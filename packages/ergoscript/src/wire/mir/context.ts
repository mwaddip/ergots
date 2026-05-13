/**
 * Context — parse + serialize.
 *
 * Wire format (sigma-rust `Expr::Context`, unit variant; opcode CONTEXT = 0xfe):
 *
 *   [OP_CONTEXT opcode = 0xfe]
 *
 * Nullary: the opcode byte carries the entire encoding. `Context` denotes
 * the implicit transaction context (the JVM `Context` value the script is
 * evaluated against — same root from which `INPUTS`, `OUTPUTS`, etc. are
 * derived as `GlobalVars` shortcuts). Sigma-rust handles it as a unit Expr
 * arm separate from the `GlobalVars` enum (`mir/expr.rs:128-129` and
 * `serialization/expr.rs:121`).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/expr.rs (Expr::Context)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:121
 */

import type { Context } from '../../mir/types'

/**
 * Build a `Context` AST node. The dispatcher consumed the OP_CONTEXT byte
 * already; the variant has no payload, so this is a pure constructor.
 */
export function parseContext(): Context {
  return { tag: 'Context' }
}

/**
 * Serialize a `Context` payload. The dispatcher writes the OP_CONTEXT
 * opcode byte; this function writes nothing further (no payload).
 */
export function serializeContext(): void {
  // Intentionally empty: Context has no payload beyond its opcode.
}
