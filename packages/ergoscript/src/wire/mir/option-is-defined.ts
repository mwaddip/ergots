/**
 * OptionIsDefined — parse + serialize.
 *
 * Wire format (sigma-rust `mir/option_is_defined.rs`):
 *
 *   [OP_OPTION_IS_DEFINED opcode = 0xe6]
 *   [input: Expr]      -- the option-typed expression (post-eval: SOption[T])
 *
 * `OptionIsDefined` returns `SBoolean`: `true` when the wrapped option is
 * `Some`, `false` for `None`. Encoding is a single recursive Expr after
 * the opcode byte; sigma-rust uses the `OneArgOp` + `OneArgOpTryBuild`
 * blanket impl pair (`mir/unary_op.rs:26-36`).
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not
 * `SOption(_)` (`mir/option_is_defined.rs:38-52`). We do NOT enforce that
 * at the wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/option_is_defined.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:123
 */

import type { OptionIsDefined, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `OptionIsDefined` payload (the OP_OPTION_IS_DEFINED opcode byte
 * was consumed by the dispatcher). Reads a single input Expr.
 *
 * Mirrors sigma-rust's `<OptionIsDefined as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseOptionIsDefined(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): OptionIsDefined {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'OptionIsDefined', input }
}

/**
 * Serialize an `OptionIsDefined` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_OPTION_IS_DEFINED opcode byte). Writes
 * the input Expr.
 */
export function serializeOptionIsDefined(
  e: OptionIsDefined,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(e.input, w, treeVersion)
}
