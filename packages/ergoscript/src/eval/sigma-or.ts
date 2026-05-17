/**
 * `SigmaOr` evaluator arm — OR sigma combinator.
 *
 * `SigmaOr { items: Expr[] }` evaluates each item individually (each must
 * evaluate to SigmaProp), then reduces via `corNormalized(items)`.
 *
 * Pattern A: per-item cost `addPerItemCost(10, 2, 1, n)` is charged BEFORE
 * eval-children (same as SigmaAnd — confirmed at sigma_or.rs:19).
 *
 * Source: ergotree-interpreter/src/eval/sigma_or.rs:13-28
 *
 * Eval flow mirrors sigma-rust:
 *   1. charge Pattern A cost (before eval).
 *   2. eval each item → must each be SigmaProp, extract SigmaBoolean.
 *   3. call corNormalized(items).
 *
 * Absorbing/identity SWAPPED vs SigmaAnd:
 *   TrivialProp(true)  → absorbing (short-circuits to true)
 *   TrivialProp(false) → identity (filtered out)
 *
 * Error codes:
 *   'sigma-prop-coll-elem-not-sigma-prop' — any item eval didn't return SigmaProp
 *   'cost-limit-exceeded'                 — cost exceeds jitCostLimit
 */

import type { SigmaOr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { corNormalized } from '../mir/sigma-boolean-normalize'
import { expectSigmaProp } from './_sigma-helpers'

export function evalSigmaOr(e: SigmaOr, env: Env, ctx: EvalContext): SValue {
  // Step 1: Pattern A — charge per-item cost BEFORE eval-children.
  // Source: sigma_or.rs:19 — ctx.add_per_item_jit_cost(10, 2, 1, self.items.len())
  ctx.addPerItemCost(10, 2, 1, e.items.length)

  // Step 2: eval each item → extract SigmaBoolean via expectSigmaProp.
  // Source: sigma_or.rs:20-23 — try_mapped_ref (sequential) then try_extract_into::<SigmaProp>
  const items = e.items.map((item) => expectSigmaProp(evalExpr(item, env, ctx), 'SigmaOr'))

  // Step 3: reduce via Cor::normalized — TrivialProp(false) absorbed (identity),
  // TrivialProp(true) absorbing, single item unwrapped, empty → TrivialProp(false).
  // Source: sigma_or.rs:24-26 — Cor::normalized(items_sigmabool)
  return { kind: 'SigmaProp', value: corNormalized(items) }
}
