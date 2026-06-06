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
 * Source: steps 1-3,6 follow atleast.rs:19-58 (sigma-rust ergo-node-integration).
 * Steps 4-5 are canonical from JVM AtLeast.reduce (trees.scala:340-359):
 * bound ≤ 0 → TrivialProp(true); bound > size → TrivialProp(false).
 * Sigma-rust ergo-node-integration was fixed 2026-06-04 to agree with the JVM
 * (it no longer errors here); see inline comment for the historical fork.
 *
 * Eval flow:
 *   1. eval bound → must be Int.
 *   2. eval input → must be Coll[SigmaProp], extract SigmaBoolean[].
 *   3. charge Pattern B cost.
 *   4-5. JVM degenerate-bound reductions (bound ≤ 0 ⇒ TrivialProp(true);
 *        bound > size ⇒ TrivialProp(false)).
 *   6. call cthresholdReduce(bound, items).
 *
 * Error codes:
 *   'atleast-bound-not-int'           — bound eval didn't return Int
 *   'sigma-prop-input-not-coll'       — input eval didn't return Coll
 *   'sigma-prop-coll-elem-not-sigma-prop' — Coll element isn't SigmaProp
 */

import type { Atleast, SValue } from '../mir/types'
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

  // Steps 4-5: JVM degenerate-bound reductions — canonical authority is
  // JVM AtLeast.reduce (trees.scala:340-359): bound ≤ 0 ⇒ TrivialProp(true);
  // bound > size ⇒ TrivialProp(false). ergots follows the JVM.
  //
  // Historical fork: the STALE vendored sigma-rust (integration/ergots) errored
  // here via u8 try_into + bound>len checks (atleast.rs:47-55); that was the
  // shape that wedged ergo-node-rust on testnet tx at h=184137. Canonical
  // sigma-rust (ergo-node-integration) was fixed 2026-06-04 to reduce, matching
  // the JVM. Blessed fixtures: atLeast_with_a_degenerate_bound #1/#4/#5/#6
  // (cost 46/46/46/44 — Pattern-B charge above is unchanged for degenerate cases).
  //
  // NOTE: a 255-CHILDREN cap (JVM MaxChildrenCount, on input-coll length, NOT the
  // bound) is NOT enforced here — deferred to F5 (conformance-run spec,
  // user-decision-pending). When added it must sit BEFORE these degenerate
  // reductions; cap-vs-reduce ordering is an open JVM-vs-sigma-rust question.
  const k = boundV.value
  if (k <= 0) {
    return { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
  }
  if (k > items.length) {
    return { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: false } }
  }

  // Step 6: reduce via Cthreshold::reduce — handles k==0 → TrivialProp(true),
  // degenerate collapses (k==1 → Cor, k==n → Cand), TrivialProp partial eval.
  return { kind: 'SigmaProp', value: cthresholdReduce(k, items) }
}
