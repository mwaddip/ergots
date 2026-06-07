/**
 * SelectField — parse + serialize.
 *
 * Wire format (sigma-rust `mir/select_field.rs`):
 *
 *   [OP_SELECT_FIELD opcode = 0x8c]
 *   [input: Expr]              -- the tuple to index (post-eval type: STuple)
 *   [field_index: u8]          -- 1-based field index, valid range 1..=255
 *
 * SelectField projects one field of a tuple value. The `field_index` is a
 * single raw u8 with sigma-rust's `TupleFieldIndex` newtype enforcing
 * `>= 1` (`mir/select_field.rs:30-37`); the zero-based index used at
 * eval time is `fieldIndex - 1`.
 *
 * Sigma-rust's `SelectField::new` additionally enforces that the input is
 * an STuple of sufficient arity (`mir/select_field.rs:74-95`). We do NOT
 * enforce that at the wire layer — type-shape checks belong to a later
 * pass. We DO enforce the `>= 1` field-index bound at the wire layer,
 * because sigma-rust's parser does (`TupleFieldIndex::sigma_parse` at
 * `mir/select_field.rs:53-60`); a `field_index == 0` is structurally
 * invalid and must be rejected by the parser to match sigma-rust's
 * `ValueOutOfBounds` taxonomy.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/select_field.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (OpCode::SELECT_FIELD)
 */

import type { SelectField, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SelectField` payload (the OP_SELECT_FIELD opcode byte was
 * consumed by the dispatcher). Reads the input Expr, then the one-byte
 * field index.
 *
 * Mirrors sigma-rust's `<SelectField as SigmaSerializable>::sigma_parse`
 * (`mir/select_field.rs:117-122`) and the bounded `TupleFieldIndex` newtype.
 */
export function parseSelectField(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): SelectField {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const fieldIndex = r.readU8()
  if (fieldIndex < 1) {
    throw new ExprParseError(
      `SelectField.fieldIndex must be >= 1, got ${fieldIndex}`,
      'select-field-index-out-of-range'
    )
  }
  return { tag: 'SelectField', input, fieldIndex }
}

/**
 * Serialize a `SelectField` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_SELECT_FIELD opcode byte). Writes the input Expr, then the
 * one-byte field index.
 */
export function serializeSelectField(e: SelectField, w: ByteWriter, treeVersion: number): void {
  if (
    !Number.isInteger(e.fieldIndex) ||
    e.fieldIndex < 1 ||
    e.fieldIndex > 255
  ) {
    throw new ExprSerializeError(
      `SelectField.fieldIndex ${e.fieldIndex} out of u8 range [1, 255]`,
      'select-field-index-out-of-range'
    )
  }
  serializeExpr(e.input, w, treeVersion)
  w.writeU8(e.fieldIndex)
}
