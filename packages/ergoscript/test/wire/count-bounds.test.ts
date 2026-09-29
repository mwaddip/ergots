// JVM bounds (sigma-state 6.0.6): getValues / getUIntExact + safeNewArray (≤ 100000, hard above):
// SigmaByteReader.scala:53-61, BlockValueSerializer.scala:28-37, FuncValueSerializer.scala:30-36,
// SigmaTransformerSerializer.scala:20-29; getUShort (≤ 0xFFFF, hard above): ConcreteCollectionSerializer
// .scala:28 (before getType), ConcreteCollectionBooleanConstantSerializer.scala:34; getUInt (≤ u32)
// for FuncValue arg ids and ValUse ids (FuncValueSerializer.scala:36, ValUseSerializer.scala:13).
import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../../src/wire/parse'
import { serializeExpr } from '../../src/wire/serialize'
import type { Expr } from '../../src/mir/types'

const vlq = (n: number) => { const o: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b) } while (n); return o }
const codeOf = (bytes: number[]) => { try { parseExpr(new ByteReader(Uint8Array.from(bytes)), [], [], new Map(), 0); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }

describe('array counts: 100000 reads on, 100001 is a hard reject', () => {
  const cases: [string, number, string][] = [
    ['Apply', 0xda, 'apply-too-many-args'],           // func first: prefix a func value
    ['BlockValue', 0xd8, 'block-too-many-items'],
    ['FuncValue', 0xd9, 'func-value-too-many-args'],
    ['SigmaAnd', 0xea, 'sigma-and-too-many-items'],
    ['SigmaOr', 0xeb, 'sigma-or-too-many-items'],
  ]
  for (const [name, op, code] of cases) {
    const prefix = op === 0xda ? [op, 0x04, 0x02] : [op]    // Apply: func = Int 1, then the count
    it(`${name}: 100001 → ${code}`, () => expect(codeOf([...prefix, ...vlq(100001)])).toBe(code))
    it(`${name}: 100000 reads on (runs out)`, () => expect(codeOf([...prefix, ...vlq(100000)])).toBe('truncated'))
  }
  it('MethodCall: 100001 → method-call-too-many-args', () => {
    // dc (MethodCall) | 63 13 (typeId, methodId as in method-call.test.ts) | a7 (SELF) | count.
    // parseMethodCall reads typeId, methodId, obj, then the count, with no check in between.
    expect(codeOf([0xdc, 0x63, 0x13, 0xa7, ...vlq(100001)])).toBe('method-call-too-many-args')
  })
  it('MethodCall: 100000 reads on (runs out)', () => {
    expect(codeOf([0xdc, 0x63, 0x13, 0xa7, ...vlq(100000)])).toBe('truncated')
  })
})

describe('collection counts: getUShort, before the element type', () => {
  it('ConcreteCollection 0x10000 → collection-size-out-of-range, before the type is read', () => {
    expect(codeOf([0x83, ...vlq(0x10000)])).toBe('collection-size-out-of-range')
  })
  it('Boolean-constant collection 0x10000 → collection-size-out-of-range', () => {
    expect(codeOf([0x85, ...vlq(0x10000)])).toBe('collection-size-out-of-range')
  })
  it('ConcreteCollection 0xFFFF reads on to the element type (runs out)', () => {
    expect(codeOf([0x83, ...vlq(0xffff)])).toBe('truncated')
  })
  it('Boolean-constant collection 0xFFFF reads on to the bits (runs out)', () => {
    expect(codeOf([0x85, ...vlq(0xffff)])).toBe('truncated')
  })
  it('a Boolean-constant collection count of 2^32-1 rejects at once (it used to loop ~2^32 times)', () => {
    expect(codeOf([0x85, ...vlq(2 ** 32 - 1)])).toBe('collection-size-out-of-range')
  })
})

describe('ids read with getUInt (≤ u32)', () => {
  it('a FuncValue arg id above u32 is rejected', () => {
    expect(codeOf([0xd9, 0x01, ...vlq(2 ** 32), 0x04, 0x04, 0x02])).toBe('vlq-overflow')
  })
  it('a ValUse id above u32 is rejected', () => {
    expect(codeOf([0x72, ...vlq(2 ** 32)])).toBe('vlq-overflow')
  })
})

// The JVM wraps both ids to an Int: getUInt().toInt (FuncValueSerializer.scala:36, ValUseSerializer
// .scala:13; the rows of DeserializationResilience.scala:372-374). It writes them with putUInt
// (FuncValueSerializer.scala:23, ValUseSerializer.scala:9), which rejects a negative Int
// ("-1 is out of unsigned int range", DeserializationResilience.scala:386-389). So such a tree parses
// but cannot be re-encoded. The id domain is a JVM Int, of which putUInt takes [0, 2^31); the
// serializers reject any other id, which only hand-built MIR can hold.
describe('FuncValue arg ids and ValUse ids wrap to an Int; an id outside [0, 2^31) cannot be re-encoded', () => {
  // d9 (FuncValue) | 01 (one arg) | id | 04 (SInt) | body: 72 (ValUse) id
  const lambda = (id: number) => [0xd9, 0x01, ...vlq(id), 0x04, 0x72, ...vlq(id)]
  const parse = (bytes: number[]) => parseExpr(new ByteReader(Uint8Array.from(bytes)), [], [], new Map(), 0)
  const serialize = (e: Expr) => { const w = new ByteWriter(); serializeExpr(e, w, 0); return Array.from(w.toBytes()) }

  const wraps: [number, number][] = [[2 ** 31, -(2 ** 31)], [2 ** 31 + 1, -(2 ** 31) + 1], [2 ** 32 - 1, -1]]
  for (const [raw, wrapped] of wraps) {
    it(`an id of ${raw} parses as ${wrapped} in both the arg and the ValUse`, () => {
      expect(parse(lambda(raw))).toEqual({
        tag: 'FuncValue',
        args: [{ id: wrapped, tpe: { tag: 'SInt' } }],
        body: { tag: 'ValUse', valId: wrapped, tpe: { tag: 'SInt' } },
      })
    })
  }
  for (const id of [0, 0x7fffffff]) {
    it(`an id of ${id} parses as itself and round-trips byte for byte`, () => {
      const bytes = lambda(id)
      const e = parse(bytes)
      expect(e).toEqual({
        tag: 'FuncValue',
        args: [{ id, tpe: { tag: 'SInt' } }],
        body: { tag: 'ValUse', valId: id, tpe: { tag: 'SInt' } },
      })
      expect(serialize(e)).toEqual(bytes)
    })
  }
  it('serializing the parsed wrapped FuncValue throws func-value-arg-id-out-of-range', () => {
    const e = parse(lambda(2 ** 32 - 1))
    expect(() => serialize(e)).toThrowError(
      expect.objectContaining({ name: 'ExprSerializeError', code: 'func-value-arg-id-out-of-range' })
    )
  })
  it('serializing a ValUse with a negative id throws val-use-id-out-of-range', () => {
    const e: Expr = { tag: 'ValUse', valId: -1, tpe: { tag: 'SInt' } }
    expect(() => serialize(e)).toThrowError(
      expect.objectContaining({ name: 'ExprSerializeError', code: 'val-use-id-out-of-range' })
    )
  })
  const outside: [string, number][] = [['0x80000000', 0x80000000], ['1.5', 1.5]]
  for (const [label, id] of outside) {
    it(`serializing a FuncValue whose arg id is ${label} throws func-value-arg-id-out-of-range`, () => {
      const one: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } }
      const e: Expr = { tag: 'FuncValue', args: [{ id, tpe: { tag: 'SInt' } }], body: one }
      expect(() => serialize(e)).toThrowError(
        expect.objectContaining({ name: 'ExprSerializeError', code: 'func-value-arg-id-out-of-range' })
      )
    })
    it(`serializing a ValUse whose id is ${label} throws val-use-id-out-of-range`, () => {
      const e: Expr = { tag: 'ValUse', valId: id, tpe: { tag: 'SInt' } }
      expect(() => serialize(e)).toThrowError(
        expect.objectContaining({ name: 'ExprSerializeError', code: 'val-use-id-out-of-range' })
      )
    })
  }
})
