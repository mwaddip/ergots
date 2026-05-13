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
// Per-variant serializers live in `wire/mir/<variant>.ts`. The dispatch
// below delegates to them; the centralized error type stays here so all
// variant serializers throw a uniform `ExprSerializeError`.
import { serializeConst } from './mir/const'
import { serializeConstantPlaceholder } from './mir/constant-placeholder'

export class ExprSerializeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'ExprSerializeError'
  }
}

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
      throw new ExprSerializeError(
        'Context serialization not implemented yet (Task 16)',
        'not-implemented-yet'
      )
    case 'Global':
      throw new ExprSerializeError(
        'Global serialization not implemented yet (Task 16)',
        'not-implemented-yet'
      )
    case 'GlobalVars':
      throw new ExprSerializeError(
        'GlobalVars serialization not implemented yet (Task 16)',
        'not-implemented-yet'
      )
    case 'FuncValue':
      throw new ExprSerializeError(
        'FuncValue serialization not implemented yet (Task 15)',
        'not-implemented-yet'
      )
    case 'Apply':
      throw new ExprSerializeError(
        'Apply serialization not implemented yet (Task 15)',
        'not-implemented-yet'
      )
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
      throw new ExprSerializeError(
        'BlockValue serialization not implemented yet (Task 11)',
        'not-implemented-yet'
      )
    case 'ValDef':
      throw new ExprSerializeError(
        'ValDef serialization not implemented yet (Task 11)',
        'not-implemented-yet'
      )
    case 'ValUse':
      throw new ExprSerializeError(
        'ValUse serialization not implemented yet (Task 11)',
        'not-implemented-yet'
      )
    case 'If':
      throw new ExprSerializeError(
        'If serialization not implemented yet (Task 12)',
        'not-implemented-yet'
      )
    case 'BinOp':
      throw new ExprSerializeError(
        'BinOp serialization not implemented yet (Task 13)',
        'not-implemented-yet'
      )
    case 'And':
      throw new ExprSerializeError(
        'And serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
    case 'Or':
      throw new ExprSerializeError(
        'Or serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
    case 'Xor':
      throw new ExprSerializeError(
        'Xor serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
    case 'Atleast':
      throw new ExprSerializeError(
        'Atleast serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
    case 'LogicalNot':
      throw new ExprSerializeError(
        'LogicalNot serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
    case 'Negation':
      throw new ExprSerializeError(
        'Negation serialization not implemented yet (Task 13)',
        'not-implemented-yet'
      )
    case 'BitInversion':
      throw new ExprSerializeError(
        'BitInversion serialization not implemented yet (Task 13)',
        'not-implemented-yet'
      )
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
      throw new ExprSerializeError(
        'ExtractAmount serialization not implemented yet (Task 24)',
        'not-implemented-yet'
      )
    case 'ExtractRegisterAs':
      throw new ExprSerializeError(
        'ExtractRegisterAs serialization not implemented yet (Task 24)',
        'not-implemented-yet'
      )
    case 'ExtractBytes':
      throw new ExprSerializeError(
        'ExtractBytes serialization not implemented yet (Task 24)',
        'not-implemented-yet'
      )
    case 'ExtractBytesWithNoRef':
      throw new ExprSerializeError(
        'ExtractBytesWithNoRef serialization not implemented yet (Task 24)',
        'not-implemented-yet'
      )
    case 'ExtractScriptBytes':
      throw new ExprSerializeError(
        'ExtractScriptBytes serialization not implemented yet (Task 24)',
        'not-implemented-yet'
      )
    case 'ExtractCreationInfo':
      throw new ExprSerializeError(
        'ExtractCreationInfo serialization not implemented yet (Task 24)',
        'not-implemented-yet'
      )
    case 'ExtractId':
      throw new ExprSerializeError(
        'ExtractId serialization not implemented yet (Task 24)',
        'not-implemented-yet'
      )
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
      throw new ExprSerializeError(
        'SelectField serialization not implemented yet (Task 18)',
        'not-implemented-yet'
      )
    case 'BoolToSigmaProp':
      throw new ExprSerializeError(
        'BoolToSigmaProp serialization not implemented yet (Task 23)',
        'not-implemented-yet'
      )
    case 'Upcast':
      throw new ExprSerializeError(
        'Upcast serialization not implemented yet (Task 21)',
        'not-implemented-yet'
      )
    case 'Downcast':
      throw new ExprSerializeError(
        'Downcast serialization not implemented yet (Task 21)',
        'not-implemented-yet'
      )
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
      throw new ExprSerializeError(
        'GetVar serialization not implemented yet (Task 26)',
        'not-implemented-yet'
      )
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
      throw new ExprSerializeError(
        'XorOf serialization not implemented yet (Task 14)',
        'not-implemented-yet'
      )
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
