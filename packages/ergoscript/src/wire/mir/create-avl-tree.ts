/**
 * CreateAvlTree — parse + serialize.
 *
 * Wire format (sigma-rust `mir/create_avl_tree.rs:72-85`):
 *
 *   [OP_AVL_TREE opcode = 0xb6]
 *   [flags: Expr]                  -- post-eval type SByte
 *   [digest: Expr]                 -- post-eval type SColl(SByte)
 *   [keyLength: Expr]              -- post-eval type SInt
 *   [valueLength: Option<Expr>]    -- standard Option<Box<T>> encoding:
 *     tag byte:
 *       0x00 → None (no value follows)
 *       0x01 → Some(value Expr follows)
 *
 * The four fields are written in order with no length prefix on the run
 * itself; the parser knows the run is exactly 4 elements long.
 *
 * The `valueLength` Option uses the same wire shape as
 * `impl<T: SigmaSerializable> SigmaSerializable for Option<Box<T>>` in
 * sigma-rust `serialization/serializable.rs` — one tag byte, then the
 * inner value (no length prefix on the inner Expr because Expr is
 * self-delimited via its opcode dispatch).
 *
 * Type-shape checks (e.g. that `flags.tpe == SByte`) are sigma-rust
 * constructor invariants enforced by `CreateAvlTree::new`. We do NOT
 * re-check those at the wire layer — well-formed corpora satisfy them
 * by construction and any type-mismatch is a higher-layer concern.
 *
 * Full AVL+ membership-proof verification is deferred to phase 2h
 * (see task description). This codec only handles the wire shape.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_avl_tree.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/serializable.rs (Option<Box<T>>)
 */

import type { CreateAvlTree, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprParseError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `CreateAvlTree` payload (the OP_AVL_TREE opcode byte was consumed
 * by the dispatcher).
 *
 * Mirrors sigma-rust's `<CreateAvlTree as SigmaSerializable>::sigma_parse`
 * (`mir/create_avl_tree.rs:72-78`).
 */
export function parseCreateAvlTree(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): CreateAvlTree {
  const flags = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const digest = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const keyLength = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const tag = r.readU8()
  let valueLength = null
  if (tag === 1) {
    valueLength = parseExpr(r, constantTypes, constantValues, valDefTypes)
  } else if (tag !== 0) {
    throw new ExprParseError(
      `CreateAvlTree.valueLength Option tag must be 0 or 1, got ${tag}`,
      'invalid-option-tag'
    )
  }
  return { tag: 'CreateAvlTree', flags, digest, keyLength, valueLength }
}

/**
 * Serialize a `CreateAvlTree` payload (the dispatcher in `serializeExpr`
 * emits the OP_AVL_TREE opcode byte).
 *
 * Mirrors sigma-rust's `<CreateAvlTree as SigmaSerializable>::sigma_serialize`
 * (`mir/create_avl_tree.rs:80-85`).
 */
export function serializeCreateAvlTree(e: CreateAvlTree, w: ByteWriter): void {
  serializeExpr(e.flags, w)
  serializeExpr(e.digest, w)
  serializeExpr(e.keyLength, w)
  w.writeOption(e.valueLength, (w, inner) => serializeExpr(inner, w))
}
