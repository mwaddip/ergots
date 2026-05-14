//! ValUse arm — fixtures for `Expr::ValUse(...)` evaluation.
//!
//! ValUse can't be exercised at top level because it requires a binding
//! in Env. Sigma-rust's `Evaluable::eval` is pub(crate); we can only
//! invoke the evaluator via `test_util::try_eval_out`, which always uses
//! an empty Env. So we exercise ValUse by wrapping it in a BlockValue
//! that defines the binding, then capture the *total* cost of the
//! wrapping block. The TS test side reproduces the same wrapping via
//! a hand-constructed Env to test ValUse's per-arm cost in isolation.
//!
//! Uses test_util (gated by 'arbitrary' feature on ergotree-interpreter).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::block::BlockValue;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::val_def::ValDef;
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ValUseFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub val_id: u32,
    pub tpe_json: serde_json::Value,
    pub env_bindings: Vec<(u32, serde_json::Value)>,
    pub expected_value_json: serde_json::Value,
    pub expected_cost: u64,
    pub expected_error_code: Option<String>,
}

#[derive(Serialize)]
pub struct ValUseFile {
    pub corpus: &'static str,
    pub entries: Vec<ValUseFixture>,
}

pub fn generate() -> anyhow::Result<ValUseFile> {
    let mut entries = Vec::new();

    // Case 1: ValUse(id=5) bound to Int 42 — wrap in BlockValue and run full eval.
    let block: Expr = BlockValue {
        items: vec![ValDef {
            id: 5.into(),
            rhs: Box::new(Expr::Const(42i32.into())),
        }
        .into()],
        result: Box::new(
            ValUse {
                val_id: 5.into(),
                tpe: SType::SInt,
            }
            .into(),
        ),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &block)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    entries.push(ValUseFixture {
        name: "val_use_int_42".to_string(),
        tree_bytes_hex,
        val_id: 5,
        tpe_json: json!({ "tag": "SInt" }),
        env_bindings: vec![(5, value_to_json(&Value::Int(42)))],
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
        expected_error_code: None,
    });

    // Case 2: ValUse(id=99) unbound — TS-side hand-dispatch only.
    entries.push(ValUseFixture {
        name: "val_use_unbound".to_string(),
        tree_bytes_hex: String::new(),
        val_id: 99,
        tpe_json: json!({ "tag": "SInt" }),
        env_bindings: vec![],
        expected_value_json: json!(null),
        expected_cost: 5, // addCost(5) is called BEFORE the env lookup throws
        expected_error_code: Some("val-use-unbound".to_string()),
    });

    Ok(ValUseFile {
        corpus: "eval_val_use",
        entries,
    })
}
