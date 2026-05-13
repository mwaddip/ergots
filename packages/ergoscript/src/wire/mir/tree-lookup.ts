/**
 * TreeLookup — parse + serialize.
 *
 * Wire format (sigma-rust `mir/tree_lookup.rs:49-61`):
 *
 *   [OP_AVL_TREE_GET opcode = 0xb7]
 *   [tree: Expr]                   -- post-eval type SAvlTree
 *   [key: Expr]                    -- post-eval type SColl(SByte)
 *   [proof: Expr]                  -- post-eval type SColl(SByte)
 *
 * Three Expr nodes in order, no length prefix.
 *
 * Note the sigma-rust opcode constant is `AVT_TREE_GET` (typo preserved
 * from the upstream Scala source); we use `OP_AVL_TREE_GET` in our
 * constants table for readability. The wire byte is the same (0xb7).
 *
 * Type-shape checks (`tree.tpe == SAvlTree`, etc.) are sigma-rust
 * constructor invariants enforced by `TreeLookup::new`. We do NOT
 * re-check those at the wire layer.
 *
 * Full AVL+ membership-proof verification is deferred to phase 2h
 * (see task description). This codec only handles the wire shape; the
 * `proof` Expr at runtime carries the merkle-path bytes that the
 * future verifier will consume.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/tree_lookup.rs
 */

import type { TreeLookup, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `TreeLookup` payload (the OP_AVL_TREE_GET opcode byte was
 * consumed by the dispatcher).
 *
 * Mirrors sigma-rust's `<TreeLookup as SigmaSerializable>::sigma_parse`
 * (`mir/tree_lookup.rs:56-61`).
 */
export function parseTreeLookup(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): TreeLookup {
  const tree = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const key = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const proof = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'TreeLookup', tree, key, proof }
}

/**
 * Serialize a `TreeLookup` payload (the dispatcher in `serializeExpr`
 * emits the OP_AVL_TREE_GET opcode byte).
 *
 * Mirrors sigma-rust's `<TreeLookup as SigmaSerializable>::sigma_serialize`
 * (`mir/tree_lookup.rs:50-54`).
 */
export function serializeTreeLookup(e: TreeLookup, w: ByteWriter): void {
  serializeExpr(e.tree, w)
  serializeExpr(e.key, w)
  serializeExpr(e.proof, w)
}
