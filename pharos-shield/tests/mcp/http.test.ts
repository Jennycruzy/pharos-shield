import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

async function waitForServer(
  child: ReturnType<typeof spawn>,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('MCP server listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with ${String(code)}`));
    });
  });
}

test('HTTP MCP binds loopback and requires configured bearer auth', async () => {
  const port = 18_000 + (process.pid % 1000);
  const token = 'test-token';
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'mcp/server.ts', '--http', '--port', String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PHAROS_SHIELD_HTTP_TOKEN: token,
        PHAROS_SHIELD_HTTP_MAX_SESSIONS: '1',
        PHAROS_SHIELD_HTTP_SESSION_IDLE_MS: '5000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    await waitForServer(child);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
    });
    assert.equal(unauthorized.status, 401);

    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await client.connect(transport as Transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(({ name }) => name).sort(),
      [
        'shield_autopsy',
        'shield_guard',
        'shield_inspect',
        'shield_probe',
        'shield_simulate',
      ],
    );

    const secondClient = new Client({ name: 'second', version: '1.0.0' });
    const secondTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    );
    await assert.rejects(
      secondClient.connect(secondTransport as Transport),
      /503|session limit/i,
    );
    await client.close();
  } finally {
    child.kill('SIGTERM');
  }
});

test('non-loopback HTTP binding is refused without a token', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'mcp/server.ts', '--http', '--host', '0.0.0.0', '--port', '1'],
    {
      cwd: process.cwd(),
      env: { ...process.env, PHAROS_SHIELD_HTTP_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exitCode = await new Promise<number | null>((resolve) =>
    child.once('exit', resolve),
  );
  assert.equal(exitCode, 1);
});
