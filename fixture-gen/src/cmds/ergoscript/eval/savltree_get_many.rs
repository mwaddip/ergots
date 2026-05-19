//! SAvlTree.getMany handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:152-212`
//! (GET_MANY_EVAL_FN). MethodCall typeId=100, methodId=11.
//! Method registration: `ergotree-ir/src/types/savltree.rs::GET_MANY_METHOD`.
//!
//! Args: `keys: Coll[Coll[Byte]]`, `proof: Coll[Byte]`.
//! Return: `Coll[Option[Coll[Byte]]]`.
//!
//! Behavior: builds `BatchAVLVerifier`; runs `Lookup(key)` for each key. Any
//! per-op Err → throw. Otherwise emit `Some(value)` for present, `None` for
//! absent.
//!
//! **No per-handler `ctx.add_jit_cost`** in sigma-rust (line 152).
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
use ergotree_ir::mir::constant::{Constant, Literal};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::mir::value::{CollKind, Value};
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::GET_MANY_METHOD;
use ergotree_ir::types::stype::SType;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;

use super::common::{stype_to_json, value_to_json, EvalFixture, EvalFixtureFile};

fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Encode the eval result as a TS SValue `Coll[Option[Coll[Byte]]]`.
///
/// sigma-rust returns `Value::Coll(WrappedColl { elem_tpe = SOption(SColl(SByte)),
/// items = [Value::Opt(...), ...] })`. We need to recurse to wrap each Option
/// in the `{ kind: "Option", elem, value }` shape because `value_to_json`
/// emits `{ kind: "Opaque" }` on Value::Opt fallback if used naively.
fn coll_option_coll_byte_json(value: &Value) -> anyhow::Result<JsonValue> {
    let coll = match value {
        Value::Coll(CollKind::WrappedColl { elem_tpe, items }) => (elem_tpe, items),
        other => anyhow::bail!(
            "savltree_get_many: expected Value::Coll(WrappedColl), got {:?}",
            other
        ),
    };
    let elem_elem_tpe = match coll.0 {
        SType::SOption(inner) => inner.clone(),
        other => anyhow::bail!(
            "savltree_get_many: expected Coll[Option[_]], got Coll[{:?}]",
            other
        ),
    };
    let inner_items: Vec<JsonValue> = coll
        .1
        .iter()
        .map(|item| match item {
            Value::Opt(None) => Ok(json!({
                "kind": "Option",
                "elem": stype_to_json(&elem_elem_tpe),
                "value": null,
            })),
            Value::Opt(Some(boxed)) => Ok(json!({
                "kind": "Option",
                "elem": stype_to_json(&elem_elem_tpe),
                "value": value_to_json(boxed),
            })),
            other => anyhow::bail!("savltree_get_many: inner not Value::Opt: {:?}", other),
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(json!({
        "kind": "Coll",
        "elem": stype_to_json(coll.0),
        "items": inner_items,
    }))
}

/// Build a prover, populate, capture starting digest, then perform `Lookup(k)`
/// for each test key (multi-op proof).
fn build_lookups_proof(
    key_length: usize,
    entries: &[(Vec<u8>, Vec<u8>)],
    test_keys: &[Vec<u8>],
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

    for key in test_keys {
        let _ = prover.perform_one_operation(&Operation::Lookup(Bytes::from(key.clone())))?;
    }
    let proof_bytes = prover.generate_proof().to_vec();

    Ok((starting_digest, proof_bytes))
}

/// Construct a `Constant<Coll[Coll[Byte]]>` from `Vec<Vec<u8>>`.
/// Mirrors the construction in sigma-rust's `eval_avl_get_many` test
/// (savltree.rs:637-643).
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
    entries: &[(Vec<u8>, Vec<u8>)],
    test_keys: &[Vec<u8>],
) -> anyhow::Result<EvalFixture> {
    let (starting_digest, proof_bytes) =
        build_lookups_proof(key_length as usize, entries, test_keys)?;

    let avl_tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags: AvlTreeFlags::new(false, false, false),
        key_length,
        value_length_opt: None,
    };

    let avl_const: Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let keys_expr: Expr = keys_constant(test_keys).into();

    let proof_const: Constant = proof_bytes.into();
    let proof_expr: Expr = proof_const.into();

    let expr: Expr = MethodCall::new(
        avl_expr,
        GET_MANY_METHOD.clone(),
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
        expected_value_json: coll_option_coll_byte_json(&val)?,
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

    // 3-leaf tree with 1-byte keys; lookups produce a single multi-op proof
    // covering the requested key paths.
    let leaves: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (key_n(0x01, 1), val_8(0x01)),
        (key_n(0x02, 1), val_8(0x02)),
        (key_n(0x03, 1), val_8(0x03)),
    ];

    // 1. all-present — 3 keys, all return Some(value)
    entries.push(make_entry(
        "get_many_all_present",
        1,
        &leaves,
        &[key_n(0x01, 1), key_n(0x02, 1), key_n(0x03, 1)],
    )?);

    // 2. mixed-2-of-3 — 2 present + 1 absent → Some/Some/None
    entries.push(make_entry(
        "get_many_mixed_2_of_3",
        1,
        &leaves,
        &[key_n(0x01, 1), key_n(0xAA, 1), key_n(0x03, 1)],
    )?);

    // 3. all-absent — 3 keys, all absent → 3 None
    entries.push(make_entry(
        "get_many_all_absent",
        1,
        &leaves,
        &[key_n(0xAA, 1), key_n(0xBB, 1), key_n(0xCC, 1)],
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_get_many",
        entries,
    })
}
