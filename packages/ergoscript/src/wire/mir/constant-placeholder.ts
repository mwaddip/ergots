/**
 * ConstantPlaceholder — parse + serialize.
 *
 * Wire format (sigma-rust `serialization/constant_placeholder.rs`):
 *
 *   [OP_CONSTANT_PLACEHOLDER opcode = 0x73] [VLQ-u32 id]
 *
 * The opcode byte is consumed by the {@link parseExpr} dispatcher before
 * this function runs. The `id` is a zero-based index into the surrounding
 * ErgoTree's segregated-constants array (`tree.constantTypes` /
 * `tree.constants`, parallel arrays).
 *
 * Sigma-rust's parser fails fast when the id has no matching constant in
 * its `ConstantStore` (`ConstantForPlaceholderNotFound`). We mirror that
 * by requiring the dispatcher to pass the parallel arrays; an out-of-range
 * id throws {@link ExprParseError} with code `invalid-constant-placeholder-id`.
 *
 * The placeholder's `tpe` is recovered from `constantTypes[id]` — it is NOT
 * encoded inline. This is the key difference from inline {@link Const}.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/constant_placeholder.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:98-109
 */

import type { ConstPlaceholder, SType } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprParseError } from '../errors'

/**
 * Parse a `ConstantPlaceholder` payload (the opcode byte was consumed by the
 * dispatcher). Looks up the placeholder's SType from the parallel
 * `constantTypes` array. Throws `ExprParseError` with code
 * `invalid-constant-placeholder-id` if `id >= constantTypes.length`.
 *
 * Mirrors sigma-rust's `ConstantPlaceholder::sigma_parse`.
 */
export function parseConstantPlaceholder(
  r: ByteReader,
  constantTypes: SType[]
): ConstPlaceholder {
  const id = r.readVlqU()
  if (id >= constantTypes.length) {
    throw new ExprParseError(
      `ConstantPlaceholder id ${id} out of range ` +
        `(${constantTypes.length} segregated constants)`,
      'invalid-constant-placeholder-id'
    )
  }
  return { tag: 'ConstPlaceholder', id, tpe: constantTypes[id]! }
}

/**
 * Serialize a `ConstantPlaceholder` payload (the dispatch in
 * {@link serializeExpr} emits the OP_CONSTANT_PLACEHOLDER opcode byte).
 * The placeholder's `tpe` is NOT written — it is recovered on parse from
 * the surrounding ErgoTree's constants table.
 */
export function serializeConstantPlaceholder(
  p: ConstPlaceholder,
  w: ByteWriter
): void {
  w.writeVlqU(p.id)
}
