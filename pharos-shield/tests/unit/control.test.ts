import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder } from 'ethers';
import { EIP1967_SLOTS } from '../../scripts/config.js';
import { buildControlGraph } from '../../scripts/control.js';
import type { ChainSnapshot } from '../../scripts/rpc.js';
import { mockClient } from '../helpers.js';

const abi = AbiCoder.defaultAbiCoder();
const proxy = '0x0000000000000000000000000000000000000010';
const implementation = '0x0000000000000000000000000000000000000020';
const admin = '0x0000000000000000000000000000000000000030';
const owner = '0x0000000000000000000000000000000000000040';
const secondOwner = '0x0000000000000000000000000000000000000050';
const snapshot: ChainSnapshot = {
  chainId: 1672,
  blockNumber: 100,
  blockNumberHex: '0x64',
  blockHash: '0x' + '11'.repeat(32),
  timestamp: Math.floor(Date.now() / 1000),
  ageSeconds: 0,
  confirmations: 2,
  meetsFinalityPolicy: true,
  finalityConfirmations: 2,
  consensus: {
    mode: 'single-endpoint',
    total: 1,
    required: 1,
    agreeing: 1,
    checkpointNumber: 100,
    checkpointHash: '0x' + '11'.repeat(32),
    lowestLatestBlock: 102,
    highestLatestBlock: 102,
    tipSkew: 0,
    finalityConfirmations: 2,
    confirmations: 2,
    meetsFinalityPolicy: true,
    reorgDetected: false,
    observations: [],
  },
  reference: '0x' + '11'.repeat(32),
};

test('control graph records code hashes, owner, multisig, timelock, and UUPS', async () => {
  const client = mockClient((method, params) => {
    if (method === 'eth_getCode') return '0x6000';
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const request = params[0] as Record<string, string>;
    const to = request.to?.toLowerCase();
    const data = request.data;
    if (to === implementation.toLowerCase() && data === '0x52d1902d') {
      return abi.encode(['bytes32'], [EIP1967_SLOTS.implementation]);
    }
    if (to === admin.toLowerCase() && data === '0x8da5cb5b') {
      return abi.encode(['address'], [owner]);
    }
    if (to === admin.toLowerCase() && data === '0xa0e67e2b') {
      return abi.encode(['address[]'], [[owner, secondOwner]]);
    }
    if (to === admin.toLowerCase() && data === '0xe75235b8') {
      return abi.encode(['uint256'], [2n]);
    }
    if (to === admin.toLowerCase() && data === '0xf27a0c92') {
      return abi.encode(['uint256'], [3600n]);
    }
    throw new Error('method absent');
  });
  const graph = await buildControlGraph(
    client,
    { target: proxy, implementation, admin },
    snapshot,
  );
  const implNode = graph.nodes.find((node) => node.address === implementation);
  const adminNode = graph.nodes.find((node) => node.address === admin);
  assert.equal(implNode?.uups?.matchesEip1967ImplementationSlot, true);
  assert.equal(adminNode?.reportedOwner, owner);
  assert.equal(adminNode?.multisig?.threshold, '2');
  assert.equal(adminNode?.timelock?.minDelaySeconds, '3600');
  assert.ok(graph.edges.some((edge) => edge.relation === 'admin-slot'));
});
