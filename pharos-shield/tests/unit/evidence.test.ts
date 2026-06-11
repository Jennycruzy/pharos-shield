import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet, keccak256 } from 'ethers';
import {
  createEvidenceBundle,
  verifyEvidenceBundle,
} from '../../scripts/evidence.js';
import type { BlockAnchor } from '../../scripts/rpc.js';
import { mockClient } from '../helpers.js';

const hash = `0x${'11'.repeat(32)}`;
const now = Math.floor(Date.now() / 1000);
const block: BlockAnchor = {
  blockNumber: 100,
  blockHash: hash,
  timestamp: now,
  confirmations: 2,
  meetsFinalityPolicy: true,
  finalityConfirmations: 2,
  consensus: {
    mode: 'single-endpoint',
    total: 1,
    required: 1,
    agreeing: 1,
    checkpointNumber: 100,
    checkpointHash: hash,
    lowestLatestBlock: 102,
    highestLatestBlock: 102,
    tipSkew: 0,
    finalityConfirmations: 2,
    confirmations: 2,
    meetsFinalityPolicy: true,
    reorgDetected: false,
    observations: [],
  },
};

test('signed evidence commits to the result, block, and contract code hashes', async () => {
  const contract = '0x0000000000000000000000000000000000000010';
  const code = '0x6001600055';
  const client = mockClient((method, params) => {
    if (method === 'eth_getBlockByNumber') {
      return {
        number: '0x64',
        hash,
        timestamp: `0x${now.toString(16)}`,
      };
    }
    if (method === 'eth_getCode') {
      return String(params[0]).toLowerCase() === contract.toLowerCase()
        ? code
        : '0x';
    }
    throw new Error(`unexpected ${method}`);
  });
  const key = Wallet.createRandom().privateKey;
  const result = {
    network: 'mainnet',
    address: contract,
    block,
    fact: 'verified',
  };
  const bundle = await createEvidenceBundle(client, 'inspect', result, {
    PHAROS_EVIDENCE_SIGNING_KEY: key,
  });
  assert.equal(bundle.payload.block.blockHash, hash);
  assert.deepEqual(bundle.payload.codeHashes, [
    {
      address: contract,
      codeHash: keccak256(code),
      codeSize: 5,
    },
  ]);
  assert.equal(verifyEvidenceBundle(bundle).valid, true);

  const tampered = structuredClone(bundle);
  (tampered.payload.result as { fact: string }).fact = 'changed';
  assert.equal(verifyEvidenceBundle(tampered).valid, false);
});
