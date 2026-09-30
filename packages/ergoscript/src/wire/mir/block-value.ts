/**
 * BlockValue — parse + serialize.
 *
 * Wire format (sigma-rust `mir/block.rs`):
 *
 *   [OP_BLOCK_VALUE opcode = 0xd8]
 *   [items: Vec<Expr>] = [VLQ-u32 count] [each Expr]*
 *   [result: Expr]
 *
 * The `Vec<Expr>` encoding is `len as u32` followed by each element, per
 * the generic `impl SigmaSerializable for Vec<T>`
 * (`ergotree-ir/src/serialization/serializable.rs:172`). `put_u32` is plain
 * VLQ on the wire (`sigma-ser/src/vlq_encode.rs:78` — calls `put_u64` with
 * `v as u64`).
 *
 * Each item is typed `Expr` on the AST side, and the parse admits only a
 * `ValDef` (a let-binding; a FunDef parses as one). The JVM casts each item to
 * `BlockItem` as it is read (BlockValueSerializer.scala:38-40), a trait whose
 * only subclass is `ValDef` (sigma/ast/values.scala:924, 945-948), so any other
 * item is a ClassCastException there: `'block-value-item-not-val-def'`.
 * Sigma-rust's parse accepts any Expr; ergots follows the JVM.
 *
 * An empty `items` list is wire-legal: `[count=0] [result Expr]`. Sigma-rust
 * accepts it (`Vec::sigma_parse` reads `count=0` and returns an empty Vec
 * with no validation). We mirror that — it would be wrong to reject what
 * the JVM and sigma-rust accept.
 *
 * The val-def-type-store is threaded through unchanged: each ValDef
 * encountered while parsing `items` populates it; a ValUse in the result
 * (or in any later ValDef's rhs) reads from it. This matches sigma-rust's
 * single shared store per reader.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/block.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs:172-186
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:158,272
 */

import type { BlockValue, Expr, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError } from '../errors'
// Forward import for recursive descent — see comment in val-def.ts.
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { readArrayCount } from './_jvm-counts'

/**
 * Parse a `BlockValue` payload (the OP_BLOCK_VALUE opcode byte was consumed
 * by the dispatcher). Reads the items count, then each item Expr, then the
 * result Expr.
 *
 * Mirrors sigma-rust's `BlockValue::sigma_parse`.
 */
export function parseBlockValue(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): BlockValue {
  // JVM BlockValueSerializer.scala:28-37: getUIntExact, then safeNewArray.
  const count = readArrayCount(r, 'BlockValue items count', 'block-too-many-items')
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    const item = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
    // BlockValueSerializer.scala:39: r.getValue().asInstanceOf[BlockItem] right after each item is read,
    // before the next; BlockItem's only subclass is ValDef (values.scala:924, 945-948). A
    // ClassCastException, which the Deserialize substitution swallows (isJvmClassCast).
    if (item.tag !== 'ValDef') {
      throw new ExprParseError(
        `BlockValue item ${i} is a ${item.tag}, not a ValDef (the JVM's BlockItem)`,
        'block-value-item-not-val-def'
      )
    }
    items.push(item)
  }
  const result = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'BlockValue', items, result }
}

/**
 * Serialize a `BlockValue` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_BLOCK_VALUE opcode byte). Writes the items count as VLQ-u32,
 * each item Expr in order, then the result Expr.
 */
export function serializeBlockValue(b: BlockValue, w: ByteWriter, treeVersion: number): void {
  w.writeVlqU(b.items.length)
  for (const item of b.items) {
    serializeExpr(item, w, treeVersion)
  }
  serializeExpr(b.result, w, treeVersion)
}
