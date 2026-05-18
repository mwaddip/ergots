/**
 * `Global` evaluator arm — returns the `Value::Global` sentinel.
 *
 * Trivial: cost 5 (Pattern A) per `expr.rs:38`. The sentinel is consumed
 * by `SGlobal.*` method handlers (Task 2: groupGenerator; future: xor,
 * serialize, deserialize, some, none, fromBigEndianBytes, etc.).
 *
 * Source: ergotree-interpreter/src/eval/expr.rs:37-40
 */

import type { Global as GlobalExpr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalGlobal(_e: GlobalExpr, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5) // Pattern A; source: expr.rs:38 "Global = Fixed(5)"
  return { kind: 'Global' }
}
