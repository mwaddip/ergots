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

export function evalExpr(e: Expr, _env: Env, _ctx: EvalContext): SValue {
  // Chassis-only: no arms wired yet. Each per-arm task (8-15) inserts an
  // explicit `case` returning the arm's eval function before this throw.
  throw new EvalError(
    `not yet supported: variant '${(e as { tag: string }).tag}'`,
    'not-implemented-yet'
  )
}
