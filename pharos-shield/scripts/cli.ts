#!/usr/bin/env node
/**
 * Pharos Shield CLI — guard | simulate | autopsy | inspect.
 *
 * Thin command layer over the shared core modules. Honors PHAROS_NETWORK
 * (default mainnet/1672). Supports --json for machine-readable output.
 */

import { loadConfig } from './config.js';
import { readFile, writeFile } from 'node:fs/promises';
import {
  blockAnchor,
  createClient,
  probeTraceSupport,
  RpcError,
} from './rpc.js';
import { autopsy } from './autopsy.js';
import { simulate, formatSimulate } from './simulate.js';
import { inspect, formatInspect } from './inspect.js';
import { guard, formatGuard } from './guard.js';
import {
  createEvidenceBundle,
  formatEvidence,
  verifyEvidenceBundle,
  type EvidencePayload,
} from './evidence.js';
import { ethers } from 'ethers';

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positionals.push(a);
    }
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags };
}

function asString(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const USAGE = `Pharos Shield — transaction & contract integrity layer (Pharos mainnet, chain 1672)

Usage:
  pharos-shield inspect  <address>                     Classify EOA/contract; detect EIP-1967 proxy + admin
  pharos-shield autopsy  <txhash>                       Diagnose a failed tx via callTracer
  pharos-shield simulate --from <addr> --to <addr> [--data 0x..] [--value 1.0] [--gas N]
                                                        Dry-run a call (debug_traceCall). Never sends.
  pharos-shield guard --from <addr> --to <addr> [--data 0x..] [--value 1.0] [--gas N]
                                                        Inspect + simulate before signing.
  pharos-shield probe                                   Report network + live trace-namespace capability
  pharos-shield verify-evidence <file>                  Verify an evidence signature offline

Flags:
  --json        Emit JSON instead of formatted text
  --network     Override PHAROS_NETWORK for this run (mainnet|testnet)
  --evidence    Write a signed JSON evidence bundle to this file

Env:
  PHAROS_NETWORK   mainnet (default) | testnet
  PHAROS_*_RPC     override RPC URLs (see .env.example)
  PHAROS_EVIDENCE_SIGNING_KEY  separate 32-byte key used only for evidence
`;

async function main(): Promise<number> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  const json = flags.get('json') === true;

  if (!command || command === 'help' || flags.get('help') === true) {
    process.stdout.write(USAGE + '\n');
    return command ? 0 : 1;
  }

  if (command === 'verify-evidence') {
    const path = positionals[0];
    if (!path) {
      process.stderr.write('verify-evidence requires a <file>.\n');
      return 1;
    }
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const verification = verifyEvidenceBundle(parsed);
    if (json) {
      process.stdout.write(JSON.stringify(verification, null, 2) + '\n');
    } else {
      process.stdout.write(
        `${verification.valid ? 'VALID' : 'INVALID'}: ${verification.reason}` +
          `${verification.signer ? `\nSigner: ${verification.signer}` : ''}\n`,
      );
    }
    return verification.valid ? 0 : 2;
  }

  // Allow --network to override env for this invocation.
  const netOverride = asString(flags.get('network'));
  if (netOverride) process.env.PHAROS_NETWORK = netOverride;

  const config = loadConfig();
  const client = createClient(config);
  const evidencePath = asString(flags.get('evidence'));
  if (flags.get('evidence') === true) {
    throw new Error('--evidence requires an output file path.');
  }

  const emit = async (
    commandName: EvidencePayload['command'],
    obj: unknown,
    text: string,
  ): Promise<void> => {
    if (evidencePath) {
      const bundle = await createEvidenceBundle(client, commandName, obj);
      await writeFile(evidencePath, formatEvidence(bundle) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    if (json) process.stdout.write(JSON.stringify(obj, bigintReplacer, 2) + '\n');
    else {
      process.stdout.write(
        text + (evidencePath ? `\nEvidence:  ${evidencePath}` : '') + '\n',
      );
    }
  };

  switch (command) {
    case 'probe': {
      const cap = await probeTraceSupport(client);
      const obj = {
        network: config.network.name,
        chainId: config.network.chainId,
        rpcUrl: config.rpcUrl,
        defaultRpcVerified: config.network.defaultRpcVerified,
        block: blockAnchor(cap.block),
        trace: cap,
      };
      await emit(
        'probe',
        obj,
        `Network:  ${config.network.name} (chain ${config.network.chainId})\n` +
          `RPC:      ${config.rpcUrl}\n` +
          `Block:    ${cap.block.blockNumber} (${cap.block.blockHash}) age=${cap.block.ageSeconds}s\n` +
          `Finality: ${cap.block.confirmations} confirmation(s); ` +
          `${cap.block.consensus.agreeing}/${cap.block.consensus.total} RPC agreement ` +
          `(${cap.block.consensus.mode})\n` +
          `Trace:    traceCall=${cap.traceCall} traceTransaction=${cap.traceTransaction}\n` +
          `Note:     ${cap.note}`,
      );
      return 0;
    }

    case 'inspect': {
      const addr = positionals[0];
      if (!addr) {
        process.stderr.write('inspect requires an <address>.\n');
        return 1;
      }
      const result = await inspect(client, addr);
      await emit('inspect', result, formatInspect(result));
      return 0;
    }

    case 'autopsy': {
      const tx = positionals[0];
      if (!tx) {
        process.stderr.write('autopsy requires a <txhash>.\n');
        return 1;
      }
      const result = await autopsy(client, tx);
      await emit('autopsy', result, formatAutopsy(result));
      return result.status === 'failed' || result.status === 'success' ? 0 : 2;
    }

    case 'simulate': {
      const from = asString(flags.get('from'));
      if (!from) {
        process.stderr.write('simulate requires --from <address>.\n');
        return 1;
      }
      const params = {
        from,
        ...(asString(flags.get('to')) ? { to: asString(flags.get('to'))! } : {}),
        ...(asString(flags.get('data')) ? { data: asString(flags.get('data'))! } : {}),
        ...(asString(flags.get('value')) ? { value: asString(flags.get('value'))! } : {}),
        ...(asString(flags.get('gas')) ? { gas: asString(flags.get('gas'))! } : {}),
      };
      const result = await simulate(client, params);
      await emit('simulate', result, formatSimulate(result));
      return 0;
    }

    case 'guard': {
      const from = asString(flags.get('from'));
      const to = asString(flags.get('to'));
      if (!from || !to) {
        process.stderr.write(
          'guard requires --from <address> and --to <address>.\n',
        );
        return 1;
      }
      const params = {
        from,
        to,
        ...(asString(flags.get('data')) ? { data: asString(flags.get('data'))! } : {}),
        ...(asString(flags.get('value')) ? { value: asString(flags.get('value'))! } : {}),
        ...(asString(flags.get('gas')) ? { gas: asString(flags.get('gas'))! } : {}),
      };
      const result = await guard(client, params);
      await emit('guard', result, formatGuard(result));
      return result.flags.length === 0 ? 0 : 2;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`);
      return 1;
  }
}

function formatAutopsy(r: ReturnType<typeof autopsy> extends Promise<infer T> ? T : never): string {
  const lines: string[] = [];
  lines.push(`Autopsy (${r.network})  tx ${r.txHash}`);
  if (!r.found) {
    lines.push(`Status:    NOT FOUND`);
    lines.push(`Block:     ${r.block.blockNumber} (${r.block.blockHash})`);
    lines.push(
      `Finality:  ${r.block.confirmations} confirmation(s); ` +
        `${r.block.consensus.agreeing}/${r.block.consensus.total} RPC agreement ` +
        `(${r.block.consensus.mode})`,
    );
    lines.push(`Cause:     ${r.probableCause}`);
    return lines.join('\n');
  }
  const traceLabel =
    r.status === 'success'
      ? ''
      : r.traced
        ? ' (call-tree traced)'
        : ' (degraded: no trace available)';
  lines.push(`Status:    ${r.status}${traceLabel}`);
  if (r.from) lines.push(`From:      ${r.from}`);
  if (r.to) lines.push(`To:        ${r.to}`);
  if (r.blockNumber !== undefined) lines.push(`Block:     ${r.blockNumber}`);
  lines.push(`Block hash:${r.block.blockHash}`);
  lines.push(
    `Finality:  ${r.block.confirmations} confirmation(s); ` +
      `${r.block.consensus.agreeing}/${r.block.consensus.total} RPC agreement ` +
      `(${r.block.consensus.mode})`,
  );
  if (r.gasUsed) lines.push(`Gas used:  ${r.gasUsed}`);
  if (r.callCount !== undefined) lines.push(`Calls:     ${r.callCount} frame(s)`);
  if (r.failingCall) {
    const f = r.failingCall;
    lines.push(`Failing:   ${f.from} -> ${f.to ?? '(create)'} [${f.selector}]${f.error ? ` error=${f.error}` : ''}`);
  }
  if (r.revert) lines.push(`Revert:    ${r.revert.reason}`);
  lines.push(`Cause:     ${r.probableCause}`);
  if (
    r.tokens &&
    (r.tokens.transfers.length > 0 ||
      r.tokens.approvals.length > 0 ||
      r.tokens.callIntents.length > 0)
  ) {
    const moved = 'Token movements (verified receipt logs)';
    if (r.tokens.transfers.length > 0) {
      lines.push(`${moved}:`);
      for (const t of r.tokens.transfers) {
        lines.push(`  ${t.from} -> ${t.to}: ${t.amount} [${t.symbol ?? t.token}]`);
      }
    }
    if (r.tokens.approvals.length > 0) {
      lines.push('Approvals:');
      for (const a of r.tokens.approvals) {
        const flag = a.isUnlimited || a.operatorAll ? '  ⚠ UNLIMITED' : a.isVeryLarge ? '  ⚠ very large' : '';
        lines.push(`  owner ${a.owner} grants ${a.spender}: ${a.amount} [${a.symbol ?? a.token}]${flag}`);
      }
    }
    if (r.tokens.callIntents.length > 0) {
      lines.push('ERC-compatible call intents (selector-derived, not movements):');
      for (const intent of r.tokens.callIntents) {
        const counterparty = intent.to ?? intent.spender ?? '(n/a)';
        const value = intent.displayAmount ?? intent.amountOrTokenId ?? '(n/a)';
        lines.push(
          `  ${intent.signature} target=${intent.target} counterparty=${counterparty} value=${value}`,
        );
      }
    }
  }
  if (r.nonPropagatingErrors && r.nonPropagatingErrors.length > 0) {
    lines.push('Non-propagating errored calls:');
    for (const error of r.nonPropagatingErrors) {
      lines.push(
        `  ${error.from} -> ${error.to ?? '(create)'} [${error.selector}] path=${error.depthPath.join('.') || 'root'}`,
      );
    }
  }
  if (r.notes.length) {
    lines.push('Notes:');
    for (const n of r.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof RpcError) {
      process.stderr.write(`RPC error: ${err.message}\n`);
    } else if (err instanceof Error) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${String(err)}\n`);
    }
    process.exit(process.argv.slice(2).includes('guard') ? 1 : 2);
  });

// Touch ethers import so tree-shakers keep it for value formatting used above.
void ethers;
