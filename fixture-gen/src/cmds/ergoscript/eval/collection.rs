//! Collection arm — fixtures for both `kind: 'Exprs'` and `kind: 'BoolConstants'`.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/collection.rs:22`
//!     ctx.add_jit_cost(20)?;          // ConcreteCollection = Fixed(20)
//!     match self {
//!         Collection::BoolConstants(bools) => bools.clone().into(),
//!         Collection::Exprs { elem_tpe, items } => { /* eval each item */ }
//!     }
//!
//! Cost: ConcreteCollection = Fixed(20) (envelope) + recursive item costs.
//! Items are themselves `Const` here (cost 5 each), so a 3-element coll of
//! `Const` items costs 20 + 5 + 5 + 5 = 35; an empty coll costs 20.
//! `BoolConstants` charges only the envelope (20) — no per-item recursion,
//! since the bools are inlined in the variant.
//!
//! Uses test_util (gated by 'arbitrary' feature on ergotree-interpreter)
//! to drive the same evaluator the Scala node ships with — sigma-rust IS
//! the cost+value oracle for this arm.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::collection::Collection;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Case 1: BoolConstants kind — Coll[Boolean] of literals.
    // `Collection::from_bools` constructs the BoolConstants variant directly,
    // routing through the bool-packed wire opcode COLL_OF_BOOL_CONST. The TS
    // arm's BoolConstants branch must charge the envelope (20) and emit a
    // `{ kind: 'Coll', elem: { tag: 'SBoolean' }, items: Boolean[] }`.
    {
        let coll: Expr = Collection::from_bools(vec![true, false, true]).into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &coll)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        entries.push(EvalFixture {
            name: "coll_bool_constants_3".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    // Case 2: Exprs kind — Coll[Int] from Const exprs.
    // `Collection::new` with a non-bool `elem_tpe` always produces the
    // `Exprs` variant. The TS arm's Exprs branch must charge the envelope
    // (20) plus per-item recursive cost (5 each Const).
    {
        let items: Vec<Expr> = vec![
            Expr::Const(1i32.into()),
            Expr::Const(2i32.into()),
            Expr::Const(3i32.into()),
        ];
        let coll: Expr = Collection::new(SType::SInt, items)?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &coll)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        entries.push(EvalFixture {
            name: "coll_exprs_int_3".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    // Case 3: empty Coll[Long]. Verifies envelope-only cost (20) and empty
    // items array semantics (no item-kind validation triggered).
    {
        let coll: Expr = Collection::new(SType::SLong, vec![])?.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &coll)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
        entries.push(EvalFixture {
            name: "coll_empty_long".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_collection",
        entries,
    })
}
