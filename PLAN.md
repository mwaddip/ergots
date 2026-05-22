# Phase 2j-pre — Mainnet validation harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto/cost-path → halt and declare (this phase is NOT a crypto/cost-path phase, but the rule stays in the preamble); #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads; #10 — truncation suspicion on grep results]. Per `[[feedback-subagent-explicit-rules]]`, this preamble is load-bearing.

**Spec:** `docs/specs/2026-05-21-mainnet-validate-harness-design.md` (HEAD `78cfde8`)

**Goal:** Build a two-process validation pipeline — a Rust shim reading the user's `ergo-node-rust` redb in read-only mode + a TypeScript harness walking the chain block-by-block — that exercises the full Phase 2 library surface (header parse/serialize/Autolykos-v2-verify, ErgoTree byte-roundtrip on every box, `evaluate` + `verifySignature` on every spending input) against chain-accepted mainnet data. Pure stop-on-error; resumable from checkpoint. Distinct from Phase 2j (cost-validation calibration via this harness), which consumes the infrastructure delivered here.

**Architecture:** Long-lived Rust shim subprocess + Node TypeScript harness, communicating over stdin (ASCII line commands) + stdout (length-prefixed CBOR responses). Shim builds its own forward-walking UTXO index from BlockTransactions outputs (state.redb's AVL+ tree has no spent-box archive). Per-block bundles carry header + per-tx signing message + per-input pre-resolved spent-box + signature + context-extension + per-output box bytes + per-block parameters. Harness has minimum state (parent header + 10-deep rolling window for `ctx.headers`). Pure stop-on-error.

**Tech stack:**
- **Rust shim** (`tools/mainnet-validate/shim/`): Cargo crate, path-deps on `external/sigma-rust/ergo-lib` + `external/sigma-rust/ergotree-ir` + `~/projects/ergo-node-rust/{chain,store}` (path-dep to user's local node repo); runtime deps `redb` + `ciborium`.
- **TS harness** (`tools/mainnet-validate/harness/`): not in npm workspace; deps on `@ergots/scorex` + `@ergots/ergoscript` + `@ergots/avltree` via local file:../../../packages/* paths, plus `cbor-x` for CBOR.

**Invariants:**
- Zero new library surface introduced by 2j-pre. No changes to `packages/*/src/`.
- Pure stop-on-error: any divergence halts the walk.
- Harness state across iterations: parent header bytes + 10-deep rolling header window. ~2 KB.
- Shim state: UTXO index, ~1–3 GB in memory at mainnet tip, persisted to sidecar `utxo-index.redb` (~5 GB disk).
- `jitCostLimit` sourced per-block from each block's Extension parameters table.
- All harness/shim code lives under `tools/mainnet-validate/` (outside npm + Cargo workspaces).
- No new commits to existing test suites; existing 3772 tests under `packages/*/test/` unchanged.

---

## Task ordering

```
T1   PLAN.md committed (this document; overwrites 2i-d plan)
T2   Rust shim scaffolding: Cargo.toml; src/main.rs argv parsing,
     stdin loop, stub stdout response; src/protocol.rs framing.
     T2 startup check: tip(101) and tip(102) both nonzero (full-archive
     verification) → else emit prerequisite-violation error and exit.
T3   Shim: GET_TIP_HEIGHT command (returns tip(101)) + sidecar
     utxo-index.redb scaffolding (open or create; "indexed up to height"
     marker + source-store content-hash for invalidation policy).
T4   Shim: GET_BLOCK <height> command — header bytes only via
     best_header_at(h) + read_header_at(h); Layer 1 unit test for
     protocol framing (CBOR encode/decode round-trip + status byte +
     length prefix).
T5   Shim: GET_BLOCK extension — full BlockBundle:
       - For each block from sidecar marker up to requested height,
         fetch BlockTransactions modifier 102 via get(102, derived_id),
         parse via sigma-rust;
       - For each tx, Transaction::bytes_to_sign() → signing message;
       - For each output, ADD box_id → box_bytes to sidecar UTXO index;
       - For each input, LOOKUP box_id → box_bytes from sidecar,
         capture, REMOVE;
       - For each dataInput, LOOKUP (no remove);
       - Per-input ContextExtension extraction (IndexMap<u8, Constant>);
       - Fetch Extension modifier 108, parse parameters table,
         emit parameters.maxBlockCost per block;
     Advance sidecar "indexed up to height" marker after each successful
     block.
T6   TS harness scaffolding: package.json (cbor-x dep), tsconfig.json,
     src/main.ts that spawns the shim, sends GET_TIP_HEIGHT, prints
     the response. No validation yet.
T7   Harness: src/checkpoint.ts (read/write/round-trip tests) +
     src/error-report.ts (structured halt with phase + errorClass +
     errorCode + location + bundleExcerpt) + library-version stamping
     in checkpoint.
T8   Harness: src/validate-block.ts — header pass:
     parseHeader + serializeHeader byte-equal + verifyAutolykosV2 with
     V1-below-activation skip (catch AutolykosV1NotSupportedError at
     height < 417792 for mainnet) + parent-link (skip at H=0).
T9   Harness: src/validate-block.ts — output round-trip pass:
     per-output parseSValue(SBox, treeVersion, reader) → extract
     .ergoTree → parseTree → serializeTree → byte-equal.
T10  Harness: src/validate-tx.ts — evaluate + verifySignature pass.
     EvalContext construction from BlockBundle:
       - height from block;
       - selfBox from input.spentBoxBytes;
       - inputs from all same-tx spent boxes;
       - outputs from all same-tx output bytes;
       - dataInputs from bundle.dataInputBoxes;
       - preHeader from field-projection of current Header
         (PreHeader::from per ergo-chain-types/src/preheader.rs:26-38);
       - headers from rolling window (last 10; H < 10 padding per
         T10 source-read of sigma-rust);
       - extension as parsed SValue map (per-input);
       - jitCostLimit from bundle.parameters.maxBlockCost;
       - treeVersion auto-derived from tree.header.version per
         evaluate(tree, opts).
     T10 must source-read sigma-rust's ctx.headers padding convention
     for H < 10 before encoding the window behavior. Resolves Open
     item #3 from the spec.
T11  Harness: src/main.ts walk loop — sequential height advance,
     rate-limit sleep, halt-and-write-report on any catch.
     CLI flags: --start-height N (override checkpoint; useful for
     bootstrap-data testing and fast iteration), --max-height M
     (cap for smoke tests), --sleep-ms N (rate-limit; default 0),
     --shim-path PATH (path to shim binary; default
     ./target/release/ergots-mainnet-validate-shim),
     --store-path PATH (path to store.redb), --sidecar-path PATH
     (path to utxo-index.redb; default
     ./tools/mainnet-validate/utxo-index.redb).
T12  Layer 3 smoke test: walk from --start-height N for K blocks
     against the user's bootstrap-data copy.
     Goal: ≥ 1 full block validates cleanly (header + outputs +
     ≥1 spending input). Confirms IPC + machinery + validation
     wiring end-to-end.
T13  Layer 4/5/6 path tests:
       - L4 halt path: deliberate fault (malformed shim path,
         deliberately-broken library function in a branch); confirm
         halt + error-report.json correctness.
       - L5 resume path: after a halt, re-run; confirm checkpoint
         read, rolling-header re-fetch, walk continues at H+1.
       - L6 tip-reach path: cap --max-height to a low value; confirm
         clean exit, tipReachedAt set in checkpoint, error-report
         deleted.
T14  README.md for tools/mainnet-validate/ — operator docs:
     prerequisites (utxo_bootstrap = false in node config, OR
     full-archive verified via REST), setup steps (cargo build
     shim; npm install harness), run command, interpreting halts,
     resume after a halt, copying redb for testing.
T15  SESSION_CONTEXT.md + HANDOFF_PROMPT.md sweep + facts/ pass
     (if any facts need cross-reference to the harness's existence)
     + memory refresh + push.
```

Total: ~15 commits (this plan + 14 task commits, T12/T13 each one commit unless they split).

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `/home/mwaddip/projects/ergots/PLAN.md` (this file, overwrites 2i-d plan)

- [ ] **Step 1: Stage and commit**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): overwrite PLAN.md with phase 2j-pre execution plan

Per HANDOFF_PROMPT.md convention: PLAN.md is the in-flight phase's task
list, overwritten at each phase boundary. Spec at
docs/specs/2026-05-21-mainnet-validate-harness-design.md
(HEAD 78cfde8, reviewer pass applied).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Verification**

```bash
git log --oneline -3  # confirm: PLAN commit + spec commit + 2i-d head
```

---

## Task 2: Rust shim scaffolding + Cargo.toml + startup checks

**Files:**
- Create: `tools/mainnet-validate/shim/Cargo.toml`
- Create: `tools/mainnet-validate/shim/src/main.rs`
- Create: `tools/mainnet-validate/shim/src/protocol.rs`
- Create: `tools/mainnet-validate/.gitignore` (entries: `target/`, `*.redb`, `checkpoint.json`, `error-report.json`)

**Cargo.toml dependencies (T2-verified upstream crate names):**
```toml
[package]
name = "ergots-mainnet-validate-shim"
version = "0.1.0"
edition = "2021"

[dependencies]
# sigma-rust crates — deferred to T5 (when sigma-rust API is actually needed).
# When adding at T5, see the sigma-rust resolver-choice note in Task 5 below.
# Verified package names from `external/sigma-rust/` (2026-05-21):
#   ergo-lib (external/sigma-rust/ergo-lib/Cargo.toml:2)
#   ergotree-ir (external/sigma-rust/ergotree-ir/Cargo.toml:2)
#   ergo-chain-types (external/sigma-rust/ergo-chain-types/Cargo.toml:2)

# ergo-node-rust crates — package names prefixed `enr-`:
enr-store = { path = "../../../../ergo-node-rust/store" }
# enr-chain: deferred to T4/T5 (when Header / BlockTransactions parsing needed)

# redb version pinned to ergo-node-rust's workspace pin (verified by T2 agent
# against ergo-node-rust/Cargo.toml:50). Mismatch would silently produce two
# parallel redb crates in the dep graph; type identities wouldn't unify.
redb = "4"
ciborium = "0.2"
serde = { version = "1", features = ["derive"] }
anyhow = "1"
```

T2 agent's source-read corrections from the original v1 PLAN sketch:
- `ergo-node-store` → `enr-store` (the `enr-` prefix is consistent across the ergo-node-rust workspace per `ergo-node-rust/store/Cargo.toml`).
- `redb = "2.x"` → `redb = "4"` (workspace is on v4 per `ergo-node-rust/Cargo.toml:50`).
- sigma-rust path-deps deliberately deferred from T2 to T5 — T2's scope (open store + tip check + stub stdin loop) doesn't compile against any sigma-rust API.

- [ ] **Step 1: Create directory structure + .gitignore**

- [ ] **Step 2: Write Cargo.toml with confirmed dep names + paths**

- [ ] **Step 3: Write src/main.rs**
  - Parse argv: store.redb path (positional, required)
  - Open store.redb via `RedbModifierStore::open(path)`
  - Startup check: query `tip(101)` (header tip) and `tip(102)` (BlockTransactions tip). If either is zero or `tip(102)` is significantly lower than `tip(101)`, write `{ok: false, error: {code: "utxo-bootstrap-detected", message: "Node was started with utxo_bootstrap = true; BlockTransactions for genesis-to-snapshot range are absent."}}` to stdout and exit 1.
  - Otherwise: enter stdin read loop. For each line, write a stub `{ok: true, message: "stub"}` CBOR response. No actual GET_BLOCK / GET_TIP_HEIGHT logic yet — that's T3, T4, T5.

- [ ] **Step 4: Write src/protocol.rs**
  - `pub fn write_response(stdout: &mut impl Write, ok: bool, body: impl Serialize)` — serialize as CBOR, prepend 4-byte BE length, write to stdout, flush.
  - `pub fn parse_request(line: &str) -> Result<Request, String>` — parse `GET_TIP_HEIGHT\n` or `GET_BLOCK <height>\n`; reject anything else with a clear error.
  - `enum Request { GetTipHeight, GetBlock { height: u32 } }`.

- [ ] **Step 5: cargo check**

```bash
cd tools/mainnet-validate/shim && cargo check
```

Resolve any compile errors. Common gotcha: crate-name mismatches between Cargo.toml and the actual `[package].name` in the source crate. Adjust as needed.

- [ ] **Step 6: cargo test (no real tests yet but ensure the scaffolding builds for tests)**

```bash
cargo test --no-run
```

- [ ] **Step 7: Stage + commit**

```bash
git add tools/mainnet-validate/shim/ tools/mainnet-validate/.gitignore
git commit -m "$(cat <<'EOF'
feat(2j-pre/shim): Rust shim scaffolding + startup full-archive check (T2)

Cargo crate at tools/mainnet-validate/shim with path-deps on
external/sigma-rust + ergo-node-rust crates. main.rs opens store.redb,
runs the tip(101)/tip(102) startup check to detect utxo_bootstrap'd
nodes, then enters a stdin loop emitting stub responses. protocol.rs
implements the CBOR-over-length-prefixed-stdout framing per spec
Decision 8. No GET_TIP_HEIGHT / GET_BLOCK logic yet (T3-T5).

Per spec docs/specs/2026-05-21-mainnet-validate-harness-design.md
Decisions 3, 6, 7, 8. T2 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Shim GET_TIP_HEIGHT + sidecar utxo-index.redb scaffolding

**Files:**
- Edit: `tools/mainnet-validate/shim/src/main.rs` (wire GET_TIP_HEIGHT branch)
- Edit: `tools/mainnet-validate/shim/src/protocol.rs` (response shape for tip-height)
- Create: `tools/mainnet-validate/shim/src/utxo_index.rs` — sidecar redb wrapper

**Sidecar schema:**
- Table `boxes` keyed by `box_id [u8; 32]`, value = `box_bytes Vec<u8>`.
- Table `meta` keyed by `String`, value = `Vec<u8>`. Holds: `indexed_up_to_height: u32` (LE), `source_store_hash: [u8; 32]` (blake2b of store.redb path metadata + tip(101) snapshot to detect store-changed-since-last-run).

- [ ] **Step 1: Implement `UtxoIndex` struct**

In `utxo_index.rs`:
- `pub struct UtxoIndex { db: redb::Database }`
- `pub fn open_or_create(path: &Path, store: &RedbModifierStore) -> Result<Self>` — open or create the sidecar; if `meta::source_store_hash` exists and doesn't match the current store's fingerprint, log a warning and truncate the boxes table back to empty (rebuild from scratch). Per spec Open item #4 recommendation (auto-rebuild on mismatch with logged warning).
- `pub fn get(&self, box_id: &[u8; 32]) -> Result<Option<Vec<u8>>>` — read-only lookup.
- `pub fn insert(&self, box_id: &[u8; 32], bytes: &[u8]) -> Result<()>` — insert (overwrites if exists; chains don't double-create).
- `pub fn remove(&self, box_id: &[u8; 32]) -> Result<Option<Vec<u8>>>` — capture-then-remove.
- `pub fn indexed_up_to_height(&self) -> Result<u32>` — read marker, default 0.
- `pub fn set_indexed_up_to_height(&self, h: u32) -> Result<()>` — atomic update.

- [ ] **Step 2: Wire GET_TIP_HEIGHT in main.rs**

When request is `GetTipHeight`: read `store.tip(101)` → emit `{ok: true, tip: <u32>}` CBOR response.

- [ ] **Step 3: Initialize sidecar at startup**

In `main.rs`, after opening store.redb, open or create sidecar at `--sidecar-path` (default `./tools/mainnet-validate/utxo-index.redb`). Pass as second argv. Log "sidecar opened at height N".

- [ ] **Step 4: Unit test sidecar round-trip**

In `utxo_index.rs::tests`:
- Open in temp-dir, insert a box, get it back, remove it, get None.
- Set indexed_up_to_height, read it back.

```bash
cd tools/mainnet-validate/shim && cargo test
```

- [ ] **Step 5: Stage + commit**

```bash
git add tools/mainnet-validate/shim/src/
git commit -m "$(cat <<'EOF'
feat(2j-pre/shim): GET_TIP_HEIGHT + sidecar UTXO index scaffolding (T3)

Implements GET_TIP_HEIGHT command (returns tip(101) from store.redb)
and the sidecar utxo-index.redb wrapper (boxes table + meta table for
indexed-up-to-height marker + source-store hash for cache coherency
per spec Open item #4: auto-rebuild on mismatch with logged warning).

Per spec docs/specs/2026-05-21-mainnet-validate-harness-design.md
Decisions 3, 11. T3 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Shim GET_BLOCK (header-only) + Layer 1 unit test

**Files:**
- Edit: `tools/mainnet-validate/shim/src/main.rs` (wire GET_BLOCK header-only branch)
- Edit: `tools/mainnet-validate/shim/src/protocol.rs` (BlockBundle skeleton with just header)
- Create: `tools/mainnet-validate/shim/tests/protocol_roundtrip.rs` — Layer 1 integration test

**BlockBundle (skeleton at T4; expanded at T5):**
```rust
#[derive(Serialize, Deserialize)]
pub struct BlockBundle {
    pub height: u32,
    pub block_id: [u8; 32],
    pub parent_id: [u8; 32],
    pub header_bytes: Vec<u8>,
    pub transactions: Vec<TxBundle>,  // empty at T4; populated at T5
}

#[derive(Serialize, Deserialize)]
pub struct TxBundle { /* empty at T4 */ }
```

- [ ] **Step 1: Wire GET_BLOCK <height> header-only path**

In `main.rs`, when request is `GetBlock { height }`:
1. `let header_id = store.best_header_at(height).ok_or(...)?` — handles missing height as `{ok: false, error: {code: "past-tip" or "missing-block"}}`.
2. `let header_bytes = store.read_header_at(height)?` — canonical header bytes.
3. **Extract `parent_id` from `header_bytes` without a sigma-rust dep:** the canonical Header serialization places `parent_id` at offset 1 (immediately after the 1-byte version), exactly 32 bytes (per `facts/scorex.md`'s Header type invariants). Use `header_bytes[1..33].try_into()`. **Defer adding sigma-rust as a Cargo dep until T5** — see T5's "Sigma-rust resolver choice" section for the resolution options. T4's narrow needs (parent_id only) are met by direct byte extraction; pulling in sigma-rust here just to read one field forces the resolver decision earlier than necessary.
4. Build `BlockBundle { height, block_id: header_id, parent_id, header_bytes, transactions: vec![] }`.
5. Emit as CBOR via `write_response`.

- [ ] **Step 2: Layer 1 unit test — protocol framing round-trip**

In `tests/protocol_roundtrip.rs`:
```rust
// Construct a synthetic BlockBundle (header only); write via write_response
// to a Vec<u8>; read back: 4-byte BE length prefix; then deserialize CBOR;
// assert structural equality.
```

Also test the error path: `{ok: false, error: {code: "past-tip", message: "..."}}` round-trip.

- [ ] **Step 3: Build + test**

```bash
cd tools/mainnet-validate/shim && cargo build && cargo test
```

- [ ] **Step 4: Smoke-test via the user's running node**

```bash
# Manually with a TEMPORARY copy of the user's redb (don't use the live one):
cp -a /var/lib/ergo-node/data /tmp/ergo-shim-test-data
echo "GET_TIP_HEIGHT" | ./target/release/ergots-mainnet-validate-shim /tmp/ergo-shim-test-data/modifiers.redb /tmp/test-sidecar.redb | xxd | head -5
# Expect: 4-byte length prefix + CBOR with ok: true, tip: ~1790449
```

(For implementation by subagent: prefer using a small Rust integration test if running the shim against real redb in CI/dev is awkward.)

- [ ] **Step 5: Stage + commit**

```bash
git add tools/mainnet-validate/shim/
git commit -m "$(cat <<'EOF'
feat(2j-pre/shim): GET_BLOCK header-only + protocol unit test (T4)

Wires GET_BLOCK <height> returning a BlockBundle with header bytes,
block id, parent id (parsed from header bytes via sigma-rust). Transactions
array is empty at T4; populated at T5. Layer 1 integration test confirms
CBOR-over-length-prefixed-stdout framing round-trips for both success and
error shapes.

Per spec Decisions 7, 8. T4 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Shim GET_BLOCK (full BlockBundle)

**Files:**
- Edit: `tools/mainnet-validate/shim/src/main.rs` (walk-forward logic from sidecar marker to requested height)
- Edit: `tools/mainnet-validate/shim/src/protocol.rs` (full TxBundle, InputBundle, parameters)
- Edit: `tools/mainnet-validate/shim/src/utxo_index.rs` (batch insert helper for tx-output ingestion)
- Create: `tools/mainnet-validate/shim/src/block_walker.rs` — per-block ingestion logic
- Edit: `tools/mainnet-validate/shim/Cargo.toml` (add sigma-rust deps; see resolver-choice note below)

**Sigma-rust resolver choice — RESOLVE AT THIS TASK** (T2 agent flagged; user clarified 2026-05-21):

T5 is the first task that genuinely needs sigma-rust APIs (`Transaction::bytes_to_sign()`, `Transaction::sigma_parse`, `Constant::sigma_serialize`, `Parameters::max_block_cost()`, `ErgoBox::sigma_serialize_bytes`). Adding these as path-deps to `external/sigma-rust/` introduces a Cargo-resolver question, because `enr-chain` (which T5 may also depend on for block-parsing helpers) references sigma-rust via a git rev (`3aa0832f` at the time of T2). The git-rev and our local `external/sigma-rust/` HEAD (`6ba9d524`) are content-equivalent (both carry the nipopow fixes per user 2026-05-21), so there's no functional conflict — but Cargo's resolver treats different sources as different crates, meaning types from one don't unify with types from the other. Three resolution options:

1. **Match `enr-chain`'s git-rev approach.** Our shim adds sigma-rust crates via `{ git = "...", rev = "3aa0832f" }` matching exactly. Cargo unifies them as one crate. Cost: depending on git fetches; harder to debug if `external/sigma-rust/` ever diverges in development.
2. **Use path-deps + a `[patch]` redirect.** Our shim adds `[patch."https://github.com/ergoplatform/sigma-rust"]` (or whatever upstream URL `enr-chain` references) pointing at our local `external/sigma-rust/` paths. Cargo redirects enr-chain's git-rev to our local path. Cost: one `[patch]` block in the shim's Cargo.toml; cleanest semantically ("library reads same bytes our local sigma-rust serializes").
3. **Don't depend on `enr-chain` at all.** If we can re-derive everything we need from sigma-rust + raw store.redb access, we don't need enr-chain's helpers, and the conflict doesn't arise. Cost: re-implementing whatever enr-chain provides (probably modifier-id derivation per `chain/src/section.rs:60-66`).

**Recommendation: Option 2 (`[patch]` redirect).** Preserves "library reads same bytes the local sigma-rust serializes," matches the `fixture-gen/` pattern, allows local sigma-rust development to flow through without re-pinning. If `[patch]` proves finicky at impl time, fall back to Option 1.

Either way, run `cargo tree | grep ergo-lib` after adding the deps to confirm only one version appears in the dependency graph.

**Full BlockBundle:**
```rust
#[derive(Serialize, Deserialize)]
pub struct BlockBundle {
    pub height: u32,
    pub block_id: [u8; 32],
    pub parent_id: [u8; 32],
    pub header_bytes: Vec<u8>,
    pub transactions: Vec<TxBundle>,
    pub parameters: BlockParameters,
}

#[derive(Serialize, Deserialize)]
pub struct TxBundle {
    pub tx_id: [u8; 32],
    pub signing_message: Vec<u8>,
    pub inputs: Vec<InputBundle>,
    pub outputs: Vec<Vec<u8>>,           // canonical box bytes per output
    pub data_input_boxes: Vec<Vec<u8>>,  // resolved-by-id, inlined
}

#[derive(Serialize, Deserialize)]
pub struct InputBundle {
    pub spent_box_bytes: Vec<u8>,
    pub signature_bytes: Vec<u8>,
    pub context_extension: Vec<(u8, Vec<u8>)>,  // (varId, Constant::sigma_serialize bytes)
}

#[derive(Serialize, Deserialize)]
pub struct BlockParameters {
    pub max_block_cost: i32,
    // Other Parameters fields if useful for future phases; max_block_cost is the
    // only one the harness uses today.
}
```

- [ ] **Step 1: Implement `block_walker::ingest_block`**

```rust
pub fn ingest_block(
    height: u32,
    store: &RedbModifierStore,
    index: &mut UtxoIndex,
) -> Result<BlockBundle, ShimError>
```

For each block:
1. Read header bytes + parse via `Header::sigma_parse` → get `parent_id`, `transaction_root`, `extension_root`.
2. Derive BlockTransactions modifier id: `blake2b256(102 || header_id || transaction_root)`. Per `chain/src/section.rs:60-66`.
3. `let txs_bytes = store.get(102, &block_txs_id)?` → parse via sigma-rust's BlockTransactions parser.
4. For each tx in the block:
    - `tx.bytes_to_sign()?` → signing message.
    - For each output: serialize canonical bytes via `ErgoBox::sigma_serialize_bytes`; ADD `(box_id, box_bytes)` to `index`.
    - For each input: LOOKUP `box_id → spent_box_bytes` from `index`; if missing, return error `{code: "missing-utxo"}`; REMOVE entry. Extract `signature_bytes` from `input.spending_proof.proof_bytes`. Extract `context_extension` via `input.spending_proof.extension` → serialize each Constant value via `Constant::sigma_serialize`.
    - For each data-input: LOOKUP (no remove).
5. Derive Extension modifier id: `blake2b256(108 || header_id || extension_root)`. Read + parse Extension via sigma-rust's voting/parameters parser. Extract `Parameters::max_block_cost()`.
6. Return populated `BlockBundle`.

- [ ] **Step 2: Walk-forward loop in main.rs**

When GET_BLOCK <H>:
- Read `indexed_up_to_height` from sidecar.
- For each `h` from `indexed + 1` to `H`:
  - Call `ingest_block(h, &store, &mut index)`.
  - If `h == H`: keep the BlockBundle for emission. If `h < H`: discard the bundle (we only emitted blockBundles for the requested H).
  - On success of each h, `index.set_indexed_up_to_height(h)`.
- Emit the kept `BlockBundle` via `write_response`.

(Note: this means walking from 1 to H on the first call; subsequent calls only need to advance by 1. For the harness's typical sequential walk, this is one block of progress per request.)

- [ ] **Step 3: Genesis special case**

At `h == 0`, there are no spending inputs (no boxes exist yet). Outputs from genesis tx become the first index entries. Per spec Risk-hotspot #9.

- [ ] **Step 4: Unit test on a synthetic 2-block chain**

In `block_walker::tests`:
- Construct a synthetic store with genesis + block 1 (block 1 spends a genesis output).
- Ingest block 0 (genesis); verify index has the output.
- Ingest block 1; verify block 1's BlockBundle has the spent-box-bytes correctly populated and that the index has the entry removed.

(This may require fixture-gen-style helpers to build a test redb; an alternative is to use `RedbModifierStore::open` against a known small fixture file checked into `tools/mainnet-validate/shim/tests/fixtures/`.)

- [ ] **Step 5: Build + test**

```bash
cd tools/mainnet-validate/shim && cargo test
```

- [ ] **Step 6: Manual smoke-test against the user's bootstrap-data copy**

```bash
cp -a /var/lib/ergo-node/data /tmp/ergo-shim-test-data  # if not already
# Send a GET_BLOCK request at some snapshot-height+ value:
echo -e "GET_BLOCK <some-known-recent-height>" | \
  ./target/release/ergots-mainnet-validate-shim \
    /tmp/ergo-shim-test-data/modifiers.redb \
    /tmp/test-sidecar.redb | \
  ciborium-cli decode  # or write a small TS script to parse
# Expect: a populated BlockBundle with multiple transactions, signing messages,
# input/output byte arrays.
```

- [ ] **Step 7: Stage + commit**

```bash
git add tools/mainnet-validate/shim/
git commit -m "$(cat <<'EOF'
feat(2j-pre/shim): full BlockBundle assembly with forward-walking UTXO index (T5)

Implements block_walker::ingest_block which walks the chain from the
sidecar's last-indexed height forward, per-block:
- Parses BlockTransactions (modifier 102) via sigma-rust;
- Computes Transaction::bytes_to_sign per tx;
- ADDs outputs to UTXO index, LOOKs UP + REMOVEs inputs (capturing
  spent box bytes), LOOKs UP data inputs (no remove);
- Extracts per-input ContextExtension (IndexMap<u8, Constant>);
- Parses Extension (modifier 108) for Parameters::max_block_cost.

GET_BLOCK <H> drives the walk: shim advances the index from current
marker to H, emits a populated BlockBundle for H. Genesis special-case
handled (no inputs at height 0).

Per spec Decisions 3, 6, 9. T5 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: TS harness scaffolding

**Files:**
- Create: `tools/mainnet-validate/harness/package.json`
- Create: `tools/mainnet-validate/harness/tsconfig.json`
- Create: `tools/mainnet-validate/harness/src/main.ts`
- Create: `tools/mainnet-validate/harness/src/protocol.ts` — mirror of shim's protocol shape

**package.json:**
```json
{
  "name": "ergots-mainnet-validate-harness",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc -p .",
    "start": "node --experimental-strip-types src/main.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@ergots/scorex": "file:../../../packages/scorex",
    "@ergots/ergoscript": "file:../../../packages/ergoscript",
    "@ergots/avltree": "file:../../../packages/avltree",
    "cbor-x": "^1.5.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vitest": "^2.x"
  }
}
```

- [ ] **Step 1: Write package.json with confirmed versions (match the monorepo's pins)**

- [ ] **Step 2: Write tsconfig.json**

Strict TS, ESM, ES2022 target, module bundler resolution to match monorepo conventions.

- [ ] **Step 3: Write src/protocol.ts**

TS mirror of the shim's CBOR shapes:
```ts
export type BlockBundle = {
  height: number;
  blockId: Uint8Array;
  parentId: Uint8Array;
  headerBytes: Uint8Array;
  transactions: TxBundle[];
  parameters: { maxBlockCost: number };
};

export type TxBundle = {
  txId: Uint8Array;
  signingMessage: Uint8Array;
  inputs: InputBundle[];
  outputs: Uint8Array[];
  dataInputBoxes: Uint8Array[];
};

export type InputBundle = {
  spentBoxBytes: Uint8Array;
  signatureBytes: Uint8Array;
  contextExtension: Array<[number, Uint8Array]>;
};

export type ShimResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
```

Plus a class `ShimClient` that:
- Spawns the shim subprocess via `child_process.spawn`.
- Provides `async getTipHeight(): Promise<number>` and `async getBlock(height: number): Promise<BlockBundle>`.
- Reads length-prefixed CBOR responses from shim stdout via a small framing parser; decodes via cbor-x.
- Writes ASCII line commands to shim stdin.

- [ ] **Step 4: Write src/main.ts (minimal)**

```ts
// Parse argv (--store-path, --shim-path)
// Spawn shim
// Send GET_TIP_HEIGHT
// Print result
// Exit
```

- [ ] **Step 5: Smoke-build**

```bash
cd tools/mainnet-validate/harness
npm install
npm run build
node dist/main.js --store-path /tmp/ergo-shim-test-data/modifiers.redb \
  --shim-path ../shim/target/release/ergots-mainnet-validate-shim
# Expect: prints "Tip height: 1790449" (or similar) and exits
```

- [ ] **Step 6: Stage + commit**

```bash
git add tools/mainnet-validate/harness/
git commit -m "$(cat <<'EOF'
feat(2j-pre/harness): TS harness scaffolding + ShimClient (T6)

package.json with cbor-x + workspace file-deps on @ergots/scorex,
@ergots/ergoscript, @ergots/avltree. main.ts is minimal — spawns the
shim, sends GET_TIP_HEIGHT, prints the response. ShimClient handles
the length-prefixed CBOR framing on the receive side and ASCII line
commands on the send side.

Per spec Decisions 7, 8. T6 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Harness checkpoint.ts + error-report.ts

**Files:**
- Create: `tools/mainnet-validate/harness/src/checkpoint.ts`
- Create: `tools/mainnet-validate/harness/src/error-report.ts`
- Create: `tools/mainnet-validate/harness/test/checkpoint.test.ts`
- Create: `tools/mainnet-validate/harness/test/error-report.test.ts`

**checkpoint.ts API:**
```ts
export type Checkpoint = {
  lastValidatedHeight: number;
  tipHeightAtStart: number;
  lastValidatedAt: string;  // ISO 8601
  shimPath: string;
  storePath: string;
  libraryVersions: { scorex: string; nipopow: string; avltree: string; ergoscript: string };
  stats: { totalBlocks: number; totalTxs: number; totalBoxesValidated: number; totalSpendsValidated: number; startedAt: string; elapsedMs: number };
  tipReachedAt?: string;
};

export function readCheckpoint(path: string): Checkpoint | null;
export function writeCheckpoint(path: string, c: Checkpoint): void;
export function deleteCheckpoint(path: string): void;
```

**error-report.ts API:**
```ts
export type ErrorReport = {
  timestamp: string;
  height: number;
  phase: "header" | "output-roundtrip" | "evaluate" | "verify-signature" | "shim";
  errorClass: string;
  errorCode?: string;
  message: string;
  stack?: string;
  location: {
    txIndex?: number;
    txId?: string;
    inputIndex?: number;
    outputIndex?: number;
    spentBoxId?: string;
    ergoTreeHex?: string;
  };
  bundleExcerpt: {
    headerHex?: string;
    txHex?: string;
    spentBoxHex?: string;
  };
};

export function writeErrorReport(path: string, r: ErrorReport): void;
export function deleteErrorReport(path: string): void;
```

- [ ] **Step 1: Implement checkpoint.ts + tests (read/write round-trip, missing-file returns null)**

- [ ] **Step 2: Implement error-report.ts + tests (write + delete behavior; structure validation)**

- [ ] **Step 3: Library-version stamp helper**

```ts
// In checkpoint.ts:
export function currentLibraryVersions(): Checkpoint["libraryVersions"];
// Reads each package's package.json via dynamic import; returns the version string.
```

- [ ] **Step 4: Run tests**

```bash
cd tools/mainnet-validate/harness && npm test
```

- [ ] **Step 5: Stage + commit**

```bash
git add tools/mainnet-validate/harness/
git commit -m "$(cat <<'EOF'
feat(2j-pre/harness): checkpoint + error-report modules with library-version
 stamp (T7)

checkpoint.json (read/write/delete; library-version stamping for mismatch
detection per Open item #2) + error-report.json (structured halt record
per spec Decision 12). Vitest unit tests for both modules. No walk
loop yet (T11).

Per spec Decisions 11, 12. T7 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Harness validate-block.ts (header pass)

**Files:**
- Create: `tools/mainnet-validate/harness/src/validate-block.ts`
- Create: `tools/mainnet-validate/harness/test/validate-block.header.test.ts`

**API:**
```ts
export type WalkerState = {
  lastHeader: Header | null;     // parent for next block's parent-link check
  rollingHeaders: Header[];      // last 10 headers, indices 0..9 (0 = most recent)
  network: "mainnet" | "testnet";
  v2ActivationHeight: number;    // 417792 for mainnet
};

export function validateHeader(bundle: BlockBundle, state: WalkerState): void;
// Throws on failure. Updates state.lastHeader + state.rollingHeaders on success.
```

**Validation steps inside `validateHeader`:**
1. `parseHeader(bundle.headerBytes)` → `header`.
2. `serializeHeader(header)` byte-equal to `bundle.headerBytes`. If not, throw a manufactured `HarnessError { phase: "header", code: "byte-roundtrip-mismatch" }`.
3. If `header.version === 1 && header.height < state.v2ActivationHeight`: catch any `AutolykosV1NotSupportedError` thrown by `verifyAutolykosV2` — don't validate PoW on these.
4. Else: `verifyAutolykosV2(header)` must return true; else throw `HarnessError { phase: "header", code: "autolykos-v2-verify-false" }`.
5. Parent-link: if `state.lastHeader !== null`, assert `header.parentId === state.lastHeader.id`. (Skip at H=0.)
6. Append to rolling window: `state.rollingHeaders.unshift(header); state.rollingHeaders = state.rollingHeaders.slice(0, 10);`.
7. Update `state.lastHeader = header`.

- [ ] **Step 1: Implement validate-block.ts header pass + WalkerState**

- [ ] **Step 2: Unit tests**

- Valid block-1-header → state updated.
- Mutated header bytes that fail serialize-byte-equal → throws byte-roundtrip-mismatch.
- V1 header below activation → no throw, no PoW verify.
- V1 header above activation → throws `v1-header-after-v2-activation` (or catches AutolykosV1NotSupportedError and re-throws).
- Wrong parent-id → throws.

(Tests will need synthetic Header data; could use `@ergots/scorex`'s test helpers or hand-construct minimal valid headers.)

- [ ] **Step 3: Run tests**

```bash
cd tools/mainnet-validate/harness && npm test
```

- [ ] **Step 4: Stage + commit**

```bash
git add tools/mainnet-validate/harness/
git commit -m "$(cat <<'EOF'
feat(2j-pre/harness): validate-block header pass (T8)

Header pass: parseHeader + serializeHeader byte-equal + verifyAutolykosV2
(with V1-below-activation skip per existing @ergots/scorex semantics) +
parent-link check (skipped at H=0). WalkerState carries lastHeader + 10-
deep rolling window for ctx.headers (consumed in T10).

Per spec Decision 2, Risk-hotspot #6. T8 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Harness validate-block.ts (output round-trip pass)

**Files:**
- Edit: `tools/mainnet-validate/harness/src/validate-block.ts`
- Create: `tools/mainnet-validate/harness/test/validate-block.output.test.ts`

**Add to validate-block.ts:**
```ts
export function validateOutputRoundtrips(bundle: BlockBundle, treeVersionFn: (boxBytes: Uint8Array) => number): void;
// For every output across all txs:
//   parseSValue(SBox, treeVersion, reader) → sbox
//   parseTree(sbox.value.ergoTree) → tree
//   serializeTree(tree) byte-equal to sbox.value.ergoTree
// Throw on first mismatch with location { txIndex, outputIndex }.
```

(Note: `treeVersion` for box-internal SBox parsing comes from the tree's header byte. The harness needs to peek at the first byte of the ErgoTree bytes to determine version before passing to parseSValue.)

- [ ] **Step 1: Implement validateOutputRoundtrips**

Iterate all outputs across all txs. For each: parse the output box as SValue(SBox), extract `.ergoTree` bytes, parseTree, serializeTree, byte-equal. On mismatch, throw `HarnessError { phase: "output-roundtrip", code: "byte-roundtrip-mismatch", location: { txIndex, outputIndex } }`.

- [ ] **Step 2: Unit tests**

Synthetic BlockBundle with known-good output box bytes → no throw. Synthetic with one tampered output → throws with the right location.

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Stage + commit**

---

## Task 10: Harness validate-tx.ts (evaluate + verifySignature)

**Files:**
- Create: `tools/mainnet-validate/harness/src/validate-tx.ts`
- Create: `tools/mainnet-validate/harness/test/validate-tx.test.ts`
- Modify: `tools/mainnet-validate/harness/src/validate-block.ts` to orchestrate header + output + per-tx passes.

**Per spec Risk-hotspot #5: source-read sigma-rust's ctx.headers padding convention for blocks at H < 10 before implementing this task.** Look for `Context::new` or equivalent in sigma-rust's test code or block-validation pipeline. Encode the convention exactly (pad with zeros, replicate genesis, or skip-eval-for-H<10). Resolves Open item #3.

**validate-tx.ts API:**
```ts
export function validateTx(
  tx: TxBundle,
  block: BlockBundle,
  walkerState: WalkerState,
): void;
// For each input: parse spent box → parse ErgoTree → build EvalContext →
// evaluate → must return SigmaProp → verifySignature(sigmaProp, signingMsg,
// signatureBytes) must return true. Throw on any failure.
```

**EvalContext construction per input:**
```ts
const allInputs = tx.inputs.map(i => parseSValue(SBox, treeVersion, fromBytes(i.spentBoxBytes)).value);
const allOutputs = tx.outputs.map(b => parseSValue(SBox, treeVersion, fromBytes(b)).value);
const dataInputs = tx.dataInputBoxes.map(b => parseSValue(SBox, treeVersion, fromBytes(b)).value);
const preHeader = preHeaderFromHeader(parsedHeader);  // field projection

for (const [i, input] of tx.inputs.entries()) {
  const selfBox = allInputs[i];
  const extension = new Map(input.contextExtension.map(([varId, constBytes]) => {
    const r = new ByteReader(constBytes);
    const tpe = parseSType(r);
    const value = parseSValue(tpe, treeVersion, r);
    return [varId, value];
  }));
  const ctx = makeContext({
    height: block.height,
    selfBox,
    inputs: allInputs,
    outputs: allOutputs,
    dataInputs,
    preHeader,
    headers: walkerState.rollingHeaders,  // padded per T10 source-read convention
    extension,
    jitCostLimit: block.parameters.maxBlockCost,
  });
  const result = evaluate(tree, ctx);
  if (result.kind !== 'SigmaProp') {
    throw new HarnessError({ phase: "evaluate", code: "non-sigmaprop-result", ... });
  }
  const verified = verifySignature(result.value, tx.signingMessage, input.signatureBytes);
  if (!verified) {
    throw new HarnessError({ phase: "verify-signature", code: "verifier-false", ... });
  }
}
```

- [ ] **Step 1: Source-read sigma-rust's H<10 padding convention**

Find sigma-rust's `Context::new` or block-validator's context construction. Common locations:
- `ergotree-interpreter/src/eval/scontext.rs`
- `ergo-lib/src/chain/...`

Record the padding convention as a top-of-file comment.

- [ ] **Step 2: Implement preHeaderFromHeader (field projection)**

Per `ergo-chain-types/src/preheader.rs:26-38`: `{ version, parent_id, timestamp, n_bits, height, miner_pk, votes }`. The miner_pk comes from `header.autolykosSolution.minerPk` per our scorex type.

- [ ] **Step 3: Implement context-extension parsing helper**

For each (varId, constBytes) entry: parse as Constant (SType + SValue prefix-tagged) using the library's wire-layer.

- [ ] **Step 4: Implement validateTx**

Per the per-input loop above. On any throw, wrap with location info.

- [ ] **Step 5: Wire all three passes in validate-block.ts**

```ts
export function validateBlock(bundle: BlockBundle, state: WalkerState): void {
  validateHeader(bundle, state);
  validateOutputRoundtrips(bundle, /* ... */);
  for (const [txIndex, tx] of bundle.transactions.entries()) {
    validateTx(tx, bundle, state, txIndex);
  }
}
```

- [ ] **Step 6: Unit tests**

- Synthetic BlockBundle with a P2PK box being spent → evaluate returns SigmaProp → verifySignature returns true → no throw.
- Wrong signature → verifySignature returns false → throws.
- Unimplemented method in a contract → evaluate throws EvalError('method-not-implemented') → harness halts with phase: "evaluate".

- [ ] **Step 7: Run tests**

- [ ] **Step 8: Stage + commit**

---

## Task 11: Harness main.ts walk loop + CLI flags

**Files:**
- Edit: `tools/mainnet-validate/harness/src/main.ts`
- Create: `tools/mainnet-validate/harness/src/cli.ts`

**CLI flags:**
- `--store-path PATH` (required) — path to user's modifiers.redb (or copy).
- `--shim-path PATH` (default `./tools/mainnet-validate/shim/target/release/ergots-mainnet-validate-shim`).
- `--sidecar-path PATH` (default `./tools/mainnet-validate/utxo-index.redb`).
- `--checkpoint-path PATH` (default `./tools/mainnet-validate/checkpoint.json`).
- `--error-report-path PATH` (default `./tools/mainnet-validate/error-report.json`).
- `--network mainnet|testnet` (default `mainnet`).
- `--start-height N` (override checkpoint; useful for bootstrap-data testing and fast iteration).
- `--max-height M` (cap for smoke tests; default = chain tip from `GET_TIP_HEIGHT`).
- `--sleep-ms N` (rate limit; default 0).

**Walk loop:**
```ts
async function main() {
  const args = parseCliArgs(process.argv);
  const shim = await ShimClient.spawn(args.shimPath, args.storePath, args.sidecarPath);
  const tipHeight = await shim.getTipHeight();
  const checkpoint = readCheckpoint(args.checkpointPath);
  const startHeight = args.startHeight ?? (checkpoint?.lastValidatedHeight ?? -1) + 1;
  const endHeight = Math.min(args.maxHeight ?? tipHeight, tipHeight);

  // Library-version mismatch check (per Open item #2): warn-and-continue
  if (checkpoint && !versionsMatch(checkpoint.libraryVersions, currentLibraryVersions())) {
    console.warn("Library version mismatch since last checkpoint; continuing anyway.");
  }

  // Rolling-header window re-fetch on resume
  const walkerState = await rebuildWalkerState(shim, startHeight, args.network);

  for (let h = startHeight; h <= endHeight; h++) {
    if (args.sleepMs > 0) await sleep(args.sleepMs);
    let bundle: BlockBundle;
    try {
      bundle = await shim.getBlock(h);
    } catch (err) {
      // Shim-side error
      writeErrorReport(args.errorReportPath, { ..., phase: "shim", ... });
      process.exit(1);
    }
    try {
      validateBlock(bundle, walkerState);
    } catch (err) {
      writeErrorReport(args.errorReportPath, classifyError(err, bundle, h));
      process.exit(1);
    }
    updateCheckpointStats(checkpoint, bundle);
    writeCheckpoint(args.checkpointPath, checkpoint);
  }

  // Tip reached
  checkpoint.tipReachedAt = new Date().toISOString();
  writeCheckpoint(args.checkpointPath, checkpoint);
  deleteErrorReport(args.errorReportPath);
  console.log(`Tip reached at height ${endHeight}.`);
}
```

- [ ] **Step 1: Implement cli.ts (argv parser)**

- [ ] **Step 2: Implement main.ts walk loop**

- [ ] **Step 3: Implement rebuildWalkerState helper (10 shim calls for rolling window)**

- [ ] **Step 4: Implement classifyError helper (instanceof checks + .code reading)**

- [ ] **Step 5: Run a tiny end-to-end against the bootstrap-data copy**

```bash
cp -a /var/lib/ergo-node/data /tmp/ergo-shim-test-data
node dist/main.js \
  --store-path /tmp/ergo-shim-test-data/modifiers.redb \
  --start-height <snapshot-height> \
  --max-height <snapshot-height + 1> \
  --sleep-ms 0
# Expect: validates 1-2 blocks, exits 0, checkpoint.json + no error-report.json.
```

- [ ] **Step 6: Stage + commit**

---

## Task 12: Layer 3 smoke test (end-to-end)

**Goal:** ≥ 1 full block validates cleanly from the user's bootstrap-data copy.

- [x] **Step 1: Make a snapshot copy of the user's data**

```bash
sudo cp /var/lib/ergo-node/data/modifiers.redb /tmp/ergots-2j-pre-smoke-data/modifiers.redb
sudo chown -R $USER:$USER /tmp/ergots-2j-pre-smoke-data
```

Snapshot taken 2026-05-22 with `ergo-node.service` stopped. State.redb omitted (not needed; sidecar rebuilds from modifiers + height_index). Snapshot redb has best_chain tip 1,790,510 (Headers count 1,790,510), height_index type-102 count 1,789,736 (heights 1..1,789,509 with a few gaps), type-108 count 1,789,760, primary count 5,385,508. Schema is the enr-store layout (tables: primary, height_index, header_forks, header_scores, best_chain, chain_meta, peer_db) confirmed via one-off `redb::Database::open` + `txn.list_tables()`.

- [x] **Step 2: Discover the lowest BlockTransactions height in the copy**

Skipped REST binary-search — snapshot inspection (Step 1) showed type-102 is contiguous from height 1, so `SNAPSHOT_HEIGHT = 1` (genesis).

- [x] **Step 3: Run harness from snapshot-height for 5 blocks**

Four attempts (see Step 4); all halted before validating ≥ 1 block. Per-attempt sidecar/checkpoint/error-report paths kept distinct under `/tmp/t12-*-attemptN.{redb,json}` to avoid cross-attempt pollution.

- [x] **Step 4: Interpret outcome — halt on TWO library bugs (scope gaps), surfaced for 2j proper fix-list**

| # | start | max | sidecar reaches | halt at | phase | errorCode | location |
|---|-------|-----|-----------------|---------|-------|-----------|----------|
| 1 | 1000  | 1004 | h=999 cleanly | h=1000 (TS) | output-roundtrip | `sbox-ergo-tree-no-size` | tx 0, output 0; header byte 0x10 |
| 2 | 1500000 | 1500004 | h=3849 cleanly (shim died mid-walk) | h=3850 (shim) | walker | `missing-utxo` | box `55274304…3c88aeda` |
| 3 | 100000 | 100004 | h=3849 (same shim halt) | h=3850 (shim) | walker | `missing-utxo` | same box |
| 4 | 3849 | 3849 | h=3848 cleanly | h=3849 (TS) | output-roundtrip | `sbox-ergo-tree-no-size` | tx 0, output 0; header byte 0x00 |
| genesis | 1 | 1 | n/a | h=1 (TS) | output-roundtrip | `sbox-ergo-tree-no-size` | tx 0, output 0; header byte 0x10 |

No `checkpoint.json` written by any attempt (`updateCheckpointStats` only fires after a block fully passes all three validation phases). Header pass DID succeed at every halt — the failure was always in the next phase. Shim ↔ harness IPC + UTXO index forward-walk + header pass are wired end-to-end and confirmed against real mainnet data through up to 3,848 contiguous blocks. The blocking library bugs are below.

**Fix-list (2j proper):**

1. **TS:** `packages/ergoscript/src/wire/parse-svalue.ts:278-287` — `parseSValue(SBox)` rejects v0 ErgoTrees with `hasSize=false` (header byte's bit-3 clear). The comment at line 280-282 claims "all real on-chain boxes use v1+ (hasSize=true)" — that's wrong: ≥ 99% of mainnet boxes use v0 P2PK trees with no size prefix (confirmed at heights 1, 1000, 3849). To bound the read we need either (a) full body parse via the wire-layer `parseTree` machinery, or (b) a length-determining body walker. Either way this is the single largest scope item before any block can validate cleanly.

2. **Shim:** `tools/mainnet-validate/shim/src/block_walker.rs:535` — at `ingest_block(3850)` the sidecar `MissingUtxo` for box `55274304…3c88aeda` reproduces deterministically across runs (attempts 2 and 3 both halt there). The shim walker uses `ergo-lib`'s `out.box_id()` to key the index insert and `Transaction::sigma_parse` + `input.box_id` to key the lookup. Possible causes: (a) sigma-rust round-trip via `sigma_serialize_bytes` produces a different byte image than the on-chain box, changing the derived `box_id` at insert time vs. what the next block's input references; (b) a fork-handling issue (the walker uses `read_header_at` which dispatches through `best_header_at`, so non-best-chain forks should not be visible — but worth confirming there's no fork-replacement issue at h ≤ 3849 that left an orphan insert in the index). Reproducer: any walk from genesis past 3849. Triage: dump `box_id` of every output at heights 3000-3849 from a Rust scan, compare to the box referenced by block 3850's first input.

3. **Spec:** the commit-message template assumed ≥ 1 block would validate cleanly; with both fix-list items above blocking that, T12 reframes as "smoke confirms wiring; deliverable is the fix-list, not a clean-walk count." T15 SESSION_CONTEXT should record this so the next session opens with this triage.

- [x] **Step 5: Stage + commit**

No source/test/fixture changes from this task — only PLAN.md updates (this section's box-ticks + the fix-list). The smoke artifacts under `/tmp/t12-*` are gitignored by location, not by .gitignore (the entire `/tmp/` tree is out of the working dir). Commit message reframed to match actual outcome:

```bash
git commit -m "$(cat <<'EOF'
test(2j-pre/smoke): Layer 3 smoke confirms wiring; 2j fix-list captured (T12)

Ran harness against a 25 GB bootstrap-data snapshot
(/tmp/ergots-2j-pre-smoke-data; tip 1,790,510). Four start-height
attempts (1, 1000, 3849, 100000, 1500000) all halt before validating
≥ 1 block — but the halts are TWO scope-gaps in the library/shim, not
wiring failures: (a) packages/ergoscript/src/wire/parse-svalue.ts:278
rejects v0 ErgoTrees with hasSize=false (~all mainnet boxes), and
(b) tools/mainnet-validate/shim/src/block_walker.rs:535 emits
missing-utxo at ingest_block(3850), reproducible across runs.

Header pass DID succeed at every halt; shim ↔ harness IPC, UTXO index
forward-walk, and header validation wired and confirmed against
real mainnet data through up to 3848 contiguous blocks. Both
library bugs become 2j proper's fix-list.

T12 of 15.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Layer 4/5/6 path tests (halt, resume, tip-reach)

**Files:**
- Create: `tools/mainnet-validate/harness/test/integration/halt-path.test.ts`
- Create: `tools/mainnet-validate/harness/test/integration/resume-path.test.ts`
- Create: `tools/mainnet-validate/harness/test/integration/tip-reach-path.test.ts`

**Test approach:** spawn the harness as a subprocess against a curated test fixture (synthetic redb with a small chain) for halt/resume/tip-reach scenarios. Alternatively: against the bootstrap-data copy with deliberate fault injection.

- [ ] **Step 1: Halt path test**

Run the harness against a non-existent --store-path → shim fails → harness exits 1 with `ShimError` on stderr. NOTE: per `halt-path.test.ts`, startup-halts do NOT write `error-report.json` (the failure is in the startup arm at `main.ts:118-189`, before the per-block `tryValidateBlock` catch arm that writes the sidecar at `main.ts:443-452`). Mid-walk halts DO write the sidecar — both behaviors are pinned by the two test cases.

- [ ] **Step 2: Resume path test**

Run against a real (or fixture) data dir, --max-height H, succeed. Run again (no --start-height) → confirms checkpoint resume, walks 1 more block.

- [ ] **Step 3: Tip-reach path test**

Run with --max-height << tip → confirms clean exit, tipReachedAt set, error-report deleted.

- [ ] **Step 4: Run tests**

```bash
cd tools/mainnet-validate/harness && npm test
```

- [ ] **Step 5: Stage + commit**

---

## Task 14: README.md for tools/mainnet-validate/

**Files:**
- Create: `tools/mainnet-validate/README.md`

**Contents:**
- **Purpose:** brief — "Mainnet validation harness for ergots library; pure stop-on-error; 2j-pre infrastructure for the 2j cost-calibration phase."
- **Prerequisites:** ergo-node-rust full-archive (no utxo_bootstrap=true); rust toolchain; node ≥ 20.
- **Build:** `cd shim && cargo build --release` + `cd ../harness && npm install && npm run build`.
- **Run:** the full CLI invocation example.
- **Interpreting halts:** explain phase + errorClass + errorCode; how to triage; how to resume.
- **Copying redb for testing:** safe operating procedure (cp -a; don't lock the live one).
- **Tuning rate limit:** --sleep-ms + OS-level (nice/cpulimit/ionice).
- **Known limits:** no cost-integer exactness vs sigma-rust (that's 2j proper); no continuous mode; no tx parser in TS yet.
- **References:** spec link + CLAUDE.md link.

- [ ] **Step 1: Write README.md**

- [ ] **Step 2: Stage + commit**

---

## Task 15: SESSION_CONTEXT.md + HANDOFF_PROMPT.md sweep + memory refresh + push

**Files:**
- Edit: `SESSION_CONTEXT.md` (refresh to post-2j-pre state)
- Edit: `HANDOFF_PROMPT.md` (refresh to point at 2j proper as next phase)
- Possibly edit: `facts/` if any cross-reference to the harness is warranted (probably not; harness is a tool, not a library surface).
- Refresh `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` and any related memory files.

- [ ] **Step 1: SESSION_CONTEXT.md sweep**

Update to: "Phase 2j-pre COMPLETE. Spec at <hash>. Harness machinery + smoke-test landed. Next: 2j proper (walk-to-tip via harness, fix-resume cycles)."

- [ ] **Step 2: HANDOFF_PROMPT.md refresh**

- [ ] **Step 3: facts/ pass — check if any need cross-reference to harness existence**

Likely no — harness is a dev tool, not a published surface. But sanity-check.

- [ ] **Step 4: Memory refresh**

Update `project_ergots_direction.md` to reflect 2j-pre done; queue 2j next.

- [ ] **Step 5: Push to origin**

```bash
git push origin master
```

(Per OVERRIDES + project convention: never `--force`, never `--no-verify`.)

- [ ] **Step 6: Final verification**

```bash
git status                                # clean modulo audit20260519/
git log --oneline -16                     # confirm 15 task commits + spec commit (78cfde8 baseline → ~93xxxxx HEAD)
ls tools/mainnet-validate/                # README + shim/ + harness/
```

- [ ] **Step 7: Stage + commit any final docs**

```bash
git add SESSION_CONTEXT.md HANDOFF_PROMPT.md
git commit -m "..."
git push origin master
```

---

## Done criteria for the phase

- All 15 tasks committed.
- `git status` clean modulo `audit20260519/`.
- `origin/master` aligned with local `master`.
- `cargo build --release` clean in `tools/mainnet-validate/shim/`.
- `cargo test` clean in `tools/mainnet-validate/shim/`.
- `npm install && npm run build && npm test` clean in `tools/mainnet-validate/harness/`.
- Layer 3 smoke test (T12) walks ≥ 1 full block end-to-end without library-bug halt against a bootstrap-data copy.
- Layer 4/5/6 path tests (T13) pass under vitest.
- README.md exists and accurately documents setup + run + triage.
- `packages/*/` tests untouched (still 3,772 passing under node + jsdom).
- `npx tsc --noEmit` clean per published package (no harness changes should affect this).
- SESSION_CONTEXT.md + HANDOFF_PROMPT.md reflect post-2j-pre state.
- `project_ergots_direction` memory refreshed.

**Done criteria explicitly NOT in scope (these are 2j proper):**
- Walking the chain to tip cleanly.
- Implementing every method handler the chain demands.
- Closing every cost-related divergence.
