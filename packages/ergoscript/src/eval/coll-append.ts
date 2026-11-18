/**
 * `Append` evaluator arm — concatenation of two collections, routed through
 * the collection module's `append`.
 *
 * Source: `data/shared/src/main/scala/sigma/ast/transformers.scala:59-70` at
 * sigma-state 6.0.7.
 *     val inputV = input.evalTo[Coll[IV#WrappedType]](env)
 *     val col2V = col2.evalTo[Coll[IV#WrappedType]](env)
 *     addSeqCost(Append.costKind, inputV.length + col2V.length) { () =>
 *       inputV.append(col2V)
 *     }
 *
 * Cost: `Append.costKind = PerItemCost(baseCost = 20, perChunkCost = 2,
 * chunkSize = 100)` (:76), nItems = inputV.length + col2V.length.
 * `addSeqCost` charges the cost before invoking the operation
 * (`interpreter/shared/src/main/scala/sigmastate/interpreter/
 *  CErgoTreeEvaluator.scala:370-392`): `coster.add(costKind.cost(nItems))`
 * runs before `block()`.
 *
 * The result's class, `elem` and item store rules come from the module's
 * `append`: on an EMPTY receiver the operand is returned UNREAD (its own
 * class and `elem`); on a non-empty specialised receiver an operand over
 * another array fails (`'coll-class-cast'`); on a non-empty plain primitive
 * receiver an operand over another array fails (`'coll-array-store'`); on
 * a plain reference receiver a per-item check applies; on a pairs receiver
 * the operand is unzipped and each side's `append` applies.
 */

import type { Append, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { append as collAppend } from './_coll'

const COLL_APPEND_BASE = 20
const COLL_APPEND_PER_CHUNK = 2
const COLL_APPEND_CHUNK_SIZE = 100

/**
 * Evaluate an `Append` node.
 *
 * @throws EvalError `'coll-input-not-coll'` if either operand is not a Coll.
 * @throws EvalError `'coll-class-cast'` / `'coll-array-store'` from the
 *   module's `append` facade.
 * @throws EvalError `'cost-limit-exceeded'` if `addPerItemCost` exceeds the
 *   limit.
 */
export function evalAppend(e: Append, env: Env, ctx: EvalContext): SValue {
  const inputVal = evalExpr(e.input, env, ctx)
  const col2Val = evalExpr(e.col2, env, ctx)
  if (inputVal.kind !== 'Coll') {
    throw new EvalError(
      `Append: expected a Coll input, got '${inputVal.kind}'`,
      'coll-input-not-coll',
    )
  }
  if (col2Val.kind !== 'Coll') {
    throw new EvalError(
      `Append: expected a Coll col2, got '${col2Val.kind}'`,
      'coll-input-not-coll',
    )
  }
  ctx.addPerItemCost(
    COLL_APPEND_BASE,
    COLL_APPEND_PER_CHUNK,
    COLL_APPEND_CHUNK_SIZE,
    inputVal.items.length + col2Val.items.length,
  )
  return collAppend(inputVal, col2Val)
}
