//! SAvlTree.enabledOperations handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:36-40`
//! (ENABLED_OPERATIONS_EVAL_FN)
//! Method registration:
//! `ergotree-ir/src/types/savltree.rs::ENABLED_OPERATIONS_METHOD`
//!
//! Pattern A cost 15 (charged before obj extraction). Returns `Byte` —
//! the packed `tree_flags.serialize() as i8` (bits 0/1/2 → insert/update/remove).
//!
//! Total eval cost: 4 (PropertyCall dispatcher) + 5 (inline Const arm) + 15
//! (handler) = 24. (Non-segregated v0(false) tree → inline Const path; cost 5
//! per eval.rs:148. Segregated ConstPlaceholder costs 1 instead.)
//!
//! Phase 2h-b Phase B wave 1 (per PLAN.md Phase B).

use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::ENABLED_OPERATIONS_METHOD;
use serde_json::json;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

fn digest_pattern(pattern: u8) -> ADDigest {
    let bytes: [u8; 33] = [pattern; 33];
    ADDigest::from(bytes)
}

fn make_entry(
    name: &str,
    digest: ADDigest,
    tree_flags: AvlTreeFlags,
    key_length: u32,
    value_length_opt: Option<u32>,
) -> anyhow::Result<EvalFixture> {
    let avl_tree_data = AvlTreeData {
        digest,
        tree_flags,
        key_length,
        value_length_opt: value_length_opt.map(Box::new),
    };

    let avl_const: ergotree_ir::mir::constant::Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let expr: Expr = PropertyCall::new(avl_expr, ENABLED_OPERATIONS_METHOD.clone())
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
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Vary all three tree-flag bits to cover the 4 boundary points (0x00 / 0x01
    // / 0x07) plus a mixed setting (0x05 = insert+remove, no update).
    entries.push(make_entry(
        "enabled_operations_none",
        digest_pattern(0x00),
        AvlTreeFlags::new(false, false, false),
        32,
        None,
    )?);
    entries.push(make_entry(
        "enabled_operations_insert_only",
        digest_pattern(0x11),
        AvlTreeFlags::new(true, false, false),
        32,
        Some(32),
    )?);
    entries.push(make_entry(
        "enabled_operations_insert_and_remove",
        digest_pattern(0xAB),
        AvlTreeFlags::new(true, false, true),
        8,
        None,
    )?);
    entries.push(make_entry(
        "enabled_operations_all_allowed",
        digest_pattern(0xFF),
        AvlTreeFlags::new(true, true, true),
        32,
        Some(64),
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_enabled_operations",
        entries,
    })
}
