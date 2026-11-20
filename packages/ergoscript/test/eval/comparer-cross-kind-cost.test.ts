/**
 * The comparer's cross-kind arm charges by the LEFT value's kind, as the
 * JVM's `DataValueComparer.equalDataValues` does
 * (`data/shared/src/main/scala/sigma/data/DataValueComparer.scala:310-340`):
 *
 *   - left is a `Coll[_]`: `MatchType` (1) is charged before the inner match
 *     (`:316-327`); returns false where the right is not a `Coll`.
 *   - left is a `Tuple2`: `EQ_Tuple` (4) is charged (`:329-337`); returns
 *     false where the right is not a `Tuple2`.
 *   - otherwise: the arm's own fixed cost runs; for the primitive arms this
 *     is `EQ_Prim` (3), which also returns false on a different right.
 *
 * ergots mirrors cases 1 and 2 at the cross-kind catch-all; the primitive
 * default stays `EQ_Prim`.
 */
import { describe, it, expect } from 'vitest'
import { sValueEquals } from '../../src/eval/bin-op/relation'
import { makeContext } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import type { SValue } from '../../src/mir/types'

describe('comparer cross-kind cost (DataValueComparer.scala:316-337 at 6.0.7)', () => {
  it('left Coll, right Tuple: charges MatchType (1) and returns false', () => {
    const coll: SValue = tupleColl([
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
    ])
    const tup: SValue = {
      kind: 'Tuple',
      items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }],
    }
    const ctx = makeContext()
    const eq = sValueEquals(coll, tup, ctx)
    expect(eq).toBe(false)
    expect(ctx.jitCost).toBe(1)
  })

  it('left Tuple, right Coll: charges EQ_Tuple (4) and returns false', () => {
    const coll: SValue = tupleColl([
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
    ])
    const tup: SValue = {
      kind: 'Tuple',
      items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }],
    }
    const ctx = makeContext()
    const eq = sValueEquals(tup, coll, ctx)
    expect(eq).toBe(false)
    expect(ctx.jitCost).toBe(4)
  })

  it('left Int, right Coll (unchanged primitive default): charges EQ_Prim (3) and returns false', () => {
    const coll: SValue = tupleColl([{ kind: 'Int', value: 1 }])
    const ctx = makeContext()
    const eq = sValueEquals({ kind: 'Int', value: 1 }, coll, ctx)
    expect(eq).toBe(false)
    expect(ctx.jitCost).toBe(3)
  })
})
