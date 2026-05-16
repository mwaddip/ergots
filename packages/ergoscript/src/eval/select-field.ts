/**
 * SelectField arm — Tuple → field at 1-based fieldIndex.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/select_field.rs:9-32
 *   ctx.add_jit_cost(10)?;                          // BEFORE eval-child
 *   let input_v = self.input.eval(env, ctx)?;
 *   match input_v {
 *     Value::Tup(items) => items.get(self.field_index.zero_based_index())
 *       .cloned()
 *       .ok_or_else(... NotFound ...)
 *     _ => UnexpectedValue(...)
 *   }
 *
 * Cost-charging order: envelope BEFORE eval-child (Pattern A).
 *
 * `field_index` is 1-based on the wire (ErgoScript's `t._1` / `t._2`
 * syntax). Subtract 1 inline for 0-based array access.
 *
 * Defensive 'select-field-input-not-tuple' guards against non-Tuple
 * input. Wire-format invariants make this unreachable for parser-
 * produced trees; same posture as LogicalNot.
 *
 * 'select-field-index-out-of-range' guards against out-of-bounds
 * fieldIndex. Also unreachable from parser-produced trees (sigma-rust's
 * `SelectField::new` validates in-bounds at construction), but tested
 * via inline TS test with a hand-built MIR node.
 */

import type { SelectField, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: sigma-rust eval/select_field.rs:15 — inline literal
//   ctx.add_jit_cost(10)?;
// Pattern A (envelope BEFORE eval-child).
const SELECT_FIELD_COST = 10

export function evalSelectField(e: SelectField, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(SELECT_FIELD_COST)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Tuple') {
    throw new EvalError(
      `SelectField: input must be Tuple, got '${input.kind}'`,
      'select-field-input-not-tuple'
    )
  }
  const zeroBased = e.fieldIndex - 1
  if (zeroBased < 0 || zeroBased >= input.items.length) {
    throw new EvalError(
      `SelectField: fieldIndex ${e.fieldIndex} is out of range for tuple of ${input.items.length} items`,
      'select-field-index-out-of-range'
    )
  }
  return input.items[zeroBased]!
}
