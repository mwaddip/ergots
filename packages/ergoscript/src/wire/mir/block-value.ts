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
 * Each item is typed `Expr` on the AST side but in well-formed trees they
 * are `ValDef` nodes (let-bindings). Sigma-rust does NOT enforce this at
 * parse time — the items array accepts any Expr — so neither do we. The
 * compiler/prover invariant that items are ValDefs is preserved at the
 * higher (AST-shape) layer.
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

// Defensive cap on the items array length. Real BlockValues have only a
// handful of let-bindings; a count beyond this is almost certainly a
// malicious/corrupt encoding aimed at allocating a huge array before the
// reader hits truncation. Sigma-rust caps Vec deserialization indirectly
// via the surrounding ErgoTree size limit; we add an explicit bound here
// because the per-element memory cost of `Expr` is non-trivial.
const MAX_BLOCK_ITEMS = 1 << 16 // 65536, well above any plausible script

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
  const count = r.readVlqU()
  if (count > MAX_BLOCK_ITEMS) {
    throw new ExprParseError(
      `BlockValue items count ${count} exceeds ${MAX_BLOCK_ITEMS}`,
      'block-too-many-items'
    )
  }
  const items: Expr[] = []
  for (let i = 0; i < count; i++) {
    items.push(parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion))
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
