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
 *   - SOption[T]: 1-byte tag (1 = Some, anything else = None) + (if Some)
 *     inner value parsed by T. Mirrors sigma-rust's `get_option` in
 *     `sigma-ser/src/vlq_encode.rs`: only the exact byte `1` triggers the
 *     inner read; every other byte (including `0`, `2`, `0xff`) is treated
 *     as None and the cursor advances by exactly one byte. Available for
 *     serialization only on ErgoTreeVersion::V3+ in sigma-rust; older trees
 *     return `NotSupported`. We accept either at the parser level — the
 *     caller is responsible for tree-version enforcement.
 *   - STuple[T1, T2, ...]: items in order, NO length prefix on the wire.
 *     The arity is recoverable from the SType.
 *
 * Deferred kinds (SHeader, SPreHeader, SContext, SGlobal, SAny, SString,
 * SFunc, STypeVar) throw `SValueParseError` with code `not-implemented-phase-2a`.
 * SBox shipped in phase 2f Stop α; SAvlTree shipped in phase 2h-b.
 * Phase 2a corpora don't contain inline `Const(_)` values of the still-deferred
 * types — they appear only as `Expr.tpe` slots (e.g. for `MethodCall` return
 * types) or as `SColl.elem` slots, and their runtime values are produced by
 * accessors and predefs at evaluation time.
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
import { parseSigmaBoolean } from './sigma-boolean'
import { parseSType } from './parse-stype'

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
      // sigma-rust serializes SShort via `put_i16` →
      // `put_u32(encode_i32(v as i32) as u32)` (sigma-ser/src/vlq_encode.rs:52).
      // The `as u32` truncation discards sign-extension above i32, so wire
      // bytes never exceed the u32 range. We mirror sigma-rust's decode path:
      // read the raw VLQ u64, truncate to u32, ZigZag-decode in i32 space,
      // then narrow to i16 via shift sign-extension.
      const raw = r.readVlqBigInt()
      const u32 = Number(raw & 0xffffffffn)
      const i32 = (u32 >>> 1) ^ -(u32 & 1)
      // i16 narrow: `(x << 16) >> 16` — left-shift to put bit 15 in the JS
      // sign bit, then arithmetic right-shift to sign-extend.
      const i16 = (i32 << 16) >> 16
      return { kind: 'Short', value: i16 }
    }

    case 'SInt': {
      // sigma-rust serializes SInt via `put_i32` → `put_u64(encode_i32(v))`
      // (sigma-ser/src/vlq_encode.rs:74). `encode_i32` returns u64 with the
      // upper 32 bits sign-extended from the i32 ZigZag result (because the
      // intermediate i32 expression is cast to u64). Decoding via the i64
      // ZigZag path would lose precision near i32::MAX/MIN — sigma-rust's
      // `decode_u32` truncates to u32 *first*, then ZigZag-decodes in i32
      // space (sigma-ser/src/zig_zag_encode.rs:20).
      const raw = r.readVlqBigInt()
      const u32 = Number(raw & 0xffffffffn)
      // ZigZag i32 decode: `(u32 >>> 1) ^ -(u32 & 1)`. `>>>` and `|0`/binary
      // ops in JS operate on 32-bit integers, so the result is naturally i32.
      const decoded = (u32 >>> 1) ^ -(u32 & 1)
      return { kind: 'Int', value: decoded | 0 }
    }

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
      // Audit ERG-03: sigma-rust's `BigInt256::from_be_slice` returns None
      // for empty input (bigint256.rs:38), matching the Scala behavior of
      // throwing on empty bytes. Pre-fix we accepted zero-length and
      // decoded as `0n`, then the serializer rewrote as length 1 — breaking
      // byte-identical round-trip.
      if (len === 0) {
        throw new SValueParseError(
          'SBigInt requires at least 1 byte of content',
          'bigint-empty',
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
      // 1-byte tag: exactly `1` means Some (parse inner via `t.elem`); any
      // other byte means None (cursor stops at the tag, no further read).
      // Mirrors sigma-rust's `get_option` in `sigma-ser/src/vlq_encode.rs`:
      // `match is_opt { 1 => Some(get_value(self)?), _ => None }`. Critical
      // for adversarial inputs: a byte like `0x02` reads as None with the
      // cursor at +1, NOT as Some-with-recurse into inner parsing.
      const tag = r.readU8()
      if (tag === 1) {
        const inner = parseSValue(t.elem, r)
        return { kind: 'Option', elem: t.elem, value: inner }
      }
      return { kind: 'Option', elem: t.elem, value: null }
    }

    case 'STuple': {
      // No length prefix; arity comes from the SType.
      const items: SValue[] = new Array(t.items.length)
      for (let i = 0; i < t.items.length; i++) {
        items[i] = parseSValue(t.items[i]!, r)
      }
      return { kind: 'Tuple', items }
    }

    case 'SSigmaProp':
      // Inline `Const(SSigmaProp, _)` is the canonical wire form for P2PK
      // ErgoTrees (the address `9f…` form deserializes to a tree whose
      // body is `Const(SSigmaProp, ProveDlog(EcPoint))`). The value
      // parser delegates to `parseSigmaBoolean`, which returns the
      // structural 6-variant SigmaBoolean discriminated union
      // (TrivialProp / ProveDlog / ProveDhTuple / Cand / Cor / Cthreshold)
      // — see phase 2g-medium.
      return { kind: 'SigmaProp', value: parseSigmaBoolean(r) }

    case 'SBox': {
      // SBox wire encoding (sigma-rust `chain/ergo_box.rs:201-223`).
      //
      // Read sequence (sigma-rust reads into ErgoBoxCandidate then appends
      // tx_id + index for full ErgoBox):
      //
      //   value           — VLQ u64 (BoxValue wraps u64; plain VLQ, NOT ZigZag)
      //   ergo_tree_bytes — self-delimiting: read header byte, if hasSize (bit 3)
      //                     read VLQ body size then that many body bytes; raw
      //                     bytes stored (no further parse — caller may call
      //                     parseTree(ergoTreeBytes) separately). !hasSize trees
      //                     require full body parse to bound the read; we error
      //                     for those since all real boxes use v1+ (hasSize=true).
      //   creation_height — VLQ u32 (`put_u32`)
      //   tokens_count    — raw u8 (`put_u8`, NOT VLQ), capped at 122
      //   per-token       — 32-byte TokenId (raw) + VLQ u64 amount (`put_u64`)
      //   additional_regs — raw u8 count (`put_u8`) + per-register:
      //                     SType byte + SValue bytes (same as inline Const wire)
      //   transaction_id  — 32 raw bytes
      //   index           — VLQ u16 (`put_u16` in sigma-ser = VLQ, NOT raw BE)

      // --- value (VLQ u64, unsigned) ---
      const value = r.readVlqBigInt()

      // --- ergoTreeBytes (self-delimiting via ErgoTree header) ---
      const treeStart = r.position
      const headerByte = r.readU8()
      const hasSize = (headerByte & 0x08) !== 0
      if (!hasSize) {
        // v0 trees with no hasSize flag cannot be safely extracted from a
        // surrounding byte stream without fully parsing the body. All real
        // on-chain boxes use v1+ (hasSize=true). Reject to avoid cursor
        // desynchronisation.
        throw new SValueParseError(
          `SBox ergoTree header 0x${headerByte.toString(16).padStart(2, '0')} has hasSize=false; ` +
            'cannot bound ergoTree read without full body parse',
          'sbox-ergo-tree-no-size'
        )
      }
      const bodySize = r.readVlqU()
      r.readBytes(bodySize) // consume body bytes (cursor advances)
      const ergoTreeBytes = r.slice(treeStart, r.position).slice()

      // --- creation_height (VLQ u32) ---
      const creationHeight = r.readVlqU()

      // --- tokens (raw u8 count + per-token 32-byte id + VLQ u64 amount) ---
      const tokenCount = r.readU8() // raw u8, NOT VLQ
      if (tokenCount > 122) {
        throw new SValueParseError(
          `SBox tokens count ${tokenCount} exceeds MAX_TOKENS_COUNT (122)`,
          'sbox-tokens-out-of-range'
        )
      }
      const tokens: { id: Uint8Array; amount: bigint }[] = []
      for (let i = 0; i < tokenCount; i++) {
        const id = r.readBytes(32).slice()
        const amount = r.readVlqBigInt() // VLQ u64 unsigned
        tokens.push({ id, amount })
      }

      // --- additional_registers (raw u8 count + per-register Const wire) ---
      const regCount = r.readU8() // raw u8, NOT VLQ
      if (regCount > 6) {
        throw new SValueParseError(
          `SBox additional_registers count ${regCount} exceeds 6 (R4..R9 only)`,
          'sbox-registers-out-of-range'
        )
      }
      const registers: Record<number, { tpe: SType; value: SValue } | undefined> = {}
      for (let i = 0; i < regCount; i++) {
        // Each register is serialized as a full Constant on the wire:
        //   [SType byte(s)] [SValue bytes]
        // This is exactly what parseSType + parseSValue reads.
        const tpe = parseSType(r)
        const regValue = parseSValue(tpe, r)
        registers[4 + i] = { tpe, value: regValue }
      }

      // --- transaction_id (32 raw bytes) ---
      const txId = r.readBytes(32).slice()

      // --- index (VLQ u16 via sigma-ser `put_u16` = VLQ, NOT raw 2-byte BE) ---
      const index = r.readVlqU()

      return {
        kind: 'Box',
        value: {
          value,
          ergoTreeBytes,
          registers,
          tokens,
          creationHeight,
          txId,
          index,
        },
      }
    }

    case 'SAvlTree': {
      // SAvlTree wire encoding (sigma-rust `mir/avl_tree_data.rs:79-90`).
      //
      // Read sequence:
      //   digest          — ADDigest scorex_parse: 33 RAW bytes (Digest<N>
      //                     is `read_exact(&mut [0u8; N])` —
      //                     ergo-chain-types/src/digest32.rs:154-158).
      //                     The 33rd byte is the tree-height byte; the
      //                     first 32 bytes are the root hash. Stored
      //                     verbatim (no parse/validation here — the
      //                     evaluator decides what to do with the contents).
      //   treeFlags       — raw u8 (`r.get_u8()?`). Bits 3-7 are reserved
      //                     and round-trip identically; we do NOT mask
      //                     them off because that would silently drop
      //                     bytes the wire fixed.
      //   keyLength       — VLQ u32 (`r.get_u32()?` → readVlqU). Stored
      //                     as JS number; valid range is `[0, 2^32 - 1]`.
      //   valueLengthOpt  — Option<Box<u32>> SigmaSerializable
      //                     (`serialization/serializable.rs:223-230`).
      //                     Read 1-byte tag: any non-zero tag means Some,
      //                     `0` means None. Parser is permissive (`tag != 0`)
      //                     where serializer writes only `0` or `1`; the
      //                     serializer round-trip will canonicalize to
      //                     `0x01` for Some.
      const digest = r.readBytes(33).slice()
      const treeFlags = r.readU8()
      const keyLength = r.readVlqU()
      const optTag = r.readU8()
      const valueLengthOpt = optTag !== 0 ? r.readVlqU() : null
      return {
        kind: 'AvlTree',
        value: { digest, treeFlags, keyLength, valueLengthOpt },
      }
    }

    // ---------------------------------------------------------------------
    // Deferred kinds. These appear in `Expr.tpe` slots but not as inline
    // `Const(_)` values in phase 2a corpora. If a phase 2a fixture trips
    // one of these, the fixture itself must be deferred to the appropriate
    // later phase.
    // ---------------------------------------------------------------------
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
