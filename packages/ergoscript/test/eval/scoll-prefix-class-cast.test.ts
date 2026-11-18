/**
 * `SColl.startsWith` (12:31) and `SColl.endsWith` (12:32) through the
 * evaluator: the receiver's class decides whether the argument's array is
 * cast, so an argument of another class on a specialised receiver — or on a
 * pairs receiver's non-pair fallback — refuses with
 * `EvalError('coll-class-cast')`, the one code the facade (`_coll.ts`) raises
 * from the module's `CollClassCast`.
 *
 * JVM lines at 6.0.7:
 *   - `CollOverArray.startsWith` (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:44`)
 *   - `CollOverArray.endsWith`   (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:46`)
 *   - `PairOfCols.startsWith` / `endsWith` (`CollsOverArrays.scala:398-406`)
 *
 * This file pins the arms through method-call evaluation; the module grid is
 * in `test/coll/ops-prefix.test.ts`, the conformance rows in
 * `fixtures/conformance/v6/authored/Coll.specialisation_{prefix_suffix,pair_prefix}.json`.
 */

import { describe, it, expect } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Const, MethodCall as MethodCallExpr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, pairsColl, plainColl, specColl } from '../_helpers'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
const collOf = (a: SType): SType => ({ tag: 'SColl', elem: a })

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })
const bool = (v: boolean): SValue => ({ kind: 'Boolean', value: v })

const v3 = () => makeContext({ treeVersion: 3 })

function constExpr(value: SValue, tpe: SType): Const {
  return { tag: 'Const', tpe, value }
}

/**
 * A method call of `SColl` (typeId `12`) with one argument, both wrapped in
 * `Const`s under the receiver's `SColl[elem]` type. Mirrors the shape used in
 * `test/eval/scoll-v6.test.ts`.
 */
function methodCall(
  recv: SValue,
  recvElem: SType,
  methodId: number,
  arg: SValue,
  argElem: SType,
): MethodCallExpr {
  return {
    tag: 'MethodCall',
    obj: constExpr(recv, collOf(recvElem)),
    args: [constExpr(arg, collOf(argElem))],
    typeId: 12,
    methodId,
    explicitTypeArgs: {},
  }
}

// ---------------------------------------------------------------------------
// Specialised receiver: an argument of another primitive array casts and throws
// (CollOverArray.startsWith / endsWith, CollsOverArrays.scala:44, :46).
// ---------------------------------------------------------------------------

describe("SColl.startsWith (12:31) on a specialised receiver: EvalError('coll-class-cast')", () => {
  const specBytes = specColl(SBYTE, [byte(1), byte(2), byte(3)])

  it('specialised Coll[Byte] with a non-empty Coll[Long] argument (CollsOverArrays.scala:44) → coll-class-cast', () => {
    const call = methodCall(specBytes, SBYTE, 31, plainColl(SLONG, [long(1n)]), SLONG)
    const err = captureEvalError(() => evalMethodCall(call, Env.empty(), v3()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('specialised Coll[Byte] with a non-empty Coll[Int] argument (CollsOverArrays.scala:44) → coll-class-cast', () => {
    const call = methodCall(specBytes, SBYTE, 31, specColl(SINT, [int(1)]), SINT)
    const err = captureEvalError(() => evalMethodCall(call, Env.empty(), v3()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('specialised Coll[Byte] with an EMPTY Coll[Long] argument (CollsOverArrays.scala:44, cast precedes the length test) → coll-class-cast', () => {
    const call = methodCall(specBytes, SBYTE, 31, plainColl(SLONG, []), SLONG)
    const err = captureEvalError(() => evalMethodCall(call, Env.empty(), v3()))
    expect(err.code).toBe('coll-class-cast')
  })
})

describe("SColl.endsWith (12:32) on a specialised receiver: EvalError('coll-class-cast')", () => {
  const specBytes = specColl(SBYTE, [byte(1), byte(2), byte(3)])

  it('specialised Coll[Byte] with a non-empty Coll[Long] argument (CollsOverArrays.scala:46) → coll-class-cast', () => {
    const call = methodCall(specBytes, SBYTE, 32, plainColl(SLONG, [long(3n)]), SLONG)
    const err = captureEvalError(() => evalMethodCall(call, Env.empty(), v3()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('specialised Coll[Byte] with an EMPTY Coll[Int] argument (CollsOverArrays.scala:46) → coll-class-cast', () => {
    const call = methodCall(specBytes, SBYTE, 32, plainColl(SINT, []), SINT)
    const err = captureEvalError(() => evalMethodCall(call, Env.empty(), v3()))
    expect(err.code).toBe('coll-class-cast')
  })
})

// ---------------------------------------------------------------------------
// Pairs receiver: a non-pair argument's array is cast to Tuple2[], so a
// primitive argument throws (PairOfCols.startsWith / endsWith,
// CollsOverArrays.scala:398-406).
// ---------------------------------------------------------------------------

describe("SColl.{startsWith, endsWith} on a pairs receiver with a non-pair primitive argument: EvalError('coll-class-cast')", () => {
  const pairsRecv = pairsColl(
    pairOf(SINT, SINT),
    [pair(int(1), int(2)), pair(int(3), int(4))],
    { shape: 'array', specialised: false, array: 'int' },
    { shape: 'array', specialised: false, array: 'int' },
  )

  it('pair-constant receiver with an EMPTY Coll[Int] argument (CollsOverArrays.scala:398-401) → coll-class-cast', () => {
    const call = methodCall(pairsRecv, pairOf(SINT, SINT), 31, specColl(SINT, []), SINT)
    const err = captureEvalError(() => evalMethodCall(call, Env.empty(), v3()))
    expect(err.code).toBe('coll-class-cast')
  })

  it('pair-constant receiver with an EMPTY Coll[Int] argument on endsWith (CollsOverArrays.scala:403-406) → coll-class-cast', () => {
    const call = methodCall(pairsRecv, pairOf(SINT, SINT), 32, specColl(SINT, []), SINT)
    const err = captureEvalError(() => evalMethodCall(call, Env.empty(), v3()))
    expect(err.code).toBe('coll-class-cast')
  })
})

// ---------------------------------------------------------------------------
// Controls: a call that answers. The specialised receiver with a same-class
// argument returns the Boolean; a plain receiver with an empty argument over
// another array answers `true` (CollsOverArrays.scala:44, plain subclass has
// no `@specialized` cast). Each control pins one half of the family.
// ---------------------------------------------------------------------------

describe('SColl.{startsWith, endsWith} controls: the method answers when the class allows', () => {
  it('specialised Coll[Byte] with a same-class Coll[Byte] prefix (CollsOverArrays.scala:44) → Boolean', () => {
    const specBytes = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    const result = evalMethodCall(
      methodCall(specBytes, SBYTE, 31, specColl(SBYTE, [byte(1), byte(2)]), SBYTE),
      Env.empty(),
      v3(),
    )
    expect(result).toEqual(bool(true))
  })

  it('specialised Coll[Byte] with a same-class Coll[Byte] suffix (CollsOverArrays.scala:46) → Boolean', () => {
    const specBytes = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    const result = evalMethodCall(
      methodCall(specBytes, SBYTE, 32, specColl(SBYTE, [byte(3)]), SBYTE),
      Env.empty(),
      v3(),
    )
    expect(result).toEqual(bool(true))
  })

  it('plain Coll[Byte] (generic collection) with an EMPTY Coll[Long] argument (CollsOverArrays.scala:44, plain compares, no cast) → true', () => {
    const plainBytes = plainColl(SBYTE, [byte(1), byte(2), byte(3)])
    const result = evalMethodCall(
      methodCall(plainBytes, SBYTE, 31, plainColl(SLONG, []), SLONG),
      Env.empty(),
      v3(),
    )
    expect(result).toEqual(bool(true))
  })

  it('plain Coll[Byte] with an EMPTY Coll[Int] argument on endsWith (CollsOverArrays.scala:46, plain compares, no cast) → true', () => {
    const plainBytes = plainColl(SBYTE, [byte(1), byte(2), byte(3)])
    const result = evalMethodCall(
      methodCall(plainBytes, SBYTE, 32, plainColl(SINT, []), SINT),
      Env.empty(),
      v3(),
    )
    expect(result).toEqual(bool(true))
  })

  it('plain CollOverArray[Tuple2] (the class of a map over a pair collection) with an EMPTY Coll[Boolean] argument → true', () => {
    // A plain `CollOverArray` whose array is `Tuple2`, the shape of
    // `Box.tokens` and of a `map` over a pair collection
    // (CollsOverArrays.scala:317-324).
    const mappedPairs = plainColl(pairOf(SBYTE, SLONG), [
      pair(byte(1), long(10n)),
      pair(byte(2), long(20n)),
    ])
    const result = evalMethodCall(
      methodCall(mappedPairs, pairOf(SBYTE, SLONG), 31, plainColl(SBOOLEAN, []), SBOOLEAN),
      Env.empty(),
      v3(),
    )
    expect(result).toEqual(bool(true))
  })
})
