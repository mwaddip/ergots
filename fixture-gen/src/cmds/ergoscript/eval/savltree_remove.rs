//! SAvlTree.remove handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:279-337`
//! (REMOVE_EVAL_FN). MethodCall typeId=100, methodId=14.
//! Method registration: `ergotree-ir/src/types/savltree.rs::REMOVE_METHOD`.
//!
//! Args: `keys: Coll[Coll[Byte]]`, `proof: Coll[Byte]`. Return:
//! `Option[AvlTree]`.
//!
//! Behavior:
//! - `!tree_flags.remove_allowed()` → `Value::Opt(None)`.
//! - Verifier construct fail OR per-op fail → throw (NO V3+ partial-success
//!   path here — diverges from insert/update).
//! - All ops succeed → `Some(AvlTree)` with new digest.
//!
//! **No per-handler `ctx.add_jit_cost`** in sigma-rust (line 279).
//!
//! Generates:
//!   - success-1-key (remove 1 existing key)
//!   - success-3-keys (remove all 3 keys from a 3-leaf tree)
//!   - disallowed-flags (removeAllowed=false → None)
//!
//! Phase 2h-b Phase B wave 2.

use std::sync::Arc;

use bytes::Bytes;
use ergo_avltree_rust::authenticated_tree_ops::AuthenticatedTreeOps;
use ergo_avltree_rust::batch_avl_prover::BatchAVLProver;
use ergo_avltree_rust::batch_node::AVLTree;
use ergo_avltree_rust::operation::{KeyValue, Operation};
use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::constant::{Constant, Literal};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::mir::value::CollKind;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::REMOVE_METHOD;
use ergotree_ir::types::stype::SType;
use serde_json::json;
use sigma_ser::ScorexSerializable;

use super::common::{EvalFixture, EvalFixtureFile};
use super::savltree_helpers::make_resolver;
use super::savltree_insert::option_avl_tree_json;

/// Build a prover with the initial state and capture the proof for applying
/// the Remove batch.
fn build_remove_proof(
    key_length: usize,
    initial_kvs: &[(Vec<u8>, Vec<u8>)],
    remove_keys: &[Vec<u8>],
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

    for key in remove_keys {
        prover.perform_one_operation(&Operation::Remove(Bytes::from(key.clone())))?;
    }
    let proof_bytes = prover.generate_proof().to_vec();

    Ok((starting_digest, proof_bytes))
}

/// Construct a `Constant<Coll[Coll[Byte]]>` from a `&[Vec<u8>]` of keys.
fn keys_constant(keys: &[Vec<u8>]) -> Constant {
    let items: Arc<[Literal]> = keys
        .iter()
        .map(|k| Literal::from(k.clone()))
        .collect();
    Constant {
        tpe: SType::SColl(Arc::new(SType::SColl(Arc::new(SType::SByte)))),
        v: Literal::Coll(CollKind::WrappedColl {
            items,
            elem_tpe: SType::SColl(Arc::new(SType::SByte)),
        }),
    }
}

fn make_entry(
    name: &str,
    key_length: u32,
    initial_kvs: &[(Vec<u8>, Vec<u8>)],
    remove_keys: &[Vec<u8>],
    remove_allowed: bool,
) -> anyhow::Result<EvalFixture> {
    let (starting_digest, proof_bytes) =
        build_remove_proof(key_length as usize, initial_kvs, remove_keys)?;

    let tree_flags = AvlTreeFlags::new(false, false, remove_allowed);
    let avl_tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags,
        key_length,
        value_length_opt: None,
    };

    let avl_const: Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let keys_expr: Expr = keys_constant(remove_keys).into();

    let proof_const: Constant = proof_bytes.into();
    let proof_expr: Expr = proof_const.into();

    let expr: Expr = MethodCall::new(
        avl_expr,
        REMOVE_METHOD.clone(),
        vec![keys_expr, proof_expr],
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

    // 1. success-1-key — remove key 0x02 which exists
    entries.push(make_entry(
        "remove_success_1_key",
        1,
        &three_leaves,
        &[key_n(0x02, 1)],
        true,
    )?);

    // 2. success-3-keys — remove all 3 keys
    entries.push(make_entry(
        "remove_success_3_keys",
        1,
        &three_leaves,
        &[key_n(0x01, 1), key_n(0x02, 1), key_n(0x03, 1)],
        true,
    )?);

    // 3. disallowed-flags — removeAllowed=false → None
    entries.push(make_entry(
        "remove_disallowed_flags",
        1,
        &three_leaves,
        &[key_n(0x02, 1)],
        false,
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_remove",
        entries,
    })
}
