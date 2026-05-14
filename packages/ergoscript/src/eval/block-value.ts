/**
 * BlockValue arm — let-bindings + result.
 * Sigma-rust ref: ergotree-interpreter/src/eval/block.rs:13-65
 * Cost: addPerItemCost(1, 1, 10, items.length) envelope
 *     + per ValDef: rhs eval cost + 5 (ADD_TO_ENV_COST per Scala)
 *     + result eval cost.
 *
 * Sigma-rust uses mutable Env + manual save/restore for nested blocks;
 * our immutable Env makes scoping correct by construction (the new Env
 * goes out of scope when this function returns).
 */

import type { BlockValue, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalBlockValue(e: BlockValue, env: Env, ctx: EvalContext): SValue {
  ctx.addPerItemCost(1, 1, 10, e.items.length)
  let scope = env
  for (let i = 0; i < e.items.length; i++) {
    const item = e.items[i]!
    if (item.tag !== 'ValDef') {
      throw new EvalError(
        `BlockValue.items[${i}] has tag '${item.tag}', expected 'ValDef'`,
        'block-item-not-val-def'
      )
    }
    const v = evalExpr(item.rhs, scope, ctx)
    ctx.addCost(5) // ADD_TO_ENV_COST per sigma-rust block.rs:30
    scope = scope.extend(item.id, v)
  }
  return evalExpr(e.result, scope, ctx)
}
