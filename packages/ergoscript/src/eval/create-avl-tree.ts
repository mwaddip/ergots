/**
 * CreateAvlTree eval arm — no inline cost (children-only).
 *
 * Source: ergotree-interpreter/src/eval/create_avl_tree.rs:15-41
 *         ergotree-ir/src/mir/create_avl_tree.rs:31-59 (MIR struct + build-time guards)
 *         ergotree-ir/src/mir/avl_tree_data.rs:32-38 (AvlTreeFlags::parse + ::new)
 *
 * Eval order (sigma-rust line-for-line): flags → digest → keyLength →
 * (optional) valueLength → construct AvlTreeData. NO add_jit_cost call —
 * children eval their own costs.
 *
 * Two CRITICAL load-bearing invariants from the spec:
 *
 * 1. **AvlTreeFlags canonicalization — `flagsV.value & 0x07`** (spec Risk
 *    Hotspot 5b). Sigma-rust's `AvlTreeFlags::parse(u8)` masks input to bits
 *    0..2 only (insert/update/remove), then `AvlTreeFlags::new(...)`
 *    reconstructs the u8 from those 3 bits — so input 0xFF round-trips
 *    through `parse → new` to 0x07. The stored `AvlTreeData.tree_flags`
 *    holds this canonicalized 3-bit form (oracle equality target).
 *
 *    NOTE this DIVERGES from the wire-parse path (phase 2h-b's
 *    `parseSValue(SAvlTree, …)`) which preserves all 8 bits on round-trip.
 *    The two paths legitimately diverge for u8 inputs with bits 3..7 set:
 *    wire-parse keeps all bits, CreateAvlTree-eval masks to 3 bits. Both
 *    correctly mirror sigma-rust's separate code paths.
 *
 *    Fixture `cat_flags_FF_canonicalize` is the canary: input flags=0xFF
 *    (encoded as i8 = -1), oracle expects `AvlTreeData.treeFlags === 0x07`.
 *    Without the `& 0x07` mask, this fixture FAILS.
 *
 * 2. **KeyLength bit-cast — `keyLengthV.value >>> 0`** (spec Risk Hotspot 5).
 *    Sigma-rust does `try_extract_into::<i32>()? as u32` — a BIT-CAST, not a
 *    range check. Negative i32 (e.g., -1) silently becomes a huge u32
 *    (4294967295). The `cat_negative_keylength` fixture validates: input
 *    i32::MIN = -2147483648, oracle expects keyLength=2147483648 in
 *    AvlTreeData. Same rule applies to `valueLength.value >>> 0`.
 *
 * Build-time type guard: `CreateAvlTree::new` (sigma-rust
 * `ergotree-ir/src/mir/create_avl_tree.rs:31-59`) enforces:
 *   flags     : SByte
 *   digest    : SColl(SByte)
 *   keyLength : SInt
 *   valueLen  : Option[SInt]
 * Non-conforming inputs cannot be serialized via the standard path. The TS-
 * side `'create-avl-tree-shape-mismatch'` / `'predef-input-not-byte-array'`
 * assertions are defensive against `ConstantPlaceholder` injection or hand-
 * crafted MIR (multiply_group / exponentiate throw-entry precedent).
 *
 * Digest length: sigma-rust's `ADDigest::try_from` (ergo-chain-types/src/
 * digest32.rs:132-139) enforces exactly 33 bytes (32-byte root hash +
 * 1 tree-height byte). Length mismatch surfaces as
 * `EvalError::AvlTree("...")` in sigma-rust (mapped via `map_eval_err` at
 * create_avl_tree.rs:43-45). We mirror with `'avl-tree-bad-digest-length'`
 * (already used by the SAvlTree.updateDigest arm in phase 2h-d).
 */

import type { CreateAvlTree, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { collByteToUint8Array } from './_byte-coll'

export function evalCreateAvlTree(
  e: CreateAvlTree,
  env: Env,
  ctx: EvalContext,
): SValue {
  // No inline cost — children-only (sigma-rust create_avl_tree.rs has no
  // add_jit_cost call).

  // 1. flags: Byte → u8 → canonicalized 3-bit form (& 0x07)
  const flagsV = evalExpr(e.flags, env, ctx)
  if (flagsV.kind !== 'Byte') {
    throw new EvalError(
      `CreateAvlTree: expected Byte flags, got '${flagsV.kind}'`,
      'create-avl-tree-shape-mismatch',
    )
  }
  // Canonicalize to bits 0..2 (matches sigma-rust AvlTreeFlags::parse → new
  // which strips reserved bits 3..7). See spec Risk Hotspot 5b.
  const treeFlags = flagsV.value & 0x07

  // 2. digest: Coll[Byte] → 33 bytes
  const digestV = evalExpr(e.digest, env, ctx)
  const digest = collByteToUint8Array(digestV, 'CreateAvlTree')
  if (digest.length !== 33) {
    throw new EvalError(
      `CreateAvlTree: digest must be 33 bytes (32-byte root + 1-byte tree height), got ${digest.length}`,
      'avl-tree-bad-digest-length',
    )
  }

  // 3. keyLength: Int → u32 (bit-cast via >>> 0). Matches sigma-rust
  //    `try_extract_into::<i32>()? as u32` — negative i32 → huge u32. See
  //    spec Risk Hotspot 5.
  const keyLengthV = evalExpr(e.keyLength, env, ctx)
  if (keyLengthV.kind !== 'Int') {
    throw new EvalError(
      `CreateAvlTree: expected Int keyLength, got '${keyLengthV.kind}'`,
      'create-avl-tree-shape-mismatch',
    )
  }
  const keyLength = keyLengthV.value >>> 0

  // 4. valueLength: Option[Int] → number | null. Same i32 → u32 bit-cast
  //    as keyLength.
  let valueLengthOpt: number | null = null
  if (e.valueLength !== null) {
    const vlenV = evalExpr(e.valueLength, env, ctx)
    if (vlenV.kind !== 'Int') {
      throw new EvalError(
        `CreateAvlTree: expected Int valueLength, got '${vlenV.kind}'`,
        'create-avl-tree-shape-mismatch',
      )
    }
    valueLengthOpt = vlenV.value >>> 0
  }

  return {
    kind: 'AvlTree',
    value: {
      digest, // freshly-allocated Uint8Array from collByteToUint8Array
      treeFlags,
      keyLength,
      valueLengthOpt,
    },
  }
}
