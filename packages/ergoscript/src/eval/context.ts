/**
 * `Context` evaluator arm — returns the `Value::Context` sentinel.
 *
 * Trivial: cost 1 (Pattern A) per `expr.rs:38`. The sentinel is consumed
 * by handlers that need to type-check their obj (currently `SContext.dataInputs`).
 *
 * Source: ergotree-interpreter/src/eval/expr.rs:38
 */

import type { Context as ContextExpr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalContext(_e: ContextExpr, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(1)
  return { kind: 'Context' }
}
