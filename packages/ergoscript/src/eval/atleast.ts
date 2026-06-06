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
 * Source: atleast.rs:19-58, EXCEPT steps 4-5 where the JVM (canonical)
 * reduces and sigma-rust errors — see inline comment.
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

  // Steps 4-5: JVM degenerate-bound reductions (canonical: sigma-state
  // AtLeast — bound ≤ 0 ⇒ TrivialProp(true); bound > size ⇒ TrivialProp(false);
  // there is NO eval-time 255 bound cap — blessed entry bound-256-gt-255-False#5
  // reduces to false, it does not error). sigma-rust's u8 try_into + bound>len
  // errors here (atleast.rs:47-55) are the TESTNET WEDGE shape (tx accepted on
  // chain at h=184137 wedged ergo-node-rust): JVM reduces where rust errored.
  // ergots follows the JVM. Blessed: atLeast_with_a_degenerate_bound #1/#4/#5/#6
  // (cost 46/46/46/44 — same charge as the non-degenerate siblings, so the
  // Pattern-B charge above this block is unchanged).
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
