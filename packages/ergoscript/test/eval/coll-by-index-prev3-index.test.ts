// The pre-v3 ByIndex index at eval (spec 2026-09-30 §8, review m5, and Task 6's review).
//
// Before tree v3 the JVM's parse upcasts the index to Int by its STATIC type (ByIndexSerializer.scala:29-33,
// `upcastTo(SInt)`, syntax.scala:168-177). An index statically Byte or Short sits under an inserted Upcast, evaluated and
// charged: NumericCastCostKind, 10 for an Int target (CostKind.scala:60-66). One statically Int has none, and
// `index.evalTo[Int]` (transformers.scala:258) fails on any other value. ergots inserts no node: the parse records the
// decision on the ByIndex, a substitution rebuild keeps it, and the arm charges the 10 itself (eval/coll-by-index.ts).
// From v3 the parse does not upcast (ByIndexSerializer.scala:29-30), so a Byte index fails, with
// 'coll-by-index-index-not-int'.
//
// Every verdict and cost below is a local sigma-state 6.0.6 probe's (spend mode, the tree as SELF, no register or
// variable). The probe prints the cost in block units, a JitCost total / 10 rounded down, so each expectation here
// gives ergots' JitCost and the probe's block cost it must round to:
//   sp(EQ(ByIndex(Coll[Int](5, 7), <index 1>), 7))             Byte 7, Short 7, Int 6    (a difference of one block unit)
//   the same 50 times, in a Coll[Boolean] under SizeOf         Byte 295, Short 295, Int 245
// The 50-fold trees are the exactness check: a widening charged at 9 or 11 would not differ by exactly 50 block units.
// Every tree is built through `probed`, which asserts its bytes against the ones the probe was given. The nodes built
// through the API, in the blocks on the recorded decision, have no bytes and no JVM verdict, and say so where they are.
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { childrenOf, substituteConstants, substituteDeserialize } from '../../src/eval/_substitute-deserialize'
import type { EvalContext } from '../../src/eval/eval-context'
import { ExprTpeError, exprTpe, recordIndexUpcast, recordedIndexUpcast } from '../../src/mir/expr-tpe'
import type { IndexUpcast } from '../../src/mir/expr-tpe'
import { isOwnSAny } from '../../src/mir/jvm-types'
import type { ByIndex as ByIndexNode, Expr, FuncValue, ParsedErgoTree, SType, SValue } from '../../src/mir/types'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { captureEvalError, parseParsedTree, synthesizeStubBox } from '../_helpers'
import {
  Apply,
  BI,
  ByIndex,
  Coll,
  Ctx,
  DC,
  DR,
  Downcast,
  EQ,
  Filter,
  GetVar,
  If,
  OptionGet,
  PC,
  Plus,
  SelectField,
  SizeOf,
  T,
  Tuple,
  ValUse,
  bool,
  bytes as collBytes,
  collInt,
  exprBytes,
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

/** A register or context variable: a typed value. */
type Entry = { tpe: SType; value: SValue }
/** A `Coll[Byte]` holding the bytes of the script `e`: what a DeserializeRegister or DeserializeContext decodes. */
const script = (e: Expr): Entry => ({
  tpe: T.Coll(T.Byte),
  value: { kind: 'Coll', elem: T.Byte, items: Array.from(exprBytes(e), (x) => ({ kind: 'Byte', value: (x << 24) >> 24 })) },
})

/** The context the probe's spend gives `bytes`: SELF holds it, R4 and variable 1 as given, the tree's own version. */
function spendContext(bytes: Uint8Array, tree: ParsedErgoTree, opts: { r4?: Entry; var1?: Entry }): EvalContext {
  return makeContext({
    treeVersion: tree.header.version,
    constants: tree.constants,
    selfBox: { ...synthesizeStubBox(), ergoTreeBytes: bytes, registers: opts.r4 ? { 4: opts.r4 } : {} },
    extension: { values: new Map(opts.var1 ? [[1, opts.var1]] : []) },
  })
}

/** The tree spent as the probe does, with R4 and variable 1 as given (none by default); the cost read back. */
function run(bytes: Uint8Array, opts: { r4?: Entry; var1?: Entry } = {}): { value: SValue; jitCost: number } {
  const tree = parseParsedTree(bytes)
  const ctx = spendContext(bytes, tree, opts)
  const value = evaluateWith(tree, ctx)
  return { value, jitCost: ctx.jitCost }
}

/** The first ByIndex under `e`, in the order `childrenOf` visits. */
function firstByIndex(e: Expr): ByIndexNode | undefined {
  if (e.tag === 'ByIndex') return e
  for (const child of childrenOf(e)) {
    const found = firstByIndex(child)
    if (found !== undefined) return found
  }
  return undefined
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


// ── The decision is made at parse and kept through a rebuild (Task 6, fix round 2; spec §8) ───────────────────────────
// The JVM's parse puts an actual Upcast node over a pre-v3 index that is not an Int (`upcastTo`, syntax.scala:168-177),
// and Kiama's `dup` keeps that node through a substitution rebuild (Rewriter.scala:236-320), rebuilding it with its
// constructor's check. ergots inserts no node. The parse records the same decision on the ByIndex (`recordIndexUpcast`,
// wire/mir/coll-by-index.ts), a rebuild copies it (`mapChildren`, eval/_substitute-deserialize.ts), and the arm evaluates
// from it, as `recordCallType` does for a call's type. The decision is 'upcast' for a statically Byte or Short index,
// 'int' for an Int one, and 'unknown' for ergots' own SAny (residual 1), which keeps the value-kind rule.

describe('an index typed as ergots\' own SAny keeps the value-kind rule', () => {
  // ergots' own SAny stands for a type the JVM knows and ergots' catalog does not (residual 1), so no probe can say what
  // the JVM's parse did: the arm widens by the value's kind. These are ergots-only expectations; the premise is asserted.
  const ownAny: SType = { tag: 'SAny' }
  const anyIndex = OptionGet(GetVar(1, ownAny))
  const INT1: SValue = { kind: 'Int', value: 1 }
  const BYTE1: SValue = { kind: 'Byte', value: 1 }
  const SHORT1: SValue = { kind: 'Short', value: 1 }
  const LONG1: SValue = { kind: 'Long', value: 1n }
  const ELEMENT: SValue = { kind: 'Int', value: 7 }

  /** Coll[Int](5, 7)(<index>), with variable 1 holding `entry`, at `treeVersion`: the element and the cost. */
  function readAt(index: Expr, entry: Entry, treeVersion?: number): { value: SValue; jitCost: number } {
    const ctx = makeContext({ extension: { values: new Map([[1, entry]]) }, treeVersion })
    const value = evalExpr(ByIndex(collInt([5, 7]), index), Env.empty(), ctx)
    return { value, jitCost: ctx.jitCost }
  }
  const own = (value: SValue, treeVersion?: number) => readAt(anyIndex, { tpe: ownAny, value }, treeVersion)

  it('the premise: the index is typed as ergots\' own SAny', () => {
    expect(isOwnSAny(exprTpe(anyIndex, 0))).toBe(true)
  })

  it('an Int value is the element, a Byte or Short value is widened and charged the Upcast, 10 above the Int', () => {
    const base = own(INT1)
    expect(base.value).toEqual(ELEMENT)
    for (const value of [BYTE1, SHORT1]) {
      const r = own(value)
      expect(r.value).toEqual(ELEMENT)
      expect(r.jitCost - base.jitCost).toBe(10)
    }
  })

  it('a Long value is rejected, and so is a Byte value from v3', () => {
    expect(captureEvalError(() => own(LONG1)).code).toBe('coll-by-index-index-not-int')
    expect(captureEvalError(() => own(BYTE1, 3)).code).toBe('coll-by-index-index-not-int')
  })
})

describe('the parse records the decision on the ByIndex', () => {
  // CONTEXT.preHeader.timestamp: ergots' catalog lacks 105:3, so the call types as its own SAny (the JVM: a Long, which
  // rejects at parse: residual 1, pinned in wire/in-arm-construction.test.ts with these bytes).
  const TS = PC(105, 3, PC(101, 3, Ctx))
  it.each([
    ['a Byte index', 'upcast', one(byte(1)), 0x00, '00d193b210020a0e020100040e'],
    ['a Short index', 'upcast', one(short(1)), 0x00, '00d193b210020a0e030200040e'],
    ['an Int index', 'int', one(int(1)), 0x00, '00d193b210020a0e040200040e'],
    ['a Byte index at v2', 'upcast', one(byte(1)), 0x0a, '0a0cd193b210020a0e020100040e'],
    [
      'an index typed as ergots\' own SAny',
      'unknown',
      sp(EQ(ByIndex(collInt([1, 2]), Plus(int(1), TS)), int(1))),
      0x00,
      '00d193b2100202049a0402db6903db6503fe000402',
    ],
  ])('%s: recorded as %s', (_name, decision, tree, header, expected) => {
    const parsed = parseParsedTree(probed(tree, header, expected))
    expect(recordedIndexUpcast(firstByIndex(parsed.body)!)).toBe(decision)
  })

  it('from v3 the JVM inserts no Upcast, so nothing is recorded', () => {
    const byteIndex = parseParsedTree(probed(one(byte(1)), 0x0b, '0b0cd193b210020a0e020100040e'))
    const intIndex = parseParsedTree(probed(one(int(1)), 0x0b, '0b0cd193b210020a0e040200040e'))
    expect(recordedIndexUpcast(firstByIndex(byteIndex.body)!)).toBeUndefined()
    expect(recordedIndexUpcast(firstByIndex(intIndex.body)!)).toBeUndefined()
  })
})

describe('a substitution rebuild copies the decision, as Kiama\'s dup keeps the inserted Upcast node', () => {
  // The index is the node the substitution replaces, so the rebuilt ByIndex is a new object around a new index; the JVM's
  // Upcast (declared Byte) or bare index (declared Int) is what the decision stands for.
  it.each([
    ['a DeserializeRegister default of the declared Byte', 'upcast', one(DR(4, T.Byte, byte(1))), '00d193b210020a0ed5040201020100040e', {}],
    ['a DeserializeRegister default of the declared Int', 'int', one(DR(4, T.Int, int(1))), '00d193b210020a0ed5040401040200040e', {}],
    ['a DeserializeRegister script of the declared Byte', 'upcast', one(DR(4, T.Byte)), '00d193b210020a0ed504020000040e', { r4: script(byte(1)) }],
    ['a DeserializeRegister script of the declared Int', 'int', one(DR(4, T.Int)), '00d193b210020a0ed504040000040e', { r4: script(int(1)) }],
    ['a DeserializeContext script of the declared Byte', 'upcast', one(DC(1, T.Byte)), '00d193b210020a0ed4020100040e', { var1: script(byte(1)) }],
    ['a DeserializeContext script of the declared Int', 'int', one(DC(1, T.Int)), '00d193b210020a0ed4040100040e', { var1: script(int(1)) }],
  ])('%s: the rebuilt ByIndex keeps %s', (_name, decision, tree, expected, opts) => {
    const bytes = probed(tree, 0x00, expected)
    const parsed = parseParsedTree(bytes)
    const before = firstByIndex(parsed.body)!
    const after = firstByIndex(substituteDeserialize(parsed.body, parsed, spendContext(bytes, parsed, opts), false))!
    expect(after).not.toBe(before)
    expect(recordedIndexUpcast(before)).toBe(decision)
    expect(recordedIndexUpcast(after)).toBe(decision)
  })

  it('the rewrite of the constants copies it too (ErgoTree.substConstants, ErgoTree.scala:314-322)', () => {
    // A segregated tree: the ByIndex's input is a placeholder, so substituteConstants rebuilds the node.
    const placeholder: Expr = { tag: 'ConstPlaceholder', id: 0, tpe: T.Coll(T.Int) }
    const bytes = serializeTree({
      header: { version: 0, hasSize: false, constantSegregation: true, rawHeader: 0x10 },
      constantTypes: [T.Coll(T.Int)],
      constants: [{ kind: 'Coll', elem: T.Int, items: [5, 7].map((n): SValue => ({ kind: 'Int', value: n })) }],
      body: sp(EQ(ByIndex(placeholder, byte(1)), int(7))),
    })
    const parsed = parseParsedTree(bytes)
    const before = firstByIndex(parsed.body)!
    const after = firstByIndex(substituteConstants(parsed.body, parsed.constants, parsed.constantTypes, 0))!
    expect(after).not.toBe(before)
    expect(recordedIndexUpcast(before)).toBe('upcast')
    expect(recordedIndexUpcast(after)).toBe('upcast')
  })
})

describe('the arm evaluates from the recorded decision; a node with none is decided from its index\'s type', () => {
  // Filter over an Int is a type read that throws. It sits in the branch the If never takes, so the index still
  // evaluates: its type is unreadable, its value is not. No parse can build it (the JVM: ClassCastException at parse, see
  // below), so these are nodes built through the API, which is what the record's absence means.
  const unreadable = (taken: Expr): Expr => If(FALSE, Filter(int(1)), taken)
  const ELEMENT: SValue = { kind: 'Int', value: 7 }
  const node = (index: Expr, decision?: IndexUpcast): ByIndexNode => {
    const n = ByIndex(collInt([5, 7]), index)
    if (decision !== undefined) recordIndexUpcast(n, decision)
    return n
  }
  const read = (n: ByIndexNode, treeVersion?: number): { value: SValue; jitCost: number } => {
    const ctx = makeContext({ treeVersion })
    const value = evalExpr(n, Env.empty(), ctx)
    return { value, jitCost: ctx.jitCost }
  }

  it('the premise: the unreadable index\'s type read throws', () => {
    expect(() => exprTpe(unreadable(int(1)), 0)).toThrow(ExprTpeError)
  })

  it.each([
    ['an Int constant', int(1)],
    ['an unreadable type holding an Int', unreadable(int(1))],
  ])('"upcast" over %s charges the Upcast: 10 above "int"', (_name, index) => {
    const upcast = read(node(index, 'upcast'))
    const plain = read(node(index, 'int'))
    expect(upcast.value).toEqual(ELEMENT)
    expect(plain.value).toEqual(ELEMENT)
    expect(upcast.jitCost - plain.jitCost).toBe(10)
  })

  it.each([
    ['a Byte constant', byte(1)],
    ['a Short constant', short(1)],
    ['an unreadable type holding a Byte', unreadable(byte(1))],
  ])('"upcast" takes %s, charged, and "int" rejects it, whatever the index\'s own type is', (_name, index) => {
    expect(read(node(index, 'upcast')).value).toEqual(ELEMENT)
    expect(captureEvalError(() => read(node(index, 'int'))).code).toBe('coll-by-index-index-not-int')
  })

  it('"upcast" rejects a Long value, as SInt.upcast errors on it', () => {
    expect(captureEvalError(() => read(node(long(1), 'upcast'))).code).toBe('coll-by-index-index-not-int')
  })

  it('"unknown" is the value-kind rule: an Int is taken, a Byte or Short is widened and charged', () => {
    const base = read(node(int(1), 'unknown'))
    expect(base.value).toEqual(ELEMENT)
    for (const index of [byte(1), short(1)]) {
      const r = read(node(index, 'unknown'))
      expect(r.value).toEqual(ELEMENT)
      // The constant's own cost is the same 5 as the Int's, so the Upcast is the whole difference.
      expect(r.jitCost - base.jitCost).toBe(10)
    }
  })

  it('a node with no record is decided from its index\'s type: a statically Byte constant is an Upcast, an Int one is not', () => {
    const byteIndex = read(node(byte(1)))
    const intIndex = read(node(int(1)))
    expect(byteIndex.jitCost - intIndex.jitCost).toBe(10)
  })

  it('a node with no record and an index whose type read throws propagates the ExprTpeError, nothing swallowed', () => {
    // No JVM path builds such a node, so there is no verdict to keep: the read's own error stands.
    expect(() => read(node(unreadable(int(1))))).toThrow(ExprTpeError)
  })

  it('from v3 the record is not read: an Int value only', () => {
    expect(captureEvalError(() => read(node(byte(1), 'upcast'), 3)).code).toBe('coll-by-index-index-not-int')
    const r = read(node(int(1), 'upcast'), 3)
    expect(r.jitCost - read(node(int(1), 'int'), 3).jitCost).toBe(0)
  })
})

describe('a substituted index, spent against the probe: the decision survives and its 10 is charged', () => {
  // The probe's costs include its deserialization charge, 2 per byte of the tree and the script (34 block units for each
  // pair here), so a pair is compared by its difference: one block unit there, the Upcast's 10 JitCost here.
  it.each([
    [
      'a DeserializeRegister script', '41 and 40',
      one(DR(4, T.Byte)), '00d193b210020a0ed504020000040e', { r4: script(byte(1)) },
      one(DR(4, T.Int)), '00d193b210020a0ed504040000040e', { r4: script(int(1)) },
    ],
    [
      'a DeserializeContext script', '39 and 38',
      one(DC(1, T.Byte)), '00d193b210020a0ed4020100040e', { var1: script(byte(1)) },
      one(DC(1, T.Int)), '00d193b210020a0ed4040100040e', { var1: script(int(1)) },
    ],
    [
      'a DeserializeRegister default', '41 and 40',
      one(DR(4, T.Byte, byte(1))), '00d193b210020a0ed5040201020100040e', {},
      one(DR(4, T.Int, int(1))), '00d193b210020a0ed5040401040200040e', {},
    ],
  ])('%s of the declared Byte against the declared Int: true, 10 apart (the probe: %s block units)', (
    _name, _probe, byteTree, byteHex, byteOpts, intTree, intHex, intOpts,
  ) => {
    const asByte = run(probed(byteTree, 0x00, byteHex), byteOpts)
    const asInt = run(probed(intTree, 0x00, intHex), intOpts)
    expect(asByte.value).toEqual(TRUE_PROP)
    expect(asInt.value).toEqual(TRUE_PROP)
    expect(asByte.jitCost).toBe(73)
    expect(asInt.jitCost).toBe(63)
  })
})

describe('a ByIndex inside a decoded script is decided by the script\'s own parse, at the spent tree\'s version', () => {
  // DeserializeRegister decodes R4 as ValueSerializer does, under the spent tree's version (Interpreter.scala:203-238), so
  // the script's ByIndex is parsed, recorded and charged as one in the tree itself would be. The probe's 41 and 40 differ
  // by its deserialization charge, which is the same in both.
  const tree = (header: number, expected: string) => probed(sp(EQ(DR(4, T.Int), int(7))), header, expected)
  const byIndexScript = (index: Expr, expected: string): Entry => {
    const e = ByIndex(collInt([5, 7]), index)
    expect(hex(exprBytes(e))).toBe(expected)
    return script(e)
  }

  it('v0: a Byte index in the script is charged the Upcast, 10 above an Int index (the probe: 41 and 40)', () => {
    const asByte = run(tree(0x00, '00d193d5040400040e'), { r4: byIndexScript(byte(1), 'b210020a0e020100') })
    const asInt = run(tree(0x00, '00d193d5040400040e'), { r4: byIndexScript(int(1), 'b210020a0e040200') })
    expect(asByte.value).toEqual(TRUE_PROP)
    expect(asInt.value).toEqual(TRUE_PROP)
    expect(asByte.jitCost - asInt.jitCost).toBe(10)
  })

  it('v3: a Byte index in the script is rejected, an Int index is not (the probe: ClassCastException, reduced)', () => {
    const v3 = tree(0x0b, '0b08d193d5040400040e')
    expect(captureEvalError(() => run(v3, { r4: byIndexScript(byte(1), 'b210020a0e020100') })).code).toBe('coll-by-index-index-not-int')
    expect(run(v3, { r4: byIndexScript(int(1), 'b210020a0e040200') })).toEqual({ value: TRUE_PROP, jitCost: 63 })
  })
})

describe('a class-cast default under a numeric index is never a number', () => {
  // A default whose type read throws has a Filter over a class-cast input on its type path, the one node that reads its
  // input's type only when it is asked for its own. Every node that reads a child's type when it is built, an If, a
  // ValDef, a ByIndex, fails the JVM's parse instead, so a default that parses evaluates to a Coll or a closure. The
  // inserted Upcast (declared Byte) is rebuilt around such a default by Kiama's dup, and reads its type there.
  it.each([
    ['a declared Byte, an Int value', If(FALSE, Filter(BI), int(1)), T.Byte, '00d193b210020a0ed5040201950100b5b2860204000400040000d90101040101040200040e'],
    ['a declared Int, a Byte value', If(FALSE, Filter(BI), byte(1)), T.Int, '00d193b210020a0ed5040401950100b5b2860204000400040000d90101040101020100040e'],
  ])('an If default, %s: cannot be parsed (the probe: ClassCastException at parse)', (_name, dflt, declared, expected) => {
    const bytes = probed(one(DR(4, declared, dflt)), 0x00, expected)
    let err: unknown
    try {
      parseTree(bytes)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExprTpeError)
    expect((err as ExprTpeError).code).toBe('filter-input-class-cast')
  })

  const closureOverFilter = (): Expr => Apply(lam(T.Int, Filter(BI)), [int(0)])
  it("a lambda over Filter as the default, a declared Byte: the rebuilt Upcast reads the default's type, a class cast (the probe: InvocationTargetException <- ClassCastException, Kiama's dup)", () => {
    // Until the final review's C1 (2026-09-30) ergots made no check there and rejected later, at eval, for its own
    // reason (coll-input-not-coll): the same verdict. It now rejects where the JVM does (spec §5, "The builder's Upcast at a
    // rebuild").
    const bytes = probed(one(DR(4, T.Byte, closureOverFilter())), 0x00, '00d193b210020a0ed5040201dad9010104b5b2860204000400040000d9010104010101040000040e')
    const err = captureEvalError(() => run(bytes))
    expect(err.code).toBe('deserialize-rebuild-failed')
    expect(err.cause).toMatchObject({ code: 'filter-input-class-cast' })
  })
  it('a lambda over Filter as the default, a declared Int: no Upcast; it parses, and is a Coll, so it rejects at eval (the probe: ClassCastException, a Tuple2 cast to a Coll)', () => {
    const bytes = probed(one(DR(4, T.Int, closureOverFilter())), 0x00, '00d193b210020a0ed5040401dad9010104b5b2860204000400040000d9010104010101040000040e')
    expect(captureEvalError(() => run(bytes)).code).toBe('coll-input-not-coll')
  })
})
