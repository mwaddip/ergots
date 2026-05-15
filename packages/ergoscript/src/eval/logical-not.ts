/**
 * LogicalNot arm — unary `!` on Boolean.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/logical_not.rs:16
 *   ctx.add_jit_cost(15)?;  // LogicalNot = Fixed(15)
 *   let input_v = self.input.eval(env, ctx)?;
 *   let input_v_bool = input_v.try_extract_into::<bool>()?;
 *   Ok((!input_v_bool).into())
 *
 * Cost: Fixed(15) per logical_not.rs:16 (inline literal; no named constant in costs.rs).
 */

import type { LogicalNot, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

const LOGICAL_NOT_COST = 15

export function evalLogicalNot(e: LogicalNot, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(LOGICAL_NOT_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Boolean') {
    throw new EvalError(
      `LogicalNot: operand kind must be Boolean, got '${input.kind}'`,
      'bin-op-not-boolean'
    )
  }
  return { kind: 'Boolean', value: !input.value }
}
