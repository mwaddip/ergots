/**
 * CreateProveDlog — parse + serialize.
 *
 * Wire format (sigma-rust `mir/create_provedlog.rs`):
 *
 *   [OP_PROVE_DLOG opcode = 0xcd]
 *   [input: Expr]                  -- SGroupElement (the PK)
 *
 * Constructs a `ProveDlog` sigma proposition from a public key (GroupElement).
 * Follows sigma-rust's `OneArgOp` + `OneArgOpTryBuild` pattern
 * (`mir/unary_op.rs:26-36`): a single inner Expr is parsed / serialized after
 * the opcode byte.
 *
 * Sigma-rust's `try_build` rejects non-`SGroupElement` inputs
 * (`mir/create_provedlog.rs:34-40`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass (same convention as
 * BoolToSigmaProp / DecodePoint / CalcBlake2b256).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/create_provedlog.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/unary_op.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs
 *     (OpCode::PROVE_DLOG = new_op_code(93) → 112 + 93 = 205 = 0xcd)
 */

import type { CreateProveDlog, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `CreateProveDlog` payload (the OP_PROVE_DLOG opcode byte was
 * consumed by the dispatcher). Reads one Expr — the input public key
 * (GroupElement).
 *
 * Mirrors sigma-rust's `<CreateProveDlog as SigmaSerializable>::sigma_parse`
 * via the `OneArgOp` blanket impl.
 */
export function parseCreateProveDlog(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): CreateProveDlog {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  return { tag: 'CreateProveDlog', input }
}

/**
 * Serialize a `CreateProveDlog` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_PROVE_DLOG opcode byte). Writes the
 * input Expr.
 */
export function serializeCreateProveDlog(
  c: CreateProveDlog,
  w: ByteWriter,
  treeVersion: number
): void {
  serializeExpr(c.input, w, treeVersion)
}
