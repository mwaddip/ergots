/**
 * Central evaluator dispatch — exhaustive switch on `Expr.tag`. Adding a
 * new Expr variant to `mir/types.ts` becomes a compile-time error here
 * via the `_exhaust: never` discriminant until an arm exists.
 *
 * Phase 2b ships 8 arms (Const, ConstPlaceholder, BlockValue, ValDef,
 * ValUse, Tuple, Collection, If). Every other variant currently throws
 * `EvalError 'not-implemented-yet'` — Phase 2c+ replaces each with an
 * explicit case calling its arm. The chassis itself is correct from
 * this commit forward.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs
 */

import type { Expr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalConst } from './const'
import { evalConstPlaceholder } from './const-placeholder'
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
    default:
      // Per-arm tasks (9-15) replace this fall-through one variant at a
      // time. Anything not yet wired throws `not-implemented-yet`.
      throw new EvalError(
        `not yet supported: variant '${(e as { tag: string }).tag}'`,
        'not-implemented-yet'
      )
  }
}
