/**
 * `SigmaPropBytes` evaluator arm — serializes a SigmaProp to its byte form.
 *
 * Cost: addPerItemCost(35, 6, 1, numNodes) where numNodes = the SigmaBoolean's
 * node count — charged AFTER eval-children (JVM `transformers.scala:337-343`).
 * sigma-rust (`sigma_prop_bytes.rs:15`) hardcodes n=1, under-charging multi-node
 * propositions vs JVM — a divergence routed to sigma-rust (santa §B1). JVM canonical.
 *
 * The prop_bytes serialization wraps the SigmaBoolean as `Const(SSigmaProp, ...)`
 * in a v0 ErgoTree with **no** constant-segregation (header byte 0x00), matching
 * sigma-rust's `SigmaProp::prop_bytes()`. Uses `sigmaPropBytesOf` from
 * `sigma/prop-bytes.ts` (distinct from the fiat-shamir `propBytes` which uses
 * constant-segregation=true for challenge computation — different bytes).
 *
 * Error codes:
 *   'sigma-prop-bytes-input-not-sigma-prop' — input evaluates to non-SigmaProp
 *   'cost-limit-exceeded'                   — cost exceeds jitCostLimit
 */

import type { SigmaBoolean, SigmaPropBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { sigmaPropBytesOf } from '../sigma/prop-bytes'
import { bytesToCollByteSValue } from './_byte-coll'

export function evalSigmaPropBytes(e: SigmaPropBytes, env: Env, ctx: EvalContext): SValue {
  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'SigmaProp') {
    throw new EvalError(
      `SigmaPropBytes expects a SigmaProp input; got '${inputV.kind}'`,
      'sigma-prop-bytes-input-not-sigma-prop'
    )
  }
  // JVM `SigmaPropBytes.eval` (transformers.scala:337-343) charges
  // addSeqCost(PerItemCost(35,6,1), numNodes) where numNodes = the SigmaBoolean's
  // node count, AFTER evaluating the input. sigma-rust + our prior code hardcoded
  // n=1 (sigma_prop_bytes.rs:15) — correct only for single-node leaves; it
  // under-charges every multi-node proposition. Routed to sigma-rust in santa §B1.
  ctx.addPerItemCost(35, 6, 1, sigmaBooleanNodeCount(inputV.value))
  return bytesToCollByteSValue(sigmaPropBytesOf(inputV.value))
}

/**
 * SigmaBoolean node count — JVM `numNodes` (transformers.scala:339). A leaf's
 * size is its group-element count (ProveDlog 1; ProveDhTuple 4 — its g,h,u,v);
 * TrivialProp = 1; conjectures (Cand/Cor/Cthreshold) = 1 + Σ(children). Confirmed
 * against the JVM-blessed `SigmaProp.propBytes` conformance vector
 * (dlog 111 / DHTuple 129 / CAND 141 / CTHRESHOLD 213 / COR 321).
 */
function sigmaBooleanNodeCount(sb: SigmaBoolean): number {
  switch (sb.tag) {
    case 'TrivialProp':
    case 'ProveDlog':
      return 1
    case 'ProveDhTuple':
      return 4
    case 'Cand':
    case 'Cor':
    case 'Cthreshold':
      return 1 + sb.items.reduce((acc, c) => acc + sigmaBooleanNodeCount(c), 0)
  }
}
