/**
 * Exists evaluator arm.
 *
 * Returns true if at least one element of a collection satisfies a boolean
 * predicate (lambda). Short-circuits on the first true element; returns
 * false for empty collections or when no element matches. `Exists.eval`
 * (`transformers.scala:143-152`) evaluates the input and condition,
 * charges the sequence cost at the input's full length, and runs
 * `inputV.exists(conditionV)`.
 *
 * Cost (Mixed pattern — outer + per-iter):
 *   Outer, AFTER input and condition are evaluated, BEFORE the loop:
 *     `addPerItemCost(3, 1, 10, inputColl.length)` — JVM
 *     `Exists.costKind = PerItemCost(3, 1, 10)`
 *     (`transformers.scala:153-160`). The sequence cost reads the FULL
 *     input length, so short-circuiting at item 1 of 1000 still charges
 *     the outer for n=1000.
 *   Per-iter, inside the closure, BEFORE body eval:
 *     `addCost(5)` — JVM `FuncValue.eval` `values.scala:1076`:
 *     `addFixedCost(AddToEnvironmentDesc_CostKind, ...)` = 5. Only visited
 *     items are charged (short-circuit reduces visits).
 *
 * Eval order:
 *   1. Eval input  → must be Coll (throws `'coll-input-not-coll'`).
 *   2. Eval condition → must be Lambda (throws `'lambda-not-callable'`).
 *   3. Elem-type check: an ergots check with no JVM counterpart (see the
 *      block in the arm). Skipped when `inputColl.elem === SANY_JVM`
 *      (tuple-collection `Coll[Any]` value): the per-application class
 *      check (step 5) takes it from there. For every other input the check
 *      stays, throwing `'coll-elem-tpe-mismatch'` on a declared-arg-type
 *      mismatch.
 *   4. Outer cost: `addPerItemCost(3, 1, 10, n)` at the FULL input length.
 *   5. Per item: `assertCheckedValue(argTpe, item)` (JVM
 *      `FuncValue.eval`'s `Value.checkType(arg0._2, vArg)`), `addCost(5)`,
 *      `env.extend(argId, item)`, eval body, `assertCheckedNode(body, res)`
 *      (JVM `Value.checkType(body, res)`), result-type check
 *      `kind === 'Boolean'` (throws `'lambda-result-type-mismatch'` on a
 *      non-Boolean body). If the body is true, return
 *      `{ kind: 'Boolean', value: true }` (short-circuit).
 *   6. After loop (or empty Coll): return `{ kind: 'Boolean', value: false }`.
 *
 * Env-extend convention: TS Env is immutable. For each item we call
 *   `env.extend(closure.argIds[0], item)` to create a new scope.
 */

import type { Exists, SValue } from '../mir/types'
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

// Outer cost: add_per_item_jit_cost(base=3, per_chunk=1, chunk_size=10, n)
// Sigma-rust ref: coll_exists.rs:60
// NOTE: base=3 — same as Fold (coll_fold.rs:48), different from Map/Filter (base=20).
const COLL_EXISTS_OUTER_BASE = 3
const COLL_EXISTS_OUTER_PER_CHUNK = 1
const COLL_EXISTS_OUTER_CHUNK_SIZE = 10

// Per-iter cost: add_jit_cost(5) per visited element before body eval
// Sigma-rust ref: coll_exists.rs:29
const COLL_EXISTS_PER_ITER = 5

/**
 * Evaluate an `Exists` node. Mixed pattern: outer after children (FULL n), per-iter in loop.
 * Short-circuits on first true; returns false for empty or no-match.
 *
 * @throws EvalError `'coll-input-not-coll'` if input does not eval to a Coll.
 * @throws EvalError `'lambda-not-callable'` if condition does not eval to a callable Lambda.
 * @throws EvalError `'coll-elem-tpe-mismatch'` if input's elem type doesn't match condition's declared arg type,
 *   when `inputColl.elem !== SANY_JVM` and the condition is a `FuncValue` MIR node.
 * @throws EvalError `'lambda-result-type-mismatch'` if a body result is not Boolean.
 * @throws EvalError `'cost-limit-exceeded'` if any cost charge exceeds the limit.
 */
export function evalExists(e: Exists, env: Env, ctx: EvalContext): SValue {
  // 1. Eval input and condition — Pattern B ordering (eval children first, outer cost after).
  // Sigma-rust coll_exists.rs:18-19: input_v, condition_v in order.
  const inputVal = evalExpr(e.input, env, ctx)
  const conditionVal = evalExpr(e.condition, env, ctx)

  // 2. Guard: input must be Coll.
  const inputColl = extractCollItems(inputVal)

  // 3. Guard: condition must be a callable Lambda with at least one arg.
  const closure = extractFuncValue(conditionVal)

  // 3b. Elem-type check: an ergots check with no JVM counterpart. `Exists.eval`
  // (transformers.scala:143-152) does not compare the input's item type with
  // the condition's declared argument type; the JVM hands each item to the
  // closure, whose `FuncValue.eval` returns a function that checks the
  // argument's class against `isValueOfType` at the declared type on each
  // application (`values.scala:1073-1074`, `SType.scala:187-213`). The compare
  // target is `dataItemType(argTpe)` — the item type the data reader gives
  // (`CoreDataSerializer.scala:176-182`), which is `SColl(SAny)` for a tuple
  // argument of another arity than two (`:179-180`): a data `Coll[(A, B, C)]`
  // has `elem: SColl(SAny)` and is admitted here. A `tupleColl` top-level
  // tuple value of another arity (`elem === SANY_JVM`) is also admitted —
  // the per-application class check takes it from there.
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
        `Exists: input elem type ${JSON.stringify(inputColl.elem)} does not match condition declared arg type ${JSON.stringify(conditionInputTpe)} (data reader's item type ${JSON.stringify(dataExpected)})`,
        'coll-elem-tpe-mismatch'
      )
    }
  }

  // 4. Outer cost: add_per_item_jit_cost(3, 1, 10, n) — charges FULL length BEFORE the loop.
  // Sigma-rust coll_exists.rs:60: ctx.add_per_item_jit_cost(3, 1, 10, normalized_input_vals.len())?;
  // CRITICAL: n = inputColl.items.length (FULL length, not visited count).
  // Short-circuiting at item 1 of 1000 still charges outer for n=1000.
  ctx.addPerItemCost(
    COLL_EXISTS_OUTER_BASE,
    COLL_EXISTS_OUTER_PER_CHUNK,
    COLL_EXISTS_OUTER_CHUNK_SIZE,
    inputColl.items.length
  )

  const argId = closure.argIds[0]!

  // 5. Loop: per-iter cost + env-extend + body eval + result-type check + short-circuit.
  // Sigma-rust coll_exists.rs:62-66:
  //   for item in normalized_input_vals {
  //     let res = condition_call(item)?.try_extract_into::<bool>()?;
  //     if res { return Ok(true.into()); }
  //   }
  // TS uses immutable Env.extend — no save/restore needed.
  // Short-circuit: return immediately on first true (unlike Filter which visits ALL items).
  for (const item of inputColl.items) {
    // v6 P6: reject applying a lambda whose arg type is an unresolved type var (JVM
    // "Unknown type T"). Per-element ⇒ an empty input never binds, never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    // FuncValue.eval (values.scala:1074): Value.checkType reads the arg's declared type and the
    // value's class against the item, before the AddToEnvironmentDesc 5 is charged and before
    // the body is evaluated. Per-element ⇒ an empty input never checks. See eval/_check-type.ts.
    assertCheckedValue(closure.argTpes[0]!, item)
    // Per-iter cost (sigma-rust coll_exists.rs:29: ctx.add_jit_cost(5)?).
    // Only charged for VISITED items — short-circuit reduces the number of charges.
    ctx.addCost(COLL_EXISTS_PER_ITER)
    const bodyEnv = closure.capturedEnv.extend(argId, item)

    // Eval body (sigma-rust coll_exists.rs:31: func_value.body.eval(env, ctx)).
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    // Lambda body (values.scala:1080): Value.checkType reads the body's declared type and the
    // value's class after each application. See eval/_check-type.ts.
    assertCheckedNode(closure.body, itemRes, ctx)

    // Result-type check: Exists's predicate MUST return Boolean.
    // sigma-rust uses try_extract_into::<bool>() which also errors on non-Boolean.
    if (itemRes.kind !== 'Boolean') {
      throw new EvalError(
        `Exists: lambda body returned type '${itemRes.kind}' but predicate must return Boolean`,
        'lambda-result-type-mismatch'
      )
    }

    // SHORT-CIRCUIT: if predicate is true, return immediately.
    // Sigma-rust coll_exists.rs:64-66: if res { return Ok(true.into()); }
    if (itemRes.value) {
      return { kind: 'Boolean', value: true }
    }
  }

  // 6. After loop (or empty Coll): return false.
  // Sigma-rust coll_exists.rs:68: Ok(false.into())
  return { kind: 'Boolean', value: false }
}
