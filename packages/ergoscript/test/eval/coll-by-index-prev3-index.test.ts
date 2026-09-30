// The pre-v3 ByIndex index at eval (spec 2026-09-30 §8, review m5, and Task 6's review).
//
// Before tree v3 the JVM's parse upcasts the index to Int by its STATIC type (ByIndexSerializer.scala:29-33,
// `upcastTo(SInt)`, syntax.scala:168-177). An index statically Byte or Short sits under an inserted Upcast, evaluated and
// charged: NumericCastCostKind, 10 for an Int target (CostKind.scala:60-66). One statically Int has none, and
// `index.evalTo[Int]` (transformers.scala:258) fails on any other value. ergots inserts no node: it reads the index's
// static type, `exprTpe(index)`, and charges the 10 itself (eval/coll-by-index.ts). From v3 the parse does not upcast
// (ByIndexSerializer.scala:29-30), so a Byte index fails, with 'coll-by-index-index-not-int'.
//
// Every verdict and cost below is a local sigma-state 6.0.6 probe's (spend mode, the tree as SELF, no register or
// variable). The probe prints the cost in block units, a JitCost total / 10 rounded down, so each expectation here
// gives ergots' JitCost and the probe's block cost it must round to:
//   sp(EQ(ByIndex(Coll[Int](5, 7), <index 1>), 7))             Byte 7, Short 7, Int 6    (a difference of one block unit)
//   the same 50 times, in a Coll[Boolean] under SizeOf         Byte 295, Short 295, Int 245
// The 50-fold trees are the exactness check: a widening charged at 9 or 11 would not differ by exactly 50 block units.
// Every tree is built through `probed`, which asserts its bytes against the ones the probe was given.
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { ExprTpeError, exprTpe } from '../../src/mir/expr-tpe'
import { isOwnSAny } from '../../src/mir/jvm-types'
import type { Expr, FuncValue, SType, SValue } from '../../src/mir/types'
import { captureEvalError, parseParsedTree, synthesizeStubBox } from '../_helpers'
import {
  Apply,
  ByIndex,
  Coll,
  DR,
  Downcast,
  EQ,
  Filter,
  GetVar,
  If,
  OptionGet,
  Plus,
  SelectField,
  SizeOf,
  T,
  Tuple,
  ValUse,
  bool,
  bytes as collBytes,
  collInt,
  hex,
  int,
  long,
  sp,
  treeBytes,
} from '../_helpers/mir-build'

const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
const SHORT: SType = { tag: 'SShort' }
const byte = (n: number): Expr => ({ tag: 'Const', tpe: T.Byte, value: { kind: 'Byte', value: n } })
const short = (n: number): Expr => ({ tag: 'Const', tpe: SHORT, value: { kind: 'Short', value: n } })

/** sigmaProp(Coll[Int](5, 7)(<index>) == 7): the probe's T6-1 to T6-3 (and T6-7 to T6-10 by header). */
const one = (index: Expr): Expr => sp(EQ(ByIndex(collInt([5, 7]), index), int(7)))
/** sigmaProp(Coll[Boolean](50 x (Coll[Int](5, 7)(<index>) == 7)).size == 50): the probe's T6-4 to T6-6. */
const fifty = (index: Expr): Expr =>
  sp(EQ(SizeOf(Coll(T.Bool, Array.from({ length: 50 }, () => EQ(ByIndex(collInt([5, 7]), index), int(7))))), int(50)))
/**
 * The probed bytes of `fifty`: 00d193b1833201 (header, sigmaProp, ==, SizeOf, a Coll of 50 Booleans), the 50 reads, then
 * 0464 (== 50). Each read is 93 b2 <Coll[Int](5, 7)> <index> 00 04 0e, its index the two bytes 02 01 (Byte 1), 03 02
 * (Short 1) or 04 02 (Int 1). Each string below was checked equal to the probe's own input.
 */
const FIFTY_HEAD = '00d193b1833201'
const FIFTY_TAIL = '0464'
const fiftyHex = (read: string): string => FIFTY_HEAD + read.repeat(50) + FIFTY_TAIL
/** sigmaProp(Coll[Int](5, 7).getOrElse(<index>, 9) == <expected>): the probe's T6-11 to T6-15, T6-17 and T6-18. */
const withDefault = (index: Expr, expected: number): Expr =>
  sp(EQ(ByIndex(collInt([5, 7]), index, int(9)), int(expected)))

/** A tree's bytes, checked against the bytes the probe was given, so no tree is asserted by its cost alone. */
function probed(tree: Expr, header: number, expected: string): Uint8Array {
  const b = treeBytes(tree, header)
  expect(hex(b)).toBe(expected)
  return b
}

/** The tree spent as the probe does: SELF holds it, no register or variable, its own header version; the cost read back. */
function run(bytes: Uint8Array): { value: SValue; jitCost: number } {
  const tree = parseParsedTree(bytes)
  const ctx = makeContext({
    treeVersion: tree.header.version,
    constants: tree.constants,
    selfBox: { ...synthesizeStubBox(), ergoTreeBytes: bytes },
    extension: { values: new Map() },
  })
  const value = evaluateWith(tree, ctx)
  return { value, jitCost: ctx.jitCost }
}

/** ergots' JitCost total and the block cost the probe prints for it. */
const blockCost = (jitCost: number): number => Math.floor(jitCost / 10)

describe('a Byte or Short ByIndex index in a v0 tree evaluates through the JVM\'s inserted Upcast', () => {
  const int1 = run(probed(one(int(1)), 0x00, '00d193b210020a0e040200040e'))
  it('the Int index is the control: no Upcast, 63 JitCost (the probe: 6)', () => {
    expect(int1).toEqual({ value: TRUE_PROP, jitCost: 63 })
    expect(blockCost(int1.jitCost)).toBe(6)
  })

  it('a Byte index 1: true, the Upcast\'s 10 above the Int index (the probe: 7)', () => {
    // ergots at 2762811 rejected it: 'coll-by-index-index-not-int'.
    const r = run(probed(one(byte(1)), 0x00, '00d193b210020a0e020100040e'))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost - int1.jitCost).toBe(10)
    expect(r.jitCost).toBe(73)
    expect(blockCost(r.jitCost)).toBe(7)
  })

  it('a Short index 1: true, the same 10 above the Int index (the probe: 7)', () => {
    const r = run(probed(one(short(1)), 0x00, '00d193b210020a0e030200040e'))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost - int1.jitCost).toBe(10)
    expect(r.jitCost).toBe(73)
    expect(blockCost(r.jitCost)).toBe(7)
  })

  it('50 Byte and 50 Short indices: 500 JitCost above 50 Int indices, so exactly 10 each (the probe: 295, 295, 245)', () => {
    const intX50 = run(probed(fifty(int(1)), 0x00, fiftyHex('93b210020a0e040200040e')))
    const byteX50 = run(probed(fifty(byte(1)), 0x00, fiftyHex('93b210020a0e020100040e')))
    const shortX50 = run(probed(fifty(short(1)), 0x00, fiftyHex('93b210020a0e030200040e')))
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
    const r = run(probed(one(byte(1)), header, expected))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(73)
    expect(blockCost(r.jitCost)).toBe(7)
  })
})

describe('a v3 tree: the JVM does not upcast, so a Byte index is still rejected', () => {
  it('a Byte index rejects with coll-by-index-index-not-int (the probe: ClassCastException, Byte to Integer, at reduce)', () => {
    const bytes = probed(one(byte(1)), 0x0b, '0b0cd193b210020a0e020100040e')
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-index-not-int')
  })

  it('the Int index at v3 is unchanged: true, 63 JitCost (the probe: 6)', () => {
    expect(run(probed(one(int(1)), 0x0b, '0b0cd193b210020a0e040200040e'))).toEqual({ value: TRUE_PROP, jitCost: 63 })
  })
})

describe('a computed Byte or Short index, a Downcast of an Int, is widened the same way', () => {
  // The Downcast is a node of its own (Const 5 and Downcast 10), and the Upcast the parse inserts over it another 10:
  // 63 - 5 + 5 + 10 + 10 = 83, not a special case of a constant index.
  it.each([
    ['Byte', T.Byte, '00d193b210020a0e7d04020200040e'],
    ['Short', SHORT, '00d193b210020a0e7d04020300040e'],
  ])('Downcast(Int 1, %s) at v0: true, 83 JitCost (the probe: reduced, 8)', (_name, tpe, expected) => {
    const r = run(probed(one(Downcast(int(1), tpe)), 0x00, expected))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(83)
    expect(blockCost(r.jitCost)).toBe(8)
  })

  it('Downcast(Int 1, Byte) at v3: rejected (the probe: ClassCastException, Byte to Integer, at reduce)', () => {
    const bytes = probed(one(Downcast(int(1), T.Byte)), 0x0b, '0b0ed193b210020a0e7d04020200040e')
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-index-not-int')
  })
})

describe('the widened index is the value the collection is read at, with a default too (v0)', () => {
  // Below v3 the default is evaluated eagerly (transformers.scala:272-275), so every case below charges the default's
  // Const, 5, whether or not the index is in bounds.
  it('Byte 1 in bounds: the element, 78 JitCost against 68 for the Int index (the probe: 7 and 6)', () => {
    const byteRun = run(probed(withDefault(byte(1), 7), 0x00, '00d193b210020a0e0201010412040e'))
    const intRun = run(probed(withDefault(int(1), 7), 0x00, '00d193b210020a0e0402010412040e'))
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
    const r = run(probed(withDefault(index, 9), 0x00, expected))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(78)
    expect(blockCost(r.jitCost)).toBe(7)
  })

  it.each([
    ['Byte 5', byte(5), '00d193b210020a0e0205000412'],
    ['Byte -1', byte(-1), '00d193b210020a0e02ff000412'],
    ['Short -300', short(-300), '00d193b210020a0e03d704000412'],
  ])('%s with no default: out of range (the probe: ArrayIndexOutOfBoundsException, Index n out of bounds for length 2)', (_name, index, expected) => {
    const bytes = probed(sp(EQ(ByIndex(collInt([5, 7]), index), int(9))), 0x00, expected)
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-out-of-range')
  })
})

describe('the Upcast\'s charge counts toward the cost limit', () => {
  const tree = parseParsedTree(probed(one(byte(1)), 0x00, '00d193b210020a0e020100040e'))
  it('a limit of 73 (the total) passes', () => {
    expect(evaluateWith(tree, makeContext({ jitCostLimit: 73 }))).toEqual(TRUE_PROP)
  })
  it('a limit of 72 trips: without the Upcast\'s 10 the total would be 63', () => {
    expect(captureEvalError(() => evaluateWith(tree, makeContext({ jitCostLimit: 72 }))).code).toBe('cost-limit-exceeded')
  })
})

describe('only a statically Byte or Short index is widened', () => {
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

// ── The widening is keyed on the index's static type (Task 6's review; spec §8) ────────────────────────────────────────
// The JVM's parse upcasts on `index.tpe` (ByIndexSerializer.scala:32, syntax.scala:168-177), so the Upcast is there when
// the index is statically Byte or Short and absent when it is Int, whatever the value is at run time. The value can
// differ from the type: the JVM checks a Coll or a pair argument by its class only (SType.scala:198-201,
// `isValueOfType`), so a Coll[Byte] enters a lambda declared over Coll[Int], and its c(0) is statically Int with a Byte
// value. That Byte reaches `index.evalTo[Int]` (transformers.scala:258) and fails. The value-kind rule accepted it.
// A scalar argument is checked exactly, by the lambda itself (values.scala:1074), so the JVM rejects a Byte passed to an
// (x: Int) lambda before its body runs; ergots has no such check (residual 7), and rejects it at the index by its type.
// Not pinned here, as they belong to residual 7 (the JVM's class-level checks at other nodes): an Int passed to an
// (x: Byte) lambda, which the lambda's argument check rejects, and `Plus(c(0), 1)` over a Coll[Byte] bound to a Coll[Int].
// The trees are the review's A, B and C cases and my X cases, each spent on the probe; the hex is the probe's input.

const FALSE = bool(false)
const lam = (argTpe: SType, body: Expr): FuncValue => ({ tag: 'FuncValue', args: [{ id: 1, tpe: argTpe }], body })
const PII = T.Tuple(T.Int, T.Int)
/** sigmaProp(((x: <tpe>) => Coll[Int](5, 7)(x))(<arg>) == 7). */
const scalarArg = (tpe: SType, arg: Expr): Expr =>
  sp(EQ(Apply(lam(tpe, ByIndex(collInt([5, 7]), ValUse(1, tpe))), [arg]), int(7)))
/** sigmaProp(((c: Coll[<elem>]) => Coll[Int](5, 7)(c(0)))(<arg>) == 7). */
const collArg = (elem: SType, arg: Expr): Expr => {
  const c = T.Coll(elem)
  return sp(EQ(Apply(lam(c, ByIndex(collInt([5, 7]), ByIndex(ValUse(1, c), int(0)))), [arg]), int(7)))
}
/** sigmaProp(((p: (Int, Int)) => Coll[Int](5, 7)(p._1))(<arg>) == 7). */
const pairArg = (arg: Expr): Expr =>
  sp(EQ(Apply(lam(PII, ByIndex(collInt([5, 7]), SelectField(ValUse(1, PII), 1))), [arg]), int(7)))
/** sigmaProp(Coll[Int](5, 7)(DeserializeRegister(R4, Int, <default>)) == 7), R4 absent. */
const defaultIndex = (dflt: Expr): Expr => sp(EQ(ByIndex(collInt([5, 7]), DR(4, T.Int, dflt)), int(7)))

describe('a statically Int index takes an Int value only', () => {
  it.each([
    [
      'a Byte argument to (x: Int) => Coll(5, 7)(x)',
      'InterpreterException, the lambda\'s argument check (values.scala:1074): expected SInt, value 1',
      scalarArg(T.Int, byte(1)),
      0x00,
      '00d193dad9010104b210020a0e720100010201040e',
    ],
    [
      'a Short argument to (x: Int) => Coll(5, 7)(x)',
      'InterpreterException, the lambda\'s argument check (values.scala:1074): expected SInt, value 1',
      scalarArg(T.Int, short(1)),
      0x00,
      '00d193dad9010104b210020a0e720100010302040e',
    ],
    [
      'the element of a Coll[Byte] passed as a Coll[Int]',
      'ClassCastException, Byte to Integer',
      collArg(T.Int, collBytes([1])),
      0x00,
      '00d193dad9010110b210020a0eb2720104000000010e0101040e',
    ],
    [
      'the first item of a (Byte, Byte) passed as an (Int, Int)',
      'ClassCastException, Byte to Integer',
      pairArg(Tuple(byte(1), byte(1))),
      0x00,
      '00d193dad9010158b210020a0e8c7201010001860202010201040e',
    ],
    [
      'a substituted default, (x: Int) => x applied to a Byte',
      'InterpreterException, the lambda\'s argument check (values.scala:1074): expected SInt, value 1',
      defaultIndex(Apply(lam(T.Int, ValUse(1, T.Int)), [byte(1)])),
      0x00,
      '00d193b210020a0ed5040401dad9010104720101020100040e',
    ],
    [
      'a substituted default, the element of a Coll[Byte] passed as a Coll[Int]',
      'InterpreterException, the lambda\'s result check (values.scala:1080): the ByIndex, expected SInt',
      defaultIndex(Apply(lam(T.Coll(T.Int), ByIndex(ValUse(1, T.Coll(T.Int)), int(0))), [collBytes([1])])),
      0x00,
      '00d193b210020a0ed5040401dad9010110b27201040000010e010100040e',
    ],
    [
      'an If typed by its true branch, Int, that takes a Byte false branch',
      'ClassCastException, Byte to Integer',
      sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, int(1), byte(1))), int(7))),
      0x00,
      '00d193b210020a0e9501000402020100040e',
    ],
    [
      'a Byte argument to (x: Int) => Coll(5, 7)(x), at v3',
      'InterpreterException, the lambda\'s argument check (values.scala:1074): expected SInt, value 1',
      scalarArg(T.Int, byte(1)),
      0x0b,
      '0b14d193dad9010104b210020a0e720100010201040e',
    ],
    [
      'the element of a Coll[Byte] passed as a Coll[Int], at v3',
      'ClassCastException, Byte to Integer',
      collArg(T.Int, collBytes([1])),
      0x0b,
      '0b19d193dad9010110b210020a0eb2720104000000010e0101040e',
    ],
    [
      'an If typed by its true branch, Int, that takes a Byte false branch, at v3',
      'ClassCastException, Byte to Integer',
      sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, int(1), byte(1))), int(7))),
      0x0b,
      '0b11d193b210020a0e9501000402020100040e',
    ],
  ])('%s: rejects (the probe: %s)', (_name, _jvm, tree, header, expected) => {
    // The Byte value behind an Int type is what the value-kind rule accepted, from v0 to v2. (At v3 it was already rejected.)
    const bytes = probed(tree, header, expected)
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-index-not-int')
  })

  it.each([
    ['an Int argument to (x: Int) => Coll(5, 7)(x)', 10, scalarArg(T.Int, int(1)), '00d193dad9010104b210020a0e720100010402040e', 108],
    ['an Int-valued Coll[Int] argument, c(0)', 14, collArg(T.Int, collInt([1])), '00d193dad9010110b210020a0eb272010400000001100102040e', 143],
    ['an (Int, Int) argument, p._1', 13, pairArg(Tuple(int(1), int(1))), '00d193dad9010158b210020a0e8c7201010001860204020402040e', 138],
  ])('%s, the controls: true with no Upcast (the probe: %s block units)', (_name, block, tree, expected, jitCost) => {
    const r = run(probed(tree, 0x00, expected))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(jitCost)
    expect(blockCost(r.jitCost)).toBe(block)
  })
})

describe('a statically Byte or Short index is charged the Upcast whatever the value, as the JVM\'s inserted node is', () => {
  // SInt.upcast takes a Byte, a Short or an Int (SType.scala:465-470), and anything else is an error there.
  it.each([
    ['a Byte argument to (x: Byte) => Coll(5, 7)(x)', 11, scalarArg(T.Byte, byte(1)), 0x00, '00d193dad9010102b210020a0e720100010201040e', 118],
    ['an Int-valued Coll[Int] passed as a Coll[Byte], c(0)', 15, collArg(T.Byte, collInt([1])), 0x00, '00d193dad901010eb210020a0eb272010400000001100102040e', 153],
    ['an If typed Byte, that takes an Int', 8, sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, byte(1), int(1))), int(7))), 0x00, '00d193b210020a0e9501000201040200040e', 88],
    ['an If typed Short, that takes an Int', 8, sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, short(1), int(1))), int(7))), 0x00, '00d193b210020a0e9501000302040200040e', 88],
    ['an If typed Byte, that takes a Short', 8, sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, byte(1), short(1))), int(7))), 0x00, '00d193b210020a0e9501000201030200040e', 88],
    ['an If typed Short, that takes a Byte', 8, sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, short(1), byte(1))), int(7))), 0x00, '00d193b210020a0e9501000302020100040e', 88],
  ])('%s: true, 10 above the same read at Int (the probe: %s block units)', (_name, block, tree, header, expected, jitCost) => {
    const r = run(probed(tree, header, expected))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(jitCost)
    expect(blockCost(r.jitCost)).toBe(block)
  })

  it('an If typed Byte that takes a Long: rejects (the probe: RuntimeException, "Cannot upcast value 1 to the type SInt")', () => {
    const bytes = probed(sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, byte(1), long(1))), int(7))), 0x00, '00d193b210020a0e9501000201050200040e')
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-by-index-index-not-int')
  })

  it('an If typed Byte that takes an Int, at v3: true, no Upcast (the probe: 7 block units, an Int read)', () => {
    const r = run(probed(sp(EQ(ByIndex(collInt([5, 7]), If(FALSE, byte(1), int(1))), int(7))), 0x0b, '0b11d193b210020a0e9501000201040200040e'))
    expect(r).toEqual({ value: TRUE_PROP, jitCost: 78 })
    expect(blockCost(r.jitCost)).toBe(7)
  })
})

describe('an index typed by arithmetic is keyed on the type the builder leaves it', () => {
  // Before v3 the builder upcasts the narrower operand (SigmaBuilder.scala:674-683), so Plus(Byte, Byte) is a Byte and
  // Plus(Byte, Int) is an Int, whose operand's Upcast the arithmetic charges: the index adds no second one.
  it.each([
    ['Plus(Byte 1, Byte 0), statically Byte: the Upcast', sp(EQ(ByIndex(collInt([5, 7]), Plus(byte(1), byte(0))), int(7))), '00d193b210020a0e9a0201020000040e'],
    ['Plus(Byte 1, Int 0), statically Int: no second Upcast', sp(EQ(ByIndex(collInt([5, 7]), Plus(byte(1), int(0))), int(7))), '00d193b210020a0e9a0201040000040e'],
  ])('%s (the probe: 9 block units)', (_name, tree, expected) => {
    const r = run(probed(tree, 0x00, expected))
    expect(r.value).toEqual(TRUE_PROP)
    expect(r.jitCost).toBe(93)
    expect(blockCost(r.jitCost)).toBe(9)
  })
})

describe('an index typed as ergots\' own SAny, or one whose type cannot be read, keeps the value-kind rule', () => {
  // ergots' own SAny stands for a type the JVM knows and ergots' catalog does not (residual 1), so no probe can say what
  // the JVM's parse keyed on: the arm widens by the value's kind. An index whose type read throws is the same, since the
  // JVM reads no index type at run time (only its parse read one), so the throw must not reject. Both are ergots-only
  // expectations; each premise is asserted, so a case cannot rot into a typed one.
  const ownAny: SType = { tag: 'SAny' }
  const anyIndex = OptionGet(GetVar(1, ownAny))
  // Filter over an Int is a type read that throws. It sits in the branch the If never takes, so the index still evaluates.
  const unreadable = (taken: Expr): Expr => If(FALSE, Filter(int(1)), taken)
  const INT1: SValue = { kind: 'Int', value: 1 }
  const BYTE1: SValue = { kind: 'Byte', value: 1 }
  const SHORT1: SValue = { kind: 'Short', value: 1 }
  const LONG1: SValue = { kind: 'Long', value: 1n }
  const ELEMENT: SValue = { kind: 'Int', value: 7 }

  /** Coll[Int](5, 7)(<index>), with variable 1 holding `entry`, at `treeVersion`: the element and the cost. */
  function readAt(index: Expr, entry?: { tpe: SType; value: SValue }, treeVersion?: number): { value: SValue; jitCost: number } {
    const values = new Map<number, { tpe: SType; value: SValue }>(entry ? [[1, entry]] : [])
    const ctx = makeContext({ extension: { values }, treeVersion })
    const value = evalExpr(ByIndex(collInt([5, 7]), index), Env.empty(), ctx)
    return { value, jitCost: ctx.jitCost }
  }
  const own = (value: SValue, treeVersion?: number) => readAt(anyIndex, { tpe: ownAny, value }, treeVersion)

  it('the premises: one index is typed as ergots\' own SAny, the other\'s type read throws', () => {
    expect(isOwnSAny(exprTpe(anyIndex, 0))).toBe(true)
    expect(() => exprTpe(unreadable(int(1)), 0)).toThrow(ExprTpeError)
  })

  it('own SAny: an Int value is the element, a Byte or Short value is widened and charged the Upcast, 10 above the Int', () => {
    const base = own(INT1)
    expect(base.value).toEqual(ELEMENT)
    for (const value of [BYTE1, SHORT1]) {
      const r = own(value)
      expect(r.value).toEqual(ELEMENT)
      expect(r.jitCost - base.jitCost).toBe(10)
    }
  })

  it('own SAny: a Long value is rejected, and so is a Byte value from v3', () => {
    expect(captureEvalError(() => own(LONG1)).code).toBe('coll-by-index-index-not-int')
    expect(captureEvalError(() => own(BYTE1, 3)).code).toBe('coll-by-index-index-not-int')
  })

  it('an unreadable type: an Int value is the element, a Byte or Short value is widened and charged, 10 above the Int', () => {
    const base = readAt(unreadable(int(1)))
    expect(base.value).toEqual(ELEMENT)
    for (const taken of [byte(1), short(1)]) {
      const r = readAt(unreadable(taken))
      expect(r.value).toEqual(ELEMENT)
      expect(r.jitCost - base.jitCost).toBe(10)
    }
  })

  it('an unreadable type: a Long value is rejected, and so is a Byte value from v3', () => {
    expect(captureEvalError(() => readAt(unreadable(long(1)))).code).toBe('coll-by-index-index-not-int')
    expect(captureEvalError(() => readAt(unreadable(byte(1)), undefined, 3)).code).toBe('coll-by-index-index-not-int')
  })
})
