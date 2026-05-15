/**
 * Negation arm — unary numeric negate (`-x`) on numeric SValues.
 *
 * Result kind equals input kind. Overflow: `Negate(MIN_K)` for each of
 * Byte/Short/Int/Long/BigInt exceeds the signed range (|MIN_K| = MAX_K + 1)
 * and raises `'arith-overflow'` (reused from 2c BinOp.Arith — same
 * semantic posture as `checked_add`/`checked_mul` overflow).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/negation.rs:16
 *   ctx.add_jit_cost(30)?;                       // Negation = Fixed(30)
 *   let input_v = self.input.eval(env, ctx)?;    // eval child after cost
 *   match input_v { Byte/Short/Int/Long/BigInt => checked_neg, ... }
 *
 * Sigma-rust uses per-primitive `checked_neg`; we use the shared
 * `_numeric.ts` helpers (`valueToBigInt` → negate in bigint →
 * `checkRange` → `bigIntToValue`) for a kind-uniform path.
 *
 * Cost-charging order: envelope BEFORE eval-child (sigma-rust line 16 →
 * 17; same posture as LogicalNot / BitInversion).
 *
 * Non-numeric input: sigma-rust returns `EvalError::UnexpectedValue`
 * (negation.rs:35-38). We surface this as `'bin-op-not-numeric'` to
 * match the precedent set by 2c's `LogicalNot` reusing
 * `'bin-op-not-boolean'`. Note: `Negation::try_build`
 * (`ergotree-ir/src/mir/negation.rs:38-50`) rejects non-numeric at
 * build time, so this defensive guard only fires for hand-built MIR
 * nodes (e.g. the inline non-numeric test).
 */

import type { Negation, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bigIntToValue, checkRange, isNumeric, valueToBigInt } from './bin-op/_numeric'

const NEGATION_COST = 30

export function evalNegation(e: Negation, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(NEGATION_COST)
  const input = evalExpr(e.input, env, ctx)
  if (!isNumeric(input.kind)) {
    throw new EvalError(
      `Negation: operand kind must be numeric, got '${input.kind}'`,
      'bin-op-not-numeric'
    )
  }
  const negated = -valueToBigInt(input)
  checkRange(negated, input.kind, 'arith-overflow')
  return bigIntToValue(input.kind, negated)
}
