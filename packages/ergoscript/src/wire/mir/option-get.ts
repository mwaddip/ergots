/**
 * OptionGet — parse + serialize.
 *
 * Wire format (sigma-rust `mir/option_get.rs`):
 *
 *   [OP_OPTION_GET opcode = 0xe4]
 *   [input: Expr]      -- the option-typed expression (post-eval: SOption[T])
 *
 * `OptionGet` returns the wrapped value of an `SOption`, erroring at eval
 * time if the option is `None`. Encoding is a single recursive Expr after
 * the opcode byte; sigma-rust uses the `OneArgOp` + `OneArgOpTryBuild`
 * blanket impl pair (`mir/unary_op.rs:26-36`) which writes / reads exactly
 * one inner Expr.
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not
 * `SOption(_)` (`mir/option_get.rs:42-54`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass (same convention
 * as the Task 14-25 variants).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/option_get.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:122
 */

import type { OptionGet, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
// Forward import for recursive descent — the Expr graph is mutually
// recursive (OptionGet → Expr → OptionGet …) so the import cycle is
// unavoidable.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `OptionGet` payload (the OP_OPTION_GET opcode byte was consumed
 * by the dispatcher). Reads a single input Expr.
 *
 * Mirrors sigma-rust's `<OptionGet as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseOptionGet(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): OptionGet {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'OptionGet', input }
}

/**
 * Serialize an `OptionGet` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_OPTION_GET opcode byte). Writes the input Expr.
 */
export function serializeOptionGet(e: OptionGet, w: ByteWriter): void {
  serializeExpr(e.input, w)
}
