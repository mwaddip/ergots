/**
 * And arm — reduces a Coll[Boolean] to Boolean via all-true (`every`).
 *
 * Empty-Coll returns `true` (vacuous truth — matches Rust `iter().all`
 * and JS `Array.prototype.every`).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/and.rs:11-22
 *   let input_v = self.input.eval(env, ctx)?;
 *   let input_v_bools = input_v.try_extract_into::<Vec<bool>>()?;
 *   ctx.add_per_item_jit_cost(10, 5, 32, input_v_bools.len() as u32)?;
 *   Ok(input_v_bools.iter().all(|b| *b).into())
 *
 * Cost-charging order: envelope charged AFTER eval-child (sigma-rust
 * line 17 → 19). The cost depends on the runtime length of the
 * resulting collection (Cast pattern from 2d-A's Upcast/Downcast).
 *
 * Non-Coll[Boolean] input: parser enforces `post_eval_tpe ==
 * Coll[Boolean]` at parse time (`mir/and.rs:24-26`), so the defensive
 * kind-check here only fires for hand-built MIR nodes or
 * ConstantPlaceholder-injected mismatched shapes. Same defensive
 * posture as 2c's LogicalNot / BoolToSigmaProp / BinOp.Logical arms.
 */

import type { And, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: ergotree-interpreter/src/eval/and.rs:19
//   ctx.add_per_item_jit_cost(10, 5, 32, n)?;
const AND_BASE_COST = 10
const AND_PER_CHUNK_COST = 5
const AND_CHUNK_SIZE = 32

export function evalAnd(e: And, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Coll') {
    throw new EvalError(
      `And: expected Coll[Boolean] input, got '${input.kind}'`,
      'coll-not-boolean'
    )
  }
  const items = input.items
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind !== 'Boolean') {
      throw new EvalError(
        `And: Coll item ${i} has kind '${items[i]!.kind}', expected 'Boolean'`,
        'coll-not-boolean'
      )
    }
  }
  ctx.addPerItemCost(AND_BASE_COST, AND_PER_CHUNK_COST, AND_CHUNK_SIZE, items.length)
  // Items all asserted to be Boolean above; cast is safe.
  const result = items.every((it) => (it as { kind: 'Boolean'; value: boolean }).value)
  return { kind: 'Boolean', value: result }
}
