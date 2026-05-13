/**
 * PropertyCall — parse + serialize.
 *
 * Wire format (sigma-rust `serialization/property_call.rs`):
 *
 *   [OP_PROPERTY_CALL opcode = 0xdb]
 *   [typeId: u8]                   -- raw TypeCode byte for the receiver type
 *                                     companion (e.g. 99 = SBox, 101 = SContext,
 *                                     106 = SGlobal).
 *   [methodId: u8]                 -- raw MethodId byte within that type.
 *   [obj: Expr]                    -- the receiver expression.
 *
 * PropertyCall is the zero-arg counterpart of {@link MethodCall}: no args,
 * no explicit_type_args. Encoded fields are typeId, methodId, obj — in
 * that order. Sigma-rust resolves the SMethod via
 * `SMethod::from_ids(type_id, method_id)?.specialize_for(obj.tpe(), Vec::new())?`
 * which we DO NOT mirror at the wire layer (no method registry yet —
 * see `method-call.ts` for the rationale). We accept any well-formed
 * (typeId, methodId) pair and pass it through verbatim, leaving method
 * resolution to a later interpreter pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/property_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/property_call.rs
 */

import type { PropertyCall, SType, SValue } from '../../mir/types'
import { ByteReader } from '../reader'
import { ByteWriter } from '../writer'
import { ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'

/**
 * Parse a `PropertyCall` payload (the OP_PROPERTY_CALL opcode byte was
 * consumed by the dispatcher).
 *
 * Mirrors sigma-rust's `<PropertyCall as SigmaSerializable>::sigma_parse`
 * (`serialization/property_call.rs:23-30`).
 */
export function parsePropertyCall(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): PropertyCall {
  const typeId = r.readU8()
  const methodId = r.readU8()
  const obj = parseExpr(r, constantTypes, constantValues, valDefTypes)
  return { tag: 'PropertyCall', obj, typeId, methodId }
}

/**
 * Serialize a `PropertyCall` payload (the dispatcher in `serializeExpr`
 * emits the OP_PROPERTY_CALL opcode byte).
 *
 * Mirrors sigma-rust's `<PropertyCall as SigmaSerializable>::sigma_serialize`
 * (`serialization/property_call.rs:16-21`).
 */
export function serializePropertyCall(e: PropertyCall, w: ByteWriter): void {
  if (!Number.isInteger(e.typeId) || e.typeId < 0 || e.typeId > 0xff) {
    throw new ExprSerializeError(
      `PropertyCall.typeId ${e.typeId} out of u8 range`,
      'property-call-id-out-of-range'
    )
  }
  if (!Number.isInteger(e.methodId) || e.methodId < 0 || e.methodId > 0xff) {
    throw new ExprSerializeError(
      `PropertyCall.methodId ${e.methodId} out of u8 range`,
      'property-call-id-out-of-range'
    )
  }
  w.writeU8(e.typeId)
  w.writeU8(e.methodId)
  serializeExpr(e.obj, w)
}
