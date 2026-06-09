/**
 * autopsy <txhash> — POST-FAILURE analysis.
 *
 * Pulls the tx + receipt; if it succeeded, says so. For a failure, traces it
 * with callTracer, descends to the deepest errored call, decodes the revert,
 * and reports the failing call path. Probable cause is offered ONLY when the
 * trace + decoded reason support it; otherwise "cause undetermined".
 *
 * Falls back to receipt + revert-reason level (no call tree) when the RPC's
 * trace namespace is unavailable — labeled honestly as degraded.
 */

import { ethers } from 'ethers';
import type { ShieldClient } from './rpc.js';
import { RpcError } from './rpc.js';
import {
  traceTransaction,
  deepestErroredFrame,
  countCalls,
  type CallFrame,
} from './trace.js';
import { decodeRevert, labelSelector, type DecodedRevert } from './decode.js';

export interface FailingCall {
  from: string;
  to: string | undefined;
  selector: string; // labeled function or raw selector
  value: string; // formatted native
  error: string | undefined; // node-level error e.g. "execution reverted"
  depthPath: number[];
}

export interface AutopsyResult {
  network: string;
  txHash: string;
  found: boolean; // tx exists on chain
  status: 'success' | 'failed' | 'unknown';
  /** True when results came from a real call-tree trace; false = degraded. */
  traced: boolean;
  from?: string;
  to?: string;
  blockNumber?: number;
  gasUsed?: string;
  callCount?: number;
  failingCall?: FailingCall;
  revert?: DecodedRevert;
  /** Honest, trace-supported cause hypothesis or an explicit "undetermined". */
  probableCause: string;
  notes: string[];
}

/**
 * Map a decoded revert + failing call to a probable cause, conservatively.
 * Returns "cause undetermined" unless the evidence clearly supports a label.
 */
function inferCause(
  revert: DecodedRevert | undefined,
  failing: FailingCall | undefined,
): string {
  if (!revert) return 'cause undetermined (no revert data recovered)';
  const text = revert.reason.toLowerCase();

  // Pattern-match on the DECODED revert string only — these are facts from the
  // contract itself, not heuristics about the token.
  if (revert.kind === 'Panic') {
    if (text.includes('overflow') || text.includes('underflow')) {
      return 'arithmetic overflow/underflow inside the contract (Panic 0x11)';
    }
    if (text.includes('division')) return 'division by zero (Panic 0x12)';
    return `solidity panic — ${revert.reason}`;
  }

  if (revert.kind === 'Error') {
    if (/(allowance|approve|insufficient[- ]?allowance)/.test(text)) {
      return 'ERC20 allowance/approval insufficient — caller has not approved enough spend';
    }
    if (/insufficient balance|exceeds balance|transfer amount exceeds/.test(text)) {
      return 'insufficient token/native balance for the transfer';
    }
    if (/(slippage|min.?out|insufficient_output|too little received|price impact|INSUFFICIENT_OUTPUT_AMOUNT)/.test(text)) {
      return 'slippage / minimum-output not met (DEX swap below minOut)';
    }
    if (/(paused|frozen|blacklist|not allowed|forbidden)/.test(text)) {
      return 'contract paused / address frozen or blocked';
    }
    if (/expired|deadline/.test(text)) {
      return 'transaction deadline expired before execution';
    }
    // We have a clear on-chain message but no known mapping — report it verbatim.
    return `contract reverted with: "${revert.reason}"`;
  }

  if (failing?.error && /out of gas/i.test(failing.error)) {
    return 'out of gas in the failing call';
  }

  if (revert.kind === 'custom') {
    return `custom error ${revert.selector} — undecodable without the contract ABI; cause undetermined`;
  }

  if (revert.kind === 'empty') {
    return 'reverted with no reason string — cause undetermined from data alone (often a bare require() or a failed low-level call)';
  }

  return 'cause undetermined';
}

function toFailingCall(
  frame: CallFrame,
  path: number[],
): FailingCall {
  const value = frame.value ? ethers.formatEther(BigInt(frame.value)) : '0.0';
  return {
    from: frame.from,
    to: frame.to,
    selector: labelSelector(frame.input),
    value,
    error: frame.error,
    depthPath: path,
  };
}

export async function autopsy(
  client: ShieldClient,
  txHash: string,
): Promise<AutopsyResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error(`Invalid transaction hash: "${txHash}" (expected 0x + 64 hex chars).`);
  }

  const notes: string[] = [];
  const tx = await client.provider.getTransaction(txHash);
  const receipt = await client.provider.getTransactionReceipt(txHash);

  if (!tx || !receipt) {
    return {
      network: client.config.network.name,
      txHash,
      found: false,
      status: 'unknown',
      traced: false,
      probableCause:
        'transaction not found on this network — check the hash and PHAROS_NETWORK',
      notes: [`No transaction/receipt for ${txHash} on ${client.config.rpcUrl}.`],
    };
  }

  const base: AutopsyResult = {
    network: client.config.network.name,
    txHash,
    found: true,
    status: receipt.status === 1 ? 'success' : 'failed',
    traced: false,
    from: tx.from,
    ...(tx.to ? { to: tx.to } : {}),
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    probableCause: '',
    notes,
  };

  if (receipt.status === 1) {
    base.probableCause = 'transaction did NOT fail — it succeeded on chain.';
    notes.push('Receipt status = 1 (success). Nothing to diagnose.');
    return base;
  }

  // Failure path — attempt a full trace; degrade gracefully if unsupported.
  let root: CallFrame;
  try {
    root = await traceTransaction(client, txHash);
  } catch (err) {
    const msg = err instanceof RpcError ? err.message : String(err);
    notes.push(
      `DEGRADED: call-tree trace unavailable (${msg}). Reporting receipt-level facts only.`,
    );
    // Best-effort: re-run the call at the failing block to recover revert data.
    const revert = await recoverRevertViaCall(client, tx, receipt.blockNumber);
    if (revert) base.revert = revert;
    base.probableCause = inferCause(revert, undefined);
    return base;
  }

  base.traced = true;
  base.callCount = countCalls(root);
  const deepest = deepestErroredFrame(root);

  if (!deepest) {
    notes.push(
      'Trace succeeded but no frame carried an error flag, despite status=0. ' +
        'The revert may be at the top level; inspecting root output.',
    );
    const revert = decodeRevert(root.output);
    base.revert = revert;
    base.failingCall = toFailingCall(root, []);
    base.probableCause = inferCause(revert, base.failingCall);
    return base;
  }

  const failing = toFailingCall(deepest.frame, deepest.path);
  const revert = decodeRevert(deepest.frame.output);
  base.failingCall = failing;
  base.revert = revert;
  base.probableCause = inferCause(revert, failing);
  notes.push(
    `Failing call at depth ${deepest.depth}: ${failing.from} -> ${failing.to ?? '(contract creation)'} ` +
      `[${failing.selector}]${failing.error ? ' error=' + failing.error : ''}.`,
  );
  return base;
}

/**
 * Degraded-mode revert recovery: re-execute the tx's call at its block via
 * eth_call (not a trace) to surface the revert payload. Returns undefined-safe
 * DecodedRevert. This only works if the RPC supports historical eth_call.
 */
async function recoverRevertViaCall(
  client: ShieldClient,
  tx: ethers.TransactionResponse,
  blockNumber: number,
): Promise<DecodedRevert | undefined> {
  try {
    await client.provider.call({
      from: tx.from,
      to: tx.to,
      data: tx.data,
      value: tx.value,
      blockTag: blockNumber,
    });
    return undefined; // no revert reproduced
  } catch (err) {
    // ethers surfaces revert data under .data on a CALL_EXCEPTION.
    const data =
      err && typeof err === 'object' && 'data' in err
        ? (err as { data?: string }).data
        : undefined;
    if (typeof data === 'string') return decodeRevert(data);
    return undefined;
  }
}
