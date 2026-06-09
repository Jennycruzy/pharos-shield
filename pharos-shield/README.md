# Pharos Shield

**A transaction-and-contract integrity layer for Pharos.** Three composable
commands — `simulate`, `autopsy`, `inspect` — that answer:

> *Will this transaction do what I expect, or why did it fail?*
> *What is this contract, and who controls it?*

Pharos Shield operates at the **transaction-execution and contract-control
layer**. It is **not** a token rug/honeypot/tax scanner — that is a different
problem. Shield verifies what a transaction *does* and what a contract *is*,
from on-chain facts only.

> **Honesty first.** Shield reports facts it verified ("no EIP-1967 proxy
> detected; admin slot = 0x…; simulation would revert: INSUFFICIENT_OUTPUT").
> It never shows an unverifiable green "SAFE" badge. Over-claiming safety is
> worse than no tool.

- **Network:** Pharos mainnet (Pacific Ocean), **chain ID 1672** — the default
  and the network of **every example and output below**. Testnet (688688) is a
  secondary toggle only.
- **No mocks anywhere.** Every example in this README is a real mainnet RPC call
  against a real contract/transaction. The hashes and addresses are live.

---

## Contents

1. [Why Shield exists](#why-shield-exists)
2. [Which command do I want?](#which-command-do-i-want)
3. [Install & quick start](#install--quick-start)
4. [`inspect` — control structure](#inspect--control-structure)
5. [`autopsy` — post-failure forensics](#autopsy--post-failure-forensics)
6. [`simulate` — pre-flight dry-run](#simulate--pre-flight-dry-run)
7. [`probe` — capability check](#probe--capability-check)
8. [Composable workflows](#composable-workflows)
9. [Using Shield from an AI agent (MCP)](#using-shield-from-an-ai-agent-mcp)
10. [Output reference (JSON fields)](#output-reference-json-fields)
11. [Building calldata for `simulate`](#building-calldata-for-simulate)
12. [Verified-vs-degraded status](#verified-vs-degraded-status)
13. [Troubleshooting](#troubleshooting)
14. [Configuration, safety policy, dependencies](#network-configuration)

---

## Why Shield exists

On a fast L1, the two most expensive moments are **right before you sign** and
**right after something failed**. Block explorers tell you a transaction
reverted; they rarely tell you *which inner call* reverted or *why* in a way you
can act on. And before you interact with a contract, you usually have no idea
whether it is a proxy whose logic can be swapped out from under you.

Shield closes those three gaps with on-chain primitives that Pharos exposes
(`debug_traceCall`, `debug_traceTransaction` with `callTracer`,
`eth_getStorageAt`, `eth_getCode`):

| Moment | Question | Command |
| --- | --- | --- |
| Before signing | "Will this revert? What will it move?" | `simulate` |
| After a failure | "Why did this fail, and where?" | `autopsy` |
| Before trusting a contract | "Is this a proxy? Who can upgrade it?" | `inspect` |

Everything it returns is a **fact it verified**, never a safety score.

---

## Which command do I want?

Map your phrasing to a command (this is also how an AI agent should route):

| If you're asking… | Use | Input you need |
| --- | --- | --- |
| "Will this transaction work / revert?" | `simulate` | `from`, `to`, `data` |
| "What would this call actually do before I sign?" | `simulate` | `from`, `to`, `data`, `value` |
| "Why did my transaction fail?" | `autopsy` | a tx hash |
| "Did this tx actually fail, or did it succeed?" | `autopsy` | a tx hash |
| "Which inner call reverted in this complex tx?" | `autopsy` | a tx hash |
| "Is this address a contract or just a wallet?" | `inspect` | an address |
| "Is this contract a proxy? What's the implementation?" | `inspect` | an address |
| "Who can upgrade this contract?" | `inspect` | an address |

---

## Install & quick start

```bash
git clone https://github.com/Jennycruzy/pharos-shield-skill
cd pharos-shield-skill/pharos-shield
npm install
cp .env.example .env          # optional; defaults already target mainnet
npm run cli -- probe          # confirm network + live trace capability
```

Three commands, one line each:

```bash
npm run cli -- inspect  0x3c2269811836af69497e5f486a85d7316753cf62
npm run cli -- autopsy  0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff
npm run cli -- simulate --from 0xYou --to 0xContract --data 0x70a08231...
```

Global flags:

| Flag | Effect |
| --- | --- |
| `--json` | Emit machine-readable JSON instead of formatted text |
| `--network mainnet\|testnet` | Override `PHAROS_NETWORK` for this one run |

As an **Agent Skill**, copy the directory into your agent's skills folder:

```bash
cp -r pharos-shield ~/.claude/skills/pharos-shield      # Claude
cp -r pharos-shield ~/.codex/skills/pharos-shield       # Codex
# or:  npx skills add <path-or-repo>
```

`SKILL.md`, `AGENTS.md`, and `CLAUDE.md` ship in the directory for cross-agent
discovery. The MCP server (below) covers agents that consume tools rather than
skills.

---

## `inspect` — control structure

**What it does.** Classifies an address as contract or EOA (`eth_getCode`),
then reads the three EIP-1967 storage slots (implementation / admin / beacon)
plus the legacy OpenZeppelin slot to determine whether it is a proxy and what
its upgrade authority looks like — purely from storage.

```
pharos-shield inspect <address> [--json]
```

### Use cases

- **Pre-interaction due diligence.** Before approving or swapping against a
  contract, find out if it's an upgradeable proxy. A non-zero admin slot means
  someone can replace the logic you're trusting.
- **Centralization check.** Identify *who* (which address) holds upgrade
  authority via the EIP-1967 admin slot — a key input for risk assessment.
- **Typo / scam guard.** Confirm a "token contract" address actually has
  bytecode. An EOA masquerading as a token (or a mistyped address) shows up as
  `kind: eoa` immediately.
- **Protocol mapping.** Walk a protocol's proxies to chart which implementation
  each one currently points at.

### Real example — an EIP-1967 proxy

```text
$ npm run cli -- inspect 0x3c2269811836af69497e5f486a85d7316753cf62
Address:   0x3c2269811836af69497E5F486A85D7316753cf62  (mainnet)
Kind:      contract (2304 bytes of code)
Proxy:     yes (eip1967)
Impl:      0x4EE2F9B7cf3A68966c370F3eb2C16613d3235245
Admin:     0x9740FF91F1985D8d2B71494aE1A2f723bb3Ed9E4
Upgrade:   inferred from the EIP-1967 admin slot: 0x9740FF91F1985D8d2B71494aE1A2f723bb3Ed9E4
           can upgrade this proxy. (Inferred from storage, NOT from verified source.)
Facts:
  - EIP-1967 implementation slot is non-zero -> proxy. Implementation = 0x4EE2F9B7...
  - EIP-1967 admin slot = 0x9740FF91... (controls upgrades).
```

**How to read it:** this contract delegates all logic to
`0x4EE2F9B7…`, and `0x9740FF91…` is the only address that can repoint it. If
that admin is an EOA, one key controls the contract's behavior.

### Real example — an EOA and a non-proxy contract

```text
$ npm run cli -- inspect 0x7Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C
Kind:      eoa
Facts:
  - eth_getCode returned 0x: no contract deployed at this address.

$ npm run cli -- inspect 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0
Kind:      contract (3249 bytes of code)
Proxy:     no
Upgrade:   no proxy slots set — no upgrade mechanism provable from storage.
```

### What it can and cannot prove

- **Can prove (from storage):** contract vs EOA; EIP-1967 implementation, admin,
  and beacon slots; legacy OZ implementation slot; therefore whether it's a
  proxy and which address the admin slot names.
- **Cannot prove (no public source API on Pharos):** verified source code, the
  human owner behind an admin address, or UUPS upgrade logic gated inside the
  implementation. These are reported as **inferred**, never as verified source.

---

## `autopsy` — post-failure forensics

**What it does.** Pulls the transaction and receipt. If it succeeded, it says so
plainly. If it failed, it traces the tx with `callTracer`, descends to the
**deepest reverting call** (the true origin — parents just propagate the error),
decodes the revert payload, and states a trace-supported probable cause.

```
pharos-shield autopsy <txhash> [--json]
```

### Use cases

- **"Why did my swap/transfer fail?"** Get the actual revert string instead of a
  generic "failed" badge.
- **Triage by category.** Shield maps decoded reverts to honest causes —
  allowance/approval, insufficient balance, slippage/minOut, paused/frozen,
  deadline expired, arithmetic panic, out-of-gas — *only when the revert text
  supports it*. Otherwise it says **cause undetermined** rather than guess.
- **Locate the failing hop in a multi-call tx.** Router → pair → token chains
  fail several layers deep; autopsy names the exact `from → to [selector]` frame
  that reverted.
- **Bot / automation post-mortems.** Feed a failed tx hash straight into the
  pipeline (`--json`) and branch on `revert.kind` or `probableCause`.

### Real example — decoded `Error(string)`

```text
$ npm run cli -- autopsy 0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff
Autopsy (mainnet)  tx 0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff
Status:    failed (call-tree traced)
From:      0x7Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C
To:        0x69Dc8E2d95C3281a643810FB5624b26Da8610DA4
Block:     9740066
Gas used:  54908
Calls:     2 frame(s)
Failing:   0x7ac6d25f... -> 0x69dc8e2d... [0xc5918880] error=execute_revert
Revert:    BC
Cause:     contract reverted with: "BC"
```

The contract reverted with the short `Error(string)` message `"BC"`. Shield
reports it verbatim — it does not dress it up as a friendlier explanation it
cannot prove.

### Real example — non-standard revert payload

```text
$ npm run cli -- autopsy 0x3697e90417e7b9d4b7b5c2b32533583f9150d29853b2ff9a58db3db6e11cd22b
Status:    failed (call-tree traced)
Failing:   0xa4971a92... -> 0x7765b930... [0x00000000] error=execute_revert
Revert:    custom error with selector 0x00000000 (no ABI available to decode its name)
Cause:     custom error 0x00000000 — undecodable without the contract ABI; cause undetermined
```

The revert data isn't a standard `Error`/`Panic` encoding, so Shield surfaces
the raw selector and says **cause undetermined** instead of inventing a reason.

### Real example — a transaction that did NOT fail

```text
$ npm run cli -- autopsy 0xeae13982de30f5386625446d0c15218d5889c004391ff012afd33be7d4080c79
Status:    success
Cause:     transaction did NOT fail — it succeeded on chain.
Notes:
  - Receipt status = 1 (success). Nothing to diagnose.
```

### Cause mapping (how honest it is)

`probableCause` is only a category when the **decoded revert string** matches a
known pattern (e.g. contains `allowance`, `INSUFFICIENT_OUTPUT_AMOUNT`,
`paused`, a `Panic(0x11)` overflow). For a clear-but-unmapped message it echoes
the message verbatim; for empty/custom/undecodable data it returns *cause
undetermined*. It never asserts a cause the trace doesn't support.

---

## `simulate` — pre-flight dry-run

**What it does.** Builds a call object and runs `debug_traceCall` at the latest
block. It reports whether the call **would revert** (with the decoded reason),
the would-be **call tree**, and any **native PROS movements** derivable from the
trace. **It never sends a transaction.**

```
pharos-shield simulate --from <addr> [--to <addr>] [--data 0x..] [--value 1.0] [--gas N] [--json]
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--from` | ✅ | Sender. Pharos requires it for `debug_traceCall`. |
| `--to` | — | Target. Omit for a contract-creation simulation. |
| `--data` | — | Calldata hex (default `0x`). |
| `--value` | — | PROS to attach: decimal (`1.5`) or hex wei (`0x…`). |
| `--gas` | — | Gas limit: decimal or hex. |

### Use cases

- **Pre-sign safety on a swap.** Simulate the exact router call; if it would
  revert on `INSUFFICIENT_OUTPUT_AMOUNT`, you learn it for free instead of
  burning gas.
- **Verify an `approve` + `transferFrom` flow** behaves before submitting.
- **Confirm a withdrawal/claim isn't blocked** by a paused or frozen state in
  current chain conditions.
- **Read-only contract probing.** Simulate a `view`/`pure` call (`balanceOf`,
  `totalSupply`) to confirm a contract responds as expected.
- **Wallet / dApp "transaction preview".** Wire `--json` output into a UI to
  show users what a tx will do before they sign.

### Real example — would succeed

```text
$ npm run cli -- simulate \
    --from 0x7Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C \
    --to   0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 \
    --data 0x70a082310000000000000000000000007Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C
Outcome:   would succeed
Calls:     1 frame(s)
Call tree:
  CALL -> 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 [balanceOf(address)]
Notes:
  - SIMULATION ONLY — no transaction was sent. Result reflects current latest-block state.
  - Would SUCCEED at the latest block (no top-level revert in the trace).
  - No non-zero native (PROS) movements in the trace.
```

### Real example — would revert

```text
$ npm run cli -- simulate --from 0x7Ac6d25... --to 0x52c48d... \
    --data 0xa9059cbb...   # transfer more than the balance
Outcome:   WOULD REVERT
Revert:    reverted with no return data (e.g. require without message, or a low-level revert)
Notes:
  - Would REVERT at the top level: reverted with no return data ...
  - Pharos reported the revert as an RPC error (no call tree returned for top-level reverts).
```

> **Pharos quirk (handled):** when the *top-level* call reverts, `debug_traceCall`
> returns a JSON-RPC error (code 3) with the revert payload in `error.data`
> rather than a trace frame. Shield catches this and presents it as a clean,
> decoded "would revert" outcome. Reverts in *inner* calls that the top frame
> catches still come back as a normal traced tree.

---

## `probe` — capability check

Reports the active network, RPC URL, and a **live** check of whether the
`debug_*` trace namespace is enabled. Run it first when pointing Shield at a new
RPC.

```text
$ npm run cli -- probe
Network:  mainnet (chain 1672)
RPC:      https://rpc.pharos.xyz
Trace:    traceCall=true traceTransaction=true
Note:     debug_traceCall(callTracer) responded; trace namespace is enabled.
```

---

## Composable workflows

The three commands share one core and chain naturally:

**1. Failure → control structure.** A tx failed at a contract you don't
recognize. Autopsy it, then inspect the failing `to` address to see if it's a
proxy whose implementation explains the behavior:

```bash
npm run cli -- autopsy 0x<failed-tx>          # -> Failing: ... -> 0xCONTRACT [selector]
npm run cli -- inspect 0xCONTRACT             # -> proxy? impl? admin?
```

**2. Pre-sign → diagnose.** Simulate a call; if it would revert, you already
have the decoded reason. If you sent it anyway and it failed, autopsy confirms
the same cause from the mined tx.

**3. Due diligence → preview.** Inspect a contract to learn it's an upgradeable
proxy, then simulate your intended call against it to see current behavior
before committing.

**Scripting it (`--json`).** Every command supports `--json`; pipe into `jq`:

```bash
# Is the failing address a proxy?
TX=0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff
TO=$(npm run -s cli -- autopsy "$TX" --json | jq -r '.failingCall.to')
npm run -s cli -- inspect "$TO" --json | jq '{kind, proxy}'
```

---

## Using Shield from an AI agent (MCP)

The same core is exposed as MCP tools so any MCP-compatible agent can call Shield
natively. The MCP layer is a **thin adapter** over the exact `scripts/` core —
no logic is reimplemented.

| MCP tool | Arguments | Returns |
| --- | --- | --- |
| `shield_inspect` | `{ address }` | inspect result (JSON) |
| `shield_autopsy` | `{ txhash }` | autopsy result (JSON) |
| `shield_simulate` | `{ from, to?, data?, value?, gas? }` | simulate result (JSON) |
| `shield_probe` | `{}` | network + live trace capability |

Run it:

```bash
npm run mcp            # stdio transport (editors / desktop agents)
npm run mcp:http       # Streamable HTTP on http://127.0.0.1:8731/mcp
#   custom port:  node --import tsx mcp/server.ts --http --port 9000
```

Example stdio client config:

```json
{
  "mcpServers": {
    "pharos-shield": {
      "command": "node",
      "args": ["--import", "tsx", "/abs/path/pharos-shield/mcp/server.ts"],
      "env": { "PHAROS_NETWORK": "mainnet" }
    }
  }
}
```

Both transports were tested end-to-end against mainnet (initialize → tools/list
→ tools/call returns real on-chain data). An agent should route user intent to a
tool using the [decision table above](#which-command-do-i-want), then read the
JSON fields described next.

---

## Output reference (JSON fields)

Use `--json` for these shapes (text mode is a formatted view of the same data).

### `inspect`

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"contract"` \| `"eoa"` | bytecode present or not |
| `codeSize` | number | deployed bytecode size in bytes (0 for EOA) |
| `proxy.isProxy` | boolean | any proxy slot set |
| `proxy.standard` | `eip1967` \| `eip1967-beacon` \| `legacy-oz` \| `none` | detected pattern |
| `proxy.implementation` | address? | current logic contract |
| `proxy.admin` | address? | EIP-1967 admin (upgrade authority) |
| `proxy.beacon` | address? | beacon contract (beacon proxies) |
| `upgradeAuthority` | string | inferred-from-storage description |
| `notes` | string[] | the facts behind the verdict |

### `autopsy`

| Field | Type | Meaning |
| --- | --- | --- |
| `found` | boolean | tx exists on this network |
| `status` | `success` \| `failed` \| `unknown` | receipt status |
| `traced` | boolean | results came from a real call-tree trace |
| `failingCall` | object? | `{ from, to, selector, value, error, depthPath }` |
| `revert.kind` | `Error` \| `Panic` \| `custom` \| `empty` \| `raw` | revert encoding |
| `revert.reason` | string | decoded reason or faithful description |
| `revert.selector` | string? | 4-byte selector of the revert payload |
| `probableCause` | string | trace-supported cause or "cause undetermined" |

### `simulate`

| Field | Type | Meaning |
| --- | --- | --- |
| `isSimulation` | `true` | always — Shield never sends |
| `willRevert` | boolean | top-level revert in the trace |
| `revert` | object? | decoded revert (same shape as autopsy) |
| `calls` | array | flattened call tree: `{ type, from, to, selector, value, errored, depth }` |
| `nativeMovements` | array | `{ from, to, pros }` non-zero native transfers |
| `callCount` | number | frames in the tree |

---

## Building calldata for `simulate`

`--data` is raw calldata. The quickest way to build it is ethers:

```bash
node -e '
const { Interface } = require("ethers");
const i = new Interface(["function transfer(address,uint256)"]);
console.log(i.encodeFunctionData("transfer", [
  "0x7Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C",
  1000000000000000000n
]));
'
# 0xa9059cbb...  -> pass to:  simulate --from 0x.. --to 0xToken --data 0xa9059cbb...
```

Common read selectors you can paste directly: `balanceOf(address)` =
`0x70a08231` + 32-byte-padded address; `totalSupply()` = `0x18160ddd`;
`decimals()` = `0x313ce567`.

---

## Verified-vs-degraded status

Everything here was probed against live Pharos mainnet on 2026-06-09.

| Capability | Status | Evidence |
| --- | --- | --- |
| Mainnet RPC `https://rpc.pharos.xyz` | **Confirmed** | `eth_chainId` → `0x688` (1672) |
| `debug_traceTransaction` (callTracer) | **Confirmed** | Returns a call frame for real failed txs (see autopsy examples) |
| `debug_traceCall` (callTracer) | **Confirmed** | Returns a frame; requires a `from` field |
| `eth_getCode` / `eth_getStorageAt` | **Confirmed** | EIP-1967 slot reads verified against real proxies |
| Top-level revert behavior | **Confirmed quirk** | `debug_traceCall` returns JSON-RPC error code 3 with revert data in `error.data` (handled) |
| Explorer source-verification API | **Not available** | `pharosscan.xyz` sits behind a bot wall and exposes no Etherscan/Blockscout-style source API. `inspect` is therefore scoped to storage-provable facts; it does **not** claim "verified source". |
| Testnet (688688) public RPC | **Unconfirmed** | No public trace-enabled testnet RPC reachable from a clean environment at build time. Override with `PHAROS_TESTNET_RPC`. |
| Pharos Agent Center / Anvita Flow MCP ingestion | **Unconfirmed** | The hackathon portal could not be inspected programmatically. Shield ships **both** a SKILL.md directory and an MCP server so it works regardless of which the Agent Center ingests. |

### Graceful degradation

If a configured RPC lacks the `debug_*` namespace, `autopsy` falls back to
receipt + revert-reason level (via a historical `eth_call`) and labels the
result **degraded**. `simulate` requires `debug_traceCall`; if it is absent the
command reports that honestly rather than faking a trace.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `probe` shows `traceCall=false` | RPC has `debug_*` disabled | Point `PHAROS_MAINNET_RPC` at a trace-enabled endpoint |
| `autopsy` says `Status: NOT FOUND` | Wrong network or wrong hash | Check the hash; confirm `PHAROS_NETWORK` matches the tx's chain |
| `autopsy` shows `degraded: no trace available` | Trace namespace unavailable on this RPC | Use a trace-enabled RPC; receipt-level facts are still reported |
| `simulate` errors with `from is needed` | `--from` omitted | Pharos requires a sender for `debug_traceCall`; pass `--from` |
| `inspect` shows `kind: eoa` for a "contract" | Address has no bytecode | Verify the address; it may be a typo or an EOA |
| Revert shows `custom error 0x…` | No ABI to decode the custom error | Expected — Shield reports the raw selector rather than guessing |

---

## Network configuration

| Network | Chain ID | Default RPC | Status |
| --- | --- | --- | --- |
| mainnet (default) | 1672 | `https://rpc.pharos.xyz` | verified |
| testnet | 688688 | `https://testnet.dplabs-internal.com` | unconfirmed (override via env) |

Environment variables (see `.env.example`):

- `PHAROS_NETWORK` — `mainnet` (default) or `testnet`
- `PHAROS_MAINNET_RPC` / `PHAROS_TESTNET_RPC` — override RPC URLs
- `PHAROS_RPC_TIMEOUT_MS` — request timeout (default 20000)

---

## Safety & honesty policy

1. **Facts, not verdicts.** Shield never emits SAFE/UNSAFE. It reports decoded
   reverts, proven proxy/admin slots, and simulation outcomes.
2. **No mocks, ever.** Every output comes from a real RPC call. Unavailable
   capabilities are degraded and labeled, never faked.
3. **Mainnet is the source of truth.** Every example here is mainnet (1672).
4. **Pre-flight is read-only.** `simulate` uses `debug_traceCall`; it never
   broadcasts a transaction.

---

## Dependencies

- [`ethers`](https://www.npmjs.com/package/ethers) v6 — provider, ABI coding,
  address/units helpers.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
  — MCP server (stdio + Streamable HTTP).
- [`zod`](https://www.npmjs.com/package/zod) — MCP tool input schemas.
- TypeScript (`strict: true`, `exactOptionalPropertyTypes`), `tsx` for running.

## Project layout

```
pharos-shield/
├── SKILL.md / AGENTS.md / CLAUDE.md   # agent-discovery manifests
├── README.md
├── package.json / tsconfig.json / .env.example
├── scripts/
│   ├── config.ts     # networks, verified RPC URLs, EIP-1967 slots
│   ├── rpc.ts        # provider + live trace-capability probe + typed errors
│   ├── trace.ts      # callTracer core (traceCall / traceTransaction)
│   ├── decode.ts     # revert + calldata decoding (Error/Panic/custom)
│   ├── simulate.ts   # PRE-FLIGHT
│   ├── autopsy.ts    # POST-FAILURE
│   ├── inspect.ts    # CONTROL STRUCTURE
│   └── cli.ts        # simulate | autopsy | inspect | probe
└── mcp/
    └── server.ts     # same core as MCP tools (stdio + HTTP)
```

## License

MIT
