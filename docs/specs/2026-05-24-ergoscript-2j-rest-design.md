# 2j-rest — REST-based mainnet-validate harness (no shim)

**Date:** 2026-05-24
**Phase:** 2j-rest (replaces and supersedes 2j-a/2j-b shim-based architecture mid-T7)
**Status:** Spec — draft for reviewer pass before implementation.

## 1. Motivation

Phase 2j's mainnet-validate harness has, since 2j-pre, depended on a Rust shim (`tools/mainnet-validate/shim/`) that opens the user's `modifiers.redb` via `enr-store` direct accessors and shells out to sigma-rust internals to assemble per-block `BlockBundle`s. T7's first loop run on 2026-05-23 halted deterministically at h=685 with a `store-race` error traced (per memory [[reference-enr-store-not-contract]] and source-read of `~/projects/ergo-node-rust/`) to an `enr-store` BEST_CHAIN/PRIMARY divergence. Upstream's workaround is parent-link walk in the main crate; the underlying storage divergence is tracked separately and unfixed. Critically: **`enr-store::best_header_at` / `read_header_at` / BEST_CHAIN / PRIMARY are NOT a contract.** They're private implementation detail of the node's storage layer. Consumers reaching into them inherit accumulated divergence with no workaround.

User direction (2026-05-23): pivot the harness to consume the node's public REST surface (`http://localhost:9052`) plus the indexer addon's REST surface (`http://localhost:9054/api/v1`) instead of reaching into `modifiers.redb` directly. This spec captures the resulting architecture.

A coordinated change on the node + indexer side has shipped (`~/projects/ergo-node-rust/prompts/ergots-update-2026-05-24.md`): two new endpoints (`GET /blocks/{headerId}/validation-fragments` on the node, `GET /api/v1/boxes/{box_id}/bytes` on the indexer) that close the gaps in the existing REST surface for this consumer. The node-side per-input `oracleCost` endpoint was attempted but dropped (the node's AVL+ state only retains currently-unspent boxes; by the time a block is finalized its inputs are gone from state). Cost-drift detection therefore moves entirely to the harness side.

The harness becomes a pure-TypeScript single-process binary. One narrow concession: `ergo-lib-wasm-nodejs` (sigma-rust's WASM bindings) is acceptable as a dev-tool dep solely for the cost oracle. The no-WASM rule in [[feedback-pure-typescript-no-wasm]] applies to the published `@ergots/*` library packages (project identity); the harness is dev tooling and is explicitly carved out for this purpose.

**Why WASM-in-harness over a TS port of `reduce_to_crypto`.** The node session's update (`ergots-update-2026-05-24.md` lines 43-53) directs us toward "the harness computes oracleCost client-side via its own TS port of `reduce_to_crypto`." That direction is correct as the long-term path — listed in §11 follow-ups — but is a multi-week port that would block the harness from running at all. WASM-in-harness is the pragmatic v1: same `reduce_to_crypto` semantics (via sigma-rust through WASM), zero new TS code on the oracle path, cost-drift detection preserved end-to-end. The narrow WASM scope (one binding, one number returned) keeps the project-identity boundary intact for everything else.

## 2. Scope

### In scope

- Delete `tools/mainnet-validate/shim/` entirely (Rust crate, all 34 tests).
- Delete the harness's `ShimClient` / `ShimError` / `ShimErrorCode` machinery (~300 LOC of TS).
- Delete `bootstrap-data/` references (`--store-path` / `--sidecar-path` flags retire).
- Add: `NodeClient` + `IndexerClient` TS classes (fetch-based, retry + timeout policy).
- Add: bundle assembler that fetches REST fragments + per-box bytes and assembles the existing `BlockBundle` shape in-memory.
- Add: WASM cost oracle wrapper (`WasmCostOracle`) — narrow TS shim around `ergo-lib-wasm-nodejs` exposing `computeOracleCost(treeBytes, spentBoxBytes, ctxState) → {oracleCost, oracleSucceeded, oracleError}`.
- Modify: `validate-tx.ts` cost-equivalence path reads from the WASM oracle instead of the bundled `InputBundle.oracleCost` field. Halt taxonomy unchanged.
- Modify: `cli.ts` — replace `--store-path` / `--sidecar-path` / `--shim-path` with `--node-url` / `--indexer-url`. `--network`, `--checkpoint-path`, `--error-report-path`, `--start-height`, `--max-height`, `--sleep-ms` all stay.
- Update: `tools/mainnet-validate/README.md` to reflect the REST architecture.
- Update: relevant docs/specs cross-references.

### Out of scope (deferred follow-up)

- **h=1 (genesis) validation.** Genesis-state boxes (emission, no_premine, founders) have no creating tx and are not in the indexer's `boxes` table. Smoke walks start at h=2 for v1. TS port of the shim's `genesis_constants.rs` is a follow-up if h=1 validation becomes load-bearing.
- **Output-roundtrip via TS box reconstruction.** v1 fetches output box bytes from the indexer like every other box. The "reconstruct output bytes in TS from block JSON, hash, compare to indexer's `box_id`" serializer-drift detector is a follow-up — useful but not in the critical path.
- **TS port of Transaction serialization / `bytes_to_sign`.** Not needed; we get `signingMessage` from the node's `/validation-fragments` endpoint.
- **Cost-drift across non-`ctx.jit_cost_value()` channels.** The WASM oracle exposes one number per input (raw JitCost). The 2j-a `evaluate-oracle-mismatch` symmetry tests (ours-succeeded/oracle-errored + ours-errored/oracle-succeeded) are preserved because the WASM oracle has the same `oracleSucceeded` / `oracleError` semantics as the shim did. No regression.
- **Continuous mode / new-block polling.** Out of scope here as it was for the shim-based harness. Harness exits at tip-or-max-height; re-run picks up from checkpoint.

### What is NOT touched

- `tools/mainnet-validate/loop-prompts/info-gather.md` + `fix-apply.md` — load-bearing for the autonomous loop's subagent contract per the parallel session's instructions.
- `tools/mainnet-validate/harness/src/loop-log.ts` — append-only log writer; orchestrator reads/writes it.
- `tools/mainnet-validate/harness/src/repeated-arm-detector.ts` — pure function, data-source-independent.
- `tools/mainnet-validate/findings/loop-log.json` — main session's iter-1 entry stays.
- `packages/scorex/`, `packages/nipopow/`, `packages/avltree/`, `packages/ergoscript/` — eval-side library packages unchanged. Iter-1's eval fix (which is in `packages/ergoscript/`) is data-source-agnostic and still applies.
- `SESSION_CONTEXT.md`, `HANDOFF_PROMPT.md` — main session's state docs.

## 3. Architecture

### 3.1 Components

```
┌────────────────────────────────────────────────────────────────┐
│  harness (Node process)                                        │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │ NodeClient  │    │IndexerClient│    │ WasmOracle  │         │
│  │  (TS)       │    │  (TS)       │    │ (TS wrapper │         │
│  │             │    │             │    │  around WASM)│        │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                  │                  │                │
│         ▼                  ▼                  ▼                │
│  ┌─────────────────────────────────────────────────┐           │
│  │   bundleAssembler — composes BlockBundle        │           │
│  │   from REST + adds oracleCost via WASM          │           │
│  └────────────────┬────────────────────────────────┘           │
│                   │                                            │
│                   ▼                                            │
│  ┌─────────────────────────────────────────────────┐           │
│  │   validateBlock + validateTx (unchanged shape)  │           │
│  │   (header / output-roundtrip / evaluate /        │           │
│  │    cost-equivalence / verify-signature)         │           │
│  └─────────────────────────────────────────────────┘           │
│                                                                │
│  ┌─────────────────────────────────────────────────┐           │
│  │   loop infrastructure (heartbeat, loop-log,     │           │
│  │   checkpoint, repeated-arm-detector)            │           │
│  │   UNTOUCHED                                     │           │
│  └─────────────────────────────────────────────────┘           │
└────────────────────────────────────────────────────────────────┘
           │                          │
           ▼                          ▼
  ┌────────────────┐          ┌────────────────┐
  │  Node REST     │          │  Indexer REST  │
  │  :9052         │          │  :9054/api/v1  │
  │                │          │                │
  │  /info         │          │  /boxes/{id}/  │
  │  /blocks/at/{h}│          │   bytes        │
  │  /blocks/{id}  │          │                │
  │  /blocks/{id}/ │          │                │
  │   validation-  │          │                │
  │   fragments    │          │                │
  └────────────────┘          └────────────────┘
```

### 3.2 Per-block fetch sequence (height `h`)

1. `GET /blocks/at/{h}` (node, existing) → `headerId`
2. `GET /blocks/{headerId}` (node, existing) → block JSON (parsed transactions, parsed header, parsed extension)
3. `GET /blocks/{headerId}/validation-fragments` (node, **new**) → `{headerBytes, parameters, transactions: [{txId, signingMessage}, ...]}`
4. Parallel: `GET /api/v1/boxes/{box_id}/bytes` (indexer, **new**) for every input `boxId`, every data-input `boxId`, and every output `boxId` in the block. Initial concurrency bound: **64** simultaneous fetches per block (tune post-smoke). The indexer's contract docs claim ~1k concurrent reads capacity under SQLite + HTTP/1.1; 64 leaves headroom + bounded fairness. Every box-bytes response MUST be hash-verified harness-side via `blake2b256(serverBytes) === boxId` before use — defensive even though the indexer itself hash-verifies before serving (per [[feedback-correctness-over-effort]]).
5. In-memory bundle assembly: glue REST data into a `BlockBundle`-shaped TS object (same shape as today's `protocol.ts BlockBundle`, minus the shim-specific `oracle_*` fields on `InputBundle` — those come from WASM in step 6).
6. For each tx: **one** synchronous WASM call → per-input `oracleCost` + `oracleSucceeded` + `oracleError` array. Populate per-input bundle entries. (Per-tx, not per-input — sigma-rust's `TransactionContext` needs all spent boxes + all data-input boxes for the whole tx; reusing one Context across the tx's inputs is the natural shape and amortizes setup cost. The WASM call is in-process; no IPC.)
7. Run existing `validateBlock(bundle, walkerState, deriveTreeVersionFromBoxBytes)` against the assembled bundle. Halt on first divergence.

Round-trip count per block: 3 fixed node calls + M parallel indexer calls (M = total box references in the block, typically 30-100 for mid-mainnet blocks). At sub-ms local-loopback latency with HTTP/1.1 keep-alive, a smoke walk of h=2..10000 completes in 5-15 minutes; full-chain walks h=2..tip take a couple of hours.

### 3.3 WASM scope boundary

`ergo-lib-wasm-nodejs` is used in exactly one place: the `WasmCostOracle` module. The narrow surface:

```ts
interface WasmCostOracle {
  /**
   * Compute per-input oracle costs for one transaction.
   * Reuses a single sigma-rust `TransactionContext` + `ErgoStateContext` for
   * all inputs of the tx (the natural shape, since sigma-rust requires all
   * spent boxes + all data-input boxes to be present when building the
   * Context for ANY input — see external/sigma-rust/ergo-lib/src/wallet/
   * signing.rs::make_context).
   *
   * Returns an array index-aligned with the input order in `txBytes`.
   * Output entries carry raw JitCost (= ctx.jit_cost_value()), NOT
   * ReductionResult.cost (which is jit_cost / 10).
   */
  computeTxOracleCosts(args: {
    txBytes: Uint8Array;                  // Transaction::sigma_serialize_bytes (full, with proofs)
    spentBoxesBytes: Uint8Array[];        // per-input spent box bytes, index-aligned with tx.inputs
    dataInputBoxesBytes: Uint8Array[];    // per-data-input box bytes, in tx order
    headerBytes: Uint8Array;              // current block's Header::scorex_serialize_bytes
    rollingHeadersBytes: Uint8Array[];    // up to 10 newest-first preceding headers (Scorex-serialized)
    parameters: { maxBlockCost: number } | null;
  }): Array<{
    oracleCost: bigint;                   // raw ctx.jit_cost_value() — NOT ReductionResult.cost
    oracleSucceeded: boolean;
    oracleError: string | null;
  }>;
}
```

**Design notes:**

- The signature deliberately does NOT take `treeBytes` separately from `spentBoxesBytes`. The tree lives inside the box; passing it separately would create a stealth divergence vector (TS-side could extract a different tree than sigma-rust extracts internally, silently breaking the cost-equivalence comparison). The oracle extracts the tree from `spentBoxesBytes[inputIndex]` itself, the same way sigma-rust does.
- Per-tx granularity matches `TransactionContext::new(tx, boxes_to_spend, data_boxes)` — building a Context requires all the tx's spent + data-input boxes, not just the one being costed. Per-tx is also closer to the node session's original POST design.
- The implementation must also override `ctx.tree_version` from each input's spent-box ergo_tree header byte (matching the shim's `cost_oracle.rs:128-138` pattern) and set `ctx.jit_cost_limit = max_block_cost * 10` (matching `cost_oracle.rs:144` and per sigma-rust's `tx_context.rs:202`).

The implementation calls into sigma-rust via the WASM bindings to:
- Reconstruct `Transaction` via `Transaction::sigma_parse` (from `txBytes`)
- Reconstruct per-input `ErgoBox` via `ErgoBox::sigma_parse` (from `spentBoxesBytes[i]`)
- Reconstruct data-input `ErgoBox` array (from `dataInputBoxesBytes`)
- Build `TransactionContext` and `ErgoStateContext`
- For each input: call `reduce_to_crypto(input_box.ergo_tree, ctx)`, read `ctx.jit_cost_value()`, record result

**Critical: read raw JitCost, NOT block cost.** Per the existing shim's `cost_oracle.rs` module doc: `ReductionResult.cost` is `jit_cost / 10` (block cost); comparing block-cost against our TS `ctx.jitCost` (raw JitCost) yields off-by-10 mismatches on every input. The shim avoided this by reading `ctx.jit_cost_value()` directly. The WASM oracle must do the same.

**WASM binding gap to close upstream:** `ergo-lib-wasm-nodejs` v0.28.0 exposes `ReducedTransaction` (which carries block-cost) but does NOT expose raw `ctx.jit_cost_value()`, nor setters for `ctx.tree_version` / `ctx.jit_cost_limit`. Closing this gap requires additions to `external/sigma-rust/bindings/ergo-lib-wasm/` (~50-100 LOC of `#[wasm_bindgen]`) to expose:

1. A `reduce_to_crypto_with_jit_cost(tree, ctx) → {sigma_prop, jit_cost}` function (or equivalent that returns raw JitCost alongside the reduction result).
2. Setters for `Context.tree_version` and `Context.jit_cost_limit` (so we can match the shim's overrides faithfully).

This change lands on the `integration/ergots` branch of sigma-rust + a `wasm-pack build --target nodejs --release` produces a `pkg-nodejs/` directory we install locally as a path-dep. Not blocking the harness-side scaffold work, but blocks end-to-end smoke.

**MANDATORY pre-implementation gate (per OVERRIDES rule #2 escalation):** Before committing to the full implementation, write a minimal binding prototype and verify it against the existing shim's three cost-oracle tests (`cost_oracle.rs:294-368`: `trivial_true_charges_fifty`, `trivial_false_charges_fifty_and_succeeds`, `cost_limit_exceeded_returns_error_with_partial_cost`). If the binding reproduces bit-equivalent results on all three, proceed. If not, fall back to the Rust-subprocess plan B (~150 LOC) — the architecture is robust to that fallback because the WASM oracle's surface is narrow.

**Lifecycle:** initialize the WASM module **eagerly at harness startup** (NOT lazy on first oracle call) so the ~100-500ms init cost doesn't skew the first block's heartbeat avg-ms-per-blk and so operators see a clear stderr "loading WASM oracle..." line instead of a silent startup hang. **Memory cleanup:** every WASM call constructs JS wrapper objects (`ErgoBox`, `Transaction`, `Context`, etc.) that hold pointers into WASM linear memory. Without explicit `.free()` calls or `FinalizationRegistry` cleanup, a 1M-block walk leaks WASM memory unbounded. The `WasmCostOracle` wrapper MUST either (a) explicitly call `.free()` on every WASM object it constructs (before returning to the bundle assembler), or (b) register them in a `FinalizationRegistry` that frees them on GC. Pattern (a) is more deterministic; prefer it.

### 3.4 What WASM is NOT used for

The validation pipeline tests our `@ergots/*` TS implementations against reality. WASM doing the same work would defeat the purpose. Explicit non-uses:

- Header parsing / serialization → `@ergots/scorex` (`parseHeader`, `serializeHeader`)
- ErgoTree parsing / serialization → `@ergots/ergoscript` (`parseTree`, `serializeTree`)
- ErgoBox parsing / serialization → `@ergots/ergoscript` (`parseSValue({tag:'SBox'}, ...)`, `serializeBoxBytes`)
- SType / SValue parsing / serialization → `@ergots/ergoscript`
- ErgoTree evaluation → `@ergots/ergoscript` (`evaluate`, `evaluateWith`) ← cross-checked against WASM oracle on cost
- Sigma verifier → `@ergots/ergoscript` (`verifySignature`)
- Autolykos v2 PoW verification → `@ergots/scorex` (`verifyAutolykosV2`)
- AVL+ proof verification → `@ergots/avltree`

All of the above remain pure-TS, exercised against real mainnet data. The harness's value proposition is intact.

### 3.5 Validation channels

| Channel | Source | Status |
|---|---|---|
| Header parse | `parseHeader` (scorex) | Preserved (was `phase: 'header'` / `byte-roundtrip-mismatch`, `autolykos-v2-verify-false`, etc.) |
| Header Autolykos v2 verify | `verifyAutolykosV2` (scorex) | Preserved |
| Header hash cross-check | `blake2b256(headerBytes) === headerId` (where `headerBytes` = full bytes including PoW) | NEW (free deterministic byte-level check; node's `headerId` was computed independently) |
| Header byte-roundtrip | `restHeaderBytes === serializeHeader(parseHeader(restHeaderBytes))` | STRENGTHENED — was a parsed-structure round-trip via shim-emitted bytes; now byte-equal because input bytes have a known canonical source |
| Output box-bytes round-trip | parseSValue + serialize + compare | Preserved (input is now indexer-served bytes instead of shim-served; indexer's hash-verified-before-serving + harness-side recompute gives deterministic byte-source provenance) |
| Indexer box-id verify | `blake2b256(serverBytes) === boxId` | NEW (defensive harness-side check; same level as the `box-hash-mismatch` error code) |
| ErgoTree parse | `parseTree` | Preserved |
| Per-input ContextExtension parse | `parseSType` + `parseSValue` | Preserved |
| Evaluate | `evaluateWith` | Preserved |
| **Cost-equivalence (per input)** | TS `ctx.jitCost` vs **WASM** `ctx.jit_cost_value()` | **Preserved via WASM oracle** (was: shim's `oracle_cost` field) |
| `evaluate-oracle-mismatch` (ours-OK / oracle-errored) | Same comparison, error-direction asymmetry | Preserved |
| `evaluate-oracle-mismatch` (ours-errored / oracle-OK) | Same | Preserved |
| `cost-overflow` (oracleCost > Number.MAX_SAFE_INTEGER) | Defensive guard | Preserved |
| Verify-signature | `verifySignature` | Preserved (uses `signingMessage` from `/validation-fragments`) |
| WASM-oracle context-fidelity | per-input `tree_version` + `jit_cost_limit` overrides applied inside `computeTxOracleCosts` matching shim `cost_oracle.rs:128-144` | NEW (enforced inside the WASM wrapper, verified by the pre-implementation prototype gate) |

Net: every validation channel that 2j-a established is preserved. The header hash cross-check is new — a free deterministic check because we have the bytes and the node returns the reported id alongside. The analogous output box-id hash cross-check (using TS-reconstructed bytes from block JSON) is deferred to follow-up per §2 — would require building a JSON→ErgoBox-typed-object adapter that doesn't exist yet and isn't on the critical path.

## 4. Wire contracts (depended-upon, NOT defined here)

The node + indexer endpoints are specified in the coordinated session (`~/projects/ergo-node-rust/prompts/ergots-update-2026-05-24.md` + the contract files the node session will land: `addons/indexer/CONTRACT.md` and the node-side `facts/api.md` equivalent). The harness MUST match those contracts exactly. Summary of harness-side expectations:

**Node — `GET /blocks/{headerId}/validation-fragments`** returns:
```jsonc
{
  "headerBytes": "<hex>",                              // Header::scorex_serialize_bytes — full header bytes INCLUDING
                                                        // Autolykos solution + PoW. blake2b256(headerBytes) == headerId.
                                                        // Distinct from serialize_without_pow(header) which is the
                                                        // Autolykos puzzle message (`autolykosMessage` in scorex's API).
  "parameters": { "maxBlockCost": 1000000 } | null,    // null = Extension parse failed; harness fallback to default
  "transactions": [
    { "signingMessage": "<hex>" }                      // index-aligned with the existing /blocks/{id} JSON's
                                                        // `blockTransactions.transactions[]` array. No `txId` field on
                                                        // the wire — alignment IS the cross-check.
  ]
}
```

The harness pairs each `signingMessage` with the corresponding tx's `id` from the `/blocks/{id}` JSON for diagnostic correlation in error reports — but that's harness-side composition, not on the wire.

**Indexer — `GET /api/v1/boxes/{box_id}/bytes`** returns:
```jsonc
{ "bytes": "<hex of ErgoBox::sigma_serialize_bytes>" }
```

Both endpoints' error responses are standard HTTP status + `{error: "<code>", message: "..."}`. Per-input oracle errors are NOT HTTP errors in any case; they happen inside the WASM call on the harness side under this architecture.

## 5. Error taxonomy

`ShimErrorCode` retires. Replacement:

```ts
type NodeRestErrorCode =
  | 'block-not-found'           // 404 from /blocks/at/{h} or /blocks/{id}
  | 'block-pruned'              // 410 (rare)
  | 'fragments-not-available'   // /validation-fragments returned 404
  | 'fragments-malformed'       // schema-shape divergence (e.g., transactions array length mismatch with /blocks/{id})
  | 'node-internal-error'       // 5xx from any node route (preserves the structured {error, message} payload)
  | 'network-error'             // fetch failure, timeout, ECONNREFUSED
  | 'unexpected-status';        // any other 4xx that doesn't map above

type IndexerRestErrorCode =
  | 'box-not-found'             // 404
  | 'box-hash-mismatch'         // indexer's hash-verify failed OR our recompute disagrees
  | 'indexer-internal-error'    // 5xx (preserves indexer's structured {error, boxId, message} payload)
  | 'network-error'
  | 'unexpected-status';

type WasmOracleErrorCode =
  | 'wasm-not-loaded'           // pkg-nodejs failed to initialize
  | 'wasm-call-threw'           // unexpected throw from the binding
  | 'jit-cost-overflow';        // returned value > BigInt(Number.MAX_SAFE_INTEGER)
```

The existing `phase: 'shim'` bucket splits into three new phases: **`phase: 'node-rest'`** for NodeRestErrorCode, **`phase: 'indexer-rest'`** for IndexerRestErrorCode, **`phase: 'wasm-oracle'`** for WasmOracleErrorCode. This precision matters for the autonomous loop's `repeated-arm-detector` (which keys on `(phase, errorCode)` for arm fingerprinting — coarser phases would degrade repeated-arm detection). The existing `validate-tx.ts` phase classes (`header`, `output-roundtrip`, `evaluate`, `evaluate-cost`, `evaluate-oracle-mismatch`, `verify-signature`) are unchanged. The `loop-prompts/info-gather.md` + `fix-apply.md` files reference `phase` parametrically (they read whatever is in `error-report.json`), so the split doesn't require their content to change.

Retry / timeout policy (initial defaults, tunable post-smoke):
- Per HTTP call: 30s timeout, 3 retries with exponential backoff (250ms, 500ms, 1s)
- Halt on persistent failure (no skip-and-continue)
- WASM oracle errors: no retry (deterministic; if it threw, it'll throw again)

HTTP connection pooling: both `NodeClient` and `IndexerClient` MUST instantiate a single `undici.Agent` (or equivalent connection pool) and reuse it across all calls. Without explicit pooling, Node's default `fetch` may not reuse connections reliably across distinct clients — and the "sub-ms local-loopback latency" claim in §3.2 depends on keep-alive working. A 1M-block walk without keep-alive is 10x slower than with it.

## 6. CLI

```
node tools/mainnet-validate/harness/dist/main.js \
  --node-url http://localhost:9052 \
  --indexer-url http://localhost:9054 \
  --start-height 2 \
  --max-height 10000 \
  --network mainnet
```

Flags retired: `--store-path`, `--sidecar-path`, `--shim-path`.
Flags added: `--node-url`, `--indexer-url`.
Flags unchanged: `--network`, `--start-height`, `--max-height`, `--checkpoint-path`, `--error-report-path`, `--sleep-ms`.

Defaults (in `cli.ts CLI_DEFAULTS`):
- `--node-url`: `http://localhost:9052`
- `--indexer-url`: `http://localhost:9054`
- `--start-height`: 2 (was 1; reflects h=1-deferred decision)
- (others unchanged)

## 7. Test strategy

### 7.1 Unit tests

- `NodeClient` / `IndexerClient` — mock fetch responses (fixtures captured from real REST calls during dev); assert request shape (URL, headers), response parsing, error taxonomy.
- `WasmCostOracle` — minimal smoke (P2PK input → expected cost = 50); error-path (cost-limit-exceeded → `oracleSucceeded: false`).
- `bundleAssembler` — given mocked REST fragments + box bytes, produces a correct `BlockBundle`.
- Existing validate-block / validate-tx tests — should mostly pass unchanged (data-source-agnostic). Adjustments: cost-equivalence path now reads `WasmCostOracle.computeOracleCost(...)` instead of `input.oracleCost`. Test fixtures update accordingly.

Target: 90+ tests passing (vs. today's 99 — net change depends on how many shim-specific tests retire).

### 7.2 Integration tests

- Mock REST server (`msw` or hand-rolled `fastify`) serving captured fixtures for h=1..h=10 to drive the full pipeline end-to-end in CI.
- Real-node opt-in tests gated by env var (`ERGOTS_LIVE_NODE_URL` etc.) — skipped in CI, run locally during dev.

### 7.3 Smoke test (validation gate)

`npm run smoke` (new script) — walks h=2..10000 against the user's live node + indexer. Exit 0 + checkpoint advanced + no `error-report.json` = pass. Run this BEFORE declaring the refactor complete.

**Named gate: h=685 specifically MUST pass.** This is the block that surfaced the BEST_CHAIN/PRIMARY divergence in the redb-direct shim — the divergence that motivated the entire REST pivot. If h=685 doesn't pass under REST, the pivot's motivating premise is invalid. Confirm explicitly in the iter-1 smoke result (loop-log entry or smoke-report).

**Header-format pre-gate (decouples header verification from full-pipeline smoke):** add a deterministic test (`harness/test/integration/header-bytes-roundtrip.test.ts`) that fetches `/validation-fragments` for h=2 and asserts:

```ts
const { headerBytes: serverBytes } = await nodeClient.getValidationFragments(headerId);
const parsed = parseHeader(new ByteReader(serverBytes));
const reserialized = serializeHeader(parsed);
expect(reserialized).toEqual(serverBytes);  // byte-equality
const computedId = blake2b256(serverBytes);
expect(bytesToHex(computedId)).toEqual(headerId);  // hash cross-check
```

This isolates the `Header::scorex_serialize_bytes` ↔ `@ergots/scorex serializeHeader` byte-format question — failures here surface as a header-format bug rather than as a confusing whole-pipeline halt on the first block.

If h=2..10000 + h=685 gate + header-format pre-gate all pass, follow with h=2..tip (full chain, ~hours). All must pass to close 2j-rest.

## 8. Migration plan (delete-add-modify-untouched matrix)

### Delete

- `tools/mainnet-validate/shim/` (entire directory; ~30k LOC of Rust)
- `bootstrap-data/` references in docs/README (data dir itself is gitignored; user deletes locally)
- `tools/mainnet-validate/harness/src/protocol.ts` — `ShimClient`, `ShimError`, `ShimErrorCode`, `FrameBuffer`, `reKey*` functions, `EXPECTED_SHIM_PROTOCOL_VERSION` (~500 LOC).
- `tools/mainnet-validate/harness/test/` — shim-mock + sidecar-rebuild + CBOR-frame tests (~5-10 test files).

### Add

- `tools/mainnet-validate/harness/src/rest/node-client.ts` (~150 LOC)
- `tools/mainnet-validate/harness/src/rest/indexer-client.ts` (~100 LOC)
- `tools/mainnet-validate/harness/src/rest/types.ts` — JSON-schema TS types for both endpoints' responses (~100 LOC)
- `tools/mainnet-validate/harness/src/wasm-oracle.ts` — narrow WASM wrapper (~150 LOC)
- `tools/mainnet-validate/harness/src/bundle-assembler.ts` — REST → in-memory `BlockBundle` (~200 LOC)
- Test fixtures captured from real REST calls (h=2, h=100, h=685, h=10000) — committed to `harness/test/fixtures/rest/`
- `ergo-lib-wasm-nodejs` dep — **NOT from the npm registry's v0.28.0** (which lacks behavioral fixes merged on `integration/ergots`); built locally from `external/sigma-rust/bindings/ergo-lib-wasm/` via `wasm-pack build --target nodejs` and installed as a local tarball or path-dep in `harness/package.json`. See §9 for the dependency mechanics.

### Modify

- `tools/mainnet-validate/harness/src/validate-tx.ts` — replace `input.oracleCost` / `input.oracleSucceeded` / `input.oracleError` reads with calls into `WasmCostOracle`. Same halt taxonomy.
- `tools/mainnet-validate/harness/src/main.ts` — `ShimClient.spawn(...)` → instantiate `NodeClient` + `IndexerClient` + `WasmCostOracle`; `shim.getBlock(h)` → `bundleAssembler.assemble(h)`; `shim.getTipHeight()` → `nodeClient.getInfo().then(info => info.fullHeight)`; remove `shim.close()` (no subprocess).
- `tools/mainnet-validate/harness/src/cli.ts` — flag swap per §6.
- `tools/mainnet-validate/harness/src/errors.ts` — extend HarnessError phase enum with `'node-rest'`, `'indexer-rest'`, `'wasm-oracle'` (or fold all into single `'rest'` if precision-of-triage doesn't warrant splitting).
- `tools/mainnet-validate/harness/src/checkpoint.ts` — drop `shimPath` + `storePath` fields from `Checkpoint`; add `nodeUrl` + `indexerUrl`. **MANDATORY: REJECT (don't silently warn-and-continue) any checkpoint that has the pre-REST `shimPath` field present**. Surface a clear error: "Checkpoint at `<path>` was written by the pre-REST harness; delete it or pass `--ignore-old-checkpoint` to start fresh." This prevents two failure modes: (a) silent stale-resume where the JSON parse succeeds with `undefined` for new fields and the walk proceeds from a wrong state, and (b) silent fresh-start where the user thinks resume worked. Per [[feedback-correctness-over-effort]]: loud failure is correct here.
- `tools/mainnet-validate/harness/package.json` — add `ergo-lib-wasm-nodejs` dep; drop dependency on the shim path.
- `tools/mainnet-validate/README.md` — full rewrite of "Prerequisites", "Build", "Run" sections. Move shim-related content to a "Historical" or "Pre-2j-rest architecture" appendix (or just delete; git history is the archive).

### Untouched

- `tools/mainnet-validate/loop-prompts/info-gather.md`
- `tools/mainnet-validate/loop-prompts/fix-apply.md`
- `tools/mainnet-validate/harness/src/loop-log.ts`
- `tools/mainnet-validate/harness/src/repeated-arm-detector.ts`
- `tools/mainnet-validate/findings/loop-log.json` (main session's iter-1 entry)
- `packages/scorex/`, `packages/nipopow/`, `packages/avltree/`, `packages/ergoscript/`
- `SESSION_CONTEXT.md`, `HANDOFF_PROMPT.md`

## 9. Upstream dependencies

This spec assumes the following land before harness smoke can complete:

1. **Node-side endpoint shipped** ✅ (per `~/projects/ergo-node-rust/prompts/ergots-update-2026-05-24.md`). `GET /blocks/{headerId}/validation-fragments` is live at `:9052`.
2. **Indexer-side endpoint shipped** ✅ (per same file). `GET /api/v1/boxes/{box_id}/bytes` is live at `:9054`.
3. **sigma-rust WASM binding for raw `ctx.jit_cost_value()`** — NOT YET DONE. ~30-50 LOC addition to `external/sigma-rust/bindings/ergo-lib-wasm/src/`. Lands on the `integration/ergots` branch. **Implementation can scaffold without this, but smoke walks block on this landing.** Coordinate via a small sigma-rust-side handoff if needed.

4. **Local WASM build, NOT npm-published v0.28.0.** The npm-published `ergo-lib-wasm-nodejs` v0.28.0 may not include behavioral fixes that landed on the `integration/ergots` branch (e.g., the `pack_interlinks` fix per memory [[reference-sigma-rust-pack-interlinks-bug]] is merged on that branch but versioning relative to npm registry releases is unclear). Per [[reference-source-first-discipline]]: the `integration/ergots` branch is the authoritative reference for behavior. The harness MUST build WASM from `external/sigma-rust/bindings/ergo-lib-wasm/` locally. The upstream package already has a `build-nodejs` script (per `external/sigma-rust/bindings/ergo-lib-wasm/package.json:11`):

   ```
   "build-nodejs": "rm -rf ./pkg-nodejs && cross-env WASM_BINDGEN_WEAKREF=1 wasm-pack build --target nodejs --out-dir pkg-nodejs && cd pkg-nodejs && node ../scripts/publish_helper -nodejs"
   ```

   Output lands in `pkg-nodejs/` (NOT `pkg/` — that's reserved for the browser build). The harness's `package.json` consumes it as a path-dep:

   ```
   "ergo-lib-wasm-nodejs": "file:../../../external/sigma-rust/bindings/ergo-lib-wasm/pkg-nodejs"
   ```

   This binds the harness to the same sigma-rust commit our `cost-equivalence` channel is calibrated against — necessary for cost-drift detection to be meaningful (cost calc changes between sigma-rust versions would otherwise surface as spurious cost-drift halts). Pin the sigma-rust commit in `harness/wasm-build/sigma-rust-commit.txt` (sidecar file checked into git); add a `npm run build:wasm` script that (a) verifies the worktree's HEAD matches the pin before building, (b) invokes the upstream `npm run build-nodejs`. Document the build step in the harness README, including prerequisites (Rust toolchain stable, `wasm-pack`, `cross-env`).

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `ergo-lib-wasm-nodejs` doesn't expose `Context.jit_cost_value()` even after binding addition | Cost-drift detection blocked | Binding addition lands in `external/sigma-rust/bindings/ergo-lib-wasm/src/` (under user's control); fallback is tiny Rust subprocess (~150 LOC, accepted in prior brainstorm). |
| Local WASM build from `external/sigma-rust/` is out-of-sync with the rest of the harness's expectations (e.g., differs from `integration/ergots` HEAD silently) | Spurious cost-drift halts, masked library bugs | Pin sigma-rust commit in `harness/package.json` or a `harness/wasm-build/commit.txt` sidecar file; `npm run build:wasm` verifies sigma-rust HEAD matches before building. |
| `wasm-pack` build introduces friction for new contributors | Slower onboarding | Document the `npm run build:wasm` flow + prerequisites (Rust toolchain, `wasm-pack`) in harness README. |
| Per-block fetch latency >> sub-ms (e.g., remote node) | Smoke walk takes hours instead of minutes | Document local-node assumption in README; if needed, add concurrency limits + per-block pipeline. |
| Indexer's `/api/v1/boxes/{id}/bytes` doesn't serve all spent boxes for some classes | Some inputs fail to resolve → spurious halts | Verify in smoke (h=2..10000); coordinate with indexer side if surfaces. |
| WASM init has a 100-500ms one-time cost | Harness startup slower than today's shim spawn | Eager init at startup + stderr "loading WASM oracle..." line; acceptable, amortized over the walk. |
| WASM memory leak across 1M-block walk | OOM kill before tip-reach | Explicit `.free()` calls on every WASM object the oracle constructs; verified via heap-profile spot-check during smoke. |
| HTTP connection pool not reused → keep-alive doesn't happen | 10x slower walks; spec's latency estimate wrong | Mandate single `undici.Agent` per REST client per §5; verify via TCP-state observation during smoke. |
| Cost-drift bug in our TS evaluator that was previously masked by oracle agreement now surfaces | Sudden burst of halts during first smoke | This is the harness DOING its job. Iter-2+ fixes per the existing fix-loop pattern. |
| `headerBytes` from `/validation-fragments` uses `Header::scorex_serialize_bytes` not `sigma_serialize_bytes`; our `serializeHeader` mismatches | Halt on every header parse | Verify on first smoke (h=2); fix our serializer to match Scorex format if needed (probably already does). |
| Test infrastructure (`msw` etc.) pulls in WASM transitively | Violates no-WASM-in-libs invariant accidentally | Audit harness's `node_modules` post-install; document acceptable test-only WASM in CLAUDE.md. |
| Indexer is single-threaded SQLite; M parallel box fetches could serialize | Slower than expected | Tune concurrency limit on smoke; accept SQLite latency floor. |

## 11. Open follow-ups (post-2j-rest)

These are explicitly OUT of scope for 2j-rest but worth tracking:

- TS port of `genesis_constants.rs` → h=1 validation.
- TS output-box reconstruction from block JSON + hash cross-check → serializer-drift detection.
- TS port of `reduce_to_crypto` (would obsolete the WASM dep) → only if we want to remove WASM from the dev surface entirely; very large undertaking, not urgent.
- Continuous-mode harness (poll for new blocks) → if the harness becomes a long-running monitor rather than a CI walker.
- Retry/timeout policy refinement based on smoke observations.
- Per-block parallelism (multiple blocks in flight simultaneously) → only if smoke shows the sequential walk is unacceptably slow.
- Once `integration/ergots` branch's behavioral fixes are merged upstream into a published `ergo-lib-wasm-nodejs` release, switch the harness from path-dep to npm-registry version. Removes the build-from-source friction for contributors.

## 12. Verification gates (per OVERRIDES rule #6)

Before declaring 2j-rest complete:

```bash
# WASM build (one-time, or when sigma-rust commit advances)
cd tools/mainnet-validate/harness
npm run build:wasm                                  # wraps wasm-pack build of external/sigma-rust/bindings/ergo-lib-wasm
                                                    # must complete without errors

# TS-side
npx tsc --noEmit                                    # must be clean
npm test                                            # all tests pass (target 90+ tests)

# Project-wide
cd ../../..  # back to repo root
npx tsc --noEmit                                    # clean across all packages
npm test                                            # all package tests still pass

# Smoke
node tools/mainnet-validate/harness/dist/main.js \
  --node-url http://localhost:9052 \
  --indexer-url http://localhost:9054 \
  --start-height 2 \
  --max-height 10000
# → exit 0 + checkpoint.lastValidatedHeight=10000 + no error-report.json
```

## 13. Notes on memory updates (post-implementation)

These memories will need refreshing once 2j-rest lands and the dust settles (do this in the post-implementation docs sweep, not now):

- `[[project-ergots-direction]]` — phase 2j-b T7 status: lift the "paused mid-walk" qualifier; document REST architecture as the new baseline.
- `[[reference-enr-store-not-contract]]` — close the loop: harness no longer reaches into enr-store; reference REST endpoints.
- `[[feedback-pure-typescript-no-wasm]]` — add the explicit carve-out: dev tooling (harness) is allowed WASM; library packages (frots, cmttk, ergots/`@ergots/*`) remain pure-TS. Document the boundary.
- New reference memory: WASM-binding-addition pattern + the raw-JitCost gap. Specifically: never use `ReductionResult.cost`; always read `ctx.jit_cost_value()` for cross-validator comparison.

## 14. Reviewer checklist

For the reviewer pass (next step after this spec):

- [ ] Architecture (§3) is internally consistent — components, data flow, WASM boundary, validation channels all coherent.
- [ ] Wire contracts (§4) match the node session's delivered endpoints (cross-reference `~/projects/ergo-node-rust/prompts/ergots-update-2026-05-24.md`).
- [ ] Cost-drift detection (§3.3, §3.5) preserves all 2j-a halt taxonomy; no silent regression.
- [ ] WASM scope (§3.3, §3.4) is genuinely narrow — no creep into channels we should be testing in TS.
- [ ] Error taxonomy (§5) covers REST + WASM failure modes; halt-on-first preserved.
- [ ] Migration plan (§8) explicitly lists what's deleted, added, modified, untouched — no gaps that would leave dead code or break the loop infrastructure.
- [ ] Upstream dependency (§9) on the sigma-rust WASM binding is realistic and bounded; fallback exists.
- [ ] Risks (§10) are addressable; nothing in the "Risk" column is load-bearing without a mitigation.
- [ ] Out-of-scope items (§2 "Out of scope" + §11) are appropriately deferred, not under-specified critical paths.
- [ ] Test strategy (§7) gives the implementer clear signals for "what counts as done."
- [ ] Confidence escalations (per OVERRIDES rule #2) — anything below 95% on the crypto path? Most likely candidates: the WASM binding addition matching raw-JitCost exactly; the header-bytes format mismatch risk (scorex vs sigma). These are testable on first smoke.

End of spec.
