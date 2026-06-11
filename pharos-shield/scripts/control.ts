/**
 * Proxy control graph built from block-pinned storage, bytecode, and clean
 * standard-method responses. Edges describe observed relationships; they do
 * not claim that an address can upgrade unless source-level authorization is
 * independently known.
 */

import { AbiCoder, getAddress, keccak256 } from 'ethers';
import { EIP1967_SLOTS } from './config.js';
import {
  callAt,
  getCodeAt,
  type ChainSnapshot,
  type ShieldClient,
} from './rpc.js';

const abi = AbiCoder.defaultAbiCoder();
const ZERO_HASH = '0x' + '00'.repeat(32);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SEL_OWNER = '0x8da5cb5b';
const SEL_GET_OWNER = '0x893d20e8';
const SEL_GET_OWNERS = '0xa0e67e2b';
const SEL_GET_THRESHOLD = '0xe75235b8';
const SEL_GET_MIN_DELAY = '0xf27a0c92';
const SEL_PROXIABLE_UUID = '0x52d1902d';

export type ControlRole =
  | 'subject'
  | 'implementation'
  | 'admin-slot'
  | 'beacon'
  | 'beacon-implementation'
  | 'reported-owner'
  | 'multisig-owner';

export interface ControlNode {
  address: string;
  kind: 'eoa' | 'contract';
  roles: ControlRole[];
  codeHash?: string;
  reportedOwner?: string;
  multisig?: {
    owners: string[];
    threshold: string;
  };
  timelock?: {
    minDelaySeconds: string;
  };
  uups?: {
    proxiableUUID: string;
    matchesEip1967ImplementationSlot: boolean;
  };
}

export interface ControlEdge {
  from: string;
  to: string;
  relation:
    | 'implementation-reference'
    | 'admin-slot'
    | 'beacon-slot'
    | 'beacon-implementation'
    | 'reported-owner'
    | 'multisig-owner';
  evidence: string;
}

export interface ControlGraph {
  nodes: ControlNode[];
  edges: ControlEdge[];
  notes: string[];
}

export interface ControlGraphInput {
  target: string;
  implementation?: string;
  implementationEvidence?: string;
  admin?: string;
  beacon?: string;
  beaconImplementation?: string;
}

async function optionalCall(
  client: ShieldClient,
  address: string,
  data: string,
  snapshot: ChainSnapshot,
): Promise<string | undefined> {
  try {
    const result = await callAt(client, { to: address, data }, snapshot);
    return result !== '0x' ? result : undefined;
  } catch {
    return undefined;
  }
}

function decodeAddress(data: string | undefined): string | undefined {
  if (!data) return undefined;
  try {
    const [address] = abi.decode(['address'], data) as unknown as [string];
    const normalized = getAddress(address);
    return normalized === ZERO_ADDRESS ? undefined : normalized;
  } catch {
    return undefined;
  }
}

function decodeUint(data: string | undefined): bigint | undefined {
  if (!data) return undefined;
  try {
    const [value] = abi.decode(['uint256'], data) as unknown as [bigint];
    return value;
  } catch {
    return undefined;
  }
}

function decodeBytes32(data: string | undefined): string | undefined {
  if (!data) return undefined;
  try {
    const [value] = abi.decode(['bytes32'], data) as unknown as [string];
    return /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function decodeAddresses(data: string | undefined): string[] | undefined {
  if (!data) return undefined;
  try {
    const [addresses] = abi.decode(['address[]'], data) as unknown as [string[]];
    return addresses.map((address) => getAddress(address));
  } catch {
    return undefined;
  }
}

async function profileNode(
  client: ShieldClient,
  address: string,
  roles: ControlRole[],
  snapshot: ChainSnapshot,
): Promise<ControlNode> {
  const code = await getCodeAt(client, address, snapshot);
  if (code === '0x') return { address, kind: 'eoa', roles };

  const [ownerRaw, getOwnerRaw, ownersRaw, thresholdRaw, delayRaw, uuidRaw] =
    await Promise.all([
      optionalCall(client, address, SEL_OWNER, snapshot),
      optionalCall(client, address, SEL_GET_OWNER, snapshot),
      optionalCall(client, address, SEL_GET_OWNERS, snapshot),
      optionalCall(client, address, SEL_GET_THRESHOLD, snapshot),
      optionalCall(client, address, SEL_GET_MIN_DELAY, snapshot),
      optionalCall(client, address, SEL_PROXIABLE_UUID, snapshot),
    ]);
  const node: ControlNode = {
    address,
    kind: 'contract',
    roles,
    codeHash: keccak256(code),
  };
  const owner = decodeAddress(ownerRaw) ?? decodeAddress(getOwnerRaw);
  if (owner) node.reportedOwner = owner;

  const owners = decodeAddresses(ownersRaw);
  const threshold = decodeUint(thresholdRaw);
  if (
    owners &&
    owners.length > 0 &&
    threshold !== undefined &&
    threshold > 0n &&
    threshold <= BigInt(owners.length)
  ) {
    node.multisig = { owners, threshold: threshold.toString() };
  }

  const minDelay = decodeUint(delayRaw);
  if (minDelay !== undefined) {
    node.timelock = { minDelaySeconds: minDelay.toString() };
  }

  const uuid = decodeBytes32(uuidRaw);
  if (uuid && uuid !== ZERO_HASH) {
    node.uups = {
      proxiableUUID: uuid,
      matchesEip1967ImplementationSlot:
        uuid === EIP1967_SLOTS.implementation.toLowerCase(),
    };
  }
  return node;
}

export async function buildControlGraph(
  client: ShieldClient,
  input: ControlGraphInput,
  snapshot: ChainSnapshot,
): Promise<ControlGraph> {
  const roleMap = new Map<string, Set<ControlRole>>();
  const addRole = (address: string | undefined, role: ControlRole): void => {
    if (!address) return;
    const normalized = getAddress(address);
    const roles = roleMap.get(normalized) ?? new Set<ControlRole>();
    roles.add(role);
    roleMap.set(normalized, roles);
  };

  addRole(input.target, 'subject');
  addRole(input.implementation, 'implementation');
  addRole(input.admin, 'admin-slot');
  addRole(input.beacon, 'beacon');
  addRole(input.beaconImplementation, 'beacon-implementation');

  let nodes = await Promise.all(
    [...roleMap].map(([address, roles]) =>
      profileNode(client, address, [...roles], snapshot),
    ),
  );

  for (const node of nodes) {
    addRole(node.reportedOwner, 'reported-owner');
    for (const owner of node.multisig?.owners ?? []) addRole(owner, 'multisig-owner');
  }
  const alreadyProfiled = new Set(nodes.map(({ address }) => address));
  const additional = await Promise.all(
    [...roleMap]
      .filter(([address]) => !alreadyProfiled.has(address))
      .map(([address, roles]) => profileNode(client, address, [...roles], snapshot)),
  );
  nodes = [...nodes, ...additional];

  const edges: ControlEdge[] = [];
  const addEdge = (
    from: string,
    to: string | undefined,
    relation: ControlEdge['relation'],
    evidence: string,
  ): void => {
    if (to) edges.push({ from: getAddress(from), to: getAddress(to), relation, evidence });
  };
  addEdge(
    input.target,
    input.implementation,
    'implementation-reference',
    input.implementationEvidence ?? 'observed implementation reference',
  );
  addEdge(input.target, input.admin, 'admin-slot', 'EIP-1967 admin storage slot');
  addEdge(input.target, input.beacon, 'beacon-slot', 'EIP-1967 beacon storage slot');
  if (input.beacon) {
    addEdge(
      input.beacon,
      input.beaconImplementation,
      'beacon-implementation',
      'block-pinned implementation() response',
    );
  }
  for (const node of nodes) {
    addEdge(
      node.address,
      node.reportedOwner,
      'reported-owner',
      'block-pinned owner()/getOwner() response',
    );
    for (const owner of node.multisig?.owners ?? []) {
      addEdge(
        node.address,
        owner,
        'multisig-owner',
        `block-pinned getOwners(); threshold=${node.multisig!.threshold}`,
      );
    }
  }

  const notes: string[] = [
    'Control-graph edges are observed storage or call relationships, not source-verified authorization proofs.',
  ];
  for (const node of nodes) {
    if (node.uups?.matchesEip1967ImplementationSlot) {
      notes.push(
        `${node.address} reports the EIP-1967 implementation slot from proxiableUUID(); this is UUPS compatibility evidence, not proof of who is authorized to upgrade.`,
      );
    }
    if (node.multisig) {
      notes.push(
        `${node.address} exposes getOwners()/getThreshold(): ${node.multisig.threshold}-of-${node.multisig.owners.length}.`,
      );
    }
    if (node.timelock) {
      notes.push(
        `${node.address} exposes getMinDelay() = ${node.timelock.minDelaySeconds} seconds.`,
      );
    }
  }
  return { nodes, edges, notes };
}
