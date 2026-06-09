/**
 * simulate <tx params> — PRE-FLIGHT dry-run.
 *
 * Builds a call object and runs debug_traceCall at the latest block. Reports
 * whether it would succeed or revert, the would-be call tree, and the native
 * (PROS) value movements derivable from the trace. It NEVER sends a transaction.
 *
 * Token (ERC20) deltas are intentionally NOT asserted: the callTracer does not
 * expose event logs, and inferring balances would require trusting an ABI the
 * trace cannot prove. We report only what the call tree itself shows.
 */

import { ethers, getAddress } from 'ethers';
import type { ShieldClient } from './rpc.js';
import { RpcError } from './rpc.js';
import {
  traceCall,
  flatten,
  isErrored,
  countCalls,
  type CallFrame,
  type TraceCallRequest,
} from './trace.js';
import {
  decodeRevert,
  labelSelector,
  nativeTransfers,
  type DecodedRevert,
  type ValueTransfer,
} from './decode.js';
import {
  decodeTokenCalls,
  enrichTokenMeta,
  buildTokenReport,
  tokenAddressesOf,
  type TokenReport,
} from './tokens.js';

export interface SimulateParams {
  from: string;
  to?: string; // omit for contract creation
  data?: string;
  /** Decimal PROS amount (e.g. "0.5") or hex wei (0x...). */
  value?: string;
  /** Optional explicit gas limit (decimal or hex). */
  gas?: string;
}

export interface SimCall {
  type: string;
  from: string;
  to: string | undefined;
  selector: string;
  value: string; // formatted native
  errored: boolean;
  depth: number;
}

export interface SimulateResult {
  network: string;
  isSimulation: true; // always — Shield never sends
  from: string;
  to: string | undefined;
  willRevert: boolean;
  callCount: number;
  revert?: DecodedRevert;
  calls: SimCall[];
  nativeMovements: Array<{ from: string; to: string; pros: string }>;
  /** Intended ERC-20/721 movements & approvals decoded from the call tree. */
  tokens: TokenReport;
  notes: string[];
}

/** True when an RpcError represents an EVM revert (vs a transport/RPC fault). */
function isRevertError(err: RpcError): boolean {
  // Pharos uses JSON-RPC error code 3 for execution reverts.
  return err.code === 3 || /execution reverted|revert/i.test(err.message);
}

/** Parse a value that may be decimal PROS or hex wei into hex wei. */
function toHexWei(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const v = value.trim();
  if (v.startsWith('0x')) {
    BigInt(v); // validate
    return v;
  }
  // Decimal PROS -> wei
  return '0x' + ethers.parseEther(v).toString(16);
}

/** Parse a gas value that may be decimal or hex into hex. */
function toHexGas(gas: string | undefined): string | undefined {
  if (gas === undefined || gas.trim() === '') return undefined;
  const g = gas.trim();
  if (g.startsWith('0x')) {
    BigInt(g);
    return g;
  }
  return '0x' + BigInt(g).toString(16);
}

export async function simulate(
  client: ShieldClient,
  params: SimulateParams,
): Promise<SimulateResult> {
  // Validate inputs up front.
  let from: string;
  try {
    from = getAddress(params.from.trim());
  } catch {
    throw new Error(`Invalid 'from' address: "${params.from}".`);
  }
  let to: string | undefined;
  if (params.to !== undefined && params.to.trim() !== '') {
    try {
      to = getAddress(params.to.trim());
    } catch {
      throw new Error(`Invalid 'to' address: "${params.to}".`);
    }
  }
  const data = params.data?.trim() ?? '0x';
  if (data !== '0x' && !/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new Error(`Invalid 'data' hex: "${params.data}".`);
  }

  const request: TraceCallRequest = { from, data };
  if (to !== undefined) request.to = to;
  const hexValue = toHexWei(params.value);
  if (hexValue !== undefined) request.value = hexValue;
  const hexGas = toHexGas(params.gas);
  if (hexGas !== undefined) request.gas = hexGas;

  // Pharos returns a JSON-RPC error (code 3, "execution reverted") with the
  // revert payload in error.data when the TOP-LEVEL call reverts — it does NOT
  // return a trace frame in that case. Catch it and report it as a clean,
  // decoded "would revert" outcome rather than letting it surface as a crash.
  let root: CallFrame;
  try {
    root = await traceCall(client, request, 'latest');
  } catch (err) {
    if (err instanceof RpcError && isRevertError(err)) {
      const revert = decodeRevert(err.data);
      // Even though it would revert, decode the user's OWN intended call so an
      // unlimited approval or transfer is still surfaced from the request.
      const syntheticFrame: CallFrame = {
        type: 'CALL',
        from,
        ...(to !== undefined ? { to } : {}),
        input: request.data ?? '0x',
      };
      const tokens = await computeTokenReport(client, [syntheticFrame]);
      return {
        network: client.config.network.name,
        isSimulation: true,
        from,
        to,
        willRevert: true,
        callCount: 0,
        revert,
        calls: [],
        nativeMovements: [],
        tokens,
        notes: [
          'SIMULATION ONLY — no transaction was sent. Result reflects current latest-block state.',
          `Would REVERT at the top level: ${revert.reason}.`,
          'Pharos reported the revert as an RPC error (no call tree returned for top-level reverts).',
          ...tokens.notes,
        ],
      };
    }
    throw err;
  }

  const flat = flatten(root);
  const calls: SimCall[] = flat.map(({ frame, depth }) => ({
    type: frame.type,
    from: frame.from,
    to: frame.to,
    selector: labelSelector(frame.input),
    value: frame.value ? ethers.formatEther(BigInt(frame.value)) : '0.0',
    errored: isErrored(frame),
    depth,
  }));

  const willRevert = isErrored(root);
  const notes: string[] = [
    'SIMULATION ONLY — no transaction was sent. Result reflects current latest-block state.',
  ];

  let revert: DecodedRevert | undefined;
  if (willRevert) {
    revert = decodeRevert(root.output);
    notes.push(
      `Would REVERT: ${revert.reason}${root.error ? ` (node error: ${root.error})` : ''}.`,
    );
  } else {
    notes.push('Would SUCCEED at the latest block (no top-level revert in the trace).');
  }

  const allFrames: CallFrame[] = flat.map((f) => f.frame);
  const transfers: ValueTransfer[] = nativeTransfers(allFrames);
  const nativeMovements = transfers.map((t) => ({
    from: t.from,
    to: t.to,
    pros: t.formatted,
  }));
  if (transfers.length === 0) {
    notes.push('No non-zero native (PROS) movements in the trace.');
  }

  const tokens = await computeTokenReport(client, allFrames);
  if (tokens.transfers.length === 0 && tokens.approvals.length === 0) {
    notes.push('No ERC-20/721 token movements or approvals decoded from the call tree.');
  }
  notes.push(...tokens.notes);

  return {
    network: client.config.network.name,
    isSimulation: true,
    from,
    to,
    willRevert,
    callCount: countCalls(root),
    ...(revert ? { revert } : {}),
    calls,
    nativeMovements,
    tokens,
    notes,
  };
}

/** Decode token calls from frames and enrich with on-chain metadata. */
async function computeTokenReport(
  client: ShieldClient,
  frames: CallFrame[],
): Promise<TokenReport> {
  const decoded = decodeTokenCalls(frames);
  const meta = await enrichTokenMeta(client, tokenAddressesOf(decoded));
  return buildTokenReport(decoded, meta);
}

/** Format a SimulateResult for human-readable CLI output. */
export function formatSimulate(r: SimulateResult): string {
  const lines: string[] = [];
  lines.push(`Simulation (${r.network})  —  NO TX SENT`);
  lines.push(`From:      ${r.from}`);
  lines.push(`To:        ${r.to ?? '(contract creation)'}`);
  lines.push(`Outcome:   ${r.willRevert ? 'WOULD REVERT' : 'would succeed'}`);
  if (r.revert) lines.push(`Revert:    ${r.revert.reason}`);
  lines.push(`Calls:     ${r.callCount} frame(s)`);
  if (r.calls.length > 0) {
    lines.push('Call tree:');
    for (const c of r.calls) {
      const indent = '  '.repeat(c.depth + 1);
      const mark = c.errored ? ' [REVERTED]' : '';
      const val = c.value !== '0.0' ? ` value=${c.value}` : '';
      lines.push(`${indent}${c.type} -> ${c.to ?? '(create)'} [${c.selector}]${val}${mark}`);
    }
  }
  if (r.nativeMovements.length > 0) {
    lines.push('Native (PROS) movements:');
    for (const m of r.nativeMovements) lines.push(`  ${m.from} -> ${m.to}: ${m.pros}`);
  }
  if (r.tokens.transfers.length > 0) {
    lines.push('Token movements (intended):');
    for (const t of r.tokens.transfers) {
      const label = t.symbol ?? t.token;
      lines.push(`  ${t.from} -> ${t.to}: ${t.amount} [${label}]`);
    }
  }
  if (r.tokens.approvals.length > 0) {
    lines.push('Approvals (intended):');
    for (const a of r.tokens.approvals) {
      const label = a.symbol ?? a.token;
      const flag = a.isUnlimited || a.operatorAll ? '  ⚠ UNLIMITED' : a.isVeryLarge ? '  ⚠ very large' : '';
      lines.push(`  owner ${a.owner} grants ${a.spender}: ${a.amount} [${label}]${flag}`);
    }
  }
  lines.push('Notes:');
  for (const n of r.notes) lines.push(`  - ${n}`);
  return lines.join('\n');
}
