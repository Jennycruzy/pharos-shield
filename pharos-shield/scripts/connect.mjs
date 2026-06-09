#!/usr/bin/env node
/**
 * Prints ready-to-paste config for connecting Pharos Shield to common agent
 * CLIs as an MCP server. All paths are resolved to absolute so the snippets
 * work regardless of where the agent is launched from.
 *
 *   npm run setup
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(root, 'bin', 'pharos-shield-mcp.mjs');
const server = join(root, 'mcp', 'server.ts');

const bar = '─'.repeat(68);
const h = (t) => `\n${bar}\n  ${t}\n${bar}`;

console.log(`
Pharos Shield — connect to an agent CLI over MCP
Repo: ${root}
${h('Claude Code  (project scope — already wired)')}
A .mcp.json is committed at the repo root. Just open this folder in Claude
Code and approve the "pharos-shield" server when prompted. To register it
globally instead (any directory):

  claude mcp add pharos-shield -- node --import tsx ${server}
${h('Codex CLI  (~/.codex/config.toml)')}
[mcp_servers.pharos-shield]
command = "node"
args = ["--import", "tsx", "${server}"]
env = { PHAROS_NETWORK = "mainnet" }
${h('Cursor / Windsurf / generic MCP client  (mcpServers JSON)')}
{
  "mcpServers": {
    "pharos-shield": {
      "command": "node",
      "args": ["--import", "tsx", "${server}"],
      "env": { "PHAROS_NETWORK": "mainnet" }
    }
  }
}
${h('Via the launcher binary  (after: npm link)')}
Shorter command — runs the same server, forwards flags (--http etc.):

  ${bin}
${bar}
Once connected, just talk in plain English. The agent picks the right tool:
  "is 0x3c22…cf62 a proxy and who can upgrade it?"   -> shield_inspect
  "why did tx 0xdeeb…e3ff fail?"                      -> shield_autopsy
  "dry-run this call before I sign it"                -> shield_simulate
  "is the Pharos trace API live right now?"           -> shield_probe
${bar}
`);
