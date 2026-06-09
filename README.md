# pharos-shield-skill

**Pharos Shield** — a transaction-and-contract **integrity** layer for Pharos
mainnet (chain 1672). Three composable commands: `simulate` (pre-flight a tx),
`autopsy` (diagnose a failed tx), and `inspect` (classify an address / detect
EIP-1967 proxy + admin). On-chain facts only — never a SAFE/UNSAFE verdict.
Not a token rug/honeypot scanner.

➡️ The skill lives in [`pharos-shield/`](./pharos-shield/). See
[`pharos-shield/README.md`](./pharos-shield/README.md) for real verified mainnet
examples, the MCP server, and the honest verified-vs-degraded status.

```bash
cd pharos-shield
npm install
npm run cli -- probe                 # network + live trace capability
npm run cli -- inspect  0x<address>
npm run cli -- autopsy  0x<txhash>
npm run cli -- simulate --from 0x<addr> --to 0x<addr> --data 0x<calldata>
```

Ships both an Agent Skill (`SKILL.md` / `AGENTS.md` / `CLAUDE.md`) and an MCP
server (`shield_inspect`, `shield_autopsy`, `shield_simulate`, `shield_probe`).
