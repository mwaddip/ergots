/**
 * ByIndex evaluator arm (phase 2f Coll HOFs Task 4).
 *
 * Returns `items[index]` when in-bounds, or evaluates the optional `default`
 * expression on out-of-bounds. Negative indices are treated as OOB.
 *
 * Pattern A: cost charged BEFORE evaluating any child.
 *
 * Tree-version-dependent semantics (mirrors sigma-rust):
 *   - V3+: default is evaluated LAZILY — only when the index is OOB.
 *   - V0/V1/V2: default is evaluated EAGERLY — even on an in-bounds access.
 * The smoking-gun pair in the fixture tests (entries 6+7) uses treeVersion=3
 * to demonstrate the lazy path (in-bounds cost < OOB-with-default cost).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/coll_by_index.rs:12-50
 *   ctx.add_jit_cost(30)?;                           // line 18 — Pattern A, Fixed(30)
 *   let input_v = self.input.eval(env, ctx)?;        // line 19
 *   let index_v = self.index.eval(env, ctx)?;        // line 20
 *   match self.default {
 *     Some(default) => {
 *       let mut default_v = || default.eval(env, ctx); // line 30 — LAZY closure (V3+)
 *       if ctx.tree_version() >= V3 {
 *         val.map(Ok).unwrap_or_else(default_v)        // line 34 — lazy (V3+)
 *       } else {
 *         Ok(val.unwrap_or(default_v()?)               // line 36 — eager (V0-V2)
 *       }
 *     }
 *     None => ... .ok_or_else(|| EvalError::Misc(...)) // line 40-47 — OOB throws
 *   }
 */

import type { ByIndex, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'

// Cost source: sigma-rust eval/coll_by_index.rs:18
//   ctx.add_jit_cost(30)?;
// Pattern A (envelope BEFORE eval-children).
const COLL_BY_INDEX_COST = 30

// Tree version threshold for lazy-default semantics.
// Mirrors sigma-rust: `if ctx.tree_version() >= ErgoTreeVersion::V3`
// (ergotree-ir/src/ergo_tree/tree_header.rs — V3 = 3).
const LAZY_DEFAULT_MIN_VERSION = 3

/**
 * Evaluate a `ByIndex` node. Pattern A: cost charged before eval-children.
 *
 * @throws EvalError `'cost-limit-exceeded'` if addCost(30) exceeds the limit.
 * @throws EvalError `'coll-input-not-coll'` if `input` does not eval to a Coll.
 * @throws EvalError `'coll-by-index-index-not-int'` if `index` does not eval to an Int.
 * @throws EvalError `'coll-by-index-out-of-range'` if index is OOB and no default is present.
 */
export function evalByIndex(e: ByIndex, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(COLL_BY_INDEX_COST)

  const inputVal = evalExpr(e.input, env, ctx)
  const indexVal = evalExpr(e.index, env, ctx)

  const inputColl = extractCollItems(inputVal)

  if (indexVal.kind !== 'Int') {
    throw new EvalError(
      `ByIndex: expected index to be Int, got ${indexVal.kind}`,
      'coll-by-index-index-not-int'
    )
  }

  const idx = indexVal.value
  const treeVersion = ctx.treeVersion ?? 0

  const inBounds = idx >= 0 && idx < inputColl.items.length

  if (e.default !== null) {
    if (treeVersion >= LAZY_DEFAULT_MIN_VERSION) {
      // V3+: lazy — default only evaluated on OOB.
      // Mirrors: `val.map(Ok).unwrap_or_else(default_v)` (line 34)
      if (inBounds) {
        return inputColl.items[idx]!
      }
      return evalExpr(e.default, env, ctx)
    } else {
      // V0/V1/V2: eager — default always evaluated.
      // Mirrors: `Ok(val.unwrap_or(default_v()?)` (line 36)
      const defaultVal = evalExpr(e.default, env, ctx)
      if (inBounds) {
        return inputColl.items[idx]!
      }
      return defaultVal
    }
  }

  // No default: OOB throws.
  // Mirrors: `.ok_or_else(|| EvalError::Misc(...))` (line 40-47)
  if (inBounds) {
    return inputColl.items[idx]!
  }
  throw new EvalError(
    `ByIndex: index ${idx} out of bounds for collection size ${inputColl.items.length}`,
    'coll-by-index-out-of-range'
  )
}
