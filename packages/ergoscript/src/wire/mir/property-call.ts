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
 *   [explicit_type_args: SType*]   -- ZERO OR MORE inline SType encodings,
 *                                     one per `STypeVar` the resolved SMethod
 *                                     declares (count implicit — NO length
 *                                     prefix). Identical tail to MethodCall.
 *
 * PropertyCall is the zero-arg counterpart of {@link MethodCall}: no args.
 * Unlike a plain method call it CAN still carry explicit type args — the JVM
 * `PropertyCallSerializer` writes `method.explicitTypeArgs` after `obj` exactly
 * as `MethodCallSerializer` does (the only difference between the two is the
 * args vector, which PropertyCall omits). `SGlobal.none[T]` (106:10) is the
 * first such method: 0 args, yet a `T` (e.g. `SByte`) follows `obj` on the
 * wire. The (typeId, methodId) → type-var-name lookup is the shared
 * `explicitTypeArgNames` registry (`./explicit-type-args`), the same one the
 * MethodCall path uses. Pairs with no registered names parse/serialize with
 * `explicitTypeArgs: {}` and consume/emit no extra bytes (backward-compatible).
 *
 * We still do NOT resolve the SMethod at the wire layer (no full method
 * registry yet — see `method-call.ts`): we accept any well-formed
 * (typeId, methodId) pair, read the type-arg count implied by the registry,
 * and pass everything through verbatim, leaving semantic method resolution to
 * a later interpreter pass.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/property_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/property_call.rs
 *   ~/projects/sigmastate-interpreter/data/shared/src/main/scala/sigma/serialization/PropertyCallSerializer.scala (JVM oracle for the type-arg tail)
 *   ./explicit-type-args.ts — the shared (typeId, methodId) → type-var registry
 */

import type { PropertyCall, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
import { explicitTypeArgNames } from './explicit-type-args'

/**
 * Parse a `PropertyCall` payload (the OP_PROPERTY_CALL opcode byte was
 * consumed by the dispatcher).
 *
 * Mirrors sigma-rust's `<PropertyCall as SigmaSerializable>::sigma_parse`
 * (`serialization/property_call.rs:23-30`) and the JVM `PropertyCallSerializer.parse`
 * (`:30-49`). Order: typeId, methodId, obj, then one SType per type-var name
 * the registry declares for `(typeId, methodId)` (zero for most pairs).
 */
export function parsePropertyCall(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): PropertyCall {
  const typeId = r.readU8()
  const methodId = r.readU8()
  const obj = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  const explicitTypeArgs: Record<string, SType> = {}
  for (const name of explicitTypeArgNames(typeId, methodId)) {
    explicitTypeArgs[name] = parseSType(r)
  }
  return { tag: 'PropertyCall', obj, typeId, methodId, explicitTypeArgs }
}

/**
 * Serialize a `PropertyCall` payload (the dispatcher in `serializeExpr`
 * emits the OP_PROPERTY_CALL opcode byte).
 *
 * Mirrors sigma-rust's `<PropertyCall as SigmaSerializable>::sigma_serialize`
 * (`serialization/property_call.rs:16-21`) and the JVM `PropertyCallSerializer.serialize`
 * (`:20-28`). After typeId, methodId, obj, emit one SType per type-var name
 * the registry declares for `(typeId, methodId)` — the same tail as MethodCall.
 * A name present in the registry but absent from `e.explicitTypeArgs` is a
 * malformed node (the parser always populates every registered name); we throw
 * rather than emit a short, un-round-trippable encoding.
 */
export function serializePropertyCall(e: PropertyCall, w: ByteWriter, treeVersion: number): void {
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
  serializeExpr(e.obj, w, treeVersion)
  for (const name of explicitTypeArgNames(e.typeId, e.methodId)) {
    const tpe = e.explicitTypeArgs[name]
    if (tpe === undefined) {
      throw new ExprSerializeError(
        `PropertyCall.explicitTypeArgs missing entry for STypeVar "${name}" (typeId=${e.typeId}, methodId=${e.methodId})`,
        'property-call-missing-type-arg'
      )
    }
    serializeSType(tpe, w)
  }
}
