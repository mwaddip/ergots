use ergo_chain_types::{
    autolykos_pow_scheme::{order_bigint, decode_compact_bits, AutolykosPowScheme},
    ADDigest, AutolykosSolution, BlockId, Digest32, EcPoint, Header, Votes,
};
use num_bigint::{BigInt, Sign, ToBigInt};
use serde::Serialize;
use sigma_ser::ScorexSerializable;
use sigma_util::hash::blake2b256_hash;
use std::str::FromStr;

/// One element of the fixture array written to autolykos_v2.json.
///
/// Every field captures an intermediate value on the Autolykos v2 verification
/// path.  The TS implementation must reproduce each field exactly.
#[derive(Serialize)]
pub struct AutolykosCase {
    /// Short label for the test case (used in test names)
    pub label: String,
    /// Full serialised header bytes (hex), ready to feed into parseHeader
    pub header_bytes_hex: String,
    /// blake2b256(serialize_without_pow(header)) – the 32-byte message that
    /// seeds everything
    pub message_hex: String,
    /// 33-byte compressed miner public key (hex)
    pub pk_hex: String,
    /// 8-byte nonce (hex)
    pub nonce_hex: String,
    /// Header height (u32)
    pub height: u32,
    /// n_bits compact encoding (u32)
    pub n_bits: u32,
    /// calc_big_n(version, height)
    pub n_value: u64,
    /// calc_seed_v2 result (32-byte hex)
    pub seed_hex: String,
    /// genIndexes output – 32 u32 values
    pub indices: Vec<u32>,
    /// For each index: blake2b256(idx_be4 ++ height_be4 ++ big_m)[1..] as hex
    /// (31 bytes per entry, treated as big-endian BigInt for sum)
    pub element_hashes_hex: Vec<String>,
    /// Sum of 32 element BigInts, decimal string
    pub sum_decimal: String,
    /// blake2b256(as_unsigned_byte_array(32, sum)) – the final 32-byte PoW hit (hex)
    pub hit_hex: String,
    /// order_bigint / decode_compact_bits(n_bits) – the PoW target, decimal string
    pub target_decimal: String,
    /// True iff hit < target (always true for real mainnet headers)
    pub is_valid: bool,
}

// ---------------------------------------------------------------------------
// Helper: build + verify a Header from raw field data, then capture all
// intermediate Autolykos v2 values.
// ---------------------------------------------------------------------------

fn make_header(
    version: u8,
    parent_id_hex: &str,
    ad_proofs_root_hex: &str,
    transaction_root_hex: &str,
    state_root_hex: &str,
    timestamp: u64,
    n_bits: u32,
    height: u32,
    extension_root_hex: &str,
    miner_pk_hex: &str,
    nonce_hex: &str,
    expected_id_hex: &str,
) -> anyhow::Result<Header> {
    let parent_id = BlockId(Digest32::from_str(parent_id_hex)?);
    let ad_proofs_root = Digest32::from_str(ad_proofs_root_hex)?;
    let transaction_root = Digest32::from_str(transaction_root_hex)?;
    let state_root_bytes = hex::decode(state_root_hex)?;
    let state_root = ADDigest::try_from(state_root_bytes.as_slice())?;
    let extension_root = Digest32::from_str(extension_root_hex)?;
    let miner_pk = EcPoint::from_base16_str(miner_pk_hex.to_string())
        .ok_or_else(|| anyhow::anyhow!("failed to parse miner_pk: {}", miner_pk_hex))?;
    let nonce = hex::decode(nonce_hex)?;

    let mut header = Header {
        version,
        id: BlockId(Digest32::zero()),
        parent_id,
        ad_proofs_root,
        state_root,
        transaction_root,
        timestamp,
        n_bits,
        height,
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

    // Derive ID by round-trip
    let bytes = header.scorex_serialize_bytes()?;
    let reparsed = Header::scorex_parse_bytes(&bytes)?;
    header.id = reparsed.id;

    let got_id = hex::encode(&header.id.0 .0);
    if got_id != expected_id_hex {
        return Err(anyhow::anyhow!(
            "header ID mismatch at height {}: expected {} got {}",
            height,
            expected_id_hex,
            got_id
        ));
    }

    Ok(header)
}

fn make_case(label: &str, h: &Header) -> anyhow::Result<AutolykosCase> {
    let pow = AutolykosPowScheme::default();

    // -- header bytes ---------------------------------------------------------
    let header_bytes = h.scorex_serialize_bytes()?;

    // -- message (serialize_without_pow, then blake2b256) ---------------------
    let without_pow = h.serialize_without_pow()?;
    let msg = blake2b256_hash(&without_pow); // Box<[u8;32]>

    // -- pk (compressed 33 bytes) ---------------------------------------------
    let pk_bytes = h.autolykos_solution.miner_pk.scorex_serialize_bytes()?;

    // -- nonce (8 bytes) -------------------------------------------------------
    let nonce = &h.autolykos_solution.nonce;

    // -- height bytes (4 bytes BE) ---------------------------------------------
    let height_bytes = h.height.to_be_bytes();

    // -- big_n ----------------------------------------------------------------
    let big_n = pow.calc_big_n(h.version, h.height);

    // -- seed -----------------------------------------------------------------
    let seed = pow.calc_seed_v2(big_n, &*msg, nonce, &height_bytes)?;

    // -- indices ---------------------------------------------------------------
    let indices = pow.gen_indexes(&seed, big_n);
    assert_eq!(indices.len(), 32, "gen_indexes must produce 32 elements");

    // -- element hashes -------------------------------------------------------
    // For each index: blake2b256(idx_be4 ++ height_bytes ++ big_m)[1..]
    // (This is what pow_hit_message_v2 does to build f2)
    let big_m = pow.calc_big_m();
    let mut element_hashes_hex = Vec::with_capacity(32);
    let mut f2 = BigInt::from(0u32);
    for &idx in &indices {
        let mut concat = vec![];
        concat.extend_from_slice(&idx.to_be_bytes());
        concat.extend_from_slice(&height_bytes);
        concat.extend(&big_m);
        let hash = blake2b256_hash(&concat);
        // [1..] slice = 31 bytes, interpreted as unsigned big-endian BigInt
        let elem_bi = BigInt::from_bytes_be(Sign::Plus, &hash[1..]);
        f2 += &elem_bi;
        element_hashes_hex.push(hex::encode(&hash[1..]));
    }

    // -- as_unsigned_byte_array + final hit -----------------------------------
    let array = as_unsigned_byte_array_32(f2.clone())?;
    let hit_bytes = blake2b256_hash(&array);
    let hit = num_bigint::BigUint::from_bytes_be(&*hit_bytes);

    // -- target ---------------------------------------------------------------
    let decoded = decode_compact_bits(h.n_bits);
    let target = order_bigint() / decoded;

    // -- validity -------------------------------------------------------------
    let is_valid = hit.to_bigint().unwrap() < target;

    Ok(AutolykosCase {
        label: label.to_string(),
        header_bytes_hex: hex::encode(&header_bytes),
        message_hex: hex::encode(&*msg),
        pk_hex: hex::encode(&pk_bytes),
        nonce_hex: hex::encode(nonce),
        height: h.height,
        n_bits: h.n_bits,
        n_value: big_n as u64,
        seed_hex: hex::encode(&*seed),
        indices,
        element_hashes_hex,
        sum_decimal: f2.to_string(),
        hit_hex: hex::encode(&*hit_bytes),
        target_decimal: target.to_string(),
        is_valid,
    })
}

/// Port of BouncyCastle's BigIntegers::asUnsignedByteArray(32, bigint).
/// Produces exactly 32 bytes (big-endian, zero-padded).
fn as_unsigned_byte_array_32(big_int: BigInt) -> anyhow::Result<Vec<u8>> {
    let length = 32usize;
    let bytes = big_int.to_signed_bytes_be();
    if bytes.len() == length {
        return Ok(bytes);
    }
    let start = usize::from(bytes[0] == 0);
    let count = bytes.len() - start;
    if count > length {
        return Err(anyhow::anyhow!(
            "BigInt too large for 32 bytes: {} bytes needed",
            count
        ));
    }
    let mut res = vec![0u8; length];
    res[(length - count)..].copy_from_slice(&bytes[start..]);
    Ok(res)
}

// ---------------------------------------------------------------------------
// Synthetic zero-modulo case
//
// The Rust gen_indexes has: `.to_u32_digits().1[0]` which panics if modulo == 0.
// In TypeScript we handle it with `result === 0n ? 0 : Number(result)`.
// We construct a seed where EVERY 4-byte window (with wraparound) is a
// multiple of big_n, so all 32 indices should be 0.
//
// n_base = 2^26 = 0x04000000.  A 32-byte seed where each 4-byte window
// equals 0x04000000 does the job:
//   seed = [0x04, 0x00, 0x00, 0x00] × 8 repeated  (32 bytes)
//   extended = seed ++ seed[..3]  (35 bytes)
//   window i (i=0..31): bytes extended[i..i+4]
//   For i=0: [0x04,0x00,0x00,0x00] = 2^26 ≡ 0 mod 2^26 ✓
//   For i=1: [0x00,0x00,0x00,0x04] = 4 ≢ 0 mod 2^26 ✗
//
// That doesn't work for all windows. Instead, a seed of all-zeros:
//   BigInt::from_bytes_be(Sign::Plus, &[0,0,0,0]) = 0 ≡ 0 mod big_n ✓
// This works for ALL windows because they're all zeros.
//
// We include this as a synthetic case — the fixture records indices=[0×32],
// but we compute everything EXCEPT the actual PoW validity (is_valid may be
// anything since the seed is artificial).
// ---------------------------------------------------------------------------

fn make_zero_modulo_case(big_n: u32) -> anyhow::Result<AutolykosCase> {
    let pow = AutolykosPowScheme::default();

    // All-zero seed → every window is 0 → 0 mod big_n = 0 → all indices = 0
    let seed = [0u8; 32];
    let indices = {
        let mut res = vec![0u32; 32];
        // Verify the zero-modulo handling: 0 mod big_n = 0, so each index = 0
        // In Rust this would panic at `.to_u32_digits().1[0]` since digits is empty
        // for BigInt::from(0). In TS we handle with `result === 0n ? 0 : Number(result)`.
        // Here we just set all to 0 since that is the correct answer.
        let mut extended: Vec<u8> = seed.to_vec();
        extended.extend(&seed[..3]);
        for i in 0..32usize {
            let val = BigInt::from_bytes_be(Sign::Plus, &extended[i..i + 4]);
            let modded = val.modpow(&BigInt::from(1u32), &BigInt::from(big_n));
            // modded == 0 here; to_u32_digits returns (Plus, []) for zero
            // The correct index is 0
            let idx = if modded == BigInt::from(0u32) {
                0u32
            } else {
                modded.to_u32_digits().1[0]
            };
            res[i] = idx;
        }
        res
    };

    // Use a dummy height (below increase_start so big_n == n_base)
    let height = 500000u32;
    let height_bytes = height.to_be_bytes();
    let big_m = pow.calc_big_m();
    let mut element_hashes_hex = Vec::with_capacity(32);
    let mut f2 = BigInt::from(0u32);
    for &idx in &indices {
        let mut concat = vec![];
        concat.extend_from_slice(&idx.to_be_bytes());
        concat.extend_from_slice(&height_bytes);
        concat.extend(&big_m);
        let hash = blake2b256_hash(&concat);
        let elem_bi = BigInt::from_bytes_be(Sign::Plus, &hash[1..]);
        f2 += &elem_bi;
        element_hashes_hex.push(hex::encode(&hash[1..]));
    }

    // For synthetic case: compute hit/target using a dummy n_bits.
    // The is_valid field is intentionally unreliable here; the test just
    // checks that indices are all zero (the zero-modulo behavior).
    // We use n_bits=0x02010000 (target = 1) to always be is_valid=false.
    let n_bits = 0x02010000u32;
    let decoded = decode_compact_bits(n_bits);
    let target = if decoded == BigInt::from(0u32) {
        // avoid division by zero
        order_bigint()
    } else {
        order_bigint() / decoded
    };

    let array = as_unsigned_byte_array_32(f2.clone())?;
    let hit_bytes = blake2b256_hash(&array);
    let hit = num_bigint::BigUint::from_bytes_be(&*hit_bytes);
    let is_valid = hit.to_bigint().unwrap() < target;

    Ok(AutolykosCase {
        label: "synthetic-zero-modulo".to_string(),
        header_bytes_hex: "".to_string(), // no real header for this synthetic case
        message_hex: "".to_string(),
        pk_hex: "".to_string(),
        nonce_hex: "".to_string(),
        height,
        n_bits,
        n_value: big_n as u64,
        seed_hex: hex::encode(seed),
        indices,
        element_hashes_hex,
        sum_decimal: f2.to_string(),
        hit_hex: hex::encode(&*hit_bytes),
        target_decimal: target.to_string(),
        is_valid,
    })
}

pub fn generate() -> anyhow::Result<Vec<AutolykosCase>> {
    let pow = AutolykosPowScheme::default();
    let n_base = pow.calc_big_n(2, 0); // = 2^26 = 67108864 for v2 low heights

    let mut cases = Vec::new();

    // -------------------------------------------------------------------------
    // Real mainnet headers (Autolykos v2, version >= 2)
    // All captured from local ergo-node-rust on port 9052, 2026-05-12
    // -------------------------------------------------------------------------

    // Case 1: mainnet height 420000 (version=2, height < 614400, big_n = n_base)
    // GET /blocks/74f136834db828b388dd969ccb621f8059158903918067cca9ce746f415eff02/header
    cases.push(make_case(
        "mainnet-h420000",
        &make_header(
            2,
            "69f4bb5aec68c7d4d501841f1ecea52dad4fed49e033e35da7003324bc81eec3",
            "546a9808dd302f55b23b6948d0c71aea7d0cef0fdb24b5f7130490419fa937a9",
            "d1911820795bae5b836fd244e5fed04d1ba47af9da505d2e539b332c05dc1607",
            "cb12765b168406222b13117434128c8fd1b83cdbd84a9fd08261d03c267c7e2713",
            1613277910681,
            100734821,
            420000,
            "e640a5da07e72c2abbd9b94c71b3d55695e2f9bab9413ab3642cf03dfcfecd84",
            "02ebaaeb381c9d855af1807781fa20ef6c0c34833275ce7913a9e4469f7bcb3bec",
            "02e634b8da8e9f60",
            "74f136834db828b388dd969ccb621f8059158903918067cca9ce746f415eff02",
        )?,
    )?);

    // Case 2: mainnet height 500000 (version=2, height < 614400, big_n = n_base)
    // GET /blocks/0261b8bbe791aa26379c679e22359d21a92bda09abd369b938946d0128eed660/header
    cases.push(make_case(
        "mainnet-h500000",
        &make_header(
            2,
            "b547185e4d69f91b1458202e81d05b0821be9b4a15993305b441ac075b3785d0",
            "21cdc942d307f5c8b3907606d087d3c7168827795151c75f5c055e285cffd2a7",
            "96d763865f6b8a77c8ba974219b045b5e1486b83a8f2a4f56176ca35b1947b79",
            "db8c36dd826cd50defd1f8c95c8bddb44b6285b8c94dbc954e7591aa6474683515",
            1622316365627,
            117919008,
            500000,
            "e707ca7f23c5aae204a6efee62a80da649f5bb65ebfdc4bbd8c448108286a595",
            "02b3a06d6eaa8671431ba1db4dd427a77f75a5c2acbd71bfb725d38adc2b55f669",
            "faf92d0a09b3fbb5",
            "0261b8bbe791aa26379c679e22359d21a92bda09abd369b938946d0128eed660",
        )?,
    )?);

    // Case 3: mainnet height 614400 (version=2, exactly at first N increase)
    // big_n should be 70464240 (per test_calc_big_n)
    // GET /blocks/bc6de9251f1a253d1199bf5764dbee312d6886206940ee56c5a8fce66b9f81da/header
    cases.push(make_case(
        "mainnet-h614400",
        &make_header(
            2,
            "fbb4c0eff63addbca909fbba58ebc410431eea81caec5d949d50c7c3c5663d61",
            "fae7cd7367ba91ddbfdf2ff2c26e0ecf4ddd2f15d97bb72b559b38d93feb0ee4",
            "f51bc1cfe62b921364b2525dedd107add5e90216e8101b43cd0bd362d2285cdf",
            "9f92d5bd5d4b94dc9507bf89435dbe3f7b7524cec0d7c6e032dc8883543416b917",
            1636270880050,
            118024994,
            614400,
            "3cbeea5f15d71e01faf6bc849f417b64aa8e6232ee23dd2e29ca331be51f7ff4",
            "03224c2f2388ae0741be2c50727caa49bd62654dc1f36ee72392b187b78da2c717",
            "0bb19645dfb3351a",
            "bc6de9251f1a253d1199bf5764dbee312d6886206940ee56c5a8fce66b9f81da",
        )?,
    )?);

    // Case 4: mainnet height 1000000 (version=3, higher N)
    // GET /blocks/f04085962f306d8e4ee9f1a415abb82c32ac6a183d4d286e995569c978a7c5cb/header
    cases.push(make_case(
        "mainnet-h1000000",
        &make_header(
            3,
            "eaf3168103a2f0304e3d6cbf621163fcf5877509a9fb39eeb3948a59f6f8d96c",
            "5615575b1afa0be7ce825c2aeb210e4157c37bfa351276388cb0f5ef10498245",
            "842c5b47f466e52eb48c2476774ab27f166eccafe069f1e536d7c9a02cf7951d",
            "7c61ff847e4837eb8b445be6f34673850e9f6917b8b0a3492ca57622b2f9f82c19",
            1683634223508,
            118205088,
            1000000,
            "367ea050a780669223476b7c43a1a5d07b8b0e7dfb508ac10ac93814d4bcd78f",
            "03677d088e4958aedcd5cd65845540e91272eba99e4d98e382f5ae2351e0dfbefd",
            "cd36b2015e53697f",
            "f04085962f306d8e4ee9f1a415abb82c32ac6a183d4d286e995569c978a7c5cb",
        )?,
    )?);

    // Case 5: mainnet height 1400000 (version=3, near tip)
    // GET /blocks/a9d9bb99118fd79915002f0ccbda3a596fb1938a8d7d2bdbda460ec7436e2ae2/header
    cases.push(make_case(
        "mainnet-h1400000",
        &make_header(
            3,
            "3df799b8e89e9d8e6fe5609c73f1058bedb836ed016180234818d264336f47be",
            "9a7299840494038c7aba6cd3f1faecf197b970dc9b6aa06c09cb23142c71ac37",
            "efeddfd2de08518e59d85b4306b3cba9093d4774af537704bb0dab9c5786eab2",
            "4a37119ac3a774538b82f698ba3237104b48ec017e45a1f4d7345ff0ecfd382819",
            1732124129815,
            117716363,
            1400000,
            "436b01b2cd9467a4499bf940691245bb6f13e0618f3bba14ee6429640f1b9b02",
            "030ab3e89183caae079bc07685e0ac5b3adc6d40a3e9112fe56e22c655bd41d4da",
            "e21669cb1e6e8d3b",
            "a9d9bb99118fd79915002f0ccbda3a596fb1938a8d7d2bdbda460ec7436e2ae2",
        )?,
    )?);

    // -------------------------------------------------------------------------
    // Synthetic: zero-modulo case
    // Exercises the path where (4-byte window) mod big_n == 0, which would
    // panic in Rust's `to_u32_digits().1[0]` but must return 0 in TS.
    // -------------------------------------------------------------------------
    cases.push(make_zero_modulo_case(n_base)?);

    Ok(cases)
}
