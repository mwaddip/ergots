//! SAvlTree.digest handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:28-34` (DIGEST_EVAL_FN)
//! Method registration: `ergotree-ir/src/types/savltree.rs::DIGEST_METHOD`
//!
//! Pattern A cost 15 (charged before obj extraction). Returns the 33-byte
//! `Coll[Byte]` digest (root hash + height byte).
//!
//! Total eval cost: 4 (PropertyCall dispatcher) + 5 (inline Const arm) + 15
//! (handler) = 24. (Non-segregated v0(false) tree → inline Const path; cost 5
//! per eval.rs:148. Segregated ConstPlaceholder costs 1 instead.)
//!
//! Each fixture entry wraps an `AvlTreeData` as a `Constant<SAvlTree>` and
//! invokes `PropertyCall(avl, DIGEST_METHOD)`. We vary `treeFlags`,
//! `keyLength`, `valueLengthOpt`, and `digest` bytes to cover the boundary
//! shapes the TS handler must accept.
//!
//! Phase 2h-b Phase B wave 1 (per PLAN.md Phase B).
//!
//! Note: `ergotree-interpreter::eval::test_util::try_eval_out` requires the
//! interpreter's `arbitrary` feature (declared in Cargo.toml).

use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::DIGEST_METHOD;
use serde_json::json;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

/// Build a 33-byte ADDigest with byte `pattern` repeated.
/// Varying the pattern across fixtures gives non-trivial digest bytes the TS
/// handler must echo unchanged into the Coll[Byte] return value.
fn digest_pattern(pattern: u8) -> ADDigest {
    let bytes: [u8; 33] = [pattern; 33];
    ADDigest::from(bytes)
}

/// One entry: build a `Constant<SAvlTree>(avl)`, wrap in `PropertyCall`, eval.
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

    // AvlTreeData → Constant via impl From<AvlTreeData> for Constant
    // (`ergotree-ir/src/mir/constant.rs:701`).
    let avl_const: ergotree_ir::mir::constant::Constant = avl_tree_data.into();
    let avl_expr: Expr = avl_const.into();

    let expr: Expr = PropertyCall::new(avl_expr, DIGEST_METHOD.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    // SAvlTree accessors don't read from Context; any context works.
    // force_any_val seeds from the OS RNG but the eval result depends only on
    // the literal AvlTreeData, so the fixture stays deterministic.
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

    // Vary flags / keyLength / valueLengthOpt / digest pattern across 4 entries.
    entries.push(make_entry(
        "digest_no_ops_klen32_vnone",
        digest_pattern(0x00),
        AvlTreeFlags::new(false, false, false),
        32,
        None,
    )?);
    entries.push(make_entry(
        "digest_insert_only_klen32_v32",
        digest_pattern(0x11),
        AvlTreeFlags::new(true, false, false),
        32,
        Some(32),
    )?);
    entries.push(make_entry(
        "digest_all_allowed_klen8_vnone",
        digest_pattern(0xAB),
        AvlTreeFlags::new(true, true, true),
        8,
        None,
    )?);
    entries.push(make_entry(
        "digest_all_allowed_klen32_v64",
        digest_pattern(0xFF),
        AvlTreeFlags::new(true, true, true),
        32,
        Some(64),
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_digest",
        entries,
    })
}
