#!/usr/bin/env node
/**
 * Portable launcher for the Pharos Shield MCP server.
 *
 * Any agent CLI (Claude Code, Codex, Cursor, …) can spawn this single binary to
 * talk to Shield over MCP. It runs the TypeScript server through the tsx loader
 * and passes stdio straight through, so the MCP stdio framing is preserved.
 * Extra flags are forwarded verbatim, e.g.:
 *
 *   pharos-shield-mcp            # stdio transport (default)
 *   pharos-shield-mcp --http     # Streamable HTTP on 127.0.0.1:8731
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, '..', 'mcp', 'server.ts');

const child = spawn(
  process.execPath,
  ['--import', 'tsx', server, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
