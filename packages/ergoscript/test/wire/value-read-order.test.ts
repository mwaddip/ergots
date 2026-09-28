// JVM ValueSerializer.deserialize (sigma-state 6.0.6, ValueSerializer.scala:396-411): raise the level
// (the depth check, CoreByteReader.scala:127-131), peekByte with NO window check (:41), then the
// checked read. Relation2Serializer (trees/Relation2Serializer.scala:40-52) peeks for 0x85 only for
// GT, GE, LT, LE, EQ, NEQ, BinOr, BinAnd, BinXor; the arithmetic and bit ops use TwoArgumentsSerializer
// (no lookahead, TwoArgumentsSerializer.scala:21-25; ValueSerializer.scala:48-75).
import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../../src/wire/parse'
import { serializeExpr } from '../../src/wire/serialize'
import { parseAdditionalRegisters } from '../../src/wire/parse-svalue'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const codeOf = (f: () => unknown) => { try { f(); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }
const expr = (r: ByteReader) => parseExpr(r, [], [], new Map(), 0)

describe('value reads: depth, then peek, then the checked read', () => {
  it('at the depth cap, the depth error comes before the window error', () => {
    const r = new ByteReader(hex('0402'))
    for (let i = 0; i < 110; i++) r.enterDepth()
    r.positionLimit = -1
    expect(codeOf(() => expr(r))).toBe('max-tree-depth-exceeded')
  })
  it('at the end of the input past the window, the peek fails first (truncated)', () => {
    const r = new ByteReader(hex('04')); r.readU8(); r.positionLimit = 0
    expect(codeOf(() => expr(r))).toBe('truncated')
  })
  it('with bytes left past the window, the checked read fails (position-limit-exceeded)', () => {
    const r = new ByteReader(hex('0402')); r.positionLimit = -1
    expect(codeOf(() => expr(r))).toBe('position-limit-exceeded')
  })
  it('register values follow the same order', () => {
    const atCap = new ByteReader(hex('010402'))
    for (let i = 0; i < 110; i++) atCap.enterDepth()
    atCap.positionLimit = 0
    expect(codeOf(() => parseAdditionalRegisters(atCap, 0))).toBe('max-tree-depth-exceeded')
    const atEnd = new ByteReader(hex('01')); atEnd.positionLimit = 0
    expect(codeOf(() => parseAdditionalRegisters(atEnd, 0))).toBe('truncated')
  })
})

describe('the 0x85 lookahead belongs to Relation2 only', () => {
  it('Plus then 0x85 reads a whole Coll[Boolean] operand', () => {
    // 9a Plus | 85 02 03 (Coll[Boolean] of 2: true, true) | 04 02 (Int 1)
    const r = new ByteReader(hex('9a8502030402'))
    const e = expr(r) as unknown as { tag: string; left: { tag: string } }
    expect(e.tag).toBe('BinOp')
    expect(e.left.tag).toBe('Collection')
    expect(r.position).toBe(6)
  })
  it('Eq then 0x85 still reads the packed pair', () => {
    const r = new ByteReader(hex('938502'))
    const e = expr(r) as unknown as { left: { tag: string } }
    expect(e.left.tag).toBe('Const')
    expect(r.position).toBe(3)
  })
  it('Plus of two Boolean constants serializes as two full values', () => {
    const t = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
    const f = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: false } }
    const w = new ByteWriter()
    serializeExpr({ tag: 'BinOp', op: { kind: 'Arith', op: 'Plus' }, left: t, right: f } as never, w, 0)
    expect(toHex(w.toBytes())).toBe('9a01010100')
  })
  it('Eq of two Boolean constants still packs', () => {
    const t = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
    const w = new ByteWriter()
    serializeExpr({ tag: 'BinOp', op: { kind: 'Relation', op: 'Eq' }, left: t, right: t } as never, w, 0)
    expect(toHex(w.toBytes())).toBe('938503')
  })
})
