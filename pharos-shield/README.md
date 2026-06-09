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

## The three commands

### `simulate` — PRE-FLIGHT

Dry-runs a call with `debug_traceCall` at the latest block and reports whether
it would revert (with the decoded reason), the would-be call tree, and native
PROS movements. **It never sends a transaction.**

### `autopsy <txhash>` — POST-FAILURE

Pulls the tx + receipt. If it succeeded, says so. For a failure it traces with
`callTracer`, descends to the deepest reverting call, decodes the revert, and
states a trace-supported probable cause (or "cause undetermined").

### `inspect <address>` — CONTROL STRUCTURE

Classifies contract vs EOA (`eth_getCode`), reads the three EIP-1967 storage
slots (+ legacy OZ slot), and reports proxy / implementation / admin facts.
Reports only what storage proves.

---

## Install

```bash
git clone <this repo> && cd pharos-shield
npm install
cp .env.example .env      # optional; defaults target mainnet
npm run cli -- probe      # sanity-check network + live trace capability
```

As an Agent Skill (SKILL.md), copy the `pharos-shield/` directory into your
agent's skills folder, e.g.:

```bash
cp -r pharos-shield ~/.claude/skills/pharos-shield      # Claude
cp -r pharos-shield ~/.codex/skills/pharos-shield       # Codex
# or:  npx skills add <path-or-repo>
```

`SKILL.md`, `AGENTS.md`, and `CLAUDE.md` ship in the directory for cross-agent
discovery.

---

## Real verified examples (Pharos mainnet, chain 1672)

All outputs below were produced by this code against `https://rpc.pharos.xyz`.

### `probe` — confirm trace support is live

```text
$ npm run cli -- probe
Network:  mainnet (chain 1672)
RPC:      https://rpc.pharos.xyz
Trace:    traceCall=true traceTransaction=true
Note:     debug_traceCall(callTracer) responded; trace namespace is enabled.
```

### `autopsy` — a real failed transaction (decoded `Error(string)`)

Tx `0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff`:

```text
$ npm run cli -- autopsy 0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff
Autopsy (mainnet)  tx 0xdeeb262fad28864a8e031db91e99de0bb4bd42aff936876d577adcddcf0de3ff
Status:    failed (call-tree traced)
From:      0x7Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C
To:        0x69Dc8E2d95C3281a643810FB5624b26Da8610DA4
Block:     9740066
Gas used:  54908
Calls:     2 frame(s)
Failing:   0x7ac6d25fd5e437cb7c57aee77ac2d0a6cb85936c -> 0x69dc8e2d95c3281a643810fb5624b26da8610da4 [0xc5918880] error=execute_revert
Revert:    BC
Cause:     contract reverted with: "BC"
Notes:
  - Failing call at depth 0: 0x7ac6d25... -> 0x69dc8e2d... [0xc5918880] error=execute_revert.
```

The contract reverted with the short `Error(string)` message `"BC"`. Shield
reports it verbatim — it does not invent a friendlier explanation it cannot
prove.

### `autopsy` — a real failed transaction (non-standard revert payload)

Tx `0x3697e90417e7b9d4b7b5c2b32533583f9150d29853b2ff9a58db3db6e11cd22b`:

```text
$ npm run cli -- autopsy 0x3697e90417e7b9d4b7b5c2b32533583f9150d29853b2ff9a58db3db6e11cd22b
Status:    failed (call-tree traced)
Failing:   0xa4971a92... -> 0x7765b930... [0x00000000] error=execute_revert
Revert:    custom error with selector 0x00000000 (no ABI available to decode its name)
Cause:     custom error 0x00000000 — undecodable without the contract ABI; cause undetermined
```

The revert data isn't a standard `Error`/`Panic` encoding, so Shield reports the
raw selector and says **cause undetermined** rather than guessing.

### `autopsy` — a transaction that did NOT fail

Tx `0xeae13982de30f5386625446d0c15218d5889c004391ff012afd33be7d4080c79`:

```text
$ npm run cli -- autopsy 0xeae13982de30f5386625446d0c15218d5889c004391ff012afd33be7d4080c79
Status:    success
Cause:     transaction did NOT fail — it succeeded on chain.
Notes:
  - Receipt status = 1 (success). Nothing to diagnose.
```

### `inspect` — a real EIP-1967 proxy

Address `0x3c2269811836af69497E5F486A85D7316753cf62`:

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

### `inspect` — a plain EOA and a non-proxy contract

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

### `simulate` — a call that would succeed, and one that would revert

```text
# balanceOf — would succeed:
$ npm run cli -- simulate --from 0x7Ac6d25FD5E437cB7c57Aee77aC2d0A6Cb85936C \
    --to 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 \
    --data 0x70a08231000000000000000000000000<addr>
Outcome:   would succeed
Calls:     1 frame(s)
Call tree:
  CALL -> 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 [balanceOf(address)]

# transfer of more than the balance — would revert (no reason string):
$ npm run cli -- simulate --from 0x7Ac6d25... --to 0x52c48d... --data 0xa9059cbb...
Outcome:   WOULD REVERT
Revert:    reverted with no return data (e.g. require without message, or a low-level revert)
Notes:
  - Pharos reported the revert as an RPC error (no call tree returned for top-level reverts).
```

---

## MCP server (same core, callable by any agent)

The three commands are also exposed as MCP tools so any MCP-compatible agent can
call Shield natively. The MCP layer is a **thin adapter** over the exact same
`scripts/` core — no logic is reimplemented.

Tools: `shield_inspect`, `shield_autopsy`, `shield_simulate`, `shield_probe`.

```bash
# stdio transport (for editors / desktop agents):
npm run mcp

# Streamable HTTP transport:
npm run mcp:http        # listens on http://127.0.0.1:8731/mcp
#   override port:  node --import tsx mcp/server.ts --http --port 9000
```

Example MCP client config (stdio):

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
→ tools/call returns real on-chain data).

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

### What `inspect` can and cannot prove

- **Can prove (from storage):** contract vs EOA, EIP-1967 implementation, admin,
  and beacon slots, legacy OZ implementation slot, and therefore whether the
  address is a proxy and which address the admin slot names.
- **Cannot prove (no source API):** verified source code, the human-readable
  owner of an admin, or upgrade logic gated inside the implementation (UUPS).
  These are stated as **inferred**, never as verified source.

### Graceful degradation

If a configured RPC lacks the `debug_*` namespace, `autopsy` falls back to
receipt + revert-reason level (via a historical `eth_call`) and labels the
result **degraded**. `simulate` requires `debug_traceCall`; if it is absent the
command reports that honestly rather than faking a trace.

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
