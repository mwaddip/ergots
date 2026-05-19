//! SAvlTree.contains handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:339-381`
//! (CONTAINS_EVAL_FN). MethodCall typeId=100, methodId=9.
//! Method registration: `ergotree-ir/src/types/savltree.rs::CONTAINS_METHOD`.
//!
//! Args: `key: Coll[Byte]`, `proof: Coll[Byte]`. Return: `Boolean`.
//!
//! Behavior: builds `BatchAVLVerifier` with `(starting_digest, proof)`; runs
//! `Lookup(key)`. If construct OR per-op fails → `Value::Boolean(false)`
//! (never throws). If `Lookup` returns `Some(_)` → `true`; `None` → `false`.
//!
//! **No per-handler `ctx.add_jit_cost`** in sigma-rust (verified at line 339).
//! Total cost = 4 (MethodCall dispatcher per eval.rs) + 5 (inline Const arm) +
//! 5 (Const arm for key) + 5 (Const arm for proof) + 0 (handler) = 19.
//! (Actual cost is captured from `try_eval_out`; comment is informative.)
//!
//! Phase 2h-b Phase B wave 2 (per PLAN.md Phase B).

use std::sync::Arc;

use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_avl_verifier::BatchAVLVerifier;
use ergo_avltree_rust::batch_node::{AVLTree, Node, NodeHeader};
use ergo_avltree_rust::operation::{Digest32, KeyValue, Operation};
use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::CONTAINS_METHOD;
use serde_json::json;
use sigma_ser::ScorexSerializable;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

/// Resolver used by both prover construction.
fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Build a prover, insert the given key/value pairs, and produce
/// `(starting_digest, proof_bytes)` for a subsequent `Lookup(test_key)` op.
///
/// The starting digest is captured BEFORE the lookup; the proof is generated
/// AFTER the lookup. This matches the eval-handler contract:
/// `BatchAVLVerifier::new(starting_digest, proof, ...)` then `Lookup(key)`.
fn build_lookup_proof(
    key_length: usize,
    entries: &[(Vec<u8>, Vec<u8>)],
    test_key: &[u8],
) -> anyhow::Result<(ADDigest, Vec<u8>)> {
    let mut prover = BatchAVLProver::new(
        AVLTree::new(make_resolver(), key_length, None),
        true,
    );
    for (k, v) in entries {
        prover.perform_one_operation(&Operation::Insert(KeyValue {
            key: Bytes::from(k.clone()),
            value: Bytes::from(v.clone()),
        }))?;
    }
    // Discard the setup proof; capture the digest after initial inserts.
    let _ = prover.generate_proof();
    let starting_digest_bytes = prover.digest().expect("digest after initial inserts");
    let starting_digest = ADDigest::scorex_parse_bytes(&starting_digest_bytes)?;

    // Apply the Lookup operation whose proof we want to capture.
    let _ = prover.perform_one_operation(&Operation::Lookup(Bytes::from(test_key.to_vec())))?;
    let proof = prover.generate_proof();
    let proof_bytes = proof.to_vec();

    // Cross-check: build a verifier and confirm it accepts (digest, proof).
    // Mirrors the eval handler's BatchAVLVerifier::new call. If this errors,
    // the prover/digest/proof state is inconsistent and the eval handler
    // would also fail. Catching the mismatch here gives a clear local error
    // instead of an opaque EvalError downstream.
    let mut verifier = BatchAVLVerifier::new(
        &Bytes::from(starting_digest.0.to_vec()),
        &Bytes::from(proof_bytes.clone()),
        AVLTree::new(make_resolver(), key_length, None),
        None,
        None,
    )?;
    verifier.perform_one_operation(&Operation::Lookup(Bytes::from(test_key.to_vec())))?;

    Ok((starting_digest, proof_bytes))
}

/// One entry: build `MethodCall(AvlTree const, CONTAINS_METHOD, [key, proof])`,
/// evaluate, capture `(value, cost)`.
fn make_entry(
    name: &str,
    key_length: u32,
    entries: &[(Vec<u8>, Vec<u8>)],
    test_key: &[u8],
    mutate_proof: bool,
) -> anyhow::Result<EvalFixture> {
    let (starting_digest, mut proof_bytes) =
        build_lookup_proof(key_length as usize, entries, test_key)?;

    // Optional: flip one byte in the proof to simulate the contains
    // "never-throw on per-op failure" path. The proof layout is
    // `packed_tree || END_OF_TREE (0x04) || directions`. Mutating a byte
    // in the directions section (post-0x04) lets the verifier reconstruct
    // the tree successfully but causes the Lookup op to follow wrong
    // directions, returning Err → `Value::Boolean(false)` from the eval
    // handler. (Mutating in the packed_tree section instead breaks
    // reconstruction → throw, which is NOT the contains-failure semantic.)
    //
    // The last byte of the proof is always in the directions section
    // (the prover serializes directions after END_OF_TREE).
    if mutate_proof {
        anyhow::ensure!(
            !proof_bytes.is_empty(),
            "savltree_contains: cannot mutate empty proof"
        );
        let last_idx = proof_bytes.len() - 1;
        proof_bytes[last_idx] ^= 0xFF;
    }

    let avl_tree_data = AvlTreeData {
        digest: starting_digest,
        // Flags don't affect contains; pick all-disabled for clarity.
        tree_flags: AvlTreeFlags::new(false, false, false),
        key_length,
        value_length_opt: None,
    };

    let avl_const: Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let key_const: Constant = test_key.to_vec().into();
    let key_expr: Expr = key_const.into();

    let proof_const: Constant = proof_bytes.into();
    let proof_expr: Expr = proof_const.into();

    let expr: Expr = MethodCall::new(
        avl_expr,
        CONTAINS_METHOD.clone(),
        vec![key_expr, proof_expr],
    )
    .unwrap()
    .into();

    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    // SAvlTree handlers read only from the explicit args / obj — Context is
    // not consulted for verification ops. force_any_val draws from OS RNG but
    // the eval result is deterministic in the test_key + entries + proof.
    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> =
        try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

/// Build a key of length `n` filled with `byte`.
fn key_n(byte: u8, n: usize) -> Vec<u8> {
    vec![byte; n]
}

/// 8-byte value filled with `byte`.
fn val_8(byte: u8) -> Vec<u8> {
    vec![byte; 8]
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Common 3-leaf tree with 1-byte keys 0x01, 0x02, 0x03.
    let three_leaves_klen1: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key_n(0x01, 1), val_8(0x01)),
        (key_n(0x02, 1), val_8(0x02)),
        (key_n(0x03, 1), val_8(0x03)),
    ];

    // 1. key-present — lookup 0x02 which exists → true
    entries.push(make_entry(
        "contains_key_present",
        1,
        &three_leaves_klen1,
        &[0x02],
        false,
    )?);

    // 2. key-absent — lookup 0xAA which doesn't exist → false
    entries.push(make_entry(
        "contains_key_absent",
        1,
        &three_leaves_klen1,
        &[0xAA],
        false,
    )?);

    // 3. proof-mutated — proof corrupted → false (sigma-rust never-throw)
    entries.push(make_entry(
        "contains_proof_mutated",
        1,
        &three_leaves_klen1,
        &[0x02],
        true,
    )?);

    // 4. bytes-key-32 — 32-byte key length variant with key present
    let three_leaves_klen32: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key_n(0x01, 32), val_8(0x01)),
        (key_n(0x02, 32), val_8(0x02)),
        (key_n(0x03, 32), val_8(0x03)),
    ];
    entries.push(make_entry(
        "contains_bytes_key_32",
        32,
        &three_leaves_klen32,
        &key_n(0x02, 32),
        false,
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_contains",
        entries,
    })
}
