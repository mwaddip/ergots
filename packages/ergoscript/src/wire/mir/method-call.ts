/**
 * MethodCall — parse + serialize.
 *
 * Wire format (sigma-rust `serialization/method_call.rs`):
 *
 *   [OP_METHOD_CALL opcode = 0xdc]
 *   [typeId: u8]                   -- raw TypeCode byte for the receiver
 *                                     type companion (e.g. 99 = SBox,
 *                                     101 = SContext, 106 = SGlobal).
 *   [methodId: u8]                 -- raw MethodId byte within that type.
 *   [obj: Expr]                    -- the receiver expression.
 *   [args: Vec<Expr>] =            -- standard Vec<T> = VLQ count + items.
 *     [VLQ-u32 args_count]
 *     [arg_i: Expr]*
 *   [explicit_type_args: SType*]   -- ZERO OR MORE inline SType encodings,
 *                                     one per `STypeVar` declared by the
 *                                     SMethod's `explicit_type_args` list
 *                                     (sigma-rust `types/smethod.rs`). The
 *                                     count is implicit in the resolved
 *                                     SMethod — there is NO length prefix
 *                                     on the wire.
 *
 * A MethodCall without arguments parses from this opcode but is written as a
 * PropertyCall (0xdb), as the JVM's companion writes it (see `serializeMethodCall`).
 *
 * Source: sigma-rust `serialization/method_call.rs`. Sigma-rust resolves
 * the SMethod via `SMethod::from_ids(type_id, method_id)?` then reads one
 * SType per entry in `method.method_raw.explicit_type_args`. We mirror this
 * with the shared `explicitTypeArgNames` registry in `./explicit-type-args`
 * (a (typeId, methodId) → STypeVar-name list, also consumed by the
 * PropertyCall path); the registry only needs the type-var NAMES because the
 * count and ordering follow from sigma-rust's `Vec<STypeVar>` and the names
 * become the keys of our `Record<string, SType>`. For any (typeId, methodId)
 * not in the registry we assume zero explicit type args.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/method_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/method_call.rs
 *   ./explicit-type-args.ts — the shared (typeId, methodId) → type-var registry
 */

import type { Expr, MethodCall, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { OP_METHOD_CALL, OP_PROPERTY_CALL } from '../../mir/opcodes'
import { ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
import { explicitTypeArgNames } from './explicit-type-args'
import { readArrayCount } from './_jvm-counts'

/**
 * Parse a `MethodCall` payload (the OP_METHOD_CALL opcode byte was consumed
 * by the dispatcher).
 *
 * Mirrors sigma-rust's `<MethodCall as SigmaSerializable>::sigma_parse`
 * (`serialization/method_call.rs:33-60`). Order:
 *   1. typeId    (1 byte)
 *   2. methodId  (1 byte)
 *   3. obj       (Expr)
 *   4. args      (Vec<Expr>: VLQ count + items)
 *   5. explicit type args (zero or more STypes, count from the registry)
 */
export function parseMethodCall(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): MethodCall {
  const typeId = r.readU8()
  const methodId = r.readU8()
  const obj = parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion)
  // JVM MethodCallSerializer.scala:51 → getValues (SigmaByteReader.scala:53-61): getUIntExact, safeNewArray.
  const argsCount = readArrayCount(r, 'MethodCall args count', 'method-call-too-many-args')
  const args: Expr[] = []
  for (let i = 0; i < argsCount; i++) {
    args.push(parseExpr(r, constantTypes, constantValues, valDefTypes, treeVersion))
  }
  const explicitTypeArgs: Record<string, SType> = {}
  for (const name of explicitTypeArgNames(typeId, methodId)) {
    explicitTypeArgs[name] = parseSType(r)
  }
  return { tag: 'MethodCall', obj, typeId, methodId, args, explicitTypeArgs }
}

/**
 * Serialize a `MethodCall`, opcode included, as the JVM writes it: the node's companion picks the
 * serializer (`MethodCall.companion = if (args.isEmpty) PropertyCall else MethodCall`,
 * sigma/ast/values.scala:1351). A call without arguments is written as a PropertyCall, OP_PROPERTY_CALL
 * with no argument count (PropertyCallSerializer.scala:20-28), whichever opcode it was read with; a
 * call with arguments is OP_METHOD_CALL (MethodCallSerializer.scala:23-33). sigma-rust writes every
 * MethodCall as OP_METHOD_CALL: ergots follows the JVM here.
 *
 * Order matches the parser: typeId, methodId, obj, the arguments (a MethodCall only), then the
 * explicit-type-args tail, one type per name the registry declares, which both serializers write
 * the same way. A registry name missing from `e.explicitTypeArgs` throws: the JVM's `typeSubst(a)`
 * would fail there too (a parsed node always carries every registered name).
 */
export function serializeMethodCall(e: MethodCall, w: ByteWriter, treeVersion: number): void {
  if (!Number.isInteger(e.typeId) || e.typeId < 0 || e.typeId > 0xff) {
    throw new ExprSerializeError(
      `MethodCall.typeId ${e.typeId} out of u8 range`,
      'method-call-id-out-of-range'
    )
  }
  if (!Number.isInteger(e.methodId) || e.methodId < 0 || e.methodId > 0xff) {
    throw new ExprSerializeError(
      `MethodCall.methodId ${e.methodId} out of u8 range`,
      'method-call-id-out-of-range'
    )
  }
  const isProperty = e.args.length === 0
  w.writeU8(isProperty ? OP_PROPERTY_CALL : OP_METHOD_CALL)
  w.writeU8(e.typeId)
  w.writeU8(e.methodId)
  serializeExpr(e.obj, w, treeVersion)
  if (!isProperty) {
    w.writeVlqU(e.args.length)
    for (const arg of e.args) {
      serializeExpr(arg, w, treeVersion)
    }
  }
  for (const name of explicitTypeArgNames(e.typeId, e.methodId)) {
    const tpe = e.explicitTypeArgs[name]
    if (tpe === undefined) {
      throw new ExprSerializeError(
        `MethodCall.explicitTypeArgs missing entry for STypeVar "${name}" (typeId=${e.typeId}, methodId=${e.methodId})`,
        'method-call-missing-type-arg'
      )
    }
    serializeSType(tpe, w)
  }
}
