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
    /// `GET_HEADER <u32>\n` — returns just the canonical header bytes for
    /// the given height. Bypasses the forward-walker constraint that
    /// `GetBlock` enforces; serves any height that exists in BEST_CHAIN.
    /// Added at PROTOCOL_VERSION 3 to unblock the 2j-b autonomous fix
    /// loop's resume-from-checkpoint path (see
    /// `docs/specs/2026-05-23-ergoscript-2j-b-resume-shim-fix-design.md`).
    GetHeader { height: u32 },
}

/// Per-input bundle. Each entry pairs the input (by box_id) with the
/// canonical bytes of the spent box (pulled from the forward-walking UTXO
/// index right before removal), the spending signature, and the user-
/// supplied context extension.
///
/// Field semantics (consumed by harness T9/T10):
/// - `box_id`: 32 bytes, the canonical id of the input box. Stored
///   redundantly for diagnostic correlation. **The harness MUST
///   recompute `box_id` from `spent_box_bytes` via blake2b256 and
///   reject if they disagree** — this field is for sanity-checking the
///   shim's UTXO index, NOT for trusting as a signing input.
///   Authoritative source: `spent_box_bytes`. A mismatch here means the
///   sidecar index stored the wrong bytes for an entry (shim bug or
///   on-disk corruption); failing fast at the harness boundary keeps
///   T9 round-trip and T10 verify from running on lies.
/// - `spent_box_bytes`: result of `ErgoBox::sigma_serialize` on the spent
///   box; the same bytes the index stored at the producing block's output
///   step. Round-trip target for T9's "serialize parsed box, compare
///   bytes" check.
/// - `signature_bytes`: `ProverResult::proof` bytes (empty when the input
///   spends a no-script box like a miner reward). T10's signature pass
///   feeds this to `verifySignature`.
/// - `context_extension`: list of `(varId, constantBytes)` pairs in the
///   order the spending tx provides them. `constantBytes` is the result
///   of `Constant::sigma_serialize` so the TS evaluator decodes them via
///   `parseConstant` and binds them in the eval context.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct InputBundle {
    pub box_id: [u8; 32],
    pub spent_box_bytes: Vec<u8>,
    pub signature_bytes: Vec<u8>,
    pub context_extension: Vec<ContextExtensionEntry>,
    // Phase 2j-a additions. The shim computes sigma-rust's per-input cost
    // via `cost_oracle::compute_oracle_cost` and emits the result here.
    // The harness's validate-tx evaluate-pass compares `oracle_cost`
    // against our `ctx.jitCost` and halts on mismatch via the
    // `'evaluate-cost'` or `'evaluate-oracle-mismatch'` phase classes.
    //
    // `oracle_cost` is RAW JitCost (the accumulator value sigma-rust
    // tracks on `Context::jit_cost`), NOT block cost (which would be
    // `oracle_cost / 10`). Our TS `ctx.jitCost` mirrors raw JitCost, so
    // direct equality comparison works.
    //
    // CBOR encoding is wire-additive (struct-as-map with named keys), so
    // pre-2j-a harness builds reading new shim bundles would tolerate the
    // new keys. PROTOCOL_VERSION bump (declared below) makes the schema
    // mismatch detectable at startup rather than at first-block decode.
    pub oracle_cost: u64,
    pub oracle_succeeded: bool,
    pub oracle_error: Option<String>,
}

/// Shim wire-protocol version. Bumped at phase 2j-a (v1 -> v2) when
/// `InputBundle` gained the `oracle_*` fields, and at phase 2j-b-resume
/// (v2 -> v3) when the `GET_HEADER` verb was added so the harness can
/// rebuild rolling-window state on resume without hitting the forward-
/// walker constraint. The shim emits this at startup; the harness's
/// EXPECTED_SHIM_PROTOCOL_VERSION tracks it for handshake validation
/// (the comparison hook is still carry-forward as of 2j-b-resume).
pub const PROTOCOL_VERSION: u32 = 3;

/// Single (varId, serialized-Constant-bytes) pair from an input's
/// `ContextExtension::values`. Kept as a separate struct so the CBOR
/// shape is `[{var_id, value_bytes}, ...]` (a CBOR-array-of-maps) rather
/// than a CBOR map with non-string keys — ciborium serialises u8-keyed
/// maps as CBOR maps with integer keys, which `cbor-x` on the harness
/// side handles but the explicit array-of-objects shape is friendlier
/// to round-trip equality tests.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ContextExtensionEntry {
    pub var_id: u8,
    pub value_bytes: Vec<u8>,
}

/// Per-transaction bundle, populated by the T5 forward walker.
///
/// `signing_message` is `Transaction::bytes_to_sign()` — the deterministic
/// pre-signature serialization that every input's signature commits to.
/// `inputs` are in tx-order. `data_input_boxes` are full
/// `ErgoBox::sigma_serialize` bytes for data-input box lookups (no
/// removal from the index).
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct TxBundle {
    pub tx_id: [u8; 32],
    pub signing_message: Vec<u8>,
    pub inputs: Vec<InputBundle>,
    /// Canonical `ErgoBox::sigma_serialize` bytes for each output, in tx-order.
    pub outputs: Vec<Vec<u8>>,
    /// Data-input box bytes, in tx-order. Empty for txs with no data inputs.
    pub data_input_boxes: Vec<Vec<u8>>,
}

/// Block-level voting/parameters snapshot extracted from the Extension
/// section. Currently only carries `max_block_cost` (T10 needs it for
/// the per-block cost ceiling); future passes can extend this with the
/// rest of `Parameters` without changing the wire shape (CBOR maps
/// extend additively).
///
/// `max_block_cost` is i32 because that's the JVM-canonical type — see
/// `Parameters::max_block_cost` in
/// `external/sigma-rust/ergo-lib/src/chain/parameters.rs:79`. Negative
/// values shouldn't be reachable on mainnet but we preserve the sign so
/// a faulty extension parse surfaces here rather than silently truncating.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct BlockParameters {
    pub max_block_cost: i32,
}

/// Per-block bundle emitted by GET_BLOCK.
///
/// At T5 (this task), `transactions` is fully populated by walking the
/// store forward from the sidecar's `indexed_up_to_height` up to the
/// requested height. `parameters` is `Some(_)` whenever the requested
/// block's Extension carries parameter votes — at the moment that's
/// every block on mainnet, but the field is Option-typed because
/// pre-version-2 blocks (genesis era) don't have the parameter
/// encoding format the parser expects.
///
/// Field encoding notes for the CBOR consumer (TS harness):
/// - `block_id`, `parent_id`, and per-input `box_id`s are 32-byte fixed
///   arrays. With serde's default representation, ciborium emits these
///   as CBOR major-type-4 arrays of small integers, not as byte strings.
///   The harness side (T6, cbor-x) will decode them as `number[]` and
///   map to Uint8Array. If at T6 this proves CBOR-inefficient (each byte
///   ≥ 1 CBOR byte overhead vs. ~1 byte per byte in a major-type-2 byte
///   string), we can switch these fields to `#[serde(with = "serde_bytes")]`
///   and bump them to byte-string encoding. The `block_bundle_roundtrip`
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
    pub transactions: Vec<TxBundle>,
    /// `None` when the Extension at this height doesn't carry parameter
    /// votes in the format the parser recognises (e.g. very early
    /// version-1 blocks).
    pub parameters: Option<BlockParameters>,
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
    if let Some(rest) = line.strip_prefix("GET_HEADER ") {
        let height: u32 = rest
            .parse()
            .map_err(|e| format!("GET_HEADER: invalid u32 height \"{rest}\": {e}"))?;
        return Ok(Request::GetHeader { height });
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

/// Response payload for `GET_HEADER`. Wrapped by `write_ok` so the emitted
/// CBOR is `{"ok": true, "data": {"header_bytes": [u8]}}`. The bytes are
/// the result of `RedbModifierStore::read_header_at(height)` — the canonical
/// header serialization at the requested height. The harness parses these
/// via the existing scorex `parseHeader` helper, the same code path
/// `validateBlock` already uses to parse `BlockBundle.headerBytes`.
#[derive(Serialize)]
pub struct HeaderResponse {
    pub header_bytes: Vec<u8>,
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
    fn parse_get_header() {
        assert_eq!(
            parse_request("GET_HEADER 49991\n"),
            Ok(Request::GetHeader { height: 49991 })
        );
        assert_eq!(
            parse_request("GET_HEADER 0"),
            Ok(Request::GetHeader { height: 0 })
        );
        assert_eq!(
            parse_request("GET_HEADER 4294967295\n"),
            Ok(Request::GetHeader { height: u32::MAX })
        );
    }

    #[test]
    fn parse_unknown_command_rejected() {
        assert!(parse_request("FOO\n").is_err());
        assert!(parse_request("").is_err());
        assert!(parse_request("GET_BLOCK\n").is_err()); // missing arg
        assert!(parse_request("GET_BLOCK abc\n").is_err()); // non-u32
        assert!(parse_request("GET_BLOCK -1\n").is_err()); // negative
        assert!(parse_request("GET_HEADER\n").is_err()); // missing arg
        assert!(parse_request("GET_HEADER abc\n").is_err()); // non-u32
        assert!(parse_request("GET_HEADER -1\n").is_err()); // negative
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

    /// Layer 1 round-trip: a header-only `BlockBundle` (no transactions,
    /// no parameters) survives serialization to length-prefixed CBOR
    /// and back without loss. Covers the T4 happy path that the T5
    /// walker preserves for height-0 / no-block cases.
    ///
    /// The bundle is hand-crafted with deterministic byte patterns so
    /// the assertion failure (if any) points at the exact field that
    /// diverged.
    #[test]
    fn block_bundle_roundtrip_header_only() {
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
            transactions: vec![],
            parameters: None,
        };

        let mut buf = Vec::new();
        write_ok(&mut buf, &bundle).expect("write_ok");

        let body = strip_length_prefix(&buf);
        let parsed: OkBodyDe<BlockBundle> =
            ciborium::from_reader(body).expect("ciborium decode of OkBody<BlockBundle>");

        assert!(parsed.ok, "ok flag must be true");
        assert_eq!(parsed.data, bundle, "BlockBundle structural equality");
    }

    /// Layer 1 round-trip for a fully-populated `BlockBundle` — a single
    /// transaction with one input + one output + one data-input + a
    /// two-entry context extension, plus a `BlockParameters` carrying
    /// a max_block_cost. Covers the T5 emission shape end-to-end.
    ///
    /// Distinct cases used by the harness side (T9/T10) all exercised:
    /// - Outputs as `Vec<Vec<u8>>` (variable per-output byte vectors).
    /// - InputBundle with non-empty signature + extension.
    /// - DataInput as a separate `Vec<Vec<u8>>` lookup.
    /// - BlockParameters in `Some(_)`.
    #[test]
    fn block_bundle_roundtrip_full() {
        let bundle = BlockBundle {
            height: 540_001,
            block_id: [0x96u8; 32],
            parent_id: [0xC5u8; 32],
            header_bytes: vec![0x02; 221],
            transactions: vec![TxBundle {
                tx_id: [0xD3u8; 32],
                signing_message: vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05],
                inputs: vec![InputBundle {
                    box_id: [0x80u8; 32],
                    spent_box_bytes: vec![0xE0u8; 64],
                    signature_bytes: vec![0xDEu8, 0xADu8, 0xBEu8, 0xEFu8],
                    context_extension: vec![
                        ContextExtensionEntry {
                            var_id: 0,
                            value_bytes: vec![0x04, 0x80, 0x02],
                        },
                        ContextExtensionEntry {
                            var_id: 1,
                            value_bytes: vec![0x05, 0xFE],
                        },
                    ],
                    oracle_cost: 0,
                    oracle_succeeded: false,
                    oracle_error: None,
                }],
                outputs: vec![vec![0xAAu8; 100], vec![0xBBu8; 60]],
                data_input_boxes: vec![vec![0xCCu8; 80]],
            }],
            parameters: Some(BlockParameters {
                max_block_cost: 1_000_000,
            }),
        };

        let mut buf = Vec::new();
        write_ok(&mut buf, &bundle).expect("write_ok");

        let body = strip_length_prefix(&buf);
        let parsed: OkBodyDe<BlockBundle> =
            ciborium::from_reader(body).expect("ciborium decode of OkBody<BlockBundle>");

        assert!(parsed.ok, "ok flag must be true");
        assert_eq!(parsed.data, bundle, "fully-populated BlockBundle structural equality");
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

    /// Phase 2j-a: InputBundle carrying oracle_cost (success path) survives
    /// the CBOR round-trip. Asserts the new oracle_* fields encode and
    /// decode byte-equal.
    #[test]
    fn input_bundle_with_oracle_cost_roundtrips() {
        let original = InputBundle {
            box_id: [0x11u8; 32],
            spent_box_bytes: vec![0xde, 0xad, 0xbe, 0xef],
            signature_bytes: vec![0xca, 0xfe],
            context_extension: vec![],
            oracle_cost: 12_345_u64,
            oracle_succeeded: true,
            oracle_error: None,
        };

        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).expect("encode");
        let decoded: InputBundle = ciborium::de::from_reader(&buf[..]).expect("decode");

        assert_eq!(decoded, original);
        assert_eq!(decoded.oracle_cost, 12_345_u64);
        assert!(decoded.oracle_succeeded);
        assert!(decoded.oracle_error.is_none());
    }

    /// Phase 2j-a: InputBundle carrying oracle_error (failure path) survives
    /// the CBOR round-trip. Exercises Option<String> encoding for the
    /// error_msg case where sigma-rust's reduce_to_crypto threw.
    #[test]
    fn input_bundle_with_oracle_error_roundtrips() {
        let original = InputBundle {
            box_id: [0x22u8; 32],
            spent_box_bytes: vec![],
            signature_bytes: vec![],
            context_extension: vec![],
            oracle_cost: 42_u64,
            oracle_succeeded: false,
            oracle_error: Some("simulated reduce_to_crypto error".to_string()),
        };

        let mut buf = Vec::new();
        ciborium::ser::into_writer(&original, &mut buf).expect("encode");
        let decoded: InputBundle = ciborium::de::from_reader(&buf[..]).expect("decode");

        assert_eq!(decoded, original);
        assert_eq!(decoded.oracle_cost, 42_u64);
        assert!(!decoded.oracle_succeeded);
        assert_eq!(
            decoded.oracle_error.as_deref(),
            Some("simulated reduce_to_crypto error")
        );
    }
}
