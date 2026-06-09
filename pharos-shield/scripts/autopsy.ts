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
  flatten,
  type CallFrame,
} from './trace.js';
import { decodeRevert, labelSelector, type DecodedRevert } from './decode.js';
import {
  decodeTokenLogs,
  decodeTokenCalls,
  enrichTokenMeta,
  buildTokenReport,
  tokenAddressesOf,
  type DecodedTokens,
  type TokenReport,
  type LogLike,
} from './tokens.js';
import {
  resolveSignature,
  decodeWithSignature,
  formatDecoded,
} from './signatures.js';

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
  /**
   * Token movements & approvals. For a SUCCEEDED tx these are the real events
   * that occurred (decoded from receipt logs). For a FAILED tx nothing moved —
   * these are the *attempted* movements decoded from the trace, labeled so.
   */
  tokens?: TokenReport;
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
    // If the signature DB resolved the error name, map the well-known ones.
    if (revert.signature) {
      const sig = revert.signature.toLowerCase();
      if (/insufficientallowance|erc20insufficientallowance/.test(sig)) {
        return `ERC20 allowance insufficient — ${revert.reason}`;
      }
      if (/insufficientbalance|erc20insufficientbalance|insufficient.*funds/.test(sig)) {
        return `insufficient token balance — ${revert.reason}`;
      }
      if (/(slippage|insufficientoutput|minamount|tooltittle|excessiveinput)/.test(sig)) {
        return `slippage / output-amount check failed — ${revert.reason}`;
      }
      if (/(paused|enforcedpause|notauthorized|unauthorized|ownable|accesscontrol)/.test(sig)) {
        return `access control / paused — ${revert.reason}`;
      }
      if (/(expired|deadline)/.test(sig)) {
        return `deadline expired — ${revert.reason}`;
      }
      // Named but unmapped — the decoded error itself IS the cause, stated plainly.
      return `reverted with ${revert.reason}`;
    }
    return `custom error ${revert.selector} — not in the signature database; cause undetermined without the contract ABI`;
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
    // Real token movements: decode the receipt's emitted events.
    const logs: LogLike[] = receipt.logs.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
    }));
    const tokens = await reportTokens(client, decodeTokenLogs(logs));
    base.tokens = tokens;
    if (tokens.transfers.length > 0 || tokens.approvals.length > 0) {
      notes.push(
        `Token activity (from event logs): ${tokens.transfers.length} transfer(s), ${tokens.approvals.length} approval(s).`,
      );
      notes.push(...tokens.notes);
    }
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
    if (revert) {
      await enrichRevertSignature(revert);
      base.revert = revert;
    }
    base.probableCause = inferCause(revert, undefined);
    return base;
  }

  base.traced = true;
  base.callCount = countCalls(root);

  // Attempted token movements/approvals decoded from the (reverted) call tree.
  const attemptedFrames = flatten(root).map((f) => f.frame);
  const attemptedTokens = await reportTokens(client, decodeTokenCalls(attemptedFrames));
  base.tokens = attemptedTokens;
  if (attemptedTokens.transfers.length > 0 || attemptedTokens.approvals.length > 0) {
    notes.push(
      `ATTEMPTED token activity (tx reverted, so nothing actually moved): ` +
        `${attemptedTokens.transfers.length} transfer(s), ${attemptedTokens.approvals.length} approval(s).`,
    );
  }

  const deepest = deepestErroredFrame(root);

  if (!deepest) {
    notes.push(
      'Trace succeeded but no frame carried an error flag, despite status=0. ' +
        'The revert may be at the top level; inspecting root output.',
    );
    const revert = decodeRevert(root.output);
    await enrichRevertSignature(revert);
    base.revert = revert;
    base.failingCall = toFailingCall(root, []);
    base.probableCause = inferCause(revert, base.failingCall);
    return base;
  }

  const failing = toFailingCall(deepest.frame, deepest.path);
  const revert = decodeRevert(deepest.frame.output);
  await enrichRevertSignature(revert);
  // Resolve the failing call's own selector to a function name when possible.
  await enrichFailingSelector(failing);
  base.failingCall = failing;
  base.revert = revert;
  base.probableCause = inferCause(revert, failing);
  notes.push(
    `Failing call at depth ${deepest.depth}: ${failing.from} -> ${failing.to ?? '(contract creation)'} ` +
      `[${failing.selector}]${failing.error ? ' error=' + failing.error : ''}.`,
  );
  return base;
}

/** Resolve a failing call's raw selector to a function name when possible. */
async function enrichFailingSelector(failing: FailingCall): Promise<void> {
  if (!/^0x[0-9a-f]{8}$/.test(failing.selector)) return; // already labeled
  const sig = await resolveSignature(failing.selector);
  if (sig) failing.selector = sig;
}

/**
 * Enrich a custom-error revert by resolving its 4-byte selector against the
 * signature database (openchain). Mutates the revert in place: on a hit it sets
 * `signature`/`args` and rewrites `reason` to the named, arg-decoded error.
 * On a miss it leaves the honest raw-selector reason untouched.
 */
async function enrichRevertSignature(revert: DecodedRevert): Promise<void> {
  if (revert.kind !== 'custom' || !revert.selector) return;
  const sig = await resolveSignature(revert.selector);
  if (!sig) return;
  // Only apply the name if the payload actually decodes against it — a bare
  // selector match (e.g. the degenerate 0x00000000) can be coincidental.
  const decoded = decodeWithSignature(sig, revert.raw);
  if (!decoded) return; // keep the honest raw-selector reason
  revert.signature = sig;
  revert.args = decoded.args;
  revert.reason = `custom error ${formatDecoded(decoded)}`;
}

/** Enrich decoded tokens with on-chain metadata and build a serializable report. */
async function reportTokens(
  client: ShieldClient,
  decoded: DecodedTokens,
): Promise<TokenReport> {
  const meta = await enrichTokenMeta(client, tokenAddressesOf(decoded));
  return buildTokenReport(decoded, meta);
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
