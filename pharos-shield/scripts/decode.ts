/**
 * Decoding helpers — revert reasons, calldata selectors, value movement.
 *
 * All decoding is best-effort and HONEST: when we cannot decode something we
 * report the raw 4-byte selector or raw hex, never an invented string.
 */

import { AbiCoder, ethers } from 'ethers';
import type { CallFrame } from './trace.js';

const abi = AbiCoder.defaultAbiCoder();

// Standard solidity error selectors.
const ERROR_STRING_SELECTOR = '0x08c379a0'; // Error(string)
const PANIC_SELECTOR = '0x4e487b71'; // Panic(uint256)

/** Solidity Panic(uint256) code meanings (subset defined by the compiler). */
const PANIC_CODES: Record<number, string> = {
  0x00: 'generic compiler panic',
  0x01: 'assert(false)',
  0x11: 'arithmetic overflow/underflow',
  0x12: 'division or modulo by zero',
  0x21: 'invalid enum conversion',
  0x22: 'invalid storage byte array access',
  0x31: 'pop() on empty array',
  0x32: 'array index out of bounds',
  0x41: 'out-of-memory / oversized allocation',
  0x51: 'call to a zero-initialized internal function',
};

/**
 * A subset of well-known function selectors used to LABEL calls in a trace.
 * Limited to widely-standardized ERC interfaces — never used to assert intent
 * beyond the selector itself.
 */
const KNOWN_SELECTORS: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0xdd62ed3e': 'allowance(address,address)',
  '0x18160ddd': 'totalSupply()',
  '0x313ce567': 'decimals()',
  '0x06fdde03': 'name()',
  '0x95d89b41': 'symbol()',
  '0xd0e30db0': 'deposit()',
  '0x2e1a7d4d': 'withdraw(uint256)',
};

export interface DecodedRevert {
  /** "Error(string)" | "Panic(uint256)" | "custom" | "empty" | "raw" */
  kind: 'Error' | 'Panic' | 'custom' | 'empty' | 'raw';
  /** Human-readable reason when decodable; otherwise a faithful description. */
  reason: string;
  /** The raw 4-byte selector of the revert payload, when present. */
  selector?: string;
  /** Raw revert data as returned by the node. */
  raw?: string;
}

/**
 * Decode revert/return data into a faithful description. Handles the two
 * standard encodings (Error(string), Panic(uint256)); for anything else we
 * surface the 4-byte custom-error selector WITHOUT guessing its name.
 */
export function decodeRevert(data: string | undefined): DecodedRevert {
  if (!data || data === '0x' || data.length < 10) {
    return {
      kind: 'empty',
      reason:
        'reverted with no return data (e.g. require without message, or a low-level revert)',
      ...(data ? { raw: data } : {}),
    };
  }
  const selector = data.slice(0, 10).toLowerCase();

  if (selector === ERROR_STRING_SELECTOR) {
    try {
      const [msg] = abi.decode(['string'], '0x' + data.slice(10));
      return { kind: 'Error', reason: String(msg), selector, raw: data };
    } catch {
      return {
        kind: 'Error',
        reason: 'Error(string) payload present but undecodable',
        selector,
        raw: data,
      };
    }
  }

  if (selector === PANIC_SELECTOR) {
    try {
      const [code] = abi.decode(['uint256'], '0x' + data.slice(10));
      const codeNum = Number(code);
      const meaning = PANIC_CODES[codeNum] ?? 'unknown panic code';
      return {
        kind: 'Panic',
        reason: `Panic(0x${codeNum.toString(16).padStart(2, '0')}): ${meaning}`,
        selector,
        raw: data,
      };
    } catch {
      return {
        kind: 'Panic',
        reason: 'Panic(uint256) payload present but undecodable',
        selector,
        raw: data,
      };
    }
  }

  // Unknown custom error — report selector faithfully, do NOT invent a name.
  return {
    kind: 'custom',
    reason: `custom error with selector ${selector} (no ABI available to decode its name)`,
    selector,
    raw: data,
  };
}

/** Return the 4-byte selector of calldata, or undefined if none. */
export function selectorOf(input: string | undefined): string | undefined {
  if (!input || input.length < 10) return undefined;
  return input.slice(0, 10).toLowerCase();
}

/** Human label for a call's selector, falling back to the raw selector. */
export function labelSelector(input: string | undefined): string {
  const sel = selectorOf(input);
  if (!sel) return '(no calldata / plain value transfer)';
  return KNOWN_SELECTORS[sel] ?? sel;
}

/** Parse a hex wei quantity to bigint; undefined/0x => 0n. */
export function hexToBigInt(hex: string | undefined): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

export interface ValueTransfer {
  from: string;
  to: string;
  /** Wei as bigint. */
  value: bigint;
  /** Formatted native amount (18 decimals). */
  formatted: string;
}

/**
 * Extract native-value (PROS) movements from a call tree. Only counts frames
 * that carry a non-zero `value` and did NOT error (reverted frames move
 * nothing). This is provable from the trace alone; it does not attempt to
 * decode ERC20 token deltas (that would require trusting event logs/ABIs that
 * the callTracer does not provide).
 */
export function nativeTransfers(frames: CallFrame[]): ValueTransfer[] {
  const out: ValueTransfer[] = [];
  for (const f of frames) {
    const v = hexToBigInt(f.value);
    if (v > 0n && !f.error && f.to) {
      out.push({
        from: f.from,
        to: f.to,
        value: v,
        formatted: ethers.formatEther(v),
      });
    }
  }
  return out;
}
