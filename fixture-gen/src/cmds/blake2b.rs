use ergo_chain_types::blake2b256_hash;
use serde::Serialize;

#[derive(Serialize)]
pub struct Blake2bCase {
    pub input_hex: String,
    pub output_hex: String,
}

pub fn generate() -> anyhow::Result<Vec<Blake2bCase>> {
    let inputs: Vec<Vec<u8>> = vec![
        vec![],
        vec![0x00],
        b"abc".to_vec(),
        (0u8..255).collect(),
        vec![0xff; 1024],
    ];
    let cases = inputs.into_iter().map(|input| {
        let digest = blake2b256_hash(&input);
        Blake2bCase {
            input_hex: hex::encode(&input),
            output_hex: hex::encode(&digest.0),
        }
    }).collect();
    Ok(cases)
}
