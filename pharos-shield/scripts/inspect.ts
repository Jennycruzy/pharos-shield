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
import {
  getCodeAt,
  getStorageAt,
  blockAnchor,
  finalizeCommandResult,
  prepareCommand,
  type BlockAnchor,
  type ShieldClient,
} from './rpc.js';
import { EIP1967_SLOTS, LEGACY_IMPL_SLOT } from './config.js';
import { scanOpcodes, detectMinimalProxy, type OpcodeScan } from './bytecode.js';
import { buildControlGraph, type ControlGraph } from './control.js';
import {
  readTraits,
  readTokenInfo,
  readInterfaces,
  resolveBeaconImplementation,
  type ContractTraits,
  type TokenInfo,
} from './traits.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Decode a canonical right-aligned address storage word; reject junk high bits. */
export function addressFromSlot(word: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) return undefined;
  const hex = word.slice(2);
  if (!/^0{24}/.test(hex)) return undefined;
  const address = getAddress(`0x${hex.slice(24)}`);
  return address === ZERO_ADDRESS ? undefined : address;
}

function isZeroWord(word: string): boolean {
  return /^0x0*$/.test(word);
}

export type AddressKind = 'eoa' | 'contract';

export interface ProxyInfo {
  isProxy: boolean;
  /** "eip1967" | "eip1967-beacon" | "legacy-oz" | "eip1167-minimal" | "none" */
  standard: 'eip1967' | 'eip1967-beacon' | 'legacy-oz' | 'eip1167-minimal' | 'none';
  implementation?: string;
  admin?: string;
  beacon?: string;
  /** Implementation resolved by calling beacon.implementation() (beacon proxies). */
  beaconImplementation?: string;
}

export interface BytecodeInfo {
  opcodes: string[];
  hasDelegateCall: boolean;
  hasSelfDestruct: boolean;
  hasCreate2: boolean;
}

export interface InspectResult {
  network: string;
  address: string;
  kind: AddressKind;
  /** Size of deployed bytecode in bytes (0 for EOA). */
  codeSize: number;
  block: BlockAnchor;
  proxy: ProxyInfo;
  /** What the admin slot implies about upgrade authority (inferred, not source). */
  upgradeAuthority: string;
  /** Static bytecode signals (PUSH-aware opcode scan). Contract only. */
  bytecode?: BytecodeInfo;
  /** Live owner()/paused()/implementation() reads, when the contract answers. */
  traits?: ContractTraits;
  /** ERC-20 token metadata, when present. */
  token?: TokenInfo;
  /** ERC-165 interfaces the contract declares support for. */
  interfaces?: string[];
  controlGraph?: ControlGraph;
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
  const snapshot = await prepareCommand(client);
  const block = blockAnchor(snapshot);
  const code = await getCodeAt(client, address, snapshot);
  const codeSize = code === '0x' ? 0 : (code.length - 2) / 2;

  if (codeSize === 0) {
    return finalizeCommandResult(client, snapshot, {
      network: client.config.network.name,
      address,
      kind: 'eoa',
      codeSize: 0,
      block,
      proxy: { isProxy: false, standard: 'none' },
      upgradeAuthority:
        'not applicable — this is an externally-owned account (no code, no upgrade slots)',
      notes: ['eth_getCode returned 0x: no contract deployed at this address.'],
    });
  }

  // Read all candidate slots concurrently.
  const [implWord, adminWord, beaconWord, legacyWord] = await Promise.all([
    getStorageAt(client, address, EIP1967_SLOTS.implementation, snapshot),
    getStorageAt(client, address, EIP1967_SLOTS.admin, snapshot),
    getStorageAt(client, address, EIP1967_SLOTS.beacon, snapshot),
    getStorageAt(client, address, LEGACY_IMPL_SLOT, snapshot),
  ]);

  const proxy = classifyProxySlots(
    implWord,
    adminWord,
    beaconWord,
    legacyWord,
    notes,
  );

  // EIP-1167 minimal proxy: detectable from bytecode shape, independent of the
  // EIP-1967 storage slots. If the slots showed no proxy, this can still find one.
  const minimal = detectMinimalProxy(code);
  if (minimal.isMinimalProxy && minimal.target) {
    proxy.isProxy = true;
    if (proxy.standard === 'none') proxy.standard = 'eip1167-minimal';
    if (!proxy.implementation) proxy.implementation = getAddress(minimal.target);
    notes.push(
      `EIP-1167 minimal proxy detected from bytecode -> delegates to ${getAddress(minimal.target)}.`,
    );
  }

  // Resolve the real implementation behind a beacon proxy.
  if (proxy.standard === 'eip1967-beacon' && proxy.beacon) {
    const beaconImpl = await resolveBeaconImplementation(client, proxy.beacon, snapshot);
    if (beaconImpl) {
      proxy.beaconImplementation = beaconImpl;
      notes.push(`Beacon ${proxy.beacon}.implementation() = ${beaconImpl}.`);
    } else {
      notes.push(
        `Beacon ${proxy.beacon} did not answer implementation(); current impl not resolvable from here.`,
      );
    }
  }

  const upgradeAuthority = describeUpgradeAuthority(proxy);

  // Static bytecode signals (PUSH-aware).
  const scan: OpcodeScan = scanOpcodes(code);
  const bytecode: BytecodeInfo = {
    opcodes: scan.found,
    hasDelegateCall: scan.hasDelegateCall,
    hasSelfDestruct: scan.hasSelfDestruct,
    hasCreate2: scan.hasCreate2,
  };
  if (scan.hasSelfDestruct) {
    notes.push(
      'Bytecode contains a SELFDESTRUCT opcode. Reachability and effective behavior are not proven by a static opcode scan.',
    );
  }
  if (scan.hasDelegateCall && !proxy.isProxy) {
    notes.push(
      'Bytecode contains DELEGATECALL but no standard proxy slot was set — may be a non-standard proxy or a library-using contract.',
    );
  }

  // Live trait / token / interface reads (each omitted unless the contract answers).
  const [traits, token, interfaces] = await Promise.all([
    readTraits(client, address, snapshot),
    readTokenInfo(client, address, snapshot),
    readInterfaces(client, address, snapshot),
  ]);
  if (traits.owner) notes.push(`owner() = ${traits.owner} (live read).`);
  if (traits.paused !== undefined) {
    notes.push(`paused() = ${traits.paused} (live read).`);
  }
  if (token.symbol || token.name) {
    notes.push(
      `Token metadata: ${token.name ?? '?'} (${token.symbol ?? '?'}), decimals ${token.decimals ?? '?'}.`,
    );
  }
  if (interfaces.length > 0) {
    notes.push(`ERC-165 interfaces: ${interfaces.join(', ')}.`);
  }

  const controlGraph = await buildControlGraph(
    client,
    {
      target: address,
      ...(proxy.implementation ? { implementation: proxy.implementation } : {}),
      ...(proxy.implementation
        ? {
            implementationEvidence:
              proxy.standard === 'eip1967'
                ? 'EIP-1967 implementation storage slot'
                : proxy.standard === 'legacy-oz'
                  ? 'legacy OpenZeppelin implementation storage slot'
                  : proxy.standard === 'eip1167-minimal'
                    ? 'EIP-1167 runtime bytecode target'
                    : 'observed implementation reference',
          }
        : {}),
      ...(proxy.admin ? { admin: proxy.admin } : {}),
      ...(proxy.beacon ? { beacon: proxy.beacon } : {}),
      ...(proxy.beaconImplementation
        ? { beaconImplementation: proxy.beaconImplementation }
        : {}),
    },
    snapshot,
  );
  notes.push(...controlGraph.notes);

  const result: InspectResult = {
    network: client.config.network.name,
    address,
    kind: 'contract',
    codeSize,
    block,
    proxy,
    upgradeAuthority,
    bytecode,
    controlGraph,
    notes,
  };
  if (Object.keys(traits).length > 0) result.traits = traits;
  if (Object.keys(token).length > 0) result.token = token;
  if (interfaces.length > 0) result.interfaces = interfaces;
  return finalizeCommandResult(client, snapshot, result);
}

export function classifyProxySlots(
  implWord: string,
  adminWord: string,
  beaconWord: string,
  legacyWord: string,
  notes: string[],
): ProxyInfo {
  const implementation = addressFromSlot(implWord);
  const admin = addressFromSlot(adminWord);
  const beacon = addressFromSlot(beaconWord);
  const legacyImplementation = addressFromSlot(legacyWord);
  for (const [label, word, decoded] of [
    ['implementation', implWord, implementation],
    ['admin', adminWord, admin],
    ['beacon', beaconWord, beacon],
    ['legacy implementation', legacyWord, legacyImplementation],
  ] as const) {
    if (!isZeroWord(word) && !decoded) {
      notes.push(
        `${label} slot was non-zero but was not a canonical right-aligned address word; ignored.`,
      );
    }
  }

  if (implementation) {
    const info: ProxyInfo = {
      isProxy: true,
      standard: 'eip1967',
      implementation,
    };
    if (admin) info.admin = admin;
    notes.push(
      `EIP-1967 implementation slot is non-zero -> proxy. Implementation = ${implementation}.`,
    );
    if (admin) {
      notes.push(`EIP-1967 admin slot = ${info.admin}.`);
      notes.push(
        'The admin slot identifies an administrative endpoint; source-level authorization and callable upgrade paths are not proven by the slot alone.',
      );
    } else {
      notes.push(
        'EIP-1967 admin slot is zero: upgrades may be governed by the implementation logic ' +
          '(e.g. UUPS) rather than a ProxyAdmin. Cannot prove the upgrader from storage alone.',
      );
    }
    return info;
  }

  if (beacon) {
    notes.push(
      `EIP-1967 beacon slot is non-zero -> beacon proxy. Beacon = ${beacon}. ` +
        'The implementation is resolved by the beacon contract at call time.',
    );
    const info: ProxyInfo = { isProxy: true, standard: 'eip1967-beacon', beacon };
    if (admin) info.admin = admin;
    return info;
  }

  if (legacyImplementation) {
    notes.push(
      `Legacy OpenZeppelin implementation slot is non-zero -> legacy proxy. Implementation = ${legacyImplementation}.`,
    );
    return {
      isProxy: true,
      standard: 'legacy-oz',
      implementation: legacyImplementation,
    };
  }

  notes.push(
    'No EIP-1967 (implementation/beacon) or legacy proxy slot set: no proxy detected. ' +
      'This is a non-proxy contract as far as standard storage slots can prove.',
  );
  return { isProxy: false, standard: 'none' };
}

function describeUpgradeAuthority(proxy: ProxyInfo): string {
  if (!proxy.isProxy) {
    return 'no standard proxy slots set — no upgrade mechanism is provable from these storage checks. Non-standard control paths remain possible.';
  }
  if (proxy.standard === 'eip1967-beacon') {
    return `beacon slot points to ${proxy.beacon}. The beacon's owner/control signals are reported in the control graph; actual upgrade authorization is not proven without verified source.`;
  }
  if (proxy.admin && proxy.admin !== ZERO_ADDRESS) {
    return `EIP-1967 admin slot points to ${proxy.admin}. This is a control signal, not proof that the address can successfully invoke an upgrade path.`;
  }
  return 'admin slot is zero — likely a UUPS proxy where the upgrade function lives in the implementation and is gated by that contract\'s own access control. Not provable from storage alone.';
}

/** Format an InspectResult for human-readable CLI output. */
export function formatInspect(r: InspectResult): string {
  const lines: string[] = [];
  lines.push(`Address:   ${r.address}  (${r.network})`);
  lines.push(`Block:     ${r.block.blockNumber} (${r.block.blockHash})`);
  lines.push(
    `Finality:  ${r.block.confirmations} confirmation(s); ` +
      `${r.block.consensus.agreeing}/${r.block.consensus.total} RPC agreement ` +
      `(${r.block.consensus.mode})`,
  );
  lines.push(`Kind:      ${r.kind}${r.kind === 'contract' ? ` (${r.codeSize} bytes of code)` : ''}`);
  if (r.kind === 'contract') {
    lines.push(`Proxy:     ${r.proxy.isProxy ? `yes (${r.proxy.standard})` : 'no'}`);
    if (r.proxy.implementation) lines.push(`Impl:      ${r.proxy.implementation}`);
    if (r.proxy.beacon) lines.push(`Beacon:    ${r.proxy.beacon}`);
    if (r.proxy.beaconImplementation) lines.push(`Beacon impl: ${r.proxy.beaconImplementation}`);
    if (r.proxy.admin) lines.push(`Admin:     ${r.proxy.admin}`);
    lines.push(`Upgrade:   ${r.upgradeAuthority}`);
    if (r.traits?.owner) lines.push(`Owner:     ${r.traits.owner} (live owner())`);
    if (r.traits?.paused !== undefined) lines.push(`Paused:    ${r.traits.paused} (live paused())`);
    if (r.token && (r.token.symbol || r.token.name)) {
      lines.push(
        `Token:     ${r.token.name ?? '?'} (${r.token.symbol ?? '?'}), decimals ${r.token.decimals ?? '?'}`,
      );
    }
    if (r.interfaces && r.interfaces.length > 0) {
      lines.push(`ERC-165:   ${r.interfaces.join(', ')}`);
    }
    if (r.bytecode && r.bytecode.opcodes.length > 0) {
      lines.push(`Bytecode:  contains ${r.bytecode.opcodes.join(', ')}`);
    }
    if (r.controlGraph) {
      lines.push(
        `Control:   ${r.controlGraph.nodes.length} node(s), ${r.controlGraph.edges.length} observed edge(s)`,
      );
    }
  }
  lines.push('Facts:');
  for (const n of r.notes) lines.push(`  - ${n}`);
  return lines.join('\n');
}

// Re-export for callers that want ethers formatting parity.
export { ethers };
