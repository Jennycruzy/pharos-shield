/**
 * Receipt activity and ERC-compatible call-intent decoding.
 *
 * Two honest sources, no heuristics, no scoring:
 *   - decodeTokenLogs(): actual ERC-20/721 Transfer & Approval EVENTS from a
 *     mined receipt's logs (what truly moved).
 *   - decodeTokenCalls(): selector-compatible calldata intents. These never
 *     assert token-standard support or completed movement.
 *
 * Amounts are reported in raw base units. Optional enrichTokenMeta() fetches
 * decimals/symbol via eth_call so the consumer can format — but only when the
 * token actually answers; unknown stays unknown.
 *
 * This is NOT a token risk score. Receipt logs and calldata intents remain
 * separate in the output so callers cannot confuse a selector with movement.
 */

import { AbiCoder, getAddress, ethers } from 'ethers';
import { callAt, getCodeAt, type ChainSnapshot, type ShieldClient } from './rpc.js';
import type { CallFrame } from './trace.js';

const abi = AbiCoder.defaultAbiCoder();

/** keccak256("Transfer(address,address,uint256)") */
const TOPIC_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** keccak256("Approval(address,address,uint256)") */
const TOPIC_APPROVAL =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** keccak256("ApprovalForAll(address,address,bool)") */
const TOPIC_APPROVAL_FOR_ALL =
  '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';

/** Function selectors we decode from a call tree. */
const SEL_TRANSFER = '0xa9059cbb'; // transfer(address,uint256)
const SEL_TRANSFER_FROM = '0x23b872dd'; // transferFrom(address,address,uint256)
const SEL_APPROVE = '0x095ea7b3'; // approve(address,uint256)
const SEL_SET_APPROVAL_FOR_ALL = '0xa22cb465'; // setApprovalForAll(address,bool)

/** max uint256 — the canonical "infinite approval" sentinel. */
export const MAX_UINT256 = (1n << 256n) - 1n;
/** Half the uint256 space; amounts at/above this are effectively unlimited. */
const HALF_UINT256 = 1n << 255n;

function decodeExact(
  types: readonly string[],
  body: string,
): readonly unknown[] | undefined {
  try {
    const decoded = abi.decode(types, body);
    if (abi.encode(types, decoded).toLowerCase() !== body.toLowerCase()) {
      return undefined;
    }
    return [...decoded];
  } catch {
    return undefined;
  }
}

/** Minimal log shape (decoupled from ethers' Log type). */
export interface LogLike {
  address: string;
  topics: ReadonlyArray<string>;
  data: string;
}

export interface TokenTransfer {
  token: string;
  standard: 'erc20' | 'erc721';
  from: string;
  to: string;
  /** Raw base-unit amount (ERC-20) — decimal string. */
  amount?: string;
  /** Token id (ERC-721) — decimal string. */
  tokenId?: string;
  /** The fact came from a mined successful receipt log. */
  source: 'log';
}

export interface TokenApproval {
  token: string;
  standard: 'erc20' | 'erc721';
  owner: string;
  spender: string;
  /** Raw base-unit allowance (ERC-20 / single-token approve). */
  amount?: string;
  /** Token id for ERC-721 single-token approve. */
  tokenId?: string;
  /** True when the approval is operator-wide (setApprovalForAll / ApprovalForAll). */
  operatorAll?: boolean;
  /** True when amount === max uint256 (canonical infinite approval). */
  isUnlimited: boolean;
  /** True when amount >= 2^255 (effectively unlimited even if not exact max). */
  isVeryLarge: boolean;
  source: 'log';
}

export interface ErcCallIntent {
  target: string;
  caller: string;
  signature:
    | 'transfer(address,uint256)'
    | 'transferFrom(address,address,uint256)'
    | 'approve(address,uint256)'
    | 'setApprovalForAll(address,bool)';
  kind: 'transfer-intent' | 'approval-intent';
  from?: string;
  to?: string;
  spender?: string;
  amountOrTokenId?: string;
  approved?: boolean;
  isUnlimited: boolean;
  isVeryLarge: boolean;
  /** A selector match is not proof that target implements an ERC standard. */
  standard: 'erc-compatible-unknown';
  source: 'call-intent';
}

export interface DecodedTokens {
  transfers: TokenTransfer[];
  approvals: TokenApproval[];
  callIntents: ErcCallIntent[];
}

function topicToAddress(topic: string): string {
  return getAddress('0x' + topic.slice(-40));
}

function classifyApprovalSize(amount: bigint): {
  isUnlimited: boolean;
  isVeryLarge: boolean;
} {
  return {
    isUnlimited: amount === MAX_UINT256,
    isVeryLarge: amount >= HALF_UINT256,
  };
}

/**
 * Decode real ERC-20/721 Transfer & Approval events from a mined receipt's logs.
 * ERC-20 transfers carry 3 topics (sig, from, to) + amount in data; ERC-721
 * transfers carry 4 topics (sig, from, to, tokenId) with empty data. Same split
 * distinguishes ERC-20 vs ERC-721 approvals.
 */
export function decodeTokenLogs(logs: ReadonlyArray<LogLike>): DecodedTokens {
  const transfers: TokenTransfer[] = [];
  const approvals: TokenApproval[] = [];

  for (const log of logs) {
    const t = log.topics;
    if (t.length === 0) continue;
    const topic0 = t[0]!.toLowerCase();

    if (topic0 === TOPIC_TRANSFER) {
      // Need at least from+to. ERC-721 has a 4th topic (tokenId).
      if (t.length === 3) {
        const amount = safeBigIntString(log.data);
        transfers.push({
          token: getAddress(log.address),
          standard: 'erc20',
          from: topicToAddress(t[1]!),
          to: topicToAddress(t[2]!),
          ...(amount !== undefined ? { amount } : {}),
          source: 'log',
        });
      } else if (t.length === 4) {
        transfers.push({
          token: getAddress(log.address),
          standard: 'erc721',
          from: topicToAddress(t[1]!),
          to: topicToAddress(t[2]!),
          tokenId: BigInt(t[3]!).toString(),
          source: 'log',
        });
      }
      continue;
    }

    if (topic0 === TOPIC_APPROVAL) {
      if (t.length === 3) {
        const amount = parseBigInt(log.data);
        const size = classifyApprovalSize(amount ?? 0n);
        approvals.push({
          token: getAddress(log.address),
          standard: 'erc20',
          owner: topicToAddress(t[1]!),
          spender: topicToAddress(t[2]!),
          ...(amount !== undefined ? { amount: amount.toString() } : {}),
          ...size,
          source: 'log',
        });
      } else if (t.length === 4) {
        approvals.push({
          token: getAddress(log.address),
          standard: 'erc721',
          owner: topicToAddress(t[1]!),
          spender: topicToAddress(t[2]!),
          tokenId: BigInt(t[3]!).toString(),
          isUnlimited: false,
          isVeryLarge: false,
          source: 'log',
        });
      }
      continue;
    }

    if (topic0 === TOPIC_APPROVAL_FOR_ALL && t.length >= 3) {
      // ApprovalForAll(owner indexed, operator indexed, bool approved in data)
      const approved = parseBigInt(log.data);
      if (approved !== undefined && approved !== 0n) {
        approvals.push({
          token: getAddress(log.address),
          standard: 'erc721',
          owner: topicToAddress(t[1]!),
          spender: topicToAddress(t[2]!),
          operatorAll: true,
          isUnlimited: true, // operator-wide approval IS unlimited by nature
          isVeryLarge: true,
          source: 'log',
        });
      }
    }
  }

  return { transfers, approvals, callIntents: [] };
}

/**
 * Decode ERC-compatible transfer/approval intents from a call tree. Reads
 * the selector + args of each frame's input. transferFrom's selector is shared
 * by ERC-20 and ERC-721 (identical signature), so its third word is reported as
 * amount-or-tokenId without asserting which.
 */
export function decodeTokenCalls(frames: ReadonlyArray<CallFrame>): DecodedTokens {
  const callIntents: ErcCallIntent[] = [];

  for (const f of frames) {
    const input = f.input ?? '0x';
    if (input.length < 10 || !f.to) continue;
    const sel = input.slice(0, 10).toLowerCase();
    const body = '0x' + input.slice(10);

    try {
      const token = getAddress(f.to);
      if (sel === SEL_TRANSFER) {
        const decoded = decodeExact(['address', 'uint256'], body);
        if (!decoded) continue;
        const [to, amount] = decoded as [string, bigint];
        callIntents.push({
          target: token,
          caller: getAddress(f.from),
          signature: 'transfer(address,uint256)',
          kind: 'transfer-intent',
          to: getAddress(to),
          amountOrTokenId: amount.toString(),
          isUnlimited: false,
          isVeryLarge: false,
          standard: 'erc-compatible-unknown',
          source: 'call-intent',
        });
      } else if (sel === SEL_TRANSFER_FROM) {
        const decoded = decodeExact(
          ['address', 'address', 'uint256'],
          body,
        );
        if (!decoded) continue;
        const [from, to, value] = decoded as [string, string, bigint];
        callIntents.push({
          target: token,
          caller: getAddress(f.from),
          signature: 'transferFrom(address,address,uint256)',
          kind: 'transfer-intent',
          from: getAddress(from),
          to: getAddress(to),
          amountOrTokenId: value.toString(),
          isUnlimited: false,
          isVeryLarge: false,
          standard: 'erc-compatible-unknown',
          source: 'call-intent',
        });
      } else if (sel === SEL_APPROVE) {
        const decoded = decodeExact(['address', 'uint256'], body);
        if (!decoded) continue;
        const [spender, amount] = decoded as [string, bigint];
        const size = classifyApprovalSize(amount);
        callIntents.push({
          target: token,
          caller: getAddress(f.from),
          signature: 'approve(address,uint256)',
          kind: 'approval-intent',
          spender: getAddress(spender),
          amountOrTokenId: amount.toString(),
          ...size,
          standard: 'erc-compatible-unknown',
          source: 'call-intent',
        });
      } else if (sel === SEL_SET_APPROVAL_FOR_ALL) {
        const decoded = decodeExact(['address', 'bool'], body);
        if (!decoded) continue;
        const [operator, approved] = decoded as [string, boolean];
        callIntents.push({
          target: token,
          caller: getAddress(f.from),
          signature: 'setApprovalForAll(address,bool)',
          kind: 'approval-intent',
          spender: getAddress(operator),
          approved,
          isUnlimited: approved,
          isVeryLarge: approved,
          standard: 'erc-compatible-unknown',
          source: 'call-intent',
        });
      }
    } catch {
      // Malformed args — skip this frame rather than guess.
      continue;
    }
  }

  return { transfers: [], approvals: [], callIntents };
}

export interface TokenMeta {
  symbol?: string;
  decimals?: number;
}

/**
 * Best-effort on-chain enrichment: fetch decimals()/symbol() for each unique
 * token via eth_call. Tokens that do not answer stay unenriched (honest — we do
 * not invent metadata). Returns a map keyed by checksummed address.
 */
export async function enrichTokenMeta(
  client: ShieldClient,
  tokenAddresses: ReadonlyArray<string>,
  snapshot: ChainSnapshot,
): Promise<Map<string, TokenMeta>> {
  const unique = [...new Set(tokenAddresses.map((a) => getAddress(a)))];
  const out = new Map<string, TokenMeta>();

  await Promise.all(
    unique.map(async (token) => {
      const meta: TokenMeta = {};
      // decimals() = 0x313ce567
      try {
        const d = await callAt(client, { to: token, data: '0x313ce567' }, snapshot);
        if (d && d !== '0x') {
          const n = Number(BigInt(d));
          if (Number.isInteger(n) && n >= 0 && n <= 255) meta.decimals = n;
        }
      } catch {
        /* token has no decimals() — leave undefined */
      }
      // symbol() = 0x95d89b41
      try {
        const s = await callAt(client, { to: token, data: '0x95d89b41' }, snapshot);
        if (s && s !== '0x') {
          const sym = decodeStringReturn(s);
          if (sym) meta.symbol = sym;
        }
      } catch {
        /* token has no symbol() — leave undefined */
      }
      out.set(token, meta);
    }),
  );

  return out;
}

/** Format a raw base-unit amount with decimals when known; else raw + note. */
export function formatAmount(amount: string | undefined, meta: TokenMeta | undefined): string {
  if (amount === undefined) return '(n/a)';
  if (meta?.decimals !== undefined) {
    const formatted = ethers.formatUnits(amount, meta.decimals);
    const sym = meta.symbol ? ` ${meta.symbol}` : '';
    return `${formatted}${sym}`;
  }
  return `${amount} (base units; decimals unknown)`;
}

export interface TokenTransferReport {
  token: string;
  symbol?: string;
  standard: 'erc20' | 'erc721';
  from: string;
  to: string;
  /** Human-formatted amount (decimals applied when known) or token id. */
  amount: string;
  source: 'log';
}

export interface TokenApprovalReport {
  token: string;
  symbol?: string;
  standard: 'erc20' | 'erc721';
  owner: string;
  spender: string;
  amount: string;
  isUnlimited: boolean;
  isVeryLarge: boolean;
  operatorAll: boolean;
  source: 'log';
}

export interface ErcCallIntentReport extends ErcCallIntent {
  targetHasCode: boolean;
  targetSymbol?: string;
  displayAmount?: string;
}

export interface TokenReport {
  /** Actual event-log-backed movements from a mined successful transaction. */
  transfers: TokenTransferReport[];
  /** Actual event-log-backed approvals from a mined successful transaction. */
  approvals: TokenApprovalReport[];
  /** Selector-derived intent only; never represented as an actual movement. */
  callIntents: ErcCallIntentReport[];
  /** Human-readable flags (e.g. unlimited-approval warnings). Facts, not scores. */
  notes: string[];
}

/** Unique token addresses referenced by a DecodedTokens set. */
export function tokenAddressesOf(d: DecodedTokens): string[] {
  const s = new Set<string>();
  for (const t of d.transfers) s.add(t.token);
  for (const a of d.approvals) s.add(a.token);
  for (const intent of d.callIntents) s.add(intent.target);
  return [...s];
}

/**
 * Turn decoded tokens + metadata into a serializable, human-formatted report.
 * Approval flags are stated as facts ("grants UNLIMITED allowance"); no scoring.
 */
export function buildTokenReport(
  d: DecodedTokens,
  meta: Map<string, TokenMeta>,
  codeByAddress: Map<string, boolean> = new Map(),
): TokenReport {
  const notes: string[] = [];

  const transfers: TokenTransferReport[] = d.transfers.map((t) => {
    const m = meta.get(t.token);
    const amount =
      t.standard === 'erc721'
        ? `tokenId ${t.tokenId ?? '(n/a)'}`
        : formatAmount(t.amount, m);
    return {
      token: t.token,
      ...(m?.symbol ? { symbol: m.symbol } : {}),
      standard: t.standard,
      from: t.from,
      to: t.to,
      amount,
      source: t.source,
    };
  });

  const approvals: TokenApprovalReport[] = d.approvals.map((a) => {
    const m = meta.get(a.token);
    const amount = a.operatorAll
      ? 'ALL tokens (operator-wide)'
      : a.standard === 'erc721'
        ? `tokenId ${a.tokenId ?? '(n/a)'}`
        : a.isUnlimited
          ? 'UNLIMITED (max uint256)'
          : formatAmount(a.amount, m);
    const symbol = m?.symbol;
    if (a.isUnlimited || a.operatorAll) {
      notes.push(
        `Approval grants ${a.spender} an UNLIMITED allowance on ${symbol ?? a.token}` +
          (a.operatorAll ? ' (operator-wide / all token ids).' : '.'),
      );
    } else if (a.isVeryLarge) {
      notes.push(
        `Approval grants ${a.spender} an effectively-unlimited allowance (>= 2^255) on ${symbol ?? a.token}.`,
      );
    }
    return {
      token: a.token,
      ...(symbol ? { symbol } : {}),
      standard: a.standard,
      owner: a.owner,
      spender: a.spender,
      amount,
      isUnlimited: a.isUnlimited,
      isVeryLarge: a.isVeryLarge,
      operatorAll: a.operatorAll ?? false,
      source: a.source,
    };
  });

  const callIntents: ErcCallIntentReport[] = d.callIntents.map((intent) => {
    const m = meta.get(intent.target);
    const displayAmount =
      intent.amountOrTokenId === undefined
        ? undefined
        : formatAmount(intent.amountOrTokenId, m);
    if (intent.isUnlimited) {
      notes.push(
        `ERC-compatible call intent would request an unlimited approval for ` +
          `${intent.spender ?? '(unknown spender)'} on target ${intent.target}.`,
      );
    }
    return {
      ...intent,
      targetHasCode: codeByAddress.get(intent.target) ?? false,
      ...(m?.symbol ? { targetSymbol: m.symbol } : {}),
      ...(displayAmount ? { displayAmount } : {}),
    };
  });

  if (callIntents.length > 0) {
    notes.push(
      'ERC-compatible call intents are selector-derived calldata interpretations, not proof of token-standard support or completed movement.',
    );
  }

  return { transfers, approvals, callIntents, notes };
}

export async function readCodePresence(
  client: ShieldClient,
  addresses: ReadonlyArray<string>,
  snapshot: ChainSnapshot,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  await Promise.all(
    [...new Set(addresses.map((address) => getAddress(address)))].map(async (address) => {
      const code = await getCodeAt(client, address, snapshot);
      out.set(address, code !== '0x');
    }),
  );
  return out;
}

/** ABI-decode a string return, falling back to bytes32-style symbols. */
function decodeStringReturn(data: string): string | undefined {
  try {
    const [s] = abi.decode(['string'], data) as unknown as [string];
    return s.length > 0 ? s : undefined;
  } catch {
    // Some old tokens return bytes32 symbols.
    try {
      const raw = Buffer.from(data.replace(/^0x/, ''), 'hex');
      const text = raw.toString('utf8').replace(/ +$/, '').trim();
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }
}

function parseBigInt(data: string): bigint | undefined {
  if (!data || data === '0x') return undefined;
  try {
    return BigInt(data.length > 66 ? data.slice(0, 66) : data);
  } catch {
    return undefined;
  }
}

function safeBigIntString(data: string): string | undefined {
  const v = parseBigInt(data);
  return v === undefined ? undefined : v.toString();
}
