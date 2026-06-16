# `@ergots/scorex` — Interface Contract

The boundary contract for the shared Scorex wire-codec layer and block-Header types package. This package exists as the foundational codec layer shared by `@ergots/nipopow` and `@ergots/ergoscript`: both consume `ByteReader`, `ByteWriter`, VLQ functions, and the `Header` / `AutolykosSolution` types. Extracting this layer removes a divergence risk between the two packages' previously-separate codec implementations and provides the shared `Header` type required by `@ergots/ergoscript` (SHeader runtime + 17 method handlers). The narrative rationale and extraction design live in `docs/specs/2026-05-19-ergots-scorex-package-design.md`; this file is *only* the interface.

Authoritative algorithmic references:

- `sigma-ser/src/vlq_encode.rs` — VLQ + ZigZag-VLQ encode/decode (pinned at sigma-rust `integration/ergots`, `~/projects/ergots/external/sigma-rust/`)
- `sigma-ser/src/scorex_serialize.rs` — `ByteReader` / `ByteWriter` patterns
- `ergo-chain-types/src/header.rs` — `Header::scorex_parse` / `scorex_serialize` / `AutolykosSolution::serialize_bytes`

Where this file is silent on implementation detail, those are canonical.

## Scope

**Ships in this contract (v0.3.0):**

1. `ByteReader` class — cursor-based reader with VLQ + ZigZag-VLQ decoding, bool/option/array helpers, a `slice()` view, and a JVM-style `positionLimit` read window.
2. `ByteWriter` class — chunk-accumulating writer with VLQ + ZigZag-VLQ encoding, bool/option/array helpers, and a `toBytes()` finalizer.
3. `ReaderError` class — typed error thrown by `ByteReader` on malformed input; 7-variant `code` union.
4. VLQ free functions: `encodeVlqU`, `decodeVlqU`, `encodeVlqZigZag`, `decodeVlqZigZag`, `readVlqU32` — stateless encode/decode operating on `ByteReader` and returning `Uint8Array` / `bigint`.
5. `MAX_ARRAY_LENGTH` constant — 16,777,216 (`1 << 24`); the DoS cap applied by `readArray`.
6. Digest constants and helpers: `BLOCK_ID_LEN`, `DIGEST32_LEN`, `AD_DIGEST_LEN`, `EC_POINT_LEN`, `readFixed`, `writeFixed`.
7. `Header` interface + `parseHeader`, `serializeHeader`, `serializeHeaderWithoutPow`, `deriveHeaderId`.
8. `AutolykosSolution` interface + `parseAutolykosSolution`, `serializeAutolykosSolution`.
9. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.
10. Autolykos v2 PoW verifier: `verifyAutolykosV2(header): boolean` + helpers (`calcBigN`, `autolykosMessage`). Internals `buildAutolykosSeed`, `genIndexes`, `hashElement` are module-internal — not exported from `packages/scorex/src/index.ts`.
11. `decodeCompactBits(nBits): bigint` — Bitcoin-compact-bits target unpacking, used by the Autolykos v2 verifier.
12. `AutolykosV1NotSupportedError` typed error class — thrown by `verifyAutolykosV2` on v1 headers (matches sigma-rust `AutolykosPowSchemeError::Unsupported`).
13. `autolykosHitForMessage(k, msg, nonce, h, N): bigint` — un-checked Autolykos-2 PoW hit core. Faithful port of JVM `Autolykos2PowValidation.hitForVersion2ForMessage` (`Autolykos2PowValidation.scala:122-137`). `h` is raw bytes; the header path passes `int32BE(height)`.
14. `autolykosHitForMessageWithChecks(k, msg, nonce, h, N): bigint` — same hit core, guarded by `require(k>=2)`, `require(k<=32)`, `require(N>=16)`; throws `PowHitInvalidParamsError` on violation. JVM `hitForVersion2ForMessageWithChecks` (`Autolykos2PowValidation.scala:115-120`).
15. `int32BE(n: number): Uint8Array` — 4-byte big-endian encoding. JVM `scorex.utils.Ints.toByteArray`.
16. `PowHitInvalidParamsError` typed error class — `readonly code = 'pow-hit-invalid-params'`; thrown by `autolykosHitForMessageWithChecks` on parameter-guard violations.

**Does NOT ship:**

- **`SValue` / `SType` / `Expr` types.** Package-specific to `@ergots/ergoscript`; live in `packages/ergoscript/src/mir/`.
- **`ErgoBox` / `NipopowProof` / `AvlTreeData`.** Package-specific to their respective packages; not shared.
- **base58 / base58check helpers.** Single-consumer in `@ergots/ergoscript` address codec; not promoted to shared layer.
- **`blake2b256` wrapper.** Exported from `index.ts` (used by `@ergots/transaction`'s `transactionId`). Thin wrapper over `@noble/hashes/blake2.js`; signature: `blake2b256(data: Uint8Array): Uint8Array`. Any package that needs blake2b for its own purposes may also import directly from `@noble/hashes/blake2.js`.

## Public surface (v0.3.0)

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
  // Does NOT inherit positionLimit: the fork's buffer is rebased to offset 0, so the
  // parent's limit (an absolute offset) would be meaningless over it — a fork gets the
  // fresh default over its own buffer. Callers that need a window arm it on the SHARED
  // reader (as the ergoscript SBox candidate window does); the JVM never forks — it
  // scopes positionLimit natively on the one reader. Mechanism difference only; the
  // accepted byte-language is unchanged as long as windowed spans stay on one reader.
  forkSubReader(bytes: Uint8Array): ByteReader

  // ── Position-limit read window ──────────────────────────────────────────────
  // Faithful port of the JVM CoreByteReader.positionLimit (CoreByteReader.scala:25-27
  // check, :36-108 per-get call sites, :133-137 accessor). Default on a fresh reader
  // = the buffer's byte length (JVM default: r.position + r.remaining = buffer end).
  // The setter is a PLAIN assignment with NO clamp (:135-137) — a nested window (e.g.
  // a box constant inside a register of an outer box) may legitimately EXCEED the
  // enclosing limit for the inner span; the caller's save/set/restore discipline
  // reinstates the outer limit afterward:
  //   const saved = r.positionLimit
  //   r.positionLimit = r.position + N
  //   …windowed parse…
  //   r.positionLimit = saved        // mirrors ErgoBoxCandidate.scala:191,235
  //
  // LAZY entry-check semantics — ONE check per logical consuming primitive: readU8,
  // readBytes, and readVlqBigInt check `position > positionLimit` at their START and
  // throw ReaderError('position-limit-exceeded'); the JVM analogue is
  // CheckPositionLimit, validation rule 1014 (ValidationRules.scala:169-189). The
  // check is strict `>` — a read beginning exactly AT the limit passes. Past the one
  // entry check the primitive's bytes are read UNCHECKED: readVlqBigInt's
  // continuation-byte loop and readBytes' N-byte run may STRADDLE the limit (start
  // ≤ limit, end past it), exactly like JVM getULong/getBytes — so an overrun by a
  // windowed span's FINAL read escapes entirely. readVlqU / readVlqS /
  // readVlqBigIntSigned / readBool / readOption / readArray inherit the check
  // through those three primitives, and the vlq.ts free functions (decodeVlqU /
  // decodeVlqZigZag / readVlqU32) DELEGATE to readVlqBigInt / readVlqBigIntSigned —
  // one window check per logical read, never per-byte (a
  // per-byte loop over public readU8 would reject straddling VLQs the JVM accepts).
  // readFixed (digests.ts) PARTICIPATES via readBytes' entry check and passes
  // 'position-limit-exceeded' through UNMODIFIED; any other underlying failure
  // keeps its named-field re-code to 'truncated'. slice() is non-consuming and does
  // NOT check. At the DEFAULT limit (buffer end) the entry check can never fire —
  // consuming reads hit the 'truncated' end-of-buffer bound first — so readers that
  // never set positionLimit (e.g. @ergots/nipopow's block codec) see no behavior change.
  get positionLimit(): number       // absolute offset; default = buffer byte length
  set positionLimit(limit: number)  // plain assignment — no clamp, no validation

  // Return a view (no copy) from start (inclusive) to end (exclusive).
  // Throws ReaderError('slice-out-of-bounds') if args violate [0, buf.length].
  slice(start: number, end: number): Uint8Array

  readU8(): number                // throws ReaderError('truncated') at EOF;
                                  // 'position-limit-exceeded' entry check (window block above)
  readBytes(n: number): Uint8Array // throws ReaderError('truncated') if n > remaining;
                                  // 'position-limit-exceeded' entry check (then N bytes unchecked)

  // VLQ unsigned — narrows bigint result to number (caller ensures <= 2^53-1)
  readVlqU(): number
  // VLQ unsigned — full 64-bit safe, returns bigint
  readVlqBigInt(): bigint         // throws ReaderError('vlq-overflow') after 10 continuation bytes;
                                  // 'position-limit-exceeded' entry check ONCE, byte loop unchecked
                                  // (straddling VLQs tolerated, like JVM getULong)

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
  readonly code: 'truncated' | 'vlq-overflow' | 'slice-out-of-bounds' | 'array-too-large' | 'max-tree-depth-exceeded' | 'position-limit-exceeded' | 'value-out-of-range'
}

export class AutolykosV1NotSupportedError extends Error {
  readonly code: 'autolykos-v1-not-supported'
}

export class PowHitInvalidParamsError extends Error {
  readonly code: 'pow-hit-invalid-params'
}

// ─── VLQ free functions ───────────────────────────────────────────────────────

// Encode/decode accept and return bigint (arbitrary precision; callers narrow to number as needed).
// The decode-side functions are delegating wrappers over the ByteReader methods
// (readVlqBigInt / readVlqBigIntSigned): ONE positionLimit check per logical read
// (see the window block above); the encode side keeps its own emit loop.
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
  // throws ReaderError('truncated') if fewer than len bytes remain;
  // a 'position-limit-exceeded' from readBytes' window entry check passes through UNMODIFIED

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
  timestamp: bigint              // ms since epoch; u64 on wire, carried losslessly as bigint
  nBits: number                  // Bitcoin-compact difficulty (u32, 4 bytes big-endian on wire — NOT VLQ)
  height: number                 // u32 > 0; VLQ-encoded on wire; rejected with ReaderError('value-out-of-range') when > 2³¹−1
  extensionRoot: Uint8Array      // 32 bytes
  autolykosSolution: AutolykosSolution
  votes: Uint8Array              // 3 bytes
  unparsedBytes: Uint8Array      // forward-compat; 0 bytes for version 1; length prefix u8 for version > 1; see type-invariants for version 2–4 parse behaviour
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
// `parseHeader` derives the header `id` by hashing the CONSUMED INPUT SLICE `[start, end)`
// (`blake2b256` over the exact bytes read), matching the JVM `ErgoHeader`
// (id = `Blake2b256(_bytes)`, `_bytes` = retained consumed slice;
// `ErgoHeader.scala:132-140` id, `:167-180` capture) and sigma-rust `ergo-node-integration`.
// The standalone `deriveHeaderId(header)` export remains a RE-serialization helper for the
// construct-from-object path; it coincides with the parse-time id for canonical encodings and
// diverges only on adversarial non-minimal encodings (where the parse-time slice id is canonical).
export function deriveHeaderId(header: Header): Uint8Array  // 32 bytes

// Parse / serialize AutolykosSolution (version determines v1 vs v2 wire layout).
export function parseAutolykosSolution(reader: ByteReader, version: number): AutolykosSolution
export function serializeAutolykosSolution(s: AutolykosSolution, version: number): Uint8Array

// ─── Autolykos v2 PoW verifier ───────────────────────────────────────────────

export function calcBigN(version: number, height: number): number
export function autolykosMessage(header: Header): Uint8Array  // 32 bytes
// buildAutolykosSeed, genIndexes, hashElement are module-internal; not exported from index.ts
export function verifyAutolykosV2(header: Header): boolean
  // throws AutolykosV1NotSupportedError on header.version === 1

// ─── Autolykos v2 PoW hit core (shared by verifyAutolykosV2, nipopow.compare, SGlobal.powHit) ───

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

// ─── blake2b-256 ─────────────────────────────────────────────────────────────
// Added Task 7 (transaction-tier) so @ergots/transaction can import it for
// transactionId without depending on @noble/hashes directly.

export function blake2b256(data: Uint8Array): Uint8Array  // 32 bytes
```

## Type invariants

Callers may rely on these without re-checking after any value returned from the public API.

**`Header`:**

- `id` is 32 bytes; never appears on the wire. On parse it is derived from the CONSUMED INPUT SLICE `[start, end)` via `blake2b256` (matching the JVM `ErgoHeader`, `:132-140`/`:167-180`); the `deriveHeaderId(header)` export recomputes it by re-serialization (equal for canonical encodings, diverges on adversarial non-minimal ones — see the `deriveHeaderId` caveat above).
- `parentId`, `adProofsRoot`, `transactionRoot`, `extensionRoot` are exactly 32 bytes.
- `stateRoot` is exactly 33 bytes (ADDigest = 32-byte tree root + 1-byte tree height).
- `votes` is exactly 3 bytes.
- `nBits` is encoded as 4 bytes big-endian on the wire (NOT VLQ — this diverges from most fields). The parsed value is a `number` in `[0, 2^32-1]`.
- `timestamp` is a `bigint` carrying the full wire u64 losslessly; `parseHeader` imposes no upper bound (JVM carries Long — round-trip identity holds for the entire u64 range).
- `height` is a `number` in `[0, 2^32-1]` (u32 range enforced by `readVlqU32`). Rejected with `ReaderError('value-out-of-range')` when `> 2³¹−1`, mirroring the JVM `getUInt().toIntExact` (`HeaderWithoutPow.scala:76`). Contrast: AvlTree `keyLength` uses `getUInt().toInt` and WRAPS — do not conflate.
- `unparsedBytes` is a `Uint8Array` of length 0 for version 1 headers; for version > 1 headers, the length is read as a u8 prefix (0..=255 bytes). For `version > 1` the u8 length prefix is always read, but the payload bytes are CONSUMED into `unparsedBytes` only when `length > 0 && version > 4` (`HeaderVersion.Interpreter60Version`); for versions 2/3/4 the length byte is read and the payload is left in the stream (it flows into the `AutolykosSolution` parse), so `unparsedBytes` is empty. The `> 1` / `> 4` gates are on the **SIGNED** version: the JVM reads `version = r.getByte()` (a signed `Byte`, `HeaderWithoutPow.scala:68`), so a version byte `>= 0x80` (negative as i8) makes both gates false and the whole `unparsedBytes` block is SKIPPED — the bytes after `votes` flow straight into the `AutolykosSolution`. ergots stores `version` unsigned (0..=255) for round-trip but applies the signed i8 value at the gates (parse + serialize); adversarial-only, since honest header versions are 1–4. `serializeHeader` mirrors the JVM: it writes the length prefix + payload for any (signed) `version > 1` (so a hand-constructed v2–v4 header with non-empty `unparsedBytes` re-emits them — non-round-tripping, exactly as the JVM does). JVM `HeaderWithoutPow.scala:61-64,68,81-91`.

**`AutolykosSolution`:**

- `minerPk` is exactly 33 bytes (compressed secp256k1 point).
- `powOnetimePk` is `null` for version >= 2 headers; exactly 33 bytes for version 1 headers.
- `nonce` is exactly 8 bytes.
- `powDistance` is `null` for version >= 2 headers; a non-negative `bigint` for version 1 headers (minimal big-endian encoding from the `d_len` + `d_bytes` wire representation). `powDistance === 0n` corresponds to `d_len === 1, d_bytes === [0x00]` on the wire (matching sigma-rust's `BigUint::to_bytes_be()` which returns `[0]` for zero). For backwards compatibility the parser also accepts `d_len === 0` and produces `powDistance === 0n`, but the writer always emits the `d_len=1` form. Rejected with `ReaderError('value-out-of-range')` when `≥ 2²⁵⁵` (`bitLength > 255`), mirroring the JVM `BigIntegers.fromUnsignedByteArray(...).toSignedBigIntValueExact` / `fitsIn256Bits` (`ErgoHeader.scala:77`, `Extensions.scala:199-223`). This keeps the value within the signed-256 invariant every other BigInt producer enforces.

**VLQ:**

- `encodeVlqU` / `decodeVlqU` handle unsigned integers up to 2^64 - 1 (callers pass a non-negative `bigint` ≤ 2^64 − 1). `decodeVlqU` (and `readVlqBigInt`) wrap mod 2^64 like sigma-rust `get_u64` / JVM protobuf loop when the 10-byte stream encodes a value ≥ 2^64; 10-continuation-byte streams (overflow of the VLQ length limit) still throw `ReaderError('vlq-overflow')`; `encodeVlqU` / `writeVlqBigInt` reject values > 2^64 - 1.
- `encodeVlqZigZag` / `decodeVlqZigZag` handle signed integers in the i64 range `[-2^63, 2^63 - 1]`.
- `MAX_ARRAY_LENGTH = 1 << 24 = 16,777,216` is a hard DoS cap applied by `readArray`. No protocol element legitimately exceeds this.

## Cross-cutting guarantees

- **Determinism.** All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output. Byte-equality with sigma-rust is the load-bearing invariant for every `Header` and `AutolykosSolution` fixture.
- **Synchronous.** No async surface. Codec operations are tight inner loops; an async boundary would only add overhead.
- **No throws on return-path.** `ByteReader` and the VLQ free functions throw only on malformed input (`ReaderError`) or programming errors (plain `Error`). They do not silently produce partial results.
- **Browser-compat.** Runtime support: Node >= 20, evergreen browsers with native ESM. Never `Buffer`. Never `globalThis.crypto`. No `process`, `fs`, `path`, `os`, or `node:*` imports in `packages/scorex/src/`. Hashing via `@noble/hashes@2.2.0` only (`blake2b256` is now exported — see "blake2b-256" in the public surface).
- **ESM-only.** Bundle deliberately omits CJS entry points.
- **No top-level await** in published code.
- **No WASM** direct or transitive.
- **`@noble/hashes@2.2.0` is the only runtime dependency.**

## Failure model

**`ReaderError` — thrown by `ByteReader` on malformed bytes (7 codes)**

These represent malformed or truncated wire input, not programming errors on the caller's side.

`ReaderError.code` is one of (the union is inline on the class constructor in `errors.ts`; not separately exported):

```ts
// 'truncated'           — readU8/readBytes/readFixed beyond end of buffer;
//                         also readBool/readOption when tag byte is out of range
// 'vlq-overflow'        — VLQ continuation bit set on byte 10 (exceeds u64);
//                         or decoded value exceeds the declared type bound (readVlqU32 > 0xffffffff)
// 'slice-out-of-bounds' — slice(start, end) args violate [0, buf.length]
// 'array-too-large'     — readArray decoded length > MAX_ARRAY_LENGTH (1 << 24)
// 'max-tree-depth-exceeded' — enterDepth would push level past maxTreeDepth
//                         (JVM SigmaConstants.MaxTreeDepth = 110 cap)
// 'position-limit-exceeded' — a consuming read begins past positionLimit (strict >).
//                         Direct check sites: readU8, readBytes, readVlqBigInt (entry
//                         check only — see the window block in the public surface);
//                         readVlqU/readVlqS/readVlqBigIntSigned/readBool/readOption/
//                         readArray inherit through them, as do the vlq.ts free
//                         functions (decodeVlqU/decodeVlqZigZag/readVlqU32, by
//                         delegation) and readFixed (passes the code through
//                         UNMODIFIED — only other failures re-code to 'truncated').
//                         JVM analogue: CheckPositionLimit, validation rule 1014
//                         (ValidationRules.scala:169-189; CoreByteReader.scala:25-27)
// 'value-out-of-range'   — a well-formed integer/BigInt field whose decoded value exceeds
//                         its consensus range: header `height` > 2³¹−1 (JVM
//                         `getUInt().toIntExact`, HeaderWithoutPow.scala:76), or v1
//                         `powDistance` ≥ 2²⁵⁵ (JVM `toSignedBigIntValueExact`,
//                         `fitsIn256Bits`, ErgoHeader.scala:77, Extensions.scala:199-223).
//                         Distinct from `vlq-overflow` (malformed/over-long VLQ encoding).
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

Tests live in `packages/scorex/test/`. All tests run under both `node` and `jsdom` via two vitest configs (`vitest.config.ts` and `vitest.browser.config.ts`). Moved from `@ergots/nipopow` and `@ergots/ergoscript` during the codec extraction:

- `reader.test.ts` — `ByteReader` constructor, `readU8`, `readBytes`, `readVlqU`/`readVlqS`/`readVlqBigInt`/`readVlqBigIntSigned`, `slice`, overflow and truncation error paths.
- `writer.test.ts` — `ByteWriter` constructor, `writeU8`, `writeBytes`, `writeVlqU`/`writeVlqS`/`writeVlqBigInt`/`writeVlqBigIntSigned`, `toBytes`, error paths.
- `vlq.test.ts` — `encodeVlqU`/`decodeVlqU`, `encodeVlqZigZag`/`decodeVlqZigZag`, `readVlqU32`; round-trip fixtures; overflow and boundary cases; ZigZag sign-extension.
- `nipopow-reader.test.ts` — `ByteReader` used in nipopow-style call patterns; exercises the VLQ path on real proof bytes.
- `nipopow-writer.test.ts` — `ByteWriter` in nipopow-style serialization patterns.
- `option-array.test.ts` — `readOption`/`writeOption`, `readArray`/`writeArray`, `readBool`/`writeBool`; null and present branches; multi-element arrays; `array-too-large` error path.
- `header.test.ts` — `parseHeader`/`serializeHeader` byte-equality against sigma-rust fixtures for version 1 and version 2 mainnet headers; `id` derivation check; u64 timestamp lossless round-trip (beyond 2^53); `readFixed` 'position-limit-exceeded' pass-through (not re-coded to 'truncated').
- `autolykos-solution.test.ts` — `parseAutolykosSolution`/`serializeAutolykosSolution` byte-equality; v1 and v2 layouts; `powDistance` minimal-encoding round-trip.
- `autolykos-v2.test.ts` — `verifyAutolykosV2` against mainnet V2 headers; V1 throw path; helpers' unit tests.
- `nbits.test.ts` — `decodeCompactBits` round-trip + boundary values.

## Source mapping to sigma-rust

Pinned at sigma-rust branch `integration/ergots` at `~/projects/ergots/external/sigma-rust/`.

| Rust function / type (file) | TS function(s) (file) | Note |
|---|---|---|
| `sigma-ser/src/vlq_encode.rs::put_u64` / `get_u64` | `ByteWriter.writeVlqBigInt` / `ByteReader.readVlqBigInt` (`writer.ts`, `reader.ts`) | VLQ loop; BigInt accumulator used to avoid 32-bit truncation |
| `sigma-ser/src/zig_zag_encode.rs::encode` / `decode` | `ByteWriter.writeVlqBigIntSigned` / `ByteReader.readVlqBigIntSigned` (`writer.ts`, `reader.ts`) | ZigZag `(v<<1)^(v>>63)` — sign-aware shift emulated via BigInt masking |
| `sigma-ser/src/vlq_encode.rs::put_u64` / `get_u64` | `encodeVlqU`, `decodeVlqU`, `encodeVlqZigZag`, `decodeVlqZigZag` (`vlq.ts`) | Free-function API; the decode side is a delegating wrapper over `ByteReader.readVlqBigInt` / `readVlqBigIntSigned` (one positionLimit check per logical read); the encode side keeps its own emit loop |
| `sigma-ser/src/scorex_serialize.rs::SigmaSerializable` | `ByteReader` / `ByteWriter` classes | Scorex reader/writer pattern; Fleet SDK ergonomic helpers (readOption/writeOption/readArray/writeArray/readBool/writeBool) are TS-only additions not present in sigma-ser |
| `ergo-chain-types/src/header.rs::Header::scorex_parse` (lines 114-212) | `parseHeader` (`header.ts`) | 1:1 field order; `id` derived from the CONSUMED INPUT SLICE `[start, end)` via `blake2b256`, matching the JVM (`ErgoHeader.scala:132-140`, `:167-180`) and sigma-rust `ergo-node-integration` |
| `ergo-chain-types/src/header.rs::Header::scorex_serialize` | `serializeHeader` (`header.ts`) | Full header bytes = `serializeHeaderWithoutPow` + `serializeAutolykosSolution` |
| `ergo-chain-types/src/header.rs::Header::serialize_without_pow` | `serializeHeaderWithoutPow` (`header.ts`) | Used as Autolykos message input |
| `ergo-chain-types/src/header.rs::AutolykosSolution::serialize_bytes` | `parseAutolykosSolution`, `serializeAutolykosSolution` (`autolykos-solution.ts`) | version parameter selects v1 (minerPk + powOnetimePk + nonce + d_len + d_bytes) vs v2 (minerPk + nonce) layout |
| (TS-only) | `deriveHeaderId` (`header.ts`) | RE-serialization helper for the construct-from-object path: `blake2b256(serializeHeader(header))`. Coincides with the parse-time slice id for canonical encodings; diverges on adversarial non-minimal encodings (where the parse-time slice id is canonical). `parseHeader` uses the consumed-slice basis (see `parseHeader` row above); `deriveHeaderId` is the standalone export for object-construction callers |
| (TS-only) | `readFixed`, `writeFixed` (`digests.ts`) | Named-field wrappers over `readBytes`/`writeBytes` with length checks; simplify fixed-size digest reads in `header.ts` and `autolykos-solution.ts` |
| (TS-only) | `BLOCK_ID_LEN`, `DIGEST32_LEN`, `AD_DIGEST_LEN`, `EC_POINT_LEN` (`digests.ts`) | Named length constants for clarity |
| (TS-only) | `MAX_ARRAY_LENGTH` (`reader.ts`) | DoS cap for `readArray`; 1 << 24 = 16,777,216 |
| (TS-only) | `readVlqU32` (`vlq.ts`) | Convenience wrapper: `ByteReader.readVlqBigInt` + assert <= 0xffffffff |
| `@noble/hashes/blake2.js` (third-party) | `blake2b256` (`src/crypto/blake2b256.ts`) | Exported from `index.ts` (Task 7; consumed by `@ergots/transaction`'s `transactionId`). `blake2b256(data: Uint8Array): Uint8Array`. |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::pow_hit` (lines 176-197) | `verifyAutolykosV2` + helpers (`autolykos-v2.ts`) | V2 path only; V1 sigma-rust returns pow_distance but our port throws AutolykosV1NotSupportedError |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::decode_compact_bits` | `decodeCompactBits` (`nbits.ts`) | Bitcoin-compact-bits target unpacking; bit-exact mirror |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::AutolykosPowSchemeError::Unsupported` (line 322) | `AutolykosV1NotSupportedError` (`errors.ts`) | V1 verification not implemented; sigma-rust returns Err on the same condition |
| JVM `Autolykos2PowValidation.hitForVersion2ForMessage` (`Autolykos2PowValidation.scala:122-137`) | `autolykosHitForMessage` (`autolykos-v2.ts`) | Un-checked hit core; shared entry point |
| JVM `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks` (`Autolykos2PowValidation.scala:115-120`) | `autolykosHitForMessageWithChecks` (`autolykos-v2.ts`) | Guarded hit core; throws `PowHitInvalidParamsError` on k/N violations |
| JVM `scorex.utils.Ints.toByteArray` | `int32BE` (`autolykos-v2.ts`) | 4-byte big-endian int encoding; used to pass `height` as `h` bytes |
| JVM `Autolykos2PowValidation.hitForVersion2ForMessageWithChecks` param guards | `PowHitInvalidParamsError` (`errors.ts`) | Typed error for k<2 / k>32 / N<16 guard violations |
| JVM `CoreByteReader.positionLimit` (`CoreByteReader.scala:25-27, 36-108, 133-137`) | `ByteReader.positionLimit` getter/setter + per-primitive entry checks (`reader.ts`) | Lazy read window: ONE check per logical read, strict `>`, no clamp on set; throws `ReaderError('position-limit-exceeded')` ≡ rule 1014 `CheckPositionLimit` (`ValidationRules.scala:169-189`). sigma-rust has NO equivalent (its `BoundedVec` token cap is a count-shaped approximation — see the SBox candidate-size window section in `facts/ergoscript-wire.md`) |

## Known limitations / follow-ups

These follow-ups are documented here so successor sessions can pick them up.

- **`readBool` and `readOption` throw `'truncated'` for malformed-but-present tag bytes.** When `readBool` reads a byte that is present but neither 0 nor 1, it throws `ReaderError('truncated')`. This is technically wrong — the buffer is not truncated; the byte is malformed. A future minor revision may add a `'malformed-value'` code variant for these cases. Requires coordinating the `ReaderError` code union change with all catch sites in `@ergots/nipopow` and `@ergots/ergoscript` that dispatch on `.code`. Low priority: in practice these call sites see only well-formed data from sigma-rust-generated fixtures.

- **VLQ ENCODE loop is duplicated between the writer method and the free function.** `ByteWriter.writeVlqBigInt` and `encodeVlqU` implement the same emit loop (~20 LOC). The decode-side duplication has been eliminated: `decodeVlqU` / `decodeVlqZigZag` / `readVlqU32` now DELEGATE to `ByteReader.readVlqBigInt` / `readVlqBigIntSigned` — the duplication was not cosmetic, it was a latent consensus fork (the free functions looped over public `readU8()`, firing a PER-BYTE positionLimit check under an armed window where the methods — and the JVM getULong — check once per logical read; a VLQ straddling the window limit was rejected instead of accepted). The remaining encode-side duplication has no equivalent hazard (writers carry no window); unifying it via a shared emit helper stays a clean but non-urgent follow-up. (`MAX_VLQ_BYTES` is now declared once, in `reader.ts` — the old double declaration went away with `decodeVlqU`'s loop.)

- **`hexToBytes` / `bytesToHex` test helpers are duplicated.** `packages/scorex/test/helpers.ts` and `packages/nipopow/test/helpers.ts` both define these utilities. They are test-only and not in any published output. A shared `@ergots/test-utils` subpath export is a reasonable future step once the duplication burden grows.

## Cross-references

- `docs/specs/2026-05-19-ergots-scorex-package-design.md` — design rationale, extraction scope, Fleet SDK evaluation, migration plan
- `facts/nipopow.md` — primary consumer; `@ergots/nipopow` imports `ByteReader`, `ByteWriter`, `ReaderError`, VLQ functions, `Header`, `AutolykosSolution`, `parseHeader`, `serializeHeader` from `@ergots/scorex`
- `facts/ergoscript-wire.md` — primary consumer; `@ergots/ergoscript` imports the same codec layer; its SBox data-parse arm arms a 4096-byte `positionLimit` candidate window (4096 = JVM `ErgoBox.MaxBoxSize`, `SigmaConstants.scala:24`) — see that file's SBox candidate-size window section
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list, package list
- `~/projects/ergots/external/sigma-rust/sigma-ser/src/vlq_encode.rs` — VLQ reference (pinned `integration/ergots`)
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/header.rs` — Header + AutolykosSolution wire format reference (pinned `integration/ergots`)
