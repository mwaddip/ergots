/**
 * Exists evaluator arm — fourth lambda HOF (phase 2f Coll HOFs Task 9).
 *
 * Returns true if at least one element of a collection satisfies a boolean
 * predicate (lambda). Short-circuits on the first true element; returns false
 * for empty collections or when no element matches.
 *
 * Cost: Mixed pattern — outer + per-iter.
 *   Sigma-rust ref: ergotree-interpreter/src/eval/coll_exists.rs:12-69
 *
 *   Outer (line 60, AFTER input/condition eval AND elem_tpe check, BEFORE loop):
 *     ctx.add_per_item_jit_cost(3, 1, 10, n)  where n = FULL inputColl.length
 *     NOTE: outer cost is (3, 1, 10) — same as Fold, DIFFERENT from Map/Filter's (20, 1, 10).
 *     CRITICAL: n is the FULL input length, charged BEFORE the loop. Short-circuiting
 *     at item 1 of 1000 still incurs outer = addPerItemCost(3, 1, 10, 1000) = 103.
 *
 *   Per-iter (line 29, inside closure, BEFORE body eval):
 *     ctx.add_jit_cost(5) — only for VISITED items (short-circuit reduces visits).
 *
 * Eval order (sigma-rust coll_exists.rs:18-68):
 *   1. Eval input  → must be Coll  (throws 'coll-input-not-coll')
 *   2. Eval condition → must be Lambda (throws 'lambda-not-callable')
 *   3. Elem-type check: input.elem vs declared elem_tpe
 *      (sigma-rust coll_exists.rs:46-52: `coll.elem_tpe() != &*self.elem_tpe`)
 *      In TS, Exists MIR has no `elemTpe` field; derive from condition.args[0].tpe
 *      when condition is a FuncValue node (mirrors Filter's approach — Task 7).
 *      Throws 'coll-elem-tpe-mismatch'.
 *   4. Outer cost: addPerItemCost(3, 1, 10, n) — charges FULL length BEFORE loop
 *   5. For each item (sigma-rust coll_exists.rs:62-66):
 *      a. addCost(5)
 *      b. env.extend(argId, item)
 *      c. Eval body, assert `kind === 'Boolean'` (else 'lambda-result-type-mismatch')
 *      d. If value === true → return { kind: 'Boolean', value: true } (SHORT-CIRCUIT)
 *   6. After loop: return { kind: 'Boolean', value: false }
 *      Empty Coll → false (loop never runs; per-iter cost = 0).
 *
 * Key difference from Filter (Task 7):
 *   - Exists short-circuits on first true (Filter visits ALL items).
 *   - Exists returns Boolean; Filter returns Coll.
 *   - Outer cost params: (3, 1, 10) not (20, 1, 10).
 *
 * Key difference from Fold (Task 8):
 *   - Exists has two children (input, condition), not three.
 *   - Exists returns Boolean, not the accumulator value.
 *   - Exists short-circuits; Fold visits all items.
 *
 * Env-extend convention (same as Map/Filter — established for Tasks 7-10):
 *   TS Env is immutable. For each item we call env.extend(argId, item) to
 *   create a new scope. No save/restore needed (unlike sigma-rust's mutable env).
 *
 * Elem-type check (sigma-rust coll_exists.rs:46-52):
 *   Sigma-rust checks `coll.elem_tpe() != &*self.elem_tpe` where `self.elem_tpe`
 *   is derived from the input's SColl element type at Exists::new() construction.
 *   In TS, where Exists MIR has no `elemTpe` field, we derive the expected type
 *   from the condition when it is a FuncValue node (condition.args[0].tpe).
 *   This matches the mismatch fixture where the declared arg type (SLong) differs
 *   from the runtime input elem (SInt).
 *   When condition is not a FuncValue, skip the static check.
 *
 * Result-type check:
 *   Exists's predicate MUST return Boolean. Each per-item result is checked:
 *   if `itemRes.kind !== 'Boolean'` → throws 'lambda-result-type-mismatch'.
 *   This is explicitly enforced in TS (sigma-rust uses try_extract_into::<bool>()
 *   which also errors on non-Boolean results).
 *
 * SMOKING-GUN (outer-cost-on-full-length subtlety):
 *   Input [true, false, false, ..., false] (1000 items), predicate = identity.
 *   Short-circuit fires at item 1 (first item is true).
 *   Outer cost = addPerItemCost(3, 1, 10, 1000) = 103 (FULL n, charged BEFORE loop).
 *   Per-iter cost = 1 * 5 = 5 (only item 1 visited).
 *   Arm contribution = 108. NOT 9 (which would be outer(n=1)+5 = 4+5).
 */

import type { Exists, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { assertArgTypeResolved } from './_lambda'
import { sTypeEquals } from '../mir/stype-helpers'

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
 * @throws EvalError `'coll-elem-tpe-mismatch'` if input's elem type doesn't match condition's declared arg type.
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

  // 3b. Elem-type check: input.elem must match condition's declared arg type.
  // Sigma-rust coll_exists.rs:46-52: `if coll.elem_tpe() != &*self.elem_tpe → EvalError`.
  // `self.elem_tpe` is derived from the input SColl at Exists::new() construction time.
  // TS MIR Exists has no `elemTpe` field; we derive the expected input type from
  // e.condition when it is a FuncValue MIR node (i.e., e.condition.args[0].tpe).
  // When condition is not a FuncValue node (ValUse etc.), skip — the extractFuncValue
  // guard above already enforces callable-at-runtime.
  if (e.condition.tag === 'FuncValue' && e.condition.args.length > 0) {
    const conditionInputTpe = e.condition.args[0]!.tpe
    if (!sTypeEquals(inputColl.elem, conditionInputTpe)) {
      throw new EvalError(
        `Exists: input elem type ${JSON.stringify(inputColl.elem)} does not match condition declared arg type ${JSON.stringify(conditionInputTpe)}`,
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
    // Per-iter cost (sigma-rust coll_exists.rs:29: ctx.add_jit_cost(5)?).
    // Only charged for VISITED items — short-circuit reduces the number of charges.
    ctx.addCost(COLL_EXISTS_PER_ITER)

    // Extend the lambda's CAPTURED (definition-site) env with the arg binding
    // — lexical scoping, JVM-faithful for v6 (sigma-rust coll_exists.rs:30:
    // env.insert(func_arg.idx, arg)). For inline predicate lambdas capturedEnv
    // == the caller env (no-op); differs only for out-of-scope-captured lambdas.
    // v6 P6: reject a type-var arg type at the per-element apply (JVM
    // "Unknown type T"). Per-element ⇒ an empty input never binds, never throws.
    assertArgTypeResolved(closure.argTpes[0]!)
    const bodyEnv = closure.capturedEnv.extend(argId, item)

    // Eval body (sigma-rust coll_exists.rs:31: func_value.body.eval(env, ctx)).
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)

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
