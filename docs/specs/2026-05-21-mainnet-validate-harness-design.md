# Phase 2j-pre — Mainnet validation harness

**Status:** Draft v2 (2026-05-21). Reviewer pass applied; pivot to option (b) shim-side UTXO index after verification of finding #2.
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Build a two-process validation pipeline — a Rust shim reading the user's Ergo node redb database and a TypeScript harness walking the chain block-by-block — that exercises the full Phase 2 library surface (header parse/serialize/Autolykos-v2-verify, ErgoTree byte-roundtrip on every box, `evaluate` + `verifySignature` on every spending input) against chain-accepted mainnet data. Pure stop-on-error; resumable from checkpoint. Distinct from Phase 2j (cost-validation calibration via the same harness), which consumes this infrastructure.

**Preceding phase:** 2i-d (arm-count reframe + DecodePoint divergence documentation).
**Phase plan:** umbrella spec `docs/specs/2026-05-13-ergoscript-interpreter-design.md` does NOT cover this — added at the 2026-05-21 brainstorm session as a 2j precursor. After 2j-pre lands, 2j proper becomes "walk genesis-to-tip with this harness, fix everything it halts on; once a clean walk is achieved, layer sigma-rust as a second oracle for exact cost-integer matching."

---

## Goal

A two-process validation pipeline that establishes the live Ergo chain as **transitive sigma-rust oracle** for the ergots library at mainnet scale. Concretely:

- **Rust shim** (`tools/mainnet-validate/shim/`) opens the user's `ergo-node-rust` redb in read-only mode, exposes a single `GET_BLOCK <height>` request type, returns a `BlockBundle` (CBOR over length-prefixed stdout) carrying everything the harness needs to validate that block: header bytes, per-transaction signing message, per-input pre-resolved spent-box + signature + context extension, per-output canonical box bytes, per-tx data-input boxes pre-resolved by id.
- **TypeScript harness** (`tools/mainnet-validate/harness/`) spawns the shim once, reads a JSON checkpoint to determine start height, requests blocks sequentially, runs all four validation passes per block (header, output round-trip, evaluate, verifySignature), halts on the first divergence with a structured error report, exits non-zero. On clean re-run after a fix, picks up at the checkpoint.

The harness's measured throughput is governed by a `--sleep-ms N` knob the user can dial; OS-level controls (`nice`, `cpulimit`, `ionice`) layer on top.

The deliverable for THIS phase is the working machinery + a smoke-test walk over a range that's clean today. Walking the chain genesis-to-tip is 2j proper.

## Non-goals

- **Cost integer exactness vs. sigma-rust.** The chain enforces an upper-bound cost limit (`MAX_BLOCK_COST`); it doesn't publish per-script cost integers. The harness catches our over-counting (we halt if our cost > `MAX_BLOCK_COST` on a chain-accepted block) but cannot catch under-counting. Exact-match-to-sigma-rust on per-arm cost is 2j proper with sigma-rust as oracle.
- **Continuous monitoring / CI gate.** This is a developer-facing tool, run on demand. Promotion to CI is a future option, not in this scope.
- **Walking the chain to tip cleanly.** That's 2j. This phase delivers a working harness, smoke-tested on a range that's clean today.
- **TS-side transaction parser.** No `Transaction` type added to the library in this phase. Tx parsing is shim-side via sigma-rust. The wallet phase will likely be the consumer that adds TS tx parsing later.
- **Error-class differentiation.** Pure stop-on-error means we don't distinguish "bug" from "scope gap" in behavior. Reporting captures the class so triage knows where to look, but the harness halts either way.
- **Persistent corpus building.** The harness is a lean regression net, not a corpus-extraction tool. If 2j or a successor phase wants persistent indexing, that's separate work; the harness's pure-pipe shape doesn't paint us into a corner.
- **Browser-purity rules for the harness or shim.** Those apply only to `packages/*/src/`. The harness runs in Node (using `fs`, `child_process`, `cbor-x`, etc.) and the shim runs in Rust (with redb, sigma-rust, ciborium); browser compat is not a constraint for tooling.

## Motivation

Three forces converge on this work:

1. **Chain-as-oracle is stronger than treated.** The Ergo rust node validates every block before accepting: it parses every header, verifies Autolykos v2 PoW, parses every transaction, parses every box's ErgoTree, evaluates every input's script with the spending context, verifies the resulting SigmaProp against the signature. A block on the chain means all of that passed. Cross-validation: rust node + JVM Ergo independently accept the same chain from genesis to tip. So "chain accepted block N" ≡ "sigma-rust + JVM Ergo BOTH evaluated this byte-for-byte successfully." That's a stronger validation surface than any curated fixture corpus we could build.

2. **Phase 2 has substantial untested-against-mainnet surface.** The ergoscript package has 3,194 tests, 67-of-67-implementable arms wired, 44 method handlers, 64 EvalError codes — all validated against curated fixtures from sigma-rust's `try_eval_out` oracle. Curated fixtures are precise but narrow; mainnet exercises the same code paths against millions of trees, headers, and spending scripts. The 2g.5 C2 corpus uplift already surfaced one wave of method-handler demand; mainnet at scale will surface another.

3. **2j (cost calibration) presupposes a corpus + oracle.** Without harness infrastructure, 2j is itself "build the corpus + tooling + start fixing." With the harness as on-ramp, 2j collapses to "walk to tip; each halt-fix-resume cycle is a commit; once clean, layer sigma-rust as cost oracle for exact integer matching." This is cleaner separation: build the validation infrastructure once, use it for every downstream validation phase.

The user's running node already has redb + sigma-rust (`integration/ergots` cherry-pick discipline keeps small drift from our `external/sigma-rust/` snapshot). Operationally: stop the node OR copy the redb, point the shim at the path, walk. No new node config required as long as the node was NOT started with `utxo_bootstrap = true` (which would leave a gap genesis-to-snapshot-height). User confirmed full-archive empirically (2026-05-21) via REST probes at heights 1 / 100k / 500k. UTXO state IS maintained — but shim-side, not harness-side (see Decision 3).

The C2 mainnet-corpus impact of THIS phase is zero — no library changes ship in 2j-pre. The win is the infrastructure that subsequent phases depend on.

## Architecture

### Decision 1: Lean regression net (pipe-shaped, minimum state, stop-on-error, resumable)

**Decided:** Pure-pipe harness — fetch one block at a time, run all validations, advance checkpoint or halt; minimum harness state across iterations (parent header + 10-deep rolling header window for `ctx.headers`).

**Alternatives:** Corpus-aware-from-start (persist box bodies indexed by ErgoTree shape, capture spending contexts, plan for sigma-rust oracle integration). Middle path (cheap persistence today, indexing deferred).

**Why:** Immediate ROI on regression coverage; corpus extension can fall out later from the same machinery if 2j needs it; YAGNI. The pipe shape constrains design choices throughout (e.g., it's why request-response IPC beats streaming — the harness drives the pace).

### Decision 2: Validation scope C (full Phase 2 surface)

**Decided:** Header walk + ErgoTree byte-roundtrip + `evaluate` + `verifySignature` end-to-end on every spending input.

**Alternatives:** Scope A (header walk + ErgoTree round-trip only, ~30% surface); Scope B (A + `verifySignature` on P2PK spends only, ~40% surface).

**Why:** Chain-as-oracle works for value-correctness across `evaluate` and `verifySignature` together — chain-accepted ≡ sigma-rust produced a SigmaProp that the signature verifies, so our equivalent produces the same or halts. No separate sigma-rust oracle needed for value correctness in this phase. Per-tx data resolves all the spending-context fields the evaluator needs (height, preHeader, inputs, outputs, dataInputs, selfBox, extension, headers).

### Decision 3: redb shim with shim-side forward-walking UTXO index (pivot from v1)

**Decided:** Small Rust binary reading the node's redb files in read-only mode, exposing a CBOR-over-stdin/stdout protocol. **Two redb files** (per reviewer source-read of `ergo-node-rust`'s storage layout):

- `store.redb` — `RedbModifierStore` from `ergo-node-rust/store/src/redb.rs`. Tables: `primary` keyed by `(type_id u8, id [u8;32])`, `height_index` keyed by `(type_id u8, height u32)`, `header_forks`, `header_scores`, `best_chain`, `chain_meta`, `peer_db`. Modifier type IDs from `chain/src/section.rs:12-15`: 101 = Header, 102 = BlockTransactions, 104 = ADProofs (NOT downloaded in UTXO mode — filtered out per `chain/src/section.rs:47-56`), 108 = Extension. The shim consumes 101 (header bytes), 102 (block tx bytes), 108 (extension bytes for per-block parameters).
- `state.redb` — `RedbAVLStorage` (the UTXO AVL+ tree). **NOT used directly by the shim** because (per reviewer source-read of `validation/src/utxo.rs:252-273` + `state/src/storage.rs:888-899`) the tree holds only the current-tip UTXO set; once a box is spent, it is removed. No historical spent-box archive exists.

**Spent-box resolution: shim-side forward-walking UTXO index** (option (b) per reviewer's enumeration; the only path that works for a typical full-archive UTXO-mode node without an external indexer addon):

- Shim opens `store.redb` at startup, reads `tip` height for modifier type 101 (header).
- On `GET_BLOCK <H>`, the shim ensures its internal UTXO index has been advanced to height `H-1`. If walking sequentially from a prior call, this is one block of progress. If starting fresh or jumping ahead, the shim walks from genesis (or from a persisted index sidecar — see Decision 11) up to `H-1`, ingesting each block's BlockTransactions and updating the index.
- Per block during the walk: for each transaction's outputs, ADD `box_id → box_bytes` to the index; for each transaction's inputs, LOOKUP `box_id → box_bytes` (must be present because the chain has been validated by the node — if absent, the shim emits an error indicating chain corruption or shim bug), then REMOVE from the index after capturing the spent-box bytes.
- At block H, BlockBundle's `inputs[i].spentBoxBytes` is the value captured at the moment of removal.
- Index state size at mainnet tip: ~6 million UTXO entries × ~200 bytes each ≈ 1.2 GB in memory. Sidecar persistence (see Decision 11) keeps disk footprint at ~5 GB to allow fast restart.

**Prerequisite — node must have BlockTransactions from genesis.** Verified empirically during v2 development (2026-05-21) via REST probe of the user's running node: `/blocks/at/1`, `/blocks/at/100000`, `/blocks/at/500000` all return 200 with full block content; `fullHeight == headersHeight == 1,790,449`. The only mechanism in `ergo-node-rust` that produces a node missing low-height BlockTransactions is `utxo_bootstrap = true` (per `src/main.rs:1838-1841` — validator created AFTER snapshot download; no automatic backfill). The `blocks_to_keep` setting is purely handshake-side (per grep across the rust node: 4 uses, all in `p2p/src/transport/handshake.rs` + `main.rs`'s config read/log) and does NOT gate local storage — `blocks_to_keep = 0` is empirically a no-op for the data layer. T2's runtime check (`tip(101)` vs `tip(102)`) is authoritative.

**Alternatives considered:**
- **REST API with indexer addon** (`addons/indexer/` runs as a separate process, ingests to postgres/sqlite, exposes its own REST API on top). Adds an external process + storage layer; reverses the "library reads the same bytes the node wrote" goal because indexed data has been transformed.
- **REST API to JVM Ergo with indexer mode enabled.** Requires running a JVM node alongside; not aligned with the rust-node-centric setup.
- **Restrict to unspent-only.** Validates only ~6M current-tip boxes; loses all spending history; fails the "test Phase 2 against mainnet at scale" goal.
- **ADProofs-based per-block reconstruction.** Would let the shim derive spent-box bytes from each block's ADProofs modifier without maintaining a UTXO index. But UTXO-mode nodes don't download ADProofs (`required_section_ids()` filters them out for `StateType::Utxo`), so this path requires a Digest-mode node — different operational profile from the user's setup.

**Why option (b):** The only path that works for the user's confirmed node profile (full-archive UTXO mode). Shim-side state stays bounded and well-defined; harness-side state stays at the "minimum state" framing (parent header + rolling header window). Forward-walk is sequential by construction, which aligns with the harness's per-block walk pattern — no random-access surprises.

### Decision 4: Pure stop-on-error (purist)

**Decided:** Every divergence halts the walk, regardless of class. Library bugs, scope gaps (method not yet wired, arm not yet implemented), consensus-edge (cost > limit), and spec-ambiguities (eval produces a SigmaProp that verify rejects) all halt; reporting distinguishes them.

**Alternatives:** Differentiated handling — library bugs halt, scope-gap classes log and continue. Avoids early halts on the first unimplemented method; lets the walk reach further on day one.

**Why:** Each halt becomes a concrete fix-list entry. End state of a clean walk proves: no consensus-direction bugs (we'd halt on any over-counting cost, any signature-verify failure, any parse divergence); every executed method handler has been fingerprinted (we'd have halted otherwise); the residual unimplemented surface is exactly what the chain DOESN'T demand. The first walk halts within the first few blocks on the first scope gap; that's expected and is the point. The harness drives the spec to honesty.

### Decision 5: Phase split — harness-build (this) → 2j walk-to-tip (next)

**Decided:** Build the harness in this named phase (2j-pre). The iterative walk-to-tip work — each halt-fix-resume cycle — is 2j proper.

**Alternatives:** Single merged phase ("2j: cost calibration"). Sub-phase nesting (2j.0 = harness, 2j.1+ = walk).

**Why:** The harness is the on-ramp to 2j, not an alternative. Naming them as distinct phases preserves the project's "spec-then-implement" cadence: 2j-pre delivers a tool + machinery test; 2j delivers the chain-validated library surface using that tool. Each commit in 2j is a halt-fix-resume cycle that's independently meaningful.

### Decision 6: Tx parsing + UTXO bookkeeping + parameters parsing — all shim-side via sigma-rust

**Decided:** The shim depends on sigma-rust as a Rust crate (pointing at `external/sigma-rust/` `integration/ergots`) AND on `ergo-node-rust`'s `chain`/`store` crates for the redb schema. The shim does all chain-aware work:

- **Block + transaction parsing.** Via sigma-rust's `Transaction::sigma_parse` and `ergo-node-rust`'s `BlockTransactions` section parsers.
- **Signing-message derivation.** Via sigma-rust's `Transaction::bytes_to_sign()` at `ergo-lib/src/chain/transaction.rs:184-191` — confirmed by reviewer to return one message shared by all inputs of a tx, derived by blanking proofs and re-serializing.
- **Spent-box + data-input resolution.** Via the shim-side UTXO index (per Decision 3): outputs ADD to the index on creation, inputs LOOKUP + REMOVE on spend; data-inputs LOOKUP without removal.
- **Per-input context-extension extraction.** `ContextExtension` per `ergotree-ir/src/chain/context_extension.rs:23-26` is an `IndexMap<u8, Constant>` — keys are `u8` (max 256 per input), values are sigma-rust `Constant` structs. Shim emits each input's extension as `Map<u8 varId, Constant bytes>` where the bytes are the canonical `Constant::sigma_serialize` encoding; the harness calls `parseSValue(parseSType(reader), treeVersion, reader)` to recover SValues. (Reviewer-corrected from v1's `u32` varId assumption.)
- **Per-block parameters extraction.** Each block's Extension (modifier type 108) carries the parameters table including `MaxBlockCost` (see Decision 9). Shim parses via sigma-rust's `Parameters::max_block_cost()` and includes the per-block value in BlockBundle so the harness can set `jitCostLimit` correctly per-block.

The TS library and harness see only pre-resolved byte arrays + integer parameters; they never need to parse a Transaction directly.

**Alternatives:** TS-side tx parser added to the ergots library in this phase. Larger spike (~tx serialization is multi-hundred LOC in sigma-rust); library gains a `Transaction` public surface; symmetric port purity with the rest of the library; useful eventually for the wallet phase.

**Why:** Faster harness build; library scope stays focused on what Phase 2 already shipped; TS tx parser becomes its own future phase when wallet work needs it. Trusting the shim to provide signing-message bytes is honest about the dependency — we're testing our library's parse/eval/verify against sigma-rust's reference data, with the shim acting as the data-extraction layer.

### Decision 7: IPC architecture — long-lived shim, request-response, per-block bundles

**Decided:** Spawn the shim once at harness start; harness sends `GET_BLOCK <height>` ASCII commands on stdin; shim emits length-prefixed CBOR responses on stdout; shim stays alive for the duration of the walk.

**Alternatives:**
- Streaming shim (shim walks redb forward, emits bundles in order; harness signals "next" or "stop"). Slightly less round-trip latency; resume mid-bundle is awkward; harness loses control over pacing details.
- Fine-grained request-response (`get_header`, `get_tx`, `get_box`, `get_signing_message` as separate calls). Maximally flexible; chatty; no real workload benefit since the harness always wants one block at a time.

**Why:** Balanced. The shim does the bundling work shim-side regardless (sigma-rust is parsing transactions, resolving inputs, computing signing messages — those have to happen somewhere). Per-block granularity matches the natural unit of work (a halt belongs to a specific height). Harness drives the pace, giving us a clean place to put rate limiting.

### Decision 8: Wire protocol — ASCII line commands + length-prefixed CBOR responses

**Decided:**
- Request: ASCII line ending in `\n`, e.g. `GET_BLOCK 12345\n` or `GET_TIP_HEIGHT\n`.
- Response: 4-byte big-endian length prefix, then N bytes of CBOR data.
- CBOR top-level shape: `{ok: true, ...}` on success, `{ok: false, error: {code, message}}` on shim-side error.

**Alternatives:** Pure binary protocol (Scorex-style VLQ-prefixed fields — would reuse `@ergots/scorex` codec but commit us to a hand-spec'd shape); JSON with hex-encoded bytes (debuggable but slow and bandwidth-heavy at mainnet scale); MessagePack.

**Why:** CBOR has well-tested libraries on both sides (`cbor-x` in TS, `ciborium` in Rust); binary so no hex inflation on byte fields; standard so the shape doesn't need bespoke documentation. ASCII commands are debuggable by hand — pipe `echo "GET_BLOCK 100"` into the shim and read the bytes back.

### Decision 9: `jitCostLimit` sourced per-block from each block's voted parameters

**Decided:** `MAX_BLOCK_COST` is NOT a static constant in sigma-rust. Per reviewer source-read of `ergo-lib/src/chain/parameters.rs:21,79-81,166` + `ergotree-interpreter/src/eval.rs:849`, it is a per-block voted `i32` parameter sourced from the block's Extension parameters table. The default in sigma-rust's `Parameters::Default` is 1,000,000; mainnet has voted this much higher (eval.rs:849 comments "~1 billion units, node-configurable"). The harness MUST NOT hard-code a value.

**How the harness gets it:** The shim parses each block's Extension (modifier type 108) via sigma-rust's parameters-extraction logic and includes `parameters.maxBlockCost: number` as a field of `BlockBundle`. The harness uses this value as the per-script `jitCostLimit` when constructing `EvalContext` for that block's spending inputs.

**Alternatives:**
- Hard-code mainnet's "current" voted value as a constant. Brittle — mainnet has voted multiple times; pinning silently drifts when a new vote lands.
- Read once at startup from the tip block and reuse. Wrong for historical blocks where the voted value differed.
- No cap. OOM/hang risk on adversarial inputs.

**Why:** The harness reproduces consensus enforcement per-block. Our cost exceeding the block's voted limit IS the over-counting bug surfacing. Sourcing per-block also future-proofs against further consensus parameter votes. Reviewer correction from v1: v1 said "~7,000,000 JIT cost units" — wrong by ~3 orders of magnitude AND wrong about staticness.

The exact `EvalError` code on cost-limit-exceeded follows the existing evaluator behavior (see `facts/ergoscript-eval.md`); no new error class introduced.

### Decision 10: Rate limit — harness-side `--sleep-ms N` + user can layer OS-level

**Decided:** Single harness CLI flag: `--sleep-ms N` (sleep N ms between block requests). Defaults to 0 (no throttle). User layers `nice` / `cpulimit` / `ionice` at OS level if more granular CPU/IO controls are wanted.

**Alternatives:** Token-bucket `--max-blocks-per-sec N` (smoother but more code); `--max-cpu-percent N` (hard to implement reliably without invoking OS primitives); no harness knob (purist relies on OS-only throttling).

**Why:** Simplest implementation; covers the user's stated concern ("just in case the harness ends up using my entire cpu / io pool"); doesn't over-engineer. The user can compose with OS tools for fancier policy.

### Decision 11: Checkpoint — minimal harness JSON, rolling-headers NOT persisted. Sidecar redb for shim's UTXO index.

**Decided (harness side):** `checkpoint.json` (gitignored) updated after every successful block validation. Fields: `lastValidatedHeight`, `tipHeightAtStart`, `lastValidatedAt`, `shimPath`, `libraryVersions` (per-package version stamp), `stats` (totalBlocks, totalTxs, totalBoxesValidated, totalSpendsValidated, startedAt, elapsedMs). The rolling 10-header window for `ctx.headers` is NOT persisted; the harness re-fetches headers `H-9..H-1` from the shim on resume before continuing at `H = lastValidatedHeight + 1`.

**Decided (shim side):** Shim's UTXO index (from Decision 3) IS persisted to a sidecar redb file `tools/mainnet-validate/utxo-index.redb` (gitignored). On startup, the shim opens this sidecar (creating it if absent), reads its current "indexed up to height N" marker, and walks forward from N+1 to the harness-requested height. Without sidecar persistence, every restart re-walks from genesis (~minutes-to-hours of startup time at mainnet tip). With sidecar, restart cost is O(blocks-since-last-walk).

**Alternatives:** Persist the rolling header bytes inline (saves 10 round-trips on resume; checkpoint becomes ~5-10 KB instead of ~1 KB). Persist richer harness state (UTXO summary — redundant with shim sidecar, observed methods). Skip shim sidecar (deterministic but slow restart).

**Why (harness side):** Minimum-state framing per the user's "keep what's necessary" constraint. Re-fetch cost is 10 shim calls (~milliseconds) — negligible compared to per-walk wall time. Persisting headers risks staleness if the user copies a newer redb mid-walk.

**Why (shim side):** The forward-walk pattern is naturally append-only (boxes added on creation, removed on spend). redb is well-suited to this. ~5 GB disk footprint at mainnet tip is acceptable. Critical for resume-driven workflow where the user fixes a bug and restarts the harness frequently.

### Decision 12: Error report — structured JSON, overwritten on halt, deleted on tip-reach

**Decided:** `error-report.json` (gitignored). Existence ≡ "last run halted, here's the divergence." Fields: `timestamp`, `height`, `phase` (one of `header` / `output-roundtrip` / `evaluate` / `verify-signature` / `shim`), `errorClass`, `errorCode`, `message`, `stack`, `location` (txIndex, txId, inputIndex|null, outputIndex|null, spentBoxId|null, ergoTreeHex|null), `bundleExcerpt` (headerHex, txHex, spentBoxHex — enough to reproduce offline).

**Alternatives:** Rich block-bundle preservation (write the full BlockBundle to disk on halt; ~MB per failure; redundant since the shim can re-fetch by height); log-only (no structured report; harder to triage offline).

**Why:** Enough info to triage without re-running the harness. Shim is always re-fetchable for full data if needed. Single file (not append-only log) because pure stop-on-error means only one error at a time.

### Decision 13: Repo location — `tools/mainnet-validate/` (outside npm + Cargo workspaces)

**Decided:**
```
tools/mainnet-validate/
  README.md
  shim/                   Rust crate
    Cargo.toml            (separate from fixture-gen's workspace)
    src/main.rs
    src/protocol.rs
  harness/                TS, not in npm workspace
    package.json
    tsconfig.json
    src/main.ts
    src/checkpoint.ts
    src/validate-block.ts
    src/validate-tx.ts
    src/protocol.ts       (mirror of shim's binary protocol)
  .gitignore              (checkpoint.json, error-report.json, redb-copy/)
```

**Alternatives:** New npm package `@ergots/mainnet-validate-harness`; integrate the Rust shim into `fixture-gen/`'s Cargo workspace; top-level `harness/` directory.

**Why:** Not published — the harness is a dev tool, not a library. Different runtime model (process spawning, file IO) from the published packages. Keeping it outside the npm workspace means it doesn't pollute the workspace install. Keeping the shim out of `fixture-gen/` keeps `fixture-gen/`'s concern (oracle fixture generation) cleanly separated from the harness's concern (mainnet validation).

### Decision 14: Edge cases — explicit handling for genesis, V1-headers-below-activation, coinbase, pruned-node-missing-UTXO

**Decided:**
- **Genesis (`height === 0`)**: skip parent-link check (no parent).
- **V1 headers below V2 activation (`height < 417792` AND `version === 1`)**: parse-roundtrip + parent-link; SKIP `verifyAutolykosV2`. Mirrors existing library structural-only acceptance of pre-activation V1 headers; the harness catches `AutolykosV1NotSupportedError` specifically for this case, halts on any other error class for these blocks.
- **Coinbase / mining-reward txs**: per-input loop is empty by design; per-output loop runs normally. No special-case code.
- **Reaching tip**: shim returns `{ok: false, error: {code: "past-tip"}}`; harness writes final checkpoint with `tipReachedAt`, deletes `error-report.json`, exits 0. Distinct from halt.
- **Pruned-node missing UTXO**: shim returns `{ok: false, error: {code: "missing-utxo", boxId}}`; halt as shim-side error.

**Alternatives:** Reject non-trivially (e.g., halt on V1 headers as a "feature not supported" deliberate gap); special-case coinbase txs (skip output validation under "miner reward" exemption).

**Why:** Mirror existing library semantics — `verifyProof` already accepts V1 headers structurally below the activation height, so the harness should too. Coinbase txs are real chain history; their outputs MUST byte-roundtrip just like any other box. Reaching tip is normal completion, not a halt.

## Error taxonomy

The harness surfaces two distinct error sources, both routing to the same `error-report.json` shape but with different `phase` and `errorClass`:

### Shim-side errors (CBOR `{ok: false, error: ...}`)

| `error.code` | Meaning |
|---|---|
| `past-tip` | Requested height > current chain tip in redb. Harness treats as normal completion. |
| `missing-utxo` | Spent box's id is referenced by a tx input but not in redb. Indicates the user is running a pruned node. Halt with `phase: "shim"`. |
| `missing-block` | redb has no record at the requested height (mid-chain gap). Halt. |
| `parse-failed` | sigma-rust panicked or returned `Err` parsing block / tx / box bytes. Halt — indicates sigma-rust + redb disagree. |
| `redb-error` | redb IO error (file locked, permission denied, etc.). Halt. |

### Library-side errors (TS throws caught by harness)

Each is the existing thrown class from the ergots library; the harness catches and writes the report. No NEW error classes are introduced by 2j-pre.

| Throwing API | Likely error classes | Likely codes |
|---|---|---|
| `parseHeader`, `parseAutolykosSolution` | `ReaderError` | `truncated`, `vlq-overflow`, `slice-out-of-bounds`, `array-too-large` |
| `verifyAutolykosV2` | `AutolykosV1NotSupportedError` (V1 case, caught and skipped for height < 417792) | `autolykos-v1-not-supported` |
| `parseTree`, `serializeTree` byte-mismatch | `ErgoTreeParseError`, `ExprParseError`, `STypeParseError`, `SValueParseError` | per existing wire-layer taxonomy (see `facts/ergoscript-wire.md`) |
| `evaluate` | `EvalError`, `ExprTpeError` | per `facts/ergoscript-eval.md` (64 codes) — including `'method-not-implemented'`, `'not-implemented-yet'`, `'cost-limit-exceeded'` (or equivalent), `'register-type-mismatch'`, etc. |
| `verifySignature` | `VerifyError` OR returns `false` | 8 codes per `facts/ergoscript-sigma.md`; the harness treats a `false` return on a chain-valid signature as halt-equivalent (manufactured error class `VerifierResultFalse` or similar). |

The harness's halt logic catches `Error` broadly, inspects `instanceof` + `.code`, and routes to the `phase` accordingly. No new library-side throws — the harness adds zero error classes; it's a pure consumer.

## Test strategy

### Layer 1 — Shim unit tests (Rust)

`tools/mainnet-validate/shim/src/protocol.rs::test_mod`:
- `BlockBundle` CBOR encode-decode round-trip with synthetic data.
- Protocol framing: write a request, read the length-prefix, read N body bytes, assert match.
- Error path: encode `{ok: false, error: {code: "past-tip"}}` and confirm shape.

These can run via `cargo test` inside the shim crate.

### Layer 2 — Harness unit tests (TS)

`tools/mainnet-validate/harness/test/`:
- Checkpoint read/write round-trip.
- Error-report serialization shape (all `phase` values, all field combinations).
- `EvalContext` construction from a synthetic `BlockBundle`: verify all fields populated correctly (height, selfBox, inputs, outputs, dataInputs, preHeader, headers, extension).
- Rolling-header window: append + truncate to 10.

Vitest config (node-only; no jsdom needed for tooling).

### Layer 3 — End-to-end smoke

The deliverable test. With the user's redb available:
1. Wire harness + shim together.
2. Walk at least one full block successfully (header validates, all outputs roundtrip, all inputs evaluate + verifySignature pass).
3. Confirm IPC round-trip works (no protocol mismatches, no truncated reads).

### Layer 4 — Halt path

Deliberate fault injection to confirm error-report fires:
- Point at a non-existent redb path → shim fails to open → harness reports `phase: "shim"`, `error.code: "redb-error"`.
- Temporarily break a library function in a branch (e.g., `parseTree` always throws) → harness reports `phase: "output-roundtrip"`, errorClass `ErgoTreeParseError`.
- Confirm error-report.json content matches expected shape.

### Layer 5 — Resume path

After a halt:
1. Read checkpoint.json — confirm `lastValidatedHeight` is correct.
2. Restart harness — confirm 10 rolling-header re-fetches happen.
3. Walk continues at `lastValidatedHeight + 1`.

### Layer 6 — Tip-reach path

Run the harness against a redb with a known small tip height (or cap the harness's walk at `--max-height N` for testing) → confirm clean exit, `tipReachedAt` set in checkpoint, error-report.json deleted.

### Non-tests: chain as corpus

There is NO separate test corpus for the harness's library-validation work. The chain IS the corpus. Every block successfully validated is a real test. Halts ARE the test failures, surfacing real divergences. The smoke test (Layer 3) merely proves the machinery works; the value of the harness comes from running it.

## Source mapping

This phase consumes existing sigma-rust + ergo-node-rust + ergots-library APIs. No new public APIs are introduced. All source paths in this section have been reviewer-verified.

### sigma-rust (pinned `external/sigma-rust/` `integration/ergots`)

| Used by shim | Source path | Purpose |
|---|---|---|
| `Transaction::bytes_to_sign` | `ergo-lib/src/chain/transaction.rs:183-191` | Per-tx signing message derivation. Takes a parsed `Transaction`, blanks all proofs via `input_to_sign()`, re-serializes via `sigma_serialize_bytes()`. Single message shared by all inputs of the tx. Returns `Result<Vec<u8>, SigmaSerializationError>`. |
| `Transaction::sigma_parse` / `sigma_serialize_bytes` | `ergo-lib/src/chain/transaction.rs` | Canonical tx wire format; shim parses tx bytes from BlockTransactions, walks inputs/outputs/dataInputs. |
| `ErgoBox::sigma_serialize_bytes` | `ergotree-ir/src/chain/ergo_box.rs` | Canonical box wire format; shim emits these bytes per-input/per-output without modification. |
| `ContextExtension` | `ergotree-ir/src/chain/context_extension.rs:23-26` | `IndexMap<u8, Constant>`. Keys are `u8` (max 256 per input), values are sigma-rust `Constant` structs. Shim emits each entry as `{varId: u8, constantBytes: Vec<u8>}` via `Constant::sigma_serialize`. |
| `Parameters::max_block_cost` | `ergo-lib/src/chain/parameters.rs:21,79-81,166` | Per-block voted `i32` parameter sourced from Extension. Default 1,000,000; mainnet voted ~1,000,000,000. Shim parses + emits per-block. |
| `PreHeader::from(&Header)` | `ergo-chain-types/src/preheader.rs:26-38` | Field-projection of current block's Header (NOT serialization-roundtrip). `PreHeader { version, parent_id, timestamp, n_bits, height, miner_pk, votes }`. |
| `Context::headers` field | `ergotree-ir/src/chain/context.rs:40` | Fixed-size `[Header; 10]` in sigma-rust. TS library relaxes to `Header[]` per `packages/ergoscript/src/eval/eval-context.ts:62-63`. For block H, headers are the 10 preceding (not including H), with `headers[0]` = most recent prior (H-1). |
| `Context::activated_script_version` | `ergotree-ir/src/chain/context.rs:66-72` | Block version - 1; independent from `ErgoTree.header.version` (the tree version). Harness uses `tree.header.version` for `treeVersion`, auto-derived by `evaluate(tree, opts)`. |

### ergo-node-rust redb schema (TWO files; reviewer-corrected from v1)

| Used by shim | Source path | Purpose |
|---|---|---|
| `RedbModifierStore` | `ergo-node-rust/store/src/redb.rs` | The `store.redb` file. Tables: `primary` keyed by `(type_id u8, id [u8;32])`, `height_index` keyed by `(type_id u8, height u32)`, `header_forks`, `header_scores`, `best_chain`, `chain_meta`. |
| `RedbModifierStore::tip(type_id: u8)` | `store/src/lib.rs:78-81` | Returns canonical chain tip height for the given modifier type. Shim uses `tip(101)` for header tip → harness's `tipHeightAtStart`. |
| `RedbModifierStore::best_header_at(height)` | `store/src/lib.rs:182-186` | Canonical header id at given height (resolves forks). |
| `RedbModifierStore::read_header_at(height)` | `store/src/lib.rs:208-211` | Canonical header bytes at given height. |
| `RedbModifierStore::get(type_id, id)` | `store/src/lib.rs` (`primary` table lookup) | Fetch BlockTransactions (102) or Extension (108) modifier by computed id. Modifier id derivation: `Blake2b256(type_id || header.id || section_root)` per `chain/src/section.rs:60-66`. |
| Modifier type IDs | `chain/src/section.rs:12-15` | 101 = Header, 102 = BlockTransactions, 104 = ADProofs (UTXO-mode does NOT download per `:47-56`), 108 = Extension. |
| `state.redb` (`RedbAVLStorage`) | `state/src/storage.rs`, `state/src/tables.rs:1-13` | **NOT used by the shim.** Current-tip UTXO set only; once a box is spent it is removed (`storage.rs:888-899`). Verified in v2 via reading `validation/src/utxo.rs:252-273` (validator captures spent-box bytes ephemerally during block application; not persisted). |

### ergots library (this monorepo)

| Used by harness | Source path | Purpose |
|---|---|---|
| `parseHeader`, `serializeHeader`, `verifyAutolykosV2` | `@ergots/scorex` | Header validation pass |
| `parseTree`, `serializeTree` | `@ergots/ergoscript` | Output ErgoTree byte-roundtrip |
| `parseSValue(SBox, treeVersion, reader)` | `packages/ergoscript/src/wire/parse-svalue.ts:93` (reviewer-verified accessible via workspace import) | Box parse → extract `.ergoTree` field |
| `parseSValue(parseSType(reader), treeVersion, reader)` | (same) | Per-input context-extension value parsing — recovers SValue from `Constant::sigma_serialize` bytes emitted by shim. |
| `evaluate`, `evaluateWith`, `makeContext` | `@ergots/ergoscript` | Per-input script evaluation. `EvalOpts` field shapes per `facts/ergoscript-eval.md`. |
| `verifySignature` | `packages/ergoscript/src/eval/sigma/verifier.ts:418` (reviewer-verified) | Per-input signature verification. |
| `EvalContext` field shapes | `facts/ergoscript-eval.md` | Harness constructs from `BlockBundle`. All required fields (height, selfBox, inputs, outputs, dataInputs, preHeader, headers, extension) accessible from public `EvalOpts`. |
| `AutolykosV1NotSupportedError` | `@ergots/scorex` | Caught + skipped for V1-below-activation |

## Execution order

Tasks ordered simplest → most cross-cutting, mirroring 2i-d's per-task commit cadence:

```
T1   PLAN.md committed (overwrites 2i-d plan)
T2   Rust shim scaffolding: Cargo.toml depending on sigma-rust (path-dep on
     external/sigma-rust/) + ergo-node-rust crates (chain, store) + redb +
     ciborium. Opens store.redb path from argv; reads stdin line, writes
     stub response; main.rs + protocol.rs.
     T2 startup check: tip(101) and tip(102) both nonzero → full-archive
     confirmed; else emit prerequisite-violation error and exit.
T3   Shim: GET_TIP_HEIGHT command (returns tip(101)) + sidecar utxo-index.redb
     scaffolding (open if exists; create empty if not; track "indexed up to
     height" marker + source-store content-hash).
T4   Shim: GET_BLOCK <height> command — header bytes only, no transactions
     yet. Uses best_header_at(h) + read_header_at(h). Layer 1 unit test for
     protocol framing.
T5   Shim: GET_BLOCK extension — for each block from current sidecar marker
     up to requested height, fetch BlockTransactions modifier 102 via
     get(102, blake2b256(102 || header.id || transaction_root)), parse via
     sigma-rust, walk transactions:
       - For each tx, compute signing message via Transaction::bytes_to_sign()
       - For each output, ADD box_id → box_bytes to sidecar UTXO index
       - For each input, LOOKUP box_id → box_bytes from sidecar, capture,
         REMOVE
       - For each dataInput, LOOKUP (no remove)
     Also fetch Extension modifier 108 via similar id derivation; parse
     parameters table; include parameters.maxBlockCost in BlockBundle.
     Advance sidecar's "indexed up to height" marker after each successful
     block. Per-input context-extension extraction included.
T6   TS harness scaffolding: package.json, tsconfig.json, main.ts that
     spawns the shim, sends GET_TIP_HEIGHT, prints the response.
T7   Harness: checkpoint.ts (read/write/round-trip tests) + error-report.ts
     (structured halt) + library-version stamping.
T8   Harness: validate-block.ts — header pass (parseHeader + serializeHeader
     byte-equal + verifyAutolykosV2 with V1-below-activation skip +
     parent-link, skip parent-link at H=0).
T9   Harness: validate-block.ts — output round-trip pass (per-output
     parseSValue(SBox) + parseTree + serializeTree byte-equal).
T10  Harness: validate-tx.ts — evaluate + verifySignature pass. EvalContext
     construction from BlockBundle (height from block; selfBox; inputs from
     same-tx spent boxes; outputs from same-tx output bytes; dataInputs;
     preHeader from field-projection of current Header; headers from rolling
     window; extension as parsed SValue map; jitCostLimit from BlockBundle's
     parameters.maxBlockCost; treeVersion auto-derived from
     tree.header.version per evaluate(tree, opts)).
     T10 must source-read sigma-rust's ctx.headers padding convention for
     H < 10 before encoding the window's first-10-blocks behavior.
T11  Harness: main.ts walk loop — sequential height advance, rate-limit
     sleep, halt-and-write-report on any catch.
     CLI flags: `--start-height N` (override checkpoint, useful when
     pointing the shim at a UTXO-bootstrapped data copy that's missing
     genesis-to-snapshot-height; harness skips ahead to N), `--max-height M`
     (cap the walk for fast smoke tests; default = chain tip),
     `--sleep-ms N` (rate-limit; default 0).
T12  Layer 3 smoke test: walk from genesis (or --start-height N) until
     first halt OR until --max-height M reached. Confirm machinery.
T13  Layer 4/5/6 path tests: deliberate fault injection (halt path),
     resume path, tip-reach path.
T14  README.md for tools/mainnet-validate/ with operator docs (how to
     set up, how to run, how to interpret halts).
T15  SESSION_CONTEXT.md + HANDOFF_PROMPT.md sweep + facts/ pass (if any
     facts need a cross-reference to the harness's existence) + push.
```

Expected commit count: ~14-15.

## Risk hotspots

1. **redb schema drift.** Reviewer-confirmed schema for store.redb (RedbModifierStore at `ergo-node-rust/store/src/redb.rs`). May still drift if the user's node is on a different `ergo-node-rust` HEAD than the spec assumes. Mitigation: T2 opens store.redb + queries `tip(101)` as the first runtime check; mismatched schema fails fast. Reviewer-verified APIs cited in the Source mapping table.

2. **UTXO-bootstrap prerequisite (NOT `blocks_to_keep`).** If the user's node was started with `utxo_bootstrap = true` (per `src/main.rs:1838-1841`, validator created AFTER snapshot download), `store.redb` will be missing BlockTransactions for the genesis-to-snapshot-height range. No automatic backfill mechanism exists. `blocks_to_keep` was thought to be the prereq in earlier v2 drafts; verified during v2 review to be purely handshake-side (4 uses across the rust node, all in handshake/config-read paths; no storage-gating code). User's actual node at v0.6.2 confirmed full-archive empirically (full block content available at heights 1, 100k, 500k via REST). Mitigation: T2 detects the bootstrap case at startup by checking `tip(102)` (BlockTransactions tip) against `tip(101)` (header tip). If BlockTransactions tip starts well above 0, the shim reports the lowest-available height and the harness's `--start-height` must be ≥ that value.

3. **Shim's UTXO index correctness.** The forward-walk LOOKUP+REMOVE pattern must mirror the chain's actual spend semantics exactly. If the shim's accounting drifts (e.g., a missed Insert, a double Remove), spent-box bytes returned to the harness will be wrong and the harness's `verifySignature` will fail — but the bug is shim-side, not library-side. Mitigation: shim unit tests round-trip the UTXO index on a small synthetic chain; first ~1000 blocks of smoke-test (Layer 3) is the integration check.

4. **Shim sidecar persistence cache coherency.** If the user copies a new redb (or resyncs the node) between harness runs, the sidecar `utxo-index.redb` will be stale relative to the new `store.redb`. Stale sidecar → wrong spent-box bytes → spurious harness halts. Mitigation: shim records the source `store.redb` path + a content-hash in the sidecar's chain_meta; mismatch on open triggers a full rebuild. PLAN.md to spec the exact invalidation policy.

5. **`ctx.headers` padding for blocks at heights < 10.** sigma-rust's `Context::headers` is a fixed `[Header; 10]` (`ergotree-ir/src/chain/context.rs:40`). For block H < 10, sigma-rust must synthesize headers for "blocks before genesis." Exact convention TBD — reviewer flagged 85% confidence; needs verification before T10. Options: pad with genesis-replicated headers; pad with all-zero headers; or skip evaluating blocks H < 10. Mitigation: T10 source-reads sigma-rust's context construction for H < 10; encodes the convention exactly.

6. **V1 headers below activation height.** Library skips PoW verify but still parses + serializes; harness must mirror. The 417792 activation height is mainnet-specific; testnet activates differently. Mitigation: harness `--network mainnet|testnet` flag; activation height table.

7. **Pure stop-on-error means early halts.** First walk almost certainly halts within the first few thousand blocks on the first unimplemented method handler. The smoke-test deliverable (Layer 3) must NOT require walking past the first halt — it requires walking AT LEAST ONE block successfully. Mitigation: smoke test asserts "≥ 1 block fully validated, machinery works"; reaching tip is 2j proper.

8. **Cost-limit-exceeded ambiguity.** If our `evaluate` throws `EvalError('cost-limit-exceeded')` (or equivalent) on a chain-accepted script, the cause could be (a) our cost is over-counting, or (b) the shim emitted the wrong `parameters.maxBlockCost` for that block. Mitigation: shim's per-block parameters extraction is tested against sigma-rust's `Parameters::max_block_cost()` on a known reference block; T5 includes this test. Error-report includes the block's voted maxBlockCost so triage can distinguish (a) vs. (b).

9. **Genesis block edge case.** Genesis at height 0: parent-link check is skipped (no parent). Genesis tx structure has no spending inputs (no UTXOs exist yet); outputs become the first index entries. Mitigation: T8 includes explicit `if height === 0` skip on parent-link; T5 ensures the shim's UTXO index seeds from genesis outputs cleanly.

10. **Spec underspecified on shim's `BlockBundle` exact CBOR schema.** This spec describes the shape but not the precise CBOR encoding (field names, integer encoding choices). Mitigation: canonical CBOR schema lives in the shim Rust crate; mirrored as a TS type definition in the harness; both validated by the round-trip unit test in T4.

11. **CBOR library compatibility.** Rust side will use `ciborium` or `serde_cbor`; TS side will use `cbor-x`. Subtle encoding differences (e.g., int vs. negint encoding, byte string vs. text string for length-prefixed bytes) can cause silent decode failures. Mitigation: T4's round-trip test must roundtrip Rust→TS→Rust on a synthetic BlockBundle.

## Confidence check (OVERRIDES #2 — crypto/cost path)

**Confidence: 96%** on the architectural plan (v2; was 95% in v1, raised by reviewer-closed verifications partially offset by the new ctx.headers padding uncertainty).

The harness is NOT a crypto-path nor cost-path artifact in itself — it's a validation tool. But it exercises crypto and cost paths in the library at scale, and several of its assumptions touch those areas:

- **Signing-message derivation correctness.** Reviewer-verified at `ergo-lib/src/chain/transaction.rs:183-191`. Confidence 99%.
- **`ContextExtension` shape (`IndexMap<u8, Constant>`).** Reviewer-verified at `context_extension.rs:23-26`. Confidence 99%.
- **`PreHeader` construction (field-projection of current Header).** Reviewer-verified at `preheader.rs:26-38`. Confidence 99%.
- **`Context::headers` rolling-window semantics (10-deep, preceding, `headers[0]` = newest prior).** Reviewer-verified for the populated case (block H ≥ 10). For H < 10, padding convention TBD — see Risk-hotspot #5. Confidence 90%.
- **`MAX_BLOCK_COST` as per-block voted parameter.** Reviewer-verified at `parameters.rs:21,79-81,166`. Confidence 99% (was the v1 spec's biggest error).
- **redb schema for `store.redb` (RedbModifierStore).** Reviewer-verified API surface at `store/src/lib.rs:78-81,182-186,208-211`. Confidence 96%.
- **Spent-box archive non-existence.** Reviewer-verified + spec author independent re-verification via `validation/src/utxo.rs:252-273`. Confidence 99%.
- **Shim-side UTXO index correctness.** New design surface in v2; bounded but untested. Confidence 90%.

**The 4% residual uncertainty:**
- 1% on `ctx.headers` padding for H < 10 — needs T10 source-read of sigma-rust's context construction at low heights.
- 1% on shim's UTXO-index off-by-one / accounting edge cases — bounded by T5 unit tests + smoke-walk integration check.
- 1% on shim sidecar coherency (stale sidecar vs. fresh redb) — mitigated by chain_meta hash check.
- 1% on unknowns we haven't enumerated.

**Escalation status:** none. Architectural design with bounded crypto/cost touchpoints; all delegated to sigma-rust on the shim side. OVERRIDES #2 escalation triggers don't apply.

## Rollback plan

Each task lands in its own commit; each is independently revertible:

- T2-T5: revert the Rust shim crate. No TS coupling.
- T6-T7: revert the harness scaffolding + checkpoint/error-report modules. No production code coupling.
- T8-T11: revert per-validation-pass commits. Each is additive; reverting one leaves the others functional but with reduced coverage.
- T12-T13: revert tests. No production coupling.
- T14: revert README.
- T15: revert docs sweep.

If a deep regression surfaces (e.g., T5's shim does something redb-corruption-like), revert T5 + T6-T11 together; the rest stand alone.

The harness lives entirely under `tools/mainnet-validate/`; removing the directory removes all of 2j-pre. The published packages and the existing test suites are unaffected by any harness work.

## Future work (captured as residual follow-ups)

1. **Phase 2j proper: walk-to-tip with this harness.** Iterative halt-fix-resume cycles until a clean genesis-to-tip walk is achieved. Each commit closes a divergence; the cumulative state is a fully chain-validated library. ETA: open-ended; depends on how many scope-gaps the chain demands and how many subtle bugs lurk in the curated-fixture-validated paths.

2. **Sigma-rust as secondary oracle for exact cost matching.** Once 2j's walk-to-tip is clean (no over-counting halts), layer sigma-rust as oracle: re-run the same blocks, compare our per-script cost integers byte-equal to sigma-rust's `try_eval_out` outputs. This catches under-counting (which the chain doesn't surface). May warrant its own phase name (2k?) depending on scope.

3. **Continuous validation mode.** Once tip is reached, optionally: keep the shim alive, poll the node's tip height periodically, validate new blocks as they land. Promotes the harness from one-pass tool to ongoing watchdog. CI-gate option opens up once this exists.

4. **TS-side transaction parser.** When the wallet phase begins, the TS library will need transaction parse/serialize. At that point the shim's tx-aware helpers become redundant; the harness can switch to passing raw tx bytes and letting the TS side parse. Library gains a public `Transaction` surface, symmetric with the rest of the port.

5. **Multi-chain validation.** Currently mainnet-only. Adding testnet support requires (a) the user pointing at a testnet redb, (b) testnet-specific V2 activation height (testnet activates differently), (c) testnet genesis assertions. Small change; deferred.

6. **Harness-driven coverage metrics.** Track which method handlers / which arms were exercised per walk. Output a coverage report on tip-reach: "method X was called N times across the chain." Useful for prioritizing future method-handler implementation work. Out of scope for 2j-pre; cheap to add later.

7. **Rate-limit knob extensions.** Token-bucket `--max-blocks-per-sec N`, max-CPU policies. Only if `--sleep-ms` proves insufficient.

## Cross-references

- `~/projects/ergots/external/sigma-rust/ergo-lib/src/chain/transaction.rs:183-191` — `Transaction::bytes_to_sign()`.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/chain/context_extension.rs:23-26` — `ContextExtension` shape (`IndexMap<u8, Constant>`).
- `~/projects/ergots/external/sigma-rust/ergo-lib/src/chain/parameters.rs:21,79-81,166` — `Parameters::max_block_cost` (voted per-block).
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/preheader.rs:26-38` — `PreHeader::from(&Header)` field-projection.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/chain/context.rs:40` — `Context::headers: [Header; 10]` fixed-size.
- `~/projects/ergo-node-rust/store/src/redb.rs` — `RedbModifierStore` table definitions.
- `~/projects/ergo-node-rust/store/src/lib.rs:78-81,182-186,208-211` — `tip`, `best_header_at`, `read_header_at` APIs.
- `~/projects/ergo-node-rust/chain/src/section.rs:12-15,47-56,60-66` — modifier type IDs, UTXO-mode section filtering, modifier-id derivation.
- `~/projects/ergo-node-rust/state/src/storage.rs:888-899` — spent-box removal from AVL+ tree (confirms no historical archive).
- `~/projects/ergo-node-rust/validation/src/utxo.rs:181-380` — validator's spent-box-bytes capture pattern (ephemeral; not persisted).
- `~/projects/ergo-node-rust/src/main.rs:924,1530` — `default_blocks_to_keep = -1`; comment on `blocks_to_keep = 0` → header-only SPV.
- `facts/scorex.md` — `Header`, `AutolykosSolution`, `verifyAutolykosV2`, `AutolykosV1NotSupportedError`.
- `facts/ergoscript.md`, `facts/ergoscript-wire.md`, `facts/ergoscript-eval.md`, `facts/ergoscript-sigma.md` — library surfaces the harness consumes.
- `facts/avltree.md` — exercised transitively via `SAvlTree.*` method handlers.
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec; 2j-pre is added 2026-05-21 to enable 2j.
- `docs/specs/2026-05-21-ergoscript-phase-2i-d-arm-count-reframe-design.md` — preceding phase.

## Open items (decide at impl time or in T1's PLAN.md)

1. **Smoke-test range scope.** What range does Layer 3 demand walk cleanly? Options: (a) first 1000 blocks of mainnet (V1-only era, simplest scope), (b) first 10000 blocks (still V1-only), (c) V2-activation onset (~417000 blocks, includes the V1→V2 transition), (d) some curated post-V2 P2PK-only slice. Recommendation: (a) — minimum to prove machinery; the rest is 2j proper. Decide at T1.

2. **Library-version mismatch on resume.** If `checkpoint.json` was written under `@ergots/ergoscript@0.3.0` and the resume run is on `@ergots/ergoscript@0.3.1`, harness should: (a) warn and continue (default), (b) refuse to resume and require `--force`, (c) silently continue. Recommendation: (a). Decide at T7.

3. **`ctx.headers` padding for blocks at H < 10.** Reviewer flagged 85% confidence on the padding convention. T10 must source-read sigma-rust's context construction for low heights and encode the convention exactly. Candidate behaviors: (a) pad with genesis-replicated headers, (b) pad with all-zero headers, (c) skip evaluating blocks H < 10 (acceptable since they have no spending tx of interest pre-activation), (d) pass shorter `Header[]` to TS (which accepts any length per `eval-context.ts:62-63`) and let the eval-side handlers fail gracefully on index-out-of-range. Resolved at T10 source-read.

4. **Shim sidecar invalidation policy.** When the harness is restarted with a different `store.redb` path, OR with the same path but a content-hash mismatch (user resynced the node between runs), how does the shim handle the sidecar `utxo-index.redb`? Options: (a) refuse to start until user deletes the sidecar manually, (b) detect the mismatch and rebuild from genesis automatically, (c) prompt for confirmation. Recommendation: (b) with a logged warning. Decide at T3.

5. **Resolved during v2 review (was v1 Open #3):** `MAX_BLOCK_COST` is a per-block voted `i32` parameter, default 1,000,000 (sigma-rust's `Parameters::Default`), mainnet voted ~1B. Sourced per-block from each block's Extension parameters table via `Parameters::max_block_cost()`. Harness uses BlockBundle's `parameters.maxBlockCost` field per block. See Decision 9.

6. **Resolved during v2 review (was v1 Open #4):** Shim crate's `Cargo.toml` uses path-dep on `external/sigma-rust/` (matches `fixture-gen/` pattern). Workspace alignment guarantees same sigma-rust HEAD as our library is validated against.

## Reviewer findings applied (v1 → v2, 2026-05-21)

Spec was reviewed by a general-purpose reviewer subagent dispatched with explicit OVERRIDES rules + source-read instructions on `Transaction::bytes_to_sign`, `ergo-node-rust` redb schema, `ContextExtension`, `MAX_BLOCK_COST`, `ctx.headers`/`PreHeader` semantics, and ergots-library API surface. Returned 3 critical / 4 moderate / 3 minor findings. Spec author independently verified the most load-bearing finding (#2 below) via `validation/src/utxo.rs:181-380` source-read + `addons/indexer/` directory inspection + `chain/src/section.rs:47-56` confirmation of ADProofs filtering + `src/main.rs:924,1530` confirmation of `blocks_to_keep` semantics.

**★★★ Critical findings (all applied inline):**

1. **Wrong redb file/crate.** v1 cited `state/src/storage.rs` as the home of block records and UTXO archive. Actually: block-modifier data lives in a separate `store/` crate (`store/src/redb.rs`) — TWO redb files: `store.redb` (modifiers) + `state.redb` (UTXO AVL+ tree). v2's Decision 3 + Source mapping table fully reflect this.

2. **No spent-box archive in redb.** v1 assumed direct lookup of spent boxes by id. Actually: `state.redb` holds only the current-tip UTXO set; spent boxes are removed (verified at `state/src/storage.rs:888-899`). No historical archive. The indexer addon (`addons/indexer/`) exists but is a separate process writing to postgres/sqlite. ADProofs (would have enabled per-block proof-based reconstruction) are NOT downloaded by UTXO-mode nodes (`chain/src/section.rs:47-56`). v2 pivoted Decision 3 to option (b): shim builds its own forward-walking UTXO index from BlockTransactions outputs, persisted to a sidecar `utxo-index.redb` for fast resume. Decision 11 (checkpoint) now documents the shim-side sidecar persistence. **Prerequisite refined during v2 verification:** node must NOT have been started with `utxo_bootstrap = true` (which leaves a genesis-to-snapshot-height BlockTransactions gap with no backfill). The `blocks_to_keep` setting — initially thought to be the prereq — is purely handshake-side (4 uses across the rust node, all in handshake/config-read paths; zero storage gating). User's node verified full-archive empirically.

3. **`MAX_BLOCK_COST` was wrong by ~3 orders of magnitude AND wrong about staticness.** v1 said "~7,000,000 JIT cost units" as a constant. Actually: per-block voted `i32` parameter sourced from each block's Extension parameters table (`Parameters::max_block_cost()` at `parameters.rs:79-81`). Default 1M; mainnet voted ~1B. v2's Decision 9 rewrote the policy: shim parses per-block parameters, BlockBundle carries `parameters.maxBlockCost`, harness uses per-block value as `jitCostLimit`.

**★★ Moderate findings (folded inline):**

4. **`ContextExtension` key is `u8` not `u32`.** Decision 6 + Source mapping corrected.
5. **`ctx.headers` is fixed `[Header; 10]` in sigma-rust.** For block H < 10, padding logic needed. Captured as Risk-hotspot #5 + Open item #3; T10 must source-read the padding convention.
6. **`PreHeader` is field-projection, not serialization-roundtrip.** v1 phrased it as "serializeHeaderWithoutPow-style logic"; v2 corrected to "field-projection per `ergo-chain-types/src/preheader.rs:26-38`."
7. **Block Extension carries the parameters table.** v1 was silent on this; v2's Decision 6 + Decision 9 + Source mapping reflect it.

**★ Minor findings (acknowledged):**

8. **treeVersion derivation should be explicit in PLAN.md.** Captured at T10 in Execution order.
9. **API surface verified.** `parseSValue` at `wire/parse-svalue.ts:93`, `verifySignature` at `eval/sigma/verifier.ts:418` — both reviewer-confirmed accessible.
10. **Specific store APIs cited.** Source mapping now references `tip(type_id)`, `best_header_at(height)`, `read_header_at(height)`, `get(type_id, id)` at their exact line numbers in `store/src/lib.rs`.

**Confidence delta:** v1 confidence 95% → v2 confidence 96%. Multiple uncertainties closed (signing message, ContextExtension shape, PreHeader, redb schema); one new uncertainty surfaced (`ctx.headers` H<10 padding); one design pivot bounded (shim-side UTXO index). Net positive on architectural soundness.
