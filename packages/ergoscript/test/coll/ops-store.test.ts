/**
 * Tests for `updated`, `updateMany`, `append` on the collection module:
 * the rules of the JVM's `CollOverArray` (`CollsOverArrays.scala:48-57`,
 * `:100-104`, `:106-117`) and `PairOfCols` (`:379-382`, `:430-434`,
 * `:436-450`) at 6.0.7, under the shared store helper that says what an
 * array of a class HOLDS after a store (the item as given, or a `Unit` for
 * an array of `Unit` on paths the JVM's `ArrayBuilder.ofUnit` drops the
 * value, or a refusal).
 *
 * Grid, per operation, per receiver shape and operand:
 *   - `updated`:
 *     - Specialised byte receiver: an item of another class fails at the
 *       call (specialised unbox): `CollClassCast`.
 *     - Plain byte receiver: the item is stored into a new Array[Byte] of
 *       the receiver's class tag — a non-byte item fails the unbox too.
 *     - Plain `Coll[Coll[Int]]` receiver takes a `Coll[Long]` item (the
 *       `Array[Coll]` store takes any `Coll`).
 *     - Plain `Coll[Box]` receiver refuses a `GroupElement` item:
 *       `CollArrayStore`.
 *     - Plain `Coll[Unit]` receiver refuses an `Int` item (a single array
 *       store, unlike `patch` via `ArrayBuilder.ofUnit`).
 *     - `'pairs'` receiver: a non-pair item fails the pair read; each
 *       side's class decides its component's store.
 *   - `updateMany`:
 *     - Same per-value store rules as `updated`, applied for each value.
 *     - `'pairs'` receiver: `builder.pairColl(builder.fromArray(resL),
 *       builder.fromArray(resR))` runs `fromArray` at erased L/R, so the
 *       result's sides come out PLAIN whatever the receiver's sides were.
 *   - `append`:
 *     - Empty receiver returns the other operand UNREAD: its own class and
 *       `elem` (`CollsOverArrays.scala:49`).
 *     - Specialised receiver: `other.toArray` is cast to the receiver's own
 *       primitive array — an operand over another array fails even when
 *       empty (`CollClassCast`).
 *     - Plain primitive receiver: `safeConcatArrays_v5` allocates
 *       `new Array[A]` and copies from `other.toArray` — a source of
 *       another component type fails the copy even when empty
 *       (`CollArrayStore`).
 *     - Plain reference receiver + reference operand: per-item check (empty
 *       operand of another reference class is accepted; a non-matching
 *       item fails with `CollArrayStore`).
 *     - Plain reference receiver + primitive operand: the copy is refused
 *       whatever the operand's length (`CollArrayStore`).
 *     - Plain `Coll[Unit]` receiver + non-empty operand of another class:
 *       `CollArrayStore`.
 *     - `'pairs'` receiver: `unzip(other)` gives up the operand's sides
 *       (`CollClassCast` when the operand's elem is no pair type); each
 *       side's `append` applies.
 *   - `patch` on `Coll[Unit]`: each stored value is coerced to a `Unit`
 *     because Scala's `Array.patch` builds the result through
 *     `ArrayBuilder.ofUnit` (scala-library 2.12.20), which counts items
 *     and fills with units. Row #56 (identity-map comparison to a
 *     `Coll[Unit]((), ())`) turns green.
 */

import { describe, it, expect } from 'vitest'
import type { SType, SValue } from '../../src/mir/types'
import { CollArrayStore, CollClassCast } from '../../src/coll'
import { append, patch, updated, updateMany } from '../../src/coll/ops'
import { pairsColl, plainColl, specColl, synthesizeStubBox } from '../_helpers'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SSHORT: SType = { tag: 'SShort' }
const SINT: SType = { tag: 'SInt' }
const SLONG: SType = { tag: 'SLong' }
const SBOX: SType = { tag: 'SBox' }
const SGROUP: SType = { tag: 'SGroupElement' }
const SUNIT: SType = { tag: 'SUnit' }
const SANY: SType = { tag: 'SAny' }

const pairOf = (a: SType, b: SType): SType => ({ tag: 'STuple', items: [a, b] })
const collOf = (a: SType): SType => ({ tag: 'SColl', elem: a })

const byte = (n: number): SValue => ({ kind: 'Byte', value: n })
const short = (n: number): SValue => ({ kind: 'Short', value: n })
const int = (n: number): SValue => ({ kind: 'Int', value: n })
const long = (n: bigint): SValue => ({ kind: 'Long', value: n })
const bool = (b: boolean): SValue => ({ kind: 'Boolean', value: b })
const unit = (): SValue => ({ kind: 'Unit' })
const bigInt = (n: bigint): SValue => ({ kind: 'BigInt', value: n })
const pair = (a: SValue, b: SValue): SValue => ({ kind: 'Tuple', items: [a, b] })
const groupElem = (): SValue => ({
  kind: 'GroupElement',
  value: new Uint8Array(33),
})
const makeBox = (): SValue => ({ kind: 'Box', value: synthesizeStubBox() })

describe('updated — CollsOverArrays.scala:100-104 (CollOverArray) and :430-434 (PairOfCols)', () => {
  it('specialised byte receiver takes a byte item (keeps the specialised class)', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    expect(updated(recv, 1, byte(9))).toEqual(specColl(SBYTE, [byte(1), byte(9), byte(3)]))
  })

  it('specialised byte receiver refuses an item of another primitive class (CollClassCast)', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2)])
    expect(() => updated(recv, 0, int(0))).toThrow(CollClassCast)
    expect(() => updated(recv, 0, bool(true))).toThrow(CollClassCast)
    expect(() => updated(recv, 0, long(0n))).toThrow(CollClassCast)
  })

  it('specialised byte receiver refuses an item of a reference class (CollClassCast)', () => {
    const recv = specColl(SBYTE, [byte(1)])
    expect(() => updated(recv, 0, bigInt(1n))).toThrow(CollClassCast)
    expect(() => updated(recv, 0, groupElem())).toThrow(CollClassCast)
  })

  it('specialised bool receiver refuses a byte (Coll.item_store_type_check #2)', () => {
    const recv = specColl(SBOOLEAN, [bool(true)])
    expect(() => updated(recv, 0, byte(1))).toThrow(CollClassCast)
  })

  it('plain primitive receiver (short, int, long) refuses a bool item (Coll.item_store_type_check #4,#6,#8)', () => {
    expect(() => updated(plainColl(SSHORT, [short(1)]), 0, bool(true))).toThrow(CollClassCast)
    expect(() => updated(plainColl(SINT, [int(1)]), 0, bool(true))).toThrow(CollClassCast)
    expect(() => updated(plainColl(SLONG, [long(1n)]), 0, bool(true))).toThrow(CollClassCast)
  })

  it('plain Coll[Coll[Int]] receiver takes a Coll[Long] item (array class Coll takes any Coll; Review focus 4)', () => {
    const recv = plainColl(collOf(SINT), [plainColl(SINT, [int(1)])])
    const anyColl = plainColl(collOf(SLONG), [long(10n)])
    const out = updated(recv, 0, anyColl)
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Coll' })
    expect(out.items).toEqual([anyColl])
  })

  it('plain Coll[Box] receiver refuses a GroupElement item (Coll.item_store_type_check #11; CollArrayStore)', () => {
    const recv = plainColl(SBOX, [makeBox()])
    expect(() => updated(recv, 0, groupElem())).toThrow(CollArrayStore)
  })

  it('plain Coll[Unit] receiver refuses an Int item (Coll.reference_store_ops #44; array of Unit on a single store is checked)', () => {
    const recv = plainColl(SUNIT, [unit()])
    expect(() => updated(recv, 0, int(1))).toThrow(CollArrayStore)
  })

  it('plain Coll[Unit] receiver takes a Unit item', () => {
    const recv = plainColl(SUNIT, [unit()])
    expect(updated(recv, 0, unit())).toEqual(plainColl(SUNIT, [unit()]))
  })

  it('pairs receiver: a non-pair item fails the pair read (CollClassCast)', () => {
    const recv = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(() => updated(recv, 0, int(0))).toThrow(CollClassCast)
  })

  it('pairs receiver: a pair whose side is of another class fails through side delegation', () => {
    const recv = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    // _1 is Int, not Byte: specialised byte side rejects.
    expect(() => updated(recv, 0, pair(int(0), long(0n)))).toThrow(CollClassCast)
  })

  it('pairs receiver: a matching pair updates each side; result is pairs', () => {
    const recv = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n)), pair(byte(2), long(20n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const out = updated(recv, 0, pair(byte(9), long(90n)))
    expect(out.cls?.shape).toBe('pairs')
    expect(out.items).toEqual([pair(byte(9), long(90n)), pair(byte(2), long(20n))])
  })
})

describe('updateMany — CollsOverArrays.scala:106-117 (CollOverArray) and :436-450 (PairOfCols)', () => {
  it('specialised byte receiver takes byte values', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2), byte(3)])
    expect(updateMany(recv, [0, 2], specColl(SBYTE, [byte(9), byte(8)]))).toEqual(
      specColl(SBYTE, [byte(9), byte(2), byte(8)]),
    )
  })

  it('specialised byte receiver refuses a value of another class (CollClassCast)', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2)])
    expect(() => updateMany(recv, [0], plainColl(SINT, [int(0)]))).toThrow(CollClassCast)
  })

  it('plain Coll[Box] receiver refuses GroupElement values (Coll.updateMany_runtime_item_type #1; CollArrayStore)', () => {
    const recv = plainColl(SBOX, [makeBox()])
    expect(() => updateMany(recv, [0], plainColl(SGROUP, [groupElem()]))).toThrow(CollArrayStore)
  })

  it('plain Coll[Unit] receiver refuses Int values (Coll.reference_store_ops #45; array of Unit direct-store checks)', () => {
    const recv = plainColl(SUNIT, [unit()])
    expect(() => updateMany(recv, [0], plainColl(SINT, [int(1)]))).toThrow(CollArrayStore)
  })

  it('pairs receiver: result has plain sides whatever the receiver sides were', () => {
    const recv = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n)), pair(byte(2), long(20n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const vals = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(9), long(90n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const out = updateMany(recv, [0], vals)
    expect(out.cls).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'long' },
    })
    expect(out.items).toEqual([pair(byte(9), long(90n)), pair(byte(2), long(20n))])
  })

  it('pairs receiver: a non-pair value fails the pair read (CollClassCast)', () => {
    const recv = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n))],
      { shape: 'array', specialised: true, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(() => updateMany(recv, [0], plainColl(SINT, [int(0)]))).toThrow(CollClassCast)
  })
})

describe('append — CollsOverArrays.scala:48-57 (CollOverArray) and :379-382 (PairOfCols)', () => {
  it('empty array receiver returns the other operand with its own class and elem (CollsOverArrays.scala:49)', () => {
    // The third pipeline of Review focus 2.
    const emptyBytes = plainColl(SBYTE, [])
    const other = plainColl(SGROUP, [groupElem()])
    const out = append(emptyBytes, other)
    // The operand is returned as it is.
    expect(out).toBe(other)
    expect(out.elem).toEqual(SGROUP)
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'GroupElement' })
  })

  it('empty specialised byte receiver returns the other operand of another array (SANTA Append.reference_array_store #2)', () => {
    const emptyBytes = specColl(SBYTE, [])
    const other = plainColl(SGROUP, [groupElem()])
    expect(append(emptyBytes, other)).toBe(other)
  })

  it('non-empty specialised byte receiver + operand over another array fails even when empty (Review focus 3; CollClassCast)', () => {
    const recv = specColl(SBYTE, [byte(1)])
    expect(() => append(recv, plainColl(SINT, []))).toThrow(CollClassCast)
    expect(() => append(recv, plainColl(SINT, [int(0)]))).toThrow(CollClassCast)
    expect(() => append(recv, plainColl(SGROUP, []))).toThrow(CollClassCast)
  })

  it('non-empty specialised byte receiver + operand over same primitive array: concatenates, keeps specialisation', () => {
    const recv = specColl(SBYTE, [byte(1), byte(2)])
    const other = specColl(SBYTE, [byte(9)])
    expect(append(recv, other)).toEqual(specColl(SBYTE, [byte(1), byte(2), byte(9)]))
  })

  it('non-empty plain primitive receiver + operand over another array fails even when empty (Coll.append_concat_v6 empty-right; CollArrayStore)', () => {
    const recv = plainColl(SBYTE, [byte(1)])
    expect(() => append(recv, plainColl(SINT, []))).toThrow(CollArrayStore)
    expect(() => append(recv, plainColl(SLONG, [long(0n)]))).toThrow(CollArrayStore)
  })

  it('non-empty plain reference receiver + empty operand of another reference class: accepted (SANTA Append.reference_array_store #0)', () => {
    const recv = plainColl(SGROUP, [groupElem()])
    const other = plainColl(SBOX, [])
    const out = append(recv, other)
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'GroupElement' })
    expect(out.items).toEqual([groupElem()])
  })

  it('non-empty plain reference receiver + non-empty operand of another reference class: fails (CollArrayStore)', () => {
    const recv = plainColl(SGROUP, [groupElem()])
    expect(() => append(recv, plainColl(SBOX, [makeBox()]))).toThrow(CollArrayStore)
  })

  it('non-empty plain reference receiver + primitive operand fails whatever the operand length (CollArrayStore)', () => {
    const recv = plainColl(SGROUP, [groupElem()])
    expect(() => append(recv, plainColl(SBYTE, []))).toThrow(CollArrayStore)
    expect(() => append(recv, plainColl(SBYTE, [byte(0)]))).toThrow(CollArrayStore)
  })

  it('non-empty plain Coll[Unit] + operand over Box fails on the first stored item (Coll.reference_store_ops #46; CollArrayStore)', () => {
    const recv = plainColl(SUNIT, [unit()])
    expect(() => append(recv, plainColl(SBOX, [makeBox()]))).toThrow(CollArrayStore)
  })

  it('plain Object array receiver takes anything (SANTA Append.reference_array_store #11-style, Object-array operand)', () => {
    // SAny → 'Object' array; Object-receiver takes any reference item.
    const recv: SValue = {
      kind: 'Coll',
      elem: SANY,
      items: [int(1)],
      cls: { shape: 'array', specialised: false, array: 'Object' },
    }
    const other = plainColl(SBOX, [])
    const out = append(recv, other)
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Object' })
  })

  it('pairs receiver: unzips the operand; non-pair operand fails (CollClassCast)', () => {
    const recv = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(() => append(recv, plainColl(SINT, [int(0)]))).toThrow(CollClassCast)
  })

  it('EMPTY pairs receiver + non-pair operand still unzips first — the pairs branch runs before any empty-receiver return (PairOfCols.append CollsOverArrays.scala:379-382 has no empty short-circuit; unzip :245-259 reads other.tItem.tFst)', () => {
    const empty = pairsColl(
      pairOf(SBYTE, SLONG),
      [],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    expect(() => append(empty, plainColl(SINT, [int(0)]))).toThrow(CollClassCast)
    expect(() => append(empty, plainColl(SINT, []))).toThrow(CollClassCast)
  })

  it('pairs receiver: a matching pairs operand appends per side, result is pairs', () => {
    const recv = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(1), long(10n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const other = pairsColl(
      pairOf(SBYTE, SLONG),
      [pair(byte(2), long(20n))],
      { shape: 'array', specialised: false, array: 'byte' },
      { shape: 'array', specialised: false, array: 'long' },
    )
    const out = append(recv, other)
    expect(out.cls?.shape).toBe('pairs')
    expect(out.items).toEqual([pair(byte(1), long(10n)), pair(byte(2), long(20n))])
  })

  it('plain CollOverArray[Tuple2] receiver on an operand: result routes to pairs with plain sides (builder.fromArray fromBoxedPairs)', () => {
    const recv = plainColl(pairOf(SBYTE, SLONG), [pair(byte(1), long(10n))])
    const other = plainColl(pairOf(SBYTE, SLONG), [pair(byte(2), long(20n))])
    const out = append(recv, other)
    expect(out.cls).toEqual({
      shape: 'pairs',
      ls: { shape: 'array', specialised: false, array: 'byte' },
      rs: { shape: 'array', specialised: false, array: 'long' },
    })
    expect(out.items).toEqual([pair(byte(1), long(10n)), pair(byte(2), long(20n))])
  })
})

describe('patch — a store into an array of Unit on the ofUnit path holds a unit (Coll.reference_store_ops #40,#41,#56)', () => {
  it('plain Coll[Unit] receiver on a Coll[Int] patch: the Int is coerced to Unit', () => {
    const recv = plainColl(SUNIT, [unit()])
    const p = plainColl(SINT, [int(1)])
    const out = patch(recv, 0, p, 0)
    expect(out.cls).toEqual({ shape: 'array', specialised: false, array: 'Unit' })
    expect(out.items).toEqual([unit(), unit()])
  })

  it('plain Coll[Unit] receiver on a Coll[Box] patch: Box items are coerced to Unit (row #41)', () => {
    const recv = plainColl(SUNIT, [unit()])
    const p = plainColl(SBOX, [makeBox()])
    const out = patch(recv, 0, p, 0)
    expect(out.items).toEqual([unit(), unit()])
  })
})
