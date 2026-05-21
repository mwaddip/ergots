/**
 * TreeLookup eval arm — no inline cost (children-only + verifier delegate).
 *
 * Source: ergotree-interpreter/src/eval/tree_lookup.rs:20-65
 *         (with helpers `map_eval_err` lines 67-69).
 *
 * Eval order (sigma-rust line-for-line): tree → key → proof → BatchAVLVerifier::new →
 * perform_one_operation(Lookup). NO add_jit_cost call — children eval their
 * own costs; the verifier itself is uncosted from this arm's perspective.
 *
 * Verifier wiring: thin wrap over `@ergots/avltree` v0.2.0's
 * `verifyAvlLookup(startingDigest, proof, config, key)`. The package's
 * return semantic distinguishes proof failure from key-absent (facts/avltree.md:70-76):
 *
 *   - `result === null`           → proof construct fail (decode error, digest
 *                                   mismatch, malformed bytes, per-op error).
 *                                   TS throws 'avl-tree-proof-failed' to mirror
 *                                   sigma-rust's `Err(EvalError::AvlTree(...))`
 *                                   at tree_lookup.rs:59-63.
 *   - `result.value === null`     → proof verified, key ABSENT → Option None
 *                                   (sigma-rust line 57: `Ok(Value::Opt(None))`).
 *   - `result.value: Uint8Array`  → proof verified, key FOUND → Option Some<Coll[Byte]>
 *                                   (sigma-rust line 56:
 *                                   `Ok(Value::Opt(Some(Box::new(v.to_vec().into()))))`).
 *
 * The double-null distinction is CONSENSUS-CRITICAL: a handler confusing
 * inner-null with outer-null would silently mis-route malformed proofs to
 * Option None — Ergo nodes accepting transactions the network rejects, or
 * vice-versa. The fixture matrix `tl_absent_in_10_leaf` (Option None) vs
 * `tl_throw_malformed_proof`/`tl_throw_wrong_digest` (throws) is the canary.
 *
 * Reused error codes (ZERO new codes):
 *   - 'avl-tree-obj-not-avl-tree'     — receiver kind check (phase 2h-b precedent)
 *   - 'predef-input-not-byte-array'   — key / proof shape check (2i-a default
 *                                       on `collByteToUint8Array`)
 *   - 'avl-tree-proof-failed'         — verifier failure (2h-b precedent)
 *
 * Build-time type guard: `TreeLookup::new` (sigma-rust
 * `ergotree-ir/src/mir/tree_lookup.rs`) enforces:
 *   tree  : SAvlTree
 *   key   : SColl(SByte)
 *   proof : SColl(SByte)
 * at construction. The TS-side kind/shape assertions are defensive against
 * `ConstantPlaceholder` injection or hand-crafted MIR (multiply_group /
 * exponentiate / create_avl_tree throw-entry precedent).
 */

import type { SType, SValue, TreeLookup } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { bytesToCollByteSValue, collByteToUint8Array } from './_byte-coll'
import { avlTreeDataToConfig } from './_avltree-adapter'
import { verifyAvlLookup } from '@ergots/avltree'

const SCOLL_BYTE: SType = { tag: 'SColl', elem: { tag: 'SByte' } }

export function evalTreeLookup(
  e: TreeLookup,
  env: Env,
  ctx: EvalContext,
): SValue {
  // No inline cost — children-only (sigma-rust tree_lookup.rs has no
  // add_jit_cost call).

  // 1. tree: must evaluate to AvlTree.
  const treeV = evalExpr(e.tree, env, ctx)
  if (treeV.kind !== 'AvlTree') {
    throw new EvalError(
      `TreeLookup: expected AvlTree receiver, got '${treeV.kind}'`,
      'avl-tree-obj-not-avl-tree',
    )
  }

  // 2. key: Coll[Byte] → Uint8Array.
  const keyV = evalExpr(e.key, env, ctx)
  const key = collByteToUint8Array(keyV, 'TreeLookup')

  // 3. proof: Coll[Byte] → Uint8Array.
  const proofV = evalExpr(e.proof, env, ctx)
  const proof = collByteToUint8Array(proofV, 'TreeLookup')

  // 4. Verifier delegate.
  const config = avlTreeDataToConfig(treeV.value)
  const startingDigest = treeV.value.digest
  const result = verifyAvlLookup(startingDigest, proof, config, key)

  // OUTER null: proof construct fail / digest mismatch / per-op error.
  // Mirrors sigma-rust's `Err(EvalError::AvlTree(...))` at tree_lookup.rs:59-63.
  if (result === null) {
    throw new EvalError(
      `TreeLookup: tree proof verification failed`,
      'avl-tree-proof-failed',
    )
  }

  // INNER null vs Uint8Array: key absent (Option None) vs key found (Option Some).
  // Mirrors sigma-rust's `match opt` at tree_lookup.rs:55-58.
  return {
    kind: 'Option',
    elem: SCOLL_BYTE,
    value: result.value === null ? null : bytesToCollByteSValue(result.value),
  }
}
