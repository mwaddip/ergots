/**
 * `Atleast` evaluator arm — THRESHOLD sigma combinator.
 *
 * `Atleast { bound: Expr<SInt>, input: Expr<SColl[SSigmaProp]> }` evaluates
 * the bound integer k and the input collection of SigmaProps, then reduces
 * via `cthresholdReduce(k, items)`.
 *
 * Pattern B: per-item cost `addPerItemCost(20, 3, 5, n)` is charged AFTER
 * eval-children (bound + input).
 *
 * Source: ergotree-interpreter/src/eval/atleast.rs:19-58
 *
 * Eval flow mirrors sigma-rust:
 *   1. eval bound → must be Int.
 *   2. eval input → must be Coll[SigmaProp], extract SigmaBoolean[].
 *   3. charge Pattern B cost.
 *   4. check bound fits in [0, 255] (sigma-rust: try_into::<u8>()).
 *   5. check bound <= items.length (sigma-rust: bound > input.len() → Err).
 *   6. call cthresholdReduce(bound, items).
 *
 * Error codes:
 *   'atleast-bound-not-int'           — bound eval didn't return Int
 *   'sigma-prop-input-not-coll'       — input eval didn't return Coll
 *   'sigma-prop-coll-elem-not-sigma-prop' — Coll element isn't SigmaProp
 *   'atleast-bound-out-of-range'      — bound > 255 or bound > items.length
 */

import type { Atleast } from '../mir/types'
import type { SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { cthresholdReduce } from '../mir/sigma-boolean-normalize'
import { extractSigmaPropColl } from './_sigma-helpers'

export function evalAtleast(e: Atleast, env: Env, ctx: EvalContext): SValue {
  // Step 1: eval bound expression → must be Int.
  const boundV = evalExpr(e.bound, env, ctx)
  if (boundV.kind !== 'Int') {
    throw new EvalError(
      `Atleast: expected Int bound, got ${boundV.kind}`,
      'atleast-bound-not-int',
    )
  }

  // Step 2: eval input expression → must be Coll[SigmaProp], extract items.
  const inputV = evalExpr(e.input, env, ctx)
  const items = extractSigmaPropColl(inputV, 'Atleast')

  // Step 3: Pattern B — charge per-item cost AFTER eval-children.
  // Source: atleast.rs:34 — ctx.add_per_item_jit_cost(20, 3, 5, n)
  ctx.addPerItemCost(20, 3, 5, items.length)

  // Step 4: check bound fits in u8 [0, 255].
  // Source: atleast.rs:47-51 — bound.try_into() → EvalError::Misc if overflow.
  const k = boundV.value
  if (k < 0 || k > 255) {
    throw new EvalError(
      `Atleast: bound (${k}) out of range [0, 255]`,
      'atleast-bound-out-of-range',
    )
  }

  // Step 5: check bound <= items.length.
  // Source: atleast.rs:52-55 — bound > input.len() → EvalError::Misc.
  if (k > items.length) {
    throw new EvalError(
      `Atleast: bound ${k} > input size ${items.length}`,
      'atleast-bound-out-of-range',
    )
  }

  // Step 6: reduce via Cthreshold::reduce — handles k==0 → TrivialProp(true),
  // degenerate collapses (k==1 → Cor, k==n → Cand), TrivialProp partial eval.
  return { kind: 'SigmaProp', value: cthresholdReduce(k, items) }
}
