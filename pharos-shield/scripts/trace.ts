/**
 * Trace core — debug_traceTransaction / debug_traceCall with the callTracer.
 *
 * Pharos confirms ONLY the callTracer tracer (not opcode/struct/prestate), so
 * everything here is designed around the call TREE, never opcode-level state.
 *
 * The callTracer returns a recursive CallFrame. We type it exactly as Pharos
 * returns it (verified against a real mainnet trace) and provide tree-walking
 * helpers used by autopsy and simulate.
 */

import type { ShieldClient } from './rpc.js';

/**
 * A node in the callTracer call tree, as returned by Pharos
 * debug_traceTransaction/debug_traceCall. Fields are hex strings as the RPC
 * returns them. `error`/`revertReason` appear only on frames that failed.
 */
export interface CallFrame {
  type: string; // CALL | DELEGATECALL | STATICCALL | CREATE | CREATE2 | SELFDESTRUCT
  from: string;
  to?: string;
  value?: string; // hex wei
  gas?: string; // hex
  gasUsed?: string; // hex
  input?: string; // hex calldata
  output?: string; // hex return / revert data
  error?: string; // e.g. "execution reverted", "out of gas"
  revertReason?: string; // decoded string when the node already decoded it
  calls?: CallFrame[];
}

/** Options accepted by debug_traceCall's call object. */
export interface TraceCallRequest {
  from: string;
  to?: string;
  data?: string;
  value?: string; // hex wei
  gas?: string; // hex
  gasPrice?: string; // hex
}

const CALL_TRACER_CONFIG = { tracer: 'callTracer' } as const;

/**
 * Trace a mined transaction by hash. Returns the root CallFrame.
 * Throws RpcError (via client.send) if the namespace is disabled or the hash
 * is unknown.
 */
export async function traceTransaction(
  client: ShieldClient,
  txHash: string,
): Promise<CallFrame> {
  const frame = await client.send<CallFrame | null>('debug_traceTransaction', [
    txHash,
    CALL_TRACER_CONFIG,
  ]);
  if (frame === null || typeof frame !== 'object') {
    throw new Error(
      `debug_traceTransaction returned no call frame for ${txHash}.`,
    );
  }
  return frame;
}

/**
 * Simulate a call at a block (default latest) WITHOUT sending a transaction.
 * Pharos requires `from` to be present (verified: omitting it yields
 * PARAM_VERIFY_ERROR "from is needed"). Returns the root CallFrame.
 */
export async function traceCall(
  client: ShieldClient,
  request: TraceCallRequest,
  blockTag: string = 'latest',
): Promise<CallFrame> {
  if (!request.from) {
    throw new Error(
      'traceCall requires a `from` address (Pharos rejects debug_traceCall without it).',
    );
  }
  const frame = await client.send<CallFrame | null>('debug_traceCall', [
    request,
    blockTag,
    CALL_TRACER_CONFIG,
  ]);
  if (frame === null || typeof frame !== 'object') {
    throw new Error('debug_traceCall returned no call frame.');
  }
  return frame;
}

/** A flattened frame plus its depth and path index for reporting. */
export interface FlatFrame {
  frame: CallFrame;
  depth: number;
  /** Index path from the root, e.g. [0, 2] = root.calls[0].calls[2]. */
  path: number[];
}

/** Depth-first flatten of the call tree, preserving order. */
export function flatten(root: CallFrame): FlatFrame[] {
  const out: FlatFrame[] = [];
  const walk = (frame: CallFrame, depth: number, path: number[]): void => {
    out.push({ frame, depth, path });
    const children = frame.calls ?? [];
    children.forEach((child, i) => walk(child, depth + 1, [...path, i]));
  };
  walk(root, 0, []);
  return out;
}

/** True if a frame carries an execution error/revert. */
export function isErrored(frame: CallFrame): boolean {
  return Boolean(frame.error) || Boolean(frame.revertReason);
}

/**
 * Find the DEEPEST errored call — the innermost frame that actually failed,
 * which is the true origin of a revert (parents propagate the error upward).
 * Returns undefined if nothing in the tree errored.
 */
export function deepestErroredFrame(root: CallFrame): FlatFrame | undefined {
  const errored = flatten(root).filter((f) => isErrored(f.frame));
  if (errored.length === 0) return undefined;
  // Deepest first; on ties, the last one encountered (latest in execution).
  errored.sort((a, b) => b.depth - a.depth || b.path.length - a.path.length);
  return errored[0];
}

/** Count every node in the tree (including the root). */
export function countCalls(root: CallFrame): number {
  return flatten(root).length;
}
