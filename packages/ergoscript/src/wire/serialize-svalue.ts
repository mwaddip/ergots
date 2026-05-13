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

import type { SType, SValue } from '../mir/types'
import { ByteWriter } from './writer'

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

    case 'SShort':
      assertKind(t, v, 'Short')
      w.writeVlqS(v.value)
      return

    case 'SInt':
      assertKind(t, v, 'Int')
      w.writeVlqS(v.value)
      return

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

    // ---------------------------------------------------------------------
    // Deferred kinds: same set as parseSValue's deferred arms. No inline
    // `Const(_)` of these types appears in phase 2a corpora.
    // ---------------------------------------------------------------------
    case 'SBox':
    case 'SAvlTree':
    case 'SSigmaProp':
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
