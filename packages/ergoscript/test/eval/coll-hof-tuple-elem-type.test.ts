/**
 * The element-type check of a lambda-applying Coll arm compares the input's
 * `elem` with the item type the data reader gives for the declared argument
 * type, `dataItemType(argTpe)`.
 *
 * `CoreDataSerializer.deserializeColl` (`:176-182`) gives a collection whose
 * declared element is `STuple(items.length !== 2)` the item descriptor
 * `collRType(sigma.AnyType)` (`:179-180`), so `data_reader.elem` is
 * `SColl(SAny)` for a `Coll[(A, B, C)]` — not the tuple type. A static
 * comparison against the declared argument type would reject every HOF over
 * such a data collection, including the empty one, which the JVM accepts
 * (the five HOF `eval`s make no pre-loop item-type check;
 * `transformers.scala:40-46, :118-127, :143-152, :171-180, :224-231`).
 *
 * Four measured trees over an empty `Coll[(Int, Int, Int)]` reduce to
 * `TrueProp` on sigma-state 6.0.7 at block costs 2, 4, 6, 6: ForAll, the
 * negation of Exists, SizeOf of Map, and SizeOf of Filter. The non-empty
 * twins reject at the lambda's own `Value.checkType` (`values.scala:1074`
 * → `SType.scala:200-202`, `sys.error("Unsupported tuple type")`); each
 * tree's hex sits beside its case.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { fromData, tupleColl } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, parseParsedTree } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const SBOOL: SType = { tag: 'SBoolean' }
const TRIPLE_III: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }
const COLL_TRIPLE: SType = { tag: 'SColl', elem: TRIPLE_III }

type B = { name: string; hex: string; cost: number }
const EMPTY_TREES: B[] = [
  { name: 'sigmaProp(ForAll(Coll[(I,I,I)](), (t:(I,I,I)) => true))',       hex: '0b11d1af0c4804040400d90101480404040101',   cost: 2 },
  { name: 'sigmaProp(!Exists(Coll[(I,I,I)](), (t:(I,I,I)) => true))',      hex: '0b12d1efae0c4804040400d90101480404040101', cost: 4 },
  { name: 'sigmaProp(SizeOf(Map(Coll[(I,I,I)](), (t:(I,I,I)) => 1)) == 0)',    hex: '0b15d193b1ad0c4804040400d901014804040404020400', cost: 6 },
  { name: 'sigmaProp(SizeOf(Filter(Coll[(I,I,I)](), (t:(I,I,I)) => true)) == 0)', hex: '0b15d193b1b50c4804040400d901014804040401010400', cost: 6 },
]

const NON_EMPTY: Array<{ name: string; hex: string }> = [
  { name: 'ForAll over a non-empty Coll[(I,I,I)]',  hex: '0b14d1af0c4804040401020406d90101480404040101' },
  { name: '!Exists over a non-empty Coll[(I,I,I)]', hex: '0b15d1efae0c4804040401020406d90101480404040101' },
  { name: 'SizeOf(Map(non-empty, _ => 1)) == 1',    hex: '0b18d193b1ad0c4804040401020406d901014804040404020402' },
  { name: 'SizeOf(Filter(non-empty, _ => true)) == 1', hex: '0b18d193b1b50c4804040401020406d901014804040401010402' },
]

describe('HOF arm on an empty data Coll of a non-pair tuple type reduces (sigma-state 6.0.7 to TrueProp)', () => {
  for (const b of EMPTY_TREES) {
    it(`${b.name} reduces to TrueProp at block cost ${b.cost}`, () => {
      const tree = parseParsedTree(hexToBytes(b.hex))
      const ctx = makeContext({ treeVersion: tree.header.version })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } })
      expect(Math.floor(ctx.jitCost / 10)).toBe(b.cost)
    })
  }
})

describe('HOF arm on a non-empty data Coll of a non-pair tuple type refuses at the lambda check (sigma-state 6.0.7 raises `Unsupported tuple type (SInt$,SInt$,SInt$)`)', () => {
  // The JVM's `FuncValue.eval` returns a closure that runs `Value.checkType
  // (arg0._2, vArg)` on each application (`values.scala:1073-1074`), and
  // `isValueOfType` throws `sys.error("Unsupported tuple type (...)")` for
  // a non-pair `STuple` declared arg (`SType.scala:200-202`); ergots refuses
  // through `assertCheckedValue`'s `assertCheckedType`.
  for (const c of NON_EMPTY) {
    it(`${c.name} refuses 'unsupported-value-type' at the per-application check`, () => {
      const tree = parseParsedTree(hexToBytes(c.hex))
      const ctx = makeContext({ treeVersion: tree.header.version })
      const err = captureEvalError(() => evaluateWith(tree, ctx))
      expect(err).toBeInstanceOf(EvalError)
      expect(err.code).toBe('unsupported-value-type')
    })
  }
})

describe('SColl.flatMap on an empty data Coll of a non-pair tuple type reduces (the fifth arm)', () => {
  it('SColl.flatMap(Coll[(I,I,I)](), t => Coll[Int](1)) answers an empty Coll[Int]', () => {
    // SColl.flatMap is `MethodCall(12, 15, coll, [lam])`. The lambda's
    // declared argument is `(Int,Int,Int)`; the data reader gives the
    // empty input `elem: SColl(SAny)`. The arm's own element check compares
    // `elem` with `dataItemType((I,I,I))` = `SColl(SAny)` and admits.
    const emptyColl: SValue = fromData(TRIPLE_III, [])
    const emptyInput: Expr = { tag: 'Const', tpe: COLL_TRIPLE, value: emptyColl }
    const bodyConst: SValue = {
      kind: 'Coll',
      elem: SINT,
      items: [{ kind: 'Int', value: 1 }],
      cls: { shape: 'array', specialised: true, array: 'int' },
    }
    const lamBody: Expr = { tag: 'Const', tpe: { tag: 'SColl', elem: SINT }, value: bodyConst }
    const lam: Expr = { tag: 'FuncValue', args: [{ id: 1, tpe: TRIPLE_III }], body: lamBody }
    const call: Expr = { tag: 'MethodCall', typeId: 12, methodId: 15, obj: emptyInput, args: [lam], explicitTypeArgs: {} }
    const ctx = makeContext({ treeVersion: 3 })
    const value = evalExpr(call, Env.empty(), ctx)
    expect(value.kind).toBe('Coll')
    if (value.kind === 'Coll') expect(value.items.length).toBe(0)
  })

  it('SColl.flatMap on a non-empty Coll[(I,I,I)] refuses at the per-application check', () => {
    const oneTriple: SValue = tupleColl([
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
      { kind: 'Int', value: 3 },
    ])
    const nonEmpty: SValue = fromData(TRIPLE_III, [oneTriple])
    const input: Expr = { tag: 'Const', tpe: COLL_TRIPLE, value: nonEmpty }
    const bodyConst: SValue = {
      kind: 'Coll',
      elem: SINT,
      items: [{ kind: 'Int', value: 1 }],
      cls: { shape: 'array', specialised: true, array: 'int' },
    }
    const lamBody: Expr = { tag: 'Const', tpe: { tag: 'SColl', elem: SINT }, value: bodyConst }
    const lam: Expr = { tag: 'FuncValue', args: [{ id: 1, tpe: TRIPLE_III }], body: lamBody }
    const call: Expr = { tag: 'MethodCall', typeId: 12, methodId: 15, obj: input, args: [lam], explicitTypeArgs: {} }
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() => evalExpr(call, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('unsupported-value-type')
  })
})

describe('positive controls: HOFs on an honest Coll[T] still check the element type', () => {
  // The element check, with the compare target changed to `dataItemType
  // (argTpe)`, keeps rejecting an honest Coll[Int] under a `(x: Long) =>` lambda,
  // which `dataItemType(SLong)` = `SLong`, mismatching the Coll's `SInt`.
  it('Filter(Coll[Int](1), (x: Long) => true) still refuses coll-elem-tpe-mismatch', () => {
    const colValue: SValue = {
      kind: 'Coll',
      elem: SINT,
      items: [{ kind: 'Int', value: 1 }],
      cls: { shape: 'array', specialised: true, array: 'int' },
    }
    const input: Expr = { tag: 'Const', tpe: { tag: 'SColl', elem: SINT }, value: colValue }
    const trueConst: Expr = { tag: 'Const', tpe: SBOOL, value: { kind: 'Boolean', value: true } }
    const lam: Expr = { tag: 'FuncValue', args: [{ id: 1, tpe: { tag: 'SLong' } }], body: trueConst }
    const expr: Expr = { tag: 'Filter', input, condition: lam }
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('coll-elem-tpe-mismatch')
  })
})
