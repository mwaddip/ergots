/**
 * Public evaluator entry points.
 *
 * `evaluate(tree, opts?)` is the ergonomic happy path — constructs an
 * EvalContext from `opts` (defaulting `constants` to `tree.constants` if
 * not overridden) and dispatches on the tree body. `evaluateWith(tree,
 * ctx)` takes a pre-built EvalContext, useful for tests and tooling that
 * need to inspect `ctx.jitCost` after evaluation completes.
 */

import type { ErgoTree, SValue } from '../mir/types'
import { Env } from './env'
import { evalExpr } from './eval'
import { makeContext } from './eval-context'
import type { EvalContext, EvalOpts } from './eval-context'

export function evaluate(tree: ErgoTree, opts: EvalOpts = {}): SValue {
  const ctx = makeContext({
    ...opts,
    constants: opts.constants ?? tree.constants,
    treeVersion: opts.treeVersion ?? tree.header.version,
  })
  return evalExpr(tree.body, Env.empty(), ctx)
}

export function evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue {
  // Caller-supplied ctx is honored verbatim. If they want tree.constants
  // resolution they must set it themselves before calling.
  return evalExpr(tree.body, Env.empty(), ctx)
}
