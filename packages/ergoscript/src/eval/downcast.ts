/**
 * Downcast arm — narrow a numeric SValue to a target numeric kind read
 * from `e.tpe`.
 *
 * Result kind equals the target kind from the MIR node's `tpe` field
 * (not the source kind). Throws `'downcast-overflow'` (new EvalError code
 * landed in this commit) when the input value lies outside the target's
 * signed range. Sigma-rust raises `EvalError::UnexpectedValue("Downcast:
 * overflow converting to ...")` for the same case
 * (`ergotree-interpreter/src/eval/downcast.rs:15-22`); we surface as a
 * distinct code so callers can dispatch on "downcast specifically failed"
 * vs other arith overflows (precedent from design spec § Error taxonomy,
 * Decision Log #2).
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/downcast.rs:117-119
 *   let input_v = self.input.eval(env, ctx)?;             // eval child FIRST
 *   ctx.add_jit_cost(if self.tpe == SType::SBigInt { 30 } else { 10 })?;
 *   match self.tpe { SBigInt/SLong/SInt/SShort/SByte => downcast_to_*, ... }
 *
 * Cost-charging order: envelope AFTER eval-child (sigma-rust line 117 →
 * 119). Same pattern as Upcast (Cast-arm family). DIFFERENT from
 * Negation / BitInversion / LogicalNot which charge before. Confirmed by
 * Layer C1 fixture cost-equality.
 *
 * Cost values: 30 for SBigInt target, 10 for any other numeric target.
 * Inline literals in sigma-rust (not in `costs.rs`).
 *
 * Same-kind Downcast (sigma-rust `downcast.rs:30, 44, 60, 75, 96`):
 *   - Byte → Byte, Short → Short, Int → Int, Long → Long: PERMITTED as
 *     no-op at any tree version. The shared bigint round-trip
 *     (`valueToBigInt` → `bigIntToValue`) yields the same SValue.
 *   - BigInt → BigInt: only permitted when `tree_version() >= V3`
 *     (`downcast.rs:30`). Our TS evaluator currently treats it as a no-op
 *     (no version-gating in scope for phase 2d-A); V3 gating belongs to
 *     a later phase that introduces tree-version awareness. Matches the
 *     Upcast arm's treatment of BigInt → BigInt.
 *
 * Range check: `checkRange(value, targetKind, 'downcast-overflow')`. The
 * range is checked against the **target** kind (not the source); this is
 * the structural difference from Negation, which checks against the same
 * kind as the input.
 *
 * Non-numeric input: sigma-rust returns `EvalError::UnexpectedValue`
 * (`downcast.rs:126-129`). We surface as `'bin-op-not-numeric'` to match
 * the precedent set by 2c's `LogicalNot` reusing `'bin-op-not-boolean'`
 * (also used by Negation, BitInversion, and Upcast). Note: `Downcast::new`
 * rejects non-numeric source/target at build time
 * (`ergotree-ir/src/mir/downcast.rs:29-48`), so this defensive guard only
 * fires for hand-built MIR nodes (covered by the inline test in
 * `test/eval/downcast.test.ts`).
 *
 * `sTypeToNumericKind` helper: kept local to this arm per the PLAN's
 * YAGNI guidance (Task 5 step 6 — "promote to `_numeric.ts` only when a
 * third user appears"). Upcast (Task 4) is the first user; this is the
 * second. Per the design spec Decision Log #4-5 the bar for promotion to
 * `_numeric.ts` is "shared by top-level arms" — but the explicit Task 5
 * guidance is to wait for a third user, so the helper duplicates here
 * identically. Promotion happens at that point if a third user
 * materializes.
 */

import type { SType, SValue, Downcast } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import {
  bigIntToValue,
  checkRange,
  isNumeric,
  valueToBigInt,
  type NumericKind,
} from './bin-op/_numeric'

// Cost source: sigma-rust eval/downcast.rs:119 — inline literal
//   ctx.add_jit_cost(if self.tpe == SType::SBigInt { 30 } else { 10 })?;
const DOWNCAST_COST_BIGINT_TARGET = 30
const DOWNCAST_COST_OTHER_TARGET = 10

function sTypeToNumericKind(t: SType): NumericKind {
  // Duplicate of upcast.ts's helper per PLAN Task 5 step 6 (YAGNI:
  // promote to `_numeric.ts` only when a third user appears).
  switch (t.tag) {
    case 'SByte':
      return 'Byte'
    case 'SShort':
      return 'Short'
    case 'SInt':
      return 'Int'
    case 'SLong':
      return 'Long'
    case 'SBigInt':
      return 'BigInt'
    default:
      throw new EvalError(
        `Downcast: target type ${t.tag} is not numeric`,
        'bin-op-not-numeric'
      )
  }
}

export function evalDowncast(e: Downcast, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  ctx.addCost(
    e.tpe.tag === 'SBigInt' ? DOWNCAST_COST_BIGINT_TARGET : DOWNCAST_COST_OTHER_TARGET
  )
  if (!isNumeric(input.kind)) {
    throw new EvalError(
      `Downcast: operand kind must be numeric, got '${input.kind}'`,
      'bin-op-not-numeric'
    )
  }
  const targetKind = sTypeToNumericKind(e.tpe)
  const value = valueToBigInt(input)
  // Range-check against the TARGET kind (not the source). Throws
  // 'downcast-overflow' on out-of-range — see checkRange in
  // bin-op/_numeric.ts and the design spec § Error taxonomy.
  checkRange(value, targetKind, 'downcast-overflow')
  return bigIntToValue(targetKind, value)
}
