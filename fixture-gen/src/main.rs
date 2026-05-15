mod cmds;

use std::path::{Path, PathBuf};

fn proof_fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent().unwrap().join("packages/proof/test/fixtures")
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
    std::fs::create_dir_all(proof_fixtures_dir())?;
    std::fs::create_dir_all(ergoscript_fixtures_dir())?;

    // Proof package (@mwaddip/ergots-proof) fixtures.
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

    // Ergoscript package (@mwaddip/ergots-ergoscript) synthetic fixtures.
    write_ergoscript_json("synthetic_stype.json", &cmds::ergoscript::synthetic_stype::generate()?)?;
    write_ergoscript_json("synthetic_svalue.json", &cmds::ergoscript::synthetic_svalue::generate()?)?;
    write_ergoscript_json("synthetic_expr.json", &cmds::ergoscript::synthetic_expr::generate()?)?;

    // Ergoscript real-world corpora (Task 29).
    write_ergoscript_json("corpus_legacy_45.json", &cmds::ergoscript::corpus_legacy_45::generate()?)?;
    write_ergoscript_json("corpus_ecosystem_14.json", &cmds::ergoscript::corpus_ecosystem_14::generate()?)?;
    write_ergoscript_json("corpus_significant_15.json", &cmds::ergoscript::corpus_significant_15::generate()?)?;
    write_ergoscript_json("mainnet_boxes.json", &cmds::ergoscript::mainnet_boxes::generate()?)?;

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

    Ok(())
}
