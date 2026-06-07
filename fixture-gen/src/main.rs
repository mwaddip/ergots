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

fn scorex_fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .unwrap()
        .join("packages/scorex/test/fixtures")
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

fn write_scorex_json<T: serde::Serialize>(name: &str, value: &T) -> anyhow::Result<()> {
    write_json_at(&scorex_fixtures_dir(), name, value)
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
    std::fs::create_dir_all(scorex_fixtures_dir())?;

    // Proof package (@ergots/nipopow) fixtures.
    write_proof_json("vlq.json", &cmds::vlq::generate()?)?;
    write_proof_json("blake2b256.json", &cmds::blake2b::generate()?)?;
    write_proof_json("autolykos_solution.json", &cmds::autolykos_solution::generate()?)?;
    write_proof_json("header.json", &cmds::header::generate()?)?;
    write_proof_json("batch_merkle.json", &cmds::batch_merkle::generate()?)?;
    write_proof_json("popow_header.json", &cmds::popow_header::generate()?)?;
    write_proof_json("nipopow_proof.json", &cmds::nipopow_proof::generate()?)?;
    write_proof_json("compare.json", &cmds::compare::generate()?)?;
    write_proof_json("envelope.json", &cmds::envelope::generate()?)?;

    // Scorex package (@ergots/scorex) fixtures — moved from nipopow in phase 2h-c.2.
    write_scorex_json("nbits.json", &cmds::nbits::generate()?)?;
    write_scorex_json("autolykos_v2.json", &cmds::autolykos_v2::generate()?)?;

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
    let calc_blake2b256_fixture = cmds::ergoscript::eval::calc_blake2b256::generate()?;
    write_ergoscript_json("eval/calc-blake2b256.json", &calc_blake2b256_fixture)?;
    let calc_sha256_fixture = cmds::ergoscript::eval::calc_sha256::generate()?;
    write_ergoscript_json("eval/calc-sha256.json", &calc_sha256_fixture)?;
    let byte_array_to_long_fixture = cmds::ergoscript::eval::byte_array_to_long::generate()?;
    write_ergoscript_json("eval/byte-array-to-long.json", &byte_array_to_long_fixture)?;
    let long_to_byte_array_fixture = cmds::ergoscript::eval::long_to_byte_array::generate()?;
    write_ergoscript_json("eval/long-to-byte-array.json", &long_to_byte_array_fixture)?;
    let byte_array_to_bigint_fixture = cmds::ergoscript::eval::byte_array_to_bigint::generate()?;
    write_ergoscript_json("eval/byte-array-to-bigint.json", &byte_array_to_bigint_fixture)?;
    let decode_point_fixture = cmds::ergoscript::eval::decode_point::generate()?;
    write_ergoscript_json("eval/decode-point.json", &decode_point_fixture)?;
    let subst_constants_fixture = cmds::ergoscript::eval::subst_constants::generate()?;
    write_ergoscript_json("eval/subst-constants.json", &subst_constants_fixture)?;
    let xor_fixture = cmds::ergoscript::eval::xor::generate()?;
    write_ergoscript_json("eval/xor.json", &xor_fixture)?;
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

    // Campaign iter-28: SColl.patch handler (MethodCall typeId=12, methodId=19).
    let coll_patch_fixture = cmds::ergoscript::eval::coll_patch::generate()?;
    write_ergoscript_json("eval/coll-patch.json", &coll_patch_fixture)?;

    // Campaign iter-29: SOption.map handler (MethodCall typeId=36, methodId=7).
    let soption_map_fixture = cmds::ergoscript::eval::soption_map::generate()?;
    write_ergoscript_json("eval/soption-map.json", &soption_map_fixture)?;

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
    //
    // ⚠ HAND-BLESSED (F4, 2026-06-07): the savltree-*.json eval fixtures'
    // expected_cost values were re-blessed to the JVM Tier-2 cost model
    // (CreateAvlVerifier/LookupAvlTree/InsertIntoAvlTree/UpdateAvlTree/
    // RemoveAvlTree + flag/digest/updateDigest charges) which this sigma-rust
    // fork PREDATES. A `cargo run -p fixture-gen` regen will show
    // expected_cost diffs on every savltree fixture — EXPECTED, not a
    // regression. Canonical model:
    // docs/specs/2026-06-07-ergoscript-f4-avltree-tier2-cost-design.md.
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

    // Phase 2h-d Task 1: SAvlTree.updateOperations handler (MethodCall typeId=100,
    // methodId=8). Pattern A cost 45; returns new AvlTree with tree_flags replaced.
    let savltree_update_operations_fixture =
        cmds::ergoscript::eval::savltree_update_operations::generate()?;
    write_ergoscript_json(
        "eval/savltree-update-operations.json",
        &savltree_update_operations_fixture,
    )?;

    // Phase 2h-d Task 6: SAvlTree.updateDigest handler (MethodCall typeId=100,
    // methodId=15). Pattern A cost 40; returns new AvlTree with digest replaced.
    // Two scenarios: happy (33-byte arg → success) and bad-length-throw
    // (32-byte arg → EvalError 'avl-tree-bad-digest-length').
    let savltree_update_digest_fixture =
        cmds::ergoscript::eval::savltree_update_digest::generate()?;
    write_ergoscript_json(
        "eval/savltree-update-digest.json",
        &savltree_update_digest_fixture,
    )?;

    // Phase 2h-d Task 10: SAvlTree.insertOrUpdate handler (MethodCall typeId=100,
    // methodId=16, V3-gated at dispatcher). Zero per-handler cost; returns
    // Option[AvlTree] with new digest on full success, Option None on
    // pre-check fail or per-op fail, or throws on malformed proof / V<3
    // dispatcher reject. Six scenarios: happy V3, insertAllowed=false
    // pre-check, updateAllowed=false pre-check, per-op-fail-graceful (V3+
    // break path via directions-mismatch), malformed proof
    // ('avl-tree-proof-failed'), V2 dispatcher reject ('tree-version-too-low').
    let savltree_insert_or_update_fixture =
        cmds::ergoscript::eval::savltree_insert_or_update::generate()?;
    write_ergoscript_json(
        "eval/savltree-insert-or-update.json",
        &savltree_insert_or_update_fixture,
    )?;

    // Phase 2h-d Task 14: SAvlTree.insert / SAvlTree.update per-op-fail-graceful
    // carry-forward fixtures (closing previously-untested 2h-b branches).
    //   - insert V3+ per-op-fail-graceful (savltree.ts:446-460)
    //   - update per-op-fail-graceful (savltree.ts:507-510)
    //   - insert V<3 per-op-fail-throw (savltree.ts:464-469; optional hardening
    //     added because the audit of `savltree-insert.json` found no V<3 throw
    //     coverage among its 3 existing scenarios).
    let savltree_insert_partial_fixture =
        cmds::ergoscript::eval::savltree_partial_success::generate_insert_partial()?;
    write_ergoscript_json(
        "eval/savltree-insert-partial.json",
        &savltree_insert_partial_fixture,
    )?;
    let savltree_update_partial_fixture =
        cmds::ergoscript::eval::savltree_partial_success::generate_update_partial()?;
    write_ergoscript_json(
        "eval/savltree-update-partial.json",
        &savltree_update_partial_fixture,
    )?;
    let savltree_insert_partial_v2_throw_fixture =
        cmds::ergoscript::eval::savltree_partial_success::generate_insert_v2_throw()?;
    write_ergoscript_json(
        "eval/savltree-insert-partial-v2-throw.json",
        &savltree_insert_partial_v2_throw_fixture,
    )?;

    // Phase 2h-f Task 2: SGroupElement.getEncoded handler (MethodCall typeId=7,
    // methodId=2). Pattern A Fixed(250); returns 33-byte SEC1-compressed point
    // as Coll[Byte]. V0+. Two scenarios: generator, identity.
    let sgroup_elem_get_encoded_fixture =
        cmds::ergoscript::eval::sgroup_elem_get_encoded::generate()?;
    write_ergoscript_json(
        "eval/sgroup-element-get-encoded.json",
        &sgroup_elem_get_encoded_fixture,
    )?;

    // Phase 2h-f Task 7: SColl.flatMap handler (MethodCall typeId=12, methodId=15).
    // Pattern B addPerItemCost(60, 10, 8, n). Lambda HOF with concat semantics +
    // body-restriction (MethodCall body must have 0 args) + SAny-tolerant outElem.
    // 5 scenarios: happy property-call body, happy concrete body, empty
    // concrete body, body-restriction throw, ValUse-source lambda.
    let scoll_flat_map_fixture = cmds::ergoscript::eval::scoll_flat_map::generate()?;
    write_ergoscript_json("eval/scoll-flat-map.json", &scoll_flat_map_fixture)?;

    // Phase 2g.5 Task 2: SigmaPropBytes Expr arm — prop_bytes serialization.
    let sigma_prop_bytes_fixture = cmds::ergoscript::eval::sigma_prop_bytes::generate()?;
    write_ergoscript_json("eval/sigma-prop-bytes.json", &sigma_prop_bytes_fixture)?;

    // Phase 2i-b T2: SigmaPropIsProven Expr arm — frontend-only structural throw.
    // Captures sigma-rust's `Err(EvalError::Misc(...))` shape at
    // ergotree-interpreter/src/eval/sigma_prop_is_proven.rs:11-25. Per throw-only
    // fixture-gen convention (decode_point.rs::error_entry), no try_eval_out
    // call — TS test asserts only the error code.
    let sigma_prop_is_proven_fixture = cmds::ergoscript::eval::sigma_prop_is_proven::generate()?;
    write_ergoscript_json("eval/sigma-prop-is-proven.json", &sigma_prop_is_proven_fixture)?;

    // Phase 2i-b T3: MultiplyGroup Expr arm — Pattern A Fixed(40), curve "multiply"
    // = point ADDITION under multiplicative notation (ec_point.rs:74-80
    // Mul<&EcPoint> = ProjectivePoint::add). 6 success + 2 throw entries.
    let multiply_group_fixture = cmds::ergoscript::eval::multiply_group::generate()?;
    write_ergoscript_json("eval/multiply-group.json", &multiply_group_fixture)?;

    // Phase 2i-b T4: Exponentiate Expr arm — Pattern A Fixed(900), scalar
    // multiplication (ec_point.rs:111-119; identity-base short-circuit at
    // line 113-118). BigInt256 exponent reduced mod n via dlog_group::
    // bigint256_to_scalar (dlog_group.rs:60-64). 9 success + 2 throw entries.
    let exponentiate_fixture = cmds::ergoscript::eval::exponentiate::generate()?;
    write_ergoscript_json("eval/exponentiate.json", &exponentiate_fixture)?;

    // Phase 2i-b T5: CreateAvlTree Expr arm — no inline cost (children-only).
    // 4-input constructor: Byte flags + Coll[Byte] digest + Int keyLength +
    // Option[Int] valueLength → AvlTreeData. Sigma-rust ref:
    // ergotree-interpreter/src/eval/create_avl_tree.rs:15-41. AvlTreeFlags::parse
    // canonicalizes flags to bits 0..2 (mir/avl_tree_data.rs:32-38).
    // 7 success + 4 throw entries.
    let create_avl_tree_fixture = cmds::ergoscript::eval::create_avl_tree::generate()?;
    write_ergoscript_json("eval/create-avl-tree.json", &create_avl_tree_fixture)?;

    // Phase 2i-b T6: TreeLookup Expr arm — no inline cost (children-only).
    // 3-input verifier delegate: AvlTree + Coll[Byte] key + Coll[Byte] proof
    // → Option[Coll[Byte]]. Sigma-rust ref:
    // ergotree-interpreter/src/eval/tree_lookup.rs:20-65. Double-null semantic:
    // outer null = proof construct fail → 'avl-tree-proof-failed';
    // {value:null} = key absent → Option None.
    // 4 happy + 3 throw entries.
    let tree_lookup_fixture = cmds::ergoscript::eval::tree_lookup::generate()?;
    write_ergoscript_json("eval/tree-lookup.json", &tree_lookup_fixture)?;

    // Phase 2i-c T6: DeserializeContext oracle fixtures (8 scenarios).
    // No inline cost charge; cost arrives via substituted inner Expr's eval.
    // Sigma-rust ref: ergotree-ir/src/mir/expr.rs:442-496 (substitute walker);
    // ergotree-interpreter/src/eval/deserialize_context.rs (tests-only).
    // P2PK 50-cost short-circuit canary (dc_const_sigmaprop_inner) pins the
    // tryTrivialReduceExpr contract on substituted bodies (T8 integration).
    let deserialize_context_fixture =
        cmds::ergoscript::eval::deserialize_context::generate()?;
    write_ergoscript_json(
        "eval/deserialize-context.json",
        &deserialize_context_fixture,
    )?;

    // Phase 2i-c T10: DeserializeRegister oracle fixtures (8 scenarios).
    // Mirrors DC structure but reads ctx.self_box.get_register(reg) instead
    // of ctx.extension.values[id]. Sigma-rust ref:
    // ergotree-ir/src/mir/expr.rs:466-491 (DR branch + tpe check); the
    // "leave node unchanged" branch (expr.rs:478-481) is captured by the
    // dr_throw_no_register_no_default scenario (uses try_eval_out directly
    // to mirror the defensive eval-time throw at eval/expr.rs:102-104).
    let deserialize_register_fixture =
        cmds::ergoscript::eval::deserialize_register::generate()?;
    write_ergoscript_json(
        "eval/deserialize-register.json",
        &deserialize_register_fixture,
    )?;

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
