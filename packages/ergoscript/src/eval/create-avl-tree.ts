/**
 * CreateAvlTree eval arm — unconditional reject.
 *
 * The JVM has NO eval override for CreateAvlTree (trees.scala:79-91):
 * `costKind = Value.notSupportedError(this, "costKind")` and the default
 * `Value.eval` fires `sys.error("Should be overriden in ...")`
 * (values.scala:102). The node even carries a `// TODO v6.0: implement
 * eval method` comment (trees.scala:77, issue #907) — it has NEVER been
 * evaluable on-chain. EVERY evaluation throws JVM-side, regardless of
 * operand validity.
 *
 * JVM-blessed vector pins the reject at ergoTree v3:
 *   AvlTree.unsupported_eval_nodes_v6.json #create_avl_tree-errored#1
 * (blessed_by jvm:sigma-state-6.0.3, vendored 2026-06-07, F4 epilogue).
 * No v5 vector exists: the tree is JVM-UNSERIALIZABLE at v5 (the
 * `Const(SOption[SInt], None)` valueLengthOpt operand needs Option data
 * serialization, a v6 feature) — per the SANTA reply
 * (~/projects/santa/prompts/f4-santa-asks.md §SANTA REPLY).
 *
 * History: ergots originally ported sigma-rust's evaluating arm
 * (ergotree-interpreter/src/eval/create_avl_tree.rs — constructed an
 * AvlTreeData with flag canonicalization + u32 bit-casts). sigma-rust
 * (eni) evaluates the node too — a CONVERGENT over-accept vs the JVM,
 * routed to sigma-rust via SANTA. The same epilogue round also fixed the
 * node's WIRE layout (sigma-rust presence-tag fork → JVM 4-expr operands;
 * see wire/mir/create-avl-tree.ts).
 *
 * Cost: NOTHING is charged before the throw — the JVM errors before any
 * cost site (there is no costKind to charge).
 *
 * Parse/serialize for the opcode (0xb6) stay — the JVM parses the node
 * fine (CreateAvlTreeSerializer); only evaluation is unsupported.
 */

import type { CreateAvlTree, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalCreateAvlTree(
  _e: CreateAvlTree,
  _env: Env,
  _ctx: EvalContext,
): SValue {
  // JVM: no eval override, costKind = notSupportedError (trees.scala:79-91)
  // — every evaluation throws sys.error("Should be overriden")
  // (values.scala:102). Blessed errored @v3:
  // AvlTree.unsupported_eval_nodes_v6.json (v5: tree unserializable
  // JVM-side, no vector). Charge nothing, eval no operands — the JVM
  // throws before either.
  throw new EvalError('CreateAvlTree has no JVM eval', 'unsupported-eval-node')
}
