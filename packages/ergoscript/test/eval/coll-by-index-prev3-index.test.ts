// The pre-v3 ByIndex index at eval (spec 2026-09-30 §8, review m5).
//
// Before tree v3 the JVM's parse upcasts a Byte or Short index to Int (ByIndexSerializer.scala:29-33, `upcastTo(SInt)`,
// syntax.scala:168-177), and the inserted Upcast is evaluated and charged: NumericCastCostKind, 10 for an Int target
// (CostKind.scala:60-66). ergots does not insert the node; it widens the index value at eval and charges the 10 there.
// From v3 the index is taken as it is (ByIndexSerializer.scala:29-30), so a Byte index reaches `index.evalTo[Int]` and
// fails (transformers.scala:258), and ergots keeps 'coll-by-index-index-not-int'.
//
// Every verdict and cost below is a local sigma-state 6.0.6 probe's (spend mode, the tree as SELF, no register or
// variable). The probe prints the cost in block units, a JitCost total / 10 rounded down, so each expectation here
// gives ergots' JitCost and the probe's block cost it must round to:
//   sp(EQ(ByIndex(Coll[Int](5, 7), <index 1>), 7))             Byte 7, Short 7, Int 6    (a difference of one block unit)
//   the same 50 times, in a Coll[Boolean] under SizeOf         Byte 295, Short 295, Int 245
// The 50-fold trees are the exactness check: a widening charged at 9 or 11 would not differ by exactly 50 block units.
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, parseParsedTree } from '../_helpers'
import { ByIndex, Coll, Downcast, EQ, SizeOf, T, collInt, hex, int, long, sp, treeBytes } from '../_helpers/mir-build'

const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
const SHORT: SType = { tag: 'SShort' }
const byte = (n: number): Expr => ({ tag: 'Const', tpe: T.Byte, value: { kind: 'Byte', value: n } })
const short = (n: number): Expr => ({ tag: 'Const', tpe: SHORT, value: { kind: 'Short', value: n } })

/** sigmaProp(Coll[Int](5, 7)(<index>) == 7): the probe's T6-1 to T6-3 (and T6-7 to T6-10 by header). */
const one = (index: Expr): Expr => sp(EQ(ByIndex(collInt([5, 7]), index), int(7)))
/** sigmaProp(Coll[Boolean](50 x (Coll[Int](5, 7)(<index>) == 7)).size == 50): the probe's T6-4 to T6-6. */
const fifty = (index: Expr): Expr =>
  sp(EQ(SizeOf(Coll(T.Bool, Array.from({ length: 50 }, () => EQ(ByIndex(collInt([5, 7]), index), int(7))))), int(50)))
/** sigmaProp(Coll[Int](5, 7).getOrElse(<index>, 9) == <expected>): the probe's T6-11 to T6-15, T6-17 and T6-18. */
const withDefault = (index: Expr, expected: number): Expr =>
  sp(EQ(ByIndex(collInt([5, 7]), index, int(9)), int(expected)))

/** The tree evaluated as the spend does: its own header version, the cost read back. */
function run(bytes: Uint8Array): { value: SValue; jitCost: number } {
  const ctx = makeContext()
  const value = evaluateWith(parseParsedTree(bytes), ctx)
  return { value, jitCost: ctx.jitCost }
}

/** ergots' JitCost total and the block cost the probe prints for it. */
const blockCost = (jitCost: number): number => Math.floor(jitCost / 10)

describe('a Byte or Short ByIndex index in a v0 tree evaluates through the JVM\'s inserted Upcast', () => {
  const int1 = run(treeBytes(one(int(1)), 0x00))
  it('the Int index is the control: no Upcast, 63 JitCost (the probe: 6)', () => {
    expect(hex(treeBytes(one(int(1)), 0x00))).toBe('00d193b210020a0e040200040e')
    expect(int1).toEqual({ value: TRUE_PROP, jitCost: 63 })
    expect(blockCost(int1.jitCost)).toBe(6)
  })

  it('a Byte index 1: true, the Upcast\'s 10 above the Int index (the probe: 7)', () => {
    // ergots at 2762811 rejected it: 'coll-by-index-index-not-int'.
    const bytes = treeBytes(one(byte(1)), 0x00)
    expect(hex(bytes)).toBe('00d193b210020a0e020100040e')
    const r = run(bytes)
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost - int1.jitCost).toBe(10)
    expect(r.jitCost).toBe(73)
    expect(blockCost(r.jitCost)).toBe(7)
  })

  it('a Short index 1: true, the same 10 above the Int index (the probe: 7)', () => {
    const bytes = treeBytes(one(short(1)), 0x00)
    expect(hex(bytes)).toBe('00d193b210020a0e030200040e')
    const r = run(bytes)
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost - int1.jitCost).toBe(10)
    expect(r.jitCost).toBe(73)
    expect(blockCost(r.jitCost)).toBe(7)
  })

  it('50 Byte and 50 Short indices: 500 JitCost above 50 Int indices, so exactly 10 each (the probe: 295, 295, 245)', () => {
    const intX50 = run(treeBytes(fifty(int(1)), 0x00))
    const byteX50 = run(treeBytes(fifty(byte(1)), 0x00))
    const shortX50 = run(treeBytes(fifty(short(1)), 0x00))
    expect(intX50).toEqual({ value: TRUE_PROP, jitCost: 2457 })
    expect(byteX50).toEqual({ value: TRUE_PROP, jitCost: 2957 })
    expect(shortX50).toEqual({ value: TRUE_PROP, jitCost: 2957 })
    expect([intX50, byteX50, shortX50].map((r) => blockCost(r.jitCost))).toEqual([245, 295, 295])
  })
})

describe('the same index in a v1 or v2 tree, still below v3', () => {
  it.each([
    ['v1', 0x09, '090cd193b210020a0e020100040e'],
    ['v2', 0x0a, '0a0cd193b210020a0e020100040e'],
  ])('a Byte index at %s: true, 73 JitCost (the probe: reduced, 7)', (_v, header, expected) => {
    const bytes = treeBytes(one(byte(1)), header)
    expect(hex(bytes)).toBe(expected)
    const r = run(bytes)
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(73)
    expect(blockCost(r.jitCost)).toBe(7)
  })
})

describe('a v3 tree: the JVM does not upcast, so a Byte index is still rejected', () => {
  it('a Byte index rejects with coll-by-index-index-not-int (the probe: ClassCastException, Byte to Integer, at reduce)', () => {
    const bytes = treeBytes(one(byte(1)), 0x0b)
    expect(hex(bytes)).toBe('0b0cd193b210020a0e020100040e')
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-index-not-int')
  })

  it('the Int index at v3 is unchanged: true, 63 JitCost (the probe: 6)', () => {
    const bytes = treeBytes(one(int(1)), 0x0b)
    expect(hex(bytes)).toBe('0b0cd193b210020a0e040200040e')
    expect(run(bytes)).toEqual({ value: TRUE_PROP, jitCost: 63 })
  })
})

describe('a computed Byte or Short index, a Downcast of an Int, is widened the same way', () => {
  // The Downcast is a node of its own (Const 5 and Downcast 10), and the Upcast the parse inserts over it another 10:
  // 63 - 5 + 5 + 10 + 10 = 83, not a special case of a constant index.
  it.each([
    ['Byte', T.Byte, '00d193b210020a0e7d04020200040e'],
    ['Short', SHORT, '00d193b210020a0e7d04020300040e'],
  ])('Downcast(Int 1, %s) at v0: true, 83 JitCost (the probe: reduced, 8)', (_name, tpe, expected) => {
    const bytes = treeBytes(one(Downcast(int(1), tpe)), 0x00)
    expect(hex(bytes)).toBe(expected)
    const r = run(bytes)
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(83)
    expect(blockCost(r.jitCost)).toBe(8)
  })

  it('Downcast(Int 1, Byte) at v3: rejected (the probe: ClassCastException, Byte to Integer, at reduce)', () => {
    const bytes = treeBytes(one(Downcast(int(1), T.Byte)), 0x0b)
    expect(hex(bytes)).toBe('0b0ed193b210020a0e7d04020200040e')
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-index-not-int')
  })
})

describe('the widened index is the value the collection is read at, with a default too (v0)', () => {
  // Below v3 the default is evaluated eagerly (transformers.scala:272-275), so every case below charges the default's
  // Const, 5, whether or not the index is in bounds.
  it('Byte 1 in bounds: the element, 78 JitCost against 68 for the Int index (the probe: 7 and 6)', () => {
    const byteRun = run(treeBytes(withDefault(byte(1), 7), 0x00))
    const intRun = run(treeBytes(withDefault(int(1), 7), 0x00))
    expect(byteRun.value).toEqual(TRUE_PROP)
    expect(intRun.value).toEqual(TRUE_PROP)
    expect(intRun.jitCost).toBe(68)
    expect(byteRun.jitCost).toBe(78)
    expect([blockCost(byteRun.jitCost), blockCost(intRun.jitCost)]).toEqual([7, 6])
  })

  it.each([
    ['Byte 5', byte(5), '00d193b210020a0e02050104120412'],
    ['Byte 127', byte(127), '00d193b210020a0e027f0104120412'],
    ['Byte -1, negative', byte(-1), '00d193b210020a0e02ff0104120412'],
    ['Short -300, negative', short(-300), '00d193b210020a0e03d7040104120412'],
    ['Short 32767', short(32767), '00d193b210020a0e03feff030104120412'],
  ])('%s: out of bounds, so the default 9 (the probe: reduced, 7)', (_name, index, expected) => {
    const bytes = treeBytes(withDefault(index, 9), 0x00)
    expect(hex(bytes)).toBe(expected)
    const r = run(bytes)
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(78)
    expect(blockCost(r.jitCost)).toBe(7)
  })

  it.each([
    ['Byte 5', byte(5), '00d193b210020a0e0205000412'],
    ['Byte -1', byte(-1), '00d193b210020a0e02ff000412'],
    ['Short -300', short(-300), '00d193b210020a0e03d704000412'],
  ])('%s with no default: out of range (the probe: ArrayIndexOutOfBoundsException, Index n out of bounds for length 2)', (_name, index, expected) => {
    const bytes = treeBytes(sp(EQ(ByIndex(collInt([5, 7]), index), int(9))), 0x00)
    expect(hex(bytes)).toBe(expected)
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-out-of-range')
  })
})

describe('the Upcast\'s charge counts toward the cost limit', () => {
  const tree = parseParsedTree(treeBytes(one(byte(1)), 0x00))
  it('a limit of 73 (the total) passes', () => {
    expect(evaluateWith(tree, makeContext({ jitCostLimit: 73 }))).toEqual(TRUE_PROP)
  })
  it('a limit of 72 trips: without the Upcast\'s 10 the total would be 63', () => {
    expect(captureEvalError(() => evaluateWith(tree, makeContext({ jitCostLimit: 72 }))).code).toBe('cost-limit-exceeded')
  })
})

describe('only a Byte or Short value is widened', () => {
  // The JVM rejects a Long, BigInt or non-numeric index at parse (upcastTo's second assert, syntax.scala:172-173), and so
  // does ergots (wire/mir/coll-by-index.ts). A node built through the API can still carry one to the arm.
  const collOf = (): Expr => collInt([5, 7])
  it('a Long index, at the default version: still coll-by-index-index-not-int', () => {
    const err = captureEvalError(() => evalExpr(ByIndex(collOf(), long(1)), Env.empty(), makeContext()))
    expect(err.code).toBe('coll-by-index-index-not-int')
  })
  it('a Byte index through the arm, at a context with no version: widened, so the element', () => {
    const ctx = makeContext()
    expect(evalExpr(ByIndex(collOf(), byte(1)), Env.empty(), ctx)).toEqual({ kind: 'Int', value: 7 })
    // Coll const 5, index const 5, the Upcast 10, ByIndex 30.
    expect(ctx.jitCost).toBe(50)
  })
  it('a Byte index through the arm, at treeVersion 3: rejected', () => {
    const err = captureEvalError(() => evalExpr(ByIndex(collOf(), byte(1)), Env.empty(), makeContext({ treeVersion: 3 })))
    expect(err.code).toBe('coll-by-index-index-not-int')
  })
})
