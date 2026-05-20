//! SGroupElement.getEncoded handler — fixtures (phase 2h-f).
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/sgroup_elem.rs:15-26` — GET_ENCODED_EVAL_FN.
//! Method registration: `ergotree-ir/src/types/sgroup_elem.rs::GET_ENCODED_METHOD` (V0+).
//!
//! Pattern A Fixed(250). Returns 33-byte SEC1-compressed point as Coll[Byte].
//! No type variables; no `with_concrete_types` needed (signature is
//! `(SGroupElement) → SColl(SByte)`).
//!
//! Scenarios:
//!   - generator: the secp256k1 base point. The returned Coll[Byte] should
//!     equal the 33-byte SEC1 encoding consumed as GROUP_GENERATOR_BYTES on
//!     the TS side.
//!   - identity: the Ergo identity-point (33 zero bytes per
//!     ergo-chain-types/src/ec_point.rs:96-99).
//!
//! (No `arbitrary` scenario: `force_any_val::<EcPoint>()` is deterministic
//! under the proptest seed and happens to produce the same bytes as
//! `generator()` on the first call — would be redundant. Mirrors the
//! `create_prove_dlog.rs` precedent of using explicit `generator()` +
//! `identity()` only.)

use ergo_chain_types::ec_point::{generator, identity};
use ergo_chain_types::EcPoint;
use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::sgroup_elem::GET_ENCODED_METHOD;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

fn entry(name: &str, ec_point: EcPoint) -> anyhow::Result<EvalFixture> {
    let ge_const: Constant = ec_point.into();
    let expr: Expr =
        MethodCall::new(ge_const.into(), GET_ENCODED_METHOD.clone(), vec![])?.into();

    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> =
        try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let entries = vec![
        entry("generator", generator())?,
        entry("identity", identity())?,
    ];
    Ok(EvalFixtureFile {
        corpus: "eval_sgroup_element_get_encoded",
        entries,
    })
}
