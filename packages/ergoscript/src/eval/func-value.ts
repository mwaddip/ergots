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
 * The JVM, unlike sigma-rust, builds a closure for exactly one parameter
 * (FuncValue.eval, values.scala:1070-1085): it charges the 5, then throws
 * "Function must have 1 argument" for 0, 2 or more. So does this arm
 * ('apply-arity-mismatch', the code of Apply's own one-argument rule; spec §9).
 *
 * Cost-charging order: envelope BEFORE the arity check and before returning
 * the Lambda (the only "work" the arm does).
 *
 * Closure shape per packages/ergoscript/src/mir/types.ts:
 *   { argIds: number[], argTpes: SType[], body: Expr, capturedEnv: Env }
 *
 * `argIds` strips the FuncArg.tpe to the val ids (needed for body's ValUse
 * lookups); `argTpes` keeps the parallel declared arg types — consumed at
 * apply-time by `assertArgTypeResolved` (the v6 P6 type-var reject) and by the
 * lambda-HOF elem-type checks. `capturedEnv` is the lexical environment in scope AT
 * THE DEFINITION SITE — captured here (lexical closure). The JVM is
 * canonical for v6 and uses lexical scoping: a returned closure that
 * references a free variable resolves it from the definition-site env, not
 * the apply-site env. Apply / the lambda HOF arms evaluate the body in
 * `capturedEnv` extended with the per-call arg bindings. Worked example:
 * `{ val add = (a:Int)=>(b:Int)=>a+b; add(3)(1) }` evaluates to `Int 4`
 * because the inner `(b)=>a+b` closes over `a` from where it was defined.
 *
 * Our TS Env is immutable per phase 2b: extending it for arg bindings never
 * mutates the captured env, so the same Lambda value can be applied
 * repeatedly with independent argument scopes (no save/restore dance).
 */

import type { FuncValue, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

const FUNC_VALUE_COST = 5

export function evalFuncValue(e: FuncValue, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(FUNC_VALUE_COST)
  // The JVM's FuncValue.eval charges its cost, then builds a closure only for exactly one parameter, and otherwise throws
  // "Function must have 1 argument" (values.scala:1070-1085). So a lambda of 0, 2 or more parameters rejects wherever it
  // is evaluated: passed to map, exists, forall or filter, compared, or bound. The code is the one Apply's own
  // one-argument rule throws (eval/apply.ts).
  if (e.args.length !== 1) {
    throw new EvalError(
      `FuncValue: function must have 1 argument, got ${e.args.length}`,
      'apply-arity-mismatch'
    )
  }
  return {
    kind: 'Lambda',
    closure: {
      argIds: e.args.map((a) => a.id),
      argTpes: e.args.map((a) => a.tpe),
      body: e.body,
      capturedEnv: env,
    },
  }
}
