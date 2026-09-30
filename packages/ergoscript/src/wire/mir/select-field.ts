/**
 * SelectField — parse + serialize.
 *
 * Wire format (sigma-rust `mir/select_field.rs`):
 *
 *   [OP_SELECT_FIELD opcode = 0x8c]
 *   [input: Expr]              -- the tuple to index (post-eval type: STuple)
 *   [field_index: u8]          -- 1-based field index (the JVM's signed Byte)
 *
 * SelectField projects one field of a tuple value. The `field_index` is a
 * single raw byte; the zero-based index used at eval time is
 * `fieldIndex - 1`.
 *
 * ergots follows the JVM, not sigma-rust, whose parser rejects index 0 at
 * its byte (`TupleFieldIndex::sigma_parse`, `mir/select_field.rs:53-60`).
 * The JVM reads the index as a signed Byte with no check
 * (SelectFieldSerializer.scala:20-24), and the constructor casts the input's
 * type to STuple before it indexes it (transformers.scala:294-295). So over a
 * non-tuple an index of 0 is the cast's ClassCastException, which the
 * Deserialize substitution swallows, not an index error. The parse hook
 * (`checkBuild`) makes both checks, in that order, through `exprTpe`
 * (facts/ergoscript-wire.md, "Node construction"). The writer still refuses
 * an index outside 1..255.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/select_field.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs (OpCode::SELECT_FIELD)
 */

import type { SelectField, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `SelectField` payload (the OP_SELECT_FIELD opcode byte was
 * consumed by the dispatcher). Reads the input Expr, then the one-byte
 * field index, which the JVM's parse does not check (SelectFieldSerializer.scala:20-24).
 */
export function parseSelectField(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): SelectField {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  // SelectFieldSerializer.scala:20-24: the index byte is read with no check. The constructor casts the
  // input's type to STuple, then indexes it (transformers.scala:294-295), which the parse hook's type
  // read mirrors: a non-tuple is a class cast whatever the index, and an index of 0, of 128 and more
  // (a negative Byte) or past the arity is out of range (exprTpe's SelectField arm).
  const fieldIndex = r.readU8()
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
