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
 * The index (the JVM's, not sigma-rust's; spec 2026-09-30 §8). The JVM's parse upcasts it to Int by its STATIC type
 * (`index.upcastTo(SInt)`, ByIndexSerializer.scala:29-33), and the arm keys on the same type, `exprTpe(index)`:
 *   - V0/V1/V2, statically Byte or Short: the inserted Upcast is charged, 10 (CostKind.scala:60-66), and a Byte,
 *     Short or Int value is accepted, as `SInt.upcast` does (SType.scala:465-470).
 *   - V0/V1/V2, statically Int, or any other type it reads: an Int value only. A Byte value behind an Int type is a
 *     class cast in the JVM, and it is reachable: a Coll or pair argument is checked by its class only
 *     (SType.scala:198-201).
 *   - V0/V1/V2, ergots' own SAny or a type read that throws: by the value's kind (residual 1).
 *   - V3+: the parse does not upcast, so the index must be an Int value, else 'coll-by-index-index-not-int'.
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

import type { ByIndex, Expr, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'
import { readCheckedType } from './_check-type'
import { upcastCost } from './bin-op/_numeric'
import { ExprTpeError, exprTpe } from '../mir/expr-tpe'
import { isOwnSAny } from '../mir/jvm-types'

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
 * The type the JVM's parse read off the index, `index.tpe` (ByIndexSerializer.scala:32), or `undefined` where ergots
 * cannot tell what it was: ergots' own SAny stands for a type its catalog lacks (residual 1), and a read that throws is
 * one the JVM never makes at run time (only its parse read the index's type), so it rejects nothing here.
 * Memoized by `exprTpe`, and the parse hook has already made this read for a parsed tree (wire/mir/coll-by-index.ts).
 */
function indexStaticType(index: Expr, treeVersion: number): SType | undefined {
  let tpe: SType
  try {
    tpe = exprTpe(index, treeVersion)
  } catch (err) {
    if (err instanceof ExprTpeError) return undefined
    throw err
  }
  return isOwnSAny(tpe) ? undefined : tpe
}

/**
 * Whether the JVM's parse put an `Upcast` over this index, as far as ergots can tell (`index.upcastTo(SInt)`,
 * ByIndexSerializer.scala:29-33, syntax.scala:168-177): it did where the index's static type, `exprTpe(index)`, is Byte
 * or Short, and not where it is Int, whatever value the index has at run time. Where ergots cannot read the type
 * (`indexStaticType`), the value's kind stands in for it: a Byte or Short value means an `Upcast` (residual 1).
 */
function upcastInserted(index: Expr, indexVal: SValue, treeVersion: number): boolean {
  const tpe = indexStaticType(index, treeVersion)
  if (tpe === undefined) return indexVal.kind === 'Byte' || indexVal.kind === 'Short'
  return tpe.tag === 'SByte' || tpe.tag === 'SShort'
}

/**
 * The index the collection is read at, from the index's value (spec 2026-09-30 §8).
 *   - Before v3, where `upcastInserted`: the JVM's Upcast was evaluated and charged with the index (Upcast.eval,
 *     trees.scala:402-407): NumericCastCostKind, 10 for an Int target (CostKind.scala:60-66). `SInt.upcast` takes a
 *     Byte, Short or Int value and errors on any other (SType.scala:465-470). ergots inserts no node. It charges the
 *     same 10 here, with the helper the pre-v3 arithmetic uses (eval/bin-op/arith.ts), and reads the value, which is
 *     the same number as its Int.
 *   - Otherwise, an Int value only: the JVM's `index.evalTo[Int]` (transformers.scala:258), where a Byte is a
 *     ClassCastException. That covers a static type of Int, whose parse inserted no Upcast, and it is reachable with a
 *     Byte value: the JVM checks a Coll or a pair argument by its class only (SType.scala:198-201), so a Coll[Byte]
 *     enters a lambda declared over Coll[Int], and its `c(0)` is a Byte behind an Int type. A widening keyed on the
 *     value's kind accepted it. From v3 the parse does not upcast (ByIndexSerializer.scala:29-30), so this is the only
 *     case.
 * ByIndex's own 30 is charged before the children, where the JVM charges it after the input and the index
 * (transformers.scala:257-278). The totals are equal, and at a cost-limit trip both reject.
 */
function indexValue(index: Expr, indexVal: SValue, treeVersion: number, ctx: EvalContext): number {
  if (treeVersion < INDEX_UPCAST_BELOW_VERSION && upcastInserted(index, indexVal, treeVersion)) {
    ctx.addCost(upcastCost('Int'))
    if (indexVal.kind === 'Byte' || indexVal.kind === 'Short' || indexVal.kind === 'Int') return indexVal.value
  } else if (indexVal.kind === 'Int') {
    return indexVal.value
  }
  throw new EvalError(
    `ByIndex: expected index to be Int, got ${indexVal.kind}`,
    'coll-by-index-index-not-int'
  )
}

/**
 * Evaluate a `ByIndex` node. Pattern A: cost charged before eval-children.
 *
 * @throws EvalError `'cost-limit-exceeded'` if addCost(30) exceeds the limit.
 * @throws EvalError `'coll-input-not-coll'` if `input` does not eval to a Coll.
 * @throws EvalError `'coll-by-index-index-not-int'` if `index` does not eval to an Int. Before tree v3 the index's
 *   static type decides (`indexValue`): a statically Byte or Short index takes a Byte, Short or Int value and is
 *   charged the JVM's inserted Upcast.
 * @throws EvalError `'coll-by-index-out-of-range'` if index is OOB and no default is present.
 */
export function evalByIndex(e: ByIndex, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(COLL_BY_INDEX_COST)

  const inputVal = evalExpr(e.input, env, ctx)
  const indexVal = evalExpr(e.index, env, ctx)

  const inputColl = extractCollItems(inputVal)
  const treeVersion = ctx.treeVersion ?? 0
  const idx = indexValue(e.index, indexVal, treeVersion, ctx)

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
