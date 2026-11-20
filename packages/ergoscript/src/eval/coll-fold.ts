/**
 * Fold evaluator arm.
 *
 * Applies a binary function (lambda) to a start value (zero) and each element
 * of a collection, going left to right. Returns the final accumulator value.
 * `Fold.eval` (`transformers.scala:224-231`) evaluates input, evaluates zero
 * and runs `Value.checkType(zero, zeroV)` on it (`values.scala:251-255`,
 * `SType.scala:187-213`), evaluates foldOp, charges the sequence cost at
 * the input's length, and runs `inputV.foldLeft(zeroV, foldOpV)`. It makes
 * no other check: in particular it does not compare the lambda's result
 * kind against the zero's. The per-application `FuncValue.eval`
 * (`values.scala:1073-1086`) then checks the argument and the body at each
 * iteration.
 *
 * The lambda takes a single argument of type `STuple([acc_type, item_type])`,
 * not the item directly. The lambda body typically destructures this tuple
 * via SelectField (1-indexed):
 *   `SelectField(1, tup)` → acc  (the current accumulator)
 *   `SelectField(2, tup)` → item (the current element)
 *
 * Cost (Mixed pattern — outer + per-iter):
 *   Outer, AFTER all three child evals (input, zero, fold_op), BEFORE the
 *   loop:
 *     `addPerItemCost(3, 1, 10, inputColl.length)` — JVM
 *     `Fold.costKind = PerItemCost(3, 1, 10)`
 *     (`transformers.scala:232-238`). The sequence cost at the input's
 *     length.
 *   Per-iter, inside the closure, BEFORE body eval:
 *     `addCost(5)` — JVM `FuncValue.eval` `values.scala:1076`:
 *     `addFixedCost(AddToEnvironmentDesc_CostKind, ...)` = 5.
 *
 * Eval order:
 *   1. Eval input  → must be Coll (throws `'coll-input-not-coll'`).
 *   2. Eval zero  → the initial accumulator value. Then
 *      `assertCheckedNode(e.zero, zeroVal, ctx)` runs the JVM's
 *      `Value.checkType(zero, zeroV)` at `transformers.scala:227`.
 *   3. Eval fold_op → must be Lambda (throws `'lambda-not-callable'`).
 *   4. Outer cost: `addPerItemCost(3, 1, 10, n)` AFTER all three child
 *      evals.
 *   5. Per item:
 *      a. Construct `tupArg = { kind: 'Tuple', items: [acc, item] }`.
 *      b. `assertCheckedValue(argTpe, tupArg)` (JVM
 *         `FuncValue.eval`'s `Value.checkType(arg0._2, vArg)` —
 *         `values.scala:1074`, pair-shape check at `SType.scala:200-201`).
 *      c. `addCost(5)`.
 *      d. Bind `closure.argIds[0]` → `tupArg` in a fresh env scope.
 *      e. `acc = evalExpr(closure.body, itemEnv, ctx)`.
 *      f. `assertCheckedNode(closure.body, acc, ctx)` (JVM
 *         `Value.checkType(body, res)`, `values.scala:1080`).
 *   6. Return acc (empty Coll → returns zero unchanged, as `foldLeft`
 *      skips the loop on an empty sequence).
 *
 * Tuple construction: the arg is always a 2-item pair — the arg check at
 * step 5b is the JVM's `Tuple2[_,_]` shape check at `SType.scala:200-201`.
 * The arg type comparison does not recurse into the pair's components, so a
 * body that returns a value of another kind than the zero passes through
 * `foldLeft` and is written back as the next step's accumulator; a
 * subsequent iteration's body check (step 5f) reads the body's static type
 * against the runtime class, and `SType.scala:198-205` is a shape check at
 * the top level (a `Coll[_]` passes a lambda whose body is typed as
 * `SCollectionType`, etc.), not an item-wise recursion.
 *
 * Env-extend convention: TS Env is immutable. For each item we construct
 *   `tupArg` and call `env.extend(argId, tupArg)` to create a new scope.
 */

import type { Fold, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'
import { assertCheckedNode, assertCheckedValue } from './_check-type'

// Outer cost: add_per_item_jit_cost(base=3, per_chunk=1, chunk_size=10, n)
// Sigma-rust ref: coll_fold.rs:48
// NOTE: base=3 — different from Map/Filter (base=20).
const COLL_FOLD_OUTER_BASE = 3
const COLL_FOLD_OUTER_PER_CHUNK = 1
const COLL_FOLD_OUTER_CHUNK_SIZE = 10

// Per-iter cost: add_jit_cost(5) per element before body eval
// Sigma-rust ref: coll_fold.rs:29
const COLL_FOLD_PER_ITER = 5

/**
 * Evaluate a `Fold` node. Mixed pattern: outer after all three children, per-iter in loop.
 *
 * @throws EvalError `'coll-input-not-coll'` if input does not eval to a Coll.
 * @throws EvalError `'lambda-not-callable'` if fold_op does not eval to a callable Lambda.
 * @throws EvalError `'cost-limit-exceeded'` if any cost charge exceeds the limit.
 */
export function evalFold(e: Fold, env: Env, ctx: EvalContext): SValue {
  // 1-3. Eval all three children — Pattern B ordering (eval children first, outer cost after).
  // Sigma-rust coll_fold.rs:18-20: input_v, zero_v, fold_op_v in order.
  const inputVal = evalExpr(e.input, env, ctx)
  const zeroVal = evalExpr(e.zero, env, ctx)
  // Fold.eval (transformers.scala:226-227): Value.checkType reads the zero's declared type and
  // the value's class right after the zero is evaluated. See eval/_check-type.ts.
  assertCheckedNode(e.zero, zeroVal, ctx)
  const foldOpVal = evalExpr(e.foldOp, env, ctx)

  // Guard: input must be Coll.
  const inputColl = extractCollItems(inputVal)

  // Guard: fold_op must be a callable Lambda with at least one arg.
  const closure = extractFuncValue(foldOpVal)

  // 4. Outer cost: add_per_item_jit_cost(3, 1, 10, n) — AFTER all three child evals.
  // Sigma-rust coll_fold.rs:48: ctx.add_per_item_jit_cost(3, 1, 10, n_items)?;
  // n_items is coll.len() — counted before the match (coll_fold.rs:44-47).
  ctx.addPerItemCost(
    COLL_FOLD_OUTER_BASE,
    COLL_FOLD_OUTER_PER_CHUNK,
    COLL_FOLD_OUTER_CHUNK_SIZE,
    inputColl.items.length
  )

  const argId = closure.argIds[0]!

  // 5. Loop: per-iter arg checkType + cost + env-extend + body eval + body
  // checkType. The JVM's `Fold.eval` makes no check of its own here
  // (`transformers.scala:231`); each iteration runs the JVM's
  // `FuncValue.eval`-returned closure (`values.scala:1073-1086`), which
  // checks the argument's class against the declared arg type, binds the
  // arg under `AddToEnvironmentDesc_CostKind` = 5, evaluates the body, and
  // checks the body's result class against its static type. The arg check
  // is the pair-shape check at `SType.scala:200-201` for a 2-item STuple;
  // it does not recurse into the pair's components, so a body that returns
  // a value of another kind than the zero passes into the next
  // iteration's acc as-is and the comparison is left to the body's own
  // checkType and to whatever consumer reads the result after the fold.
  let acc: SValue = zeroVal
  for (const item of inputColl.items) {
    const tupArg: SValue = { kind: 'Tuple', items: [acc, item] }

    // Reject applying a lambda whose arg type is an unresolved type var (the JVM's
    // "Unknown type T" throw at stypeToRType, Evaluation.scala:54-55). Per-element,
    // so an empty input never binds and never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    // FuncValue.eval (values.scala:1074): Value.checkType reads the arg's declared type and the
    // value's class against the (acc, item) tuple, before the AddToEnvironmentDesc 5 is charged
    // and before the body is evaluated. Per-element ⇒ an empty input never checks. The arg type
    // here is a pair STuple(zero, elem); the tuple argument passes the pair-class check by
    // construction, and the type-driven arm catches a declared `SAny`/`NoType`, a non-pair arg
    // type (unreachable from parse, defensive for an API-built node) or a non-unary SFunc.
    // See eval/_check-type.ts.
    assertCheckedValue(closure.argTpes[0]!, tupArg)
    // Per-iter cost: 5 for `AddToEnvironmentDesc` (JVM values.scala:1076).
    ctx.addCost(COLL_FOLD_PER_ITER)
    const itemEnv = closure.capturedEnv.extend(argId, tupArg)

    const newAcc = evalExpr(closure.body, itemEnv, ctx)
    // Lambda body (values.scala:1080): Value.checkType reads the body's declared type and the
    // value's class after each application. See eval/_check-type.ts.
    assertCheckedNode(closure.body, newAcc, ctx)

    acc = newAcc
  }

  // 6. Return acc. For empty Coll, returns zeroVal unchanged (foldLeft
  // skips the loop on an empty sequence).
  return acc
}
