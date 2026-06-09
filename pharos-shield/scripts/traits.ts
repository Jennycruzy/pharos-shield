/**
 * Live contract-trait reads — honest eth_call probes, no assumptions.
 *
 * Each probe calls a standard selector and reports the result ONLY when the
 * contract returns a cleanly-decodable value. A function that does not exist
 * returns "0x" (or reverts); we treat both as "trait absent" and omit it —
 * never inventing an owner, a paused flag, or an interface the contract didn't
 * actually answer.
 */

import { AbiCoder, getAddress, ethers } from 'ethers';
import type { ShieldClient } from './rpc.js';

const abi = AbiCoder.defaultAbiCoder();

// Standard selectors.
const SEL_OWNER = '0x8da5cb5b'; // owner()
const SEL_GET_OWNER = '0x893d20e8'; // getOwner()
const SEL_PAUSED = '0x5c975abb'; // paused()
const SEL_IMPLEMENTATION = '0x5c60da1b'; // implementation()
const SEL_NAME = '0x06fdde03'; // name()
const SEL_SYMBOL = '0x95d89b41'; // symbol()
const SEL_DECIMALS = '0x313ce567'; // decimals()
const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
const SEL_SUPPORTS_INTERFACE = '0x01ffc9a7'; // supportsInterface(bytes4)

/** Well-known ERC-165 interface IDs we probe for. */
const KNOWN_INTERFACES: Array<{ id: string; name: string }> = [
  { id: '0x01ffc9a7', name: 'ERC-165' },
  { id: '0x80ac58cd', name: 'ERC-721' },
  { id: '0x5b5e139f', name: 'ERC-721 Metadata' },
  { id: '0x780e9d63', name: 'ERC-721 Enumerable' },
  { id: '0xd9b67a26', name: 'ERC-1155' },
  { id: '0x0e89341c', name: 'ERC-1155 Metadata URI' },
];

async function rawCall(
  client: ShieldClient,
  to: string,
  data: string,
): Promise<string | undefined> {
  try {
    const res = await client.provider.call({ to, data });
    return res && res !== '0x' ? res : undefined;
  } catch {
    return undefined; // function absent / reverted — trait not present
  }
}

async function readAddress(
  client: ShieldClient,
  to: string,
  selector: string,
): Promise<string | undefined> {
  const res = await rawCall(client, to, selector);
  if (!res) return undefined;
  try {
    const [addr] = abi.decode(['address'], res) as unknown as [string];
    const checksummed = getAddress(addr);
    // Ignore zero address — a present-but-empty owner/impl is not informative.
    return checksummed === ethers.ZeroAddress ? undefined : checksummed;
  } catch {
    return undefined;
  }
}

async function readBool(
  client: ShieldClient,
  to: string,
  selector: string,
): Promise<boolean | undefined> {
  const res = await rawCall(client, to, selector);
  if (!res) return undefined;
  try {
    const [b] = abi.decode(['bool'], res) as unknown as [boolean];
    return b;
  } catch {
    return undefined;
  }
}

async function readUint(
  client: ShieldClient,
  to: string,
  selector: string,
): Promise<bigint | undefined> {
  const res = await rawCall(client, to, selector);
  if (!res) return undefined;
  try {
    const [n] = abi.decode(['uint256'], res) as unknown as [bigint];
    return n;
  } catch {
    return undefined;
  }
}

async function readString(
  client: ShieldClient,
  to: string,
  selector: string,
): Promise<string | undefined> {
  const res = await rawCall(client, to, selector);
  if (!res) return undefined;
  try {
    const [s] = abi.decode(['string'], res) as unknown as [string];
    return s.length > 0 ? s : undefined;
  } catch {
    // bytes32-style metadata fallback
    try {
      const txt = Buffer.from(res.replace(/^0x/, ''), 'hex')
        .toString('utf8')
        .replace(/\0+$/, '')
        .trim();
      return txt.length > 0 ? txt : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface ContractTraits {
  owner?: string;
  paused?: boolean;
  /** UUPS-style implementation() exposed on the contract itself. */
  implementation?: string;
}

/** Probe ownership / pausability / UUPS implementation. */
export async function readTraits(
  client: ShieldClient,
  address: string,
): Promise<ContractTraits> {
  const [owner, getOwner, paused, implementation] = await Promise.all([
    readAddress(client, address, SEL_OWNER),
    readAddress(client, address, SEL_GET_OWNER),
    readBool(client, address, SEL_PAUSED),
    readAddress(client, address, SEL_IMPLEMENTATION),
  ]);
  const traits: ContractTraits = {};
  const resolvedOwner = owner ?? getOwner;
  if (resolvedOwner) traits.owner = resolvedOwner;
  if (paused !== undefined) traits.paused = paused;
  if (implementation) traits.implementation = implementation;
  return traits;
}

export interface TokenInfo {
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
}

/** Probe ERC-20-style token metadata. Returns {} if the contract is not a token. */
export async function readTokenInfo(
  client: ShieldClient,
  address: string,
): Promise<TokenInfo> {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    readString(client, address, SEL_NAME),
    readString(client, address, SEL_SYMBOL),
    readUint(client, address, SEL_DECIMALS),
    readUint(client, address, SEL_TOTAL_SUPPLY),
  ]);
  const info: TokenInfo = {};
  if (name) info.name = name;
  if (symbol) info.symbol = symbol;
  if (decimals !== undefined && decimals <= 255n) info.decimals = Number(decimals);
  if (totalSupply !== undefined) info.totalSupply = totalSupply.toString();
  return info;
}

/**
 * Probe ERC-165 support. Per the standard, a compliant contract returns true
 * for 0x01ffc9a7 and false for 0xffffffff; we require that handshake before
 * trusting any other interface answer, so non-ERC-165 contracts that happen to
 * return garbage are not misreported.
 */
export async function readInterfaces(
  client: ShieldClient,
  address: string,
): Promise<string[]> {
  const supports = async (id: string): Promise<boolean> => {
    const data = SEL_SUPPORTS_INTERFACE + id.replace(/^0x/, '').padEnd(64, '0');
    const b = await readBool(client, address, data);
    return b === true;
  };

  // ERC-165 compliance handshake.
  const [supports165, supportsInvalid] = await Promise.all([
    supports('0x01ffc9a7'),
    supports('0xffffffff'),
  ]);
  if (!supports165 || supportsInvalid) return []; // not a compliant ERC-165 contract

  const results = await Promise.all(
    KNOWN_INTERFACES.map(async ({ id, name }) => ((await supports(id)) ? name : null)),
  );
  return results.filter((x): x is string => x !== null);
}

/** Resolve the real implementation behind a beacon by calling beacon.implementation(). */
export async function resolveBeaconImplementation(
  client: ShieldClient,
  beacon: string,
): Promise<string | undefined> {
  return readAddress(client, beacon, SEL_IMPLEMENTATION);
}
