#!/usr/bin/env node
/**
 * Pharos Shield CLI — simulate | autopsy | inspect.
 *
 * Thin command layer over the shared core modules. Honors PHAROS_NETWORK
 * (default mainnet/1672). Supports --json for machine-readable output.
 */

import { loadConfig } from './config.js';
import { createClient, probeTraceSupport, RpcError } from './rpc.js';
import { autopsy } from './autopsy.js';
import { simulate, formatSimulate } from './simulate.js';
import { inspect, formatInspect } from './inspect.js';
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
  pharos-shield probe                                   Report network + live trace-namespace capability

Flags:
  --json        Emit JSON instead of formatted text
  --network     Override PHAROS_NETWORK for this run (mainnet|testnet)

Env:
  PHAROS_NETWORK   mainnet (default) | testnet
  PHAROS_*_RPC     override RPC URLs (see .env.example)
`;

async function main(): Promise<number> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  const json = flags.get('json') === true;

  if (!command || command === 'help' || flags.get('help') === true) {
    process.stdout.write(USAGE + '\n');
    return command ? 0 : 1;
  }

  // Allow --network to override env for this invocation.
  const netOverride = asString(flags.get('network'));
  if (netOverride) process.env.PHAROS_NETWORK = netOverride;

  const config = loadConfig();
  const client = createClient(config);

  const emit = (obj: unknown, text: string): void => {
    if (json) process.stdout.write(JSON.stringify(obj, bigintReplacer, 2) + '\n');
    else process.stdout.write(text + '\n');
  };

  switch (command) {
    case 'probe': {
      const cap = await probeTraceSupport(client);
      const obj = {
        network: config.network.name,
        chainId: config.network.chainId,
        rpcUrl: config.rpcUrl,
        defaultRpcVerified: config.network.defaultRpcVerified,
        trace: cap,
      };
      emit(
        obj,
        `Network:  ${config.network.name} (chain ${config.network.chainId})\n` +
          `RPC:      ${config.rpcUrl}\n` +
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
      emit(result, formatInspect(result));
      return 0;
    }

    case 'autopsy': {
      const tx = positionals[0];
      if (!tx) {
        process.stderr.write('autopsy requires a <txhash>.\n');
        return 1;
      }
      const result = await autopsy(client, tx);
      emit(result, formatAutopsy(result));
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
      emit(result, formatSimulate(result));
      return 0;
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
  if (r.gasUsed) lines.push(`Gas used:  ${r.gasUsed}`);
  if (r.callCount !== undefined) lines.push(`Calls:     ${r.callCount} frame(s)`);
  if (r.failingCall) {
    const f = r.failingCall;
    lines.push(`Failing:   ${f.from} -> ${f.to ?? '(create)'} [${f.selector}]${f.error ? ` error=${f.error}` : ''}`);
  }
  if (r.revert) lines.push(`Revert:    ${r.revert.reason}`);
  lines.push(`Cause:     ${r.probableCause}`);
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
    process.exit(2);
  });

// Touch ethers import so tree-shakers keep it for value formatting used above.
void ethers;
