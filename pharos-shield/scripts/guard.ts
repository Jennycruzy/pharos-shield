/**
 * guard — compose inspect + simulate into one pre-sign report.
 *
 * This module intentionally delegates all chain work to the existing command
 * cores. It only combines their verified results and derives stable fact keys.
 */

import type { ShieldClient } from './rpc.js';
import { inspect, type InspectResult } from './inspect.js';
import {
  formatSimulate,
  simulate,
  type SimulateParams,
  type SimulateResult,
} from './simulate.js';

export type GuardFlag =
  | 'unlimited_approval'
  | 'very_large_approval'
  | 'set_approval_for_all'
  | 'native_value_intent'
  | 'upgradeable_proxy_admin_set'
  | 'target_is_eoa'
  | 'would_revert';

export interface GuardParams extends SimulateParams {
  to: string;
}

export interface GuardResult {
  network: string;
  block: SimulateResult['block'];
  inspect: InspectResult;
  simulate: SimulateResult;
  flags: GuardFlag[];
}

export function guardFlags(
  inspected: InspectResult,
  simulation: SimulateResult,
  data: string | undefined,
): GuardFlag[] {
  const flags = new Set<GuardFlag>();
  const intents = simulation.tokens.callIntents;

  if (intents.some((intent) => intent.isUnlimited)) {
    flags.add('unlimited_approval');
  }
  if (intents.some((intent) => intent.isVeryLarge && !intent.isUnlimited)) {
    flags.add('very_large_approval');
  }
  if (
    intents.some(
      (intent) =>
        intent.signature === 'setApprovalForAll(address,bool)' &&
        intent.approved === true,
    )
  ) {
    flags.add('set_approval_for_all');
  }
  if (simulation.nativeValueIntents.length > 0) {
    flags.add('native_value_intent');
  }
  if (inspected.proxy.isProxy && inspected.proxy.admin !== undefined) {
    flags.add('upgradeable_proxy_admin_set');
  }
  if (inspected.kind === 'eoa' && (data?.trim() ?? '0x') !== '0x') {
    flags.add('target_is_eoa');
  }
  if (simulation.willRevert) {
    flags.add('would_revert');
  }

  return [...flags];
}

export async function guard(
  client: ShieldClient,
  params: GuardParams,
): Promise<GuardResult> {
  const inspected = await inspect(client, params.to);
  const simulation = await simulate(client, params);
  return {
    network: client.config.network.name,
    block: simulation.block,
    inspect: inspected,
    simulate: simulation,
    flags: guardFlags(inspected, simulation, params.data),
  };
}

const FLAG_TEXT: Record<GuardFlag, string> = {
  unlimited_approval:
    'The calldata requests an unlimited approval.',
  very_large_approval:
    'The calldata requests an approval at or above 2^255.',
  set_approval_for_all:
    'The calldata requests setApprovalForAll(..., true).',
  native_value_intent:
    'The trace contains one or more non-zero native PROS value intents.',
  upgradeable_proxy_admin_set:
    'The target is a detected proxy with a non-zero admin slot.',
  target_is_eoa:
    'The target has no deployed code, but the call includes calldata.',
  would_revert:
    'The exact simulated call would revert at the pinned block.',
};

export function formatGuard(result: GuardResult): string {
  const inspected = result.inspect;
  const simulation = result.simulate;
  const lines = [
    `Guard (${result.network}) — NO TX SENT`,
    '',
    'Verified facts',
    `  Target: ${inspected.address} (${inspected.kind})`,
    `  Target code size: ${inspected.codeSize} bytes`,
    `  Proxy: ${inspected.proxy.isProxy ? inspected.proxy.standard : 'not detected'}`,
  ];
  if (inspected.proxy.implementation) {
    lines.push(`  Implementation: ${inspected.proxy.implementation}`);
  }
  if (inspected.proxy.admin) {
    lines.push(`  Admin slot: ${inspected.proxy.admin}`);
  }
  if (inspected.bytecode) {
    lines.push(
      `  Notable opcodes: ${inspected.bytecode.opcodes.join(', ') || 'none detected'}`,
    );
  }
  lines.push(
    `  Simulation outcome: ${simulation.willRevert ? 'WOULD REVERT' : 'would succeed'}`,
  );
  if (simulation.revert) {
    lines.push(`  Decoded revert: ${simulation.revert.reason}`);
  }
  lines.push(`  Call frames: ${simulation.callCount}`);
  if (simulation.calls.length > 0) {
    lines.push('  Call tree:');
    for (const call of simulation.calls) {
      const indent = '  '.repeat(call.depth + 2);
      const reverted = call.errored ? ' [REVERTED]' : '';
      const value = call.value !== '0.0' ? ` value=${call.value}` : '';
      lines.push(
        `${indent}${call.type} -> ${call.to ?? '(create)'} [${call.selector}]${value}${reverted}`,
      );
    }
  }
  if (simulation.tokens.callIntents.length > 0) {
    lines.push('  ERC-compatible call intents:');
    for (const intent of simulation.tokens.callIntents) {
      const counterparty = intent.to ?? intent.spender ?? '(n/a)';
      const amount = intent.displayAmount ?? intent.amountOrTokenId ?? '(n/a)';
      lines.push(
        `    ${intent.signature} target=${intent.target} counterparty=${counterparty} value=${amount}`,
      );
    }
  }
  if (simulation.nativeValueIntents.length > 0) {
    lines.push('  Native PROS value intents:');
    for (const intent of simulation.nativeValueIntents) {
      lines.push(`    ${intent.from} -> ${intent.to}: ${intent.pros}`);
    }
  }
  lines.push('', 'Flags (facts that warrant attention)');
  if (result.flags.length === 0) {
    lines.push('  None.');
  } else {
    for (const flag of result.flags) {
      lines.push(`  ${flag}: ${FLAG_TEXT[flag]}`);
    }
  }
  lines.push('', 'Simulation details', formatSimulate(simulation));
  return lines.join('\n');
}
