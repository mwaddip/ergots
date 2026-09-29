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
 *   - SGroupElement: 33 bytes, validated + normalized to canonical SEC1
 *     (F5 batch 4): 0x00-lead → canonical 33-zero identity (tail discarded);
 *     non-0x00-lead must curve-decode or throws
 *     `'group-element-invalid-point'`. See the GE canonical-bytes invariant
 *     in facts/ergoscript-eval.md.
 *   - SUnit: 0 bytes.
 *   - SColl[T]: VLQ-u16 length + each item parsed by T, EXCEPT:
 *       · SColl[SByte] → VLQ-u16 length + raw bytes (NativeColl optimization
 *         in sigma-rust: `CollKind::NativeColl(NativeColl::CollByte(_))`).
 *       · SColl[SBoolean] → VLQ-u16 length + LSB-first bit-packed bytes
 *         (`ceil(len/8)` bytes; trailing bits zero-padded). Mirrors
 *         sigma-rust's `WriteSigmaVlqExt::put_bits` / `get_bits` via
 *         `bitvec::BitVec<u8, Lsb0>`.
 *   - SOption[T]: 1-byte tag (0 = None, any nonzero = Some) + (if Some)
 *     inner value parsed by T. scorex-util VLQReader.getOption: ANY nonzero
 *     tag → Some (bytecode-verified F4-epilogue + SANTA-blessed F5 batch 1).
 *     sigma-rust `get_option` diverges (only exact 1 = Some; tag ≥ 2 → None,
 *     causing stream desync) — JVM canonical. Serializer emits canonical
 *     0x01/0x00; nonzero-noncanonical tags do not byte-round-trip (same on JVM).
 *     V3-gated: tree-version < 3 throws `SValueParseError('soption-tree-version-too-low')`.
 *     Version-gated DATA kinds (SOption, SHeader) enforce their gates from the
 *     threaded `treeVersion`; remaining kinds are version-free.
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
 *   - `~/projects/sigmastate-interpreter/core/.../GroupElementSerializer.scala`
 *     (SGroupElement canonical parse: 0x00-lead ⇒ identity, else decodePoint)
 *   - `~/projects/sigma-rust/sigma-rust/sigma-ser/src/vlq_encode.rs::put_bits`
 *     (SColl[SBoolean] bit packing)
 */

import type { SType, SValue } from '../mir/types'
import { ByteReader, parseHeader, readVlqU32 } from '@ergots/scorex'
import { parseSigmaBoolean } from './sigma-boolean'
import { parseSTypeWithFirstByte } from './parse-stype'
import { parseErgoTreeBytes } from './ergo-tree'
import { exprParserFor, OPCODES_THE_JVM_PARSES } from './parse'
// A value's first byte: at most LAST_CONSTANT_CODE (112) is a Constant's type code, above it an
// opcode (ValueSerializer.scala:400-408).
import { LAST_CONSTANT_CODE, OP_TUPLE } from '../mir/opcodes'
import { canonicalGePayload } from './_ge-canonical'
import { decodeUtf8Lossy } from './_utf8'

// JVM `ErgoBox.MaxBoxSize` = `SigmaConstants.MaxBoxSize` = 4 * 1024
// (SigmaConstants.scala:24, surfaced at ErgoBox.scala:127). The SBox data
// parse reads the candidate span (value → registers) under a lazy
// `positionLimit` window of this many bytes, armed at candidate start
// (ErgoBoxCandidate.scala:191-192) and restored after the registers loop
// (:235); txId/index sit OUTSIDE the window (ErgoBox.scala:214-225).
// Crossing the window is JVM validation rule 1014 `CheckPositionLimit`
// (ValidationRules.scala:169-189), surfaced here as scorex
// `ReaderError('position-limit-exceeded')`.
const ERGO_BOX_MAX_SIZE = 4096

/**
 * Parse a register-level Expr, read as the JVM's `r.getValue()` reads a register
 * value (`ErgoBoxCandidate.scala:231`) and each Tuple item (`TupleSerializer.scala:33`);
 * sigma-rust calls `Expr::sigma_parse` here and then restricts the result to
 * `Const` or `Tuple` in `register.rs:140-162`.
 * Returns the equivalent Constant view (`tpe` + `value`) for runtime use, and
 * `tag`, the value's first byte (a Constant's type code, or `OP_TUPLE`);
 * the caller is responsible for capturing the original wire bytes via
 * `r.position` snapshots if byte-roundtrip is required.
 *
 * Mirrors sigma-rust's restriction: only `Expr::Const` and `Expr::Tuple` are
 * legal as register values. A `Tuple` whose items aren't all Const-or-Tuple
 * (per `tuple_to_constant`) is rejected. Everything else is rejected at the
 * tag-dispatch step.
 *
 * Recursive: nested Tuples are accepted (a register can be `((1,2),3)`).
 *
 * Rule 1019 is not checked here, nor on a Tuple's items: `parseAdditionalRegisters`
 * runs it once on the complete value, after this frame has returned
 * (`ErgoBoxCandidate.scala:231-232`).
 */
function parseRegisterExpr(
  r: ByteReader,
  treeVersion: number
): { tpe: SType; value: SValue; tag: number } {
  // A register value is an Expr read via the JVM's `r.getValue()`
  // (`ValueSerializer.deserialize`, `SigmaByteReader.scala:46`), which bumps the
  // shared reader level once per Expr node BEFORE the inner data parse/recursion.
  // So a register Const costs THIS ValueSerializer level + the `parseSValue`
  // (CoreDataSerializer) level, and a register Tuple costs this level + one per
  // item — matching the JVM. Without this enterDepth, SBox register sub-values
  // undercount depth by one level vs the JVM (a `deserializeTo[Box]` whose
  // register is nested to `Coll^109` would be accepted here but rejected by the
  // JVM at depth 111 — a consensus fork). The leaf `parseSValue` adds the data
  // level; nested-Tuple recursion re-enters here, one level per item.
  //
  // The level is lowered only on a normal return, as the JVM's `r.level = r.level - 1` is (no
  // finally, ValueSerializer.scala:396-412): a throw that a soft-fork degrade catches leaves this
  // frame's level on the reader (facts/ergoscript-wire.md, "Reader depth after a degrade").
  //
  // r.getValue(): ValueSerializer.scala:396-411 — the depth check, then the first-byte peek with
  // no window check (CoreByteReader.scala:41; at the end of the input a hard error), then the
  // window-checked read.
  r.enterDepth()
  r.peekU8()
  const tag = r.readU8()
  let entry: { tpe: SType; value: SValue }
  if (tag <= LAST_CONSTANT_CODE) {
    // Constant Expr: tag is the SType lead byte.
    const tpe = parseSTypeWithFirstByte(tag, r)
    entry = { tpe, value: parseSValue(tpe, treeVersion, r) }
  } else if (tag === OP_TUPLE) {
    // Tuple Expr: 1-byte items count, then N nested Exprs.
    const itemsCount = r.readU8()
    if (itemsCount < 2) {
      throw new SValueParseError(
        `SBox register Tuple Expr items count ${itemsCount} below minimum 2`,
        'sbox-register-tuple-arity'
      )
    }
    // TupleSerializer (TupleSerializer.scala:28-31) reads the arity with a signed getByte; 0x80 and
    // above are negative and fail safeNewArray before any item is read.
    if (itemsCount > 127) {
      throw new SValueParseError(`SBox register Tuple arity ${itemsCount} is negative as a signed byte`, 'sbox-register-tuple-arity')
    }
    const itemTpes: SType[] = []
    const itemValues: SValue[] = []
    for (let i = 0; i < itemsCount; i++) {
      const item = parseRegisterExpr(r, treeVersion)
      itemTpes.push(item.tpe)
      itemValues.push(item.value)
    }
    entry = {
      tpe: { tag: 'STuple', items: itemTpes },
      value: { kind: 'Tuple', items: itemValues },
    }
  } else {
    // Any other lead is an opcode. `r.getValue()` looks up its serializer and runs rule 1002
    // `CheckValidOpCode` on it (ValueSerializer.scala:171-175, 404-408): an opcode with no
    // serializer throws parseExpr's soft code, 'opcode-reserved' or 'unknown-opcode', which degrades
    // an enclosing sized tree. For a known opcode the JVM parses the node, which the register then
    // casts to an evaluated value (ErgoBoxCandidate.scala:231): a hard reject for a node like HEIGHT
    // (a ClassCastException). ergots rejects it on the lead byte, without reading its payload, and
    // accepts no evaluated value but a constant or a tuple (residual 4). The six opcodes the JVM
    // parses but parseExpr rejects stay hard as known opcodes (residual 5).
    if (!OPCODES_THE_JVM_PARSES.has(tag)) exprParserFor(tag)
    throw new SValueParseError(
      `SBox register: unsupported Expr tag 0x${tag.toString(16).padStart(2, '0')} ` +
        `(a register value is a Constant or a Tuple Expr here; residual 4)`,
      'sbox-register-unsupported-expr'
    )
  }
  r.exitDepth()
  return { ...entry, tag }
}

/** Decoded box additional-registers map: R4.. keyed by register id (4..9). */
export type AdditionalRegisters = Record<
  number,
  { tpe: SType; value: SValue; opaqueBytes?: Uint8Array } | undefined
>

/**
 * Parse a box's additional-registers section from the reader's current
 * position, in the JVM candidate parser's order (ErgoBoxCandidate.scala:226-234):
 * a raw `u8` count (NOT VLQ; the JVM's `r.getUByte()`, :226), then, for each
 * register in turn, keyed R4.. (`4 + i`):
 *   1. its id is resolved (`nonMandatoryRegisters(iReg)`, :230), so a seventh
 *      register rejects with `'sbox-registers-out-of-range'` only when the loop
 *      reaches it, after R4–R9 have been read;
 *   2. its value is read whole (`r.getValue()`, :231), by `parseRegisterExpr`,
 *      which also keeps the per-Expr depth accounting;
 *   3. rule-1019 `CheckV6Type` runs on the complete value (:232;
 *      `'register-v6-type'`). So a hard error in the value's data comes first.
 *
 * Each register is a full Expr on the wire (sigma-rust `register.rs:140` calls
 * `Expr::sigma_parse(r)`) restricted to `Const` or `Tuple`. Most mainnet
 * registers are Constants (lead byte = SType byte ≤ 112). The rare Tuple-Expr
 * form (lead byte 0x86, ~one box at h=855,650 R8) is recognized + preserved
 * via `opaqueBytes` so the wire form round-trips byte-identically even though
 * the type system stores the value as a regular STuple Constant.
 *
 * Shared by the SBox data parser (`case 'SBox'`) and `@ergots/transaction`'s
 * ErgoBoxCandidate codec — the register grammar lives in one place. The caller
 * owns any surrounding read-window (positionLimit) save/restore; this helper
 * only consumes the count + register bytes.
 */
export function parseAdditionalRegisters(r: ByteReader, treeVersion: number): AdditionalRegisters {
  const regCount = r.readU8() // getUByte (ErgoBoxCandidate.scala:226)
  const registers: AdditionalRegisters = {}
  for (let i = 0; i < regCount; i++) {
    // nonMandatoryRegisters(iReg) (:230) resolves the id before the value is read:
    // the 7th register is an index error only when the loop reaches it.
    if (i >= 6) {
      throw new SValueParseError(`register index ${i} is beyond R9 (R4..R9 only)`, 'sbox-registers-out-of-range')
    }
    const startPos = r.position
    const parsed = parseRegisterExpr(r, treeVersion)   // r.getValue(): enterDepth → peekU8 → readU8 (ValueSerializer.scala:396-411)
    // CheckV6Type(v) (:232) runs on the complete value, after its frame returned.
    if (violatesCheckV6Type(parsed.tpe)) {
      throw new SValueParseError(
        'box register type contains a v6-only type (Option/Header/UnsignedBigInt) — rule-1019 CheckV6Type',
        'register-v6-type')
    }
    if (parsed.tag > LAST_CONSTANT_CODE) {
      registers[4 + i] = { tpe: parsed.tpe, value: parsed.value, opaqueBytes: r.slice(startPos, r.position).slice() }
    } else {
      registers[4 + i] = { tpe: parsed.tpe, value: parsed.value }
    }
  }
  return registers
}

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
 * Rule-1019 `CheckV6Type` predicate: true iff `tpe`, recursing through `STuple`
 * items and `SColl`/`SCollection` elemType, contains a leaf that is an
 * `SOption` (any element type), `SHeader`, or `SUnsignedBigInt`.
 *
 * Mirrors JVM `ValidationRules.scala:165-205` (`CheckV6Type`):
 *   - `v6TypeCheck(tpe)` rejects iff `tpe.isOption` OR `tpe.typeCode == SHeader`
 *     (104) OR `tpe.typeCode == SUnsignedBigInt` (9).
 *   - `step(STuple)` → `items.foreach(step)`; `step(SCollection)` →
 *     `step(elemType)` — and STuple is matched BEFORE SCollection in the JVM
 *     (STuple <: SCollection). Our `SType` union tags STuple / SColl / SOption
 *     disjointly, so the explicit STuple-before-SColl ordering is moot here,
 *     but the per-arm shape is kept identical to the JVM `step`.
 *
 * DISTINCT from `eval/validate-v6-types.ts::containsV6Type` — that predicate
 * gates the tree BODY for the v6 version-gate type set `{ SUnsignedBigInt,
 * SFunc }`. This one gates box REGISTERS and context-extension values for the
 * set `{ SOption, SHeader, SUnsignedBigInt }`. Different type set, different
 * surface; do NOT merge.
 *
 * The JVM enforces `CheckV6Type` at two ingress points, both served by this one
 * predicate: box registers (`ErgoBoxCandidate.scala:232`, here in
 * `parseAdditionalRegisters`, once each value is read) and context-extension values
 * (`ContextExtension.scala:62`, sigma-state v6.0.6 — `@ergots/transaction`'s
 * `parseContextExtension`, which is why it is exported). The JVM-blessed
 * witness W7 is a register case.
 */
export function violatesCheckV6Type(tpe: SType): boolean {
  switch (tpe.tag) {
    // STuple first, matching the JVM `step` (STuple <: SCollection).
    case 'STuple':
      return tpe.items.some(violatesCheckV6Type)
    case 'SColl':
      return violatesCheckV6Type(tpe.elem)
    // Leaf v6TypeCheck: any Option, SHeader (104), SUnsignedBigInt (9).
    case 'SOption':
    case 'SHeader':
    case 'SUnsignedBigInt':
      return true
    default:
      return false
  }
}

/**
 * Parse an SValue from the reader `r`, driven by the type `t`. Throws
 * {@link SValueParseError} on malformed bytes or on deferred kinds, and
 * `ReaderError('max-tree-depth-exceeded')` (from the shared reader-level
 * depth counter) when data nesting exceeds the reader's `maxTreeDepth`.
 *
 * The reader cursor advances exactly the number of bytes the encoding
 * consumes; the caller can chain further reads. Trailing-byte checks
 * (e.g. `r.isExhausted` after a top-level call) are the caller's
 * responsibility.
 *
 * `treeVersion` is the ErgoTree header version (0–7) of the enclosing tree.
 * It gates SHeader: tree-version < 3 throws `sheader-tree-version-too-low`.
 * Mirrors sigma-rust `ergotree-ir/src/serialization/data.rs:196` where the
 * same version check is `r.tree_version() >= ErgoTreeVersion::V3`.
 */
export function parseSValue(t: SType, treeVersion: number, r: ByteReader): SValue {
  // MaxTreeDepth bound (consensus) — mirrors the JVM `CoreByteReader.level`:
  // `CoreDataSerializer.deserialize` does `r.level = depth + 1` at the top of
  // EVERY data-value call and `r.level = r.level - 1` at the bottom
  // (`CoreDataSerializer.scala:95-96,148`); `CoreByteReader.level_=` throws when
  // the new level > maxTreeDepth (default 110). The counter lives on the reader
  // and is SHARED with the expr-node parser (`parseExpr`) and the SigmaBoolean
  // parser (`parseSigmaBoolean`), exactly as the JVM shares one `r.level` across
  // ValueSerializer / CoreDataSerializer / SigmaBoolean.serializer. So this guard
  // participates in the whole-tree depth budget automatically — there is no
  // separate threaded `depth` to keep in sync.
  //
  // The limit fires DATA-DRIVEN: enterDepth runs once per parseSValue call, and
  // empty/shallow data never recurses, so a deeply-nested TYPE with empty data is
  // accepted (the JVM only descends into elements present). The level is lowered only
  // on a normal return, as the JVM's `r.level = r.level - 1` is (no finally,
  // CoreDataSerializer.scala:148): a throw that a soft-fork degrade catches leaves it
  // raised (facts/ergoscript-wire.md, "Reader depth after a degrade").
  r.enterDepth()
  const value = parseSValueBody(t, treeVersion, r)
  r.exitDepth()
  return value
}

/**
 * Body of {@link parseSValue}, run inside the reader-level depth guard. Kept
 * as a separate function so the single enter/exit pair in `parseSValue` wraps
 * every `switch` arm (including the early-returning ones) without repeating
 * the exit per arm.
 */
function parseSValueBody(t: SType, treeVersion: number, r: ByteReader): SValue {
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
      // JVM CoreDataSerializer.scala:112-117 (sigma-state v6.0.6): `getUShort().toShort`
      // — above 0xFFFF a hard IAE (getUShort's own bound); 33..0x7FFF throw at once
      // (a Short > 32 bytes); 0 and 0x8000..0xFFFF (negative as a Short) reach
      // `getBytes`, which checks the window first (rule 1014) before the
      // empty/negative message. sigma-rust's BigInt256::from_be_slice returning
      // None on empty input (bigint256.rs:38) matches the Scala `new BigInteger`
      // throw on empty bytes — both reachable only once the window passes.
      const len = r.readVlqU()
      if (len > 0xffff) {
        throw new SValueParseError(`SBigInt length ${len} exceeds u16`, 'bigint-too-large')
      }
      const size = (len << 16) >> 16
      if (size > 32) {
        throw new SValueParseError(`SBigInt length ${len} exceeds 32 bytes`, 'bigint-too-large')
      }
      if (size <= 0) {
        r.readBytes(0) // the window check getBytes makes first
        if (size === 0) {
          throw new SValueParseError('SBigInt requires at least 1 byte of content', 'bigint-empty')
        }
        throw new SValueParseError(`SBigInt length ${len} is negative as a Short`, 'bigint-too-large')
      }
      const bytes = r.readBytes(size)
      return { kind: 'BigInt', value: decodeBigIntBE(bytes) }
    }

    case 'SGroupElement': {
      // F5 batch 4: validate + normalize per the GE canonical-bytes invariant
      // (facts/ergoscript-eval.md). JVM GroupElementSerializer.parse:35-42 —
      // 0x00-lead ⇒ identity (tail discarded); else decodePoint curve-validates.
      // Defensive copy: `readBytes` returns a subarray view; .slice() detaches.
      const raw = r.readBytes(33).slice()
      return {
        kind: 'GroupElement',
        value: canonicalGePayload(
          raw,
          (cause) =>
            new SValueParseError(
              `SGroupElement payload is not a valid curve point: ${cause}`,
              'group-element-invalid-point'
            )
        ),
      }
    }

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
        items[i] = parseSValue(t.elem, treeVersion, r)
      }
      return { kind: 'Coll', elem: t.elem, items }
    }

    case 'SOption': {
      // V3-gated DATA: the JVM deserializes Option DATA only at tree-version
      // ≥ 3 (CoreDataSerializer.scala:140-143 — the SOption arm is guarded by
      // isV3OrLaterErgoTreeVersion; pre-v3 falls through to
      // CheckSerializableTypeCode/ValidationRule 1009 + SerializerException).
      // Recursive by construction: Option nested anywhere inside a constant's
      // type tree (Coll[Option[T]], pairs, …) reaches this arm via recursion —
      // the same shape as the JVM's recursive deserialize. Same gate family as
      // the SHeader gate below.
      if (treeVersion < 3) {
        throw new SValueParseError(
          `SOption SValue requires tree-version >= 3; got treeVersion=${treeVersion}`,
          'soption-tree-version-too-low'
        )
      }
      // Option DATA tag (scorex-util VLQReader.getOption — bytecode-verified
      // F4-epilogue + SANTA-blessed SOption.nonzero_data_tag): `0` → None;
      // ANY nonzero → Some, payload follows. NB sigma-rust `get_option`
      // (`1 => Some, _ => None`) is a FORK on tags ≥ 2 — a 0x02-tag Some
      // mis-reads as None and desyncs the byte stream; no longer mirrored
      // (F5 batch 1, 2026-06-08). Serialize emits canonical 0x01/0x00, so a
      // nonzero-noncanonical tag does not byte-round-trip — same on the JVM.
      const tag = r.readU8()
      if (tag !== 0) {
        const inner = parseSValue(t.elem, treeVersion, r)
        return { kind: 'Option', elem: t.elem, value: inner }
      }
      return { kind: 'Option', elem: t.elem, value: null }
    }

    case 'STuple': {
      // No length prefix; arity comes from the SType.
      const items: SValue[] = new Array(t.items.length)
      for (let i = 0; i < t.items.length; i++) {
        items[i] = parseSValue(t.items[i]!, treeVersion, r)
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
      //   ergo_tree_bytes — one ErgoTree, parsed on this reader by
      //                     `parseErgoTreeBytes` under the box rules (see below);
      //                     its span as received is stored verbatim on the SBox.
      //   creation_height — VLQ u32 (`put_u32`)
      //   tokens_count    — raw u8 (`put_u8`, NOT VLQ); no count gate — the
      //                     u8 ceiling 255 is the natural bound (JVM getUByte,
      //                     ErgoBoxCandidate.scala:200); the real bound is the
      //                     4096-byte candidate window below
      //   per-token       — 32-byte TokenId (raw) + VLQ u64 amount (`put_u64`)
      //   additional_regs — raw u8 count (`put_u8`) + per-register:
      //                     SType byte + SValue bytes (same as inline Const wire)
      //   transaction_id  — 32 raw bytes
      //   index           — VLQ u16 (`put_u16` in sigma-ser = VLQ, NOT raw BE)

      // Retained-bytes capture (F5 batch 4 E): the JVM parse snapshots the
      // position before reading any field and hands the consumed slice to
      // the ErgoBox constructor as `_bytes` (ErgoBox.scala:214-225). Box
      // equality/id derive from these bytes, so non-canonical-but-accepted
      // encodings (e.g. garbage-tail identity GE registers, normalized at
      // the SValue layer) still yield JVM-faithful distinct ids.
      const boxStart = r.position

      // 4096-byte candidate window (F5 batch 5): arm at candidate start —
      // mirrors ErgoBoxCandidate.scala:191-192. The window is LAZY (one
      // entry check per logical read, strict `>`, straddles tolerated, an
      // overrun by the candidate's FINAL read escapes — see the positionLimit
      // block in facts/scorex.md). The save/restore is INLINE, NOT
      // try/finally: a window-overrun throw abandons the parse exactly like
      // the JVM (the reader is not reused after a parse error). A nested box
      // (in a register) legitimately arms a window EXCEEDING this one for its
      // inner span — the setter has no clamp (CoreByteReader.scala:133-137).
      const previousPositionLimit = r.positionLimit
      r.positionLimit = r.position + ERGO_BOX_MAX_SIZE

      // --- value (VLQ u64, unsigned) ---
      const value = r.readVlqBigInt()

      // --- ergoTreeBytes ---
      // `parseErgoTreeBytes` (ergo-tree.ts) parses one tree on this reader under the box
      // rules, as the JVM box parser's `deserializeErgoTree` call does
      // (ErgoBoxCandidate.scala:194, whose 2-argument form passes `checkType = true`,
      // ErgoTreeSerializer.scala:137-139): rule 1001 applies here, unlike in the lenient
      // bare `parseTree`. It returns the tree's span as received. The same helper is
      // consumed by `@ergots/transaction`'s ErgoBoxCandidate codec, so the box's tree
      // grammar lives in one place.
      const ergoTreeBytes = parseErgoTreeBytes(r)

      // --- creation_height (VLQ; rejects > Int.MaxValue (2^31-1) to match the
      //     JVM consensus reader `r.getUIntExact` (ErgoBoxCandidate.scala:195) =
      //     `getUInt().toIntExact` (CoreByteReader.scala:73), which throws an
      //     ArithmeticException for any value > 0x7fffffff. The ceiling is i32,
      //     NOT u32 (the prior `> 0xffffffff` mirrored the non-canonical
      //     sigma-rust `get_u32` at chain/ergo_box.rs:351 — looser than the JVM,
      //     a latent fork on a hand-crafted height in (2^31, 2^32)). NO-FORK per
      //     ErgoBoxCandidate.scala:195-199: v4.x used `.toInt` (wrap-to-negative,
      //     then rejected by tx-validation rule #122); v5.x throws at parse —
      //     same accept/reject outcome. ergots is a v5+/v6 validator → parse-
      //     reject here. (The scorex header-height u32 sibling is deferred to its
      //     own branch.) ---
      const creationHeight = r.readVlqU()
      if (creationHeight > 0x7fffffff) {
        throw new SValueParseError(
          `SBox creation_height ${creationHeight} exceeds 2^31-1 (Int.MaxValue; JVM getUIntExact)`,
          'sbox-creation-height-out-of-range'
        )
      }

      // --- tokens (raw u8 count + per-token 32-byte id + VLQ u64 amount) ---
      // NO count gate: the JVM reads `nTokens = r.getUByte()` bare
      // (ErgoBoxCandidate.scala:200) — the u8 read's natural ceiling 255 is
      // the only count bound; the real gate is the 4096-byte candidate window
      // armed above. (The pre-F5-batch-5 >122 gate mirrored sigma-rust's
      // BoundedVec<Token, 1, 122> — their own comment, ergo_box.rs:100-104,
      // marks it a count-shaped approximation of the size rule. SANTA-measured
      // boundary: 123 tokens fits the window; the JVM accepts.)
      const tokenCount = r.readU8() // raw u8, NOT VLQ
      const tokens: { id: Uint8Array; amount: bigint }[] = []
      for (let i = 0; i < tokenCount; i++) {
        const id = r.readBytes(32).slice()
        const amount = r.readVlqBigInt() // VLQ u64 unsigned
        tokens.push({ id, amount })
      }

      // --- additional_registers (raw u8 count + per-register Const/Tuple wire) ---
      // Factored into `parseAdditionalRegisters` (shared with @ergots/transaction's
      // ErgoBoxCandidate codec), in the JVM's order (ErgoBoxCandidate.scala:226-234):
      // raw u8 count, then per register the id (a seventh rejects when reached), the
      // Const/Tuple value (opaqueBytes for the Tuple-Expr form), then the rule-1019
      // CheckV6Type check, all under the threaded treeVersion.
      const registers = parseAdditionalRegisters(r, treeVersion)

      // Restore the enclosing window: the candidate span ends with the
      // registers; txId/index sit OUTSIDE it — mirrors the
      // ErgoBoxCandidate.scala:235 restore running BEFORE ErgoBox's
      // txId/index reads (ErgoBox.scala:214-225).
      r.positionLimit = previousPositionLimit

      // --- transaction_id (32 raw bytes) ---
      const txId = r.readBytes(32).slice()

      // --- index (VLQ u16 via sigma-ser `put_u16` = VLQ, NOT raw 2-byte BE;
      //     rejects > u16 to match sigma-rust `r.get_u16()` at
      //     chain/ergo_box.rs:220, mirroring the serializer's own u16 cap) ---
      const index = r.readVlqU()
      if (index > 0xffff) {
        throw new SValueParseError(
          `SBox index ${index} out of u16 range`,
          'sbox-index-out-of-range'
        )
      }

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
          // Detached copy — scorex `slice` returns a view over the reader's
          // backing buffer.
          retainedBytes: r.slice(boxStart, r.position).slice(),
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
      //   keyLength       — VLQ u32 (`r.get_u32()?` → readVlqU32, which
      //                     rejects values above `2^32 - 1`). Stored as JS
      //                     number; mirrors the serializer's u32 cap.
      //   valueLengthOpt  — Option<Box<u32>> SigmaSerializable
      //                     (`serialization/serializable.rs:223-230`; JVM
      //                     `AvlTreeData.scala:85` reads via `r.getOption(...)`
      //                     — scorex-util getOption: any nonzero tag → Some).
      //                     Read 1-byte tag: any non-zero tag means Some,
      //                     `0` means None. Parser is permissive (`tag != 0`)
      //                     where serializer writes only `0` or `1`; the
      //                     serializer round-trip will canonicalize to `0x01`.
      const digest = r.readBytes(33).slice()
      const treeFlags = r.readU8()
      const keyLength = readVlqU32(r, 'SAvlTree.keyLength')
      const optTag = r.readU8()
      const valueLengthOpt = optTag !== 0 ? readVlqU32(r, 'SAvlTree.valueLengthOpt') : null
      return {
        kind: 'AvlTree',
        value: { digest, treeFlags, keyLength, valueLengthOpt },
      }
    }

    // ---------------------------------------------------------------------
    case 'SHeader': {
      // V3-gated: SHeader SValue literals in segregated-constants sections
      // require ErgoTree version >= 3. Mirrors sigma-rust
      // `ergotree-ir/src/serialization/data.rs:196`:
      //   `SHeader if r.tree_version() >= ErgoTreeVersion::V3 =>
      //     Literal::Header(Box::new(Header::scorex_parse(r)?))`
      // Falls through at V<3 to the NotSupported error.
      if (treeVersion < 3) {
        throw new SValueParseError(
          `SHeader SValue requires tree-version >= 3; got treeVersion=${treeVersion}`,
          'sheader-tree-version-too-low'
        )
      }
      // id basis: scorex parseHeader derives id from the consumed input slice
      // (JVM ErgoHeader.scala:167-180), so no local override is needed; that
      // derivation still runs only after the whole solution is read, same as
      // before this task — only the GE normalization timing moved.
      // F5 batch 4 / Task 4D — GE canonical-bytes invariant on the hydration
      // leg. The `validatePoint` hook below runs INSIDE parseHeader, right
      // after each point is read, mirroring the JVM: it parses minerPk + (v1)
      // powOnetimePk through GroupElementSerializer AS EACH IS READ
      // (AutolykosSolution.sigmaSerializerV1.parse ErgoHeader.scala:73-74,
      // .sigmaSerializerV2.parse :90): 0x00-lead → identity POINT (tail
      // discarded); invalid non-0x00-lead → throw, before the next field's
      // read can trip the enclosing tree's read-window (rule 1014) first.
      // scorex readFixed returns subarray VIEWS into the reader buffer —
      // .slice() detaches the verbatim (valid-point) path; the normalize
      // path is already fresh.
      const header = parseHeader(r, {
        validatePoint: (bytes, field) => canonicalGePayload(bytes.slice(), (cause) =>
          new SValueParseError(`SHeader ${field} is not a valid curve point: ${cause}`, 'group-element-invalid-point')),
      })
      return { kind: 'Header', value: header }
    }

    // ---------------------------------------------------------------------
    // Deferred kinds. These appear in `Expr.tpe` slots but not as inline
    // `Const(_)` values in phase 2a corpora. If a phase 2a fixture trips
    // one of these, the fixture itself must be deferred to the appropriate
    // later phase.
    // ---------------------------------------------------------------------
    case 'SString': {
      // JVM CoreDataSerializer.scala:104-110 (sigma-state v6.0.6): `getUIntExact` length, then
      // `new String(bytes, UTF_8)`. Decoded with the JVM-faithful `decodeUtf8Lossy`, NOT
      // `TextDecoder`: that strips a leading byte-order mark (Java keeps U+FEFF) and splits an
      // ill-formed surrogate `ed a0 80` into three U+FFFD (Java gives one), so two strings the
      // JVM tells apart would compare equal (facts/ergoscript-wire.md "SString data").
      // Harness needs SString parsing for output-roundtrip on boxes whose
      // registers carry SString values (mainnet first surfaces this at
      // h=766,915 tx 15 output 1; iter-17 closes the phase-2a deferral).
      const len = readVlqU32(r, 'SString.length')
      // getUIntExact (CoreDataSerializer.scala:105): ArithmeticException above
      // Int.MaxValue, thrown BEFORE getBytes — so, unlike SBigInt/SUnsignedBigInt's
      // toShort shape above, this check precedes the window check.
      if (len > 0x7fffffff) {
        throw new SValueParseError(`SString length ${len} exceeds Int.MaxValue`, 'string-too-long')
      }
      const bytes = r.readBytes(len)
      return { kind: 'String', value: decodeUtf8Lossy(bytes) }
    }

    case 'SPreHeader':
    case 'SContext':
    case 'SGlobal':
    case 'SAny':
    case 'SFunc':
    case 'STypeVar':
      throw new SValueParseError(
        `parseSValue ${t.tag} is not implemented in phase 2a`,
        'not-implemented-phase-2a'
      )

    case 'SUnsignedBigInt': {
      // JVM CoreDataSerializer.scala:118-124 (sigma-state v6.0.6): the same
      // `getUShort().toShort` shape as SBigInt above — above 0xFFFF a hard IAE;
      // 33..0x7FFF throw at once; a negative-as-Short size reaches `getBytes`,
      // which checks the window first. Unlike SBigInt, size 0 is a normal,
      // accepted value: `BigIntegers.fromUnsignedByteArray` gives 0n for empty
      // input (must accept — rejecting would be stricter than the JVM = fork.
      // See P2a spec §3). Permissive on version — the v3 gate is validateV6Types.
      const len = r.readVlqU()
      if (len > 0xffff) {
        throw new SValueParseError(`SUnsignedBigInt length ${len} exceeds u16`, 'unsigned-bigint-too-large')
      }
      const size = (len << 16) >> 16
      if (size > 32) {
        throw new SValueParseError(`SUnsignedBigInt length ${len} exceeds 32 bytes`, 'unsigned-bigint-too-large')
      }
      if (size < 0) {
        r.readBytes(0) // the window check getBytes makes first
        throw new SValueParseError(`SUnsignedBigInt length ${len} is negative as a Short`, 'unsigned-bigint-too-large')
      }
      const bytes = r.readBytes(size)
      return { kind: 'UnsignedBigInt', value: decodeUnsignedBigIntBE(bytes) }
    }

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

/** Decode unsigned big-endian magnitude bytes to bigint ([] -> 0n). See spec §3. */
function decodeUnsignedBigIntBE(bytes: Uint8Array): bigint {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
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
