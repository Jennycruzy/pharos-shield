import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSnapshotCanonical,
  ChainValidationError,
  prepareCommand,
  probeTraceSupport,
  RpcConsensusError,
  RpcError,
  type RpcEndpoint,
  type ShieldClient,
} from '../../scripts/rpc.js';
import { FRESH_BLOCK, mockClient, testConfig } from '../helpers.js';
import type { JsonRpcProvider } from 'ethers';

test('prepareCommand rejects a wrong-chain RPC before reading state', async () => {
  const client = mockClient((method) => {
    assert.equal(method, 'eth_chainId');
    return '0x1';
  });
  await assert.rejects(prepareCommand(client), ChainValidationError);
});

test('prepareCommand rejects stale latest blocks', async () => {
  const stale = {
    ...FRESH_BLOCK,
    timestamp: '0x' + (Math.floor(Date.now() / 1000) - 301).toString(16),
  };
  const client = mockClient((method) => {
    if (method === 'eth_chainId') return '0x688';
    if (method === 'eth_getBlockByNumber') return stale;
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(prepareCommand(client), /stale/);
});

test('trace probe reports RPC failures as unsupported, never as proof', async () => {
  const client = mockClient((method) => {
    if (method === 'eth_chainId') return '0x688';
    if (method === 'eth_getBlockByNumber') return FRESH_BLOCK;
    if (method.startsWith('debug_')) {
      throw new RpcError('DNS failure', undefined, method);
    }
    throw new Error(`unexpected ${method}`);
  });
  const result = await probeTraceSupport(client, '0x' + '22'.repeat(32));
  assert.equal(result.traceCall, false);
  assert.equal(result.traceTransaction, false);
  assert.match(result.note, /DNS failure/);
});

test('prepareCommand pins the canonical block hash', async () => {
  const calls: Array<[string, unknown[]]> = [];
  const client = mockClient((method, params) => {
    calls.push([method, params]);
    if (method === 'eth_chainId') return '0x688';
    if (method === 'eth_getBlockByNumber') return FRESH_BLOCK;
    throw new Error(`unexpected ${method}`);
  });
  const snapshot = await prepareCommand(client);
  assert.equal(snapshot.reference, FRESH_BLOCK.hash);
  assert.equal(calls.at(-1)?.[0], 'eth_getBlockByNumber');
});

function block(number: number, byte: string) {
  return {
    number: `0x${number.toString(16)}`,
    hash: `0x${byte.repeat(64)}`,
    timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
  };
}

function quorumClient(
  handler: (index: number, method: string, params: unknown[]) => unknown,
): ShieldClient {
  const rpcUrls = [
    'https://one.example',
    'https://two.example',
    'https://three.example',
  ];
  const endpoints: RpcEndpoint[] = rpcUrls.map((_url, index) => ({
    label: `rpc#${index + 1}`,
    async send<T>(method: string, params: unknown[]): Promise<T> {
      return handler(index, method, params) as T;
    },
  }));
  return {
    config: testConfig({
      rpcUrls,
      rpcUrl: rpcUrls[0]!,
      quorumMinimum: 2,
      finalityConfirmations: 2,
      maxTipSkew: 3,
    }),
    provider: {} as JsonRpcProvider,
    endpoints,
    send: endpoints[0]!.send,
  };
}

test('prepareCommand selects a finality-depth block agreed by an RPC quorum', async () => {
  const client = quorumClient((index, method, params) => {
    if (method === 'eth_chainId') return '0x688';
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') {
      return block(102 + index, String(index + 1));
    }
    if (method === 'eth_getBlockByNumber' && params[0] === '0x64') {
      return block(100, 'a');
    }
    throw new Error(`unexpected ${method} ${String(params[0])}`);
  });
  const snapshot = await prepareCommand(client);
  assert.equal(snapshot.blockNumber, 100);
  assert.equal(snapshot.confirmations, 2);
  assert.equal(snapshot.meetsFinalityPolicy, true);
  assert.equal(snapshot.consensus.mode, 'quorum');
  assert.equal(snapshot.consensus.agreeing, 3);
});

test('prepareCommand rejects a primary hash outside the RPC quorum', async () => {
  const client = quorumClient((index, method, params) => {
    if (method === 'eth_chainId') return '0x688';
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') {
      return block(102, String(index + 1));
    }
    if (method === 'eth_getBlockByNumber' && params[0] === '0x64') {
      return block(100, index === 0 ? 'a' : 'b');
    }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(prepareCommand(client), RpcConsensusError);
});

test('post-command canonicality check detects a reorg of the primary block', async () => {
  let postCheck = false;
  const client = quorumClient((index, method, params) => {
    if (method === 'eth_chainId') return '0x688';
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') {
      return block(102, String(index + 1));
    }
    if (method === 'eth_getBlockByNumber' && params[0] === '0x64') {
      return block(100, postCheck && index === 0 ? 'b' : 'a');
    }
    throw new Error(`unexpected ${method}`);
  });
  const snapshot = await prepareCommand(client);
  postCheck = true;
  await assert.rejects(
    assertSnapshotCanonical(client, snapshot),
    RpcConsensusError,
  );
});

test('historical block hashes must remain canonical on the RPC quorum', async () => {
  const requestedHash = `0x${'a'.repeat(64)}`;
  const client = quorumClient((index, method, params) => {
    if (method === 'eth_chainId') return '0x688';
    if (method === 'eth_getBlockByNumber' && params[0] === 'latest') {
      return block(102, String(index + 1));
    }
    if (method === 'eth_getBlockByHash') return block(100, 'a');
    if (method === 'eth_getBlockByNumber' && params[0] === '0x64') {
      return block(100, index === 0 ? 'a' : 'b');
    }
    throw new Error(`unexpected ${method}`);
  });
  await assert.rejects(
    prepareCommand(client, requestedHash),
    RpcConsensusError,
  );
});
