/**
 * Central evaluator dispatch — exhaustive switch on `Expr.tag`. Adding a
 * new Expr variant to `mir/types.ts` becomes a compile-time error here
 * via the `_exhaust: never` discriminant until an arm exists.
 *
 * Phase 2b ships 8 arms (Const, ConstPlaceholder, BlockValue, ValDef,
 * ValUse, Tuple, Collection, If). Phase 2c adds BinOp (central
 * dispatcher + 4 family sub-arms), LogicalNot, BoolToSigmaProp. Every
 * other variant currently throws `EvalError 'not-implemented-yet'` —
 * Phase 2c+ replaces each with an explicit case calling its arm. The
 * chassis itself is correct from this commit forward.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs
 */

import type { Expr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalAnd } from './and'
import { evalAtleast } from './atleast'
import { evalApply } from './apply'
import { evalBinOp } from './bin-op'
import { evalBitInversion } from './bit-inversion'
import { evalBlockValue } from './block-value'
import { evalBoolToSigmaProp } from './bool-to-sigma-prop'
import { evalByteArrayToLong } from './byte-array-to-long'
import { evalCalcBlake2b256 } from './calc-blake2b256'
import { evalCalcSha256 } from './calc-sha256'
import { evalAppend } from './coll-append'
import { evalByIndex } from './coll-by-index'
import { evalExists } from './coll-exists'
import { evalFilter } from './coll-filter'
import { evalForAll } from './coll-forall'
import { evalFold } from './coll-fold'
import { evalMap } from './coll-map'
import { evalSlice } from './coll-slice'
import { evalSizeOf } from './coll-size'
import { evalCollection } from './collection'
import { evalConst } from './const'
import { evalConstPlaceholder } from './const-placeholder'
import { evalContext } from './context'
import { evalDowncast } from './downcast'
import { evalExtractAmount } from './extract-amount'
import { evalExtractBytes } from './extract-bytes'
import { evalExtractBytesWithNoRef } from './extract-bytes-with-no-ref'
import { evalExtractCreationInfo } from './extract-creation-info'
import { evalExtractId } from './extract-id'
import { evalGetVar } from './get-var'
import { evalGlobal } from './global'
import { evalGlobalVars } from './global-vars'
import { evalOptionGet } from './option-get'
import { evalOptionGetOrElse } from './option-get-or-else'
import { evalOptionIsDefined } from './option-is-defined'
import { evalExtractRegisterAs } from './extract-register-as'
import { evalExtractScriptBytes } from './extract-script-bytes'
import { evalFuncValue } from './func-value'
import { evalIf } from './if'
import { evalLogicalNot } from './logical-not'
import { evalMethodCall, evalPropertyCall } from './method-call'
import { evalNegation } from './negation'
import { evalOr } from './or'
import { evalSelectField } from './select-field'
import { evalSigmaAnd } from './sigma-and'
import { evalSigmaOr } from './sigma-or'
import { evalSigmaPropBytes } from './sigma-prop-bytes'
import { evalTuple } from './tuple'
import { evalUpcast } from './upcast'
import { evalValDef } from './val-def'
import { evalValUse } from './val-use'
import { evalCreateProveDhTuple } from './create-prove-dh-tuple'
import { evalCreateProveDlog } from './create-prove-dlog'
import { evalXorOf } from './xor-of'

export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
    case 'And':
      return evalAnd(e, env, ctx)
    case 'Atleast':
      return evalAtleast(e, env, ctx)
    case 'CreateProveDhTuple':
      return evalCreateProveDhTuple(e, env, ctx)
    case 'CreateProveDlog':
      return evalCreateProveDlog(e, env, ctx)
    case 'Append':
      return evalAppend(e, env, ctx)
    case 'Apply':
      return evalApply(e, env, ctx)
    case 'ByIndex':
      return evalByIndex(e, env, ctx)
    case 'Const':
      return evalConst(e, env, ctx)
    case 'ConstPlaceholder':
      return evalConstPlaceholder(e, env, ctx)
    case 'Context':
      return evalContext(e, env, ctx)
    case 'ValDef':
      return evalValDef(e, env, ctx)
    case 'ValUse':
      return evalValUse(e, env, ctx)
    case 'Tuple':
      return evalTuple(e, env, ctx)
    case 'Collection':
      return evalCollection(e, env, ctx)
    case 'If':
      return evalIf(e, env, ctx)
    case 'BlockValue':
      return evalBlockValue(e, env, ctx)
    case 'BinOp':
      return evalBinOp(e, env, ctx)
    case 'LogicalNot':
      return evalLogicalNot(e, env, ctx)
    case 'BoolToSigmaProp':
      return evalBoolToSigmaProp(e, env, ctx)
    case 'BitInversion':
      return evalBitInversion(e, env, ctx)
    case 'ByteArrayToLong':
      return evalByteArrayToLong(e, env, ctx)
    case 'CalcBlake2b256':
      return evalCalcBlake2b256(e, env, ctx)
    case 'CalcSha256':
      return evalCalcSha256(e, env, ctx)
    case 'Negation':
      return evalNegation(e, env, ctx)
    case 'Or':
      return evalOr(e, env, ctx)
    case 'PropertyCall':
      return evalPropertyCall(e, env, ctx)
    case 'Upcast':
      return evalUpcast(e, env, ctx)
    case 'Downcast':
      return evalDowncast(e, env, ctx)
    case 'ExtractAmount':
      return evalExtractAmount(e, env, ctx)
    case 'ExtractBytes':
      return evalExtractBytes(e, env, ctx)
    case 'ExtractBytesWithNoRef':
      return evalExtractBytesWithNoRef(e, env, ctx)
    case 'ExtractCreationInfo':
      return evalExtractCreationInfo(e, env, ctx)
    case 'ExtractRegisterAs':
      return evalExtractRegisterAs(e, env, ctx)
    case 'ExtractId':
      return evalExtractId(e, env, ctx)
    case 'ExtractScriptBytes':
      return evalExtractScriptBytes(e, env, ctx)
    case 'Exists':
      return evalExists(e, env, ctx)
    case 'ForAll':
      return evalForAll(e, env, ctx)
    case 'Filter':
      return evalFilter(e, env, ctx)
    case 'Fold':
      return evalFold(e, env, ctx)
    case 'FuncValue':
      return evalFuncValue(e, env, ctx)
    case 'GetVar':
      return evalGetVar(e, env, ctx)
    case 'GlobalVars':
      return evalGlobalVars(e, env, ctx)
    case 'Global':
      return evalGlobal(e, env, ctx)
    case 'Map':
      return evalMap(e, env, ctx)
    case 'MethodCall':
      return evalMethodCall(e, env, ctx)
    case 'OptionGet':
      return evalOptionGet(e, env, ctx)
    case 'OptionGetOrElse':
      return evalOptionGetOrElse(e, env, ctx)
    case 'OptionIsDefined':
      return evalOptionIsDefined(e, env, ctx)
    case 'SelectField':
      return evalSelectField(e, env, ctx)
    case 'SigmaAnd':
      return evalSigmaAnd(e, env, ctx)
    case 'SigmaOr':
      return evalSigmaOr(e, env, ctx)
    case 'SigmaPropBytes':
      return evalSigmaPropBytes(e, env, ctx)
    case 'SizeOf':
      return evalSizeOf(e, env, ctx)
    case 'Slice':
      return evalSlice(e, env, ctx)
    case 'XorOf':
      return evalXorOf(e, env, ctx)
    default:
      // Per-arm tasks (9-15) replace this fall-through one variant at a
      // time. Anything not yet wired throws `not-implemented-yet`.
      throw new EvalError(
        `not yet supported: variant '${(e as { tag: string }).tag}'`,
        'not-implemented-yet'
      )
  }
}
