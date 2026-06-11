import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTokenReport,
  decodeTokenCalls,
} from '../../scripts/tokens.js';
import type { CallFrame } from '../../scripts/trace.js';

test('selector-derived calls are intents, not token movements', () => {
  const input =
    '0xa9059cbb' +
    '0'.repeat(24) +
    '0000000000000000000000000000000000000002' +
    '0'.repeat(63) +
    '1';
  const frame: CallFrame = {
    type: 'CALL',
    from: '0x0000000000000000000000000000000000000001',
    to: '0x0000000000000000000000000000000000000003',
    input,
  };
  const decoded = decodeTokenCalls([frame]);
  const report = buildTokenReport(
    decoded,
    new Map(),
    new Map([['0x0000000000000000000000000000000000000003', false]]),
  );
  assert.equal(report.transfers.length, 0);
  assert.equal(report.approvals.length, 0);
  assert.equal(report.callIntents.length, 1);
  assert.equal(report.callIntents[0]?.targetHasCode, false);
  assert.equal(report.callIntents[0]?.standard, 'erc-compatible-unknown');
});

test('transferFrom does not assert ERC-20 versus ERC-721', () => {
  const input =
    '0x23b872dd' +
    '0'.repeat(24) +
    '0000000000000000000000000000000000000001' +
    '0'.repeat(24) +
    '0000000000000000000000000000000000000002' +
    '0'.repeat(63) +
    '7';
  const decoded = decodeTokenCalls([
    {
      type: 'CALL',
      from: '0x0000000000000000000000000000000000000003',
      to: '0x0000000000000000000000000000000000000004',
      input,
    },
  ]);
  assert.equal(decoded.callIntents[0]?.standard, 'erc-compatible-unknown');
  assert.equal(decoded.callIntents[0]?.amountOrTokenId, '7');
});
