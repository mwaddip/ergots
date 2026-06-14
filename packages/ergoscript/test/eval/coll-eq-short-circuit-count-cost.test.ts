/**
 * Coll/composite equality charges the per-item cost on the count of elements
 * ACTUALLY COMPARED before the first inequality — NOT on the full collection
 * length — matching the JVM's charge-AFTER-loop semantics.
 *
 * JVM canonical (`~/projects/sigmastate-interpreter/`):
 *   CErgoTreeEvaluator.scala:399-421 — `addSeqCost(costKind, opDesc)(block: () => Int)`
 *     runs `nItems = block()` FIRST (the compare loop, returning the count of
 *     items actually compared), THEN charges `costKind.cost(nItems)`.
 *   DataValueComparer.scala:159-176 (`equalCOA_Prim`, COA-leaf bulk path) and
 *     :183-196 (`equalColls`, composite/recursive path) both run a
 *     `while (i < len && okEqual)` loop and `return i` — so on first inequality
 *     at 0-based index j the returned count is j+1, and on full equality it is
 *     len. The charged cost is therefore `cost(j+1)` (short-circuit) or
 *     `cost(len)` (equal).
 *
 * `PerItemCost.cost(n) = base + perChunk * ((n-1)/chunkSize + 1)`. The formula +
 * constants already byte-match ergots (`addPerItemJitCost`); ONLY the `n` fed in
 * was wrong — ergots used the full length eagerly before the loop. This bites
 * whenever a short-circuit crosses a per-item chunk boundary (or, for the
 * composite path, whenever the per-chunk delta between full-len and
 * compared-count is nonzero — DEFAULT chunkSize is 1, so every short-circuit
 * over-charged).
 *
 * Real mainnet/testnet trigger: testnet h=28931 tx
 * 20892b8520d7c5243bdd5ad0093288b10a1fca7e062d1f96997046979423ed1b input 0 — a
 * `Coll[Coll[Byte]]` n=4 unequal at element 0. JVM charges the OUTER per-item on
 * count=1 (`cost(1)=12`, DEFAULT base 10 + perChunk 2 * 1 chunk); ergots charged
 * `cost(4)=18` (4 chunks) → +6 over-charge (610 vs JVM 604).
 */

import { describe, it, expect } from 'vitest'
import { sValueEquals } from '../../src/eval/bin-op/relation'
import { makeContext } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'

function vByte(n: number): SValue { return { kind: 'Byte', value: n } }
function vInt(n: number): SValue { return { kind: 'Int', value: n } }
function collOfBytes(...ns: number[]): SValue {
  return { kind: 'Coll', elem: { tag: 'SByte' }, items: ns.map(vByte) }
}
function collOfInts(...ns: number[]): SValue {
  return { kind: 'Coll', elem: { tag: 'SInt' }, items: ns.map(vInt) }
}
function collOfCollBytes(rows: number[][]): SValue {
  return {
    kind: 'Coll',
    elem: { tag: 'SColl', elem: { tag: 'SByte' } },
    items: rows.map((r) => collOfBytes(...r)),
  }
}

describe('Coll equality — composite path charges per-item on compared count (h=28931)', () => {
  it('Coll[Coll[Byte]] n=4 unequal at element 0: outer per-item charged on count=1, not 4', () => {
    // a, b differ only at element 0's first inner byte (1 vs 9). The outer loop
    // recurses element 0, finds the inner colls unequal, and short-circuits —
    // having compared exactly 1 outer element.
    const a = collOfCollBytes([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]])
    const b = collOfCollBytes([[9, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]])

    const ctx = makeContext({})
    expect(sValueEquals(a, b, ctx)).toBe(false)

    // Expected (JVM, charge-after-loop on compared count):
    //   outer COLL_MATCH_TYPE_COST          = 1
    //   recurse element 0 (inner Coll[Byte], differ at byte 0):
    //     inner COLL_MATCH_TYPE_COST        = 1
    //     inner COA byte cost(compared=1)   = 15 + 2*((1-1)/128+1) = 17
    //   outer per-item DEFAULT cost(compared=1) = 10 + 2*((1-1)/1+1) = 12
    //   total                               = 1 + 1 + 17 + 12 = 31
    // BUG charged outer DEFAULT cost(4) = 10 + 2*4 = 18 eagerly → total 37.
    expect(ctx.jitCost).toBe(31)
  })

  it('Coll[Coll[Byte]] n=4 FULLY EQUAL: per-item charged on full count=4 (no over-correction)', () => {
    const rows = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]
    const a = collOfCollBytes(rows)
    const b = collOfCollBytes(rows.map((r) => [...r]))

    const ctx = makeContext({})
    expect(sValueEquals(a, b, ctx)).toBe(true)

    // outer COLL_MATCH                       = 1
    // 4 * [inner COLL_MATCH 1 + inner byte cost(3)=17] = 4 * 18 = 72
    // outer per-item DEFAULT cost(4) = 10 + 2*4 = 18
    // total = 1 + 72 + 18 = 91
    expect(ctx.jitCost).toBe(91)
  })

  it('Coll[Coll[Byte]] n=4 unequal at element 2: outer per-item charged on count=3', () => {
    const a = collOfCollBytes([[1], [2], [3], [4]])
    const b = collOfCollBytes([[1], [2], [9], [4]])

    const ctx = makeContext({})
    expect(sValueEquals(a, b, ctx)).toBe(false)

    // outer COLL_MATCH = 1
    // elements 0,1 EQUAL (recurse, each: inner COLL_MATCH 1 + byte cost(1)=17 = 18) → 36
    // element 2 UNEQUAL (recurse: inner COLL_MATCH 1 + byte cost(1)=17 = 18) → 18
    // outer per-item DEFAULT cost(compared=3) = 10 + 2*((3-1)/1+1) = 10 + 2*3 = 16
    // total = 1 + 36 + 18 + 16 = 71
    expect(ctx.jitCost).toBe(71)
  })
})

describe('Coll equality — COA-leaf path charges per-item on compared count across chunk boundary', () => {
  it('Coll[Int] n=65 unequal at index 0: charged on count=1 (1 chunk), not 65 (2 chunks)', () => {
    const aInts = Array.from({ length: 65 }, (_, i) => i)
    const bInts = [...aInts]; bInts[0] = 9999
    const a = collOfInts(...aInts)
    const b = collOfInts(...bInts)

    const ctx = makeContext({})
    expect(sValueEquals(a, b, ctx)).toBe(false)

    // COLL_MATCH = 1
    // COA Int cost(compared=1) = 15 + 2*((1-1)/64+1) = 15 + 2 = 17
    // total = 18
    // BUG charged cost(65) = 15 + 2*((65-1)/64+1) = 15 + 4 = 19 → total 20.
    expect(ctx.jitCost).toBe(18)
  })

  it('Coll[Int] n=65 FULLY EQUAL: charged on full count=65 (2 chunks) (no over-correction)', () => {
    const ints = Array.from({ length: 65 }, (_, i) => i)
    const a = collOfInts(...ints)
    const b = collOfInts(...ints)

    const ctx = makeContext({})
    expect(sValueEquals(a, b, ctx)).toBe(true)

    // COLL_MATCH = 1 + COA Int cost(65) = 15 + 2*2 = 19 → total 20
    expect(ctx.jitCost).toBe(20)
  })

  it('Coll[Int] n=65 unequal at index 64 (last): charged on count=65 (2 chunks)', () => {
    const aInts = Array.from({ length: 65 }, (_, i) => i)
    const bInts = [...aInts]; bInts[64] = 9999
    const a = collOfInts(...aInts)
    const b = collOfInts(...bInts)

    const ctx = makeContext({})
    expect(sValueEquals(a, b, ctx)).toBe(false)

    // last element differs → compared count = 65 → cost(65) = 19; total = 20
    expect(ctx.jitCost).toBe(20)
  })

  it('Coll[Byte] n=4 unequal at byte 0: count=1 same chunk as count=4 (no change, chunkSize 128)', () => {
    const a = collOfBytes(1, 2, 3, 4)
    const b = collOfBytes(9, 2, 3, 4)

    const ctx = makeContext({})
    expect(sValueEquals(a, b, ctx)).toBe(false)

    // COLL_MATCH 1 + byte cost(1) = 15 + 2 = 17 → 18 (cost(4) is also 18, cs 128)
    expect(ctx.jitCost).toBe(18)
  })
})
