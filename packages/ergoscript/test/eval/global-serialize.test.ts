/**
 * v6 P5a — SGlobal.serialize (MethodCall, 106:3) eval handler + serializeCost walk.
 *
 * JVM source: sigma/ast/methods.scala:1957-1984 — DynamicCost: StartWriter(10)
 * + per-primitive write costs as DataSerializer walks the value. V3-gated.
 *
 * Cost decomposition (established from P4 some/none test — consensus-load-bearing):
 *   4 (dispatcher) + 5 (Global obj arm) + 5 (Const arg) = 14 framework
 *   + 10 (StartWriter) + walk(T, v) = handler
 *
 * JVM verifyCase anchors (from LanguageSpecificationV6.scala:76-201):
 *   serialize[Byte](-128)  → method-portion = 11  (StartWriter + SByte(1))
 *   serialize[Coll[Byte]](1,2,3) → method-portion = 19  (StartWriter + 3(len) + (3+3))
 *
 * All cost assertions below are derived from the spec's primitive table; the JVM
 * anchors above confirm the per-type constants.
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall, SType, SValue } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }

/** Construct a Global.serialize MethodCall expr over a Const arg. */
function serExpr(tpe: SType, value: SValue): MethodCall {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 3,
    args: [{ tag: 'Const', tpe, value }],
    explicitTypeArgs: {},
  }
}

/** Build a Coll[Byte] SValue from an array of number bytes. */
const collByte = (bytes: number[]): SValue =>
  ({ kind: 'Coll', elem: SBYTE, items: bytes.map((b) => ({ kind: 'Byte', value: b })) })

describe('Global.serialize (106:3) — v6 P5a (data types)', () => {
  // Framework: 4 + 5 + 5 = 14. Handler = 10 (StartWriter) + walk.
  // JVM anchor: serialize[Byte](-128) method-portion = 11, confirming walk(SByte) = 1.

  it('serialize[Byte](0) → Coll[Byte]([0]), cost 25', () => {
    // walk = putByte = 1 → handler = 11 → total = 14 + 11 = 25
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(serExpr(SBYTE, { kind: 'Byte', value: 0 }), Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(25)
  })

  it('serialize[Byte](-128) → Coll[Byte]([0x80]), cost 25', () => {
    // Same walk cost as above; -128 encodes as unsigned 0x80.
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(serExpr(SBYTE, { kind: 'Byte', value: -128 }), Env.empty(), ctx)
    // -128 & 0xff = 0x80 = 128 unsigned; sign-extended back = -128
    expect(r).toEqual(collByte([0x80].map((b) => (b << 24) >> 24)))
    expect(ctx.jitCost).toBe(25)
  })

  it('serialize[Int](0) → Coll[Byte]([0]), cost 27', () => {
    // walk = putInt = 3 → handler = 13 → total = 27
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(serExpr({ tag: 'SInt' }, { kind: 'Int', value: 0 }), Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(27)
  })

  it('serialize[Short](0) → Coll[Byte]([0]), cost 27', () => {
    // walk = putShort = 3 → handler = 13 → total = 27
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(serExpr({ tag: 'SShort' }, { kind: 'Short', value: 0 }), Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(27)
  })

  it('serialize[Long](0) → Coll[Byte]([0]), cost 27', () => {
    // walk = putLong = 3 → handler = 13 → total = 27
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(serExpr({ tag: 'SLong' }, { kind: 'Long', value: 0n }), Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(27)
  })

  it('serialize[Boolean](true) → Coll[Byte]([1]), cost 25', () => {
    // walk = putBoolean = 1 → handler = 11 → total = 25
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SBoolean' }, { kind: 'Boolean', value: true }), Env.empty(), ctx)
    expect(r).toEqual(collByte([1]))
    expect(ctx.jitCost).toBe(25)
  })

  it('serialize[Unit](()) → Coll[Byte]([]), cost 24', () => {
    // walk = 0 → handler = 10 → total = 24
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(serExpr({ tag: 'SUnit' }, { kind: 'Unit' }), Env.empty(), ctx)
    expect(r).toEqual(collByte([]))
    expect(ctx.jitCost).toBe(24)
  })

  it('serialize[Coll[Byte]]([1,2,3]) → Coll[Byte]([3,1,2,3]), cost 33', () => {
    // JVM anchor: method-portion = 19 → handler = 10 + 9 = 19 → total 33.
    // walk = putUShort(len=3)(3) + putBytes(3)(3+3) = 9.
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SColl', elem: SBYTE }, collByte([1, 2, 3])), Env.empty(), ctx)
    expect(r).toEqual(collByte([3, 1, 2, 3]))
    expect(ctx.jitCost).toBe(33)
  })

  it('serialize[Coll[Byte]]([]) → Coll[Byte]([0]), cost 30', () => {
    // walk = putUShort(len=0)(3) + putBytes(0)(3+0) = 6 → handler = 16 → total = 30
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SColl', elem: SBYTE }, collByte([])), Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(30)
  })

  it('serialize[Coll[Boolean]]([true, false]) → Coll[Byte]([2, 0x01]), cost 32', () => {
    // walk = putUShort(len=2)(3) + putBits(2)(3+2) = 8 → handler = 18 → total = 32
    // Output: len VLQ(2) = [0x02], then bit-packed [true,false] = 0b00000001 = [0x01]
    const ctx = makeContext({ treeVersion: 3 })
    const collBool: SValue = {
      kind: 'Coll', elem: { tag: 'SBoolean' },
      items: [{ kind: 'Boolean', value: true }, { kind: 'Boolean', value: false }],
    }
    const r = evalMethodCall(serExpr({ tag: 'SColl', elem: { tag: 'SBoolean' } }, collBool), Env.empty(), ctx)
    // VLQ(2) = [0x02], bitpack = [0x01]
    expect(r).toEqual(collByte([2, 1].map((b) => (b << 24) >> 24)))
    expect(ctx.jitCost).toBe(32)
  })

  it('serialize[(Long,Long)]((0,0)) → Coll[Byte]([0,0]), cost 30', () => {
    // walk = SLong(3) + SLong(3) = 6 → handler = 16 → total = 30
    const ctx = makeContext({ treeVersion: 3 })
    const tup: SType = { tag: 'STuple', items: [{ tag: 'SLong' }, { tag: 'SLong' }] }
    const r = evalMethodCall(
      serExpr(tup, { kind: 'Tuple', items: [{ kind: 'Long', value: 0n }, { kind: 'Long', value: 0n }] }),
      Env.empty(), ctx)
    expect(r).toEqual(collByte([0, 0]))
    expect(ctx.jitCost).toBe(30)
  })

  it('serialize[BigInt](0) → Coll[Byte]([1, 0]), cost 31', () => {
    // encodeBigIntBE(0n) = [0x00] (1 byte).
    // walk = putUShort(len=1)(3) + putBytes(1)(3+1) = 7 → handler = 17 → total = 31
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SBigInt' }, { kind: 'BigInt', value: 0n }), Env.empty(), ctx)
    // VLQ(1) = [0x01], then [0x00]
    expect(r).toEqual(collByte([1, 0].map((b) => (b << 24) >> 24)))
    expect(ctx.jitCost).toBe(31)
  })

  it('serialize[Option[Int]](None) → Coll[Byte]([0]), cost 25', () => {
    // walk = putOption tag(1) + no inner = 1 → handler = 11 → total = 25
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SOption', elem: { tag: 'SInt' } },
        { kind: 'Option', elem: { tag: 'SInt' }, value: null }),
      Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(25)
  })

  it('serialize[Option[Int]](Some(0)) → Coll[Byte]([1, 0]), cost 28', () => {
    // walk = putOption tag(1) + SInt(3) = 4 → handler = 14 → total = 14 + 14 = 28
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SOption', elem: { tag: 'SInt' } },
        { kind: 'Option', elem: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }),
      Env.empty(), ctx)
    // writeOption(Some(0)) for SInt: [0x01] tag + ZigZag(0)=[0x00]
    expect(r).toEqual(collByte([1, 0].map((b) => (b << 24) >> 24)))
    expect(ctx.jitCost).toBe(28)
  })

  it('serialize[GroupElement] → Coll[Byte](33 bytes), cost 60', () => {
    // walk = putBytes(33) = 3 + 33 = 36 → handler = 46 → total = 60
    // Output = raw 33 bytes (no length prefix — writeBytes is raw for SGroupElement)
    const ge = new Uint8Array(33)
    ge[0] = 0x02 // SEC1 compressed even-Y prefix
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SGroupElement' }, { kind: 'GroupElement', value: ge }),
      Env.empty(), ctx)
    // serializeSValue for SGroupElement = writeBytes(33) = 33 raw bytes
    const expected: number[] = Array(33).fill(0)
    expected[0] = 2 // ge[0] = 0x02
    expect(r).toEqual(collByte(expected.map((b) => (b << 24) >> 24)))
    expect(ctx.jitCost).toBe(60)
  })

  // SString length uses the no-DataInfo putUInt (cost 0), NOT putUShort (3) — so
  // cost = StartWriter(10) + putBytes(3 + utf8Len). Verified vs CoreDataSerializer.
  // scala:29-32 + SigmaByteWriter.scala:105-107 (anchorless arm; review Important-1).
  it('serialize[String]("") → Coll[Byte]([0]), cost 27', () => {
    // walk = putBytes(0) = 3 (length putUInt = 0) → handler = 13 → total = 27
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SString' }, { kind: 'String', value: '' }), Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(27)
  })

  it('serialize[String]("ab") → Coll[Byte]([2, 97, 98]), cost 29', () => {
    // walk = putBytes(2) = 3 + 2 = 5 (length putUInt = 0) → handler = 15 → total = 29
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SString' }, { kind: 'String', value: 'ab' }), Env.empty(), ctx)
    expect(r).toEqual(collByte([2, 97, 98]))
    expect(ctx.jitCost).toBe(29)
  })

  it('serialize[UnsignedBigInt](0) → Coll[Byte]([0]), cost 30', () => {
    // encodeUnsignedBigIntBE(0n) = [] (len 0).
    // walk = putUShort(len=0)(3) + putBytes(0)(3+0) = 6 → handler = 16 → total = 30
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SUnsignedBigInt' }, { kind: 'UnsignedBigInt', value: 0n }), Env.empty(), ctx)
    expect(r).toEqual(collByte([0]))
    expect(ctx.jitCost).toBe(30)
  })

  it('serialize[UnsignedBigInt](50) → Coll[Byte]([1, 50]), cost 31', () => {
    // encodeUnsignedBigIntBE(50n) = [0x32] (1 byte).
    // walk = putUShort(len=1)(3) + putBytes(1)(3+1) = 7 → handler = 17 → total = 31
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(
      serExpr({ tag: 'SUnsignedBigInt' }, { kind: 'UnsignedBigInt', value: 50n }), Env.empty(), ctx)
    expect(r).toEqual(collByte([1, 50]))
    expect(ctx.jitCost).toBe(31)
  })

  it('V3 gate — treeVersion 2 throws tree-version-too-low', () => {
    const ctx = makeContext({ treeVersion: 2 })
    expect(() =>
      evalMethodCall(serExpr(SBYTE, { kind: 'Byte', value: 0 }), Env.empty(), ctx)
    ).toThrowError(EvalError)
    try {
      evalMethodCall(serExpr(SBYTE, { kind: 'Byte', value: 0 }), Env.empty(), makeContext({ treeVersion: 2 }))
    } catch (e) {
      expect((e as EvalError).code).toBe('tree-version-too-low')
    }
  })
})

describe('Global.serialize (106:3) — output bytes round-trip sanity', () => {
  // The output bytes must equal what serializeSValue would produce directly.
  // This catches any mismatch between the cost walk and the actual encoding.

  it('serialize[Int](12345) output bytes match serializeSValue', async () => {
    const { serializeSValue } = await import('../../src/wire/serialize-svalue')
    const { ByteWriter } = await import('@ergots/scorex')
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(
      serExpr({ tag: 'SInt' }, { kind: 'Int', value: 12345 }), Env.empty(), ctx)
    const w = new ByteWriter()
    serializeSValue({ tag: 'SInt' }, { kind: 'Int', value: 12345 }, 3, w)
    const expected = w.toBytes()
    // result is Coll[Byte]; compare each item.sign-extended byte
    const actual = (result as Extract<SValue, { kind: 'Coll' }>).items
      .map((item) => (item as Extract<SValue, { kind: 'Byte' }>).value & 0xff)
    expect(new Uint8Array(actual)).toEqual(expected)
  })

  it('serialize[Coll[Byte]]([10,20,30]) output bytes match serializeSValue', async () => {
    const { serializeSValue } = await import('../../src/wire/serialize-svalue')
    const { ByteWriter } = await import('@ergots/scorex')
    const val: SValue = collByte([10, 20, 30])
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalMethodCall(
      serExpr({ tag: 'SColl', elem: SBYTE }, val), Env.empty(), ctx)
    const w = new ByteWriter()
    serializeSValue({ tag: 'SColl', elem: SBYTE }, val, 3, w)
    const expected = w.toBytes()
    const actual = (result as Extract<SValue, { kind: 'Coll' }>).items
      .map((item) => (item as Extract<SValue, { kind: 'Byte' }>).value & 0xff)
    expect(new Uint8Array(actual)).toEqual(expected)
  })
})
