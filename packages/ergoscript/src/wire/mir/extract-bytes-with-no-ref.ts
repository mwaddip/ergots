/**
 * ExtractBytesWithNoRef — parse + serialize.
 *
 * Wire format (sigma-rust `mir/extract_bytes_with_no_ref.rs`):
 *
 *   [OP_EXTRACT_BYTES_WITH_NO_REF opcode = 0xc4]
 *   [input: Expr]      -- the box to extract from (post-eval type: SBox)
 *
 * ExtractBytesWithNoRef returns the serialized bytes (`Coll[Byte]`) of an
 * SBox WITHOUT its transaction_id and index reference fields. The single
 * payload byte after the opcode is a recursive Expr for the box operand.
 * Mirrors sigma-rust's `OneArgOp`/`OneArgOpTryBuild` impl pair.
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not SBox
 * (`mir/extract_bytes_with_no_ref.rs:41-46`). We do NOT enforce that at
 * the wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_bytes_with_no_ref.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (ExtractBytesWithNoRef::OP_CODE)
 */

import type { ExtractBytesWithNoRef, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `ExtractBytesWithNoRef` payload (the OP_EXTRACT_BYTES_WITH_NO_REF
 * opcode byte was consumed by the dispatcher). Reads a single input Expr.
 */
export function parseExtractBytesWithNoRef(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): ExtractBytesWithNoRef {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'ExtractBytesWithNoRef', input }
}

/**
 * Serialize an `ExtractBytesWithNoRef` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_EXTRACT_BYTES_WITH_NO_REF opcode byte).
 * Writes only the input Expr.
 */
export function serializeExtractBytesWithNoRef(
  e: ExtractBytesWithNoRef,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(e.input, w, treeVersion)
}
