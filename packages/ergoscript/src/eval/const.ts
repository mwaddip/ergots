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
 *
 * P2PK short-circuit (EVAL_SIGMA_PROP_CONSTANT = 50): a tree whose root
 * is `Const(SSigmaProp, _)` charges a flat 50 JitCost in sigma-rust via
 * `trivial_reduce` (eval.rs:138-158), which fires BEFORE any arm eval.
 * We replicate this in `evaluate.ts:tryTrivialReduce` — NOT here — so
 * that SigmaProp constants nested inside other expressions (e.g., BinOp)
 * still charge only 5, matching sigma-rust's non-short-circuit path.
 */

import type { Const, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalConst(e: Const, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  return e.value
}
