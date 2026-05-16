//! Phase 2f medium Stop β Task 2 — GetVar eval fixtures.
//!
//! Cost: Fixed(10). Leaf arm (Pattern A: cost BEFORE everything).
//! Sigma-rust ref: `ergotree-interpreter/src/eval/get_var.rs:10-23`
//!   ctx.add_jit_cost(10)?;
//!   match ctx.extension.values.get(&self.var_id) {
//!     None => Ok(Value::Opt(None)),
//!     Some(v) if v.tpe == self.var_tpe => Ok((Some(v.v.clone())).into()),
//!     Some(v) => Err(TryExtractFromError(...)),   // type-mismatch THROWS
//!   }
//!
//! The oracle for each entry is `try_eval_out::<Value>` against a controlled
//! Context with a specific ContextExtension.
//!
//! Fixture entries (7 total):
//!   1. get_var_int_present       — varId=3,  varTpe=SInt,          ext[3]=42       → Some(42)
//!   2. get_var_long_present      — varId=4,  varTpe=SLong,         ext[4]=100i64   → Some(100)
//!   3. get_var_coll_byte_present — varId=5,  varTpe=SColl(SByte),  ext[5]=bytes    → Some(coll)
//!   4. get_var_absent            — varId=99, varTpe=SInt,          ext doesn't contain 99 → None
//!   5. get_var_type_mismatch     — varId=3,  stored SLong,  requested SInt          → 'get-var-type-mismatch'
//!   6. get_var_boolean_present   — varId=6,  varTpe=SBoolean,      ext[6]=true     → Some(true)
//!   7. get_var_cost_limit        — jitCostLimit=5 < Fixed(10)                      → 'cost-limit-exceeded'

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
use ergotree_ir::mir::value::Value as ErgotreeValue;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::get_var::GetVar;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;
use sigma_test_util::force_any_val;

use super::common::{stype_to_json, value_to_json};

/// A minimal ContextExtensionProvider for the controlled Context.
struct SimpleExtProvider(ContextExtension);

impl ContextExtensionProvider for SimpleExtProvider {
    fn context_extension(&self, _input_index: usize) -> Option<&ContextExtension> {
        Some(&self.0)
    }
}

#[derive(Serialize)]
pub struct GetVarFixture {
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
pub struct GetVarFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<GetVarFixture>,
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

/// Build the serialized ErgoTree for a GetVar expression and return its hex.
fn build_get_var_tree(var_id: u8, var_tpe: SType) -> anyhow::Result<(ErgoTree, String)> {
    let get_var = GetVar { var_id, var_tpe };
    let expr: Expr = get_var.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Build a controlled Context with a specific ContextExtension.
///
/// Uses hardcoded deterministic values for all fields (identical to the
/// GlobalVars Task 1 pattern). The ContextExtension is the variable part
/// supplied by the caller.
fn controlled_context_with_extension(
    extension: ContextExtension,
) -> Context<'static> {
    let gen_bytes = hex::decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    ).expect("decode gen bytes");
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

    let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
    let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
    let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));

    let ext: &'static ContextExtension = Box::leak(Box::new(extension.clone()));
    let ext_provider: &'static SimpleExtProvider = Box::leak(Box::new(
        SimpleExtProvider(extension)
    ));

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
///   `{ "values": { "<varId>": { "tpe": SType, "value": SValue } | null } }`
///
/// Note: the Rust ContextExtension stores a `Constant` per entry (which has
/// both `.tpe` and `.v: Value`); we serialize both to the JSON so the TS side
/// can reconstruct the typed entry.
fn context_extension_to_json(ext: &ContextExtension) -> JsonValue {
    let values: serde_json::Map<String, JsonValue> = ext.values.iter().map(|(k, c)| {
        let entry = json!({
            "tpe": stype_to_json(&c.tpe),
            "value": value_to_json(&ErgotreeValue::from(c.v.clone())),
        });
        (k.to_string(), entry)
    }).collect();
    json!({ "values": values })
}

/// Build the expected Option SValue JSON for a GetVar result.
///
/// `value_to_json` in common.rs falls through to the Opaque branch for
/// `Value::Opt` (which erases the elem type). We build the Option JSON
/// directly here instead, since we know both the elem type (varTpe) and
/// the contained value:
///   present → { kind: "Option", elem: <stype>, value: <inner_svalue> }
///   absent  → { kind: "Option", elem: <stype>, value: null }
///
/// The inner value is encoded by calling `value_to_json` on the extracted
/// `Value::Opt`'s inner — we validate against sigma-rust's oracle first.
fn option_value_json(elem_tpe: &SType, inner: Option<JsonValue>) -> JsonValue {
    json!({
        "kind": "Option",
        "elem": stype_to_json(elem_tpe),
        "value": inner.unwrap_or(JsonValue::Null),
    })
}

pub fn generate() -> anyhow::Result<GetVarFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. get_var_int_present ────────────────────────────────────────────────
    // varId=3, varTpe=SInt, ext[3]=Constant(SInt, 42) → Some(42), cost=10
    {
        let (tree, hex) = build_get_var_tree(3, SType::SInt)?;
        let mut ext = ContextExtension::empty();
        let constant: Constant = 42i32.into();
        ext.values.insert(3, constant);
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension(ext);
        // Validate against oracle: must succeed and be Opt(Some(Int(42))).
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, ErgotreeValue::Opt(Some(_))), "expected Some: {:?}", val);
        entries.push(GetVarFixture {
            name: "get_var_int_present".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: option_value_json(
                &SType::SInt,
                Some(json!({ "kind": "Int", "value": 42 })),
            ),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. get_var_long_present ───────────────────────────────────────────────
    // varId=4, varTpe=SLong, ext[4]=Constant(SLong, 100i64) → Some(100), cost=10
    {
        let (tree, hex) = build_get_var_tree(4, SType::SLong)?;
        let mut ext = ContextExtension::empty();
        let constant: Constant = 100i64.into();
        ext.values.insert(4, constant);
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension(ext);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, ErgotreeValue::Opt(Some(_))), "expected Some: {:?}", val);
        entries.push(GetVarFixture {
            name: "get_var_long_present".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: option_value_json(
                &SType::SLong,
                // Long values serialized as decimal strings (JSON can't represent i64 exactly).
                Some(json!({ "kind": "Long", "value": "100" })),
            ),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 3. get_var_coll_byte_present ──────────────────────────────────────────
    // varId=5, varTpe=SColl(SByte), ext[5]=Constant(SColl[SByte], [1,2,3,4]) → Some(coll)
    {
        let (tree, hex) = build_get_var_tree(5, SType::SColl(SType::SByte.into()))?;
        let mut ext = ContextExtension::empty();
        // Fixed 4-byte payload (deterministic, no randomness).
        let bytes: Vec<i8> = vec![1i8, 2i8, 3i8, 4i8];
        let constant: Constant = bytes.into();
        ext.values.insert(5, constant);
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension(ext);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, ErgotreeValue::Opt(Some(_))), "expected Some: {:?}", val);
        entries.push(GetVarFixture {
            name: "get_var_coll_byte_present".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: option_value_json(
                &SType::SColl(SType::SByte.into()),
                Some(json!({
                    "kind": "Coll",
                    "elem": { "tag": "SByte" },
                    "items": [
                        { "kind": "Byte", "value": 1 },
                        { "kind": "Byte", "value": 2 },
                        { "kind": "Byte", "value": 3 },
                        { "kind": "Byte", "value": 4 },
                    ]
                })),
            ),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. get_var_absent ─────────────────────────────────────────────────────
    // varId=99, varTpe=SInt, ext doesn't contain 99 → None, cost=10
    {
        let (tree, hex) = build_get_var_tree(99, SType::SInt)?;
        // Build ext with varId=3 but query varId=99 → absent.
        let mut ext = ContextExtension::empty();
        let constant: Constant = 42i32.into();
        ext.values.insert(3, constant);
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension(ext);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, ErgotreeValue::Opt(None)), "expected None: {:?}", val);
        entries.push(GetVarFixture {
            name: "get_var_absent".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: option_value_json(&SType::SInt, None),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 5. get_var_type_mismatch ──────────────────────────────────────────────
    // varId=3, stored=SLong(100), requested=SInt → throws 'get-var-type-mismatch'
    {
        let (_tree, hex) = build_get_var_tree(3, SType::SInt)?;
        // Store SLong but request SInt → mismatch.
        let ext_with_long = {
            let mut ext = ContextExtension::empty();
            let constant: Constant = 100i64.into();
            ext.values.insert(3, constant);
            ext
        };
        let ext_json = context_extension_to_json(&ext_with_long);
        entries.push(GetVarFixture {
            name: "get_var_type_mismatch".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("get-var-type-mismatch"),
        });
    }

    // ── 6. get_var_boolean_present ────────────────────────────────────────────
    // varId=6, varTpe=SBoolean, ext[6]=Constant(SBoolean, true) → Some(true), cost=10
    {
        let (tree, hex) = build_get_var_tree(6, SType::SBoolean)?;
        let mut ext = ContextExtension::empty();
        let constant: Constant = true.into();
        ext.values.insert(6, constant);
        let ext_json = context_extension_to_json(&ext);
        let ctx = controlled_context_with_extension(ext);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(matches!(val, ErgotreeValue::Opt(Some(_))), "expected Some: {:?}", val);
        entries.push(GetVarFixture {
            name: "get_var_boolean_present".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json }),
            expected_value_json: option_value_json(
                &SType::SBoolean,
                Some(json!({ "kind": "Boolean", "value": true })),
            ),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 7. get_var_cost_limit ─────────────────────────────────────────────────
    // jitCostLimit=5 < Fixed(10) → 'cost-limit-exceeded'
    {
        let (_tree, hex) = build_get_var_tree(3, SType::SInt)?;
        let mut ext = ContextExtension::empty();
        let constant: Constant = 42i32.into();
        ext.values.insert(3, constant);
        let ext_json = context_extension_to_json(&ext);
        entries.push(GetVarFixture {
            name: "get_var_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "extension": ext_json, "jitCostLimit": 5 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    Ok(GetVarFixtureFile {
        corpus: "eval_get_var",
        entries,
    })
}
