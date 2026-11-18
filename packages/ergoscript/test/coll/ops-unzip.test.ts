/**
 * The `unzip` fallback of a non-pair-shape operand of `append` / `patch` on
 * a pairs receiver. Mirrors the JVM's `CollOverArrayBuilder.unzip`
 * (`core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:245-259`)
 * at 6.0.7:
 *
 *   override def unzip[A, B](xs: Coll[(A, B)]): (Coll[A], Coll[B]) = xs match {
 *     case pa: PairColl[_,_] => (pa.ls, pa.rs)
 *     case _ =>
 *       val ls = Array.ofDim[A](limit)(tA.classTag)
 *       val rs = Array.ofDim[B](limit)(tB.classTag)
 *       cfor(0)(_ < limit, _ + 1) { i =>
 *         val p = xs(i); ls(i) = p._1; rs(i) = p._2
 *       }
 *       (fromArray(ls), fromArray(rs))
 *   }
 *
 * A component whose class is not the side's class fails the aastore: a
 * primitive side with `ClassCastException` (`CollClassCast`); a reference
 * side with `ArrayStoreException` (`CollArrayStore`).
 *
 * Grid: a plain `Tuple2[]` operand whose left or right component lies about
 * its class, for `append` and for `patch` on a pairs receiver whose side is
 * primitive or reference.
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { append, patch, filtered, slice } from '../../src/coll/ops'
import { CollArrayStore, CollClassCast } from '../../src/coll/class'
import { pairsColl, plainColl } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const bigInt = (n: bigint): SValue => ({ kind: 'BigInt', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })

describe('unzip fallback — primitive left side', () => {
  const pairsRecv = pairsColl(
    pairOf(SINT, SBYTE),
    [pair(int(1), byte(1))],
    { shape: 'array', specialised: false, array: 'int' },
    { shape: 'array', specialised: true, array: 'byte' },
  )

  it('append accepts a honest Tuple2[] operand', () => {
    const operand = plainColl(pairOf(SINT, SBYTE), [pair(int(2), byte(2))])
    const out = append(pairsRecv, operand)
    expect(out.items.length).toBe(2)
  })

  it('append refuses a left-lying component (long into int side) with CollClassCast', () => {
    const operand = plainColl(pairOf(SINT, SBYTE), [pair(long(99n), byte(2))])
    expect(() => append(pairsRecv, operand)).toThrow(CollClassCast)
  })

  it('patch refuses a right-lying component (int into byte side) with CollClassCast', () => {
    const operand = plainColl(pairOf(SINT, SBYTE), [pair(int(9), int(2))])
    expect(() => patch(pairsRecv, 0, operand, 0)).toThrow(CollClassCast)
  })
})

describe('unzip fallback — reference left side', () => {
  const pairsRecv = pairsColl(
    pairOf(SBIGINT, SBYTE),
    [pair(bigInt(1n), byte(1))],
    { shape: 'array', specialised: false, array: 'BigInt' },
    { shape: 'array', specialised: true, array: 'byte' },
  )

  it('append accepts an honest Tuple2[] operand', () => {
    const operand = plainColl(pairOf(SBIGINT, SBYTE), [pair(bigInt(2n), byte(2))])
    const out = append(pairsRecv, operand)
    expect(out.items.length).toBe(2)
  })

  it('append refuses a left-lying component (Long into BigInt side) with CollArrayStore', () => {
    const operand = plainColl(pairOf(SBIGINT, SBYTE), [pair(long(99n), byte(2))])
    expect(() => append(pairsRecv, operand)).toThrow(CollArrayStore)
  })

  it('patch refuses a right-lying component (Long into byte side) with CollClassCast', () => {
    const operand = plainColl(pairOf(SBIGINT, SBYTE), [pair(bigInt(9n), long(2n))])
    expect(() => patch(pairsRecv, 0, operand, 0)).toThrow(CollClassCast)
  })
})

describe('slice and filtered on a plain Tuple2[] receiver', () => {
  // A plain `CollOverArray[Tuple2]` receiver (the class of `Box.tokens`)
  // mirrors `CollOverArray.slice` / `.filter` (`CollsOverArrays.scala:40`,
  // `:36`): both route a pair elem through `builder.fromArray` into
  // `'pairs'` with plain sides.
  const tuple2Recv = plainColl(pairOf(SBYTE, SLONG), [
    pair(byte(1), long(10n)),
    pair(byte(2), long(20n)),
    pair(byte(3), long(30n)),
  ])

  it('slice on a plain Tuple2[] receiver returns pairs with plain sides', () => {
    const out = slice(tuple2Recv, 0, 2)
    expect(out.items.length).toBe(2)
    expect(out.cls?.shape).toBe('pairs')
  })

  it('filtered on a plain Tuple2[] receiver returns pairs with plain sides', () => {
    const kept = [tuple2Recv.items[0]!, tuple2Recv.items[2]!]
    const out = filtered(tuple2Recv, kept)
    expect(out.items.length).toBe(2)
    expect(out.cls?.shape).toBe('pairs')
  })
})
