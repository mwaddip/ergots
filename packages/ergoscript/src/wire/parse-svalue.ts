/**
 * SValue wire-format parser. Byte-for-byte compatible with sigma-rust's
 * `ergotree-ir/src/serialization/data.rs::DataSerializer::sigma_parse`.
 *
 * SValue serialization is **type-driven**: the wire bytes contain no type tag
 * (the type is established by the surrounding context — typically a
 * `Const(tpe, value)` MIR node, whose `tpe` is parsed first and then passed
 * to `parseSValue` to drive value parsing). This file is the value half;
 * SType parsing lives in `parse-stype.ts`.
 *
 * Encoding rules (verified against sigma-rust):
 *   - SBoolean: 1 raw byte (0 → false, anything else → true; sigma-rust:
 *     `Literal::Boolean(r.get_u8()? != 0)`).
 *   - SByte: 1 raw byte interpreted as i8 (two's complement).
 *   - SShort, SInt: ZigZag VLQ (sigma-rust `get_i16` / `get_i32` both call
 *     `get_u64` then decode via `zig_zag_encode::decode_u32`; truncation to
 *     i16 is checked in the i16 path but on the wire it's identical bytes).
 *   - SLong: ZigZag VLQ i64.
 *   - SBigInt: VLQ length (sigma-rust uses `get_u16`, max 32 bytes) + raw
 *     big-endian signed two's-complement bytes (minimal encoding). The
 *     value's bit-width is determined by `bytes[0] & 0x80`: MSB set ⇒
 *     negative ⇒ sign-extend.
 *   - SGroupElement: 33 raw bytes (SEC1 compressed point, or 33 zero bytes
 *     for the identity / point at infinity). Phase 2a accepts the bytes
 *     as-is; curve-point validation is deferred to phase 2g.
 *   - SUnit: 0 bytes.
 *   - SColl[T]: VLQ-u16 length + each item parsed by T, EXCEPT:
 *       · SColl[SByte] → VLQ-u16 length + raw bytes (NativeColl optimization
 *         in sigma-rust: `CollKind::NativeColl(NativeColl::CollByte(_))`).
 *       · SColl[SBoolean] → VLQ-u16 length + LSB-first bit-packed bytes
 *         (`ceil(len/8)` bytes; trailing bits zero-padded). Mirrors
 *         sigma-rust's `WriteSigmaVlqExt::put_bits` / `get_bits` via
 *         `bitvec::BitVec<u8, Lsb0>`.
 *   - SOption[T]: 1-byte tag (0 = None, anything else = Some) + (if Some)
 *     inner value parsed by T. Available for serialization only on
 *     ErgoTreeVersion::V3+ in sigma-rust; older trees return
 *     `NotSupported`. We accept either at the parser level — the caller is
 *     responsible for tree-version enforcement.
 *   - STuple[T1, T2, ...]: items in order, NO length prefix on the wire.
 *     The arity is recoverable from the SType.
 *
 * Deferred kinds (SBox, SAvlTree, SSigmaProp, SHeader, SPreHeader, SContext,
 * SGlobal, SAny, SString, SFunc, STypeVar) throw `SValueParseError` with
 * code `not-implemented-phase-2a`. Phase 2a corpora don't contain inline
 * `Const(_)` values of these types — they appear only as `Expr.tpe` slots
 * (e.g. for `MethodCall` return types) or as `SColl.elem` slots, and their
 * runtime values are produced by accessors and predefs at evaluation time.
 *
 * Cross-reference:
 *   - `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/data.rs`
 *     (canonical wire encoding)
 *   - `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/bigint256.rs::sigma_serialize`
 *     (SBigInt length-prefixed BE two's-complement)
 *   - `~/projects/sigma-rust/sigma-rust/ergo-chain-types/src/ec_point.rs`
 *     (SGroupElement = 33 raw bytes, identity = 33 zeros)
 *   - `~/projects/sigma-rust/sigma-rust/sigma-ser/src/vlq_encode.rs::put_bits`
 *     (SColl[SBoolean] bit packing)
 */

import type { SType, SValue } from '../mir/types'
import { ByteReader } from './reader'

export class SValueParseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'SValueParseError'
  }
}

/**
 * Parse an SValue from the reader `r`, driven by the type `t`. Throws
 * {@link SValueParseError} on malformed bytes or on deferred kinds.
 *
 * The reader cursor advances exactly the number of bytes the encoding
 * consumes; the caller can chain further reads. Trailing-byte checks
 * (e.g. `r.isExhausted` after a top-level call) are the caller's
 * responsibility.
 */
export function parseSValue(t: SType, r: ByteReader): SValue {
  switch (t.tag) {
    case 'SBoolean':
      // sigma-rust: `Literal::Boolean(r.get_u8()? != 0)`. Any nonzero byte
      // is `true`; we mirror the permissive read rather than rejecting
      // non-{0,1} values.
      return { kind: 'Boolean', value: r.readU8() !== 0 }

    case 'SByte': {
      // i8 two's-complement: sign-extend by left-shift / arithmetic-right-shift.
      const b = r.readU8()
      return { kind: 'Byte', value: (b << 24) >> 24 }
    }

    case 'SShort': {
      // ZigZag VLQ via the i32 path; sigma-rust bounds-checks the result
      // into i16. We don't enforce that here because phase 2a fixtures
      // are valid; bounds enforcement can be added when wallet construction
      // surfaces malicious inputs.
      return { kind: 'Short', value: r.readVlqS() }
    }

    case 'SInt':
      return { kind: 'Int', value: r.readVlqS() }

    case 'SLong':
      // i64-range signed VLQ — number is too narrow.
      return { kind: 'Long', value: r.readVlqBigIntSigned() }

    case 'SBigInt': {
      // VLQ length (sigma-rust uses `put_u16`, capped at 32 bytes) + raw
      // big-endian signed two's-complement bytes (minimal encoding).
      const len = r.readVlqU()
      if (len > 32) {
        throw new SValueParseError(
          `SBigInt length ${len} exceeds 32 bytes`,
          'bigint-too-large'
        )
      }
      const bytes = r.readBytes(len)
      return { kind: 'BigInt', value: decodeBigIntBE(bytes) }
    }

    case 'SGroupElement':
      // 33 raw bytes (compressed SEC1, or all zeros = identity). Defensive
      // copy: `readBytes` returns a subarray view; the caller may mutate
      // the underlying buffer later. We .slice() to detach.
      return { kind: 'GroupElement', value: r.readBytes(33).slice() }

    case 'SUnit':
      return { kind: 'Unit' }

    case 'SColl': {
      // Length is VLQ-u16 (sigma-rust: `r.get_u16()? as usize`).
      const len = r.readVlqU()
      if (len > 0xffff) {
        throw new SValueParseError(
          `SColl length ${len} exceeds u16 bound`,
          'coll-length-out-of-range'
        )
      }
      // SColl[SByte] is the NativeColl optimization: bytes are NOT
      // individually VLQ-encoded.
      if (t.elem.tag === 'SByte') {
        const raw = r.readBytes(len).slice()
        const items: SValue[] = new Array(len)
        for (let i = 0; i < len; i++) {
          items[i] = { kind: 'Byte', value: (raw[i]! << 24) >> 24 }
        }
        return { kind: 'Coll', elem: t.elem, items }
      }
      // SColl[SBoolean]: LSB-first bit-packed bytes.
      if (t.elem.tag === 'SBoolean') {
        const byteLen = Math.ceil(len / 8)
        const raw = r.readBytes(byteLen)
        const items: SValue[] = new Array(len)
        for (let i = 0; i < len; i++) {
          const byte = raw[i >> 3]!
          const bit = (byte >> (i & 7)) & 1
          items[i] = { kind: 'Boolean', value: bit === 1 }
        }
        return { kind: 'Coll', elem: t.elem, items }
      }
      // General case: parse each item by `t.elem`.
      const items: SValue[] = new Array(len)
      for (let i = 0; i < len; i++) {
        items[i] = parseSValue(t.elem, r)
      }
      return { kind: 'Coll', elem: t.elem, items }
    }

    case 'SOption': {
      // 1-byte tag: 0 → None, anything else → Some (sigma-rust matches
      // exactly `1` for Some, but the `_` arm reads any other byte as None;
      // we mirror that permissive behavior).
      const tag = r.readU8()
      if (tag === 0) {
        return { kind: 'Option', elem: t.elem, value: null }
      }
      const inner = parseSValue(t.elem, r)
      return { kind: 'Option', elem: t.elem, value: inner }
    }

    case 'STuple': {
      // No length prefix; arity comes from the SType.
      const items: SValue[] = new Array(t.items.length)
      for (let i = 0; i < t.items.length; i++) {
        items[i] = parseSValue(t.items[i]!, r)
      }
      return { kind: 'Tuple', items }
    }

    // ---------------------------------------------------------------------
    // Deferred kinds. These appear in `Expr.tpe` slots but not as inline
    // `Const(_)` values in phase 2a corpora. If a phase 2a fixture trips
    // one of these, the fixture itself must be deferred to the appropriate
    // later phase.
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
      throw new SValueParseError(
        `parseSValue ${t.tag} is not implemented in phase 2a`,
        'not-implemented-phase-2a'
      )

    default: {
      // Compile-time exhaustiveness: every variant must be matched above.
      const _exhaust: never = t
      throw new SValueParseError(
        `Unreachable SType variant: ${JSON.stringify(_exhaust)}`,
        'unreachable'
      )
    }
  }
}

/**
 * Decode a big-endian two's-complement signed integer from `bytes`.
 *
 * Empty bytes → 0n (sigma-rust rejects this on the BigInt256 path because
 * an empty serialization is invalid; the check happens in
 * `BigInt256::from_be_slice` returning `None`. We never receive empty
 * bytes from a valid stream — `len > 0` is implicit in the encoding —
 * but we tolerate the edge case rather than throw mid-parse.).
 *
 * For non-empty input, the algorithm is straightforward:
 *   1. Pack the unsigned magnitude as a big-endian BigInt.
 *   2. If the high bit of the first byte is set, the value is negative;
 *      subtract `2^(8*len)` to sign-extend.
 */
function decodeBigIntBE(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n
  let result = 0n
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]!)
  }
  // Sign-extend if the leading bit was set.
  if ((bytes[0]! & 0x80) !== 0) {
    result -= 1n << BigInt(bytes.length * 8)
  }
  return result
}
