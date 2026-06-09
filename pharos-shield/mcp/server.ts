#!/usr/bin/env node
/**
 * Pharos Shield MCP server.
 *
 * Exposes the SAME three core commands as MCP tools so any MCP-compatible agent
 * can call Shield natively. This is a THIN adapter — it reuses scripts/ core
 * (simulate, autopsy, inspect) verbatim; no logic is reimplemented here.
 *
 * Transports:
 *   - stdio (default): `node --import tsx mcp/server.ts`
 *   - Streamable HTTP:  `node --import tsx mcp/server.ts --http [--port 8731]`
 *
 * Tools:
 *   shield_inspect   { address }
 *   shield_autopsy   { txhash }
 *   shield_simulate  { from, to?, data?, value?, gas? }
 *   shield_probe     {}                      (network + live trace capability)
 *
 * Honors PHAROS_NETWORK (default mainnet/1672) exactly like the CLI.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { loadConfig } from '../scripts/config.js';
import { createClient, probeTraceSupport } from '../scripts/rpc.js';
import { inspect } from '../scripts/inspect.js';
import { autopsy } from '../scripts/autopsy.js';
import { simulate } from '../scripts/simulate.js';

/** Build a fresh client per call so PHAROS_NETWORK changes are honored. */
function client() {
  return createClient(loadConfig());
}

function jsonContent(obj: unknown) {
  const text = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  return { content: [{ type: 'text' as const, text }] };
}

function errorContent(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'pharos-shield',
    version: '0.1.0',
  });

  server.registerTool(
    'shield_inspect',
    {
      title: 'Inspect a Pharos address',
      description:
        'Classify an address as contract or EOA and report EIP-1967 proxy facts ' +
        '(implementation, admin, beacon) read from on-chain storage. Pharos mainnet by default. ' +
        'Reports only what storage proves; no source-verification claims.',
      inputSchema: {
        address: z.string().describe('0x-prefixed 20-byte address to inspect'),
      },
    },
    async ({ address }) => {
      try {
        return jsonContent(await inspect(client(), address));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'shield_autopsy',
    {
      title: 'Autopsy a failed Pharos transaction',
      description:
        'Diagnose why a transaction failed: traces it with callTracer, finds the deepest ' +
        'reverting call, decodes the revert reason (Error/Panic/custom), and reports a ' +
        'trace-supported probable cause. Says so plainly if the tx actually succeeded.',
      inputSchema: {
        txhash: z.string().describe('0x-prefixed 32-byte transaction hash'),
      },
    },
    async ({ txhash }) => {
      try {
        return jsonContent(await autopsy(client(), txhash));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'shield_simulate',
    {
      title: 'Simulate (dry-run) a Pharos transaction',
      description:
        'Pre-flight a call via debug_traceCall at the latest block. Reports whether it would ' +
        'revert (with decoded reason), the would-be call tree, and native PROS movements. ' +
        'NEVER sends a transaction.',
      inputSchema: {
        from: z.string().describe('0x sender address (required by Pharos debug_traceCall)'),
        to: z.string().optional().describe('0x target address; omit for contract creation'),
        data: z.string().optional().describe('0x calldata (default 0x)'),
        value: z.string().optional().describe('PROS amount (decimal e.g. "1.5") or hex wei'),
        gas: z.string().optional().describe('gas limit (decimal or hex)'),
      },
    },
    async (params) => {
      try {
        const args = {
          from: params.from,
          ...(params.to !== undefined ? { to: params.to } : {}),
          ...(params.data !== undefined ? { data: params.data } : {}),
          ...(params.value !== undefined ? { value: params.value } : {}),
          ...(params.gas !== undefined ? { gas: params.gas } : {}),
        };
        return jsonContent(await simulate(client(), args));
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'shield_probe',
    {
      title: 'Probe network & trace capability',
      description:
        'Report the active network (mainnet 1672 by default), RPC URL, and a LIVE check of ' +
        'whether the debug_* trace namespace is enabled on it.',
      inputSchema: {},
    },
    async () => {
      try {
        const c = client();
        const cap = await probeTraceSupport(c);
        return jsonContent({
          network: c.config.network.name,
          chainId: c.config.network.chainId,
          rpcUrl: c.config.rpcUrl,
          defaultRpcVerified: c.config.network.defaultRpcVerified,
          trace: cap,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  return server;
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout carries the MCP protocol.
  process.stderr.write('pharos-shield MCP server running on stdio\n');
}

async function runHttp(port: number): Promise<void> {
  // Stateful Streamable HTTP: one transport+server per session id.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttp(req, res, transports).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }));
    });
  });

  httpServer.listen(port, () => {
    process.stderr.write(
      `pharos-shield MCP server listening on http://127.0.0.1:${port}/mcp\n`,
    );
  });
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  transports: Map<string, StreamableHTTPServerTransport>,
): Promise<void> {
  const url = req.url ?? '/';
  if (!url.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found; POST to /mcp' }));
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

  let transport: StreamableHTTPServerTransport | undefined =
    sid ? transports.get(sid) : undefined;

  if (!transport) {
    // New session: create a transport + server pair.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        transports.set(id, transport!);
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    const server = buildServer();
    // The SDK's Transport interface and the concrete class disagree on the
    // optionality of `onclose` under exactOptionalPropertyTypes; the runtime
    // contract is satisfied (we set onclose above). Cast at this boundary only.
    await server.connect(transport as Transport);
  }

  await transport.handleRequest(req, res);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const http = argv.includes('--http');
  if (http) {
    const portIdx = argv.indexOf('--port');
    const port =
      portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : 8731;
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Invalid --port value.`);
    }
    await runHttp(port);
  } else {
    await runStdio();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
