/**
 * Bytecode static analysis — pure, offline, fact-based.
 *
 * Two honest signals from deployed bytecode (eth_getCode):
 *   - scanOpcodes(): which control-flow-relevant opcodes the code actually
 *     contains (DELEGATECALL, SELFDESTRUCT, CREATE/CREATE2, CALLCODE). The scan
 *     is PUSH-aware: bytes inside PUSH immediates are data, not opcodes, so we
 *     skip them — otherwise a 0xf4 inside pushed data would be a false positive.
 *   - detectMinimalProxy(): EIP-1167 minimal-proxy recognition by exact bytecode
 *     shape, returning the delegate target it hard-codes.
 *
 * These are statements about the bytecode, not judgments. "Contains a
 * SELFDESTRUCT opcode" is a fact; whether that matters is the reader's call.
 */

/** EIP-1167 minimal proxy: 363d3d373d3d3d363d73 <20-byte addr> 5af43d82803e903d91602b57fd5bf3 */
const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';
/** Total hex length of a canonical EIP-1167 runtime (45 bytes => 90 hex chars). */
const EIP1167_HEX_LEN = 90;

const OPCODES: Record<number, string> = {
  0xf0: 'CREATE',
  0xf2: 'CALLCODE',
  0xf4: 'DELEGATECALL',
  0xf5: 'CREATE2',
  0xff: 'SELFDESTRUCT',
};

export interface OpcodeScan {
  hasDelegateCall: boolean;
  hasSelfDestruct: boolean;
  hasCreate: boolean;
  hasCreate2: boolean;
  hasCallCode: boolean;
  /** Human-readable list of the notable opcodes found. */
  found: string[];
}

/** Strip 0x and lowercase; returns '' for empty/EOA code. */
function normalize(code: string): string {
  return code.replace(/^0x/, '').toLowerCase();
}

/**
 * PUSH-aware opcode scan. Walks the bytecode one instruction at a time; for
 * PUSH1..PUSH32 (0x60..0x7f) it skips the N immediate data bytes so they are
 * never mistaken for opcodes.
 */
export function scanOpcodes(code: string): OpcodeScan {
  const hex = normalize(code);
  const found = new Set<string>();

  const len = hex.length / 2;
  let i = 0;
  while (i < len) {
    const op = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(op)) break;
    if (op >= 0x60 && op <= 0x7f) {
      // PUSH1..PUSH32: skip the immediate data bytes.
      i += 1 + (op - 0x5f);
      continue;
    }
    const name = OPCODES[op];
    if (name) found.add(name);
    i += 1;
  }

  return {
    hasDelegateCall: found.has('DELEGATECALL'),
    hasSelfDestruct: found.has('SELFDESTRUCT'),
    hasCreate: found.has('CREATE'),
    hasCreate2: found.has('CREATE2'),
    hasCallCode: found.has('CALLCODE'),
    found: [...found].sort(),
  };
}

export interface MinimalProxy {
  isMinimalProxy: boolean;
  /** Checksummed delegate target hard-coded in the proxy bytecode. */
  target?: string;
}

/**
 * Detect an EIP-1167 minimal proxy by exact bytecode shape and extract the
 * delegate target. Returns isMinimalProxy=false for anything that does not match
 * the canonical 45-byte layout.
 */
export function detectMinimalProxy(code: string): MinimalProxy {
  const hex = normalize(code);
  if (
    hex.length === EIP1167_HEX_LEN &&
    hex.startsWith(EIP1167_PREFIX) &&
    hex.endsWith(EIP1167_SUFFIX)
  ) {
    const target = '0x' + hex.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40);
    return { isMinimalProxy: true, target };
  }
  return { isMinimalProxy: false };
}
