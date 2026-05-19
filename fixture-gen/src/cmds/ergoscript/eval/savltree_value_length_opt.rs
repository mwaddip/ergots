//! SAvlTree.valueLengthOpt handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/savltree.rs:48-57`
//! (VALUE_LENGTH_OPT_EVAL_FN)
//! Method registration:
//! `ergotree-ir/src/types/savltree.rs::VALUE_LENGTH_OPT_METHOD`
//!
//! Pattern A cost 15 (charged before obj extraction). Returns
//! `Option[Int]` — `value_length_opt.map(|v| v as i32)`.
//!
//! Total eval cost: 4 (PropertyCall dispatcher) + 5 (inline Const arm) + 15
//! (handler) = 24. (Non-segregated v0(false) tree → inline Const path; cost 5
//! per eval.rs:148. Segregated ConstPlaceholder costs 1 instead.)
//!
//! Phase 2h-b Phase B wave 1 (per PLAN.md Phase B).
//!
//! Note on the expected-value encoding: `value_to_json` in `common.rs`
//! does not have a `Value::Opt` arm (the runtime form erases the elem
//! SType). We handle `Option[Int]` locally via `option_json` so the JSON
//! matches the TS `SValue` Option variant (schema mirrored from
//! `extract_register_as.rs::option_json`).

use ergo_chain_types::ADDigest;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::savltree::VALUE_LENGTH_OPT_METHOD;
use ergotree_ir::types::stype::SType;
use serde_json::{json, Value as JsonValue};

use super::common::{stype_to_json, value_to_json, EvalFixture, EvalFixtureFile};

fn digest_pattern(pattern: u8) -> ADDigest {
    let bytes: [u8; 33] = [pattern; 33];
    ADDigest::from(bytes)
}

/// Encode an `Option[Int]` result as the TS `SValue` Option variant.
/// Schema mirrors `extract_register_as.rs::option_json`:
///   `{ kind: "Option", elem: SType, value: SValue | null }`
fn option_int_json(value: &Value) -> anyhow::Result<JsonValue> {
    let inner = match value {
        Value::Opt(None) => None,
        Value::Opt(Some(boxed)) => Some(value_to_json(boxed)),
        other => anyhow::bail!(
            "savltree_value_length_opt: expected Value::Opt, got {:?}",
            other
        ),
    };
    let elem = stype_to_json(&SType::SInt);
    Ok(match inner {
        None => json!({ "kind": "Option", "elem": elem, "value": null }),
        Some(v) => json!({ "kind": "Option", "elem": elem, "value": v }),
    })
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

    let expr: Expr = PropertyCall::new(avl_expr, VALUE_LENGTH_OPT_METHOD.clone())
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
        expected_value_json: option_int_json(&val)?,
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Cover both Option arms: None (variable-length values) and Some(...) at
    // common fixed-length settings (8, 32, 64 bytes).
    entries.push(make_entry(
        "value_length_opt_none",
        digest_pattern(0x00),
        AvlTreeFlags::new(false, false, false),
        32,
        None,
    )?);
    entries.push(make_entry(
        "value_length_opt_some_8",
        digest_pattern(0x11),
        AvlTreeFlags::new(true, false, false),
        32,
        Some(8),
    )?);
    entries.push(make_entry(
        "value_length_opt_some_32",
        digest_pattern(0xAB),
        AvlTreeFlags::new(true, true, true),
        8,
        Some(32),
    )?);
    entries.push(make_entry(
        "value_length_opt_some_64",
        digest_pattern(0xFF),
        AvlTreeFlags::new(true, true, true),
        32,
        Some(64),
    )?);

    Ok(EvalFixtureFile {
        corpus: "eval_savltree_value_length_opt",
        entries,
    })
}
