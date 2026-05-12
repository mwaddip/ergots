use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent().unwrap().join("packages/proof/test/fixtures")
}

fn main() -> anyhow::Result<()> {
    let out = fixtures_dir();
    std::fs::create_dir_all(&out)?;
    println!("fixture-gen: writing to {}", out.display());
    Ok(())
}
