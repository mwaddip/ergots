/**
 * serializeCost — analytical DynamicCost walk for Global.serialize (106:3).
 *
 * Charges ctx.addCost() for each JVM SigmaByteWriter primitive write that
 * DataSerializer would perform when serializing (t, v). Does NOT include the
 * once-only StartWriter(10) — evalGlobalSerialize charges that separately.
 *
 * Mirrors the structure of serializeSValue (wire/serialize-svalue.ts) arm-for-arm.
 * The two functions MUST stay in sync: every write in serializeSValue corresponds
 * to a charge here, using the matching primitive cost.
 *
 * JVM source: SigmaByteWriter.scala (primitive costs) + DataSerializer (structure).
 * Spec: docs/specs/2026-06-04-ergoscript-v6-p5a-serialize-deserializeto-design.md
 * §"Primitive cost table" + §"Per-SType cost rules".
 *
 * JVM verifyCase anchors (LanguageSpecificationV6.scala:76-201):
 *   serialize[Byte](-128)   → method-portion = 11 → walk(SByte) = 1   ✓
 *   serialize[Coll[Byte]](1,2,3) → method-portion = 19 → walk = 9:
 *     putUShort(3)=3 + putBytes(3)(3+3)=6 → 9 ✓
 *
 * Complex types (SBox, SHeader, SAvlTree) live in Task 5; the `default` arm here
 * throws 'global-serialize-failed' so that Task 5 fills them cleanly.
 *
 * Data-type arms covered:
 *   SBoolean, SByte, SShort, SInt, SLong, SUnit,
 *   SBigInt, SUnsignedBigInt, SGroupElement,
 *   SColl (SByte NativeColl, SBoolean bit-packed, general),
 *   SOption, STuple, SString.
 */

import { EvalError } from './eval-context'
import type { EvalContext } from './eval-context'
import type { SType, SValue } from '../mir/types'
import { encodeBigIntBE, encodeUnsignedBigIntBE } from '../wire/serialize-svalue'

// ── Primitive cost constants (JVM SigmaByteWriter.scala, agent-verified) ──────
//
//  put / putByte / putBoolean            = 1
//  putShort / putInt / putLong (signed)  = 3
//  putUShort / put_u16                   = 3   (Coll/BigInt/UBI length, Box.index)
//  putULong / put_u64                    = 3   (Box.value, token.amount, Header.timestamp)
//  putUInt(DataInfo) / put_u32           = 3   (Box.creationHeight, Header.height,
//                                               AvlTree.keyLength, token.index)
//  putUByte                              = 0   (token count, reg count, AvlTree flags)
//  putBytes(n)                           = 3 + n  (PerItemCost(3,1,1))
//  putBits(nbits)                        = 3 + nbits
//  putOption (tag byte)                  = 1

const PUT_BYTE = 1     // put / putByte / putBoolean / putOption-tag
const PUT_NUM3 = 3     // putShort/Int/Long/UShort/ULong/UInt(DataInfo) — all 3

/**
 * Charge the DynamicCost of serializing (t, v), NOT including StartWriter(10).
 *
 * Throws EvalError 'global-serialize-failed' for complex types not yet
 * implemented (Task 5 will fill SBox, SHeader, SAvlTree).
 */
export function serializeCost(t: SType, v: SValue, ctx: EvalContext): void {
  switch (t.tag) {
    // ── Scalars ──────────────────────────────────────────────────────────────

    case 'SBoolean':
      // putBoolean = put = 1
      ctx.addCost(PUT_BYTE)
      return

    case 'SByte':
      // writeU8 = put = 1
      ctx.addCost(PUT_BYTE)
      return

    case 'SShort':
    case 'SInt':
    case 'SLong':
      // putShort / putInt / putLong = 3 each (ZigZag-VLQ)
      ctx.addCost(PUT_NUM3)
      return

    case 'SUnit':
      // 0 bytes written — no cost
      return

    // ── BigInt / UnsignedBigInt ───────────────────────────────────────────────
    //
    // Wire format: VLQ u16 (magnitude byte-length) + raw bytes.
    // JVM: putUShort(len)(3) + putBytes(len)(3 + len).
    // The byte count depends on the RUNTIME VALUE (not a fixed bound).

    case 'SBigInt': {
      const bv = v as Extract<SValue, { kind: 'BigInt' }>
      const len = encodeBigIntBE(bv.value).length
      // putUShort(len) = 3; putBytes(len) = 3 + len
      ctx.addCost(PUT_NUM3 + (3 + len))
      return
    }

    case 'SUnsignedBigInt': {
      const ubv = v as Extract<SValue, { kind: 'UnsignedBigInt' }>
      const len = encodeUnsignedBigIntBE(ubv.value).length
      // putUShort(len) = 3; putBytes(len) = 3 + len
      ctx.addCost(PUT_NUM3 + (3 + len))
      return
    }

    // ── GroupElement ─────────────────────────────────────────────────────────
    //
    // Wire: exactly 33 raw bytes (SEC1-compressed point).
    // JVM: putBytes(33) = 3 + 33 = 36.

    case 'SGroupElement':
      ctx.addCost(3 + 33)
      return

    // ── SColl ─────────────────────────────────────────────────────────────────
    //
    // Wire: VLQ u16 (length) + element payload.
    // JVM: putUShort(n)(3) + ...
    //   SColl[SByte]: NativeColl → putBytes(n) = 3 + n
    //   SColl[SBoolean]: bit-packed → putBits(n) = 3 + n
    //   SColl[T]: general → putUShort(n)(3) + Σ walk(elem, item)

    case 'SColl': {
      const coll = v as Extract<SValue, { kind: 'Coll' }>
      const n = coll.items.length
      // length field: putUShort = 3
      ctx.addCost(PUT_NUM3)

      if (t.elem.tag === 'SByte') {
        // NativeColl: putBytes(n) = 3 + n
        ctx.addCost(3 + n)
        return
      }

      if (t.elem.tag === 'SBoolean') {
        // Bit-packed: putBits(n) = 3 + n
        ctx.addCost(3 + n)
        return
      }

      // General: each item recurses
      for (const item of coll.items) {
        serializeCost(t.elem, item, ctx)
      }
      return
    }

    // ── SOption ───────────────────────────────────────────────────────────────
    //
    // Wire: 1-byte tag (0x00 = None, 0x01 = Some) + Some? inner.
    // JVM: putOption-tag(1) + Some? walk(elem, inner).

    case 'SOption': {
      const opt = v as Extract<SValue, { kind: 'Option' }>
      // putOption tag = 1
      ctx.addCost(PUT_BYTE)
      if (opt.value !== null) {
        serializeCost(t.elem, opt.value, ctx)
      }
      return
    }

    // ── STuple ────────────────────────────────────────────────────────────────
    //
    // Wire: no length prefix — items written in order.
    // JVM: Σ walk(item) per item.

    case 'STuple': {
      const tup = v as Extract<SValue, { kind: 'Tuple' }>
      for (let i = 0; i < t.items.length; i++) {
        serializeCost(t.items[i]!, tup.items[i]!, ctx)
      }
      return
    }

    // ── SString ───────────────────────────────────────────────────────────────
    //
    // Wire: VLQ u16 (UTF-8 byte count) + raw UTF-8 bytes.
    // JVM: putUShort(utf8Len)(3) + putBytes(utf8Len)(3 + utf8Len).

    case 'SString': {
      const sv = v as Extract<SValue, { kind: 'String' }>
      const utf8Len = new TextEncoder().encode(sv.value).length
      // putUShort(utf8Len) = 3; putBytes(utf8Len) = 3 + utf8Len
      ctx.addCost(PUT_NUM3 + (3 + utf8Len))
      return
    }

    // ── Complex types: Task 5 ─────────────────────────────────────────────────
    //
    // SAvlTree, SHeader, SBox: cost arms land in Task 5.
    // Until then, throw so the test suite reliably fails on these types.

    case 'SAvlTree':
    case 'SHeader':
    case 'SBox':
      throw new EvalError(
        `serialize: complex type ${t.tag} cost arm not yet implemented (Task 5)`,
        'global-serialize-failed',
      )

    // ── Non-data types ────────────────────────────────────────────────────────
    //
    // SAny, SFunc, SPreHeader, SContext, SGlobal, SSigmaProp, STypeVar,
    // STypeApply, STupleKind, etc. — serializeSValue throws for these, so
    // the cost walk should never be reached. Throw here defensively.
    default: {
      const _tag: string = (t as { tag: string }).tag
      throw new EvalError(
        `serialize: unsupported type ${_tag} in serializeCost`,
        'global-serialize-failed',
      )
    }
  }
}

