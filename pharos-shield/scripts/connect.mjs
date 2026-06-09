#!/usr/bin/env node
/**
 * Prints ready-to-paste config for connecting Pharos Shield to common agent
 * CLIs as an MCP server. Shows the installed-binary form (preferred) and the
 * in-repo dev form. All paths are resolved to absolute.
 *
 *   npm run setup
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distServer = join(root, 'dist', 'mcp', 'server.js');
const built = existsSync(distServer);

const bar = '─'.repeat(68);
const h = (t) => `\n${bar}\n  ${t}\n${bar}`;

console.log(`
Pharos Shield — connect to an agent CLI over MCP
Repo: ${root}
Build: ${built ? 'dist/ present ✓' : 'not built yet — run `npm run build` (or `npm install`)'}
${h('Recommended — install the binary once, then refer to it by name')}
From this folder:

  npm install -g .        # or: npm link    (exposes "pharos-shield-mcp")

Then every CLI below can use a one-word command with NO path and NO tsx.
Once published to npm, the same works zero-clone via:

  npx -y -p pharos-shield pharos-shield-mcp
${h('Claude Code')}
A project-scoped .mcp.json is committed at the repo root — open this folder
and approve the "pharos-shield" server. To register globally (any directory):

  claude mcp add pharos-shield -- pharos-shield-mcp
${h('Codex CLI  (~/.codex/config.toml)')}
[mcp_servers.pharos-shield]
command = "pharos-shield-mcp"
env = { PHAROS_NETWORK = "mainnet" }
${h('Cursor / Windsurf / generic MCP client  (mcpServers JSON)')}
{
  "mcpServers": {
    "pharos-shield": {
      "command": "pharos-shield-mcp",
      "env": { "PHAROS_NETWORK": "mainnet" }
    }
  }
}
${h('No global install? Point at the compiled file directly')}
command = "node",  args = ["${distServer}"]
${h('In-repo dev (no build step — runs TypeScript via tsx)')}
command = "node",  args = ["--import", "tsx", "${join(root, 'mcp', 'server.ts')}"]
${bar}
Once connected, just talk in plain English. The agent picks the right tool:
  "is 0x3c22…cf62 a proxy and who can upgrade it?"   -> shield_inspect
  "why did tx 0xdeeb…e3ff fail?"                      -> shield_autopsy
  "dry-run this call before I sign it"                -> shield_simulate
  "is the Pharos trace API live right now?"           -> shield_probe
${bar}
`);
