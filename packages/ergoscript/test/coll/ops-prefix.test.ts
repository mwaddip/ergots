/**
 * Tests for `startsWith` and `endsWith` on the collection module: the rule of
 * the JVM's `CollOverArray.startsWith` (`CollsOverArrays.scala:44` at 6.0.7),
 * its `endsWith` (`:46`), and `PairOfCols.startsWith` / `endsWith` (`:398-406`).
 *
 * Grid: receiver class x argument class x item layout.
 *   - A specialised receiver casts the argument's array to its own before any
 *     item is read, so an argument whose array is of another class throws
 *     `CollClassCast`, an empty one and a longer one included. An argument
 *     over the same primitive array passes the cast and the items are
 *     compared, whether the argument object is itself specialised or plain.
 *   - A plain array-shape receiver (whatever its array) compares items
 *     pairwise with `itemEq`; a longer argument gives `false`.
 *   - A `'pairs'` receiver with a `'pairs'` argument goes side by side with
 *     `&&` short-circuit — each side by its own class's rule, the right side
 *     not read when the left returns `false`.
 *   - A `'pairs'` receiver with any other argument falls back to
 *     `toArray.startsWith(ys.toArray)`, where `this.toArray` is `Array[Tuple2]`
 *     and the ARGUMENT's array is cast to `Tuple2[]`: a primitive argument
 *     array throws (an empty one included), a reference argument array passes
 *     and the items are compared (the receiver's items are the pairs, so an
 *     argument item that is no pair reduces to `false`).
 *   - A plain `CollOverArray[Tuple2]` is an `'array'` shape, so the plain rule
 *     applies there too.
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { CollClassCast } from '../../src/coll'
import { endsWith, startsWith } from '../../src/coll/ops'
import { sValueStructuralEq } from '../../src/eval/bin-op/relation'
import { pairsColl, plainColl, specColl } from '../_helpers'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
const collOf = (a: SType): SType => ({ tag: 'SColl', elem: a })

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const bool = (b: boolean): SValue => ({ kind: 'Boolean', value: b })
const bigInt = (n: bigint): SValue => ({ kind: 'BigInt', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })

describe('startsWith / endsWith — specialised receiver (CollsOverArrays.scala:44, :46)', () => {
  const bytes = specColl(SBYTE, [byte(1), byte(2), byte(3)])

  it('takes an argument of its own primitive class; items compared with itemEq', () => {
    const bytePrefix = specColl(SBYTE, [byte(1), byte(2)])
    expect(startsWith(bytes, bytePrefix, sValueStructuralEq)).toBe(true)
    expect(endsWith(bytes, specColl(SBYTE, [byte(2), byte(3)]), sValueStructuralEq)).toBe(true)
    expect(startsWith(bytes, specColl(SBYTE, [byte(1), byte(9)]), sValueStructuralEq)).toBe(false)
  })

  it('takes a plain argument over the same primitive array (empty, shorter, equal, longer)', () => {
    const plainBytes = plainColl(SBYTE, [byte(1), byte(2)])
    expect(startsWith(bytes, plainBytes, sValueStructuralEq)).toBe(true)
    expect(startsWith(bytes, plainColl(SBYTE, []), sValueStructuralEq)).toBe(true)
    expect(endsWith(bytes, plainColl(SBYTE, [byte(3)]), sValueStructuralEq)).toBe(true)
    expect(startsWith(bytes, plainColl(SBYTE, [byte(1), byte(2), byte(3), byte(4)]), sValueStructuralEq)).toBe(false)
  })

  it('throws CollClassCast on an argument of another primitive class, shorter and equal and longer', () => {
    expect(() => startsWith(bytes, specColl(SLONG, [long(1n)]), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => startsWith(bytes, plainColl(SINT, [int(0)]), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => endsWith(bytes, specColl(SINT, [int(1), int(2), int(3)]), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => startsWith(bytes, specColl(SLONG, [long(1n), long(2n), long(3n), long(4n)]), sValueStructuralEq)).toThrow(CollClassCast)
  })

  it('throws CollClassCast on an EMPTY argument of another primitive class', () => {
    // The sharpest row of the family — the cast precedes the length test.
    expect(() => startsWith(bytes, specColl(SLONG, []), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => endsWith(bytes, specColl(SLONG, []), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => startsWith(bytes, plainColl(SINT, []), sValueStructuralEq)).toThrow(CollClassCast)
  })

  it('throws CollClassCast on a reference argument array (Coll, BigInt, Tuple2, Object)', () => {
    expect(() => startsWith(bytes, plainColl(SBIGINT, [bigInt(1n)]), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => startsWith(bytes, plainColl(collOf(SINT), []), sValueStructuralEq)).toThrow(CollClassCast)
  })

  it('throws CollClassCast on a pairs argument (its toArray is Tuple2[])', () => {
    const pairsArg = pairsColl(
      pairOf(SINT, SINT),
      [pair(int(0), int(0))],
      { shape: 'array', specialised: false, array: 'int' },
      { shape: 'array', specialised: false, array: 'int' },
    )
    expect(() => startsWith(bytes, pairsArg, sValueStructuralEq)).toThrow(CollClassCast)
  })

  it('specialised boolean receiver on another primitive argument: throws, empty included', () => {
    const bools = specColl(SBOOLEAN, [bool(true), bool(false)])
    expect(() => startsWith(bools, specColl(SLONG, []), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => endsWith(bools, specColl(SBYTE, [byte(0)]), sValueStructuralEq)).toThrow(CollClassCast)
    expect(startsWith(bools, specColl(SBOOLEAN, [bool(true)]), sValueStructuralEq)).toBe(true)
  })
})

describe('startsWith / endsWith — plain array-shape receiver (CollsOverArrays.scala:44, :46)', () => {
  it('plain byte receiver compares pairwise, no cast, whatever the argument class', () => {
    const plainBytes = plainColl(SBYTE, [byte(1), byte(2), byte(3)])
    // Same-class argument.
    expect(startsWith(plainBytes, plainColl(SBYTE, [byte(1)]), sValueStructuralEq)).toBe(true)
    // Argument of another primitive class — no cast, strict `itemEq` returns `false`.
    expect(startsWith(plainBytes, plainColl(SLONG, [long(1n)]), sValueStructuralEq)).toBe(false)
    expect(startsWith(plainBytes, specColl(SINT, [int(1)]), sValueStructuralEq)).toBe(false)
    // An empty argument matches trivially.
    expect(startsWith(plainBytes, plainColl(SLONG, []), sValueStructuralEq)).toBe(true)
    expect(endsWith(plainBytes, specColl(SINT, []), sValueStructuralEq)).toBe(true)
  })

  it('plain reference-array receiver compares pairwise', () => {
    const refs = plainColl(SBIGINT, [bigInt(1n), bigInt(2n)])
    expect(startsWith(refs, plainColl(SBIGINT, [bigInt(1n)]), sValueStructuralEq)).toBe(true)
    expect(endsWith(refs, plainColl(SBIGINT, [bigInt(2n)]), sValueStructuralEq)).toBe(true)
    expect(startsWith(refs, plainColl(SBIGINT, [bigInt(9n)]), sValueStructuralEq)).toBe(false)
  })

  it('plain CollOverArray[Tuple2] (the class of a map over a pair collection) follows the plain rule', () => {
    const ofTuple2 = plainColl(pairOf(SBYTE, SLONG), [
      pair(byte(1), long(10n)),
      pair(byte(2), long(20n)),
    ])
    // Another-class EMPTY argument: plain rule, trivially `true` — the map-over-pairs
    // shape that P16 of `Coll.specialisation_pair_prefix.json` records.
    expect(startsWith(ofTuple2, plainColl(SINT, []), sValueStructuralEq)).toBe(true)
    // Same-class prefix.
    expect(startsWith(ofTuple2, plainColl(pairOf(SBYTE, SLONG), [pair(byte(1), long(10n))]), sValueStructuralEq)).toBe(true)
  })

  it('a longer argument gives `false`, never throws', () => {
    const plainBytes = plainColl(SBYTE, [byte(1), byte(2)])
    expect(startsWith(plainBytes, plainColl(SBYTE, [byte(1), byte(2), byte(3)]), sValueStructuralEq)).toBe(false)
    expect(endsWith(plainBytes, specColl(SBYTE, [byte(1), byte(2), byte(3)]), sValueStructuralEq)).toBe(false)
  })
})

describe('startsWith / endsWith — pairs receiver with pairs argument (CollsOverArrays.scala:398-406)', () => {
  // Pair with plain sides on both.
  const plainPairs = pairsColl(
    pairOf(SBYTE, SLONG),
    [pair(byte(1), long(10n)), pair(byte(2), long(20n)), pair(byte(3), long(30n))],
    { shape: 'array', specialised: false, array: 'byte' },
    { shape: 'array', specialised: false, array: 'long' },
  )

  it('side by side: both sides match → true', () => {
    const arg = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n)), pair(byte(2), long(20n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(startsWith(plainPairs, arg, sValueStructuralEq)).toBe(true)
    const endArg = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(2), long(20n)), pair(byte(3), long(30n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(endsWith(plainPairs, endArg, sValueStructuralEq)).toBe(true)
  })

  it('side by side: ls differ → false (right side not read)', () => {
    const arg = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(9), long(10n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(startsWith(plainPairs, arg, sValueStructuralEq)).toBe(false)
  })

  it('a specialised ls receiver (zip of specialised byte with plain long) with a ls of the same class: compares via itemEq', () => {
    // The shape of `Coll[Byte].zip(Coll(0L,1L,2L))` — a pairs receiver whose ls is specialised.
    const specLsPairs = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n)), pair(byte(2), long(20n)), pair(byte(3), long(30n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const arg = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(startsWith(specLsPairs, arg, sValueStructuralEq)).toBe(true)
  })

  it('a specialised ls receiver with a ls of another class: throws through the side delegation', () => {
    // The shape of P1 / P5 of `Coll.specialisation_pair_prefix.json`.
    const specLsPairs = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n)), pair(byte(2), long(20n)), pair(byte(3), long(30n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const lyingArg = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(long(1n) as unknown as SValue, long(10n))], // the component is a Long where the class says byte
      { shape: 'array', specialised: true, array: 'long' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(() => startsWith(specLsPairs, lyingArg, sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => endsWith(specLsPairs, lyingArg, sValueStructuralEq)).toThrow(CollClassCast)
  })

  it('short-circuit: plain ls differs, specialised rs would throw → answers false, no throw', () => {
    // Receiver: plain-ls (byte), specialised-rs (long).
    const mixedPairs = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n)), pair(byte(2), long(20n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: true, array: 'long' },
    )
    // Argument with a different ls item and a rs of another class — if the rs side
    // was read, the cast would throw. The && short-circuit skips it.
    const arg = pairsColl(
      pairOf(SBYTE, SINT),
      [pair(byte(9), int(0))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: true, array: 'int' },
    )
    expect(startsWith(mixedPairs, arg, sValueStructuralEq)).toBe(false)
  })
})

describe('startsWith / endsWith — pairs receiver with a non-pairs argument (fallback, :400, :405)', () => {
  const pairsRecv = pairsColl(
    pairOf(SINT, SINT),
    [pair(int(1), int(2)), pair(int(3), int(4))],
    { shape: 'array', specialised: false, array: 'int' },
    { shape: 'array', specialised: false, array: 'int' },
  )

  it('throws on an EMPTY primitive argument (P7 / P12): the cast precedes the length test', () => {
    expect(() => startsWith(pairsRecv, plainColl(SINT, []), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => endsWith(pairsRecv, plainColl(SINT, []), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => startsWith(pairsRecv, specColl(SBYTE, []), sValueStructuralEq)).toThrow(CollClassCast)
  })

  it('throws on a non-empty primitive argument (P8 / P9)', () => {
    expect(() => startsWith(pairsRecv, plainColl(SINT, [int(1)]), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => startsWith(pairsRecv, specColl(SBYTE, [byte(1), byte(2)]), sValueStructuralEq)).toThrow(CollClassCast)
    expect(() => startsWith(pairsRecv, specColl(SBOOLEAN, [bool(true)]), sValueStructuralEq)).toThrow(CollClassCast)
  })

  it('answers on an EMPTY reference argument: true, no cast (P10 / P13)', () => {
    expect(startsWith(pairsRecv, plainColl(collOf(SINT), []), sValueStructuralEq)).toBe(true)
    expect(endsWith(pairsRecv, plainColl(collOf(SINT), []), sValueStructuralEq)).toBe(true)
  })

  it('answers on a non-empty reference argument: items compared pairwise, pair vs Coll → false (P11)', () => {
    const refArg = plainColl(collOf(SINT), [plainColl(SINT, [int(1)])])
    expect(startsWith(pairsRecv, refArg, sValueStructuralEq)).toBe(false)
  })
})
