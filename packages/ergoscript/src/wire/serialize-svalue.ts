/**
 * SValue wire-format serializer. Byte-for-byte compatible with sigma-rust's
 * `ergotree-ir/src/serialization/data.rs::DataSerializer::sigma_serialize`.
 *
 * Mirror of {@link parseSValue}. See `parse-svalue.ts` for the encoding
 * model and the cross-references to sigma-rust source. This module only
 * ever writes — it never reads back its own output; round-trip correctness
 * is enforced by `test/svalue.test.ts`.
 *
 * Error model: a `SValueSerializeError` is thrown for any mismatch between
 * `t` and `v` (e.g. `t.tag === 'SBoolean'` but `v.kind === 'Int'`) and for
 * argument-bounds violations (GroupElement length ≠ 33, STuple arity
 * mismatch, SColl length > 65535). The asymmetry with reader errors is
 * intentional and matches the rest of the package — serialize-time inputs
 * are programmer-controlled, so a mismatch is a contract violation, not
 * untrusted-data handling.
 */

import type { ErgoBox, SType, SValue } from '../mir/types'
import { ByteWriter } from './writer'
import { serializeSType } from './serialize-stype'

export class SValueSerializeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'SValueSerializeError'
  }
}

/**
 * Write the first 5 canonical box body fields shared by both the full
 * `ErgoBox` wire format and the `ErgoBoxCandidate` (no-ref) variant.
 *
 * Fields written (sigma-rust `serialize_box_with_indexed_digests`,
 * `chain/ergo_box.rs:302-344`):
 *   value           — VLQ u64 (BoxValue, unsigned — NOT ZigZag)
 *   ergo_tree_bytes — raw bytes verbatim (self-delimiting via ErgoTree header)
 *   creation_height — VLQ u32 (sigma-ser `put_u32`)
 *   tokens_count    — raw u8 (NOT VLQ), max 122
 *   per-token       — 32-byte id (raw) + VLQ u64 amount
 *   additional_regs — raw u8 count + per-register: SType bytes + SValue bytes
 *
 * Exported so that `ergo-box-bytes.ts` (`serializeBoxBytes` /
 * `serializeBoxBytesWithoutRef`) can delegate here instead of duplicating
 * the body. The SBox arm below also calls this helper — a single
 * implementation, two consumers.
 */
export function writeBoxBodyWithoutRef(box: ErgoBox, w: ByteWriter): void {
  // value (unsigned VLQ u64 — NOT ZigZag)
  w.writeVlqBigInt(box.value)

  // ergoTreeBytes written verbatim (self-delimiting via ErgoTree header)
  w.writeBytes(box.ergoTreeBytes)

  // creation_height (VLQ u32)
  w.writeVlqU(box.creationHeight)

  // tokens (raw u8 count + per-token id + amount)
  if (box.tokens.length > 122) {
    throw new SValueSerializeError(
      `SBox tokens length ${box.tokens.length} exceeds MAX_TOKENS_COUNT (122)`,
      'sbox-tokens-out-of-range'
    )
  }
  w.writeU8(box.tokens.length) // raw u8, NOT VLQ
  for (const token of box.tokens) {
    if (token.id.length !== 32) {
      throw new SValueSerializeError(
        `SBox token id length ${token.id.length} must be 32`,
        'token-id-length'
      )
    }
    w.writeBytes(token.id)
    w.writeVlqBigInt(token.amount) // VLQ u64 unsigned
  }

  // additional_registers (raw u8 count + per-register Const wire)
  //
  // Sigma-rust enforces that NonMandatoryRegisters are densely packed
  // (R4, R5, …, Rk with no gaps) — see register.rs:223 NonDenselyPacked.
  // A gapped register set would silently mis-assign registers on parse
  // (the parser re-indexes from R4 regardless of what the caller put in).
  const regKeys = Object.keys(box.registers)
    .map((k) => Number(k))
    .filter((k) => k >= 4 && k <= 9 && box.registers[k] !== undefined)
    .sort((a, b) => a - b)
  for (let i = 0; i < regKeys.length; i++) {
    if (regKeys[i] !== 4 + i) {
      throw new SValueSerializeError(
        `SBox registers must be densely packed from R4; found gap before R${4 + i}`,
        'sbox-registers-not-dense'
      )
    }
  }
  w.writeU8(regKeys.length) // raw u8, NOT VLQ
  for (const k of regKeys) {
    const entry = box.registers[k]!
    serializeSType(entry.tpe, w)
    serializeSValue(entry.tpe, entry.value, w)
  }
}

/**
 * Serialize `v` into `w` using `t` to drive the encoding. Throws
 * {@link SValueSerializeError} on any value/type mismatch or bounds
 * violation. Byte output is byte-identical to sigma-rust's
 * `DataSerializer::sigma_serialize` for every well-formed (t, v) pair.
 *
 * Implemented as a single exhaustive switch on `t.tag`. Each arm
 * additionally narrows on `v.kind` and throws if the value variant doesn't
 * match the type — this catches programmer errors at the producer rather
 * than emitting corrupt bytes that would fail downstream parsing or
 * (worse) silently round-trip incorrectly.
 */
export function serializeSValue(t: SType, v: SValue, w: ByteWriter): void {
  switch (t.tag) {
    case 'SBoolean':
      assertKind(t, v, 'Boolean')
      w.writeU8(v.value ? 1 : 0)
      return

    case 'SByte': {
      assertKind(t, v, 'Byte')
      // Truncate to i8 range; the SValue holds a JS number (any int) so a
      // defensive mask catches accidental out-of-range producers.
      w.writeU8(v.value & 0xff)
      return
    }

    case 'SShort': {
      assertKind(t, v, 'Short')
      // sigma-rust: `put_u32(encode_i32(v as i32) as u32)` —
      // sign-extend i16 → i32, ZigZag-encode in i32 space, truncate to u32,
      // then VLQ-encode as a u64 with the upper 32 bits zeroed.
      // JS bitwise ops are 32-bit signed; mask to u32 before writing.
      const i32 = v.value | 0 // already in i16 range; JS cast for explicitness
      const zz = ((i32 << 1) ^ (i32 >> 31)) >>> 0 // u32
      w.writeVlqBigInt(BigInt(zz))
      return
    }

    case 'SInt': {
      assertKind(t, v, 'Int')
      // sigma-rust: `put_u64(encode_i32(v))` — ZigZag-encode in i32 space and
      // emit the result as a u64. The `as u64` cast in Rust sign-extends the
      // i32-bit-pattern result above bit 31, so values like i32::MAX/MIN
      // produce 10-byte VLQ encodings. We replicate by zigzagging in i32
      // space and then sign-extending to a 64-bit BigInt before writing.
      const i32 = v.value | 0
      const zz32 = ((i32 << 1) ^ (i32 >> 31)) | 0 // i32 bit pattern (signed)
      // Sign-extend the i32 result to u64: if the top bit of the i32 is set
      // (i.e. zz32 < 0 as i32), prepend 0xFFFFFFFF to the upper 32 bits.
      const u64: bigint =
        zz32 < 0
          ? 0xffffffff00000000n | BigInt(zz32 >>> 0)
          : BigInt(zz32 >>> 0)
      w.writeVlqBigInt(u64)
      return
    }

    case 'SLong':
      assertKind(t, v, 'Long')
      w.writeVlqBigIntSigned(v.value)
      return

    case 'SBigInt': {
      assertKind(t, v, 'BigInt')
      // VLQ length + raw big-endian two's-complement bytes (minimal).
      // sigma-rust caps at 32 bytes (BigInt256); we enforce the same.
      const bytes = encodeBigIntBE(v.value)
      if (bytes.length > 32) {
        throw new SValueSerializeError(
          `SBigInt requires ${bytes.length} bytes; exceeds 32-byte limit`,
          'bigint-too-large'
        )
      }
      w.writeVlqU(bytes.length)
      w.writeBytes(bytes)
      return
    }

    case 'SGroupElement': {
      assertKind(t, v, 'GroupElement')
      // 33 raw bytes. We do NOT validate the SEC1 prefix here — phase 2a
      // accepts the bytes as-is and defers curve-point validation to
      // phase 2g (sigma-protocol evaluation). The 33-byte length check is
      // load-bearing because anything else would silently desynchronize
      // the wire cursor on read-back.
      if (v.value.length !== 33) {
        throw new SValueSerializeError(
          `SGroupElement requires exactly 33 bytes, got ${v.value.length}`,
          'group-element-length'
        )
      }
      w.writeBytes(v.value)
      return
    }

    case 'SUnit':
      assertKind(t, v, 'Unit')
      // 0 bytes — nothing to emit.
      return

    case 'SColl': {
      assertKind(t, v, 'Coll')
      // sigma-rust caps SColl length at u16 via `put_usize_as_u16_unwrapped`
      // (which panics on overflow). We throw a typed error instead.
      if (v.items.length > 0xffff) {
        throw new SValueSerializeError(
          `SColl length ${v.items.length} exceeds u16 bound`,
          'coll-length-out-of-range'
        )
      }
      w.writeVlqU(v.items.length)

      // SColl[SByte] is the NativeColl optimization: raw bytes, NOT
      // individually VLQ-encoded.
      if (t.elem.tag === 'SByte') {
        const raw = new Uint8Array(v.items.length)
        for (let i = 0; i < v.items.length; i++) {
          const item = v.items[i]!
          if (item.kind !== 'Byte') {
            throw new SValueSerializeError(
              `SColl[SByte] expects Byte items, got ${item.kind} at index ${i}`,
              'coll-item-kind-mismatch'
            )
          }
          raw[i] = item.value & 0xff
        }
        w.writeBytes(raw)
        return
      }

      // SColl[SBoolean]: LSB-first bit-packed. ceil(n/8) bytes, trailing
      // bits zero-padded.
      if (t.elem.tag === 'SBoolean') {
        const byteLen = Math.ceil(v.items.length / 8)
        const raw = new Uint8Array(byteLen)
        for (let i = 0; i < v.items.length; i++) {
          const item = v.items[i]!
          if (item.kind !== 'Boolean') {
            throw new SValueSerializeError(
              `SColl[SBoolean] expects Boolean items, got ${item.kind} at index ${i}`,
              'coll-item-kind-mismatch'
            )
          }
          if (item.value) {
            raw[i >> 3]! |= 1 << (i & 7)
          }
        }
        w.writeBytes(raw)
        return
      }

      // General case: each item is serialized by `t.elem`.
      for (const item of v.items) {
        serializeSValue(t.elem, item, w)
      }
      return
    }

    case 'SOption': {
      assertKind(t, v, 'Option')
      if (v.value === null) {
        w.writeU8(0)
        return
      }
      w.writeU8(1)
      serializeSValue(t.elem, v.value, w)
      return
    }

    case 'STuple': {
      assertKind(t, v, 'Tuple')
      // Arity must match the SType, since the wire has no length prefix
      // and the parser will key off `t.items.length`.
      if (v.items.length !== t.items.length) {
        throw new SValueSerializeError(
          `STuple arity mismatch: type has ${t.items.length} items, value has ${v.items.length}`,
          'tuple-arity-mismatch'
        )
      }
      for (let i = 0; i < t.items.length; i++) {
        serializeSValue(t.items[i]!, v.items[i]!, w)
      }
      return
    }

    case 'SSigmaProp': {
      assertKind(t, v, 'SigmaProp')
      // Emit the raw sigma-protocol bytes verbatim. The reader and the
      // writer are dual: `parseSigmaBoolean` captures exactly the bytes
      // that produced a given SigmaBoolean, so writing them back gives a
      // byte-identical round-trip.
      if (v.value.raw.length === 0) {
        throw new SValueSerializeError(
          'SigmaBoolean.raw is empty',
          'sigma-boolean-empty'
        )
      }
      w.writeBytes(v.value.raw)
      return
    }

    case 'SBox': {
      // SBox wire encoding (sigma-rust `chain/ergo_box.rs:201-223`).
      //
      // Write sequence:
      //   value           — VLQ u64 (BoxValue, unsigned)
      //   ergo_tree_bytes — raw bytes written verbatim (`write_all`)
      //   creation_height — VLQ u32
      //   tokens_count    — raw u8 (NOT VLQ)
      //   per-token       — 32-byte id (raw) + VLQ u64 amount
      //   additional_regs — raw u8 count + per-register: SType bytes + SValue bytes
      //   transaction_id  — 32 raw bytes
      //   index           — VLQ u16 (sigma-ser `put_u16` = VLQ, NOT raw BE)
      //
      // The first 5 fields are shared with `serializeBoxBytesWithoutRef`
      // (used by ExtractBytesWithNoRef) via `writeBoxBodyWithoutRef`.
      assertKind(t, v, 'Box')
      const box = v.value

      // Body fields (value + ergoTree + creation_height + tokens + registers)
      writeBoxBodyWithoutRef(box, w)

      // transaction_id (32 raw bytes)
      if (box.txId.length !== 32) {
        throw new SValueSerializeError(
          `SBox txId length ${box.txId.length} must be 32`,
          'txid-length'
        )
      }
      w.writeBytes(box.txId)

      // index (VLQ u16 — sigma-ser `put_u16` = VLQ, NOT raw 2-byte BE)
      if (box.index < 0 || box.index > 0xffff) {
        throw new SValueSerializeError(
          `SBox index ${box.index} out of u16 range`,
          'sbox-index-out-of-range'
        )
      }
      w.writeVlqU(box.index)
      return
    }

    // ---------------------------------------------------------------------
    // Deferred kinds: same set as parseSValue's deferred arms. No inline
    // `Const(_)` of these types appears in phase 2a corpora.
    // ---------------------------------------------------------------------
    case 'SAvlTree':
    case 'SHeader':
    case 'SPreHeader':
    case 'SContext':
    case 'SGlobal':
    case 'SAny':
    case 'SString':
    case 'SFunc':
    case 'STypeVar':
      throw new SValueSerializeError(
        `serializeSValue ${t.tag} is not implemented in phase 2a`,
        'not-implemented-phase-2a'
      )

    default: {
      // Compile-time exhaustiveness: every variant must be matched above.
      const _exhaust: never = t
      throw new SValueSerializeError(
        `Unreachable SType variant: ${JSON.stringify(_exhaust)}`,
        'unreachable'
      )
    }
  }
}

/**
 * Throw if `v.kind` doesn't match the expected variant for `t`. Centralizes
 * the type/value-mismatch error so each switch arm doesn't repeat the
 * narrowing dance.
 *
 * The runtime check is necessary because TS can't narrow `SValue` from
 * `SType.tag` alone — the two unions are correlated by convention, not by
 * the type system. A wrong producer would otherwise emit bytes that match
 * the wrong kind, which is a worse failure mode than throwing.
 */
function assertKind<K extends SValue['kind']>(
  t: SType,
  v: SValue,
  expected: K
): asserts v is Extract<SValue, { kind: K }> {
  if (v.kind !== expected) {
    throw new SValueSerializeError(
      `SType ${t.tag} expects SValue.kind=${expected}, got ${v.kind}`,
      'type-value-mismatch'
    )
  }
}

/**
 * Encode a bigint as minimal big-endian two's-complement bytes. Matches
 * sigma-rust's `BigInt256::to_be_vec` output for the i32 / i64-representable
 * subset; phase 2a doesn't exercise larger values but the algorithm
 * supports the full BigInt256 range.
 *
 * Algorithm:
 *   - `v === 0n` → `[0x00]` (one byte; mirrors bnum's `to_radix_be(256)`).
 *   - `v > 0n` → emit minimal unsigned big-endian bytes; if the first
 *     byte has its high bit set (would be interpreted as negative on
 *     read-back), prepend `0x00`.
 *   - `v < 0n` → find the smallest k such that v fits in k bytes of
 *     two's complement (i.e. `v >= -(2^(8k-1))`). Compute
 *     `unsigned = v + 2^(8k)`, which is guaranteed to have its high bit
 *     set in k bytes. Emit unsigned in k bytes big-endian.
 */
function encodeBigIntBE(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array([0x00])

  if (v > 0n) {
    const bytes: number[] = []
    let n = v
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn))
      n >>= 8n
    }
    if ((bytes[0]! & 0x80) !== 0) {
      bytes.unshift(0x00)
    }
    return new Uint8Array(bytes)
  }

  // v < 0n. Find smallest k where v fits in k bytes of two's-complement.
  // The condition `v >= -(2^(8k-1))` is equivalent to `-v <= 2^(8k-1)`.
  let k = 1n
  let half = 1n << 7n // 2^(8k - 1) for k=1
  while (-v > half) {
    k++
    half <<= 8n
  }
  const modulus = 1n << (8n * k)
  let unsigned = v + modulus
  const kNum = Number(k)
  const bytes = new Uint8Array(kNum)
  for (let i = kNum - 1; i >= 0; i--) {
    bytes[i] = Number(unsigned & 0xffn)
    unsigned >>= 8n
  }
  return bytes
}
