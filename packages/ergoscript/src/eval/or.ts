/**
 * Or arm — reduces a Coll[Boolean] to Boolean via any-true (`some`).
 *
 * Empty-Coll returns `false` (identity of Or — matches Rust `iter().any`
 * and JS `Array.prototype.some`).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/or.rs:11-22
 *   let input_v = self.input.eval(env, ctx)?;
 *   let input_v_bools = input_v.try_extract_into::<Vec<bool>>()?;
 *   ctx.add_per_item_jit_cost(5, 5, 64, input_v_bools.len() as u32)?;
 *   Ok(input_v_bools.iter().any(|b| *b).into())
 *
 * Cost-charging order: envelope charged AFTER eval-child (sigma-rust
 * line 17 → 19). The cost depends on the runtime length of the
 * resulting collection (Cast pattern from 2d-A).
 *
 * Cost values differ from And: base 5 (not 10), chunkSize 64 (not 32).
 * Don't refactor toward shared constants — the values are arm-specific.
 *
 * Non-Coll[Boolean] input: parser enforces `post_eval_tpe ==
 * Coll[Boolean]` at parse time (`mir/or.rs:22-24`); the defensive
 * kind-check here mirrors `and.ts` and matches the 2c LogicalNot /
 * BoolToSigmaProp posture. Throws `'coll-not-boolean'` (the code added
 * in Task 1).
 *
 * Note: the kind-check is duplicated with `and.ts` (~5 LOC each).
 * Intentional per slice A's `sTypeToNumericKind` YAGNI precedent —
 * promote to a shared `_coll.ts` helper when a third caller appears
 * (likely `XorOf` / `ForAll` / `Exists` in later phases).
 */

import type { Or, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: ergotree-interpreter/src/eval/or.rs:19
//   ctx.add_per_item_jit_cost(5, 5, 64, n)?;
const OR_BASE_COST = 5
const OR_PER_CHUNK_COST = 5
const OR_CHUNK_SIZE = 64

export function evalOr(e: Or, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Coll') {
    throw new EvalError(
      `Or: expected Coll[Boolean] input, got '${input.kind}'`,
      'coll-not-boolean'
    )
  }
  const items = input.items
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind !== 'Boolean') {
      throw new EvalError(
        `Or: Coll item ${i} has kind '${items[i]!.kind}', expected 'Boolean'`,
        'coll-not-boolean'
      )
    }
  }
  ctx.addPerItemCost(OR_BASE_COST, OR_PER_CHUNK_COST, OR_CHUNK_SIZE, items.length)
  // Items all asserted to be Boolean above; cast is safe.
  const result = items.some((it) => (it as { kind: 'Boolean'; value: boolean }).value)
  return { kind: 'Boolean', value: result }
}
