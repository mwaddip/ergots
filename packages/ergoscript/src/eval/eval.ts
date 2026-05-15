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
import { evalApply } from './apply'
import { evalBinOp } from './bin-op'
import { evalBitInversion } from './bit-inversion'
import { evalBlockValue } from './block-value'
import { evalBoolToSigmaProp } from './bool-to-sigma-prop'
import { evalCollection } from './collection'
import { evalConst } from './const'
import { evalConstPlaceholder } from './const-placeholder'
import { evalDowncast } from './downcast'
import { evalExtractAmount } from './extract-amount'
import { evalExtractCreationInfo } from './extract-creation-info'
import { evalExtractRegisterAs } from './extract-register-as'
import { evalExtractScriptBytes } from './extract-script-bytes'
import { evalFuncValue } from './func-value'
import { evalIf } from './if'
import { evalLogicalNot } from './logical-not'
import { evalNegation } from './negation'
import { evalOr } from './or'
import { evalTuple } from './tuple'
import { evalUpcast } from './upcast'
import { evalValDef } from './val-def'
import { evalValUse } from './val-use'
import { evalXorOf } from './xor-of'

export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
    case 'And':
      return evalAnd(e, env, ctx)
    case 'Apply':
      return evalApply(e, env, ctx)
    case 'Const':
      return evalConst(e, env, ctx)
    case 'ConstPlaceholder':
      return evalConstPlaceholder(e, env, ctx)
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
    case 'Negation':
      return evalNegation(e, env, ctx)
    case 'Or':
      return evalOr(e, env, ctx)
    case 'Upcast':
      return evalUpcast(e, env, ctx)
    case 'Downcast':
      return evalDowncast(e, env, ctx)
    case 'ExtractAmount':
      return evalExtractAmount(e, env, ctx)
    case 'ExtractCreationInfo':
      return evalExtractCreationInfo(e, env, ctx)
    case 'ExtractRegisterAs':
      return evalExtractRegisterAs(e, env, ctx)
    case 'ExtractScriptBytes':
      return evalExtractScriptBytes(e, env, ctx)
    case 'FuncValue':
      return evalFuncValue(e, env, ctx)
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
