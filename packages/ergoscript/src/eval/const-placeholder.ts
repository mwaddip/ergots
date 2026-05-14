/**
 * ConstPlaceholder arm — resolve via ctx.constants[id], charge cost.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval.rs:52-64
 *
 *     Expr::ConstPlaceholder(cp) => {
 *         ctx.add_jit_cost(1)?; // ConstantPlaceholder = Fixed(1) per Scala
 *         let constant = ctx
 *             .constants
 *             .and_then(|cs| cs.get(cp.id as usize))
 *             .ok_or_else(|| {
 *                 EvalError::UnexpectedExpr(format!(
 *                     "ConstPlaceholder({}): constant not found",
 *                     cp.id
 *                 ))
 *             })?;
 *         Ok(Value::from(constant.v.clone()))
 *     }
 *
 * Cost: ConstantPlaceholder = Fixed(1) per Scala. Note this is markedly
 * cheaper than the Const arm's Fixed(5); both are charged by their own arm
 * regardless of which payload they wrap. Sigma-rust's `reduce_to_crypto`
 * adds a `trivial_reduce` short-circuit for SigmaProp constants
 * (eval.rs:262-278) that flat-rates the whole tree at JitCost 50, but that
 * lives outside the arm itself — pure ConstPlaceholder eval is always 1.
 *
 * Our `ctx.constants` mirrors sigma-rust's `Context.constants` (set via
 * `with_constants(...)` on the lazy-resolution path); the public
 * `evaluate(tree, opts?)` entry point in `evaluate.ts` defaults
 * `ctx.constants` to `tree.constants` so callers don't need to plumb it
 * by hand.
 */

import type { ConstPlaceholder, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalConstPlaceholder(
  e: ConstPlaceholder,
  _env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(1)
  if (ctx.constants === undefined) {
    throw new EvalError(
      `ConstPlaceholder(${e.id}): ctx.constants is undefined; cannot resolve`,
      'const-placeholder-no-constants'
    )
  }
  if (e.id >= ctx.constants.length) {
    throw new EvalError(
      `ConstPlaceholder(${e.id}): id out of range (constants.length=${ctx.constants.length})`,
      'const-placeholder-id-out-of-range'
    )
  }
  return ctx.constants[e.id]!
}
