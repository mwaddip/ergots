# tools/mainnet-validate

Mainnet validation harness for the `@ergots/*` library stack. Pure stop-on-error. 2j-pre infrastructure for the upcoming phase 2j cost-calibration work.

A Rust shim (`shim/`) opens the user's `modifiers.redb` from a local `ergo-node-rust` checkout and streams CBOR `BlockBundle`s to a TypeScript harness (`harness/`). The harness walks the chain block-by-block, runs four validation passes per block (header / output round-trip / evaluate / verify-signature), and halts on the first divergence — writing a structured `error-report.json` for triage.

The harness is a developer tool, not a published surface. It is the loom on which 2j proper will calibrate per-arm costs and close the remaining sigma-rust divergences.

## Prerequisites

- A locally running (or fully synced + stopped) `ergo-node-rust` **full-archive** node, with both Headers and BlockTransactions present from genesis. Nodes started with `utxo_bootstrap = true` leave a gap from genesis to the snapshot height and the shim's startup check will refuse to proceed — only `utxo_bootstrap = false` archives walk cleanly. (`blocks_to_keep = 0` is a peer-handshake flag and does NOT gate local storage; empirically verified during T2.)
- Rust toolchain (stable). The shim crate sits OUTSIDE both the ergots and ergo-node-rust workspaces but path-deps into both; cargo resolves the graph transparently.
- Node.js ≥ 20. The harness is ESM, uses `node:fs`/`node:child_process`, and depends on the four `@ergots/*` workspace packages via `file:` deps.
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
  "errorCode": "sbox-ergo-tree-no-size",
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
| `output-roundtrip` | `validate-block.ts` per-output pass | `byte-roundtrip-mismatch`, `tree-version-derivation-failed`, `sbox-parse-failed`, `tree-parse-failed`, `tree-serialize-failed`, `sbox-ergo-tree-no-size` |
| `evaluate` | `validate-tx.ts` evaluate pass | per-`EvalError` code (see `facts/ergoscript-eval.md`) |
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
5. Resume by re-running the same `node dist/main.js ...` invocation **after fixing the library bug** (or deciding the divergence is expected and adjusting test expectations). The harness reads the checkpoint and starts at `lastValidatedHeight + 1`. If you want to re-validate from a specific height instead, pass `--start-height N` — this treats the run as fresh and zeroes the in-memory stats counter (but the checkpoint file on disk is overwritten on the next successful block).

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

## Current status: 2j-pre

The harness machinery is complete. T12's Layer-3 smoke walk against a 25 GB bootstrap-data snapshot (mainnet tip 1,790,510 at the time) surfaced **two scope gaps** that block clean validation of any block — every smoke attempt halted before validating ≥ 1 block. Header pass succeeded at every halt; the failure was always in the next pass. The shim ↔ harness IPC, UTXO sidecar forward-walk, and header validation are confirmed against real mainnet data through up to 3,848 contiguous blocks.

The two fix-list items become 2j proper's first work:

1. **TS — `packages/ergoscript/src/wire/parse-svalue.ts:278-287`:** `parseSValue(SBox)` rejects v0 ErgoTrees with `hasSize=false` (header byte's bit-3 clear) with `errorCode: sbox-ergo-tree-no-size`. The existing comment at line 280-282 ("all real on-chain boxes use v1+") is wrong — ≥99% of mainnet boxes use v0 P2PK trees with no size prefix. Confirmed by halts at heights 1, 1000, and 3849. Fixing this requires either (a) full body parse via the wire-layer `parseTree` machinery, or (b) a length-determining body walker. This is the single largest scope item before any block can validate cleanly.

2. **Shim — `tools/mainnet-validate/shim/src/block_walker.rs:535`:** at `ingest_block(3850)` the sidecar `MissingUtxo` for box `55274304…3c88aeda` reproduces deterministically across runs (T12 attempts 2 and 3 both halt there). The walker uses `ergo-lib`'s `out.box_id()` to key index inserts and `Transaction::sigma_parse` + `input.box_id` for lookups. Hypotheses: sigma-rust round-trip via `sigma_serialize_bytes` produces a different byte image than the on-chain box at insert time, OR a fork-replacement issue earlier in the chain left an orphan in the index. Triage path: dump `box_id` of every output at heights 3000-3849 from a Rust scan, compare to the box referenced by block 3850's first input.

Until these close, no smoke walk can demonstrate a clean ≥1-block validation. They are the front of 2j proper's fix-list.

## Known limits

- **No cost-integer exactness vs sigma-rust.** The harness exercises `evaluate` and `verifySignature` but does NOT compare the cost integers each `evaluate` accumulates against sigma-rust's `try_eval_out` oracle outputs on real mainnet workloads. Per-arm unit tests already enforce cost-integer equality at the arm level (see `packages/ergoscript/test/`); calibrating the Layer-C3 real-context distribution is phase 2j proper.
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
