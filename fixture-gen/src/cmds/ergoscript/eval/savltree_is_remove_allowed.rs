//! SAvlTree.isRemoveAllowed handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:71-75`
//! (IS_REMOVE_ALLOWED_EVAL_FN)
//! Method registration:
//! `ergotree-ir/src/types/savltree.rs::IS_REMOVE_ALLOWED_METHOD`
//!
//! Pattern A cost 15 (charged before obj extraction). Returns `Boolean` —
//! `tree_flags.remove_allowed()` (bit 2 of the packed flag byte).
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
use ergotree_ir::types::savltree::IS_REMOVE_ALLOWED_METHOD;
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

    let expr: Expr = PropertyCall::new(avl_expr, IS_REMOVE_ALLOWED_METHOD.clone())
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

    // Cover both Boolean outcomes plus mixed-bit shapes:
    //  - all flags off → false
    //  - insert+update on, remove off (0x03) → false
    //  - remove-only on (0x04) → true
    //  - all flags on (0x07) → true
    entries.push(make_entry(
        "is_remove_allowed_no_ops",
        digest_pattern(0x00),
        AvlTreeFlags::new(false, false, false),
        32,
        None,
    )?);
    entries.push(make_entry(
        "is_remove_allowed_insert_update_only",
        digest_pattern(0x11),
        AvlTreeFlags::new(true, true, false),
        32,
        Some(32),
    )?);
    entries.push(make_entry(
        "is_remove_allowed_remove_only",
        digest_pattern(0xAB),
        AvlTreeFlags::new(false, false, true),
        8,
        None,
    )?);
    entries.push(make_entry(
        "is_remove_allowed_all_allowed",
        digest_pattern(0xFF),
        AvlTreeFlags::new(true, true, true),
        32,
        Some(64),
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_is_remove_allowed",
        entries,
    })
}
