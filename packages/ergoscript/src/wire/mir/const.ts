/**
 * Const (inline constant) — parse + serialize.
 *
 * Wire format (sigma-rust `serialization/constant.rs`, `serialization/expr.rs`
 * lines 88-93):
 *
 *   [type_code_byte] [SType payload, if any] [SValue bytes driven by SType]
 *
 * The type_code_byte (1..=LAST_CONSTANT_CODE = 112) doubles as the "opcode"
 * the {@link parseExpr} dispatcher reads to identify an inline Constant.
 * The dispatcher peeks/consumes that byte, recognizes it's a constant, and
 * routes here; we re-use the byte as the first byte of {@link parseSType}
 * via {@link parseSTypeWithFirstByte}.
 *
 * Serialization is symmetric: the SType serializer emits the type_code_byte
 * as its first output byte, which IS the on-wire opcode for the surrounding
 * Expr. {@link serializeConst} therefore does NOT emit a separate opcode
 * prefix — that would corrupt the wire format.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/constant.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:88-93
 */

import type { Const } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSTypeWithFirstByte } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
import { parseSValue } from '../parse-svalue'
import { serializeSValue } from '../serialize-svalue'

/**
 * Parse an inline `Const` when `firstByte` has already been consumed by the
 * Expr dispatcher (and is the first byte of the SType). Mirrors
 * sigma-rust's `Constant::parse_with_tag`.
 *
 * `treeVersion` gates SHeader: see `parseSValue` for details. For inline body
 * constants, `treeVersion` should be the ErgoTree header version of the
 * enclosing tree (0 = safe default for pre-V3 trees).
 * Required (not defaulted) so call sites inherited from the Expr dispatcher
 * always thread an explicit value — the default lives at the public
 * parseExpr / parseExprWithFirstByte boundary.
 */
export function parseConstFromByte(firstByte: number, treeVersion: number, r: ByteReader): Const {
  const tpe = parseSTypeWithFirstByte(firstByte, r)
  const value = parseSValue(tpe, treeVersion, r)
  return { tag: 'Const', tpe, value }
}

/**
 * Serialize a `Const`. The first byte of the SType doubles as the opcode
 * byte in the surrounding Expr stream; the caller {@link serializeExpr} does
 * not (and must not) emit an opcode prefix for Const.
 *
 * `treeVersion` gates SHeader: see `serializeSValue` for details.
 * Required (not defaulted) for the same reason as parseConstFromByte — the
 * default lives at the serializeExpr boundary.
 */
export function serializeConst(c: Const, treeVersion: number, w: ByteWriter): void {
  serializeSType(c.tpe, w)
  serializeSValue(c.tpe, c.value, treeVersion, w)
}
