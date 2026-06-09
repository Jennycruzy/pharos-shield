/**
 * Pharos Shield — network & protocol configuration.
 *
 * Every value here was confirmed against the live Pharos network before being
 * committed. See README "Verified-vs-degraded status" for the probe results.
 *
 *  - Mainnet (Pacific Ocean, chain 1672) is the DEFAULT and the network every
 *    example/demo in this repo is run on. Its RPC (https://rpc.pharos.xyz) was
 *    confirmed on 2026-06-09 to return chainId 0x688 and to expose the debug_*
 *    trace namespace (debug_traceTransaction / debug_traceCall, callTracer).
 *  - Testnet (chain 688688) is a SECONDARY convenience toggle. A public,
 *    trace-enabled testnet RPC could NOT be confirmed from a clean environment
 *    at build time, so its default URL is marked unconfirmed below. Override it
 *    with PHAROS_TESTNET_RPC if you have a working endpoint.
 */

export type NetworkName = 'mainnet' | 'testnet';

export interface NetworkConfig {
  readonly name: NetworkName;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly explorer: string;
  /** Native currency symbol. */
  readonly symbol: string;
  /**
   * Whether the built-in default RPC for this network was verified end-to-end
   * (chainId + debug trace namespace) at build time. Used purely for honest
   * reporting; it does not gate functionality — rpc.ts probes capabilities live.
   */
  readonly defaultRpcVerified: boolean;
}

/**
 * EIP-1967 standard storage slots. These are chain-agnostic constants defined
 * by the standard (keccak256("eip1967.proxy.*") - 1) and are read directly via
 * eth_getStorageAt. Confirmed readable on Pharos mainnet.
 */
export const EIP1967_SLOTS = {
  /** keccak256("eip1967.proxy.implementation") - 1 */
  implementation:
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  /** keccak256("eip1967.proxy.admin") - 1 */
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  /** keccak256("eip1967.proxy.beacon") - 1 */
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
} as const;

/**
 * Legacy / OpenZeppelin "unstructured storage" implementation slot,
 * keccak256("org.zeppelinos.proxy.implementation"). Some older proxies use this
 * instead of the EIP-1967 slot. Read as a secondary signal only.
 */
export const LEGACY_IMPL_SLOT =
  '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';

const MAINNET: NetworkConfig = {
  name: 'mainnet',
  chainId: 1672,
  // Confirmed: returns 0x688 and exposes debug_traceTransaction/callTracer.
  rpcUrl: 'https://rpc.pharos.xyz',
  explorer: 'https://pharosscan.xyz',
  symbol: 'PROS',
  defaultRpcVerified: true,
};

const TESTNET: NetworkConfig = {
  name: 'testnet',
  chainId: 688688,
  // UNCONFIRMED default — a public trace-enabled testnet RPC was not reachable
  // from a clean environment at build time. Override via PHAROS_TESTNET_RPC.
  rpcUrl: 'https://testnet.dplabs-internal.com',
  explorer: 'https://testnet.pharosscan.xyz',
  symbol: 'PROS',
  defaultRpcVerified: false,
};

const NETWORKS: Record<NetworkName, NetworkConfig> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};

function parseNetwork(raw: string | undefined): NetworkName {
  if (raw === undefined || raw.trim() === '') return 'mainnet';
  const v = raw.trim().toLowerCase();
  if (v === 'mainnet' || v === '1672') return 'mainnet';
  if (v === 'testnet' || v === '688688') return 'testnet';
  throw new Error(
    `Invalid PHAROS_NETWORK="${raw}". Expected "mainnet" (default) or "testnet".`,
  );
}

export interface ResolvedConfig {
  readonly network: NetworkConfig;
  readonly rpcUrl: string;
  readonly timeoutMs: number;
}

/**
 * Resolve effective configuration from environment, applying overrides.
 * Mainnet is the default when PHAROS_NETWORK is unset.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const network = NETWORKS[parseNetwork(env.PHAROS_NETWORK)];

  const rpcOverride =
    network.name === 'mainnet'
      ? env.PHAROS_MAINNET_RPC
      : env.PHAROS_TESTNET_RPC;
  const rpcUrl =
    rpcOverride && rpcOverride.trim() !== ''
      ? rpcOverride.trim()
      : network.rpcUrl;

  let timeoutMs = 20_000;
  const rawTimeout = env.PHAROS_RPC_TIMEOUT_MS;
  if (rawTimeout !== undefined && rawTimeout.trim() !== '') {
    const parsed = Number(rawTimeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid PHAROS_RPC_TIMEOUT_MS="${rawTimeout}". Expected a positive number of milliseconds.`,
      );
    }
    timeoutMs = parsed;
  }

  return { network, rpcUrl, timeoutMs };
}

export function getNetwork(name: NetworkName): NetworkConfig {
  return NETWORKS[name];
}
