/**
 * Or arm — the disjunction of a collection of Booleans, read item by item.
 *
 * The input is evaluated whole. The arm then reads its items from index 0 and stops after the first `true`; the
 * result is `true` when it found one and `false` when it read every item (an empty collection is `false`). The
 * cost is charged once, after the read, by the count of items read.
 *
 * JVM (sigma-state 6.0.7): `OR.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:199-214). The loop is
 * `while (i < len && !res) { res ||= inputV(i); i += 1 }` and its result is `i`; the cost block adds the cost after
 * the loop returns
 * (interpreter/shared/src/main/scala/sigmastate/interpreter/CErgoTreeEvaluator.scala:399-417). The cost kind is
 * `PerItemCost(5, 5, 64)` (trees.scala:222-223): its base and its chunk size differ from `AND`'s.
 *
 * An item is tested for its kind where the arm reads it: the JVM casts `inputV(i)` to Boolean at the read. An item
 * of another kind behind the deciding item is not read and refuses nothing. A tuple of another arity than two is a
 * collection here; a pair is not.
 *
 * Error codes:
 *   'coll-not-boolean'    — the input is no collection, or the item read is no Boolean
 *   'cost-limit-exceeded' — the cost exceeds jitCostLimit
 */

import type { Or, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// `PerItemCost(baseCost = JitCost(5), perChunkCost = JitCost(5), chunkSize = 64)`, trees.scala:222-223.
const OR_BASE_COST = 5
const OR_PER_CHUNK_COST = 5
const OR_CHUNK_SIZE = 64

export function evalOr(e: Or, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Coll') {
    throw new EvalError(
      `Or: expected Coll[Boolean] input, got '${input.kind}'`,
      'coll-not-boolean'
    )
  }
  const items = input.items
  let result = false
  let read = 0
  while (read < items.length && !result) {
    const item = items[read]!
    if (item.kind !== 'Boolean') {
      throw new EvalError(
        `Or: Coll item ${read} has kind '${item.kind}', expected 'Boolean'`,
        'coll-not-boolean'
      )
    }
    result = item.value
    read++
  }
  ctx.addPerItemCost(OR_BASE_COST, OR_PER_CHUNK_COST, OR_CHUNK_SIZE, read)
  return { kind: 'Boolean', value: result }
}
