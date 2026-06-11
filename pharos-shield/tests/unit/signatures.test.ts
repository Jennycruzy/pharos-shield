import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, id } from 'ethers';
import { decodeWithSignature } from '../../scripts/signatures.js';

test('signature decoding rejects trailing payload words', () => {
  const signature = 'Example(uint256)';
  const canonical =
    id(signature).slice(0, 10) +
    AbiCoder.defaultAbiCoder().encode(['uint256'], [1n]).slice(2);
  assert.ok(decodeWithSignature(signature, canonical));
  const withTrailingWord = canonical + '0'.repeat(63) + '2';
  assert.equal(decodeWithSignature(signature, withTrailingWord), undefined);
});
