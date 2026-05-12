use ergo_chain_types::{
    ADDigest, AutolykosSolution, BlockId, Digest32, EcPoint, Header, Votes,
};
use serde::Serialize;
use sigma_ser::ScorexSerializable;
use std::str::FromStr;

#[derive(Serialize)]
pub struct HeaderCase {
    pub label: String,
    pub bytes_hex: String,
    pub id_hex: String,
    pub height: u32,
    pub n_bits: u64,
    pub timestamp: u64,
    pub parent_id_hex: String,
    pub extension_root_hex: String,
    pub version: u8,
}

/// Build a synthetic header using the same pattern as
/// `ergo-node-rust/chain/src/nipopow_proof.rs:324-355`.
fn make_synthetic_header(
    height: u32,
    parent_id: BlockId,
    timestamp: u64,
    n_bits: u32,
) -> Header {
    let zero32 = Digest32::zero();
    let mut header = Header {
        version: 2,
        id: BlockId(Digest32::zero()),
        parent_id,
        ad_proofs_root: zero32,
        state_root: ADDigest::zero(),
        transaction_root: zero32,
        timestamp,
        n_bits,
        height,
        extension_root: zero32,
        autolykos_solution: AutolykosSolution {
            miner_pk: Box::new(EcPoint::default()),
            pow_onetime_pk: None,
            nonce: height.to_be_bytes().repeat(2),
            pow_distance: None,
        },
        votes: Votes([0, 0, 0]),
        unparsed_bytes: Box::new([]),
    };
    // Serialize then re-parse to trigger ID derivation (blake2b256 of all bytes)
    let bytes = header.scorex_serialize_bytes().unwrap();
    let reparsed = Header::scorex_parse_bytes(&bytes).unwrap();
    header.id = reparsed.id;
    header
}

fn header_case(label: &str, h: &Header) -> anyhow::Result<HeaderCase> {
    let bytes = h.scorex_serialize_bytes()?;
    Ok(HeaderCase {
        label: label.to_string(),
        bytes_hex: hex::encode(&bytes),
        id_hex: hex::encode(&h.id.0 .0),
        height: h.height,
        n_bits: h.n_bits as u64,
        timestamp: h.timestamp,
        parent_id_hex: hex::encode(&h.parent_id.0 .0),
        extension_root_hex: hex::encode(&h.extension_root.0),
        version: h.version,
    })
}

/// Build the mainnet header at height 1_000_000 field-by-field.
///
/// Source JSON captured from local ergo-node-rust on port 9052 (2026-05-12):
/// GET /blocks/f04085962f306d8e4ee9f1a415abb82c32ac6a183d4d286e995569c978a7c5cb/header
/// {
///   "version":3,
///   "id":"f04085962f306d8e4ee9f1a415abb82c32ac6a183d4d286e995569c978a7c5cb",
///   "parentId":"eaf3168103a2f0304e3d6cbf621163fcf5877509a9fb39eeb3948a59f6f8d96c",
///   "adProofsRoot":"5615575b1afa0be7ce825c2aeb210e4157c37bfa351276388cb0f5ef10498245",
///   "stateRoot":"7c61ff847e4837eb8b445be6f34673850e9f6917b8b0a3492ca57622b2f9f82c19",
///   "transactionsRoot":"842c5b47f466e52eb48c2476774ab27f166eccafe069f1e536d7c9a02cf7951d",
///   "timestamp":1683634223508,
///   "nBits":118205088,
///   "height":1000000,
///   "extensionHash":"367ea050a780669223476b7c43a1a5d07b8b0e7dfb508ac10ac93814d4bcd78f",
///   "powSolutions":{"pk":"03677d088e4958aedcd5cd65845540e91272eba99e4d98e382f5ae2351e0dfbefd","w":null,"n":"cd36b2015e53697f","d":null},
///   "votes":"000000",
///   "unparsedBytes":""
/// }
///
/// This is Autolykos v2 (version >= 2), so pow_onetime_pk and pow_distance are None.
fn make_mainnet_header() -> anyhow::Result<Header> {
    let miner_pk_hex = "03677d088e4958aedcd5cd65845540e91272eba99e4d98e382f5ae2351e0dfbefd";
    let miner_pk = EcPoint::from_base16_str(miner_pk_hex.to_string())
        .ok_or_else(|| anyhow::anyhow!("failed to parse miner_pk"))?;

    let nonce = hex::decode("cd36b2015e53697f")?;

    let parent_id = BlockId(Digest32::from_str("eaf3168103a2f0304e3d6cbf621163fcf5877509a9fb39eeb3948a59f6f8d96c")?);
    let ad_proofs_root = Digest32::from_str("5615575b1afa0be7ce825c2aeb210e4157c37bfa351276388cb0f5ef10498245")?;
    // stateRoot is 33 bytes (ADDigest = Digest<33>)
    let state_root_bytes = hex::decode("7c61ff847e4837eb8b445be6f34673850e9f6917b8b0a3492ca57622b2f9f82c19")?;
    let state_root = ADDigest::try_from(state_root_bytes.as_slice())?;
    let transaction_root = Digest32::from_str("842c5b47f466e52eb48c2476774ab27f166eccafe069f1e536d7c9a02cf7951d")?;
    let extension_root = Digest32::from_str("367ea050a780669223476b7c43a1a5d07b8b0e7dfb508ac10ac93814d4bcd78f")?;

    let mut header = Header {
        version: 3,
        id: BlockId(Digest32::zero()), // will be computed
        parent_id,
        ad_proofs_root,
        state_root,
        transaction_root,
        timestamp: 1_683_634_223_508,
        n_bits: 118_205_088,
        height: 1_000_000,
        extension_root,
        autolykos_solution: AutolykosSolution {
            miner_pk: Box::new(miner_pk),
            pow_onetime_pk: None,
            nonce,
            pow_distance: None,
        },
        votes: Votes([0, 0, 0]),
        unparsed_bytes: Box::new([]),
    };

    // Derive the ID by serialize + re-parse
    let bytes = header.scorex_serialize_bytes()?;
    let reparsed = Header::scorex_parse_bytes(&bytes)?;
    header.id = reparsed.id;

    // Verify against the known block ID
    let expected_id = "f04085962f306d8e4ee9f1a415abb82c32ac6a183d4d286e995569c978a7c5cb";
    let got_id = hex::encode(&header.id.0 .0);
    if got_id != expected_id {
        return Err(anyhow::anyhow!(
            "mainnet header ID mismatch: expected {} got {}",
            expected_id,
            got_id
        ));
    }

    Ok(header)
}

pub fn generate() -> anyhow::Result<Vec<HeaderCase>> {
    // --- Synthetic case 1: height 1 ---
    let genesis_parent = BlockId(Digest32::zero());
    let h1 = make_synthetic_header(1, genesis_parent, 1_000_000, 117_586_360);
    let case1 = header_case("synthetic-h1", &h1)?;

    // --- Synthetic case 2: height 10, parent = h1.id ---
    let h10 = make_synthetic_header(10, h1.id, 1_000_000 + 9 * 45_000, 117_586_360);
    let case2 = header_case("synthetic-h10", &h10)?;

    // --- Mainnet case: height 1_000_000 ---
    let mainnet = make_mainnet_header()?;
    let case3 = header_case("mainnet-h1000000", &mainnet)?;

    Ok(vec![case1, case2, case3])
}
