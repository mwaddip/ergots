/**
 * ValUse — parse + serialize.
 *
 * Wire format (sigma-rust `mir/val_use.rs`):
 *
 *   [OP_VAL_USE opcode = 0x72] [VLQ-u32 val_id]
 *
 * Critical: ValUse's `tpe` is NOT on the wire. Sigma-rust recovers it by
 * looking up `val_id` in a `ValDefTypeStore` populated when the enclosing
 * BlockValue's ValDef items were parsed (see `serialization/val_def_type_store.rs`
 * and `mir/val_def.rs::sigma_parse`). We mirror that scoping discipline by
 * threading a `Map<number, SType>` through {@link parseExpr}: ValDef inserts
 * `(id, rhs.tpe())` into the map; ValUse reads `tpe` from the map.
 *
 * Sigma-rust failure mode is `SigmaParsingError::ValDefIdNotFound`; we raise
 * `ExprParseError` with code `val-use-unknown-id`.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/val_use.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/val_def_type_store.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:162,273
 */

import type { SType, ValUse } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprParseError } from '../errors'

/**
 * Parse a `ValUse` payload (the OP_VAL_USE opcode byte was consumed by the
 * dispatcher). Looks up `tpe` from `valDefTypes`. Throws `ExprParseError`
 * with code `val-use-unknown-id` if the id is not in the map.
 *
 * Mirrors sigma-rust's `ValUse::sigma_parse`.
 */
export function parseValUse(
  r: ByteReader,
  valDefTypes: Map<number, SType>
): ValUse {
  const valId = r.readVlqU()
  const tpe = valDefTypes.get(valId)
  if (tpe === undefined) {
    throw new ExprParseError(
      `ValUse references unknown ValDef id ${valId} ` +
        `(known ids: [${[...valDefTypes.keys()].join(', ')}])`,
      'val-use-unknown-id'
    )
  }
  return { tag: 'ValUse', valId, tpe }
}

/**
 * Serialize a `ValUse` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_VAL_USE opcode byte). Only `valId` is written — `tpe` is
 * recovered on parse from the enclosing scope's ValDef bindings, matching
 * sigma-rust's `ValUse::sigma_serialize`.
 */
export function serializeValUse(v: ValUse, w: ByteWriter): void {
  w.writeVlqU(v.valId)
}
