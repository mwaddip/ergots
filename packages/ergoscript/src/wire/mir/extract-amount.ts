/**
 * ExtractAmount — parse + serialize.
 *
 * Wire format (sigma-rust `mir/extract_amount.rs`):
 *
 *   [OP_EXTRACT_AMOUNT opcode = 0xc1]
 *   [input: Expr]      -- the box to extract from (post-eval type: SBox)
 *
 * ExtractAmount returns the nanoErg value (SLong) of an SBox. The single
 * payload byte after the opcode is a recursive Expr for the box operand.
 * Mirrors sigma-rust's `OneArgOp`/`OneArgOpTryBuild` impl pair: the
 * serializer writes only the input Expr, and the parser only consumes one.
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not SBox
 * (`mir/extract_amount.rs:41-46`). We do NOT enforce that at the wire layer
 * — type-shape checks belong to a later pass. The wire-layer parser is
 * permissive (same convention as Upcast / Downcast / Negation /
 * BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_amount.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (ExtractAmount::OP_CODE)
 */

import type { ExtractAmount, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `ExtractAmount` payload (the OP_EXTRACT_AMOUNT opcode byte was
 * consumed by the dispatcher). Reads a single input Expr.
 *
 * Mirrors sigma-rust's `<ExtractAmount as OneArgOp>` serialization via
 * `unary_op.rs`: `sigma_parse_with_opcode` reads the input Expr and calls
 * `try_build`.
 */
export function parseExtractAmount(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ExtractAmount {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'ExtractAmount', input }
}

/**
 * Serialize an `ExtractAmount` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_EXTRACT_AMOUNT opcode byte). Writes
 * only the input Expr.
 */
export function serializeExtractAmount(e: ExtractAmount, w: ByteWriter): void {
  serializeExpr(e.input, w)
}
