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
 * The index (the JVM's, not sigma-rust's; spec 2026-09-30 §8):
 *   - V0/V1/V2: a Byte or Short index is widened to Int and the Upcast the JVM's
 *     parse inserts is charged, 10 (ByIndexSerializer.scala:29-33, CostKind.scala:60-66).
 *   - V3+: the index must be an Int value, else 'coll-by-index-index-not-int'.
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
import { readCheckedType } from './_check-type'
import { upcastCost } from './bin-op/_numeric'

// Cost source: sigma-rust eval/coll_by_index.rs:18
//   ctx.add_jit_cost(30)?;
// Pattern A (envelope BEFORE eval-children).
const COLL_BY_INDEX_COST = 30

// Tree version threshold for lazy-default semantics.
// Mirrors sigma-rust: `if ctx.tree_version() >= ErgoTreeVersion::V3`
// (ergotree-ir/src/ergo_tree/tree_header.rs — V3 = 3).
const LAZY_DEFAULT_MIN_VERSION = 3

// Tree version from which the JVM's parse no longer upcasts the index to Int:
// `VersionContext.current.isV3OrLaterErgoTreeVersion` (ByIndexSerializer.scala:29).
const INDEX_UPCAST_BELOW_VERSION = 3

/**
 * Evaluate a `ByIndex` node. Pattern A: cost charged before eval-children.
 *
 * @throws EvalError `'cost-limit-exceeded'` if addCost(30) exceeds the limit.
 * @throws EvalError `'coll-input-not-coll'` if `input` does not eval to a Coll.
 * @throws EvalError `'coll-by-index-index-not-int'` if `index` does not eval to an Int. Before tree v3 a Byte or
 *   Short is widened to Int instead, and its inserted Upcast charged.
 * @throws EvalError `'coll-by-index-out-of-range'` if index is OOB and no default is present.
 */
export function evalByIndex(e: ByIndex, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(COLL_BY_INDEX_COST)

  const inputVal = evalExpr(e.input, env, ctx)
  const indexVal = evalExpr(e.index, env, ctx)

  const inputColl = extractCollItems(inputVal)
  const treeVersion = ctx.treeVersion ?? 0

  // Before v3 the JVM's parse upcasts the index to Int, `index.upcastTo(SInt)` (ByIndexSerializer.scala:29-33,
  // syntax.scala:168-177): a Byte or Short index sits under an inserted Upcast, evaluated and charged while the index
  // is evaluated (Upcast.eval, trees.scala:402-407) at NumericCastCostKind's 10 for an Int target
  // (CostKind.scala:60-66). ergots inserts no node. It widens the value here, a Byte or Short being the same number as
  // its Int, and charges the same 10 with the helper the pre-v3 arithmetic uses (eval/bin-op/arith.ts).
  // ByIndex's own 30 is charged above, before the children, where the JVM charges it after the input and the index
  // (transformers.scala:257-278). The totals are equal, and at a cost-limit trip both reject (spec 2026-09-30 §8).
  // Only a Byte or Short is widened: before v3 a wider or non-numeric index rejects at parse
  // (wire/mir/coll-by-index.ts). From v3 the index is taken as it is (ByIndexSerializer.scala:29-30), so a Byte
  // reaches `index.evalTo[Int]` and fails there (transformers.scala:258), as the throw below does.
  let idx: number
  if (indexVal.kind === 'Int') {
    idx = indexVal.value
  } else if (treeVersion < INDEX_UPCAST_BELOW_VERSION && (indexVal.kind === 'Byte' || indexVal.kind === 'Short')) {
    ctx.addCost(upcastCost('Int'))
    idx = indexVal.value
  } else {
    throw new EvalError(
      `ByIndex: expected index to be Int, got ${indexVal.kind}`,
      'coll-by-index-index-not-int'
    )
  }

  const inBounds = idx >= 0 && idx < inputColl.items.length

  if (e.default !== null) {
    // ByIndex.eval (transformers.scala:256-273): checkType reads the default's type right after the default is
    // evaluated, from v3 only when it is taken, before v3 always (spec §5 item 5).
    if (treeVersion >= LAZY_DEFAULT_MIN_VERSION) {
      // V3+: lazy — default only evaluated on OOB.
      // Mirrors: `val.map(Ok).unwrap_or_else(default_v)` (line 34)
      if (inBounds) {
        return inputColl.items[idx]!
      }
      const defaultVal = evalExpr(e.default, env, ctx)
      readCheckedType(e.default, ctx)
      return defaultVal
    } else {
      // V0/V1/V2: eager — default always evaluated.
      // Mirrors: `Ok(val.unwrap_or(default_v()?)` (line 36)
      const defaultVal = evalExpr(e.default, env, ctx)
      readCheckedType(e.default, ctx)
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
