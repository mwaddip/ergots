mod cmds;

use std::path::{Path, PathBuf};

fn proof_fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent().unwrap().join("packages/nipopow/test/fixtures")
}

fn ergoscript_fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .unwrap()
        .join("packages/ergoscript/test/fixtures")
}

fn write_json_at<T: serde::Serialize>(dir: &Path, name: &str, value: &T) -> anyhow::Result<()> {
    let path = dir.join(name);
    let json = serde_json::to_string_pretty(value)?;
    std::fs::write(&path, json + "\n")?;
    println!("wrote {}", path.display());
    Ok(())
}

fn write_proof_json<T: serde::Serialize>(name: &str, value: &T) -> anyhow::Result<()> {
    write_json_at(&proof_fixtures_dir(), name, value)
}

fn write_ergoscript_json<T: serde::Serialize>(name: &str, value: &T) -> anyhow::Result<()> {
    write_json_at(&ergoscript_fixtures_dir(), name, value)
}

fn main() -> anyhow::Result<()> {
    // Subcommand dispatch: `cargo run -p fixture-gen -- wider_corpus` routes here.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("wider_corpus") {
        return cmds::wider_corpus::run();
    }
    if args.get(1).map(|s| s.as_str()) == Some("avltree") {
        return cmds::avltree::run();
    }

    std::fs::create_dir_all(proof_fixtures_dir())?;
    std::fs::create_dir_all(ergoscript_fixtures_dir())?;

    // Proof package (@ergots/nipopow) fixtures.
    write_proof_json("vlq.json", &cmds::vlq::generate()?)?;
    write_proof_json("blake2b256.json", &cmds::blake2b::generate()?)?;
    write_proof_json("autolykos_solution.json", &cmds::autolykos_solution::generate()?)?;
    write_proof_json("nbits.json", &cmds::nbits::generate()?)?;
    write_proof_json("header.json", &cmds::header::generate()?)?;
    write_proof_json("batch_merkle.json", &cmds::batch_merkle::generate()?)?;
    write_proof_json("popow_header.json", &cmds::popow_header::generate()?)?;
    write_proof_json("nipopow_proof.json", &cmds::nipopow_proof::generate()?)?;
    write_proof_json("autolykos_v2.json", &cmds::autolykos_v2::generate()?)?;
    write_proof_json("compare.json", &cmds::compare::generate()?)?;
    write_proof_json("envelope.json", &cmds::envelope::generate()?)?;

    // Ergoscript package (@ergots/ergoscript) synthetic fixtures.
    write_ergoscript_json("synthetic_stype.json", &cmds::ergoscript::synthetic_stype::generate()?)?;
    write_ergoscript_json("synthetic_svalue.json", &cmds::ergoscript::synthetic_svalue::generate()?)?;
    write_ergoscript_json("synthetic_expr.json", &cmds::ergoscript::synthetic_expr::generate()?)?;

    // Ergoscript real-world corpora (Task 29).
    write_ergoscript_json("corpus_legacy_45.json", &cmds::ergoscript::corpus_legacy_45::generate()?)?;
    write_ergoscript_json("corpus_ecosystem_14.json", &cmds::ergoscript::corpus_ecosystem_14::generate()?)?;
    write_ergoscript_json("corpus_significant_15.json", &cmds::ergoscript::corpus_significant_15::generate()?)?;
    write_ergoscript_json("mainnet_boxes.json", &cmds::ergoscript::mainnet_boxes::generate()?)?;

    // Phase 2f SBox wire round-trip fixtures land in their own `wire/` subdir.
    std::fs::create_dir_all(ergoscript_fixtures_dir().join("wire"))?;
    write_ergoscript_json(
        "wire/sbox-roundtrip.json",
        &cmds::ergoscript::wire::sbox_roundtrip::generate()?,
    )?;
    write_ergoscript_json(
        "wire/ergo-box-bytes.json",
        &cmds::ergoscript::wire::ergo_box_bytes::generate()?,
    )?;
    write_ergoscript_json(
        "wire/sigma-boolean-variants.json",
        &cmds::ergoscript::wire::sigma_boolean_variants::generate()?,
    )?;

    // Phase 2h-c.1 Step 5: V3 SHeader-constant ErgoTree wire-roundtrip fixtures.
    // Written as raw binary files (not JSON wrappers) so parseTree/serializeTree
    // can be tested byte-for-byte directly.
    cmds::ergoscript::wire::sheader_constants::generate(
        &ergoscript_fixtures_dir().join("wire"),
    )?;

    // Phase 2b per-arm eval fixtures land in their own `eval/` subdir to
    // keep the top-level `fixtures/` listing tidy as more arm tasks land.
    std::fs::create_dir_all(ergoscript_fixtures_dir().join("eval"))?;
    write_ergoscript_json("eval/const.json", &cmds::ergoscript::eval::const_arm::generate()?)?;
    write_ergoscript_json(
        "eval/const-placeholder.json",
        &cmds::ergoscript::eval::const_placeholder::generate()?,
    )?;
    let vd_fixture = cmds::ergoscript::eval::val_def::generate()?;
    write_ergoscript_json("eval/val-def.json", &vd_fixture)?;
    let vu_fixture = cmds::ergoscript::eval::val_use::generate()?;
    write_ergoscript_json("eval/val-use.json", &vu_fixture)?;
    let tuple_fixture = cmds::ergoscript::eval::tuple::generate()?;
    write_ergoscript_json("eval/tuple.json", &tuple_fixture)?;
    let collection_fixture = cmds::ergoscript::eval::collection::generate()?;
    write_ergoscript_json("eval/collection.json", &collection_fixture)?;
    let if_fixture = cmds::ergoscript::eval::if_arm::generate()?;
    write_ergoscript_json("eval/if.json", &if_fixture)?;
    let block_value_fixture = cmds::ergoscript::eval::block_value::generate()?;
    write_ergoscript_json("eval/block-value.json", &block_value_fixture)?;
    let logical_not_fixture = cmds::ergoscript::eval::logical_not::generate()?;
    write_ergoscript_json("eval/logical-not.json", &logical_not_fixture)?;
    let bool_to_sigma_prop_fixture = cmds::ergoscript::eval::bool_to_sigma_prop::generate()?;
    write_ergoscript_json("eval/bool-to-sigma-prop.json", &bool_to_sigma_prop_fixture)?;
    let bin_op_bit_fixture = cmds::ergoscript::eval::bin_op_bit::generate()?;
    write_ergoscript_json("eval/bin-op-bit.json", &bin_op_bit_fixture)?;
    let bin_op_logical_fixture = cmds::ergoscript::eval::bin_op_logical::generate()?;
    write_ergoscript_json("eval/bin-op-logical.json", &bin_op_logical_fixture)?;
    let bin_op_relation_fixture = cmds::ergoscript::eval::bin_op_relation::generate()?;
    write_ergoscript_json("eval/bin-op-relation.json", &bin_op_relation_fixture)?;
    let bin_op_arith_fixture = cmds::ergoscript::eval::bin_op_arith::generate()?;
    write_ergoscript_json("eval/bin-op-arith.json", &bin_op_arith_fixture)?;
    let bit_inversion_fixture = cmds::ergoscript::eval::bit_inversion::generate()?;
    write_ergoscript_json("eval/bit-inversion.json", &bit_inversion_fixture)?;
    let negation_fixture = cmds::ergoscript::eval::negation::generate()?;
    write_ergoscript_json("eval/negation.json", &negation_fixture)?;
    let upcast_fixture = cmds::ergoscript::eval::upcast::generate()?;
    write_ergoscript_json("eval/upcast.json", &upcast_fixture)?;
    let downcast_fixture = cmds::ergoscript::eval::downcast::generate()?;
    write_ergoscript_json("eval/downcast.json", &downcast_fixture)?;
    let and_fixture = cmds::ergoscript::eval::and::generate()?;
    write_ergoscript_json("eval/and.json", &and_fixture)?;
    let or_fixture = cmds::ergoscript::eval::or::generate()?;
    write_ergoscript_json("eval/or.json", &or_fixture)?;
    let apply_fixture = cmds::ergoscript::eval::apply::generate()?;
    write_ergoscript_json("eval/apply.json", &apply_fixture)?;
    let xor_of_fixture = cmds::ergoscript::eval::xor_of::generate()?;
    write_ergoscript_json("eval/xor-of.json", &xor_of_fixture)?;
    let extract_amount_fixture = cmds::ergoscript::eval::extract_amount::generate()?;
    write_ergoscript_json("eval/extract-amount.json", &extract_amount_fixture)?;
    let extract_script_bytes_fixture = cmds::ergoscript::eval::extract_script_bytes::generate()?;
    write_ergoscript_json("eval/extract-script-bytes.json", &extract_script_bytes_fixture)?;
    let extract_register_as_fixture = cmds::ergoscript::eval::extract_register_as::generate()?;
    write_ergoscript_json("eval/extract-register-as.json", &extract_register_as_fixture)?;
    let extract_creation_info_fixture =
        cmds::ergoscript::eval::extract_creation_info::generate()?;
    write_ergoscript_json(
        "eval/extract-creation-info.json",
        &extract_creation_info_fixture,
    )?;
    let extract_bytes_fixture = cmds::ergoscript::eval::extract_bytes::generate()?;
    write_ergoscript_json("eval/extract-bytes.json", &extract_bytes_fixture)?;
    let extract_bytes_with_no_ref_fixture =
        cmds::ergoscript::eval::extract_bytes_with_no_ref::generate()?;
    write_ergoscript_json(
        "eval/extract-bytes-with-no-ref.json",
        &extract_bytes_with_no_ref_fixture,
    )?;
    let extract_id_fixture = cmds::ergoscript::eval::extract_id::generate()?;
    write_ergoscript_json("eval/extract-id.json", &extract_id_fixture)?;
    let global_vars_fixture = cmds::ergoscript::eval::global_vars::generate()?;
    write_ergoscript_json("eval/global-vars.json", &global_vars_fixture)?;
    let get_var_fixture = cmds::ergoscript::eval::get_var::generate()?;
    write_ergoscript_json("eval/get-var.json", &get_var_fixture)?;
    let option_get_fixture = cmds::ergoscript::eval::option_get::generate()?;
    write_ergoscript_json("eval/option-get.json", &option_get_fixture)?;
    let option_get_or_else_fixture = cmds::ergoscript::eval::option_get_or_else::generate()?;
    write_ergoscript_json("eval/option-get-or-else.json", &option_get_or_else_fixture)?;
    let option_is_defined_fixture = cmds::ergoscript::eval::option_is_defined::generate()?;
    write_ergoscript_json("eval/option-is-defined.json", &option_is_defined_fixture)?;
    let select_field_fixture = cmds::ergoscript::eval::select_field::generate()?;
    write_ergoscript_json("eval/select-field.json", &select_field_fixture)?;
    let coll_append_fixture = cmds::ergoscript::eval::coll_append::generate()?;
    write_ergoscript_json("eval/coll-append.json", &coll_append_fixture)?;
    let coll_by_index_fixture = cmds::ergoscript::eval::coll_by_index::generate()?;
    write_ergoscript_json("eval/coll-by-index.json", &coll_by_index_fixture)?;
    let coll_exists_fixture = cmds::ergoscript::eval::coll_exists::generate()?;
    write_ergoscript_json("eval/coll-exists.json", &coll_exists_fixture)?;
    let coll_filter_fixture = cmds::ergoscript::eval::coll_filter::generate()?;
    write_ergoscript_json("eval/coll-filter.json", &coll_filter_fixture)?;
    let coll_forall_fixture = cmds::ergoscript::eval::coll_forall::generate()?;
    write_ergoscript_json("eval/coll-forall.json", &coll_forall_fixture)?;
    let coll_fold_fixture = cmds::ergoscript::eval::coll_fold::generate()?;
    write_ergoscript_json("eval/coll-fold.json", &coll_fold_fixture)?;
    let coll_map_fixture = cmds::ergoscript::eval::coll_map::generate()?;
    write_ergoscript_json("eval/coll-map.json", &coll_map_fixture)?;
    let coll_slice_fixture = cmds::ergoscript::eval::coll_slice::generate()?;
    write_ergoscript_json("eval/coll-slice.json", &coll_slice_fixture)?;
    let coll_size_fixture = cmds::ergoscript::eval::coll_size::generate()?;
    write_ergoscript_json("eval/coll-size.json", &coll_size_fixture)?;

    let create_prove_dh_tuple_fixture =
        cmds::ergoscript::eval::create_prove_dh_tuple::generate()?;
    write_ergoscript_json("eval/create-prove-dh-tuple.json", &create_prove_dh_tuple_fixture)?;

    let create_prove_dlog_fixture =
        cmds::ergoscript::eval::create_prove_dlog::generate()?;
    write_ergoscript_json("eval/create-prove-dlog.json", &create_prove_dlog_fixture)?;

    let atleast_fixture = cmds::ergoscript::eval::atleast::generate()?;
    write_ergoscript_json("eval/atleast.json", &atleast_fixture)?;

    let sigma_and_fixture = cmds::ergoscript::eval::sigma_and::generate()?;
    write_ergoscript_json("eval/sigma-and.json", &sigma_and_fixture)?;

    let sigma_or_fixture = cmds::ergoscript::eval::sigma_or::generate()?;
    write_ergoscript_json("eval/sigma-or.json", &sigma_or_fixture)?;

    let p2pk_short_circuit_fixture =
        cmds::ergoscript::eval::p2pk_short_circuit::generate()?;
    write_ergoscript_json("eval/p2pk-short-circuit.json", &p2pk_short_circuit_fixture)?;

    // Phase 2g.5 Task 1: Context Expr arm — trivial sentinel arm (cost 1).
    let context_fixture = cmds::ergoscript::eval::context::generate()?;
    write_ergoscript_json("eval/context.json", &context_fixture)?;

    // Phase 2g.6 Task 1: Global Expr arm — trivial sentinel arm (cost 5).
    let global_fixture = cmds::ergoscript::eval::global::generate()?;
    write_ergoscript_json("eval/global.json", &global_fixture)?;

    // Phase 2g.6 Task 2: SGlobal.groupGenerator handler (PropertyCall typeId=106, methodId=1).
    let sglobal_group_generator_fixture =
        cmds::ergoscript::eval::sglobal_group_generator::generate()?;
    write_ergoscript_json("eval/sglobal-group-generator.json", &sglobal_group_generator_fixture)?;

    // Phase 2g.6 Task 3: SColl.indices handler (MethodCall typeId=12, methodId=14).
    let scoll_indices_fixture = cmds::ergoscript::eval::scoll_indices::generate()?;
    write_ergoscript_json("eval/scoll-indices.json", &scoll_indices_fixture)?;

    // Phase 2g.6 Task 4: SColl.zip handler (MethodCall typeId=12, methodId=29).
    let scoll_zip_fixture = cmds::ergoscript::eval::scoll_zip::generate()?;
    write_ergoscript_json("eval/scoll-zip.json", &scoll_zip_fixture)?;

    // Phase 2g.6 Task 6: SContext.preHeader handler (PropertyCall typeId=101, methodId=3).
    let scontext_pre_header_fixture = cmds::ergoscript::eval::scontext_pre_header::generate()?;
    write_ergoscript_json("eval/scontext-pre-header.json", &scontext_pre_header_fixture)?;

    // Phase 2g.6 Task 7: SPreHeader.timestamp handler (PropertyCall typeId=105, methodId=3).
    let spreheader_timestamp_fixture = cmds::ergoscript::eval::spreheader_timestamp::generate()?;
    write_ergoscript_json("eval/spreheader-timestamp.json", &spreheader_timestamp_fixture)?;

    // Phase 2h-c.1: 15 SHeader property accessor handlers (PropertyCall typeId=104, methodIds 1-15).
    // All Pattern A Fixed(10). Source: ergotree-interpreter/src/eval/sheader.rs:16-113.
    let sheader_handlers_fixture = cmds::ergoscript::eval::sheader_handlers::generate()?;
    write_ergoscript_json("eval/sheader-handlers.json", &sheader_handlers_fixture)?;

    // Phase 2h-c.2 — SHeader.checkPow oracle fixture (MethodCall typeId=104, methodId=16).
    // Uses a real mainnet V3 header with valid Autolykos V2 PoW; expectedValue=true.
    // Also carries V1 synthetic header bytes for the AutolykosV1NotSupportedError test (T12).
    let sheader_checkpow_fixture = cmds::ergoscript::eval::sheader_checkpow::generate()?;
    write_ergoscript_json("eval/sheader-checkpow.json", &sheader_checkpow_fixture)?;

    // Phase 2h-c.1 Step 4: SContext.lastBlockUtxoRootHash handler (PropertyCall typeId=101, methodId=9).
    // Pattern A cost 15. Returns AvlTree synthesized from ctx.headers[0].state_root.
    let scontext_last_block_utxo_root_hash_fixture =
        cmds::ergoscript::eval::scontext_last_block_utxo_root_hash::generate()?;
    write_ergoscript_json(
        "eval/scontext-last-block-utxo-root-hash.json",
        &scontext_last_block_utxo_root_hash_fixture,
    )?;

    // Phase 2h-b Phase B wave 1: 7 Tier-1 SAvlTree.* accessor handlers
    // (PropertyCall typeId=100, methodIds 1..=7). Each returns a pure projection
    // of AvlTreeData with no proof verification — cost 15 (Pattern A).
    let savltree_digest_fixture = cmds::ergoscript::eval::savltree_digest::generate()?;
    write_ergoscript_json("eval/savltree-digest.json", &savltree_digest_fixture)?;
    let savltree_enabled_operations_fixture =
        cmds::ergoscript::eval::savltree_enabled_operations::generate()?;
    write_ergoscript_json(
        "eval/savltree-enabled-operations.json",
        &savltree_enabled_operations_fixture,
    )?;
    let savltree_key_length_fixture =
        cmds::ergoscript::eval::savltree_key_length::generate()?;
    write_ergoscript_json("eval/savltree-key-length.json", &savltree_key_length_fixture)?;
    let savltree_value_length_opt_fixture =
        cmds::ergoscript::eval::savltree_value_length_opt::generate()?;
    write_ergoscript_json(
        "eval/savltree-value-length-opt.json",
        &savltree_value_length_opt_fixture,
    )?;
    let savltree_is_insert_allowed_fixture =
        cmds::ergoscript::eval::savltree_is_insert_allowed::generate()?;
    write_ergoscript_json(
        "eval/savltree-is-insert-allowed.json",
        &savltree_is_insert_allowed_fixture,
    )?;
    let savltree_is_update_allowed_fixture =
        cmds::ergoscript::eval::savltree_is_update_allowed::generate()?;
    write_ergoscript_json(
        "eval/savltree-is-update-allowed.json",
        &savltree_is_update_allowed_fixture,
    )?;
    let savltree_is_remove_allowed_fixture =
        cmds::ergoscript::eval::savltree_is_remove_allowed::generate()?;
    write_ergoscript_json(
        "eval/savltree-is-remove-allowed.json",
        &savltree_is_remove_allowed_fixture,
    )?;

    // Phase 2h-b Phase B wave 2: 6 Tier-2 SAvlTree.* verification op handlers
    // (MethodCall typeId=100, methodIds 9..=14). Each constructs a real AD
    // proof via BatchAVLProver and captures eval result via try_eval_out.
    let savltree_contains_fixture = cmds::ergoscript::eval::savltree_contains::generate()?;
    write_ergoscript_json("eval/savltree-contains.json", &savltree_contains_fixture)?;
    let savltree_get_fixture = cmds::ergoscript::eval::savltree_get::generate()?;
    write_ergoscript_json("eval/savltree-get.json", &savltree_get_fixture)?;
    let savltree_get_many_fixture = cmds::ergoscript::eval::savltree_get_many::generate()?;
    write_ergoscript_json("eval/savltree-get-many.json", &savltree_get_many_fixture)?;
    let savltree_insert_fixture = cmds::ergoscript::eval::savltree_insert::generate()?;
    write_ergoscript_json("eval/savltree-insert.json", &savltree_insert_fixture)?;
    let savltree_update_fixture = cmds::ergoscript::eval::savltree_update::generate()?;
    write_ergoscript_json("eval/savltree-update.json", &savltree_update_fixture)?;
    let savltree_remove_fixture = cmds::ergoscript::eval::savltree_remove::generate()?;
    write_ergoscript_json("eval/savltree-remove.json", &savltree_remove_fixture)?;

    // Phase 2g.5 Task 2: SigmaPropBytes Expr arm — prop_bytes serialization.
    let sigma_prop_bytes_fixture = cmds::ergoscript::eval::sigma_prop_bytes::generate()?;
    write_ergoscript_json("eval/sigma-prop-bytes.json", &sigma_prop_bytes_fixture)?;

    // Phase 2g.5 Task 4: SBox.tokens handler (PropertyCall typeId=99, methodId=8).
    let method_call_fixture = cmds::ergoscript::eval::method_call::generate()?;
    write_ergoscript_json("eval/method-call.json", &method_call_fixture)?;

    // Phase 2g-combinators Task 2: GF(2^192) element-arithmetic cross-validation
    // fixtures (`gf2_192-element-ops.json`). Lives under `crypto/` to mirror the
    // TS package layout (`packages/ergoscript/src/crypto/gf2_192.ts`).
    std::fs::create_dir_all(ergoscript_fixtures_dir().join("crypto"))?;
    write_ergoscript_json(
        "crypto/gf2_192-element-ops.json",
        &cmds::ergoscript::crypto::gf2_192_element_ops::generate()?,
    )?;

    // Phase 2g-combinators Task 3: GF(2^192) polynomial-layer cross-validation
    // fixtures (`gf2_192-poly-ops.json`). Built on top of Task 2's element
    // arithmetic; consumed by `packages/ergoscript/test/crypto/gf2_192-poly.test.ts`.
    write_ergoscript_json(
        "crypto/gf2_192-poly-ops.json",
        &cmds::ergoscript::crypto::gf2_192_poly_ops::generate()?,
    )?;

    // Phase 2g-medium Task 6: leaf-only sigma-protocol verifier fixtures.
    std::fs::create_dir_all(ergoscript_fixtures_dir().join("verify"))?;
    write_ergoscript_json(
        "verify/verifier-positive.json",
        &cmds::ergoscript::verify::verifier_positive::generate()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-reject.json",
        &cmds::ergoscript::verify::verifier_reject::generate()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-mutation.json",
        &cmds::ergoscript::verify::verifier_mutation::generate()?,
    )?;

    // Phase 2g-combinators Task 8: Cand/Cor/Cthreshold conjecture verifier fixtures.
    write_ergoscript_json(
        "verify/verifier-cand.json",
        &cmds::ergoscript::verify::verifier_cand::generate()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cand-reject.json",
        &cmds::ergoscript::verify::verifier_cand::generate_reject()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cand-mutation.json",
        &cmds::ergoscript::verify::verifier_cand::generate_mutation()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cor.json",
        &cmds::ergoscript::verify::verifier_cor::generate()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cor-reject.json",
        &cmds::ergoscript::verify::verifier_cor::generate_reject()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cor-mutation.json",
        &cmds::ergoscript::verify::verifier_cor::generate_mutation()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cthreshold.json",
        &cmds::ergoscript::verify::verifier_cthreshold::generate()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cthreshold-reject.json",
        &cmds::ergoscript::verify::verifier_cthreshold::generate_reject()?,
    )?;
    write_ergoscript_json(
        "verify/verifier-cthreshold-mutation.json",
        &cmds::ergoscript::verify::verifier_cthreshold::generate_mutation()?,
    )?;

    Ok(())
}
