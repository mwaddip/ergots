//! SAvlTree.updateDigest handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:90-102`
//! (UPDATE_DIGEST_EVAL_FN). MethodCall typeId=100, methodId=15.
//! Method registration: `ergotree-ir/src/types/savltree.rs::UPDATE_DIGEST_METHOD`
//! (UPDATE_DIGEST_METHOD_ID = MethodId(15); SType (SAvlTree, Coll[Byte]) → SAvlTree;
//! min_version V0).
//!
//! Args: `newDigest: Coll[Byte]` (must be 33 bytes).
//! Return: `AvlTree` (new tree-value with `digest` replaced).
//!
//! Pattern A cost 40 (charged before obj extraction). Behavior:
//!   ctx.add_jit_cost(40);
//!   let mut avl = obj.try_extract_into::<AvlTreeData>()?;
//!   let bytes_vec = args[0].try_extract_into::<Vec<u8>>()?;
//!   let new_digest = ADDigest::try_from(bytes_vec).map_err(map_eval_err)?;  // throws here if len != 33
//!   avl.digest = new_digest;
//!   Value::AvlTree(Box::new(avl))
//!
//! Two scenarios:
//!
//! 1. **Happy** (`update_digest_replace_33_byte`): starting tree with digest A
//!    (33 bytes, pattern 0x42); call updateDigest with digest B (33 bytes,
//!    pattern 0xAB). Expect AvlTreeData with `digest == B`. Captured via
//!    `try_eval_out`; expected_cost = ctx.jit_cost_value(); expected_error_code = null.
//!
//! 2. **Bad-length-throw** (`update_digest_bad_length_32_byte`): starting tree;
//!    call updateDigest with a 32-byte Coll[Byte] arg. Sigma-rust's
//!    `ADDigest::try_from(bytes_vec)` returns `Err(...)`, mapped via
//!    `map_eval_err` to `EvalError::Misc(...)`. We do NOT call `try_eval_out`
//!    here — the helper returns `Err(EvalError::...)` with no Value. Instead
//!    we capture the structural data (tree bytes) and emit
//!    `expected_value_json: null`, `expected_cost: 0`, and
//!    `expected_error_code: "avl-tree-bad-digest-length"`. The TS test
//!    asserts the throw via the dispatcher's full Pattern A cost path.
//!
//!    (Convention from `coll_exists.rs`, `extract_register_as.rs`, etc.:
//!    error entries set `expected_cost: 0` rather than computing the
//!    partial accumulated cost; the TS-side assertion is on the error
//!    code, with cost-charged-before-throw separately covered by edge-case
//!    tests in T8 that drive the dispatcher directly.)
//!
//! The eval result `Value::AvlTree(Box<AvlTreeData>)` is encoded manually as
//! `{ kind: "AvlTree", value: <avl_tree_data> }` to match the TS
//! `hydrateSValue` AvlTree arm at `packages/ergoscript/test/_helpers/index.ts`.
//! Reuses `savltree_insert::avl_tree_data_to_json` for the inner shape.
//!
//! Phase 2h-d Task 6.

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
use ergotree_ir::types::savltree::UPDATE_DIGEST_METHOD;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};

use super::savltree_insert::avl_tree_data_to_json;

/// Fixture struct extending the standard EvalFixture shape with
/// `expected_error_code` for the bad-length throw scenario.
///
/// Mirrors `CollExistsFixture` in `coll_exists.rs` — the canonical pattern
/// for per-arm modules that mix success and error entries.
#[derive(Serialize)]
pub struct UpdateDigestFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries
    pub expected_value_json: JsonValue,
    /// 0 for error entries (convention from coll_exists / extract_register_as)
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct UpdateDigestFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<UpdateDigestFixture>,
}

/// Encode an `AvlTree` Value as the TS SValue AvlTree variant:
///   `{ kind: "AvlTree", value: <avl_tree_data> }`
fn avl_tree_value_json(value: &Value) -> anyhow::Result<JsonValue> {
    match value {
        Value::AvlTree(avl) => Ok(json!({
            "kind": "AvlTree",
            "value": avl_tree_data_to_json(avl),
        })),
        other => anyhow::bail!(
            "savltree_update_digest: expected Value::AvlTree, got {:?}",
            other
        ),
    }
}

/// Build a starting AvlTreeData with the given digest pattern + flags.
fn make_starting_tree(digest_pattern: u8) -> AvlTreeData {
    let digest_bytes: [u8; 33] = [digest_pattern; 33];
    AvlTreeData {
        digest: ADDigest::from(digest_bytes),
        tree_flags: AvlTreeFlags::new(true, true, true),
        key_length: 32,
        value_length_opt: None,
    }
}

/// Build the MethodCall expr for `tree.updateDigest(new_digest_bytes)`.
fn build_update_digest_expr(
    starting_tree: AvlTreeData,
    new_digest_bytes: Vec<u8>,
) -> anyhow::Result<Expr> {
    let avl_const: Constant = starting_tree.into();
    let avl_expr: Expr = avl_const.into();

    // Coll[Byte] argument carrying the new digest bytes.
    let digest_const: Constant = new_digest_bytes.into();
    let digest_expr: Expr = digest_const.into();

    Ok(MethodCall::new(
        avl_expr,
        UPDATE_DIGEST_METHOD.clone(),
        vec![digest_expr],
    )
    .map_err(|e| anyhow::anyhow!("MethodCall updateDigest: {:?}", e))?
    .into())
}

/// Happy-path entry: 33-byte new digest, captured via sigma-rust oracle.
fn make_happy_entry() -> anyhow::Result<UpdateDigestFixture> {
    let starting_tree = make_starting_tree(0x42);
    let new_digest_bytes: Vec<u8> = vec![0xAB; 33];

    let expr = build_update_digest_expr(starting_tree, new_digest_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(UpdateDigestFixture {
        name: "update_digest_replace_33_byte".into(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: avl_tree_value_json(&val)?,
        expected_cost: cost,
        expected_error_code: json!(null),
    })
}

/// Bad-length-throw entry: 32-byte Coll[Byte] arg → `ADDigest::try_from` errors.
/// We do NOT call `try_eval_out` (it would return `Err`); just serialize the
/// tree and let the TS test assert the throw.
fn make_bad_length_entry() -> anyhow::Result<UpdateDigestFixture> {
    let starting_tree = make_starting_tree(0x42);
    // 32 bytes instead of 33 — triggers `ADDigest::try_from` length-check failure.
    let bad_digest_bytes: Vec<u8> = vec![0xAB; 32];

    let expr = build_update_digest_expr(starting_tree, bad_digest_bytes)?;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    Ok(UpdateDigestFixture {
        name: "update_digest_bad_length_32_byte".into(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("avl-tree-bad-digest-length"),
    })
}

pub fn generate() -> anyhow::Result<UpdateDigestFixtureFile> {
    let entries = vec![
        make_happy_entry()?,
        make_bad_length_entry()?,
    ];

    Ok(UpdateDigestFixtureFile {
        corpus: "eval_savltree_update_digest",
        entries,
    })
}
