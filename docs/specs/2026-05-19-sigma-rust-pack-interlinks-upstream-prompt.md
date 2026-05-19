# Prompt: sigma-rust upstream PR — fix `NipopowAlgos::pack_interlinks` key encoding

Use this prompt to seed a fresh Claude Code session targeting the upstream `sigma-rust` repository (`~/projects/sigma-rust/sigma-rust/`, branch `integration/ergots` or a fresh branch off `develop`).

---

## Context

`sigma-rust`'s `NipopowAlgos::pack_interlinks` (`ergo-nipopow/src/nipopow_algos.rs:326-357`) generates ExtensionKV pairs with key=`[INTERLINK_VECTOR_PREFIX, distinct_ix]` where `distinct_ix` is a sequential 0-indexed counter of distinct interlink groups. The JVM Ergo node (`ergoplatform/ergo`, Scala) uses key=`[INTERLINK_VECTOR_PREFIX, position_of_first_occurrence_in_interlinks_array]` — the index of the first interlink in that duplicate-run, NOT a sequential distinct counter.

Empirically verified against a real mainnet NiPoPoW proof (block height 1784124, captured 2026-05-13 from ergo-node-rust on mainnet). With JVM-compat keys, **all 11 leaf hashes** in the proof's `interlinksProof.indices` match a TS port's `packInterlinks → hashExtensionLeaf` output exactly. With sigma-rust's current `distinct_ix` keys, only the first 2 match (positions 0 and 1 happen to align with `distinct_ix=0,1`).

## Why this is a bug

`unpack_interlinks` (lines 359-380) explicitly **ignores** `key[1]` — it filters by `key[0] == INTERLINK_VECTOR_PREFIX` only and reads `(qty, blockId)` from the value. So sigma-rust round-trips its own buggy output internally (pack → unpack succeeds). The divergence is **observable only at the Merkle-leaf hash level**: the leaf hash depends on the full kv-bytes including `key[1]`, and a sigma-rust-packed leaf hashes differently from a JVM-packed leaf.

Concrete impact:
- Sigma-rust-generated proofs are **incompatible** with JVM Ergo's `check_interlinks_proof` (and vice versa) for any block with >= 1 duplicate-run in the interlinks vector — which is **every real mainnet block**.
- Sigma-rust's `PoPowHeader::check_interlinks_proof` (nipopow_proof.rs:302-323) FAILS on real mainnet proofs because it computes the expected root via sigma-rust's buggy pack but the proof's walk-up reaches the JVM-packed root.
- Sigma-rust's `NipopowProof::is_better_than` (nipopow_proof.rs:71-93) calls `is_valid()` which calls `has_valid_proofs()` which calls `check_interlinks_proof` per PoPowHeader — so `is_better_than` rejects all real mainnet proofs as "invalid" and returns false in both directions.

## The fix

Replace the sequential `distinct_ix` counter with the position-of-first-occurrence in the interlinks input. Three single-line changes:

**Before** (lines 326-357):

```rust
pub fn pack_interlinks(interlinks: Vec<BlockId>) -> Vec<([u8; 2], Vec<u8>)> {
    let mut res = vec![];
    let mut ix_distinct_block_ids = 0;
    let mut curr_block_id_count = 1;
    let mut curr_block_id = interlinks[0];
    for id in interlinks.into_iter().skip(1) {
        if id == curr_block_id {
            curr_block_id_count += 1;
        } else {
            let block_id_bytes: Vec<u8> = curr_block_id.0.into();
            let packed_value = std::iter::once(curr_block_id_count)
                .chain(block_id_bytes)
                .collect();
            res.push((
                [INTERLINK_VECTOR_PREFIX, ix_distinct_block_ids],
                packed_value,
            ));
            curr_block_id = id;
            curr_block_id_count = 1;
            ix_distinct_block_ids += 1;
        }
    }
    let block_id_bytes: Vec<u8> = curr_block_id.0.into();
    let packed_value = std::iter::once(curr_block_id_count)
        .chain(block_id_bytes)
        .collect();
    res.push((
        [INTERLINK_VECTOR_PREFIX, ix_distinct_block_ids],
        packed_value,
    ));
    res
}
```

**After** — use `i` (the input position from `enumerate().skip(1)`) to capture the *first* position of each new run; preserve it as `curr_first_pos` instead of the sequential `ix_distinct_block_ids`:

```rust
pub fn pack_interlinks(interlinks: Vec<BlockId>) -> Vec<([u8; 2], Vec<u8>)> {
    if interlinks.is_empty() {
        return vec![];
    }
    let mut res = vec![];
    let mut curr_block_id_count: u8 = 1;
    let mut curr_block_id = interlinks[0];
    let mut curr_first_pos: usize = 0;
    for (i, id) in interlinks.iter().enumerate().skip(1) {
        if *id == curr_block_id {
            curr_block_id_count += 1;
        } else {
            let block_id_bytes: Vec<u8> = curr_block_id.0.into();
            let packed_value = std::iter::once(curr_block_id_count)
                .chain(block_id_bytes)
                .collect();
            let ix_byte: u8 = curr_first_pos
                .try_into()
                .expect("interlinks first-position byte index > 255");
            res.push(([INTERLINK_VECTOR_PREFIX, ix_byte], packed_value));
            curr_block_id = *id;
            curr_block_id_count = 1;
            curr_first_pos = i;
        }
    }
    let block_id_bytes: Vec<u8> = curr_block_id.0.into();
    let packed_value = std::iter::once(curr_block_id_count)
        .chain(block_id_bytes)
        .collect();
    let ix_byte: u8 = curr_first_pos
        .try_into()
        .expect("interlinks first-position byte index > 255");
    res.push(([INTERLINK_VECTOR_PREFIX, ix_byte], packed_value));
    res
}
```

## Validation strategy

1. **Existing tests**: sigma-rust's existing `pack_interlinks` / `unpack_interlinks` round-trip tests (and the `PoPowHeader::Arbitrary` impl that generates proofs against `ExtensionCandidate::new(pack_interlinks(...))`) should continue to pass because `unpack_interlinks` ignores `key[1]`.

2. **New JVM-compat regression test**: add a test that packs a known interlinks vector and asserts the resulting kv-pairs match JVM Ergo's output. Reference vector (from real mainnet block 1784124):

   ```rust
   let interlinks: Vec<BlockId> = vec![
       hex_to_blockid("b0244dfc..."),  // genesis (1 instance)
       hex_to_blockid("23e64616..."),  // (4 instances)
       hex_to_blockid("23e64616..."),
       hex_to_blockid("23e64616..."),
       hex_to_blockid("23e64616..."),
       hex_to_blockid("11347ec5..."),  // (1 instance)
       // ... see ~/projects/ergots/fixture-gen/src/cmds/mainnet_nipopow_m2k2.json
   ];
   let packed = NipopowAlgos::pack_interlinks(interlinks);
   // pre-fix: keys = [0x01, 0], [0x01, 1], [0x01, 2], ...
   // post-fix: keys = [0x01, 0], [0x01, 1], [0x01, 5], [0x01, 6], ...
   assert_eq!(packed[2].0, [0x01, 5]);
   ```

3. **Mainnet proof round-trip**: load the real mainnet proof from `~/projects/ergots/fixture-gen/src/cmds/mainnet_nipopow_m2k2.json`. After the fix, `proof.is_valid()` should return `true` (currently returns `false` due to `check_interlinks_proof` failing).

## Related downstream work

The TypeScript port at `~/projects/ergots/packages/nipopow` (specifically `src/merkle.ts::packInterlinks` and the documentation in `facts/nipopow.md`) uses the JVM-compat key encoding. Once this upstream PR lands and is published, the downstream comment "An upstream sigma-rust PR is queued" can be removed.

The fixture-gen tool at `~/projects/ergots/fixture-gen/src/cmds/interlinks_jvm.rs` carries a local `pack_interlinks_jvm` (and downstream helpers `check_interlinks_proof_jvm`, `is_valid_jvm`, `is_better_than_jvm`) as a workaround. Once upstream is fixed, those helpers can be removed and the call sites can revert to using sigma-rust's `NipopowAlgos::pack_interlinks` / `PoPowHeader::check_interlinks_proof` / `NipopowProof::is_better_than` directly.

## Acceptance criteria

- [ ] `NipopowAlgos::pack_interlinks` updated per the diff above.
- [ ] New regression test exercising a duplicate-run interlinks vector with at least one position-3+ distinct group, asserting JVM-compat keys.
- [ ] Existing `pack_interlinks` / `unpack_interlinks` round-trip tests still pass.
- [ ] `cargo test -p ergo-nipopow` passes.
- [ ] PR description references the empirical mainnet validation (block 1784124, 11/11 leaf hashes match with the fix).
