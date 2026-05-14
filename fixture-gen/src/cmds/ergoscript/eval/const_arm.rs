//! Const arm — fixtures for `Expr::Const(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/expr.rs:21-24` —
//!   `Expr::Const(c) => { ctx.add_jit_cost(5)?; Ok(Value::from(c.v.clone())) }`
//!
//! Cost: `Constant = Fixed(5)`.
//!
//! We inline the arm's behavior here rather than calling sigma-rust's
//! `Evaluable::eval` (which is `pub(crate)`, not reachable from this crate)
//! or going through `reduce_to_crypto` (returns `SigmaProp` only, not raw
//! `Value`). The Const arm is one cost.add + one Value::from(Literal); both
//! sides of the equation are mechanically derived from `Constant.v`, so this
//! exactly reproduces what `Expr::Const(c).eval(env, ctx)` would have
//! produced. If the arm body in sigma-rust ever grows beyond cost+wrap, we
//! switch to a feature-gated `try_eval_out` path.

use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let cases: Vec<(&str, Constant)> = vec![
        ("const_bool_true", true.into()),
        ("const_bool_false", false.into()),
        ("const_byte_0", 0i8.into()),
        ("const_byte_42", 42i8.into()),
        ("const_short_0", 0i16.into()),
        ("const_short_neg1", (-1i16).into()),
        ("const_int_0", 0i32.into()),
        ("const_int_max", i32::MAX.into()),
        ("const_int_min", i32::MIN.into()),
        ("const_long_0", 0i64.into()),
        ("const_long_max", i64::MAX.into()),
    ];

    let mut entries = Vec::with_capacity(cases.len());
    for (name, c) in cases {
        // Header: v0, no segregation. Without segregation `ErgoTree::new`
        // wraps the expr verbatim and `tree.constants` stays empty.
        let header = ErgoTreeHeader::v0(/* constant_segregation */ false);
        let expr: Expr = c.clone().into();
        let tree = ErgoTree::new(header, &expr)?;
        let tree_bytes = tree.sigma_serialize_bytes()?;
        let tree_bytes_hex = hex::encode(&tree_bytes);

        // Mirror sigma-rust's `Expr::Const` arm:
        //   ctx.add_jit_cost(5)?;            -> expected_cost = 5
        //   Ok(Value::from(c.v.clone()))     -> expected_value
        let value: Value<'static> = Value::from(c.v.clone());
        let expected_cost: u64 = 5;

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&value),
            expected_cost,
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_const",
        entries,
    })
}
