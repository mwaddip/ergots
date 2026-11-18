/**
 * Tests for the builders of the coll module: `fromArray`, `collOverArray`,
 * `byteColl`, `withClass`, and the test helpers that build collections with a
 * class for expectations.
 *
 * JVM references at 6.0.7:
 *   CollsOverArrays.scala:226-233   CollOverArrayBuilder.fromArray
 *   CollsOverArrays.scala:205-215   fromBoxedPairs (pair routing, plain sides)
 *   CollsOverArrays.scala:11, :323  new CollOverArray (no pair routing)
 */

import { describe, it, expect } from 'vitest'
import type { CollValue } from '../../src/coll'
import {
  byteColl,
  collOverArray,
  fromArray,
  withClass,
} from '../../src/coll/build'
import type { SType, SValue } from '../../src/mir/types'
import { pairsColl, plainColl, specColl, withoutClass } from '../_helpers'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBIGINT: SType = { tag: 'SBigInt' }
const SBOX: SType = { tag: 'SBox' }

const collOf = (elem: SType): SType => ({ tag: 'SColl', elem })
const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })

const int = (n: number): SValue => ({ kind: 'Int', value: n })
const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })

describe('fromArray (CollOverArrayBuilder.fromArray :226-233)', () => {
  it('is specialised for a primitive item type when specialised = true', () => {
    expect(fromArray(SBYTE, [byte(1), byte(2)], true)).toEqual({
      kind: 'Coll',
      elem: SBYTE,
      items: [byte(1), byte(2)],
      cls: { shape: 'array', specialised: true, array: 'byte' },
    })
    expect(fromArray(SBOOLEAN, [], true)).toEqual({
      kind: 'Coll',
      elem: SBOOLEAN,
      items: [],
      cls: { shape: 'array', specialised: true, array: 'boolean' },
    })
  })

  it('is plain for a primitive item type when specialised = false', () => {
    expect(fromArray(SINT, [int(1), int(2)], false)).toEqual({
      kind: 'Coll',
      elem: SINT,
      items: [int(1), int(2)],
      cls: { shape: 'array', specialised: false, array: 'int' },
    })
  })

  it('is plain for a reference item type whatever specialised says', () => {
    expect(fromArray(SBIGINT, [], true)).toEqual({
      kind: 'Coll',
      elem: SBIGINT,
      items: [],
      cls: { shape: 'array', specialised: false, array: 'BigInt' },
    })
    expect(fromArray(SBIGINT, [], false)).toEqual({
      kind: 'Coll',
      elem: SBIGINT,
      items: [],
      cls: { shape: 'array', specialised: false, array: 'BigInt' },
    })
  })

  it('routes a pair item type to pairs with plain sides, whatever specialised says', () => {
    const items: SValue[] = [pair(int(1), byte(10)), pair(int(2), byte(20))]
    const expected = {
      kind: 'Coll',
      elem: pairOf(SINT, SBYTE),
      items,
      cls: {
        shape: 'pairs',
        ls: { shape: 'array', specialised: false, array: 'int' },
        rs: { shape: 'array', specialised: false, array: 'byte' },
      },
    } as const
    expect(fromArray(pairOf(SINT, SBYTE), items, true)).toEqual(expected)
    expect(fromArray(pairOf(SINT, SBYTE), items, false)).toEqual(expected)
  })
})

describe('collOverArray (new CollOverArray, no pair routing, :323)', () => {
  it('is plain for every item type, with the array class of the element type', () => {
    expect(collOverArray(SINT, [int(1)])).toEqual({
      kind: 'Coll',
      elem: SINT,
      items: [int(1)],
      cls: { shape: 'array', specialised: false, array: 'int' },
    })
    expect(collOverArray(pairOf(SINT, SBYTE), [pair(int(1), byte(2))])).toEqual({
      kind: 'Coll',
      elem: pairOf(SINT, SBYTE),
      items: [pair(int(1), byte(2))],
      cls: { shape: 'array', specialised: false, array: 'Tuple2' },
    })
    expect(collOverArray(collOf(SBYTE), [])).toEqual({
      kind: 'Coll',
      elem: collOf(SBYTE),
      items: [],
      cls: { shape: 'array', specialised: false, array: 'Coll' },
    })
    expect(collOverArray(SBOX, [])).toEqual({
      kind: 'Coll',
      elem: SBOX,
      items: [],
      cls: { shape: 'array', specialised: false, array: 'Box' },
    })
  })
})

describe('byteColl (Colls.fromArray(Array[Byte]) or Array[Byte].toColl)', () => {
  it('sign-extends every byte and sets the byte class', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255])
    const spec = byteColl(bytes, true)
    expect(spec).toEqual({
      kind: 'Coll',
      elem: SBYTE,
      items: [byte(0), byte(1), byte(127), byte(-128), byte(-1)],
      cls: { shape: 'array', specialised: true, array: 'byte' },
    })
    const plain = byteColl(bytes, false)
    expect(plain.cls).toEqual({ shape: 'array', specialised: false, array: 'byte' })
    expect(plain.items).toEqual(spec.items)
  })

  it('accepts the empty input', () => {
    expect(byteColl(new Uint8Array(), true).items).toEqual([])
    expect(byteColl(new Uint8Array(), false).items).toEqual([])
  })
})

describe('withClass (an exact class)', () => {
  it('sets the class exactly as given', () => {
    const cls = { shape: 'array' as const, specialised: true as const, array: 'byte' as const }
    expect(withClass(SBYTE, [byte(1)], cls)).toEqual({
      kind: 'Coll',
      elem: SBYTE,
      items: [byte(1)],
      cls,
    })
    const pairsCls = {
      shape: 'pairs' as const,
      ls: { shape: 'array' as const, specialised: true as const, array: 'byte' as const },
      rs: { shape: 'array' as const, specialised: false as const, array: 'Box' as const },
    }
    const r = withClass(pairOf(SBYTE, SBOX), [], pairsCls)
    expect(r.cls).toEqual(pairsCls)
  })
})

describe('test helpers for a collection with a class', () => {
  it('specColl builds a specialised array collection with the given item type', () => {
    expect(specColl(SBYTE, [byte(1)])).toEqual({
      kind: 'Coll',
      elem: SBYTE,
      items: [byte(1)],
      cls: { shape: 'array', specialised: true, array: 'byte' },
    })
  })

  it('plainColl builds a plain array collection with the given item type', () => {
    expect(plainColl(SLONG, [])).toEqual({
      kind: 'Coll',
      elem: SLONG,
      items: [],
      cls: { shape: 'array', specialised: false, array: 'long' },
    })
  })

  it('pairsColl builds a pair-shape collection with the given sides', () => {
    const items: SValue[] = [pair(int(1), byte(2))]
    const ls = { shape: 'array', specialised: false, array: 'int' } as const
    const rs = { shape: 'array', specialised: false, array: 'byte' } as const
    expect(pairsColl(pairOf(SINT, SBYTE), items, ls, rs)).toEqual({
      kind: 'Coll',
      elem: pairOf(SINT, SBYTE),
      items,
      cls: { shape: 'pairs', ls, rs },
    })
  })

  it('withoutClass deep-copies and strips cls at every depth', () => {
    const inner = specColl(SBYTE, [byte(1), byte(2)])
    const outer: CollValue = {
      kind: 'Coll',
      elem: collOf(SBYTE),
      items: [inner],
      cls: { shape: 'array', specialised: false, array: 'Coll' },
    }
    const stripped = withoutClass(outer) as CollValue
    expect(stripped.cls).toBeUndefined()
    const innerStripped = stripped.items[0]! as CollValue
    expect(innerStripped.cls).toBeUndefined()
    // the input is untouched
    expect(outer.cls).toBeDefined()
    expect(inner.cls).toBeDefined()
  })

  it('withoutClass strips cls under a Tuple and under an Option', () => {
    const c = specColl(SBYTE, [byte(1)])
    const t: SValue = { kind: 'Tuple', items: [c, int(1)] }
    const stripped = withoutClass(t) as SValue & { kind: 'Tuple' }
    expect((stripped.items[0] as CollValue).cls).toBeUndefined()

    const opt: SValue = { kind: 'Option', elem: collOf(SBYTE), value: c }
    const strippedOpt = withoutClass(opt) as SValue & { kind: 'Option' }
    const inner = strippedOpt.value as CollValue
    expect(inner.cls).toBeUndefined()
  })

  it('withoutClass leaves a value without cls as it is (structurally equal)', () => {
    const v: SValue = { kind: 'Coll', elem: SBYTE, items: [byte(1)] }
    expect(withoutClass(v)).toEqual(v)
  })
})
