/**
 * `serializeSValue` under a `STuple` type follows the JVM's `fromDslTuple`
 * (`core/shared/src/main/scala/sigma/Evaluation.scala:91-96`): a pair value
 * gives its two items, a collection of `Any` (`elem === SANY_JVM`) gives its
 * items at every arity, anything else is refused by `fromDslTuple`
 * (`sys.error`). The writer then asserts `items.length === type.items.length`
 * (`core/shared/src/main/scala/sigma/serialization/CoreDataSerializer.scala:74`)
 * and emits each item under the type's item type at that index
 * (`:75-80`).
 */
import { describe, it, expect } from 'vitest'
import { ByteWriter } from '@ergots/scorex'
import { serializeSValue, SValueSerializeError, tupleItems } from '../../src/wire/serialize-svalue'
import { tupleColl } from '../../src/coll'
import type { SType, SValue } from '../../src/mir/types'
import { SANY_JVM } from '../../src/mir/types'

const SINT: SType = { tag: 'SInt' }
const PAIR_II: SType = { tag: 'STuple', items: [SINT, SINT] }
const TRIPLE_III: SType = { tag: 'STuple', items: [SINT, SINT, SINT] }
const SOLO_I: SType = { tag: 'STuple', items: [SINT] }

const intVal = (v: number): SValue => ({ kind: 'Int', value: v })
const byteVal = (v: number): SValue => ({ kind: 'Byte', value: v })

function writeBytes(t: SType, v: SValue): Uint8Array {
  const w = new ByteWriter()
  serializeSValue(t, v, 3, w)
  return w.toBytes()
}

describe('tupleItems', () => {
  it('a kind: Tuple value gives its items (every arity today)', () => {
    const v: SValue = { kind: 'Tuple', items: [intVal(1), intVal(2), intVal(3)] }
    expect(tupleItems(v)).toEqual([intVal(1), intVal(2), intVal(3)])
  })

  it('a kind: Coll whose elem is SANY_JVM (by identity) gives its items', () => {
    const v = tupleColl([intVal(1), intVal(2), intVal(3)])
    const items = tupleItems(v)
    expect(items).toEqual([intVal(1), intVal(2), intVal(3)])
  })

  it('a kind: Coll whose elem is some other object with tag: SAny is NOT a tuple collection', () => {
    // ergots' own SAny — a fresh object — told apart from SANY_JVM by identity.
    const ownSAny: SType = { tag: 'SAny' }
    expect(ownSAny === SANY_JVM).toBe(false)
    const v: SValue = {
      kind: 'Coll',
      elem: ownSAny,
      items: [intVal(1), intVal(2)],
      cls: { shape: 'array', specialised: false, array: 'Object' },
    }
    expect(tupleItems(v)).toBeNull()
  })

  it('a kind: Coll whose elem is a concrete type (SInt) gives null', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: SINT,
      items: [intVal(1), intVal(2)],
      cls: { shape: 'array', specialised: true, array: 'int' },
    }
    expect(tupleItems(v)).toBeNull()
  })

  it('a non-collection non-tuple kind gives null', () => {
    expect(tupleItems(intVal(1))).toBeNull()
    expect(tupleItems({ kind: 'Unit' })).toBeNull()
  })
})

describe('serializeSValue STuple arm follows fromDslTuple', () => {
  it('a kind: Tuple pair writes under (Int, Int)', () => {
    const v: SValue = { kind: 'Tuple', items: [intVal(1), intVal(2)] }
    expect(Array.from(writeBytes(PAIR_II, v))).toEqual([0x02, 0x04])
  })

  it('a two-item tupleColl writes the same bytes as the pair under (Int, Int)', () => {
    const v = tupleColl([intVal(1), intVal(2)])
    expect(Array.from(writeBytes(PAIR_II, v))).toEqual([0x02, 0x04])
  })

  it('a three-item tupleColl writes 020406 under (Int, Int, Int)', () => {
    const v = tupleColl([intVal(1), intVal(2), intVal(3)])
    expect(Array.from(writeBytes(TRIPLE_III, v))).toEqual([0x02, 0x04, 0x06])
  })

  it('a three-item kind: Tuple writes the same bytes as the tupleColl under (Int, Int, Int)', () => {
    const v: SValue = { kind: 'Tuple', items: [intVal(1), intVal(2), intVal(3)] }
    expect(Array.from(writeBytes(TRIPLE_III, v))).toEqual([0x02, 0x04, 0x06])
  })

  it('a one-item tupleColl writes 02 under (Int)', () => {
    const v = tupleColl([intVal(1)])
    expect(Array.from(writeBytes(SOLO_I, v))).toEqual([0x02])
  })

  it('a two-item tupleColl under (Int, Int, Int) refuses the length assertion', () => {
    // The JVM's length assertion at CoreDataSerializer.scala:74.
    const v = tupleColl([intVal(1), intVal(2)])
    expect(() => writeBytes(TRIPLE_III, v)).toThrow(
      expect.objectContaining({ code: 'tuple-arity-mismatch' }),
    )
  })

  it('a two-item kind: Tuple under (Int, Int, Int) refuses the length assertion', () => {
    const v: SValue = { kind: 'Tuple', items: [intVal(1), intVal(2)] }
    expect(() => writeBytes(TRIPLE_III, v)).toThrow(
      expect.objectContaining({ code: 'tuple-arity-mismatch' }),
    )
  })

  it("a Coll[Int] of three under (Int, Int, Int) refuses as fromDslTuple refuses it", () => {
    // fromDslTuple's Coll arm tests the collection's item type against sigma.AnyType
    // (Evaluation.scala:93, `a.tItem == sigma.AnyType`); a Coll[Int] fails that test.
    const v: SValue = {
      kind: 'Coll',
      elem: SINT,
      items: [intVal(1), intVal(2), intVal(3)],
      cls: { shape: 'array', specialised: true, array: 'int' },
    }
    expect(() => writeBytes(TRIPLE_III, v)).toThrow(SValueSerializeError)
  })

  it('a Byte value under (Int, Int) refuses as fromDslTuple refuses a non-tuple, non-Coll[Any] value', () => {
    expect(() => writeBytes(PAIR_II, byteVal(1))).toThrow(SValueSerializeError)
  })
})
