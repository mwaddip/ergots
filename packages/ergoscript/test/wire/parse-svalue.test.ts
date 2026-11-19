/**
 * The data reader's STuple arm (`CoreDataSerializer.scala:139-144`) builds a
 * `Tuple2` for a pair (`Colls.fromArray(arr)(sigma.AnyType)` passed through
 * `Evaluation.toDslTuple` returns the pair back) and a plain `Coll[Any]`
 * over `Object[]` for a tuple of any other arity; a collection whose element
 * is itself a non-pair tuple takes `collRType(sigma.AnyType)` as the item
 * descriptor (`:179-180`), so its runtime `elem` is `SColl(SAny)` (the JVM's
 * `SAny`, told from ergots' own `SAny` by object identity).
 */
import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { SANY_JVM } from '../../src/mir/types'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { tupleColl } from '../../src/coll'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { hexToBytes } from '../_helpers'

const SINT: SType = { tag: 'SInt' }
const int = (n: number): SValue => ({ kind: 'Int', value: n })

/** Parse `hex` as the SValue of `tpe` at `treeVersion`, asserting the reader is exhausted. */
function parse(hex: string, tpe: SType, treeVersion = 3): SValue {
  const r = new ByteReader(hexToBytes(hex))
  const v = parseSValue(tpe, treeVersion, r)
  expect(r.isExhausted).toBe(true)
  return v
}

/** Write `v` at `tpe` and `treeVersion` and return the bytes. */
function write(tpe: SType, v: SValue, treeVersion = 3): Uint8Array {
  const w = new ByteWriter()
  serializeSValue(tpe, v, treeVersion, w)
  return w.toBytes()
}

/** Lower-case hex of `bytes`. */
function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

describe('the data reader at a tuple type', () => {
  it('a pair constant builds kind: Tuple', () => {
    // STuple(Int, Int), items ZigZag: 1 → 02, 2 → 04.
    const tpe: SType = { tag: 'STuple', items: [SINT, SINT] }
    const v = parse('0204', tpe)
    expect(v.kind).toBe('Tuple')
    if (v.kind === 'Tuple') {
      expect(v.items).toEqual([int(1), int(2)])
    }
  })

  it('a triple constant builds tupleColl at every item', () => {
    // STuple(Int, Int, Int), items 02, 04, 06.
    const tpe: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }
    expect(parse('020406', tpe)).toEqual(tupleColl([int(1), int(2), int(3)]))
  })

  it('a one-item tuple constant builds tupleColl', () => {
    // TupleSerializer reads 0..127; the DATA reader has no arity gate on an
    // STuple type it was handed, and a one-item tuple builds `Coll[Any]`.
    const tpe: SType = { tag: 'STuple', items: [SINT] }
    expect(parse('02', tpe)).toEqual(tupleColl([int(1)]))
  })

  it('a zero-item tuple constant builds an empty tupleColl', () => {
    // A zero-item tuple's items array is empty; the collection is
    // `tupleColl([])`. The wire form is zero bytes.
    const tpe: SType = { tag: 'STuple', items: [] }
    const r = new ByteReader(new Uint8Array(0))
    const v = parseSValue(tpe, 3, r)
    expect(v).toEqual(tupleColl([]))
  })

  it('an Option of a triple at tree v3 holds a tupleColl', () => {
    // SOption parses at tree v3; the Some branch reads the inner triple as
    // a tupleColl.
    const tpe: SType = {
      tag: 'SOption',
      elem: { tag: 'STuple', items: [SINT, SINT, SINT] },
    }
    const v = parse('01020406', tpe, 3)
    expect(v.kind).toBe('Option')
    if (v.kind === 'Option') {
      expect(v.value).toEqual(tupleColl([int(1), int(2), int(3)]))
    }
  })

  it('a pair holding a triple keeps the pair as kind: Tuple and the triple as tupleColl', () => {
    // STuple(STuple(Int,Int,Int), Int): the outer is a pair, the first item
    // is a tupleColl, the second an int. Bytes: 02 04 06 then 02.
    const tpe: SType = {
      tag: 'STuple',
      items: [{ tag: 'STuple', items: [SINT, SINT, SINT] }, SINT],
    }
    const v = parse('02040602', tpe)
    expect(v.kind).toBe('Tuple')
    if (v.kind === 'Tuple') {
      expect(v.items[0]).toEqual(tupleColl([int(1), int(2), int(3)]))
      expect(v.items[1]).toEqual(int(1))
    }
  })

  it('a triple holding a triple holds a tupleColl at every item', () => {
    // STuple(STuple(Int,Int,Int), Int, Int): the outer is a non-pair tuple
    // (arity 3), so it's a tupleColl. Its first item is the inner tupleColl.
    const tpe: SType = {
      tag: 'STuple',
      items: [
        { tag: 'STuple', items: [SINT, SINT, SINT] },
        SINT,
        SINT,
      ],
    }
    const v = parse('020406020a', tpe)
    expect(v.kind).toBe('Coll')
    if (v.kind === 'Coll') {
      expect(v.items[0]).toEqual(tupleColl([int(1), int(2), int(3)]))
      expect(v.items[1]).toEqual(int(1))
      expect(v.items[2]).toEqual(int(5))
    }
  })

  it('a Coll of triples has elem SColl(SAny) by identity', () => {
    // Coll[STuple(Int,Int,Int)] of one item: the item descriptor is
    // `collRType(sigma.AnyType)` (:179-180), so the collection's runtime
    // `elem` is `SColl(SANY_JVM)`. VLQ len = 1 (01), then the triple bytes.
    const tpe: SType = {
      tag: 'SColl',
      elem: { tag: 'STuple', items: [SINT, SINT, SINT] },
    }
    const v = parse('01020406', tpe)
    expect(v.kind).toBe('Coll')
    if (v.kind === 'Coll') {
      expect(v.elem.tag).toBe('SColl')
      if (v.elem.tag === 'SColl') {
        // SANY_JVM is told by identity, not by shape.
        expect(v.elem.elem).toBe(SANY_JVM)
      }
      expect(v.items).toEqual([tupleColl([int(1), int(2), int(3)])])
    }
  })

  it('a Coll of pairs has elem of the pair type unchanged', () => {
    // Coll[STuple(Int,Int)] of two items: the pair arm of :176-178 passes
    // `Evaluation.stypeToRType(tpeElem)` as the item descriptor, so the
    // runtime `elem` is the pair type unchanged.
    const tpe: SType = {
      tag: 'SColl',
      elem: { tag: 'STuple', items: [SINT, SINT] },
    }
    // Count 02, then two pairs (1,2) and (3,4): 02 04 then 06 08.
    const v = parse('0202040608', tpe)
    expect(v.kind).toBe('Coll')
    if (v.kind === 'Coll') {
      expect(v.elem).toEqual({ tag: 'STuple', items: [SINT, SINT] })
    }
  })
})

describe('the writer round-trip of a tuple value of any arity', () => {
  // The writer takes a `kind: 'Tuple'` value for a pair (two items) and a
  // `kind: 'Coll'` whose `elem === SANY_JVM` for a tuple of any other arity
  // (`Evaluation.fromDslTuple` `Evaluation.scala:91-96`); the reader builds
  // each of those at the arity the type declares. The bytes are identical
  // either way.

  it('a triple round-trips byte-identically', () => {
    const tpe: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }
    const bytes = '020406'
    const v = parse(bytes, tpe)
    expect(hexOf(write(tpe, v))).toBe(bytes)
  })

  it('a one-item tuple round-trips byte-identically', () => {
    const tpe: SType = { tag: 'STuple', items: [SINT] }
    const bytes = '02'
    const v = parse(bytes, tpe)
    expect(hexOf(write(tpe, v))).toBe(bytes)
  })

  it('a zero-item tuple round-trips byte-identically (empty bytes)', () => {
    const tpe: SType = { tag: 'STuple', items: [] }
    const r = new ByteReader(new Uint8Array(0))
    const v = parseSValue(tpe, 3, r)
    expect(hexOf(write(tpe, v))).toBe('')
  })

  it('a Coll of triples round-trips byte-identically', () => {
    const tpe: SType = {
      tag: 'SColl',
      elem: { tag: 'STuple', items: [SINT, SINT, SINT] },
    }
    // Count 02, then triples (1,2,3) and (5,6,7).
    const bytes = '020204060a0c0e'
    const v = parse(bytes, tpe)
    expect(hexOf(write(tpe, v))).toBe(bytes)
  })
})
