/**
 * SubstConstants arm — substitute constants in a serialized ErgoTree
 * (CONSENSUS-CRITICAL: output bytes go on-chain; a 1-byte divergence from the
 * JVM `sigma-state` reference is a consensus failure).
 *
 * ⚠ Out-of-range position handling DELIBERATELY diverges from sigma-rust to
 * match the JVM (no-op, not an error — see step 7). JVM is canonical.
 *
 * Sigma-rust ref:
 *   ergotree-interpreter/src/eval/subst_const.rs:18-89  (top-level eval impl)
 *   ergotree-ir/src/ergo_tree.rs:45-70                  (ParsedErgoTree::with_constant)
 *
 * Pseudocode (mirrors sigma-rust):
 *     script_bytes_v = scriptBytes.eval(env, ctx)        // child eval
 *     positions_v    = positions.eval(env, ctx)          // child eval
 *     new_values_v   = newValues.eval(env, ctx)          // child eval
 *     ... extract positions: number[] ...                 // Coll[Int] guard
 *     ... extract new_constants: SValue[] ...             // Coll[_]  guard
 *     if positions.length !== new_constants.length: throw 'subst-constants-error'
 *     ... extract script_bytes: Uint8Array ...            // Coll[Byte] guard
 *     ergo_tree = parseTree(script_bytes)                 // wire-layer error → 'subst-constants-error'
 *     ctx.addPerItemCost(100, 100, 1, ergo_tree.constants.length)   // Pattern B; template-sized
 *     for (ix, i) in positions.entries():
 *       if i < 0 || i >= ergo_tree.constants.length: continue   // JVM no-op (getPositionsBackref:294), NOT a throw
 *       if newValues.elem !== ergo_tree.constantTypes[i]: throw 'subst-constants-error'  // structural sType-equality
 *       ergo_tree.constants[i] = new_constants[ix]        // defensive deep copy
 *     return Coll[Byte] of serializeTree(ergo_tree)
 *
 * Cost-charging order: Pattern B (charged after the type-guards / parseTree,
 * before the substitution loop). Sized by the TEMPLATE'S `constants.length`,
 * NOT the caller-supplied `positions.length`. The bug-3 regression test at
 * sigma-rust subst_const.rs:221-283 fixes this: substituting 1 vs 3 positions
 * on a 3-const template must yield identical SubstConstants cost.
 *
 * Output byte-equality guarantee: serializeTree(parseTree(b)) ≡ b on all 255
 * corpus fixtures and 6,221 parse-mutation entries. Substituting
 * `constants[i] := new_constants[ix]` keeps the constant_types list invariant
 * (the structural type check enforces this) and changes only the constant's
 * serialized form in the constants section; the body bytes are untouched. So
 * for any tree whose original encoding our serializeTree round-trips
 * byte-exactly, the substituted-output bytes match sigma-rust byte-for-byte
 * — verified end-to-end by the byte-equality canary in
 * `test/eval/subst-constants.test.ts`.
 *
 * Single compact error code: `'subst-constants-error'` covers the remaining
 * throw paths (per the 2g.5 compact-taxonomy decision); the out-of-range
 * position path is now a no-op (JVM parity), not a throw. Externally callers
 * distinguish the throws via `error.message` text. The throw paths are
 * enumerated in `eval/errors.ts` under the `'subst-constants-error'` docs.
 *
 * Build-time type guards: `SubstConstants::new` in sigma-rust validates
 * `script_bytes : SColl(SByte)`, `positions : SColl(SInt)`, and
 * `new_values : SColl(_)` at MIR construction, so parser-produced trees
 * cannot reach the shape-guards in this handler. The TS-side guards remain
 * for defense against `ConstantPlaceholder` injection / hand-crafted MIR
 * (calc_blake2b256 / byte_array_to_long precedent).
 */

import type { ErgoTree, SubstConstants, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue, collByteToUint8Array } from './_byte-coll'
import { extractCollInt } from './_coll-helpers'
import { sTypeEquals } from '../mir/stype-helpers'
import { parseTree, serializeTree } from '../wire/ergo-tree'

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

  // 4. Length match (sigma-rust subst_const.rs:49-55).
  if (positions.length !== newValuesV.items.length) {
    throw new EvalError(
      `SubstConstants: positions.length (${positions.length}) !== new_values.length (${newValuesV.items.length})`,
      'subst-constants-error',
    )
  }

  // 5. Parse the embedded template. Any wire-layer error → 'subst-constants-error'.
  //    This is consensus-critical: the template bytes are the same bytes the
  //    rest of the system expects to round-trip; reusing parseTree keeps the
  //    output bytes bit-identical to sigma-rust (validated by 255 corpus
  //    fixtures + 6,221 parse-mutation tests).
  let tree: ErgoTree
  try {
    tree = parseTree(scriptBytes)
  } catch (cause) {
    throw new EvalError(
      `SubstConstants: bad template bytes — ${(cause as Error).message}`,
      'subst-constants-error',
    )
  }

  // 6. Pattern B cost: AFTER parse, BEFORE substitution. Sized by
  //    `tree.constants.length`, NOT `positions.length` (sigma-rust
  //    subst_const.rs:65; bug-3 regression at subst_const.rs:221-283).
  ctx.addPerItemCost(100, 100, 1, tree.constants.length)

  // 7. Substitute. Validate position bounds + structural type-equality per
  //    iteration. Defensive deep copy on the constants array — never mutate
  //    the input tree's arrays in place (the input tree may be shared with
  //    other evaluations under hand-crafted MIR or future caller caching).
  const newConstants = [...tree.constants]
  for (let ix = 0; ix < positions.length; ix++) {
    const i = positions[ix]!
    // JVM `ErgoTreeSerializer.getPositionsBackref` (ErgoTreeSerializer.scala:294)
    // guards `0 <= pos && pos < nConstants`: any out-of-range position — negative
    // OR too-large — is silently SKIPPED (no substitution, no error), so the
    // template bytes pass through unchanged. sigma-rust `subst_const.rs:71-77`
    // and our prior code both *errored* here — a divergence from JVM (SANTA v5
    // substConstants #0/#2/#3/#6; routed to sigma-rust in
    // `~/projects/santa/prompts/ergots-v5-divergences.md` §A2). JVM is canonical.
    if (i < 0 || i >= tree.constants.length) {
      continue
    }
    // new_values.elem is the declared Coll element type; compare to the
    // original constant's stored SType. Mirrors sigma-rust ergo_tree.rs:51
    // (the `constant.tpe == old_constant.tpe` check inside with_constant).
    // sTypeEquals is recursive (stype-helpers.ts:48), so nested types
    // (Coll[Coll[Byte]], Tuple of varied items, SOption[T]) compare deeply.
    if (!sTypeEquals(newValuesV.elem, tree.constantTypes[i]!)) {
      throw new EvalError(
        `SubstConstants: type mismatch at position ${i} (new_values elem vs original)`,
        'subst-constants-error',
      )
    }
    newConstants[i] = newValuesV.items[ix]!
  }

  // 8. Re-serialize. Byte-equality with sigma-rust is guaranteed by the
  //    round-trip property of parseTree/serializeTree (see file-level docstring).
  const newTree: ErgoTree = { ...tree, constants: newConstants }
  try {
    return bytesToCollByteSValue(serializeTree(newTree))
  } catch (cause) {
    throw new EvalError(
      `SubstConstants: re-serialize failed — ${(cause as Error).message}`,
      'subst-constants-error',
    )
  }
}
