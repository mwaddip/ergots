/**
 * SOption.map method handler — campaign iter-29.
 *
 * sigma-rust:
 *   ergotree-ir/src/types/soption.rs:34-55         — method descriptor (id 7, V0+)
 *   ergotree-interpreter/src/eval/soption.rs:13-60 — map_eval
 *
 * `Option[T].map(f: T => R): Option[R]`. Fixed cost 20 (Pattern A, charged FIRST,
 * before the lambda/obj checks — matching sigma-rust's `add_jit_cost(20)` at the
 * top of map_eval). `Some(t)` → `Some(lambda(t))`; `None` → `None` (lambda NOT
 * invoked for None). Lambda invocation mirrors SColl.flatMap's env-extend; there
 * is NO body restriction (contrast flatMap).
 *
 * Some-path lambda invocation additionally charges ADD_TO_ENV_COST(5) before the
 * body eval (F3.5). None path uncharged — lambda is never invoked.
 *
 * Output Option elem type = `exprTpe(closure.body)` — same convention as flatMap.
 * The walker only checks cost (the oracle returns no value), so the elem only
 * matters for the offline byte-equality fixtures, which use BinOp bodies whose
 * exprTpe resolves concretely.
 */

import type { SType, SValue } from '../mir/types'
import { EvalError } from './eval-context'
import type { EvalContext } from './eval-context'
import type { Env } from './env'
import { evalExpr } from './eval'
import { extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'
import { exprTpe } from '../mir/expr-tpe'

/**
 * Evaluate a `SOption.map` method call.
 *
 * @throws EvalError `'lambda-not-callable'` if args.length !== 1, the arg is not
 *         a Lambda, or the closure does not take exactly 1 arg.
 * @throws EvalError `'option-input-not-option'` if obj is not an Option SValue.
 * @throws EvalError `'cost-limit-exceeded'` if the fixed cost trips the limit.
 */
export function evalSOptionMap(
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  // Retained for call-site signature symmetry with the dispatcher (extra.env);
  // unused since v6 P6 made lambda bodies eval in the closure's CAPTURED env
  // (lexical scoping) rather than this apply-site env.
  _env: Env
): SValue {
  // Fixed cost 20, Pattern A — charged FIRST (sigma-rust soption.rs:20).
  ctx.addCost(20)

  // Lambda arg — sigma-rust extracts + checks the lambda BEFORE the obj.
  if (args.length !== 1) {
    throw new EvalError(
      `SOption.map expects 1 lambda arg; got ${args.length}`,
      'lambda-not-callable'
    )
  }
  const closure = extractFuncValue(args[0]!)
  if (closure.argIds.length !== 1) {
    throw new EvalError(
      `SOption.map: lambda must take exactly 1 arg, got ${closure.argIds.length}`,
      'lambda-not-callable'
    )
  }

  // Receiver must be an Option (sigma-rust soption.rs:48-54).
  if (obj.kind !== 'Option') {
    throw new EvalError(
      `SOption.map expects an Option obj; got '${obj.kind}'`,
      'option-input-not-option'
    )
  }

  // Output Option elem = static type of the lambda body (flatMap convention).
  // Computed statically, so it is valid for the None case too.
  const outElem: SType = exprTpe(closure.body)

  // None → None (lambda NOT invoked). Some(t) → Some(lambda(t)).
  if (obj.value === null) {
    return { kind: 'Option', elem: outElem, value: null }
  }
  const argId = closure.argIds[0]!
  // v6 P6: reject a type-var arg type at apply (JVM "Unknown type T"). Placed
  // after the None early-return above ⇒ Option.map over None never invokes the
  // lambda, so it never throws (matches the JVM: no invocation, no resolution).
  assertArgTypeResolved(closure.argTpes[0]!)
  // Lambda-arg env binding: ADD_TO_ENV_COST (5) per FuncValue application —
  // JVM AddToEnvironmentDesc; same class as apply.ts:74 / scoll-flat-map.ts
  // per-element charge. F3.5 (SANTA Option.map vectors: Some 65 incl. the 5;
  // None 39 without — the lambda is never invoked on None).
  ctx.addCost(5)
  // Extend the lambda's CAPTURED (definition-site) env — lexical scoping,
  // JVM-faithful for v6. For inline map lambdas capturedEnv == the caller env
  // (no-op); differs only for out-of-scope-captured lambdas.
  const bodyEnv = closure.capturedEnv.extend(argId, obj.value)
  const result = evalExpr(closure.body, bodyEnv, ctx)
  return { kind: 'Option', elem: outElem, value: result }
}
