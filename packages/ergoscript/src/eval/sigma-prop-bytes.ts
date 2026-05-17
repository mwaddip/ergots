/**
 * `SigmaPropBytes` evaluator arm — serializes a SigmaProp to its byte form.
 *
 * Pattern A cost: addPerItemCost(35, 6, 1, 1) BEFORE eval-children.
 * Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs:15-23.
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

import type { SigmaPropBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { sigmaPropBytesOf } from '../sigma/prop-bytes'
import { bytesToCollByteSValue } from './_byte-coll'

export function evalSigmaPropBytes(e: SigmaPropBytes, env: Env, ctx: EvalContext): SValue {
  // Pattern A cost charge BEFORE eval-children.
  // Source: sigma_prop_bytes.rs:15 — ctx.add_per_item_jit_cost(35, 6, 1, 1)
  ctx.addPerItemCost(35, 6, 1, 1)

  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'SigmaProp') {
    throw new EvalError(
      `SigmaPropBytes expects a SigmaProp input; got '${inputV.kind}'`,
      'sigma-prop-bytes-input-not-sigma-prop'
    )
  }
  return bytesToCollByteSValue(sigmaPropBytesOf(inputV.value))
}
