/**
 * Shared helper functions for Coll HOF evaluator arms (phase 2f).
 *
 * `extractCollItems` — guards a SValue is a Coll, returns `{ items, elem }`.
 *   Used by all 9 arms in the Coll HOFs slice. Throws `'coll-input-not-coll'`
 *   on kind mismatch.
 *
 * `extractFuncValue` — guards a SValue is a Lambda with non-empty argIds,
 *   returns the Closure. Used by 5 lambda HOF arms (MapColl, Filter, Fold,
 *   Exists, ForAll). Pre-stubbed in Task 1; consumers arrive from Task 6 onward.
 *   Throws `'lambda-not-callable'` for non-Lambda or Lambda with empty argIds
 *   (merged into one code per Decision #8 in the design spec — both are
 *   "lambda value didn't have the expected callable shape").
 *
 * Convention: leading-underscore filename follows existing project pattern
 * (`_byte-coll.ts`, `_box-synthesis.ts`, `_numeric.ts`, `_group-generator.ts`).
 *
 * Source cross-reference:
 *   sigma-rust ergotree-interpreter/src/eval/coll_map.rs (extractFuncValue analog)
 *   sigma-rust ergotree-interpreter/src/eval/coll_filter.rs (extractCollItems analog)
 */

import type { Closure, SType, SValue } from '../mir/types'
import { EvalError } from './eval-context'

/**
 * Assert that `v` is a `Coll` SValue and return its runtime view.
 *
 * 9 callers across the Coll HOFs slice: SizeOf, Append (×2), ByIndex, Slice,
 * MapColl, Filter, Fold, Exists, ForAll.
 *
 * @throws EvalError `'coll-input-not-coll'` if `v.kind !== 'Coll'`.
 */
export function extractCollItems(v: SValue): { items: SValue[]; elem: SType } {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `expected Coll SValue, got ${v.kind}`,
      'coll-input-not-coll'
    )
  }
  return { items: v.items, elem: v.elem }
}

/**
 * Assert that `v` is a `Lambda` SValue with at least one argument, and return
 * its `Closure`.
 *
 * 5 callers in the Coll HOFs slice: MapColl, Filter, Fold, Exists, ForAll.
 * Pre-stubbed in Task 1; all callers land in Tasks 6-10.
 *
 * Both failure modes throw `'lambda-not-callable'` (per Decision #8):
 *   - `v.kind !== 'Lambda'`: the evaluating expression produced a non-function value.
 *   - `v.closure.argIds.length === 0`: malformed lambda (parser invariant should
 *     prevent this; defensive guard for eval-time-only malformations).
 *
 * @throws EvalError `'lambda-not-callable'` if not a callable Lambda.
 */
export function extractFuncValue(v: SValue): Closure {
  if (v.kind !== 'Lambda') {
    throw new EvalError(
      `expected Lambda SValue, got ${v.kind}`,
      'lambda-not-callable'
    )
  }
  if (v.closure.argIds.length === 0) {
    // Defensive: sigma-rust parser invariant rejects FuncValue with no args;
    // this catches eval-time-only malformations that bypass the parser.
    throw new EvalError(
      'lambda has empty argIds list (not callable)',
      'lambda-not-callable'
    )
  }
  return v.closure
}
