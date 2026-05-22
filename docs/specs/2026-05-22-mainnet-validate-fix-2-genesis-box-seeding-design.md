# Phase 2j-pre fix-2 — Genesis-state box seeding in the shim's UTXO sidecar

**Status:** Draft v2 (2026-05-22). Reviewer pass applied.
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Seed the shim's UTXO sidecar with Ergo's 3 genesis-state boxes (emission, no_premine, founders) at initialization. Removes the deterministic `missing-utxo at h=3850` halt that blocks fix-1's stretch-outcome smoke from walking past h=3850.

**Preceding phase:** 2j-pre fix-1 (sbox-ergo-tree-no-size resolution; 9 commits on origin/master; HEAD `7c10373`).
**Triage findings:** `tools/mainnet-validate/findings/2026-05-22-fix-2-triage.md`.

---

## Goal

Resolve fix-list item 2 from the 2j-pre handoff. Today the shim's UTXO sidecar initializes empty and only inserts boxes that appear in block-transaction outputs. Ergo's chain however starts with **3 genesis-state boxes** that exist outside any block transaction (emission contract, no-premine proof, foundation multisig). The first time any block tx spends one of these, the shim's lookup misses with `missing-utxo`. The fix-1 Layer-3 smoke surfaced this at h=3850 tx#2 in#0 spending the founders box.

The fix is to seed the 3 genesis-state boxes into the sidecar at initialization time, using `ergo_lib::chain::genesis::genesis_boxes(...)` with network-appropriate `MonetarySettings`. Mirrors ergo-node-rust's `build_genesis_boxes` + `genesis box insert` flow at `src/main.rs:81-114, 1850-1854`.

## Non-goals

- **No changes to the harness's TS validation passes.** This is a shim-only fix. Library behavior unchanged. Package tests stay at 3779.
- **No new TypeScript exports.** No changes to `@ergots/*` packages.
- **No fixture-gen Rust changes.** No new fixtures generated; existing fixtures unchanged.
- **No structural changes to the shim's protocol** (CBOR over stdin/stdout). The wire is unchanged; only the sidecar's startup state differs.
- **No consensus-level chain validation in the shim.** The seeded box ids are derived from the network's hard-coded chain parameters via sigma-rust's already-audited `genesis_boxes` function; we do not re-verify them against the store's GenesisStateDigest. (Future hardening could add this check.)

## Motivation

Three converging reasons:

1. **Triage is definitive.** The missing box id `5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda` matches `ergo-node-rust/src/main.rs:3095`'s expected mainnet founders genesis box id exactly. There's no ambiguity about the root cause.

2. **The fix is a tight delta against an audited reference.** ergo-node-rust seeds the same 3 boxes at startup via the same `ergo_lib::chain::genesis::genesis_boxes` function we'd call. Our seeding is structurally identical to the reference; only the storage layer (sidecar redb vs ergo-node-rust's state.redb) differs.

3. **Fix-1's stretch outcome remains incomplete without this.** The Layer-3 smoke validates 3849 blocks cleanly, then halts. With genesis-box seeding, the harness can advance further into mainnet history, which is itself useful for surfacing the next library divergence (if any).

## Architecture

### Decision 1: Seed at `UtxoIndex::open_or_create` when the index is fresh

The sidecar's existing initialization flow (per `utxo_index.rs:73-90` and follow-up logic):

- Fresh sidecar (no prior `source_store_hash`) → init `indexed_up_to_height = 0`, write `source_store_hash`, `boxes` table empty.
- Matching prior `source_store_hash` → keep existing state.
- Mismatching prior `source_store_hash` → drop and rebuild from scratch.

In both the "fresh" and "rebuild" paths, the new `boxes` table should be seeded with the 3 genesis boxes BEFORE the first block's walk begins. The "matching prior" path preserves whatever was seeded previously — fine, as long as the original init seeded correctly.

Implementation: `UtxoIndex::open_or_create` gains a new arg `genesis_seed: &[(BoxId32, Vec<u8>)]` (Vec of 3 entries). After the write txn that initializes `meta` and (if applicable) drops `boxes`, the same write txn inserts each genesis box into `boxes`.

The caller (shim's `main.rs` at startup) constructs the genesis_seed via `ergo_lib::chain::genesis::genesis_boxes(...)`:

```rust
let (emission, no_premine, founders) = ergo_lib::chain::genesis::genesis_boxes(
    &MonetarySettings::default(),
    &founders_pks,
    2,  // 2-of-3 threshold
    proof_strings,
)?;
let genesis_seed: Vec<([u8; 32], Vec<u8>)> = [emission, no_premine, founders]
    .into_iter()
    .map(|b| {
        let id: [u8; 32] = b.box_id().as_ref().try_into().unwrap();
        let bytes = b.sigma_serialize_bytes()?;
        Ok((id, bytes))
    })
    .collect::<anyhow::Result<_>>()?;
```

This matches ergo-node-rust's `src/main.rs:81-114` `build_genesis_boxes` function 1:1.

### Decision 2: Network selection via shim CLI flag

The 3 genesis boxes differ between mainnet and testnet ONLY in the no_premine box's R4-R8 register payloads (per the comment at `ergo-node-rust/src/main.rs:3089-3091`). The emission and founders boxes are identical on both networks.

The no_premine box's id therefore differs between mainnet and testnet (emission and founders ids are identical on both — confirmed by cross-checking `external/sigma-rust/ergo-lib/src/chain/genesis.rs:241-269` testnet tests vs `ergo-node-rust/src/main.rs:3092-3096` mainnet test). The shim needs to know which network the store represents.

Two options:

- **A. New CLI flag `--network mainnet|testnet` on the shim.** Default to mainnet. Harness already accepts `--network` (per `harness/src/cli.ts:36-37,124-134,162`), but `ShimClient.spawn(shimPath, storePath, sidecarPath)` at `harness/src/protocol.ts:420-424` is a 3-arg signature that only forwards `[storePath, sidecarPath]` to the subprocess. The shim itself uses positional args only at `shim/src/main.rs:120-124`. Plumbing the `--network` value through requires: (a) extend `ShimClient.spawn` to a 4-arg signature accepting network; (b) update the single call site at `harness/src/main.ts:364` to pass `args.network`; (c) add flag parsing to the shim's `run()` (the shim currently has no flag parser — only positional). **Recommended despite the larger surface.**
- **B. Detect from chain state.** Read genesis-block (h=1) bytes from the modifier store, extract the chain's GenesisStateDigest from somewhere (?), match against the network's expected digest. More clever but more code and more failure modes.

Recommendation: A. Simple, explicit, matches the existing harness conventions. Execution order splits this work into T5a (shim-side flag parsing + thread to `UtxoIndex::open_or_create`) and T5b (harness-side `ShimClient.spawn` signature + call-site update).

### Decision 3: Keep `GENESIS_HEIGHT` input-skip special-case

With genesis-box seeding, the emission box IS in the sidecar at startup. h=1's first tx spends it. Two paths possible:

- **Path 1 (REMOVE the special-case):** Walker treats h=1 inputs like any other height. The emission box is in the index from seeding, so the lookup + REMOVE succeeds. The new emission box from h=1's output INSERT replaces it.
- **Path 2 (KEEP the special-case):** Walker still skips h=1 lookups. Emission box stays in the index from seeding. h=1's emission output INSERT adds a SECOND emission-shaped box to the index. Then h=2's input REMOVE looks up the new box id (from h=1's output) and finds it correctly. The OLD genesis emission box stays in the index forever, unspent.

Both paths produce correct lookup results from h=2 onward. Path 2 has a memory cost (extra orphan entry) but is safer — preserves the existing genesis-handling discipline. Path 1 is cleaner.

**Recommendation: Path 1 (remove the special-case).** The seeding makes the special-case obsolete; carrying it as dead code would be misleading. Reviewer pass should weigh in if there's a subtle case I'm missing (e.g., h=1's tx has a data input that references something not seeded).

If reviewer finds a problem with Path 1, fall back to Path 2 with a doc-comment explaining why the special-case is preserved.

### Decision 4: Network-aware MonetarySettings + FOUNDERS_PKS + no-premine proofs — copy with source-comments

The `genesis_boxes` function takes 4 args: settings, founders_pks, threshold, proofs. The shim needs all 4 with network-specific values.

Looking at `ergo-node-rust/src/main.rs`:
- `MonetarySettings::default()` (sigma-rust) — same across networks. Available via `ergo_lib`.
- `FOUNDERS_PKS` at `src/main.rs:53-57` — same across networks.
- Threshold `2` — same across networks (2-of-3).
- `TESTNET_NO_PREMINE_PROOFS` at `src/main.rs:33-39` — testnet only.
- `MAINNET_NO_PREMINE_PROOFS` at `src/main.rs:43-49` — mainnet only.

**Path-dep is NOT viable** (reviewer C1 applied): `FOUNDERS_PKS`, `TESTNET_NO_PREMINE_PROOFS`, `MAINNET_NO_PREMINE_PROOFS` all live in `ergo-node-rust/src/main.rs` (binary crate). The binary's `src/lib.rs` exists but re-exports unrelated modules — none of the three constants are part of any library surface. Sigma-rust's own copy at `external/sigma-rust/ergo-lib/src/chain/genesis.rs:163-177` is `#[cfg(test)]` only and lacks the MAINNET variant entirely.

**Decision: copy the three const blocks verbatim into the shim with `// SOURCE: ergo-node-rust/src/main.rs:LINE` headers.** Create `tools/mainnet-validate/shim/src/genesis_constants.rs` containing:
- `FOUNDERS_PKS: &[&str]` (3 entries, hex-encoded compressed pubkeys; SOURCE main.rs:53-57)
- `TESTNET_NO_PREMINE_PROOFS: &[&str]` (≤5 strings; SOURCE main.rs:33-39)
- `MAINNET_NO_PREMINE_PROOFS: &[&str]` (≤5 strings; SOURCE main.rs:43-49)

The duplication is small (~30 lines total) and bounded — these constants change only at chain-genesis-rewrite events (i.e., never on production networks). Decision 6's defensive box-id assertion catches any future drift.

### Decision 5: Genesis seeding is idempotent

If `UtxoIndex::open_or_create` is called twice with the same fresh sidecar, the first call seeds the 3 boxes. The second call:
- Reads prior `source_store_hash` → matches → keeps existing state (including the 3 seeded boxes).
- No re-seed needed. Idempotent by virtue of the existing init flow.

If the sidecar is rebuilt (mismatching `source_store_hash`), the boxes table is dropped, `indexed_up_to_height` resets to 0, AND the 3 boxes are re-seeded — keeping the index consistent.

### Decision 6: Validate seeded box ids against expected

As a defensive check, after computing the 3 box ids via `genesis_boxes`, the shim asserts they match a hard-coded expected list. If they don't match, fail fast at startup with a clear error.

This guards against future upstream changes to `MonetarySettings::default()` or `FOUNDERS_PKS` that would silently produce different box ids.

**Expected ids (cited at the assertion site):**

- **Mainnet** — per `ergo-node-rust/src/main.rs:3092-3096`:
  - emission: `b69575e11c5c43400bfead5976ee0d6245a1168396b2e2a4f384691f275d501c`
  - no_premine: `b8ce8cfe331e5eadfb0783bdc375c94413433f65e1e45857d71550d42e4d83bd`
  - founders: `5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda`

- **Testnet** — per `external/sigma-rust/ergo-lib/src/chain/genesis.rs:241-269`:
  - emission: `b69575e11c5c43400bfead5976ee0d6245a1168396b2e2a4f384691f275d501c` (same as mainnet)
  - no_premine: `3bfaf76c824df668822dfce71abaf688d0281f91c3ac2a271f92fa28c3efaac7`
  - founders: `5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda` (same as mainnet)

**Recommendation: ADD the defensive check** with both networks' ids in the source. Lifecycle is low — these ids change only at chain-genesis-rewrite events (never on production).

**Network-mismatch failure mode (reviewer verification gap #2):** if an operator runs `--network mainnet` against a testnet store, the seeded mainnet emission (b69575...) and founders (552743...) IDs match testnet, so seeding completes without the defensive check tripping. The mismatch surfaces only when the first block tx referencing the testnet `no_premine` box (id `3bfaf76c...`) fires `missing-utxo` — deep into the chain, hostile to debug. Document this in the operator README so users know to suspect `--network` first if `missing-utxo` reappears at a no-premine-shaped halt.

## Error taxonomy

No new error codes introduced. The fix removes one error scenario (genesis-state box missing-utxo) without adding any.

If genesis box construction itself fails (e.g., the founders public key constants are malformed), the shim's existing startup error path applies — surfaces via stderr and exits non-zero.

## Test strategy

### Layer 1 — Rust unit test for genesis seeding

New test in `tools/mainnet-validate/shim/src/utxo_index.rs::tests`:
- Construct a fresh sidecar in a temp dir.
- Call `open_or_create` with a synthetic 3-entry genesis seed.
- Assert: post-init, `indexed_up_to_height == 0`, `boxes.len() == 3`, each genesis box id is queryable via `get`.

### Layer 2 — Network-specific genesis-id assertion test

New test in `tools/mainnet-validate/shim/src/bin/main.rs` (or a separate module):
- Compute the 3 mainnet genesis box ids.
- Assert each matches the hard-coded expected list (per Decision 6).
- Repeat for testnet.

This mirrors ergo-node-rust's `mainnet_genesis_boxes_produce_correct_digest` test directly.

### Layer 3 — Layer 3 smoke walk re-run

After implementation, re-run smoke against `/tmp/ergots-2j-pre-smoke-data/modifiers.redb` from h=1 with a higher `--max-height` (e.g., 5000). Expected outcomes:
- Walks past h=3850 cleanly (the founders spend now resolves to the seeded box).
- Either walks to `--max-height` cleanly (stretch outcome) OR hits a new downstream halt (next fix-list item for 2j proper).

Document the new state (clean walk depth or new halt site) in a findings file.

### Layer 4 — Harness integration tests

The fix-1 T8 refresh pinned the halt at h=3850 in the halt-path integration test. Once fix-2 lands, that pin becomes wrong — the halt either vanishes or moves further into the chain. Update assertions accordingly (analogous to fix-1 T8b).

## Source mapping to ergo-node-rust + sigma-rust

| Rust source (path) | Purpose |
|---|---|
| `ergo-node-rust/src/main.rs:81-114` (`build_genesis_boxes`) | Reference implementation — exact pattern to mirror in the shim. |
| `ergo-node-rust/src/main.rs:1850-1854` (genesis box insert at startup) | Confirms the "seed at init" pattern used by the audited node. |
| `ergo-node-rust/src/main.rs:3085-3104` (`mainnet_genesis_boxes_produce_correct_digest` test) | Source of expected mainnet box ids for the defensive assertion. |
| `external/sigma-rust/ergo-lib/src/chain/genesis.rs:95-154` (`genesis_boxes`) | The constructor we call. Already audited. |
| `tools/mainnet-validate/shim/src/utxo_index.rs:73-90` (`UtxoIndex::open_or_create`) | Modification target: new arg + seed-on-init path. |
| `tools/mainnet-validate/shim/src/block_walker.rs:519-524` (GENESIS_HEIGHT skip) | Decision 3 target: remove (Path 1) or preserve (Path 2). |

## Execution order

```
T1   PLAN.md committed (overwrites fix-1 plan)
T2   Copy 3 const blocks from ergo-node-rust/src/main.rs into
     new shim/src/genesis_constants.rs with explicit SOURCE
     comments (FOUNDERS_PKS, TESTNET_NO_PREMINE_PROOFS,
     MAINNET_NO_PREMINE_PROOFS). Add a Network enum (2 variants)
     locally — no enr-p2p dep added.
T3   Layer 1 RED — Unit test for UtxoIndex::open_or_create with
     genesis seeding. Test fails (no seeding implementation yet).
T4   GREEN — Implement UtxoIndex::open_or_create seeding path.
     Add new genesis_seed: &[([u8; 32], Vec<u8>)] arg; insert into
     boxes table during init write txn (both fresh-init AND rebuild
     paths). Update EXISTING utxo_index test call sites
     (round_trip_insert_get_remove, indexed_up_to_height_persists,
     marker_survives_reopen, hash_mismatch_triggers_rebuild) to
     pass &[] for genesis_seed. Verify per OVERRIDES rule #6:
       - cargo build --release --manifest-path .../shim/Cargo.toml
       - cargo test --release --manifest-path .../shim/Cargo.toml
T5a  Shim-side: add --network mainnet|testnet CLI flag to
     shim/src/main.rs. Parse from argv (default mainnet). Compute
     genesis_seed via ergo_lib::chain::genesis::genesis_boxes() +
     genesis_constants module. Pass to UtxoIndex::open_or_create.
     Verify: cargo build + cargo test in shim.
T5b  Harness-side: extend ShimClient.spawn from 3-arg to 4-arg
     accepting network. Update single call site at
     harness/src/main.ts:364. Update any harness tests that
     instantiate ShimClient. Verify:
       - npm test in tools/mainnet-validate/harness
       - npm run build (refresh dist/)
T6   Layer 2 — Network-specific box-id assertion in shim's
     genesis-box construction path. Hard-coded expected ids per
     network (mainnet from ergo-node-rust main.rs:3092-3096;
     testnet from sigma-rust genesis.rs:241-269). Test asserts
     both networks produce expected ids. Verify cargo test.
T7   Decision 3 — Remove GENESIS_HEIGHT input-skip special-case
     at shim/src/block_walker.rs:519-524. CRITICAL sub-step:
     update ingest_block_walks_synthetic_genesis_block_end_to_end
     at block_walker.rs:911-1158 — (a) seed the 3 real genesis
     boxes into the test sidecar before ingest_block, (b) replace
     synthetic BoxId::zero() input with the real seeded emission
     box id + serialized bytes, (c) remove spent_box_bytes.is_empty()
     assertion at line 1132 (lookup now succeeds). Verify
     cargo test --release passes.
T8   Re-run Layer 3 smoke against bootstrap-data.
     Pre-step: DELETE existing /tmp/ergots-2j-pre-smoke-data/
     sidecar.redb (or use a fresh sidecar path) — smoke MUST
     walk from h=1 (not from a prior fix-1 checkpoint that
     already has h=1..3849 in the index from the empty-init
     path). Document new halt site (or clean tip-reach) in
     tools/mainnet-validate/findings/2026-05-22-fix-2-smoke.md.
T9   Refresh harness integration tests for new halt site
     (analogous to fix-1 T8). Bump --max-height as needed.
     Verify: npm test in tools/mainnet-validate/harness.
T10  SESSION_CONTEXT + HANDOFF + memory refresh + push.
```

Expected commit count: ~11 (T1 plus T2-T10 with T5 split).

**Why T2 leads:** the constants are binary-crate-only; copy-with-source-comments is the only viable path (reviewer C1 applied). Resolving the dep-graph shape upfront prevents rework.

**Why T5 splits into T5a/T5b:** reviewer M1 noted the harness-side `ShimClient.spawn` signature is 3-arg today; adding the 4th arg touches multiple files including tests. Splitting isolates shim-side vs harness-side risk.

**Why T7 is its own task with explicit test-rewrite:** reviewer C2 caught that `ingest_block_walks_synthetic_genesis_block_end_to_end` at `block_walker.rs:949-1158` relies on the GENESIS_HEIGHT special-case (assertion at line 1132 explicitly tests `spent_box_bytes.is_empty()` post-skip). Removing the special-case without rewriting this test would surface as a regression mid-T7, blocking progress. T7 now bundles the removal + test rewrite as a single atomic change.

**Why T8 deletes the existing sidecar:** reviewer M5 caught that the existing sidecar at `/tmp/ergots-2j-pre-smoke-data/` was populated by the empty-init path during fix-1 — re-running smoke without a fresh sidecar would skip the new seeding logic entirely and falsely report success. T8 forces a fresh walk-from-h=1 to exercise the seed path.

## Risk hotspots

1. **Genesis box construction depends on `MonetarySettings::default()` semantics being stable.** If sigma-rust's defaults change in a future patch, the seeded box ids would diverge from chain-history ids. Mitigation: T6's hard-coded expected ids fail fast on any mismatch. Math validation (reviewer M4 applied): `founders_coins_total` at h=0 = `full15 + full45 + (frp-1) * fir` = `97,200,000,000,000 + 291,600,000,000,000 + 525,599 * 7,500,000,000` = `4,330,792,500,000,000 nanoErg` per `external/sigma-rust/ergo-lib/src/chain/genesis.rs:141` + `emission.rs:144-161` + `MonetarySettings::default()`. Genesis founders box value = `founders_coins_total - COINS_IN_ONE_ERGO` = `4,330,791,500,000,000 nanoErg` = 4,330,791.5 ERG. The triage observed h=3850 spend output #0 at 4,330,776.4 ERG; difference = 15.1 ERG distributed across outputs #1-#4. Internally consistent with founders-box-as-input hypothesis.

2. **The `ergo-node-rust` constants are binary-crate-only.** Reviewer C1 confirmed via source-read that `FOUNDERS_PKS` (src/main.rs:53-57), `TESTNET_NO_PREMINE_PROOFS` (src/main.rs:33-39), `MAINNET_NO_PREMINE_PROOFS` (src/main.rs:43-49) all live in the binary's `src/main.rs`, and `src/lib.rs` does not re-export them. Path-dep is impossible; copy-with-source-comments is the only viable approach. Decision 4 commits to this.

3. **GENESIS_HEIGHT special-case removal (Decision 3 Path 1) breaks `ingest_block_walks_synthetic_genesis_block_end_to_end`.** Reviewer C2 caught this. The test at `block_walker.rs:949-1158` constructs a synthetic h=1 block with `BoxId::zero()` input AND asserts `spent_box_bytes.is_empty()` (line 1132) — both directly depend on the special-case skipping the lookup. T7 bundles the special-case removal with an explicit rewrite of this test (seed real genesis boxes, replace synthetic input with real emission box, remove the empty-bytes assertion).

4. **Sidecar rebuild path (mismatching `source_store_hash`) must re-seed.** Currently the rebuild path at `utxo_index.rs:134-164` drops `boxes` and resets `indexed_up_to_height` inside a single write_txn. Reviewer M3 verified that redb's `WriteTransaction::open_table` auto-creates the table after `delete_table` within the same transaction — so inserting the 3 seed boxes inside that same write_txn works cleanly. T3/T4 tests both fresh-init AND rebuild paths.

5. **No mismatch verification against the actual chain.** The shim does not (yet) read the chain's GenesisStateDigest and assert that the seeded ids match. If the store represents a forked network with different genesis parameters, the seeding would be wrong. Out of scope for fix-2; documented as a future-work item.

6. **Founders box value mismatch.** See Risk #1 (math sanity check applied via reviewer M4).

7. **Network-mismatch debug hostility.** Reviewer verification gap #2: if operator runs `--network mainnet` against a testnet store, the seeded mainnet emission + founders ids match testnet (those 2 are network-agnostic). The mismatch surfaces only at the first no_premine spend (deep into the chain) as `missing-utxo`. T9's harness README update should document "if missing-utxo reappears, suspect `--network` first."

8. **Layer 3 smoke false-positive on a populated sidecar.** Reviewer M5: re-running smoke against the existing `/tmp/ergots-2j-pre-smoke-data/sidecar.redb` would skip the new seeding logic (the sidecar already has h=1..3849 boxes from the empty-init path during fix-1). T8 explicitly deletes the existing sidecar before re-running.

## Confidence check (OVERRIDES #2 — crypto/cost path)

**Confidence on fix mechanics: 93%** (reviewer-pass adjusted down from 97%).

- Triage is definitive: the missing box id matches `ergo-node-rust/src/main.rs:3095`'s expected mainnet founders id exactly. Zero ambiguity about the cause.
- The fix is structurally identical to ergo-node-rust's audited `build_genesis_boxes`. Same call signature, same constants, same insert pattern.
- The `genesis_boxes` constructor is part of sigma-rust's audited `ergo-lib` crate; no new cryptographic primitives or consensus logic introduced.
- Founders box value math sanity-checks (Risk #1 footnote): genesis founders value 4,330,791.5 ERG; h=3850 spend output #0 child value 4,330,776.4 ERG; 15.1 ERG distributed to siblings. Consistent.
- Reviewer-pass independent re-read confirmed the path-dep impossibility (C1), the existing-test breakage (C2), and the sidecar-redb idempotency claim (M3 verified).

**The 7% residual uncertainty (reviewer-pass C1 + C2 + M1/M2 surfaced):**
- 2% on the path-dep-impossible constants-copy approach — Decision 4 now commits explicitly to copy-with-source-comments, but if the constants' format (Vec of &str hex strings) shifts upstream, the copy goes stale silently. T6's expected-id assertion catches the resulting drift loudly.
- 2% on Decision 3 (special-case removal). T7 bundles the test rewrite, but a subtle h=1 path issue could still surface (e.g., a data-input that references a box not seeded). Mitigation: T8's fresh-sidecar smoke catches this end-to-end.
- 2% on the `ShimClient.spawn` 3→4-arg signature change (reviewer M1). Cross-cutting; T5a/T5b separation reduces risk but coordinated tests touch multiple files.
- 1% on the existing utxo_index tests (reviewer M2) — adding the `genesis_seed` arg breaks 4 existing test call sites; T4 enumerates them but typo risk remains.

**Confidence on spec-as-delivery-plan: ~92%** (reviewer's independent rating). The fix mechanics are sound; gaps are in execution-plan completeness — addressed by v2's explicit T2/T5/T7/T8 task structure.

**Escalation status:** none. Not a crypto-path phase; not a cost-path phase. Reviewer's independent rating (93%) matches mine. OVERRIDES #2 escalation triggers do not apply.

## Rollback plan

Single-revert per task; each commit independently revertible.

- T2: revert Cargo.toml changes. No code coupling.
- T3 (RED): revert. No production code change.
- T4 (GREEN): revert; restores empty-init behavior. Layer 1 test fails until re-tried.
- T5: revert main.rs startup changes; --network arg removed.
- T6: revert defensive assertion test.
- T7: revert special-case removal; restore Path 2 (preserve GENESIS_HEIGHT skip with explanatory comment).
- T8-T10: revert docs and findings.

If a deep regression surfaces (e.g., T7's removal breaks h=1 walking), revert T7 alone — the seeding from T4/T5 is independent and remains correct.

## Future work (residual follow-ups)

1. **GenesisStateDigest verification.** Read the store's expected genesis-state digest and assert the seeded boxes match. Guards against using the shim with a forked / non-canonical network.

2. **Network auto-detection (Decision 2 option B).** Eliminate the --network flag by detecting from chain context. Lower priority — explicit flag is fine for a dev tool.

3. **Generalized "no-input boxes" surface.** If Ergo ever adds another no-input box mechanism (e.g., a future hard fork), the seeding logic would need to extend. Document as a known assumption in the operator README.

## Cross-references

- `~/projects/ergo-node-rust/src/main.rs:33-39` — `TESTNET_NO_PREMINE_PROOFS` (copy source).
- `~/projects/ergo-node-rust/src/main.rs:43-49` — `MAINNET_NO_PREMINE_PROOFS` (copy source).
- `~/projects/ergo-node-rust/src/main.rs:53-57` — `FOUNDERS_PKS` (copy source).
- `~/projects/ergo-node-rust/src/main.rs:76-114` — `build_genesis_boxes` reference implementation.
- `~/projects/ergo-node-rust/src/main.rs:1850-1854` — genesis-box insert at startup.
- `~/projects/ergo-node-rust/src/main.rs:3085-3104` — mainnet expected-ids test.
- `~/projects/ergots/external/sigma-rust/ergo-lib/src/chain/genesis.rs:95-154` — `genesis_boxes` constructor.
- `~/projects/ergots/external/sigma-rust/ergo-lib/src/chain/genesis.rs:241-269` — testnet expected-ids test.
- `~/projects/ergots/tools/mainnet-validate/shim/src/utxo_index.rs:73-90, 134-164` — modification target.
- `~/projects/ergots/tools/mainnet-validate/shim/src/block_walker.rs:519-524` — GENESIS_HEIGHT special-case (Decision 3 target).
- `~/projects/ergots/tools/mainnet-validate/shim/src/block_walker.rs:911-1158` — `ingest_block_walks_synthetic_genesis_block_end_to_end` test (T7 rewrite target).
- `~/projects/ergots/tools/mainnet-validate/shim/src/main.rs:120-124` — shim's positional-args parser (T5a target).
- `~/projects/ergots/tools/mainnet-validate/harness/src/protocol.ts:420-424` — `ShimClient.spawn` signature (T5b target).
- `~/projects/ergots/tools/mainnet-validate/harness/src/main.ts:364` — single `ShimClient.spawn` call site (T5b target).
- `~/projects/ergots/tools/mainnet-validate/findings/2026-05-22-fix-2-triage.md` — triage record.
- `~/projects/ergots/docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md` — preceding fix-1 spec.

## Reviewer findings applied (2026-05-22)

Spec was reviewed by a general-purpose reviewer subagent dispatched with explicit instructions to validate the triage definitiveness, verify the constants' location, walk through h=1 under Path 1, check idempotency claims, sanity-check the founders box value math, audit the smoke-walk success criterion, and rate confidence honesty. Reviewer returned 2 ★★★ critical findings, 5 ★★ moderate findings, 4 ★ minor findings, plus 2 verification gaps.

**★★★ Critical findings (both applied inline):**

1. **C1 — Path-dep is provably impossible; spec leaves it as TBD.** The 3 constants live in `ergo-node-rust/src/main.rs` (binary crate); `src/lib.rs` re-exports unrelated modules; sigma-rust's own copy is `#[cfg(test)]` only and lacks MAINNET. **Applied:** Decision 4 rewritten to commit to copy-with-source-comments unconditionally; T2 reframed as "copy 3 const blocks into new shim/src/genesis_constants.rs with SOURCE comments." Path-dep language removed.

2. **C2 — `ingest_block_walks_synthetic_genesis_block_end_to_end` will fail under Path 1.** Test at `block_walker.rs:949-1158` explicitly relies on the GENESIS_HEIGHT special-case (input is BoxId::zero(); line 1132 asserts `spent_box_bytes.is_empty()`). Removing the special-case breaks the test silently mid-T7. **Applied:** T7 now bundles the test rewrite (seed real boxes, replace synthetic input, remove empty-bytes assertion) as a single atomic step. Risk hotspot #3 documents the dependency.

**★★ Moderate findings (all folded inline):**

1. **M1 — `ShimClient.spawn` is 3-arg today; --network plumbing is non-trivial.** Today the harness reads `--network` but doesn't forward it. **Applied:** Decision 2 expanded with full plumbing list; T5 split into T5a (shim-side flag parsing) and T5b (harness-side spawn signature + call site + tests).

2. **M2 — "Run all existing shim tests" is underspecified.** Adding `genesis_seed` arg breaks 4 existing call sites in utxo_index tests. **Applied:** T4 now enumerates the 4 test sites that pass `&[]` for genesis_seed (round_trip_insert_get_remove, indexed_up_to_height_persists, marker_survives_reopen, hash_mismatch_triggers_rebuild) plus the block_walker test which gets real seed bytes per C2.

3. **M3 — Idempotency claim plausible but unverified.** Reviewer verified that redb's `WriteTransaction::open_table` auto-creates after `delete_table` in the same write_txn — so inserting genesis seeds inside the existing init write_txn works cleanly. **Applied:** Risk hotspot #4 documents the redb semantics + cites the file:line.

4. **M4 — Founders box value math not enumerated.** **Applied:** Risk hotspot #1 footnote now includes: `founders_coins_total at h=0 = 4,330,792,500,000,000 nanoErg per emission.rs:144-161 + MonetarySettings::default(); genesis founders box value = founders_coins_total - COINS_IN_ONE_ERGO = 4,330,791,500,000,000 nanoErg; triage's h=3850 output #0 child value 4,330,776.4 ERG matches with 15.1 ERG distributed to outputs 1-4.`

5. **M5 — Layer 3 smoke could falsely pass on populated sidecar.** **Applied:** T8 now explicitly deletes the existing `/tmp/ergots-2j-pre-smoke-data/sidecar.redb` (or uses a fresh path) before re-running. Risk hotspot #8 documents.

**★ Minor findings (acknowledged):**

1. **Mi1 — h=1 vs validation/genesis terminology.** Spec wording consistent with the walker's understanding. No change.
2. **Mi2 — Testnet expected ids citation.** **Applied:** Decision 6 now cites both networks' expected ids with file:line.
3. **Mi3 — Decision 2 "even" wording.** **Applied:** "The no_premine box's id therefore differs..." rewrite per reviewer.
4. **Mi4 — `ShimClient.spawn` cross-reference.** **Applied:** Cross-references section now lists protocol.ts:420-424 and main.ts:364 as T5b targets.

**Verification gaps (incorporated):**

1. **OVERRIDES rule #6 commands missing.** **Applied:** T4/T5a/T5b/T7/T9 now have explicit `cargo build`, `cargo test`, `npm test`, `npm run build` verification gates inline.

2. **Network-mismatch debug hostility.** **Applied:** Decision 6 + Risk hotspot #7 document the failure mode; T9's harness README update step (implicit in fix-1's T8-equivalent doc sweep) should call out `--network` as the first thing to suspect on missing-utxo.

3. **Harness already threads `network` through validate-block.** **Applied:** Non-goals section already noted "no harness validation changes"; no additional update needed.

Net effect: confidence 97% → 93% on fix mechanics; recommendation REVISE → SHIP. All actionable findings folded into spec v2.
