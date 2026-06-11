/**
 * Signed, self-contained evidence bundles for Pharos Shield command results.
 *
 * The signature key is deliberately separate from any transaction key. Shield
 * signs a canonical JSON payload hash with secp256k1/EIP-191 so any consumer can
 * verify integrity offline and recover the evidence signer address.
 */

import {
  Wallet,
  getAddress,
  getBytes,
  keccak256,
  toUtf8Bytes,
  verifyMessage,
} from 'ethers';
import {
  assertBlockAnchorCanonical,
  type BlockAnchor,
  type ShieldClient,
} from './rpc.js';

const SCHEMA = 'pharos-shield-evidence/v1' as const;
const MAX_CODE_HASH_ADDRESSES = 128;

export interface EvidenceCodeHash {
  address: string;
  codeHash: string;
  codeSize: number;
}

export interface EvidencePayload {
  schema: typeof SCHEMA;
  command: 'inspect' | 'autopsy' | 'simulate' | 'probe';
  createdAt: string;
  network: string;
  chainId: number;
  block: BlockAnchor;
  resultHash: string;
  result: unknown;
  codeHashes: EvidenceCodeHash[];
  codeHashAddressLimit: number;
  codeHashAddressesTruncated: boolean;
}

export interface EvidenceSignature {
  algorithm: 'secp256k1-keccak256-eip191';
  signer: string;
  payloadHash: string;
  signature: string;
}

export interface SignedEvidenceBundle {
  payload: EvidencePayload;
  signing: EvidenceSignature;
}

export interface EvidenceVerification {
  valid: boolean;
  signer?: string;
  reason: string;
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Evidence cannot contain non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) output[key] = canonicalValue(item);
    }
    return output;
  }
  if (value === undefined) return null;
  throw new Error(`Evidence cannot encode ${typeof value}.`);
}

/** Stable JSON with recursively sorted object keys and decimal bigint strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function hashCanonical(value: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(value)));
}

function resultBlock(result: unknown): BlockAnchor {
  if (!result || typeof result !== 'object' || !('block' in result)) {
    throw new Error('Command result has no block anchor for evidence.');
  }
  const block = (result as { block: unknown }).block;
  if (
    !block ||
    typeof block !== 'object' ||
    typeof (block as BlockAnchor).blockNumber !== 'number' ||
    !/^0x[0-9a-fA-F]{64}$/.test(String((block as BlockAnchor).blockHash))
  ) {
    throw new Error('Command result contains an invalid block anchor.');
  }
  return block as BlockAnchor;
}

function collectAddresses(value: unknown, output: Set<string>): void {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) {
    try {
      output.add(getAddress(value.toLowerCase()));
    } catch {
      // A shape-compatible string that is not a valid address is not evidence.
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAddresses(item, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectAddresses(item, output);
    }
  }
}

async function collectCodeHashes(
  client: ShieldClient,
  result: unknown,
  block: BlockAnchor,
): Promise<{
  hashes: EvidenceCodeHash[];
  truncated: boolean;
}> {
  const found = new Set<string>();
  collectAddresses(result, found);
  const all = [...found].sort((a, b) => a.localeCompare(b));
  const addresses = all.slice(0, MAX_CODE_HASH_ADDRESSES);
  const entries = await Promise.all(
    addresses.map(async (address): Promise<EvidenceCodeHash | undefined> => {
      const code = await client.send<string>('eth_getCode', [
        address,
        block.blockHash,
      ]);
      if (code === '0x') return undefined;
      if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
        throw new Error(`RPC returned invalid code for ${address}.`);
      }
      return {
        address,
        codeHash: keccak256(code),
        codeSize: (code.length - 2) / 2,
      };
    }),
  );
  return {
    hashes: entries.filter(
      (entry): entry is EvidenceCodeHash => entry !== undefined,
    ),
    truncated: all.length > MAX_CODE_HASH_ADDRESSES,
  };
}

function signingKeyFromEnvironment(env: NodeJS.ProcessEnv): string {
  const key = env.PHAROS_EVIDENCE_SIGNING_KEY?.trim();
  if (!key) {
    throw new Error(
      'PHAROS_EVIDENCE_SIGNING_KEY is required to create signed evidence.',
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'PHAROS_EVIDENCE_SIGNING_KEY must be a separate 0x-prefixed 32-byte private key.',
    );
  }
  return key;
}

export async function createEvidenceBundle(
  client: ShieldClient,
  command: EvidencePayload['command'],
  result: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignedEvidenceBundle> {
  const block = resultBlock(result);
  await assertBlockAnchorCanonical(client, block);
  const code = await collectCodeHashes(client, result, block);
  await assertBlockAnchorCanonical(client, block);

  const payload: EvidencePayload = {
    schema: SCHEMA,
    command,
    createdAt: new Date().toISOString(),
    network: client.config.network.name,
    chainId: client.config.network.chainId,
    block,
    resultHash: hashCanonical(result),
    result,
    codeHashes: code.hashes,
    codeHashAddressLimit: MAX_CODE_HASH_ADDRESSES,
    codeHashAddressesTruncated: code.truncated,
  };
  const payloadHash = hashCanonical(payload);
  const wallet = new Wallet(signingKeyFromEnvironment(env));
  const signature = await wallet.signMessage(getBytes(payloadHash));
  return {
    payload,
    signing: {
      algorithm: 'secp256k1-keccak256-eip191',
      signer: wallet.address,
      payloadHash,
      signature,
    },
  };
}

export function verifyEvidenceBundle(bundle: unknown): EvidenceVerification {
  try {
    if (!bundle || typeof bundle !== 'object') {
      return { valid: false, reason: 'Evidence bundle is not an object.' };
    }
    const typed = bundle as SignedEvidenceBundle;
    if (typed.payload?.schema !== SCHEMA) {
      return { valid: false, reason: 'Unsupported evidence schema.' };
    }
    if (typed.signing?.algorithm !== 'secp256k1-keccak256-eip191') {
      return { valid: false, reason: 'Unsupported signature algorithm.' };
    }
    const resultHash = hashCanonical(typed.payload.result);
    if (resultHash !== typed.payload.resultHash) {
      return { valid: false, reason: 'Result hash mismatch.' };
    }
    const payloadHash = hashCanonical(typed.payload);
    if (payloadHash !== typed.signing.payloadHash) {
      return { valid: false, reason: 'Payload hash mismatch.' };
    }
    const recovered = getAddress(
      verifyMessage(getBytes(payloadHash), typed.signing.signature),
    );
    const claimed = getAddress(typed.signing.signer);
    if (recovered !== claimed) {
      return { valid: false, reason: 'Signature signer mismatch.' };
    }
    return {
      valid: true,
      signer: recovered,
      reason: 'Signature, payload hash, and result hash are valid.',
    };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatEvidence(bundle: SignedEvidenceBundle): string {
  return JSON.stringify(
    bundle,
    (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    2,
  );
}
