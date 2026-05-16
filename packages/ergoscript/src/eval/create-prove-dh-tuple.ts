/**
 * `CreateProveDhTuple` evaluator arm — wraps 4 GroupElements into a
 * SigmaProp{ProveDhTuple, g, h, u, v}.
 *
 * Pattern A: Fixed(20) cost BEFORE eval-children. No curve operation on the
 * eval path; the cryptographic work lives entirely on the verify path.
 *
 * Source: ergotree-interpreter/src/eval/create_prove_dh_tuple.rs:12-25
 *
 *     fn eval(&self, env: &mut Env<'ctx>, ctx: &Context<'ctx>) -> Result<Value<'ctx>, EvalError> {
 *         ctx.add_jit_cost(20)?; // CreateProveDHTuple = Fixed(20)
 *         let g = self.g.eval(env, ctx)?.try_extract_into::<EcPoint>()?;
 *         let h = self.h.eval(env, ctx)?.try_extract_into::<EcPoint>()?;
 *         let u = self.u.eval(env, ctx)?.try_extract_into::<EcPoint>()?;
 *         let v = self.v.eval(env, ctx)?.try_extract_into::<EcPoint>()?;
 *         Ok(ProveDhTuple::new(g, h, u, v).into())
 *     }
 */

import type { CreateProveDhTuple, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

/** Local helper — 4 callers within this file; per Decision #10, not promoted. */
function expectGroupElement(v: SValue, fieldName: string): Uint8Array {
  if (v.kind !== 'GroupElement') {
    throw new EvalError(
      `CreateProveDhTuple: expected GroupElement for ${fieldName}, got ${v.kind}`,
      'sigma-prop-input-not-group-element'
    )
  }
  // Defensive copy of the 33-byte compressed SEC1 point — mirrors ProveDlog's slice().
  return v.value.slice()
}

export function evalCreateProveDhTuple(
  e: CreateProveDhTuple,
  env: Env,
  ctx: EvalContext
): SValue {
  // Pattern A: charge cost BEFORE eval-children.
  // Source: create_prove_dh_tuple.rs:13 — ctx.add_jit_cost(20)?
  ctx.addCost(20)
  const g = expectGroupElement(evalExpr(e.g, env, ctx), 'g')
  const h = expectGroupElement(evalExpr(e.h, env, ctx), 'h')
  const u = expectGroupElement(evalExpr(e.u, env, ctx), 'u')
  const v = expectGroupElement(evalExpr(e.v, env, ctx), 'v')
  return { kind: 'SigmaProp', value: { tag: 'ProveDhTuple', g, h, u, v } }
}
