/**
 * SColl.flatMap method handler — Tier-3 phase 2h-f.
 *
 * sigma-rust:
 *   ergotree-ir/src/types/scoll.rs:82-100   — method descriptor (id 15, V0+)
 *   ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval
 *
 * Cost: Pattern B — addPerItemCost(60, 10, 8, n) AFTER all guards, BEFORE loop.
 * No per-iter cost (unlike MapColl/Filter Mixed pattern).
 *
 * Lambda body restriction (scoll.rs:78-84): when the runtime closure body is
 * a MethodCall, its args MUST be empty (property-call style). Allowed:
 * xs.flatMap(x => x.indices). NOT allowed: xs.flatMap(x => x.indexOf(5, 0)).
 * We check the RUNTIME closure.body, not the MIR-node mc.args[0].body, so the
 * restriction fires correctly for ValUse-source lambdas too.
 *
 * R3 divergences from sigma-rust (documented in facts/ergoscript-eval.md):
 *   (a) Elem-type check uses MIR-node lambda's static arg type — skipped when
 *       the lambda Expr is not an inline FuncValue (Closure SValue has no
 *       argTpes). Mirrors coll-map.ts:94-108 convention.
 *   (b) Output elem type from exprTpe(closure.body) — returns SAny for
 *       PropertyCall/MethodCall body (SMethod resolver not yet online).
 *       Handler tolerates SAny pre-loop, refines from itemRes.elem on first
 *       iter. Empty input returns Coll[SAny].
 */

import type { MethodCall, SType, SValue } from '../mir/types'
import { EvalError } from './eval-context'
import type { EvalContext } from './eval-context'
import type { Env } from './env'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEquals } from '../mir/stype-helpers'

// Pattern B outer cost: add_per_item_jit_cost(base=60, per_chunk=10, chunk_size=8, n)
// Source: scoll.rs:126
const FLATMAP_OUTER_BASE = 60
const FLATMAP_OUTER_PER_CHUNK = 10
const FLATMAP_OUTER_CHUNK_SIZE = 8

/**
 * Evaluate a `SColl.flatMap` method call.
 *
 * @throws EvalError `'coll-input-not-coll'` if obj does not evaluate to Coll.
 * @throws EvalError `'lambda-not-callable'` if args.length !== 1, or closure
 *         is not a Lambda, or closure.argIds.length !== 1, or the body
 *         restriction fires (MethodCall body with non-empty args).
 * @throws EvalError `'coll-elem-tpe-mismatch'` if mc.args[0] is FuncValue and
 *         its arg tpe differs from input.elem (R3(a) skip otherwise).
 * @throws EvalError `'lambda-result-type-mismatch'` if exprTpe(closure.body)
 *         is neither SColl nor SAny, or itemRes is not Coll, or sub-coll
 *         elem mismatch (when outElem is concrete post-refinement).
 * @throws EvalError `'cost-limit-exceeded'` if the outer cost charge trips it.
 */
export function evalSCollFlatMap(
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  _explicitTypeArgs: Record<string, SType>,
  mc: MethodCall,
  // Retained for call-site signature symmetry with the dispatcher (extra.env);
  // unused since v6 P6 made lambda bodies eval in the closure's CAPTURED env
  // (lexical scoping) rather than this apply-site env.
  _env: Env
): SValue {
  // 1. Receiver shape check (sigma-rust scoll.rs:109-117).
  const inputColl = extractCollItems(obj)

  // 2. Argument check: exactly 1 lambda arg (sigma-rust scoll.rs:60-71).
  if (args.length !== 1) {
    throw new EvalError(
      `SColl.flatMap expects 1 lambda arg; got ${args.length}`,
      'lambda-not-callable'
    )
  }
  const closure = extractFuncValue(args[0]!)

  // 3. Lambda arity check (sigma-rust scoll.rs:72-77). extractFuncValue
  //    enforces argIds.length >= 1; flatMap further enforces == 1.
  if (closure.argIds.length !== 1) {
    throw new EvalError(
      `SColl.flatMap: lambda must take exactly 1 arg, got ${closure.argIds.length}`,
      'lambda-not-callable'
    )
  }

  // 4. Defensive body restriction (sigma-rust scoll.rs:78-84).
  //    USE THE RUNTIME closure.body — works for both inline FuncValue and
  //    ValUse-source lambdas. The runtime body is the resolved Expr in both
  //    cases; sigma-rust's lambda.body field is populated identically.
  if (closure.body.tag === 'MethodCall' && closure.body.args.length > 0) {
    throw new EvalError(
      `SColl.flatMap: lambda body MethodCall must take 0 args (property-call only); got ${closure.body.args.length}`,
      'lambda-not-callable'
    )
  }

  // 5. Elem-type check (R3(a) divergence).
  //    Static check via mc.args[0] when it's a FuncValue MIR node; skipped
  //    for ValUse-source lambdas because the runtime Closure SValue does not
  //    carry argTpes (mir/types.ts:149-156). Mirrors coll-map.ts:94-108.
  const lambdaExpr = mc.args[0]!
  if (lambdaExpr.tag === 'FuncValue' && lambdaExpr.args.length > 0) {
    const lambdaInputTpe = lambdaExpr.args[0]!.tpe
    if (!sTypeEquals(inputColl.elem, lambdaInputTpe)) {
      throw new EvalError(
        `SColl.flatMap: input elem type ${JSON.stringify(inputColl.elem)} does not match lambda arg type ${JSON.stringify(lambdaInputTpe)}`,
        'coll-elem-tpe-mismatch'
      )
    }
  }

  // 7. Determine initial output elem type. 3-branch init (R3(b)):
  //    - SColl body type → use bodyTpe.elem (concrete path)
  //    - SAny body type  → set outElem = SAny pre-loop; refine post-iter-1
  //    - other body type → defensive throw
  const bodyTpe = exprTpe(closure.body)
  let outElem: SType
  if (bodyTpe.tag === 'SColl') {
    outElem = bodyTpe.elem
  } else if (bodyTpe.tag === 'SAny') {
    outElem = { tag: 'SAny' }
  } else {
    throw new EvalError(
      `SColl.flatMap: lambda body must return Coll; got ${JSON.stringify(bodyTpe)}`,
      'lambda-result-type-mismatch'
    )
  }

  // 8. Loop: per-item env-extend + body eval + Coll-check + concat.
  //    sigma-rust scoll.rs:127-135 — collect::<Result<Vec<Value>, _>>() then from_vec_vec.
  //    When pre-loop outElem === SAny, refine from the first itemRes.elem.
  //    Subsequent iters check itemRes.elem matches the (now-refined) outElem.
  const argId = closure.argIds[0]!
  const outItems: SValue[] = []
  for (const item of inputColl.items) {
    // Per-element lambda-arg binding cost: 5 (ADD_TO_ENV_COST). JVM applies the
    // FuncValue once per element, each application charging AddToEnvironmentDesc
    // = 5 to bind the arg before the body eval (`values.scala:1047`). Binding
    // inline here without it under-charged 5/element vs JVM; sigma-rust shares
    // the gap (`scoll.rs` flatmap_eval binds via env.insert, uncharged). Routed
    // to the sigma-rust session in `~/projects/santa/prompts/ergots-v5-divergences.md`.
    // JVM is canonical.
    ctx.addCost(5)
    // Extend the lambda's CAPTURED (definition-site) env — lexical scoping,
    // JVM-faithful for v6. For inline flatMap lambdas capturedEnv == the caller
    // env (no-op); differs only for out-of-scope-captured lambdas.
    // v6 P6: reject a type-var arg type at the per-element apply (JVM
    // "Unknown type T"). Per-element ⇒ an empty input never binds, never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    const bodyEnv = closure.capturedEnv.extend(argId, item)
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    if (itemRes.kind !== 'Coll') {
      throw new EvalError(
        `SColl.flatMap: lambda body returned non-Coll; got '${itemRes.kind}'`,
        'lambda-result-type-mismatch'
      )
    }
    if (outElem.tag === 'SAny') {
      // First-iter refinement: adopt the runtime Coll's elem type.
      outElem = itemRes.elem
    } else if (!sTypeEquals(itemRes.elem, outElem)) {
      // Sub-coll elem-type check (mirror from_vec_vec validation).
      throw new EvalError(
        `SColl.flatMap: lambda body Coll elem type ${JSON.stringify(itemRes.elem)} does not match expected ${JSON.stringify(outElem)}`,
        'lambda-result-type-mismatch'
      )
    }
    for (const sub of itemRes.items) outItems.push(sub)
  }

  // 9. Outer cost: addPerItemCost(60, 10, 8, OUTPUT length). JVM `flatMap_eval`
  //    (methods.scala:1004-1008) charges PerItemCost(60,10,8) over `res.length`
  //    — the flattened OUTPUT length — AFTER running the body evals; sigma-rust
  //    (scoll.rs:126) and our prior code charged on the INPUT length, a large
  //    structural under-charge. JVM is canonical (SANTA v5 B2; routed in
  //    `~/projects/santa/prompts/ergots-v5-divergences.md`).
  ctx.addPerItemCost(FLATMAP_OUTER_BASE, FLATMAP_OUTER_PER_CHUNK, FLATMAP_OUTER_CHUNK_SIZE, outItems.length)

  // Empty-input case: outElem stays SAny; returns Coll[SAny].
  return { kind: 'Coll', elem: outElem, items: outItems }
}
