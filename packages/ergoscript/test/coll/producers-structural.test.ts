/**
 * Every structural producer sets the JVM's class on the collection it builds.
 *
 * JVM references at 6.0.7:
 *   CoreDataSerializer.scala:166-191                 deserializeColl
 *   core/.../sigma/ast/values.scala:887-898          ConcreteCollection.eval
 *   core/.../sigma/ast/transformers.scala:94-101     Slice.eval
 *   core/.../sigma/ast/transformers.scala:64-71      Filter.eval
 *   core/.../sigma/ast/transformers.scala:40-46      MapCollection.eval
 *   core/.../sigma/ast/methods.scala:1000-1008       SColl.flatMap
 *   core/.../sigma/ast/methods.scala:1120-1141       SColl.reverse (v6)
 *   core/.../sigma/data/CollsOverArrays.scala:40,68  CollOverArray.slice/indices
 *   core/.../sigma/data/CollsOverArrays.scala:42,59  CollOverArray.zip/reverse
 *   core/.../sigma/data/CollsOverArrays.scala:183-215, 226-233, 274, 317-324
 *                                                    the builder and PairOfCols
 */

import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { classOf, type CollClass, type CollValue } from '../../src/coll'
import { parseSValue } from '../../src/wire/parse-svalue'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr, SType, SValue } from '../../src/mir/types'
import {
  bool,
  bytes,
  int,
  Coll as CollE,
  MC,
  PC,
  Slice,
  Tuple as TupleE,
  T,
  ValUse,
} from '../_helpers/mir-build'
import { hexToBytes } from '../_helpers'

// ─── helpers ───────────────────────────────────────────────────────────────

/** A one-argument FuncValue at arg type `tDom`. */
function lam(tDom: SType, body: Expr, argId = 1): Expr {
  return { tag: 'FuncValue', args: [{ id: argId, tpe: tDom }], body }
}

/** Evaluate an Expr at the given tree version. */
function runAt(e: Expr, treeVersion: number): SValue {
  const ctx = makeContext({ treeVersion })
  return evalExpr(e, Env.empty(), ctx)
}

/** Narrow an SValue to a CollValue. */
function asColl(v: SValue): CollValue {
  if (v.kind !== 'Coll') throw new Error(`asColl: ${v.kind}`)
  return v
}

// Common classes.
const PLAIN_BYTE: CollClass = { shape: 'array', specialised: false, array: 'byte' }
const SPEC_BYTE: CollClass = { shape: 'array', specialised: true, array: 'byte' }
const SPEC_BOOL: CollClass = { shape: 'array', specialised: true, array: 'boolean' }
const PLAIN_INT: CollClass = { shape: 'array', specialised: false, array: 'int' }
const SPEC_INT: CollClass = { shape: 'array', specialised: true, array: 'int' }
const PLAIN_LONG: CollClass = { shape: 'array', specialised: false, array: 'long' }
const PLAIN_COLL: CollClass = { shape: 'array', specialised: false, array: 'Coll' }

// ─── the data reader ───────────────────────────────────────────────────────

describe('data reader (deserializeColl :166-191)', () => {
  // A Coll[Byte] constant: tag 0x0e (Const, SColl), element tag 0x02 (SByte),
  // length 3, bytes 01 02 03. The data reader specialises for SByte (:174).
  it('a Coll[Byte] constant is specialised', () => {
    const r = new ByteReader(hexToBytes('02030102fd'))
    const t: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
    const v = parseSValue(t, 0, r)
    expect(classOf(asColl(v))).toEqual(SPEC_BYTE)
  })

  it('a Coll[Boolean] constant is specialised', () => {
    // Boolean bit-packed: length 3, one byte with bits 0b00000101 → [true, false, true]
    const r = new ByteReader(hexToBytes('0305'))
    const t: SType = { tag: 'SColl', elem: { tag: 'SBoolean' } }
    const v = parseSValue(t, 0, r)
    expect(classOf(asColl(v))).toEqual(SPEC_BOOL)
  })

  it('a Coll[Int] constant is plain over int', () => {
    // Int items are ZigZag-VLQ. length 2, 0, 2 (= 1).
    const r = new ByteReader(hexToBytes('020002'))
    const t: SType = { tag: 'SColl', elem: { tag: 'SInt' } }
    const v = parseSValue(t, 0, r)
    expect(classOf(asColl(v))).toEqual(PLAIN_INT)
  })

  it('a Coll[(Int, Int)] constant is pairs with plain sides', () => {
    // length 1, item 1 (ZigZag 2), 2 (ZigZag 4).
    const r = new ByteReader(hexToBytes('010204'))
    const pairT: SType = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }] }
    const t: SType = { tag: 'SColl', elem: pairT }
    const v = parseSValue(t, 0, r)
    expect(classOf(asColl(v))).toEqual({
      shape: 'pairs',
      ls: PLAIN_INT,
      rs: PLAIN_INT,
    })
  })

  it('a Coll[Coll[Byte]] constant: plain outer, specialised inner', () => {
    // length 1, inner length 2, bytes 01 02.
    const r = new ByteReader(hexToBytes('01020102'))
    const t: SType = { tag: 'SColl', elem: { tag: 'SColl', elem: { tag: 'SByte' } } }
    const v = parseSValue(t, 0, r)
    const outer = asColl(v)
    expect(classOf(outer)).toEqual(PLAIN_COLL)
    const inner = asColl(outer.items[0]!)
    expect(classOf(inner)).toEqual(SPEC_BYTE)
  })
})

// ─── the collection expression ─────────────────────────────────────────────

describe('collection expression (ConcreteCollection.eval, values.scala:887-898)', () => {
  it('a Coll[Int] expression is plain over int', () => {
    const v = runAt(CollE(T.Int, [int(1), int(2)]), 0)
    expect(classOf(asColl(v))).toEqual(PLAIN_INT)
  })

  it('a Coll[Byte] expression is PLAIN (not the data reader\'s specialised)', () => {
    const byteConst: Expr = {
      tag: 'Const',
      tpe: T.Byte,
      value: { kind: 'Byte', value: 1 },
    }
    const v = runAt(CollE(T.Byte, [byteConst]), 0)
    // ConcreteCollection.eval builds directly from items, NOT through the
    // specialised fromArray — it calls Colls.fromArray at an abstract type.
    expect(classOf(asColl(v))).toEqual(PLAIN_BYTE)
  })

  it('an empty Coll[Long] expression is plain over long', () => {
    const v = runAt(CollE(T.Long, []), 0)
    expect(classOf(asColl(v))).toEqual(PLAIN_LONG)
  })

  it('a Coll[(Int, Int)] expression is pairs with plain sides', () => {
    const pairT = T.Tuple(T.Int, T.Int)
    const expr = CollE(pairT, [TupleE(int(1), int(2))])
    const v = runAt(expr, 0)
    expect(classOf(asColl(v))).toEqual({
      shape: 'pairs',
      ls: PLAIN_INT,
      rs: PLAIN_INT,
    })
  })
})

// ─── Slice ─────────────────────────────────────────────────────────────────

describe('Slice (transformers.scala:94-101 → CollOverArray/PairOfCols.slice)', () => {
  it('Slice on a specialised byte constant stays specialised', () => {
    const v = runAt(Slice(bytes([1, 2, 3, 4]), int(0), int(2)), 0)
    expect(classOf(asColl(v))).toEqual(SPEC_BYTE)
  })

  it('Slice on a plain collection expression stays plain', () => {
    const v = runAt(Slice(CollE(T.Int, [int(1), int(2), int(3)]), int(0), int(2)), 0)
    expect(classOf(asColl(v))).toEqual(PLAIN_INT)
  })
})

// ─── Filter ────────────────────────────────────────────────────────────────

describe('Filter (transformers.scala:64-71 → CollOverArray/PairOfCols.filter)', () => {
  it('Filter on a specialised byte constant stays specialised', () => {
    // A constant-true lambda over Byte.
    const condition = lam(T.Byte, bool(true))
    const e: Expr = { tag: 'Filter', input: bytes([1, 2, 3]), condition }
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual(SPEC_BYTE)
  })

  it('Filter on a plain collection expression stays plain', () => {
    // A constant-true lambda over Int.
    const condition = lam(T.Int, bool(true))
    const e: Expr = { tag: 'Filter', input: CollE(T.Int, [int(1), int(2)]), condition }
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual(PLAIN_INT)
  })
})

// ─── MapCollection ─────────────────────────────────────────────────────────

describe('MapCollection (transformers.scala:40-46 → map()) always plain', () => {
  it('map(x => x) over bytes gives PLAIN over byte', () => {
    const mapper = lam(T.Byte, ValUse(1, T.Byte))
    const e: Expr = { tag: 'Map', input: bytes([1, 2]), mapper }
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual(PLAIN_BYTE)
  })

  it('map(x => (x, x)) gives PAIRS with plain sides', () => {
    const pairT = T.Tuple(T.Int, T.Int)
    const mapper: Expr = {
      tag: 'FuncValue',
      args: [{ id: 1, tpe: T.Int }],
      body: TupleE(ValUse(1, T.Int), ValUse(1, T.Int)),
    }
    const e: Expr = { tag: 'Map', input: CollE(T.Int, [int(1), int(2)]), mapper }
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual({
      shape: 'pairs',
      ls: PLAIN_INT,
      rs: PLAIN_INT,
    })
    // sanity: elem matches the tRange
    expect(asColl(v).elem).toEqual(pairT)
  })
})

// ─── flatMap ───────────────────────────────────────────────────────────────

describe('SColl.flatMap (methods.scala:1000-1008 → map/flatMap) always plain', () => {
  it('flatMap on a byte input, body returning a byte collection, gives plain byte', () => {
    // flatMap is MethodCall 12:15. Body is `.indices` — a PropertyCall on the
    // byte element that returns `Coll[Int]`. We want a flat byte result though;
    // use a lambda body that returns the byte constant itself.
    const body: Expr = bytes([1, 2])
    const mapper = lam(T.Byte, body)
    const e: Expr = MC(12, 15, bytes([0]), [mapper])
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual(PLAIN_BYTE)
  })
})

// ─── reverse (12:30) ───────────────────────────────────────────────────────

describe('SColl.reverse v6 (methods.scala:1120-1141 → reverse)', () => {
  it('reverse on a specialised byte constant stays specialised', () => {
    const e: Expr = PC(12, 30, bytes([1, 2, 3]))
    const v = runAt(e, 3)
    expect(classOf(asColl(v))).toEqual(SPEC_BYTE)
  })

  it('reverse of a MAPPED pair collection restores the pair shape', () => {
    // map a plain Int coll through `(x, x)` to get a plain CollOverArray[Tuple2],
    // then reverse to a CollOverArray with pair routing → pairs with plain sides.
    const mapper: Expr = {
      tag: 'FuncValue',
      args: [{ id: 1, tpe: T.Int }],
      body: TupleE(ValUse(1, T.Int), ValUse(1, T.Int)),
    }
    const mapped: Expr = { tag: 'Map', input: CollE(T.Int, [int(1), int(2)]), mapper }
    const reversed: Expr = PC(12, 30, mapped)
    const v = runAt(reversed, 3)
    expect(classOf(asColl(v))).toEqual({
      shape: 'pairs',
      ls: PLAIN_INT,
      rs: PLAIN_INT,
    })
  })
})

// ─── indices (12:14) ───────────────────────────────────────────────────────

describe('SColl.indices (CollsOverArrays.scala:68) always specialised Coll[Int]', () => {
  it('indices on a byte collection is a specialised Coll[Int]', () => {
    const e: Expr = PC(12, 14, bytes([1, 2, 3]))
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual(SPEC_INT)
  })

  it('indices on a pair collection is a specialised Coll[Int]', () => {
    // A pair constant from a map; use a synthesized trivial pair collection expression.
    const pairT = T.Tuple(T.Int, T.Int)
    const pairs = CollE(pairT, [TupleE(int(1), int(2)), TupleE(int(3), int(4))])
    const e: Expr = PC(12, 14, pairs)
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual(SPEC_INT)
  })
})

// ─── zip (12:29) ───────────────────────────────────────────────────────────

describe('SColl.zip (CollsOverArrays.scala:42 → pairColl)', () => {
  it('zip of two specialised byte constants gives pairs with two specialised sides', () => {
    const left = bytes([1, 2, 3])
    const right = bytes([4, 5, 6])
    const e: Expr = MC(12, 29, left, [right])
    const v = runAt(e, 0)
    expect(classOf(asColl(v))).toEqual({
      shape: 'pairs',
      ls: SPEC_BYTE,
      rs: SPEC_BYTE,
    })
  })

  it('zip of unequal lengths cuts the longer side with its own slice', () => {
    const left = bytes([1, 2]) // len 2
    const right = bytes([4, 5, 6, 7]) // len 4 → cut to 2
    const e: Expr = MC(12, 29, left, [right])
    const v = runAt(e, 0)
    const cls = classOf(asColl(v))
    expect(cls.shape).toBe('pairs')
    expect(asColl(v).items).toHaveLength(2)
    // each side keeps its class (specialised byte).
    expect((cls as { ls: CollClass }).ls).toEqual(SPEC_BYTE)
    expect((cls as { rs: CollClass }).rs).toEqual(SPEC_BYTE)
  })
})

