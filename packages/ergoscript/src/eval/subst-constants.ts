/**
 * SubstConstants arm — substitute constants in a serialized ErgoTree
 * (CONSENSUS-CRITICAL: output bytes go on-chain; a 1-byte divergence from the
 * JVM `sigma-state` reference is a consensus failure).
 *
 * The byte surgery lives in the wire layer: `substituteConstantsBytes`
 * (`wire/ergo-tree.ts`), mirroring JVM `ErgoTreeSerializer.substituteConstants`
 * (`sigma-state-6.0.3`). This arm evals the three children, extracts/guards
 * their shapes, then delegates and charges cost.
 *
 * ⚠ The template BODY is copied VERBATIM, never parsed — matching JVM. A crafted
 * template whose body is not valid Expr bytes (SANTA substConstants `#1`) is
 * returned unchanged (0 constants ⇒ no substitution) where the old
 * `parseTree`/`serializeTree` path threw. The wire fn documents the full
 * JVM-parity contract (out-of-range no-op, first-wins duplicate positions, the
 * v3-gated size prefix, the unbounded body read).
 *
 * Sigma-rust ref (the historical parse-based approach — still its current impl):
 *   ergotree-interpreter/src/eval/subst_const.rs:18-89
 *   ergotree-ir/src/ergo_tree.rs:45-70  (ParsedErgoTree::with_constant)
 * sigma-rust full-parses the body too, so it shares the `#1` divergence; ergots
 * leads the serializer-level fix (JVM is canonical). Routed for sigma-rust in
 * `~/projects/santa/prompts/ergots-v5-divergences.md` §A2.
 *
 * Pseudocode:
 *     script_bytes = scriptBytes.eval(...)             // Coll[Byte] guard
 *     positions    = positions.eval(...)               // Coll[Int]  guard
 *     new_values   = newValues.eval(...)               // Coll[_]    guard
 *     {bytes, n}   = substituteConstantsBytes(script_bytes, positions,
 *                       new_values.items, new_values.elem, ctx.treeVersion)
 *     ctx.addPerItemCost(100, 100, 1, n)               // Pattern B; template-sized
 *     return Coll[Byte] of bytes
 *
 * Cost-charging order: Pattern B, sized by the TEMPLATE's constant count `n`
 * (returned by the wire fn), NOT the caller-supplied `positions.length`. The
 * bug-3 regression (sigma-rust subst_const.rs:221-283 + the byte-equality
 * suite) fixes this: substituting 1 vs 3 positions on a 3-const template must
 * yield identical SubstConstants cost. The final jitCost is independent of
 * whether the charge lands before or after the byte surgery — the op is atomic
 * w.r.t. cost, and errored runs (the only paths affected by ordering) do not
 * assert cost.
 *
 * Single compact error code: `'subst-constants-error'` wraps every throw path
 * from the wire fn (bad template bytes, length mismatch, structural type
 * mismatch) per the 2g.5 compact-taxonomy decision; the out-of-range position
 * path is a no-op (JVM parity), not a throw. Callers distinguish the throws via
 * `error.message`.
 *
 * Build-time type guards: `SubstConstants::new` in sigma-rust validates
 * `script_bytes : SColl(SByte)`, `positions : SColl(SInt)`, and
 * `new_values : SColl(_)` at MIR construction, so parser-produced trees cannot
 * reach the shape-guards here. The TS-side guards remain for defense against
 * `ConstantPlaceholder` injection / hand-crafted MIR (calc_blake2b256 /
 * byte_array_to_long precedent).
 */

import type { SubstConstants, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue, collByteToUint8Array } from './_byte-coll'
import { extractCollInt } from './_coll-helpers'
import { substituteConstantsBytes } from '../wire/ergo-tree'

export function evalSubstConstants(
  e: SubstConstants,
  env: Env,
  ctx: EvalContext,
): SValue {
  // 1. Eval scriptBytes child + extract as Uint8Array.
  const scriptBytesV = evalExpr(e.scriptBytes, env, ctx)
  const scriptBytes = collByteToUint8Array(
    scriptBytesV,
    'SubstConstants script_bytes',
    'subst-constants-error',
  )

  // 2. Eval positions child + extract as number[].
  const positionsV = evalExpr(e.positions, env, ctx)
  const positions = extractCollInt(positionsV, 'SubstConstants positions', 'subst-constants-error')

  // 3. Eval newValues child — must be a Coll[T] (heterogeneous content rejected
  //    by the parser's Coll[T] type-tagging).
  const newValuesV = evalExpr(e.newValues, env, ctx)
  if (newValuesV.kind !== 'Coll') {
    throw new EvalError(
      `SubstConstants: new_values must be Coll[T], got kind='${newValuesV.kind}'`,
      'subst-constants-error',
    )
  }

  // 4. Serializer-level substitution: header + constants re-serialized, body
  //    copied verbatim. The length check, out-of-range no-op, first-wins
  //    duplicate handling, and structural type-equality all live in the wire
  //    fn (JVM parity). Any wire-layer error → compact 'subst-constants-error'.
  let result: { bytes: Uint8Array; numConstants: number }
  try {
    result = substituteConstantsBytes(
      scriptBytes,
      positions,
      newValuesV.items,
      newValuesV.elem,
      ctx.treeVersion ?? 0,
    )
  } catch (cause) {
    throw new EvalError(
      `SubstConstants: ${(cause as Error).message}`,
      'subst-constants-error',
    )
  }

  // 5. Pattern B cost: sized by the TEMPLATE's constant count (returned by the
  //    wire fn), NOT positions.length (sigma-rust subst_const.rs:65; bug-3).
  ctx.addPerItemCost(100, 100, 1, result.numConstants)

  // 6. Wrap the substituted bytes as Coll[Byte].
  return bytesToCollByteSValue(result.bytes)
}
