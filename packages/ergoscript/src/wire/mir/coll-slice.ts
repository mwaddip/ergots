/**
 * CollSlice — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_slice.rs`):
 *
 *   [OP_SLICE opcode = 0xb4]
 *   [input: Expr]    -- the collection to slice
 *   [from: Expr]     -- the lowest index INCLUDED in the slice (SInt)
 *   [until: Expr]    -- the lowest index EXCLUDED from the slice (SInt)
 *
 * Slice produces a sub-collection `input[from..until)`. The wire payload is
 * three back-to-back Exprs parsed recursively via the central dispatcher.
 *
 * Sigma-rust's `Slice::new` enforces that `input.post_eval_tpe() == SColl(_)`
 * and both `from` and `until` are `SInt` (`mir/coll_slice.rs:30-50`). We do
 * NOT enforce these type-shape checks at the wire layer — they belong to a
 * later pass. The wire-layer parser is permissive (same convention as Append
 * / SelectField / others).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_slice.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::SLICE)
 */

import type { Slice, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `Slice` payload (the OP_SLICE opcode byte was consumed by the
 * dispatcher). Reads the input collection Expr, then the `from` SInt Expr,
 * then the `until` SInt Expr.
 *
 * Mirrors sigma-rust's `<Slice as SigmaSerializable>::sigma_parse`
 * (`mir/coll_slice.rs:75-80`).
 */
export function parseCollSlice(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Slice {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const from = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const until = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Slice', input, from, until }
}

/**
 * Serialize a `Slice` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_SLICE opcode byte). Writes the input Expr, then `from`,
 * then `until`.
 */
export function serializeCollSlice(e: Slice, w: ByteWriter): void {
  serializeExpr(e.input, w)
  serializeExpr(e.from, w)
  serializeExpr(e.until, w)
}
