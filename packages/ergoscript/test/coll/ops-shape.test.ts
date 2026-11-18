/**
 * Tests for the operations part of the coll module: the seven functions whose
 * result class depends on the receiver's class and on which JVM builder the
 * operation calls (slice, filtered, mapped, flatMapped, reversed, indices, zip).
 *
 * JVM references at 6.0.7:
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala
 *     CollOverArray         :11-157
 *     CollOverArrayBuilder :180-272
 *     PairOfCols           :274-486
 *   core/shared/src/main/scala/sigma/Colls.scala:349   pairCollFromArrays
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { classOf, type CollClass, type CollValue } from '../../src/coll'
import {
  filtered,
  flatMapped,
  indices,
  mapped,
  reversed,
  slice,
  zip,
} from '../../src/coll/ops'
import { pairsColl, plainColl, specColl } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })

const PLAIN_INT: CollClass = { shape: 'array', specialised: false, array: 'int' }
const PLAIN_BYTE: CollClass = { shape: 'array', specialised: false, array: 'byte' }
const SPEC_BYTE: CollClass = { shape: 'array', specialised: true, array: 'byte' }
const PLAIN_LONG: CollClass = { shape: 'array', specialised: false, array: 'long' }
const PLAIN_BIGINT: CollClass = { shape: 'array', specialised: false, array: 'BigInt' }
const PLAIN_TUPLE2: CollClass = { shape: 'array', specialised: false, array: 'Tuple2' }
const SPEC_INT: CollClass = { shape: 'array', specialised: true, array: 'int' }

describe('slice (CollOverArray :40, PairOfCols :377)', () => {
  it('keeps specialised on a specialised byte receiver (:40, fromArray[Byte])', () => {
    const c = specColl(SBYTE, [byte(1), byte(2), byte(3), byte(4)])
    const r = slice(c, 1, 3)
    expect(classOf(r)).toEqual(SPEC_BYTE)
    expect(r.elem).toEqual(SBYTE)
    expect(r.items).toEqual([byte(2), byte(3)])
  })

  it('stays plain on a plain int receiver (:40, fromArray[Int] at non-specialised call)', () => {
    const c = plainColl(SINT, [int(10), int(20), int(30)])
    const r = slice(c, 0, 2)
    expect(classOf(r)).toEqual(PLAIN_INT)
    expect(r.items).toEqual([int(10), int(20)])
  })

  it('on a pairs receiver slices each side via pairColl (:377 and :183-203)', () => {
    const items: SValue[] = [pair(byte(1), int(10)), pair(byte(2), int(20)), pair(byte(3), int(30))]
    const c = pairsColl(pairOf(SBYTE, SINT), items, SPEC_BYTE, PLAIN_INT)
    const r = slice(c, 1, 3)
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: SPEC_BYTE, rs: PLAIN_INT })
    expect(r.items).toEqual([pair(byte(2), int(20)), pair(byte(3), int(30))])
  })

  it('clamps negative `from` to 0 (Scala Array.slice)', () => {
    const c = plainColl(SINT, [int(1), int(2), int(3)])
    expect(slice(c, -5, 2).items).toEqual([int(1), int(2)])
  })

  it('clamps `until` past end to length (Scala Array.slice)', () => {
    const c = plainColl(SINT, [int(1), int(2), int(3)])
    expect(slice(c, 1, 100).items).toEqual([int(2), int(3)])
  })

  it('empty on `until <= from` (Scala Array.slice)', () => {
    const c = plainColl(SINT, [int(1), int(2), int(3)])
    expect(slice(c, 2, 2).items).toEqual([])
    expect(slice(c, 2, 1).items).toEqual([])
  })

  it('empty on a negative `until` (Scala Array.slice)', () => {
    const c = plainColl(SINT, [int(1), int(2), int(3)])
    expect(slice(c, 0, -1).items).toEqual([])
  })
})

describe('filtered (CollOverArray :36, PairOfCols :348-363)', () => {
  it('keeps specialised on a specialised byte receiver (:36, fromArray[Byte])', () => {
    const c = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    const r = filtered(c, [byte(1), byte(3)])
    expect(classOf(r)).toEqual(SPEC_BYTE)
    expect(r.elem).toEqual(SBYTE)
    expect(r.items).toEqual([byte(1), byte(3)])
  })

  it('stays plain on a plain int receiver (:36, non-specialised fromArray[Int])', () => {
    const c = plainColl(SINT, [int(1), int(2), int(3)])
    const r = filtered(c, [int(2)])
    expect(classOf(r)).toEqual(PLAIN_INT)
  })

  it('on a pairs receiver with a specialised left side gives plain sides (pairCollFromArrays, :363)', () => {
    const items: SValue[] = [pair(byte(1), int(10)), pair(byte(2), int(20))]
    const c = pairsColl(pairOf(SBYTE, SINT), items, SPEC_BYTE, PLAIN_INT)
    const r = filtered(c, [pair(byte(1), int(10))])
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: PLAIN_BYTE, rs: PLAIN_INT })
    expect(r.items).toEqual([pair(byte(1), int(10))])
    expect(r.elem).toEqual(pairOf(SBYTE, SINT))
  })

  it('on a pairs receiver with plain sides keeps plain (pairCollFromArrays, :363)', () => {
    const items: SValue[] = [pair(int(1), int(2))]
    const c = pairsColl(pairOf(SINT, SINT), items, PLAIN_INT, PLAIN_INT)
    const r = filtered(c, [pair(int(1), int(2))])
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: PLAIN_INT, rs: PLAIN_INT })
  })
})

describe('mapped (CollOverArray :28-31, PairOfCols :317-324)', () => {
  it('is plain on a specialised receiver (:28-31, fromArray[B] at abstract B)', () => {
    const c = specColl(SBYTE, [byte(1), byte(2)])
    const r = mapped(c, SINT, [int(10), int(20)])
    expect(classOf(r)).toEqual(PLAIN_INT)
    expect(r.elem).toEqual(SINT)
    expect(r.items).toEqual([int(10), int(20)])
  })

  it('is plain on a plain receiver (:28-31)', () => {
    const c = plainColl(SINT, [int(1)])
    const r = mapped(c, SLONG, [long(1n)])
    expect(classOf(r)).toEqual(PLAIN_LONG)
  })

  it('with a pair tRange on an array-shape receiver is pairs with plain sides (:28-31, fromArray pair routing)', () => {
    const c = plainColl(SINT, [int(1), int(2)])
    const r = mapped(c, pairOf(SINT, SBYTE), [pair(int(10), byte(1)), pair(int(20), byte(2))])
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: PLAIN_INT, rs: PLAIN_BYTE })
    expect(r.elem).toEqual(pairOf(SINT, SBYTE))
  })

  it('on a pairs receiver is a plain array of Tuple2 for a pair tRange (:317-324, new CollOverArray)', () => {
    const items: SValue[] = [pair(byte(1), int(10)), pair(byte(2), int(20))]
    const c = pairsColl(pairOf(SBYTE, SINT), items, PLAIN_BYTE, PLAIN_INT)
    const mappedItems: SValue[] = [pair(int(1), byte(10)), pair(int(2), byte(20))]
    const r = mapped(c, pairOf(SINT, SBYTE), mappedItems)
    expect(classOf(r)).toEqual(PLAIN_TUPLE2)
    expect(r.elem).toEqual(pairOf(SINT, SBYTE))
    expect(r.items).toEqual(mappedItems)
  })

  it('on a pairs receiver with a non-pair tRange is plain over the tRange class (:317-324)', () => {
    const items: SValue[] = [pair(byte(1), int(10))]
    const c = pairsColl(pairOf(SBYTE, SINT), items, SPEC_BYTE, PLAIN_INT)
    const r = mapped(c, SBIGINT, [{ kind: 'BigInt', value: 11n }])
    expect(classOf(r)).toEqual(PLAIN_BIGINT)
    expect(r.elem).toEqual(SBIGINT)
  })
})

describe('flatMapped (CollOverArray :70-73, PairOfCols :410-411)', () => {
  it('is plain on a specialised receiver (:70-73, fromArray[B] at abstract B)', () => {
    const c = specColl(SBYTE, [byte(1)])
    const r = flatMapped(c, SINT, [plainColl(SINT, [int(1), int(2)])])
    expect(classOf(r)).toEqual(PLAIN_INT)
    expect(r.elem).toEqual(SINT)
    expect(r.items).toEqual([int(1), int(2)])
  })

  it('on a pairs receiver is plain for the tRange (:410-411)', () => {
    const items: SValue[] = [pair(int(1), byte(2))]
    const c = pairsColl(pairOf(SINT, SBYTE), items, PLAIN_INT, PLAIN_BYTE)
    const r = flatMapped(c, SINT, [plainColl(SINT, [int(1), int(2)])])
    expect(classOf(r)).toEqual(PLAIN_INT)
  })

  it('with a pair tRange routes to pairs with plain sides (:70-73 and :410-411, fromArray pair routing)', () => {
    const c = plainColl(SINT, [int(1)])
    const r = flatMapped(c, pairOf(SINT, SBYTE), [plainColl(pairOf(SINT, SBYTE), [pair(int(10), byte(1))])])
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: PLAIN_INT, rs: PLAIN_BYTE })
  })
})

describe('reversed (CollOverArray :59-66, PairOfCols :384-394)', () => {
  it('keeps specialised on a specialised byte receiver (:59-66, fromArray[Byte] at :65)', () => {
    const c = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    const r = reversed(c)
    expect(classOf(r)).toEqual(SPEC_BYTE)
    expect(r.items).toEqual([byte(3), byte(2), byte(1)])
  })

  it('stays plain on a plain int receiver (:59-66)', () => {
    const c = plainColl(SINT, [int(1), int(2), int(3)])
    const r = reversed(c)
    expect(classOf(r)).toEqual(PLAIN_INT)
    expect(r.items).toEqual([int(3), int(2), int(1)])
  })

  it('on a plain Tuple2-array receiver becomes pairs with plain sides (:65, fromArray pair routing)', () => {
    const items: SValue[] = [pair(int(1), byte(10)), pair(int(2), byte(20))]
    // the result of PairOfCols.map with a pair tRange is `new CollOverArray` of Tuple2 — plain.
    const c: CollValue = {
      kind: 'Coll',
      elem: pairOf(SINT, SBYTE),
      items,
      cls: PLAIN_TUPLE2,
    }
    const r = reversed(c)
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: PLAIN_INT, rs: PLAIN_BYTE })
    expect(r.items).toEqual([pair(int(2), byte(20)), pair(int(1), byte(10))])
    expect(r.elem).toEqual(pairOf(SINT, SBYTE))
  })

  it('on a pairs receiver reverses each side and keeps each side class (:384-394)', () => {
    const items: SValue[] = [pair(byte(1), int(10)), pair(byte(2), int(20)), pair(byte(3), int(30))]
    const c = pairsColl(pairOf(SBYTE, SINT), items, SPEC_BYTE, PLAIN_INT)
    const r = reversed(c)
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: SPEC_BYTE, rs: PLAIN_INT })
    expect(r.items).toEqual([pair(byte(3), int(30)), pair(byte(2), int(20)), pair(byte(1), int(10))])
  })
})

describe('indices (CollOverArray :68, PairOfCols :408)', () => {
  it('is specialised Int on an array-shape specialised receiver (:68, fromArray[Int])', () => {
    const c = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    const r = indices(c)
    expect(classOf(r)).toEqual(SPEC_INT)
    expect(r.elem).toEqual(SINT)
    expect(r.items).toEqual([int(0), int(1), int(2)])
  })

  it('is specialised Int on an array-shape plain receiver (:68, fromArray[Int])', () => {
    const c = plainColl(SBIGINT, [
      { kind: 'BigInt', value: 1n },
      { kind: 'BigInt', value: 2n },
    ])
    const r = indices(c)
    expect(classOf(r)).toEqual(SPEC_INT)
    expect(r.items).toEqual([int(0), int(1)])
  })

  it('is specialised Int on a pairs receiver (:408, ls.indices / rs.indices)', () => {
    const items: SValue[] = [pair(byte(1), int(10)), pair(byte(2), int(20))]
    const c = pairsColl(pairOf(SBYTE, SINT), items, SPEC_BYTE, PLAIN_INT)
    const r = indices(c)
    expect(classOf(r)).toEqual(SPEC_INT)
    expect(r.items).toEqual([int(0), int(1)])
  })

  it('is empty on an empty receiver', () => {
    const c = plainColl(SINT, [])
    const r = indices(c)
    expect(classOf(r)).toEqual(SPEC_INT)
    expect(r.items).toEqual([])
  })
})

describe('zip (CollOverArray :42, PairOfCols :396, pairColl :183-203)', () => {
  it('equal lengths keeps each side class (:183, new PairOfCols)', () => {
    const ls = specColl(SBYTE, [byte(1), byte(2)])
    const rs = plainColl(SINT, [int(10), int(20)])
    const r = zip(ls, rs)
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: SPEC_BYTE, rs: PLAIN_INT })
    expect(r.items).toEqual([pair(byte(1), int(10)), pair(byte(2), int(20))])
    expect(r.elem).toEqual(pairOf(SBYTE, SINT))
  })

  it('left longer: left is sliced (:189, pairColl keeps each side)', () => {
    const ls = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    const rs = plainColl(SINT, [int(10), int(20)])
    const r = zip(ls, rs)
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: SPEC_BYTE, rs: PLAIN_INT })
    expect(r.items).toEqual([pair(byte(1), int(10)), pair(byte(2), int(20))])
  })

  it('right longer: right is sliced (:187, pairColl keeps each side)', () => {
    const ls = specColl(SBYTE, [byte(1), byte(2)])
    const rs = plainColl(SINT, [int(10), int(20), int(30)])
    const r = zip(ls, rs)
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: SPEC_BYTE, rs: PLAIN_INT })
    expect(r.items).toEqual([pair(byte(1), int(10)), pair(byte(2), int(20))])
  })

  it('on a pairs receiver nests into another PairOfCols (:396, pairColl(this, ys))', () => {
    const innerItems: SValue[] = [pair(byte(1), int(10)), pair(byte(2), int(20))]
    const innerCls: CollClass = { shape: 'pairs', ls: SPEC_BYTE, rs: PLAIN_INT }
    const innerElem = pairOf(SBYTE, SINT)
    const inner = pairsColl(innerElem, innerItems, SPEC_BYTE, PLAIN_INT)
    const rs = plainColl(SLONG, [long(100n), long(200n)])
    const r = zip(inner, rs)
    expect(classOf(r)).toEqual({ shape: 'pairs', ls: innerCls, rs: PLAIN_LONG })
    expect(r.elem).toEqual(pairOf(innerElem, SLONG))
    expect(r.items).toEqual([
      pair(pair(byte(1), int(10)), long(100n)),
      pair(pair(byte(2), int(20)), long(200n)),
    ])
  })
})

describe('pipelines: the class a receiver carries through a chain of operations', () => {
  it('a pair constant through mapped (same pair tRange) then reversed restores pairs with plain sides', () => {
    // dataClass of Coll[(Int, Byte)] gives pairs with plain sides.
    const items: SValue[] = [pair(int(1), byte(10)), pair(int(2), byte(20)), pair(int(3), byte(30))]
    const start = pairsColl(pairOf(SINT, SBYTE), items, PLAIN_INT, PLAIN_BYTE)

    // step 1: mapped on a pairs receiver with the same pair tRange — PairOfCols.map
    //         (:317-324) uses `new CollOverArray(res, builder)` directly: plain array
    //         of Tuple2, pair shape dropped.
    const step1 = mapped(start, pairOf(SINT, SBYTE), items)
    expect(classOf(step1)).toEqual(PLAIN_TUPLE2)
    expect(step1.elem).toEqual(pairOf(SINT, SBYTE))

    // step 2: reversed on a plain CollOverArray[(Int,Byte)] goes through
    //         `builder.fromArray` (:65) with a pair element type — fromArray routes
    //         pairs (fromBoxedPairs :205-215), giving pairs with plain sides.
    const step2 = reversed(step1)
    expect(classOf(step2)).toEqual({ shape: 'pairs', ls: PLAIN_INT, rs: PLAIN_BYTE })
    expect(step2.items).toEqual([
      pair(int(3), byte(30)),
      pair(int(2), byte(20)),
      pair(int(1), byte(10)),
    ])
    expect(step2.elem).toEqual(pairOf(SINT, SBYTE))
  })

  it('a pairs receiver with a specialised left side through filtered gives plain sides', () => {
    // A pairs value with a specialised byte left side is what `zip` of a
    // specialised byte collection with a plain int collection gives (above).
    const zipped = zip(specColl(SBYTE, [byte(1), byte(2), byte(3)]), plainColl(SINT, [int(10), int(20), int(30)]))
    expect(classOf(zipped)).toEqual({ shape: 'pairs', ls: SPEC_BYTE, rs: PLAIN_INT })

    // `filtered` on a pairs receiver is `pairCollFromArrays(resL, resR)` (:363),
    // which is `pairColl(fromArray(resL), fromArray(resR))` at abstract side
    // types — each side comes out plain, whatever the receiver's side class was.
    const kept = filtered(zipped, [pair(byte(1), int(10)), pair(byte(3), int(30))])
    expect(classOf(kept)).toEqual({ shape: 'pairs', ls: PLAIN_BYTE, rs: PLAIN_INT })
    expect(kept.items).toEqual([pair(byte(1), int(10)), pair(byte(3), int(30))])
  })
})
