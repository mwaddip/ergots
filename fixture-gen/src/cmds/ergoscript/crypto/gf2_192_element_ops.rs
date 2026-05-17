//! Cross-validation fixtures for `Gf2_192Element` element arithmetic
//! (phase 2g-combinators Task 2).
//!
//! Drives sigma-rust's `gf2_192::Gf2_192` reference implementation through a
//! deterministic suite of element-level operations (`add`, `multiply`, `sqr`,
//! `invert`, `equals`, `from_bytes`, `to_bytes`) and serializes the resulting
//! 24-byte values as hex. The TS test under
//! `packages/ergoscript/test/crypto/gf2_192-element.test.ts` loads this JSON
//! and asserts byte-for-byte equality of the pure-TS port.
//!
//! Source: `~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192.rs`
//! (HEAD ed5452cf, branch `integration/ergots`).
//!
//! Determinism: every test vector is hard-coded as a literal byte pattern.
//! No OS randomness; the same byte sequences are used on every fixture-gen run
//! so the two-run diff is empty.

use anyhow::Result;
use gf2_192::gf2_192::Gf2_192;
use serde::Serialize;

#[derive(Serialize)]
pub struct ElementOpFixture {
    pub name: String,
    /// Operation: "add" | "multiply" | "sqr" | "invert" | "equals"
    ///          | "from_bytes" | "to_bytes" | "round_trip"
    pub op: String,
    /// Hex-encoded 24-byte operands (one entry for unary ops, two for binary).
    pub inputs: Vec<String>,
    /// Hex-encoded 24-byte output, or "true"/"false" for `equals`.
    pub expected: String,
}

/// Convert sigma-rust's `Gf2_192` to the canonical 24-byte little-endian-per-word
/// representation (the same layout `From<Gf2_192> for [u8; 24]` produces).
fn to_24_hex(e: Gf2_192) -> String {
    let bytes: [u8; 24] = e.into();
    hex::encode(bytes)
}

/// Inverse of `to_24_hex` — decode a 24-byte hex string into a `Gf2_192`.
fn from_24_hex(s: &str) -> Gf2_192 {
    let bytes = hex::decode(s).expect("hex");
    assert_eq!(bytes.len(), 24, "Gf2_192 input must be 24 bytes");
    let mut arr = [0u8; 24];
    arr.copy_from_slice(&bytes);
    Gf2_192::from(arr)
}

/// Hardcoded byte patterns we use across the suite. Picked to exercise edge
/// cases: zero, one (low-bit-only), high-bit-only-of-word0, high-bit-only-of-word2
/// (forces reduction), and three mixed pseudo-random patterns.
fn samples() -> Vec<(&'static str, &'static str)> {
    vec![
        ("zero", "000000000000000000000000000000000000000000000000"),
        ("one",  "010000000000000000000000000000000000000000000000"),
        // High bit of word[0] only: byte 7 = 0x80.
        ("hi_word0", "000000000000008000000000000000000000000000000000"),
        // High bit of word[2] only: byte 23 = 0x80. Multiplying by x raises reduction.
        ("hi_word2", "000000000000000000000000000000000000000000000080"),
        // Two distinct nibble-shifted patterns to exercise the 4-bit table.
        ("pat_a", "0123456789abcdef0123456789abcdef0123456789abcdef"),
        ("pat_b", "fedcba9876543210fedcba9876543210fedcba9876543210"),
        // Mixed pattern with set bits across all three words (48 hex = 24 bytes).
        ("pat_c", "deadbeefcafef00d1122334455667788aabbccddee001122"),
        // Pattern with bit 191 set (high bit of last byte / word[2]).
        // 0x8000...0001
        ("pat_d", "010000000000000000000000000000000000000000000080"),
        // Pattern that triggers many reductions: all 0xff.
        ("ones", "ffffffffffffffffffffffffffffffffffffffffffffffff"),
        // Single-byte set on word boundary.
        ("byte8_set", "000000000000000001000000000000000000000000000000"),
        ("byte16_set", "000000000000000000000000000000000100000000000000"),
    ]
}

pub fn generate() -> Result<Vec<ElementOpFixture>> {
    // Use a few key samples for cross-product testing; full pairwise would be 110 entries.
    let s = samples();

    let mut out = Vec::new();

    // ----- add (~10) — additive identity, self-cancellation, random pairs -----
    let pairs_add = [
        ("zero", "zero"),
        ("zero", "pat_a"),
        ("pat_a", "zero"),
        ("pat_a", "pat_a"), // x + x = 0
        ("pat_a", "pat_b"),
        ("pat_b", "pat_a"), // commutative
        ("pat_c", "pat_d"),
        ("ones", "pat_a"),
        ("hi_word0", "hi_word2"),
        ("byte8_set", "byte16_set"),
    ];
    for (na, nb) in pairs_add {
        let a = from_24_hex(s.iter().find(|(n, _)| *n == na).unwrap().1);
        let b = from_24_hex(s.iter().find(|(n, _)| *n == nb).unwrap().1);
        let c = a + b;
        out.push(ElementOpFixture {
            name: format!("add/{}+{}", na, nb),
            op: "add".to_string(),
            inputs: vec![to_24_hex(a), to_24_hex(b)],
            expected: to_24_hex(c),
        });
    }

    // ----- multiply (~25) — zero, one, self, edge values, random pairs -----
    let pairs_mul = [
        ("zero", "pat_a"),
        ("pat_a", "zero"),
        ("one", "pat_a"),
        ("pat_a", "one"),
        ("one", "one"),
        ("pat_a", "pat_a"),
        ("pat_a", "pat_b"),
        ("pat_b", "pat_a"), // commutative
        ("pat_a", "pat_c"),
        ("pat_b", "pat_c"),
        ("pat_c", "pat_d"),
        ("hi_word0", "pat_a"),
        ("hi_word2", "pat_a"), // forces reduction
        ("hi_word2", "hi_word2"),
        ("ones", "ones"),
        ("ones", "one"),
        ("ones", "pat_a"),
        ("pat_d", "pat_d"),
        ("pat_d", "pat_a"),
        ("byte8_set", "byte16_set"),
        ("byte8_set", "byte8_set"),
        ("byte16_set", "byte16_set"),
        ("pat_a", "pat_d"),
        ("pat_c", "pat_a"),
        ("pat_c", "pat_b"),
    ];
    for (na, nb) in pairs_mul {
        let a = from_24_hex(s.iter().find(|(n, _)| *n == na).unwrap().1);
        let b = from_24_hex(s.iter().find(|(n, _)| *n == nb).unwrap().1);
        let c = a * b;
        out.push(ElementOpFixture {
            name: format!("multiply/{}*{}", na, nb),
            op: "multiply".to_string(),
            inputs: vec![to_24_hex(a), to_24_hex(b)],
            expected: to_24_hex(c),
        });
    }

    // ----- sqr (~10) — squaring is bit-interleave + reduction -----
    let sqr_names = [
        "zero", "one", "hi_word0", "hi_word2", "pat_a", "pat_b", "pat_c", "pat_d",
        "ones", "byte8_set",
    ];
    for n in sqr_names {
        let a = from_24_hex(s.iter().find(|(nn, _)| *nn == n).unwrap().1);
        let c = Gf2_192::sqr(a);
        out.push(ElementOpFixture {
            name: format!("sqr/{}", n),
            op: "sqr".to_string(),
            inputs: vec![to_24_hex(a)],
            expected: to_24_hex(c),
        });
        // Cross-check sqr against multiply self-multiply.
        let alt = a * a;
        assert_eq!(c, alt, "sqr({}) must equal {} * {} at fixture-gen time", n, n, n);
    }

    // ----- invert (~10) — invert(1)=1; x*invert(x)=1 for nonzero x -----
    let inv_names = [
        "one", "hi_word0", "hi_word2", "pat_a", "pat_b", "pat_c", "pat_d",
        "ones", "byte8_set", "byte16_set",
    ];
    for n in inv_names {
        let a = from_24_hex(s.iter().find(|(nn, _)| *nn == n).unwrap().1);
        let inv = Gf2_192::invert(a);
        // Cross-check x * invert(x) == 1 at fixture-gen time.
        let prod = a * inv;
        assert!(
            prod.is_one(),
            "invert({}): expected x*invert(x)=1 but got {:?}",
            n,
            prod
        );
        out.push(ElementOpFixture {
            name: format!("invert/{}", n),
            op: "invert".to_string(),
            inputs: vec![to_24_hex(a)],
            expected: to_24_hex(inv),
        });
    }

    // ----- equals (~10) — trivially equal, trivially not-equal, byte-level diffs -----
    let eq_pairs: Vec<(&str, &str, bool)> = vec![
        ("zero", "zero", true),
        ("one", "one", true),
        ("pat_a", "pat_a", true),
        ("zero", "one", false),
        ("one", "zero", false),
        ("pat_a", "pat_b", false),
        ("hi_word0", "hi_word2", false),
        ("ones", "ones", true),
        ("pat_c", "pat_d", false),
        ("byte8_set", "byte16_set", false),
    ];
    for (na, nb, exp) in eq_pairs {
        let a = from_24_hex(s.iter().find(|(n, _)| *n == na).unwrap().1);
        let b = from_24_hex(s.iter().find(|(n, _)| *n == nb).unwrap().1);
        let actual = a == b;
        assert_eq!(actual, exp, "equals oracle mismatch: {} == {}", na, nb);
        out.push(ElementOpFixture {
            name: format!("equals/{}=={}", na, nb),
            op: "equals".to_string(),
            inputs: vec![to_24_hex(a), to_24_hex(b)],
            expected: if exp { "true".to_string() } else { "false".to_string() },
        });
    }

    // ----- from_bytes / to_bytes (~10) — round-trip identity -----
    let rt_names = [
        "zero", "one", "hi_word0", "hi_word2", "pat_a", "pat_b", "pat_c",
        "pat_d", "ones", "byte8_set",
    ];
    for n in rt_names {
        let hex = s.iter().find(|(nn, _)| *nn == n).unwrap().1;
        // Decode via sigma-rust then re-encode; the result must equal the input.
        let a = from_24_hex(hex);
        let out_hex = to_24_hex(a);
        assert_eq!(out_hex, hex, "round-trip {} mismatch at fixture-gen", n);
        out.push(ElementOpFixture {
            name: format!("round_trip/{}", n),
            op: "round_trip".to_string(),
            inputs: vec![hex.to_string()],
            expected: out_hex,
        });
    }

    Ok(out)
}
