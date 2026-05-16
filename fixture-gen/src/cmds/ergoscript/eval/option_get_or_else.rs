//! Phase 2f medium Stop β Task 5 — OptionGetOrElse eval fixtures.
//!
//! Cost: Fixed(20), Pattern A (cost BEFORE input eval).
//! Sigma-rust ref: `ergotree-interpreter/src/eval/option_get_or_else.rs:10-29`
//!   ctx.add_jit_cost(20)?;                          // BEFORE input eval
//!   let v = self.input.eval(env, ctx)?;
//!   let mut default_v = || self.default.eval(env, ctx);
//!   match v {
//!     Value::Opt(opt_v) if ctx.tree_version() >= V3 => {
//!       opt_v.as_deref().cloned().map(Ok).unwrap_or_else(default_v)  // LAZY
//!     }
//!     Value::Opt(opt_v) => {
//!       Ok(opt_v.as_deref().cloned().unwrap_or(default_v()?))         // EAGER
//!     }
//!     _ => Err(EvalError::UnexpectedExpr(...))
//!   }
//!
//! V3-gated lazy semantics:
//!   V<3: eager — default ALWAYS evaluated (cost always charged)
//!   V3+: lazy — default only evaluated when input is None
//!
//! Same VALUE at all versions; COST differs on Some-input with non-trivial default.
//!
//! Type constraint: OptionGetOrElse::new(input, default) requires:
//!   input.post_eval_tpe() == SOption(T), and default.post_eval_tpe() == T.
//!   GetVar(id, SLong) has tpe() = SOption(SLong), so default must produce SLong directly.
//!   BinOp(Plus, Const(SLong,1), Const(SLong,0)) provides a multi-node default with
//!   additional cost (BinOp + 2×Const) to prove the V3 lazy gate via cost difference.
//!
//! Fixture entries (7 total):
//!   1. option_get_or_else_some_v0_eager — GetVar(3,SLong) at V0, default=BinOp(Plus, 1L, 0L)
//!      Input is Some(Long(42)). EAGER: default BinOp evaluated.
//!      Returns Long(42). Cost = 20 (OGOE) + 10 (GetVar/input) + ArithBinOp_cost = some N.
//!   2. option_get_or_else_some_v3_lazy — same tree at V3; LAZY: default NOT evaluated.
//!      Returns Long(42). Cost = 20 (OGOE) + 10 (GetVar/input) = 30.
//!      *** SMOKING GUN: cost is lower at V3 (default not charged). ***
//!   3. option_get_or_else_none_v0 — GetVar(99,SLong) at V0 (absent = None), default=Const(SLong,99).
//!      Returns Long(99). EAGER: Const(99) evaluated.
//!   4. option_get_or_else_none_v3 — same at V3; None triggers default even lazily.
//!      Returns Long(99). Same cost as V0 (default required).
//!   5. option_get_or_else_some_v2_eager — GetVar(3,SLong) at V2, default=BinOp(Plus,1L,0L).
//!      V2 < V3 → eager. Same cost as V0.
//!   6a. option_get_or_else_register_some_v2_eager — ExtractRegisterAs default=Const(SLong,0) at V2.
//!      V2 eager: Const(0) evaluated. Returns Long(MIN_RAW). Cost includes Const(5).
//!   6b. option_get_or_else_register_some_v3_lazy — Same tree at V3.
//!      V3 lazy: Const(0) NOT evaluated. Cost excludes Const(5). *** SECOND SMOKING GUN ***
//!   7. option_get_or_else_cost_limit — jitCostLimit=10 < Fixed(20) → 'cost-limit-exceeded'.

use core::cell::Cell;

use ergo_chain_types::{BlockId, Digest32, EcPoint, PreHeader, Votes};
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::{Context, ContextExtensionProvider};
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::bin_op::{ArithOp, BinOp, BinOpKind};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_reg_as::ExtractRegisterAs;
use ergotree_ir::mir::get_var::GetVar;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::option_get_or_else::OptionGetOrElse;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;
use sigma_test_util::force_any_val;

use super::common::{ergo_box_to_json, stype_to_json, value_to_json};

/// A minimal ContextExtensionProvider for the controlled Context.
struct SimpleExtProvider(ContextExtension);

impl ContextExtensionProvider for SimpleExtProvider {
    fn context_extension(&self, _input_index: usize) -> Option<&ContextExtension> {
        Some(&self.0)
    }
}

#[derive(Serialize)]
pub struct OptionGetOrElseFixture {
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
pub struct OptionGetOrElseFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<OptionGetOrElseFixture>,
}

/// Build a minimal ErgoTree (v1, hasSize=true, body = Const(SBoolean true)).
/// v1 required: TS SBox parser demands hasSize=true for bounded reads.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a 32-byte all-zero TxId.
fn zero_tx_id() -> TxId {
    TxId::zero()
}

/// Construct a minimal ErgoBox.
fn simple_box(nanoerg: u64) -> ErgoBox {
    let value = BoxValue::new(nanoerg).expect("BoxValue");
    let candidate = ErgoBoxCandidate {
        value,
        ergo_tree: minimal_ergo_tree(),
        tokens: None,
        additional_registers: NonMandatoryRegisters::empty(),
        creation_height: 0,
    };
    ErgoBox::from_box_candidate(&candidate, zero_tx_id(), 0).expect("ErgoBox")
}

/// Build a controlled Context with a specific ContextExtension and tree version.
///
/// Uses hardcoded deterministic values for all fields. Mirrors option_get.rs pattern.
fn controlled_context_with_extension_and_version(
    extension: ContextExtension,
    version: u8,
) -> Context<'static> {
    let gen_bytes = hex::decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    )
    .expect("decode gen bytes");
    let miner_pk: EcPoint = EcPoint::scorex_parse_bytes(&gen_bytes).expect("parse gen point");

    let base_ctx = force_any_val::<Context<'static>>();
    let pre_header = PreHeader {
        version: 1,
        parent_id: BlockId(Digest32::zero()),
        timestamp: 1_700_000_000_000u64,
        n_bits: 0x1d00ffff,
        height: 999_999,
        miner_pk: Box::new(miner_pk),
        votes: Votes([0, 0, 0]),
    };

    let self_box: &'static ErgoBox =
        Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
    let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
    let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));

    let ext: &'static ContextExtension = Box::leak(Box::new(extension.clone()));
    let ext_provider: &'static SimpleExtProvider =
        Box::leak(Box::new(SimpleExtProvider(extension)));

    Context {
        height: 999_999,
        self_box,
        outputs: std::slice::from_ref(out_box),
        data_inputs: None,
        inputs: vec![in_box].try_into().expect("inputs TxIoVec"),
        pre_header,
        headers: base_ctx.headers,
        extension: ext,
        tree_version: Cell::new(ErgoTreeVersion::from(version)),
        extension_provider: ext_provider,
        jit_cost: Cell::new(0),
        jit_cost_limit: None,
        constants: None,
    }
}

/// Serialize a ContextExtension to the opts_json "extension" field.
///
/// Schema mirrors the TS `ContextExtension` interface:
///   `{ "values": { "<varId>": { "tpe": SType, "value": SValue } } }`
fn context_extension_to_json(ext: &ContextExtension) -> JsonValue {
    let values: serde_json::Map<String, JsonValue> = ext
        .values
        .iter()
        .map(|(k, c)| {
            let entry = json!({
                "tpe": stype_to_json(&c.tpe),
                "value": value_to_json(&ergotree_ir::mir::value::Value::from(c.v.clone())),
            });
            (k.to_string(), entry)
        })
        .collect();
    json!({ "values": values })
}

/// Build `BinOp(Plus, Const(SLong, a), Const(SLong, b))` — a two-node SLong expression.
/// Used as the default to provide observable cost: BinOp + 2×Const.
fn long_plus_expr(a: i64, b: i64) -> Expr {
    Expr::BinOp(
        BinOp {
            kind: BinOpKind::Arith(ArithOp::Plus),
            left: Box::new(Expr::Const(Constant::from(a))),
            right: Box::new(Expr::Const(Constant::from(b))),
        }
        .into(),
    )
}

pub fn generate() -> anyhow::Result<OptionGetOrElseFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. option_get_or_else_some_v0_eager ──────────────────────────────────
    // OptionGetOrElse(GetVar(3,SLong), BinOp(Plus, 1L, 0L)) at V0.
    // ext[3]=42L. Input GetVar(3) returns Some(Long(42)).
    // EAGER V0: default BinOp ALWAYS evaluated even though input is Some.
    // Returns Long(42). Cost = 20 (OGOE) + 10 (GetVar/input) + BinOp-cost.
    {
        let input_expr: Expr = GetVar {
            var_id: 3,
            var_tpe: SType::SLong,
        }
        .into();
        // BinOp(Plus, Const(1L), Const(0L)) — type SLong. Cost = BinOp(10) + Const(5) + Const(5) = 20.
        let default_expr = long_plus_expr(1, 0);
        let ogoe = OptionGetOrElse::new(input_expr, default_expr)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new: {:?}", e))?;
        let outer_expr: Expr = ogoe.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let mut ext = ContextExtension::empty();
        ext.values.insert(3, Constant::from(42i64));
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension_and_version(ext, 0);

        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Long(42)),
            "expected Long(42) at V0 eager, got {:?}",
            val
        );
        let cost_v0 = ctx.jit_cost_value();
        // V0 eager: OGOE(20) + GetVar(10) + BinOp(10) + Const(5) + Const(5) = 50.
        assert!(cost_v0 > 30, "V0 eager cost should include default, got {}", cost_v0);

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_some_v0_eager".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json, "treeVersion": 0 }),
            expected_value_json: json!({ "kind": "Long", "value": "42" }),
            expected_cost: cost_v0,
            expected_error_code: json!(null),
        });

        // ── 2. option_get_or_else_some_v3_lazy — SMOKING GUN ─────────────────
        // Same tree at V3: LAZY — default BinOp NOT evaluated.
        // Returns Long(42). Cost = 20 (OGOE) + 10 (GetVar/input) = 30.
        // *** cost_v3 (30) < cost_v0 — proves the V3 lazy gate. ***
        let mut ext2 = ContextExtension::empty();
        ext2.values.insert(3, Constant::from(42i64));
        let ext2_json = context_extension_to_json(&ext2);
        let ctx2 = controlled_context_with_extension_and_version(ext2, 3);

        let input_expr2: Expr = GetVar {
            var_id: 3,
            var_tpe: SType::SLong,
        }
        .into();
        let default_expr2 = long_plus_expr(1, 0);
        let ogoe2 = OptionGetOrElse::new(input_expr2, default_expr2)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new (v3): {:?}", e))?;
        let outer2: Expr = ogoe2.into();
        let tree2 = ErgoTree::new(ErgoTreeHeader::v0(false), &outer2)?;
        let hex2 = hex::encode(tree2.sigma_serialize_bytes()?);

        let val2 = try_eval_out::<ergotree_ir::mir::value::Value>(&tree2.proposition()?, &ctx2)?;
        assert!(
            matches!(val2, ergotree_ir::mir::value::Value::Long(42)),
            "expected Long(42) at V3 lazy, got {:?}",
            val2
        );
        let cost_v3 = ctx2.jit_cost_value();
        assert_eq!(cost_v3, 30, "V3 lazy cost should be 30, got {}", cost_v3);
        assert!(
            cost_v3 < cost_v0,
            "SMOKING GUN: V3 lazy cost ({}) must be < V0 eager cost ({})",
            cost_v3,
            cost_v0
        );

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_some_v3_lazy".into(),
            tree_bytes_hex: hex2,
            opts_json: json!({ "extension": ext2_json, "treeVersion": 3 }),
            expected_value_json: json!({ "kind": "Long", "value": "42" }),
            expected_cost: cost_v3,
            expected_error_code: json!(null),
        });
    }

    // ── 3. option_get_or_else_none_v0 ────────────────────────────────────────
    // OptionGetOrElse(GetVar(99,SLong), Const(SLong,99)) at V0.
    // ext doesn't have varId=99 → GetVar returns None.
    // EAGER: default Const(99) evaluated. Returns Long(99).
    // Cost = 20 (OGOE) + 10 (GetVar/input) + 5 (Const/default) = 35.
    {
        let input_expr: Expr = GetVar {
            var_id: 99,
            var_tpe: SType::SLong,
        }
        .into();
        let default_expr: Expr = Expr::Const(Constant::from(99i64));
        let ogoe = OptionGetOrElse::new(input_expr, default_expr)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new none_v0: {:?}", e))?;
        let outer_expr: Expr = ogoe.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        // Only var 3 in extension — varId 99 absent → GetVar returns None.
        let mut ext = ContextExtension::empty();
        ext.values.insert(3, Constant::from(42i64));
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension_and_version(ext, 0);

        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Long(99)),
            "expected Long(99) for None V0, got {:?}",
            val
        );
        let cost = ctx.jit_cost_value();
        assert_eq!(cost, 35, "None V0 cost should be 35, got {}", cost);

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_none_v0".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json, "treeVersion": 0 }),
            expected_value_json: json!({ "kind": "Long", "value": "99" }),
            expected_cost: cost,
            expected_error_code: json!(null),
        });
    }

    // ── 4. option_get_or_else_none_v3 ────────────────────────────────────────
    // OptionGetOrElse(GetVar(99,SLong), Const(SLong,99)) at V3.
    // None → lazy still evaluates default (lazy only skips on Some).
    // Returns Long(99). Cost = 35 (same as V0 on None).
    {
        let input_expr: Expr = GetVar {
            var_id: 99,
            var_tpe: SType::SLong,
        }
        .into();
        let default_expr: Expr = Expr::Const(Constant::from(99i64));
        let ogoe = OptionGetOrElse::new(input_expr, default_expr)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new none_v3: {:?}", e))?;
        let outer_expr: Expr = ogoe.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let mut ext = ContextExtension::empty();
        ext.values.insert(3, Constant::from(42i64));
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension_and_version(ext, 3);

        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Long(99)),
            "expected Long(99) for None V3, got {:?}",
            val
        );
        let cost = ctx.jit_cost_value();
        assert_eq!(cost, 35, "None V3 cost should be 35, got {}", cost);

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_none_v3".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json, "treeVersion": 3 }),
            expected_value_json: json!({ "kind": "Long", "value": "99" }),
            expected_cost: cost,
            expected_error_code: json!(null),
        });
    }

    // ── 5. option_get_or_else_some_v2_eager ──────────────────────────────────
    // Same GetVar(3,SLong) / BinOp(Plus,1L,0L) tree at V2.
    // V2 < V3 → eager (same as V0). Returns Long(42). Cost = cost_v0.
    {
        let input_expr: Expr = GetVar {
            var_id: 3,
            var_tpe: SType::SLong,
        }
        .into();
        let default_expr = long_plus_expr(1, 0);
        let ogoe = OptionGetOrElse::new(input_expr, default_expr)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new v2: {:?}", e))?;
        let outer_expr: Expr = ogoe.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let mut ext = ContextExtension::empty();
        ext.values.insert(3, Constant::from(42i64));
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension_and_version(ext, 2);

        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Long(42)),
            "expected Long(42) at V2, got {:?}",
            val
        );
        let cost = ctx.jit_cost_value();
        // V2 is eager: OGOE + GetVar + BinOp + 2×Const = same as V0.
        assert!(cost > 30, "V2 eager cost should include default, got {}", cost);

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_some_v2_eager".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json, "treeVersion": 2 }),
            expected_value_json: json!({ "kind": "Long", "value": "42" }),
            expected_cost: cost,
            expected_error_code: json!(null),
        });
    }

    // ── 6a. option_get_or_else_register_some_v2_eager ────────────────────────
    // OptionGetOrElse(ExtractRegisterAs(SelfBox,0,SOption(SLong)), Const(SLong,0)) at V2.
    // SelfBox.R0 = box.value = BoxValue::MIN_RAW. ExtractRegisterAs returns Some(Long(MIN_RAW)).
    // EAGER V2: default Const(0) evaluated even though input is Some.
    // Returns Long(MIN_RAW). Cost = 20 (OGOE) + 50 (ERA) + 10 (GlobalVars/SelfBox) + 5 (Const) = 85.
    {
        let self_box_expr: Expr = GlobalVars::SelfBox.into();
        let extract_reg_expr: Expr = ExtractRegisterAs::new(
            self_box_expr,
            0, // R0 = box.value (SLong)
            SType::SOption(SType::SLong.into()),
        )
        .map_err(|e| anyhow::anyhow!("ExtractRegisterAs::new: {:?}", e))?
        .into();
        let default_expr: Expr = Expr::Const(Constant::from(0i64));
        let ogoe = OptionGetOrElse::new(extract_reg_expr, default_expr)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new register_v2: {:?}", e))?;
        let outer_expr: Expr = ogoe.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let self_box_val = simple_box(BoxValue::MIN_RAW);
        let self_box_json = ergo_box_to_json(&self_box_val);
        let ext = ContextExtension::empty();
        let ctx = controlled_context_with_extension_and_version(ext, 2);

        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        let expected_long = BoxValue::MIN_RAW as i64;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Long(n) if n == expected_long),
            "expected Long({}) at V2, got {:?}",
            expected_long,
            val
        );
        let cost_v2 = ctx.jit_cost_value();
        // V2 eager: OGOE(20) + ERA(50) + SelfBox(10) + Const(5) = 85.
        assert_eq!(cost_v2, 85, "V2 register Some eager cost should be 85, got {}", cost_v2);

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_register_some_v2_eager".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "selfBox": self_box_json, "treeVersion": 2 }),
            expected_value_json: json!({ "kind": "Long", "value": expected_long.to_string() }),
            expected_cost: cost_v2,
            expected_error_code: json!(null),
        });

        // ── 6b. option_get_or_else_register_some_v3_lazy — SECOND SMOKING GUN ──
        // Same tree at V3: LAZY — Const(0) NOT evaluated.
        // Returns Long(MIN_RAW). Cost = 20 + 50 + 10 = 80. (5 LESS than V2).
        let ext2 = ContextExtension::empty();
        let ctx2 = controlled_context_with_extension_and_version(ext2, 3);

        let self_box_expr2: Expr = GlobalVars::SelfBox.into();
        let extract_reg_expr2: Expr = ExtractRegisterAs::new(
            self_box_expr2,
            0,
            SType::SOption(SType::SLong.into()),
        )
        .map_err(|e| anyhow::anyhow!("ExtractRegisterAs::new (v3): {:?}", e))?
        .into();
        let default_expr2: Expr = Expr::Const(Constant::from(0i64));
        let ogoe2 = OptionGetOrElse::new(extract_reg_expr2, default_expr2)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new register_v3: {:?}", e))?;
        let outer2: Expr = ogoe2.into();
        let tree2 = ErgoTree::new(ErgoTreeHeader::v0(false), &outer2)?;
        let hex2 = hex::encode(tree2.sigma_serialize_bytes()?);
        let self_box_json2 = ergo_box_to_json(&simple_box(BoxValue::MIN_RAW));

        let val2 = try_eval_out::<ergotree_ir::mir::value::Value>(&tree2.proposition()?, &ctx2)?;
        assert!(
            matches!(val2, ergotree_ir::mir::value::Value::Long(n) if n == expected_long),
            "expected Long({}) at V3, got {:?}",
            expected_long,
            val2
        );
        let cost_v3 = ctx2.jit_cost_value();
        // V3 lazy: OGOE(20) + ERA(50) + SelfBox(10) = 80 (Const NOT charged).
        assert_eq!(cost_v3, 80, "V3 register Some lazy cost should be 80, got {}", cost_v3);
        assert!(
            cost_v3 < cost_v2,
            "SECOND SMOKING GUN: V3 lazy ({}) < V2 eager ({}) for same Some-input",
            cost_v3,
            cost_v2
        );

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_register_some_v3_lazy".into(),
            tree_bytes_hex: hex2,
            opts_json: json!({ "selfBox": self_box_json2, "treeVersion": 3 }),
            expected_value_json: json!({ "kind": "Long", "value": expected_long.to_string() }),
            expected_cost: cost_v3,
            expected_error_code: json!(null),
        });
    }

    // ── 7. option_get_or_else_cost_limit ─────────────────────────────────────
    // jitCostLimit=10 < Fixed(20) → 'cost-limit-exceeded'.
    // OGOE charges 20 first (Pattern A); cost-limit fires before child eval.
    {
        let input_expr: Expr = GetVar {
            var_id: 3,
            var_tpe: SType::SLong,
        }
        .into();
        let default_expr: Expr = Expr::Const(Constant::from(99i64));
        let ogoe = OptionGetOrElse::new(input_expr, default_expr)
            .map_err(|e| anyhow::anyhow!("OptionGetOrElse::new cost_limit: {:?}", e))?;
        let outer_expr: Expr = ogoe.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let mut ext = ContextExtension::empty();
        ext.values.insert(3, Constant::from(42i64));
        let ext_json = context_extension_to_json(&ext);

        entries.push(OptionGetOrElseFixture {
            name: "option_get_or_else_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json, "jitCostLimit": 10, "treeVersion": 0 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    Ok(OptionGetOrElseFixtureFile {
        corpus: "eval_option_get_or_else",
        entries,
    })
}
