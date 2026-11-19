/**
 * The JVM `Value.checkType` sites — the type check and the value's pair class.
 *
 * `Value.checkType` runs `SType.isValueOfType(value, node.tpe)` after a
 * child is evaluated (`values.scala:251-255`): `isValueOfType`
 * (`SType.scala:187-213`) throws for a static type of the JVM's `SAny` or
 * `NoType` (`:212`), a non-pair `STuple` (`:200-202`) or a non-unary `SFunc`
 * (`:203-205`) whatever the value is, and for a pair type it compares the
 * value's class (`:200-201`, `x.isInstanceOf[Tuple2[_,_]]`).
 *
 * The pair-class comparison bites on a `kind: 'Coll'` value of the JVM's
 * `Any` ("Tuples and non-pair tuple values" in `facts/ergoscript-eval.md`):
 * such a value is the one a tuple of another arity than two takes, and the
 * one a `Tuple` expression in a context variable reads as. Earlier tasks
 * built `tupleColl(items)` for the value; the data reader does not build it
 * yet, so the tests bind a hand-built `tupleColl(...)` to context variable 1
 * under its tuple type and read it with `GetVar`.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] }
const TRIPLE_III: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }

function intConst(v: number): Expr {
  return { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: v } }
}

/** `getVar[T](1).get` — reads variable 1 whose value is bound by the context. */
function getVarGet(tpe: SType): Expr {
  return {
    tag: 'OptionGet',
    input: { tag: 'GetVar', varId: 1, varTpe: tpe },
  }
}

/** `ByIndex(getVar[T](1).get, i)`: an indexed read of a tuple-typed variable. */
function byIndexOfTupleVar(tpe: SType, i: number): Expr {
  return {
    tag: 'ByIndex',
    input: getVarGet(tpe),
    index: intConst(i),
    default: null,
  }
}

/** `BinOp.Eq(left, right)`. */
function eq(left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Relation', op: 'Eq' }, left, right }
}

/** `BinOp.NEq(left, right)`. */
function neq(left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Relation', op: 'NEq' }, left, right }
}

/** A hand-built `tupleColl` of ints, as the data reader will build it. */
function intTupleColl(values: number[]): SValue {
  return tupleColl(values.map((v) => ({ kind: 'Int', value: v }) as SValue))
}

function run(expr: Expr, varTpe: SType, varVal: SValue, treeVersion = 3) {
  const ctx = makeContext({
    treeVersion,
    extension: { values: new Map([[1, { tpe: varTpe, value: varVal }]]) },
  })
  return evalExpr(expr, Env.empty(), ctx)
}

describe('the EQ / NEQ checkType sites', () => {
  it('EQ: an operand typed as the JVM SAny (ByIndex over a tuple) rejects as unsupported-value-type', () => {
    // `ByIndex(getVar[(Int,Int,Int)](1).get, 0)` types as SAny (sigma/ast/transformers.scala:254):
    // `ByIndex.tpe = input.tpe.elemType`, and an STuple's elemType is SAny (SType.scala:838-841).
    // EQ reads each operand's type after it is evaluated (trees.scala:1206-1208);
    // `isValueOfType` throws on SAny (SType.scala:212).
    const left = byIndexOfTupleVar(TRIPLE_III, 0)
    const right = byIndexOfTupleVar(TRIPLE_III, 0)
    const expr = eq(left, right)
    const err = captureEvalError(() => run(expr, TRIPLE_III, intTupleColl([1, 2, 3])))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('EQ: an operand typed as a non-pair STuple rejects as unsupported-value-type', () => {
    // `getVar[(Int,Int,Int)](1).get` types as STuple(3); EQ's type read throws
    // (SType.scala:200-202 "Unsupported tuple type").
    const expr = eq(getVarGet(TRIPLE_III), getVarGet(TRIPLE_III))
    const err = captureEvalError(() => run(expr, TRIPLE_III, intTupleColl([1, 2, 3])))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('EQ: a pair of two triples — the type check is the root pair, and it passes', () => {
    // `(getVar[(Int,Int,Int)](1).get, getVar[(Int,Int,Int)](1).get)` types as a PAIR of two triples.
    // EQ reads the root type of each operand only (SType.scala:174): a pair of two triples, which
    // passes `isValueOfType`. The two operands' runtime kind is Tuple of two items (Tuple.eval).
    // The equality is between two identical pair values; the Tuple arm's own checkType reads its item
    // types (STuple of 3), and that is where `unsupported-value-type` fires — before the outer EQ sees
    // the root pair. So this row is NOT green today; check both paths.
    const pair: Expr = {
      tag: 'Tuple',
      items: [getVarGet(TRIPLE_III), getVarGet(TRIPLE_III)],
    }
    const err = captureEvalError(() => run(eq(pair, pair), TRIPLE_III, intTupleColl([1, 2, 3])))
    expect(err.code).toBe('unsupported-value-type')
  })

  it('EQ: pair type with a non-pair value on the right — left passes, right check throws as checked-value-class', () => {
    // `(1, 2) == getVar[(Int,Int)](1).get`, where variable 1 holds a hand-built tupleColl([1, 2])
    // under the pair type. The left is a Tuple2 and passes; the right reads the value from the
    // variable, a kind: 'Coll', and fails the pair-class check (SType.scala:200-201).
    const left: Expr = { tag: 'Tuple', items: [intConst(1), intConst(2)] }
    const right = getVarGet(PAIR_II)
    const err = captureEvalError(() => run(eq(left, right), PAIR_II, intTupleColl([1, 2])))
    expect(err.code).toBe('checked-value-class')
  })

  it('EQ: pair type with a non-pair value on the left — the left check throws as checked-value-class', () => {
    // `getVar[(Int,Int)](1).get == (1, 2)`: left evaluated then checked, before the right is
    // evaluated (trees.scala:1206-1208). The left check throws; the right is never evaluated.
    const left = getVarGet(PAIR_II)
    const right: Expr = { tag: 'Tuple', items: [intConst(1), intConst(2)] }
    const err = captureEvalError(() => run(eq(left, right), PAIR_II, intTupleColl([1, 2])))
    expect(err.code).toBe('checked-value-class')
  })

  it('NEQ: pair type with a non-pair value on the left — the same refusal as EQ', () => {
    // NEQ runs the identical sequence (trees.scala:1224-1230): left evaluated, left checked, right
    // evaluated, right checked.
    const left = getVarGet(PAIR_II)
    const right: Expr = { tag: 'Tuple', items: [intConst(1), intConst(2)] }
    const err = captureEvalError(() => run(neq(left, right), PAIR_II, intTupleColl([1, 2])))
    expect(err.code).toBe('checked-value-class')
  })
})
