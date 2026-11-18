/**
 * Tests for `getOrElse` on the collection module: the rule of the JVM's
 * `CollOverArray.getOrElse` (`CollsOverArrays.scala:26` at 6.0.7) and of
 * `PairOfCols.getOrElse` (`CollsOverArrays.scala:309-315`).
 *
 * Grid: receiver class x default class x in range or out.
 *   - A specialised receiver unboxes the default, so a default of another
 *     class throws `CollClassCast`, IN range and out. A default of the
 *     receiver's primitive class returns the item in range and the default
 *     out of range.
 *   - A plain receiver returns the item in range and the default out of
 *     range, whatever the default's class.
 *   - A `'pairs'` receiver reads the default's two components out of range,
 *     so a default that is no pair throws out of range; a default that is a
 *     pair is returned whatever its components' classes. In range the
 *     receiver's own `apply(i)` returns, and the default is not read.
 *   - A plain collection over `'Tuple2'` (the class of `Box.tokens` and of
 *     a `map` over a pair collection) is a `CollOverArray`: the plain rule.
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { Env } from '../../src/eval/env'
import { CollClassCast } from '../../src/coll'
import { getOrElse } from '../../src/coll/ops'
import { pairsColl, plainColl, specColl } from '../_helpers'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const short = (n: number): SValue => ({ kind: 'Short', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const bool = (b: boolean): SValue => ({ kind: 'Boolean', value: b })
const bigInt = (n: bigint): SValue => ({ kind: 'BigInt', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })

describe('getOrElse — specialised receiver (CollsOverArrays.scala:26)', () => {
  // The specialised subclass of `CollOverArray` unboxes the default through
  // `BoxesRunTime.unboxTo<T>`, before the range test. A default whose class
  // is not the receiver's primitive class fails that unbox: `ClassCastException`.
  const bytes = specColl(SBYTE, [byte(1), byte(2)])

  it('returns the item in range when the default is of the receiver class', () => {
    expect(getOrElse(bytes, 0, byte(7))).toEqual(byte(1))
    expect(getOrElse(bytes, 1, byte(7))).toEqual(byte(2))
  })

  it('returns the default out of range when the default is of the receiver class', () => {
    expect(getOrElse(bytes, 2, byte(7))).toEqual(byte(7))
    expect(getOrElse(bytes, -1, byte(7))).toEqual(byte(7))
    expect(getOrElse(bytes, 99, byte(7))).toEqual(byte(7))
  })

  it('throws CollClassCast when the default is of another class, in range', () => {
    expect(() => getOrElse(bytes, 0, bool(true))).toThrow(CollClassCast)
    expect(() => getOrElse(bytes, 0, int(7))).toThrow(CollClassCast)
    expect(() => getOrElse(bytes, 0, short(7))).toThrow(CollClassCast)
  })

  it('throws CollClassCast when the default is of another class, out of range', () => {
    expect(() => getOrElse(bytes, 9, bool(true))).toThrow(CollClassCast)
    expect(() => getOrElse(bytes, 9, int(7))).toThrow(CollClassCast)
    expect(() => getOrElse(bytes, -1, short(7))).toThrow(CollClassCast)
  })

  it('takes a default of its own class for Coll[Boolean], Coll[Int], Coll[Long]', () => {
    const bools = specColl(SBOOLEAN, [bool(false), bool(true)])
    expect(getOrElse(bools, 0, bool(true))).toEqual(bool(false))
    expect(getOrElse(bools, 2, bool(true))).toEqual(bool(true))
    expect(() => getOrElse(bools, 0, byte(0))).toThrow(CollClassCast)

    const ints = specColl(SINT, [int(10), int(20)])
    expect(getOrElse(ints, 0, int(99))).toEqual(int(10))
    expect(getOrElse(ints, 5, int(99))).toEqual(int(99))
    expect(() => getOrElse(ints, 0, long(0n))).toThrow(CollClassCast)
    expect(() => getOrElse(ints, 0, short(0))).toThrow(CollClassCast)

    const longs = specColl(SLONG, [long(10n), long(20n)])
    expect(getOrElse(longs, 1, long(99n))).toEqual(long(20n))
    expect(getOrElse(longs, 9, long(99n))).toEqual(long(99n))
    expect(() => getOrElse(longs, 0, int(0))).toThrow(CollClassCast)
  })
})

describe('getOrElse — plain receiver (CollsOverArrays.scala:26)', () => {
  // A plain `CollOverArray[A]` has `A` abstract (no `@specialized` instance),
  // so the default is an object and comes back as it is out of range,
  // whatever its class. In range the item is returned; the default is
  // not read.
  const bytes = plainColl(SBYTE, [byte(1), byte(2)])

  it('returns the item in range, whatever the default class', () => {
    expect(getOrElse(bytes, 0, bool(true))).toEqual(byte(1))
    expect(getOrElse(bytes, 1, int(0))).toEqual(byte(2))
  })

  it('returns the default out of range, whatever its class', () => {
    expect(getOrElse(bytes, 2, bool(true))).toEqual(bool(true))
    expect(getOrElse(bytes, -1, int(42))).toEqual(int(42))
    expect(getOrElse(bytes, 99, pair(byte(0), byte(0)))).toEqual(pair(byte(0), byte(0)))
  })

  it('a plain collection over a reference array follows the plain rule', () => {
    const refs = plainColl(SBIGINT, [bigInt(1n), bigInt(2n)])
    expect(getOrElse(refs, 0, bool(true))).toEqual(bigInt(1n))
    expect(getOrElse(refs, 9, bool(true))).toEqual(bool(true))
  })

  it('a plain collection over `Tuple2[]` returns the default (whatever class) out of range', () => {
    // The class of `Box.tokens` and of a `map` over a pair collection: a
    // `CollOverArray[Tuple2]`, not a `PairOfCols` (CollsOverArrays.scala:11).
    const ofTuple2 = plainColl(pairOf(SBYTE, SLONG), [pair(byte(1), long(10n))])
    expect(getOrElse(ofTuple2, 0, bool(true))).toEqual(pair(byte(1), long(10n)))
    expect(getOrElse(ofTuple2, 2, bool(true))).toEqual(bool(true))
    expect(getOrElse(ofTuple2, 2, pair(byte(7), long(70n)))).toEqual(pair(byte(7), long(70n)))
  })
})

describe('getOrElse — pairs receiver (CollsOverArrays.scala:309-315)', () => {
  // `PairOfCols.getOrElse(i: Int, default: (L, R))` is reached from the
  // generic `Coll.getOrElse(i: Int, default: A)` through a bridge method
  // whose `default: Object` is cast to `Tuple2` BEFORE the body runs. A
  // non-pair default fails the bridge cast, in range or out. Measured on
  // sigma-state 6.0.7 (`.../fallback-and-default.jvm.jsonl` line 5, tree
  // v0 in-range `ClassCastException: java.lang.Long cannot be cast to
  // scala.Tuple2`).
  const pairs = pairsColl(
    pairOf(SBYTE, SLONG),
    [pair(byte(1), long(10n)), pair(byte(2), long(20n))],
    { shape: 'array', specialised: true, array: 'byte' },
    { shape: 'array', specialised: false, array: 'long' },
  )

  it('returns `apply(i)` in range when the default is a pair', () => {
    expect(getOrElse(pairs, 0, pair(byte(7), long(70n)))).toEqual(pair(byte(1), long(10n)))
    expect(getOrElse(pairs, 1, pair(byte(7), long(70n)))).toEqual(pair(byte(2), long(20n)))
  })

  it('throws CollClassCast in range when the default is not a pair (bridge method cast)', () => {
    expect(() => getOrElse(pairs, 0, bool(true))).toThrow(CollClassCast)
    expect(() => getOrElse(pairs, 1, int(0))).toThrow(CollClassCast)
  })

  it('returns the default out of range when it is a pair, whatever its components', () => {
    expect(getOrElse(pairs, 2, pair(byte(7), long(70n)))).toEqual(pair(byte(7), long(70n)))
    // Components of another class: the JVM accepts.
    expect(getOrElse(pairs, 2, pair(bool(true), int(0)))).toEqual(pair(bool(true), int(0)))
  })

  it('throws CollClassCast out of range when the default is not a pair', () => {
    expect(() => getOrElse(pairs, 2, bool(true))).toThrow(CollClassCast)
    expect(() => getOrElse(pairs, -1, byte(0))).toThrow(CollClassCast)
    expect(() => getOrElse(pairs, 9, int(0))).toThrow(CollClassCast)
  })
})

// `void` keeps the environment import for possible future tests.
void Env
