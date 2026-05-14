/**
 * Const arm — return the literal value, charge cost.
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/expr.rs:21-24`
 *
 *     Expr::Const(c) => {
 *         ctx.add_jit_cost(5)?;          // Constant = Fixed(5)
 *         Ok(Value::from(c.v.clone()))
 *     }
 *
 * Our `SValue` already mirrors sigma-rust's `Value` shape, so the "wrap"
 * step is a no-op — we simply hand back `e.value`. Cost is the only side
 * effect the arm has on the context.
 */

import type { Const, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalConst(e: Const, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  return e.value
}
