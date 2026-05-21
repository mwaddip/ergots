//! SubstConstants arm — substitute constants in a serialized ErgoTree
//! (CONSENSUS-CRITICAL: output bytes go on-chain; byte-equality with sigma-rust
//! is the load-bearing assertion this fixture exists to enforce).
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/subst_const.rs:18-89
//!     let script_bytes_v = self.script_bytes.eval(env, ctx)?;
//!     let positions_v    = self.positions.eval(env, ctx)?;
//!     let new_values_v   = self.new_values.eval(env, ctx)?;
//!     ... extract positions: Vec<usize>, new_constants: Vec<Constant> ...
//!     if new_constants.len() != positions.len() {
//!         return Err(Misc("... positions.len() (== {}) and new_values.len() (== {}) differ"));
//!     }
//!     if let Value::Coll(CollKind::NativeColl(NativeColl::CollByte(b))) = script_bytes_v {
//!         let mut ergo_tree = ErgoTree::sigma_parse_bytes(&b.as_vec_u8())?;
//!         let num_constants = ergo_tree.constants_len()?;
//!         ctx.add_per_item_jit_cost(100, 100, 1, num_constants as u32)?;   // Pattern B
//!         for (ix, i) in positions.iter().enumerate() {
//!             if *i < num_constants { ergo_tree = ergo_tree.with_constant(*i, new_constants[ix].clone())?; }
//!             else                  { return Err(Misc("... out of bound ...")); }
//!         }
//!         Ok(Value::Coll(CollKind::NativeColl(NativeColl::CollByte(
//!             ergo_tree.sigma_serialize_bytes()?.as_vec_i8().into(),
//!         ))))
//!     } else { Err(Misc("expected script_bytes to be Coll[SBytes]")) }
//!
//! CRITICAL — Bug-3 regression: cost is sized by the TEMPLATE'S `constants_len`,
//! NOT positions.len(). See sigma-rust subst_const.rs:221-283 for the
//! regression test (substituting 1 vs 3 positions on a 3-const template yields
//! identical SubstConstants cost). Fixture `subst_cost_uses_template_count`
//! asserts this property end-to-end.
//!
//! Cost-charging order: Pattern B — charged AFTER `parseTree(scriptBytes)`,
//! BEFORE the substitution loop. The order matters because a bad template
//! returns the parse error, not a partial cost charge.
//!
//! Build-time type guards: `SubstConstants::new` (ergotree-ir/src/mir/subst_const.rs:33-50)
//! validates:
//!   - `script_bytes`: `SColl(SByte)`
//!   - `positions`:    `SColl(SInt)`
//!   - `new_values`:   `SColl(_)` (any element type)
//! So malformed-shape MIR cannot be produced through the standard parse path.
//! The TS-side `'subst-constants-error'` defensive shape-guards are covered
//! by inline tests that call `evalExpr` with hand-built MIR nodes.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::subst_const::SubstConstants;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct SubstConstantsFixture {
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
pub struct SubstConstantsFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<SubstConstantsFixture>,
}

/// Build a 1-constant template tree containing a single i32 Const.
/// Returns the SERIALIZED bytes of that template (the wire-format ErgoTree
/// bytes the SubstConstants caller passes in).
fn make_template_1_int(v: i32) -> Vec<u8> {
    let expr = Expr::Const(v.into());
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &expr).unwrap();
    assert_eq!(tree.constants_len().unwrap(), 1);
    tree.sigma_serialize_bytes().unwrap()
}

/// Build a 1-constant template tree containing a single Coll[Byte] Const.
fn make_template_1_bytes(v: Vec<i8>) -> Vec<u8> {
    let expr = Expr::Const(v.into());
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &expr).unwrap();
    assert_eq!(tree.constants_len().unwrap(), 1);
    tree.sigma_serialize_bytes().unwrap()
}

/// Build a 3-constant template tree: `a + b * c` (i32 constants).
/// Mirrors the sigma-rust `test_3_substitutions` builder.
fn make_template_3_int(a: i32, b: i32, c: i32) -> Vec<u8> {
    let expr = Expr::BinOp(
        BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::Const(a.into())),
            right: Box::new(Expr::BinOp(
                BinOp {
                    kind: BinOpKind::Arith(ArithOp::Multiply),
                    left: Box::new(Expr::Const(b.into())),
                    right: Box::new(Expr::Const(c.into())),
                }
                .into(),
            )),
        }
        .into(),
    );
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &expr).unwrap();
    assert_eq!(tree.constants_len().unwrap(), 3);
    tree.sigma_serialize_bytes().unwrap()
}

/// Build a 3-constant template tree with i64 constants: `a + b * c`.
fn make_template_3_long(a: i64, b: i64, c: i64) -> Vec<u8> {
    let expr = Expr::BinOp(
        BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::Const(a.into())),
            right: Box::new(Expr::BinOp(
                BinOp {
                    kind: BinOpKind::Arith(ArithOp::Multiply),
                    left: Box::new(Expr::Const(b.into())),
                    right: Box::new(Expr::Const(c.into())),
                }
                .into(),
            )),
        }
        .into(),
    );
    let tree = ErgoTree::new(ErgoTreeHeader::v0(true), &expr).unwrap();
    assert_eq!(tree.constants_len().unwrap(), 3);
    tree.sigma_serialize_bytes().unwrap()
}

/// Build a SubstConstants tree using the supplied template bytes + positions +
/// new_values. Templates are wrapped as a `Coll[Byte]` Const so they appear as
/// constants in the outer SubstConstants tree.
fn build_subst_tree(
    template_bytes: Vec<u8>,
    positions: Vec<i32>,
    new_values_const: Constant,
) -> anyhow::Result<(ErgoTree, String)> {
    // Wrap template bytes as a Coll[Byte] Const (i8 internally).
    let template_const: Constant = template_bytes
        .into_iter()
        .map(|b| b as i8)
        .collect::<Vec<i8>>()
        .into();
    let script_bytes: Box<Expr> = Box::new(Expr::Const(template_const));
    let positions_expr: Box<Expr> = Box::new(Expr::Const(positions.into()));
    let new_values_expr: Box<Expr> = Box::new(Expr::Const(new_values_const));
    let node = SubstConstants::new(*script_bytes, *positions_expr, *new_values_expr)
        .map_err(|e| anyhow::anyhow!("SubstConstants::new: {:?}", e))?;
    let expr: Expr = Expr::SubstConstants(node.into());
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

fn success_entry(
    name: &str,
    template_bytes: Vec<u8>,
    positions: Vec<i32>,
    new_values: Constant,
) -> anyhow::Result<SubstConstantsFixture> {
    let (tree, hex) = build_subst_tree(template_bytes, positions, new_values)?;
    let ctx = force_any_val::<Context>();
    let val: Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    Ok(SubstConstantsFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: ctx.jit_cost_value(),
        expected_error_code: json!(null),
    })
}

fn error_entry(
    name: &str,
    template_bytes: Vec<u8>,
    positions: Vec<i32>,
    new_values: Constant,
    code: &str,
) -> anyhow::Result<SubstConstantsFixture> {
    let (_tree, hex) = build_subst_tree(template_bytes, positions, new_values)?;
    Ok(SubstConstantsFixture {
        name: name.into(),
        tree_bytes_hex: hex,
        opts_json: json!({}),
        expected_value_json: json!(null),
        expected_cost: 0,
        expected_error_code: json!(code),
    })
}

pub fn generate() -> anyhow::Result<SubstConstantsFixtureFile> {
    let mut entries = Vec::new();

    // Coverage (13 scenarios):
    //
    //   Happy paths (7):
    //     1. subst_single_int_at_0       : 1-const i32 template, position [0].
    //     2. subst_3_int_reorder         : 3-const i32 template, positions [2,0,1].
    //     3. subst_3_int_in_order        : 3-const i32 template, positions [0,1,2].
    //     4. subst_empty_positions       : 3-const i32 template, positions [].
    //                                      Tests that empty-positions still walks
    //                                      the template (cost = 100 + 100*3 = 400
    //                                      SubstConstants component).
    //     5. subst_byte_template         : 1-const Coll[Byte] template.
    //                                      Tests Coll[Byte]-typed substitution.
    //     6. subst_long_template         : 3-const SLong template.
    //                                      Tests non-i32 typed substitution.
    //     7. subst_byte_equality_check   : explicit byte-equality canary —
    //                                      single-position substitution where
    //                                      output bytes are bit-checked against
    //                                      sigma-rust in the TS test.
    //
    //   Bug-3 regression (1):
    //     8. subst_cost_uses_template_count : 3-const template, position [0].
    //                                         Companion to entry 3 (3-const,
    //                                         positions [0,1,2]). When the TS
    //                                         test confirms these two entries
    //                                         have the SAME jit cost (modulo
    //                                         the differing positions/new_values
    //                                         Coll lengths), the bug-3 invariant
    //                                         holds.
    //
    //   Error paths (5):
    //     9.  subst_bad_template       : malformed template bytes (`[0xFF]`).
    //                                    Sigma-rust returns
    //                                    `EvalError::TryExtractFrom`
    //                                    via the `?` after sigma_parse_bytes.
    //    10. subst_position_oob       : 1-const template, position [5].
    //                                    Sigma-rust: "out of bound index".
    //    11. subst_length_mismatch    : positions=[0,1,2], new_values=[1,2].
    //                                    Sigma-rust: "positions.len()/new_values.len() differ".
    //    12. subst_type_mismatch      : i32 template, new_values=Coll[Long].
    //                                    Sigma-rust: with_constant TypeMismatch.
    //    13. subst_negative_position  : 1-const template, position [-1].
    //                                    The cast `i as usize` on negative i32
    //                                    yields a huge usize, so this trips the
    //                                    out-of-bound branch the same way as
    //                                    subst_position_oob — surfaces as the
    //                                    same error code (per sigma-rust
    //                                    subst_const.rs:67).
    //
    // No template_with_0_constants happy fixture: with `segregation=false`,
    // `constants_len()` returns 0 (the template has no constants section), and
    // sigma-rust's empty-positions path succeeds with a single base-cost charge.
    // Covered indirectly by the empty-positions happy fixture; an explicit
    // 0-const-with-empty-positions entry would duplicate signal.

    // 1. Single i32 substitution at position 0.
    entries.push(success_entry(
        "subst_single_int_at_0",
        make_template_1_int(42),
        vec![0],
        Constant::from(vec![999i32]),
    )?);

    // 2. 3-const i32 template, reordered positions [2, 0, 1].
    entries.push(success_entry(
        "subst_3_int_reorder",
        make_template_3_int(1, 2, 3),
        vec![2, 0, 1],
        Constant::from(vec![10i32, 20, 30]),
    )?);

    // 3. 3-const i32 template, in-order positions [0, 1, 2].
    entries.push(success_entry(
        "subst_3_int_in_order",
        make_template_3_int(1, 2, 3),
        vec![0, 1, 2],
        Constant::from(vec![100i32, 200, 300]),
    )?);

    // 4. Empty positions, 3-const i32 template (no-op; cost based on template's
    //    constants_len = 3).
    entries.push(success_entry(
        "subst_empty_positions",
        make_template_3_int(1, 2, 3),
        Vec::<i32>::new(),
        Constant::from(Vec::<i32>::new()),
    )?);

    // 5. Coll[Byte] template — single-byte substitution.
    entries.push(success_entry(
        "subst_byte_template",
        make_template_1_bytes(vec![1i8, 2, 3]),
        vec![0],
        Constant::from(vec![vec![10i8, 20, 30]]),
    )?);

    // 6. 3-const SLong template.
    entries.push(success_entry(
        "subst_long_template",
        make_template_3_long(1, 2, 3),
        vec![0, 1, 2],
        Constant::from(vec![100i64, 200, 300]),
    )?);

    // 7. Byte-equality canary — single-position substitution; TS test extracts
    //    output bytes from expected_value_json and bit-compares against the
    //    handler output. Distinct value range from #1 to avoid masking
    //    coincidence on `42 → 999`.
    entries.push(success_entry(
        "subst_byte_equality_check",
        make_template_1_int(7),
        vec![0],
        Constant::from(vec![123_456_789i32]),
    )?);

    // 8. Bug-3 regression companion: 3-const template, position [0] only.
    //    When paired with #3 (3-const, positions [0,1,2]), both must yield the
    //    same SubstConstants-arm JIT cost contribution (template walk is 3).
    //    Differing inputs/outputs only differ on the Coll-payload Const arms;
    //    the SubstConstants component is invariant by design.
    entries.push(success_entry(
        "subst_cost_uses_template_count",
        make_template_3_int(1, 2, 3),
        vec![0],
        Constant::from(vec![777i32]),
    )?);

    // 9. Bad template bytes — `[0xFF]`. Wrapped through the same `build_subst_tree`
    //    so the OUTER tree parses but the INNER template-bytes fail to parse.
    //    Sigma-rust raises `EvalError::TryExtractFrom` via `?` after
    //    `sigma_parse_bytes`; our compact taxonomy maps it to
    //    `subst-constants-error`.
    entries.push(error_entry(
        "subst_bad_template",
        vec![0xFFu8],
        vec![0],
        Constant::from(vec![1i32]),
        "subst-constants-error",
    )?);

    // 10. Position out-of-bounds.
    entries.push(error_entry(
        "subst_position_oob",
        make_template_1_int(42),
        vec![5],
        Constant::from(vec![1i32]),
        "subst-constants-error",
    )?);

    // 11. positions/new_values length mismatch.
    entries.push(error_entry(
        "subst_length_mismatch",
        make_template_3_int(1, 2, 3),
        vec![0, 1, 2],
        Constant::from(vec![1i32, 2]),
        "subst-constants-error",
    )?);

    // 12. Type mismatch — i32 template, new_values Coll[Long].
    entries.push(error_entry(
        "subst_type_mismatch",
        make_template_1_int(42),
        vec![0],
        Constant::from(vec![999i64]),
        "subst-constants-error",
    )?);

    // 13. Negative position. The cast `i as usize` on negative i32 wraps to a
    //     huge usize value, so the out-of-bound branch trips (sigma-rust
    //     subst_const.rs:67 — same error path as subst_position_oob).
    entries.push(error_entry(
        "subst_negative_position",
        make_template_1_int(42),
        vec![-1],
        Constant::from(vec![1i32]),
        "subst-constants-error",
    )?);

    Ok(SubstConstantsFixtureFile {
        corpus: "eval_subst_constants",
        entries,
    })
}
