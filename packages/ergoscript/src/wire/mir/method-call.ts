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
 * SType per entry in `method.method_raw.explicit_type_args`. We mirror
 * this with a small registry of (typeId, methodId) → STypeVar-name list
 * derived directly from sigma-rust's type companion definitions; the
 * registry only needs the type-var NAMES because the count and ordering
 * follow from sigma-rust's `Vec<STypeVar>` and the names become the keys
 * of our `Record<string, SType>`.
 *
 * Methods currently known to declare explicit_type_args (all `vec![STypeVar::t()]`,
 * so always exactly one "T"):
 *   - SBox (typeId=99):    getReg            (methodId=7)
 *   - SContext (typeId=101): getVarFromInput (methodId=12)
 *   - SGlobal (typeId=106): deserialize      (methodId=4)
 *   - SGlobal (typeId=106): fromBigEndianBytes (methodId=5)
 *   - SGlobal (typeId=106): none             (methodId=10)
 *
 * For any (typeId, methodId) not in the registry we assume zero explicit
 * type args. This mirrors the sigma-rust behavior for well-typed corpora
 * (only listed methods ever produce non-empty type args) while being
 * conservative for unknown methods — full SMethod resolution (with
 * rejection of unknown methodIds) is deferred to a later pass that owns
 * the method dispatch table; at the wire layer we only need enough info
 * to know how many SType bytes follow the args vector.
 *
 * The registry intentionally lives in this file (rather than a shared
 * `mir/` registry module) because it is purely a wire-layer concern: it
 * exists to disambiguate how many bytes to consume, not to model
 * ErgoScript semantics. When the SMethod registry lands in a future task
 * (likely with the interpreter), this table moves there.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/method_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/method_call.rs
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sbox.rs (GET_REG_METHOD_DESC)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scontext.rs (GET_VAR_FROM_INPUT_METHOD_DESC)
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sglobal.rs (DESERIALIZE_METHOD_DESC, FROM_BIGENDIAN_BYTES_METHOD_DESC, NONE_METHOD_DESC)
 */

import type { Expr, MethodCall, SType, SValue } from '../../mir/types'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { ExprParseError, ExprSerializeError } from '../errors'
import { parseExpr } from '../parse'
import { serializeExpr } from '../serialize'
import { parseSType } from '../parse-stype'
import { serializeSType } from '../serialize-stype'

// Defensive cap on the args array length, mirroring `apply.ts`. Methods
// take a handful of args at most in practice; a count beyond this is
// almost certainly a malformed encoding.
const MAX_METHOD_ARGS = 1 << 16

// TypeCode constants for type companions that declare methods. Mirrors the
// `TypeCode` values in sigma-rust `serialization/types.rs`.
const TYPE_CODE_SBOX = 99
const TYPE_CODE_SCONTEXT = 101
const TYPE_CODE_SGLOBAL = 106

// (typeId, methodId) → ordered list of STypeVar names declaring this method's
// explicit_type_args. Empty list (or absence) = no inline STypes follow the
// args vector. See module header for the full provenance of each entry.
const EXPLICIT_TYPE_ARG_NAMES: Record<number, Record<number, readonly string[]>> = {
  [TYPE_CODE_SBOX]: {
    7: ['T'], // getReg[T]
  },
  [TYPE_CODE_SCONTEXT]: {
    12: ['T'], // getVarFromInput[T]
  },
  [TYPE_CODE_SGLOBAL]: {
    4: ['T'],  // deserialize[T]
    5: ['T'],  // fromBigEndianBytes[T]
    10: ['T'], // none[T]
  },
}

/**
 * Returns the ordered list of STypeVar names whose SType bytes follow the
 * args vector on the wire for `(typeId, methodId)`. Empty for any pair
 * not in the registry (the conservative default — see module header).
 */
function explicitTypeArgNames(typeId: number, methodId: number): readonly string[] {
  return EXPLICIT_TYPE_ARG_NAMES[typeId]?.[methodId] ?? []
}

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
