/**
 * Filter evaluator arm — second lambda HOF (phase 2f Coll HOFs Task 7).
 *
 * Selects all elements of a collection for which a predicate (boolean-returning
 * lambda) returns true, returning a new collection of the passing elements.
 *
 * Cost: Mixed pattern — outer + per-iter.
 *   Sigma-rust ref: ergotree-interpreter/src/eval/coll_filter.rs:15-90
 *
 *   Outer (line 61, AFTER input/condition eval, BEFORE loop):
 *     ctx.add_per_item_jit_cost(20, 1, 10, n)  where n = inputColl.length
 *
 *   Per-iter (line 31, inside closure, BEFORE body eval):
 *     ctx.add_jit_cost(5)
 *
 * Eval order (Mixed pattern):
 *   1. Eval input  → must be Coll  (throws 'coll-input-not-coll')
 *   2. Eval condition → must be Lambda (throws 'lambda-not-callable')
 *   3. Elem-type check: inputColl.elem vs declared elem_tpe on the Filter MIR
 *      (sigma-rust coll_filter.rs:52-58: `coll.elem_tpe() != &*self.elem_tpe`)
 *      In TS, the Filter MIR has no `elemTpe` field, so the elem_tpe is
 *      equivalent to `inputColl.elem` at runtime — the check cannot mismatch
 *      via normal paths. For the mismatch fixture, we detect via condition's
 *      declared arg type when the condition is a FuncValue MIR node.
 *      Throws 'coll-elem-tpe-mismatch'.
 *   4. Outer cost: addPerItemCost(20, 1, 10, n)
 *   5. Per item: addCost(5), env.extend(argId, item), eval body,
 *      result-type check MUST be Boolean (throws 'lambda-result-type-mismatch'),
 *      collect item if true
 *   6. No short-circuit — all items visited (cost determinism)
 *   7. Return { kind: 'Coll', elem: inputColl.elem, items: kept }
 *
 * Key difference from Map (Task 6):
 *   - Elem-type check: Filter's check is against `self.elem_tpe` (the declared
 *     elem type stored on the MIR node, derived from input at construction time).
 *     TS MIR Filter has no `elemTpe` field; we detect mismatches via the condition
 *     FuncValue's declared arg type (condition.args[0].tpe) when available.
 *   - Result type: Map accumulates any result type; Filter body MUST return Boolean.
 *
 * Env-extend convention (same as Map — established for Tasks 7-10):
 *   TS Env is immutable. For each item we call env.extend(argId, item) to
 *   create a new scope. No save/restore needed (unlike sigma-rust's mutable env).
 *
 * Elem-type check (sigma-rust coll_filter.rs:52-58):
 *   Sigma-rust checks `coll.elem_tpe() != &*self.elem_tpe` where `self.elem_tpe`
 *   is derived from the input's SColl element type at Filter::new() construction.
 *   In TS, where Filter MIR has no `elemTpe` field, we can derive the expected
 *   input type from the condition when it is a FuncValue node
 *   (condition.args[0].tpe). This matches the mismatch fixture where the declared
 *   arg type (SLong) differs from the runtime input elem (SInt).
 *   When condition is not a FuncValue, skip the static check.
 *
 * Result-type check:
 *   Filter's predicate MUST return Boolean. Each per-item result is checked:
 *   if `itemRes.kind !== 'Boolean'` → throws 'lambda-result-type-mismatch'.
 *   This is explicitly enforced in TS (sigma-rust uses try_extract_into::<bool>()
 *   which also errors on non-Boolean results).
 */

import type { Filter, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { sTypeEquals } from '../mir/stype-helpers'

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
 * @throws EvalError `'coll-elem-tpe-mismatch'` if input's elem type doesn't match condition's declared arg type.
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

  // 3b. Elem-type check: input.elem must match condition's declared arg type.
  // Sigma-rust coll_filter.rs:52-58: `if coll.elem_tpe() != &*self.elem_tpe → EvalError`.
  // `self.elem_tpe` is derived from the input SColl at Filter::new() construction time.
  // TS MIR Filter has no `elemTpe` field; we derive the expected input type from
  // e.condition when it is a FuncValue MIR node (i.e., e.condition.args[0].tpe).
  // When condition is not a FuncValue node (ValUse etc.), skip — the extractFuncValue
  // guard above already enforces callable-at-runtime.
  if (e.condition.tag === 'FuncValue' && e.condition.args.length > 0) {
    const conditionInputTpe = e.condition.args[0]!.tpe
    if (!sTypeEquals(inputColl.elem, conditionInputTpe)) {
      throw new EvalError(
        `Filter: input elem type ${JSON.stringify(inputColl.elem)} does not match condition declared arg type ${JSON.stringify(conditionInputTpe)}`,
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
    // Per-iter cost (sigma-rust coll_filter.rs:31).
    ctx.addCost(COLL_FILTER_PER_ITER)
    // Extend env with arg binding (sigma-rust coll_filter.rs:32: env.insert(func_arg.idx, arg)).
    const bodyEnv = env.extend(argId, item)
    // Eval body (sigma-rust coll_filter.rs:33: func_value.body.eval(env, ctx)).
    const itemRes = evalExpr(closure.body, bodyEnv, ctx)
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

  // 6. Return filtered collection preserving input elem type.
  // Sigma-rust coll_filter.rs:74-78: CollKind::from_collection(self.elem_tpe, filtered).
  // Elem type is always `inputColl.elem` (same as sigma-rust's self.elem_tpe which is
  // derived from the input SColl at construction time).
  return { kind: 'Coll', elem: inputColl.elem, items: kept }
}
