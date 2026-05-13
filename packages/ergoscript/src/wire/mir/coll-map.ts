/**
 * CollMap — parse + serialize.
 *
 * Wire format (sigma-rust `mir/coll_map.rs`):
 *
 *   [OP_MAP opcode = 0xad]
 *   [input: Expr]    -- the source collection (SColl)
 *   [mapper: Expr]   -- the per-element function (typically FuncValue)
 *
 * Map applies `mapper` to each element of `input`, producing a new
 * collection. The wire payload is two back-to-back Exprs parsed recursively
 * via the central dispatcher. The mapper is typically a `FuncValue` but the
 * wire format does not require it (any expression of `SFunc` type works).
 *
 * Sigma-rust's `Map::new` enforces post-eval typing: `input` must be
 * `SColl(elem)` and `mapper` must be `SFunc` with a single arg of type
 * `elem` (`mir/coll_map.rs:30-50`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/coll_map.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::MAP)
 */

import type { Map as CollMap, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `Map` payload (the OP_MAP opcode byte was consumed by the
 * dispatcher). Reads the input collection Expr, then the mapper Expr.
 *
 * Mirrors sigma-rust's `<Map as SigmaSerializable>::sigma_parse`
 * (`mir/coll_map.rs:74-78`).
 */
export function parseCollMap(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): CollMap {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const mapper = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'Map', input, mapper }
}

/**
 * Serialize a `Map` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_MAP opcode byte). Writes the input Expr, then the mapper Expr.
 */
export function serializeCollMap(e: CollMap, w: ByteWriter): void {
  serializeExpr(e.input, w)
  serializeExpr(e.mapper, w)
}
