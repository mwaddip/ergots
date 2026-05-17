/**
 * `SigmaAnd` evaluator arm — AND sigma combinator.
 *
 * `SigmaAnd { items: Expr[] }` evaluates each item individually (each must
 * evaluate to SigmaProp), then reduces via `candNormalized(items)`.
 *
 * Pattern A: per-item cost `addPerItemCost(10, 2, 1, n)` is charged BEFORE
 * eval-children (unlike Atleast's Pattern B).
 *
 * Source: ergotree-interpreter/src/eval/sigma_and.rs:13-28
 *
 * Eval flow mirrors sigma-rust:
 *   1. charge Pattern A cost (before eval).
 *   2. eval each item → must each be SigmaProp, extract SigmaBoolean.
 *   3. call candNormalized(items).
 *
 * Error codes:
 *   'sigma-prop-coll-elem-not-sigma-prop' — any item eval didn't return SigmaProp
 *   'cost-limit-exceeded'                 — cost exceeds jitCostLimit
 */

import type { SigmaAnd, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { candNormalized } from '../mir/sigma-boolean-normalize'
import { expectSigmaProp } from './_sigma-helpers'

export function evalSigmaAnd(e: SigmaAnd, env: Env, ctx: EvalContext): SValue {
  // Step 1: Pattern A — charge per-item cost BEFORE eval-children.
  // Source: sigma_and.rs:19 — ctx.add_per_item_jit_cost(10, 2, 1, self.items.len())
  ctx.addPerItemCost(10, 2, 1, e.items.length)

  // Step 2: eval each item → extract SigmaBoolean via expectSigmaProp.
  // Source: sigma_and.rs:20-25 — try_mapped_ref (sequential) then try_extract_into::<SigmaProp>
  const items = e.items.map((item) => expectSigmaProp(evalExpr(item, env, ctx), 'SigmaAnd'))

  // Step 3: reduce via Cand::normalized — TrivialProp(true) absorbed (identity),
  // TrivialProp(false) absorbing, single item unwrapped, empty → TrivialProp(true).
  // Source: sigma_and.rs:27 — Cand::normalized(items_sigmabool)
  return { kind: 'SigmaProp', value: candNormalized(items) }
}
