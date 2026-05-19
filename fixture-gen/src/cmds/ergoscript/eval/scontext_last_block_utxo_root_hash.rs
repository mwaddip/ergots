//! SContext.lastBlockUtxoRootHash handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scontext.rs:83-99`
//!   `LAST_BLOCK_UTXO_ROOT_HASH_EVAL_FN`
//! Method registration: `ergotree-ir/src/types/scontext.rs::LAST_BLOCK_UTXO_ROOT_HASH_PROPERTY`
//!
//! Pattern A cost 15 (charged before obj check). Returns AvlTree synthesized
//! from ctx.headers[0].state_root with:
//!   treeFlags = AvlTreeFlags::new(true, true, true) = 0b00000111 = 7
//!   key_length = 32
//!   value_length_opt = None
//!
//! Total eval cost: 4 (PropertyCall dispatcher) + 1 (Context arm) + 15 (handler) = 20.
//!
//! The deterministic Context::arbitrary() seed produces V1 headers (with
//! non-trivial state_root bytes); the expected value is an AvlTree whose
//! digest = ctx.headers[0].state_root, treeFlags = 7, keyLength = 32,
//! valueLengthOpt = null.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scontext::LAST_BLOCK_UTXO_ROOT_HASH_PROPERTY;
use proptest::arbitrary::Arbitrary;
use proptest::strategy::Strategy;
use proptest::test_runner::TestRunner;
use serde_json::json;

use super::common::{headers_to_json, EvalFixture, EvalFixtureFile};

fn avl_tree_value_to_json(val: &ergotree_ir::mir::value::Value) -> serde_json::Value {
    match val {
        ergotree_ir::mir::value::Value::AvlTree(avl) => {
            json!({
                "kind": "AvlTree",
                "value": {
                    "digest_hex": hex::encode(avl.digest.0.as_ref()),
                    "treeFlags": avl.tree_flags.serialize() as u32,
                    "keyLength": avl.key_length,
                    "valueLengthOpt": avl.value_length_opt.as_deref().copied(),
                }
            })
        }
        other => panic!(
            "scontext_last_block_utxo_root_hash: expected AvlTree, got {:?}",
            other
        ),
    }
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Tree: PropertyCall(Context, lastBlockUtxoRootHash)
    let expr: Expr = PropertyCall::new(Expr::Context, LAST_BLOCK_UTXO_ROOT_HASH_PROPERTY.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    // Deterministic TestRunner (fixed seed) — same seed as sheader_handlers.rs and
    // scontext_pre_header.rs — so fixtures stay stable across re-runs.
    let mut runner = TestRunner::deterministic();
    let ctx = Context::arbitrary()
        .new_tree(&mut runner)
        .unwrap()
        .current();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    let opts_json = json!({
        "headers": headers_to_json(&ctx.headers),
    });

    entries.push(EvalFixture {
        name: "context_last_block_utxo_root_hash".to_string(),
        tree_bytes_hex,
        opts_json,
        expected_value_json: avl_tree_value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_scontext_last_block_utxo_root_hash",
        entries,
    })
}
