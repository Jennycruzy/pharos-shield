import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {
  AbiCoder,
  Interface,
  getAddress,
  hexlify,
  zeroPadValue,
} from 'ethers';
import { decodeRevert } from '../../scripts/decode.js';
import {
  addressFromSlot,
  classifyProxySlots,
} from '../../scripts/inspect.js';
import { decodeTokenCalls, MAX_UINT256 } from '../../scripts/tokens.js';
import type { CallFrame } from '../../scripts/trace.js';

const abi = AbiCoder.defaultAbiCoder();
const erc = new Interface([
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function approve(address,uint256)',
  'function setApprovalForAll(address,bool)',
]);
const caller = '0x0000000000000000000000000000000000000001';
const target = '0x0000000000000000000000000000000000000002';
const zeroWord = `0x${'00'.repeat(32)}`;
const addressArbitrary = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((bytes) => getAddress(hexlify(bytes)))
  .filter((address) => address !== '0x0000000000000000000000000000000000000000');
const uint256Arbitrary = fc.bigInt({ min: 0n, max: MAX_UINT256 });

function intents(input: string) {
  const frame: CallFrame = { type: 'CALL', from: caller, to: target, input };
  return decodeTokenCalls([frame]).callIntents;
}

test('property: canonical ERC calldata round-trips to one exact call intent', () => {
  fc.assert(
    fc.property(
      addressArbitrary,
      addressArbitrary,
      uint256Arbitrary,
      fc.boolean(),
      (first, second, amount, approved) => {
        const transfer = intents(
          erc.encodeFunctionData('transfer', [first, amount]),
        );
        assert.equal(transfer.length, 1);
        assert.equal(transfer[0]?.to, first);
        assert.equal(transfer[0]?.amountOrTokenId, amount.toString());

        const transferFrom = intents(
          erc.encodeFunctionData('transferFrom', [first, second, amount]),
        );
        assert.equal(transferFrom.length, 1);
        assert.equal(transferFrom[0]?.from, first);
        assert.equal(transferFrom[0]?.to, second);
        assert.equal(transferFrom[0]?.amountOrTokenId, amount.toString());

        const approval = intents(
          erc.encodeFunctionData('approve', [first, amount]),
        );
        assert.equal(approval.length, 1);
        assert.equal(approval[0]?.spender, first);
        assert.equal(approval[0]?.isUnlimited, amount === MAX_UINT256);

        const operator = intents(
          erc.encodeFunctionData('setApprovalForAll', [first, approved]),
        );
        assert.equal(operator.length, 1);
        assert.equal(operator[0]?.approved, approved);
      },
    ),
    { numRuns: 300 },
  );
});

test('property: trailing or arbitrary calldata never becomes a decoded intent', () => {
  fc.assert(
    fc.property(
      addressArbitrary,
      uint256Arbitrary,
      fc.uint8Array({ minLength: 1, maxLength: 96 }),
      (recipient, amount, suffix) => {
        const canonical = erc.encodeFunctionData('transfer', [recipient, amount]);
        assert.deepEqual(intents(canonical + hexlify(suffix).slice(2)), []);
      },
    ),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(
      fc.uint8Array({ maxLength: 256 }),
      (bytes) => {
        assert.doesNotThrow(() => intents(hexlify(bytes)));
      },
    ),
    { numRuns: 500 },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (malformedTarget) => {
      const frame: CallFrame = {
        type: 'CALL',
        from: caller,
        to: malformedTarget,
        input: erc.encodeFunctionData('transfer', [caller, 1n]),
      };
      assert.doesNotThrow(() => decodeTokenCalls([frame]));
    }),
    { numRuns: 300 },
  );
});

test('property: standard revert payloads decode exactly and reject trailing words', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 256 }), (reason) => {
      const encoded =
        '0x08c379a0' + abi.encode(['string'], [reason]).slice(2);
      const decoded = decodeRevert(encoded);
      assert.equal(decoded.kind, 'Error');
      assert.equal(decoded.reason, reason);
      const trailing = decodeRevert(encoded + '00'.repeat(32));
      assert.equal(trailing.kind, 'Error');
      assert.match(trailing.reason, /undecodable/);
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 255 }), (code) => {
      const encoded =
        '0x4e487b71' + abi.encode(['uint256'], [BigInt(code)]).slice(2);
      const decoded = decodeRevert(encoded);
      assert.equal(decoded.kind, 'Panic');
      assert.equal(decoded.raw, encoded);
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(uint256Arbitrary, (code) => {
      const encoded =
        '0x4e487b71' + abi.encode(['uint256'], [code]).slice(2);
      assert.match(decodeRevert(encoded).reason, new RegExp(code.toString(16)));
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
      assert.doesNotThrow(() => decodeRevert(hexlify(bytes)));
    }),
    { numRuns: 500 },
  );
});

test('property: proxy slots accept only canonical right-aligned addresses', () => {
  fc.assert(
    fc.property(addressArbitrary, (implementation) => {
      const word = zeroPadValue(implementation, 32);
      assert.equal(addressFromSlot(word), implementation);
      const info = classifyProxySlots(
        word,
        zeroWord,
        zeroWord,
        zeroWord,
        [],
      );
      assert.equal(info.standard, 'eip1967');
      assert.equal(info.implementation, implementation);
    }),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 32, maxLength: 32 }).filter(
        (bytes) => bytes.slice(0, 12).some((value) => value !== 0),
      ),
      (bytes) => {
        const word = hexlify(bytes);
        assert.equal(addressFromSlot(word), undefined);
        const info = classifyProxySlots(
          word,
          zeroWord,
          zeroWord,
          zeroWord,
          [],
        );
        assert.equal(info.isProxy, false);
      },
    ),
    { numRuns: 500 },
  );
});
