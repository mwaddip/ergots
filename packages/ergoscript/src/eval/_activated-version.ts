/**
 * The activated script version of the block being validated: one below the pre-header's block version, as the JVM
 * node sets it (ergo-core nodeView/ErgoContext.scala:28: `(stateContext.blockVersion - 1).toByte`), floored at 0.
 * The interpreter reads it as `VersionContext.activatedVersion`: block version 4 is activated version 3, the V6 soft
 * fork (sigma/VersionContext.scala:33, 56). The gate is the block's version, never the tree's.
 *
 * `caller` names the reader in the error an unset pre-header gives.
 */
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function activatedScriptVersion(ctx: EvalContext, caller: string): number {
  if (ctx.preHeader === undefined) {
    throw new EvalError(`${caller}: ctx.preHeader is undefined`, 'context-field-missing')
  }
  return Math.max(0, (ctx.preHeader.version | 0) - 1)
}
