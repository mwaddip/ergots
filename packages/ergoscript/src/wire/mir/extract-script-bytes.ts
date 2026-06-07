/**
 * ExtractScriptBytes — parse + serialize.
 *
 * Wire format (sigma-rust `mir/extract_script_bytes.rs`):
 *
 *   [OP_EXTRACT_SCRIPT_BYTES opcode = 0xc2]
 *   [input: Expr]      -- the box to extract from (post-eval type: SBox)
 *
 * ExtractScriptBytes returns the serialized guarding-script bytes
 * (`Coll[Byte]`) of an SBox. The single payload byte after the opcode is
 * a recursive Expr for the box operand. Mirrors sigma-rust's
 * `OneArgOp`/`OneArgOpTryBuild` impl pair.
 *
 * Sigma-rust's `try_build` rejects inputs whose post-eval type is not SBox
 * (`mir/extract_script_bytes.rs:41-46`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_script_bytes.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (ExtractScriptBytes::OP_CODE)
 */

import type { ExtractScriptBytes, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse an `ExtractScriptBytes` payload (the OP_EXTRACT_SCRIPT_BYTES opcode
 * byte was consumed by the dispatcher). Reads a single input Expr.
 */
export function parseExtractScriptBytes(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): ExtractScriptBytes {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'ExtractScriptBytes', input }
}

/**
 * Serialize an `ExtractScriptBytes` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_EXTRACT_SCRIPT_BYTES opcode byte).
 * Writes only the input Expr.
 */
export function serializeExtractScriptBytes(
  e: ExtractScriptBytes,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(e.input, w, treeVersion)
}
