/**
 * inspect <address> — CONTROL STRUCTURE analysis from on-chain facts only.
 *
 * Classifies contract vs EOA (eth_getCode), reads the three EIP-1967 storage
 * slots (implementation/admin/beacon) plus the legacy OZ slot, and reports the
 * proxy/implementation/admin facts that storage PROVES.
 *
 * It does NOT claim "verified source" or upgrade authority beyond what the
 * admin slot shows: Pharos's explorer exposes no public source-verification API
 * (confirmed at build time — it sits behind a bot wall), so source-level
 * enrichment is intentionally omitted rather than faked.
 */

import { ethers, getAddress } from 'ethers';
import type { ShieldClient } from './rpc.js';
import { EIP1967_SLOTS, LEGACY_IMPL_SLOT } from './config.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Extract a 20-byte address from a 32-byte storage word (right-aligned). */
function addressFromSlot(word: string): string {
  // word is 0x + 64 hex; the address is the low 20 bytes (last 40 hex chars).
  const hex = word.replace(/^0x/, '').padStart(64, '0');
  const addr = '0x' + hex.slice(24);
  return getAddress(addr);
}

function isZeroWord(word: string): boolean {
  return /^0x0*$/.test(word);
}

export type AddressKind = 'eoa' | 'contract';

export interface ProxyInfo {
  isProxy: boolean;
  /** "eip1967" | "eip1967-beacon" | "legacy-oz" | "none" */
  standard: 'eip1967' | 'eip1967-beacon' | 'legacy-oz' | 'none';
  implementation?: string;
  admin?: string;
  beacon?: string;
}

export interface InspectResult {
  network: string;
  address: string;
  kind: AddressKind;
  /** Size of deployed bytecode in bytes (0 for EOA). */
  codeSize: number;
  proxy: ProxyInfo;
  /** What the admin slot implies about upgrade authority (inferred, not source). */
  upgradeAuthority: string;
  notes: string[];
}

export async function inspect(
  client: ShieldClient,
  rawAddress: string,
): Promise<InspectResult> {
  let address: string;
  try {
    address = getAddress(rawAddress.trim());
  } catch {
    throw new Error(`Invalid address: "${rawAddress}".`);
  }

  const notes: string[] = [];
  const code = await client.provider.getCode(address);
  const codeSize = code === '0x' ? 0 : (code.length - 2) / 2;

  if (codeSize === 0) {
    return {
      network: client.config.network.name,
      address,
      kind: 'eoa',
      codeSize: 0,
      proxy: { isProxy: false, standard: 'none' },
      upgradeAuthority:
        'not applicable — this is an externally-owned account (no code, no upgrade slots)',
      notes: ['eth_getCode returned 0x: no contract deployed at this address.'],
    };
  }

  // Read all candidate slots concurrently.
  const [implWord, adminWord, beaconWord, legacyWord] = await Promise.all([
    client.send<string>('eth_getStorageAt', [address, EIP1967_SLOTS.implementation, 'latest']),
    client.send<string>('eth_getStorageAt', [address, EIP1967_SLOTS.admin, 'latest']),
    client.send<string>('eth_getStorageAt', [address, EIP1967_SLOTS.beacon, 'latest']),
    client.send<string>('eth_getStorageAt', [address, LEGACY_IMPL_SLOT, 'latest']),
  ]);

  const proxy = classifyProxy(implWord, adminWord, beaconWord, legacyWord, notes);
  const upgradeAuthority = describeUpgradeAuthority(proxy);

  return {
    network: client.config.network.name,
    address,
    kind: 'contract',
    codeSize,
    proxy,
    upgradeAuthority,
    notes,
  };
}

function classifyProxy(
  implWord: string,
  adminWord: string,
  beaconWord: string,
  legacyWord: string,
  notes: string[],
): ProxyInfo {
  const hasImpl = !isZeroWord(implWord);
  const hasBeacon = !isZeroWord(beaconWord);
  const hasLegacy = !isZeroWord(legacyWord);
  const hasAdmin = !isZeroWord(adminWord);

  if (hasImpl) {
    const implementation = addressFromSlot(implWord);
    const info: ProxyInfo = {
      isProxy: true,
      standard: 'eip1967',
      implementation,
    };
    if (hasAdmin) info.admin = addressFromSlot(adminWord);
    notes.push(
      `EIP-1967 implementation slot is non-zero -> proxy. Implementation = ${implementation}.`,
    );
    if (hasAdmin) {
      notes.push(`EIP-1967 admin slot = ${info.admin} (controls upgrades).`);
    } else {
      notes.push(
        'EIP-1967 admin slot is zero: upgrades may be governed by the implementation logic ' +
          '(e.g. UUPS) rather than a ProxyAdmin. Cannot prove the upgrader from storage alone.',
      );
    }
    return info;
  }

  if (hasBeacon) {
    const beacon = addressFromSlot(beaconWord);
    notes.push(
      `EIP-1967 beacon slot is non-zero -> beacon proxy. Beacon = ${beacon}. ` +
        'The implementation is resolved by the beacon contract at call time.',
    );
    const info: ProxyInfo = { isProxy: true, standard: 'eip1967-beacon', beacon };
    if (hasAdmin) info.admin = addressFromSlot(adminWord);
    return info;
  }

  if (hasLegacy) {
    const implementation = addressFromSlot(legacyWord);
    notes.push(
      `Legacy OpenZeppelin implementation slot is non-zero -> legacy proxy. Implementation = ${implementation}.`,
    );
    return { isProxy: true, standard: 'legacy-oz', implementation };
  }

  notes.push(
    'No EIP-1967 (implementation/beacon) or legacy proxy slot set: no proxy detected. ' +
      'This is a non-proxy contract as far as standard storage slots can prove.',
  );
  return { isProxy: false, standard: 'none' };
}

function describeUpgradeAuthority(proxy: ProxyInfo): string {
  if (!proxy.isProxy) {
    return 'no proxy slots set — no upgrade mechanism provable from storage. Logic at this address is fixed unless it self-destructs or uses a non-standard pattern.';
  }
  if (proxy.standard === 'eip1967-beacon') {
    return `beacon proxy — upgrade authority lives in the beacon contract ${proxy.beacon}, not this address. Inspect the beacon to find its owner.`;
  }
  if (proxy.admin && proxy.admin !== ZERO_ADDRESS) {
    return `inferred from the EIP-1967 admin slot: ${proxy.admin} can upgrade this proxy. (Inferred from storage, NOT from verified source.)`;
  }
  return 'admin slot is zero — likely a UUPS proxy where the upgrade function lives in the implementation and is gated by that contract\'s own access control. Not provable from storage alone.';
}

/** Format an InspectResult for human-readable CLI output. */
export function formatInspect(r: InspectResult): string {
  const lines: string[] = [];
  lines.push(`Address:   ${r.address}  (${r.network})`);
  lines.push(`Kind:      ${r.kind}${r.kind === 'contract' ? ` (${r.codeSize} bytes of code)` : ''}`);
  if (r.kind === 'contract') {
    lines.push(`Proxy:     ${r.proxy.isProxy ? `yes (${r.proxy.standard})` : 'no'}`);
    if (r.proxy.implementation) lines.push(`Impl:      ${r.proxy.implementation}`);
    if (r.proxy.beacon) lines.push(`Beacon:    ${r.proxy.beacon}`);
    if (r.proxy.admin) lines.push(`Admin:     ${r.proxy.admin}`);
    lines.push(`Upgrade:   ${r.upgradeAuthority}`);
  }
  lines.push('Facts:');
  for (const n of r.notes) lines.push(`  - ${n}`);
  return lines.join('\n');
}

// Re-export for callers that want ethers formatting parity.
export { ethers };
