/**
 * XorOf arm — reduces Coll[Boolean] to Boolean via XOR, with
 * tree-version-dependent semantics.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/xor_of.rs:12-36
 *   let input_v = self.input.eval(env, ctx)?;
 *   let input_v_bools = input_v.try_extract_into::<Vec<bool>>()?;
 *   ctx.add_per_item_jit_cost(20, 5, 32, input_v_bools.len() as u32)?;
 *   if ctx.tree_version() < V2 {
 *       // JVM v4.x bug: has_true && has_false (count-independent)
 *   } else {
 *       // Correct left-fold XOR: true iff odd count of trues
 *   }
 *
 * Tree-version-dependent semantics:
 *   V0/V1: JVM v4.x bug — returns true iff the Coll contains BOTH true
 *     and false (count-independent). xorOf([true, true, false]) → true.
 *   V2+:   Correct left-fold XOR — true iff odd count of trues.
 *     xorOf([true, true, false]) → false (2 trues = even).
 *
 * Reads ctx.treeVersion ?? 0 (V0 default; most-restrictive fallback per
 * phase 2e EvalContext contract). V0/V1 uses the bug branch; V2+ uses
 * correct XOR.
 *
 * Cost: addPerItemCost(20, 5, 32, n) per xor_of.rs:20. Charged AFTER
 * eval-child (Cast pattern, same as slice B's And/Or arms). Cost is
 * identical regardless of which branch is taken; only the reducer
 * differs.
 *
 * Closes out the third originally-deferred item in the
 * project_treeversion_gating_deferred memory (XorOf was wholly deferred
 * pending the treeVersion field; that field landed in Task 1 of phase 2e).
 *
 * Defensive kind-check throws 'coll-not-boolean' (reused from slice B's
 * And/Or arms per the YAGNI note in or.ts: promote to shared helper when
 * a third caller appears — this is that third caller, but the note
 * explicitly names XorOf as covered by the "later phase" deferral, so
 * we keep the inline check here per slice B's precedent).
 */

import type { SValue, XorOf } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// Cost source: ergotree-interpreter/src/eval/xor_of.rs:20
//   ctx.add_per_item_jit_cost(20, 5, 32, input_v_bools.len() as u32)?;
const XOR_OF_BASE_COST = 20
const XOR_OF_PER_CHUNK_COST = 5
const XOR_OF_CHUNK_SIZE = 32

export function evalXorOf(e: XorOf, env: Env, ctx: EvalContext): SValue {
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'Coll') {
    throw new EvalError(
      `XorOf: expected Coll[Boolean] input, got '${input.kind}'`,
      'coll-not-boolean'
    )
  }
  const items = input.items
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.kind !== 'Boolean') {
      throw new EvalError(
        `XorOf: Coll item ${i} has kind '${items[i]!.kind}', expected 'Boolean'`,
        'coll-not-boolean'
      )
    }
  }
  ctx.addPerItemCost(XOR_OF_BASE_COST, XOR_OF_PER_CHUNK_COST, XOR_OF_CHUNK_SIZE, items.length)
  const v = ctx.treeVersion ?? 0
  let result: boolean
  if (v < 2) {
    // JVM v4.x bug: true iff Coll contains both true and false
    // (count and order independent). Short-circuits when both seen.
    let hasTrue = false
    let hasFalse = false
    for (let i = 0; i < items.length; i++) {
      if ((items[i] as { kind: 'Boolean'; value: boolean }).value) {
        hasTrue = true
      } else {
        hasFalse = true
      }
      if (hasTrue && hasFalse) break
    }
    result = hasTrue && hasFalse
  } else {
    // Correct left-fold XOR: true iff odd count of trues.
    // sigma-rust: input_v_bools.into_iter().fold(false, |a, b| a ^ b)
    result = items.reduce<boolean>(
      (acc, it) => acc !== (it as { kind: 'Boolean'; value: boolean }).value,
      false
    )
  }
  return { kind: 'Boolean', value: result }
}
