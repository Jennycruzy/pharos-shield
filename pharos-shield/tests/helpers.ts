import type { JsonRpcProvider } from 'ethers';
import type { NetworkConfig, ResolvedConfig } from '../scripts/config.js';
import type { ShieldClient } from '../scripts/rpc.js';

const TEST_NETWORK: NetworkConfig = {
  name: 'mainnet',
  chainId: 1672,
  rpcUrl: 'https://example.invalid',
  explorer: 'https://example.invalid',
  symbol: 'PROS',
  defaultRpcVerified: false,
};

export function testConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    network: TEST_NETWORK,
    rpcUrls: [TEST_NETWORK.rpcUrl],
    rpcUrl: TEST_NETWORK.rpcUrl,
    timeoutMs: 1000,
    maxBlockAgeSeconds: 300,
    quorumMinimum: 1,
    finalityConfirmations: 0,
    maxTipSkew: 5,
    ...overrides,
  };
}

export function mockClient(
  handler: (method: string, params: unknown[]) => unknown | Promise<unknown>,
  config: ResolvedConfig = testConfig(),
): ShieldClient {
  return {
    config,
    provider: {} as JsonRpcProvider,
    async send<T>(method: string, params: unknown[]): Promise<T> {
      return (await handler(method, params)) as T;
    },
  };
}

export const FRESH_BLOCK = {
  number: '0x64',
  hash: '0x' + '11'.repeat(32),
  timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
};
