//! SAvlTree.update handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:383-439`
//! (UPDATE_EVAL_FN). MethodCall typeId=100, methodId=13.
//! Method registration: `ergotree-ir/src/types/savltree.rs::UPDATE_METHOD`.
//!
//! Args: `entries: Coll[(Coll[Byte], Coll[Byte])]`, `proof: Coll[Byte]`.
//! Return: `Option[AvlTree]`.
//!
//! Behavior:
//! - `!tree_flags.update_allowed()` → `Value::Opt(None)`.
//! - Verifier construct fail → throw.
//! - Per-op fail → break loop (NOTE: unlike insert, no V<3 throw branch —
//!   update unconditionally breaks on the first failure). Then if bv.digest()
//!   is Some → return that digest; otherwise return None.
//! - All ops succeed → `Some(AvlTree)` with new digest.
//!
//! **No per-handler `ctx.add_jit_cost`** in sigma-rust (line 383).
//!
//! Generates:
//!   - success-1-entry (1 update of an existing key)
//!   - success-3-entries (3 updates of existing keys)
//!   - disallowed-flags (treeFlags.updateAllowed=false → None)
//!
//! Phase 2h-b Phase B wave 2.

use std::sync::Arc;

use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
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
use ergotree_ir::types::savltree::UPDATE_METHOD;
use serde_json::json;
use sigma_ser::ScorexSerializable;

use super::common::{EvalFixture, EvalFixtureFile};
use super::savltree_insert::{entries_constant, option_avl_tree_json};

fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Build a prover with the initial state (inserts) and capture the proof for
/// applying the update batch.
fn build_update_proof(
    key_length: usize,
    initial_kvs: &[(Vec<u8>, Vec<u8>)],
    update_entries: &[(Vec<u8>, Vec<u8>)],
) -> anyhow::Result<(ADDigest, Vec<u8>)> {
    let mut prover = BatchAVLProver::new(
        AVLTree::new(make_resolver(), key_length, None),
        true,
    );
    for (k, v) in initial_kvs {
        prover.perform_one_operation(&Operation::Insert(KeyValue {
            key: Bytes::from(k.clone()),
            value: Bytes::from(v.clone()),
        }))?;
    }
    let _ = prover.generate_proof();
    let starting_digest_bytes = prover.digest().expect("digest after initial inserts");
    let starting_digest = ADDigest::scorex_parse_bytes(&starting_digest_bytes)?;

    for (k, v) in update_entries {
        prover.perform_one_operation(&Operation::Update(KeyValue {
            key: Bytes::from(k.clone()),
            value: Bytes::from(v.clone()),
        }))?;
    }
    let proof_bytes = prover.generate_proof().to_vec();

    Ok((starting_digest, proof_bytes))
}

fn make_entry(
    name: &str,
    key_length: u32,
    initial_kvs: &[(Vec<u8>, Vec<u8>)],
    update_entries: &[(Vec<u8>, Vec<u8>)],
    update_allowed: bool,
) -> anyhow::Result<EvalFixture> {
    let (starting_digest, proof_bytes) =
        build_update_proof(key_length as usize, initial_kvs, update_entries)?;

    let tree_flags = AvlTreeFlags::new(false, update_allowed, false);
    let avl_tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags,
        key_length,
        value_length_opt: None,
    };

    let avl_const: Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let entries_expr: Expr = entries_constant(update_entries).into();

    let proof_const: Constant = proof_bytes.into();
    let proof_expr: Expr = proof_const.into();

    let expr: Expr = MethodCall::new(
        avl_expr,
        UPDATE_METHOD.clone(),
        vec![entries_expr, proof_expr],
    )
    .unwrap()
    .into();

    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> =
        try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: option_avl_tree_json(&val)?,
        expected_cost: cost,
    })
}

fn key_n(byte: u8, n: usize) -> Vec<u8> {
    vec![byte; n]
}

fn val_8(byte: u8) -> Vec<u8> {
    vec![byte; 8]
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let three_leaves: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key_n(0x01, 1), val_8(0x01)),
        (key_n(0x02, 1), val_8(0x02)),
        (key_n(0x03, 1), val_8(0x03)),
    ];

    // 1. success-1-entry — update key 0x02 to a new value
    entries.push(make_entry(
        "update_success_1_entry",
        1,
        &three_leaves,
        &[(key_n(0x02, 1), val_8(0xBB))],
        true,
    )?);

    // 2. success-3-entries — update all three keys to new values
    entries.push(make_entry(
        "update_success_3_entries",
        1,
        &three_leaves,
        &[
            (key_n(0x01, 1), val_8(0xAA)),
            (key_n(0x02, 1), val_8(0xBB)),
            (key_n(0x03, 1), val_8(0xCC)),
        ],
        true,
    )?);

    // 3. disallowed-flags — updateAllowed=false → handler returns None
    entries.push(make_entry(
        "update_disallowed_flags",
        1,
        &three_leaves,
        &[(key_n(0x02, 1), val_8(0xBB))],
        false,
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_update",
        entries,
    })
}
