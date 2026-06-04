# `@ergots/scorex` — Interface Contract

The boundary contract for the shared Scorex wire-codec layer and block-Header types package. This package exists as the foundational codec layer shared by `@ergots/nipopow` and `@ergots/ergoscript`: both consume `ByteReader`, `ByteWriter`, VLQ functions, and the `Header` / `AutolykosSolution` types. Extracting this layer removes a divergence risk between the two packages' previously-separate codec implementations and provides the shared `Header` type required by `@ergots/ergoscript` phase 2h-c.1 (SHeader runtime + 17 method handlers). The narrative rationale and extraction design live in `docs/specs/2026-05-19-ergots-scorex-package-design.md`; this file is *only* the interface.

Authoritative algorithmic references:

- `sigma-ser/src/vlq_encode.rs` — VLQ + ZigZag-VLQ encode/decode (pinned at sigma-rust `integration/ergots`, `~/projects/ergots/external/sigma-rust/`)
- `sigma-ser/src/scorex_serialize.rs` — `ByteReader` / `ByteWriter` patterns
- `ergo-chain-types/src/header.rs` — `Header::scorex_parse` / `scorex_serialize` / `AutolykosSolution::serialize_bytes`

Where this file is silent on implementation detail, those are canonical.

## Scope

**Ships in this contract (v0.2.0):**

1. `ByteReader` class — cursor-based reader with VLQ + ZigZag-VLQ decoding, bool/option/array helpers, and a `slice()` view.
2. `ByteWriter` class — chunk-accumulating writer with VLQ + ZigZag-VLQ encoding, bool/option/array helpers, and a `toBytes()` finalizer.
3. `ReaderError` class — typed error thrown by `ByteReader` on malformed input; 4-variant `code` union.
4. VLQ free functions: `encodeVlqU`, `decodeVlqU`, `encodeVlqZigZag`, `decodeVlqZigZag`, `readVlqU32` — stateless encode/decode operating on `ByteReader` and returning `Uint8Array` / `bigint`.
5. `MAX_ARRAY_LENGTH` constant — 16,777,216 (`1 << 24`); the DoS cap applied by `readArray`.
6. Digest constants and helpers: `BLOCK_ID_LEN`, `DIGEST32_LEN`, `AD_DIGEST_LEN`, `EC_POINT_LEN`, `readFixed`, `writeFixed`.
7. `Header` interface + `parseHeader`, `serializeHeader`, `serializeHeaderWithoutPow`, `deriveHeaderId`.
8. `AutolykosSolution` interface + `parseAutolykosSolution`, `serializeAutolykosSolution`.
9. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.
10. Autolykos v2 PoW verifier: `verifyAutolykosV2(header): boolean` + helpers (`calcBigN`, `autolykosMessage`). Internals `buildAutolykosSeed`, `genIndexes`, `hashElement` are module-internal in P5c and removed from `packages/scorex/src/index.ts`.
11. `decodeCompactBits(nBits): bigint` — Bitcoin-compact-bits target unpacking, used by the Autolykos v2 verifier.
12. `AutolykosV1NotSupportedError` typed error class — thrown by `verifyAutolykosV2` on v1 headers (matches sigma-rust `AutolykosPowSchemeError::Unsupported`).
13. `autolykosHitForMessage(k, msg, nonce, h, N): bigint` — un-checked Autolykos-2 PoW hit core (Architecture C″). Faithful port of JVM `Autolykos2PowValidation.hitForVersion2ForMessage` (`Autolykos2PowValidation.scala:122-137`). `h` is raw bytes; the header path passes `int32BE(height)`.
14. `autolykosHitForMessageWithChecks(k, msg, nonce, h, N): bigint` — same hit core, guarded by `require(k>=2)`, `require(k<=32)`, `require(N>=16)`; throws `PowHitInvalidParamsError` on violation. JVM `hitForVersion2ForMessageWithChecks` (`Autolykos2PowValidation.scala:115-120`).
15. `int32BE(n: number): Uint8Array` — 4-byte big-endian encoding. JVM `scorex.utils.Ints.toByteArray`.
16. `PowHitInvalidParamsError` typed error class — `readonly code = 'pow-hit-invalid-params'`; thrown by `autolykosHitForMessageWithChecks` on parameter-guard violations.

**Does NOT ship:**

- **`SValue` / `SType` / `Expr` types.** Package-specific to `@ergots/ergoscript`; live in `packages/ergoscript/src/mir/`.
- **`ErgoBox` / `NipopowProof` / `AvlTreeData`.** Package-specific to their respective packages; not shared.
- **base58 / base58check helpers.** Single-consumer in `@ergots/ergoscript` address codec; not promoted to shared layer.
- **`blake2b256` wrapper.** Internal-only utility at `packages/scorex/src/crypto/blake2b256.ts`. Used by `deriveHeaderId`; not re-exported from `index.ts` on v0.2.0 because it is a thin wrapper with no added surface; any package that needs blake2b should import from `@noble/hashes/blake2.js` directly.

## Public surface (v0.2.0)

### Primary export: `@ergots/scorex`

```ts
// ─── ByteReader ──────────────────────────────────────────────────────────────

export class ByteReader {
  // maxTreeDepth defaults to MAX_TREE_DEPTH (110); a forked sub-reader inherits it.
  constructor(bytes: Uint8Array, maxTreeDepth?: number)

  get position(): number          // current cursor offset
  get remaining(): number         // bytes.length - position
  get isExhausted(): boolean      // position >= bytes.length

  // ── Recursion-depth counter (shared across all parsers reading THIS reader) ──
  // Faithful port of the JVM CoreByteReader.level (cap SigmaConstants.MaxTreeDepth=110).
  // Used by @ergots/ergoscript's recursive parsers (parseExpr / parseSValue /
  // parseSigmaBoolean) to bound deserialization depth uniformly; parsers that never
  // recurse (e.g. @ergots/nipopow's block codec) simply never call enterDepth, so the
  // counter stays 0 and the cap is a no-op for them.
  readonly maxTreeDepth: number   // recursion-depth cap (default MAX_TREE_DEPTH)
  get level(): number             // current recursion depth (starts 0 on a fresh reader)
  enterDepth(): void              // ++level; throws ReaderError('max-tree-depth-exceeded') if level would exceed maxTreeDepth
  exitDepth(): void               // --level (pair with enterDepth via try/finally)
  // Fork a sub-reader over `bytes` INHERITING this reader's level + maxTreeDepth.
  // For size-prefixed inner regions read into a bounded buffer (e.g. a hasSize=true
  // ErgoTree body), so the depth counter persists across the size boundary as the
  // JVM does via positionLimit on the one reader.
  forkSubReader(bytes: Uint8Array): ByteReader

  // Return a view (no copy) from start (inclusive) to end (exclusive).
  // Throws ReaderError('slice-out-of-bounds') if args violate [0, buf.length].
  slice(start: number, end: number): Uint8Array

  readU8(): number                // throws ReaderError('truncated') at EOF
  readBytes(n: number): Uint8Array // throws ReaderError('truncated') if n > remaining

  // VLQ unsigned — narrows bigint result to number (caller ensures <= 2^53-1)
  readVlqU(): number
  // VLQ unsigned — full 64-bit safe, returns bigint
  readVlqBigInt(): bigint         // throws ReaderError('vlq-overflow') after 10 continuation bytes

  // ZigZag-VLQ signed — narrows bigint result to number
  readVlqS(): number
  // ZigZag-VLQ signed — full 64-bit safe, returns bigint
  readVlqBigIntSigned(): bigint

  // Fleet-inspired helpers:
  readBool(): boolean             // 0x00=false, 0x01=true; throws ReaderError('truncated') on other byte
  readOption<T>(reader: (r: ByteReader) => T): T | null  // 0x00=null, 0x01=present; throws on other tag
  readArray<T>(reader: (r: ByteReader) => T): T[]        // VLQ length prefix; throws ReaderError('array-too-large') if length > MAX_ARRAY_LENGTH
}

// ─── ByteWriter ──────────────────────────────────────────────────────────────

export class ByteWriter {
  get length(): number            // accumulated byte count

  writeU8(byte: number): void     // throws Error on out-of-range (programming error)
  writeBytes(bytes: Uint8Array): void  // defensive copy; does not alias caller's buffer

  // VLQ unsigned — accepts number (caller ensures non-negative integer)
  writeVlqU(value: number): void
  // VLQ unsigned — accepts bigint; up to 64 bits
  writeVlqBigInt(value: bigint): void  // throws Error on negative value

  // ZigZag-VLQ signed — accepts number
  writeVlqS(value: number): void
  // ZigZag-VLQ signed — accepts bigint; i64 range
  writeVlqBigIntSigned(value: bigint): void

  // Fleet-inspired helpers:
  writeBool(value: boolean): void
  writeOption<T>(value: T | null, serializer: (w: ByteWriter, v: T) => void): void
  writeArray<T>(items: T[], serializer: (w: ByteWriter, item: T) => void): void

  toBytes(): Uint8Array           // concatenate all accumulated chunks into a single buffer
}

// ─── Error classes ───────────────────────────────────────────────────────────

export class ReaderError extends Error {
  readonly code: 'truncated' | 'vlq-overflow' | 'slice-out-of-bounds' | 'array-too-large' | 'max-tree-depth-exceeded'
}

export class AutolykosV1NotSupportedError extends Error {
  readonly code: 'autolykos-v1-not-supported'
}

export class PowHitInvalidParamsError extends Error {
  readonly code: 'pow-hit-invalid-params'
}

// ─── VLQ free functions ───────────────────────────────────────────────────────

// Encode/decode accept and return bigint (arbitrary precision; callers narrow to number as needed).
export function encodeVlqU(value: bigint): Uint8Array          // throws Error on negative
export function decodeVlqU(reader: ByteReader): bigint         // throws ReaderError('vlq-overflow') on >10 bytes
export function encodeVlqZigZag(value: bigint): Uint8Array     // i64 zigzag; throws Error on out-of-i64-range
export function decodeVlqZigZag(reader: ByteReader): bigint    // throws ReaderError('vlq-overflow') on >10 bytes

// Convenience: decode a plain VLQ and assert the result fits in u32 [0, 2^32-1].
export function readVlqU32(reader: ByteReader, fieldName: string): number  // throws ReaderError('vlq-overflow') if > 0xffffffff

// ─── Constants ───────────────────────────────────────────────────────────────

export const MAX_ARRAY_LENGTH = 1 << 24  // 16,777,216
export const MAX_TREE_DEPTH = 110        // default ByteReader.maxTreeDepth (JVM SigmaConstants.MaxTreeDepth)

export const BLOCK_ID_LEN = 32   // bytes
export const DIGEST32_LEN = 32   // bytes
export const AD_DIGEST_LEN = 33  // bytes (32-byte digest + 1-byte tree height)
export const EC_POINT_LEN = 33   // bytes (compressed secp256k1 point)

// ─── Digest helpers ──────────────────────────────────────────────────────────

export function readFixed(reader: ByteReader, len: number, name: string): Uint8Array
  // throws ReaderError('truncated') if fewer than len bytes remain

export function writeFixed(writer: ByteWriter, bytes: Uint8Array, expectedLen: number, name: string): void
  // throws Error if bytes.length !== expectedLen (programming error)

// ─── Block Header types and codecs ───────────────────────────────────────────

export interface AutolykosSolution {
  minerPk: Uint8Array            // 33 bytes (compressed secp256k1)
  powOnetimePk: Uint8Array | null // v1 only: 33 bytes; null for v2 headers
  nonce: Uint8Array              // 8 bytes
  powDistance: bigint | null     // v1 only: big-endian unsigned integer; null for v2 headers
}

export interface Header {
  version: number                // 0..=255 (u8)
  id: Uint8Array                 // 32 bytes; derived via blake2b256, NOT present on wire
  parentId: Uint8Array           // 32 bytes
  adProofsRoot: Uint8Array       // 32 bytes
  stateRoot: Uint8Array          // 33 bytes (ADDigest = 32-byte digest + 1-byte tree height)
  transactionRoot: Uint8Array    // 32 bytes
  timestamp: number              // ms since epoch; stored as u64 on wire; capped at Number.MAX_SAFE_INTEGER
  nBits: number                  // Bitcoin-compact difficulty (u32, 4 bytes big-endian on wire — NOT VLQ)
  height: number                 // u32 > 0; VLQ-encoded on wire
  extensionRoot: Uint8Array      // 32 bytes
  autolykosSolution: AutolykosSolution
  votes: Uint8Array              // 3 bytes
  unparsedBytes: Uint8Array      // forward-compat; 0 bytes for version 1; length prefix u8 for version > 1
}

// Parse a Header from a ByteReader. Derives id in-process; does NOT read id from wire.
export function parseHeader(reader: ByteReader): Header

// Serialize a Header to its canonical wire representation.
// The id field is NOT included in the output (it is derived, not stored on wire).
export function serializeHeader(header: Header): Uint8Array

// Serialize only the pre-PoW portion (used as the Autolykos message input).
// autolykosMessage = blake2b256(serializeHeaderWithoutPow(header))
export function serializeHeaderWithoutPow(header: Header): Uint8Array

// Derive the Header ID: blake2b256 of the full serialized header bytes.
export function deriveHeaderId(header: Header): Uint8Array  // 32 bytes

// Parse / serialize AutolykosSolution (version determines v1 vs v2 wire layout).
export function parseAutolykosSolution(reader: ByteReader, version: number): AutolykosSolution
export function serializeAutolykosSolution(s: AutolykosSolution, version: number): Uint8Array

// ─── Autolykos v2 PoW verifier ───────────────────────────────────────────────

export function calcBigN(version: number, height: number): number
export function autolykosMessage(header: Header): Uint8Array  // 32 bytes
// buildAutolykosSeed, genIndexes, hashElement are module-internal (P5c); removed from public index.ts
export function verifyAutolykosV2(header: Header): boolean
  // throws AutolykosV1NotSupportedError on header.version === 1

// ─── Autolykos v2 PoW hit core (Architecture C″ — shared by verifyAutolykosV2, nipopow.compare, SGlobal.powHit) ───

// 4-byte big-endian encoding of a signed 32-bit integer.
// JVM: scorex.utils.Ints.toByteArray
export function int32BE(n: number): Uint8Array  // 4 bytes

// Un-checked Autolykos-2 PoW hit core.
// Faithful port of JVM Autolykos2PowValidation.hitForVersion2ForMessage (Autolykos2PowValidation.scala:122-137).
// h is raw bytes; the header path passes int32BE(height).
// No parameter guards — callers that need validation must use autolykosHitForMessageWithChecks.
export function autolykosHitForMessage(
  k: number,
  msg: Uint8Array,
  nonce: Uint8Array,
  h: Uint8Array,
  N: number
): bigint

// Same as autolykosHitForMessage, guarded by:
//   require(k >= 2)  — at least 2 elements needed for the k-sum
//   require(k <= 32) — genIndexes does not support k > 32
//   require(N >= 16) — minimum table size
// Throws PowHitInvalidParamsError (code 'pow-hit-invalid-params') on any guard violation.
// JVM: Autolykos2PowValidation.hitForVersion2ForMessageWithChecks (Autolykos2PowValidation.scala:115-120).
export function autolykosHitForMessageWithChecks(
  k: number,
  msg: Uint8Array,
  nonce: Uint8Array,
  h: Uint8Array,
  N: number
): bigint

// ─── nBits decode ────────────────────────────────────────────────────────────

export function decodeCompactBits(nBits: number): bigint
```

## Type invariants

Callers may rely on these without re-checking after any value returned from the public API.

**`Header`:**

- `id` is 32 bytes; derived by `blake2b256(serializeHeader(header))`; never appears on the wire (derived in-process on parse, recomputed on serialize).
- `parentId`, `adProofsRoot`, `transactionRoot`, `extensionRoot` are exactly 32 bytes.
- `stateRoot` is exactly 33 bytes (ADDigest = 32-byte tree root + 1-byte tree height).
- `votes` is exactly 3 bytes.
- `nBits` is encoded as 4 bytes big-endian on the wire (NOT VLQ — this diverges from most fields). The parsed value is a `number` in `[0, 2^32-1]`.
- `timestamp` is a `number` in `[0, Number.MAX_SAFE_INTEGER]`; `parseHeader` throws `ReaderError('vlq-overflow')` if the on-wire VLQ u64 exceeds `Number.MAX_SAFE_INTEGER`. Real chain timestamps are below `2^45` for the next few millennia; this bound is not a practical constraint.
- `height` is a `number` in `[0, 2^32-1]` (u32 range enforced by `readVlqU32`).
- `unparsedBytes` is a `Uint8Array` of length 0 for version 1 headers; for version > 1 headers, the length is read as a u8 prefix (0..=255 bytes).

**`AutolykosSolution`:**

- `minerPk` is exactly 33 bytes (compressed secp256k1 point).
- `powOnetimePk` is `null` for version >= 2 headers; exactly 33 bytes for version 1 headers.
- `nonce` is exactly 8 bytes.
- `powDistance` is `null` for version >= 2 headers; a non-negative `bigint` for version 1 headers (minimal big-endian encoding from the `d_len` + `d_bytes` wire representation). `powDistance === 0n` corresponds to `d_len === 1, d_bytes === [0x00]` on the wire (matching sigma-rust's `BigUint::to_bytes_be()` which returns `[0]` for zero). For backwards compatibility the parser also accepts `d_len === 0` and produces `powDistance === 0n`, but the writer always emits the `d_len=1` form.

**VLQ:**

- `encodeVlqU` / `decodeVlqU` handle unsigned integers up to 2^64 - 1 (but `number` callers must stay within `Number.MAX_SAFE_INTEGER`).
- `encodeVlqZigZag` / `decodeVlqZigZag` handle signed integers in the i64 range `[-2^63, 2^63 - 1]`.
- `MAX_ARRAY_LENGTH = 1 << 24 = 16,777,216` is a hard DoS cap applied by `readArray`. No protocol element legitimately exceeds this.

## Cross-cutting guarantees

- **Determinism.** All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output. Byte-equality with sigma-rust is the load-bearing invariant for every `Header` and `AutolykosSolution` fixture.
- **Synchronous.** No async surface. Codec operations are tight inner loops; an async boundary would only add overhead.
- **No throws on return-path.** `ByteReader` and the VLQ free functions throw only on malformed input (`ReaderError`) or programming errors (plain `Error`). They do not silently produce partial results.
- **Browser-compat.** Runtime support: Node >= 20, evergreen browsers with native ESM. Never `Buffer`. Never `globalThis.crypto`. No `process`, `fs`, `path`, `os`, or `node:*` imports in `packages/scorex/src/`. Hashing via `@noble/hashes@2.2.0` only (internally for `blake2b256`; not exposed in the public API).
- **ESM-only.** Bundle deliberately omits CJS entry points.
- **No top-level await** in published code.
- **No WASM** direct or transitive.
- **`@noble/hashes@2.2.0` is the only runtime dependency.**

## Failure model

**`ReaderError` — thrown by `ByteReader` on malformed bytes (4 codes)**

These represent malformed or truncated wire input, not programming errors on the caller's side.

`ReaderError.code` is one of (the union is inline on the class constructor in `errors.ts`; not separately exported):

```ts
// 'truncated'           — readU8/readBytes/readFixed beyond end of buffer;
//                         also readBool/readOption when tag byte is out of range
// 'vlq-overflow'        — VLQ continuation bit set on byte 10 (exceeds u64);
//                         or decoded value exceeds the declared type bound (readVlqU32 > 0xffffffff)
// 'slice-out-of-bounds' — slice(start, end) args violate [0, buf.length]
// 'array-too-large'     — readArray decoded length > MAX_ARRAY_LENGTH (1 << 24)
```

**Plain `Error` — thrown by `ByteWriter` and `writeFixed` on programming errors**

These indicate bugs in calling code (out-of-range byte, negative VLQ value, wrong byte count to `writeFixed`). Not a typed class — programming errors need no dispatch.

**Note on `readBool` / `readOption` error codes:** Currently both throw `ReaderError('truncated')` for a tag byte that is present but has an invalid value (not 0 or 1). A future minor revision may introduce `'malformed-value'` for this case; see Known Limitations.

**`AutolykosV1NotSupportedError` — thrown by `verifyAutolykosV2` on V1 headers**

A typed error class wrapping the case where `verifyAutolykosV2` is called with `header.version === 1`. Mirrors sigma-rust's `AutolykosPowSchemeError::Unsupported` (`autolykos_pow_scheme.rs:322-324`). The `code` is the string literal `'autolykos-v1-not-supported'`.

Real Ergo nodes (incl. ergo-node-rust) skip v1 PoW verification structurally; this throw exists for callers that mistakenly hand a v1 header to `verifyAutolykosV2` directly. `@ergots/ergoscript`'s `SHeader.checkPow` eval arm catches this class and re-throws as `EvalError('autolykos-v1-not-supported')`.

**`PowHitInvalidParamsError` — thrown by `autolykosHitForMessageWithChecks` on parameter guard violations**

A typed error class for invalid Autolykos-2 PoW hit parameters. The `code` is the string literal `'pow-hit-invalid-params'`. Thrown when any of the three guards fires: `k < 2` (at least 2 elements required for the k-sum), `k > 32` (genIndexes does not support larger k), or `N < 16` (minimum table size). Mirrors the JVM `require(...)` calls in `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks` (`Autolykos2PowValidation.scala:115-120`). `@ergots/ergoscript`'s `SGlobal.powHit` eval arm catches this class and re-throws as `EvalError('pow-hit-invalid-params')`.

## Test corpus

Tests live in `packages/scorex/test/`. All tests run under both `node` and `jsdom` via two vitest configs (`vitest.config.ts` and `vitest.browser.config.ts`). Moved from `@ergots/nipopow` and `@ergots/ergoscript` during the phase 2h-c.0 extraction:

- `reader.test.ts` — `ByteReader` constructor, `readU8`, `readBytes`, `readVlqU`/`readVlqS`/`readVlqBigInt`/`readVlqBigIntSigned`, `slice`, overflow and truncation error paths.
- `writer.test.ts` — `ByteWriter` constructor, `writeU8`, `writeBytes`, `writeVlqU`/`writeVlqS`/`writeVlqBigInt`/`writeVlqBigIntSigned`, `toBytes`, error paths.
- `vlq.test.ts` — `encodeVlqU`/`decodeVlqU`, `encodeVlqZigZag`/`decodeVlqZigZag`, `readVlqU32`; round-trip fixtures; overflow and boundary cases; ZigZag sign-extension.
- `nipopow-reader.test.ts` — `ByteReader` used in nipopow-style call patterns; exercises the VLQ path on real proof bytes.
- `nipopow-writer.test.ts` — `ByteWriter` in nipopow-style serialization patterns.
- `option-array.test.ts` — `readOption`/`writeOption`, `readArray`/`writeArray`, `readBool`/`writeBool`; null and present branches; multi-element arrays; `array-too-large` error path.
- `header.test.ts` — `parseHeader`/`serializeHeader` byte-equality against sigma-rust fixtures for version 1 and version 2 mainnet headers; `id` derivation check; `timestamp` overflow guard.
- `autolykos-solution.test.ts` — `parseAutolykosSolution`/`serializeAutolykosSolution` byte-equality; v1 and v2 layouts; `powDistance` minimal-encoding round-trip.
- `autolykos-v2.test.ts` — `verifyAutolykosV2` against mainnet V2 headers; V1 throw path; helpers' unit tests.
- `nbits.test.ts` — `decodeCompactBits` round-trip + boundary values.

## Source mapping to sigma-rust

Pinned at sigma-rust branch `integration/ergots` at `~/projects/ergots/external/sigma-rust/`.

| Rust function / type (file) | TS function(s) (file) | Note |
|---|---|---|
| `sigma-ser/src/vlq_encode.rs::put_u64` / `get_u64` | `ByteWriter.writeVlqBigInt` / `ByteReader.readVlqBigInt` (`writer.ts`, `reader.ts`) | VLQ loop; BigInt accumulator used to avoid 32-bit truncation |
| `sigma-ser/src/zig_zag_encode.rs::encode` / `decode` | `ByteWriter.writeVlqBigIntSigned` / `ByteReader.readVlqBigIntSigned` (`writer.ts`, `reader.ts`) | ZigZag `(v<<1)^(v>>63)` — sign-aware shift emulated via BigInt masking |
| `sigma-ser/src/vlq_encode.rs::put_u64` / `get_u64` | `encodeVlqU`, `decodeVlqU`, `encodeVlqZigZag`, `decodeVlqZigZag` (`vlq.ts`) | Free-function API; same algorithm as the reader/writer methods |
| `sigma-ser/src/scorex_serialize.rs::SigmaSerializable` | `ByteReader` / `ByteWriter` classes | Scorex reader/writer pattern; Fleet SDK ergonomic helpers (readOption/writeOption/readArray/writeArray/readBool/writeBool) are TS-only additions not present in sigma-ser |
| `ergo-chain-types/src/header.rs::Header::scorex_parse` (lines 114-212) | `parseHeader` (`header.ts`) | 1:1 field order; `id` derived in-process by `deriveHeaderId` |
| `ergo-chain-types/src/header.rs::Header::scorex_serialize` | `serializeHeader` (`header.ts`) | Full header bytes = `serializeHeaderWithoutPow` + `serializeAutolykosSolution` |
| `ergo-chain-types/src/header.rs::Header::serialize_without_pow` | `serializeHeaderWithoutPow` (`header.ts`) | Used as Autolykos message input |
| `ergo-chain-types/src/header.rs::AutolykosSolution::serialize_bytes` | `parseAutolykosSolution`, `serializeAutolykosSolution` (`autolykos-solution.ts`) | version parameter selects v1 (minerPk + powOnetimePk + nonce + d_len + d_bytes) vs v2 (minerPk + nonce) layout |
| (TS-only) | `deriveHeaderId` (`header.ts`) | `blake2b256(serializeHeader(header))`; sigma-rust computes this inside `scorex_parse` rather than exposing it as a standalone function |
| (TS-only) | `readFixed`, `writeFixed` (`digests.ts`) | Named-field wrappers over `readBytes`/`writeBytes` with length checks; simplify fixed-size digest reads in `header.ts` and `autolykos-solution.ts` |
| (TS-only) | `BLOCK_ID_LEN`, `DIGEST32_LEN`, `AD_DIGEST_LEN`, `EC_POINT_LEN` (`digests.ts`) | Named length constants for clarity |
| (TS-only) | `MAX_ARRAY_LENGTH` (`reader.ts`) | DoS cap for `readArray`; 1 << 24 = 16,777,216 |
| (TS-only) | `readVlqU32` (`vlq.ts`) | Convenience wrapper: `decodeVlqU` + assert <= 0xffffffff |
| `@noble/hashes/blake2.js` (third-party) | `blake2b256` (`src/crypto/blake2b256.ts`) | Internal-only; not exported from index.ts |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::pow_hit` (lines 176-197) | `verifyAutolykosV2` + helpers (`autolykos-v2.ts`) | V2 path only; V1 sigma-rust returns pow_distance but our port throws AutolykosV1NotSupportedError |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::decode_compact_bits` | `decodeCompactBits` (`nbits.ts`) | Bitcoin-compact-bits target unpacking; bit-exact mirror |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::AutolykosPowSchemeError::Unsupported` (line 322) | `AutolykosV1NotSupportedError` (`errors.ts`) | V1 verification not implemented; sigma-rust returns Err on the same condition |
| JVM `Autolykos2PowValidation.hitForVersion2ForMessage` (`Autolykos2PowValidation.scala:122-137`) | `autolykosHitForMessage` (`autolykos-v2.ts`) | Un-checked hit core; Architecture C″ shared entry point |
| JVM `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks` (`Autolykos2PowValidation.scala:115-120`) | `autolykosHitForMessageWithChecks` (`autolykos-v2.ts`) | Guarded hit core; throws `PowHitInvalidParamsError` on k/N violations |
| JVM `scorex.utils.Ints.toByteArray` | `int32BE` (`autolykos-v2.ts`) | 4-byte big-endian int encoding; used to pass `height` as `h` bytes |
| JVM `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks` param guards | `PowHitInvalidParamsError` (`errors.ts`) | Typed error for k<2 / k>32 / N<16 guard violations |

## Version note (v6 P5c)

The P5c changes to this package (`autolykosHitForMessage`, `autolykosHitForMessageWithChecks`, `int32BE`, `PowHitInvalidParamsError` added; `buildAutolykosSeed`, `genIndexes`, `hashElement` removed from the public `index.ts` export) constitute a breaking public-API change. A version bump and npm republish of `@ergots/scorex` is required at v6 delivery (before or together with the `@ergots/nipopow` and `@ergots/ergoscript` v6 packages that depend on the new API).

## Known limitations / follow-ups

These items are deferred from phase 2h-c.0 and documented here so successor sessions can pick them up.

- **`readBool` and `readOption` throw `'truncated'` for malformed-but-present tag bytes.** When `readBool` reads a byte that is present but neither 0 nor 1, it throws `ReaderError('truncated')`. This is technically wrong — the buffer is not truncated; the byte is malformed. A future minor revision may add a `'malformed-value'` code variant for these cases. Requires coordinating the `ReaderError` code union change with all catch sites in `@ergots/nipopow` and `@ergots/ergoscript` that dispatch on `.code`. Low priority: in practice these call sites see only well-formed data from sigma-rust-generated fixtures.

- **`MAX_VLQ_BYTES` constant is declared twice.** Both `reader.ts` and `vlq.ts` declare `const MAX_VLQ_BYTES = 10` independently. This is a minor DRY gap. Moving it to a shared `_constants.ts` or having one file import from the other is a clean but non-urgent follow-up.

- **VLQ encode/decode loops are duplicated between class methods and free functions.** `ByteReader.readVlqBigInt` and `decodeVlqU` implement the same 10-iteration loop; `ByteWriter.writeVlqBigInt` and `encodeVlqU` implement the same emit loop (~20 LOC each). The free functions were preserved as a stateless API for callers that don't have a cursor (e.g. constructing a VLQ prefix length to prepend). A unification via a `_vlq_core.ts` internal module is feasible but has no functional impact.

- **`hexToBytes` / `bytesToHex` test helpers are duplicated.** `packages/scorex/test/helpers.ts` and `packages/nipopow/test/helpers.ts` both define these utilities. They are test-only and not in any published output. A shared `@ergots/test-utils` subpath export is a reasonable future step once the duplication burden grows.

## Cross-references

- `docs/specs/2026-05-19-ergots-scorex-package-design.md` — design rationale, extraction scope, Fleet SDK evaluation, migration plan
- `facts/nipopow.md` — primary consumer; `@ergots/nipopow` imports `ByteReader`, `ByteWriter`, `ReaderError`, VLQ functions, `Header`, `AutolykosSolution`, `parseHeader`, `serializeHeader` from `@ergots/scorex`
- `facts/ergoscript-wire.md` — primary consumer; `@ergots/ergoscript` imports the same codec layer
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list, package list
- `~/projects/ergots/external/sigma-rust/sigma-ser/src/vlq_encode.rs` — VLQ reference (pinned `integration/ergots`)
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/header.rs` — Header + AutolykosSolution wire format reference (pinned `integration/ergots`)
