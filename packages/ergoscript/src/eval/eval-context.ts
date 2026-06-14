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

import type { Header } from '@ergots/scorex'
import type { ErgoBox, PreHeader, ContextExtension, SValue, AvlTreeData } from '../mir/types'

/**
 * Evaluator error. `code` is a stable string key for programmatic matching.
 *
 * Known codes (representative, not exhaustive):
 *   'cost-limit-exceeded'          — JIT cost limit overrun
 *   'arith-overflow'               — arithmetic overflow / division by zero
 *   'downcast-overflow'            — Downcast narrowing failed
 *   'bin-op-not-numeric'           — BinOp applied to a non-numeric operand
 *   'bin-op-kind-mismatch'         — BinOp operand kinds mismatch (V3+)
 *   'bigint-result-out-of-range'   — BigInt256 arithmetic result overflows ±2^255
 *   'v6-type-in-pre-v3-tree'       — SUnsignedBigInt type found in a pre-V3 tree
 *   'unsigned-bigint-op-unsupported' — UBI operation not yet supported (casts/modular; P2b/P2c)
 *   'unsigned-bigint-out-of-range'   — UBI value outside [0, 2^256): shiftLeft overflow or negative cast to UBI
 *   'unsigned-bigint-not-invertible' — UBI.modInverse with gcd(a, m) != 1 (no multiplicative inverse; P2d-2)
 */
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
  /**
   * Transaction data-inputs (read-only boxes). Mirrors sigma-rust
   * `Context::data_inputs` (`ergotree-ir/src/chain/context.rs`).
   * SContext.dataInputs (PropertyCall typeId=101, methodId=1) reads this.
   * `undefined` treated as empty (matches sigma-rust `map_or(Arc::new([]), ...)`).
   */
  dataInputs?: ErgoBox[]
  /** Block headers; sigma-rust uses fixed-size [Header; 10] — TS relaxes to variable length. */
  headers?: Header[]
  /**
   * Per-input context extensions, indexed by SPENDING-TRANSACTION input
   * position — mirrors JVM `spendingTransaction.inputs(i).extension`
   * (`CContext.scala:76-83`). May legitimately differ in length from
   * `inputs` (the JVM's own blessed getVarFromInput vector has
   * tx.inputs = 0 while ctx.inputs = 1) — never validate length equality.
   * Invariant (documented, not enforced): when both are supplied,
   * `inputExtensions[selfIndex]` ≡ `extension`; self-`getVar` keeps reading
   * `extension`. Absent ⇒ every lookup → None (the `dataInputs`
   * absent-=-empty convention, NOT the `extension`
   * `'context-field-missing'` convention — per-input witness data a caller
   * may legitimately not carry). SContext.getVarFromInput (101:12, v6 P7a)
   * reads this.
   * Keys in each entry's .values are unsigned 0-255 (see ContextExtension);
   * the 101:12 handler normalizes its signed Byte var-id operand into that
   * domain (& 0xff, byte identity with the JVM's signed-Byte Map keys).
   */
  inputExtensions?: ContextExtension[]
  /**
   * Last-block UTXO state-tree root, as an INDEPENDENT context field — mirrors
   * JVM `ErgoLikeContext.lastBlockUtxoRoot`. Readers: the
   * `SContext.lastBlockUtxoRootHash` handler (101:9, method-call.ts) and the
   * bare 0xa6 op-form arm (eval/last-block-utxo-root-hash.ts). Both read THIS
   * field directly rather than deriving an AvlTree from `headers[0].stateRoot`
   * (the sigma-rust quirk at `scontext.rs:83-99`). Absent ⇒ either reader
   * throws `'context-field-missing'`. The walker supplies
   * `{ digest: headers[0].stateRoot, treeFlags: 0b111, keyLength: 32,
   * valueLengthOpt: null }`; the conformance dummy context supplies
   * `AvlTreeData.dummy`.
   */
  lastBlockUtxoRootHash?: AvlTreeData
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
    dataInputs: opts.dataInputs,
    headers: opts.headers,
    inputExtensions: opts.inputExtensions,
    lastBlockUtxoRootHash: opts.lastBlockUtxoRootHash,
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
      // chunks mirrors Scala consensus PerItemCost.chunks = (n-1)/chunkSize + 1 with
      // signed toward-zero division (sigma-rust chain/context.rs:108, commit f6b2dd7f).
      // Identical to ceil(n/cs) for n>=1; differs only at n=0, where a chunkSize>=2
      // element still costs one chunk (the JVM charges base+perChunk on an empty coll,
      // chunkSize==1 charges base only). Math.trunc matches Rust i64 toward-zero division.
      const chunks = Math.max(0, Math.trunc((nItems - 1) / chunkSize) + 1)
      ctx.addCost(base + chunks * perChunk)
    },
  }
  return ctx
}
