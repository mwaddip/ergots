/**
 * Global — parse + serialize.
 *
 * Wire format (sigma-rust `Expr::Global`, unit variant; opcode GLOBAL = 0xdd):
 *
 *   [OP_GLOBAL opcode = 0xdd]
 *
 * Nullary: the opcode byte carries the entire encoding. `Global` denotes
 * the singleton `Global` companion object (SGlobal-typed; namespace for
 * cross-type utilities like `Global.groupGenerator`,
 * `Global.serialize[T]`). Sigma-rust handles it as a unit Expr arm
 * (`mir/expr.rs:130-131` and `serialization/expr.rs:116`).
 *
 * Distinct from `GlobalVars` (the predefined globals like HEIGHT, INPUTS);
 * `GlobalVars` is a kind-discriminated wrapper over six unit variants,
 * whereas `Global` is a single unit Expr arm in its own right.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/expr.rs (Expr::Global)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:116
 */

import type { Global } from '../../mir/types'

/**
 * Build a `Global` AST node. The dispatcher consumed the OP_GLOBAL byte
 * already; the variant has no payload, so this is a pure constructor.
 */
export function parseGlobal(): Global {
  return { tag: 'Global' }
}
