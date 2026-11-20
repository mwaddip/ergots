/**
 * Shared helpers for sigma-combinator evaluator arms.
 *
 * `expectSigmaProp` — asserts a `SValue` is a `SigmaProp` and returns the
 * inner `SigmaBoolean`. Called by `SigmaAnd`, `SigmaOr` (the per-item map
 * over `e.items`) and `AtLeast` (the defensive per-item check after
 * `castArray` has verified the array is `SigmaProp[]`). Throws
 * `'sigma-prop-coll-elem-not-sigma-prop'` on any non-SigmaProp value.
 *
 * Source cross-reference:
 *   data/shared/src/main/scala/sigma/ast/trees.scala — `SigmaAnd.eval`,
 *     `SigmaOr.eval`, `AtLeast.eval`.
 */

import { EvalError } from './eval-context'
import type { SValue, SigmaBoolean } from '../mir/types'

/**
 * Assert that `value` is a `SigmaProp` SValue and return the inner
 * `SigmaBoolean`.
 *
 * @param value  The SValue to inspect.
 * @param callerName  Descriptive label for the error message (e.g.
 *   `'AtLeast item 0'`, `'SigmaAnd'`).
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
