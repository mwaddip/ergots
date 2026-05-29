/**
 * Coll equality per-item cost for SAvlTree/SBox/SHeader/SPreHeader (iter-20).
 *
 * Root cause (mainnet h=972,275 tx 4 input 0, cost-drift +9): comparing two
 * `Coll[SAvlTree]` of length 3 charged our `EQ_COLL_DEFAULT_PER_ITEM` (10,2,1)
 * = 10 + 2*ceil(3/1) = 16, but sigma-rust's `coll_eq_cost`
 * (data_value_comparer.rs:151) dispatches `SAvlTree => EQ_COLL_AVL_TREE_PER_ITEM`
 * (15,5,2) = 15 + 5*ceil(3/2) = 25. Plus the always-paid COLL_MATCH_TYPE_COST(1):
 * ours 17 vs sigma-rust 26 → under by 9.
 *
 * Our `collEqPerItemCost` was missing the SAvlTree/SBox/SPreHeader/SHeader
 * dispatch arms (present in sigma-rust), so all four fell through to DEFAULT.
 * Fix adds the four per-item cost kinds verbatim from data_value_comparer.rs.
 */

import { describe, it, expect } from 'vitest'
import { sValueEquals } from '../../src/eval/bin-op/relation'
import { makeContext } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'

const avlTreeValue = (): SValue => ({
  kind: 'AvlTree',
  value: { digest: new Uint8Array(33), treeFlags: 0, keyLength: 32, valueLengthOpt: null },
})

const collOfAvlTrees = (n: number): SValue => ({
  kind: 'Coll',
  elem: { tag: 'SAvlTree' },
  items: Array.from({ length: n }, avlTreeValue),
})

describe('Coll[AvlTree] equality cost (iter-20)', () => {
  it('uses EQ_COLL_AVL_TREE_PER_ITEM (15,5,2), not DEFAULT — exact mainnet case (n=3)', () => {
    const ctx = makeContext()
    const eq = sValueEquals(collOfAvlTrees(3), collOfAvlTrees(3), ctx)
    expect(eq).toBe(true)
    // COLL_MATCH_TYPE_COST(1) + (15 + 5*ceil(3/2)) = 1 + 25 = 26.
    // Pre-fix (DEFAULT 10,2,1): 1 + (10 + 2*3) = 17.
    expect(ctx.jitCost).toBe(26)
  })
})
