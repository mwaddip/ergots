# tools/mainnet-validate

Mainnet validation harness for the `@ergots/*` library stack. Pure stop-on-error. 2j-pre infrastructure for the upcoming phase 2j cost-calibration work.

A Rust shim (`shim/`) opens the user's `modifiers.redb` from a local `ergo-node-rust` checkout and streams CBOR `BlockBundle`s to a TypeScript harness (`harness/`). The harness walks the chain block-by-block, runs four validation passes per block (header / output round-trip / evaluate / verify-signature), and halts on the first divergence — writing a structured `error-report.json` for triage.

The harness is a developer tool, not a published surface. It is the loom on which 2j proper will calibrate per-arm costs and close the remaining sigma-rust divergences.

## Prerequisites

- A locally running (or fully synced + stopped) `ergo-node-rust` **full-archive** node, with both Headers and BlockTransactions present from genesis. Nodes started with `utxo_bootstrap = true` leave a gap from genesis to the snapshot height and the shim's startup check will refuse to proceed — only `utxo_bootstrap = false` archives walk cleanly. (`blocks_to_keep = 0` is a peer-handshake flag and does NOT gate local storage; empirically verified during T2.)
- Rust toolchain (stable). The shim crate sits OUTSIDE both the ergots and ergo-node-rust workspaces but path-deps into both; cargo resolves the graph transparently.
- Node.js ≥ 20. The harness is ESM, uses `node:fs`/`node:child_process`, and depends on three `@ergots/*` workspace packages via `file:` deps (`scorex`, `ergoscript`, `avltree`; not `nipopow` — though the checkpoint records all four versions for mismatch detection, the nipopow package is read off-disk for its version string only).
- Disk: the sidecar UTXO index grows to ~5 GB at mainnet tip; RAM during the walk runs ~1-3 GB.

## Build

From the repo root:

```bash
# Build the shim (release-only — debug builds are too slow for any
# realistic walk and aren't tested):
cd tools/mainnet-validate/shim
cargo build --release

# Build the harness:
cd ../harness
npm install
npm run build
```

The shim binary lands at `tools/mainnet-validate/shim/target/release/ergots-mainnet-validate-shim`. The harness entry point lands at `tools/mainnet-validate/harness/dist/main.js`.

> **Dist-rebuild gotcha** (load-bearing for both manual walks and the 2j-b autonomous loop):
> the harness imports `@ergots/*` packages through their `package.json` `exports → "./dist/index.js"` field, so source changes to `packages/*/src/` are **invisible** to the harness until that package's dist is rebuilt. Vitest runs against `src/` directly and will pass — but the harness will continue running pre-fix code. Before any walk that depends on a recent `packages/*/src/` change, run `cd packages/<pkg> && npm run build`. The 2j-b fix-apply prompt enforces this for autonomous-loop iterations; manual operators must do it themselves. Empirical demonstration: iter-2 of the 2j-b first loop run reproduced iter-1's halt verbatim because `packages/ergoscript/dist/` was stale.

`cargo test` in `shim/` (22 tests) and `npm test` in `harness/` (74 tests) cover the wire protocol, the UTXO sidecar, the walk loop, and all four validation passes. Both should pass cleanly before any walk attempt.

## Run

### 1. Snapshot the live store

The shim opens the modifier store via `redb::Database::create` (read-write), so you **must not** point it at a live `modifiers.redb` that the running `ergo-node` service is holding open. Take a snapshot first:

```bash
# Stop the node (recommended — atomic snapshot, no torn redb pages):
sudo systemctl stop ergo-node.service

# Copy the data dir. The live file is 0644 root:root (or
# ergo-node:ergo-node depending on packaging). cp -a preserves
# permissions and timestamps; reown to your user so the shim can
# open it RW.
sudo cp -a /var/lib/ergo-node/data /tmp/ergots-validate-data
sudo chown -R $USER:$USER /tmp/ergots-validate-data

# Restart the node if you want it back online (it now drifts from the
# snapshot — that's fine, the snapshot is the validation input):
sudo systemctl start ergo-node.service
```

Only `modifiers.redb` is required. The shim does NOT read `state.redb` — the sidecar UTXO index is rebuilt from `modifiers.redb` + the height index alone, so omitting `state.redb` saves disk on the snapshot.

### 2. Invoke the harness

```bash
node tools/mainnet-validate/harness/dist/main.js \
  --store-path /tmp/ergots-validate-data/modifiers.redb \
  --start-height 1 \
  --max-height 100 \
  --sleep-ms 0
```

Defaults assume invocation from the repo root:

- `--shim-path` defaults to `./tools/mainnet-validate/shim/target/release/ergots-mainnet-validate-shim`
- `--sidecar-path` defaults to `./tools/mainnet-validate/utxo-index.redb`
- `--checkpoint-path` defaults to `./tools/mainnet-validate/checkpoint.json`
- `--error-report-path` defaults to `./tools/mainnet-validate/error-report.json`
- `--network` defaults to `mainnet`
- `--sleep-ms` defaults to `0`

Run from elsewhere by passing absolute paths for those four.

All flags:

| Flag | Required? | Default | Purpose |
|---|---|---|---|
| `--store-path PATH` | yes | — | path to the snapshotted `modifiers.redb` |
| `--shim-path PATH` | no | (see above) | compiled shim binary |
| `--sidecar-path PATH` | no | (see above) | harness's UTXO sidecar redb (created if absent; auto-rebuilt on source-store fingerprint mismatch) |
| `--checkpoint-path PATH` | no | (see above) | `checkpoint.json`; presence on disk drives resume |
| `--error-report-path PATH` | no | (see above) | `error-report.json`; written on halt, deleted on tip-reached |
| `--network mainnet\|testnet` | no | `mainnet` | which network's v2-activation height applies |
| `--start-height N` | no | resume from checkpoint or 1 | override the resume height (treats this run as fresh; existing-checkpoint stats are reset) |
| `--max-height M` | no | shim's reported tip | cap on end height; useful for smoke walks |
| `--sleep-ms N` | no | `0` | sleep between blocks; OS-level throttling alternative below |

On a clean walk to the requested end height, the harness writes `tipReachedAt` into the checkpoint and deletes the error-report sidecar. Exit code 0.

## Interpreting halts

The harness halts on the **first** divergence and writes a structured `error-report.json`. It does not retry, skip, or aggregate — every halt is load-bearing.

### What lands in `error-report.json`

```jsonc
{
  "timestamp": "2026-05-22T15:31:14.020Z",
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
| `evaluate` | `validate-tx.ts` evaluate pass (both-error case for 2j-a) | per-`EvalError` code (see `facts/ergoscript-eval.md`) |
| `evaluate-cost` | `validate-tx.ts` cost-equivalence sub-step (phase 2j-a) | `cost-drift` (oracle cost ≠ ours), `cost-overflow` (oracleCost > MAX_SAFE_INTEGER) |
| `evaluate-oracle-mismatch` | `validate-tx.ts` cost-equivalence sub-step (phase 2j-a) | `ours-succeeded-oracle-errored`, `ours-errored-oracle-succeeded` |
| `verify-signature` | `validate-tx.ts` verifier pass | per-`VerifyError` code (see `facts/ergoscript-sigma.md`) |
| `shim` | shim process (stdout CBOR error frames) | `missing-block`, `missing-utxo`, `missing-data-utxo`, `store-race`, `unknown-command` (plus any anyhow chain on shim startup failure) |

### Two halt-vs-error distinctions

- **Validation halts write `error-report.json`.** Caught around `shim.getBlock` and `validateBlock` in the per-block try blocks; the report's `phase` field tells you which side surfaced the divergence.
- **Startup halts write stderr only — no sidecar.** Failures BEFORE the per-block walk loop (shim spawn failure, `getTipHeight` failure, `readCheckpoint` parse error, `rebuildWalkerState` failure) are operational — wrong `--store-path`, shim binary missing, stale checkpoint with a different libraryVersions stamp — and surface to stderr without a structured report. If you don't see an `error-report.json` after a halt, check stderr.

### Triage flow

1. Read `error-report.json`. The `phase` + `errorCode` pair is the dispatch axis.
2. If `phase: shim` with `errorCode: missing-utxo`: a tx input pointed at a box not in the sidecar. Either the sidecar diverged from the source store (rare — rebuild by deleting `--sidecar-path` and re-running) OR there's a real shim-side accounting bug (see Current status §2 below).
3. If `phase: shim` with `errorCode: missing-block`: the shim's `best_header_at(h)` returned None mid-walk. Suggests the source store has a hole in BEST_CHAIN at that height — unexpected on a clean snapshot.
4. If `phase: header`/`output-roundtrip`/`evaluate`/`verify-signature`: the divergence is in the `@ergots/*` library. Cross-reference the `errorCode` against the per-package facts file; reproduce by feeding the `bundleExcerpt.headerHex` (and the indexed `location`) into a unit fixture.
5. If `phase: evaluate-cost` with `errorCode: cost-drift`: our TS evaluator and sigma-rust agree the input succeeded but disagree on cost. The `evaluateCost.{expected, actual, delta}` payload tells you the magnitude + direction (positive `delta` ⇒ ours undercharged, negative ⇒ ours overcharged). Reproduce by extracting `(ergoTreeHex, spentBoxId, ...)` from `location` into a per-arm fixture under `packages/ergoscript/test/eval/`; source-read the relevant sigma-rust arms for the actual charge.
6. If `phase: evaluate-cost` with `errorCode: cost-overflow`: oracle cost exceeded `Number.MAX_SAFE_INTEGER` (defensive guard; not expected on mainnet). Indicates an integration bug, not a chain divergence.
7. If `phase: evaluate-oracle-mismatch`: our eval and sigma-rust disagree on success/failure. `errorCode: ours-succeeded-oracle-errored` means we accept a tree sigma-rust rejects; `errorCode: ours-errored-oracle-succeeded` means we reject a tree sigma-rust accepts. The `oracleError` / `ourError` / `ourEvaluateCost` fields tell you what each side did. Both directions are bugs in the library; reproduce as in step 5.
8. Resume by re-running the same `node dist/main.js ...` invocation **after fixing the library bug** (or deciding the divergence is expected and adjusting test expectations). The harness reads the checkpoint and starts at `lastValidatedHeight + 1`. If you want to re-validate from a specific height instead, pass `--start-height N` — this treats the run as fresh and zeroes the in-memory stats counter (but the checkpoint file on disk is overwritten on the next successful block).

### Resume semantics edge cases

- `--start-height` overrides the checkpoint AND resets the in-memory stats. A subsequent run without `--start-height` will resume from the new `lastValidatedHeight`.
- If the four `@ergots/*` `libraryVersions` strings have changed since the checkpoint was written, the harness emits a warning to stderr and continues. Bumping a package version mid-walk is intentional during 2j proper iteration.
- `--max-height M` past the shim's reported tip clamps to the tip — the harness will not wait for new blocks to be mined.

## Tuning the rate limit

The per-block work is dominated by sigma-protocol verification at high heights (mainnet's later blocks carry transactions with substantial `SigmaBoolean` walks). On a workstation, a 4-thread spike for ~50ms per block is typical. Two ways to throttle:

- **In-harness:** `--sleep-ms N` adds an `await sleep(N)` between blocks. Cheap; the timer fires inside the same event loop tick that just finished `validateBlock`, so it's a soft cap.
- **OS-level:** the shim and harness are both subject to the usual nicing controls. For long unattended walks:

```bash
# Lower CPU + IO priority; same as the user above but throttled:
nice -n 19 ionice -c idle node tools/mainnet-validate/harness/dist/main.js \
  --store-path /tmp/ergots-validate-data/modifiers.redb

# Or hard-cap CPU% (Linux):
cpulimit -l 50 -p $(pgrep -f 'node.*main.js') &
```

The shim's redb access is the heaviest IO path; `ionice -c idle` is more effective at quieting the harness for a desktop session than `nice` alone.

## Current status: 2j-a cost-oracle wiring complete; 2j-b first fix pending

Fix-1 (sbox-no-size), fix-2 (genesis-box seeding), fix-3 (Or/Xor/Atleast
exprTpe), and **phase 2j-a (cost-equivalence oracle wiring)** are all
resolved. The harness now routes sigma-rust's per-input cost (oracle)
alongside our TS `ctx.jitCost` and halts on the first cost-drift or
oracle-mismatch divergence at the new phase classes documented above.

Fix-list:

1. **RESOLVED in phase 2j-pre fix-1** (2026-05-22) — `parseSValue(SBox)` now handles v0+hasSize=false ErgoTrees. See `docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md`.
2. **RESOLVED in phase 2j-pre fix-2** (2026-05-22) — genesis-box seeding in shim sidecar. See `docs/specs/2026-05-22-ergoscript-2j-pre-fix-2-genesis-box-seeding-design.md`.
3. **RESOLVED in phase 2j-pre fix-3** (2026-05-22) — Or/Xor/Atleast exprTpe arms. See `docs/specs/2026-05-22-ergoscript-2j-pre-fix-3-atleast-exprtpe-design.md`.
4. **RESOLVED in phase 2j-a** (2026-05-23) — cost-equivalence oracle wiring (shim emits sigma-rust per-input cost; harness compares against our `ctx.jitCost` with halt-on-first-divergence). See `docs/specs/2026-05-22-ergoscript-2j-a-cost-oracle-design.md`. Layer-5 validation smoke walked clean to h=1000; surfaced first cost-drift at h=3850 (delta 24, ours undercharged) — that's 2j-b's input data. See `tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md`.

**Next: 2j-b (focused fix for h=3850 cost-drift)** — per-arm fixture
test against the surfaced site, source-read of the relevant sigma-rust
arms, GREEN with calibration patch. Subsequent fixes (2j-c, 2j-d, ...)
surface organically through deeper smoke walks per the TDD-loop pattern
2j-a established.

## Known limits

- **Cost-equivalence smoke depth.** 2j-a's smoke walked cleanly through h=1000 and surfaced the first cost-drift at h=3850 (validated; the wiring works). Walking past h=3850 requires the 2j-b fix (per-arm cost calibration); 2j-b/c/... iterate forward depth-by-depth.
- **No continuous mode.** The harness exits when it reaches `--max-height` (or the shim's reported tip at startup). It does NOT poll for new blocks. Re-running the invocation picks up from the checkpoint and walks any new blocks the snapshot has gained since the last run.
- **No TypeScript transaction parser yet.** The shim parses `Transaction::sigma_parse` via sigma-rust and ships the parsed bundle over CBOR. A pure-TS transaction parser is out of scope for 2j; the harness consumes the shim's parsed form directly.
- **No retries, no skip-and-continue, no per-block parallelism.** Halt-on-first-failure is the contract; aggregating divergences would defeat the differential-validator design.
- **`GET_HEADER` shortcut not implemented.** Resume-time walker-state rebuild deserializes full `BlockBundle`s (hundreds of KB each on recent blocks) to extract just the `headerBytes`. Correct but slow on resume; a future optimisation could add a `GET_HEADER` shim verb.

## References

- Design spec: [`docs/specs/2026-05-21-mainnet-validate-harness-design.md`](../../docs/specs/2026-05-21-mainnet-validate-harness-design.md)
- Project conventions: [`CLAUDE.md`](../../CLAUDE.md) at the repo root
- Library facts:
  - [`facts/scorex.md`](../../facts/scorex.md), [`facts/nipopow.md`](../../facts/nipopow.md), [`facts/avltree.md`](../../facts/avltree.md), [`facts/ergoscript.md`](../../facts/ergoscript.md)
- Reference implementations (consensus oracles):
  - `~/projects/ergo-node-rust/` (consensus pipeline)
  - `~/projects/ergots/external/sigma-rust/` (parser + evaluator + verifier reference)
