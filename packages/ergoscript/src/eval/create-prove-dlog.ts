/**
 * `CreateProveDlog` evaluator arm — wraps a GroupElement into a
 * SigmaProp{ProveDlog, h}.
 *
 * Pattern A: Fixed(10) cost BEFORE eval-child. No curve operation on the
 * eval path; the cryptographic work lives entirely on the verify path.
 *
 * Source: ergotree-interpreter/src/eval/create_provedlog.rs:10-29
 *
 *     fn eval(&self, env: &mut Env<'ctx>, ctx: &Context<'ctx>) -> Result<Value<'ctx>, EvalError> {
 *         ctx.add_jit_cost(10)?; // CreateProveDlog = Fixed(10)
 *         let value_v = self.input.eval(env, ctx)?;
 *         match value_v {
 *             Value::GroupElement(ecpoint) => {
 *                 let prove_dlog = ProveDlog::new(*ecpoint);
 *                 Ok(prove_dlog.into())
 *             }
 *             _ => Err(EvalError::UnexpectedValue(...))
 *         }
 *     }
 */

import type { CreateProveDlog } from '../mir/types'
import type { SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalCreateProveDlog(e: CreateProveDlog, env: Env, ctx: EvalContext): SValue {
  // Pattern A: charge cost BEFORE eval-child.
  // Source: create_provedlog.rs:18 — ctx.add_jit_cost(10)?
  ctx.addCost(10)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'GroupElement') {
    throw new EvalError(
      `CreateProveDlog: expected GroupElement input, got ${input.kind}`,
      'sigma-prop-input-not-group-element'
    )
  }
  // Defensive copy of the h bytes — the 33-byte compressed SEC1 point.
  // Source: create_provedlog.rs:20-23 — ProveDlog::new(*ecpoint)
  const h = input.value.slice()
  return { kind: 'SigmaProp', value: { tag: 'ProveDlog', h } }
}
