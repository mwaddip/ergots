/**
 * `And` and `Or` read their collection item by item: from index 0, up to and including the deciding item (the
 * first `false` for `And`, the first `true` for `Or`), and charge by the count of items read.
 *
 * JVM (sigma-state 6.0.7): `AND.eval` and `OR.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:269-284,
 * :199-214); the charge follows the read
 * (interpreter/shared/src/main/scala/sigmastate/interpreter/CErgoTreeEvaluator.scala:399-417); `PerItemCost(10, 5,
 * 32)` for `AND` (trees.scala:292-293), `PerItemCost(5, 5, 64)` for `OR` (:222-223).
 *
 * The rows are JVM-blessed: SANTA `vectors/eval/v5/authored/AND.item_by_item.json` and `OR.item_by_item.json` at
 * commit 0f2fc79, each named by its row; tree version 0, activated script version 2. A row's tree reads nothing of
 * the context.
 */
import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes } from '../_helpers'

/** Evaluates a row's tree at tree version 0, with a context that holds no pre-header. */
function run(treeHex: string, opts: EvalOpts = {}): { value: SValue; cost: number } {
  const tree = parseTree(hexToBytes(treeHex))
  if (!('constants' in tree)) throw new Error('the row has a parsed tree')
  const ctx = makeContext({ treeVersion: 0, constants: tree.constants, ...opts })
  const value = evaluateWith(tree, ctx)
  return { value, cost: ctx.jitCost }
}

const bool = (value: boolean): SValue => ({ kind: 'Boolean', value })

/** [row, tree bytes, the value answered, the cost] */
const AND_ANSWERED: [string, string, boolean, number][] = [
  // A Coll[Boolean] constant of 100 items, the deciding item at index k (none: every item true).
  ['AND-ladder-L0-none-tv0-a2#0', '00960d00', true, 20],
  ['AND-ladder-L100-none-tv0-a2#28', '00960d64ffffffffffffffffffffffff0f', true, 35],
  ['AND-ladder-L100-k0-tv0-a2#29', '00960d64feffffffffffffffffffffff0f', false, 20],
  ['AND-ladder-L100-k31-tv0-a2#31', '00960d64ffffff7fffffffffffffffff0f', false, 20],
  ['AND-ladder-L100-k32-tv0-a2#32', '00960d64fffffffffeffffffffffffff0f', false, 25],
  ['AND-ladder-L100-k63-tv0-a2#33', '00960d64ffffffffffffff7fffffffff0f', false, 25],
  ['AND-ladder-L100-k64-tv0-a2#34', '00960d64fffffffffffffffffeffffff0f', false, 30],
  ['AND-ladder-L100-k99-tv0-a2#35', '00960d64ffffffffffffffffffffffff07', false, 35],
  // A tuple of three holding an item of another kind behind the deciding item: (false, 5, true), (true, false, "a").
  ['AND-tuple-dKn-Int5-tv0-a2#80', '009648010401000a01', false, 20],
  ['AND-direct-ndK-String-v0-a2#620', '00964801016601000161', false, 20],
  // An empty Coll[Byte]: no item is read.
  ['AND-coll-Coll_Byte_-empty-tv0-a2#136', '00960e00', true, 20],
  // AND(Coll(false, 1 / 1 == 1)): the collection node evaluates both children; the arm reads one item.
  ['AND-expr-d-divone-tv0-a2#149', '00968302010100939d040204020402', false, 73],
]

const OR_ANSWERED: [string, string, boolean, number][] = [
  ['OR-ladder-L0-none-tv0-a2#0', '00970d00', false, 15],
  ['OR-ladder-L100-none-tv0-a2#28', '00970d6400000000000000000000000000', false, 20],
  ['OR-ladder-L100-k0-tv0-a2#29', '00970d6401000000000000000000000000', true, 15],
  ['OR-ladder-L100-k63-tv0-a2#33', '00970d6400000000000000800000000000', true, 15],
  ['OR-ladder-L100-k64-tv0-a2#34', '00970d6400000000000000000100000000', true, 20],
  ['OR-ladder-L100-k99-tv0-a2#35', '00970d6400000000000000000000000008', true, 20],
  // (true, 5, false)
  ['OR-tuple-dKn-Int5-tv0-a2#80', '009748010401010a00', true, 15],
  // An empty Coll[Byte]: no item is read.
  ['OR-coll-Coll_Byte_-empty-tv0-a2#136', '00970e00', false, 15],
]

/** [row, tree bytes]: an item of another kind at an index the arm reads. */
const REFUSED_AT_AN_ITEM: [string, string][] = [
  ['AND-tuple-nKd-Int5-tv0-a2#82', '009648010401010a00'], // (true, 5, false)
  ['AND-tuple-Kdn-Int5-tv0-a2#83', '0096480401010a0001'], // (5, false, true)
  ['AND-coll-Coll_Byte_-one-tv0-a2#137', '00960e0101'], // Coll[Byte](1)
  ['OR-tuple-nKd-Int5-tv0-a2#82', '009748010401000a01'], // (false, 5, true)
  ['OR-tuple-Kdn-Int5-tv0-a2#83', '0097480401010a0100'], // (5, true, false)
  ['OR-coll-Coll_Byte_-one-tv0-a2#137', '00970e0101'], // Coll[Byte](1)
  // A pair is no collection, whatever its first component.
  ['AND-pair-dInt5-tv0-a2#134', '00963d04000a'], // (false, 5)
  ['OR-pair-dInt5-tv0-a2#134', '00973d04010a'], // (true, 5)
]

describe('And reads its collection item by item (AND.item_by_item)', () => {
  for (const [row, tree, value, cost] of AND_ANSWERED) {
    it(`${row}: ${value} at ${cost}`, () => {
      expect(run(tree)).toEqual({ value: bool(value), cost })
    })
  }
})

describe('Or reads its collection item by item (OR.item_by_item)', () => {
  for (const [row, tree, value, cost] of OR_ANSWERED) {
    it(`${row}: ${value} at ${cost}`, () => {
      expect(run(tree)).toEqual({ value: bool(value), cost })
    })
  }
})

describe('And / Or refuse an input that is no collection, and an item of another kind at an index they read', () => {
  for (const [row, tree] of REFUSED_AT_AN_ITEM) {
    it(`${row}: 'coll-not-boolean'`, () => {
      expect(captureEvalError(() => run(tree)).code).toBe('coll-not-boolean')
    })
  }
})

describe('And evaluates its input whole', () => {
  it("AND-expr-d-divzero-tv0-a2#148: AND(Coll(false, 1 / 0 == 1)) evaluates the child behind the deciding item: 'arith-divide-by-zero'", () => {
    expect(captureEvalError(() => run('00968302010100939d040204000402')).code).toBe('arith-divide-by-zero')
  })
})

describe('And under a cost limit: the charge is for the items read', () => {
  // AND-ladder-L100-k0-tv0-a2#29: 100 items, the first false; the cost is 20.
  const TREE = '00960d64feffffffffffffffffffffff0f'

  it('a limit of 20 answers false at 20', () => {
    expect(run(TREE, { jitCostLimit: 20 })).toEqual({ value: bool(false), cost: 20 })
  })

  it("a limit of 19 is 'cost-limit-exceeded'", () => {
    expect(captureEvalError(() => run(TREE, { jitCostLimit: 19 })).code).toBe('cost-limit-exceeded')
  })
})

describe('Or under a cost limit: the charge is for the items read', () => {
  // OR-ladder-L100-k0-tv0-a2#29: 100 items, the first true; the cost is 15.
  const TREE = '00970d6401000000000000000000000000'

  it('a limit of 15 answers true at 15', () => {
    expect(run(TREE, { jitCostLimit: 15 })).toEqual({ value: bool(true), cost: 15 })
  })

  it("a limit of 14 is 'cost-limit-exceeded'", () => {
    expect(captureEvalError(() => run(TREE, { jitCostLimit: 14 })).code).toBe('cost-limit-exceeded')
  })
})
