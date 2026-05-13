/**
 * ValDef — parse + serialize.
 *
 * Wire format (sigma-rust `mir/val_def.rs`):
 *
 *   [OP_VAL_DEF opcode = 0xd6] [VLQ-u32 id] [rhs Expr]
 *
 * The `id` is a `ValId(u32)` written with `put_u32` (which is plain VLQ;
 * see `sigma-ser/src/vlq_encode.rs:78`). No type bytes are emitted — the
 * rhs's type is recovered from the rhs Expr's own structure (see
 * {@link exprTpe}). Sigma-rust's parser has a side effect: it inserts
 * `(id, rhs.tpe())` into a thread-through `ValDefTypeStore` so a sibling
 * or descendant `ValUse` node can look up the type by id. We replicate
 * that side effect via the `valDefTypes` Map parameter, populated here
 * after parsing the rhs.
 *
 * Note (sigma-rust intentional decision): there is no validation that the
 * id is unique within the surrounding BlockValue's items. The Scala/Rust
 * implementations rely on the prover/compiler to emit a topologically
 * ordered, deduplicated sequence. We mirror that: a second ValDef with the
 * same id silently overwrites the earlier binding in the store, exactly
 * as `HashMap::insert` does in sigma-rust.
 *
 * ValDef is reachable as a top-level Expr via the dispatcher (sigma-rust
 * `serialization/expr.rs:161`), but in practice it only appears inside a
 * `BlockValue.items` list — that's the producer side, and the consumer
 * (ValUse) requires the store to be populated.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/val_def.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:161,274
 */

import type { SType, SValue, ValDef } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprParseError } from '../errors'
import { exprTpe } from '../../mir/expr-tpe'
// Forward import: parse.ts and serialize.ts re-export their dispatcher
// functions. The Expr graph is mutually recursive (ValDef → Expr → ValDef …)
// so the import cycle is unavoidable. ESM hoists `import` declarations and
// resolves names at first use, so the call site below sees the real
// `parseExpr` even though it's defined in a module that itself imports us.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `ValDef` payload (the OP_VAL_DEF opcode byte was consumed by the
 * dispatcher). Reads `id`, then parses the rhs Expr (which may itself
 * contain ValDef/ValUse nodes), then records the binding in `valDefTypes`
 * so a later sibling/descendant `ValUse` of the same id can recover its
 * type.
 *
 * Mirrors sigma-rust's `ValDef::sigma_parse`.
 */
export function parseValDef(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): ValDef {
  const id = r.readVlqU()
  const rhs = parseExpr(r, constantTypes, constantValues, valDefTypes)
  // Side effect: register the binding for the scope. Sigma-rust uses
  // HashMap::insert which silently overwrites; we mirror that semantic.
  try {
    valDefTypes.set(id, exprTpe(rhs))
  } catch (e) {
    // exprTpe throws when rhs is a yet-unimplemented variant. Surface
    // the error as an ExprParseError so callers see a single taxonomy.
    throw new ExprParseError(
      `ValDef(id=${id}): cannot determine rhs type — ${(e as Error).message}`,
      'val-def-rhs-tpe'
    )
  }
  return { tag: 'ValDef', id, rhs }
}

/**
 * Serialize a `ValDef` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_VAL_DEF opcode byte). Writes `id` (VLQ-u32) followed by
 * the rhs Expr.
 */
export function serializeValDef(d: ValDef, w: ByteWriter): void {
  w.writeVlqU(d.id)
  serializeExpr(d.rhs, w)
}
