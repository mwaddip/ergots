/**
 * Tests for the tuple-collection builder, the data reader's item type for a
 * declared element type, and the array cast a consumer makes when it needs
 * the array of a class.
 *
 * JVM references at 6.0.7:
 *   core/shared/src/main/scala/sigma/serialization/CoreDataSerializer.scala:139-143
 *                                               (the tuple arm of deserializeColl)
 *   core/shared/src/main/scala/sigma/ast/values.scala:818-822
 *                                               (Tuple.value, Colls.fromArray(arr)(AnyType))
 *   core/shared/src/main/scala/sigma/serialization/CoreDataSerializer.scala:176-182
 *                                               (the item descriptor in deserializeColl)
 *   core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:299
 *                                               (PairOfCols.toArray = ls.toArray.zip(rs.toArray))
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { SANY_JVM } from '../../src/mir/types'
import {
  byteColl,
  castArray,
  CollClassCast,
  classOf,
  dataItemType,
  empty,
  fromData,
  tupleColl,
  type CollValue,
} from '../../src/coll'

const SINT: SType = { tag: 'SInt' }
const SBYTE: SType = { tag: 'SByte' }
const SLONG: SType = { tag: 'SLong' }
const STUPLE = (items: SType[]): SType => ({ tag: 'STuple', items })

const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const bool = (b: boolean): SValue => ({ kind: 'Boolean', value: b })

describe('tupleColl (Colls.fromArray(arr)(sigma.AnyType), CoreDataSerializer.scala:139-143, values.scala:818-822)', () => {
  it('builds a plain Object[] collection of SAny at every arity', () => {
    // The data reader's tuple arm (:139-143) returns `Evaluation.toDslTuple`,
    // whose body is `Colls.fromArray(arr)(sigma.AnyType)` (Evaluation.scala
    // :99-102): a plain `CollOverArray` of `Any`, over `Object[]`.
    expect(tupleColl([int(1), bool(true)])).toEqual({
      kind: 'Coll',
      elem: SANY_JVM,
      items: [int(1), bool(true)],
      cls: { shape: 'array', specialised: false, array: 'Object' },
    })
  })

  it('accepts the empty input and still gives SAny / Object[]', () => {
    expect(tupleColl([]).items).toEqual([])
    expect(tupleColl([]).elem).toBe(SANY_JVM)
    expect(tupleColl([]).cls).toEqual({
      shape: 'array',
      specialised: false,
      array: 'Object',
    })
  })

  it('builds an arity-3 tuple as the Coll[Any]', () => {
    const v = tupleColl([int(1), int(2), int(3)])
    expect(v.elem).toBe(SANY_JVM)
    expect(v.items).toEqual([int(1), int(2), int(3)])
    expect(v.cls).toEqual({ shape: 'array', specialised: false, array: 'Object' })
  })

  it('uses SANY_JVM by identity, not a fresh { tag: "SAny" }', () => {
    // Told apart from ergots' own SAny (a fresh { tag: 'SAny' }) by object identity
    // (mir/types.ts:79, the user of SANY_JVM in jvm-types.ts). The builder sets
    // the elem to the exported object, not a copy.
    expect(tupleColl([int(1)]).elem).toBe(SANY_JVM)
  })
})

describe('dataItemType (the item descriptor of CoreDataSerializer.deserializeColl :176-182)', () => {
  it('returns SColl(SAny) for a tuple type of three items', () => {
    // :179-180 passes `collRType(sigma.AnyType)` as the item descriptor when
    // the declared element type is an STuple of another arity than two. In the
    // ergots value model this is `elem: SColl(SAny)`: a Coll of non-pair tuples
    // has SAny as its item element type, not the tuple type.
    expect(dataItemType(STUPLE([SINT, SINT, SINT]))).toEqual({ tag: 'SColl', elem: SANY_JVM })
    // Inner elem is SANY_JVM by identity, told apart from ergots' own SAny
    // (a fresh `{ tag: 'SAny' }`) by object identity (mir/types.ts:79).
    const r = dataItemType(STUPLE([SINT, SINT, SINT])) as { tag: 'SColl'; elem: SType }
    expect(r.elem).toBe(SANY_JVM)
  })

  it('returns SColl(SAny) for a tuple type of one item (arity not two)', () => {
    // The register reader accepts a one-item Tuple expression (TupleSerializer
    // reads 0..127); a collection whose element is a one-item tuple takes the
    // collRType(sigma.AnyType) descriptor too, since the arity-two carve-out
    // applies only to a pair.
    expect(dataItemType(STUPLE([SINT]))).toEqual({ tag: 'SColl', elem: SANY_JVM })
  })

  it('returns the pair type itself for a pair element type', () => {
    // :176-178 is the pair arm; the item descriptor is the pair type's own
    // RType — in ergots' model, the declared element type unchanged.
    expect(dataItemType(STUPLE([SINT, SINT]))).toEqual(STUPLE([SINT, SINT]))
  })

  it('returns the element type itself when the element is nested with an outer pair', () => {
    // A tuple whose outer arity is two keeps the pair rule, whatever its
    // components are (its left side being a non-pair tuple does not change
    // the outer arm).
    expect(dataItemType(STUPLE([STUPLE([SINT, SINT, SINT]), SINT]))).toEqual(
      STUPLE([STUPLE([SINT, SINT, SINT]), SINT]),
    )
  })

  it('returns the element type itself for every non-tuple type', () => {
    expect(dataItemType(SINT)).toBe(SINT)
    expect(dataItemType(SBYTE)).toBe(SBYTE)
    expect(dataItemType({ tag: 'SColl', elem: SINT })).toEqual({
      tag: 'SColl',
      elem: SINT,
    })
    expect(dataItemType({ tag: 'SBox' })).toEqual({ tag: 'SBox' })
  })
})

describe('fromData with a tuple element type (controls the data-reader row)', () => {
  it('builds the plain Coll over a Coll[Coll[Any]] for a collection of non-pair tuples', () => {
    // `fromData` on a tuple-of-another-arity ELEMENT type ends up as a plain
    // Coll whose array class is 'Coll' (`arrayClassOf({tag:'STuple',items:3})`
    // = 'Coll'). Pins the class the builder gives, as a control.
    expect(classOf(fromData(STUPLE([SINT, SINT, SINT]), []))).toEqual({
      shape: 'array',
      specialised: false,
      array: 'Coll',
    })
  })
})

describe('castArray (a consumer that needs the array of a class)', () => {
  it('returns items of a plain array-shape collection whose array matches', () => {
    // A consumer that needs a byte[] casts `toArray` to byte[]; a plain
    // CollOverArray[Byte] over byte[] (the receiver's `toArray` returns the
    // stored primitive array) passes the cast without reading its items.
    const v = byteColl(new Uint8Array([1, 2, 3]), false)
    expect(castArray(v, 'byte', 'ByteArrayToBigInt argument')).toEqual(v.items)
    expect(castArray(v, 'byte', 'x')).toHaveLength(3)
  })

  it('returns items of a specialised collection whose array matches', () => {
    // The class's `array` field decides, not `specialised`: both a specialised
    // and a plain byte-array-backed collection pass a cast to byte[].
    const v = byteColl(new Uint8Array([7]), true)
    expect(castArray(v, 'byte', 'x')).toHaveLength(1)
  })

  it('throws CollClassCast when a non-pairs collection\'s array is of another class', () => {
    // `tupleColl` is over Object[]: cast to byte[] throws, as the JVM throws
    // ClassCastException on `(Object[]) toArray as byte[]`.
    expect(() => castArray(tupleColl([byte(1)]), 'byte', 'ByteArrayToBigInt argument')).toThrow(
      CollClassCast,
    )
  })

  it('throws CollClassCast with the `what` string in the message', () => {
    try {
      castArray(tupleColl([int(1)]), 'byte', 'ByteArrayToBigInt argument')
      throw new Error('castArray should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(CollClassCast)
      expect((e as Error).message).toContain('ByteArrayToBigInt argument')
    }
  })

  it('throws CollClassCast when a plain Coll[Long] is cast to byte[]', () => {
    const v = fromData(SLONG, [long(1n), long(2n)])
    expect(() => castArray(v, 'byte', 'x')).toThrow(CollClassCast)
  })

  it('throws CollClassCast on a `pairs` collection, which has no single stored array', () => {
    // `castArray` reads the stored array a `CollOverArray` keeps; a
    // `PairOfCols` keeps TWO arrays — one per side — and has no single stored
    // array (`CollsOverArrays.scala:299`, `toArray = ls.toArray.zip(rs.toArray)`,
    // builds a new one on demand by zipping, which is not the stored array).
    // The brief's rule: a pairs collection has no one array; the cast throws.
    const pairCol = fromData(STUPLE([SINT, SINT]), [
      { kind: 'Tuple', items: [int(1), int(2)] },
    ])
    expect(() => castArray(pairCol, 'Tuple2', 'x')).toThrow(CollClassCast)
  })

  it('returns the items of an `unknown`-shape collection unchecked', () => {
    // An unknown-shape collection is an empty result of a map/flatMap whose
    // mapper's static range ergots cannot name (`coll/build.ts` `empty`), and
    // every reader takes it by the empty-receiver-of-its-own-class rule so
    // honest scripts like `hash ++ CONTEXT.headers.flatMap(h => h.id)` with
    // no headers answer. castArray does the same: the empty `items` passes
    // through, whatever array class the consumer asked for, and no reader
    // refuses it.
    expect(castArray(empty(SINT), 'int', 'x')).toEqual([])
    expect(castArray(empty(SINT), 'byte', 'ByteArrayToBigInt argument')).toEqual([])
  })

  it('returns the exact items array of an `unknown`-shape collection', () => {
    const u: CollValue = empty(SINT)
    // The one builder of this class carries an empty items array
    // (`coll/build.ts` `empty`'s invariant), which castArray hands back.
    expect(castArray(u, 'int', 'x')).toBe(u.items)
  })
})
