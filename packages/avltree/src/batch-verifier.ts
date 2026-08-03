/**
 * BatchAvlVerifier — internal orchestrator that ties together proof decoding,
 * per-operation modification (modify.ts), and structural deletion (delete.ts).
 *
 * Ports ergo_avltree_rust/src/batch_avl_verifier.rs::BatchAVLVerifier:
 *   - struct (lines 21-34)
 *   - constructor `new` (lines 37-55) + `reconstruct_tree` (lines 58-143; the
 *     latter lives in proof-decode.ts and is invoked from the constructor)
 *   - `perform_one_operation` (lines 157-172)
 * PLUS the orchestration recipe from authenticated_tree_ops.rs::
 *   - `return_result_of_one_operation` (lines 221-248)
 *
 * CONSENSUS-CRITICAL — the modify_helper → delete_helper dispatch, the proof
 * traversal state lifecycle, and the height bookkeeping must match the Rust
 * reference exactly. Off-by-one in the directions/replay indices or skipping
 * the needsDelete handoff would silently diverge downstream digests.
 *
 * Per the design spec (docs/specs/2026-05-18-ergots-avltree-package-design.md),
 * this class is INTERNAL on v0.1.0 — consumers use `verifyAvlBatch` /
 * `verifyAvlLookup` (T18+T19) which wrap this. Key/value LENGTH validation
 * lives in those wrappers (throws, documented contract). The references'
 * two strict ±inf bounds requires (Rust `ensure!`s at
 * authenticated_tree_ops.rs:267-268 @d18773c; scrypto's identical requires)
 * are enforced HERE at the top of performOneOperation as fail-and-poison
 * ('key-out-of-bounds') — task 6g. Beyond those per-op gates, once
 * construction finishes this class trusts the inputs and operates on bytes.
 *
 * @see ~/projects/ergo_avltree_rust/src/batch_avl_verifier.rs
 * @see ~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs (lines 221-248)
 */

import { parseProofPackedTree } from './proof-decode.js'
import { modifyHelper } from './modify.js'
import { deleteHelper } from './delete.js'
import { label, type AvlNode } from './node.js'
import type { InternalNode, LeafNode } from './node.js'
import { nextDirectionIsLeft, keyMatchesLeaf, replayComparison, type TraversalState } from './tree-traversal.js'
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import type { Operation } from './operation.js'
import type { AvlTreeConfig } from './types.js'
import type { AvlVerifyFailReason } from './errors.js'

/**
 * Constants — mirrors `DIGEST_LENGTH` from the Rust source.
 * 32 bytes of blake2b-256 + 1 height byte = 33 bytes for the digest tuple.
 */
const DIGEST_LENGTH = 32

/**
 * Lexicographic comparison of two Uint8Arrays. Returns -1, 0, or 1.
 * Fourth private copy in the package (batch-prover.ts, persistent-prover.ts,
 * tree-traversal.ts carry the others) — Phase C consolidates them.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length)
  for (let i = 0; i < min; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return -1
    if ((a[i] ?? 0) > (b[i] ?? 0)) return 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/**
 * Ports batch_avl_verifier.rs::BatchAVLVerifier (struct + impl), the integration
 * layer of the AVL+ verifier. Holds the proof-bytes + config + reconstructed
 * tree state, and exposes `performOneOperation` for the caller.
 *
 * Lifecycle:
 *   1. `new BatchAvlVerifier(startingDigest, proof, config)` — runs
 *      proof-decode to reconstruct the tree. On failure `root === null` and
 *      `lastFailReason` is set; `isValid` returns false.
 *   2. `performOneOperation(op)` — applies one operation:
 *        - If the tree is already poisoned (`root === null`), returns
 *          `{ failed: true }` without touching state.
 *        - Otherwise dispatches modify_helper → (optional) delete_helper per
 *          the Rust `return_result_of_one_operation` recipe.
 *        - On failure, sets `root = null` (poisoning), records
 *          `lastFailReason`, returns `{ failed: true }`.
 *        - On success, updates `root` and `height`, returns the old value
 *          (Uint8Array if the key existed, `null` if absent).
 *   3. `digest()` — computes the current 33-byte digest, or null if poisoned.
 *
 * `lastFailReason` is set on any failure path (proof decode, modifyHelper,
 * deleteHelper, or tree-poisoned re-entry). Tracked publicly as a debugging
 * aid; the design spec defers exposing it on the v0.1.0 public surface
 * (option-3 decision; see errors.ts § AvlVerifyFailReason).
 */
export class BatchAvlVerifier {
  /** The serialized AD proof (packed post-order tree + directions bit-string). */
  readonly proof: Uint8Array
  /** Tree config (keyLength, valueLengthOpt, DoS bounds). */
  readonly config: AvlTreeConfig
  /**
   * The current root node, or `null` after a verification failure (poisoned).
   * Mirrors `self.base.tree.root` in Rust (line 168: set to None on failure).
   */
  root: AvlNode | null
  /**
   * The current tree height. Set from `startingDigest[32]` on construction
   * (Rust line 61) and updated by `performOneOperation` via
   * `heightDelta` from modify/delete results.
   */
  height: number
  /**
   * Internal failure reason (option-3: not exposed publicly on v0.1.0 per the
   * design spec — to be promoted to a getter when/if this class is exposed).
   * Set on:
   *   - construction-time proof-decode failure (reason from parseProofPackedTree)
   *   - performOneOperation failure (reason from modifyHelper / deleteHelper)
   *   - re-entry on a poisoned tree ('tree-poisoned')
   */
  lastFailReason: AvlVerifyFailReason | null = null

  /** −inf sentinel key (0x00 × config.keyLength). Op keys must sort STRICTLY above. */
  private readonly negInfKey: Uint8Array
  /** +inf sentinel key (0xFF × config.keyLength). Op keys must sort STRICTLY below. */
  private readonly posInfKey: Uint8Array

  /**
   * Verifier traversal state — proof-byte cursor (directionsIndex), deepest
   * right-step (lastRightStep), and delete-pass replay cursor (replayIndex).
   * Mirrors the three indices on the Rust struct (lines 28, 31, 33).
   * Private so external callers can't corrupt state.
   *
   * All three indices are BIT INDICES (not byte indices), per the Rust
   * `proof[i >> 3] & (1 << (i & 7))` indexing convention.
   */
  private state: TraversalState

  /**
   * Ports BatchAVLVerifier::new (lines 37-55) + reconstruct_tree (lines 58-143).
   *
   * The reconstruct_tree port lives in `proof-decode.ts::parseProofPackedTree`
   * — it returns the root, height, and the directions bit-string start
   * offset (as a BYTE INDEX). The constructor here converts that byte index to
   * a BIT INDEX (× 8) before storing in `state.directionsIndex`, matching the
   * Rust `self.directions_index = (i + 1) * 8` (line 141).
   *
   * Failure handling: on parseProofPackedTree failure, `root` stays null,
   * `lastFailReason` is set, and `isValid` returns false. Callers (verifyAvlBatch)
   * MUST check `isValid` (or equivalently `root !== null`) before issuing
   * operations — otherwise performOneOperation returns `{ failed: true }`.
   */
  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig) {
    this.proof = proof
    this.config = config
    this.negInfKey = new Uint8Array(config.keyLength)
    this.posInfKey = new Uint8Array(config.keyLength).fill(0xff)
    // Rust struct init (lines 44-52): directions_index=0, last_right_step=0,
    // replay_index=0. We replicate the same triple-zero init; directionsIndex
    // is set to the post-tree byte position after parseProofPackedTree below.
    this.state = { directionsIndex: 0, lastRightStep: 0, replayIndex: 0, failedReason: null }
    this.root = null
    this.height = 0

    const decoded = parseProofPackedTree(proof, config, startingDigest)
    if (!decoded.ok) {
      // Mirrors Rust line 53 `?` operator: `reconstruct_tree` returning Err
      // propagates out of `new`. We don't throw — the design spec routes
      // proof-decode failure into a null-root state (caller checks isValid).
      this.lastFailReason = decoded.reason
      return
    }
    this.root = decoded.root
    this.height = decoded.height
    // CRITICAL CONVERSION — directionsStart is the BYTE index immediately
    // after END_OF_TREE; the Rust source stores it as a BIT index (line 141:
    // `(i + 1) * 8`). The directions bit-string starts at that bit position.
    // Without this `× 8` the verifier would read directions from inside the
    // tree-bytes region and produce digest-mismatch on every multi-internal-
    // node fixture.
    this.state.directionsIndex = decoded.directionsStart * 8
  }

  /** True if the constructor's proof decoding succeeded (root is non-null). */
  get isValid(): boolean {
    return this.root !== null
  }

  /**
   * Build verifier-specific callbacks that consume from the proof's
   * directions bit-string. Each callback closes over this.proof and
   * this.state for the current operation's traversal.
   *
   * The verifier reads direction from proof bytes (not by comparing keys),
   * so nextDirectionIsLeft ignores its `key` and `r` parameters. The prover's
   * implementation of the same callback WILL use them.
   */
  private buildCallbacks(_op: Operation): AvlTreeOpsCallbacks {
    const proof = this.proof
    const state = this.state
    return {
      nextDirectionIsLeft: (_key: Uint8Array, _r: InternalNode) => {
        return nextDirectionIsLeft(proof, state)
      },
      keyMatchesLeaf: (key: Uint8Array, leaf: LeafNode) => {
        return keyMatchesLeaf(key, leaf)
      },
      replayComparison: () => {
        return replayComparison(proof, state)
      },
      onNodeVisit: (_node: AvlNode, _operation: Operation, _isRotate: boolean) => {
        // Verifier: no-op — doesn't track modified nodes
      },
      getFailedReason: () => state.failedReason,
    }
  }

  /**
   * Ports BatchAVLVerifier::perform_one_operation (lines 157-172) plus the
   * orchestration body from authenticated_tree_ops.rs::
   * return_result_of_one_operation (lines 221-248).
   *
   * Two-phase dispatch:
   *   1. modifyHelper handles ALL 8 op types (Lookup / Insert / Update /
   *      InsertOrUpdate / UpdateLongBy / UnknownModification / Remove /
   *      RemoveIfExists). It returns `needsDelete=true` when the operation's
   *      updateFn returned `null` for the new value — i.e., the leaf must be
   *      structurally removed (Remove on present key, RemoveIfExists on
   *      present key, or UpdateLongBy that produced result=0). Mirrors Rust
   *      modify_helper lines 286-289 (`to_delete=true` only on update_fn None).
   *   2. If `needsDelete=true`, deleteHelper performs the structural removal
   *      using `replay_comparison` on the directions bits modify_helper just
   *      consumed. Mirrors Rust lines 232-242: pass the new_root_node from
   *      modify_helper (NOT the original root) into delete_helper.
   *
   * Return type:
   *   - `Uint8Array`        — old value at this key
   *   - `null`              — key was absent (success)
   *   - `{ failed: true }`  — verification failure (proof inconsistent, op
   *                           preconditions violated, or tree already poisoned)
   *
   * `null` is distinct from `{ failed: true }` because a Lookup on an absent
   * key is a successful verification with `null` oldValue. The wrapper
   * (verifyAvlBatch, T18) flattens `{ failed: true }` to a top-level null
   * after the batch.
   *
   * State lifecycle (per Rust line 158 and traversal semantics):
   *   - `replayIndex` is set to the CURRENT `directionsIndex` at entry.
   *     This snapshots the bit position where this operation's directions
   *     start, so deleteHelper's `replay_comparison` can re-read the same
   *     bits.
   *   - `directionsIndex` advances during modifyHelper's descent (one bit per
   *     internal-node visit). It is NOT reset between operations — each op
   *     consumes the next slice of the proof's directions bit-string.
   *   - `lastRightStep` is updated by `nextDirectionIsLeft` whenever the
   *     verifier takes a right step. NOT reset between operations: the value
   *     left over from the prior op's last right step is overwritten as the
   *     current op descends; on operations that take NO right steps the
   *     stale value is benign because replay_comparison is only invoked when
   *     needsDelete=true AND modify_helper found the target leaf, which on
   *     non-trivial trees implies at least one right step (see Rust line 461
   *     assertion `!(direction < 0 && r.left.is_leaf())`).
   *
   * Height bookkeeping (mirrors Rust lines 234-246):
   *   - Modify-only path: `height += result.heightDelta` (0 or +1 for inserts).
   *   - Modify + delete path: `height += deleteResult.heightDelta` (0 or -1).
   *     Modify's heightDelta is asserted 0 in the needsDelete case
   *     (per modify.ts handleLeafMatch needsDelete branch); the delete path
   *     overwrites it.
   *   - `Math.max(0, ...)` guards against the corner-case of an underflow
   *     should heightDelta be -1 on an already-empty tree; in practice the
   *     verifier never observes that state (delete on an empty tree fails
   *     earlier at the modifyHelper leaf-match check), but the clamp is
   *     defensive.
   */
  performOneOperation(op: Operation): Uint8Array | null | { failed: true } {
    // Rust line 159-165: empty-tree / already-poisoned guard.
    // The Rust uses `ok_or(anyhow!("Empty tree"))?` which propagates an Err
    // that the caller (line 167) catches by setting root=None. Same end state.
    if (this.root === null) {
      // Preserve the original poisoning reason if already set (proof-decode
      // failure or a prior op's failure); otherwise mark 'tree-poisoned'.
      this.lastFailReason ??= 'tree-poisoned'
      return { failed: true }
    }

    // Both references open the shared op entry with two strict bounds
    // requires — ergo_avltree_rust authenticated_tree_ops.rs:267-268
    // (@d18773c: `ensure!(key > neg_inf)`, `ensure!(key < pos_inf)`),
    // scrypto returnResultOfOneOperation (same two requires,
    // bytecode-verified) — and fail-and-poison on violation, before any
    // descent. Without this gate a proof steered to the −inf sentinel leaf
    // lets an out-of-bounds key match it (dummy-value lookup, sentinel
    // rewrite/delete — digests no reference produces). The references'
    // THIRD entry check, key length, is a wrapper throw here by documented
    // contract (verify.ts::validateOperationShape); lexicographically short
    // keys below −inf still land in this gate, same as the references.
    if (
      compareBytes(op.key, this.negInfKey) <= 0 ||
      compareBytes(op.key, this.posInfKey) >= 0
    ) {
      this.root = null
      this.height = 0
      this.lastFailReason = 'key-out-of-bounds'
      return { failed: true }
    }

    // Rust line 158: `self.replay_index = self.directions_index;` — snapshot
    // the start-of-op directions cursor for delete_helper's replay pass.
    // Set BEFORE modifyHelper runs (modifyHelper advances directionsIndex).
    this.state.replayIndex = this.state.directionsIndex

    // Phase 1 — Rust line 232-233:
    //   let (new_root_node, _, height_increased, to_delete, old_value) =
    //       self.modify_helper(root_node, &key, operation)?;
    const callbacks = this.buildCallbacks(op)
    const modifyResult = modifyHelper(this.root, op, callbacks)
    if (!modifyResult.ok) {
      // Rust lines 167-170: on Err from return_result_of_one_operation,
      // root=None and height=0. Mirror that poisoning.
      this.root = null
      this.height = 0
      this.lastFailReason = modifyResult.reason
      return { failed: true }
    }

    // Phase 2 — Rust lines 234-246: handle needsDelete vs straight-update.
    if (modifyResult.needsDelete) {
      // Rust line 235-236:
      //   let (post_delete_root_node, height_decreased) =
      //       self.delete_helper(&new_root_node, false, operation, &mut saved_node);
      //
      // IMPORTANT: delete_helper is called on `&new_root_node` (the result of
      // modify_helper, which in the needsDelete case is the unchanged subtree
      // root because modify.ts's handleLeafMatch returns the leaf unchanged
      // with needsDelete=true; see modify.ts lines 225-234).
      //
      // The deleteHelper call uses `replayIndex` (set above to the start-of-op
      // cursor) and `lastRightStep` (set by modifyHelper during its descent).
      // It does NOT advance `directionsIndex` further (replay_comparison only
      // advances replayIndex).
      const deleteResult = deleteHelper(modifyResult.newSubtreeRoot, op, callbacks)
      if (!deleteResult.ok) {
        // Rust same poisoning rule: on Err, root=None and height=0.
        this.root = null
        this.height = 0
        this.lastFailReason = deleteResult.reason
        return { failed: true }
      }
      // Rust lines 237-240:
      //   if height_decreased { self.tree().height -= 1; }
      //   self.tree().root = Some(post_delete_root_node);
      // NOTE: modify_helper's `height_increased` in the to_delete case is
      // IGNORED (Rust lines 234-241 only consult `height_decreased` from
      // delete_helper). modify.ts's needsDelete cases already guarantee
      // heightDelta=0, so the result is identical either way; but for
      // source-fidelity we explicitly use only deleteResult.heightDelta here.
      this.root = deleteResult.newSubtreeRoot
      this.height = Math.max(0, this.height + deleteResult.heightDelta)
      // Modify returns the oldValue in the to_delete case (Rust line 288:
      // `(r_node.clone(), false, false, true, Some(r.value))`) — surface that
      // to the caller. deleteHelper's oldValue is always null in the wrapped
      // result (delete.ts line 134) because modify already produced the value.
      return modifyResult.oldValue
    }

    // No-delete path — Rust lines 242-246:
    //   if height_increased { self.tree().height += 1; }
    //   self.tree().root = Some(new_root_node);
    this.root = modifyResult.newSubtreeRoot
    this.height = Math.max(0, this.height + modifyResult.heightDelta)
    return modifyResult.oldValue
  }

  /**
   * Compute the current digest: 32-byte blake2b root label || 1-byte height.
   * Mirrors Rust authenticated_tree_ops.rs::digest (lines 112-128).
   *
   * Returns `null` when the tree is poisoned (root === null). Returning null
   * (rather than a sentinel value or throwing) lets the wrapper layer
   * propagate proof-failure as a top-level null cleanly.
   *
   * The Rust source clamps height to 255 (line 123: `this.tree.height as u8`).
   * We mirror that with `& 0xff` on the height byte. The wrapper layer relies
   * on this byte matching what the prover produced.
   */
  digest(): Uint8Array | null {
    if (this.root === null) return null
    const rootLabel = label(this.root)
    const out = new Uint8Array(DIGEST_LENGTH + 1)
    out.set(rootLabel, 0)
    // Rust: `buf.put_u8(this.tree.height as u8)` (line 123). Height should
    // never exceed 255 in practice (would imply 2^(255/1.4) > 2^177 leaves),
    // but we mask defensively to mirror the Rust truncation.
    out[DIGEST_LENGTH] = this.height & 0xff
    return out
  }
}
