/**
 * ExtractId — parse + serialize.
 *
 * Wire format (sigma-rust `mir/extract_id.rs`):
 *
 *   [OP_EXTRACT_ID opcode = 0xc5]
 *   [input: Expr]      -- the box to extract from (post-eval type: SBox)
 *
 * ExtractId returns the SBox's id — `blake2b256(ExtractBytes(box))`, the
 * 32-byte content hash. The single payload byte after the opcode is a
 * recursive Expr for the box operand. Mirrors sigma-rust's
 * `OneArgOp`/`OneArgOpTryBuild` impl pair.
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not SBox
 * (`mir/extract_id.rs:41-46`). We do NOT enforce that at the wire layer —
 * type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_id.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (ExtractId::OP_CODE)
 */

import type { ExtractId, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `ExtractId` payload (the OP_EXTRACT_ID opcode byte was consumed
 * by the dispatcher). Reads a single input Expr.
 */
export function parseExtractId(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ExtractId {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'ExtractId', input }
}

/**
 * Serialize an `ExtractId` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_EXTRACT_ID opcode byte). Writes only the input Expr.
 */
export function serializeExtractId(e: ExtractId, w: ByteWriter): void {
  serializeExpr(e.input, w)
}
