/**
 * `ArithOp.impls` lookup covers every left-operand kind, including the UBI
 * branch. `ArithOp.eval` evaluates the left operand, then the right operand,
 * and `companion.eval` runs `impls(tpe.typeCode)` BEFORE `addCost`
 * (`trees.scala:722-728, :733-736`). `impls` has entries for the numeric
 * types only (`:861-869`), so a left operand typed as the JVM's `SAny` (97)
 * or `NoType` (0) refuses, whatever its runtime kind.
 *
 * ergots mirrors this in `eval/bin-op/arith.ts`'s `evalArithOp`:
 *   1. Eval left.
 *   2. Eval right.
 *   3. `assertArithImplForLeftType` on `e.left`'s static type.
 *   4. Dispatch on the left value's kind (UBI through `evalUBIArith`, others
 *      through the native-numeric path) and charge the cost.
 *
 * The three probe-measured trees from
 * `.superpowers/sdd/2026-11-19-collection-value-model-stage-2/final-review-probe/batch1.out`
 * lines 1-3 pin the behaviour on 6.0.7, and the unit grid pins each left-value
 * kind (Byte/Short/Int/Long/BigInt/UnsignedBigInt): refuses when the left's
 * static type is the JVM's `SAny`, answers when it is the kind itself.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, parseParsedTree } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const SBYTE: SType = { tag: 'SByte' }
const SSHORT: SType = { tag: 'SShort' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }
const SUBI: SType = { tag: 'SUnsignedBigInt' }

const plus = (l: Expr, r: Expr): Expr => ({ tag: 'BinOp', op: { kind: 'Arith', op: 'Plus' }, left: l, right: r })
const constOf = (tpe: SType, value: SValue): Expr => ({ tag: 'Const', tpe, value })

describe('ArithOp A1/A2/A3 (6.0.7 probe batch1.out lines 1-3)', () => {
  it("A1 sigmaProp(Apply(x:UBI => x==x, t(0)+t(1))), t:(UBI,UBI,UBI) refuses 'bin-op-not-numeric'", () => {
    // 0b29d1dad90101099372017201019ab248090909010101020103040000b248090909010101020103040200
    // `t(0) + t(1)` with t typed `(UBI,UBI,UBI)`: ByIndex over a non-pair
    // tuple types as the JVM's SAny; the impls lookup has no entry for 97.
    // The JVM rejects at reduce with `debox.KeyNotFoundException: key 97
    // was not found` (`ArithOp.impls` miss).
    const bytes = hexToBytes(
      '0b29d1dad90101099372017201019ab248090909010101020103040000b248090909010101020103040200',
    )
    const tree = parseParsedTree(bytes)
    const ctx = makeContext({ treeVersion: tree.header.version })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('bin-op-not-numeric')
  })

  it("A2 (control) sigmaProp(Apply(x:Int => x==x, t(0)+t(1))), t:(Int,Int,Int) refuses 'bin-op-not-numeric'", () => {
    // 0b23d1dad90101049372017201019ab248040404020406040000b248040404020406040200
    // The same shape with Int tuple and Int lambda: the ByIndex over a tuple
    // types as SAny, so the lookup still refuses.
    const bytes = hexToBytes(
      '0b23d1dad90101049372017201019ab248040404020406040000b248040404020406040200',
    )
    const tree = parseParsedTree(bytes)
    const ctx = makeContext({ treeVersion: tree.header.version })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('bin-op-not-numeric')
  })

  it('A3 (control) sigmaProp(Apply(x:UBI => x==x, 1u + 2u)) reduces to TrueProp at block cost 9', () => {
    // 0b13d1dad90101099372017201019a090101090102
    // Left is typed UBI (a Const of SUnsignedBigInt), so the lookup finds the
    // UBI entry; the arith runs and the Apply evaluates the body `x == x`.
    // The 6.0.7 probe reports cost=9 (block-cost units = floor(JIT/10)).
    const bytes = hexToBytes('0b13d1dad90101099372017201019a090101090102')
    const tree = parseParsedTree(bytes)
    const ctx = makeContext({ treeVersion: tree.header.version })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } })
    expect(Math.floor(ctx.jitCost / 10)).toBe(9)
  })
})

describe('arith lookup: a left value of each numeric kind, typed as the JVM SAny', () => {
  // A ByIndex over a `(K,K,K)` tuple types as the JVM's SAny
  // (`SType.scala:838-841`): the arith lookup refuses before the dispatch on
  // the value kind. The runtime value is the kind itself.
  type Case = {
    kind: SValue['kind']
    sType: SType
    make: (n: number) => SValue
  }
  const CASES: Case[] = [
    { kind: 'Byte',           sType: SBYTE,   make: (n) => ({ kind: 'Byte',           value: n }) },
    { kind: 'Short',          sType: SSHORT,  make: (n) => ({ kind: 'Short',          value: n }) },
    { kind: 'Int',            sType: SINT,    make: (n) => ({ kind: 'Int',            value: n }) },
    { kind: 'Long',           sType: SLONG,   make: (n) => ({ kind: 'Long',           value: BigInt(n) }) },
    { kind: 'BigInt',         sType: SBIGINT, make: (n) => ({ kind: 'BigInt',         value: BigInt(n) }) },
    { kind: 'UnsignedBigInt', sType: SUBI,    make: (n) => ({ kind: 'UnsignedBigInt', value: BigInt(n) }) },
  ]

  for (const c of CASES) {
    const TRIPLE: SType = { tag: 'STuple', items: [c.sType, c.sType, c.sType] }
    it(`${c.kind} left value from ByIndex(tuple:${c.kind},0) typed SAny refuses 'bin-op-not-numeric'`, () => {
      // getVar[TRIPLE](1).get, bound through extension var 1.
      const left: Expr = {
        tag: 'ByIndex',
        input: {
          tag: 'OptionGet',
          input: { tag: 'GetVar', varId: 1, varTpe: TRIPLE },
        },
        index: constOf(SINT, { kind: 'Int', value: 0 }),
        default: null,
      }
      const right = constOf(c.sType, c.make(2))
      const ctx = makeContext({
        treeVersion: 3,
        extension: { values: new Map([[1, { tpe: TRIPLE, value: tupleColl([c.make(1), c.make(2), c.make(3)]) }]]) },
      })
      const err = captureEvalError(() => evalExpr(plus(left, right), Env.empty(), ctx))
      expect(err).toBeInstanceOf(EvalError)
      expect(err.code).toBe('bin-op-not-numeric')
    })

    it(`${c.kind} left value from a Const typed ${c.kind} answers`, () => {
      // Const value typed as itself: the impls lookup finds its entry.
      const expr = plus(constOf(c.sType, c.make(1)), constOf(c.sType, c.make(2)))
      const ctx = makeContext({ treeVersion: 3 })
      const value = evalExpr(expr, Env.empty(), ctx)
      // For each kind, 1 + 2 = 3 (literally for primitive kinds; same BigInt
      // for the two bigint kinds).
      const expect3: SValue =
        c.kind === 'Byte' ? { kind: 'Byte', value: 3 } :
        c.kind === 'Short' ? { kind: 'Short', value: 3 } :
        c.kind === 'Int' ? { kind: 'Int', value: 3 } :
        c.kind === 'Long' ? { kind: 'Long', value: 3n } :
        c.kind === 'BigInt' ? { kind: 'BigInt', value: 3n } :
        { kind: 'UnsignedBigInt', value: 3n }
      expect(value).toEqual(expect3)
      // Cost is non-zero (the three Const nodes charge 1 each, and the arith
      // charges its own fixed cost on top; the exact figure is pinned by the
      // cost-conformance suite).
      expect(ctx.jitCost).toBeGreaterThan(0)
    })
  }
})
