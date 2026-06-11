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
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { loadConfig } from '../scripts/config.js';
import { blockAnchor, createClient, probeTraceSupport } from '../scripts/rpc.js';
import { inspect } from '../scripts/inspect.js';
import { autopsy } from '../scripts/autopsy.js';
import { simulate } from '../scripts/simulate.js';
import {
  createEvidenceBundle,
  type EvidencePayload,
} from '../scripts/evidence.js';

/** Build a fresh client per call so PHAROS_NETWORK changes are honored. */
function client() {
  return createClient(loadConfig());
}

function jsonContent(obj: unknown) {
  const text = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  return { content: [{ type: 'text' as const, text }] };
}

async function resultContent(
  command: EvidencePayload['command'],
  c: ReturnType<typeof client>,
  result: unknown,
  includeEvidence: boolean | undefined,
) {
  return jsonContent(
    includeEvidence
      ? await createEvidenceBundle(c, command, result)
      : result,
  );
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
        'Inspect a Pharos contract/address. Classifies it as contract or EOA, then reports its ' +
        'control structure from on-chain facts: proxy detection (EIP-1967 implementation/admin/' +
        'beacon, legacy-OZ, and EIP-1167 minimal-proxy), a control graph with code hashes, reported ' +
        'owners, Safe-style thresholds, timelock delays, and UUPS compatibility, plus a PUSH-aware ' +
        'bytecode scan for DELEGATECALL / SELFDESTRUCT / CREATE2, live owner()/paused() reads, token ' +
        'name/symbol/decimals/totalSupply, and declared ERC-165 interfaces — each pinned to one block ' +
        'hash and only when the chain ' +
        'answers. Use for: "is this a proxy / who can upgrade it", "is this a contract or wallet", ' +
        '"can this contract self-destruct", "who owns this contract", "what token is this". Pharos ' +
        'mainnet by default. Reports only what storage/chain proves; never a SAFE/UNSAFE verdict or ' +
        'verified-source claim.',
      inputSchema: {
        address: z.string().describe('0x-prefixed 20-byte address to inspect'),
        includeEvidence: z
          .boolean()
          .optional()
          .describe('Return a signed evidence bundle; requires PHAROS_EVIDENCE_SIGNING_KEY'),
      },
    },
    async ({ address, includeEvidence }) => {
      try {
        const c = client();
        const result = await inspect(c, address);
        return await resultContent('inspect', c, result, includeEvidence);
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'shield_autopsy',
    {
      title: 'Autopsy a Pharos transaction',
      description:
        'Diagnose a Pharos transaction from its hash. If it failed, traces it with callTracer, finds ' +
        'the deepest call on the root-propagated revert path, separates caught errors, and decodes the revert reason (Error/Panic/custom selector, with ' +
        '4-byte selectors resolved via the openchain signature DB), and reports a trace-supported ' +
        'root-propagated probable cause (allowance, insufficient balance, slippage, paused, deadline, overflow, ' +
        'out-of-gas) or "cause undetermined". If it succeeded, says so and decodes the real ERC-20/721 ' +
        'Transfer/Approval events from the receipt; for a failure it separately reports selector-derived ' +
        'ERC-compatible call intents, never fake movements. Use for: "why did my tx fail/revert", "did this tx succeed or fail", "which inner ' +
        'call reverted", "what tokens did this move".',
      inputSchema: {
        txhash: z.string().describe('0x-prefixed 32-byte transaction hash'),
        includeEvidence: z
          .boolean()
          .optional()
          .describe('Return a signed evidence bundle; requires PHAROS_EVIDENCE_SIGNING_KEY'),
      },
    },
    async ({ txhash, includeEvidence }) => {
      try {
        const c = client();
        const result = await autopsy(c, txhash);
        return await resultContent('autopsy', c, result, includeEvidence);
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
        'Pre-flight / dry-run a Pharos call via debug_traceCall at one quorum-checked confirmation-depth block hash, before signing. ' +
        'Reports whether it would revert (with decoded reason), the would-be call tree, native PROS ' +
        'value intents, and selector-derived ERC-compatible transfer/approval call intents — flagging UNLIMITED ' +
        'approvals (max uint256 / setApprovalForAll), the most common way wallets get drained. Use for: ' +
        '"will this tx work / revert", "what does this transaction do / what would it move before I ' +
        'sign", "is this an unlimited approval intent", "dry-run this call". Call intents are not claimed ' +
        'as completed token movements. NEVER sends a transaction — it is ' +
        'read-only.',
      inputSchema: {
        from: z.string().describe('0x sender address (required by Pharos debug_traceCall)'),
        to: z.string().optional().describe('0x target address; omit for contract creation'),
        data: z.string().optional().describe('0x calldata (default 0x)'),
        value: z.string().optional().describe('PROS amount (decimal e.g. "1.5") or hex wei'),
        gas: z.string().optional().describe('gas limit (decimal or hex)'),
        includeEvidence: z
          .boolean()
          .optional()
          .describe('Return a signed evidence bundle; requires PHAROS_EVIDENCE_SIGNING_KEY'),
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
        const c = client();
        const result = await simulate(c, args);
        return await resultContent(
          'simulate',
          c,
          result,
          params.includeEvidence,
        );
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
      inputSchema: {
        includeEvidence: z
          .boolean()
          .optional()
          .describe('Return a signed evidence bundle; requires PHAROS_EVIDENCE_SIGNING_KEY'),
      },
    },
    async ({ includeEvidence }) => {
      try {
        const c = client();
        const cap = await probeTraceSupport(c);
        const result = {
          network: c.config.network.name,
          chainId: c.config.network.chainId,
          rpcUrl: c.config.rpcUrl,
          defaultRpcVerified: c.config.network.defaultRpcVerified,
          block: blockAnchor(cap.block),
          trace: cap,
        };
        return await resultContent('probe', c, result, includeEvidence);
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

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

interface HttpState {
  sessions: Map<string, HttpSession>;
  pendingSessions: number;
}

interface HttpOptions {
  host: string;
  port: number;
  token?: string;
  maxSessions: number;
  sessionIdleMs: number;
}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1';
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  const supplied =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : undefined;
  if (!supplied) return false;
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

async function runHttp(options: HttpOptions): Promise<void> {
  // Stateful Streamable HTTP: one transport+server per session id.
  const state: HttpState = {
    sessions: new Map<string, HttpSession>(),
    pendingSessions: 0,
  };

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttp(req, res, state, options).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off('error', reject);
      process.stderr.write(
        `pharos-shield MCP server listening on http://${options.host}:${options.port}/mcp ` +
          `(maxSessions=${options.maxSessions}, idle=${options.sessionIdleMs}ms, ` +
          `auth=${options.token ? 'bearer' : 'loopback-only'})\n`,
      );
      resolve();
    });
  });
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  state: HttpState,
  options: HttpOptions,
): Promise<void> {
  const { sessions } = state;
  if (!authorized(req, options.token)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const url = req.url ?? '/';
  if (!url.startsWith('/mcp')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found; POST to /mcp' }));
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastSeen > options.sessionIdleMs) {
      sessions.delete(id);
      void session.transport.close().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`failed to close idle MCP session ${id}: ${message}\n`);
      });
    }
  }

  let transport: StreamableHTTPServerTransport | undefined =
    sid ? sessions.get(sid)?.transport : undefined;

  if (sid && !transport) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown or expired MCP session' }));
    return;
  }
  if (sid) {
    const session = sessions.get(sid);
    if (session) session.lastSeen = now;
  }

  if (!transport) {
    if (sessions.size + state.pendingSessions >= options.maxSessions) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP session limit reached' }));
      return;
    }
    state.pendingSessions++;
    // New session: create a transport + server pair.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport: transport!, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport!.sessionId) sessions.delete(transport!.sessionId);
    };
    const server = buildServer();
    // The SDK's Transport interface and the concrete class disagree on the
    // optionality of `onclose` under exactOptionalPropertyTypes; the runtime
    // contract is satisfied (we set onclose above). Cast at this boundary only.
    try {
      await server.connect(transport as Transport);
    } catch (err) {
      state.pendingSessions--;
      throw err;
    }
  }

  try {
    await transport.handleRequest(req, res);
  } finally {
    if (!sid && state.pendingSessions > 0) state.pendingSessions--;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const http = argv.includes('--http');
  if (http) {
    const portIdx = argv.indexOf('--port');
    const port =
      portIdx >= 0 && argv[portIdx + 1] ? Number(argv[portIdx + 1]) : 8731;
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid --port value.`);
    }
    const hostIdx = argv.indexOf('--host');
    const host =
      hostIdx >= 0 && argv[hostIdx + 1]
        ? argv[hostIdx + 1]!
        : process.env.PHAROS_SHIELD_HTTP_HOST?.trim() || '127.0.0.1';
    const token = process.env.PHAROS_SHIELD_HTTP_TOKEN?.trim() || undefined;
    if (!isLoopback(host) && (!token || token.length < 16)) {
      throw new Error(
        'Non-loopback HTTP binding requires PHAROS_SHIELD_HTTP_TOKEN bearer authentication with at least 16 characters.',
      );
    }
    const maxSessions = positiveInteger(
      process.env.PHAROS_SHIELD_HTTP_MAX_SESSIONS,
      32,
      'PHAROS_SHIELD_HTTP_MAX_SESSIONS',
    );
    const sessionIdleMs = positiveInteger(
      process.env.PHAROS_SHIELD_HTTP_SESSION_IDLE_MS,
      15 * 60 * 1000,
      'PHAROS_SHIELD_HTTP_SESSION_IDLE_MS',
    );
    await runHttp({
      host,
      port,
      ...(token ? { token } : {}),
      maxSessions,
      sessionIdleMs,
    });
  } else {
    await runStdio();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
