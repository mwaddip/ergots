/**
 * Public evaluator entry points.
 *
 * `evaluate(tree, opts?)` is the ergonomic happy path — constructs an
 * EvalContext from `opts` (defaulting `constants` to `tree.constants` if
 * not overridden) and dispatches on the tree body. `evaluateWith(tree,
 * ctx)` takes a pre-built EvalContext, useful for tests and tooling that
 * need to inspect `ctx.jitCost` after evaluation completes.
 */

import type { ErgoTree, Expr, SValue } from '../mir/types'
import { Env } from './env'
import { evalExpr } from './eval'
import { makeContext, EvalError } from './eval-context'
import type { EvalContext, EvalOpts } from './eval-context'
import {
  substituteConstants,
  substituteDeserialize,
  treeHasDeserialize,
} from './_substitute-deserialize'
import { validateBinOpTypes } from './validate-bin-op-types'
import { validateMethodCallArity } from './validate-method-call-arity'
import { validateV6Types } from './validate-v6-types'

/**
 * P2PK short-circuit on an Expr — mirrors sigma-rust's `trivial_reduce` in
 * `ergotree-interpreter/src/eval.rs:138-158, 268-278`.
 *
 * An Expr that is a plain `Const(SSigmaProp, _)` or a `ConstPlaceholder`
 * resolving to a SigmaProp is short-circuited with a flat 50 JitCost
 * (`EVAL_SIGMA_PROP_CONSTANT`). Without this, bare P2PK trees undercharge
 * by 10× vs sigma-rust.
 *
 * Returns the SigmaProp SValue if short-circuiting applies (and charges
 * the cost on ctx), or `null` if full eval is required.
 *
 * Extracted from `tryTrivialReduce(tree, ctx)` in phase 2i-c T5 so the
 * substitute-pre-pass (T8) can call this directly on the SUBSTITUTED body
 * Expr without synthesizing a wrapping ErgoTree.
 */
export function tryTrivialReduceExpr(body: Expr, ctx: EvalContext): SValue | null {
  if (body.tag === 'Const' && body.tpe.tag === 'SSigmaProp') {
    // Non-segregated case: Const(SSigmaProp, ...) at the tree root.
    ctx.addCost(50)
    return body.value
  }
  if (body.tag === 'ConstPlaceholder' && body.tpe.tag === 'SSigmaProp') {
    // Segregated case: ConstPlaceholder(SSigmaProp) at the tree root,
    // resolving via ctx.constants.
    const constants = ctx.constants
    if (constants !== undefined && body.id < constants.length) {
      const resolved = constants[body.id]
      if (resolved !== undefined && resolved.kind === 'SigmaProp') {
        ctx.addCost(50)
        return resolved
      }
    }
  }
  return null
}

/**
 * Thin wrapper over `tryTrivialReduceExpr` for the common
 * tree-body-is-trivial-reduce case. Preserves the original phase 2g-medium
 * call shape used by `evaluate` / `evaluateWith` on the non-substitute path.
 */
function tryTrivialReduce(tree: ErgoTree, ctx: EvalContext): SValue | null {
  return tryTrivialReduceExpr(tree.body, ctx)
}

export function evaluate(tree: ErgoTree, opts: EvalOpts = {}): SValue {
  const ctx = makeContext({
    ...opts,
    constants: opts.constants ?? tree.constants,
    treeVersion: opts.treeVersion ?? tree.header.version,
  })
  return dispatchTreeBody(tree, ctx)
}

export function evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue {
  // Caller-supplied ctx is honored verbatim. If they want tree.constants
  // resolution they must set it themselves before calling.
  return dispatchTreeBody(tree, ctx)
}

/**
 * Internal dispatch — mirrors sigma-rust `eval.rs:203-280`:
 *
 *   if tree.has_deserialize() { substitute_then_eval } else { straight_eval }
 *
 * Both branches end with `tryTrivialReduce ?? evalExpr`. The substitute path
 * runs `substituteConstants` (when the tree is segregated) and then
 * `substituteDeserialize` as bottom-up pre-eval rewrites, then dispatches on
 * the REWRITTEN body (so the P2PK 50-cost short-circuit can fire on a
 * substituted `Const(SSigmaProp)` body — see fixture `dc_const_sigmaprop_inner`).
 *
 * Order matches sigma-rust `eval.rs:206-207`:
 *
 *   let expr = tree.proposition()?;          // substitute_constants if segregated
 *   let expr = expr.substitute_deserialize(ctx)?;
 *
 * The CP→Const rewrite MUST run before the Deserialize* rewrite so that every
 * `ConstPlaceholder` reaching `evalExpr` charges `Const = Fixed(5)` (matching
 * sigma-rust `eval/expr.rs:21-23`) instead of the lazy `ConstantPlaceholder
 * = Fixed(1)` path (`eval/expr.rs:52-53`). Pre-2j-b/iter-1 this code ran only
 * `substituteDeserialize` and relied on `ctx.constants` lookup at eval-time,
 * which produced a -4 per-CP undercharge surfaced at h=3850 in the 2j-a
 * Layer-5 smoke (oracle 434 vs ours 410 — see
 * `tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md`).
 *
 * Non-deserialize path stays on lazy resolution via `ctx.constants`: that
 * path's `ConstPlaceholder` arm IS the sigma-rust `with_constants(...)`
 * branch (`eval.rs:259-261`), which intentionally charges 1 per CP. Only the
 * substitute branch needs the CP→Const pre-pass to match sigma-rust costs.
 */
function dispatchTreeBody(tree: ErgoTree, ctx: EvalContext): SValue {
  // JVM-align (v6 batch-6, Ask 20): the SELF context extension is consumed by
  // `ErgoLikeContext.toSigmaContext` → `contextVars` (ErgoLikeContext.scala:140-147),
  // which builds `new Array(maxKey+1)` and assigns `res(key)` per `Map[Byte]` key. A
  // key whose wire byte is >= 0x80 parses to a NEGATIVE Scala Byte, so `res(negative)`
  // (or `new Array(negative)`) crashes (ArrayIndexOutOfBounds / NegativeArraySize) —
  // the JVM rejects the context BEFORE reduction, independent of whether the script
  // reads that var. ergots keys `ctx.extension` by unsigned number, so reject keys
  // outside [0,127] here (the toSigmaContext-equivalent point: before any reduction or
  // cost). `ctx.inputExtensions` are NOT guarded — getVarFromInput reads `Map[Byte].get`
  // directly (no array), so they stay byte-identity 0..255 (see eval/method-call.ts
  // 101:12 + context-get-var-from-input.test.ts). Adversarial-only.
  if (ctx.extension !== undefined) {
    for (const key of Object.keys(ctx.extension.values)) {
      const k = Number(key)
      if (!Number.isInteger(k) || k < 0 || k > 127) {
        throw new EvalError(
          `context extension key ${key} out of range [0, 127] — the JVM keys the self extension by signed Byte; a wire byte >= 0x80 is negative and crashes toSigmaContext`,
          'context-extension-key-out-of-range'
        )
      }
    }
  }
  // JVM-align #2: mirror the deserializer's check2(SameType)/(OnlyNumeric) on
  // comparison/equality — a WHOLE-TREE pre-eval pass run before any cost is
  // charged, so a mismatched node (even in a never-evaluated branch) rejects the
  // tree with zero JIT cost, matching the JVM's deserialize-time rejection. Runs
  // on the post-substitution body so substituted-in Deserialize* subtrees are
  // checked too. See eval/validate-bin-op-types.ts.
  const treeVersion = ctx.treeVersion ?? 0
  if (treeHasDeserialize(tree)) {
    const constSubstituted = tree.header.constantSegregation
      ? substituteConstants(tree.body, tree.constants, tree.constantTypes)
      : tree.body
    const rewrittenBody = substituteDeserialize(constSubstituted, tree, ctx)
    // JVM-align: reject v3+-only type constructs (SUnsignedBigInt/SFunc) in a
    // pre-V3 tree (constantTypes[] + the post-substitution body) before any
    // eval/cost, matching the JVM's deserialize-time rejection. See
    // eval/validate-v6-types.ts. Walks rewrittenBody so attacker-controlled
    // Deserialize* sub-trees are covered.
    validateV6Types(tree, rewrittenBody, treeVersion)
    validateBinOpTypes(rewrittenBody, treeVersion)
    // JVM-align: reject a V3+ MethodCall-opcode node with empty args (honest
    // trees use PropertyCall for zero args). Closes the none/groupGenerator
    // over-accept. Pre-V3 grandfathered. See eval/validate-method-call-arity.ts.
    validateMethodCallArity(rewrittenBody, treeVersion)
    return tryTrivialReduceExpr(rewrittenBody, ctx) ?? evalExpr(rewrittenBody, Env.empty(), ctx)
  }
  validateV6Types(tree, tree.body, treeVersion)
  validateBinOpTypes(tree.body, treeVersion)
  validateMethodCallArity(tree.body, treeVersion)
  return tryTrivialReduce(tree, ctx) ?? evalExpr(tree.body, Env.empty(), ctx)
}
