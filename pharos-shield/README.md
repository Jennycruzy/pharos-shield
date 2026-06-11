# pharos-shield-mcp

**Transaction & contract integrity for Pharos mainnet (chain 1672), as an MCP
server.** Talk to it in plain English from any agent CLI — it answers from
on-chain facts only, and never shows a fake "SAFE" badge.

It answers two questions honestly:

- *Will this transaction do what I expect, or why did it fail?*
- *What is this contract, and who controls it?*

It is **not** a token rug/honeypot/tax scanner — it operates at the
transaction-execution and contract-control layer.

## Tools

Connect it to your agent and just ask; the agent routes to the right tool:

| Tool | Ask | What it does |
| --- | --- | --- |
| `shield_inspect` | "map this proxy's controls" | slots, code hashes, owners, multisig/timelock signals, UUPS compatibility |
| `shield_autopsy` | "why did tx `0x…` fail?" | follows the root-propagated failure and separates caught reverts |
| `shield_simulate` | "dry-run this before I sign" | pinned pre-flight, native value intents, ERC-compatible call intents |
| `shield_probe` | "is the trace API live?" | validates chain/genesis/freshness and probes both trace methods |

Reports verified facts ("admin slot = 0x…", "would revert: INSUFFICIENT_OUTPUT"),
never a SAFE/UNSAFE verdict.

## Connect

**Once published to npm** — zero clone, add to your MCP client:

```json
{
  "mcpServers": {
    "pharos-shield": {
      "command": "npx",
      "args": ["-y", "pharos-shield-mcp"],
      "env": { "PHAROS_NETWORK": "mainnet" }
    }
  }
}
```

Or for Claude Code: `claude mcp add pharos-shield -- npx -y pharos-shield-mcp`

**From source** — clone the repo and run the one-step installer (installs deps,
builds, registers the MCP server, installs the agent skill):

```bash
git clone https://github.com/Jennycruzy/pharos-shield
cd pharos-shield
bash install.sh
```

Run `npm run setup` in this folder for ready-to-paste config for Codex, Cursor,
and other MCP clients.

## CLI (optional)

The same core is a CLI:

```bash
npm run cli -- inspect  0x3c2269811836af69497e5f486a85d7316753cf62
npm run cli -- autopsy  0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff
npm run cli -- simulate --from 0x… --to 0x… --data 0x…
npm run cli -- probe
# add --json for machine-readable output
```

## Notes

- **Mainnet (1672) is the default** and the network of every example. Atlantic
  testnet (688689) is a secondary toggle via `PHAROS_NETWORK=testnet`.
- Every command rejects wrong-chain RPCs and pins state reads to one block hash.
- **No keys, read-only.** Shield only calls read RPC methods (`eth_call`,
  `eth_getCode`, `eth_getStorageAt`, `debug_traceCall`, `debug_traceTransaction`).
  It never signs or sends a transaction, so there is nothing to put in `.env`
  beyond optional network/RPC overrides — see `.env.example`.

Full documentation, verified mainnet examples, and exact outputs are in the
[repository README](https://github.com/Jennycruzy/pharos-shield#readme).

MIT
