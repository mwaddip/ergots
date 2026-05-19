//! SHeader.checkPow oracle fixture — phase 2h-c.2 Task 8.
//!
//! Generates one fixture for `MethodCall(headers[0], SHeader.CHECK_POW_METHOD, args=[])`.
//! Uses a real mainnet V3 block (height 1433531) whose Autolykos V2 PoW is valid,
//! so `try_eval_out::<bool>` returns `true`.
//!
//! Also carries a V1 synthetic header (scorex-serialized bytes + metadata) so the
//! TS test for Task 12 (V1 → AutolykosV1NotSupportedError) has an input header.
//!
//! Sigma-rust refs:
//!   eval impl:     `ergotree-interpreter/src/eval/sheader.rs:115-124`
//!   method desc:   `ergotree-ir/src/types/sheader.rs:164-176`
//!   method id:     `CHECK_POW_METHOD_ID = MethodId(16)`
//!   min_version:   `ErgoTreeVersion::V3`
//!   jit cost:      `ctx.add_jit_cost(700)` (CHECK_POW_EVAL_FN)
//!
//! Cost breakdown:
//!   4  (MethodCall dispatcher)
//! + 4  (ByIndex arm)
//! + 1  (Const arm — index literal 0)
//! + 4  (PropertyCall dispatcher — Context.headers)
//! + 1  (Context arm)
//! + 15 (SContext.headers handler)
//! + 700 (SHeader.checkPow handler)
//! = 729

use ergo_chain_types::Header;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::coll_by_index::ByIndex;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scontext::HEADERS_PROPERTY;
use ergotree_ir::types::sheader::CHECK_POW_METHOD;
use proptest::arbitrary::Arbitrary;
use proptest::strategy::Strategy;
use proptest::test_runner::TestRunner;
use serde_json::{json, Value as JsonValue};
use sigma_ser::ScorexSerializable;

// ─── V2 mainnet header with valid Autolykos V2 PoW ───────────────────────────

/// Real mainnet V3 header — block 1433531 — with valid Autolykos V2 PoW.
///
/// This JSON string mirrors the `serde_json::from_str` pattern used in
/// `ergotree-interpreter/src/eval/sheader.rs:391-418` (test_eval_check_pow).
/// Injected directly into `ctx.headers[0]` so that `header.check_pow()` returns
/// `true` without building a proof from scratch.
const MAINNET_HEADER_V3_JSON: &str = r#"{
  "extensionId": "d51a477cc12b187d9bc7f464b22d00e3aa7c92463874e863bf3acf2f427bb48b",
  "difficulty": "1595361307131904",
  "votes": "000000",
  "timestamp": 1736177881102,
  "size": 220,
  "unparsedBytes": "",
  "stateRoot": "4dfafb43842680fd5870d8204a218f873479e1f5da1b34b059ca8da526abcc8719",
  "height": 1433531,
  "nBits": 117811961,
  "version": 3,
  "id": "3473e7b5aaf623e4260d5798253d26f3cdc912c12594b7e3a979e3db8ed883f6",
  "adProofsRoot": "73160faa9f0e47bf7da598d4e9d3de58e8a24b8564458ad8a4d926514f435dc1",
  "transactionsRoot": "c88d5f50ece85c2b918b5bd41d2bc06159e6db1b3aad95091d994c836a172950",
  "extensionHash": "d5a43bf63c1d8c7f10b15b6d2446abe565b93a4fd3f5ca785b00e6bda831644f",
  "powSolutions": {
    "pk": "0274e729bb6615cbda94d9d176a2f1525068f12b330e38bbbf387232797dfd891f",
    "w": "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    "n": "a6905b8c65f5864a",
    "d": 0
  },
  "adProofsId": "80a5ff0c6cd98440163bd27f2d7c775ea516af09024a98d9d83f16029bfbd034",
  "transactionsId": "c7315c49df258522d3e92ce2653d9f4d8a35309a7a7dd470ebf8db53dd3fb792",
  "parentId": "93172f3152a6a25dc89dc45ede1130c5eb86636a50bfb93a999556d16016ceb7"
}"#;

// ─── V1 synthetic header helpers ─────────────────────────────────────────────

/// Build a V1 synthetic header (scorex-serialized).
///
/// Reuses the same construction as `sheader_constants.rs:make_v1_header()`:
/// version=1, all-zero fields, height=1, EcPoint::default() for both
/// pk and pow_onetime_pk (required for V1 Autolykos).
///
/// Sigma-rust ref: `ergo-chain-types/src/header.rs` — V1 wire layout includes
/// `pow_onetime_pk` and `pow_distance` fields.
fn make_v1_header() -> anyhow::Result<Header> {
    use ergo_chain_types::{ADDigest, AutolykosSolution, BlockId, Digest32, EcPoint, Votes};
    use num_bigint::BigUint;

    let zero32 = Digest32::zero();
    let mut header = Header {
        version: 1,
        id: BlockId(Digest32::zero()),
        parent_id: BlockId(Digest32::zero()),
        ad_proofs_root: zero32,
        state_root: ADDigest::zero(),
        transaction_root: zero32,
        timestamp: 1_000_000u64,
        n_bits: 117_586_360u32,
        height: 1u32,
        extension_root: zero32,
        autolykos_solution: AutolykosSolution {
            miner_pk: Box::new(EcPoint::default()),
            // V1 Autolykos: pow_onetime_pk and pow_distance are required.
            pow_onetime_pk: Some(Box::new(EcPoint::default())),
            nonce: vec![0u8; 8],
            pow_distance: Some(BigUint::from(0u32)),
        },
        votes: Votes([0, 0, 0]),
        unparsed_bytes: Box::new([]),
    };
    // Serialize and reparse to let the ID field be computed by sigma-rust.
    let bytes = header.scorex_serialize_bytes()?;
    let reparsed = Header::scorex_parse_bytes(&bytes)?;
    header.id = reparsed.id;
    Ok(header)
}

// ─── Expr builder ─────────────────────────────────────────────────────────────

/// Build the Expr tree:
///   `MethodCall(ByIndex(PropertyCall(Context, headers), Const(0i32)), CHECK_POW_METHOD, [])`
///
/// This mirrors the pattern from the sigma-rust test at
/// `ergotree-interpreter/src/eval/sheader.rs:421-425`.
fn checkpow_expr() -> anyhow::Result<Expr> {
    let headers_expr: Expr = ergotree_ir::mir::property_call::PropertyCall::new(
        Expr::Context,
        HEADERS_PROPERTY.clone(),
    )
    .map_err(|e| anyhow::anyhow!("PropertyCall Context.headers: {:?}", e))?
    .into();

    let header_expr: Expr = ByIndex::new(headers_expr, Expr::Const(0i32.into()), None)
        .map_err(|e| anyhow::anyhow!("ByIndex headers[0]: {:?}", e))?
        .into();

    let expr: Expr = MethodCall::new(header_expr, CHECK_POW_METHOD.clone(), vec![])
        .map_err(|e| anyhow::anyhow!("MethodCall checkPow: {:?}", e))?
        .into();

    Ok(expr)
}

// ─── Public entry point ───────────────────────────────────────────────────────

/// Generate the SHeader.checkPow oracle fixture.
///
/// Returns a flat `serde_json::Value` (not wrapped in `EvalFixtureFile`):
///   - `name`             — fixture identifier
///   - `exprBytes`        — hex of the sigma-serialized Expr (body of a V3 ErgoTree)
///   - `expectedValue`    — `true` (valid mainnet V3 header with PoW)
///   - `expectedJitCost`  — sigma-rust's recorded jit cost (u64 as JSON number)
///   - `headerHexBytes`   — scorex-serialized bytes of the V3 oracle header (hex)
///   - `headerVersion`    — `3`
///   - `headerHeight`     — `1433531`
///   - `v1HeaderHexBytes` — scorex-serialized bytes of the V1 synthetic header (hex)
///   - `v1HeaderVersion`  — `1`
///   - `v1HeaderHeight`   — `1`
pub fn generate() -> anyhow::Result<JsonValue> {
    // ── Build and serialize the Expr ─────────────────────────────────────────
    let expr = checkpow_expr()?;
    // Wrap in a V3 ErgoTree to get the sigma-serialized byte sequence.
    // V3 is required because CHECK_POW_METHOD has min_version = ErgoTreeVersion::V3.
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let expr_bytes = tree.sigma_serialize_bytes()?;

    // ── Build the oracle Context ──────────────────────────────────────────────
    // Start with a deterministic proptest Context so the surrounding fields
    // (pre_header, data_inputs, etc.) are reproducible, then overwrite headers[0]
    // with the real mainnet header that has valid PoW.
    let mut runner = TestRunner::deterministic();
    let mut ctx = Context::arbitrary().new_tree(&mut runner).unwrap().current();

    // Deserialize the real mainnet V3 header from JSON (same approach as
    // sigma-rust's `test_eval_check_pow`).
    let v3_header: Header = serde_json::from_str(MAINNET_HEADER_V3_JSON)
        .map_err(|e| anyhow::anyhow!("parse mainnet header JSON: {}", e))?;
    ctx.headers[0] = v3_header.clone();

    // ── Run the oracle ────────────────────────────────────────────────────────
    let value: bool = try_eval_out(&expr, &ctx)
        .map_err(|e| anyhow::anyhow!("try_eval_out checkPow: {:?}", e))?;
    let jit_cost = ctx.jit_cost_value();

    // ── Serialize the V3 oracle header (scorex) ───────────────────────────────
    let v3_header_bytes = v3_header.scorex_serialize_bytes()?;

    // ── Build and serialize the V1 synthetic header ───────────────────────────
    let v1_header = make_v1_header()?;
    let v1_header_bytes = v1_header.scorex_serialize_bytes()?;

    Ok(json!({
        "name": "sheader-checkpow",
        "exprBytes": hex::encode(&expr_bytes),
        "expectedValue": value,
        "expectedJitCost": jit_cost,
        "headerHexBytes": hex::encode(&v3_header_bytes),
        "headerVersion": v3_header.version,
        "headerHeight": v3_header.height,
        "v1HeaderHexBytes": hex::encode(&v1_header_bytes),
        "v1HeaderVersion": v1_header.version,
        "v1HeaderHeight": v1_header.height,
    }))
}
