/**
 * BoolToSigmaProp arm — wraps a Boolean as the `TrivialProp(b)` leaf of a SigmaProp.
 *
 * A SigmaProp operand is returned as it is when the block's activated script version is below 2, and is refused
 * from 2. The gate is the block's activated version; the tree's version is not read. The activated version comes
 * from the pre-header (`_activated-version.ts`) and is read for a SigmaProp operand only, so a Boolean operand
 * evaluates in a context without a pre-header.
 *
 * JVM (sigma-state 6.0.7): `BoolToSigmaProp.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:36-51) casts
 * its operand to Boolean when `isJitActivated` (activated version >= 2,
 * core/shared/src/main/scala/sigma/VersionContext.scala:25) and otherwise returns a `SigmaProp` operand. The cost
 * kind is `FixedCost(15)` (trees.scala:55).
 *
 * Mainnet holds `sigmaProp(sigmaProp(...))` scripts spent below the activation: the tree `10010101d1d17300` at
 * height 680,692, a block of version 2 (activated script version 1).
 *
 * Error codes:
 *   'bin-op-not-boolean'    — the operand is no Boolean (a SigmaProp at activated version 2 and above included)
 *   'context-field-missing' — a SigmaProp operand in a context without a pre-header
 *   'cost-limit-exceeded'   — the cost exceeds jitCostLimit
 */

import type { BoolToSigmaProp, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { activatedScriptVersion } from './_activated-version'

const BOOL_TO_SIGMA_PROP_COST = 15

export function evalBoolToSigmaProp(
  e: BoolToSigmaProp,
  env: Env,
  ctx: EvalContext,
): SValue {
  ctx.addCost(BOOL_TO_SIGMA_PROP_COST)
  const input = evalExpr(e.input, env, ctx)
  // trees.scala:39-49: below activated version 2 a SigmaProp operand is the result. The kind is tested first, so
  // the activated version is read for a SigmaProp operand only.
  if (input.kind === 'SigmaProp' && activatedScriptVersion(ctx, 'BoolToSigmaProp') < 2) {
    return input
  }
  if (input.kind !== 'Boolean') {
    throw new EvalError(
      `BoolToSigmaProp: operand kind must be Boolean, got '${input.kind}'`,
      'bin-op-not-boolean'
    )
  }
  return { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: input.value } }
}
