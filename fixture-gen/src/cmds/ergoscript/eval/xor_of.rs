//! XorOf arm — fixtures for `Expr::XorOf(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/xor_of.rs:12-36
//!   let input_v = self.input.eval(env, ctx)?;
//!   let input_v_bools = input_v.try_extract_into::<Vec<bool>>()?;
//!   ctx.add_per_item_jit_cost(20, 5, 32, input_v_bools.len() as u32)?;
//!   if ctx.tree_version() < V2 {
//!       // JVM v4.x bug: has_true && has_false (count-independent)
//!   } else {
//!       // Correct left-fold XOR: true iff odd count of trues
//!   }
//!
//! Tree-version-dependent semantics (per the PLAN's smoking-gun case):
//!   V0/V1: JVM v4.x bug — true iff Coll contains BOTH true and false.
//!     xorOf([true, true, false]) → true.
//!   V2+:   Correct left-fold XOR — true iff odd count of trues.
//!     xorOf([true, true, false]) → false (2 trues = even count).
//!
//! Coverage: empty Coll at V0/V1/V2/V3 (all → false); single-item at V0
//! and V2; mixed cases that produce DIFFERENT results at V0/V1 vs V2+
//! (the smoking-gun [true, true, false] appears at both V0 and V2); V0
//! with all-true (no false, so bug returns false); V2 with three trues
//! (odd count → true); n=32/33 chunk boundary at V0; cost-limit.
//!
//! Non-Coll[Boolean] error case is NOT generated here. `XorOf::sigma_parse`
//! requires `post_eval_tpe == Coll[Boolean]` on the input, so we cannot
//! serialize a malformed tree through the standard path. The TS-side
//! `'coll-not-boolean'` assertion is covered by inline tests that
//! construct hand-built MIR nodes (And/Or precedent from slice 2d-B).

use core::cell::Cell;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::constant::Literal;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::CollKind;
use ergotree_ir::mir::value::Value;
use ergotree_ir::mir::xor_of::XorOf;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;
use std::sync::Arc;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct XorOfFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: JsonValue,
    /// null for error entries
    pub expected_value_json: JsonValue,
    /// 0 for error entries
    pub expected_cost: u64,
    /// null for success entries
    pub expected_error_code: JsonValue,
}

#[derive(Serialize)]
pub struct XorOfFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<XorOfFixture>,
}

/// Wrap a `Vec<bool>` into a `Const(Coll[Boolean])` Expr.
fn bool_coll_const(bools: Vec<bool>) -> Expr {
    let literals: Arc<[Literal]> = bools.into_iter().map(Literal::from).collect();
    let coll = CollKind::from_collection(SType::SBoolean, literals)
        .expect("from_collection on SBoolean");
    Expr::Const(Constant {
        tpe: SType::SColl(SType::SBoolean.into()),
        v: Literal::Coll(coll),
    })
}

fn build_tree(input: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = XorOf {
        input: Box::new(input),
    }
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Build a Context with a specific tree version.
fn ctx_with_version(version: u8) -> Context<'static> {
    let ctx = force_any_val::<Context>();
    Context {
        tree_version: Cell::new(ErgoTreeVersion::from(version)),
        ..ctx
    }
}

fn success_entry_with_version(
    name: &str,
    bools: Vec<bool>,
    version: u8,
) -> anyhow::Result<XorOfFixture> {
    let input = bool_coll_const(bools);
    let (tree, hex) = build_tree(input)?;
    let ctx = ctx_with_version(version);
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(XorOfFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "treeVersion": version }),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<XorOfFixtureFile> {
    let mut entries = Vec::new();

    // Empty Coll at each version → false (identity; no trues present).
    for v in [0u8, 1, 2, 3] {
        entries.push(success_entry_with_version(
            &format!("xor_of_empty_v{}", v),
            vec![],
            v,
        )?);
    }

    // Single-item [true]: V0 → false (no false present, bug); V2 → true (odd trues).
    entries.push(success_entry_with_version("xor_of_single_true_v0", vec![true], 0)?);
    entries.push(success_entry_with_version("xor_of_single_true_v2", vec![true], 2)?);

    // Single-item [false]: both versions → false.
    entries.push(success_entry_with_version("xor_of_single_false_v0", vec![false], 0)?);

    // *** Smoking-gun case: [true, true, false] ***
    //   V0: hasTrue && hasFalse → true (JVM v4.x bug — both values present, count-independent)
    //   V2: left-fold XOR → false (2 trues = even count)
    entries.push(success_entry_with_version(
        "xor_of_two_trues_one_false_v0",
        vec![true, true, false],
        0,
    )?);
    entries.push(success_entry_with_version(
        "xor_of_two_trues_one_false_v2",
        vec![true, true, false],
        2,
    )?);

    // V0 with all-true: no false present → false (bug: hasFalse stays false).
    entries.push(success_entry_with_version(
        "xor_of_all_true_v0",
        vec![true, true, true],
        0,
    )?);

    // V2 with three trues → true (3 trues = odd count).
    entries.push(success_entry_with_version(
        "xor_of_three_trues_v2",
        vec![true, true, true],
        2,
    )?);

    // V2 with all-false → false (0 trues = even count).
    entries.push(success_entry_with_version(
        "xor_of_all_false_v2",
        vec![false, false, false],
        2,
    )?);

    // Chunk boundary at V0: n=32 exactly one chunk (chunkSize=32).
    entries.push(success_entry_with_version("xor_of_n32_all_true_v0", vec![true; 32], 0)?);

    // Chunk boundary at V0: n=33 one full + one partial chunk.
    entries.push(success_entry_with_version("xor_of_n33_all_true_v0", vec![true; 33], 0)?);

    // V1 version: [true, false] → true (both present — bug; same as V0).
    entries.push(success_entry_with_version(
        "xor_of_true_false_v1",
        vec![true, false],
        1,
    )?);

    // V3 (same as V2+ branch): [true, false] → true (odd trues).
    entries.push(success_entry_with_version(
        "xor_of_true_false_v3",
        vec![true, false],
        3,
    )?);

    // Cost-limit: jitCostLimit=1 is below base cost of 20 → 'cost-limit-exceeded'.
    {
        let input = bool_coll_const(vec![true; 3]);
        let (_tree, hex) = build_tree(input)?;
        entries.push(XorOfFixture {
            name: "xor_of_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "jitCostLimit": 1, "treeVersion": 0 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    Ok(XorOfFixtureFile {
        corpus: "eval_xor_of",
        entries,
    })
}
