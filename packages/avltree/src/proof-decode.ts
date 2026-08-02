/**
 * Packed post-order tree reconstruction from a serialized AD-proof.
 *
 * Ports `BatchAVLVerifier::reconstruct_tree` from
 *   ~/projects/ergo_avltree_rust/src/batch_avl_verifier.rs (lines 58-143).
 *
 * Token constants come from
 *   ~/projects/ergo_avltree_rust/src/batch_node.rs (lines 14-16):
 *     LEAF_IN_PACKAGED_PROOF       = 2
 *     LABEL_IN_PACKAGED_PROOF      = 3
 *     END_OF_TREE_IN_PACKAGED_PROOF = 4
 *   Any other byte is the balance for an internal-node token, encoded as
 *   `i8`: -1 → 0xff, 0 → 0x00, 1 → 0x01 (see batch_node.rs line 13 comment
 *   "Do not use bytes -1, 0, or 1 -- these are for balance" and line 18
 *   `pub type Balance = i8`).
 *
 * CONSENSUS-CRITICAL — every byte read is bounds-checked. TS `Uint8Array`
 * OOB returns `undefined`, which silently NaN-poisons downstream arithmetic;
 * thus the small reader helpers below return `null` on OOB and the caller
 * short-circuits to `{ ok: false, reason: 'proof-truncated' }`.
 */

import { newInternal, newLabel, newLeaf, label } from './node.js'
import type { AvlNode, Balance } from './node.js'
import type { AvlTreeConfig } from './types.js'
import type { AvlVerifyFailReason } from './errors.js'

// ---------------------------------------------------------------------------
// Token constants — confirmed against batch_node.rs:14-16
// ---------------------------------------------------------------------------

const LEAF_IN_PACKAGED_PROOF = 2
const LABEL_IN_PACKAGED_PROOF = 3
const END_OF_TREE_IN_PACKAGED_PROOF = 4

const DIGEST_LENGTH = 32
/** Starting digest layout: 32-byte root label || 1-byte tree height. */
const STARTING_DIGEST_LENGTH = DIGEST_LENGTH + 1

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface ParseProofOk {
  readonly ok: true
  readonly root: AvlNode
  /** Tree height — derived from `startingDigest[32]`. */
  readonly height: number
  /** Byte offset where the directions bit-string begins (the byte immediately AFTER END_OF_TREE). */
  readonly directionsStart: number
}

export interface ParseProofFail {
  readonly ok: false
  readonly reason: AvlVerifyFailReason
}

export type ParseProofResult = ParseProofOk | ParseProofFail

// ---------------------------------------------------------------------------
// Reader state — a small struct with bounds-checked helpers
// ---------------------------------------------------------------------------

interface ReaderState {
  readonly proof: Uint8Array
  /** Cursor into `proof`. Advances on each read. */
  i: number
}

/** Peek a single byte without advancing. Returns null on OOB. */
function peekU8(s: ReaderState): number | null {
  if (s.i >= s.proof.length) return null
  return s.proof[s.i]!
}

/** Bounds-checked fixed-length byte read. Returns null on OOB. */
function readBytes(s: ReaderState, n: number): Uint8Array | null {
  if (s.i + n > s.proof.length) return null
  // slice() returns an owning copy; node.ts constructors also defensively
  // copy, but we hand off to constructors via slice for clarity.
  const out = s.proof.slice(s.i, s.i + n)
  s.i += n
  return out
}

/** Bounds-checked big-endian unsigned 32-bit read. Returns null on OOB. */
function readU32BE(s: ReaderState): number | null {
  if (s.i + 4 > s.proof.length) return null
  const b0 = s.proof[s.i]!
  const b1 = s.proof[s.i + 1]!
  const b2 = s.proof[s.i + 2]!
  const b3 = s.proof[s.i + 3]!
  s.i += 4
  // Use unsigned-shift identity (`>>> 0`) to map back into [0, 2^32) range.
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0
}

// ---------------------------------------------------------------------------
// Helpers — balance byte interpretation, max-nodes DoS bound
// ---------------------------------------------------------------------------

/**
 * Internal-node token byte → AVL `Balance` ∈ {-1, 0, 1}.
 *
 * Rust source `n as Balance` is a `u8 → i8` reinterpret (line 132). Valid
 * balance bytes are 0x00, 0x01, and 0xff (= -1 under two's complement i8).
 * The Rust prover ONLY emits those three values (batch_node.rs:13 comment).
 * Any other byte that lands in this branch — values 5..=254 — is rejected
 * as `proof-malformed`. (Rust permissively casts and lets digest mismatch
 * downstream; we fail-fast for a cleaner error.)
 */
function balanceFromByte(b: number): Balance | null {
  if (b === 0x00) return 0
  if (b === 0x01) return 1
  if (b === 0xff) return -1
  return null
}

/**
 * Compute the max-nodes DoS upper bound, per
 * batch_avl_verifier.rs lines 63-87 (and KMZ17 Appendix B last paragraph).
 *
 * Returns the bound only when `maxNumOperations` is set; otherwise returns
 * `null` and the caller skips the guard (matching `is_some()` gate on line 99).
 *
 * Formula (all integer math, mirroring the Rust):
 *   logNumOps = smallest k with 2^k >= maxNumOps     // ceil(log2)
 *   temp      = 1 + max(treeHeight, logNumOps)
 *   hnew      = temp + temp / 2                       // floor — Rust integer div
 *   realMaxDeletes = maxDeletes ?? maxNumOps
 *   maxNodes  = (maxNumOps + realMaxDeletes) * (2 * treeHeight + 1)
 *             + realMaxDeletes * hnew
 *             + 1                                     // +1 case maxNumOps == 0
 */
function computeMaxNodes(
  treeHeight: number,
  maxNumOps: number | undefined,
  maxDeletes: number | undefined,
): number | null {
  if (maxNumOps === undefined) return null
  // Rust uses `unwrap_or(0)` for max_num_operations and `unwrap_or(real_num_ops)`
  // for max_deletes (lines 70, 79). Mirror exactly.
  const realNumOps = maxNumOps
  let logNumOps = 0
  let temp = 1
  while (temp < realNumOps) {
    temp = temp * 2
    logNumOps += 1
  }
  temp = 1 + Math.max(treeHeight, logNumOps)
  // Integer division — Math.trunc handles non-negative inputs identically to Rust `/`.
  const hnew = temp + Math.trunc(temp / 2)
  const realMaxDeletes = maxDeletes ?? realNumOps
  return (realNumOps + realMaxDeletes) * (2 * treeHeight + 1)
    + realMaxDeletes * hnew
    + 1
}

// ---------------------------------------------------------------------------
// Public entry — parseProofPackedTree
// ---------------------------------------------------------------------------

/**
 * Decode the proof's packed post-order tree representation, validate the
 * reconstructed root's label against `startingDigest`, and return the root
 * plus the byte offset at which the directions bit-string begins.
 *
 * Ports `BatchAVLVerifier::reconstruct_tree` lines 58-143.
 *
 * Preconditions (returned as fail-results, NOT thrown):
 *   - `config.keyLength > 0`              → otherwise `proof-malformed`
 *   - `startingDigest.length === 33`      → otherwise `proof-malformed`
 *
 * Failure reasons:
 *   - `proof-truncated`   — proof ended while still reading a token field
 *   - `proof-malformed`   — invalid token byte, bad balance byte, malformed stack
 *   - `digest-mismatch`   — reconstructed root.label() != startingDigest[0..32]
 *   - `max-nodes-exceeded`— node count crossed the KMZ17 DoS bound
 */
export function parseProofPackedTree(
  proof: Uint8Array,
  config: AvlTreeConfig,
  startingDigest: Uint8Array,
): ParseProofResult {
  // Pre-flight: shape checks the Rust `ensure!` macros do at line 59-60.
  if (config.keyLength <= 0) return { ok: false, reason: 'proof-malformed' }
  if (startingDigest.length !== STARTING_DIGEST_LENGTH) {
    return { ok: false, reason: 'proof-malformed' }
  }

  // Tree height comes from the last byte of startingDigest (line 61).
  const treeHeight = startingDigest[DIGEST_LENGTH]!
  const maxNodes = computeMaxNodes(treeHeight, config.maxNumOperations, config.maxDeletes)

  // Reconstruct from post-order traversal (lines 88-135).
  const state: ReaderState = { proof, i: 0 }
  // The stack holds reconstructed sub-tree roots. The post-order layout
  // means an internal-node token pops the two most-recent stack entries
  // (right first, then left).
  const stack: AvlNode[] = []
  let previousLeaf: { nextLeafKey: Uint8Array } | null = null
  let numNodes = 0

  // Outer loop: peek-byte-then-decode. The Rust loop conditions on
  // `proof[i] != END_OF_TREE_IN_PACKAGED_PROOF` (line 95), so we peek.
  while (true) {
    const tok = peekU8(state)
    if (tok === null) return { ok: false, reason: 'proof-truncated' }
    if (tok === END_OF_TREE_IN_PACKAGED_PROOF) {
      state.i += 1 // consume the END_OF_TREE token
      break
    }

    // Now we know it's not END_OF_TREE; the Rust increments i to point past
    // the token byte BEFORE entering the match arms (line 97).
    state.i += 1
    numNodes += 1
    if (maxNodes !== null && numNodes > maxNodes) {
      return { ok: false, reason: 'max-nodes-exceeded' }
    }

    if (tok === LABEL_IN_PACKAGED_PROOF) {
      // Line 101-107: read 32-byte digest, push label-only stub.
      const lbl = readBytes(state, DIGEST_LENGTH)
      if (lbl === null) return { ok: false, reason: 'proof-truncated' }
      stack.push(newLabel(lbl))
      // CRITICAL: Rust resets previous_leaf to None ONLY at a LABEL token
      // (line 106). Internal-node builds do NOT reset, so leaf chaining
      // can span across an internal-node build in post-order.
      previousLeaf = null
      continue
    }

    if (tok === LEAF_IN_PACKAGED_PROOF) {
      // Line 108-128.
      // 1. Key: either the previous leaf's nextLeafKey (chaining optimization
      //    line 109-111) or read keyLength bytes from the proof (line 112-115).
      let key: Uint8Array
      if (previousLeaf !== null) {
        // No bytes are consumed — the prover relies on the verifier reusing
        // the prior nextLeafKey to save proof size.
        key = previousLeaf.nextLeafKey
      } else {
        const k = readBytes(state, config.keyLength)
        if (k === null) return { ok: false, reason: 'proof-truncated' }
        key = k
      }

      // 2. nextLeafKey: always reads keyLength bytes (line 116-117).
      const nextLeafKey = readBytes(state, config.keyLength)
      if (nextLeafKey === null) return { ok: false, reason: 'proof-truncated' }

      // 3. Value length & bytes (line 118-124).
      let valueLength: number
      if (config.valueLengthOpt !== null) {
        valueLength = config.valueLengthOpt
      } else {
        // Variable-length value: 4-byte BE u32 length prefix in the proof.
        const vl = readU32BE(state)
        if (vl === null) return { ok: false, reason: 'proof-truncated' }
        valueLength = vl
      }
      if (valueLength < 0) return { ok: false, reason: 'proof-malformed' }
      // JVM scrypto 3.1.1+: reject oversized declared value lengths before
      // attempting the read (DOS guard; matches BatchAVLVerifier require).
      if (valueLength > 4_194_304) return { ok: false, reason: 'proof-malformed' }
      if (valueLength > state.proof.length - state.i) return { ok: false, reason: 'proof-malformed' }
      const value = readBytes(state, valueLength)
      if (value === null) return { ok: false, reason: 'proof-truncated' }

      const leaf = newLeaf(key, value, nextLeafKey)
      stack.push(leaf)
      previousLeaf = { nextLeafKey: leaf.nextLeafKey }
      continue
    }

    // Internal-node token: the byte IS the balance, reinterpreted as i8.
    // Rust line 129-133.
    const balance = balanceFromByte(tok)
    if (balance === null) return { ok: false, reason: 'proof-malformed' }
    // Pop right first, then left (line 130-131).
    const right = stack.pop()
    const left = stack.pop()
    if (right === undefined || left === undefined) {
      return { ok: false, reason: 'proof-malformed' }
    }
    stack.push(newInternal(left, right, balance))
    // No reset of previousLeaf here — see comment above on LABEL branch.
  }

  // Line 137: a well-formed post-order traversal collapses to a single root.
  if (stack.length !== 1) return { ok: false, reason: 'proof-malformed' }
  const root = stack[0]!

  // Line 139: starting_digest.starts_with(rootLabel) — i.e. the first 32 bytes
  // of the 33-byte starting digest equal the root's blake2b-256 label.
  const rootLabel = label(root)
  for (let j = 0; j < DIGEST_LENGTH; j += 1) {
    if (rootLabel[j] !== startingDigest[j]) {
      return { ok: false, reason: 'digest-mismatch' }
    }
  }

  // Line 141: directions begin at the byte immediately AFTER END_OF_TREE.
  // Rust stores `(i + 1) * 8` (a bit-index); we return the byte index.
  // At this point `state.i` already points to the byte after END_OF_TREE
  // (we consumed END_OF_TREE on the break path above).
  return {
    ok: true,
    root,
    height: treeHeight,
    directionsStart: state.i,
  }
}
