/**
 * ExtractAmount arm — Box → Long.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/extract_amount.rs:9-25
 *   ctx.add_jit_cost(8)?;                            // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v { Value::CBox(b) => Value::Long(b.value.as_i64()), ... }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A —
 * [[reference-cost-charging-order-patterns]] memory).
 *
 * Defensive eval-time kind-check (`'extract-input-not-box'`) guards
 * against ConstantPlaceholder injection — same posture as 2c's
 * LogicalNot / 2d-B's And/Or defensive checks. Wire-format invariants
 * (sigma-rust enforces input.post_eval_tpe == SBox at construction time)
 * make this throw unreachable for parser-produced trees.
 *
 * This arm establishes the Box-extract template and introduces the shared
 * `'extract-input-not-box'` EvalError code reused by all 6 remaining
 * Box-extract arms in phase 2f.
 */

import type { ExtractAmount, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: sigma-rust eval/extract_amount.rs:15 — inline literal
//   ctx.add_jit_cost(8)?;
// Pattern A (envelope BEFORE eval-child).
const EXTRACT_AMOUNT_COST = 8

export function evalExtractAmount(
  e: ExtractAmount,
  env: Env,
  ctx: EvalContext
): SValue {
  ctx.addCost(EXTRACT_AMOUNT_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Box') {
    throw new EvalError(
      `ExtractAmount: input must be Box, got '${input.kind}'`,
      'extract-input-not-box'
    )
  }
  // box.value is already bigint per the ErgoBox interface.
  return { kind: 'Long', value: input.value.value }
}
