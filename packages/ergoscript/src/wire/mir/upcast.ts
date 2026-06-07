/**
 * Upcast — parse + serialize.
 *
 * Wire format (sigma-rust `mir/upcast.rs`):
 *
 *   [OP_UPCAST opcode = 0x7e]
 *   [input: Expr]
 *   [tpe:   SType]      -- target type for the conversion
 *
 * Upcast is a numerical widening conversion between SByte / SShort / SInt
 * / SLong / SBigInt — semantically, the target type must be wider than
 * the input's post-eval type. Both the input Expr and the target SType
 * are written end-to-end after the opcode byte; this mirrors sigma-rust's
 * `<Upcast as SigmaSerializable>::sigma_serialize` (`mir/upcast.rs:60-66`).
 *
 * Sigma-rust's `Upcast::new` constructor rejects non-numeric source or
 * target types (`mir/upcast.rs:31-49`). We do NOT enforce that at the
 * wire layer — type-shape checks belong to a later pass. The wire-layer
 * parser is permissive (same convention as Negation / BitInversion /
 * BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/upcast.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:131
 */

import type { SType, SValue, Upcast } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

/**
 * Parse an `Upcast` payload (the OP_UPCAST opcode byte was consumed by
 * the dispatcher). Reads an input Expr followed by the target SType.
 *
 * Mirrors sigma-rust's `<Upcast as SigmaSerializable>::sigma_parse`
 * (`mir/upcast.rs:68-72`).
 */
export function parseUpcast(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Upcast {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const tpe = parseSType(r)
  return { tag: 'Upcast', input, tpe }
}

/**
 * Serialize an `Upcast` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_UPCAST opcode byte). Writes the input Expr followed by
 * the target SType.
 */
export function serializeUpcast(u: Upcast, w: ByteWriter, treeVersion: number): void {
  serializeExpr(u.input, w, treeVersion)
  serializeSType(u.tpe, w)
}
