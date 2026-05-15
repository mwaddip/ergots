/**
 * FuncValue arm — constructs a Lambda SValue from a FuncValue MIR node.
 *
 * The body is lazy: not evaluated at FuncValue site. The closure stores
 * argIds + body; Apply (Task 3) evaluates the body with args bound when
 * the lambda is invoked.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/func_value.rs:10-18
 *   ctx.add_jit_cost(5)?; // FuncValue = Fixed(5)
 *   Ok(Value::Lambda(Lambda { args: self.args().to_vec(),
 *                             body: self.body().clone().into() }))
 *
 * Cost-charging order: envelope BEFORE returning the Lambda (the only
 * "work" the arm does).
 *
 * Closure shape per packages/ergoscript/src/mir/types.ts (forward-declared
 * in phase 2a):
 *   { argIds: number[], body: Expr, capturedEnv: Record<number, SValue> }
 *
 * `argIds` strips the FuncArg.tpe (only the val id is needed for body's
 * ValUse lookups). `capturedEnv` is set to `{}` (empty) — sigma-rust uses
 * dynamic-style scoping (env at apply-site, with arg bindings extended,
 * is used for body eval). The `capturedEnv` field in the existing TS
 * shape is non-load-bearing for sigma-rust-compatible semantics; we
 * leave it empty rather than capturing the env at definition (which
 * would diverge from sigma-rust).
 *
 * Sigma-rust uses a mutable Env with save/restore for argument binding
 * (apply.rs:30-46). Our TS Env is immutable per phase 2b — Apply uses
 * Env.extend() directly without save/restore.
 */

import type { FuncValue, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

const FUNC_VALUE_COST = 5

export function evalFuncValue(e: FuncValue, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(FUNC_VALUE_COST)
  return {
    kind: 'Lambda',
    closure: {
      argIds: e.args.map((a) => a.id),
      body: e.body,
      capturedEnv: {},
    },
  }
}
