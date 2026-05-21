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
import { makeContext } from './eval-context'
import type { EvalContext, EvalOpts } from './eval-context'
import { substituteDeserialize, treeHasDeserialize } from './_substitute-deserialize'

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
 * runs `substituteDeserialize` as a bottom-up pre-eval rewrite, then dispatches
 * on the REWRITTEN body (so the P2PK 50-cost short-circuit can fire on a
 * substituted `Const(SSigmaProp)` body — see fixture `dc_const_sigmaprop_inner`).
 *
 * Architectural divergence from sigma-rust (deliberate, cost-equivalent): we
 * keep `ctx.constants` populated for all paths and rely on
 * `tryTrivialReduceExpr` handling both `Const(SSigmaProp)` and
 * `ConstPlaceholder(SSigmaProp)` via ctx.constants lookup; sigma-rust's
 * substitute path uses `tree.proposition()` to eagerly substitute placeholders.
 * Same observable cost-integer and value output (verified by
 * `dc_const_sigmaprop_inner` cost === 50).
 */
function dispatchTreeBody(tree: ErgoTree, ctx: EvalContext): SValue {
  if (treeHasDeserialize(tree)) {
    const rewrittenBody = substituteDeserialize(tree.body, tree, ctx)
    return tryTrivialReduceExpr(rewrittenBody, ctx) ?? evalExpr(rewrittenBody, Env.empty(), ctx)
  }
  return tryTrivialReduce(tree, ctx) ?? evalExpr(tree.body, Env.empty(), ctx)
}
