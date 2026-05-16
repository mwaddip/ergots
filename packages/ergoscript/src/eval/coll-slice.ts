/**
 * Slice evaluator arm (phase 2f Coll HOFs Task 5).
 *
 * Returns the intersection of the requested range `[from, until)` with the
 * collection bounds. Scala-compat semantics: does NOT throw on OOB — clips
 * silently (sigma-rust issue #724).
 *
 * Pattern B-chunked: cost charged AFTER all three child evals.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/coll_slice.rs:17-43
 *   let input_v = self.input.eval(env, ctx)?;      // line 17
 *   let from_v  = self.from.eval(env, ctx)?;       // line 18
 *   let until_v = self.until.eval(env, ctx)?;      // line 19
 *   let from = from_v.try_extract_into::<i32>()?;  // line 27
 *   let until = until_v.try_extract_into::<i32>()?;// line 28
 *   // cost scales with REQUESTED range, not input length (bug-7 fix, issue #724)
 *   let n_items = 0i32.max(until - from) as u32;   // line 31
 *   ctx.add_per_item_jit_cost(10, 2, 100, n_items)?; // line 32 — Pattern B-chunked
 *   // intersection with collection bounds
 *   let range = from.max(0) as usize..until.min(input_vec.len() as i32) as usize; // line 36
 *   match input_vec.get(range) { ... }              // line 37-41
 */

import type { Slice, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'

// Cost source: sigma-rust eval/coll_slice.rs:32
//   ctx.add_per_item_jit_cost(10, 2, 100, n_items)?;
// Pattern B-chunked (cost AFTER eval-children). n_items = max(0, until - from).
const COLL_SLICE_BASE = 10
const COLL_SLICE_PER_CHUNK = 2
const COLL_SLICE_CHUNK_SIZE = 100

/**
 * Evaluate a `Slice` node. Pattern B-chunked: cost charged after all children.
 *
 * Cost scales with the REQUESTED RANGE `max(0, until - from)`, not with input
 * length or the clipped output length (sigma-rust issue #724 fix).
 *
 * Intersection semantics: from is clipped to [0, len], until is clipped to
 * [0, len], and if clippedFrom >= clippedUntil the result is empty. No throws
 * on OOB.
 *
 * @throws EvalError `'coll-input-not-coll'` if input is not a Coll.
 * @throws EvalError `'coll-slice-bound-not-int'` if from or until is not Int.
 * @throws EvalError `'cost-limit-exceeded'` if addPerItemCost exceeds the limit.
 */
export function evalSlice(e: Slice, env: Env, ctx: EvalContext): SValue {
  // Pattern B: eval all children FIRST, then charge cost.
  const inputVal = evalExpr(e.input, env, ctx)
  const fromVal = evalExpr(e.from, env, ctx)
  const untilVal = evalExpr(e.until, env, ctx)

  const inputColl = extractCollItems(inputVal)

  if (fromVal.kind !== 'Int') {
    throw new EvalError(
      `Slice: expected from to be Int, got ${fromVal.kind}`,
      'coll-slice-bound-not-int'
    )
  }
  if (untilVal.kind !== 'Int') {
    throw new EvalError(
      `Slice: expected until to be Int, got ${untilVal.kind}`,
      'coll-slice-bound-not-int'
    )
  }

  const fromI = fromVal.value
  const untilI = untilVal.value

  // Cost: max(0, until - from) — the REQUESTED RANGE, not clipped output.
  // sigma-rust coll_slice.rs:31: let n_items = 0i32.max(until - from) as u32;
  const requestedRange = Math.max(0, untilI - fromI)
  ctx.addPerItemCost(COLL_SLICE_BASE, COLL_SLICE_PER_CHUNK, COLL_SLICE_CHUNK_SIZE, requestedRange)

  // Intersection with collection bounds (Scala semantics, no throw on OOB).
  // sigma-rust coll_slice.rs:36: let range = from.max(0) as usize..until.min(len) as usize;
  const len = inputColl.items.length
  const clippedFrom = Math.max(0, fromI)
  const clippedUntil = Math.min(len, untilI)

  // If clippedFrom >= clippedUntil, slice returns empty (JS Array.slice handles this).
  return {
    kind: 'Coll',
    elem: inputColl.elem,
    items: inputColl.items.slice(clippedFrom, clippedUntil),
  }
}
