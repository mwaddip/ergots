/**
 * If — parse + serialize.
 *
 * Wire format (sigma-rust `mir/if_op.rs`):
 *
 *   [OP_IF opcode = 0x95]
 *   [condition: Expr]
 *   [true_branch: Expr]
 *   [false_branch: Expr]
 *
 * Three Expr nodes follow the opcode byte, in order. No payload prefix
 * between them — sigma-rust's `If::sigma_serialize` writes the three
 * `sigma_serialize` calls back-to-back and `If::sigma_parse` reads them
 * back-to-back. Each branch is recursively parsed via the central
 * dispatcher, so the `valDefTypes` map threads through unchanged (used
 * when, e.g., a branch contains a ValUse referencing a binding from an
 * enclosing FuncValue or BlockValue scope).
 *
 * `If.tpe()` is the type of the true branch (sigma-rust `mir/if_op.rs:27`).
 * Both branches must agree at well-typed sites, but sigma-rust does not
 * enforce that at parse time — it accepts whatever the wire encodes and
 * defers type-checking to higher layers. We mirror that.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/if_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:180,295
 */

import type { If, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
// Forward import for recursive descent — see comment in val-def.ts. The
// Expr graph is mutually recursive (If → Expr → If …) so the import cycle
// is unavoidable.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `If` payload (the OP_IF opcode byte was consumed by the
 * dispatcher). Reads three Expr nodes back-to-back: condition, true-branch,
 * false-branch.
 *
 * Mirrors sigma-rust's `If::sigma_parse`.
 */
export function parseIf(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): If {
  const condition = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const trueBranch = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const falseBranch = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'If', condition, trueBranch, falseBranch }
}

/**
 * Serialize an `If` payload (the dispatcher in {@link serializeExpr} emits
 * the OP_IF opcode byte). Writes condition, true-branch, false-branch in
 * order.
 */
export function serializeIf(i: If, w: ByteWriter): void {
  serializeExpr(i.condition, w)
  serializeExpr(i.trueBranch, w)
  serializeExpr(i.falseBranch, w)
}
