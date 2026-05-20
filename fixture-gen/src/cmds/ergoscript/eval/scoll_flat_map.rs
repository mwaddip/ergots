//! SColl.flatMap handler — fixtures (phase 2h-f).
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scoll.rs:52-136` — `flatmap_eval`.
//! Method registration: `ergotree-ir/src/types/scoll.rs::FLATMAP_METHOD` (V0+).
//!
//! Pattern B `add_per_item_jit_cost(60, 10, 8, n)` AFTER all guards.
//! No per-iter cost (unlike MapColl/Filter/etc. Mixed pattern).
//!
//! ── T6 reachability pre-flight finding ──────────────────────────────────────
//!
//! `MethodCall::new` (sigma-rust mir/method_call.rs:90, calling `new_inner` at
//! :41-87) performs strict structural type-matching: `method.tpe().t_dom` zipped
//! against `[obj.tpe(), ...args.tpe()]` must all `expected == actual`. This
//! REJECTS at construction time:
//!   - arity > 1 lambda (lambda tpe SFunc([T1,T2],...) doesn't match SFunc([IV],...))
//!   - elem-type mismatch (lambda arg tpe doesn't match concrete IV)
//!   - lambda-result-type-mismatch (body's static tpe must be SColl(OV))
//!   - non-Coll obj (Const(SLong) doesn't match SColl(IV))
//!
//! `flatmap_eval`'s body-restriction check (scoll.rs:78-84: `if Expr::MethodCall
//! with non-empty args { Err }`) fires at RUNTIME, NOT at construction. The
//! body's static tpe is still SColl(...) per the type system, so MethodCall::new
//! accepts. ⇒ body-restriction throw IS reachable via fixture.
//!
//! ⇒ Oracle fixtures (5): happy_property_body, happy_concrete_body,
//!    empty_concrete_body, body_restriction_throw, valuse_source_lambda.
//! ⇒ TS-direct tests in T11: arity > 1 lambda, elem-type-mismatch, non-Coll obj,
//!    empty_property_body (R3(b) SAny divergence — sigma-rust returns Coll[Int]
//!    empty, TS returns Coll[SAny] empty; cannot oracle-test the divergence).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::block::BlockValue;
use ergotree_ir::mir::collection::Collection;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::func_value::{FuncArg, FuncValue};
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::mir::val_def::{ValDef, ValId};
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scoll::{FLATMAP_METHOD, INDICES_METHOD, ZIP_METHOD};
use ergotree_ir::types::stuple::STuple;
use ergotree_ir::types::stype::SType;
use ergotree_ir::types::stype_param::STypeVar;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;
use std::sync::Arc;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct FlatMapFixture {
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
pub struct FlatMapFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<FlatMapFixture>,
}

fn build_tree(expr: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, expr: Expr) -> anyhow::Result<FlatMapFixture> {
    let (tree, hex) = build_tree(expr)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(FlatMapFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

pub fn generate() -> anyhow::Result<FlatMapFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. flatmap_happy_property_body ──────────────────────────────────────────
    // Coll[Coll[Long]] flatMap (xs: Coll[Long]) => xs.indices
    //   → Coll[Int] of concatenated indices.
    // Body is a PropertyCall (MethodCall with 0 args) → body-restriction OK.
    // R3(b): TS exprTpe(MethodCall) returns SAny; TS handler refines outElem
    //        from itemRes.elem on first iter (= SInt). sigma-rust resolves to
    //        SColl(SInt) via SMethod resolver. Final value JSON matches.
    {
        // Input: Coll[Coll[Long]] = [[10, 20], [30]]
        let inner1: Expr = Collection::new(SType::SLong, vec![Expr::Const(10i64.into()), Expr::Const(20i64.into())])?.into();
        let inner2: Expr = Collection::new(SType::SLong, vec![Expr::Const(30i64.into())])?.into();
        let input: Expr = Collection::new(
            SType::SColl(Arc::new(SType::SLong)),
            vec![inner1, inner2],
        )?
        .into();
        // Lambda: (xs: Coll[Long]) => xs.indices
        let xs_use: Expr = ValUse {
            val_id: ValId(1),
            tpe: SType::SColl(Arc::new(SType::SLong)),
        }
        .into();
        let body: Expr = MethodCall::new(
            xs_use,
            INDICES_METHOD
                .clone()
                .with_concrete_types(&[(STypeVar::t(), SType::SLong)].iter().cloned().collect()),
            vec![],
        )?
        .into();
        let lambda: Expr = FuncValue::new(
            vec![FuncArg {
                idx: ValId(1),
                tpe: SType::SColl(Arc::new(SType::SLong)),
            }],
            body,
        )
        .into();
        let expr: Expr = MethodCall::new(
            input,
            FLATMAP_METHOD.clone().with_concrete_types(
                &[
                    (STypeVar::iv(), SType::SColl(Arc::new(SType::SLong))),
                    (STypeVar::ov(), SType::SInt),
                ]
                .iter()
                .cloned()
                .collect(),
            ),
            vec![lambda],
        )?
        .into();
        entries.push(success_entry("flatmap_happy_property_body", expr)?);
    }

    // ── 2. flatmap_happy_concrete_body ──────────────────────────────────────────
    // Coll[Long] flatMap (x: Long) => Coll(x, x)
    //   → Coll[Long] of repeated items.
    // Body is a Collection Expr → exprTpe = SColl(SLong) (concrete; non-SAny).
    // Tests the concrete-tpe path (no refinement; outElem = bodyTpe.elem at step 7).
    {
        let input: Expr = Collection::new(
            SType::SLong,
            vec![Expr::Const(10i64.into()), Expr::Const(20i64.into())],
        )?
        .into();
        let x_use: Expr = ValUse {
            val_id: ValId(1),
            tpe: SType::SLong,
        }
        .into();
        // Body: Coll(x, x) — Collection literal of 2 items.
        let body: Expr = Collection::new(SType::SLong, vec![x_use.clone(), x_use])?.into();
        let lambda: Expr = FuncValue::new(
            vec![FuncArg {
                idx: ValId(1),
                tpe: SType::SLong,
            }],
            body,
        )
        .into();
        let expr: Expr = MethodCall::new(
            input,
            FLATMAP_METHOD.clone().with_concrete_types(
                &[
                    (STypeVar::iv(), SType::SLong),
                    (STypeVar::ov(), SType::SLong),
                ]
                .iter()
                .cloned()
                .collect(),
            ),
            vec![lambda],
        )?
        .into();
        entries.push(success_entry("flatmap_happy_concrete_body", expr)?);
    }

    // ── 3. flatmap_empty_concrete_body ──────────────────────────────────────────
    // Coll[Long]() flatMap (x: Long) => Coll(x)
    //   → empty Coll[Long].
    // Empty input + concrete body. outElem = SColl(SLong).elem = SLong;
    // no iters but outElem stays concrete (no refinement needed). Test passes.
    //
    // (The "empty input + property body" scenario — Coll[Coll[Long]]() flatMap
    // (xs => xs.indices) — is omitted here because sigma-rust returns
    // Coll[Int](empty) while TS returns Coll[SAny](empty). The divergence is
    // documented in R3(b); tested via TS-direct call in T11.)
    {
        let input: Expr = Collection::new(SType::SLong, vec![])?.into();
        let x_use: Expr = ValUse {
            val_id: ValId(1),
            tpe: SType::SLong,
        }
        .into();
        let body: Expr = Collection::new(SType::SLong, vec![x_use])?.into();
        let lambda: Expr = FuncValue::new(
            vec![FuncArg {
                idx: ValId(1),
                tpe: SType::SLong,
            }],
            body,
        )
        .into();
        let expr: Expr = MethodCall::new(
            input,
            FLATMAP_METHOD.clone().with_concrete_types(
                &[
                    (STypeVar::iv(), SType::SLong),
                    (STypeVar::ov(), SType::SLong),
                ]
                .iter()
                .cloned()
                .collect(),
            ),
            vec![lambda],
        )?
        .into();
        entries.push(success_entry("flatmap_empty_concrete_body", expr)?);
    }

    // ── 4. flatmap_body_restriction_throw ───────────────────────────────────────
    // Coll[Coll[Long]] flatMap (xs: Coll[Long]) => xs.zip(other_coll)
    //   → throws 'lambda-not-callable' (per the spec's compact-taxonomy
    //   mapping of sigma-rust's `UnexpectedValue("unsupported lambda...")`).
    //
    // The body is `MethodCall(xs, ZIP_METHOD, [other_coll])` — a MethodCall
    // with non-empty args. Construction passes MethodCall::new's type-check
    // (the body's static tpe is SColl(STuple[Long, Long]), still SColl);
    // sigma-rust throws at runtime per scoll.rs:78-84. TS handler throws via
    // the closure.body.tag === 'MethodCall' && closure.body.args.length > 0 check.
    //
    // We DO NOT call try_eval_out — it would return Err (UnexpectedValue).
    {
        let inner1: Expr =
            Collection::new(SType::SLong, vec![Expr::Const(1i64.into())])?.into();
        let input: Expr =
            Collection::new(SType::SColl(Arc::new(SType::SLong)), vec![inner1])?.into();
        let xs_use: Expr = ValUse {
            val_id: ValId(1),
            tpe: SType::SColl(Arc::new(SType::SLong)),
        }
        .into();
        // Body: xs.zip(other_coll) — MethodCall with 1 arg.
        let other_coll: Expr =
            Collection::new(SType::SLong, vec![Expr::Const(99i64.into())])?.into();
        let body: Expr = MethodCall::new(
            xs_use,
            ZIP_METHOD.clone().with_concrete_types(
                &[
                    (STypeVar::t(), SType::SLong),
                    (STypeVar::iv(), SType::SLong),
                ]
                .iter()
                .cloned()
                .collect(),
            ),
            vec![other_coll],
        )?
        .into();
        let lambda: Expr = FuncValue::new(
            vec![FuncArg {
                idx: ValId(1),
                tpe: SType::SColl(Arc::new(SType::SLong)),
            }],
            body,
        )
        .into();
        // FlatMap ov = STuple[Long, Long] (matches body's t_range from zip).
        let expr: Expr = MethodCall::new(
            input,
            FLATMAP_METHOD.clone().with_concrete_types(
                &[
                    (STypeVar::iv(), SType::SColl(Arc::new(SType::SLong))),
                    (
                        STypeVar::ov(),
                        SType::STuple(STuple::pair(SType::SLong, SType::SLong)),
                    ),
                ]
                .iter()
                .cloned()
                .collect(),
            ),
            vec![lambda],
        )?
        .into();
        let (_tree, hex) = build_tree(expr)?;
        entries.push(FlatMapFixture {
            name: "flatmap_body_restriction_throw".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("lambda-not-callable"),
        });
    }

    // ── 5. flatmap_valuse_source_lambda ─────────────────────────────────────────
    // BlockValue {
    //   items: [ValDef(0, FuncValue((xs: Coll[Long]) => xs.indices))],
    //   result: Coll[Coll[Long]] flatMap ValUse(0)
    // }
    //
    // Tests:
    //   - R3(a): when mc.args[0].tag !== 'FuncValue' (it's a ValUse), the TS
    //     elem-type-check is SKIPPED. We document this by having the test
    //     succeed even when types align (we don't actively expose mismatch
    //     here; T11 has a dedicated TS-direct test that exposes the
    //     divergence with deliberate mismatch).
    //   - R3(b): the runtime `closure.body` still resolves correctly through
    //     the ValUse → ValDef → FuncValue chain. Body restriction check still
    //     fires correctly (xs.indices is property-call, OK).
    //
    // sigma-rust evaluates correctly (the runtime Lambda's body field is
    // populated by FuncValue eval). Result equals what flatmap_happy_property_body
    // produces — same input + same lambda logic, different sourcing path.
    {
        let inner1: Expr = Collection::new(SType::SLong, vec![Expr::Const(10i64.into()), Expr::Const(20i64.into())])?.into();
        let inner2: Expr = Collection::new(SType::SLong, vec![Expr::Const(30i64.into())])?.into();
        let input: Expr = Collection::new(
            SType::SColl(Arc::new(SType::SLong)),
            vec![inner1, inner2],
        )?
        .into();
        // ValDef(0): the lambda.
        let xs_use_inside: Expr = ValUse {
            val_id: ValId(1),
            tpe: SType::SColl(Arc::new(SType::SLong)),
        }
        .into();
        let body: Expr = MethodCall::new(
            xs_use_inside,
            INDICES_METHOD
                .clone()
                .with_concrete_types(&[(STypeVar::t(), SType::SLong)].iter().cloned().collect()),
            vec![],
        )?
        .into();
        let lambda: Expr = FuncValue::new(
            vec![FuncArg {
                idx: ValId(1),
                tpe: SType::SColl(Arc::new(SType::SLong)),
            }],
            body,
        )
        .into();
        // ValUse(0): references the lambda; tpe = SFunc([Coll[Long]], SColl(SInt)).
        let valuse_lambda: Expr = ValUse {
            val_id: ValId(0),
            tpe: SType::SFunc(
                ergotree_ir::types::sfunc::SFunc {
                    t_dom: vec![SType::SColl(Arc::new(SType::SLong))],
                    t_range: Box::new(SType::SColl(Arc::new(SType::SInt))),
                    tpe_params: vec![],
                },
            ),
        }
        .into();
        // FlatMap result expression (uses ValUse for the lambda).
        let flat_map: Expr = MethodCall::new(
            input,
            FLATMAP_METHOD.clone().with_concrete_types(
                &[
                    (STypeVar::iv(), SType::SColl(Arc::new(SType::SLong))),
                    (STypeVar::ov(), SType::SInt),
                ]
                .iter()
                .cloned()
                .collect(),
            ),
            vec![valuse_lambda],
        )?
        .into();
        let block: Expr = BlockValue {
            items: vec![ValDef {
                id: ValId(0),
                rhs: Box::new(lambda),
            }
            .into()],
            result: Box::new(flat_map),
        }
        .into();
        entries.push(success_entry("flatmap_valuse_source_lambda", block)?);
    }

    Ok(FlatMapFixtureFile {
        corpus: "eval_scoll_flat_map",
        entries,
    })
}
