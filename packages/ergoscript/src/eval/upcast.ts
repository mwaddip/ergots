/**
 * Upcast arm — widen a numeric SValue to a target numeric kind read
 * from `e.tpe`.
 *
 * Result kind equals the target kind from the MIR node's `tpe` field
 * (not the source kind). No overflow path: widening preserves the
 * source value exactly. Sigma-rust's `Upcast::new`
 * (`ergotree-ir/src/mir/upcast.rs:29-48`) requires both source and
 * target to be numeric but does NOT enforce target ≥ source width;
 * that's checked at eval-time in `upcast_to_*` per-target functions.
 * Our parser is permissive (matches sigma-rust's serializer); the eval
 * arm trusts the wire-format invariant per CLAUDE.md "validate at
 * boundaries."
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/upcast.rs:78-92
 *   let input_v = self.input.eval(env, ctx)?;             // eval child FIRST
 *   ctx.add_jit_cost(if self.tpe == SType::SBigInt { 30 } else { 10 })?;
 *   match self.tpe { SBigInt/SLong/SInt/SShort/SByte => upcast_to_*, ... }
 *
 * Cost-charging order: envelope AFTER eval-child (sigma-rust line 78 →
 * 80). DIFFERENT from Negation / BitInversion / LogicalNot which charge
 * before. Confirmed by Layer C1 fixture cost-equality.
 *
 * Cost values: 30 for SBigInt target, 10 for any other numeric target.
 * Inline literals in sigma-rust (not in `costs.rs`).
 *
 * Same-kind Upcast (sigma-rust `upcast.rs:31, 43, 54, 64`):
 *   - Byte → Byte, Short → Short, Int → Int, Long → Long: PERMITTED as
 *     no-op at any tree version. The shared bigint round-trip
 *     (`valueToBigInt` → `bigIntToValue`) yields the same SValue.
 *   - BigInt → BigInt: only permitted when `tree_version() >= V3`
 *     (`upcast.rs:18`). Phase 2e (this slice) implements the gate;
 *     throws 'tree-version-too-low' when (ctx.treeVersion ?? 0) < 3.
 *
 * V3 gating: BigInt → BigInt no-op self-cast requires tree_version >= V3
 * (sigma-rust upcast.rs:18). Other source kinds widening to BigInt (Byte/
 * Short/Int/Long → BigInt) are unconditional at any version. Phase 2e
 * (this slice) implements the gate; throws 'tree-version-too-low' at V<3.
 *
 * Non-numeric input: sigma-rust returns `EvalError::UnexpectedValue`
 * (`upcast.rs:87-90`). We surface as `'bin-op-not-numeric'` to match
 * the precedent set by 2c's `LogicalNot` reusing `'bin-op-not-boolean'`
 * (also used by Negation and BitInversion). Note: `Upcast::new`
 * rejects non-numeric source/target at build time, so this defensive
 * guard only fires for hand-built MIR nodes (covered by the inline
 * test in `test/eval/upcast.test.ts`).
 *
 * `sTypeToNumericKind` helper: local to this arm per the PLAN's YAGNI
 * guidance (promote to `_numeric.ts` only when a third user appears).
 * Downcast (Task 5) will duplicate the same switch; promotion can
 * happen at that point if a third user materializes.
 */

import type { SType, SValue, Upcast } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import {
  bigIntToValue,
  isNumeric,
  valueToBigInt,
  type NumericKind,
} from './bin-op/_numeric'

// Cost source: sigma-rust eval/upcast.rs:80 — inline literal
//   ctx.add_jit_cost(if self.tpe == SType::SBigInt { 30 } else { 10 })?;
const UPCAST_COST_BIGINT_TARGET = 30
const UPCAST_COST_OTHER_TARGET = 10

function sTypeToNumericKind(t: SType): NumericKind {
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
        `Upcast: target type ${t.tag} is not numeric`,
        'bin-op-not-numeric'
      )
  }
}

export function evalUpcast(e: Upcast, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  ctx.addCost(
    e.tpe.tag === 'SBigInt' ? UPCAST_COST_BIGINT_TARGET : UPCAST_COST_OTHER_TARGET
  )
  if (!isNumeric(input.kind)) {
    throw new EvalError(
      `Upcast: operand kind must be numeric, got '${input.kind}'`,
      'bin-op-not-numeric'
    )
  }
  const targetKind = sTypeToNumericKind(e.tpe)
  // V3 gate: sigma-rust eval/upcast.rs:18 — BigInt → BigInt no-op only.
  // Non-BigInt sources widening to BigInt are unconditional at any version.
  if (input.kind === 'BigInt' && targetKind === 'BigInt' && (ctx.treeVersion ?? 0) < 3) {
    throw new EvalError(
      `Upcast: BigInt → BigInt no-op requires tree version >= V3, got ${ctx.treeVersion ?? 0}`,
      'tree-version-too-low'
    )
  }
  return bigIntToValue(targetKind, valueToBigInt(input))
}
