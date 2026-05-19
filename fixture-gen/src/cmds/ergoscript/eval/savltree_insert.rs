//! SAvlTree.insert handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:214-277`
//! (INSERT_EVAL_FN). MethodCall typeId=100, methodId=12.
//! Method registration: `ergotree-ir/src/types/savltree.rs::INSERT_METHOD`.
//!
//! Args: `entries: Coll[(Coll[Byte], Coll[Byte])]`, `proof: Coll[Byte]`.
//! Return: `Option[AvlTree]`.
//!
//! Behavior:
//! - `!tree_flags.insert_allowed()` → `Value::Opt(None)` (no avltree call).
//! - Verifier construct fail → throw.
//! - V<3 per-op fail → throw.
//! - V3+ per-op fail → break loop; partial-success digest used.
//! - All ops succeed → `Some(AvlTree)` with new digest.
//!
//! **No per-handler `ctx.add_jit_cost`** in sigma-rust (line 214).
//!
//! This module generates V0 (treeVersion=0) fixtures only:
//!   - success-1-entry (1 insert)
//!   - success-3-entries (3 inserts)
//!   - disallowed-flags (treeFlags.insertAllowed=false → None)
//!
//! V3+ partial-success fixtures are deferred per the wave 2 task brief.
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
use ergotree_ir::types::savltree::INSERT_METHOD;
use ergotree_ir::types::stuple::STuple;
use ergotree_ir::types::stype::SType;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;

use super::common::{EvalFixture, EvalFixtureFile};

fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}

/// Encode an AvlTreeData as TS-side AvlTree value JSON.
///
/// Schema mirrors `packages/ergoscript/src/mir/types.ts::AvlTreeData`
/// (per docs/specs/2026-05-19-ergoscript-phase-2h-b-...:111-117):
///   `{ digest_hex, treeFlags, keyLength, valueLengthOpt }`
///
/// The outer SValue wrap is `{ kind: "AvlTree", value: <this> }` per the
/// established kind/value pattern for primitive variants in `value_to_json`.
pub(super) fn avl_tree_data_to_json(d: &AvlTreeData) -> JsonValue {
    json!({
        "digest_hex": hex::encode(d.digest.0.as_ref()),
        "treeFlags": d.tree_flags.serialize() as u32,
        "keyLength": d.key_length,
        "valueLengthOpt": d.value_length_opt.as_deref().copied(),
    })
}

/// Encode SType::SAvlTree (`stype_to_json` in `common.rs` doesn't have an
/// SAvlTree arm; handle inline to avoid mutating the shared helper).
pub(super) fn savl_tree_type_json() -> JsonValue {
    json!({ "tag": "SAvlTree" })
}

/// Encode an `Option[AvlTree]` Value as the TS SValue Option variant.
pub(super) fn option_avl_tree_json(value: &Value) -> anyhow::Result<JsonValue> {
    let inner = match value {
        Value::Opt(None) => None,
        Value::Opt(Some(boxed)) => match boxed.as_ref() {
            Value::AvlTree(avl) => Some(json!({
                "kind": "AvlTree",
                "value": avl_tree_data_to_json(avl),
            })),
            other => anyhow::bail!(
                "savltree_insert: expected Value::Opt(AvlTree), got Some({:?})",
                other
            ),
        },
        other => anyhow::bail!("savltree_insert: expected Value::Opt, got {:?}", other),
    };
    Ok(match inner {
        None => json!({ "kind": "Option", "elem": savl_tree_type_json(), "value": null }),
        Some(v) => json!({ "kind": "Option", "elem": savl_tree_type_json(), "value": v }),
    })
}

/// Build a prover with the initial state and produce
/// `(starting_digest, proof_bytes)` for a multi-Insert op batch.
///
/// Mirrors the wave 1 fixture pattern: setup ops → discard their proof →
/// capture digest → apply test ops → capture their proof.
pub(super) fn build_insert_proof(
    key_length: usize,
    initial_kvs: &[(Vec<u8>, Vec<u8>)],
    insert_entries: &[(Vec<u8>, Vec<u8>)],
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

    for (k, v) in insert_entries {
        prover.perform_one_operation(&Operation::Insert(KeyValue {
            key: Bytes::from(k.clone()),
            value: Bytes::from(v.clone()),
        }))?;
    }
    let proof_bytes = prover.generate_proof().to_vec();

    Ok((starting_digest, proof_bytes))
}

/// Construct a `Constant<Coll[(Coll[Byte], Coll[Byte])]>` for the `entries`
/// argument. Mirrors sigma-rust's `eval_avl_insert` test (savltree.rs:724-736).
pub(super) fn entries_constant(entries: &[(Vec<u8>, Vec<u8>)]) -> Constant {
    let items: Arc<[Literal]> = entries
        .iter()
        .map(|(k, v)| {
            Literal::Tup(
                [Literal::from(k.clone()), Literal::from(v.clone())].into(),
            )
        })
        .collect();
    let pair_tpe = SType::STuple(STuple::pair(
        SType::SColl(Arc::new(SType::SByte)),
        SType::SColl(Arc::new(SType::SByte)),
    ));
    Constant {
        tpe: SType::SColl(Arc::new(pair_tpe.clone())),
        v: Literal::Coll(CollKind::WrappedColl {
            items,
            elem_tpe: pair_tpe,
        }),
    }
}

fn make_entry(
    name: &str,
    key_length: u32,
    initial_kvs: &[(Vec<u8>, Vec<u8>)],
    insert_entries: &[(Vec<u8>, Vec<u8>)],
    insert_allowed: bool,
) -> anyhow::Result<EvalFixture> {
    // For disallowed-flags fixtures we still need a valid starting digest +
    // proof, because the handler reads `obj.try_extract_into::<AvlTreeData>()`
    // before the `!insert_allowed` short-circuit. Generate a real proof for
    // the would-be insert ops, then set treeFlags to disable insert.
    let (starting_digest, proof_bytes) =
        build_insert_proof(key_length as usize, initial_kvs, insert_entries)?;

    let tree_flags = AvlTreeFlags::new(insert_allowed, false, false);
    let avl_tree_data = AvlTreeData {
        digest: starting_digest,
        tree_flags,
        key_length,
        value_length_opt: None,
    };

    let avl_const: Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let entries_expr: Expr = entries_constant(insert_entries).into();

    let proof_const: Constant = proof_bytes.into();
    let proof_expr: Expr = proof_const.into();

    let expr: Expr = MethodCall::new(
        avl_expr,
        INSERT_METHOD.clone(),
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

    // Empty initial tree; single Insert.
    entries.push(make_entry(
        "insert_success_1_entry",
        1,
        &[],
        &[(key_n(0x01, 1), val_8(0x01))],
        true,
    )?);

    // Empty initial tree; three Inserts (multi-entry batch).
    entries.push(make_entry(
        "insert_success_3_entries",
        1,
        &[],
        &[
            (key_n(0x01, 1), val_8(0x01)),
            (key_n(0x02, 1), val_8(0x02)),
            (key_n(0x03, 1), val_8(0x03)),
        ],
        true,
    )?);

    // disallowed-flags: insertAllowed=false → handler returns Option None
    // before touching the verifier. We still pass a valid proof; the early
    // return ignores it.
    entries.push(make_entry(
        "insert_disallowed_flags",
        1,
        &[],
        &[(key_n(0x01, 1), val_8(0x01))],
        false,
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_insert",
        entries,
    })
}
