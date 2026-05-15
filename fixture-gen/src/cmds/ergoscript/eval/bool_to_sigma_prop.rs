//! BoolToSigmaProp arm — fixtures for `Expr::BoolToSigmaProp(...)` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/bool_to_sigma.rs:19`
//!   ctx.add_jit_cost(15)?;  // BoolToSigmaProp = Fixed(15)
//!   let input_v = self.input.eval(env, ctx)?;
//!   let input_v_bool = input_v.try_extract_into::<bool>()?;
//!   Ok((SigmaProp::new(SigmaBoolean::TrivialProp(input_v_bool))).into())
//!
//! Cost: Fixed(15) (arm envelope) + input cost (Const = 5) = 20 total.
//! Two truth-table entries: BoolToSigmaProp(true), BoolToSigmaProp(false).
//!
//! The result is `Value::SigmaProp(SigmaProp(TrivialProp(b)))`.
//! Wire bytes: a single opcode byte — 0xd2 for false, 0xd3 for true.
//! These are captured as `raw_hex` in the fixture so the TS value-equality
//! assertion can check byte-exact output.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bool_to_sigma::BoolToSigmaProp;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    for (name, input_val) in [
        ("bool_to_sigma_true", true),
        ("bool_to_sigma_false", false),
    ] {
        let input_expr: Expr = Expr::Const(input_val.into());
        let sigma_expr: Expr = BoolToSigmaProp {
            input: Box::new(input_expr),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &sigma_expr)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;

        // Extract raw bytes from the SigmaProp value. TrivialProp serializes
        // as a single opcode byte (0xd2 for false, 0xd3 for true) — no payload.
        // SigmaBoolean::sigma_serialize_bytes() gives us just that byte.
        let raw_hex = if let Value::SigmaProp(sp) = &val {
            let sigma_bool = sp.value();
            hex::encode(sigma_bool.sigma_serialize_bytes()?)
        } else {
            anyhow::bail!("expected SigmaProp value, got {:?}", val);
        };

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: json!({ "kind": "SigmaProp", "raw_hex": raw_hex }),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_bool_to_sigma_prop",
        entries,
    })
}
