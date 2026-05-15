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
import { evalBinOp } from './bin-op'
import { evalBitInversion } from './bit-inversion'
import { evalBlockValue } from './block-value'
import { evalBoolToSigmaProp } from './bool-to-sigma-prop'
import { evalCollection } from './collection'
import { evalConst } from './const'
import { evalConstPlaceholder } from './const-placeholder'
import { evalIf } from './if'
import { evalLogicalNot } from './logical-not'
import { evalNegation } from './negation'
import { evalTuple } from './tuple'
import { evalValDef } from './val-def'
import { evalValUse } from './val-use'

export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
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
    default:
      // Per-arm tasks (9-15) replace this fall-through one variant at a
      // time. Anything not yet wired throws `not-implemented-yet`.
      throw new EvalError(
        `not yet supported: variant '${(e as { tag: string }).tag}'`,
        'not-implemented-yet'
      )
  }
}
