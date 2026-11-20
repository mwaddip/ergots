/**
 * ForAll evaluator arm.
 *
 * Returns true if every element of a collection satisfies a boolean
 * predicate (lambda). Short-circuits on the first false element; returns
 * true for empty collections (vacuous truth) or when every element
 * matches. `ForAll.eval` (`transformers.scala:171-180`) evaluates the
 * input and condition, charges the sequence cost at the input's full
 * length, and runs `inputV.forall(conditionV)`.
 *
 * Cost (Mixed pattern — outer + per-iter):
 *   Outer, AFTER input and condition are evaluated, BEFORE the loop:
 *     `addPerItemCost(3, 1, 10, inputColl.length)` — JVM
 *     `ForAll.costKind = PerItemCost(3, 1, 10)`
 *     (`transformers.scala:181-188`). The sequence cost reads the FULL
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
 *      non-Boolean body). If the body is false, return
 *      `{ kind: 'Boolean', value: false }` (short-circuit).
 *   6. After loop (or empty Coll): return `{ kind: 'Boolean', value: true }`.
 *
 * Env-extend convention: TS Env is immutable. For each item we call
 *   `env.extend(closure.argIds[0], item)` to create a new scope.
 */

import type { ForAll, SValue } from '../mir/types'
import { SANY_JVM } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'
import { assertCheckedNode, assertCheckedValue } from './_check-type'
import { sTypeEquals } from '../mir/stype-helpers'
import { dataItemType } from './_coll'

// Outer cost: add_per_item_jit_cost(base=3, per_chunk=1, chunk_size=10, n)
// Sigma-rust ref: coll_forall.rs:60
// NOTE: base=3 — same as Exists/Fold (coll_exists.rs:60, coll_fold.rs:48), different from Map/Filter (base=20).
const COLL_FORALL_OUTER_BASE = 3
const COLL_FORALL_OUTER_PER_CHUNK = 1
const COLL_FORALL_OUTER_CHUNK_SIZE = 10

// Per-iter cost: add_jit_cost(5) per visited element before body eval
// Sigma-rust ref: coll_forall.rs:29
const COLL_FORALL_PER_ITER = 5

/**
 * Evaluate a `ForAll` node. Mixed pattern: outer after children (FULL n), per-iter in loop.
 * Short-circuits on first false; returns true for empty or all-match.
 *
 * @throws EvalError `'coll-input-not-coll'` if input does not eval to a Coll.
 * @throws EvalError `'lambda-not-callable'` if condition does not eval to a callable Lambda.
 * @throws EvalError `'coll-elem-tpe-mismatch'` if input's elem type doesn't match condition's declared arg type,
 *   when `inputColl.elem !== SANY_JVM` and the condition is a `FuncValue` MIR node.
 * @throws EvalError `'lambda-result-type-mismatch'` if a body result is not Boolean.
 * @throws EvalError `'cost-limit-exceeded'` if any cost charge exceeds the limit.
 */
export function evalForAll(e: ForAll, env: Env, ctx: EvalContext): SValue {
  // 1. Eval input and condition — Pattern B ordering (eval children first, outer cost after).
  // Sigma-rust coll_forall.rs:18-19: input_v, condition_v in order.
  const inputVal = evalExpr(e.input, env, ctx)
  const conditionVal = evalExpr(e.condition, env, ctx)

  // 2. Guard: input must be Coll.
  const inputColl = extractCollItems(inputVal)

  // 3. Guard: condition must be a callable Lambda with at least one arg.
  const closure = extractFuncValue(conditionVal)

  // 3b. Elem-type check: an ergots check with no JVM counterpart. `ForAll.eval`
  // (transformers.scala:171-180) does not compare the input's item type with
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
        `ForAll: input elem type ${JSON.stringify(inputColl.elem)} does not match condition declared arg type ${JSON.stringify(conditionInputTpe)} (data reader's item type ${JSON.stringify(dataExpected)})`,
        'coll-elem-tpe-mismatch'
      )
    }
  }

  // 4. Outer cost: add_per_item_jit_cost(3, 1, 10, n) — charges FULL length BEFORE the loop.
  // Sigma-rust coll_forall.rs:60: ctx.add_per_item_jit_cost(3, 1, 10, normalized_input_vals.len())?;
  // CRITICAL: n = inputColl.items.length (FULL length, not visited count).
  // Short-circuiting at item 1 of 1000 still charges outer for n=1000.
  ctx.addPerItemCost(
    COLL_FORALL_OUTER_BASE,
    COLL_FORALL_OUTER_PER_CHUNK,
    COLL_FORALL_OUTER_CHUNK_SIZE,
    inputColl.items.length
  )

  const argId = closure.argIds[0]!

  // 5. Loop: per-iter cost + env-extend + body eval + result-type check + short-circuit.
  // Sigma-rust coll_forall.rs:62-66:
  //   for item in normalized_input_vals {
  //     let res = condition_call(item)?.try_extract_into::<bool>()?;
  //     if !res { return Ok(false.into()); }
  //   }
  // TS uses immutable Env.extend — no save/restore needed.
  // SHORT-CIRCUIT: return immediately on first FALSE (unlike Filter which visits ALL items).
  // NOTE: This is the inverse of Exists (which short-circuits on first true).
  for (const item of inputColl.items) {
    // Reject applying a lambda whose arg type is an unresolved type var (the JVM's
    // "Unknown type T" throw at stypeToRType, Evaluation.scala:54-55). Per-element,
    // so an empty input never binds and never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    // FuncValue.eval (values.scala:1074): Value.checkType reads the arg's declared type and the
    // value's class against the item, before the AddToEnvironmentDesc 5 is charged and before
    // the body is evaluated. Per-element ⇒ an empty input never checks. See eval/_check-type.ts.
    assertCheckedValue(closure.argTpes[0]!, item)
    // Per-iter cost (sigma-rust coll_forall.rs:29: ctx.add_jit_cost(5)?).
    // Only charged for VISITED items — short-circuit reduces the number of charges.
    ctx.addCost(COLL_FORALL_PER_ITER)
    const bodyEnv = closure.capturedEnv.extend(argId, item)

    // Eval body (sigma-rust coll_forall.rs:31: func_value.body.eval(env, ctx)).
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
    // Lambda body (values.scala:1080): Value.checkType reads the body's declared type and the
    // value's class after each application. See eval/_check-type.ts.
    assertCheckedNode(closure.body, itemRes, ctx)

    // Result-type check: ForAll's predicate MUST return Boolean.
    // sigma-rust uses try_extract_into::<bool>() which also errors on non-Boolean.
    if (itemRes.kind !== 'Boolean') {
      throw new EvalError(
        `ForAll: lambda body returned type '${itemRes.kind}' but predicate must return Boolean`,
        'lambda-result-type-mismatch'
      )
    }

    // SHORT-CIRCUIT: if predicate is false, return immediately.
    // Sigma-rust coll_forall.rs:64-66: if !res { return Ok(false.into()); }
    if (!itemRes.value) {
      return { kind: 'Boolean', value: false }
    }
  }

  // 6. After loop (or empty Coll): return true.
  // Sigma-rust coll_forall.rs:68: Ok(true.into())
  // NOTE: Empty Coll → true (vacuous truth). This is the OPPOSITE of Exists's false.
  return { kind: 'Boolean', value: true }
}
