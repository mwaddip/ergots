//! Cross-validation fixtures for `Gf2_192Poly` polynomial operations
//! (phase 2g-combinators Task 3).
//!
//! Drives sigma-rust's `gf2_192::gf2_192poly::Gf2_192Poly` reference
//! implementation through a deterministic suite of polynomial operations
//! (`interpolate`, `evaluate`, `to_bytes`, `from_coefficients_and_constant`
//! round-trip). The TS test under
//! `packages/ergoscript/test/crypto/gf2_192-poly.test.ts` loads this JSON
//! and asserts byte-for-byte equality of the pure-TS port.
//!
//! Source: `~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192poly.rs`
//! (HEAD ed5452cf, branch `integration/ergots`).
//!
//! Determinism: every test vector is hard-coded as a literal byte pattern.
//! No OS randomness; the same byte sequences are used on every fixture-gen
//! run so the two-run diff is empty.

use anyhow::Result;
use gf2_192::gf2_192::Gf2_192;
use gf2_192::gf2_192poly::{CoefficientsByteRepr, Gf2_192Poly};
use serde::Serialize;

#[derive(Serialize)]
pub struct PolyOpFixture {
    pub name: String,
    /// Operation: "interpolate" | "evaluate" | "to_bytes" | "from_coeffs_and_const"
    pub op: String,
    pub inputs: PolyInputs,
    /// Hex-encoded expected output.
    /// - "interpolate" / "to_bytes": `degree * 24` bytes of non-constant coefficients.
    /// - "evaluate" / "from_coeffs_and_const": the 24-byte evaluation result.
    pub expected: String,
}

#[derive(Serialize, Default)]
pub struct PolyInputs {
    /// Distinct nonzero u8 points (for `interpolate`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<u8>>,
    /// 24-byte hex values, one per point (for `interpolate`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values_hex: Option<Vec<String>>,
    /// 24-byte hex value of `value_at_zero` (or, for `evaluate`/round-trip,
    /// the constant coefficient passed via the reader path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_at_zero_hex: Option<String>,
    /// For `evaluate` and `from_coeffs_and_const`: hex bytes for the
    /// non-constant coefficients (`(degree * 24)` bytes total).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poly_bytes_hex: Option<String>,
    /// For `evaluate` and `from_coeffs_and_const`: u8 point at which to
    /// evaluate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_point: Option<u8>,
}

/// Convert sigma-rust's `Gf2_192` to the canonical 24-byte little-endian-per-word
/// representation.
fn to_24_hex(e: Gf2_192) -> String {
    let bytes: [u8; 24] = e.into();
    hex::encode(bytes)
}

/// Decode a 24-byte hex string into a `Gf2_192`.
fn from_24_hex(s: &str) -> Gf2_192 {
    let bytes = hex::decode(s).expect("hex");
    assert_eq!(bytes.len(), 24, "Gf2_192 input must be 24 bytes");
    let mut arr = [0u8; 24];
    arr.copy_from_slice(&bytes);
    Gf2_192::from(arr)
}

/// Hard-coded 24-byte hex patterns reused across the suite.
/// All distinct, chosen to exercise edges: zero, one, high-bit-set,
/// nibble-shifted, all-ones, etc.
fn sample(name: &str) -> &'static str {
    match name {
        "zero" => "000000000000000000000000000000000000000000000000",
        "one" => "010000000000000000000000000000000000000000000000",
        "v1" => "0123456789abcdef0123456789abcdef0123456789abcdef",
        "v2" => "fedcba9876543210fedcba9876543210fedcba9876543210",
        "v3" => "deadbeefcafef00d1122334455667788aabbccddee001122",
        "v4" => "0011223344556677889900aabbccddeeff00112233445566",
        "v5" => "abababababababababababababababababababababababab",
        "v6" => "ffffffffffffffffffffffffffffffffffffffffffffffff",
        "v7" => "0102030405060708091011121314151617181920212223ff",
        "v8" => "8000000000000080000000000000008000000000000000ff",
        _ => panic!("unknown sample name: {}", name),
    }
}

pub fn generate() -> Result<Vec<PolyOpFixture>> {
    let mut out = Vec::new();

    // -----------------------------------------------------------------------
    // Section 1: interpolate (~8 entries)
    // -----------------------------------------------------------------------
    // Build polynomials of varying degree via Lagrange interpolation, then
    // serialize their non-constant coefficients as the `expected`.
    //
    // Each entry: (case_name, points, value_names, value_at_zero_name).
    // The resulting expected bytes are `degree * 24` long, where
    // `degree == points.len()` (the (0, value_at_zero) point also contributes
    // and is what makes degree equal to the number of nonzero points).

    let interp_cases: Vec<(&str, Vec<u8>, Vec<&str>, &str)> = vec![
        // Degree-1: a single nonzero point + value_at_zero=zero (=> constant=0,
        // linear polynomial with two coefficients but only one serialized).
        ("interp/deg1_a", vec![1], vec!["v1"], "zero"),
        // Degree-1 with nonzero value_at_zero.
        ("interp/deg1_b", vec![5], vec!["v2"], "v3"),
        // Degree-2.
        ("interp/deg2", vec![1, 2], vec!["v1", "v2"], "v3"),
        // Degree-3.
        ("interp/deg3", vec![3, 7, 11], vec!["v1", "v2", "v3"], "v4"),
        // Degree-5 with value_at_zero=zero.
        (
            "interp/deg5_zero_const",
            vec![1, 2, 3, 4, 5],
            vec!["v1", "v2", "v3", "v4", "v5"],
            "zero",
        ),
        // Degree-5 with nonzero value_at_zero.
        (
            "interp/deg5",
            vec![10, 20, 30, 40, 50],
            vec!["v1", "v2", "v3", "v4", "v5"],
            "v6",
        ),
        // Degree-8 covering wider point spread (forces several reductions).
        (
            "interp/deg8",
            vec![1, 4, 9, 16, 25, 100, 200, 255],
            vec!["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"],
            "v3",
        ),
        // Empty points => constant polynomial = value_at_zero. Serialized
        // bytes are empty (degree == 0, so degree * 24 == 0).
        ("interp/empty", vec![], vec![], "v3"),
    ];

    for (name, points, value_names, vaz_name) in &interp_cases {
        let values: Vec<Gf2_192> = value_names
            .iter()
            .map(|n| from_24_hex(sample(n)))
            .collect();
        let value_at_zero = from_24_hex(sample(vaz_name));
        let poly = Gf2_192Poly::interpolate(points, &values, value_at_zero)
            .expect("interpolate should not fail");

        let expected = hex::encode(poly.to_bytes());

        // Cross-validation gate at fixture-gen time: the polynomial must pass
        // through (0, value_at_zero) and every (points[i], values[i]).
        assert_eq!(
            poly.evaluate(0),
            value_at_zero,
            "{}: poly.evaluate(0) != value_at_zero",
            name
        );
        for i in 0..points.len() {
            assert_eq!(
                poly.evaluate(points[i]),
                values[i],
                "{}: poly.evaluate(points[{}]) != values[{}]",
                name,
                i,
                i
            );
        }

        out.push(PolyOpFixture {
            name: (*name).to_string(),
            op: "interpolate".to_string(),
            inputs: PolyInputs {
                points: Some(points.clone()),
                values_hex: Some(value_names.iter().map(|n| sample(n).to_string()).collect()),
                value_at_zero_hex: Some(sample(vaz_name).to_string()),
                ..Default::default()
            },
            expected,
        });
    }

    // -----------------------------------------------------------------------
    // Section 2: evaluate (~10 entries)
    // -----------------------------------------------------------------------
    // For two reference polynomials (built via interpolate), evaluate at
    // points 0, points[i] (must return values[i]), and several other points
    // including 0/u8::MAX/middle/just-past-last-point. Polynomial provided as
    // a (constant_hex, more_coeffs_hex) pair plus eval_point.

    struct EvalCase {
        name_prefix: &'static str,
        points: Vec<u8>,
        value_names: Vec<&'static str>,
        vaz_name: &'static str,
        eval_points: Vec<u8>,
    }

    let eval_cases = vec![
        // Degree-3 polynomial; evaluate at 0, each interpolated point, and a
        // few extrapolation points.
        EvalCase {
            name_prefix: "eval/deg3",
            points: vec![3, 7, 11],
            value_names: vec!["v1", "v2", "v3"],
            vaz_name: "v4",
            eval_points: vec![0, 3, 7, 11, 1, 50, 255],
        },
        // Degree-5 polynomial with zero const.
        EvalCase {
            name_prefix: "eval/deg5_zero_const",
            points: vec![1, 2, 3, 4, 5],
            value_names: vec!["v1", "v2", "v3", "v4", "v5"],
            vaz_name: "zero",
            eval_points: vec![0, 1, 2, 3, 4, 5, 6, 254],
        },
    ];

    for case in &eval_cases {
        let values: Vec<Gf2_192> = case
            .value_names
            .iter()
            .map(|n| from_24_hex(sample(n)))
            .collect();
        let value_at_zero = from_24_hex(sample(case.vaz_name));
        let poly = Gf2_192Poly::interpolate(&case.points, &values, value_at_zero)
            .expect("interpolate should not fail");
        let poly_bytes_hex = hex::encode(poly.to_bytes());
        let constant_hex = sample(case.vaz_name).to_string();

        for &ep in &case.eval_points {
            let result = poly.evaluate(ep);
            out.push(PolyOpFixture {
                name: format!("{}/at_{}", case.name_prefix, ep),
                op: "evaluate".to_string(),
                inputs: PolyInputs {
                    value_at_zero_hex: Some(constant_hex.clone()),
                    poly_bytes_hex: Some(poly_bytes_hex.clone()),
                    eval_point: Some(ep),
                    ..Default::default()
                },
                expected: to_24_hex(result),
            });
        }
    }

    // -----------------------------------------------------------------------
    // Section 3: to_bytes (~5 entries)
    // -----------------------------------------------------------------------
    // The interpolate cases above ALREADY assert `to_bytes()` output via the
    // `expected` field. Add a few explicit `to_bytes` entries built from
    // polynomials of varying degree to document the surface area separately.

    let tb_cases: Vec<(&str, Vec<u8>, Vec<&str>, &str)> = vec![
        ("to_bytes/deg1", vec![7], vec!["v1"], "v2"),
        ("to_bytes/deg2", vec![1, 250], vec!["v2", "v3"], "v4"),
        ("to_bytes/deg4", vec![1, 2, 3, 4], vec!["v1", "v2", "v3", "v4"], "v5"),
        (
            "to_bytes/deg7",
            vec![1, 2, 3, 4, 5, 6, 7],
            vec!["v1", "v2", "v3", "v4", "v5", "v6", "v7"],
            "zero",
        ),
        ("to_bytes/deg0", vec![], vec![], "v6"),
    ];

    for (name, points, value_names, vaz_name) in &tb_cases {
        let values: Vec<Gf2_192> = value_names
            .iter()
            .map(|n| from_24_hex(sample(n)))
            .collect();
        let value_at_zero = from_24_hex(sample(vaz_name));
        let poly = Gf2_192Poly::interpolate(points, &values, value_at_zero)
            .expect("interpolate should not fail");

        out.push(PolyOpFixture {
            name: (*name).to_string(),
            op: "to_bytes".to_string(),
            inputs: PolyInputs {
                points: Some(points.clone()),
                values_hex: Some(value_names.iter().map(|n| sample(n).to_string()).collect()),
                value_at_zero_hex: Some(sample(vaz_name).to_string()),
                ..Default::default()
            },
            expected: hex::encode(poly.to_bytes()),
        });
    }

    // -----------------------------------------------------------------------
    // Section 4: from_coeffs_and_const round-trip (~2+ entries)
    // -----------------------------------------------------------------------
    // Serialize a polynomial via `to_bytes`, deserialize via
    // `CoefficientsByteRepr::try_from` (the sigma-rust verifier path), then
    // evaluate at an arbitrary point and assert the result matches direct
    // evaluation on the original polynomial. The fixture asserts the eval
    // result; the TS test parses (poly_bytes, value_at_zero) and evaluates,
    // which should match.

    let rt_cases: Vec<(&str, Vec<u8>, Vec<&str>, &str, u8)> = vec![
        ("rt/deg3_at_42", vec![3, 7, 11], vec!["v1", "v2", "v3"], "v4", 42),
        (
            "rt/deg5_at_99",
            vec![1, 2, 3, 4, 5],
            vec!["v1", "v2", "v3", "v4", "v5"],
            "v6",
            99,
        ),
        (
            "rt/deg8_at_200",
            vec![1, 4, 9, 16, 25, 100, 200, 255],
            vec!["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"],
            "v3",
            200,
        ),
    ];

    for (name, points, value_names, vaz_name, ep) in &rt_cases {
        let values: Vec<Gf2_192> = value_names
            .iter()
            .map(|n| from_24_hex(sample(n)))
            .collect();
        let value_at_zero = from_24_hex(sample(vaz_name));
        let poly = Gf2_192Poly::interpolate(points, &values, value_at_zero)
            .expect("interpolate should not fail");

        // Round-trip via CoefficientsByteRepr (the deserialization API the
        // verifier walk in Task 9 will use).
        let poly_bytes = poly.to_bytes();
        let mut coeff0_arr = [0u8; 24];
        let vaz_bytes: [u8; 24] = value_at_zero.into();
        coeff0_arr.copy_from_slice(&vaz_bytes);
        let reconstructed = Gf2_192Poly::try_from(CoefficientsByteRepr {
            coeff0: coeff0_arr,
            more_coeffs: &poly_bytes,
        })
        .expect("round-trip should not fail");

        let direct = poly.evaluate(*ep);
        let via_rt = reconstructed.evaluate(*ep);
        assert_eq!(direct, via_rt, "{}: round-trip mismatch", name);

        out.push(PolyOpFixture {
            name: (*name).to_string(),
            op: "from_coeffs_and_const".to_string(),
            inputs: PolyInputs {
                value_at_zero_hex: Some(sample(vaz_name).to_string()),
                poly_bytes_hex: Some(hex::encode(&poly_bytes)),
                eval_point: Some(*ep),
                ..Default::default()
            },
            expected: to_24_hex(via_rt),
        });
    }

    Ok(out)
}
