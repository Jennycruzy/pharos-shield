import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeValueIntents } from '../../scripts/decode.js';
import { propagatedFailure, type CallFrame } from '../../scripts/trace.js';

test('propagatedFailure ignores caught reverts and follows matching root payload', () => {
  const payload = '0x08c379a0' + '00'.repeat(32);
  const root: CallFrame = {
    type: 'CALL',
    from: '0x0',
    to: '0x1',
    error: 'execution reverted',
    output: payload,
    calls: [
      {
        type: 'CALL',
        from: '0x0',
        to: '0x3',
        calls: [
          {
            type: 'CALL',
            from: '0x1',
            to: '0x2',
            error: 'execution reverted',
            output: '0xdeadbeef',
          },
        ],
      },
      {
        type: 'CALL',
        from: '0x0',
        to: '0x4',
        error: 'execution reverted',
        output: payload,
      },
    ],
  };
  const failure = propagatedFailure(root);
  assert.ok(failure);
  assert.deepEqual(failure.path.map(({ path }) => path), [[], [1]]);
  assert.deepEqual(failure.nonPropagating.map(({ path }) => path), [[0, 0]]);
});

test('nativeValueIntents excludes value rolled back by an errored ancestor', () => {
  const root: CallFrame = {
    type: 'CALL',
    from: '0x1',
    to: '0x2',
    error: 'execution reverted',
    calls: [
      {
        type: 'CALL',
        from: '0x2',
        to: '0x3',
        value: '0x1',
      },
    ],
  };
  assert.deepEqual(nativeValueIntents(root), []);
});
