use ergo_chain_types::autolykos_pow_scheme::decode_compact_bits;
use serde::Serialize;

#[derive(Serialize)]
pub struct NBitsCase {
    pub n_bits: u32,
    pub target_decimal: String,
}

pub fn generate() -> anyhow::Result<Vec<NBitsCase>> {
    // n_bits values seen in testnet/mainnet, plus edge cases.
    let inputs: Vec<u32> = vec![
        0x1d00ffff, // bitcoin genesis target (classic)
        0x1b0404cb,
        0x18000000, // mantissa zero with large exponent
        0x21010000, // large exponent
        0x01000000, // exponent == 1 (size < 3), mantissa fully shifted out
        0x027f1234, // exponent == 2, non-zero mantissa (sign bit clear) exercises size<3 path
        0x03000000, // exponent == 3 (no shift), mantissa is zero
    ];
    inputs
        .into_iter()
        .map(|n| {
            let target = decode_compact_bits(n);
            Ok(NBitsCase {
                n_bits: n,
                target_decimal: target.to_string(),
            })
        })
        .collect()
}
