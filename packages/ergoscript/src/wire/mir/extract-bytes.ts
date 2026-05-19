/**
 * ExtractBytes — parse + serialize.
 *
 * Wire format (sigma-rust `mir/extract_bytes.rs`):
 *
 *   [OP_EXTRACT_BYTES opcode = 0xc3]
 *   [input: Expr]      -- the box to extract from (post-eval type: SBox)
 *
 * ExtractBytes returns the full serialized bytes (`Coll[Byte]`) of an SBox.
 * The single payload byte after the opcode is a recursive Expr for the box
 * operand. Mirrors sigma-rust's `OneArgOp`/`OneArgOpTryBuild` impl pair.
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not SBox
 * (`mir/extract_bytes.rs:41-46`). We do NOT enforce that at the wire layer
 * — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_bytes.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (ExtractBytes::OP_CODE)
 */

import type { ExtractBytes, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `ExtractBytes` payload (the OP_EXTRACT_BYTES opcode byte was
 * consumed by the dispatcher). Reads a single input Expr.
 */
export function parseExtractBytes(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ExtractBytes {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'ExtractBytes', input }
}

/**
 * Serialize an `ExtractBytes` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_EXTRACT_BYTES opcode byte). Writes
 * only the input Expr.
 */
export function serializeExtractBytes(e: ExtractBytes, w: ByteWriter): void {
  serializeExpr(e.input, w)
}
