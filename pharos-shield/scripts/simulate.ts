/**
 * simulate <tx params> — PRE-FLIGHT dry-run.
 *
 * Builds a call object and runs debug_traceCall at one pinned latest-block hash. Reports
 * whether it would succeed or revert, the would-be call tree, and native-value
 * call intents visible in the trace. It NEVER sends a transaction.
 *
 * Token (ERC20) deltas are intentionally NOT asserted: the callTracer does not
 * expose event logs, and inferring balances would require trusting an ABI the
 * trace cannot prove. We report only what the call tree itself shows.
 */

import { ethers, getAddress } from 'ethers';
import type { ChainSnapshot, ShieldClient } from './rpc.js';
import { prepareCommand, RpcError } from './rpc.js';
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
  nativeValueIntents,
  type DecodedRevert,
  type NativeValueIntent,
} from './decode.js';
import {
  decodeTokenCalls,
  enrichTokenMeta,
  buildTokenReport,
  readCodePresence,
  tokenAddressesOf,
  type TokenReport,
} from './tokens.js';
import {
  resolveSignatures,
  resolveSignature,
  decodeWithSignature,
  formatDecoded,
} from './signatures.js';

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
  block: Pick<ChainSnapshot, 'blockNumber' | 'blockHash' | 'timestamp'>;
  willRevert: boolean;
  callCount: number;
  revert?: DecodedRevert;
  calls: SimCall[];
  nativeValueIntents: Array<{ from: string; to: string; pros: string }>;
  /** Receipt-backed activity arrays plus selector-derived ERC-compatible intents. */
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
    const parsed = BigInt(v);
    if (parsed < 0n) throw new Error('value must not be negative.');
    return v;
  }
  // Decimal PROS -> wei
  const parsed = ethers.parseEther(v);
  if (parsed < 0n) throw new Error('value must not be negative.');
  return '0x' + parsed.toString(16);
}

/** Parse a gas value that may be decimal or hex into hex. */
function toHexGas(gas: string | undefined): string | undefined {
  if (gas === undefined || gas.trim() === '') return undefined;
  const g = gas.trim();
  if (g.startsWith('0x')) {
    const parsed = BigInt(g);
    if (parsed <= 0n) throw new Error('gas must be greater than zero.');
    return g;
  }
  const parsed = BigInt(g);
  if (parsed <= 0n) throw new Error('gas must be greater than zero.');
  return '0x' + parsed.toString(16);
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
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) {
    throw new Error(
      `Invalid 'data' hex: "${params.data}". Expected byte-aligned 0x-prefixed hex.`,
    );
  }

  const snapshot = await prepareCommand(client);
  const block = {
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    timestamp: snapshot.timestamp,
  };

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
    root = await traceCall(client, request, snapshot.reference);
  } catch (err) {
    if (err instanceof RpcError && isRevertError(err)) {
      const revert = decodeRevert(err.data);
      await enrichSimRevert(revert);
      // Even though it would revert, decode the user's own calldata as an
      // ERC-compatible intent so an unlimited approval request is visible.
      const syntheticFrame: CallFrame = {
        type: 'CALL',
        from,
        ...(to !== undefined ? { to } : {}),
        input: request.data ?? '0x',
      };
      const tokens = await computeTokenReport(client, [syntheticFrame], snapshot);
      return {
        network: client.config.network.name,
        isSimulation: true,
        from,
        to,
        block,
        willRevert: true,
        callCount: 0,
        revert,
        calls: [],
        nativeValueIntents: [],
        tokens,
        notes: [
          'SIMULATION ONLY — no transaction was sent. Result reflects the reported pinned block.',
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
  // Resolve unknown selectors in the call tree to function names (batched).
  await relabelCalls(calls);

  const willRevert = isErrored(root);
  const notes: string[] = [
    'SIMULATION ONLY — no transaction was sent. Result reflects the reported pinned block.',
  ];

  let revert: DecodedRevert | undefined;
  if (willRevert) {
    revert = decodeRevert(root.output);
    await enrichSimRevert(revert);
    notes.push(
      `Would REVERT: ${revert.reason}${root.error ? ` (node error: ${root.error})` : ''}.`,
    );
  } else {
    notes.push('Would SUCCEED at the pinned block (no top-level revert in the trace).');
  }

  const allFrames: CallFrame[] = flat.map((f) => f.frame);
  const valueIntents: NativeValueIntent[] = nativeValueIntents(root);
  const formattedValueIntents = valueIntents.map((t) => ({
    from: t.from,
    to: t.to,
    pros: t.formatted,
  }));
  if (formattedValueIntents.length === 0) {
    notes.push('No non-zero native (PROS) value intents in the trace.');
  } else {
    notes.push(
      'Native values are call intents from callTracer, not receipt-log or state-delta-proven movements.',
    );
  }

  const tokens = await computeTokenReport(client, allFrames, snapshot);
  if (
    tokens.transfers.length === 0 &&
    tokens.approvals.length === 0 &&
    tokens.callIntents.length === 0
  ) {
    notes.push('No ERC-compatible transfer or approval call intents decoded from the call tree.');
  }
  notes.push(...tokens.notes);

  return {
    network: client.config.network.name,
    isSimulation: true,
    from,
    to,
    block,
    willRevert,
    callCount: countCalls(root),
    ...(revert ? { revert } : {}),
    calls,
    nativeValueIntents: formattedValueIntents,
    tokens,
    notes,
  };
}

/** Resolve raw 4-byte selectors in a SimCall list to function names (batched). */
async function relabelCalls(calls: SimCall[]): Promise<void> {
  const unknown = calls
    .map((c) => c.selector)
    .filter((s) => /^0x[0-9a-f]{8}$/.test(s));
  if (unknown.length === 0) return;
  const resolved = await resolveSignatures(unknown);
  for (const c of calls) {
    const name = resolved.get(c.selector.toLowerCase());
    if (name) c.selector = name;
  }
}

/** Enrich a custom-error simulate revert with its resolved signature + args. */
async function enrichSimRevert(revert: DecodedRevert): Promise<void> {
  if (revert.kind !== 'custom' || !revert.selector) return;
  const sig = await resolveSignature(revert.selector);
  if (!sig) return;
  // Only apply the name if the payload actually decodes (avoid coincidental
  // selector collisions); otherwise keep the honest raw-selector reason.
  const decoded = decodeWithSignature(sig, revert.raw);
  if (!decoded) return;
  revert.signature = sig;
  revert.args = decoded.args;
  revert.reason = `custom error ${formatDecoded(decoded)}`;
}

/** Decode token calls from frames and enrich with on-chain metadata. */
async function computeTokenReport(
  client: ShieldClient,
  frames: CallFrame[],
  snapshot: ChainSnapshot,
): Promise<TokenReport> {
  const decoded = decodeTokenCalls(frames);
  const addresses = tokenAddressesOf(decoded);
  const [meta, code] = await Promise.all([
    enrichTokenMeta(client, addresses, snapshot),
    readCodePresence(client, addresses, snapshot),
  ]);
  return buildTokenReport(decoded, meta, code);
}

/** Format a SimulateResult for human-readable CLI output. */
export function formatSimulate(r: SimulateResult): string {
  const lines: string[] = [];
  lines.push(`Simulation (${r.network})  —  NO TX SENT`);
  lines.push(`From:      ${r.from}`);
  lines.push(`To:        ${r.to ?? '(contract creation)'}`);
  lines.push(`Block:     ${r.block.blockNumber} (${r.block.blockHash})`);
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
  if (r.nativeValueIntents.length > 0) {
    lines.push('Native (PROS) value intents (trace-derived, not proven movements):');
    for (const m of r.nativeValueIntents) {
      lines.push(`  ${m.from} -> ${m.to}: ${m.pros}`);
    }
  }
  if (r.tokens.callIntents.length > 0) {
    lines.push('ERC-compatible call intents (selector-derived, not movements):');
    for (const intent of r.tokens.callIntents) {
      const target = intent.targetSymbol ?? intent.target;
      const amount = intent.displayAmount ?? intent.amountOrTokenId ?? '(n/a)';
      const counterparty = intent.to ?? intent.spender ?? '(n/a)';
      const flag = intent.isUnlimited ? ' [UNLIMITED REQUEST]' : '';
      const code = intent.targetHasCode ? 'contract' : 'no-code address';
      lines.push(
        `  ${intent.signature} -> ${target} (${code}); counterparty=${counterparty}; value=${amount}${flag}`,
      );
    }
  }
  lines.push('Notes:');
  for (const n of r.notes) lines.push(`  - ${n}`);
  return lines.join('\n');
}
