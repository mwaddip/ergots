//! BlockValue arm — fixtures with let-bindings + result.
//! Sigma-rust ref: ergotree-interpreter/src/eval/block.rs
//! Cost: addPerItemCost(1, 1, 10, items.length) envelope + per ValDef (rhs + 5 ADD_TO_ENV) + result.
//! Uses test_util.

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
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Case 1: BlockValue { items: [ValDef(0, Const(42))], result: ValUse(0) }
    {
        let block: Expr = BlockValue {
            items: vec![ValDef {
                id: 0.into(),
                rhs: Box::new(Expr::Const(42i32.into())),
            }
            .into()],
            result: Box::new(
                ValUse {
                    val_id: 0.into(),
                    tpe: SType::SInt,
                }
                .into(),
            ),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &block)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        entries.push(EvalFixture {
            name: "block_one_valdef_one_valuse".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    // Case 2: 4 ValDefs (validates ADD_TO_ENV_COST × 4 + envelope)
    {
        let block: Expr = BlockValue {
            items: (1..=4)
                .map(|i| {
                    ValDef {
                        id: i.into(),
                        rhs: Box::new(Expr::Const((i as i32).into())),
                    }
                    .into()
                })
                .collect(),
            result: Box::new(
                ValUse {
                    val_id: 4.into(),
                    tpe: SType::SInt,
                }
                .into(),
            ),
        }
        .into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &block)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        entries.push(EvalFixture {
            name: "block_4_valdefs".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_block_value",
        entries,
    })
}
