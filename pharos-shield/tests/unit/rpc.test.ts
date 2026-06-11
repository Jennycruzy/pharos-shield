import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChainValidationError,
  prepareCommand,
  probeTraceSupport,
  RpcError,
} from '../../scripts/rpc.js';
import { FRESH_BLOCK, mockClient } from '../helpers.js';

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
