/**
 * Tuple arm — eval each item, wrap as `Tuple` SValue.
 *
 * Sigma-rust ref: `ergotree-interpreter/src/eval/tuple.rs:9-19`
 *
 *     ctx.add_jit_cost(15)?;        // Tuple = Fixed(15) (envelope)
 *     let items_v = self.items.try_mapped_ref(|i| i.eval(env, ctx));
 *     Ok(Value::Tup(items_v?))
 *
 * Cost: Tuple = Fixed(15) (envelope); per-item costs are added recursively
 * by each child arm (e.g. a 2-tuple of Const = 15 + 5 + 5 = 25).
 *
 * NB: cost is charged BEFORE evaluating items, mirroring sigma-rust. If a
 * child item throws, the envelope cost has already been added — same as
 * the reference behavior.
 */

import type { SValue, Tuple } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'

export function evalTuple(e: Tuple, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(15)
  const items = e.items.map((item) => evalExpr(item, env, ctx))
  return { kind: 'Tuple', items }
}
