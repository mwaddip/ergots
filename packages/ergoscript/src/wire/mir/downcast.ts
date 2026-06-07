/**
 * Downcast — parse + serialize.
 *
 * Wire format (sigma-rust `mir/downcast.rs`):
 *
 *   [OP_DOWNCAST opcode = 0x7d]
 *   [input: Expr]
 *   [tpe:   SType]      -- target type for the conversion
 *
 * Downcast is a numerical narrowing conversion between SByte / SShort /
 * SInt / SLong / SBigInt — semantically, the target type must be
 * narrower than the input's post-eval type. The wire layout is identical
 * to Upcast: an input Expr and target SType end-to-end after the opcode.
 * Mirrors sigma-rust's `<Downcast as SigmaSerializable>::sigma_serialize`
 * (`mir/downcast.rs:60-66`).
 *
 * Sigma-rust's `Downcast::new` rejects non-numeric source or target
 * types (`mir/downcast.rs:31-49`). We do NOT enforce that at the wire
 * layer — type-shape checks belong to a later pass. The wire-layer
 * parser is permissive (same convention as Upcast / Negation /
 * BitInversion / BoolToSigmaProp).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/downcast.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:132
 */

import type { Downcast, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

/**
 * Parse a `Downcast` payload (the OP_DOWNCAST opcode byte was consumed
 * by the dispatcher). Reads an input Expr followed by the target SType.
 *
 * Mirrors sigma-rust's `<Downcast as SigmaSerializable>::sigma_parse`
 * (`mir/downcast.rs:68-72`).
 */
export function parseDowncast(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Downcast {
  const input = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const tpe = parseSType(r)
  return { tag: 'Downcast', input, tpe }
}

/**
 * Serialize a `Downcast` payload (the dispatcher in {@link serializeExpr}
 * emits the OP_DOWNCAST opcode byte). Writes the input Expr followed by
 * the target SType.
 */
export function serializeDowncast(d: Downcast, w: ByteWriter, treeVersion: number): void {
  serializeExpr(d.input, w, treeVersion)
  serializeSType(d.tpe, w)
}
