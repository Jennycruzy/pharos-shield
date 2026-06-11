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

import { FetchRequest, JsonRpcProvider, Network } from 'ethers';
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

/** Raised before command execution when the RPC is not the configured chain. */
export class ChainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainValidationError';
  }
}

/** Pharos accepts a raw block hash string, but not the EIP-1898 object form. */
export type RpcBlockReference = string;

/** One canonical block used for every state read in a command. */
export interface ChainSnapshot {
  readonly chainId: number;
  readonly blockNumber: number;
  readonly blockNumberHex: string;
  readonly blockHash: string;
  readonly timestamp: number;
  readonly ageSeconds: number;
  readonly reference: RpcBlockReference;
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
  const request = new FetchRequest(config.rpcUrl);
  request.timeout = config.timeoutMs;
  const provider = new JsonRpcProvider(request, staticNetwork, {
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

interface RawBlock {
  number?: string;
  hash?: string;
  timestamp?: string;
}

function parseQuantity(value: string | undefined, label: string): number {
  if (!value || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ChainValidationError(`RPC returned an invalid ${label}: ${String(value)}.`);
  }
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ChainValidationError(`RPC returned an out-of-range ${label}: ${value}.`);
  }
  return parsed;
}

function validateBlock(block: RawBlock | null, label: string): RawBlock & {
  number: string;
  hash: string;
  timestamp: string;
} {
  if (
    block === null ||
    !block.number ||
    !/^0x[0-9a-fA-F]+$/.test(block.number) ||
    !block.hash ||
    !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
    !block.timestamp ||
    !/^0x[0-9a-fA-F]+$/.test(block.timestamp)
  ) {
    throw new ChainValidationError(`RPC returned an invalid ${label} block.`);
  }
  return {
    ...block,
    number: block.number,
    hash: block.hash.toLowerCase(),
    timestamp: block.timestamp,
  };
}

/**
 * Validate chain identity, optional genesis identity, and block freshness, then
 * pin one canonical block hash for all state reads performed by a command.
 */
export async function prepareCommand(
  client: ShieldClient,
  blockHash?: string,
): Promise<ChainSnapshot> {
  const chainIdHex = await client.send<string>('eth_chainId', []);
  const chainId = parseQuantity(chainIdHex, 'chain ID');
  if (chainId !== client.config.network.chainId) {
    throw new ChainValidationError(
      `RPC chain mismatch: expected Pharos ${client.config.network.name} chain ` +
        `${client.config.network.chainId}, received ${chainId}. Refusing to label or analyze wrong-chain data.`,
    );
  }

  if (client.config.expectedGenesisHash) {
    const genesis = validateBlock(
      await client.send<RawBlock | null>('eth_getBlockByNumber', ['0x0', false]),
      'genesis',
    );
    if (genesis.hash !== client.config.expectedGenesisHash.toLowerCase()) {
      throw new ChainValidationError(
        `RPC genesis mismatch for chain ${chainId}: expected ` +
          `${client.config.expectedGenesisHash}, received ${genesis.hash}.`,
      );
    }
  }

  const block = validateBlock(
    blockHash
      ? await client.send<RawBlock | null>('eth_getBlockByHash', [blockHash, false])
      : await client.send<RawBlock | null>('eth_getBlockByNumber', ['latest', false]),
    blockHash ? `requested ${blockHash}` : 'latest',
  );
  if (blockHash && block.hash !== blockHash.toLowerCase()) {
    throw new ChainValidationError(
      `RPC returned block ${block.hash} when ${blockHash.toLowerCase()} was requested.`,
    );
  }

  const timestamp = parseQuantity(block.timestamp, 'block timestamp');
  const blockNumber = parseQuantity(block.number, 'block number');
  const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
  if (!blockHash && ageSeconds > client.config.maxBlockAgeSeconds) {
    throw new ChainValidationError(
      `Latest block ${block.number} is stale by ${ageSeconds}s; maximum allowed is ` +
        `${client.config.maxBlockAgeSeconds}s.`,
    );
  }
  if (ageSeconds < -60) {
    throw new ChainValidationError(
      `Block ${block.number} timestamp is ${Math.abs(ageSeconds)}s in the future.`,
    );
  }

  return {
    chainId,
    blockNumber,
    blockNumberHex: block.number,
    blockHash: block.hash,
    timestamp,
    ageSeconds,
    reference: block.hash,
  };
}

export async function getCodeAt(
  client: ShieldClient,
  address: string,
  snapshot: ChainSnapshot,
): Promise<string> {
  return client.send<string>('eth_getCode', [address, snapshot.reference]);
}

export async function getStorageAt(
  client: ShieldClient,
  address: string,
  slot: string,
  snapshot: ChainSnapshot,
): Promise<string> {
  return client.send<string>('eth_getStorageAt', [address, slot, snapshot.reference]);
}

export async function callAt(
  client: ShieldClient,
  request: Record<string, string>,
  snapshot: ChainSnapshot,
): Promise<string> {
  return client.send<string>('eth_call', [request, snapshot.reference]);
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
  /** Canonical block used by the traceCall probe. */
  block: ChainSnapshot;
}

/**
 * Live-probe both trace methods independently. traceCall uses the pinned block
 * hash; traceTransaction is attempted only with a supplied real transaction.
 * Any RPC/transport error is reported as a failed probe, never as support.
 */
export async function probeTraceSupport(
  client: ShieldClient,
  knownTransactionHash: string | undefined =
    client.config.network.traceProbeTransactionHash,
): Promise<TraceCapability> {
  const snapshot = await prepareCommand(client);
  const probeFrom = '0x0000000000000000000000000000000000000001';
  let traceCall = false;
  let traceTransaction = false;
  const notes: string[] = [];
  try {
    // A self-call to a zero-code address: returns a trivial frame if tracing
    // works, and errors with -32601/method-not-found if it does not.
    await client.send('debug_traceCall', [
      { from: probeFrom, to: probeFrom, data: '0x' },
      snapshot.reference,
      { tracer: 'callTracer' },
    ]);
    traceCall = true;
    notes.push('debug_traceCall(callTracer) responded at the pinned block hash.');
  } catch (err) {
    notes.push(`debug_traceCall probe failed: ${errorMessage(err)}.`);
  }

  if (knownTransactionHash) {
    try {
      await client.send('debug_traceTransaction', [
        knownTransactionHash,
        { tracer: 'callTracer' },
      ]);
      traceTransaction = true;
      notes.push('debug_traceTransaction(callTracer) responded for the supplied real transaction.');
    } catch (err) {
      notes.push(`debug_traceTransaction probe failed: ${errorMessage(err)}.`);
    }
  } else {
    notes.push(
      'debug_traceTransaction was not inferred from traceCall; supply a real transaction hash to probe it.',
    );
  }

  return { traceTransaction, traceCall, note: notes.join(' '), block: snapshot };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
