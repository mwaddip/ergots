//! SAvlTree.get handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:104-150`
//! (GET_EVAL_FN). MethodCall typeId=100, methodId=10.
//! Method registration: `ergotree-ir/src/types/savltree.rs::GET_METHOD`.
//!
//! Args: `key: Coll[Byte]`, `proof: Coll[Byte]`. Return:
//! `Option[Coll[Byte]]`.
//!
//! Behavior: builds `BatchAVLVerifier`; runs `Lookup(key)`. Verifier construct
//! fail OR per-op fail → throws (`EvalError::AvlTree`). Proof valid + key
//! present → `Some(value)`. Proof valid + key absent → `None`.
//!
//! **No per-handler `ctx.add_jit_cost`** in sigma-rust (line 104).
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
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::GET_METHOD;
use ergotree_ir::types::stype::SType;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;

use super::common::{stype_to_json, value_to_json, EvalFixture, EvalFixtureFile};

fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Encode an `Option[Coll[Byte]]` Value as the TS SValue Option variant.
///
/// Schema mirrors `extract_register_as.rs::option_json` /
/// `savltree_value_length_opt.rs::option_int_json`:
///   `{ kind: "Option", elem: SType, value: SValue | null }`
fn option_coll_byte_json(value: &Value) -> anyhow::Result<JsonValue> {
    let inner = match value {
        Value::Opt(None) => None,
        Value::Opt(Some(boxed)) => Some(value_to_json(boxed)),
        other => anyhow::bail!("savltree_get: expected Value::Opt, got {:?}", other),
    };
    let elem = stype_to_json(&SType::SColl(Arc::new(SType::SByte)));
    Ok(match inner {
        None => json!({ "kind": "Option", "elem": elem, "value": null }),
        Some(v) => json!({ "kind": "Option", "elem": elem, "value": v }),
    })
}

/// Build a prover, populate, capture digest, then perform Lookup and capture
/// proof bytes.
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
    let _ = prover.generate_proof();
    let starting_digest_bytes = prover.digest().expect("digest after initial inserts");
    let starting_digest = ADDigest::scorex_parse_bytes(&starting_digest_bytes)?;

    let _ = prover.perform_one_operation(&Operation::Lookup(Bytes::from(test_key.to_vec())))?;
    let proof_bytes = prover.generate_proof().to_vec();

    Ok((starting_digest, proof_bytes))
}

fn make_entry(
    name: &str,
    key_length: u32,
    entries: &[(Vec<u8>, Vec<u8>)],
    test_key: &[u8],
) -> anyhow::Result<EvalFixture> {
    let (starting_digest, proof_bytes) =
        build_lookup_proof(key_length as usize, entries, test_key)?;

    let avl_tree_data = AvlTreeData {
        digest: starting_digest,
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
        GET_METHOD.clone(),
        vec![key_expr, proof_expr],
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
        expected_value_json: option_coll_byte_json(&val)?,
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

    let three_leaves_klen1: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key_n(0x01, 1), val_8(0x01)),
        (key_n(0x02, 1), val_8(0x02)),
        (key_n(0x03, 1), val_8(0x03)),
    ];

    // 1. key-present → Some(value)
    entries.push(make_entry(
        "get_key_present",
        1,
        &three_leaves_klen1,
        &[0x02],
    )?);

    // 2. key-absent (proof valid for the absent path) → None
    entries.push(make_entry(
        "get_key_absent",
        1,
        &three_leaves_klen1,
        &[0xAA],
    )?);

    // 3. bytes-key-32 — 32-byte key length variant; key present
    let three_leaves_klen32: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key_n(0x01, 32), val_8(0x01)),
        (key_n(0x02, 32), val_8(0x02)),
        (key_n(0x03, 32), val_8(0x03)),
    ];
    entries.push(make_entry(
        "get_bytes_key_32",
        32,
        &three_leaves_klen32,
        &key_n(0x02, 32),
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_get",
        entries,
    })
}
