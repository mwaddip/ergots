/**
 * Filter evaluator arm.
 *
 * Selects all elements of a collection for which a predicate
 * (boolean-returning lambda) answers true, and returns a new collection of
 * the passing elements. `Filter.eval` (`transformers.scala:118-127`)
 * evaluates the input collection and the condition, charges the sequence
 * cost at the input's length, and runs `inputV.filter(conditionV)`.
 *
 * Cost (Mixed pattern — outer + per-iter):
 *   Outer, AFTER input and condition are evaluated, BEFORE the loop:
 *     `addPerItemCost(20, 1, 10, inputColl.length)` — JVM
 *     `Filter.costKind = PerItemCost(20, 1, 10)`
 *     (`transformers.scala:128-134`); the sequence cost at `inputV.length`.
 *   Per-iter, inside the closure, BEFORE body eval:
 *     `addCost(5)` — JVM `FuncValue.eval` `values.scala:1076`:
 *     `addFixedCost(AddToEnvironmentDesc_CostKind, ...)` = 5.
 *
 * Eval order:
 *   1. Eval input  → must be Coll (throws `'coll-input-not-coll'`).
 *   2. Eval condition → must be Lambda (throws `'lambda-not-callable'`).
 *   3. Elem-type check: an ergots check with no JVM counterpart (see the
 *      block in the arm). Skipped when `inputColl.elem === SANY_JVM`:
 *      a tuple of another arity than two takes a `Coll[Any]` the JVM
 *      accepts here, and the per-application class check (step 5) takes it
 *      from there. For every other input the check stays, comparing
 *      `inputColl.elem` with the condition's declared arg type when the
 *      condition is a `FuncValue` MIR node, and throws
 *      `'coll-elem-tpe-mismatch'` on mismatch.
 *   4. Outer cost: `addPerItemCost(20, 1, 10, n)`.
 *   5. Per item: `assertCheckedValue(argTpe, item)` (JVM
 *      `FuncValue.eval`'s `Value.checkType(arg0._2, vArg)` —
 *      `values.scala:1073-1074`, `SType.scala:187-213`), `addCost(5)`,
 *      `env.extend(argId, item)`, eval body, `assertCheckedNode(body, res)`
 *      (JVM `Value.checkType(body, res)`, `values.scala:1080`), result-type
 *      check `kind === 'Boolean'` (throws `'lambda-result-type-mismatch'`
 *      on a non-Boolean body, which `conditionV` is typed to return).
 *      Collect the item if the body is true.
 *   6. No short-circuit — every item is visited (cost determinism).
 *   7. Return `filtered(inputColl, kept)` — the module decides the result's
 *      class per the JVM's `CollOverArray.filter` (`CollsOverArrays.scala:36`)
 *      and `PairOfCols.filter` (`:348-363`) rules.
 *
 * Env-extend convention: TS Env is immutable. For each item we call
 *   `env.extend(closure.argIds[0], item)` to create a new scope — the
 *   previous scope is the still-live parent binding.
 */

import type { Filter, SValue } from '../mir/types'
import { SANY_JVM } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'
import { assertCheckedNode, assertCheckedValue } from './_check-type'
import { sTypeEquals } from '../mir/stype-helpers'
import { dataItemType } from '../coll/class'
import { filtered } from './_coll'

// Outer cost: add_per_item_jit_cost(base=20, per_chunk=1, chunk_size=10, n)
// Sigma-rust ref: coll_filter.rs:61
const COLL_FILTER_OUTER_BASE = 20
const COLL_FILTER_OUTER_PER_CHUNK = 1
const COLL_FILTER_OUTER_CHUNK_SIZE = 10

// Per-iter cost: add_jit_cost(5) per element before body eval
// Sigma-rust ref: coll_filter.rs:31
const COLL_FILTER_PER_ITER = 5

/**
 * Evaluate a `Filter` node. Mixed pattern: outer after children, per-iter in loop.
 *
 * @throws EvalError `'coll-input-not-coll'` if input does not eval to a Coll.
 * @throws EvalError `'lambda-not-callable'` if condition does not eval to a callable Lambda.
 * @throws EvalError `'coll-elem-tpe-mismatch'` if input's elem type doesn't match condition's declared arg type,
 *   when `inputColl.elem !== SANY_JVM` and the condition is a `FuncValue` MIR node.
 * @throws EvalError `'lambda-result-type-mismatch'` if a body result is not Boolean.
 * @throws EvalError `'cost-limit-exceeded'` if any cost charge exceeds the limit.
 */
export function evalFilter(e: Filter, env: Env, ctx: EvalContext): SValue {
  // 1. Eval input and condition — Pattern B ordering (eval children first, outer cost after).
  const inputVal = evalExpr(e.input, env, ctx)
  const conditionVal = evalExpr(e.condition, env, ctx)

  // 2. Guard: input must be Coll.
  const inputColl = extractCollItems(inputVal)

  // 3. Guard: condition must be a callable Lambda with at least one arg.
  const closure = extractFuncValue(conditionVal)

  // 3b. Elem-type check: an ergots check with no JVM counterpart. `Filter.eval`
  // (transformers.scala:118-127) does not compare the input's item type with
  // the condition's declared argument type; the JVM hands each item to the
  // closure, whose `FuncValue.eval` returns a function that checks the
  // argument's class against `isValueOfType` at the declared type on each
  // application (`values.scala:1073-1074`, `SType.scala:187-213`). The compare
  // target is `dataItemType(argTpe)` — the item type the data reader gives
  // (`CoreDataSerializer.scala:176-182`), which is `SColl(SAny)` for a tuple
  // argument of another arity than two (`:179-180`): a data `Coll[(A, B, C)]`
  // has `elem: SColl(SAny)` and is admitted here, the per-application check
  // (step 5) refuses the non-pair declared type through `assertCheckedType`
  // on every application. A tuple value of another arity (`tupleColl`,
  // `elem === SANY_JVM` by identity) is also admitted — the per-application
  // check takes it from there.
  if (
    inputColl.elem !== SANY_JVM
    && e.condition.tag === 'FuncValue'
    && e.condition.args.length > 0
  ) {
    const conditionInputTpe = e.condition.args[0]!.tpe
    const dataExpected = dataItemType(conditionInputTpe)
    if (
      !sTypeEquals(inputColl.elem, conditionInputTpe)
      && !sTypeEquals(inputColl.elem, dataExpected)
    ) {
      throw new EvalError(
        `Filter: input elem type ${JSON.stringify(inputColl.elem)} does not match condition declared arg type ${JSON.stringify(conditionInputTpe)} (data reader's item type ${JSON.stringify(dataExpected)})`,
        'coll-elem-tpe-mismatch'
      )
    }
  }

  // 4. Outer cost: add_per_item_jit_cost(20, 1, 10, n) — BEFORE the loop.
  // Sigma-rust coll_filter.rs:61: ctx.add_per_item_jit_cost(20, 1, 10, normalized_input_vals.len())?;
  ctx.addPerItemCost(
    COLL_FILTER_OUTER_BASE,
    COLL_FILTER_OUTER_PER_CHUNK,
    COLL_FILTER_OUTER_CHUNK_SIZE,
    inputColl.items.length
  )

  const argId = closure.argIds[0]!

  // 5. Loop: per-iter cost + env-extend + body eval + result-type check + filter.
  // Sigma-rust coll_filter.rs:63-73: iter().map(|item| condition_call(item)).collect()
  // where condition_call: add_jit_cost(5), env.insert(argId, item), body.eval, env restore.
  // TS uses immutable Env.extend — no save/restore needed.
  // No short-circuit: all items are visited regardless of intermediate results.
  const kept: SValue[] = []
  for (const item of inputColl.items) {
    // v6 P6: reject applying a lambda whose arg type is an unresolved type var (JVM
    // "Unknown type T"). Per-element ⇒ an empty input never binds, never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    // FuncValue.eval (values.scala:1074): Value.checkType reads the arg's declared type and the
    // value's class against the item, before the AddToEnvironmentDesc 5 is charged and before
    // the body is evaluated. Per-element ⇒ an empty input never checks. See eval/_check-type.ts.
    assertCheckedValue(closure.argTpes[0]!, item)
    // Per-iter cost (sigma-rust coll_filter.rs:31).
    ctx.addCost(COLL_FILTER_PER_ITER)
    const bodyEnv = closure.capturedEnv.extend(argId, item)
    // Eval body (sigma-rust coll_filter.rs:33: func_value.body.eval(env, ctx)).
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    // Lambda body (values.scala:1080): Value.checkType reads the body's declared type and the
    // value's class after each application. See eval/_check-type.ts.
    assertCheckedNode(closure.body, itemRes, ctx)
    // Result-type check: Filter's predicate MUST return Boolean.
    // sigma-rust uses try_extract_into::<bool>() which also errors on non-Boolean.
    if (itemRes.kind !== 'Boolean') {
      throw new EvalError(
        `Filter: lambda body returned type '${itemRes.kind}' but predicate must return Boolean`,
        'lambda-result-type-mismatch'
      )
    }
    // Keep item if predicate is true.
    if (itemRes.value) {
      kept.push(item)
    }
  }

  // 6. Return filtered collection preserving input elem type and class.
  // `CollOverArray.filter` (CollsOverArrays.scala:36) keeps the receiver's
  // class (specialised stays specialised); `PairOfCols.filter` (:348-363)
  // rebuilds the pair with plain sides through `pairCollFromArrays`.
  if (inputVal.kind !== 'Coll') throw new Error('unreachable: extractCollItems would have thrown')
  return filtered(inputVal, kept)
}
