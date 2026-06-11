/**
 * RPC identity, quorum, finality, and block-pinning layer for Pharos Shield.
 *
 * Every command validates chain identity and freshness. When independent RPCs
 * are configured, they must agree on the canonical checkpoint hash. Latest
 * state is intentionally read behind the slowest healthy tip by the configured
 * confirmation depth. The checkpoint is re-read after command execution to
 * detect a reorg that occurred during analysis.
 */

import { FetchRequest, JsonRpcProvider, Network } from 'ethers';
import { loadConfig, type ResolvedConfig } from './config.js';

/** Error raised when an RPC endpoint rejects or fails a request. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly method?: string,
    readonly data?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Raised when chain identity, freshness, or block shape is invalid. */
export class ChainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainValidationError';
  }
}

/** Raised when configured RPCs cannot establish one canonical block hash. */
export class RpcConsensusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcConsensusError';
  }
}

/** Pharos accepts a raw block hash string, but not the EIP-1898 object form. */
export type RpcBlockReference = string;

export interface RpcEndpointObservation {
  endpoint: string;
  status: 'agreeing' | 'disagreeing' | 'unavailable';
  latestBlockNumber?: number;
  latestBlockHash?: string;
  checkpointHash?: string;
  detail?: string;
}

export interface RpcConsensus {
  mode: 'single-endpoint' | 'quorum';
  total: number;
  required: number;
  agreeing: number;
  checkpointNumber: number;
  checkpointHash: string;
  lowestLatestBlock: number;
  highestLatestBlock: number;
  tipSkew: number;
  finalityConfirmations: number;
  confirmations: number;
  meetsFinalityPolicy: boolean;
  reorgDetected: false;
  observations: RpcEndpointObservation[];
}

/** Public block anchor included in every command result and evidence bundle. */
export interface BlockAnchor {
  blockNumber: number;
  blockHash: string;
  timestamp: number;
  confirmations: number;
  meetsFinalityPolicy: boolean;
  finalityConfirmations: number;
  consensus: RpcConsensus;
}

/** One canonical block used for every state read in a command. */
export interface ChainSnapshot extends BlockAnchor {
  readonly chainId: number;
  readonly blockNumberHex: string;
  readonly ageSeconds: number;
  readonly reference: RpcBlockReference;
}

export interface RpcEndpoint {
  readonly label: string;
  send<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

export interface ShieldClient {
  readonly config: ResolvedConfig;
  readonly provider: JsonRpcProvider;
  readonly endpoints?: readonly RpcEndpoint[];
  /** Raw JSON-RPC call through the primary endpoint. */
  send<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

interface BuiltEndpoint extends RpcEndpoint {
  provider: JsonRpcProvider;
}

function endpointLabel(rawUrl: string, index: number): string {
  try {
    return `${new URL(rawUrl).host}#${index + 1}`;
  } catch {
    return `rpc#${index + 1}`;
  }
}

function buildEndpoint(
  rpcUrl: string,
  index: number,
  config: ResolvedConfig,
): BuiltEndpoint {
  const request = new FetchRequest(rpcUrl);
  request.timeout = config.timeoutMs;
  const staticNetwork = Network.from(config.network.chainId);
  const provider = new JsonRpcProvider(request, staticNetwork, {
    staticNetwork,
    batchMaxCount: 1,
  });
  const label = endpointLabel(rpcUrl, index);
  return {
    label,
    provider,
    async send<T>(method: string, params: unknown[]): Promise<T> {
      try {
        return (await provider.send(method, params)) as T;
      } catch (error) {
        const { message, code, data } = normalizeRpcError(error);
        throw new RpcError(
          `RPC ${method} failed on ${label}: ${message}`,
          code,
          method,
          data,
        );
      }
    },
  };
}

/** Build a primary provider plus any independently configured quorum peers. */
export function createClient(config: ResolvedConfig = loadConfig()): ShieldClient {
  const endpoints = config.rpcUrls.map((url, index) =>
    buildEndpoint(url, index, config),
  );
  const primary = endpoints[0];
  if (!primary) throw new Error('At least one RPC URL is required.');
  return {
    config,
    provider: primary.provider,
    endpoints,
    send: primary.send,
  };
}

interface RawBlock {
  number?: string;
  hash?: string;
  timestamp?: string;
}

interface ValidBlock {
  number: string;
  hash: string;
  timestamp: string;
}

interface EndpointTip {
  endpoint: RpcEndpoint;
  block: ValidBlock;
  blockNumber: number;
  timestamp: number;
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

function validateBlock(block: RawBlock | null, label: string): ValidBlock {
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
    number: block.number,
    hash: block.hash.toLowerCase(),
    timestamp: block.timestamp,
  };
}

function clientEndpoints(client: ShieldClient): readonly RpcEndpoint[] {
  return client.endpoints && client.endpoints.length > 0
    ? client.endpoints
    : [{ label: 'primary#1', send: client.send }];
}

function safeError(error: unknown, config: ResolvedConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const rpcUrl of config.rpcUrls) {
    message = message.replaceAll(rpcUrl, '[rpc-url-redacted]');
  }
  return message;
}

async function observeTip(
  endpoint: RpcEndpoint,
  config: ResolvedConfig,
): Promise<EndpointTip> {
  const chainIdHex = await endpoint.send<string>('eth_chainId', []);
  const chainId = parseQuantity(chainIdHex, 'chain ID');
  if (chainId !== config.network.chainId) {
    throw new ChainValidationError(
      `chain mismatch: expected ${config.network.chainId}, received ${chainId}`,
    );
  }
  if (config.expectedGenesisHash) {
    const genesis = validateBlock(
      await endpoint.send<RawBlock | null>('eth_getBlockByNumber', ['0x0', false]),
      'genesis',
    );
    if (genesis.hash !== config.expectedGenesisHash.toLowerCase()) {
      throw new ChainValidationError(
        `genesis mismatch: expected ${config.expectedGenesisHash}, received ${genesis.hash}`,
      );
    }
  }
  const block = validateBlock(
    await endpoint.send<RawBlock | null>('eth_getBlockByNumber', ['latest', false]),
    'latest',
  );
  const timestamp = parseQuantity(block.timestamp, 'block timestamp');
  const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
  if (ageSeconds > config.maxBlockAgeSeconds) {
    throw new ChainValidationError(
      `latest block is stale by ${ageSeconds}s (maximum ${config.maxBlockAgeSeconds}s)`,
    );
  }
  if (ageSeconds < -60) {
    throw new ChainValidationError(
      `latest block timestamp is ${Math.abs(ageSeconds)}s in the future`,
    );
  }
  return {
    endpoint,
    block,
    blockNumber: parseQuantity(block.number, 'block number'),
    timestamp,
  };
}

async function readBlockByNumber(
  tip: EndpointTip,
  blockNumber: number,
): Promise<ValidBlock> {
  const block = validateBlock(
    await tip.endpoint.send<RawBlock | null>('eth_getBlockByNumber', [
      `0x${blockNumber.toString(16)}`,
      false,
    ]),
    `checkpoint ${blockNumber}`,
  );
  if (parseQuantity(block.number, 'checkpoint number') !== blockNumber) {
    throw new ChainValidationError(
      `RPC returned block ${block.number} for requested height ${blockNumber}.`,
    );
  }
  return block;
}

async function readCanonicalRequestedBlock(
  tip: EndpointTip,
  blockHash: string,
): Promise<ValidBlock> {
  const requested = validateBlock(
    await tip.endpoint.send<RawBlock | null>('eth_getBlockByHash', [blockHash, false]),
    `requested ${blockHash}`,
  );
  if (requested.hash !== blockHash.toLowerCase()) {
    throw new RpcConsensusError(
      `RPC returned ${requested.hash} when block ${blockHash.toLowerCase()} was requested`,
    );
  }
  const number = parseQuantity(requested.number, 'requested block number');
  const canonical = await readBlockByNumber(tip, number);
  if (canonical.hash !== requested.hash) {
    throw new RpcConsensusError(
      `requested block ${requested.hash} is not canonical at height ${number}`,
    );
  }
  return requested;
}

interface ConsensusSelection {
  block: ValidBlock;
  blockNumber: number;
  lowestLatest: number;
  highestLatest: number;
  agreeing: number;
  observations: RpcEndpointObservation[];
}

async function selectConsensusBlock(
  client: ShieldClient,
  requestedHash?: string,
): Promise<ConsensusSelection> {
  const endpoints = clientEndpoints(client);
  const observations = new Map<string, RpcEndpointObservation>();
  const settled = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const tip = await observeTip(endpoint, client.config);
        observations.set(endpoint.label, {
          endpoint: endpoint.label,
          status: 'disagreeing',
          latestBlockNumber: tip.blockNumber,
          latestBlockHash: tip.block.hash,
        });
        return tip;
      } catch (error) {
        observations.set(endpoint.label, {
          endpoint: endpoint.label,
          status: 'unavailable',
          detail: safeError(error, client.config),
        });
        return undefined;
      }
    }),
  );
  const tips = settled.filter((tip): tip is EndpointTip => tip !== undefined);
  const primary = tips.find((tip) => tip.endpoint.label === endpoints[0]!.label);
  if (!primary) {
    throw new ChainValidationError(
      `Primary RPC failed chain/genesis/freshness validation: ` +
        `${observations.get(endpoints[0]!.label)?.detail ?? 'unknown error'}.`,
    );
  }
  if (tips.length < client.config.quorumMinimum) {
    throw new RpcConsensusError(
      `RPC quorum unavailable: ${tips.length}/${endpoints.length} healthy, ` +
        `${client.config.quorumMinimum} required.`,
    );
  }

  const latestNumbers = tips.map(({ blockNumber }) => blockNumber);
  const lowestLatest = Math.min(...latestNumbers);
  const highestLatest = Math.max(...latestNumbers);
  const tipSkew = highestLatest - lowestLatest;
  if (tipSkew > client.config.maxTipSkew) {
    throw new RpcConsensusError(
      `RPC tip skew ${tipSkew} exceeds configured maximum ${client.config.maxTipSkew}.`,
    );
  }

  const reads = await Promise.all(
    tips.map(async (tip) => {
      try {
        const block = requestedHash
          ? await readCanonicalRequestedBlock(tip, requestedHash.toLowerCase())
          : await readBlockByNumber(
              tip,
              Math.max(0, lowestLatest - client.config.finalityConfirmations),
            );
        return { tip, block };
      } catch (error) {
        const observation = observations.get(tip.endpoint.label)!;
        observation.status = 'unavailable';
        observation.detail = safeError(error, client.config);
        return undefined;
      }
    }),
  );
  const validReads = reads.filter(
    (read): read is { tip: EndpointTip; block: ValidBlock } => read !== undefined,
  );
  const primaryRead = validReads.find(
    ({ tip }) => tip.endpoint.label === endpoints[0]!.label,
  );
  if (!primaryRead) {
    throw new RpcConsensusError(
      `Primary RPC could not prove the requested canonical checkpoint.`,
    );
  }
  const primaryNumber = parseQuantity(primaryRead.block.number, 'checkpoint number');
  const agreeing = validReads.filter(
    ({ block }) =>
      block.hash === primaryRead.block.hash &&
      parseQuantity(block.number, 'checkpoint number') === primaryNumber,
  );
  for (const { tip, block } of validReads) {
    const observation = observations.get(tip.endpoint.label)!;
    observation.checkpointHash = block.hash;
    observation.status = agreeing.some(
      ({ tip: agreeingTip }) => agreeingTip.endpoint.label === tip.endpoint.label,
    )
      ? 'agreeing'
      : 'disagreeing';
  }
  if (agreeing.length < client.config.quorumMinimum) {
    throw new RpcConsensusError(
      `Canonical block disagreement/reorg detected at height ${primaryNumber}: ` +
        `${agreeing.length}/${endpoints.length} match primary hash ${primaryRead.block.hash}; ` +
        `${client.config.quorumMinimum} required.`,
    );
  }
  return {
    block: primaryRead.block,
    blockNumber: primaryNumber,
    lowestLatest,
    highestLatest,
    agreeing: agreeing.length,
    observations: endpoints.map(
      ({ label }) =>
        observations.get(label) ?? {
          endpoint: label,
          status: 'unavailable',
          detail: 'no observation',
        },
    ),
  };
}

/**
 * Validate identity and quorum, then pin one canonical block hash. Latest-state
 * commands use a confirmation-depth checkpoint; historical hashes are checked
 * against the canonical block at their height on the quorum.
 */
export async function prepareCommand(
  client: ShieldClient,
  blockHash?: string,
): Promise<ChainSnapshot> {
  if (blockHash && !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new ChainValidationError(`Invalid requested block hash: ${blockHash}.`);
  }
  const selected = await selectConsensusBlock(client, blockHash);
  const timestamp = parseQuantity(selected.block.timestamp, 'block timestamp');
  const confirmations = Math.max(0, selected.lowestLatest - selected.blockNumber);
  const consensus: RpcConsensus = {
    mode: client.config.rpcUrls.length > 1 ? 'quorum' : 'single-endpoint',
    total: client.config.rpcUrls.length,
    required: client.config.quorumMinimum,
    agreeing: selected.agreeing,
    checkpointNumber: selected.blockNumber,
    checkpointHash: selected.block.hash,
    lowestLatestBlock: selected.lowestLatest,
    highestLatestBlock: selected.highestLatest,
    tipSkew: selected.highestLatest - selected.lowestLatest,
    finalityConfirmations: client.config.finalityConfirmations,
    confirmations,
    meetsFinalityPolicy:
      confirmations >= client.config.finalityConfirmations,
    reorgDetected: false,
    observations: selected.observations,
  };
  return {
    chainId: client.config.network.chainId,
    blockNumber: selected.blockNumber,
    blockNumberHex: selected.block.number,
    blockHash: selected.block.hash,
    timestamp,
    ageSeconds: Math.floor(Date.now() / 1000) - timestamp,
    confirmations,
    meetsFinalityPolicy: consensus.meetsFinalityPolicy,
    finalityConfirmations: client.config.finalityConfirmations,
    consensus,
    reference: selected.block.hash,
  };
}

export function blockAnchor(snapshot: ChainSnapshot): BlockAnchor {
  return {
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    timestamp: snapshot.timestamp,
    confirmations: snapshot.confirmations,
    meetsFinalityPolicy: snapshot.meetsFinalityPolicy,
    finalityConfirmations: snapshot.finalityConfirmations,
    consensus: snapshot.consensus,
  };
}

/**
 * Re-read the pinned block number after analysis. A changed primary hash or an
 * insufficient number of matching peers means the result crossed a reorg or
 * lost quorum and must not be returned as stable evidence.
 */
export async function assertBlockAnchorCanonical(
  client: ShieldClient,
  blockAnchor: BlockAnchor,
): Promise<void> {
  const endpoints = clientEndpoints(client);
  const blockNumberHex = `0x${blockAnchor.blockNumber.toString(16)}`;
  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        const block = validateBlock(
          await endpoint.send<RawBlock | null>('eth_getBlockByNumber', [
            blockNumberHex,
            false,
          ]),
          `post-check ${blockAnchor.blockNumber}`,
        );
        return { endpoint, block };
      } catch {
        return undefined;
      }
    }),
  );
  const valid = results.filter(
    (result): result is { endpoint: RpcEndpoint; block: ValidBlock } =>
      result !== undefined,
  );
  const agreeing = valid.filter(
    ({ block }) =>
      block.hash === blockAnchor.blockHash &&
      parseQuantity(block.number, 'post-check block number') ===
        blockAnchor.blockNumber,
  );
  const primaryAgrees = agreeing.some(
    ({ endpoint }) => endpoint.label === endpoints[0]!.label,
  );
  if (!primaryAgrees || agreeing.length < blockAnchor.consensus.required) {
    throw new RpcConsensusError(
      `Pinned block reorg/loss-of-quorum detected at height ${blockAnchor.blockNumber}: ` +
        `${agreeing.length}/${endpoints.length} still report ${blockAnchor.blockHash}; ` +
        `${blockAnchor.consensus.required} required.`,
    );
  }
}

export async function assertSnapshotCanonical(
  client: ShieldClient,
  snapshot: ChainSnapshot,
): Promise<void> {
  await assertBlockAnchorCanonical(client, snapshot);
}

export async function finalizeCommandResult<T>(
  client: ShieldClient,
  snapshot: ChainSnapshot,
  result: T,
): Promise<T> {
  await assertSnapshotCanonical(client, snapshot);
  return result;
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

function normalizeRpcError(error: unknown): NormalizedError {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const inner =
      (value.error as Record<string, unknown> | undefined) ??
      ((value.info as Record<string, unknown> | undefined)?.error as
        | Record<string, unknown>
        | undefined);
    if (inner) {
      return {
        message:
          typeof inner.message === 'string' ? inner.message : String(inner),
        code: typeof inner.code === 'number' ? inner.code : undefined,
        data: typeof inner.data === 'string' ? inner.data : undefined,
      };
    }
    return {
      message:
        typeof value.message === 'string' ? value.message : String(error),
      code: typeof value.code === 'number' ? value.code : undefined,
      data: typeof value.data === 'string' ? value.data : undefined,
    };
  }
  return { message: String(error), code: undefined, data: undefined };
}

export interface TraceCapability {
  traceTransaction: boolean;
  traceCall: boolean;
  note: string;
  block: ChainSnapshot;
}

/** Live-probe both trace methods independently at the quorum-pinned block. */
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
    await client.send('debug_traceCall', [
      { from: probeFrom, to: probeFrom, data: '0x' },
      snapshot.reference,
      { tracer: 'callTracer' },
    ]);
    traceCall = true;
    notes.push('debug_traceCall(callTracer) responded at the pinned block hash.');
  } catch (error) {
    notes.push(`debug_traceCall probe failed: ${safeError(error, client.config)}.`);
  }
  if (knownTransactionHash) {
    try {
      await client.send('debug_traceTransaction', [
        knownTransactionHash,
        { tracer: 'callTracer' },
      ]);
      traceTransaction = true;
      notes.push(
        'debug_traceTransaction(callTracer) responded for the supplied real transaction.',
      );
    } catch (error) {
      notes.push(
        `debug_traceTransaction probe failed: ${safeError(error, client.config)}.`,
      );
    }
  } else {
    notes.push(
      'debug_traceTransaction was not inferred from traceCall; supply a real transaction hash to probe it.',
    );
  }
  await assertSnapshotCanonical(client, snapshot);
  return {
    traceTransaction,
    traceCall,
    note: notes.join(' '),
    block: snapshot,
  };
}
