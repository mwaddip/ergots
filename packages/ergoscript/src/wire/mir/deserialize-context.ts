/**
 * DeserializeContext — parse + serialize.
 *
 * Wire format (sigma-rust `mir/deserialize_context.rs:36-48`):
 *
 *   [OP_DESERIALIZE_CONTEXT opcode = 0xd4]
 *   [tpe: SType]              -- result type of the deserialized script
 *   [id: u8]                  -- context-variable id
 *
 * `DeserializeContext` reads `Context.extension(id)` as a `Coll[Byte]`,
 * deserializes the bytes into an `Expr` and inlines it into the executing
 * script. The wire payload is the bare `tpe` (the wrapping `Coll[Byte]` is
 * not encoded) followed by the one-byte var id.
 *
 * Sigma-rust's `sigma_parse` reads `tpe` first then `id`, and sets the
 * reader's `set_deserialize(true)` flag (relevant only to its inline-
 * expansion pass — irrelevant to a pure wire round-trip).
 *
 * Note on field order: in this AST `tag` comes first, then `tpe`, then `id`
 * (sigma-rust struct literal is `{tpe, id}` in the same order). Wire order
 * matches: `tpe` then `id`.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/deserialize_context.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs (OpCode::DESERIALIZE_CONTEXT)
 */

import type { DeserializeContext } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprSerializeError } from '../errors'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

/**
 * Parse a `DeserializeContext` payload (the OP_DESERIALIZE_CONTEXT opcode byte
 * was consumed by the dispatcher). Reads the SType then the one-byte var id.
 *
 * Mirrors `DeserializeContext::sigma_parse`
 * (`mir/deserialize_context.rs:43-47`).
 */
export function parseDeserializeContext(r: ByteReader): DeserializeContext {
  const tpe = parseSType(r)
  const id = r.readU8()
  return { tag: 'DeserializeContext', tpe, id }
}

/**
 * Serialize a `DeserializeContext` payload (the dispatcher in
 * {@link serializeExpr} emits the OP_DESERIALIZE_CONTEXT opcode byte).
 * Writes the SType then the one-byte var id.
 *
 * Mirrors `DeserializeContext::sigma_serialize`
 * (`mir/deserialize_context.rs:37-41`).
 */
export function serializeDeserializeContext(
  e: DeserializeContext,
  w: ByteWriter
): void {
  if (!Number.isInteger(e.id) || e.id < 0 || e.id > 255) {
    throw new ExprSerializeError(
      `DeserializeContext.id ${e.id} out of u8 range [0, 255]`,
      'deserialize-context-id-out-of-range'
    )
  }
  serializeSType(e.tpe, w)
  w.writeU8(e.id)
}
