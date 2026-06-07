/**
 * CreateAvlTree — parse + serialize.
 *
 * Wire format (JVM `CreateAvlTreeSerializer.scala:24-37`, canonical):
 *
 *   [OP_AVL_TREE opcode = 0xb6]
 *   [flags: Expr]                  -- type SByte
 *   [digest: Expr]                 -- type SColl(SByte)
 *   [keyLength: Expr]              -- type SInt
 *   [valueLengthOpt: Expr]         -- type SOption(SInt)
 *
 * FOUR operands, ALL written via the expr channel (`w.putValue(...)` ×4 in
 * `serialize`, `r.getValue()` ×4 in `parse`). The 4th operand is an expr
 * whose *type* is Option (JVM `valueLengthOpt: Value[SIntOption]`,
 * trees.scala:82) — "no value length" is an Option-typed expr that
 * evaluates to None (the compiler emits `Const(SOption[SInt], None)`),
 * NOT an absent operand. There is no presence tag anywhere in the run,
 * and no length prefix — the parser knows the run is exactly 4 exprs.
 *
 * ⚠ sigma-rust FORKS this layout (ergo-node-integration
 * `ergotree-ir/src/mir/create_avl_tree.rs`): its 4th operand is
 * `Option<Box<Expr>>` — a one-byte presence tag (0x00 = absent,
 * 0x01 = expr follows). JVM-emitted bytes are unparseable under that shape
 * (the JVM-blessed vector `AvlTree.unsupported_eval_nodes_v6.json
 * #create_avl_tree-errored#1` puts a ConstantPlaceholder 0x73 where
 * sigma-rust expects the tag → parse crash) and sigma-rust-emitted
 * CreateAvlTree bytes are unparseable by the JVM. ergots originally ported
 * the sigma-rust shape; fixed to the JVM layout in the F4 epilogue
 * (2026-06-07). The fork is routed to sigma-rust via SANTA.
 *
 * Type-shape checks (e.g. that `flags.tpe == SByte`) are constructor
 * invariants in both references. We do NOT re-check those at the wire
 * layer — well-formed corpora satisfy them by construction and any
 * type-mismatch is a higher-layer concern (eval rejects the node
 * unconditionally anyway — no JVM eval override; see
 * eval/create-avl-tree.ts).
 *
 * Cross-reference:
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/
 *     serialization/CreateAvlTreeSerializer.scala (canonical)
 *   external/sigma-rust @ ergo-node-integration:
 *     ergotree-ir/src/mir/create_avl_tree.rs (forked presence-tag shape)
 */

import type { CreateAvlTree, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `CreateAvlTree` payload (the OP_AVL_TREE opcode byte was consumed
 * by the dispatcher).
 *
 * Mirrors the JVM `CreateAvlTreeSerializer.parse`
 * (`CreateAvlTreeSerializer.scala:31-37`) — four `r.getValue()` calls.
 *
 * `treeVersion` is required to correctly gate version-dependent constant
 * encodings (e.g. Const(SOption[SInt], …) in the valueLengthOpt operand
 * requires tree-version ≥ 3 per CoreDataSerializer.scala:140-143).
 */
export function parseCreateAvlTree(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): CreateAvlTree {
  const flags = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const digest = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const keyLength = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const valueLength = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'CreateAvlTree', flags, digest, keyLength, valueLength }
}

/**
 * Serialize a `CreateAvlTree` payload (the dispatcher in `serializeExpr`
 * emits the OP_AVL_TREE opcode byte).
 *
 * Mirrors the JVM `CreateAvlTreeSerializer.serialize`
 * (`CreateAvlTreeSerializer.scala:24-29`) — four `w.putValue(...)` calls.
 *
 * `treeVersion` is forwarded to `serializeExpr` so that version-dependent
 * constant encodings (e.g. Const(SOption[SInt], …)) are gated correctly.
 */
export function serializeCreateAvlTree(e: CreateAvlTree, w: ByteWriter, treeVersion: number): void {
  serializeExpr(e.flags, w, treeVersion)
  serializeExpr(e.digest, w, treeVersion)
  serializeExpr(e.keyLength, w, treeVersion)
  serializeExpr(e.valueLength, w, treeVersion)
}
