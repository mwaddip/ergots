/**
 * Unit grid for a collection whose class is not known. The class carries
 * one empty collection whose array ergots cannot name: a `map` / `flatMap`
 * result of a mapper whose static range ergots types as `SAny`, when the
 * input is empty. Every reader of the module handles it by the rules in
 * "A collection's class" of `facts/ergoscript-eval.md`.
 *
 * Measured on sigma-state 6.0.7 (`.../sigma/data/CollsOverArrays.scala`).
 * Each row is grouped by producer/reader and names the JVM lines its rule
 * follows.
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import {
  append,
  endsWith,
  filtered,
  getOrElse,
  indices,
  patch,
  reversed,
  slice,
  startsWith,
  updateMany,
  updated,
  zip,
} from '../../src/coll/ops'
import { emptyOfUnknownClass } from '../../src/coll/build'
import { classOf, CollClassCast } from '../../src/coll/class'
import { pairsColl, plainColl, specColl } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SANY: SType = { tag: 'SAny' }

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const bool = (b: boolean): SValue => ({ kind: 'Boolean', value: b })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })

const eq = (a: SValue, b: SValue): boolean => JSON.stringify(a) === JSON.stringify(b)

describe('the unknown class is carried by the one builder, over an empty collection', () => {
  it('builds an empty collection whose class is unknown', () => {
    const u = emptyOfUnknownClass(SANY)
    expect(u.kind).toBe('Coll')
    expect(u.items).toEqual([])
    expect(u.cls).toEqual({ shape: 'unknown' })
  })

  it('classOf reads the carried class', () => {
    const u = emptyOfUnknownClass(SANY)
    expect(classOf(u)).toEqual({ shape: 'unknown' })
  })
})

describe('unknown as an operand: a reader by class does not refuse it', () => {
  // `append(c, u)` on a non-empty receiver: the JVM's receiver-class
  // allocation would take an empty operand of the real range type without
  // refusal, so ergots gives the receiver back as it is.
  it('append on a specialised byte receiver with an unknown empty operand returns the receiver', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2)])
    const u = emptyOfUnknownClass(SANY)
    const out = append(recv, u)
    expect(out.items).toEqual([byte(1), byte(2)])
    expect(out.elem).toEqual(SBYTE)
    expect(classOf(out)).toEqual({ shape: 'array', specialised: true, array: 'byte' })
  })

  it('append on a plain long receiver with an unknown empty operand returns the receiver', () => {
    const recv = plainColl(SLONG, [long(1n), long(2n)])
    const u = emptyOfUnknownClass(SANY)
    const out = append(recv, u)
    expect(out.items).toEqual([long(1n), long(2n)])
    expect(classOf(out)).toEqual({ shape: 'array', specialised: false, array: 'long' })
  })

  it('append on a pairs receiver with an unknown empty operand returns the receiver', () => {
    const recv = pairsColl(
      { tag: 'STuple', items: [SBYTE, SLONG] },
      [pair(byte(1), long(10n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const u = emptyOfUnknownClass(SANY)
    const out = append(recv, u)
    expect(out.items.length).toBe(1)
    expect(classOf(out)).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: true, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'long' },
    })
  })

  it('patch on a specialised receiver with an unknown empty patch gives an empty patch result', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    const u = emptyOfUnknownClass(SANY)
    const out = patch(recv, 1, u, 1)
    // receiver[0,1) ++ [] ++ receiver[2,) = [byte(1), byte(3)]
    expect(out.items).toEqual([byte(1), byte(3)])
    expect(classOf(out)).toEqual({ shape: 'array', specialised: true, array: 'byte' })
  })

  it('startsWith on a specialised receiver with an unknown empty argument is true', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2)])
    const u = emptyOfUnknownClass(SANY)
    expect(startsWith(recv, u, eq)).toBe(true)
    expect(endsWith(recv, u, eq)).toBe(true)
  })

  it('updateMany on a specialised receiver with an unknown empty values-coll leaves it unchanged', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2)])
    const u = emptyOfUnknownClass(SANY)
    const out = updateMany(recv, [], u)
    expect(out.items).toEqual([byte(1), byte(2)])
    expect(classOf(out)).toEqual({ shape: 'array', specialised: true, array: 'byte' })
  })
})

describe('unknown as a receiver: readers take it through their own paths', () => {
  it('append on an unknown receiver returns the operand unread', () => {
    const u = emptyOfUnknownClass(SANY)
    const other = specColl(SBYTE, [byte(9)])
    const out = append(u, other)
    expect(out).toBe(other)
  })

  it('patch on an unknown receiver returns the patch items with the patch class', () => {
    const u = emptyOfUnknownClass(SANY)
    const p = specColl(SBYTE, [byte(7)])
    const out = patch(u, 0, p, 0)
    expect(out.items).toEqual([byte(7)])
    expect(out.elem).toEqual(SBYTE)
    expect(classOf(out)).toEqual({ shape: 'array', specialised: true, array: 'byte' })
  })

  it('getOrElse on an unknown receiver returns the default unchecked', () => {
    const u = emptyOfUnknownClass(SANY)
    // The receiver is empty: every index is out of range, and nothing casts.
    expect(getOrElse(u, 0, bool(true))).toEqual(bool(true))
    expect(getOrElse(u, 0, long(7n))).toEqual(long(7n))
    expect(getOrElse(u, -1, int(5))).toEqual(int(5))
  })

  it('startsWith / endsWith on an unknown receiver are true iff the argument is empty', () => {
    const u = emptyOfUnknownClass(SANY)
    const empty = specColl(SBYTE, [])
    const nonEmpty = specColl(SBYTE, [byte(1)])
    expect(startsWith(u, empty, eq)).toBe(true)
    expect(endsWith(u, empty, eq)).toBe(true)
    expect(startsWith(u, nonEmpty, eq)).toBe(false)
    expect(endsWith(u, nonEmpty, eq)).toBe(false)
  })

  it('slice / filtered / reversed on an unknown receiver give an empty of unknown class', () => {
    const u = emptyOfUnknownClass(SANY)
    const s = slice(u, 0, 10)
    expect(s.items).toEqual([])
    expect(classOf(s)).toEqual({ shape: 'unknown' })
    const f = filtered(u, [])
    expect(f.items).toEqual([])
    expect(classOf(f)).toEqual({ shape: 'unknown' })
    const r = reversed(u)
    expect(r.items).toEqual([])
    expect(classOf(r)).toEqual({ shape: 'unknown' })
  })

  it('indices on an unknown receiver is a specialised empty Coll[Int]', () => {
    const u = emptyOfUnknownClass(SANY)
    const i = indices(u)
    expect(i.items).toEqual([])
    expect(i.elem).toEqual(SINT)
    expect(classOf(i)).toEqual({ shape: 'array', specialised: true, array: 'int' })
  })

  it('zip of an unknown receiver with an ordinary collection is a pairs class with an unknown side', () => {
    const u = emptyOfUnknownClass(SANY)
    const other = specColl(SBYTE, [byte(1)])
    // zip cuts the longer side: u has length 0, so the result's items length is 0.
    const left = zip(u, other)
    expect(left.items).toEqual([])
    const leftCls = classOf(left)
    if (leftCls.shape !== 'pairs') throw new Error('zip(u, other) must be pairs')
    expect(leftCls.ls).toEqual({ shape: 'unknown' })
    const right = zip(other, u)
    expect(right.items).toEqual([])
    const rightCls = classOf(right)
    if (rightCls.shape !== 'pairs') throw new Error('zip(other, u) must be pairs')
    expect(rightCls.rs).toEqual({ shape: 'unknown' })
  })

  it('updated on an unknown receiver throws typed CollClassCast (an empty receiver has no in-range index)', () => {
    const u = emptyOfUnknownClass(SANY)
    // The dispatcher checks bounds first in the arm; this reaches the module
    // only through a public-API caller. The module throws its typed error.
    expect(() => updated(u, 0, byte(1))).toThrow(CollClassCast)
    expect(() => updateMany(u, [0], specColl(SBYTE, [byte(1)]))).toThrow(CollClassCast)
  })
})
