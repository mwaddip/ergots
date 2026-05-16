//! Phase 2f medium Stop β Task 4 — OptionIsDefined eval fixtures.
//!
//! Cost: Fixed(10). Pattern A (cost BEFORE eval-child).
//! Sigma-rust ref: `ergotree-interpreter/src/eval/option_is_defined.rs:9-24`
//!   ctx.add_jit_cost(10)?;
//!   let v = self.input.eval(env, ctx)?;
//!   match v {
//!     Value::Opt(opt_v) => Ok(opt_v.is_some().into()),
//!     _ => Err(EvalError::UnexpectedExpr(...)),
//!   }
//!
//! Fixture entries (4 total):
//!   1. option_is_defined_some_via_getvar  — OptionIsDefined(GetVar(3, SInt)) ext[3]=42
//!      → Boolean(true), cost = 10 (OID) + 10 (GetVar) = 20
//!   2. option_is_defined_some_via_register — OptionIsDefined(ExtractRegisterAs(SelfBox, 0, SOption(SLong)))
//!      → Boolean(true), cost = 10 (OID) + 50 (ERA) + 10 (GlobalVars) = 70
//!   3. option_is_defined_none — OptionIsDefined(GetVar(99, SInt)) ext without varId=99
//!      → Boolean(false), cost = 10 (OID) + 10 (GetVar) = 20
//!   4. option_is_defined_cost_limit — jitCostLimit=8 < Fixed(10) → 'cost-limit-exceeded'

use core::cell::Cell;

use ergo_chain_types::{BlockId, Digest32, EcPoint, PreHeader, Votes};
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::{Context, ContextExtensionProvider};
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_reg_as::ExtractRegisterAs;
use ergotree_ir::mir::get_var::GetVar;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::option_is_defined::OptionIsDefined;
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
pub struct OptionIsDefinedFixture {
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
pub struct OptionIsDefinedFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<OptionIsDefinedFixture>,
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

/// Build a controlled Context with a specific ContextExtension.
///
/// Uses hardcoded deterministic values for all fields (identical to the
/// GlobalVars Task 1, GetVar Task 2, OptionGet Task 3 pattern).
fn controlled_context_with_extension(extension: ContextExtension) -> Context<'static> {
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
        tree_version: Cell::new(ErgoTreeVersion::V0),
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

pub fn generate() -> anyhow::Result<OptionIsDefinedFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. option_is_defined_some_via_getvar ──────────────────────────────────
    // OptionIsDefined(GetVar(varId=3, varTpe=SInt)) with ext[3]=Constant(SInt, 42).
    // GetVar returns Some(Int(42)); OptionIsDefined returns Boolean(true).
    // Cost: 10 (OptionIsDefined) + 10 (GetVar) = 20.
    {
        let get_var = GetVar {
            var_id: 3,
            var_tpe: SType::SInt,
        };
        let get_var_expr: Expr = get_var.into();
        let option_is_defined = OptionIsDefined {
            input: Box::new(get_var_expr),
        };
        let outer_expr: Expr = option_is_defined.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let mut ext = ContextExtension::empty();
        let constant: Constant = 42i32.into();
        ext.values.insert(3, constant);
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension(ext);

        // Oracle: OptionIsDefined on Some(Int(42)) → Boolean(true).
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Boolean(true)),
            "expected Boolean(true), got {:?}",
            val
        );

        entries.push(OptionIsDefinedFixture {
            name: "option_is_defined_some_via_getvar".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: json!({ "kind": "Boolean", "value": true }),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. option_is_defined_some_via_register ────────────────────────────────
    // OptionIsDefined(ExtractRegisterAs(SelfBox, 0, SOption(SLong))).
    // SelfBox.R0 = box.value (SLong); ExtractRegisterAs returns Some(Long(value));
    // OptionIsDefined returns Boolean(true).
    // Cost: 10 (OptionIsDefined) + 50 (ExtractRegisterAs) + 10 (GlobalVars/SelfBox) = 70.
    {
        let self_box_expr: Expr = GlobalVars::SelfBox.into();
        let extract_reg_expr: Expr = ExtractRegisterAs::new(
            self_box_expr,
            0, // R0 = value (SLong)
            SType::SOption(SType::SLong.into()),
        )
        .map_err(|e| anyhow::anyhow!("ExtractRegisterAs::new: {:?}", e))?
        .into();
        let option_is_defined = OptionIsDefined {
            input: Box::new(extract_reg_expr),
        };
        let outer_expr: Expr = option_is_defined.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let self_box_val = simple_box(BoxValue::MIN_RAW);
        let self_box_json = ergo_box_to_json(&self_box_val);
        let ext = ContextExtension::empty();
        let ctx = controlled_context_with_extension(ext);

        // Oracle: OptionIsDefined on Some(Long(10800)) → Boolean(true).
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Boolean(true)),
            "expected Boolean(true) from register, got {:?}",
            val
        );

        entries.push(OptionIsDefinedFixture {
            name: "option_is_defined_some_via_register".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "selfBox": self_box_json }),
            expected_value_json: json!({ "kind": "Boolean", "value": true }),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 3. option_is_defined_none ─────────────────────────────────────────────
    // OptionIsDefined(GetVar(varId=99, varTpe=SInt)) where ext doesn't have varId=99.
    // GetVar returns None; OptionIsDefined returns Boolean(false).
    // Cost: 10 (OptionIsDefined) + 10 (GetVar) = 20.
    {
        let get_var = GetVar {
            var_id: 99,
            var_tpe: SType::SInt,
        };
        let get_var_expr: Expr = get_var.into();
        let option_is_defined = OptionIsDefined {
            input: Box::new(get_var_expr),
        };
        let outer_expr: Expr = option_is_defined.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        // Extension has varId=3 but not 99 → GetVar returns None → OptionIsDefined → false.
        let mut ext = ContextExtension::empty();
        let constant: Constant = 42i32.into();
        ext.values.insert(3, constant);
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension(ext);

        // Oracle: OptionIsDefined on None → Boolean(false).
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Boolean(false)),
            "expected Boolean(false) for None, got {:?}",
            val
        );

        entries.push(OptionIsDefinedFixture {
            name: "option_is_defined_none".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: json!({ "kind": "Boolean", "value": false }),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. option_is_defined_cost_limit ──────────────────────────────────────
    // jitCostLimit=8 < Fixed(10) → 'cost-limit-exceeded'.
    // OptionIsDefined charges 10 first (Pattern A); cost-limit fires before child eval.
    {
        let get_var = GetVar {
            var_id: 3,
            var_tpe: SType::SInt,
        };
        let get_var_expr: Expr = get_var.into();
        let option_is_defined = OptionIsDefined {
            input: Box::new(get_var_expr),
        };
        let outer_expr: Expr = option_is_defined.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &outer_expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let mut ext = ContextExtension::empty();
        let constant: Constant = 42i32.into();
        ext.values.insert(3, constant);
        let ext_json = context_extension_to_json(&ext);

        entries.push(OptionIsDefinedFixture {
            name: "option_is_defined_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json, "jitCostLimit": 8 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    Ok(OptionIsDefinedFixtureFile {
        corpus: "eval_option_is_defined",
        entries,
    })
}
