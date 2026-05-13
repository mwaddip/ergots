/**
 * Expr wire-format serializer — central tag-dispatch shell.
 *
 * Mirror of {@link parseExpr}: Task 9 lays down the structure, Tasks 10-26
 * fill in per-variant logic. Each case throws `ExprSerializeError` with
 * code `not-implemented-yet` until its handler is ported.
 *
 * The exhaustive switch over `e.tag` is wired so adding a new Expr variant
 * to the union (`mir/types.ts`) becomes a TypeScript compile-time error
 * here: the trailing `_exhaust: never` assignment will fail to compile.
 */

import type { Expr } from '../mir/types'
import { ByteWriter } from './writer'
import * as OP from '../mir/opcodes'
// Per-variant serializers live in `wire/mir/<variant>.ts`. The centralized
// error type lives in `./errors` (a leaf module) so variant serializers can
// import it without creating a circular import back into this dispatcher.
// Re-exported below for backward compatibility with consumers that imported
// it from `wire/serialize`.
import { ExprSerializeError } from './errors'
import { serializeConst } from './mir/const'
import { serializeConstantPlaceholder } from './mir/constant-placeholder'
import { serializeBlockValue } from './mir/block-value'
import { serializeValDef } from './mir/val-def'
import { serializeValUse } from './mir/val-use'
import { serializeIf } from './mir/if'
import { serializeFuncValue } from './mir/func-value'
import { serializeApply } from './mir/apply'
import { serializeBinOp } from './mir/bin-op'
import { serializeAnd } from './mir/and'
import { serializeOr } from './mir/or'
import { serializeXor } from './mir/xor'
import { serializeXorOf } from './mir/xor-of'
import { serializeAtleast } from './mir/atleast'
import { serializeBoolToSigmaProp } from './mir/bool-to-sigma-prop'
import { serializeLogicalNot } from './mir/logical-not'
import { serializeNegation } from './mir/negation'
import { serializeBitInversion } from './mir/bit-inversion'
import { serializeUpcast } from './mir/upcast'
import { serializeDowncast } from './mir/downcast'
import { serializeExtractAmount } from './mir/extract-amount'
import { serializeExtractBytes } from './mir/extract-bytes'
import { serializeExtractBytesWithNoRef } from './mir/extract-bytes-with-no-ref'
import { serializeExtractCreationInfo } from './mir/extract-creation-info'
import { serializeExtractId } from './mir/extract-id'
import { serializeExtractRegisterAs } from './mir/extract-register-as'
import { serializeExtractScriptBytes } from './mir/extract-script-bytes'
import { serializeSelectField } from './mir/select-field'
import { serializeGlobalVars } from './mir/global-vars'
import { serializeGetVar } from './mir/get-var'

export { ExprSerializeError } from './errors'

export function serializeExpr(e: Expr, w: ByteWriter): void {
  switch (e.tag) {
    case 'Append':
      throw new ExprSerializeError(
        'Append serialization not implemented yet (Task 19)',
        'not-implemented-yet'
      )
    case 'Const':
      // serializeConst emits the SType (whose first byte is the inline-
      // constant "opcode") followed by the SValue. No separate opcode prefix.
      serializeConst(e, w)
      return
    case 'ConstPlaceholder':
      w.writeU8(OP.OP_CONSTANT_PLACEHOLDER)
      serializeConstantPlaceholder(e, w)
      return
    case 'SubstConstants':
      throw new ExprSerializeError(
        'SubstConstants serialization not implemented yet (Task 17)',
        'not-implemented-yet'
      )
    case 'ByteArrayToLong':
      throw new ExprSerializeError(
        'ByteArrayToLong serialization not implemented yet (Task 17)',
        'not-implemented-yet'
      )
    case 'ByteArrayToBigInt':
      throw new ExprSerializeError(
        'ByteArrayToBigInt serialization not implemented yet (Task 17)',
        'not-implemented-yet'
      )
    case 'LongToByteArray':
      throw new ExprSerializeError(
        'LongToByteArray serialization not implemented yet (Task 17)',
        'not-implemented-yet'
      )
    case 'Collection':
      throw new ExprSerializeError(
        'Collection serialization not implemented yet (Task 18)',
        'not-implemented-yet'
      )
    case 'Tuple':
      throw new ExprSerializeError(
        'Tuple serialization not implemented yet (Task 18)',
        'not-implemented-yet'
      )
    case 'CalcBlake2b256':
      throw new ExprSerializeError(
        'CalcBlake2b256 serialization not implemented yet (Task 22)',
        'not-implemented-yet'
      )
    case 'CalcSha256':
      throw new ExprSerializeError(
        'CalcSha256 serialization not implemented yet (Task 22)',
        'not-implemented-yet'
      )
    case 'Context':
      // Context is a unit-variant Expr arm (sigma-rust `Expr::Context`); the
      // entire encoding is the single OP_CONTEXT opcode byte.
      w.writeU8(OP.OP_CONTEXT)
      return
    case 'Global':
      // Global is a unit-variant Expr arm (sigma-rust `Expr::Global`); the
      // entire encoding is the single OP_GLOBAL opcode byte.
      w.writeU8(OP.OP_GLOBAL)
      return
    case 'GlobalVars':
      // GlobalVars emits its own opcode (derived from the `kind`
      // discriminator) — there is no single fixed `OP_*` constant for the
      // `'GlobalVars'` tag. The six kinds each map to a unique opcode byte;
      // see `wire/mir/global-vars.ts::globalVarsOpcode`.
      serializeGlobalVars(e, w)
      return
    case 'FuncValue':
      w.writeU8(OP.OP_FUNC_VALUE)
      serializeFuncValue(e, w)
      return
    case 'Apply':
      w.writeU8(OP.OP_APPLY)
      serializeApply(e, w)
      return
    case 'MethodCall':
      throw new ExprSerializeError(
        'MethodCall serialization not implemented yet (Task 16)',
        'not-implemented-yet'
      )
    case 'PropertyCall':
      throw new ExprSerializeError(
        'PropertyCall serialization not implemented yet (Task 16)',
        'not-implemented-yet'
      )
    case 'BlockValue':
      w.writeU8(OP.OP_BLOCK_VALUE)
      serializeBlockValue(e, w)
      return
    case 'ValDef':
      w.writeU8(OP.OP_VAL_DEF)
      serializeValDef(e, w)
      return
    case 'ValUse':
      w.writeU8(OP.OP_VAL_USE)
      serializeValUse(e, w)
      return
    case 'If':
      w.writeU8(OP.OP_IF)
      serializeIf(e, w)
      return
    case 'BinOp':
      // Unlike most variants, BinOp emits its own opcode (derived from the
      // BinOpKind discriminator) — there is no single fixed `OP_*` constant
      // for the `'BinOp'` tag. The serializer also handles the bool-pair
      // packing optimization for `(Const SBoolean, Const SBoolean)` operands.
      serializeBinOp(e, w)
      return
    case 'And':
      w.writeU8(OP.OP_AND)
      serializeAnd(e, w)
      return
    case 'Or':
      w.writeU8(OP.OP_OR)
      serializeOr(e, w)
      return
    case 'Xor':
      w.writeU8(OP.OP_XOR)
      serializeXor(e, w)
      return
    case 'Atleast':
      w.writeU8(OP.OP_ATLEAST)
      serializeAtleast(e, w)
      return
    case 'LogicalNot':
      w.writeU8(OP.OP_LOGICAL_NOT)
      serializeLogicalNot(e, w)
      return
    case 'Negation':
      w.writeU8(OP.OP_NEGATION)
      serializeNegation(e, w)
      return
    case 'BitInversion':
      w.writeU8(OP.OP_BIT_INVERSION)
      serializeBitInversion(e, w)
      return
    case 'OptionGet':
      throw new ExprSerializeError(
        'OptionGet serialization not implemented yet (Task 21)',
        'not-implemented-yet'
      )
    case 'OptionIsDefined':
      throw new ExprSerializeError(
        'OptionIsDefined serialization not implemented yet (Task 21)',
        'not-implemented-yet'
      )
    case 'OptionGetOrElse':
      throw new ExprSerializeError(
        'OptionGetOrElse serialization not implemented yet (Task 21)',
        'not-implemented-yet'
      )
    case 'ExtractAmount':
      w.writeU8(OP.OP_EXTRACT_AMOUNT)
      serializeExtractAmount(e, w)
      return
    case 'ExtractRegisterAs':
      w.writeU8(OP.OP_EXTRACT_REGISTER_AS)
      serializeExtractRegisterAs(e, w)
      return
    case 'ExtractBytes':
      w.writeU8(OP.OP_EXTRACT_BYTES)
      serializeExtractBytes(e, w)
      return
    case 'ExtractBytesWithNoRef':
      w.writeU8(OP.OP_EXTRACT_BYTES_WITH_NO_REF)
      serializeExtractBytesWithNoRef(e, w)
      return
    case 'ExtractScriptBytes':
      w.writeU8(OP.OP_EXTRACT_SCRIPT_BYTES)
      serializeExtractScriptBytes(e, w)
      return
    case 'ExtractCreationInfo':
      w.writeU8(OP.OP_EXTRACT_CREATION_INFO)
      serializeExtractCreationInfo(e, w)
      return
    case 'ExtractId':
      w.writeU8(OP.OP_EXTRACT_ID)
      serializeExtractId(e, w)
      return
    case 'ByIndex':
      throw new ExprSerializeError(
        'ByIndex serialization not implemented yet (Task 19)',
        'not-implemented-yet'
      )
    case 'SizeOf':
      throw new ExprSerializeError(
        'SizeOf serialization not implemented yet (Task 19)',
        'not-implemented-yet'
      )
    case 'Slice':
      throw new ExprSerializeError(
        'Slice serialization not implemented yet (Task 19)',
        'not-implemented-yet'
      )
    case 'Fold':
      throw new ExprSerializeError(
        'Fold serialization not implemented yet (Task 20)',
        'not-implemented-yet'
      )
    case 'Map':
      throw new ExprSerializeError(
        'Map serialization not implemented yet (Task 20)',
        'not-implemented-yet'
      )
    case 'Filter':
      throw new ExprSerializeError(
        'Filter serialization not implemented yet (Task 20)',
        'not-implemented-yet'
      )
    case 'Exists':
      throw new ExprSerializeError(
        'Exists serialization not implemented yet (Task 20)',
        'not-implemented-yet'
      )
    case 'ForAll':
      throw new ExprSerializeError(
        'ForAll serialization not implemented yet (Task 20)',
        'not-implemented-yet'
      )
    case 'SelectField':
      w.writeU8(OP.OP_SELECT_FIELD)
      serializeSelectField(e, w)
      return
    case 'BoolToSigmaProp':
      w.writeU8(OP.OP_BOOL_TO_SIGMA_PROP)
      serializeBoolToSigmaProp(e, w)
      return
    case 'Upcast':
      w.writeU8(OP.OP_UPCAST)
      serializeUpcast(e, w)
      return
    case 'Downcast':
      w.writeU8(OP.OP_DOWNCAST)
      serializeDowncast(e, w)
      return
    case 'CreateProveDlog':
      throw new ExprSerializeError(
        'CreateProveDlog serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'CreateProveDhTuple':
      throw new ExprSerializeError(
        'CreateProveDhTuple serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'SigmaPropBytes':
      throw new ExprSerializeError(
        'SigmaPropBytes serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'SigmaPropIsProven':
      throw new ExprSerializeError(
        'SigmaPropIsProven serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'ZkProofBlock':
      // ZkProofBlock has no canonical opcode (Scala's `OpCodes.Undefined`);
      // sigma-rust's serializer rejects it. We mirror that error path.
      throw new ExprSerializeError(
        'ZkProofBlock has no canonical opcode and cannot be serialized (matches sigma-rust NotSupported)',
        'not-supported'
      )
    case 'DecodePoint':
      throw new ExprSerializeError(
        'DecodePoint serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'SigmaAnd':
      throw new ExprSerializeError(
        'SigmaAnd serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
    case 'SigmaOr':
      throw new ExprSerializeError(
        'SigmaOr serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
    case 'GetVar':
      w.writeU8(OP.OP_GET_VAR)
      serializeGetVar(e, w)
      return
    case 'DeserializeRegister':
      throw new ExprSerializeError(
        'DeserializeRegister serialization not implemented yet (Task 26)',
        'not-implemented-yet'
      )
    case 'DeserializeContext':
      throw new ExprSerializeError(
        'DeserializeContext serialization not implemented yet (Task 26)',
        'not-implemented-yet'
      )
    case 'MultiplyGroup':
      throw new ExprSerializeError(
        'MultiplyGroup serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'Exponentiate':
      throw new ExprSerializeError(
        'Exponentiate serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'XorOf':
      w.writeU8(OP.OP_XOR_OF)
      serializeXorOf(e, w)
      return
    case 'TreeLookup':
      throw new ExprSerializeError(
        'TreeLookup serialization not implemented yet (Task 25)',
        'not-implemented-yet'
      )
    case 'CreateAvlTree':
      throw new ExprSerializeError(
        'CreateAvlTree serialization not implemented yet (Task 25)',
        'not-implemented-yet'
      )
    default: {
      // Every case throws above; TypeScript will narrow `e` to `never` here.
      // Adding a new Expr variant in mir/types.ts without a corresponding
      // case will surface as a compile-time error on this assignment.
      const _exhaust: never = e
      throw new ExprSerializeError(
        `Unknown Expr.tag: ${(_exhaust as { tag: string }).tag}`,
        'unknown-variant'
      )
    }
  }
}
