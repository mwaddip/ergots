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

use serde::Serialize;

/// Parsed stdin request.
#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    /// `GET_TIP_HEIGHT\n` — returns `tip(101)` from the modifier store.
    GetTipHeight,
    /// `GET_BLOCK <u32>\n` — returns a BlockBundle for the given height.
    GetBlock { height: u32 },
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
}
