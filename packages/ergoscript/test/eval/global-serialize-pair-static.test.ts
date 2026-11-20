/**
 * `Global.serialize` writes by the argument's static type whenever that type
 * holds a tuple type at any depth, pairs included. The JVM's
 * `serialize_eval` passes `mc.args(0).tpe` to the data writer
 * (`methods.scala:1982`), and `fromDslTuple`'s pair case takes a `Coll[Any]`
 * whose `tItem == AnyType` (`Evaluation.scala:91-96`): a `Tuple` expression in
 * a register reads as `Coll[Any]` (`values.scala:818-822`; the register's
 * value is the `Coll[Any]` at every arity, two included, per the spec's
 * corrections point 1), and under a pair-typed read the value writes by its
 * static type.
 *
 * ergots falls back to the value-derived type only where the static type
 * holds ergots' own `SAny` (residual 1 of `facts/ergoscript-wire.md`); for
 * every other static type the writer is handed the static type. (Read from
 * `methods.scala:1982` and `Evaluation.scala:91-96`; the probe binds R4 as a
 * constant only, so the register-expression path is not measured — a SANTA
 * row is listed in the final-fix report.)
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import type { Expr, MethodCall, SType, SValue } from '../../src/mir/types'
import { specColl } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] }
const SBYTE: SType = { tag: 'SByte' }

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

function getVarGet(tpe: SType): Expr {
  return { tag: 'OptionGet', input: { tag: 'GetVar', varId: 1, varTpe: tpe } }
}

function collByte(bytes: number[]): SValue {
  return specColl(SBYTE, bytes.map((b) => ({ kind: 'Byte', value: b })))
}

function runAt(expr: Expr, varTpe: SType, varVal: SValue, treeVersion = 3) {
  const ctx = makeContext({
    treeVersion,
    extension: { values: new Map([[1, { tpe: varTpe, value: varVal }]]) },
  })
  const value = evalExpr(expr, Env.empty(), ctx)
  return { value, cost: ctx.jitCost }
}

describe('Global.serialize at a pair-typed argument whose runtime value is Coll[Any]', () => {
  // The pair constant Tuple(1, 2) typed as (Int, Int): a kind: 'Tuple' of two
  // Int items, which `fromDslTuple`'s pair case writes as `0x02 0x04`
  // (02 = zigzag 1, 04 = zigzag 2).
  it('a pair-typed getVar holding kind:Tuple(1, 2) writes 0204', () => {
    const pairValue: SValue = {
      kind: 'Tuple',
      items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }],
    }
    const { value } = runAt(serMc(getVarGet(PAIR_II)), PAIR_II, pairValue)
    expect(value).toEqual(collByte([0x02, 0x04]))
  })

  // A pair-typed getVar holding a `tupleColl([1, 2])`: a `kind: 'Coll'` with
  // `elem: SANY_JVM`, `items: [Int 1, Int 2]`. The static type is the pair;
  // the JVM writes it through `fromDslTuple`'s `Coll[Any]` branch
  // (`Evaluation.scala:91-96`), as `0x02 0x04`.
  it('a pair-typed getVar holding tupleColl([1, 2]) writes 0204', () => {
    const tupleCollValue: SValue = tupleColl([
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
    ])
    const { value } = runAt(serMc(getVarGet(PAIR_II)), PAIR_II, tupleCollValue)
    expect(value).toEqual(collByte([0x02, 0x04]))
  })

  // The cost is the same for both routes: both go through `fromDslTuple`'s
  // pair case under the same static type, so `serializeCost`'s walk charges
  // the same primitives.
  it('the cost walker charges the same on both routes (pair constant and tupleColl)', () => {
    const pairValue: SValue = {
      kind: 'Tuple',
      items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }],
    }
    const tupleCollValue: SValue = tupleColl([
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
    ])
    const a = runAt(serMc(getVarGet(PAIR_II)), PAIR_II, pairValue)
    const b = runAt(serMc(getVarGet(PAIR_II)), PAIR_II, tupleCollValue)
    expect(a.cost).toBe(b.cost)
  })
})
