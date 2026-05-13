/**
 * ExtractRegisterAs — parse + serialize.
 *
 * Wire format (sigma-rust `mir/extract_reg_as.rs`):
 *
 *   [OP_EXTRACT_REGISTER_AS opcode = 0xc6]
 *   [input: Expr]              -- the box to extract from (post-eval type: SBox)
 *   [register_id: i8]          -- raw signed byte: 0..9 for R0..R9
 *   [elem_tpe: SType]          -- inner element type (NOT wrapped in SOption on the wire)
 *
 * ExtractRegisterAs returns `Option[T]` where `T = elem_tpe`. The wire
 * encodes the bare `elem_tpe` only; sigma-rust wraps it back as
 * `SType::SOption(elem_tpe)` at construction time (`mir/extract_reg_as.rs:78`).
 * Our AST stores `elemTpe` un-wrapped to match the wire encoding 1:1 — the
 * later type-pass / interpreter reconstructs the SOption when computing
 * the variant's `tpe()`.
 *
 * The `register_id` byte uses sigma-rust's `put_i8` / `get_i8` which are
 * raw u8 casts (`sigma-ser/vlq_encode.rs:41-42` and `:172-174`). A negative
 * `register_id` (e.g. internal -1 placeholder) round-trips through two's-
 * complement: write as `(id & 0xff)`, parse as `byte > 127 ? byte - 256 : byte`.
 *
 * Sigma-rust's `ExtractRegisterAs::new` rejects:
 *   - inputs whose post-eval type is not SBox
 *   - non-SOption `tpe` arguments (the `try_build` wraps elem_tpe; the
 *     parser passes `SType::SOption(elem_tpe.into())` so this can never
 *     fail at parse time)
 * We do NOT enforce the SBox-input check at the wire layer — type-shape
 * checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/extract_reg_as.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (ExtractRegisterAs::OP_CODE)
 */

import type { ExtractRegisterAs, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

/**
 * Parse an `ExtractRegisterAs` payload (the OP_EXTRACT_REGISTER_AS opcode
 * byte was consumed by the dispatcher). Reads the input Expr, then the
 * one-byte signed register id, then the element SType.
 *
 * Mirrors sigma-rust's `<ExtractRegisterAs as SigmaSerializable>::sigma_parse`
 * (`mir/extract_reg_as.rs:67-77`).
 */
export function parseExtractRegisterAs(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ExtractRegisterAs {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  // i8: read u8 byte, sign-extend if the top bit is set. Mirrors
  // sigma-rust's `get_i8 -> get_u8 as i8`.
  const rawByte = r.readU8()
  const registerId = rawByte > 127 ? rawByte - 256 : rawByte
  const elemTpe = parseSType(r)
  return { tag: 'ExtractRegisterAs', input, registerId, elemTpe }
}

/**
 * Serialize an `ExtractRegisterAs` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_EXTRACT_REGISTER_AS opcode byte).
 * Writes the input Expr, the register id as a raw u8 (two's-complement
 * i8 cast), then the element SType.
 */
export function serializeExtractRegisterAs(
  e: ExtractRegisterAs,
  w: ByteWriter
): void {
  if (!Number.isInteger(e.registerId) || e.registerId < -128 || e.registerId > 127) {
    throw new ExprSerializeError(
      `ExtractRegisterAs.registerId ${e.registerId} out of i8 range [-128, 127]`,
      'extract-register-as-id-out-of-range'
    )
  }
  serializeExpr(e.input, w)
  // i8: two's-complement byte. Mirrors sigma-rust's `put_i8 -> put_u8(v as u8)`.
  w.writeU8(e.registerId & 0xff)
  serializeSType(e.elemTpe, w)
}
