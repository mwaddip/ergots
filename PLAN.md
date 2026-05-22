# Phase 2j-pre fix-2 — Genesis-box seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto/cost-path → halt and declare (this fix is NOT crypto/cost-path, but the rule stays); #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads; #10 — truncation suspicion on grep results]. Per `[[feedback-subagent-explicit-rules]]`, this preamble is load-bearing.

**Spec:** `docs/specs/2026-05-22-mainnet-validate-fix-2-genesis-box-seeding-design.md` (v2, reviewer pass applied)

**Goal:** Seed the shim's UTXO sidecar with Ergo's 3 genesis-state boxes (emission, no_premine, founders) at initialization. The missing founders-box seeding is the deterministic cause of the `missing-utxo at h=3850` halt that blocks fix-1's smoke from walking further.

**Architecture (one-paragraph summary):** Copy 3 const blocks (FOUNDERS_PKS + 2 NO_PREMINE_PROOFS arrays) from `ergo-node-rust/src/main.rs:33-57` into a new `shim/src/genesis_constants.rs` with SOURCE comments. Extend `UtxoIndex::open_or_create` with a `genesis_seed` arg; insert the 3 boxes into the boxes table during the same write_txn that initializes meta. In `shim/src/main.rs`, add a `--network mainnet|testnet` CLI flag (default mainnet), compute the 3 genesis boxes via `ergo_lib::chain::genesis::genesis_boxes(...)`, pass the seed to `open_or_create`. Add a defensive hard-coded expected-id assertion (per `ergo-node-rust/src/main.rs:3092-3096` for mainnet + `external/sigma-rust/ergo-lib/src/chain/genesis.rs:241-269` for testnet). On the harness side, extend `ShimClient.spawn` from 3-arg to 4-arg accepting network; update the single call site at `harness/src/main.ts:364`. Remove the `GENESIS_HEIGHT` input-skip special-case at `shim/src/block_walker.rs:519-524` AND rewrite the `ingest_block_walks_synthetic_genesis_block_end_to_end` test (lines 911-1158) to use real seeded boxes. Verify via Layer 3 smoke from a FRESH sidecar (delete existing one first).

**Invariants:**
- Library behavior unchanged: no `@ergots/*` package changes; package tests stay at 3201 (ergoscript) + 156 (avltree) + 245 (nipopow) + 177 (scorex) = 3779.
- Shim's wire protocol unchanged (CBOR over stdin/stdout).
- Harness validation passes unchanged (header / output-roundtrip / evaluate / verifySignature).
- Existing shim tests continue to pass (with updated call-site signatures + the one explicit test rewrite at T7).

---

## Task ordering

```
T1   PLAN.md committed (this document; overwrites fix-1 plan)
T2   Copy ergo-node-rust constants into shim/src/genesis_constants.rs;
     add Network enum (mainnet|testnet). Verify cargo build.
T3   Layer 1 RED — Unit test for UtxoIndex::open_or_create with
     genesis_seed arg. Test fails (no seeding implementation).
T4   GREEN — Implement UtxoIndex::open_or_create seeding; update 4
     existing utxo_index test call sites with &[]. Verify cargo
     test passes.
T5a  Shim-side: --network CLI flag parsing in main.rs; thread
     through to UtxoIndex::open_or_create; compute genesis_seed
     via ergo_lib::chain::genesis::genesis_boxes(). Verify cargo
     build + test.
T5b  Harness-side: extend ShimClient.spawn signature to 4-arg
     accepting network; update single call site at main.ts:364;
     update any harness tests. Verify npm test + npm run build.
T6   Layer 2 — Network-specific box-id assertion in shim startup;
     hard-coded expected ids per network. Verify cargo test.
T7   Remove GENESIS_HEIGHT special-case at block_walker.rs:519-524.
     CRITICAL sub-step: rewrite ingest_block_walks_synthetic_genesis_
     block_end_to_end (block_walker.rs:911-1158) to use real seeded
     boxes. Verify cargo test --release passes.
T8   Re-run Layer 3 smoke from a FRESH sidecar (delete existing one).
     Document new halt site or clean tip-reach in
     tools/mainnet-validate/findings/2026-05-22-fix-2-smoke.md.
T9   Refresh harness integration tests for the new halt site
     (analogous to fix-1 T8). Verify npm test.
T10  SESSION_CONTEXT + HANDOFF + memory refresh + push.
```

Total: ~11 commits (T1 + T2 + T3 + T4 + T5a + T5b + T6 + T7 + T8 + T9 + T10).

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `/home/mwaddip/projects/ergots/PLAN.md` (this file, overwrites fix-1 plan)

- [ ] **Step 1: Stage and commit**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): overwrite PLAN.md with phase 2j-pre fix-2 execution plan

Per HANDOFF_PROMPT.md convention: PLAN.md is the in-flight phase's task
list, overwritten at each phase boundary. Spec at
docs/specs/2026-05-22-mainnet-validate-fix-2-genesis-box-seeding-design.md
(v2, reviewer pass applied).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Copy ergo-node-rust constants + Network enum

**Files:**
- Create: `tools/mainnet-validate/shim/src/genesis_constants.rs`
- Edit: `tools/mainnet-validate/shim/src/main.rs` (add `mod genesis_constants;`)

**Contents of new `genesis_constants.rs`:**

```rust
//! Genesis-state box construction constants.
//!
//! These are COPIED from ergo-node-rust/src/main.rs (lines as cited in
//! each block's SOURCE comment). The constants live in the binary crate
//! there, not exposed via lib.rs — path-dep is impossible. Copying with
//! source citations is the only viable path; lifecycle is low (constants
//! change only at chain-genesis-rewrite events, never on production).
//!
//! Decision 6's box-id assertion at shim startup catches any drift loudly.

/// Testnet no-premine proof strings (ergo-node-rust/src/main.rs:33-39).
// SOURCE: ergo-node-rust/src/main.rs:33-39
pub const TESTNET_NO_PREMINE_PROOFS: &[&str] = &[
    // ... copy verbatim ...
];

/// Mainnet no-premine proof strings (ergo-node-rust/src/main.rs:43-49).
// SOURCE: ergo-node-rust/src/main.rs:43-49
pub const MAINNET_NO_PREMINE_PROOFS: &[&str] = &[
    // ... copy verbatim ...
];

/// Foundation multisig public keys (ergo-node-rust/src/main.rs:53-57).
// SOURCE: ergo-node-rust/src/main.rs:53-57
pub const FOUNDERS_PKS: &[&str] = &[
    // ... copy verbatim ...
];

/// Network selection for genesis-box seeding. Self-contained 2-variant
/// enum so we don't pull in enr-p2p just for the type.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    pub fn no_premine_proofs(&self) -> &'static [&'static str] {
        match self {
            Network::Mainnet => MAINNET_NO_PREMINE_PROOFS,
            Network::Testnet => TESTNET_NO_PREMINE_PROOFS,
        }
    }
}
```

- [ ] **Step 1: Read ergo-node-rust/src/main.rs:33-57**

To get the exact const definitions.

- [ ] **Step 2: Create genesis_constants.rs with the verbatim copies**

- [ ] **Step 3: Wire the module in main.rs**

Add `mod genesis_constants;` near the top of `main.rs` alongside the existing `mod` lines.

- [ ] **Step 4: Verify cargo build**

```bash
cargo build --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml
```

- [ ] **Step 5: Stage + commit**

```bash
git add tools/mainnet-validate/shim/src/genesis_constants.rs \
        tools/mainnet-validate/shim/src/main.rs
git commit -m "$(cat <<'EOF'
feat(2j-pre/fix-2): copy ergo-node-rust genesis constants into shim (T2)

New shim/src/genesis_constants.rs contains verbatim copies of:
- TESTNET_NO_PREMINE_PROOFS (SOURCE: ergo-node-rust/src/main.rs:33-39)
- MAINNET_NO_PREMINE_PROOFS (SOURCE: ergo-node-rust/src/main.rs:43-49)
- FOUNDERS_PKS (SOURCE: ergo-node-rust/src/main.rs:53-57)

Plus a self-contained Network enum (2 variants) so we don't pull enr-p2p
just for the type. Path-dep was impossible — these constants live in
the binary crate's src/main.rs, not in src/lib.rs.

T2 of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Layer 1 RED — failing test for UtxoIndex genesis seeding

**Files:**
- Edit: `tools/mainnet-validate/shim/src/utxo_index.rs` (add to existing test module)

**Failing test to add:**

```rust
#[test]
fn open_or_create_seeds_genesis_boxes_on_fresh_init() {
    let tempdir = tempfile::tempdir().unwrap();
    let path = tempdir.path().join("test.redb");
    let source_hash = [0x11u8; 32];

    // 3 synthetic seed entries. The actual genesis box ids/bytes don't
    // matter for THIS test — we're verifying the seeding mechanism, not
    // the box-id derivation (that's Layer 2).
    let seed_entries: Vec<([u8; 32], Vec<u8>)> = (0..3)
        .map(|i| {
            let mut id = [0u8; 32];
            id[0] = i as u8;
            let bytes = vec![0xff; 50 + i as usize];  // distinguishable lengths
            (id, bytes)
        })
        .collect();

    let index = UtxoIndex::open_or_create(&path, &source_hash, &seed_entries).unwrap();

    // All 3 seeded boxes are queryable.
    for (id, expected_bytes) in &seed_entries {
        let got = index.get(id).unwrap().unwrap();
        assert_eq!(got, *expected_bytes);
    }

    // indexed_up_to_height is still 0 (seeding doesn't advance the marker).
    assert_eq!(index.indexed_up_to_height().unwrap(), 0);
}

#[test]
fn open_or_create_re_seeds_on_rebuild() {
    let tempdir = tempfile::tempdir().unwrap();
    let path = tempdir.path().join("test.redb");

    let seed_entries: Vec<([u8; 32], Vec<u8>)> = vec![
        ([0xaa; 32], vec![1, 2, 3]),
        ([0xbb; 32], vec![4, 5, 6]),
        ([0xcc; 32], vec![7, 8, 9]),
    ];

    // First open with hash_v1 — seeds 3 boxes.
    {
        let index = UtxoIndex::open_or_create(&path, &[0xa1; 32], &seed_entries).unwrap();
        assert_eq!(index.get(&[0xaa; 32]).unwrap().unwrap(), vec![1, 2, 3]);
    }

    // Re-open with a DIFFERENT hash — triggers rebuild. Seeds must re-apply.
    let index = UtxoIndex::open_or_create(&path, &[0xa2; 32], &seed_entries).unwrap();
    for (id, bytes) in &seed_entries {
        assert_eq!(index.get(id).unwrap().unwrap(), *bytes);
    }
    assert_eq!(index.indexed_up_to_height().unwrap(), 0);
}
```

- [ ] **Step 1: Add the failing tests to the existing `mod tests` block in utxo_index.rs**

- [ ] **Step 2: Run the tests; confirm they fail with compile errors (`open_or_create` doesn't accept 3rd arg)**

```bash
cargo test --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml 2>&1 | tail -20
```

- [ ] **Step 3: Stage + commit (RED commit — test file changes only)**

```bash
git add tools/mainnet-validate/shim/src/utxo_index.rs
git commit -m "$(cat <<'EOF'
test(2j-pre/fix-2): RED — failing tests for UtxoIndex genesis seeding (T3)

Adds 2 failing tests to utxo_index.rs::tests:
- open_or_create_seeds_genesis_boxes_on_fresh_init: 3 synthetic seed
  entries pass through to open_or_create; all 3 queryable post-init.
- open_or_create_re_seeds_on_rebuild: hash mismatch triggers rebuild;
  seeds must re-apply.

Both fail with compile errors today — open_or_create doesn't accept
a genesis_seed arg yet. T4's GREEN step adds it.

T3 of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: GREEN — implement UtxoIndex seeding

**Files:**
- Edit: `tools/mainnet-validate/shim/src/utxo_index.rs`

**Changes:**

1. **Extend `open_or_create` signature:**

```rust
pub fn open_or_create(
    path: &Path,
    source_store_hash: &[u8; 32],
    genesis_seed: &[([u8; 32], Vec<u8>)],
) -> Result<Self> {
```

2. **In the FRESH-INIT path** (when no prior source_store_hash exists), insert the seed entries inside the same write_txn that writes meta. Per reviewer M3, redb's `WriteTransaction::open_table(BOXES_TABLE)` auto-creates the table; insert each `(box_id, bytes)` after that.

3. **In the REBUILD path** (when source_store_hash mismatches), after `delete_table(BOXES_TABLE)` + meta reset, also insert the seed entries (re-opening BOXES_TABLE in the same write_txn auto-creates it).

4. **In the MATCHING path** (existing sidecar with matching hash), do NOT re-seed — the existing data already contains the seeds from a prior init.

**Update existing test call sites** (reviewer M2 enumeration):
- `round_trip_insert_get_remove` — pass `&[]` for genesis_seed.
- `indexed_up_to_height_persists` — pass `&[]`.
- `marker_survives_reopen` — pass `&[]`.
- `hash_mismatch_triggers_rebuild` — pass `&[]`.

- [ ] **Step 1: Re-read utxo_index.rs (OVERRIDES rule #8)**

```bash
# utxo_index.rs is ~400 lines; one Read.
```

- [ ] **Step 2: Edit open_or_create signature + implementation**

- [ ] **Step 3: Update the 4 existing test call sites with `&[]` for genesis_seed**

- [ ] **Step 4: Run all utxo_index tests**

```bash
cargo test --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml utxo_index 2>&1 | tail -15
```

Expected: all tests pass (including the 2 new ones from T3).

- [ ] **Step 5: Run ALL shim tests to ensure no other call sites were missed**

```bash
cargo test --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml 2>&1 | tail -15
```

Expected: any other `open_or_create` call sites in non-utxo_index tests (e.g., block_walker tests) also need `&[]`. Update if needed.

- [ ] **Step 6: Stage + commit**

```bash
git add tools/mainnet-validate/shim/src/utxo_index.rs \
        tools/mainnet-validate/shim/src/block_walker.rs  # if any tests there updated
git commit -m "$(cat <<'EOF'
feat(2j-pre/fix-2): UtxoIndex::open_or_create accepts genesis_seed (T4)

Extends open_or_create with a third arg `genesis_seed: &[([u8; 32], Vec<u8>)]`.
Both the fresh-init path AND the rebuild path insert each seed entry
into the boxes table during the same write_txn that writes meta. redb's
WriteTransaction::open_table auto-creates BOXES_TABLE after the
delete_table call in the rebuild path; insertion fits cleanly.

Updates the 4 existing utxo_index test call sites + any other call sites
in shim tests to pass &[]. The 2 RED tests from T3 turn GREEN.

T4 of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5a: Shim-side — --network CLI flag + compute genesis_seed

**Files:**
- Edit: `tools/mainnet-validate/shim/src/main.rs`

**Changes:**

1. Add `--network mainnet|testnet` flag parsing (default mainnet).
2. Compute the 3 genesis boxes via `ergo_lib::chain::genesis::genesis_boxes(MonetarySettings::default(), &founders_pks, 2, &network.no_premine_proofs())`.
3. Pass the resulting `Vec<([u8; 32], Vec<u8>)>` to `UtxoIndex::open_or_create`.

**Argv parser:** the shim currently uses positional args 1 (store_path) and 2 (sidecar_path). Add flag handling that accepts `--network mainnet` or `--network testnet` interleaved with positional args. Simplest: process all args looking for `--network <value>` first; consume those two; the remaining positional args are store_path + sidecar_path.

**Genesis-box construction (per spec Decision 1 + ergo-node-rust/src/main.rs:81-114):**

```rust
fn build_genesis_seed(network: Network) -> Result<Vec<([u8; 32], Vec<u8>)>> {
    use ergo_lib::chain::genesis::genesis_boxes;
    use ergo_lib::ergotree_ir::chain::ergo_box::MonetarySettings;
    use ergo_lib::ergotree_ir::sigma_protocol::dlog_group::EcPoint;
    use ergo_lib::ergotree_ir::sigma_protocol::sigma_boolean::ProveDlog;

    let settings = MonetarySettings::default();
    let founders_pks: Vec<ProveDlog> = FOUNDERS_PKS
        .iter()
        .map(|hex_str| {
            let bytes = hex::decode(hex_str).expect("invalid founder pk hex");
            let point = EcPoint::sigma_parse_bytes(&bytes).expect("invalid EC point");
            ProveDlog::new(point)
        })
        .collect();
    let proof_strings = network.no_premine_proofs();
    let (emission, no_premine, founders) = genesis_boxes(
        &settings,
        &founders_pks,
        2,  // 2-of-3 threshold
        proof_strings,
    )?;
    [emission, no_premine, founders]
        .into_iter()
        .map(|b| {
            let id: [u8; 32] = b.box_id().as_ref().try_into().unwrap();
            let bytes = b.sigma_serialize_bytes()?;
            Ok((id, bytes))
        })
        .collect::<Result<_>>()
}
```

(Adjust imports / paths to match what's actually available.)

- [ ] **Step 1: Read shim/src/main.rs to find the argv parsing site**

- [ ] **Step 2: Add --network parsing + Network enum import**

- [ ] **Step 3: Add `hex` crate dep to shim/Cargo.toml** (used by build_genesis_seed)

```toml
hex = "0.4"
```

- [ ] **Step 4: Implement build_genesis_seed + wire it into UtxoIndex::open_or_create call**

- [ ] **Step 5: Verify**

```bash
cargo build --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml 2>&1 | tail -5
cargo test --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml 2>&1 | tail -10
```

- [ ] **Step 6: Smoke-test the shim binary**

```bash
echo "GET_TIP_HEIGHT" | /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/target/release/ergots-mainnet-validate-shim \
  --network mainnet \
  /tmp/ergots-2j-pre-smoke-data/modifiers.redb \
  /tmp/t5a-fix2-sidecar.redb 2>&1 | head -10
```

Expected: shim accepts the flag, opens the store, seeds the 3 boxes, responds with tip.

- [ ] **Step 7: Stage + commit**

```bash
git add tools/mainnet-validate/shim/src/main.rs tools/mainnet-validate/shim/Cargo.toml
git commit -m "$(cat <<'EOF'
feat(2j-pre/fix-2): shim --network flag + genesis-box seeding (T5a)

Adds --network mainnet|testnet flag parsing to shim/src/main.rs
(default mainnet). At startup, the shim now computes the 3 Ergo
genesis-state boxes via ergo_lib::chain::genesis::genesis_boxes()
+ the copied FOUNDERS_PKS/NO_PREMINE_PROOFS constants from
genesis_constants.rs, and passes them as genesis_seed to
UtxoIndex::open_or_create.

Mirrors ergo-node-rust src/main.rs:81-114 build_genesis_boxes pattern
exactly. Adds hex = "0.4" as a direct dep (for founder pk parsing).

T5a of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5b: Harness-side — ShimClient.spawn signature

**Files:**
- Edit: `tools/mainnet-validate/harness/src/protocol.ts` (ShimClient.spawn)
- Edit: `tools/mainnet-validate/harness/src/main.ts` (single call site)
- Edit: any harness test that spawns ShimClient

**Changes:**

1. `ShimClient.spawn(shimPath, storePath, sidecarPath, network)` — extend to 4 args.
2. Inside spawn, prepend `['--network', network]` to the subprocess args:

```ts
const proc = spawn(shimPath, ['--network', network, storePath, sidecarPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
});
```

3. Update `harness/src/main.ts:364` call site to pass `args.network`.
4. Update any harness tests (e.g., `_helpers.ts` if it has a `runHarness` that internally spawns).

- [ ] **Step 1: Read protocol.ts spawn implementation**

- [ ] **Step 2: Extend signature + subprocess args**

- [ ] **Step 3: Update main.ts:364 call site**

- [ ] **Step 4: Grep for any other ShimClient.spawn call sites**

```bash
grep -rn "ShimClient.spawn\|ShimClient\.spawn" /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/ --include="*.ts" 2>&1
```

Update each.

- [ ] **Step 5: Verify**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm test 2>&1 | tail -10
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm run build 2>&1 | tail -5
cd /home/mwaddip/projects/ergots
```

Expected: all 74 harness tests pass; dist/ rebuilt.

- [ ] **Step 6: Stage + commit**

```bash
git add tools/mainnet-validate/harness/src/protocol.ts \
        tools/mainnet-validate/harness/src/main.ts
git commit -m "$(cat <<'EOF'
feat(2j-pre/fix-2): ShimClient.spawn accepts network (T5b)

Extends ShimClient.spawn from 3-arg (shimPath, storePath, sidecarPath)
to 4-arg (... + network). Inside spawn, prepends ['--network', network]
to the subprocess args, matching the shim's new flag parser from T5a.

Updates the single call site at main.ts:364 to pass args.network (which
was already read from CLI per cli.ts:36-37). Updates any harness test
that spawns ShimClient directly.

T5b of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Layer 2 — Network-specific box-id assertion test

**Files:**
- Edit: `tools/mainnet-validate/shim/src/main.rs` (add assertion at startup OR test module)

**Two flavors of the check:**

1. **Startup-time assertion (production runtime):** after `build_genesis_seed(network)` returns, assert each computed box_id matches the network's expected list. Fail fast with a clear error if any mismatch.

2. **Test (separate verification):** a `#[test]` that calls `build_genesis_seed(Network::Mainnet)` + `build_genesis_seed(Network::Testnet)` and asserts both produce the expected 3-id triple.

**Expected IDs (per spec Decision 6):**

```rust
const MAINNET_EXPECTED_IDS: [&str; 3] = [
    "b69575e11c5c43400bfead5976ee0d6245a1168396b2e2a4f384691f275d501c",  // emission
    "b8ce8cfe331e5eadfb0783bdc375c94413433f65e1e45857d71550d42e4d83bd",  // no_premine
    "5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda",  // founders
];

const TESTNET_EXPECTED_IDS: [&str; 3] = [
    "b69575e11c5c43400bfead5976ee0d6245a1168396b2e2a4f384691f275d501c",  // emission (same)
    "3bfaf76c824df668822dfce71abaf688d0281f91c3ac2a271f92fa28c3efaac7",  // no_premine
    "5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda",  // founders (same)
];
```

- [ ] **Step 1: Add the expected-ids constants + startup-time assertion to main.rs**

- [ ] **Step 2: Add the test that exercises both networks**

- [ ] **Step 3: Verify**

```bash
cargo test --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml 2>&1 | tail -10
```

Expected: all tests pass, including the new network-id assertions.

- [ ] **Step 4: Stage + commit**

```bash
git add tools/mainnet-validate/shim/src/main.rs
git commit -m "$(cat <<'EOF'
feat(2j-pre/fix-2): network-specific box-id defensive assertion (T6)

Adds startup-time + test-time assertions that the 3 computed genesis
box ids match the network's expected hard-coded list:

- Mainnet expected: per ergo-node-rust src/main.rs:3092-3096
  (mainnet_genesis_boxes_produce_correct_digest test).
- Testnet expected: per external/sigma-rust/ergo-lib/src/chain/
  genesis.rs:241-269 (existing sigma-rust testnet test).

Emission + founders ids are identical across networks; only no_premine
differs. The assertion catches future drift in MonetarySettings::default()
or FOUNDERS_PKS that would silently produce different ids.

T6 of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Remove GENESIS_HEIGHT special-case + rewrite synthetic test

**Files:**
- Edit: `tools/mainnet-validate/shim/src/block_walker.rs`

**Changes:**

1. **Remove the special-case at lines 519-524:**

```rust
// BEFORE:
let spent_box_bytes = if height == GENESIS_HEIGHT {
    Vec::new()  // skip lookup at genesis
} else {
    index.remove(&box_id_arr)?.ok_or(WalkerError::MissingUtxo { ... })?
};

// AFTER:
let spent_box_bytes = index.remove(&box_id_arr)?
    .ok_or(WalkerError::MissingUtxo {
        box_id: box_id_arr,
        height,
    })?;
```

2. **Rewrite the test at lines 949-1158:** `ingest_block_walks_synthetic_genesis_block_end_to_end`. Per reviewer C2:
   - (a) Seed the 3 real genesis boxes into the test sidecar BEFORE calling `ingest_block`.
   - (b) Replace the synthetic `BoxId::zero()` input with the real seeded emission box id + serialized bytes.
   - (c) Remove the `spent_box_bytes.is_empty()` assertion at line 1132 — lookup now succeeds with the real emission box bytes.

The test should construct a synthetic h=1 block whose first tx spends the emission box and produces a new emission-shaped output. The test verifies:
   - `ingest_block(1, ...)` returns successfully.
   - The returned BlockBundle's tx[0].inputs[0].spent_box_bytes equals the seeded emission box bytes.
   - The sidecar no longer contains the original emission box id (REMOVE succeeded).
   - The sidecar contains the new emission-shaped output.

- [ ] **Step 1: Re-read block_walker.rs (OVERRIDES rule #8)**

This is the largest single file (~1200 lines); read in chunks.

- [ ] **Step 2: Remove the GENESIS_HEIGHT special-case**

The `GENESIS_HEIGHT` constant might still be referenced elsewhere (e.g., genesis-block tx-id checks). Keep the constant but remove its use in walk_transaction's input loop.

- [ ] **Step 3: Rewrite the synthetic genesis test**

Use `build_genesis_seed(Network::Mainnet)` to produce real seed bytes; pass them to `UtxoIndex::open_or_create`. Construct the synthetic h=1 input referencing the emission box id (not `BoxId::zero()`).

- [ ] **Step 4: Verify**

```bash
cargo test --release --manifest-path /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/Cargo.toml 2>&1 | tail -15
```

Expected: ALL shim tests pass, including the rewritten synthetic genesis test.

- [ ] **Step 5: Stage + commit**

```bash
git add tools/mainnet-validate/shim/src/block_walker.rs
git commit -m "$(cat <<'EOF'
refactor(2j-pre/fix-2): remove GENESIS_HEIGHT special-case + rewrite synthetic test (T7)

With T4-T6's genesis-box seeding in place, the input-lookup skip at
height==1 (block_walker.rs:519-524) is no longer needed. The genesis
emission box IS in the sidecar at startup; h=1's emission spend
resolves via the standard walker semantics.

Removes the special-case. Rewrites ingest_block_walks_synthetic_genesis_
block_end_to_end (lines 911-1158) to:
- Seed the 3 real genesis boxes before ingest_block (was: empty sidecar)
- Replace BoxId::zero() input with the real emission box id
- Drop the spent_box_bytes.is_empty() assertion (lookup now succeeds)

Per reviewer-pass C2: the test was the only consumer of the special-case;
bundling its rewrite with the removal keeps the change atomic.

T7 of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Re-run Layer 3 smoke from FRESH sidecar

**Goal:** confirm the harness walks past h=3850 cleanly after seeding (no more founders missing-utxo). Document new halt site or clean tip-reach.

- [ ] **Step 1: Delete existing T7 sidecar + checkpoint**

Per reviewer M5: the existing sidecar from fix-1 T7 has h=1..3849 already inserted via the empty-init path; reusing it would skip the new seeding logic entirely.

```bash
rm -f /tmp/t8-fix2-sidecar.redb /tmp/t8-fix2-checkpoint.json /tmp/t8-fix2-error-report.json
```

- [ ] **Step 2: Confirm shim + harness are built**

```bash
ls /home/mwaddip/projects/ergots/tools/mainnet-validate/shim/target/release/ergots-mainnet-validate-shim
ls /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/dist/main.js
```

- [ ] **Step 3: Run smoke from h=1**

```bash
timeout 600 node /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/dist/main.js \
  --network mainnet \
  --store-path /tmp/ergots-2j-pre-smoke-data/modifiers.redb \
  --sidecar-path /tmp/t8-fix2-sidecar.redb \
  --checkpoint-path /tmp/t8-fix2-checkpoint.json \
  --error-report-path /tmp/t8-fix2-error-report.json \
  --start-height 1 \
  --max-height 10000 \
  --sleep-ms 0 2>&1 | tail -15
```

(Adjust `--max-height` based on the prior smoke's timing: 3849 blocks took ~28s, so 10000 ≈ 73s. Beyond h=3850, walk time may scale differently as blocks become denser.)

- [ ] **Step 4: Interpret outcome**

Three outcomes:
- **A.** Walks to `--max-height` cleanly → stretch outcome; tip-reached + clean checkpoint.
- **B.** Halts at h>3850 with a NEW phase/errorCode → next fix-list item for 2j proper.
- **C.** Halts at h=3850 with `missing-utxo` again → fix didn't work; debug.

(C) shouldn't happen if T2-T7 land correctly, but if it does: check that the seeding actually ran (look at shim startup stderr), check that the seeded founders box id matches `5527430474b673...`, and re-examine.

- [ ] **Step 5: Write findings to a new file**

```bash
# Path: tools/mainnet-validate/findings/2026-05-22-fix-2-smoke.md
# Contents per spec §Layer 3 + the actual outcome.
```

- [ ] **Step 6: Stage + commit**

```bash
git add tools/mainnet-validate/findings/2026-05-22-fix-2-smoke.md
git commit -m "$(cat <<'EOF'
test(2j-pre/fix-2): Layer 3 smoke from fresh sidecar confirms seeding (T8)

After T2-T7, re-ran smoke from a FRESH sidecar (deleted prior fix-1
sidecar to force a from-h=1 walk that exercises the new seed path).

Outcome: {validates h=1..N | halts at h=N phase X errorCode Y}.

Per reviewer M5: fresh sidecar required to actually test the seed
path; a populated sidecar from fix-1 would skip the new code path
entirely (already has h=1..3849 boxes from empty-init walk).

Findings recorded in tools/mainnet-validate/findings/2026-05-22-fix-2-smoke.md.

T8 of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Refresh harness integration tests for new halt site

**Files:**
- Edit: `tools/mainnet-validate/harness/test/integration/halt-path.test.ts`
- Edit: `tools/mainnet-validate/harness/test/integration/tip-reach-path.test.ts`
- Edit: `tools/mainnet-validate/harness/test/integration/resume-path.test.ts` (if affected)

**Strategy depends on T8's outcome:**

- **If T8 outcome A (clean tip-reach to 10000):** halt-path test's premise breaks again. Restructure to use a deliberate fault injection (e.g., a corrupted store-path) — OR pin to a known stable halt point further down the chain (which would require a new --max-height much higher; slow).
- **If T8 outcome B (new halt at h=N):** update halt-path's --max-height + assertions to pin the new halt site.
- **If T8 outcome C (still h=3850):** fix didn't land correctly — debug and re-run T2-T7 as needed before T9.

- [ ] **Step 1: Re-read the 3 integration tests**

- [ ] **Step 2: Update halt-path.test.ts**

If T8 outcome A: the test needs deliberate fault injection. Options:
- Point at a corrupted store-path → fires shim startup-fail. But that's the existing startup-halt scenario.
- Use a deliberately broken --max-height combination → no halt.
- Replace strict halt-site assertions with shape-only (`expect(report).toMatchObject({ height: expect.any(Number), phase: expect.any(String) })`) + an outcome-detection branch.

If T8 outcome B: bump --max-height to the new halt + update assertions.

- [ ] **Step 3: Update tip-reach-path.test.ts**

The tip-reach test pinned h=999 with sbox-parse-failed (stale planted value). After fix-1 + fix-2, that planted value is no longer realistic. Update to use a current halt code or keep the planted-value pattern but with a realistic code.

- [ ] **Step 4: Update resume-path.test.ts**

The resume-path test was rewritten in fix-1 T8 to expect clean walks at h=101..105 and h=50..55. Those still work post-fix-2. The "back-to-back forward-walker collision" test at h=200..205 may also still work.

Likely: minimal narrative-comment update to reflect fix-2 status.

- [ ] **Step 5: Verify**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness && npm test 2>&1 | tail -10
cd /home/mwaddip/projects/ergots
```

Expected: all 74 harness tests pass.

- [ ] **Step 6: Stage + commit**

```bash
git add tools/mainnet-validate/harness/test/integration/
git commit -m "$(cat <<'EOF'
test(2j-pre/fix-2): refresh harness integration tests for new halt site (T9)

After fix-2 lands, the previously-pinned h=3850 shim halt (from fix-1
T8) is gone. Updates the 3 integration tests in
tools/mainnet-validate/harness/test/integration/ to reflect the new
halt site observed in T8 ({outcome description}).

{Per-test summary of changes.}

T9 of 10.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: SESSION_CONTEXT + HANDOFF + memory refresh + push

**Files:**
- Edit: `SESSION_CONTEXT.md` (gitignored, local-only)
- Edit: `HANDOFF_PROMPT.md` (gitignored, local-only)
- Edit: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`

- [ ] **Step 1: SESSION_CONTEXT.md refresh**

Update to reflect:
- Phase 2j-pre fix-2 COMPLETE.
- Commit count this session (11 expected).
- Test counts (unchanged from fix-1 baseline modulo any new shim tests in T3/T4/T6).
- Fix-list item 2 RESOLVED; next item (if surfaced in T8) noted.

- [ ] **Step 2: HANDOFF_PROMPT.md refresh**

Update §"Phase 2j-pre fix-list":
- Strike item 2 with RESOLVED in commit {sha} (T7 of fix-2 plan).
- Add new item N+1 if T8 surfaced one.

Update §"Phase plan status" to add `✅ Phase 2j-pre fix-2` entry.

- [ ] **Step 3: Memory refresh**

Update `project_ergots_direction.md` with fix-2 closure + updated commit table.

- [ ] **Step 4: Push**

```bash
git push origin master
```

Per OVERRIDES + project convention: never `--force`, never `--no-verify`.

- [ ] **Step 5: Final verification**

```bash
git status                          # CLEAN modulo audit20260519/
git log --oneline -13               # confirm: PLAN + 10 task commits + spec
```

---

## Done criteria for this phase

- All 10 tasks committed (11 commits total with T5 split).
- `git status` clean modulo `audit20260519/`.
- `origin/master` aligned with local `master`.
- `cargo build --release` clean in `tools/mainnet-validate/shim/`.
- `cargo test --release` clean in `tools/mainnet-validate/shim/`.
- `npm test` clean in `tools/mainnet-validate/harness/`.
- `npm run build` produces refreshed `dist/`.
- Layer 3 smoke from a FRESH sidecar walks past h=3850 (no more founders missing-utxo); findings recorded.
- Harness integration tests refreshed for the new halt site.
- SESSION_CONTEXT.md + HANDOFF_PROMPT.md reflect post-fix-2 state.
- `project_ergots_direction` memory refreshed.

**Done criteria explicitly NOT in scope:**
- Validating the chain's actual GenesisStateDigest matches the seeded boxes (defensive check is hard-coded id assertion only).
- Continuous-mode harness (still single-walk-and-exit).
- 2j proper (cost calibration).
- Any downstream halt that fix-2 surfaces — those become new focused-fix items.
