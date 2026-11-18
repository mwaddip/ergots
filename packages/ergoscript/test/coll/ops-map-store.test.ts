/**
 * Tests for `mapped` and `flatMapped` on the collection module: the rules of
 * `CollOverArray.map` (CollsOverArrays.scala:28-31 at 6.0.7),
 * `PairOfCols.map` (:317-324), `CollOverArray.flatMap` (:70-73), and
 * `PairOfCols.flatMap` (:410-411). The module decides the result's class
 * (always plain; pair routing on a pair range for an array-shape receiver)
 * and casts/stores each item through the range's array class.
 *
 * Store rule, per receiver shape and range type (from CollsOverArrays.scala
 * and SANTA `Coll.reference_store_ops`):
 *
 *   `CollOverArray.map` (array-shape receiver): `toArray.map(f)` builds the
 *   result through `ArrayBuilder.ofXXX.+=` (scala-library 2.12.20). A
 *   primitive builder unboxes the item (`CollClassCast`). An `ofUnit` builder
 *   takes a `Unit` parameter whose call site inserts an unbox cast — an item
 *   of another class fails the cast (`CollClassCast`; row #62). An `ofRef`
 *   builder stores the item through `elems(size) = elem` (aastore check; row
 *   #53 for `Box[]` holding a `GroupElement`, `CollArrayStore`).
 *
 *   `PairOfCols.map` (pairs-shape receiver): `new Array[V](limit); res(i) =
 *   f((ls(i), rs(i)))` — a direct aastore. A primitive V unboxes
 *   (`CollClassCast`). A `Unit` V is `BoxedUnit[]` on this path: aastore
 *   check (`CollArrayStore`; row #63). A reference V: aastore check
 *   (`CollArrayStore`; rows #52, #55).
 *
 *   `flatMap` (both shapes, :70-73 and :410-411): `builder.fromArray(
 *   toArray.flatMap(x => f(x).toArray))`. Array.flatMap builds through
 *   `ArrayBuilder[B].++=`. An EMPTY part of any class stores nothing (rows
 *   #37, #38). A `Unit` builder's `++=` counts items only (`ArrayBuilder.ofUnit`
 *   drops each; row #42). A primitive builder's `++=` falls to generic
 *   iteration + `+= each` which unbox-casts (ClassCastException on wrong
 *   class). A reference builder's `+=` is aastore (`CollArrayStore` on
 *   wrong class).
 *
 * The result's class: always a plain `CollOverArray` (`builder.fromArray` on
 * CollOverArray.map and flatMap goes through B as abstract, so no
 * specialisation; `PairOfCols.map` writes `new CollOverArray(res, builder)`
 * directly — always plain, no pair routing on pairs-receivers; pair routing
 * through `fromArray` applies on array-shape receivers with a pair range).
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { CollArrayStore, CollClassCast, flatMapped, mapped } from '../../src/coll'
import { fromArray } from '../../src/coll/build'
import { pairsColl, plainColl, synthesizeStubBox } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBOX: SType = { tag: 'SBox' }
const SGROUP: SType = { tag: 'SGroupElement' }
const SUNIT: SType = { tag: 'SUnit' }
const SANY: SType = { tag: 'SAny' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
const collOf = (a: SType): SType => ({ tag: 'SColl', elem: a })

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const unit = (): SValue => ({ kind: 'Unit' })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })
const groupElem = (): SValue => ({ kind: 'GroupElement', value: new Uint8Array(33) })
const makeBox = (): SValue => ({ kind: 'Box', value: synthesizeStubBox() })

describe('mapped — CollOverArray.map (CollsOverArrays.scala:28-31) and PairOfCols.map (:317-324) at 6.0.7', () => {
  it('array-shape receiver, primitive range: result is plain over the primitive array', () => {
    const recv = plainColl(SINT, [int(1), int(2)])
    const out = mapped(recv, SINT, [int(10), int(20)])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'int' })
    expect(out.items).toEqual([int(10), int(20)])
  })

  it('array-shape receiver + reference range: result is plain reference (pin for row #20: Coll[Long] into a Coll[Coll[Int]] result accepts — the range is a Coll, Array[Coll] takes any Coll)', () => {
    const recv = plainColl(SINT, [int(1)])
    const resultColl: SValue = {
      kind: 'Coll',
      elem: SLONG,
      items: [long(1n)],
      cls: { shape: 'array', specialised: false, array: 'long' },
    }
    const out = mapped(recv, collOf(SINT), [resultColl])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Coll' })
    expect(out.items).toEqual([resultColl])
  })

  it('array-shape receiver + Box range + GroupElement item: ArrayStoreException — row #53 (CollOverArray.map stores through an ArrayBuilder.ofRef[Box])', () => {
    const recv = plainColl(SINT, [int(1)])
    expect(() => mapped(recv, SBOX, [groupElem()])).toThrow(CollArrayStore)
  })

  it('array-shape receiver + Unit range + Int item: ClassCastException — row #62 (ArrayBuilder.ofUnit.+=(Unit) casts the call-site argument)', () => {
    const recv = plainColl(SINT, [int(1)])
    expect(() => mapped(recv, SUNIT, [int(1)])).toThrow(CollClassCast)
  })

  it('array-shape receiver + Unit range + Unit item: accepts', () => {
    const recv = plainColl(SINT, [int(1)])
    const out = mapped(recv, SUNIT, [unit()])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Unit' })
    expect(out.items).toEqual([unit()])
  })

  it('array-shape receiver + primitive range + mismatched-class item: ClassCastException (ArrayBuilder.ofByte.+= unboxes)', () => {
    const recv = plainColl(SINT, [int(1)])
    expect(() => mapped(recv, SBYTE, [int(1)])).toThrow(CollClassCast)
  })

  it('array-shape receiver + pair range: result is pairs with plain sides (fromArray pair routing through fromBoxedPairs)', () => {
    const recv = plainColl(SINT, [int(1)])
    const p = pair(byte(1), long(10n))
    const out = mapped(recv, pairOf(SBYTE, SLONG), [p])
    expect(out.cls).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'long' },
    })
  })

  it('pairs-shape receiver + pair range + any pair item: accepts — row #34 (PairOfCols.map writes into Array[Tuple2] which takes any pair)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    const lie = pair(int(1), makeBox())
    const out = mapped(recv, pairOf(SINT, SBOX), [lie])
    // :322 writes `new CollOverArray(res, builder)` directly — always plain,
    // no pair routing. The result is a plain Coll[Tuple2].
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Tuple2' })
    expect(out.items).toEqual([lie])
  })

  it('pairs-shape receiver + Box range + GroupElement item: ArrayStoreException — row #52 (new Array[Box] + aastore)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    expect(() => mapped(recv, SBOX, [groupElem()])).toThrow(CollArrayStore)
  })

  it('pairs-shape receiver + Unit range + Int item: ArrayStoreException — row #63 (new Array[Unit] = BoxedUnit[], direct aastore)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    expect(() => mapped(recv, SUNIT, [int(1)])).toThrow(CollArrayStore)
  })

  it('pairs-shape receiver + pair range + non-pair item: ArrayStoreException — row #55 (new Array[Tuple2] + aastore)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    expect(() => mapped(recv, pairOf(SINT, SBOX), [groupElem()])).toThrow(CollArrayStore)
  })

  it('pairs-shape receiver + reference range + matching item: plain reference collection (not pairs)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    const out = mapped(recv, SBOX, [makeBox()])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Box' })
  })

  it('array-shape receiver + Object range (SAny): accepts any item', () => {
    const recv = plainColl(SINT, [int(1)])
    const out = mapped(recv, SANY, [groupElem()])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Object' })
    expect(out.items).toEqual([groupElem()])
  })

  it('pairs-shape receiver + primitive range + matching item: accepts (new Array[Int] + aastore unboxes a matching Int)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    const out = mapped(recv, SINT, [int(42)])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'int' })
    expect(out.items).toEqual([int(42)])
  })

  it('pairs-shape receiver + primitive range + mismatched-class item: CollClassCast (new Array[Int] aastore unbox of Long fails; row-compatible with #63 primitive side)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    expect(() => mapped(recv, SINT, [long(1n)])).toThrow(CollClassCast)
  })

  it('EMPTY array-shape receiver: no item is checked against the range class; result carries the range\'s class and is empty (CollsOverArrays.scala:28-31 maps zero items, builder.fromArray on an empty Array[B])', () => {
    const recv = plainColl(SINT, [])
    const out = mapped(recv, SBOX, [])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Box' })
    expect(out.items).toEqual([])
  })

  it('EMPTY pairs-shape receiver: no item is checked; result is plain CollOverArray of the range\'s class (CollsOverArrays.scala:317-324 map of zero items)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    const out = mapped(recv, SBOX, [])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Box' })
    expect(out.items).toEqual([])
  })
})

describe('flatMapped — CollOverArray.flatMap (CollsOverArrays.scala:70-73) and PairOfCols.flatMap (:410-411) at 6.0.7', () => {
  it('Unit range + non-empty Int part + non-empty Unit part: accepts all, keeps units — row #42 (ArrayBuilder.ofUnit.++= counts items and fills with units)', () => {
    const recv = plainColl(SINT, [int(1)])
    const unitPart = plainColl(SUNIT, [unit()])
    const intPart = plainColl(SINT, [int(1)])
    const out = flatMapped(recv, SUNIT, [unitPart, intPart])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Unit' })
    expect(out.items).toEqual([unit(), unit()])
  })

  it('byte range + EMPTY long part: accepts; stores nothing — row #38 (`++=` on an empty part never iterates)', () => {
    const recv = plainColl(SINT, [int(1)])
    const emptyLongs = plainColl(SLONG, [])
    const out = flatMapped(recv, SBYTE, [emptyLongs])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'byte' })
    expect(out.items).toEqual([])
  })

  it('Box range + EMPTY GroupElement part: accepts; stores nothing — row #37', () => {
    const recv = plainColl(SINT, [int(1)])
    const emptyGE = plainColl(SGROUP, [])
    const out = flatMapped(recv, SBOX, [emptyGE])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Box' })
    expect(out.items).toEqual([])
  })

  it('Coll range + part of another Coll class: accepts (Array[Coll] takes any Coll — row #22)', () => {
    const recv = plainColl(SINT, [int(1)])
    const sub: SValue = {
      kind: 'Coll',
      elem: SLONG,
      items: [long(1n)],
      cls: { shape: 'array', specialised: false, array: 'long' },
    }
    const part: SValue = {
      kind: 'Coll',
      elem: collOf(SLONG),
      items: [sub],
      cls: { shape: 'array', specialised: false, array: 'Coll' },
    }
    const out = flatMapped(recv, collOf(SINT), [part])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Coll' })
    expect(out.items).toEqual([sub])
  })

  it('byte range + non-empty long part: ClassCastException on the first item (`ofByte.+= each` unboxes)', () => {
    const recv = plainColl(SINT, [int(1)])
    const longPart = plainColl(SLONG, [long(1n)])
    expect(() => flatMapped(recv, SBYTE, [longPart])).toThrow(CollClassCast)
  })

  it('Box range + non-empty GroupElement part: ArrayStoreException on the first item', () => {
    const recv = plainColl(SINT, [int(1)])
    const ge = plainColl(SGROUP, [groupElem()])
    expect(() => flatMapped(recv, SBOX, [ge])).toThrow(CollArrayStore)
  })

  it('pairs-shape receiver + Unit range + Int part: accepts — row #66 (PairOfCols.flatMap goes through the same builder ++=)', () => {
    const recv = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(1), int(1))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    const intPart = plainColl(SINT, [int(1)])
    const out = flatMapped(recv, SUNIT, [intPart])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Unit' })
    expect(out.items).toEqual([unit()])
  })

  it('pair range: pair routing through fromArray fromBoxedPairs — result is pairs with plain sides', () => {
    const recv = plainColl(SINT, [int(1)])
    const p = pair(byte(1), long(10n))
    const part = plainColl(pairOf(SBYTE, SLONG), [p])
    const out = flatMapped(recv, pairOf(SBYTE, SLONG), [part])
    expect(out.cls).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'long' },
    })
  })

  it('Object range accepts any part (SAny)', () => {
    const recv = plainColl(SINT, [int(1)])
    const part: SValue = {
      kind: 'Coll',
      elem: SANY,
      items: [int(1), groupElem()],
      cls: { shape: 'array', specialised: false, array: 'Object' },
    }
    const out = flatMapped(recv, SANY, [part])
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Object' })
    expect(out.items).toEqual([int(1), groupElem()])
  })
})

describe('fromArray on a pair elem routes to fromBoxedPairs and checks each component against its side\'s class (CollsOverArrays.scala:226-233 and :205-215)', () => {
  it('each component matching its side\'s class: result is pairs with plain sides', () => {
    const items: SValue[] = [pair(byte(1), long(10n)), pair(byte(2), long(20n))]
    const out = fromArray(pairOf(SBYTE, SLONG), items, false)
    expect(out.cls).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'long' },
    })
    expect(out.items).toEqual(items)
  })

  it('pair whose RIGHT component is of another class: CollArrayStore (SANTA Coll.reference_store_ops map-pair-component-lie-errored#33; the aastore into the right side\'s Array[Box] refuses a GroupElement)', () => {
    const items: SValue[] = [pair(int(1), groupElem())]
    expect(() => fromArray(pairOf(SINT, SBOX), items, false)).toThrow(CollArrayStore)
  })

  it('pair whose LEFT component is of another primitive class: CollClassCast (new Array[Byte] + aastore unbox of Int)', () => {
    const items: SValue[] = [pair(int(1), long(10n))]
    expect(() => fromArray(pairOf(SBYTE, SLONG), items, false)).toThrow(CollClassCast)
  })

  it('pair-rebuild via fromArray after a lying PairOfCols map: CollArrayStore (SANTA Coll.reference_store_ops pair-map-lie-reverse-errored#35: G2.reverse calls builder.fromArray at a pair elem, which hits the component check and refuses a GroupElement into Array[Box])', () => {
    // G2's class at the reverse-call site is a plain CollOverArray[Tuple2] of
    // elem (SInt, SBox); reverse goes through fromArray at that elem, which
    // routes the pair elem to fromBoxedPairs.
    const items: SValue[] = [pair(int(1), groupElem())]
    expect(() => fromArray(pairOf(SINT, SBOX), items, false)).toThrow(CollArrayStore)
  })

  it('a non-pair item at a pair elem: CollArrayStore (ergots\' fromArray guard; the JVM equivalent is the cast Array[Tuple2] aastore)', () => {
    const items: SValue[] = [int(1)]
    expect(() => fromArray(pairOf(SINT, SBOX), items, false)).toThrow(CollArrayStore)
  })
})
