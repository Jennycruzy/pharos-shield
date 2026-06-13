import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuardFlag } from '../../scripts/guard.js';
import { guardFlags } from '../../scripts/guard.js';
import type { InspectResult } from '../../scripts/inspect.js';
import type { BlockAnchor } from '../../scripts/rpc.js';
import type { SimulateResult } from '../../scripts/simulate.js';
import type { ErcCallIntentReport } from '../../scripts/tokens.js';

const hash = `0x${'11'.repeat(32)}`;
const block: BlockAnchor = {
  blockNumber: 100,
  blockHash: hash,
  timestamp: Math.floor(Date.now() / 1000),
  confirmations: 2,
  meetsFinalityPolicy: true,
  finalityConfirmations: 2,
  consensus: {
    mode: 'single-endpoint' as const,
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

function inspected(overrides: Partial<InspectResult> = {}): InspectResult {
  return {
    network: 'mainnet',
    address: '0x0000000000000000000000000000000000000010',
    kind: 'contract',
    codeSize: 1,
    block,
    proxy: { isProxy: false, standard: 'none' },
    upgradeAuthority: 'none observed',
    notes: [],
    ...overrides,
  };
}

function simulation(
  overrides: Partial<SimulateResult> = {},
): SimulateResult {
  return {
    network: 'mainnet',
    isSimulation: true,
    from: '0x0000000000000000000000000000000000000001',
    to: '0x0000000000000000000000000000000000000010',
    block,
    willRevert: false,
    callCount: 1,
    calls: [],
    nativeValueIntents: [],
    tokens: { transfers: [], approvals: [], callIntents: [], notes: [] },
    notes: [],
    ...overrides,
  };
}

function intent(
  overrides: Partial<ErcCallIntentReport>,
): ErcCallIntentReport {
  return {
    target: '0x0000000000000000000000000000000000000010',
    caller: '0x0000000000000000000000000000000000000001',
    signature: 'approve(address,uint256)',
    kind: 'approval-intent',
    spender: '0x0000000000000000000000000000000000000020',
    amountOrTokenId: '1',
    isUnlimited: false,
    isVeryLarge: false,
    standard: 'erc-compatible-unknown',
    source: 'call-intent',
    targetHasCode: true,
    ...overrides,
  };
}

function flags(
  inspectResult: InspectResult = inspected(),
  simulateResult: SimulateResult = simulation(),
  data = '0x',
): GuardFlag[] {
  return guardFlags(inspectResult, simulateResult, data);
}

test('guard has no flags for a successful contract read', () => {
  assert.deepEqual(flags(), []);
});

test('guard surfaces approval fact flags', () => {
  const unlimited = simulation({
    tokens: {
      transfers: [],
      approvals: [],
      callIntents: [intent({ isUnlimited: true, isVeryLarge: true })],
      notes: [],
    },
  });
  assert.deepEqual(flags(inspected(), unlimited), ['unlimited_approval']);

  const veryLarge = simulation({
    tokens: {
      transfers: [],
      approvals: [],
      callIntents: [intent({ isVeryLarge: true })],
      notes: [],
    },
  });
  assert.deepEqual(flags(inspected(), veryLarge), ['very_large_approval']);

  const operator = simulation({
    tokens: {
      transfers: [],
      approvals: [],
      callIntents: [
        intent({
          signature: 'setApprovalForAll(address,bool)',
          approved: true,
          isUnlimited: true,
          isVeryLarge: true,
        }),
      ],
      notes: [],
    },
  });
  assert.deepEqual(flags(inspected(), operator), [
    'unlimited_approval',
    'set_approval_for_all',
  ]);
});

test('guard surfaces revert, native value, proxy admin, and EOA calldata facts', () => {
  assert.deepEqual(
    flags(inspected(), simulation({ willRevert: true })),
    ['would_revert'],
  );
  assert.deepEqual(
    flags(
      inspected(),
      simulation({
        nativeValueIntents: [
          {
            from: '0x0000000000000000000000000000000000000001',
            to: '0x0000000000000000000000000000000000000010',
            pros: '1.0',
          },
        ],
      }),
    ),
    ['native_value_intent'],
  );
  assert.deepEqual(
    flags(
      inspected({
        proxy: {
          isProxy: true,
          standard: 'eip1967',
          implementation: '0x0000000000000000000000000000000000000020',
          admin: '0x0000000000000000000000000000000000000030',
        },
      }),
    ),
    ['upgradeable_proxy_admin_set'],
  );
  assert.deepEqual(
    flags(inspected({ kind: 'eoa', codeSize: 0 }), simulation(), '0x1234'),
    ['target_is_eoa'],
  );
});
