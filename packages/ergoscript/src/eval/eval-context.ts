/**
 * EvalContext + EvalOpts + EvalError. The runtime state passed through
 * every evaluator arm. Cost lives on Context (mirrors sigma-rust's
 * `Context::add_jit_cost` posture); `EvalContext extends EvalOpts` so
 * phase 2e can grow `EvalOpts` with chain-state fields and `EvalContext`
 * inherits them.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/context.rs:77-99
 */

import type { ErgoBox, PreHeader, ContextExtension, SValue } from '../mir/types'

export class EvalError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'EvalError'
  }
}

export interface EvalOpts {
  /** undefined = unlimited (signing-style) */
  jitCostLimit?: number
  /** Overrides tree.constants if set. Used by ConstPlaceholder resolution. */
  constants?: SValue[]
  /**
   * ErgoTree version (0..7). Auto-derived from tree.header.version in
   * evaluate(); explicit in evaluateWith(). Arms reading ctx.treeVersion
   * use (ctx.treeVersion ?? 0) — V0 default; most-restrictive fallback.
   *
   * Required for arms with tree-version-dependent semantics:
   * - Upcast: BigInt → BigInt requires V3+
   * - Downcast: BigInt → any requires V3+
   * - XorOf: V0/V1 uses JVM v4.x bug; V2+ uses correct left-fold XOR
   *
   * Sigma-rust ref: chain/context.rs:44 `tree_version: Cell<ErgoTreeVersion>`
   */
  treeVersion?: number
  /** Current block height (u32). GlobalVars.Height reads this. */
  height?: number
  /** Spending box. GlobalVars.SelfBox reads this. */
  selfBox?: ErgoBox
  /** Transaction inputs. GlobalVars.Inputs reads this. */
  inputs?: ErgoBox[]
  /** Transaction outputs. GlobalVars.Outputs reads this. */
  outputs?: ErgoBox[]
  /** Pre-header of current block. GlobalVars.MinerPubKey reads .minerPk. */
  preHeader?: PreHeader
  /** Context-extension key-value map. GetVar reads .values[varId]. */
  extension?: ContextExtension
}

export interface EvalContext extends EvalOpts {
  /** Mutable accumulator. */
  jitCost: number
  /**
   * Saturating add. Throws `EvalError 'cost-limit-exceeded'` if
   * `jitCostLimit` is set and the new total exceeds it.
   * Mirrors sigma-rust `Context::add_jit_cost`.
   */
  addCost(amount: number): void
  /**
   * Composite per-item charge: `base + ceil(nItems / chunkSize) * perChunk`.
   * Mirrors sigma-rust `Context::add_per_item_jit_cost`
   * (`ergotree-ir/src/chain/context.rs:88-99`). Used by BlockValue
   * envelope cost; will be reused by 2f's collection HOFs.
   */
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
}

export function makeContext(opts: EvalOpts = {}): EvalContext {
  const ctx: EvalContext = {
    jitCost: 0,
    jitCostLimit: opts.jitCostLimit,
    constants: opts.constants,
    treeVersion: opts.treeVersion,
    height: opts.height,
    selfBox: opts.selfBox,
    inputs: opts.inputs,
    outputs: opts.outputs,
    preHeader: opts.preHeader,
    extension: opts.extension,
    addCost(amount: number): void {
      ctx.jitCost = Math.min(ctx.jitCost + amount, Number.MAX_SAFE_INTEGER)
      if (ctx.jitCostLimit !== undefined && ctx.jitCost > ctx.jitCostLimit) {
        throw new EvalError(
          `JIT cost limit (${ctx.jitCostLimit}) exceeded`,
          'cost-limit-exceeded'
        )
      }
    },
    addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void {
      const chunks = Math.ceil(nItems / chunkSize)
      ctx.addCost(base + chunks * perChunk)
    },
  }
  return ctx
}
