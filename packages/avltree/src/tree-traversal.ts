import type { LeafNode } from './node.js'
import type { AvlVerifyFailReason } from './errors.js'
import { type KeyMatchesResult } from './avl-tree-ops.js'
import { compareBytes } from './compare-bytes.js'
// Re-export so existing consumers don't break
export type { KeyMatchesResult }

/**
 * Mutable verifier traversal state. Mirrors the directions/replay indices
 * on BatchAVLVerifier (batch_avl_verifier.rs lines 30-37 @568e7c3).
 *
 * `failedReason` is a TS-only out-channel for surfacing OOB reads from
 * `nextDirectionIsLeft` / `replayComparison`. The Rust verifier indexes a
 * slice and panics on OOB; we set this field instead and let the caller
 * propagate it as a verifier failure (audit AVL-01). Always null on entry
 * to a fresh op; set to 'directions-exhausted' when a bit read runs past
 * `proof.length`.
 */
export interface TraversalState {
  directionsIndex: number
  lastRightStep: number
  replayIndex: number
  failedReason: AvlVerifyFailReason | null
}

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier::next_direction_is_left (lines 230-241 @568e7c3).
 * Reads one bit from the proof's "directions" bit-string at position
 * state.directionsIndex; advances the index by 1. Returns true if the bit is set
 * (left), false otherwise (right) — also updates state.lastRightStep when right.
 *
 * Bit indexing: byte offset = i >> 3; bit offset = 1 << (i & 7).
 * This is LSB-first ordering within each byte — matches Rust exactly.
 * Do NOT use 1 << (7 - (i & 7)) (MSB-first); that would diverge from the reference.
 *
 * Bounds (audit AVL-01): out-of-bounds reads set `state.failedReason =
 * 'directions-exhausted'` instead of silently returning 0. The function still
 * returns `false` (a default "go right") so the caller can finish its expression
 * cleanly; callers MUST check `state.failedReason` after this call and
 * propagate as a verifier failure.
 */
export function nextDirectionIsLeft(
  proof: Uint8Array,
  state: TraversalState,
): boolean {
  const i = state.directionsIndex
  const byteOffset = i >> 3
  if (byteOffset >= proof.length) {
    state.failedReason = 'directions-exhausted'
    state.directionsIndex = i + 1
    return false
  }
  const byte = proof[byteOffset]!
  const left = (byte & (1 << (i & 7))) !== 0
  if (!left) state.lastRightStep = i
  state.directionsIndex = i + 1
  return left
}

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier::replay_comparison (lines 277-289 @568e7c3).
 *
 * Deletions traverse the tree twice: once to find the leaf, once to perform the
 * deletion. This method re-creates the comparison results from the first pass by
 * reading bits from the proof's directions bit-string and comparing with
 * lastRightStep. Each call advances replayIndex by 1.
 *
 * Three-way return:
 *   0  — replayIndex === lastRightStep (was the deepest right step; key == node.key)
 *   1  — bit at replayIndex is 0 AND replayIndex < lastRightStep (went left; key > node.key)
 *  -1  — otherwise (went right but not the deepest right, or bit set; key < node.key)
 *
 * Bit indexing: byte offset = i >> 3; bit offset = 1 << (i & 7). LSB-first, matching Rust.
 */
export function replayComparison(
  proof: Uint8Array,
  state: TraversalState,
): -1 | 0 | 1 {
  const i = state.replayIndex
  let ret: -1 | 0 | 1
  if (i === state.lastRightStep) {
    ret = 0
  } else {
    const byteOffset = i >> 3
    if (byteOffset >= proof.length) {
      // Audit AVL-01: OOB read sets state.failedReason; caller must check and propagate.
      state.failedReason = 'directions-exhausted'
      state.replayIndex = i + 1
      return -1
    }
    const byte = proof[byteOffset]!
    const bit = (byte & (1 << (i & 7))) !== 0
    if (!bit && i < state.lastRightStep) ret = 1
    else ret = -1
  }
  state.replayIndex = i + 1
  return ret
}

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier::key_matches_leaf (lines 251-265 @568e7c3).
 *
 * The verifier does not store keys in internal nodes, so it must check the
 * key against the leaf's range during operation execution. This function asserts
 * that the key lies in [leaf.key, leaf.nextLeafKey) and returns whether it is
 * exactly equal to leaf.key.
 *
 * Returns:
 *   { ok: true, matches: true }  — key === leaf.key (exact match; found the leaf)
 *   { ok: true, matches: false } — leaf.key < key < leaf.nextLeafKey (not found, but valid position)
 *   { ok: false, reason: 'leaf-key-out-of-order' } — key outside [leaf.key, leaf.nextLeafKey); proof corrupt
 *
 * See https://eprint.iacr.org/2016/994 Appendix B, paragraph "Our Algorithms".
 */
export function keyMatchesLeaf(key: Uint8Array, leaf: LeafNode): KeyMatchesResult {
  const cmpLeaf = compareBytes(key, leaf.key)
  if (cmpLeaf === 0) return { ok: true, matches: true }
  // key != leaf.key: assert key > leaf.key (Rust: ensure!(*key > *leaf_key))
  if (cmpLeaf < 0) return { ok: false, reason: 'leaf-key-out-of-order' }
  // key > leaf.key: assert key < leaf.nextLeafKey (Rust: ensure!(*key < leaf.next_node_key))
  if (compareBytes(key, leaf.nextLeafKey) >= 0) return { ok: false, reason: 'leaf-key-out-of-order' }
  return { ok: true, matches: false }
}
