# @ergots/scorex

Pure-TypeScript Scorex wire-codec layer, block-Header types, and Autolykos v2 PoW verifier. Browser-compatible. Validated byte-for-byte against sigma-rust (`ergo-chain-types` + `sigma-ser`, branch `integration/ergots`).

This package is the shared foundation for `@ergots/nipopow` and `@ergots/ergoscript`: it provides the `ByteReader` / `ByteWriter` classes, VLQ + ZigZag-VLQ encode/decode, the `Header` and `AutolykosSolution` types, digest-length constants, and the Autolykos v2 proof-of-work verifier (`verifyAutolykosV2` and `decodeCompactBits`). Extracting this layer removes duplicate codec implementations across packages and provides a stable, single-source-of-truth for the Ergo block-header wire format.

## Install

```bash
npm install @ergots/scorex
```

## Public API

### Codec layer

```ts
import { ByteReader, ByteWriter, ReaderError, MAX_ARRAY_LENGTH } from '@ergots/scorex';
import { encodeVlqU, decodeVlqU, encodeVlqZigZag, decodeVlqZigZag, readVlqU32 } from '@ergots/scorex';

const r = new ByteReader(bytes);
const n = r.readVlqU();             // plain unsigned VLQ -> number
const s = r.readVlqS();             // ZigZag VLQ -> number (signed)
const big = r.readVlqBigInt();      // plain unsigned VLQ -> bigint, wrapping mod 2^64 (matching JVM getULong / sigma-rust get_u64)
const opt = r.readOption(sub => sub.readU8());  // null | T
const arr = r.readArray(sub => sub.readU8());   // T[]

const w = new ByteWriter();
w.writeVlqU(42);
w.writeOption(null, (sub, v) => sub.writeU8(v));
w.writeArray([1, 2, 3], (sub, v) => sub.writeU8(v));
const out = w.toBytes();            // Uint8Array
```

`ByteReader.positionLimit` (getter/setter) arms a lazy read window: a consuming read that *begins* past the limit throws `ReaderError('position-limit-exceeded')`. ONE entry check per logical primitive (`readU8` / `readBytes` / `readVlqBigInt`; every other read inherits through them), strict `>` — a read that merely straddles the limit is tolerated. The setter is plain assignment (no clamp, no validation); the default is the buffer end. Save/restore around a bounded span mirrors the JVM `CoreByteReader.positionLimit` accessor (`CoreByteReader.scala:133-137`; validation rule 1014 `CheckPositionLimit`, `ValidationRules.scala:169-189`):

```ts
const saved = r.positionLimit;
r.positionLimit = r.position + maxSize;
// ... bounded reads; an overrunning read throws ReaderError('position-limit-exceeded') ...
r.positionLimit = saved;
```

### Block Header types and codecs

```ts
import { parseHeader, serializeHeader, serializeHeaderWithoutPow, deriveHeaderId } from '@ergots/scorex';
import type { Header, AutolykosSolution } from '@ergots/scorex';

const header = parseHeader(reader);   // derives id in-process; not read from wire
const bytes  = serializeHeader(header);
const id     = deriveHeaderId(header); // blake2b256(serializeHeader(header)); 32 bytes
```

### Digest helpers

```ts
import { BLOCK_ID_LEN, DIGEST32_LEN, AD_DIGEST_LEN, EC_POINT_LEN, readFixed, writeFixed } from '@ergots/scorex';
```

### Autolykos v2 PoW verifier

```ts
import { verifyAutolykosV2, decodeCompactBits, AutolykosV1NotSupportedError } from '@ergots/scorex';

const ok: boolean = verifyAutolykosV2(header);  // throws AutolykosV1NotSupportedError on v1 headers
const target: bigint = decodeCompactBits(header.nBits);  // Bitcoin-compact difficulty -> 256-bit target
```

Verifies an Autolykos v2 proof-of-work solution against the header's self-declared `nBits` target. v1 headers throw a typed error (sigma-rust parity — neither sigma-rust nor `ergo-node-rust` verify v1 PoW; v1 is JVM-only territory).

### Autolykos-2 PoW hit core

```ts
import {
  autolykosHitForMessage,
  autolykosHitForMessageWithChecks,
  int32BE,
  PowHitInvalidParamsError
} from '@ergots/scorex';

// Un-checked hit core (callers responsible for parameter validity):
const hit: bigint = autolykosHitForMessage(k, msg, nonce, int32BE(height), N);

// Guarded variant — throws PowHitInvalidParamsError on k<2, k>32, or N<16:
const hit2: bigint = autolykosHitForMessageWithChecks(k, msg, nonce, h, N);
```

The hit primitive shared by `verifyAutolykosV2`, `@ergots/nipopow`'s proof comparison, and `@ergots/ergoscript`'s `Global.powHit` evaluator arm. Faithful port of JVM `Autolykos2PowValidation.hitForVersion2ForMessage`. `int32BE` encodes a signed 32-bit integer as 4 big-endian bytes (JVM `scorex.utils.Ints.toByteArray`); pass `int32BE(height)` as the `h` argument for the standard header path.

See [facts/scorex.md](../../facts/scorex.md) for the full interface contract: all method signatures, type invariants, VLQ semantics, error codes, and source mapping to sigma-rust.

## Breaking changes vs 0.1.0 — republish as 0.2.0 at v6 delivery

The following changes are doubly breaking relative to the published `@ergots/scorex@0.1.0`:

- **`Header.timestamp` is now `bigint`** (was `number`). The prior `MAX_SAFE_INTEGER` guard is removed; the field now carries the full u64 range losslessly. Callers that used `header.timestamp` as a JS `number` must update to bigint arithmetic. `SHeader.timestamp` and `SPreHeader.timestamp` in the ergoscript evaluator present the signed i64 view (`BigInt.asIntN(64, timestamp)`), matching JVM `as Long`.
- **`encodeVlqU` / `writeVlqBigInt` reject inputs > u64** (`value > 0xffffffffffffffffn` guard). Previously any bigint was accepted; now inputs beyond the u64 range throw.
- **`decodeVlqU` / `readVlqBigInt` wrap mod 2^64** (`BigInt.asUintN(64, accumulator)` applied per-shift). This matches sigma-rust `get_u64` / JVM `getULong`'s protobuf loop behaviour; previously oversized inputs could produce values beyond u64.

These three changes together complete the scorex VLQ u64 contract. A scorex `0.2.0` publish is planned at v6 delivery (the `ergoscript-v6` branch is the staging area; `@ergots/ergoscript` and `@ergots/nipopow` will be co-published).

## Browser compatibility

Runs unchanged in evergreen browsers and Node >= 20. No `Buffer`, no `node:crypto`, no dynamic Node built-ins, no WASM. ESM-only.

All codec functions are pure and synchronous: bytes in, structured result out. No I/O, no clock, no storage.

## What this package does NOT do

- **`SValue` / `SType` / `Expr` / `ErgoBox` types.** Package-specific to `@ergots/ergoscript`.
- **`NipopowProof` / `AvlTreeData` / `Operation` types.** Package-specific to their respective packages.
- **base58 / base58check.** Single-consumer in `@ergots/ergoscript`; not promoted to shared layer.

## Reference implementation

This package ports the Scorex wire-codec layer and `Header` types from sigma-rust (`sigma-ser/src/vlq_encode.rs`, `ergo-chain-types/src/header.rs`, branch `integration/ergots`). Every `Header` and `AutolykosSolution` test asserts byte-equality against fixtures generated by the sigma-rust reference.

See [facts/scorex.md](../../facts/scorex.md) for the load-bearing interface contract and source-mapping table.

## License

MIT
