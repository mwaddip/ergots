/**
 * XorOf arm — the exclusive or of a collection of Booleans.
 *
 * The input is evaluated, the cost is charged by the collection's length, and the result is the exclusive or of
 * all the items: `false` for an empty collection, `true` for an odd count of `true` items. The tree's version is
 * not read.
 *
 * JVM (sigma-state 6.0.7): `XorOf.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:238-245) charges
 * `PerItemCost(20, 5, 32)` (:253-254) by `inputV.length` and calls `xorOf`
 * (data/shared/src/main/scala/sigma/data/CSigmaDslBuilder.scala:116-127), which reads every item at the block's
 * activated script version 2 and above.
 *
 * Every item is read, so an item of another kind in any position refuses the call. A tuple of another arity than
 * two is a collection here; a pair is not.
 *
 * Error codes:
 *   'coll-not-boolean'    — the input is no collection, or an item is no Boolean
 *   'cost-limit-exceeded' — the cost exceeds jitCostLimit
 */

import type { SValue, XorOf } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// `PerItemCost(baseCost = JitCost(20), perChunkCost = JitCost(5), chunkSize = 32)`, trees.scala:253-254.
const XOR_OF_BASE_COST = 20
const XOR_OF_PER_CHUNK_COST = 5
const XOR_OF_CHUNK_SIZE = 32

export function evalXorOf(e: XorOf, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Coll') {
    throw new EvalError(
      `XorOf: expected Coll[Boolean] input, got '${input.kind}'`,
      'coll-not-boolean'
    )
  }
  const items = input.items
  let result = false
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind !== 'Boolean') {
      throw new EvalError(
        `XorOf: Coll item ${i} has kind '${item.kind}', expected 'Boolean'`,
        'coll-not-boolean'
      )
    }
    result = result !== item.value
  }
  ctx.addPerItemCost(XOR_OF_BASE_COST, XOR_OF_PER_CHUNK_COST, XOR_OF_CHUNK_SIZE, items.length)
  return { kind: 'Boolean', value: result }
}
