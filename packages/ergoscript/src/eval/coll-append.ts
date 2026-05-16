/**
 * Append evaluator arm (phase 2f Coll HOFs Task 3).
 *
 * Concatenates two Coll[T] values, returning a new Coll[T].
 * Pattern B-chunked: cost charged AFTER both child evals.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/coll_append.rs:39-63
 *   let input_v = self.input.eval(env, ctx)?;        // line 44 — eval input first
 *   let col2_v = self.col_2.eval(env, ctx)?;         // line 45 — eval col_2 second
 *   if input_elem_tpe != col2_elem_tpe { return Err(...) }   // line 52-58
 *   let input_vecval = extract_vecval(input_v)?;
 *   let col_2_vecval = extract_vecval(col2_v)?;
 *   ctx.add_per_item_jit_cost(20, 2, 100, n1+n2)?;  // line 57 — Pattern B-chunked
 *   Ok(concat result)
 */

import type { Append, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'
import { sTypeEquals } from '../mir/stype-helpers'

// Cost source: sigma-rust eval/coll_append.rs:57
//   ctx.add_per_item_jit_cost(20, 2, 100, n1+n2)?;
// Pattern B-chunked (cost AFTER eval-children).
const COLL_APPEND_BASE = 20
const COLL_APPEND_PER_CHUNK = 2
const COLL_APPEND_CHUNK_SIZE = 100

/**
 * Evaluate an `Append` node. Pattern B-chunked: cost charged after both children.
 *
 * @throws EvalError `'coll-input-not-coll'` if either operand is not a Coll.
 * @throws EvalError `'coll-elem-tpe-mismatch'` if the two Colls have different elem types.
 * @throws EvalError `'cost-limit-exceeded'` if addPerItemCost exceeds the limit.
 */
export function evalAppend(e: Append, env: Env, ctx: EvalContext): SValue {
  const inputVal = evalExpr(e.input, env, ctx)
  const col2Val = evalExpr(e.col2, env, ctx)

  const inputColl = extractCollItems(inputVal)
  const col2Coll = extractCollItems(col2Val)

  if (!sTypeEquals(inputColl.elem, col2Coll.elem)) {
    throw new EvalError(
      `Append: expected the same elem type, got ${JSON.stringify(inputColl.elem)} and ${JSON.stringify(col2Coll.elem)}`,
      'coll-elem-tpe-mismatch'
    )
  }

  ctx.addPerItemCost(
    COLL_APPEND_BASE,
    COLL_APPEND_PER_CHUNK,
    COLL_APPEND_CHUNK_SIZE,
    inputColl.items.length + col2Coll.items.length
  )

  return {
    kind: 'Coll',
    elem: inputColl.elem,
    items: [...inputColl.items, ...col2Coll.items],
  }
}
