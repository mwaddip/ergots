/**
 * CollByIndex — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_by_index.rs`):
 *
 *   [OP_BY_INDEX opcode = 0xb2]
 *   [input: Expr]               -- the collection (SColl)
 *   [index: Expr]               -- the index (SInt)
 *   [default: Option<Box<Expr>>] -- present iff `Coll.getOrElse` (else `null`)
 *
 * ByIndex indexes a collection: strict `Coll.apply(i)` when `default == null`,
 * or `Coll.getOrElse(i, default)` when present.
 *
 * The `Option<Box<Expr>>` encoding follows sigma-rust's generic impl in
 * `serialization/serializable.rs:212-231`:
 *
 *   - tag byte 0x01 → Some, immediately followed by the inner Expr
 *   - tag byte 0x00 → None, no further bytes
 *
 * Any non-zero tag byte is treated as Some in sigma-rust (`tag != 0`), but
 * sigma-rust's own writer always emits exactly 0x00 or 0x01. We mirror both
 * directions: the parser accepts any non-zero tag as Some; the serializer
 * always writes 0x01 / 0x00.
 *
 * Sigma-rust's `ByIndex::new` enforces post-eval typing: input must be
 * `SColl(_)`, index must be `SInt`, and if `default` is present its
 * post-eval tpe must match the collection's element type
 * (`mir/coll_by_index.rs:33-66`). We do NOT enforce that at the wire layer
 * — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_by_index.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs:212-231
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::BY_INDEX)
 */

import type { ByIndex, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ByIndex` payload (the OP_BY_INDEX opcode byte was consumed by
 * the dispatcher). Reads the input Expr, the index Expr, then the optional
 * default tagged by a single byte (0 = None, non-zero = Some).
 *
 * Mirrors sigma-rust's `<ByIndex as SigmaSerializable>::sigma_parse`
 * (`mir/coll_by_index.rs:86-91`) and the generic `Option<Box<T>>`
 * decoding from `serialization/serializable.rs:223-230` (`tag != 0`).
 */
export function parseCollByIndex(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ByIndex {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const index = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const tag = r.readU8()
  const def =
    tag !== 0
      ? parseExpr(r, constantTypes, constantValues, valDefTypes)
      : null
  return { tag: 'ByIndex', input, index, default: def }
}

/**
 * Serialize a `ByIndex` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_BY_INDEX opcode byte). Writes the input Expr, the index
 * Expr, then the optional default as a tagged Option: 0x01 + inner when
 * present, single 0x00 when absent.
 */
export function serializeCollByIndex(e: ByIndex, w: ByteWriter): void {
  serializeExpr(e.input, w)
  serializeExpr(e.index, w)
  if (e.default === null) {
    w.writeU8(0)
  } else {
    w.writeU8(1)
    serializeExpr(e.default, w)
  }
}
