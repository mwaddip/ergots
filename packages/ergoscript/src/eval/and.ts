/**
 * And arm — the conjunction of a collection of Booleans, read item by item.
 *
 * The input is evaluated whole. The arm then reads its items from index 0 and stops after the first `false`; the
 * result is `false` when it found one and `true` when it read every item (an empty collection is `true`). The cost
 * is charged once, after the read, by the count of items read.
 *
 * JVM (sigma-state 6.0.7): `AND.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:269-284). The loop is
 * `while (i < len && res) { res &&= inputV(i); i += 1 }` and its result is `i`; the cost block adds the cost after
 * the loop returns
 * (interpreter/shared/src/main/scala/sigmastate/interpreter/CErgoTreeEvaluator.scala:399-417). The cost kind is
 * `PerItemCost(10, 5, 32)` (trees.scala:292-293).
 *
 * An item is tested for its kind where the arm reads it: the JVM casts `inputV(i)` to Boolean at the read. An item
 * of another kind behind the deciding item is not read and refuses nothing. A tuple of another arity than two is a
 * collection here; a pair is not.
 *
 * Error codes:
 *   'coll-not-boolean'    — the input is no collection, or the item read is no Boolean
 *   'cost-limit-exceeded' — the cost exceeds jitCostLimit
 */

import type { And, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// `PerItemCost(baseCost = JitCost(10), perChunkCost = JitCost(5), chunkSize = 32)`, trees.scala:292-293.
const AND_BASE_COST = 10
const AND_PER_CHUNK_COST = 5
const AND_CHUNK_SIZE = 32

export function evalAnd(e: And, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Coll') {
    throw new EvalError(
      `And: expected Coll[Boolean] input, got '${input.kind}'`,
      'coll-not-boolean'
    )
  }
  const items = input.items
  let result = true
  let read = 0
  while (read < items.length && result) {
    const item = items[read]!
    if (item.kind !== 'Boolean') {
      throw new EvalError(
        `And: Coll item ${read} has kind '${item.kind}', expected 'Boolean'`,
        'coll-not-boolean'
      )
    }
    result = item.value
    read++
  }
  ctx.addPerItemCost(AND_BASE_COST, AND_PER_CHUNK_COST, AND_CHUNK_SIZE, read)
  return { kind: 'Boolean', value: result }
}
