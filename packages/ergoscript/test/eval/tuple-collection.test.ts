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
 * one a `Tuple` expression in a context variable reads as. The tests build
 * one through `tupleColl(items)` and bind it to context variable 1 under its
 * tuple type, read with `GetVar`.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, type EvalContext } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import { serializeCost } from '../../src/eval/serialize-cost'
import type { Expr, MethodCall, SType, SValue } from '../../src/mir/types'
import { captureEvalError, plainColl, specColl } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] }
const TRIPLE_III: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }
const COLL_INT: SType = { tag: 'SColl', elem: SINT }

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

/** A `tupleColl` of ints, as the data reader builds it. */
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

  it('EQ: a pair of two triples — the Tuple arm reads the item types and refuses first', () => {
    // `(getVar[(Int,Int,Int)](1).get, getVar[(Int,Int,Int)](1).get)` types as a PAIR of two triples.
    // EQ reads the root type of each operand only (SType.scala:174): a pair of two triples, which
    // passes `isValueOfType`. The two operands' runtime kind is Tuple of two items (Tuple.eval).
    // The equality is between two identical pair values; the Tuple arm's own checkType reads its item
    // types (STuple of 3), and that is where `unsupported-value-type` fires — before the outer EQ
    // sees the root pair. The test asserts the refusal.
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

describe('Global.serialize under a tuple-type argument', () => {
  // `Global.serialize_eval` passes `mc.args(0).tpe` (the argument's static type)
  // to the data writer (`data/shared/src/main/scala/sigma/ast/methods.scala:1982`).
  // ergots derives the type from the runtime value, with two exceptions: when the
  // static type is `SANY_JVM` the JVM's catch-all refuses it
  // (`core/shared/src/main/scala/sigma/serialization/CoreDataSerializer.scala:89-91`),
  // and when the static type holds a tuple of another arity than two at any depth
  // the writer walks it under the tuple type through `Evaluation.fromDslTuple`
  // (`core/shared/src/main/scala/sigma/Evaluation.scala:91-96`), with its length
  // assertion (`CoreDataSerializer.scala:74`).

  // Build a Global.serialize MethodCall over a literal arg expression.
  function serMc(argExpr: Expr): MethodCall {
    return {
      tag: 'MethodCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 3,
      args: [argExpr],
      explicitTypeArgs: {},
    }
  }

  /** `Global.serialize(getVar[T](1).get)` over a variable of static type `tpe`. */
  function serVar(tpe: SType): MethodCall {
    return serMc(getVarGet(tpe))
  }

  /** `Global.serialize(ByIndex(getVar[T](1).get, 0))` — ByIndex over a tuple types as SANY_JVM. */
  function serByIndex(tpe: SType, idx: number): MethodCall {
    return serMc(byIndexOfTupleVar(tpe, idx))
  }

  /** `Global.serialize(Slice(getVar[T](1).get, 0, 2))` — Slice typed with the input's tuple type. */
  function serSlice(tpe: SType, from: number, until: number): MethodCall {
    return serMc({
      tag: 'Slice',
      input: getVarGet(tpe),
      from: intConst(from),
      until: intConst(until),
    })
  }

  function collByte(bytes: number[]): SValue {
    const SBYTE: SType = { tag: 'SByte' }
    return specColl(SBYTE, bytes.map((b) => ({ kind: 'Byte', value: b })))
  }

  it('W1: a tupleColl([1,2,3]) read at (Int,Int,Int) writes 020406', () => {
    // `Global.serialize(getVar[(Int,Int,Int)](1).get)` where variable 1 holds
    // `tupleColl([1,2,3])` under the triple type. The static type of the arg
    // is `(Int,Int,Int)` — non-pair tuple at depth → `fromDslTuple` path.
    const r = run(serVar(TRIPLE_III), TRIPLE_III, intTupleColl([1, 2, 3]))
    expect(r).toEqual(collByte([0x02, 0x04, 0x06]))
  })

  it('a kind: Tuple of three items under a three-item tuple type refuses as global-serialize-failed', () => {
    // A `kind: 'Tuple'` value holds exactly two items by the contract
    // ([`facts/ergoscript-eval.md`](./ergoscript-eval.md), "Tuples and
    // non-pair tuple values"). `tupleItems` (the writer's call to
    // `Evaluation.fromDslTuple`, `Evaluation.scala:91-96`) matches a pair
    // only, as the JVM's pair case does; a `kind: 'Tuple'` of any other
    // arity is a value the writer refuses.
    const tup: SValue = {
      kind: 'Tuple',
      items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Int', value: 3 }],
    }
    const err = captureEvalError(() => run(serVar(TRIPLE_III), TRIPLE_III, tup))
    expect(err.code).toBe('global-serialize-failed')
  })

  it('a tupleColl([1,2,3]) read at (Int,Int,Int) writes 020406', () => {
    // The `Coll[Any]` of a non-pair tuple goes through `fromDslTuple`'s
    // collection branch at every arity; each item is written by the type's
    // item type at that index (`CoreDataSerializer.scala:71-81`).
    const r = run(serVar(TRIPLE_III), TRIPLE_III, intTupleColl([1, 2, 3]))
    expect(r).toEqual(collByte([0x02, 0x04, 0x06]))
  })

  it('R2: a ByIndex over a tuple (static type SANY_JVM) refuses as global-serialize-failed', () => {
    // `Global.serialize(ByIndex(getVar[(Int,Int,Int)](1).get, 0))`:
    // ByIndex's type is the input's elemType (SType.scala:838-841, STuple extends
    // SCollection[SAny]), which is the JVM's SAny. The writer's catch-all refuses
    // (CoreDataSerializer.scala:89-91).
    const expr = serByIndex(TRIPLE_III, 0)
    const err = captureEvalError(() => run(expr, TRIPLE_III, intTupleColl([1, 2, 3])))
    expect(err.code).toBe('global-serialize-failed')
  })

  it('R3: a Slice of a tuple at an arity mismatch refuses as global-serialize-failed', () => {
    // `Global.serialize(Slice(getVar[(Int,Int,Int)](1).get, 0, 2))`:
    // Slice's static type stays the input's (a 3-tuple) while its runtime value
    // holds 2 items, so the length assertion at CoreDataSerializer.scala:74 fails.
    const expr = serSlice(TRIPLE_III, 0, 2)
    const err = captureEvalError(() => run(expr, TRIPLE_III, intTupleColl([1, 2, 3])))
    expect(err.code).toBe('global-serialize-failed')
  })
})

describe('the three predicate Coll HOFs over a tuple-collection value', () => {
  // `Filter.eval`, `Exists.eval` and `ForAll.eval` (transformers.scala:118-127,
  // :143-152, :171-180) evaluate input and condition and iterate; they do NOT
  // compare the input's item type with the lambda's declared argument type.
  // The JVM hands each item to the lambda, whose own
  // `FuncValue.eval`-returned closure checks each argument's class against
  // `isValueOfType` at the declared type (`values.scala:1073-1074`,
  // `SType.scala:187-213` — the pair-shape check for a 2-item STuple, the
  // kind check for a scalar type). A tuple of another arity than two takes a
  // `Coll[Any]` value (`CoreDataSerializer.scala:139-144`); the item class
  // check per application is the one the JVM makes.

  /** `λ(x: Int) → body`: a unary lambda whose argument binds to valId 1. */
  function lambdaIntTo(body: Expr): Expr {
    return {
      tag: 'FuncValue',
      args: [{ id: 1, tpe: SINT }],
      body,
    }
  }
  /** `ValUse(1)` typed as Int (the lambda's argument). */
  const xInt: Expr = { tag: 'ValUse', valId: 1, tpe: SINT }
  /** `x > n`: Boolean-returning body of kind Gt. */
  function gt(n: number): Expr {
    return { tag: 'BinOp', op: { kind: 'Relation', op: 'Gt' }, left: xInt, right: intConst(n) }
  }
  /** `x == n`: Boolean-returning body of kind Eq. */
  function eqInt(n: number): Expr {
    return { tag: 'BinOp', op: { kind: 'Relation', op: 'Eq' }, left: xInt, right: intConst(n) }
  }

  function runWithCost(expr: Expr, varTpe: SType, varVal: SValue) {
    const ctx = makeContext({
      treeVersion: 3,
      extension: { values: new Map([[1, { tpe: varTpe, value: varVal }]]) },
    })
    const value = evalExpr(expr, Env.empty(), ctx)
    return { value, cost: ctx.jitCost }
  }

  it('Filter over tupleColl([1,2,3]) with λ(x: Int) → x > 1: SizeOf answers Int 2, cost equals the plain-Coll[Int] twin', () => {
    // SizeOf(Filter(getVar[(Int,Int,Int)](1).get, λ(x: Int) → x > 1)) at the
    // tuple reading: the tupleColl has `elem: SANY_JVM`; the JVM runs the
    // filter without the item-type check. Items [1,2,3] pass λ(x > 1) for
    // {2,3}, so the result is 2.
    const filterExpr = (varTpe: SType): Expr => ({
      tag: 'SizeOf',
      input: {
        tag: 'Filter',
        input: getVarGet(varTpe),
        condition: lambdaIntTo(gt(1)),
      },
    })
    const tupleRun = runWithCost(filterExpr(TRIPLE_III), TRIPLE_III, intTupleColl([1, 2, 3]))
    expect(tupleRun.value).toEqual({ kind: 'Int', value: 2 })
    const twin = runWithCost(
      filterExpr(COLL_INT),
      COLL_INT,
      plainColl(SINT, [1, 2, 3].map((v) => ({ kind: 'Int', value: v } as SValue))),
    )
    expect(twin.value).toEqual({ kind: 'Int', value: 2 })
    expect(tupleRun.cost).toBe(twin.cost)
  })

  it('Exists over tupleColl([1,2,3]) with λ(x: Int) → x == 1: answers Boolean true, cost equals the plain-Coll[Int] twin', () => {
    const existsExpr = (varTpe: SType): Expr => ({
      tag: 'Exists',
      input: getVarGet(varTpe),
      condition: lambdaIntTo(eqInt(1)),
    })
    const tupleRun = runWithCost(existsExpr(TRIPLE_III), TRIPLE_III, intTupleColl([1, 2, 3]))
    expect(tupleRun.value).toEqual({ kind: 'Boolean', value: true })
    const twin = runWithCost(
      existsExpr(COLL_INT),
      COLL_INT,
      plainColl(SINT, [1, 2, 3].map((v) => ({ kind: 'Int', value: v } as SValue))),
    )
    expect(twin.value).toEqual({ kind: 'Boolean', value: true })
    expect(tupleRun.cost).toBe(twin.cost)
  })

  it('ForAll over tupleColl([1,2,3]) with λ(x: Int) → x > 0: answers Boolean true, cost equals the plain-Coll[Int] twin', () => {
    const forAllExpr = (varTpe: SType): Expr => ({
      tag: 'ForAll',
      input: getVarGet(varTpe),
      condition: lambdaIntTo(gt(0)),
    })
    const tupleRun = runWithCost(forAllExpr(TRIPLE_III), TRIPLE_III, intTupleColl([1, 2, 3]))
    expect(tupleRun.value).toEqual({ kind: 'Boolean', value: true })
    const twin = runWithCost(
      forAllExpr(COLL_INT),
      COLL_INT,
      plainColl(SINT, [1, 2, 3].map((v) => ({ kind: 'Int', value: v } as SValue))),
    )
    expect(twin.value).toEqual({ kind: 'Boolean', value: true })
    expect(tupleRun.cost).toBe(twin.cost)
  })
})

describe('serializeCost under a tuple type follows fromDslTuple', () => {
  it('a tupleColl([1,2,3]) under (Int,Int,Int) walks each item under the type\'s item type', () => {
    // The cost walker takes the writer's path through `tupleItems` — the
    // collection branch of `fromDslTuple` at every non-pair arity — and
    // iterates the items under the type's item types. The cost is positive
    // and the walk does not throw.
    const ctx: EvalContext = makeContext({ treeVersion: 3 })
    serializeCost(TRIPLE_III, intTupleColl([1, 2, 3]), ctx)
    expect(ctx.jitCost).toBeGreaterThan(0)
  })

  it('a kind: Tuple of three items under a three-item tuple type is refused by the cost walker', () => {
    // `tupleItems` returns `null` on a `kind: 'Tuple'` of any other arity
    // than two, and the writer refuses the value with `'type-value-mismatch'`.
    // The cost walker takes the same path (`serializeCost.ts` STuple arm),
    // so it refuses too.
    const ctx: EvalContext = makeContext({ treeVersion: 3 })
    const tup: SValue = {
      kind: 'Tuple',
      items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Int', value: 3 }],
    }
    expect(() => serializeCost(TRIPLE_III, tup, ctx)).toThrow(/STuple cost walk expects/)
  })

  it('a tupleColl([1,2]) under a pair type (Int,Int) walks the items', () => {
    // A tuple collection whose `elem` is the JVM's `SAny` is accepted at any
    // tuple-type length, two included — the collection branch of
    // `fromDslTuple` (`Evaluation.scala:91-96`).
    const ctx: EvalContext = makeContext({ treeVersion: 3 })
    serializeCost(PAIR_II, intTupleColl([1, 2]), ctx)
    expect(ctx.jitCost).toBeGreaterThan(0)
  })
})
