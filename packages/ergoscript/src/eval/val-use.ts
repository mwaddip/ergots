/**
 * ValUse arm — env lookup, charge cost.
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/val_use.rs:15-19`
 *   _ctx.add_jit_cost(5)?;
 *   env.get(self.val_id).cloned().ok_or_else(|| EvalError::NotFound(...))
 *
 * Cost: ValUse = Fixed(5).
 *
 * NB: cost is charged BEFORE the env lookup, mirroring sigma-rust. An
 * unbound ValUse therefore still consumes 5 jitCost before throwing.
 */

import type { SValue, ValUse } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalValUse(e: ValUse, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  const v = env.get(e.valId)
  if (v === undefined) {
    throw new EvalError(`ValUse(id=${e.valId}): no binding in env`, 'val-use-unbound')
  }
  return v
}
