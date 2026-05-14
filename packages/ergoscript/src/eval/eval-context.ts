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

import type { SValue } from '../mir/types'

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
  // Phase 2e adds: height, selfBox, inputs, outputs, dataInputs,
  // preHeader, headers, extension, treeVersion, ...
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
