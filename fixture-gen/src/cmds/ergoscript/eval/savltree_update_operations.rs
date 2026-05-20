//! SAvlTree.updateOperations handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:77-88`
//! (UPDATE_OPERATIONS_EVAL_FN). MethodCall typeId=100, methodId=8.
//! Method registration: `ergotree-ir/src/types/savltree.rs::UPDATE_OPERATIONS_METHOD`.
//!
//! Args: `newOperations: Byte`.
//! Return: `AvlTree` (new tree-value with `tree_flags` replaced).
//!
//! Pattern A cost 45 (charged before obj extraction). Behavior:
//!   ctx.add_jit_cost(45);
//!   let mut avl = obj.try_extract_into::<AvlTreeData>()?;
//!   let new_flag_byte = args[0].try_extract_into::<i8>()? as u8;
//!   avl.tree_flags = AvlTreeFlags::parse(new_flag_byte);
//!   Value::AvlTree(Box::new(avl))
//!
//! Minimal scenario (this fixture module): starting tree with flags `0b111`
//! (insert+update+remove enabled), pass a Byte arg encoding `0b101`
//! (insert+remove, no update), expect AvlTreeData with `tree_flags == 5`.
//!
//! The eval result `Value::AvlTree(Box<AvlTreeData>)` is encoded manually as
//! `{ kind: "AvlTree", value: <avl_tree_data> }` to match the TS
//! `hydrateSValue` AvlTree arm at `packages/ergoscript/test/_helpers/index.ts:94`.
//! (`value_to_json` in `common.rs` has no AvlTree arm — falls back to
//! `kind: "Opaque"`. We reuse `savltree_insert::avl_tree_data_to_json` for
//! the inner shape.)
//!
//! Phase 2h-d Task 1.

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
use ergotree_ir::types::savltree::UPDATE_OPERATIONS_METHOD;
use serde_json::json;

use super::common::{EvalFixture, EvalFixtureFile};
use super::savltree_insert::avl_tree_value_json;

fn digest_pattern(pattern: u8) -> ADDigest {
    let bytes: [u8; 33] = [pattern; 33];
    ADDigest::from(bytes)
}

fn make_entry(
    name: &str,
    starting_flags: AvlTreeFlags,
    new_flag_byte: i8,
    key_length: u32,
    value_length_opt: Option<u32>,
) -> anyhow::Result<EvalFixture> {
    let avl_tree_data = AvlTreeData {
        digest: digest_pattern(0x42),
        tree_flags: starting_flags,
        key_length,
        value_length_opt: value_length_opt.map(Box::new),
    };

    let avl_const: Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    // Build a Byte Expr for the newOperations argument. `coll_append.rs:205`
    // shows the canonical `Expr::Const(i8.into())` pattern for SByte literals.
    let new_flags_expr: Expr = Expr::Const(new_flag_byte.into());

    let expr: Expr = MethodCall::new(
        avl_expr,
        UPDATE_OPERATIONS_METHOD.clone(),
        vec![new_flags_expr],
    )
    .unwrap()
    .into();

    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = sigma_test_util::force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: avl_tree_value_json(&val)?,
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Minimal scenario: starting flags 0b111 (insert+update+remove), pass new
    // flags 0b101 (insert+remove, no update). Expect AvlTreeData with
    // treeFlags === 5.
    entries.push(make_entry(
        "update_operations_drop_update_bit",
        AvlTreeFlags::new(true, true, true),
        0b101_i8,
        32,
        None,
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_update_operations",
        entries,
    })
}
