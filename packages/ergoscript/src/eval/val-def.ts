/**
 * ValDef arm — top-level rejection. ValDef is only valid as an item
 * inside `BlockValue.items`; reaching it as a top-level Expr is a
 * structural error.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval.rs:66-68
 *   Expr::ValDef(_) => Err(EvalError::UnexpectedExpr(...))
 */

import type { SValue, ValDef } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalValDef(e: ValDef, _env: Env, _ctx: EvalContext): SValue {
  throw new EvalError(
    `ValDef(id=${e.id}) should be evaluated inside BlockValue, not at top level`,
    'val-def-outside-block'
  )
}
