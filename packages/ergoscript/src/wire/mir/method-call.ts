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
import { ExprParseError, ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'
import { explicitTypeArgNames } from './explicit-type-args'

// Defensive cap on the args array length, mirroring `apply.ts`. Methods
// take a handful of args at most in practice; a count beyond this is
// almost certainly a malformed encoding.
const MAX_METHOD_ARGS = 1 << 16

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
  valDefTypes: Map<number, SType>
): MethodCall {
  const typeId = r.readU8()
  const methodId = r.readU8()
  const obj = parseExpr(r, constantTypes, constantValues, valDefTypes)
  const argsCount = r.readVlqU()
  if (argsCount > MAX_METHOD_ARGS) {
    throw new ExprParseError(
      `MethodCall args count ${argsCount} exceeds ${MAX_METHOD_ARGS}`,
      'method-call-too-many-args'
    )
  }
  const args: Expr[] = []
  for (let i = 0; i < argsCount; i++) {
    args.push(parseExpr(r, constantTypes, constantValues, valDefTypes))
  }
  const explicitTypeArgs: Record<string, SType> = {}
  for (const name of explicitTypeArgNames(typeId, methodId)) {
    explicitTypeArgs[name] = parseSType(r)
  }
  return { tag: 'MethodCall', obj, typeId, methodId, args, explicitTypeArgs }
}

/**
 * Serialize a `MethodCall` payload (the dispatcher in `serializeExpr` emits
 * the OP_METHOD_CALL opcode byte).
 *
 * Mirrors sigma-rust's `<MethodCall as SigmaSerializable>::sigma_serialize`
 * (`serialization/method_call.rs:20-31`). Order matches the parser exactly.
 *
 * For the explicit-type-args tail: we iterate the names returned by the
 * registry (the wire order), looking up each name in `e.explicitTypeArgs`.
 * If a name is missing we throw — sigma-rust's writer would have panicked
 * on `self.explicit_type_args[type_arg]` against a missing key.
 */
export function serializeMethodCall(e: MethodCall, w: ByteWriter): void {
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
  w.writeU8(e.typeId)
  w.writeU8(e.methodId)
  serializeExpr(e.obj, w)
  w.writeVlqU(e.args.length)
  for (const arg of e.args) {
    serializeExpr(arg, w)
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
