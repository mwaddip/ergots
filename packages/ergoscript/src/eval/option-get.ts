/**
 * OptionGet arm — unwraps an Option Some, throws on None.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/option_get.rs:10-28
 *   ctx.add_jit_cost(15)?;                          // BEFORE eval-child
 *   let v = self.input.eval(env, ctx)?;
 *   match v {
 *     Value::Opt(opt_v) => opt_v.ok_or_else(... NotFound ...)
 *     _ => UnexpectedExpr(...)
 *   }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 *
 * Defensive 'option-input-not-option' guards against non-Option input
 * (wire-format invariants make this unreachable for parser-produced
 * trees; same posture as LogicalNot's defensive check).
 */

import type { OptionGet, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: sigma-rust eval/option_get.rs:16 — inline literal
//   ctx.add_jit_cost(15)?;
// Pattern A (envelope BEFORE eval-child).
const OPTION_GET_COST = 15

export function evalOptionGet(e: OptionGet, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(OPTION_GET_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Option') {
    throw new EvalError(
      `OptionGet: input must be Option, got '${input.kind}'`,
      'option-input-not-option'
    )
  }
  if (input.value === null) {
    throw new EvalError(`OptionGet: called on None`, 'option-empty')
  }
  return input.value
}
