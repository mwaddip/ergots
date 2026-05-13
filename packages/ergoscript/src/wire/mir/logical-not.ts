/**
 * LogicalNot — parse + serialize.
 *
 * Wire format (sigma-rust `mir/logical_not.rs`):
 *
 *   [OP_LOGICAL_NOT opcode = 0xef]
 *   [input: Expr]
 *
 * A single Expr payload follows the opcode byte; sigma-rust implements this
 * via the `OneArgOp` + `OneArgOpTryBuild` trait pair
 * (`mir/unary_op.rs:26-36`), whose blanket `SigmaSerializable` impl writes /
 * reads exactly one inner Expr. We mirror that — the input is recursively
 * parsed via the central dispatcher so the `valDefTypes` map threads through
 * unchanged.
 *
 * Sigma-rust's `try_build` for LogicalNot calls
 * `input.check_post_eval_tpe(&SType::SBoolean)?` (rejecting non-Boolean
 * inputs at parse time). We do NOT enforce that on the wire side — the
 * design carries type-checking concerns in a later pass, not the wire layer,
 * and the verifier won't run AST shapes with type-mismatched inputs anyway.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/logical_not.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:135
 */

import type { LogicalNot, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
// Forward import for recursive descent — see comment in val-def.ts. The
// Expr graph is mutually recursive (LogicalNot → Expr → LogicalNot …) so
// the import cycle is unavoidable.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `LogicalNot` payload (the OP_LOGICAL_NOT opcode byte was consumed
 * by the dispatcher). Reads one Expr — the input expression.
 *
 * Mirrors sigma-rust's `<LogicalNot as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseLogicalNot(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): LogicalNot {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'LogicalNot', input }
}

/**
 * Serialize a `LogicalNot` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_LOGICAL_NOT opcode byte). Writes the input Expr.
 */
export function serializeLogicalNot(n: LogicalNot, w: ByteWriter): void {
  serializeExpr(n.input, w)
}
