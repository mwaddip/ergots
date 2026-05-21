/**
 * Shared helper functions for Coll HOF evaluator arms (phase 2f).
 *
 * `extractCollItems` — guards a SValue is a Coll, returns `{ items, elem }`.
 *   Used by all 9 arms in the Coll HOFs slice. Throws `'coll-input-not-coll'`
 *   on kind mismatch.
 *
 * `extractFuncValue` — guards a SValue is a Lambda with non-empty argIds,
 *   returns the Closure. Used by `coll-map.ts`, `coll-filter.ts`, `coll-fold.ts`,
 *   `coll-exists.ts`, `coll-forall.ts` (5 callers). Throws `'lambda-not-callable'`
 *   for non-Lambda or Lambda with empty argIds (merged into one code per
 *   Decision #8 in the design spec — both are "lambda value didn't have the
 *   expected callable shape").
 *
 * Convention: leading-underscore filename follows existing project pattern
 * (`_byte-coll.ts`, `_box-synthesis.ts`, `_numeric.ts`, `_group-generator.ts`).
 *
 * Source cross-reference:
 *   Input-Coll guards live inline in sigma-rust:
 *     ergotree-interpreter/src/eval/coll_map.rs:56-71    (Map)
 *     ergotree-interpreter/src/eval/coll_filter.rs:47-62 (Filter)
 *     ergotree-interpreter/src/eval/coll_append.rs:19-27 (extract_vecval, Append)
 */

import type { Closure, SType, SValue } from '../mir/types'
import type { EvalErrorCode } from './errors'
import { EvalError } from './eval-context'

/**
 * Assert that `v` is a `Coll` SValue and return its runtime view.
 *
 * Used by `coll-size.ts`, `coll-append.ts` (×2), `coll-by-index.ts`,
 * `coll-slice.ts`, `coll-map.ts`, `coll-filter.ts`, `coll-fold.ts`,
 * `coll-exists.ts`, `coll-forall.ts` (9 callers).
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
 * Used by `coll-map.ts`, `coll-filter.ts`, `coll-fold.ts`, `coll-exists.ts`,
 * `coll-forall.ts` (5 callers).
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

/**
 * Extract a `Coll[Int]` SValue as a `number[]`. Throws `EvalError` with the
 * supplied code on:
 *   - non-Coll input (`v.kind !== 'Coll'`)
 *   - declared element type isn't `SInt`
 *   - per-item kind mismatch (defends against `ConstantPlaceholder` injection
 *     in hand-crafted MIR)
 *
 * Used by: `SubstConstants` (T9 phase 2i-a) for the `positions` argument.
 *
 * Default code `'coll-input-not-coll'` so existing Coll-HOF call-sites can
 * adopt the helper without widening their taxonomy; T9 passes its arm-specific
 * code (`'subst-constants-error'`) to keep all 7 throw paths under one umbrella.
 */
export function extractCollInt(
  v: SValue,
  arm: string,
  code: EvalErrorCode = 'coll-input-not-coll',
): number[] {
  if (v.kind !== 'Coll') {
    throw new EvalError(
      `${arm}: expected Coll input, got kind='${v.kind}'`,
      code,
    )
  }
  if (v.elem.tag !== 'SInt') {
    throw new EvalError(
      `${arm}: expected Coll[Int], got Coll[${v.elem.tag}]`,
      code,
    )
  }
  const out: number[] = new Array(v.items.length)
  for (let i = 0; i < v.items.length; i++) {
    const item = v.items[i]!
    if (item.kind !== 'Int') {
      throw new EvalError(
        `${arm}: Coll[Int] item is not Int (got '${item.kind}')`,
        code,
      )
    }
    out[i] = item.value
  }
  return out
}
