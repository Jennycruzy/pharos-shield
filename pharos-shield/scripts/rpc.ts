/**
 * RPC layer for Pharos Shield.
 *
 * Wraps an ethers v6 JsonRpcProvider and adds:
 *  - a raw `send` helper for the debug_* namespace (ethers has no typed binding)
 *  - a LIVE capability probe so commands can honestly report whether the
 *    configured RPC actually supports tracing, and degrade if it does not.
 *
 * No capability is assumed: probeTraceSupport() makes a real call and reports
 * what the endpoint answered.
 */

import { JsonRpcProvider, Network } from 'ethers';
import { loadConfig, type ResolvedConfig } from './config.js';

/** Error raised when the RPC endpoint rejects or fails a request. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly method?: string,
    /**
     * Revert payload when the server returned one (JSON-RPC error code 3 on
     * Pharos carries the revert data here). Used to decode reverts that the
     * node reports as an error rather than a trace frame.
     */
    readonly data?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Error raised when a required trace capability is absent on the endpoint. */
export class TraceUnsupportedError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'TraceUnsupportedError';
  }
}

export interface ShieldClient {
  readonly config: ResolvedConfig;
  readonly provider: JsonRpcProvider;
  /** Raw JSON-RPC call (used for debug_* methods ethers cannot express). */
  send<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

/**
 * Build a client for the resolved network. Uses a static Network so ethers does
 * not waste a round-trip auto-detecting the chain on every call.
 */
export function createClient(config: ResolvedConfig = loadConfig()): ShieldClient {
  const staticNetwork = Network.from(config.network.chainId);
  const provider = new JsonRpcProvider(config.rpcUrl, staticNetwork, {
    staticNetwork,
    // Pharos has no concept of pending-block batching subtleties we rely on;
    // keep batching modest so a single bad call does not poison a batch.
    batchMaxCount: 1,
  });

  async function send<T>(method: string, params: unknown[]): Promise<T> {
    try {
      return (await provider.send(method, params)) as T;
    } catch (err) {
      const { message, code, data } = normalizeRpcError(err);
      throw new RpcError(
        `RPC ${method} failed: ${message}`,
        code,
        method,
        data,
      );
    }
  }

  return { config, provider, send };
}

interface NormalizedError {
  message: string;
  code: number | undefined;
  data: string | undefined;
}

/** Pull a human message, JSON-RPC error code, and revert data out of an error. */
function normalizeRpcError(err: unknown): NormalizedError {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    // ethers wraps the server error under `.error` or `.info.error`.
    const inner =
      (e.error as Record<string, unknown> | undefined) ??
      ((e.info as Record<string, unknown> | undefined)?.error as
        | Record<string, unknown>
        | undefined);
    if (inner) {
      const code = typeof inner.code === 'number' ? inner.code : undefined;
      const message =
        typeof inner.message === 'string' ? inner.message : String(inner);
      const data = typeof inner.data === 'string' ? inner.data : undefined;
      return { message, code, data };
    }
    // Some ethers errors expose revert data directly on the top-level object.
    const topData = typeof e.data === 'string' ? e.data : undefined;
    if (typeof e.message === 'string') {
      const code = typeof e.code === 'number' ? e.code : undefined;
      return { message: e.message, code, data: topData };
    }
  }
  return { message: String(err), code: undefined, data: undefined };
}

export interface TraceCapability {
  /** debug_traceTransaction with callTracer answered for a real tx. */
  traceTransaction: boolean;
  /** debug_traceCall with callTracer answered for a trivial call. */
  traceCall: boolean;
  /** Human-readable note about what was observed (for honest reporting). */
  note: string;
}

/**
 * Live-probe the endpoint's trace support. Does NOT assume — it issues a real
 * debug_traceCall (cheap, no tx needed) and inspects the response. A
 * "method not found" / -32601 means the namespace is disabled.
 *
 * We probe traceCall (always reproducible) and infer traceTransaction from the
 * same namespace availability; callers that specifically need traceTransaction
 * will surface their own error if it differs.
 */
export async function probeTraceSupport(
  client: ShieldClient,
): Promise<TraceCapability> {
  const probeFrom = '0x0000000000000000000000000000000000000001';
  try {
    // A self-call to a zero-code address: returns a trivial frame if tracing
    // works, and errors with -32601/method-not-found if it does not.
    await client.send('debug_traceCall', [
      { from: probeFrom, to: probeFrom, data: '0x' },
      'latest',
      { tracer: 'callTracer' },
    ]);
    return {
      traceTransaction: true,
      traceCall: true,
      note: 'debug_traceCall(callTracer) responded; trace namespace is enabled.',
    };
  } catch (err) {
    if (err instanceof RpcError) {
      // -32601: method not found  => namespace disabled.
      if (err.code === -32601 || /not found|not available|unsupported/i.test(err.message)) {
        return {
          traceTransaction: false,
          traceCall: false,
          note: `Trace namespace appears disabled on ${client.config.rpcUrl}: ${err.message}`,
        };
      }
      // -32602 (param error) or similar means the METHOD exists but our probe
      // args were rejected — namespace is present.
      return {
        traceTransaction: true,
        traceCall: true,
        note: `debug_traceCall is present (probe returned: ${err.message}).`,
      };
    }
    throw err;
  }
}
