import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Interface, MaxUint256, Wallet } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { autopsy } from '../../scripts/autopsy.js';
import { loadConfig } from '../../scripts/config.js';
import {
  createEvidenceBundle,
  verifyEvidenceBundle,
} from '../../scripts/evidence.js';
import { inspect } from '../../scripts/inspect.js';
import { guard } from '../../scripts/guard.js';
import {
  createClient,
  prepareCommand,
  probeTraceSupport,
} from '../../scripts/rpc.js';
import { simulate } from '../../scripts/simulate.js';

const live = process.env.PHAROS_LIVE_TEST === '1';
const mainnetTest = live ? test : test.skip;
const wpros = '0x52c48d4213107b20bc583832b0d951fb9ca8f0b0';
const sender = '0x7Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C';
const approval = new Interface(['function approve(address,uint256)']);

mainnetTest('Pharos mainnet commands use real chain 1672 artifacts', async () => {
  const config = loadConfig({ ...process.env, PHAROS_NETWORK: 'mainnet' });
  const client = createClient(config);
  const snapshot = await prepareCommand(client);
  assert.equal(snapshot.chainId, 1672);
  assert.equal(snapshot.consensus.mode, 'single-endpoint');
  assert.equal(snapshot.confirmations >= 2, true);
  assert.equal(snapshot.meetsFinalityPolicy, true);

  const capability = await probeTraceSupport(client);
  assert.equal(capability.traceCall, true);
  assert.equal(capability.traceTransaction, true);

  const proxy = await inspect(
    client,
    '0x3c2269811836af69497e5f486a85d7316753cf62',
  );
  assert.equal(proxy.proxy.isProxy, true);
  assert.equal(
    proxy.proxy.implementation,
    '0x4EE2F9B7cf3A68966c370F3eb2C16613d3235245',
  );
  const evidence = await createEvidenceBundle(client, 'inspect', proxy, {
    PHAROS_EVIDENCE_SIGNING_KEY: Wallet.createRandom().privateKey,
  });
  assert.equal(verifyEvidenceBundle(evidence).valid, true);
  assert.equal(evidence.payload.block.blockHash, proxy.block.blockHash);
  assert.ok(
    evidence.payload.codeHashes.some(
      ({ address }) => address.toLowerCase() === proxy.address.toLowerCase(),
    ),
  );

  const failed = await autopsy(
    client,
    '0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff',
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.revert?.reason, 'BC');

  const simulation = await simulate(client, {
    from: sender,
    to: wpros,
    data:
      '0x70a082310000000000000000000000007Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C',
  });
  assert.equal(simulation.willRevert, false);
  assert.equal(simulation.block.blockHash.length, 66);

  const cleanGuard = await guard(client, {
    from: sender,
    to: wpros,
    data: '0x18160ddd',
  });
  assert.equal(cleanGuard.simulate.willRevert, false);
  assert.deepEqual(cleanGuard.flags, []);

  const approvalGuard = await guard(client, {
    from: sender,
    to: wpros,
    data: approval.encodeFunctionData('approve', [
      '0xbf105f4fd2f8f4c91d9a84a8d9708d23d8773f6e',
      MaxUint256,
    ]),
  });
  assert.equal(approvalGuard.simulate.willRevert, false);
  assert.deepEqual(approvalGuard.flags, ['unlimited_approval']);
});

function assertProbeContent(result: unknown): void {
  assert.ok(result && typeof result === 'object' && 'content' in result);
  const content = (result as { content: unknown }).content;
  assert.ok(Array.isArray(content));
  const text = content
    .filter(
      (item: unknown): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item: { text: string }) => item.text)
    .join('\n');
  assert.match(text, /"chainId": 1672/);
  assert.match(text, /"traceTransaction": true/);
}

function assertSignedEvidenceContent(result: unknown): void {
  assert.ok(result && typeof result === 'object' && 'content' in result);
  const content = (result as { content: unknown }).content;
  assert.ok(Array.isArray(content));
  const text = content
    .filter(
      (item: unknown): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item: { text: string }) => item.text)
    .join('\n');
  const bundle = JSON.parse(text) as unknown;
  assert.equal(verifyEvidenceBundle(bundle).valid, true);
  assert.match(text, /pharos-shield-evidence\/v1/);
  assert.match(text, /"chainId": 1672/);
}

function assertGuardContent(result: unknown): void {
  assert.ok(result && typeof result === 'object' && 'content' in result);
  const content = (result as { content: unknown }).content;
  assert.ok(Array.isArray(content));
  const text = content
    .filter(
      (item: unknown): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        'type' in item &&
        item.type === 'text' &&
        'text' in item &&
        typeof item.text === 'string',
    )
    .map((item: { text: string }) => item.text)
    .join('\n');
  const resultObject = JSON.parse(text) as {
    network?: unknown;
    flags?: unknown;
    simulate?: { willRevert?: unknown };
  };
  assert.equal(resultObject.network, 'mainnet');
  assert.deepEqual(resultObject.flags, []);
  assert.equal(resultObject.simulate?.willRevert, false);
}

async function waitForHttpServer(
  child: ReturnType<typeof spawn>,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP MCP start timeout')), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('MCP server listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP MCP exited early with ${String(code)}`));
    });
  });
}

mainnetTest('both MCP transports call live mainnet probe and guard', async () => {
  const stdioClient = new Client({ name: 'live-stdio', version: '1.0.0' });
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'mcp/server.ts'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PHAROS_NETWORK: 'mainnet',
      PHAROS_EVIDENCE_SIGNING_KEY: Wallet.createRandom().privateKey,
    },
    stderr: 'pipe',
  });
  await stdioClient.connect(stdio);
  try {
    assertSignedEvidenceContent(
      await stdioClient.callTool({
        name: 'shield_probe',
        arguments: { includeEvidence: true },
      }),
    );
    assertGuardContent(
      await stdioClient.callTool({
        name: 'shield_guard',
        arguments: { from: sender, to: wpros, data: '0x18160ddd' },
      }),
    );
  } finally {
    await stdioClient.close();
  }

  const port = 19_000 + (process.pid % 1000);
  const token = 'live-mainnet-test-token';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'mcp/server.ts', '--http', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PHAROS_NETWORK: 'mainnet',
        PHAROS_SHIELD_HTTP_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await waitForHttpServer(child);
    const httpClient = new Client({ name: 'live-http', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await httpClient.connect(transport as Transport);
    try {
      assertProbeContent(
        await httpClient.callTool({ name: 'shield_probe', arguments: {} }),
      );
      assertGuardContent(
        await httpClient.callTool({
          name: 'shield_guard',
          arguments: { from: sender, to: wpros, data: '0x18160ddd' },
        }),
      );
    } finally {
      await httpClient.close();
    }
  } finally {
    child.kill('SIGTERM');
  }
});
