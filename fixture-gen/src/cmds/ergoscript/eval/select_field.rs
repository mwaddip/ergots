//! Phase 2f medium Stop γ Task 6 — SelectField eval fixtures.
//!
//! Cost: Fixed(10). Pattern A (cost BEFORE eval-child).
//! Sigma-rust ref: `ergotree-interpreter/src/eval/select_field.rs:9-32`
//!   ctx.add_jit_cost(10)?;
//!   let input_v = self.input.eval(env, ctx)?;
//!   match input_v {
//!     Value::Tup(items) => items.get(field_index.zero_based_index())
//!       .cloned()
//!       .ok_or_else(... NotFound ...),
//!     _ => Err(EvalError::UnexpectedValue(...)),
//!   }
//!
//! Notes:
//!   - `field_index` is 1-based on the wire; `zero_based_index()` subtracts 1.
//!   - `SelectField::new` validates at construction time that `field_index` is
//!     in-bounds for the tuple type — so OOB cannot be reached via a
//!     parser-produced tree. OOB error tested inline in TS only.
//!
//! Fixture entries (4 total):
//!   1. select_field_first_of_pair     — SelectField(Tuple(Int(5), Int(99)), 1) → Int(5)
//!      Cost = 10 (SF) + 15 (Tuple) + 5 (Const 5) + 5 (Const 99) = 35
//!   2. select_field_second_of_pair    — same input, fieldIndex=2 → Int(99)
//!      Cost = 35 (same tree)
//!   3. select_field_creation_info_height — SelectField(ExtractCreationInfo(SelfBox), 1) → Int
//!      returns the creation height (Int) from a 2-tuple (Int, Coll[Byte])
//!      Cost = 10 (SF) + 16 (ECI) + 10 (GlobalVars) = 36
//!   4. select_field_cost_limit        — jitCostLimit=8 < Fixed(10) → 'cost-limit-exceeded'

use core::cell::Cell;
use core::convert::TryFrom;

use ergo_chain_types::{BlockId, Digest32, EcPoint, PreHeader, Votes};
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::{Context, ContextExtensionProvider};
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::extract_creation_info::ExtractCreationInfo;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::select_field::{SelectField, TupleFieldIndex};
use ergotree_ir::mir::tuple::Tuple;
use ergotree_ir::mir::unary_op::OneArgOpTryBuild;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;
use sigma_test_util::force_any_val;

use super::common::{ergo_box_to_json, value_to_json};

/// A minimal ContextExtensionProvider for the controlled Context.
struct SimpleExtProvider(ContextExtension);

impl ContextExtensionProvider for SimpleExtProvider {
    fn context_extension(&self, _input_index: usize) -> Option<&ContextExtension> {
        Some(&self.0)
    }
}

#[derive(Serialize)]
pub struct SelectFieldFixture {
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
pub struct SelectFieldFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<SelectFieldFixture>,
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

/// Build a controlled Context (same deterministic seed as prior 2f-medium tasks).
fn controlled_context() -> Context<'static> {
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

    let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
    let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
    let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));

    let ext = ContextExtension::empty();
    let ext: &'static ContextExtension = Box::leak(Box::new(ext.clone()));
    let ext_provider: &'static SimpleExtProvider =
        Box::leak(Box::new(SimpleExtProvider(ContextExtension::empty())));

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

pub fn generate() -> anyhow::Result<SelectFieldFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. select_field_first_of_pair ─────────────────────────────────────────
    // SelectField(Tuple(Int(5), Int(99)), fieldIndex=1) → Int(5)
    // Cost: 10 (SelectField) + 15 (Tuple) + 5 (Const 5) + 5 (Const 99) = 35
    {
        let tuple_expr: Expr = Tuple::new(vec![
            Expr::Const(5i32.into()),
            Expr::Const(99i32.into()),
        ])?
        .into();
        let field_index = TupleFieldIndex::try_from(1u8).expect("field_index 1");
        let sf = SelectField::new(tuple_expr, field_index)
            .map_err(|e| anyhow::anyhow!("SelectField::new: {:?}", e))?;
        let expr: Expr = sf.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = controlled_context();
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Int(5)),
            "expected Int(5), got {:?}",
            val
        );

        entries.push(SelectFieldFixture {
            name: "select_field_first_of_pair".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. select_field_second_of_pair ────────────────────────────────────────
    // SelectField(Tuple(Int(5), Int(99)), fieldIndex=2) → Int(99)
    // Cost: 10 (SelectField) + 15 (Tuple) + 5 (Const 5) + 5 (Const 99) = 35
    {
        let tuple_expr: Expr = Tuple::new(vec![
            Expr::Const(5i32.into()),
            Expr::Const(99i32.into()),
        ])?
        .into();
        let field_index = TupleFieldIndex::try_from(2u8).expect("field_index 2");
        let sf = SelectField::new(tuple_expr, field_index)
            .map_err(|e| anyhow::anyhow!("SelectField::new: {:?}", e))?;
        let expr: Expr = sf.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = controlled_context();
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Int(99)),
            "expected Int(99), got {:?}",
            val
        );

        entries.push(SelectFieldFixture {
            name: "select_field_second_of_pair".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 3. select_field_creation_info_height ──────────────────────────────────
    // SelectField(ExtractCreationInfo(SelfBox), fieldIndex=1) → Int(creation_height)
    // ExtractCreationInfo returns (Int, Coll[Byte]); field 1 is the Int (creation height).
    // Cost: 10 (SF) + 16 (ECI) + 10 (GlobalVars/SelfBox) = 36
    {
        let self_box_expr: Expr = GlobalVars::SelfBox.into();
        let eci_expr: Expr = ExtractCreationInfo::try_build(self_box_expr)
            .map_err(|e| anyhow::anyhow!("ExtractCreationInfo::try_build: {:?}", e))?
            .into();
        let field_index = TupleFieldIndex::try_from(1u8).expect("field_index 1");
        let sf = SelectField::new(eci_expr, field_index)
            .map_err(|e| anyhow::anyhow!("SelectField::new for ECI: {:?}", e))?;
        let expr: Expr = sf.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        let self_box_val = simple_box(BoxValue::MIN_RAW);
        let self_box_json = ergo_box_to_json(&self_box_val);
        let ctx = controlled_context();

        // Oracle: SelectField(_1) of ExtractCreationInfo → Int(0) (creation_height=0).
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        assert!(
            matches!(val, ergotree_ir::mir::value::Value::Int(0)),
            "expected Int(0) (creation_height=0), got {:?}",
            val
        );

        entries.push(SelectFieldFixture {
            name: "select_field_creation_info_height".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "selfBox": self_box_json }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. select_field_cost_limit ────────────────────────────────────────────
    // jitCostLimit=8 < Fixed(10) → 'cost-limit-exceeded'
    // Use SelectField(Tuple(Int(5), Int(99)), 1) same as entry 1.
    {
        let tuple_expr: Expr = Tuple::new(vec![
            Expr::Const(5i32.into()),
            Expr::Const(99i32.into()),
        ])?
        .into();
        let field_index = TupleFieldIndex::try_from(1u8).expect("field_index 1");
        let sf = SelectField::new(tuple_expr, field_index)
            .map_err(|e| anyhow::anyhow!("SelectField::new: {:?}", e))?;
        let expr: Expr = sf.into();
        let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
        let hex = hex::encode(tree.sigma_serialize_bytes()?);

        entries.push(SelectFieldFixture {
            name: "select_field_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "jitCostLimit": 8 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    Ok(SelectFieldFixtureFile {
        corpus: "eval_select_field",
        entries,
    })
}
