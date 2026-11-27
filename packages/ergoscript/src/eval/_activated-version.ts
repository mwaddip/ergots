/**
 * The activated script version an evaluation runs under: the JVM's `ErgoLikeContext.activatedScriptVersion`, a
 * signed byte, which the interpreter reads as `VersionContext.activatedVersion` (sigma/VersionContext.scala:17).
 * Activated version 2 is the JIT (5.0) soft fork and 3 the V6 one (:25, :33, :51, :56).
 *
 * The JVM node sets it to one below its state context's block version, as a byte: `(stateContext.blockVersion -
 * 1).toByte` (ergo-core nodeView/ErgoContext.scala:28). So block version 0 wraps to -1, 128 to 127, and 129 to 255
 * to -128 to -2. The block version is the voted parameter (nodeView/state/ErgoStateContext.scala:109), which the
 * node compares with a header's version at an epoch's first block (rule 410, :222).
 *
 * A context carries the activated version as `activatedScriptVersion`. One made without it derives it from its
 * pre-header's version wrapped as a signed byte, which equals the JVM's value wherever the pre-header carries the
 * voted block version.
 */
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

/**
 * `(blockVersion - 1)` as the JVM's signed byte (`-128..127`). `blockVersion` is a JS integer, wrapped as
 * `.toByte` wraps it.
 */
export function activatedVersionOfBlock(blockVersion: number): number {
  if (!Number.isInteger(blockVersion)) {
    throw new TypeError(
      `activatedVersionOfBlock: the block version must be an integer, got ${String(blockVersion)}`,
    )
  }
  return ((blockVersion - 1) << 24) >> 24
}

/**
 * The context's activated version: `activatedScriptVersion` when set, otherwise the one its pre-header's version
 * gives, and `undefined` for a context that has neither.
 */
export function knownActivatedVersion(ctx: EvalContext): number | undefined {
  const own = ctx.activatedScriptVersion
  if (own !== undefined) return own
  if (ctx.preHeader === undefined) return undefined
  return activatedVersionOfBlock(ctx.preHeader.version | 0)
}

/** {@link knownActivatedVersion}, for a reader that cannot do without it. `caller` names the reader in the error. */
export function activatedScriptVersion(ctx: EvalContext, caller: string): number {
  const activated = knownActivatedVersion(ctx)
  if (activated === undefined) {
    throw new EvalError(
      `${caller}: the context has neither activatedScriptVersion nor a preHeader`,
      'context-field-missing',
    )
  }
  return activated
}
