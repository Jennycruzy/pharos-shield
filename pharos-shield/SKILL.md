---
name: pharos-shield
description: >-
  Transaction & contract integrity layer for Pharos mainnet (chain 1672). Use
  when a user wants to (a) SIMULATE / dry-run / pre-flight a Pharos transaction
	  before signing to see if it will revert, what ERC-compatible call intents
	  appear, and whether calldata requests an UNLIMITED approval; (b) AUTOPSY /
	  debug / diagnose why a Pharos
  transaction FAILED or reverted (and what token movements it made or attempted),
  given its tx hash; or (c) INSPECT a Pharos address to tell whether it is a
  contract or EOA, whether it is a proxy (EIP-1967), and its
  implementation/admin/upgrade authority. Triggers include "will this tx work",
  "why did my tx fail/revert", "simulate this call", "what tokens does this move",
  "is this an unlimited approval", "is this address a proxy", "who owns/can
  upgrade this contract", "can this contract self-destruct", "what token is this",
  "what does this transaction do". Reports only on-chain-verified
	  facts (decoded reverts, receipt-log transfers/approvals, call intents, proxy
	  slots); never a
  SAFE/UNSAFE verdict or token risk score. NOT a token rug/honeypot scanner.
---

# Pharos Shield

Pharos Shield verifies **transactions and contracts** on **Pharos mainnet
(Pacific Ocean, chain ID 1672)** — the default and the network every example
here is run on. It answers two questions honestly, from on-chain facts only:

- *Will this transaction do what I expect / why did it fail?*
- *What is this contract and who controls it?*

It is **not** a token threat-scorer or rug detector. It operates at the
transaction-execution and contract-control layer.

## When to use

Invoke this skill when the user asks to:

| Intent | Command |
| --- | --- |
| Dry-run / pre-flight a tx before signing | `simulate` |
| Diagnose a failed / reverted tx | `autopsy` |
| Classify an address; detect proxy/admin/upgrade authority | `inspect` |

## How it works (honest scope)

- **All commands** validate live `eth_chainId` (mainnet `1672` by default),
  verify the known mainnet genesis hash, reject stale latest blocks, and pin
  state reads to one block hash.
- **simulate** runs `debug_traceCall` at the pinned block and reports whether the
  call would revert (with the decoded reason), the would-be call tree, native
	  PROS value intents, and selector-derived **ERC-compatible call intents** —
	  flagging
  **UNLIMITED** approvals (`max uint256` / `setApprovalForAll`) before you sign.
  It **never sends a transaction**.
- **autopsy** pulls the tx + receipt; if it succeeded it says so (and decodes the
  real `Transfer`/`Approval` events that occurred). For a failure it traces with
  `callTracer`, follows the root-propagated revert path, separates caught
  errors, and decodes the revert
  (`Error(string)` / `Panic(uint256)` / custom selector), reports the *attempted*
  token movements, and gives a trace-supported probable cause — or "cause
  undetermined" when the data does not support a confident answer.
- **Signature resolution** — `simulate` and `autopsy` resolve raw 4-byte
  function and custom-error selectors against the **openchain.xyz** signature
  database (selectors are chain-agnostic, so this works on Pharos). A named
  custom error is applied **only when its arguments actually decode** against
	  the revert payload with no trailing bytes, so a coincidental selector collision
  `0x00000000`) never mislabels a revert. Sourcify is intentionally not used —
  it does not index chain 1672 (verified at build time), so no verified ABI is
  ever claimed.
- Successful transaction receipt logs are reported as actual activity. Trace
  selectors are reported only as **ERC-compatible call intents**, never as
  completed or proven token movements. Metadata reads are block-pinned.
- **inspect** uses `eth_getCode` to classify contract vs EOA, reads the three
	  EIP-1967 storage slots (+ legacy OZ slot), and builds a control graph with
	  implementation code hashes, admin/beacon kinds, reported owners, Safe-style
	  thresholds, timelock delays, and UUPS UUID compatibility. It also adds
  signals: EIP-1167 minimal-proxy detection, beacon `implementation()`
  resolution, PUSH-aware bytecode scan (`DELEGATECALL`/`SELFDESTRUCT`/`CREATE2`),
  and live `eth_call` reads of `owner()`/`paused()`, token name/symbol/decimals,
  and ERC-165 interfaces — each reported only when the chain answers. It does
  **not** claim "verified source" (Pharos's explorer exposes no public
  source-verification API — confirmed at build time).

All three share one trace/RPC core. The default mainnet RPC
(`https://rpc.pharos.xyz`) was verified to expose the `debug_*` trace namespace
	with `callTracer`. `probe` tests both trace methods independently, including a
	real mainnet transaction. If a configured RPC lacks tracing, commands degrade to
receipt/revert-reason level and say so.

## Running the commands

Two equivalent paths — pick whichever is available:

- **MCP tools (preferred for natural language).** If the `shield_inspect`,
  `shield_autopsy`, `shield_simulate`, and `shield_probe` tools are present (the
  MCP server is registered), just call the one that matches the user's intent —
  no shell needed. Route by the "When to use" table above.
- **CLI.** Otherwise run the commands from this skill's directory (after a
  one-time `npm install`):

```bash
# from the pharos-shield/ directory, after `npm install`
npm run cli -- inspect  <address>
npm run cli -- autopsy  <txhash>
npm run cli -- simulate --from <addr> --to <addr> [--data 0x..] [--value 1.0]
npm run cli -- probe          # show network + live trace capability
# add --json for machine-readable output; --network testnet to switch (secondary)
```

Real verified mainnet examples and exact outputs are in the repository
[`README.md`](../README.md) (repo root).

## Scripts

- `scripts/config.ts` — networks, verified RPC URLs, EIP-1967 slots
- `scripts/rpc.ts` — provider + live trace-capability probe + typed errors
- `scripts/trace.ts` — callTracer core (`debug_traceCall` / `debug_traceTransaction`)
- `scripts/decode.ts` — revert + calldata decoding (Error/Panic/custom)
- `scripts/signatures.ts` — openchain signature-DB lookup + decode-confirmed naming
- `scripts/simulate.ts`, `scripts/autopsy.ts`, `scripts/inspect.ts` — the commands
- `scripts/cli.ts` — CLI entrypoint
- `mcp/server.ts` — same core exposed as MCP tools (stdio + HTTP)

## Honesty policy

Shield reports facts it verified ("no EIP-1967 proxy detected; admin slot =
0x…; simulation would revert: INSUFFICIENT_OUTPUT_AMOUNT"). It never emits an
unverifiable green "SAFE" badge. Over-claiming safety is worse than no tool.
