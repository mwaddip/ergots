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
 *   (b) Output elem type from exprTpe(closure.body, ctx.treeVersion ?? 0) — returns SAny for
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
import { readCheckedType } from './_check-type'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEquals, hasSAny } from '../mir/stype-helpers'
import { flatMapped, empty } from './_coll'

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
 * @throws EvalError `'lambda-result-type-mismatch'` if exprTpe(closure.body, ctx.treeVersion ?? 0)
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

  // 7. Determine initial output elem type. Three branches:
  //    - SColl body type → use bodyTpe.elem (concrete path; JVM
  //      `methods.scala:1005` reads `mc.tpe.asInstanceOf[SCollection[_]].elemType`)
  //    - SAny body type  → set outElem = SAny pre-loop; refine from the first part
  //    - other body type → defensive throw: the JVM parse rejects such a tree
  //      because `flatMap`'s declared range is `Coll[B]`; a well-typed body is
  //      always `SColl[_]` or `SAny` (ergots' residual for unresolved methods).
  const bodyTpe = exprTpe(closure.body, ctx.treeVersion ?? 0)
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

  // 8. Loop: per-item env-extend + body eval + per-part collect.
  //    sigma-rust scoll.rs:127-135 — collect::<Result<Vec<Value>, _>>() then from_vec_vec.
  //    Each per-element body result is one PART (handed to `flatMapped`): the
  //    collection module reads each part's length and class to decide what
  //    the JVM's `ArrayBuilder.++=` would store (`CollsOverArrays.scala:70-73`
  //    and `:410-411`; `ArrayBuilder.ofUnit` drops; `ofRef.+=` aastore; an
  //    empty part stores nothing whatever its class — SANTA rows #37, #38).
  //    The body's shape (`kind === 'Coll'`) is checked here, matching the
  //    JVM's `FuncValue.eval` `checkType(body, res)` = `isValueOfType` which
  //    for an SColl declared range checks `x.isInstanceOf[Coll[_]]`
  //    (`core/shared/src/main/scala/sigma/ast/values.scala:1080`,
  //    `core/shared/src/main/scala/sigma/ast/SType.scala:187-213`).
  const argId = closure.argIds[0]!
  const parts: SValue[] = []
  for (const item of inputColl.items) {
    // Per-element lambda-arg binding cost: 5 (ADD_TO_ENV_COST). JVM applies the
    // FuncValue once per element, each application charging AddToEnvironmentDesc
    // = 5 to bind the arg before the body eval (`values.scala:1047`). Binding
    // inline here without it under-charged 5/element vs JVM.
    ctx.addCost(5)
    // Extend the lambda's CAPTURED (definition-site) env — lexical scoping,
    // JVM-faithful for v6. For inline flatMap lambdas capturedEnv == the caller
    // env (no-op); differs only for out-of-scope-captured lambdas.
    // v6 P6: reject a type-var arg type at the per-element apply (JVM
    // "Unknown type T"). Per-element ⇒ an empty input never binds, never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    const bodyEnv = closure.capturedEnv.extend(argId, item)
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    // The JVM's closure reads the body's type after each application (values.scala:1080; spec §5 item 5).
    readCheckedType(closure.body, ctx)
    if (itemRes.kind !== 'Coll') {
      throw new EvalError(
        `SColl.flatMap: lambda body returned non-Coll; got '${itemRes.kind}'`,
        'lambda-result-type-mismatch'
      )
    }
    if (outElem.tag === 'SAny') {
      // First-iter refinement: adopt the runtime Coll's elem type.
      outElem = itemRes.elem
    }
    parts.push(itemRes)
  }

  const totalOutLen = parts.reduce((n, p) => n + (p as { items: SValue[] }).items.length, 0)

  // 9. Outer cost: addPerItemCost(60, 10, 8, OUTPUT length). JVM `flatMap_eval`
  //    (methods.scala:1004-1008) charges PerItemCost(60,10,8) over `res.length`
  //    — the flattened OUTPUT length — AFTER running the body evals; sigma-rust
  //    (scoll.rs:126) and our prior code charged on the INPUT length, a large
  //    structural under-charge. JVM is canonical (SANTA v5 B2).
  ctx.addPerItemCost(FLATMAP_OUTER_BASE, FLATMAP_OUTER_PER_CHUNK, FLATMAP_OUTER_CHUNK_SIZE, totalOutLen)

  // `SColl.flatMap` (methods.scala:1000-1008) calls `inputV.flatMap(mapperV)` at
  // `mc.tpe` (the call's declared range). On both receiver shapes
  // (`CollOverArray.flatMap` CollsOverArrays.scala:70-73, `PairOfCols.flatMap`
  // :410-411) the body goes through `builder.fromArray(toArray.flatMap(...))`
  // at abstract B — the module stores each part's items through the range
  // array's `ArrayBuilder` and returns the plain collection (pair routing
  // through `fromArray` on a pair range).
  //
  // An empty-input case where `outElem` stays `SAny` (the body's exprTpe
  // types as ergots' own `SAny`): the JVM has the real range at this call
  // and gives the result its array; ergots cannot name it, and the result
  // carries the unknown class. Every reader by class takes it by the
  // empty-of-the-receiver's-class rule.
  if (obj.kind !== 'Coll') throw new Error('unreachable: extractCollItems would have thrown')
  if (parts.length === 0 && hasSAny(outElem)) {
    return empty(outElem)
  }
  return flatMapped(obj, outElem, parts as (SValue & { kind: 'Coll' })[])
}
