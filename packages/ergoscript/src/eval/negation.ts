/**
 * Negation arm — unary numeric negate (`-x`) on numeric SValues.
 *
 * Result kind equals input kind. `Negate(MIN_K)`: Byte/Short/Int/Long WRAP
 * two's-complement (`-MIN_K === MIN_K`, no error) to match JVM's numeric
 * `negate` (sigma-state `ast/trees.scala:889`); BigInt is 256-bit *checked*
 * and raises `'arith-overflow'` on `-(2^255)` (JVM's 256-bit BigInt overflows
 * too). JVM is canonical here.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/negation.rs:16,25
 *   ctx.add_jit_cost(30)?;                       // Negation = Fixed(30)
 *   let input_v = self.input.eval(env, ctx)?;    // eval child after cost
 *   match input_v { Byte/Short/Int/Long/BigInt => checked_neg, ... }
 *
 * ⚠ Deliberate divergence from sigma-rust: its `checked_neg` ERRORS on all five
 * MINs — wrong vs JVM for the 4 machine widths. We wrap them (`_numeric.ts`
 * `maskToKind`) and keep BigInt checked. Routed to the sigma-rust session in
 * `~/projects/santa/prompts/ergots-v5-divergences.md` §A1.
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
import { bigIntToValue, checkRange, isNumeric, maskToKind, valueToBigInt } from './bin-op/_numeric'

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
  // JVM `Negation.eval` (sigma-state `ast/trees.scala:889`) negates via the
  // numeric `negate`: two's-complement WRAP for the fixed-width types
  // (`-MIN_K === MIN_K`, no error), while BigInt is 256-bit *checked* and throws
  // on `-(2^255)`. sigma-rust `negation.rs:25` uses `checked_neg` for every
  // width and so errors on all five MINs — a divergence from JVM on the 4
  // machine widths. JVM is canonical here (SANTA v5 `Numeric_Negation`; routed
  // to sigma-rust in `~/projects/santa/prompts/ergots-v5-divergences.md` §A1).
  if (input.kind === 'BigInt') {
    checkRange(negated, input.kind, 'arith-overflow')
    return bigIntToValue(input.kind, negated)
  }
  return bigIntToValue(input.kind, maskToKind(negated, input.kind))
}
