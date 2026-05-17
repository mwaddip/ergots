//! Atleast eval arm fixture (phase 2g-combinators Task 4).
//!
//! Atleast is the THRESHOLD sigma combinator: `Atleast { bound: Expr<SInt>,
//! input: Expr<SColl[SSigmaProp]> }` — evaluates to SigmaProp after reducing
//! via `Cthreshold::reduce(k, items)`.
//!
//! Cost: Pattern B — `add_per_item_jit_cost(20, 3, 5, n)` AFTER eval-children.
//!   Source: ergotree-interpreter/src/eval/atleast.rs:34
//!
//! Eval flow:
//!   1. eval bound → i32
//!   2. eval input → Coll of Value::SigmaProp items
//!   3. charge cost
//!   4. cast bound to u8 (error if overflow)
//!   5. check bound <= input.len() (error if not)
//!   6. Cthreshold::reduce(bound_u8, input)
//!
//! Coverage:
//!   - basic 2-of-3 ProveDlogs → Cthreshold(2, [a,b,c])
//!   - k=0 of 3 → TrivialProp(true)
//!   - k=1 of 3 → Cor([a,b,c]) (single-of-n collapse)
//!   - k=3 of 3 → Cand([a,b,c]) (all-of-n collapse)
//!   - k=2 of 2 → Cand([a,b]) (all-of-n collapse, 2 items)
//!   - TrivialProp(true) child: k=2 of [T,P,Q] → Cand([P,Q]) or Cor([P]) ...
//!     resolve per cthreshold::reduce rules
//!   - TrivialProp(false) child: k=2 of [F,P,Q] → Cthreshold(2,[P,Q]) or Cor...
//!     resolve per cthreshold::reduce rules
//!   - cost-limit-exceeded (tight limit below base cost)
//!   - error: k=4 of 3 → 'atleast-bound-out-of-range' (bound > input.len())
//!
//! Inline-only TS error cases (cannot be built via sigma-rust Atleast::new):
//!   - non-Int bound          → 'atleast-bound-not-int'
//!   - non-Coll input         → 'sigma-prop-input-not-coll'
//! These are added directly in atleast.test.ts as hand-built MIR nodes.

use ergo_chain_types::ec_point::generator;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::atleast::Atleast;
use ergotree_ir::mir::constant::{Constant, Literal};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::{CollKind, Value};
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{
    ProveDlog, SigmaBoolean, SigmaProofOfKnowledgeTree, SigmaProp,
};
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;
use std::sync::Arc;

/// Build a ProveDlog from the secp256k1 generator point. The Atleast eval only
/// cares about the structural SigmaBoolean form, not the actual key values.
/// Using the same generator point for all items keeps fixtures simple and deterministic.
fn prove_dlog() -> SigmaBoolean {
    let pt = generator();
    SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(ProveDlog::new(pt)))
}

fn trivial_true() -> SigmaBoolean {
    SigmaBoolean::TrivialProp(true)
}

fn trivial_false() -> SigmaBoolean {
    SigmaBoolean::TrivialProp(false)
}

/// Build Const(Coll[SSigmaProp], items) — the `input` child for Atleast.
fn sigma_prop_coll_const(items: Vec<SigmaBoolean>) -> Expr {
    let literals: Arc<[Literal]> = items
        .into_iter()
        .map(|sb| {
            let sp = SigmaProp::new(sb);
            Literal::SigmaProp(Box::new(sp))
        })
        .collect();
    let coll = CollKind::from_collection(SType::SSigmaProp, literals)
        .expect("from_collection SSigmaProp");
    Expr::Const(Constant {
        tpe: SType::SColl(SType::SSigmaProp.into()),
        v: Literal::Coll(coll),
    })
}

/// Build Const(SInt, k) — the `bound` child for Atleast.
fn int_const(k: i32) -> Expr {
    Expr::Const(Constant {
        tpe: SType::SInt,
        v: Literal::Int(k),
    })
}

/// Build an Atleast ErgoTree and return (tree, hex).
fn build_tree(k: i32, sigmas: Vec<SigmaBoolean>) -> anyhow::Result<(ErgoTree, String)> {
    let bound_expr = int_const(k);
    let input_expr = sigma_prop_coll_const(sigmas);
    let body: Expr = Atleast::new(bound_expr, input_expr)?.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &body)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Encode a sigma-rust Value::SigmaProp as `{ kind: "SigmaProp", raw_hex: "..." }`.
/// raw_hex = sigma_serialize_bytes of the inner SigmaBoolean (NOT ErgoTree prop_bytes).
/// Matches the TS hydrateSValue SigmaProp arm which calls parseSigmaBoolean(bytes).
fn sigma_prop_value_to_json(val: &Value) -> anyhow::Result<JsonValue> {
    if let Value::SigmaProp(sp) = val {
        let raw_bytes = sp.value().sigma_serialize_bytes()?;
        Ok(json!({ "kind": "SigmaProp", "raw_hex": hex::encode(&raw_bytes) }))
    } else {
        anyhow::bail!("expected SigmaProp, got {:?}", val)
    }
}

#[derive(Serialize)]
pub struct AtleastEntry {
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
pub struct AtleastFixture {
    pub description: &'static str,
    pub entries: Vec<AtleastEntry>,
}

fn success_entry(
    name: &str,
    k: i32,
    sigmas: Vec<SigmaBoolean>,
) -> anyhow::Result<AtleastEntry> {
    let (tree, hex) = build_tree(k, sigmas)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let expected_value_json = sigma_prop_value_to_json(&val)?;
    Ok(AtleastEntry {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json,
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(
    name: &str,
    k: i32,
    sigmas: Vec<SigmaBoolean>,
    limit: u64,
) -> anyhow::Result<AtleastEntry> {
    let (_tree, hex) = build_tree(k, sigmas)?;
    Ok(AtleastEntry {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

fn error_entry(
    name: &str,
    k: i32,
    sigmas: Vec<SigmaBoolean>,
    expected_error_code: &str,
) -> anyhow::Result<AtleastEntry> {
    let (_tree, hex) = build_tree(k, sigmas)?;
    Ok(AtleastEntry {
        name: name.to_string(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(expected_error_code),
    })
}

pub fn generate() -> anyhow::Result<AtleastFixture> {
    let mut entries = Vec::new();

    // Three distinct ProveDlog leaves for k-of-3 tests.
    // We use the same generator point for all three — the eval logic is about
    // structure, not the specific keys. Sigma-rust evaluates fine with identical points.
    let p = prove_dlog();
    let q = prove_dlog();
    let r = prove_dlog();

    // basic 2-of-3: Cthreshold(2, [P,Q,R])
    entries.push(success_entry("atleast_2_of_3", 2, vec![p.clone(), q.clone(), r.clone()])?);

    // k=0 of 3: TrivialProp(true) (Cthreshold::reduce short-circuit)
    entries.push(success_entry("atleast_0_of_3_true", 0, vec![p.clone(), q.clone(), r.clone()])?);

    // k=1 of 3: Cor([P,Q,R]) (1-of-n = OR)
    entries.push(success_entry("atleast_1_of_3_cor", 1, vec![p.clone(), q.clone(), r.clone()])?);

    // k=3 of 3: Cand([P,Q,R]) (all-of-n = AND)
    entries.push(success_entry("atleast_3_of_3_cand", 3, vec![p.clone(), q.clone(), r.clone()])?);

    // k=2 of 2: Cand([P,Q]) (all-of-n with n=2)
    entries.push(success_entry("atleast_2_of_2_cand", 2, vec![p.clone(), q.clone()])?);

    // TrivialProp(true) child: k=2 of [T,P,Q] → Cthreshold::reduce reduces one True,
    // currK becomes 1, then remaining [P,Q] → Cor([P,Q])
    entries.push(success_entry(
        "atleast_2_of_3_with_true_child",
        2,
        vec![trivial_true(), p.clone(), q.clone()],
    )?);

    // TrivialProp(false) child: k=2 of [F,P,Q] → Cthreshold::reduce skips False,
    // childrenLeft decrements to 2, currK stays 2 → Cand([P,Q])
    entries.push(success_entry(
        "atleast_2_of_3_with_false_child",
        2,
        vec![trivial_false(), p.clone(), q.clone()],
    )?);

    // cost-limit-exceeded: base cost is addPerItemCost(20, 3, 5, 3) = 20 + ceil(3/5)*3 = 20+3 = 23
    // plus 3 child Const evals at 5 each = 15; total = 38 (before any tree header cost).
    // Use limit=1 to trigger early.
    entries.push(cost_limit_entry(
        "atleast_cost_limit_exceeded",
        2,
        vec![p.clone(), q.clone(), r.clone()],
        1,
    )?);

    // k > input.len(): error — sigma-rust atleast.rs:49-55
    // k=4 of 3 → EvalError::Misc (bound > input.len())
    // TS maps this to 'atleast-bound-out-of-range'
    entries.push(error_entry(
        "atleast_bound_exceeds_input_len",
        4,
        vec![p.clone(), q.clone(), r.clone()],
        "atleast-bound-out-of-range",
    )?);

    Ok(AtleastFixture {
        description: "Atleast eval arm (phase 2g-combinators Task 4). Pattern B cost: addPerItemCost(20,3,5,n) AFTER eval-children. Source: ergotree-interpreter/src/eval/atleast.rs.",
        entries,
    })
}
