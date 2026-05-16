/**
 * OptionGetOrElse arm — unwraps Option Some, falls back to default
 * expression on None. **V3-gated lazy default evaluation.**
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/option_get_or_else.rs:10-29
 *   ctx.add_jit_cost(20)?;                          // BEFORE input eval
 *   let v = self.input.eval(env, ctx)?;
 *   let mut default_v = || self.default.eval(env, ctx);
 *   match v {
 *     Value::Opt(opt_v) if ctx.tree_version() >= V3 => {
 *       opt_v.as_deref().cloned().map(Ok).unwrap_or_else(default_v)  // LAZY
 *     }
 *     Value::Opt(opt_v) => {
 *       Ok(opt_v.as_deref().cloned().unwrap_or(default_v()?))         // EAGER
 *     }
 *     _ => UnexpectedExpr(...)
 *   }
 *
 * Cost-charging order: envelope BEFORE eval-input (Pattern A). Default
 * eval order depends on treeVersion:
 *   - V<3: eager — default always evaluated (cost always charged)
 *   - V3+: lazy — default only evaluated when input is None
 *
 * Mirrors phase 2e's XorOf V0/V1-vs-V2+ pattern: same VALUE produced
 * but different COST at version boundary.
 *
 * Reuses 'option-input-not-option' from OptionGet (Task 3).
 */

import type { OptionGetOrElse, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: ergotree-interpreter/src/eval/option_get_or_else.rs:16
//   ctx.add_jit_cost(20)?;
// Pattern A (envelope BEFORE eval-input).
const OPTION_GET_OR_ELSE_COST = 20

export function evalOptionGetOrElse(
  e: OptionGetOrElse,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(OPTION_GET_OR_ELSE_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Option') {
    throw new EvalError(
      `OptionGetOrElse: input must be Option, got '${input.kind}'`,
      'option-input-not-option'
    )
  }
  if ((ctx.treeVersion ?? 0) >= 3) {
    // V3+ lazy: default evaluated ONLY if input is None.
    if (input.value !== null) {
      return input.value
    }
    return evalExpr(e.default, env, ctx)
  }
  // V<3 eager: default always evaluated regardless of Some/None.
  const defaultV = evalExpr(e.default, env, ctx)
  if (input.value !== null) {
    return input.value
  }
  return defaultV
}
