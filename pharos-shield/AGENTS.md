# Pharos Shield — agent guide

Transaction & contract **integrity** layer for **Pharos mainnet (chain 1672)**.
Three composable commands sharing one trace/RPC core. Reports only on-chain
facts — never a SAFE/UNSAFE verdict. Not a token rug/honeypot scanner.

## Commands

- `simulate` — pre-flight a tx via `debug_traceCall`; reports revert/no-revert,
  call tree, native PROS movements, and ERC-20/721 token movements + approvals
  (flags UNLIMITED approvals before signing). Never sends a transaction.
- `autopsy <txhash>` — diagnose a failed tx via `debug_traceTransaction`
  (callTracer): deepest reverting call + decoded revert + probable cause, plus
  real (succeeded) or attempted (failed) token movements from logs/trace.
- `inspect <address>` — contract vs EOA, EIP-1967 proxy/impl/admin + EIP-1167
  minimal-proxy + beacon resolution, PUSH-aware bytecode scan
  (DELEGATECALL/SELFDESTRUCT/CREATE2), and live owner()/paused()/token-metadata/
  ERC-165 reads. Reports only what storage proves or the chain answers.

Token reporting is fact-based movement/approval accounting (symbols/decimals via
`eth_call`), NOT a token risk score or honeypot scanner.

## Invoke (CLI)

```bash
npm install
npm run cli -- inspect  0x<address>
npm run cli -- autopsy  0x<txhash>
npm run cli -- simulate --from 0x<addr> --to 0x<addr> --data 0x<calldata>
npm run cli -- probe
# flags: --json (machine output), --network testnet (secondary; mainnet default)
```

## Invoke (MCP)

The same core is exposed as MCP tools — see `mcp/server.ts`:
`shield_inspect`, `shield_autopsy`, `shield_simulate`, `shield_probe`.

```bash
npm run mcp           # stdio transport
npm run mcp:http      # Streamable HTTP on http://127.0.0.1:8731/mcp
```

## Hard rules for any agent using/extending this

1. **Mainnet (1672) is the default and the network of every claim/demo.** Testnet
   (688688) is a secondary toggle via `PHAROS_NETWORK=testnet` and its public RPC
   is unconfirmed.
2. **Never fabricate output.** Every result must come from a real RPC call. If a
   capability is unavailable, degrade and label it — do not fake it.
3. **Report verified facts, not verdicts.** "admin slot = 0x…", "would revert:
   <reason>", "cause undetermined" — never a green "SAFE" badge.
4. Default mainnet RPC `https://rpc.pharos.xyz` is confirmed to expose
   `debug_traceCall` / `debug_traceTransaction` with `callTracer`. Pharos returns
   top-level reverts in `debug_traceCall` as JSON-RPC error code 3 with revert
   data in `error.data` (handled in `scripts/simulate.ts`).
