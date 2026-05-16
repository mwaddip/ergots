/**
 * OptionIsDefined arm — Option → Boolean.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/option_is_defined.rs:9-24
 *   ctx.add_jit_cost(10)?;                          // BEFORE eval-child
 *   let v = self.input.eval(env, ctx)?;
 *   match v {
 *     Value::Opt(opt_v) => Ok(opt_v.is_some().into()),
 *     _ => UnexpectedExpr(...)
 *   }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 *
 * Returns Boolean(true) for Some, Boolean(false) for None.
 * Throws 'option-input-not-option' if input is not an Option value.
 * Reuses 'option-input-not-option' error code from OptionGet (Task 3).
 */

import type { OptionIsDefined, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: sigma-rust eval/option_is_defined.rs:15 — inline literal
//   ctx.add_jit_cost(10)?;
// Pattern A (envelope BEFORE eval-child).
const OPTION_IS_DEFINED_COST = 10

export function evalOptionIsDefined(
  e: OptionIsDefined,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(OPTION_IS_DEFINED_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Option') {
    throw new EvalError(
      `OptionIsDefined: input must be Option, got '${input.kind}'`,
      'option-input-not-option',
    )
  }
  return { kind: 'Boolean', value: input.value !== null }
}
