//! Tuple arm — fixtures for `Expr::Tuple(items)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/tuple.rs:9-19`
//!   ctx.add_jit_cost(15)?;        // Tuple = Fixed(15) (envelope)
//!   let items_v = self.items.try_mapped_ref(|i| i.eval(env, ctx));
//!   Ok(Value::Tup(items_v?))
//!
//! Cost: Tuple = Fixed(15) (envelope) + sum of item costs (recursive).
//! Items are themselves Const here (cost 5 each), so a 2-tuple of Const
//! costs 15 + 5 + 5 = 25; a 3-tuple of Const costs 15 + 5 + 5 + 5 = 30.
//!
//! Uses test_util (gated by 'arbitrary' feature on ergotree-interpreter)
//! to drive the same evaluator the Scala node ships with — sigma-rust IS
//! the cost+value oracle for this arm.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::tuple::Tuple;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let cases: Vec<(&str, Vec<Expr>)> = vec![
        (
            "tuple_pair_int_long",
            vec![Expr::Const(1i32.into()), Expr::Const(100i64.into())],
        ),
        (
            "tuple_triple_bool_byte_short",
            vec![
                Expr::Const(true.into()),
                Expr::Const(7i8.into()),
                Expr::Const(1234i16.into()),
            ],
        ),
    ];

    for (name, items) in cases {
        let tuple_expr: Expr = Tuple::new(items)?.into();
        // No constant segregation — keeps the body a literal Tuple node so
        // the TS-side parser walks straight into the Tuple arm. Segregation
        // would lift each Const into tree.constants and wrap with
        // ConstPlaceholders, which routes through a different arm we already
        // covered in Task 9.
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &tuple_expr)?;
        let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        let cost = ctx.jit_cost_value();

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: cost,
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_tuple",
        entries,
    })
}
