mod cmds;

use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent().unwrap().join("packages/proof/test/fixtures")
}

fn write_json<T: serde::Serialize>(name: &str, value: &T) -> anyhow::Result<()> {
    let path = fixtures_dir().join(name);
    let json = serde_json::to_string_pretty(value)?;
    std::fs::write(&path, json + "\n")?;
    println!("wrote {}", path.display());
    Ok(())
}

fn main() -> anyhow::Result<()> {
    std::fs::create_dir_all(fixtures_dir())?;
    write_json("vlq.json", &cmds::vlq::generate()?)?;
    write_json("blake2b256.json", &cmds::blake2b::generate()?)?;
    write_json("autolykos_solution.json", &cmds::autolykos_solution::generate()?)?;
    write_json("nbits.json", &cmds::nbits::generate()?)?;
    write_json("header.json", &cmds::header::generate()?)?;
    write_json("batch_merkle.json", &cmds::batch_merkle::generate()?)?;
    write_json("popow_header.json", &cmds::popow_header::generate()?)?;
    write_json("nipopow_proof.json", &cmds::nipopow_proof::generate()?)?;
    write_json("autolykos_v2.json", &cmds::autolykos_v2::generate()?)?;
    write_json("compare.json", &cmds::compare::generate()?)?;
    write_json("envelope.json", &cmds::envelope::generate()?)?;
    Ok(())
}
