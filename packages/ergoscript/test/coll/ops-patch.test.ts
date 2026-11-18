/**
 * Tests for `patch` on the collection module: the rule of the JVM's
 * `CollOverArray.patch` (`CollsOverArrays.scala:94-98` at 6.0.7) and of
 * `PairOfCols.patch` (`:423-428`), which calls `builder.unzip(patch)` (`:245-259`).
 *
 * Grid: receiver class x patch class x `from` / `replaced` boundary.
 *   - A specialised receiver casts the patch's array to its own primitive array
 *     BEFORE any store, so a patch over another array throws `CollClassCast`
 *     — empty included, and when nothing is replaced. A patch over the same
 *     primitive array passes the cast, whether the patch object is specialised
 *     or plain; a `'pairs'` patch's `toArray` is `Array[Tuple2]`, a reference
 *     array, so it fails the cast too.
 *   - A plain array-shape receiver stores each PATCH item into the result
 *     array of the receiver's class tag. A primitive array fails the store on
 *     an item of another class (unbox); a reference array of `'Object'` takes
 *     anything; `'Coll'` takes any collection; another reference class takes
 *     only its own. An EMPTY patch stores nothing, so an empty patch of
 *     another class is answered on a plain receiver (the row that separates
 *     the plain rule from the specialised one).
 *   - A `'pairs'` receiver unzips the patch and patches each side: a `'pairs'`
 *     patch gives up its sides as they are; a plain `CollOverArray[Tuple2]`
 *     patch has its items read as pairs into two plain-side collections. A
 *     side that casts throws through the recursion.
 *   - The result's class is the receiver's: `fromArray(elem, items,
 *     cls.specialised)` from inside the receiver — a plain collection over
 *     `Tuple2[]` comes back as `'pairs'` with plain sides (the `fromBoxedPairs`
 *     route of `builder.fromArray`, `CollsOverArrays.scala:205-215`).
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { CollArrayStore, CollClassCast } from '../../src/coll'
import { patch } from '../../src/coll/ops'
import { pairsColl, plainColl, specColl } from '../_helpers'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }
const SBOX: SType = { tag: 'SBox' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
const collOf = (a: SType): SType => ({ tag: 'SColl', elem: a })

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const bool = (b: boolean): SValue => ({ kind: 'Boolean', value: b })
const bigInt = (n: bigint): SValue => ({ kind: 'BigInt', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })

describe('patch — specialised receiver (CollsOverArrays.scala:94-98)', () => {
  const bytes = specColl(SBYTE, [byte(1), byte(2), byte(3)])

  it('takes a patch of the receiver\'s own primitive class (empty, non-empty)', () => {
    const empty = specColl(SBYTE, [])
    expect(patch(bytes, 0, empty, 0)).toEqual(specColl(SBYTE, [byte(1), byte(2), byte(3)]))
    const one = specColl(SBYTE, [byte(9)])
    expect(patch(bytes, 1, one, 0)).toEqual(specColl(SBYTE, [byte(1), byte(9), byte(2), byte(3)]))
    expect(patch(bytes, 1, one, 1)).toEqual(specColl(SBYTE, [byte(1), byte(9), byte(3)]))
  })

  it('takes a plain patch over the same primitive array (JVM: specialisation of the patch is irrelevant)', () => {
    const plain = plainColl(SBYTE, [byte(9), byte(8)])
    expect(patch(bytes, 1, plain, 0)).toEqual(specColl(SBYTE, [byte(1), byte(9), byte(8), byte(2), byte(3)]))
  })

  it('throws CollClassCast on an EMPTY patch of another primitive class (the sharpest row of the family)', () => {
    // The cast precedes any store, so emptiness is irrelevant.
    expect(() => patch(bytes, 0, specColl(SINT, []), 0)).toThrow(CollClassCast)
    expect(() => patch(bytes, 0, specColl(SLONG, []), 0)).toThrow(CollClassCast)
    expect(() => patch(bytes, 0, plainColl(SBOOLEAN, []), 0)).toThrow(CollClassCast)
  })

  it('throws CollClassCast on an empty patch of another primitive class, with nothing replaced AND with items replaced', () => {
    expect(() => patch(bytes, 1, specColl(SINT, []), 0)).toThrow(CollClassCast)
    expect(() => patch(bytes, 1, specColl(SINT, []), 2)).toThrow(CollClassCast)
  })

  it('throws CollClassCast on a non-empty patch of another primitive class', () => {
    expect(() => patch(bytes, 0, specColl(SINT, [int(0)]), 0)).toThrow(CollClassCast)
    expect(() => patch(bytes, 0, plainColl(SLONG, [long(0n)]), 1)).toThrow(CollClassCast)
  })

  it('throws CollClassCast on a reference-array patch (BigInt, Coll, Object)', () => {
    expect(() => patch(bytes, 0, plainColl(SBIGINT, []), 0)).toThrow(CollClassCast)
    expect(() => patch(bytes, 0, plainColl(collOf(SINT), []), 0)).toThrow(CollClassCast)
    expect(() => patch(bytes, 0, plainColl(SBOX, []), 0)).toThrow(CollClassCast)
  })

  it('throws CollClassCast on a pairs patch (its toArray is Tuple2[])', () => {
    const pairsPatch = pairsColl(
      pairOf(SINT, SINT),
      [],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    expect(() => patch(bytes, 0, pairsPatch, 0)).toThrow(CollClassCast)
  })

  it('specialised Boolean receiver on another primitive patch: throws, empty included', () => {
    const bools = specColl(SBOOLEAN, [bool(true), bool(false)])
    expect(() => patch(bools, 0, specColl(SBYTE, []), 0)).toThrow(CollClassCast)
    expect(() => patch(bools, 0, specColl(SINT, [int(0)]), 0)).toThrow(CollClassCast)
    expect(patch(bools, 1, specColl(SBOOLEAN, [bool(true)]), 1)).toEqual(
      specColl(SBOOLEAN, [bool(true), bool(true)]),
    )
  })

  it('from and replaced each clamp to >=0 (Scala Array.patch semantics)', () => {
    // [1,2,3].patch(-1, [9], 1): from clamps to 0, replaced=1.
    expect(patch(bytes, -1, specColl(SBYTE, [byte(9)]), 1)).toEqual(
      specColl(SBYTE, [byte(9), byte(2), byte(3)]),
    )
    // [1,2,3].patch(1, [9], -5): replaced clamps to 0.
    expect(patch(bytes, 1, specColl(SBYTE, [byte(9)]), -5)).toEqual(
      specColl(SBYTE, [byte(1), byte(9), byte(2), byte(3)]),
    )
    // Out-of-bounds from saturates to length; replaced past the end is harmless.
    expect(patch(bytes, 9, specColl(SBYTE, [byte(9)]), 9)).toEqual(
      specColl(SBYTE, [byte(1), byte(2), byte(3), byte(9)]),
    )
  })
})

describe('patch — plain array-shape receiver (CollsOverArrays.scala:94-98)', () => {
  it('plain byte receiver takes an EMPTY patch of another class — the row that separates plain from specialised', () => {
    const plain = plainColl(SBYTE, [byte(1), byte(2), byte(3)])
    expect(patch(plain, 0, specColl(SINT, []), 0)).toEqual(
      plainColl(SBYTE, [byte(1), byte(2), byte(3)]),
    )
    expect(patch(plain, 1, plainColl(SLONG, []), 1)).toEqual(
      plainColl(SBYTE, [byte(1), byte(3)]),
    )
  })

  it('plain byte receiver: a non-empty patch of another class fails the per-item unbox (CollClassCast)', () => {
    const plain = plainColl(SBYTE, [byte(1), byte(2)])
    expect(() => patch(plain, 0, specColl(SINT, [int(0)]), 0)).toThrow(CollClassCast)
    expect(() => patch(plain, 1, plainColl(SLONG, [long(0n)]), 0)).toThrow(CollClassCast)
  })

  it('plain int receiver takes a same-class patch (empty, non-empty)', () => {
    const ints = plainColl(SINT, [int(1), int(2), int(3)])
    expect(patch(ints, 1, plainColl(SINT, []), 1)).toEqual(plainColl(SINT, [int(1), int(3)]))
    expect(patch(ints, 1, specColl(SINT, [int(9)]), 1)).toEqual(
      plainColl(SINT, [int(1), int(9), int(3)]),
    )
  })

  it('plain reference-array receiver over `BigInt` refuses an item of another class (CollArrayStore)', () => {
    const refs = plainColl(SBIGINT, [bigInt(1n), bigInt(2n)])
    expect(() => patch(refs, 0, plainColl(SINT, [int(0)]), 0)).toThrow(CollArrayStore)
    // An EMPTY patch of another class passes (no items stored).
    expect(patch(refs, 1, plainColl(SINT, []), 1)).toEqual(plainColl(SBIGINT, [bigInt(1n)]))
    // A same-class patch is accepted.
    expect(patch(refs, 1, plainColl(SBIGINT, [bigInt(9n)]), 0)).toEqual(
      plainColl(SBIGINT, [bigInt(1n), bigInt(9n), bigInt(2n)]),
    )
  })

  it('plain `Coll` array (reference array of Coll) takes any Coll item, whatever its item type', () => {
    const ofCollInt = plainColl(collOf(SINT), [plainColl(SINT, [int(1)])])
    const anyColl = plainColl(collOf(SLONG), [long(10n)])
    const patchOfLongColls = plainColl(collOf(SLONG), [anyColl])
    expect(patch(ofCollInt, 0, patchOfLongColls, 0)).toEqual(
      plainColl(collOf(SINT), [anyColl, plainColl(SINT, [int(1)])]),
    )
    // A non-Coll item is refused.
    expect(() => patch(ofCollInt, 0, plainColl(SINT, [int(0)]), 0)).toThrow(CollArrayStore)
  })

  it('plain `CollOverArray[Tuple2]` receiver (the shape of `Box.tokens` and of a `map` over a pair collection)', () => {
    // `builder.fromArray(res)` with a pair element type routes through
    // `fromBoxedPairs` — the result comes back as 'pairs' with plain sides.
    const ofTuple2 = plainColl(pairOf(SBYTE, SLONG), [
      pair(byte(1), long(10n)),
      pair(byte(2), long(20n)),
    ])
    const patchArr = plainColl(pairOf(SBYTE, SLONG), [pair(byte(9), long(90n))])
    const out = patch(ofTuple2, 1, patchArr, 1)
    expect(out.cls).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'long' },
    })
    expect(out.items).toEqual([pair(byte(1), long(10n)), pair(byte(9), long(90n))])
  })
})

describe('patch — pairs receiver (CollsOverArrays.scala:423-428)', () => {
  // A pairs receiver with one specialised side and one plain side — the shape
  // of `Coll[Byte](1,2,3).zip(Coll(10L,20L,30L))`.
  const specLsPairs = pairsColl(
    pairOf(SBYTE, SLONG),
    [pair(byte(1), long(10n)), pair(byte(2), long(20n)), pair(byte(3), long(30n))],
    { shape: 'array', specialised: true, array: 'byte' },
    { shape: 'array', specialised: false, array: 'long' },
  )
  const plainSidesPairs = pairsColl(
    pairOf(SBYTE, SLONG),
    [pair(byte(1), long(10n)), pair(byte(2), long(20n))],
    { shape: 'array', specialised: false, array: 'byte' },
    { shape: 'array', specialised: false, array: 'long' },
  )

  it('with a same-type pairs patch: each side patched by its own class, result is a pairs value', () => {
    const arg = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(9), long(90n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const out = patch(specLsPairs, 1, arg, 1)
    expect(out.cls?.shape).toBe('pairs')
    expect(out.items).toEqual([
      pair(byte(1), long(10n)),
      pair(byte(9), long(90n)),
      pair(byte(3), long(30n)),
    ])
  })

  it('with a plain CollOverArray[Tuple2] patch: items read as pairs, each side patched plain', () => {
    const arg = plainColl(pairOf(SBYTE, SLONG), [pair(byte(9), long(90n))])
    const out = patch(plainSidesPairs, 0, arg, 1)
    expect(out.cls?.shape).toBe('pairs')
    expect(out.items).toEqual([pair(byte(9), long(90n)), pair(byte(2), long(20n))])
  })

  it('specialised-left pairs receiver: a patch whose left side is of another primitive array throws through side delegation', () => {
    // Pairs patch whose left side is Int, not the receiver's Byte.
    const wrongLs = pairsColl(
      pairOf(SINT, SLONG),
      [],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(() => patch(specLsPairs, 0, wrongLs, 0)).toThrow(CollClassCast)
    // Non-empty too.
    const wrongLs1 = pairsColl(
      pairOf(SINT, SLONG),
      [pair(int(0), long(0n))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(() => patch(specLsPairs, 0, wrongLs1, 1)).toThrow(CollClassCast)
  })

  it('pairs receiver + non-pair patch throws (unzip reads xs.tItem.tFst)', () => {
    // A plain Coll[Int] patch handed to a pairs receiver — JVM's unzip reads
    // `xs.tItem.tFst` and fails.
    expect(() => patch(plainSidesPairs, 0, plainColl(SINT, []), 0)).toThrow(CollClassCast)
    expect(() => patch(plainSidesPairs, 0, specColl(SBYTE, [byte(0)]), 0)).toThrow(CollClassCast)
  })

  it('from and replaced propagate to each side', () => {
    const arg = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(9), long(90n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    // from=-1 clamps to 0 on each side.
    const out = patch(plainSidesPairs, -1, arg, 1)
    expect(out.items).toEqual([pair(byte(9), long(90n)), pair(byte(2), long(20n))])
  })
})
