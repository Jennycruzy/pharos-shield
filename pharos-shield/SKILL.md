---
name: pharos-shield
description: >-
  Transaction and contract integrity for Pharos mainnet (chain 1672). Use to:
  GUARD or pre-flight a transaction before signing; SIMULATE or dry-run a call; AUTOPSY or
  diagnose a failed/reverted transaction hash; or INSPECT an address as an EOA,
  contract, proxy, and observable control graph. Trigger for "will this tx
  work", "why did my tx fail", "simulate this call", "what does this transaction
  do", "is this an unlimited approval", "is this address a proxy", "who owns or
  can upgrade this contract", and similar Pharos execution/control questions.
  Reports actual activity only from receipt logs or state facts; selector matches
  are ERC-compatible call intents, not movements. Validates chain identity,
  genesis and freshness, pins reads to one block hash, distinguishes propagated
  from caught reverts, and inspects EIP-1967/UUPS/admin/beacon/owner/multisig/
  timelock signals. Never sends a transaction or emits SAFE/UNSAFE or rug scores.
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
| Check a transaction before signing | `guard` |
| Dry-run a call without target inspection | `simulate` |
| Diagnose a failed / reverted tx | `autopsy` |
| Classify an address; detect proxy/admin/upgrade authority | `inspect` |

## How it works (honest scope)

- **All commands** validate live `eth_chainId` (mainnet `1672` by default),
  verify the known mainnet genesis hash, reject stale/divergent RPCs, use a
  confirmation-depth checkpoint, pin state reads to its hash, and recheck it
  after analysis. Independent quorum is enabled with
  `PHAROS_RPC_QUORUM_URLS`; one endpoint is labeled `single-endpoint`.
- **simulate** runs `debug_traceCall` at the pinned block and reports whether the
  call would revert (with the decoded reason), the would-be call tree, native
  PROS value intents, and selector-derived **ERC-compatible call intents** —
  flagging
  **UNLIMITED** approvals (`max uint256` / `setApprovalForAll`) before you sign.
  It **never sends a transaction**.
- **guard** composes the same `inspect` and `simulate` cores into one report and
  emits stable fact flags. CLI exit codes are `0` for no flags, `2` when flags
  are present, and `1` when Shield cannot complete.
- **autopsy** pulls the tx + receipt; if it succeeded it says so (and decodes the
  real `Transfer`/`Approval` events that occurred). For a failure it traces with
  `callTracer`, follows the root-propagated revert path, separates caught
  errors, decodes the revert (`Error(string)` / `Panic(uint256)` / custom
  selector), reports ERC-compatible call intents without claiming movements,
  and gives a trace-supported probable cause — or "cause undetermined" when the
  data does not support a confident answer.
- **Signature resolution** — `simulate` and `autopsy` resolve raw 4-byte
  function and custom-error selectors against the **openchain.xyz** signature
  database (selectors are chain-agnostic, so this works on Pharos). A named
  custom error is applied **only when its arguments actually decode** against
  the revert payload with no trailing bytes, so a coincidental selector collision
  (`0x00000000`) never mislabels a revert. Sourcify is intentionally not used —
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

All four share one trace/RPC core. The default mainnet RPC
(`https://rpc.pharos.xyz`) was verified to expose the `debug_*` trace namespace
with `callTracer`. `probe` tests both trace methods independently, including a
real mainnet transaction. If a configured RPC lacks tracing, commands degrade to
receipt/revert-reason level and say so.

- **Signed evidence** is opt-in via CLI `--evidence <file>` or MCP
  `includeEvidence: true`. It requires a separate
  `PHAROS_EVIDENCE_SIGNING_KEY` and emits a canonical JSON bundle containing the
  complete result, block/quorum/finality metadata, contract code hashes, result
  hash, signer and EIP-191 signature. Never reuse a wallet transaction key.

## Running the commands

Two equivalent paths — pick whichever is available:

- **MCP tools (preferred for natural language).** If the `shield_inspect`,
  `shield_guard`, `shield_autopsy`, `shield_simulate`, and `shield_probe` tools are present (the
  MCP server is registered), just call the one that matches the user's intent —
  no shell needed. Route by the "When to use" table above.
- **CLI.** Otherwise run the commands from this skill's directory (after a
  one-time `npm install`):

```bash
# from the pharos-shield/ directory, after `npm install`
npm run cli -- inspect  <address>
npm run cli -- autopsy  <txhash>
npm run cli -- guard --from <addr> --to <addr> [--data 0x..] [--value 1.0]
npm run cli -- simulate --from <addr> --to <addr> [--data 0x..] [--value 1.0]
npm run cli -- probe          # show network + live trace capability
npm run cli -- verify-evidence evidence.json
# add --json for machine-readable output; --network testnet to switch (secondary)
```

Real verified mainnet examples and exact outputs are in the repository
[`README.md`](../README.md) (repo root).

## Scripts

- `scripts/config.ts` — networks, verified RPC URLs, EIP-1967 slots
- `scripts/rpc.ts` — provider + quorum/finality/reorg checks + trace probe
- `scripts/evidence.ts` — canonical result/code hashes + evidence signatures
- `scripts/trace.ts` — callTracer core (`debug_traceCall` / `debug_traceTransaction`)
- `scripts/decode.ts` — revert + calldata decoding (Error/Panic/custom)
- `scripts/signatures.ts` — openchain signature-DB lookup + decode-confirmed naming
- `scripts/guard.ts`, `scripts/simulate.ts`, `scripts/autopsy.ts`,
  `scripts/inspect.ts` — the commands
- `scripts/cli.ts` — CLI entrypoint
- `mcp/server.ts` — same core exposed as MCP tools (stdio + HTTP)

## Honesty policy

Shield reports facts it verified ("no EIP-1967 proxy detected; admin slot =
0x…; simulation would revert: INSUFFICIENT_OUTPUT_AMOUNT"). It never emits an
unverifiable green "SAFE" badge. Over-claiming safety is worse than no tool.
