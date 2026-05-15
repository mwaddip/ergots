/**
 * BitInversion arm — bitwise complement (`~x`) on numeric SValues.
 *
 * Result kind equals input kind. No overflow path: `~` is a self-inverse on
 * the bit pattern; `maskToKind` brings the unmasked bigint result back into
 * the kind's signed range.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bit_inversion.rs:15
 *   ctx.add_jit_cost(1)?;                       // BitOp = Fixed(1)
 *   let input_v = self.input.eval(env, ctx)?;   // eval child after cost
 *   match input_v { Byte(v)/Short/Int/Long/BigInt => Ok(...(!v)), ... }
 *
 * Cost-charging order: envelope BEFORE eval-child (matches sigma-rust line
 * 15 → 16; same posture as LogicalNot).
 *
 * Non-numeric input: sigma-rust returns `EvalError::UnexpectedValue`
 * (bit_inversion.rs:23). We surface this as `'bin-op-not-numeric'` to
 * match the precedent set by 2c's `LogicalNot` reusing
 * `'bin-op-not-boolean'`.
 */

import type { BitInversion, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bigIntToValue, isNumeric, maskToKind, valueToBigInt } from './bin-op/_numeric'

const BIT_INVERSION_COST = 1

export function evalBitInversion(e: BitInversion, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(BIT_INVERSION_COST)
  const input = evalExpr(e.input, env, ctx)
  if (!isNumeric(input.kind)) {
    throw new EvalError(
      `BitInversion: operand kind must be numeric, got '${input.kind}'`,
      'bin-op-not-numeric'
    )
  }
  const inverted = ~valueToBigInt(input)
  return bigIntToValue(input.kind, maskToKind(inverted, input.kind))
}
