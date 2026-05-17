/**
 * Shared helpers for sigma-combinator evaluator arms (phase 2g-combinators).
 *
 * `expectSigmaProp` — asserts a SValue is a SigmaProp, returns the inner
 *   SigmaBoolean. Used by `extractSigmaPropColl` and any arm that wraps a
 *   single SigmaProp result. Throws `'sigma-prop-coll-elem-not-sigma-prop'`.
 *
 * `extractSigmaPropColl` — asserts a SValue is a Coll, maps each element
 *   through `expectSigmaProp`, returns `SigmaBoolean[]`. Used by `Atleast`,
 *   `SigmaAnd`, `SigmaOr` (Tasks 4-6). Throws `'sigma-prop-input-not-coll'`
 *   (outer) or `'sigma-prop-coll-elem-not-sigma-prop'` (per item).
 *
 * Convention: leading-underscore filename follows existing project pattern
 * (`_coll-helpers.ts`, `_byte-coll.ts`, `_box-synthesis.ts`, ...).
 *
 * Promoted ahead of YAGNI threshold per phase 2g-combinators design
 * decision #3 (3 callers across 3 files in Tasks 4-6).
 *
 * Source cross-reference:
 *   ergotree-interpreter/src/eval/atleast.rs:31-46
 */

import { EvalError } from './eval-context'
import type { SValue, SigmaBoolean } from '../mir/types'

/**
 * Assert that `value` is a `SigmaProp` SValue and return the inner
 * `SigmaBoolean`.
 *
 * Used by `extractSigmaPropColl` (element-wise guard) and any single-prop arm.
 *
 * @param value  The SValue to inspect.
 * @param callerName  Descriptive label for the error message (e.g. `'Atleast'`
 *   or `'Atleast item 0'`).
 *
 * @throws EvalError `'sigma-prop-coll-elem-not-sigma-prop'` if
 *   `value.kind !== 'SigmaProp'`.
 */
export function expectSigmaProp(value: SValue, callerName: string): SigmaBoolean {
  if (value.kind !== 'SigmaProp') {
    throw new EvalError(
      `${callerName}: expected SigmaProp, got ${value.kind}`,
      'sigma-prop-coll-elem-not-sigma-prop',
    )
  }
  return value.value
}

/**
 * Assert that `value` is a `Coll` SValue, then extract the `SigmaBoolean`
 * from each element via `expectSigmaProp`.
 *
 * Used by `Atleast`, `SigmaAnd`, `SigmaOr` (Tasks 4-6).
 *
 * @param value  The SValue to inspect (expected `Coll[SigmaProp]` at runtime).
 * @param callerName  Descriptive label prepended to error messages.
 *
 * @throws EvalError `'sigma-prop-input-not-coll'` if `value.kind !== 'Coll'`.
 * @throws EvalError `'sigma-prop-coll-elem-not-sigma-prop'` if any element is
 *   not a SigmaProp.
 */
export function extractSigmaPropColl(value: SValue, callerName: string): SigmaBoolean[] {
  if (value.kind !== 'Coll') {
    throw new EvalError(
      `${callerName}: expected Coll[SigmaProp], got ${value.kind}`,
      'sigma-prop-input-not-coll',
    )
  }
  return value.items.map((item, idx) =>
    expectSigmaProp(item, `${callerName} item ${idx}`),
  )
}
