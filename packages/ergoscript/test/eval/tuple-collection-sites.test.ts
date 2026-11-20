/**
 * The `checkType` sites per arm.
 *
 * Each arm whose JVM counterpart runs `Value.checkType(node, value)` (`values.scala:
 * 251-255`) gets one pinning test here, each on a hand-built `tupleColl` value
 * surfaced through a context variable: removing the arm's `assertCheckedNode` call
 * leaves the test red. The arms: `If` taken branch (`trees.scala:1360, 1364`),
 * `Fold`'s zero (`transformers.scala:227`), `ByIndex`'s default (`:268, :273`),
 * `OptionGetOrElse`'s default (`:634, :640`), `Apply`'s body (`values.scala:1080`),
 * and each HOF arm's body check at the same line.
 *
 * The EQ-at-the-root test pins `isValueOfType`'s root-only property (`SType.scala:
 * 174`): two context variables each read a pair whose first component is a Coll
 * of 3; the EQ's root check passes and the equality answers at the root type.
 *
 * The pair-class check's laziness is pinned by a dead-branch `If` whose unevaluated
 * branch would otherwise refuse.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, plainColl, specColl } from '../_helpers'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SINT: SType = { tag: 'SInt' }
const COLL_INT: SType = { tag: 'SColl', elem: SINT }
const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] }

function intC(v: number): Expr {
  return { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: v } }
}
function boolC(b: boolean): Expr {
  return { tag: 'Const', tpe: SBOOLEAN, value: { kind: 'Boolean', value: b } }
}

function getVarGet(tpe: SType): Expr {
  return { tag: 'OptionGet', input: { tag: 'GetVar', varId: 1, varTpe: tpe } }
}

function intTupleColl(values: number[]): SValue {
  return tupleColl(values.map((v) => ({ kind: 'Int', value: v }) as SValue))
}

function runWithVar(expr: Expr, varTpe: SType, varVal: SValue, treeVersion = 3) {
  const ctx = makeContext({
    treeVersion,
    extension: { values: new Map([[1, { tpe: varTpe, value: varVal }]]) },
  })
  return evalExpr(expr, Env.empty(), ctx)
}

describe('If.eval (trees.scala:1360, 1364) — the taken branch', () => {
  it('If: a taken branch whose operand reads a tupleColl at a pair type rejects as checked-value-class', () => {
    const taken = getVarGet(PAIR_II)
    const other: Expr = { tag: 'Tuple', items: [intC(0), intC(0)] }
    const expr: Expr = { tag: 'If', condition: boolC(true), trueBranch: taken, falseBranch: other }
    const err = captureEvalError(() => runWithVar(expr, PAIR_II, intTupleColl([1, 2])))
    expect(err.code).toBe('checked-value-class')
  })

  it('If: a dead branch that would refuse is skipped — the pair-class check does not fire on it', () => {
    // If(false, getVar[(Int,Int)](1).get, 42). The true branch would refuse; it is not taken.
    const taken: Expr = intC(42)
    const dead = getVarGet(PAIR_II)
    const expr: Expr = { tag: 'If', condition: boolC(false), trueBranch: dead, falseBranch: taken }
    const v = runWithVar(expr, PAIR_II, intTupleColl([1, 2]))
    expect(v).toEqual({ kind: 'Int', value: 42 })
  })
})

describe('Fold.eval (transformers.scala:227) — the zero', () => {
  it("Fold: a zero reading a tupleColl at a pair type rejects as checked-value-class", () => {
    // Fold(Coll[Int](), getVar[(Int,Int)](2).get, (acc, x) => acc._1): the zero's check fires
    // after the zero is evaluated, before the fold-op is evaluated. Variable 1 holds the empty
    // collection (the fold's input), variable 2 the pair-typed tupleColl (the zero).
    const items: SValue[] = []
    const input = plainColl(SINT, items)
    const argId = 1
    const func: Expr = {
      tag: 'FuncValue',
      args: [{ id: argId, tpe: { tag: 'STuple', items: [PAIR_II, SINT] } }],
      body: {
        tag: 'SelectField',
        input: { tag: 'ValUse', valId: argId, tpe: { tag: 'STuple', items: [PAIR_II, SINT] } },
        fieldIndex: 1,
      },
    }
    const zero: Expr = {
      tag: 'OptionGet',
      input: { tag: 'GetVar', varId: 2, varTpe: PAIR_II },
    }
    const expr: Expr = {
      tag: 'Fold',
      input: getVarGet(COLL_INT),
      zero,
      foldOp: func,
    }
    const ctx = makeContext({
      treeVersion: 3,
      extension: {
        values: new Map<number, { tpe: SType; value: SValue }>([
          [1, { tpe: COLL_INT, value: input }],
          [2, { tpe: PAIR_II, value: intTupleColl([1, 2]) }],
        ]),
      },
    })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('checked-value-class')
  })
})

describe('ByIndex.eval default (transformers.scala:268, 273)', () => {
  it('v3 ByIndex default taken (OOB): a pair-typed default with a tupleColl value rejects', () => {
    // ByIndex(Coll[(Int,Int)](), 0, getVar[(Int,Int)](1).get) — out of range, so the default is
    // evaluated and checked (`transformers.scala:268`).
    const emptyInput: Expr = {
      tag: 'Collection',
      kind: 'Exprs',
      elemTpe: PAIR_II,
      items: [],
    }
    const def = getVarGet(PAIR_II)
    const expr: Expr = { tag: 'ByIndex', input: emptyInput, index: intC(0), default: def }
    const err = captureEvalError(() => runWithVar(expr, PAIR_II, intTupleColl([1, 2]), 3))
    expect(err.code).toBe('checked-value-class')
  })

  it('pre-v3 ByIndex default eager (always): the default is evaluated and checked even in range', () => {
    // ByIndex(Coll[(Int,Int)]((1,2)), 0, getVar[(Int,Int)](1).get). Below v3 the default is
    // always evaluated (`transformers.scala:273`).
    const pair: Expr = { tag: 'Tuple', items: [intC(1), intC(2)] }
    const input: Expr = {
      tag: 'Collection',
      kind: 'Exprs',
      elemTpe: PAIR_II,
      items: [pair],
    }
    const def = getVarGet(PAIR_II)
    const expr: Expr = { tag: 'ByIndex', input, index: intC(0), default: def }
    const err = captureEvalError(() => runWithVar(expr, PAIR_II, intTupleColl([1, 2]), 2))
    expect(err.code).toBe('checked-value-class')
  })
})

describe('OptionGetOrElse.eval default (transformers.scala:634, 640)', () => {
  it('v3 lazy: default taken (None input) with a pair-typed tupleColl rejects as checked-value-class', () => {
    const def = getVarGet(PAIR_II)
    const expr: Expr = {
      tag: 'OptionGetOrElse',
      input: { tag: 'GetVar', varId: 2, varTpe: PAIR_II },
      default: def,
    }
    const ctx = makeContext({
      treeVersion: 3,
      extension: {
        values: new Map<number, { tpe: SType; value: SValue }>([
          [1, { tpe: PAIR_II, value: intTupleColl([1, 2]) }],
        ]),
      },
    })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('checked-value-class')
  })

  it('pre-v3 eager: default always evaluated and checked, even when input is Some', () => {
    const someInput: Expr = { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SOption', elem: PAIR_II } }
    const def = getVarGet(PAIR_II)
    const expr: Expr = {
      tag: 'OptionGetOrElse',
      input: someInput,
      default: def,
    }
    const ctx = makeContext({
      treeVersion: 2,
      constants: [{
        kind: 'Option',
        elem: PAIR_II,
        value: { kind: 'Tuple', items: [{ kind: 'Int', value: 7 }, { kind: 'Int', value: 8 }] },
      }],
      extension: {
        values: new Map<number, { tpe: SType; value: SValue }>([
          [1, { tpe: PAIR_II, value: intTupleColl([1, 2]) }],
        ]),
      },
    })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('checked-value-class')
  })
})

describe("Apply's body check (values.scala:1080)", () => {
  it("Apply: a body that returns a tupleColl at a pair type rejects as checked-value-class", () => {
    // `((x: Int) => getVar[(Int,Int)](1).get)(1)` — the body reads a pair-typed variable
    // bound to a tupleColl, and the body's checkType fires at the apply site.
    const func: Expr = {
      tag: 'FuncValue',
      args: [{ id: 0, tpe: SINT }],
      body: getVarGet(PAIR_II),
    }
    const expr: Expr = { tag: 'Apply', func, args: [intC(1)] }
    const err = captureEvalError(() => runWithVar(expr, PAIR_II, intTupleColl([1, 2])))
    expect(err.code).toBe('checked-value-class')
  })
})

describe('each HOF body check (values.scala:1080 at the per-element apply)', () => {
  it("Map body: a mapper whose body is a pair-typed read of a tupleColl rejects at body", () => {
    // Map(Coll[Int](1), (x: Int) => getVar[(Int,Int)](1).get). The body's declared type is the
    // pair; the body check at `:1080` fires per element.
    const items: SValue[] = [{ kind: 'Int', value: 1 }]
    const input = specColl(SINT, items)
    const mapperBody = getVarGet(PAIR_II)
    const mapper: Expr = {
      tag: 'FuncValue',
      args: [{ id: 0, tpe: SINT }],
      body: mapperBody,
    }
    const expr: Expr = {
      tag: 'Map',
      input: { tag: 'ConstPlaceholder', id: 0, tpe: COLL_INT },
      mapper,
    }
    const ctx = makeContext({
      treeVersion: 3,
      constants: [input],
      extension: {
        values: new Map<number, { tpe: SType; value: SValue }>([
          [1, { tpe: PAIR_II, value: intTupleColl([1, 2]) }],
        ]),
      },
    })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('checked-value-class')
  })

  it("Fold body: a lambda whose body reads a pair-typed var that is a tupleColl rejects at body", () => {
    // Fold(Coll[Int](1), 0, (acc_x) => getVar[(Int,Int)](1).get). The body's declared type is
    // the pair; the body check at `:1080` fires per iteration.
    const items: SValue[] = [{ kind: 'Int', value: 1 }]
    const input = specColl(SINT, items)
    const argId = 1
    const argTpe: SType = { tag: 'STuple', items: [SINT, SINT] }
    const func: Expr = {
      tag: 'FuncValue',
      args: [{ id: argId, tpe: argTpe }],
      body: getVarGet(PAIR_II),
    }
    const expr: Expr = {
      tag: 'Fold',
      input: { tag: 'ConstPlaceholder', id: 0, tpe: COLL_INT },
      zero: intC(0),
      foldOp: func,
    }
    const ctx = makeContext({
      treeVersion: 3,
      constants: [input],
      extension: {
        values: new Map<number, { tpe: SType; value: SValue }>([
          [1, { tpe: PAIR_II, value: intTupleColl([1, 2]) }],
        ]),
      },
    })
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('checked-value-class')
  })
})

describe('EQ root-only check (SType.scala:174)', () => {
  it('EQ over two pair-typed context vars, each a Tuple2 whose first component is a Coll of 3, answers true', () => {
    // The operand's static type is `((Coll[Int], Int), (Coll[Int], Int))` and value is a
    // genuine `kind: 'Tuple'` pair; the root check passes and the comparer walks the
    // components by their declared types. The inner Coll's items (three Ints) are compared
    // by the Coll arm, and the result is true. The row's cost belongs to the operand tree;
    // this test pins the verdict, not the cost (SANTA's constant-form row
    // `Tuple.non_pair_value_producers eq_two_pairs_holding_tuples-accept#9` carries that
    // cost).
    const innerTupleColl = intTupleColl([1, 2, 3])
    const pairWithInnerColl: SValue = {
      kind: 'Tuple',
      items: [innerTupleColl, { kind: 'Int', value: 9 }],
    }
    const outerPairType: SType = {
      tag: 'STuple',
      items: [COLL_INT, SINT],
    }
    const expr: Expr = {
      tag: 'BinOp',
      op: { kind: 'Relation', op: 'Eq' },
      left: getVarGet(outerPairType),
      right: getVarGet(outerPairType),
    }
    const v = runWithVar(expr, outerPairType, pairWithInnerColl)
    expect(v).toEqual({ kind: 'Boolean', value: true })
  })
})
