//! JVM-compatible `pack_interlinks` for fixture generation.
//!
//! Sigma-rust's `NipopowAlgos::pack_interlinks` (ergo-nipopow/src/nipopow_algos.rs:326-357)
//! has a key-indexing divergence from JVM Ergo:
//!
//!   - sigma-rust uses sequential `distinct_ix` (0, 1, 2, ...) as the second key byte
//!   - JVM Ergo uses `position_of_first_occurrence_in_interlinks_array`
//!
//! For interlinks `[A, B, B, B, B, C, D, E, F, F, F, ...]`:
//!   - sigma-rust pack: keys `[01 00], [01 01], [01 02], [01 03], [01 04], ...`
//!   - JVM Ergo pack:   keys `[01 00], [01 01], [01 05], [01 06], [01 07], ...`
//!
//! Sigma-rust round-trips its own buggy output (`unpack_interlinks` ignores key[1]
//! entirely), but the divergence is observable when interfacing with real
//! JVM-generated mainnet proofs: leaf hashes differ for any block with at least
//! one duplicate run, which is every real mainnet block.
//!
//! This helper provides the JVM-compatible packing for use in fixture-gen so
//! that generated synthetic fixtures match real-world mainnet proof semantics.
//! The TypeScript verifier (`@ergots/nipopow`) uses the same JVM-compat semantics.
//!
//! A separate sigma-rust upstream session will file a PR with a permanent fix.

use ergo_chain_types::{BlockId, Header};
use ergo_merkle_tree::{MerkleNode, MerkleTree};
use ergo_nipopow::{NipopowAlgos, NipopowProof, NipopowProofError, PoPowHeader};

const INTERLINK_VECTOR_PREFIX: u8 = 0x01;

/// JVM-compatible pack_interlinks: groups consecutive duplicate BlockIds and
/// emits `(key=[0x01, first_pos], value=[count, ...blockid_32])`.
///
/// Returns `[]` for empty input.
///
/// # Panics
/// Panics if a distinct group's first position exceeds 255 (interlinks vector
/// would need to be longer than 256 entries — well outside normal use).
pub fn pack_interlinks_jvm(interlinks: Vec<BlockId>) -> Vec<([u8; 2], Vec<u8>)> {
    if interlinks.is_empty() {
        return vec![];
    }
    let mut res = vec![];
    let mut curr_count: u8 = 1;
    let mut curr_id = interlinks[0];
    let mut curr_first_pos: usize = 0;
    let emit = |res: &mut Vec<([u8; 2], Vec<u8>)>, count: u8, id: BlockId, first_pos: usize| {
        let ix_byte: u8 = first_pos
            .try_into()
            .expect("interlinks first-position byte index > 255");
        let block_id_bytes: Vec<u8> = id.0.into();
        let packed_value = std::iter::once(count).chain(block_id_bytes).collect();
        res.push(([INTERLINK_VECTOR_PREFIX, ix_byte], packed_value));
    };
    for (i, id) in interlinks.iter().enumerate().skip(1) {
        if *id == curr_id {
            curr_count += 1;
        } else {
            emit(&mut res, curr_count, curr_id, curr_first_pos);
            curr_id = *id;
            curr_count = 1;
            curr_first_pos = i;
        }
    }
    emit(&mut res, curr_count, curr_id, curr_first_pos);
    res
}

/// JVM-compatible analog of sigma-rust `PoPowHeader::check_interlinks_proof`,
/// using `pack_interlinks_jvm` instead of sigma-rust's buggy `pack_interlinks`.
///
/// Mirrors the structure of sigma-rust check_interlinks_proof
/// (ergo-nipopow/src/nipopow_proof.rs:302-323) one-to-one. Pack interlinks
/// (JVM-compat), build a Merkle tree from packed leaves, validate the proof
/// against the resulting interlinks-only Merkle root.
///
/// Used by fixture-gen `mutation_expected_to_fail` so generated mutation
/// fixtures' `expected_to_fail` flags match what the TS verifier
/// (`@ergots/nipopow` checkInterlinksProof) actually does.
pub fn check_interlinks_proof_jvm(p: &PoPowHeader) -> bool {
    if p.interlinks.is_empty()
        && p.interlinks_proof.get_indices().is_empty()
        && p.interlinks_proof.get_proofs().is_empty()
    {
        return true;
    }
    let leaves: Vec<MerkleNode> = pack_interlinks_jvm(p.interlinks.clone())
        .into_iter()
        .map(|(k, v)| {
            let mut leaf = Vec::with_capacity(1 + k.len() + v.len());
            leaf.push(2u8);
            leaf.extend_from_slice(&k);
            leaf.extend_from_slice(&v);
            leaf
        })
        .map(MerkleNode::from_bytes)
        .collect();
    let tree = MerkleTree::new(leaves);
    p.interlinks_proof.valid(tree.root_hash().as_ref())
}

/// `NipopowProof.headers_chain()` — pub(crate) in sigma-rust, inlined here.
fn headers_chain(p: &NipopowProof) -> impl Iterator<Item = &Header> {
    p.prefix
        .iter()
        .map(|ph| &ph.header)
        .chain(std::iter::once(&p.suffix_head.header).chain(p.suffix_tail.iter()))
}

/// `NipopowProof::has_valid_heights` — private in sigma-rust, inlined here.
fn has_valid_heights(p: &NipopowProof) -> bool {
    let chain: Vec<&Header> = headers_chain(p).collect();
    chain.windows(2).all(|w| w[0].height < w[1].height)
}

/// `NipopowProof::has_valid_proofs` — private in sigma-rust, inlined here
/// with JVM-compat `check_interlinks_proof_jvm` in place of sigma-rust's
/// buggy `PoPowHeader::check_interlinks_proof`.
fn has_valid_proofs_jvm(p: &NipopowProof) -> bool {
    std::iter::once(&p.suffix_head)
        .chain(p.prefix.iter())
        .all(check_interlinks_proof_jvm)
}

/// JVM-compat `NipopowProof::is_valid` — mirrors sigma-rust
/// (ergo-nipopow/src/nipopow_proof.rs:95-97) using JVM-compat checks.
pub fn is_valid_jvm(p: &NipopowProof) -> bool {
    p.has_valid_connections() && has_valid_heights(p) && has_valid_proofs_jvm(p)
}

/// JVM-compat `NipopowProof::is_better_than` — mirrors sigma-rust
/// (ergo-nipopow/src/nipopow_proof.rs:71-93) with JVM-compat `is_valid_jvm`.
/// Used by fixture-gen `compare.rs` so generated compare fixtures' expected
/// values reflect what the TS verifier (with JVM-compat semantics) computes.
pub fn is_better_than_jvm(
    a: &NipopowProof,
    b: &NipopowProof,
) -> Result<bool, NipopowProofError> {
    if is_valid_jvm(a) && is_valid_jvm(b) {
        let algos = NipopowAlgos::default();
        let a_headers: Vec<&Header> = headers_chain(a).collect();
        let b_headers: Vec<&Header> = headers_chain(b).collect();
        if let Some(lca) = algos.lowest_common_ancestor(&a_headers, &b_headers) {
            let a_after_lca: Vec<&Header> = headers_chain(a)
                .filter(|h| h.height > lca.height)
                .collect();
            let b_after_lca: Vec<&Header> = headers_chain(b)
                .filter(|h| h.height > lca.height)
                .collect();
            Ok(algos.best_arg(&a_after_lca, a.m)?
                > algos.best_arg(&b_after_lca, b.m)?)
        } else {
            Ok(false)
        }
    } else {
        Ok(is_valid_jvm(a))
    }
}
