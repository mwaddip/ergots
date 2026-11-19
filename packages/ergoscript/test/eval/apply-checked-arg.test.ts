/**
 * `FuncValue.eval` (`data/shared/src/main/scala/sigma/ast/values.scala:1074`) runs
 * `Value.checkType(arg0._2, vArg)` at every application of a unary lambda, before
 * `AddToEnvironmentDesc`'s fixed 5 is charged and before the body is evaluated. The
 * first argument is the declared `SType` of the lambda's single parameter
 * (`arg0._2`), which calls the second overload of `checkType` (`:257-260`); for a
 * declared non-pair `STuple`, non-unary `SFunc`, the JVM's `SAny` or `NoType`, or
 * a pair type applied to a `kind: 'Coll'` tuple value, it refuses. For a lambda
 * of other than one parameter the JVM errors first (`:1083`, "Function must have
 * 1 argument"), and ergots' arms reject that with `'apply-arity-mismatch'`.
 *
 * Every site that applies a closure calls `assertCheckedValue(closure.argTpes[i],
 * argValue)` at that point: `apply.ts`'s arg-bind loop, and each HOF arm after
 * its per-item arg bind (`coll-filter`, `coll-map`, `coll-exists`, `coll-forall`,
 * `coll-fold`, `scoll-flat-map`, `soption-map`).
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
const TRIPLE_III: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }

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

function runCtx(expr: Expr, treeVersion = 3) {
  return evalExpr(expr, Env.empty(), makeContext({ treeVersion }))
}

function lambda(argTpe: SType, body: Expr, argId = 0): Expr {
  return {
    tag: 'FuncValue',
    args: [{ id: argId, tpe: argTpe }],
    body,
  }
}

describe('FuncValue.eval arg-value check (values.scala:1074)', () => {
  it('Apply: a unary lambda with a triple arg type applied to a tupleColl of 3 rejects as unsupported-value-type', () => {
    // `((x: (Int,Int,Int)) => 42)(getVar[(Int,Int,Int)](1).get)` — the body never reads `x`,
    // so the only check that fires is the arg's declared triple type at the apply site.
    const func = lambda(TRIPLE_III, intC(42))
    const expr: Expr = { tag: 'Apply', func, args: [getVarGet(TRIPLE_III)] }
    const err = captureEvalError(() => runWithVar(expr, TRIPLE_III, intTupleColl([1, 2, 3])))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('Apply: a unary lambda with a pair arg type applied to a tupleColl of 2 rejects as checked-value-class', () => {
    const func = lambda(PAIR_II, intC(42))
    const expr: Expr = { tag: 'Apply', func, args: [getVarGet(PAIR_II)] }
    const err = captureEvalError(() => runWithVar(expr, PAIR_II, intTupleColl([1, 2])))
    expect(err.code).toBe('checked-value-class')
  })

  it('Apply control: a unary lambda with a well-typed arg answers', () => {
    const func = lambda(SINT, { tag: 'ValUse', valId: 0, tpe: SINT })
    const expr: Expr = { tag: 'Apply', func, args: [intC(7)] }
    const v = runCtx(expr)
    expect(v).toEqual({ kind: 'Int', value: 7 })
  })

  it('Filter: a lambda with a triple arg type applied to a plain coll of one triple rejects at arg check', () => {
    const items = [intTupleColl([1, 2, 3])]
    const input = plainColl(TRIPLE_III, items)
    const func = lambda(TRIPLE_III, boolC(true))
    const expr: Expr = {
      tag: 'Filter',
      input: getVarGet({ tag: 'SColl', elem: TRIPLE_III }),
      condition: func,
    }
    const err = captureEvalError(() =>
      runWithVar(expr, { tag: 'SColl', elem: TRIPLE_III }, input),
    )
    expect(err.code).toBe('unsupported-value-type')
  })

  it('Filter: a pair arg type with a tupleColl element rejects at arg check as checked-value-class', () => {
    const items = [intTupleColl([1, 2])]
    const input = plainColl(PAIR_II, items)
    const func = lambda(PAIR_II, boolC(true))
    const expr: Expr = {
      tag: 'Filter',
      input: getVarGet({ tag: 'SColl', elem: PAIR_II }),
      condition: func,
    }
    const err = captureEvalError(() =>
      runWithVar(expr, { tag: 'SColl', elem: PAIR_II }, input),
    )
    expect(err.code).toBe('checked-value-class')
  })

  it('Filter control: well-typed input and arg answers', () => {
    const items: SValue[] = [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }]
    const input = specColl(SINT, items)
    const func = lambda(
      SINT,
      {
        tag: 'BinOp',
        op: { kind: 'Relation', op: 'Eq' },
        left: { tag: 'ValUse', valId: 0, tpe: SINT },
        right: intC(1),
      },
    )
    const expr: Expr = {
      tag: 'Filter',
      input: getVarGet(COLL_INT),
      condition: func,
    }
    const v = runWithVar(expr, COLL_INT, input)
    expect(v.kind).toBe('Coll')
  })

  it('Map: a triple arg type applied to a plain coll of triples rejects at arg check', () => {
    const items = [intTupleColl([1, 2, 3])]
    const input = plainColl(TRIPLE_III, items)
    const func = lambda(TRIPLE_III, intC(0))
    const expr: Expr = {
      tag: 'Map',
      input: getVarGet({ tag: 'SColl', elem: TRIPLE_III }),
      mapper: func,
    }
    const err = captureEvalError(() =>
      runWithVar(expr, { tag: 'SColl', elem: TRIPLE_III }, input),
    )
    expect(err.code).toBe('unsupported-value-type')
  })

  it('Exists: a triple arg type applied to a plain coll of triples rejects at arg check', () => {
    const items = [intTupleColl([1, 2, 3])]
    const input = plainColl(TRIPLE_III, items)
    const func = lambda(TRIPLE_III, boolC(true))
    const expr: Expr = {
      tag: 'Exists',
      input: getVarGet({ tag: 'SColl', elem: TRIPLE_III }),
      condition: func,
    }
    const err = captureEvalError(() =>
      runWithVar(expr, { tag: 'SColl', elem: TRIPLE_III }, input),
    )
    expect(err.code).toBe('unsupported-value-type')
  })

  it('ForAll: a triple arg type applied to a plain coll of triples rejects at arg check', () => {
    const items = [intTupleColl([1, 2, 3])]
    const input = plainColl(TRIPLE_III, items)
    const func = lambda(TRIPLE_III, boolC(true))
    const expr: Expr = {
      tag: 'ForAll',
      input: getVarGet({ tag: 'SColl', elem: TRIPLE_III }),
      condition: func,
    }
    const err = captureEvalError(() =>
      runWithVar(expr, { tag: 'SColl', elem: TRIPLE_III }, input),
    )
    expect(err.code).toBe('unsupported-value-type')
  })

  it('Fold: a lambda whose declared arg type is a triple STuple rejects at arg check', () => {
    // Fold's arg is a pair `(acc, elem)`; the JVM checks `arg0._2` against this pair type.
    // A mis-declared lambda (arg typed as the triple) rejects at the apply, as the type is a
    // non-pair STuple.
    const items: SValue[] = [{ kind: 'Int', value: 1 }]
    const input = specColl(SINT, items)
    const func = lambda(TRIPLE_III, intC(0))
    const expr: Expr = {
      tag: 'Fold',
      input: getVarGet(COLL_INT),
      zero: intC(0),
      foldOp: func,
    }
    const err = captureEvalError(() => runWithVar(expr, COLL_INT, input))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('SColl.flatMap: a triple arg type at the per-element apply rejects', () => {
    const items = [intTupleColl([1, 2, 3])]
    const input = plainColl(TRIPLE_III, items)
    const func = lambda(TRIPLE_III, {
      tag: 'Collection',
      kind: 'Exprs',
      elemTpe: SINT,
      items: [],
    })
    const expr: Expr = {
      tag: 'MethodCall',
      typeId: 12,
      methodId: 15,
      obj: getVarGet({ tag: 'SColl', elem: TRIPLE_III }),
      args: [func],
      explicitTypeArgs: {},
    }
    const err = captureEvalError(() =>
      runWithVar(expr, { tag: 'SColl', elem: TRIPLE_III }, input),
    )
    expect(err.code).toBe('unsupported-value-type')
  })

  it('SOption.map: a triple arg type on a Some payload rejects at arg check', () => {
    // `getVar[(Int,Int,Int)](1)` is `Some(tupleColl([1,2,3]))`; `.map(x => 0)` with a triple
    // arg type reads the arg's type at `:1074` and rejects.
    const func = lambda(TRIPLE_III, intC(0))
    const expr: Expr = {
      tag: 'MethodCall',
      typeId: 36,
      methodId: 7,
      obj: { tag: 'GetVar', varId: 1, varTpe: TRIPLE_III },
      args: [func],
      explicitTypeArgs: {},
    }
    const err = captureEvalError(() =>
      runWithVar(expr, TRIPLE_III, intTupleColl([1, 2, 3])),
    )
    expect(err.code).toBe('unsupported-value-type')
  })
})

describe('FuncValue.eval arg-value check — laziness', () => {
  it('Filter over an empty Coll never applies the lambda, so the per-element arg check never fires', () => {
    // An empty Coll of the triple type: the per-element check at `:1074` never runs. The arm
    // answers with the empty filtered collection.
    const empty = plainColl(TRIPLE_III, [])
    const func = lambda(TRIPLE_III, boolC(true))
    const expr: Expr = {
      tag: 'Filter',
      input: getVarGet({ tag: 'SColl', elem: TRIPLE_III }),
      condition: func,
    }
    const v = runWithVar(expr, { tag: 'SColl', elem: TRIPLE_III }, empty)
    expect(v.kind).toBe('Coll')
  })
})
