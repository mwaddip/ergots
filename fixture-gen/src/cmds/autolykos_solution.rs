use ergo_chain_types::{ec_point, AutolykosSolution, EcPoint};
use serde::Serialize;
use sigma_ser::ScorexSerializable;

#[derive(Serialize)]
pub struct SolutionCase {
    pub miner_pk_hex: String,
    pub pow_onetime_pk_hex: Option<String>,
    pub nonce_hex: String,
    pub pow_distance: Option<String>, // BigInt -> decimal string
    pub bytes_hex: String,
}

pub fn generate() -> anyhow::Result<Vec<SolutionCase>> {
    let pk = Box::new(EcPoint::default());
    let cases = vec![
        AutolykosSolution {
            miner_pk: pk.clone(),
            pow_onetime_pk: None,
            nonce: vec![0u8; 8],
            pow_distance: None,
        },
        AutolykosSolution {
            miner_pk: pk.clone(),
            pow_onetime_pk: None,
            nonce: (1u32.to_be_bytes()).repeat(2),
            pow_distance: None,
        },
        // Case 3: non-identity pk — catches byte-boundary off-by-one bugs in parsers
        // that all-zero pk wouldn't detect. Uses secp256k1 generator G.
        AutolykosSolution {
            miner_pk: Box::new(ec_point::generator()),
            pow_onetime_pk: None,
            nonce: vec![0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89],
            pow_distance: None,
        },
    ];
    cases.into_iter().map(|s| {
        // Serialize using Autolykos v2 format (version=2): minerPk(33) || nonce(8)
        let mut buf: Vec<u8> = Vec::new();
        s.serialize_bytes(2, &mut buf)?;

        Ok(SolutionCase {
            miner_pk_hex: hex::encode(s.miner_pk.scorex_serialize_bytes()?),
            pow_onetime_pk_hex: s.pow_onetime_pk.as_ref()
                .map(|p| Ok::<_, anyhow::Error>(hex::encode(p.scorex_serialize_bytes()?)))
                .transpose()?,
            nonce_hex: hex::encode(&s.nonce),
            pow_distance: s.pow_distance.as_ref().map(|d| d.to_string()),
            bytes_hex: hex::encode(buf),
        })
    }).collect()
}
