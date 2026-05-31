# tools/mainnet-validate

Mainnet validation harness for the `@ergots/*` library stack. Pure stop-on-error. Validates blocks from a live `ergo-node-rust` + indexer via REST; uses `ergo-lib-wasm-nodejs` (built locally from `external/sigma-rust/`) solely as the cost oracle.

A single TypeScript binary (`harness/`) walks the chain block-by-block, fetching block data from the node REST at `:9052` and box bytes from the indexer REST at `:9054/api/v1`. It runs four validation passes per block (header / output round-trip / evaluate / verify-signature), plus a cost-equivalence pass comparing our `ctx.jitCost` against the WASM oracle's per-input cost. The harness halts on the first divergence — writing a structured `error-report.json` for triage.

The harness is a developer tool, not a published surface. It is the loom on which the `@ergots/ergoscript` evaluator was calibrated per-arm against the live chain — driving the iter-1..31 cost/semantics fixes plus the JVM-alignment lockstep, and ultimately validating h=2 → tip byte-for-byte against the sigma-rust cost oracle.

## Prerequisites

- A locally running `ergo-node-rust` node exposing:
  - `:9052` — node REST surface, with the `validation-fragments` endpoint enabled (per the user's node-side `facts/api.md`)
  - `:9054/api/v1` — indexer addon REST surface, with the `/boxes/{id}/bytes` endpoint enabled (per the user's `addons/indexer/CONTRACT.md`)
  - Both endpoints are required; see `docs/specs/2026-05-24-ergoscript-2j-rest-design.md` §4 for the wire contract.
- Rust toolchain (stable) + `wasm-pack` + `cross-env` — for building `ergo-lib-wasm-nodejs` locally from `external/sigma-rust/bindings/ergo-lib-wasm/`. Per spec §9, the npm-registry-published version may lack behavioral fixes that landed on the `integration/ergots` branch.
- Node.js ≥ 20. The harness is ESM, single-process, ~600 LOC of orchestration TS.
- Disk: harness is stateless w.r.t. chain data — no sidecar redb, no snapshot required. ~5 MB for checkpoint + per-block HTTP fetches.

## Build

From the repo root:

```bash
cd tools/mainnet-validate/harness
npm run build:wasm   # builds ergo-lib-wasm-nodejs from external/sigma-rust/; verifies commit pin
npm install          # installs WASM (path-dep) + workspace packages
npm run build        # compiles harness TS to dist/
```

The harness entry point lands at `tools/mainnet-validate/harness/dist/main.js`. WASM artifacts at `external/sigma-rust/bindings/ergo-lib-wasm/pkg-nodejs/`.

`npm test` covers REST clients, WASM oracle wrapper, bundle assembler, validation passes, and a mock-REST integration walk h=2..h=10.

## Run

The harness fetches block data via REST — no local snapshot copy required. Just point it at your local node + indexer:

```bash
node tools/mainnet-validate/harness/dist/main.js \
  --node-url http://localhost:9052 \
  --indexer-url http://localhost:9054 \
  --start-height 2 \
  --max-height 100
```

Defaults assume invocation from the repo root.

| Flag | Required? | Default | Purpose |
|---|---|---|---|
| `--node-url URL` | no | `http://localhost:9052` | ergo-node REST surface |
| `--indexer-url URL` | no | `http://localhost:9054` | indexer addon REST surface |
| `--checkpoint-path PATH` | no | `./tools/mainnet-validate/checkpoint.json` | resume state |
| `--error-report-path PATH` | no | `./tools/mainnet-validate/error-report.json` | structured halt report |
| `--network mainnet\|testnet` | no | `mainnet` | network identifier |
| `--start-height N` | no | resume from checkpoint or 2 | override resume; **minimum h=2 for v1** (genesis-state-box validation is deferred follow-up per spec §11) |
| `--max-height M` | no | tip | end-of-walk cap |
| `--sleep-ms N` | no | `0` | rate-limit pause between blocks |

On a clean walk to the requested end height, the harness writes `tipReachedAt` into the checkpoint and deletes the error-report sidecar. Exit code 0.

### Migration from the pre-REST harness

If you previously ran the shim-based harness, **delete any pre-REST checkpoint** before the first REST run:

```bash
rm -f tools/mainnet-validate/checkpoint.json
```

The harness REJECTS pre-REST checkpoints loudly (per spec §8) — they have `shimPath`/`storePath` fields that the new architecture does not understand. The harness exits with a clear error on startup if it detects either field in the checkpoint file.

## Interpreting halts

The harness halts on the **first** divergence and writes a structured `error-report.json`. It does not retry, skip, or aggregate — every halt is load-bearing.

### What lands in `error-report.json`

```jsonc
{
  "timestamp": "2026-05-24T15:31:14.020Z",
  "height": 3849,
  "phase": "output-roundtrip",          // see "phase classes" below
  "errorClass": "HarnessError",
  "errorCode": "byte-roundtrip-mismatch",
  "message": "...",
  "stack": "...",                       // diagnostic; safe to ignore
  "location": {
    "txIndex": 0,
    "txId": "...",
    "outputIndex": 0,
    "ergoTreeHex": "00..."
  },
  "bundleExcerpt": {
    "headerHex": "..."                  // hex of the failing block's header
  }
}
```

### Phase classes

| `phase` | Source | Typical `errorCode` values |
|---|---|---|
| `header` | `validate-block.ts` header pass | `byte-roundtrip-mismatch`, `autolykos-v2-verify-false`, `v1-header-after-v2-activation`, `parent-link-mismatch` |
| `output-roundtrip` | `validate-block.ts` per-output pass | `byte-roundtrip-mismatch`, `tree-version-derivation-failed`, `sbox-parse-failed`, `tree-parse-failed`, `tree-serialize-failed` |
| `evaluate` | `validate-tx.ts` evaluate pass | per-`EvalError` code (see `facts/ergoscript-eval.md`) |
| `evaluate-cost` | `validate-tx.ts` cost-equivalence sub-step | `cost-drift`, `cost-overflow` |
| `evaluate-oracle-mismatch` | `validate-tx.ts` cost-equivalence | `ours-succeeded-oracle-errored`, `ours-errored-oracle-succeeded` |
| `verify-signature` | `validate-tx.ts` verifier pass | per-`VerifyError` code |
| `node-rest` | `NodeClient` REST failures | `block-not-found`, `block-pruned`, `fragments-not-available`, `fragments-malformed`, `node-internal-error`, `network-error`, `unexpected-status` |
| `indexer-rest` | `IndexerClient` REST failures | `box-not-found`, `box-hash-mismatch`, `indexer-internal-error`, `network-error`, `unexpected-status` |
| `wasm-oracle` | `WasmCostOracle` failures | `wasm-not-loaded`, `wasm-call-threw`, `jit-cost-overflow` |

### Two halt-vs-error distinctions

- **Validation halts write `error-report.json`.** Caught around `NodeClient.getBlock` and `validateBlock` in the per-block try blocks; the report's `phase` field tells you which side surfaced the divergence.
- **Startup halts write stderr only — no sidecar.** Failures BEFORE the per-block walk loop (WASM load failure, `getTipHeight` failure, `readCheckpoint` parse error, rejected pre-REST checkpoint) are operational and surface to stderr without a structured report. If you don't see an `error-report.json` after a halt, check stderr.

### Triage flow

1. Read `error-report.json`. The `phase` + `errorCode` pair is the dispatch axis.
2. If `phase: node-rest` with `errorCode: block-not-found` or `block-pruned`: the node doesn't have the block or validation fragments at that height. Verify the node is running with full-archive storage and the `validation-fragments` endpoint is enabled.
3. If `phase: indexer-rest` with `errorCode: box-not-found` (or `indexer-internal-error`/500 on the box-bytes endpoint): the indexer couldn't serve a box's bytes. Expected for the 3 genesis-state boxes (emission, no_premine, founders) — those have a hardcoded fallback in `IndexerClient`. Otherwise the indexer genuinely cannot serve that box, in one of two ways: (a) it is not fully synced; or (b) the box belongs to a **legacy reorg-orphan gap** — a pre-v0.6.6 block the indexer indexed as an *orphan* (vs the canonical block at that height), so a box created intra-block on the canonical side was never indexed. Class (b) is **not** an `@ergots/*` bug — it is node/indexer data state, and the harness has no way to reconstruct the box (it keeps no UTXO/box→creating-block index, and box-by-id 404s on the node too). Fix is node-side: truncate the indexer below the affected height and re-index forward canonical. Capture the box id + height and route to the node/indexer maintainer. (Two occurred this campaign, both fixed by truncate+reindex: h≈1,767,449 and h≈1,781,017.)
4. If `phase: header`/`output-roundtrip`/`evaluate`/`verify-signature`: the divergence is in the `@ergots/*` library. Cross-reference the `errorCode` against the per-package facts file; reproduce by feeding the `bundleExcerpt.headerHex` (and the indexed `location`) into a unit fixture.
5. If `phase: evaluate-cost` with `errorCode: cost-drift`: our TS evaluator and sigma-rust agree the input succeeded but disagree on cost. The `evaluateCost.{expected, actual, delta}` payload tells you the magnitude + direction (positive `delta` ⇒ ours undercharged, negative ⇒ ours overcharged). Reproduce by extracting `(ergoTreeHex, spentBoxId, ...)` from `location` into a per-arm fixture under `packages/ergoscript/test/eval/`; source-read the relevant sigma-rust arms for the actual charge.
6. If `phase: evaluate-cost` with `errorCode: cost-overflow`: oracle cost exceeded `Number.MAX_SAFE_INTEGER` (defensive guard; not expected on mainnet). Indicates an integration bug, not a chain divergence.
7. If `phase: evaluate-oracle-mismatch`: our eval and sigma-rust disagree on success/failure. `errorCode: ours-succeeded-oracle-errored` means we accept a tree sigma-rust rejects; `errorCode: ours-errored-oracle-succeeded` means we reject a tree sigma-rust accepts. The `oracleError` / `ourError` / `ourEvaluateCost` fields tell you what each side did. Both directions are bugs in the library; reproduce as in step 5.
8. If `phase: wasm-oracle` with `errorCode: wasm-call-threw`: the WASM oracle threw during cost evaluation. Usually WASM heap exhaustion (`memory access out of bounds`) — see Known limits; restart the process (checkpoint resumes) and re-run. The chunked restart loop absorbs this automatically.
9. Resume by re-running the same `node dist/main.js ...` invocation **after fixing the library bug** (or deciding the divergence is expected and adjusting test expectations). The harness reads the checkpoint and starts at `lastValidatedHeight + 1`. If you want to re-validate from a specific height instead, pass `--start-height N` — this treats the run as fresh and zeroes the in-memory stats counter (but the checkpoint file on disk is overwritten on the next successful block).

### Resume semantics edge cases

- `--start-height` overrides the checkpoint AND resets the in-memory stats. A subsequent run without `--start-height` will resume from the new `lastValidatedHeight`.
- If the four `@ergots/*` `libraryVersions` strings have changed since the checkpoint was written, the harness emits a warning to stderr and continues. Bumping a package version mid-walk is intentional during 2j proper iteration.
- `--max-height M` past the node's reported tip at startup clamps to the tip — the harness will not wait for new blocks to be mined.

## Tuning the rate limit

Per-block work is dominated by sigma-protocol verification at high heights (mainnet's later blocks carry transactions with substantial `SigmaBoolean` walks), plus M parallel indexer box fetches (M = box-ref count per block). At depth the walk is **I/O-bound on node/indexer store reads** (disk, not CPU); observed sustained throughput is ~5–10 blocks/s on a workstation. Two ways to throttle:

- **In-harness:** `--sleep-ms N` adds an `await sleep(N)` between blocks. Cheap; the timer fires inside the same event loop tick that just finished `validateBlock`, so it's a soft cap.
- **OS-level:** For long unattended walks:

```bash
# Lower CPU + IO priority:
nice -n 19 ionice -c idle node tools/mainnet-validate/harness/dist/main.js \
  --node-url http://localhost:9052 \
  --indexer-url http://localhost:9054

# Or hard-cap CPU% (Linux):
cpulimit -l 50 -p $(pgrep -f 'node.*main.js') &
```

## Current status: full mainnet walk complete — h=2 → tip

The harness has validated the mainnet chain from h=2 through to the **tip** (h=1,797,470 as
of 2026-05-31) with **zero unhandled halts** — every tx-input's JIT cost compared
byte-for-byte against the sigma-rust WASM oracle, alongside clean header /
output-roundtrip / evaluate / verify-signature passes. Reaching tip without an unhandled
divergence was the campaign goal. The walk surfaced and fixed 31 divergences (iters 1–31)
plus the JVM-alignment lockstep — per-iter history in `findings/iter-*.md` and
`findings/overnight-*.md`.

It is a pure-TypeScript REST client (per spec
`docs/specs/2026-05-24-ergoscript-2j-rest-design.md`):

- Fetches block data from the node REST at `:9052` (validation-fragments endpoint) + indexer REST at `:9054/api/v1` (boxes/{id}/bytes endpoint).
- Uses `ergo-lib-wasm-nodejs` (built locally from `external/sigma-rust/`) solely as the cost oracle; per-input `oracleCost = ctx.jit_cost_value()` post-`reduce_to_crypto`.
- Hardcodes the 3 mainnet genesis-state boxes (emission, no_premine, founders) as a fallback in `IndexerClient` since the indexer cannot index them (they are not transaction outputs).
- Long walks run under a chunked restart loop (~125-block chunks under `nice`) that auto-respawns on WASM OOM + transient REST errors and halts on the first validation divergence.

Per-block flow:
1. `GET /blocks/at/{h}` (node) → headerId
2. `GET /blocks/{id}` (node) → block JSON
3. `GET /blocks/{id}/validation-fragments` (node) → headerBytes + parameters + signingMessages
4. M parallel `GET /api/v1/boxes/{box_id}/bytes` (indexer) — M = inputs + data-inputs + outputs in the block
5. WasmCostOracle per-tx call → per-input oracleCost / oracleSucceeded / oracleError
6. validateBlock (header / output-roundtrip / evaluate / verify-signature / cost-equivalence) — halt on first divergence

## Known limits

- **WASM memory growth.** `compute_tx_oracle_costs` eventually hits `memory access out of bounds` from WASM heap fragmentation. The ceiling is **depth-dependent** — thousands of blocks on the sparse early chain, but only ~600–1,500 on dense later blocks (allocator state, not raw budget). Fresh process restart resolves it; checkpoint resume continues from the next height. The standard operating mode wraps the harness in a chunked restart loop (~125-block chunks) that respawns on OOM — the checkpoint persists progress across restarts. Not a consensus bug; pure WASM heap exhaustion.
- **h=1 deferred.** Smoke walks start at h=2 by default. h=1 validation requires special-casing the 3 genesis-state boxes' creation context (they have no creating tx); see spec §11 for the follow-up.
- **No continuous mode.** The harness exits when it reaches `--max-height` (or the node's reported tip at startup). It does NOT poll for new blocks. Re-running picks up from the checkpoint.
- **No retries beyond the REST client's per-call retry policy** (3 attempts with 250/500/1000ms backoff, 30s timeout per call). A persistent REST failure halts the walk.
- **No per-block parallelism.** Sequential block walk; cleaner halt semantics. The within-block parallelism is bounded to 64 concurrent indexer box fetches.
- **Pre-REST checkpoints rejected.** Any `checkpoint.json` with `shimPath`/`storePath` fields fails loudly on startup; delete the file or pass `--start-height` to override.

## References

- Design spec: [`docs/specs/2026-05-24-ergoscript-2j-rest-design.md`](../../docs/specs/2026-05-24-ergoscript-2j-rest-design.md)
- Plan: [`PLAN-2j-rest.md`](../../PLAN-2j-rest.md) at the repo root
- Project conventions: [`CLAUDE.md`](../../CLAUDE.md) at the repo root
- Library facts:
  - [`facts/scorex.md`](../../facts/scorex.md), [`facts/nipopow.md`](../../facts/nipopow.md), [`facts/avltree.md`](../../facts/avltree.md), [`facts/ergoscript.md`](../../facts/ergoscript.md)
- Reference implementations (consensus oracles):
  - `~/projects/ergo-node-rust/` (consensus pipeline + REST endpoints)
  - `~/projects/ergots/external/sigma-rust/` (parser + evaluator + verifier reference; integration/ergots branch carries our WASM binding addition)
