//! Wire-protocol framing for the ergots mainnet validation harness shim.
//!
//! Per spec docs/specs/2026-05-21-mainnet-validate-harness-design.md Decision 8:
//! - Request: ASCII line on stdin terminated by `\n` (e.g. `GET_BLOCK 12345\n`
//!   or `GET_TIP_HEIGHT\n`).
//! - Response: 4-byte big-endian length prefix, then N bytes of CBOR.
//! - Top-level CBOR shape:
//!     * Success: `{"ok": true,  "data":  <T>}`
//!     * Failure: `{"ok": false, "error": {"code": <str>, "message": <str>}}`
//!
//! T2 implements only framing + request parsing. The Request enum's variants
//! are dispatched in main.rs but the bodies are stubbed; T3-T5 wire real
//! handlers.

use std::io::Write;

use serde::{Deserialize, Serialize};

/// Parsed stdin request.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    /// `GET_TIP_HEIGHT\n` — returns `tip(101)` from the modifier store.
    GetTipHeight,
    /// `GET_BLOCK <u32>\n` — returns a BlockBundle for the given height.
    GetBlock { height: u32 },
}

/// Per-transaction bundle skeleton.
///
/// T4 emits an empty struct; T5 populates it with `tx_id`, `signing_message`,
/// `inputs` (with spent box bytes, signature bytes, context extension),
/// `outputs`, and `data_input_boxes`. Keeping the type defined here so
/// `BlockBundle::transactions: Vec<TxBundle>` can be constructed at T4
/// (always-empty for now) without a follow-up signature change at T5.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct TxBundle {
    // empty at T4; T5 adds tx_id, signing_message, inputs, outputs, data_input_boxes
}

/// Per-block bundle emitted by GET_BLOCK.
///
/// At T4: `transactions` is always `vec![]` — only the header layer is
/// populated. The harness's header pass (T8) can validate against this.
/// At T5, `transactions` is filled in by the forward-walking UTXO index.
///
/// Field encoding notes for the CBOR consumer (TS harness):
/// - `block_id` and `parent_id` are 32-byte fixed arrays. With serde's
///   default representation, ciborium emits these as CBOR major-type-4
///   arrays of small integers, not as byte strings. The harness side
///   (T6, cbor-x) will decode them as `number[]` and map to Uint8Array.
///   If at T6 this proves CBOR-inefficient (each byte ≥ 1 CBOR byte
///   overhead vs. ~1 byte per byte in a major-type-2 byte string), we
///   can switch these fields to `#[serde(with = "serde_bytes")]` and
///   bump them to byte-string encoding. The `block_bundle_roundtrip`
///   unit test below would still pass — it only asserts structural
///   equality, not the on-wire byte shape.
/// - `header_bytes: Vec<u8>` uses the same `Vec`-of-integers encoding by
///   default; same future-tightening note applies if size becomes a
///   concern.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct BlockBundle {
    pub height: u32,
    pub block_id: [u8; 32],
    pub parent_id: [u8; 32],
    pub header_bytes: Vec<u8>,
    /// Empty at T4; populated at T5.
    pub transactions: Vec<TxBundle>,
}

/// Parse a single stdin line into a `Request`. Trims trailing whitespace
/// (including the `\n` delimiter).
///
/// Returns `Err(String)` with a human-readable reason on any parse failure;
/// the caller emits this back over the wire as an `unknown-command` error.
pub fn parse_request(line: &str) -> Result<Request, String> {
    let line = line.trim_end();
    if line == "GET_TIP_HEIGHT" {
        return Ok(Request::GetTipHeight);
    }
    if let Some(rest) = line.strip_prefix("GET_BLOCK ") {
        let height: u32 = rest
            .parse()
            .map_err(|e| format!("GET_BLOCK: invalid u32 height \"{rest}\": {e}"))?;
        return Ok(Request::GetBlock { height });
    }
    Err(format!("unknown command: \"{line}\""))
}

/// Top-level success body. Generic over the inner `data` payload.
///
/// CBOR serialization produces `{"ok": true, "data": <T>}`.
#[derive(Serialize)]
struct OkBody<T: Serialize> {
    ok: bool,
    data: T,
}

/// Response payload for `GET_TIP_HEIGHT`. Wrapped by `write_ok` so the
/// emitted CBOR is `{"ok": true, "data": {"tip": <u32>}}`. Keeping the
/// `tip` field nested under `data` matches the shape the harness expects
/// for every command — spec Decision 8.
#[derive(Serialize)]
pub struct TipHeightResponse {
    pub tip: u32,
}

/// Top-level error body — `{"ok": false, "error": {"code", "message"}}`.
#[derive(Serialize)]
struct ErrBody<'a> {
    ok: bool,
    error: ErrorPayload<'a>,
}

/// Inner payload of an error response. Code is a stable short string used
/// for programmatic dispatch on the harness side (e.g. `utxo-bootstrap-detected`,
/// `unknown-command`, `past-tip`, `missing-utxo`). Message is human-readable.
#[derive(Serialize)]
struct ErrorPayload<'a> {
    code: &'a str,
    message: &'a str,
}

/// Write a CBOR-serialized `body` to `out`, prefixed with a 4-byte big-endian
/// length. Flushes after the write so partial buffering doesn't strand the
/// harness's read.
pub fn write_response<W: Write, T: Serialize>(out: &mut W, body: &T) -> std::io::Result<()> {
    let mut cbor = Vec::with_capacity(64);
    ciborium::into_writer(body, &mut cbor)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let len: u32 = cbor
        .len()
        .try_into()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "response exceeds u32 len"))?;
    out.write_all(&len.to_be_bytes())?;
    out.write_all(&cbor)?;
    out.flush()?;
    Ok(())
}

/// Emit a success response wrapping `data` as `{"ok": true, "data": data}`.
pub fn write_ok<W: Write, T: Serialize>(out: &mut W, data: T) -> std::io::Result<()> {
    let body = OkBody { ok: true, data };
    write_response(out, &body)
}

/// Emit an error response with the given `code` and `message`.
pub fn write_err<W: Write>(out: &mut W, code: &str, message: &str) -> std::io::Result<()> {
    let body = ErrBody {
        ok: false,
        error: ErrorPayload { code, message },
    };
    write_response(out, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_get_tip_height() {
        assert_eq!(parse_request("GET_TIP_HEIGHT\n"), Ok(Request::GetTipHeight));
        assert_eq!(parse_request("GET_TIP_HEIGHT"), Ok(Request::GetTipHeight));
    }

    #[test]
    fn parse_get_block() {
        assert_eq!(
            parse_request("GET_BLOCK 12345\n"),
            Ok(Request::GetBlock { height: 12345 })
        );
        assert_eq!(
            parse_request("GET_BLOCK 0"),
            Ok(Request::GetBlock { height: 0 })
        );
    }

    #[test]
    fn parse_unknown_command_rejected() {
        assert!(parse_request("FOO\n").is_err());
        assert!(parse_request("").is_err());
        assert!(parse_request("GET_BLOCK\n").is_err()); // missing arg
        assert!(parse_request("GET_BLOCK abc\n").is_err()); // non-u32
        assert!(parse_request("GET_BLOCK -1\n").is_err()); // negative
    }

    #[test]
    fn framed_length_prefix_round_trips() {
        let mut buf = Vec::new();
        write_ok(&mut buf, "stub").unwrap();
        // Length prefix is 4 BE bytes; remainder is CBOR.
        assert!(buf.len() > 4);
        let prefix: [u8; 4] = buf[..4].try_into().unwrap();
        let len = u32::from_be_bytes(prefix) as usize;
        assert_eq!(len, buf.len() - 4);
    }

    /// Deserialization shape for the success wrapper. Mirrors `OkBody<T>`
    /// but `#[derive(Deserialize)]` so a test can parse what `write_ok`
    /// emitted and assert structural equality on the inner `data`.
    #[derive(Deserialize, Debug, PartialEq, Eq)]
    struct OkBodyDe<T> {
        ok: bool,
        data: T,
    }

    /// Deserialization shape for the error wrapper.
    #[derive(Deserialize, Debug, PartialEq, Eq)]
    struct ErrBodyDe {
        ok: bool,
        error: ErrorPayloadDe,
    }

    #[derive(Deserialize, Debug, PartialEq, Eq)]
    struct ErrorPayloadDe {
        code: String,
        message: String,
    }

    /// Strip the 4-byte big-endian length prefix and return the inner
    /// CBOR body bytes. Asserts that `buf.len() == 4 + advertised_len`
    /// so a truncation in `write_response` would surface here.
    fn strip_length_prefix(buf: &[u8]) -> &[u8] {
        assert!(buf.len() >= 4, "framed buffer must be at least 4 bytes");
        let prefix: [u8; 4] = buf[..4].try_into().unwrap();
        let len = u32::from_be_bytes(prefix) as usize;
        assert_eq!(
            buf.len() - 4,
            len,
            "framed body length disagrees with the 4-byte BE prefix"
        );
        &buf[4..]
    }

    /// Layer 1 round-trip: a populated `BlockBundle` survives serialization
    /// to length-prefixed CBOR and back without loss. Covers the T4 happy
    /// path: GET_BLOCK responds with a header-only BlockBundle.
    ///
    /// The bundle is hand-crafted with deterministic byte patterns so the
    /// assertion failure (if any) points at the exact field that diverged.
    #[test]
    fn block_bundle_roundtrip() {
        let bundle = BlockBundle {
            height: 12345,
            block_id: [0xAAu8; 32],
            parent_id: [0xBBu8; 32],
            // Synthetic header bytes: version (0x02) + parent_id pattern
            // (32 × 0xBB) + a few trailing bytes to make this look like a
            // valid pre-PoW header prefix without actually being parseable.
            // The actual byte values don't matter for the framing test —
            // only that they survive the round-trip.
            header_bytes: {
                let mut v = vec![0x02u8];
                v.extend_from_slice(&[0xBBu8; 32]);
                v.extend_from_slice(&[0xCCu8, 0xDD, 0xEE, 0xFF]);
                v
            },
            transactions: vec![], // T4 always-empty
        };

        let mut buf = Vec::new();
        write_ok(&mut buf, &bundle).expect("write_ok");

        let body = strip_length_prefix(&buf);
        let parsed: OkBodyDe<BlockBundle> =
            ciborium::from_reader(body).expect("ciborium decode of OkBody<BlockBundle>");

        assert!(parsed.ok, "ok flag must be true");
        assert_eq!(parsed.data, bundle, "BlockBundle structural equality");
    }

    /// Layer 1 round-trip for the error path: `write_err(code, message)`
    /// survives length-prefixed CBOR and decodes back to matching strings.
    /// Covers the "missing-block" / "past-tip" error shape the T4
    /// GET_BLOCK handler emits when `best_header_at(height)` returns
    /// `None`.
    #[test]
    fn error_response_roundtrip() {
        let mut buf = Vec::new();
        write_err(&mut buf, "missing-block", "no canonical header at height 999999")
            .expect("write_err");

        let body = strip_length_prefix(&buf);
        let parsed: ErrBodyDe =
            ciborium::from_reader(body).expect("ciborium decode of ErrBody");

        assert!(!parsed.ok, "ok flag must be false on error");
        assert_eq!(parsed.error.code, "missing-block");
        assert_eq!(
            parsed.error.message,
            "no canonical header at height 999999"
        );
    }
}
