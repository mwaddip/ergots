/**
 * GetVar — parse + serialize.
 *
 * Wire format (sigma-rust `mir/get_var.rs`):
 *
 *   [OP_GET_VAR opcode = 0xe3]
 *   [var_id: u8]               -- context-variable id (raw byte, 0..255)
 *   [var_tpe: SType]           -- the expected variable type
 *
 * `GetVar` reads `Context.extension(var_id)` and yields `Option[var_tpe]`.
 * The wire encodes the bare `var_tpe` (the wrapping `SOption` is computed
 * by the post-eval `tpe()` accessor in sigma-rust — see
 * `mir/get_var.rs:25-27`; on parse our AST mirrors the wire and stores
 * `varTpe` unwrapped).
 *
 * Sigma-rust `sigma_parse` (`mir/get_var.rs:40-44`) reads:
 *   1. `var_id: u8` via `get_u8`
 *   2. `var_tpe: SType` via `SType::sigma_parse`
 * and the matching `sigma_serialize` (`mir/get_var.rs:35-38`) writes:
 *   1. `put_u8(var_id)`
 *   2. `var_tpe.sigma_serialize(w)`
 *
 * No semantic validation at the wire layer — sigma-rust also performs
 * none for `GetVar` (its `try_build` is the identity constructor; the
 * context-extension lookup itself is an eval-time concern).
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/get_var.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/expr.rs:196
 */

import type { GetVar } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprSerializeError } from '../errors'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

/**
 * Parse a `GetVar` payload (the OP_GET_VAR opcode byte was consumed by
 * the dispatcher). Reads the one-byte var id, then the SType.
 *
 * Mirrors `GetVar::sigma_parse` (`mir/get_var.rs:40-44`).
 */
export function parseGetVar(r: ByteReader): GetVar {
  const varId = r.readU8()
  const varTpe = parseSType(r)
  return { tag: 'GetVar', varId, varTpe }
}

/**
 * Serialize a `GetVar` payload (the dispatcher writes the OP_GET_VAR
 * opcode byte). Writes the one-byte var id, then the SType.
 *
 * Mirrors `GetVar::sigma_serialize` (`mir/get_var.rs:35-38`).
 */
export function serializeGetVar(e: GetVar, w: ByteWriter): void {
  if (!Number.isInteger(e.varId) || e.varId < 0 || e.varId > 255) {
    throw new ExprSerializeError(
      `GetVar.varId ${e.varId} out of u8 range [0, 255]`,
      'get-var-id-out-of-range'
    )
  }
  w.writeU8(e.varId)
  serializeSType(e.varTpe, w)
}
