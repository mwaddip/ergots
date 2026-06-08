/**
 * SelectField arm — Tuple → field at 1-based fieldIndex.
 *
 * JVM-canonical ref: sigma `ast/transformers.scala:297-308`
 *   val inputV = input.evalTo[Any](env)            // eval-child
 *   addCost(SelectField.costKind)                  // FixedCost(10), :314
 *   inputV match {
 *     case p: Tuple2[_,_] => if (fieldIndex == 1) p._1 else if (== 2) p._2 …
 *     case _ => Value.typeError(input, inputV)      // non-pair ⇒ error
 *   }
 *
 * The JVM runtime has only `Tuple2`; a non-pair tuple value (1-tuple `(5,)`,
 * 3-tuple, …) is a `Coll[Any]` and falls to `Value.typeError` (line 306).
 * Hence the explicit arity≠2 reject ('select-field-non-pair') — sigma-rust
 * convergently OVER-ACCEPTS here (`items.get(idx)` on any-arity Tup), so this
 * arm is JVM-faithful, not a sigma-rust port. Adversarial-only: a 1-tuple
 * CONSTANT reaches this arm (the input parses as a Const, not a Tuple EXPR, so
 * batch-1's 'tuple-invalid-arity' does not fire; SelectField input is not a
 * checkType seam so 'unsupported-value-type' does not fire either). SANTA pin:
 * W3 `008c6001040a01`.
 *
 * Cost-charging order: Pattern A (envelope BEFORE eval-child in ergots; the
 * JVM charges after the child eval at :299). Observable cost is identical — the
 * total at the reject is FixedCost(10) regardless of order. The reject is
 * cost-then-throw on both sides.
 *
 * `field_index` is 1-based on the wire (ErgoScript's `t._1` / `t._2`
 * syntax). Subtract 1 inline for 0-based array access.
 *
 * Defensive 'select-field-input-not-tuple' guards against non-Tuple
 * input. Wire-format invariants make this unreachable for parser-
 * produced trees; same posture as LogicalNot.
 *
 * 'select-field-index-out-of-range' guards against out-of-bounds
 * fieldIndex on a pair (now reachable only via hand-built MIR with a
 * fieldIndex > 2 on an arity-2 input, since the arity≠2 reject precedes it
 * for non-pairs). Tested via inline TS test with a hand-built MIR node.
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
  // JVM SelectField.eval (transformers.scala:300-307) matches ONLY a runtime
  // Tuple2 (a pair). A non-pair tuple (1-tuple, 3-tuple, …) is a Coll[Any] at
  // runtime and falls through to Value.typeError (line 306). Cost is already
  // charged above (transformers.scala:299, before the match) ⇒ cost-then-throw.
  if (input.items.length !== 2) {
    throw new EvalError(
      `SelectField: input Tuple must be a pair (arity 2), got arity ${input.items.length}`,
      'select-field-non-pair'
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
