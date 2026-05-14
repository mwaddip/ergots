/**
 * If arm — eval condition, branch on its boolean value.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/if_op.rs:16
 *
 *     ctx.add_jit_cost(10)?; // If = Fixed(10)
 *     let condition_v = self.condition.eval(env, ctx)?;
 *     if condition_v.try_extract_into::<bool>()? {
 *         self.true_branch.eval(env, ctx)
 *     } else {
 *         self.false_branch.eval(env, ctx)
 *     }
 *
 * Cost: If = Fixed(10) (envelope) + condition eval cost + taken branch eval cost.
 *
 * Short-circuit semantics: the non-taken branch is NEVER evaluated, so its
 * cost is NOT charged. This mirrors sigma-rust exactly — the Rust test suite
 * has explicit `eval_laziness_true_branch` / `eval_laziness_false_branch`
 * cases that put a divide-by-zero in the dead branch and assert it doesn't
 * blow up. Our short-circuit unit tests (in `test/eval/if.test.ts`) use the
 * same trick with an out-of-range ConstPlaceholder to prove dead-branch
 * skipping behaviour.
 */

import type { If, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalIf(e: If, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(10)
  const cond = evalExpr(e.condition, env, ctx)
  if (cond.kind !== 'Boolean') {
    throw new EvalError(
      `If.condition evaluated to '${cond.kind}', expected Boolean`,
      'if-condition-not-boolean'
    )
  }
  return cond.value ? evalExpr(e.trueBranch, env, ctx) : evalExpr(e.falseBranch, env, ctx)
}
