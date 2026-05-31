/**
 * Apply arm — invokes a Lambda SValue with given arg expressions.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/apply.rs:12-56
 *   ctx.add_jit_cost(30)?; // Apply = Fixed(30) — BEFORE eval-func
 *   let func_v = self.func.eval(env, ctx)?;
 *   let args_v: Vec<Value> = self.args.iter().map(|a| a.eval(env, ctx)).collect()?;
 *   match func_v {
 *       Value::Lambda(fv) => { per arg: add_jit_cost(5) + env.insert/remove dance; fv.body.eval(env, ctx) }
 *       _ => Err(EvalError::UnexpectedValue(...))
 *   }
 *
 * Sequence (TS, with immutable Env per phase 2b):
 *   1. Charge Fixed(30).
 *   2. Eval e.func → must be Lambda. Otherwise throw 'apply-non-lambda'.
 *   3. Arity check: closure.argIds.length === e.args.length. Otherwise
 *      throw 'apply-arity-mismatch' (BEFORE arg-eval; pure structural).
 *   4. Eval each arg expression in order.
 *   5. Build bodyEnv via immutable extend for each (closure.argIds[i],
 *      args[i]) pair, charging ADD_TO_ENV_COST (5 JIT) per binding (mirrors
 *      block-value.ts; sigma-rust apply.rs / block.rs:30). The TS Env is
 *      immutable per phase 2b — no save/restore needed.
 *   6. Eval closure.body in bodyEnv. Return.
 *
 * Sigma-rust's mutable save/restore (apply.rs:30-46) is a borrow-checker
 * workaround in Rust that doesn't apply to TS. Result is identical to
 * sigma-rust's behavior modulo mechanism.
 */

import type { Apply, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

const APPLY_COST = 30

export function evalApply(e: Apply, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(APPLY_COST)
  const func = evalExpr(e.func, env, ctx)
  if (func.kind !== 'Lambda') {
    throw new EvalError(
      `Apply: expected Lambda func, got '${func.kind}'`,
      'apply-non-lambda'
    )
  }
  const closure = func.closure
  // Arity check BEFORE arg-eval (pure structural; per design spec Decision #6).
  if (closure.argIds.length !== e.args.length) {
    throw new EvalError(
      `Apply: arity mismatch — closure expects ${closure.argIds.length} args, got ${e.args.length}`,
      'apply-arity-mismatch'
    )
  }
  // Eval all args in order using caller's env.
  const argValues: SValue[] = []
  for (const argExpr of e.args) {
    argValues.push(evalExpr(argExpr, env, ctx))
  }
  // Extend env with each (closure arg id, arg value) pair (immutable extend).
  // Sigma-rust uses dynamic-style scoping: body is evaluated in the caller's
  // env extended with arg bindings (not a definition-time captured env).
  let bodyEnv = env
  for (let i = 0; i < closure.argIds.length; i++) {
    ctx.addCost(5) // ADD_TO_ENV_COST per sigma-rust apply.rs (mirrors block.rs:30 / block-value.ts:31)
    bodyEnv = bodyEnv.extend(closure.argIds[i]!, argValues[i]!)
  }
  return evalExpr(closure.body, bodyEnv, ctx)
}
