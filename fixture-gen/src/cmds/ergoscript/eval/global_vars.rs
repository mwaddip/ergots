//! Phase 2f medium Task 1 — GlobalVars eval fixtures.
//!
//! Cost summary (sigma-rust `ergotree-interpreter/src/eval/global_vars.rs`):
//!   Height         = Fixed(26)
//!   SelfBox        = Fixed(10)
//!   Outputs        = Fixed(10)
//!   Inputs         = Fixed(10)
//!   MinerPubKey    = Fixed(20) — returns Coll[Byte], NOT GroupElement
//!   GroupGenerator = Fixed(10)
//!
//! All Pattern A (cost charged BEFORE; GlobalVars is a leaf with no child eval).
//!
//! Context construction: we build a controlled `Context<'static>` with v1
//! ergoTrees (TS SBox parser requires hasSize=true / v1 header).
//! We use `force_any_val::<Context>()` as a base (for headers, extension, etc.)
//! then substitute the fields that GlobalVars actually reads.
//!
//! Fixture entries:
//!   1. Height happy path   — opts_json.height = 999_999
//!   2. SelfBox happy path  — opts_json.selfBox = simple box
//!   3. Outputs happy path  — opts_json.outputs = [simple box]
//!   4. Inputs happy path   — opts_json.inputs  = [simple box]
//!   5. MinerPubKey happy   — opts_json.preHeader.minerPkHex = secp256k1 G compressed
//!   6. GroupGenerator      — opts_json = {} (no ctx field needed)
//!   7. Height cost-limit   — jitCostLimit=1 < Fixed(26) → 'cost-limit-exceeded'
//!
//! NOTE: For SelfBox/Inputs/Outputs the expected_value_json encodes the ErgoBox
//! using `ergo_box_to_json` from common.rs. The TS test rehydrates via
//! `hydrateErgoBox` helper in `test/_helpers/index.ts`.

use core::cell::Cell;

use ergo_chain_types::EcPoint;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::{Context, ContextExtensionProvider};
use ergotree_ir::chain::context_extension::ContextExtension;
use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
use ergotree_ir::chain::ergo_box::box_value::BoxValue;
use ergotree_ir::chain::tx_id::TxId;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader, ErgoTreeVersion};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::serialization::SigmaSerializable;
use ergo_chain_types::PreHeader;
use sigma_ser::ScorexSerializable;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
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
pub struct GlobalVarsFixture {
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
pub struct GlobalVarsFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<GlobalVarsFixture>,
}

/// Build a minimal ErgoTree (v1, hasSize=true, body = Const(SBoolean true)).
///
/// v1 is required: the TS SBox parser reads the ergoTree header and demands
/// `hasSize=true` (bit 3) to bound the read without a full body parse.
fn minimal_ergo_tree() -> ErgoTree {
    let header = ErgoTreeHeader::v1(false);
    let expr = Expr::Const(true.into());
    ErgoTree::new(header, &expr).expect("minimal ErgoTree")
}

/// Build a 32-byte all-zero TxId.
fn zero_tx_id() -> TxId {
    TxId::zero()
}

/// Construct an ErgoBox with the given nanoErg value, zero tokens, empty registers.
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

/// Build the serialized ErgoTree for a GlobalVars variant and return its hex.
fn build_global_vars_tree(variant: GlobalVars) -> anyhow::Result<(ErgoTree, String)> {
    let expr: Expr = variant.into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let hex = hex::encode(tree.sigma_serialize_bytes()?);
    Ok((tree, hex))
}

/// Build a controlled Context where all GlobalVars-relevant fields are set.
///
/// We use `force_any_val::<Context>()` as a base (to satisfy the headers,
/// extension_provider, etc. fields), then substitute the fields that
/// GlobalVars actually reads with controlled values.
///
/// The controlled self_box, inputs, and outputs all use v1 ergoTrees
/// (required by the TS SBox parser).
fn controlled_context(
    self_box: &'static ErgoBox,
    out_box: &'static ErgoBox,
    in_box: &'static ErgoBox,
    height: u32,
) -> Context<'static> {
    // Build a controlled PreHeader with a known miner_pk (secp256k1 generator).
    // The generator bytes: 0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
    let gen_bytes = hex::decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    ).expect("decode gen bytes");
    let miner_pk: EcPoint = EcPoint::scorex_parse_bytes(&gen_bytes).expect("parse gen point");

    let base_ctx = force_any_val::<Context<'static>>();
    let pre_header = PreHeader {
        version: base_ctx.pre_header.version,
        parent_id: base_ctx.pre_header.parent_id,
        timestamp: base_ctx.pre_header.timestamp,
        n_bits: base_ctx.pre_header.n_bits,
        height,
        miner_pk: Box::new(miner_pk),
        votes: base_ctx.pre_header.votes,
    };

    let ext: &'static ContextExtension = Box::leak(Box::new(ContextExtension::empty()));
    let ext_provider: &'static SimpleExtProvider = Box::leak(Box::new(
        SimpleExtProvider(ContextExtension::empty())
    ));

    Context {
        height,
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

pub fn generate() -> anyhow::Result<GlobalVarsFixtureFile> {
    let mut entries = Vec::new();

    // ── 1. Height ─────────────────────────────────────────────────────────────
    {
        let (tree, hex) = build_global_vars_tree(GlobalVars::Height)?;
        let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
        let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
        let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));
        let ctx = controlled_context(self_box, out_box, in_box, 999_999);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        entries.push(GlobalVarsFixture {
            name: "global_vars_height".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "height": 999_999 }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 2. SelfBox ────────────────────────────────────────────────────────────
    {
        let (tree, hex) = build_global_vars_tree(GlobalVars::SelfBox)?;
        let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
        let self_box_json = ergo_box_to_json(self_box);
        let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
        let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));
        let ctx = controlled_context(self_box, out_box, in_box, 999_999);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        entries.push(GlobalVarsFixture {
            name: "global_vars_self_box".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "selfBox": self_box_json
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 3. Outputs ────────────────────────────────────────────────────────────
    {
        let (tree, hex) = build_global_vars_tree(GlobalVars::Outputs)?;
        let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
        let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
        let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));
        let out_box_json = ergo_box_to_json(out_box);
        let ctx = controlled_context(self_box, out_box, in_box, 999_999);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        entries.push(GlobalVarsFixture {
            name: "global_vars_outputs".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "outputs": [out_box_json]
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 4. Inputs ─────────────────────────────────────────────────────────────
    {
        let (tree, hex) = build_global_vars_tree(GlobalVars::Inputs)?;
        let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
        let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
        let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));
        let in_box_json = ergo_box_to_json(in_box);
        let ctx = controlled_context(self_box, out_box, in_box, 999_999);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        entries.push(GlobalVarsFixture {
            name: "global_vars_inputs".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "inputs": [in_box_json]
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 5. MinerPubKey ────────────────────────────────────────────────────────
    // Returns Coll[Byte] of 33-byte compressed secp256k1 generator.
    {
        let (tree, hex) = build_global_vars_tree(GlobalVars::MinerPubKey)?;
        let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
        let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
        let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));
        let ctx = controlled_context(self_box, out_box, in_box, 999_999);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        let votes_hex = hex::encode(ctx.pre_header.votes.0.as_ref());
        let parent_id_hex = hex::encode(ctx.pre_header.parent_id.0.0.as_ref());
        entries.push(GlobalVarsFixture {
            name: "global_vars_miner_pubkey".into(),
            tree_bytes_hex: hex,
            opts_json: json!({
                "preHeader": {
                    "version": ctx.pre_header.version,
                    "parentIdHex": parent_id_hex,
                    "timestamp": ctx.pre_header.timestamp.to_string(),
                    "nBits": ctx.pre_header.n_bits,
                    "height": ctx.pre_header.height,
                    "minerPkHex": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
                    "votesHex": votes_hex,
                }
            }),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 6. GroupGenerator ─────────────────────────────────────────────────────
    // Returns GroupElement (secp256k1 generator, 33-byte compressed).
    {
        let (tree, hex) = build_global_vars_tree(GlobalVars::GroupGenerator)?;
        let self_box: &'static ErgoBox = Box::leak(Box::new(simple_box(BoxValue::MIN_RAW)));
        let out_box: &'static ErgoBox = Box::leak(Box::new(simple_box(50_000_000)));
        let in_box: &'static ErgoBox = Box::leak(Box::new(simple_box(20_000_000)));
        let ctx = controlled_context(self_box, out_box, in_box, 999_999);
        let val = try_eval_out::<ergotree_ir::mir::value::Value>(&tree.proposition()?, &ctx)?;
        entries.push(GlobalVarsFixture {
            name: "global_vars_group_generator".into(),
            tree_bytes_hex: hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
            expected_error_code: json!(null),
        });
    }

    // ── 7. Height cost-limit exceeded ─────────────────────────────────────────
    {
        let (_tree, hex) = build_global_vars_tree(GlobalVars::Height)?;
        entries.push(GlobalVarsFixture {
            name: "global_vars_height_cost_limit".into(),
            tree_bytes_hex: hex,
            opts_json: json!({ "height": 1, "jitCostLimit": 1 }),
            expected_value_json: json!(null),
            expected_cost: 0,
            expected_error_code: json!("cost-limit-exceeded"),
        });
    }

    Ok(GlobalVarsFixtureFile {
        corpus: "eval_global_vars",
        entries,
    })
}
