/**
 * SizeOf evaluator arm (phase 2f Coll HOFs Task 2).
 *
 * Returns `Int(items.length)` from a Coll SValue. Pattern A: cost charged
 * BEFORE evaluating the input child.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/coll_size.rs:11-22
 *   ctx.add_jit_cost(14)?;            // line 15 — Fixed(14), Pattern A
 *   let input_v = self.input.eval(env, ctx)?;  // line 16
 *   match input_v {
 *     Value::Coll(coll) => Ok((coll.len() as i32).into()),
 *     _ => Err(EvalError::UnexpectedValue(...)),
 *   }
 */

import type { SizeOf, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'

/**
 * Evaluate a `SizeOf` node. Pattern A: cost charged before eval-child.
 *
 * @throws EvalError `'cost-limit-exceeded'` if addCost(14) exceeds the limit.
 * @throws EvalError `'coll-input-not-coll'` if the input does not evaluate to a Coll.
 */
export function evalSizeOf(e: SizeOf, env: Env, ctx: EvalContext): SValue {
  // Pattern A: charge cost BEFORE evaluating the child.
  // Sigma-rust: ctx.add_jit_cost(14)? at line 15, before self.input.eval at line 16.
  ctx.addCost(14)
  const inputVal = evalExpr(e.input, env, ctx)
  const { items } = extractCollItems(inputVal)
  return { kind: 'Int', value: items.length }
}
