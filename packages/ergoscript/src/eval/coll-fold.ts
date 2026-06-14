/**
 * Fold evaluator arm — third lambda HOF (phase 2f Coll HOFs Task 8).
 *
 * Applies a binary function (lambda) to a start value (zero) and all elements
 * of a collection, going left to right. Returns the final accumulator value.
 *
 * Structurally distinct from Map/Filter: the lambda takes a single argument
 * of type `STuple([acc_type, item_type])`, not the item directly. The lambda
 * body typically destructures this tuple via SelectField (1-indexed):
 *   SelectField(1, tup) → acc  (the current accumulator)
 *   SelectField(2, tup) → item (the current element)
 *
 * This mirrors sigma-rust's `Value::Tup([acc, item].into())` at coll_fold.rs:53,61.
 *
 * Cost: Mixed pattern — outer + per-iter.
 *   Sigma-rust ref: ergotree-interpreter/src/eval/coll_fold.rs:12-71
 *
 *   Outer (line 48, AFTER all three child evals, BEFORE loop):
 *     ctx.add_per_item_jit_cost(3, 1, 10, n)  where n = inputColl.length
 *     NOTE: outer cost is (3, 1, 10) — DIFFERENT from Map/Filter's (20, 1, 10).
 *
 *   Per-iter (line 29, inside closure, BEFORE body eval):
 *     ctx.add_jit_cost(5)
 *
 * Eval order (sigma-rust coll_fold.rs:18-20, 48, 49-63):
 *   1. Eval input  → must be Coll  (throws 'coll-input-not-coll')
 *   2. Eval zero   → initial accumulator value
 *   3. Eval fold_op → must be Lambda (throws 'lambda-not-callable')
 *   4. Outer cost: addPerItemCost(3, 1, 10, n) — AFTER all three children
 *   5. For each item in input:
 *      a. addCost(5)
 *      b. Construct tupArg = { kind: 'Tuple', items: [acc, item] }
 *      c. Bind closure.argIds[0] → tupArg in a fresh env scope
 *      d. acc = evalExpr(closure.body, itemEnv, ctx)
 *      e. Result-type check: new acc kind must equal original zero kind
 *         (throws 'lambda-result-type-mismatch' on mismatch)
 *   6. Return acc (empty Coll → returns zero unchanged, per sigma-rust try_fold)
 *
 * Empty Coll: sigma-rust's `iter().try_fold(zero_v, ...)` returns `zero_v` for
 * empty input without entering the closure. Cost: outer only (n=0 → base=3).
 *
 * Tuple construction (sigma-rust coll_fold.rs:53, 61):
 *   NativeColl:  Value::Tup([acc, Value::Byte(*byte)].into())
 *   WrappedColl: Value::Tup([acc, item.clone()].into())
 * In TS, extractCollItems unpacks both kinds into SValue[] uniformly, so the
 * Tuple construction is always: { kind: 'Tuple', items: [acc, item] }.
 *
 * Result-type check:
 *   Sigma-rust: typed accumulator enforced by the MIR type system. In TS we
 *   check that the new acc.kind equals the original zero.kind after each iter.
 *   Throws 'lambda-result-type-mismatch' if the types diverge.
 *   This aligns with the fixture: a body returning Boolean(true) when zero is
 *   Int(0) will trigger the check on the first iteration.
 *
 * Env-extend convention (same as Map/Filter — established for Tasks 7-10):
 *   TS Env is immutable. For each item we construct tupArg and call
 *   env.extend(argId, tupArg) to create a new scope. No save/restore needed
 *   (unlike sigma-rust's mutable env insert/remove).
 */

import type { Fold, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'

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
 * @throws EvalError `'lambda-result-type-mismatch'` if a body result changes the acc type.
 * @throws EvalError `'cost-limit-exceeded'` if any cost charge exceeds the limit.
 */
export function evalFold(e: Fold, env: Env, ctx: EvalContext): SValue {
  // 1-3. Eval all three children — Pattern B ordering (eval children first, outer cost after).
  // Sigma-rust coll_fold.rs:18-20: input_v, zero_v, fold_op_v in order.
  const inputVal = evalExpr(e.input, env, ctx)
  const zeroVal = evalExpr(e.zero, env, ctx)
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

  // Record the original zero's kind for per-iteration result-type checking.
  // The acc type must not change across iterations (sigma-rust: type system enforces this
  // statically; TS enforces it dynamically via kind comparison).
  const zeroKind = zeroVal.kind

  // 5. Loop: per-iter cost + Tuple construction + env-extend + body eval + result-type check.
  // Sigma-rust coll_fold.rs:49-63:
  //   - NativeColl path (CollByte): Value::Tup([acc, Value::Byte(*byte)])
  //   - WrappedColl path:           Value::Tup([acc, item.clone()])
  // In TS: extractCollItems unpacks both paths uniformly as SValue[].
  // For each item, construct { kind: 'Tuple', items: [acc, item] } and bind to argId.
  // Sigma-rust: per-iter cost at line 29 (before body eval), env insert at line 30.
  let acc: SValue = zeroVal
  for (const item of inputColl.items) {
    // Per-iter cost (sigma-rust coll_fold.rs:29: ctx.add_jit_cost(5)?).
    ctx.addCost(COLL_FOLD_PER_ITER)

    // Construct the 2-tuple argument: { kind: 'Tuple', items: [acc, item] }
    // Mirrors sigma-rust coll_fold.rs:53: Value::Tup([acc, Value::Byte(*byte)].into())
    // and coll_fold.rs:61: Value::Tup([acc, item.clone()].into())
    const tupArg: SValue = { kind: 'Tuple', items: [acc, item] }

    // Extend the lambda's CAPTURED (definition-site) env with the arg binding
    // — lexical scoping, JVM-faithful for v6 (sigma-rust coll_fold.rs:30:
    // env.insert(func_arg.idx, arg)). For inline fold_op lambdas capturedEnv ==
    // the caller env (no-op); differs only for out-of-scope-captured lambdas.
    // v6 P6: reject a type-var arg type at the per-element apply (JVM
    // "Unknown type T"). Per-element ⇒ an empty input never binds, never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    const itemEnv = closure.capturedEnv.extend(argId, tupArg)

    // Eval body (sigma-rust coll_fold.rs:31: func_value.body.eval(env, ctx)).
    const newAcc = evalExpr(closure.body, itemEnv, ctx)

    // Result-type check: acc kind must remain consistent across iterations.
    // Sigma-rust: type system prevents kind mismatch statically; TS does it dynamically.
    if (newAcc.kind !== zeroKind) {
      throw new EvalError(
        `Fold: lambda body returned type '${newAcc.kind}' but accumulator type is '${zeroKind}' (from zero)`,
        'lambda-result-type-mismatch'
      )
    }

    acc = newAcc
  }

  // 6. Return acc. For empty Coll, returns zeroVal unchanged (closure never called).
  // Sigma-rust: try_fold returns Ok(zero_v) immediately for empty iters.
  return acc
}
