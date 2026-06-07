/**
 * TreeLookup eval arm — unconditional reject.
 *
 * The JVM has NO eval override for TreeLookup (trees.scala:1322-1338):
 * `costKind = Value.notSupportedError(this, "costKind")` and the default
 * `Value.eval` fires `sys.error("Should be overriden in ...")`
 * (values.scala:102). EVERY evaluation of this node throws JVM-side —
 * regardless of operand validity, tree version, or activation.
 *
 * JVM-blessed vectors pin the reject at BOTH ergoTree v2 and v3:
 *   AvlTree.unsupported_eval_nodes.json     #tree_lookup-errored#0 (@v2)
 *   AvlTree.unsupported_eval_nodes_v6.json  #tree_lookup-errored#0 (@v3)
 * (blessed_by jvm:sigma-state-6.0.3, vendored 2026-06-07, F4 epilogue).
 *
 * History: ergots originally ported sigma-rust's evaluating arm
 * (ergotree-interpreter/src/eval/tree_lookup.rs — full AVL+ lookup via
 * `@ergots/avltree`'s `verifyAvlLookup`). sigma-rust (eni) evaluates the
 * node too — a CONVERGENT over-accept vs the JVM, routed to sigma-rust via
 * SANTA. Accepting a JVM-rejected node is a consensus over-accept, so the
 * arm now rejects unconditionally.
 *
 * Cost: NOTHING is charged before the throw — the JVM errors before any
 * cost site (there is no costKind to charge).
 *
 * Parse/serialize for the opcode (0xb7) stay unchanged — the JVM parses
 * TreeLookup fine (QuadrupleSerializer); only evaluation is unsupported.
 */

import type { SValue, TreeLookup } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalTreeLookup(
  _e: TreeLookup,
  _env: Env,
  _ctx: EvalContext,
): SValue {
  // JVM: no eval override, costKind = notSupportedError (trees.scala:
  // 1322-1338) — every evaluation throws sys.error("Should be overriden")
  // (values.scala:102). Blessed errored at BOTH v2 and v3:
  // AvlTree.unsupported_eval_nodes{,_v6}.json. Charge nothing, eval no
  // operands — the JVM throws before either.
  throw new EvalError('TreeLookup has no JVM eval', 'unsupported-eval-node')
}
