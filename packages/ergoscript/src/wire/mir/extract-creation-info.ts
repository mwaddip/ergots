/**
 * ExtractCreationInfo — parse + serialize.
 *
 * Wire format (sigma-rust `mir/extract_creation_info.rs`):
 *
 *   [OP_EXTRACT_CREATION_INFO opcode = 0xc7]
 *   [input: Expr]      -- the box to extract from (post-eval type: SBox)
 *
 * ExtractCreationInfo returns a tuple `(SInt height, Coll[Byte] tx_id_and_index)`
 * describing the block height at which the box was included and the
 * transaction id concatenated with the output index (32 + 2 bytes). The
 * single payload byte after the opcode is a recursive Expr for the box
 * operand. Mirrors sigma-rust's `OneArgOp`/`OneArgOpTryBuild` impl pair.
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not SBox
 * (`mir/extract_creation_info.rs:41-46`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_creation_info.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (ExtractCreationInfo::OP_CODE)
 */

import type { ExtractCreationInfo, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `ExtractCreationInfo` payload (the OP_EXTRACT_CREATION_INFO
 * opcode byte was consumed by the dispatcher). Reads a single input Expr.
 */
export function parseExtractCreationInfo(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): ExtractCreationInfo {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'ExtractCreationInfo', input }
}

/**
 * Serialize an `ExtractCreationInfo` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_EXTRACT_CREATION_INFO opcode byte).
 * Writes only the input Expr.
 */
export function serializeExtractCreationInfo(
  e: ExtractCreationInfo,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(e.input, w, treeVersion)
}
