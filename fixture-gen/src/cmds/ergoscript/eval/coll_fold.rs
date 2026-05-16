//! Phase 2f Coll HOFs Task 8 — Fold eval fixtures (third lambda HOF).
//!
//! Fold is structurally distinct from Map/Filter: the lambda takes a 2-tuple
//! `(acc, item)` and destructures it via SelectField (1-indexed, 1=acc, 2=item).
//!
//! Cost: Mixed pattern.
//!   - Outer (after all three child evals — input, zero, fold_op — before loop):
//!       `ctx.add_per_item_jit_cost(3, 1, 10, n)` where n = input.len()
//!       NOTE: outer cost is (3, 1, 10), NOT (20, 1, 10) like Map/Filter.
//!   - Per-iter (inside closure, before body eval):
//!       `ctx.add_jit_cost(5)` per element
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/coll_fold.rs:12-71`
//!   line 18: let input_v = self.input.eval(env, ctx)?;
//!   line 19: let zero_v = self.zero.eval(env, ctx)?;
//!   line 20: let fold_op_v = self.fold_op.eval(env, ctx)?;
//!   line 29: ctx.add_jit_cost(5)?;           // per-iter cost inside closure
//!   line 48: ctx.add_per_item_jit_cost(3, 1, 10, n_items)?; // outer cost (base=3!)
//!   line 50-63: iterate input, fold with closure (NativeColl bytes + WrappedColl)
//!
//! Lambda body shape (happy-path): BinOp(Plus, SelectField(1, ValUse(tup_id)),
//!   SelectField(2, ValUse(tup_id))) — SelectField(1) extracts acc, SelectField(2)
//!   extracts item. SelectField is 1-indexed per phase 2f medium.
//!
//! Sigma-rust proptest tree shape: `ergotree-interpreter/src/eval/coll_fold.rs:100-150`
//!   FuncArg { idx: 1, tpe: STuple([zero_tpe, input_elem_tpe]) }
//!   body = BinOp(Plus, SelectField(1, ValUse(1)), SelectField(2, ValUse(1)))
//!
//! Outer cost formula: `add_per_item_jit_cost(base=3, per_chunk=1, chunk_size=10, n)`:
//!   cost = base + per_chunk * ceil(n / chunk_size)
//!   For n=0:   3 + 1 * ceil(0/10)  = 3 + 0 = 3
//!   For n=3:   3 + 1 * ceil(3/10)  = 3 + 1 = 4
//!   For n=4:   3 + 1 * ceil(4/10)  = 3 + 1 = 4
//!   For n=5:   3 + 1 * ceil(5/10)  = 3 + 1 = 4
//!   For n=12:  3 + 1 * ceil(12/10) = 3 + 2 = 5
//!
//! Total arm contribution = outer + sum(per-iter):
//!   n=0:   3 + 5*0   = 3
//!   n=3:   4 + 5*3   = 19
//!   n=4:   4 + 5*4   = 24
//!   n=5:   4 + 5*5   = 29
//!   n=12:  5 + 5*12  = 65
//!
//! FOLD opcode = LAST_CONSTANT_CODE(112) + new_op_code(64) = 176 = 0xB0
//!
//! Fixture entries (9 total):
//!   1. coll_fold_happy_sum          — [1,2,3,4].fold(0)((acc,item) => acc+item) → Int(10)
//!   2. coll_fold_multiply           — [1,2,3].fold(1)((acc,item) => acc*item)   → Int(6)
//!   3. coll_fold_empty              — [].fold(42)(...) → Int(42)  (closure never called)
//!   4. coll_fold_byte_coll          — Coll[Byte] fold (NativeColl path is transparent in TS)
//!   5. coll_fold_sg_n12             — n=12 vs n=5 to observe outer chunked cost difference
//!                                     n=5 outer = 3 + 1*ceil(5/10) = 4
//!                                     n=12 outer = 3 + 1*ceil(12/10) = 5
//!   6. coll_fold_lambda_not_callable     — synthetic
//!   7. coll_fold_lambda_result_type_mismatch — synthetic
//!   8. coll_fold_not_coll                — synthetic
//!   9. coll_fold_cost_limit_exceeded     — synthetic

use core::convert::TryInto;

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::coll_fold::Fold;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::func_value::{FuncArg, FuncValue};
use ergotree_ir::mir::select_field::SelectField;
use ergotree_ir::mir::val_def::ValId;
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stuple::STuple;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct CollFoldFixture {
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
pub struct CollFoldFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<CollFoldFixture>,
}

/// Build a sum-fold expr: `input.fold(zero)((tup: (zero_tpe, elem_tpe)) => tup._1 + tup._2)`
/// Mirrors sigma-rust proptest at coll_fold.rs:100-150.
/// ValId(1) is bound to the 2-tuple argument.
fn build_sum_fold(input: Expr, zero: Expr, zero_tpe: SType, elem_tpe: SType) -> anyhow::Result<Expr> {
    // The tuple argument type: STuple([zero_tpe, elem_tpe])
    // Mirrors coll_fold.rs:110-116: SType::STuple(STuple { items: [SLong, SBox].into() })
    let tup_tpe = SType::STuple(STuple::pair(zero_tpe.clone(), elem_tpe.clone()));
    let tup_use: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: tup_tpe.clone() });

    // body = tup._1 + tup._2
    // SelectField(1, tup_use) extracts acc (first field)
    // SelectField(2, tup_use) extracts item (second field)
    // Mirrors coll_fold.rs:115-126: BinOp(Plus, SelectField(1, ValUse(1)), SelectField(2, ValUse(1)))
    let select_acc: Expr = Expr::SelectField(
        SelectField::new(tup_use.clone(), 1u8.try_into().unwrap())?.into(),
    );
    let select_item: Expr = Expr::SelectField(
        SelectField::new(tup_use.clone(), 2u8.try_into().unwrap())?.into(),
    );
    let body: Expr = BinOp {
        kind: BinOpKind::Arith(ArithOp::Plus),
        left: Box::new(select_acc),
        right: Box::new(select_item),
    }
    .into();

    // FuncArg with idx=1 and type=STuple([zero_tpe, elem_tpe])
    // Mirrors coll_fold.rs:131-139: FuncArg { idx: 1.into(), tpe: SType::STuple(...) }
    let fold_op: Expr = FuncValue::new(
        vec![FuncArg { idx: ValId(1), tpe: tup_tpe }],
        body,
    )
    .into();

    Ok(Fold::new(input, zero, fold_op)?.into())
}

/// Build a multiply-fold expr: `input.fold(zero)((tup: (zero_tpe, elem_tpe)) => tup._1 * tup._2)`
fn build_mul_fold(input: Expr, zero: Expr, zero_tpe: SType, elem_tpe: SType) -> anyhow::Result<Expr> {
    let tup_tpe = SType::STuple(STuple::pair(zero_tpe.clone(), elem_tpe.clone()));
    let tup_use: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: tup_tpe.clone() });

    let select_acc: Expr = Expr::SelectField(
        SelectField::new(tup_use.clone(), 1u8.try_into().unwrap())?.into(),
    );
    let select_item: Expr = Expr::SelectField(
        SelectField::new(tup_use.clone(), 2u8.try_into().unwrap())?.into(),
    );
    let body: Expr = BinOp {
        kind: BinOpKind::Arith(ArithOp::Multiply),
        left: Box::new(select_acc),
        right: Box::new(select_item),
    }
    .into();

    let fold_op: Expr = FuncValue::new(
        vec![FuncArg { idx: ValId(1), tpe: tup_tpe }],
        body,
    )
    .into();

    Ok(Fold::new(input, zero, fold_op)?.into())
}

fn build_tree(expr: Expr) -> anyhow::Result<(ErgoTree, String)> {
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(name: &str, expr: Expr) -> anyhow::Result<CollFoldFixture> {
    let (tree, hex) = build_tree(expr)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(CollFoldFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn cost_limit_entry(name: &str, expr: Expr, limit: u64) -> anyhow::Result<CollFoldFixture> {
    let (_tree, hex) = build_tree(expr)?;
    Ok(CollFoldFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({ "jitCostLimit": limit }),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!("cost-limit-exceeded"),
    })
}

pub fn generate() -> anyhow::Result<CollFoldFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. coll_fold_happy_sum ────────────────────────────────────────────────
    // [1,2,3,4].fold(0)((acc, item) => acc + item) → Int(10)
    // Mirrors sigma-rust proptest at coll_fold.rs:100-150, but with Int not Long.
    // Tree shape: BinOp(Plus, SelectField(1, ValUse(1)), SelectField(2, ValUse(1)))
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32, 4i32].into());
        let zero: Expr = Expr::Const(0i32.into());
        let expr = build_sum_fold(coll, zero, SType::SInt, SType::SInt)?;
        entries.push(success_entry("coll_fold_happy_sum", expr)?);
    }

    // ── 2. coll_fold_multiply ─────────────────────────────────────────────────
    // [1,2,3].fold(1)((acc, item) => acc * item) → Int(6)
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let zero: Expr = Expr::Const(1i32.into());
        let expr = build_mul_fold(coll, zero, SType::SInt, SType::SInt)?;
        entries.push(success_entry("coll_fold_multiply", expr)?);
    }

    // ── 3. coll_fold_empty ────────────────────────────────────────────────────
    // [].fold(42)((acc, item) => acc + item) → Int(42)
    // Closure is never called for empty input — returns zero unchanged.
    {
        let coll: Expr = Expr::Const(Vec::<i32>::new().into());
        let zero: Expr = Expr::Const(42i32.into());
        let expr = build_sum_fold(coll, zero, SType::SInt, SType::SInt)?;
        entries.push(success_entry("coll_fold_empty", expr)?);
    }

    // ── 4. coll_fold_byte_coll ────────────────────────────────────────────────
    // Coll[Byte].fold(0)((acc, item) => acc + item) — tests NativeColl path.
    // Sigma-rust coll_fold.rs:51-55: NativeColl::CollByte dispatches via Tup([acc, Byte(byte)]).
    // In TS, items from byte collections are unpacked as regular SValue::Byte — transparent.
    // Use [10, 20, 5] → fold sum = 0 + 10 + 20 + 5 = 35, result = Int(35).
    // NOTE: Long zero because sigma-rust Fold requires zero.tpe() == fold result tpe.
    //   For a Coll[Byte] + zero of SInt: BinOp(Plus, SByte, SByte) returns SByte... but
    //   in sigma-rust the accumulator type drives the fold. Use SByte zero = 0i8,
    //   sum = (0i8 + 10i8 + 20i8 + 5i8) = 35i8.
    //   Fold::new checks fold_op.tpe().t_dom == [STuple::pair(zero.tpe(), input_elem_tpe)]
    //   so zero must be SByte and elem_tpe = SByte.
    {
        let items: Vec<i8> = vec![10, 20, 5];
        let coll: Expr = Expr::Const(items.into());
        let zero: Expr = Expr::Const(0i8.into());
        let expr = build_sum_fold(coll, zero, SType::SByte, SType::SByte)?;
        entries.push(success_entry("coll_fold_byte_coll", expr)?);
    }

    // ── 5. coll_fold_sg_n12 ──────────────────────────────────────────────────
    // [0..12].fold(0)((acc, item) => acc + item) — n=12, smoking-gun for chunking.
    // n=5 outer = 3 + 1*ceil(5/10) = 4
    // n=12 outer = 3 + 1*ceil(12/10) = 5 — proves outer cost changes at chunk boundary.
    // sum(0..12) = 0+1+2+...+11 = 66
    {
        let items: Vec<i32> = (0i32..12).collect();
        let coll: Expr = Expr::Const(items.into());
        let zero: Expr = Expr::Const(0i32.into());
        let expr = build_sum_fold(coll, zero, SType::SInt, SType::SInt)?;
        entries.push(success_entry("coll_fold_sg_n12", expr)?);
    }

    // ── 6. coll_fold_lambda_not_callable ──────────────────────────────────────
    // Fold(Coll[Int], zero=0, fold_op=Const(true)) → 'lambda-not-callable'
    //
    // Fold::new checks fold_op.tpe() == SFunc — Const(true) has type SBoolean.
    // Bypass via raw bytes (FOLD opcode = 0xB0).
    //
    // Raw layout:
    //   [0x00]  ErgoTreeHeader v0(false)
    //   [0xB0]  FOLD opcode
    //   [coll_bytes]    Const(Coll[Int], [1,2,3])
    //   [zero_bytes]    Const(SInt, 0)
    //   [bool_bytes]    Const(SBoolean, true)
    //
    // TS: extractFuncValue throws 'lambda-not-callable' when fold_op evals to Boolean.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let zero: Expr = Expr::Const(0i32.into());
        let const_foldop: Expr = Expr::Const(true.into());

        let coll_bytes = coll.sigma_serialize_bytes()?;
        let zero_bytes = zero.sigma_serialize_bytes()?;
        let foldop_bytes = const_foldop.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8); // ErgoTreeHeader v0(false)
        tree_bytes.push(0xB0u8); // FOLD opcode = 112 + 64 = 176 = 0xB0
        tree_bytes.extend_from_slice(&coll_bytes);
        tree_bytes.extend_from_slice(&zero_bytes);
        tree_bytes.extend_from_slice(&foldop_bytes);

        entries.push(CollFoldFixture {
            name: "coll_fold_lambda_not_callable".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("lambda-not-callable"),
        });
    }

    // ── 7. coll_fold_lambda_result_type_mismatch ──────────────────────────────
    // Fold([1,2], zero=0, fold_op=(tup) => if (tup._1 == 0) { 0 } else { true })
    // → 'lambda-result-type-mismatch'
    //
    // Body: if (tup._1 == 0) { 0i32 } else { true }
    // On iteration 1: acc=0, item=1, tup._1=0 → returns Int(0). OK, acc stays Int.
    // On iteration 2: acc=0, item=2, tup._1=0 → still returns Int(0). Hmm.
    //
    // Better: zero=0, fold: if (SelectField(1, tup) == 1) { 1i32 } else { true }
    // Item 1: acc=0, tup._1=0, 0==1 is false → returns Boolean(true) → mismatch (expected Int from zero).
    //
    // Actually: TS checks that acc type stays consistent across iterations.
    // First iter: acc = zero = Int(0), body = if (tup._1 == 0) { 0 } else { true }
    //   tup._1 = acc = 0 → returns Int(0) → matches zero type. acc = 0.
    // Need to trigger mismatch on second iter (or first): use constant body returning Boolean.
    //
    // Cleanest: fold_op body = Const(true) but forced through If to fool static type check.
    //   Body = if (tup._1 == 0) { true } else { false }  — type SBoolean, but zero is SInt.
    //   Fold::new requires fold_op.tpe().t_dom[0] == STuple(SInt, SInt).
    //   FuncValue::new(..., body).tpe() = SFunc { t_dom: [STuple(SInt,SInt)], t_range: body.tpe() }.
    //   If body.tpe() = SBoolean then t_range = SBoolean ≠ SInt → Fold::new fails.
    //
    // Use raw bytes to bypass Fold::new validation:
    //   Build FuncValue with body returning SBoolean (Const(true)), arg type = STuple(SInt, SInt).
    //   Fold::new would reject this because fold_op t_range ≠ zero.tpe() = SInt.
    //   But we can build the tree directly.
    //
    // Raw layout (FOLD opcode = 0xB0):
    //   [0x00]  header
    //   [0xB0]  FOLD opcode
    //   [coll_bytes]     Const(Coll[Int], [1,2])
    //   [zero_bytes]     Const(SInt, 0)
    //   [foldop_bytes]   FuncValue((tup: STuple(SInt,SInt)) => true)
    //
    // TS: on first iteration, evalFold evals body → Boolean(true). Checks new acc kind
    //   against original zero kind (Int). Boolean ≠ Int → 'lambda-result-type-mismatch'.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32].into());
        let zero: Expr = Expr::Const(0i32.into());
        // FuncValue body returns Boolean, but arg type says STuple(SInt, SInt)
        let tup_tpe = SType::STuple(STuple::pair(SType::SInt, SType::SInt));
        let fold_op: Expr = FuncValue::new(
            vec![FuncArg { idx: ValId(1), tpe: tup_tpe }],
            Expr::Const(true.into()),
        )
        .into();

        let coll_bytes = coll.sigma_serialize_bytes()?;
        let zero_bytes = zero.sigma_serialize_bytes()?;
        let foldop_bytes = fold_op.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8);
        tree_bytes.push(0xB0u8); // FOLD opcode
        tree_bytes.extend_from_slice(&coll_bytes);
        tree_bytes.extend_from_slice(&zero_bytes);
        tree_bytes.extend_from_slice(&foldop_bytes);

        entries.push(CollFoldFixture {
            name: "coll_fold_lambda_result_type_mismatch".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("lambda-result-type-mismatch"),
        });
    }

    // ── 8. coll_fold_not_coll ─────────────────────────────────────────────────
    // Fold(Const(SInt, 42), zero=0, fold_op=...) → 'coll-input-not-coll'
    //
    // Fold::new validates input is SColl — bypass via raw bytes (FOLD opcode = 0xB0).
    //
    // Raw layout:
    //   [0x00]  header
    //   [0xB0]  FOLD opcode
    //   [int_const_bytes]   Const(SInt, 42)  ← not a Coll!
    //   [zero_bytes]        Const(SInt, 0)
    //   [foldop_bytes]      FuncValue((tup: STuple(SInt,SInt)) => tup._1 + tup._2)
    {
        let int_const: Expr = Expr::Const(42i32.into());
        let zero: Expr = Expr::Const(0i32.into());
        let tup_tpe = SType::STuple(STuple::pair(SType::SInt, SType::SInt));
        let tup_use: Expr = Expr::ValUse(ValUse { val_id: ValId(1), tpe: tup_tpe.clone() });
        let select_acc: Expr = Expr::SelectField(
            SelectField::new(tup_use.clone(), 1u8.try_into().unwrap())?.into(),
        );
        let select_item: Expr = Expr::SelectField(
            SelectField::new(tup_use.clone(), 2u8.try_into().unwrap())?.into(),
        );
        let body: Expr = BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(select_acc),
            right: Box::new(select_item),
        }
        .into();
        let fold_op: Expr = FuncValue::new(
            vec![FuncArg { idx: ValId(1), tpe: tup_tpe }],
            body,
        )
        .into();

        let int_bytes = int_const.sigma_serialize_bytes()?;
        let zero_bytes = zero.sigma_serialize_bytes()?;
        let foldop_bytes = fold_op.sigma_serialize_bytes()?;

        let mut tree_bytes = Vec::new();
        tree_bytes.push(0x00u8);
        tree_bytes.push(0xB0u8); // FOLD opcode
        tree_bytes.extend_from_slice(&int_bytes);
        tree_bytes.extend_from_slice(&zero_bytes);
        tree_bytes.extend_from_slice(&foldop_bytes);

        entries.push(CollFoldFixture {
            name: "coll_fold_not_coll".into(),
            tree_bytes_hex: hex::encode(&tree_bytes),
            opts_json: json!({}),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("coll-input-not-coll"),
        });
    }

    // ── 9. coll_fold_cost_limit_exceeded ──────────────────────────────────────
    // jitCostLimit too low → cost-limit-exceeded before eval completes.
    // Limit = 1 guarantees the very first cost charge overflows.
    {
        let coll: Expr = Expr::Const(vec![1i32, 2i32, 3i32].into());
        let zero: Expr = Expr::Const(0i32.into());
        let expr = build_sum_fold(coll, zero, SType::SInt, SType::SInt)?;
        entries.push(cost_limit_entry("coll_fold_cost_limit_exceeded", expr, 1)?);
    }

    Ok(CollFoldFixtureFile {
        corpus: "eval_coll_fold",
        entries,
    })
}
