# Pharos Shield — agent guide

Transaction & contract **integrity** layer for **Pharos mainnet (chain 1672)**.
Four composable commands sharing one trace/RPC core. Reports only on-chain
facts — never a SAFE/UNSAFE verdict. Not a token rug/honeypot scanner.

## Install (if asked to "install this skill")

Run the repo's installer from the repo root, then tell the user to start a new
session: `bash install.sh`. It runs `npm install` (builds `dist/`), registers
the MCP server, and installs the skill. For a specific MCP client instead, run
`npm run setup` here for ready-to-paste config.

## Commands

- `guard` — preferred pre-sign gate: composes `inspect` and `simulate`, then
  returns stable fact flags and exit code 0 (no flags), 2 (flags), or 1
  (Shield could not complete). Use for "check this transaction before I sign it".
- `simulate` — pre-flight a tx via `debug_traceCall`; reports revert/no-revert,
	  call tree, native PROS value intents, and ERC-compatible calldata intents
	  (flags UNLIMITED approval requests). Never sends a transaction.
- `autopsy <txhash>` — diagnose a failed tx via `debug_traceTransaction`
  (callTracer): root-propagated reverting call + caught-error separation +
  decoded revert + probable cause, plus
	  real succeeded activity from receipt logs and separate selector-derived call
	  intents for failed traces.
- Both `simulate` and `autopsy` resolve raw 4-byte function/custom-error
  selectors via the openchain.xyz signature DB (`scripts/signatures.ts`). A
  named custom error is applied only when its args actually decode against the
  payload (no coincidental-collision mislabels). Sourcify is not used — it does
  not index chain 1672 (verified), so no verified ABI is ever claimed.
- `inspect <address>` — contract vs EOA, EIP-1967 proxy/impl/admin + EIP-1167
	  minimal-proxy + beacon resolution, a control graph (code hashes, reported
	  owners, Safe thresholds, timelocks, UUPS compatibility), PUSH-aware bytecode scan
  (DELEGATECALL/SELFDESTRUCT/CREATE2), and live owner()/paused()/token-metadata/
  ERC-165 reads. Reports only what storage proves or the chain answers.

Token reporting is fact-based movement/approval accounting (symbols/decimals via
`eth_call`), NOT a token risk score or honeypot scanner.

## Invoke (CLI)

```bash
npm install
npm run cli -- guard --from 0x<addr> --to 0x<addr> --data 0x<calldata>
npm run cli -- inspect  0x<address>
npm run cli -- autopsy  0x<txhash>
npm run cli -- simulate --from 0x<addr> --to 0x<addr> --data 0x<calldata>
npm run cli -- probe
npm run cli -- verify-evidence evidence.json
# flags: --json (machine output), --network testnet (secondary; mainnet default)
```

## Invoke (MCP)

The same core is exposed as MCP tools — see `mcp/server.ts`:
`shield_guard`, `shield_inspect`, `shield_autopsy`, `shield_simulate`,
`shield_probe`.

```bash
npm run mcp           # stdio transport
npm run mcp:http      # Streamable HTTP on http://127.0.0.1:8731/mcp
```

## Hard rules for any agent using/extending this

1. **Mainnet (1672) is the default and the network of every claim/demo.** Atlantic
   testnet (688689) is a secondary toggle via `PHAROS_NETWORK=testnet`.
2. **Never fabricate output.** Every result must come from a real RPC call. If a
   capability is unavailable, degrade and label it — do not fake it.
3. **Report verified facts, not verdicts.** "admin slot = 0x…", "would revert:
   <reason>", "cause undetermined" — never a green "SAFE" badge.
4. Every command validates chain ID, verifies mainnet genesis, checks freshness,
   pins state reads to a confirmation-depth block hash, and rechecks it after
   analysis. Configured independent RPC peers must meet quorum; one endpoint is
   labeled `single-endpoint`, never quorum. Default mainnet RPC
   `https://rpc.pharos.xyz` is confirmed to expose
   `debug_traceCall` / `debug_traceTransaction` with `callTracer`. Pharos returns
   top-level reverts in `debug_traceCall` as JSON-RPC error code 3 with revert
   data in `error.data` (handled in `scripts/simulate.ts`).
5. Evidence signing is opt-in and uses only `PHAROS_EVIDENCE_SIGNING_KEY`.
   Never request or reuse a wallet transaction key for evidence.
