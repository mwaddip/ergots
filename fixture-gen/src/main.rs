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
    Ok(())
}
