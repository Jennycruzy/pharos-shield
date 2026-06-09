/**
 * Signature-database integration (openchain.xyz) — turns raw 4-byte selectors
 * into named functions and custom errors, with arguments decoded.
 *
 * Why this and not Sourcify: function/error selectors are GLOBAL (chain-
 * agnostic), so openchain's database resolves them for Pharos contracts even
 * though Pharos has no verified-source explorer API. Sourcify does NOT index
 * Pharos (chain 1672 is absent from its chain list — checked at build time), so
 * it is intentionally not used; we never claim a verified ABI we cannot fetch.
 *
 * Honesty & degradation:
 *  - A lookup that returns nothing leaves the raw selector untouched — we never
 *    invent a name.
 *  - All lookups are best-effort; a network failure degrades silently to the
 *    raw-selector behavior the rest of Shield already provides.
 *  - Set PHAROS_SHIELD_OFFLINE=1 to disable all external lookups (only the
 *    4-byte selector would otherwise be sent to openchain — no addresses, no
 *    calldata args).
 */

import { AbiCoder } from 'ethers';

const abi = AbiCoder.defaultAbiCoder();
const OPENCHAIN_LOOKUP =
  'https://api.openchain.xyz/signature-database/v1/lookup';

/** Module-level cache so repeated selectors cost one round-trip per process. */
const fnCache = new Map<string, string | null>();

function offline(): boolean {
  const v = process.env.PHAROS_SHIELD_OFFLINE;
  return v === '1' || v === 'true';
}

interface OpenchainResponse {
  ok: boolean;
  result?: {
    function?: Record<string, Array<{ name: string; filtered: boolean }> | null>;
    event?: Record<string, Array<{ name: string; filtered: boolean }> | null>;
  };
}

/**
 * Resolve a batch of 4-byte selectors to their best signature name (functions
 * and custom errors share the selector space, so this covers both). Returns a
 * map; unresolved selectors map to null. Never throws — failures yield nulls.
 */
export async function resolveSignatures(
  selectors: ReadonlyArray<string>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const want = [
    ...new Set(
      selectors
        .map((s) => s.toLowerCase())
        .filter((s) => /^0x[0-9a-f]{8}$/.test(s)),
    ),
  ];

  const missing: string[] = [];
  for (const sel of want) {
    if (fnCache.has(sel)) out.set(sel, fnCache.get(sel) ?? null);
    else missing.push(sel);
  }
  if (missing.length === 0 || offline()) {
    for (const sel of missing) out.set(sel, null);
    return out;
  }

  try {
    const url = `${OPENCHAIN_LOOKUP}?function=${missing.join(',')}&filter=true`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`openchain HTTP ${res.status}`);
    const body = (await res.json()) as OpenchainResponse;
    const fns = body.result?.function ?? {};
    for (const sel of missing) {
      const hits = fns[sel];
      const name = hits && hits.length > 0 ? hits[0]!.name : null;
      fnCache.set(sel, name);
      out.set(sel, name);
    }
  } catch {
    // Network/parse failure — degrade to raw selectors.
    for (const sel of missing) out.set(sel, null);
  }
  return out;
}

/** Convenience: resolve a single selector. */
export async function resolveSignature(
  selector: string,
): Promise<string | null> {
  const m = await resolveSignatures([selector]);
  return m.get(selector.toLowerCase()) ?? null;
}

/** Split a signature's parameter list at top level, respecting nested tuples. */
function splitParams(paramList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of paramList) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

export interface DecodedSignature {
  /** e.g. "ERC20InsufficientAllowance" */
  name: string;
  /** Full signature, e.g. "ERC20InsufficientAllowance(address,uint256,uint256)" */
  signature: string;
  /** Decoded argument values as display strings (best-effort). */
  args: string[];
}

/**
 * Decode the arguments of a resolved signature against the raw payload. This is
 * also the CONFIRMATION step: a selector match alone can be coincidental (e.g.
 * the degenerate 0x00000000 selector), so we only return a result when the
 * payload actually decodes against the signature's types. Returns undefined on
 * any mismatch — we never assert an error/function the data doesn't support.
 */
export function decodeWithSignature(
  signature: string,
  rawData: string | undefined,
): DecodedSignature | undefined {
  const m = signature.match(/^([^(]+)\((.*)\)$/);
  if (!m) return undefined;
  const name = m[1]!;
  const paramList = m[2]!;
  const types = paramList.trim() === '' ? [] : splitParams(paramList);

  if (types.length === 0) {
    // Zero-arg error/function: the payload must be exactly the 4-byte selector.
    if (!rawData || rawData.length !== 10) return undefined;
    return { name, signature, args: [] };
  }

  if (!rawData || rawData.length < 10) return undefined;
  try {
    const body = '0x' + rawData.slice(10);
    const decoded = abi.decode(types, body);
    // ethers throws on insufficient/over-long data; reaching here = clean decode.
    return { name, signature, args: decoded.map((v) => stringifyArg(v)) };
  } catch {
    return undefined; // selector matched but args don't decode -> not a real match
  }
}

function stringifyArg(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(stringifyArg).join(', ')}]`;
  return String(v);
}

/** Build a human label like "ERC20InsufficientAllowance(0xabc.., 100, 250)". */
export function formatDecoded(d: DecodedSignature): string {
  if (d.args.length === 0) return d.signature;
  return `${d.name}(${d.args.join(', ')})`;
}
