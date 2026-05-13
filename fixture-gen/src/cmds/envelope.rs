/// Envelope fixture generation for P2P message codes 90 and 91.
///
/// Code 90 (`GetNipopowProof`): carries a request `(m, k, optional header_id)`.
/// Code 91 (`NipopowProof`): carries inner proof bytes.
/// Both have a `future_pad_length` u16 (plain VLQ) tail.
///
/// Wire format (from ~/projects/ergo-node-rust/facts/nipopow.md and nipopow_serve.rs):
///
/// **Code 90 body**:
///   m: i32 (ZigZag VLQ — JVM putInt)
///   k: i32 (ZigZag VLQ — JVM putInt)
///   header_id_present: u8 (raw byte: 0 or 1)
///   [if present] header_id: 32 raw bytes
///   future_pad_length: u16 (plain VLQ — JVM putUShort)
///   [if > 0] padding: future_pad_length bytes
///
/// **Code 91 body**:
///   proof_length: u32 (plain VLQ — JVM putUInt)
///   proof_bytes: [u8; proof_length]
///   future_pad_length: u16 (plain VLQ — JVM putUShort)
///   [if > 0] padding: future_pad_length bytes

use serde::Serialize;
use sigma_ser::vlq_encode::WriteSigmaVlqExt;

#[derive(Serialize)]
pub struct GetNipopowEnvelopeCase {
    pub label: String,
    pub m: i32,
    pub k: i32,
    pub header_id_hex: Option<String>,
    pub bytes_hex: String,
}

#[derive(Serialize)]
pub struct NipopowProofEnvelopeCase {
    pub label: String,
    pub inner_proof_hex: String,
    pub bytes_hex: String,
    /// If true, the fixture has non-zero future padding — serialize(parse(bytes)) != bytes.
    /// The test should only assert parse correctness, not round-trip equality.
    pub parse_only: bool,
}

#[derive(Serialize)]
pub struct EnvelopeFixtures {
    pub get_requests: Vec<GetNipopowEnvelopeCase>,
    pub proof_envelopes: Vec<NipopowProofEnvelopeCase>,
}

/// Serialize `m` and `k` as ZigZag VLQ (JVM `putInt` = signed ZigZag).
fn put_i32(buf: &mut Vec<u8>, v: i32) -> anyhow::Result<()> {
    buf.put_i32(v).map_err(|e| anyhow::anyhow!("put_i32: {e}"))
}

/// Serialize a plain unsigned VLQ u32 (JVM `putUInt`).
fn put_u32(buf: &mut Vec<u8>, v: u32) -> anyhow::Result<()> {
    buf.put_u32(v).map_err(|e| anyhow::anyhow!("put_u32: {e}"))
}

/// Serialize a plain unsigned VLQ u16 (JVM `putUShort`).
fn put_u16(buf: &mut Vec<u8>, v: u16) -> anyhow::Result<()> {
    buf.put_u16(v).map_err(|e| anyhow::anyhow!("put_u16: {e}"))
}

pub fn generate() -> anyhow::Result<EnvelopeFixtures> {
    let mut get_requests = Vec::new();

    // ─── Case 1: m=6, k=10, no anchor (header_id_present = 0) ───────────────
    {
        let (m, k) = (6i32, 10i32);
        let mut buf: Vec<u8> = Vec::new();
        put_i32(&mut buf, m)?;      // ZigZag VLQ: 6 → 0x0c
        put_i32(&mut buf, k)?;      // ZigZag VLQ: 10 → 0x14
        buf.push(0u8);              // header_id_present = 0
        put_u16(&mut buf, 0)?;      // future_pad_length = 0 → 0x00

        // Sanity: read back via sigma-ser
        {
            use sigma_ser::vlq_encode::ReadSigmaVlqExt;
            let mut cur = std::io::Cursor::new(buf.clone());
            assert_eq!(cur.get_i32().unwrap(), m);
            assert_eq!(cur.get_i32().unwrap(), k);
        }

        get_requests.push(GetNipopowEnvelopeCase {
            label: "m6-k10-no-anchor".into(),
            m,
            k,
            header_id_hex: None,
            bytes_hex: hex::encode(&buf),
        });
    }

    // ─── Case 2: m=2, k=2, with 32-byte anchor ───────────────────────────────
    {
        let (m, k) = (2i32, 2i32);
        let header_id = [0x42u8; 32];
        let mut buf: Vec<u8> = Vec::new();
        put_i32(&mut buf, m)?;          // ZigZag VLQ: 2 → 0x04
        put_i32(&mut buf, k)?;          // ZigZag VLQ: 2 → 0x04
        buf.push(1u8);                  // header_id_present = 1
        buf.extend_from_slice(&header_id); // 32 raw bytes
        put_u16(&mut buf, 0)?;          // future_pad_length = 0

        get_requests.push(GetNipopowEnvelopeCase {
            label: "m2-k2-with-anchor".into(),
            m,
            k,
            header_id_hex: Some(hex::encode(header_id)),
            bytes_hex: hex::encode(&buf),
        });
    }

    // ─── Case 3: m=6, k=10, non-zero padding (tests pad skip on parse) ───────
    {
        let (m, k) = (6i32, 10i32);
        let pad_bytes = [0xffu8; 4];
        let mut buf: Vec<u8> = Vec::new();
        put_i32(&mut buf, m)?;
        put_i32(&mut buf, k)?;
        buf.push(0u8);                  // header_id_present = 0
        put_u16(&mut buf, pad_bytes.len() as u16)?; // future_pad_length = 4
        buf.extend_from_slice(&pad_bytes);

        get_requests.push(GetNipopowEnvelopeCase {
            label: "m6-k10-no-anchor-with-pad".into(),
            m,
            k,
            header_id_hex: None,
            bytes_hex: hex::encode(&buf),
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Code 91: NipopowProof envelopes
    // ─────────────────────────────────────────────────────────────────────────
    let mut proof_envelopes = Vec::new();

    // ─── Case 1: tiny synthetic payload (100 bytes of 0xaa) ──────────────────
    {
        let inner = vec![0xaau8; 100];
        let mut buf: Vec<u8> = Vec::new();
        put_u32(&mut buf, inner.len() as u32)?;  // plain VLQ: 100 → 0x64
        buf.extend_from_slice(&inner);
        put_u16(&mut buf, 0)?;                   // future_pad_length = 0

        proof_envelopes.push(NipopowProofEnvelopeCase {
            label: "tiny-payload-100-bytes".into(),
            inner_proof_hex: hex::encode(&inner),
            bytes_hex: hex::encode(&buf),
            parse_only: false,
        });
    }

    // ─── Case 2: minimal 1-byte payload ──────────────────────────────────────
    {
        let inner = vec![0x01u8; 1];
        let mut buf: Vec<u8> = Vec::new();
        put_u32(&mut buf, inner.len() as u32)?;  // plain VLQ: 1 → 0x01
        buf.extend_from_slice(&inner);
        put_u16(&mut buf, 0)?;

        proof_envelopes.push(NipopowProofEnvelopeCase {
            label: "minimal-1-byte".into(),
            inner_proof_hex: hex::encode(&inner),
            bytes_hex: hex::encode(&buf),
            parse_only: false,
        });
    }

    // ─── Case 3: payload with non-zero padding ────────────────────────────────
    // parse_only = true: serializeNipopowProofEnvelope always writes pad_length=0,
    // so serialize(parse(bytes)) != bytes when bytes has non-zero padding.
    // The test asserts parse correctness only for this case.
    {
        let inner = vec![0xbbu8; 50];
        let pad = [0x00u8; 3];
        let mut buf: Vec<u8> = Vec::new();
        put_u32(&mut buf, inner.len() as u32)?;
        buf.extend_from_slice(&inner);
        put_u16(&mut buf, pad.len() as u16)?;    // future_pad_length = 3
        buf.extend_from_slice(&pad);

        proof_envelopes.push(NipopowProofEnvelopeCase {
            label: "payload-with-pad".into(),
            inner_proof_hex: hex::encode(&inner),
            bytes_hex: hex::encode(&buf),
            parse_only: true,
        });
    }

    Ok(EnvelopeFixtures { get_requests, proof_envelopes })
}
