/**
 * BatchAVLProver — builds an in-memory AVL+ tree, applies authenticated
 * operations, and generates serialized AD proofs.
 *
 * Consumes the shared mutation engine (modifyHelper, deleteHelper) through
 * the AvlTreeOpsCallbacks interface (Task 1), with prover-specific callbacks
 * that record traversal directions for later proof serialization.
 *
 * Ports ergo_avltree_rust/src/batch_avl_prover.rs (506 lines).
 *
 * @see ~/projects/ergo_avltree_rust/src/batch_avl_prover.rs
 */

import { newLeaf, newInternal, label, type AvlNode, type InternalNode, type LeafNode } from './node.js'
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import { modifyHelper } from './modify.js'
import { deleteHelper } from './delete.js'
import type { Operation } from './operation.js'
import { AvlVerifyError } from './errors.js'

// ---------------------------------------------------------------------------
// Token constants for packed proof format (batch_node.rs:14-16)
// ---------------------------------------------------------------------------

const LEAF_IN_PACKAGED_PROOF = 0x02
const LABEL_IN_PACKAGED_PROOF = 0x03
const END_OF_TREE_IN_PACKAGED_PROOF = 0x04
const DIGEST_LENGTH = 32

// ---------------------------------------------------------------------------
// compareBytes helper
// ---------------------------------------------------------------------------

/**
 * Lexicographic byte comparison. Ports the per-op key-comparison logic
 * within batch_avl_prover.rs::next_direction_is_left (lines 409-446).
 *
 * Defined locally because tree-traversal.ts's version is not exported.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length)
  for (let i = 0; i < min; i++) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

// ---------------------------------------------------------------------------
// ProverOperationResult
// ---------------------------------------------------------------------------

export type ProverOperationResult =
  | { success: true; value: Uint8Array | null }
  | { success: false }

// ---------------------------------------------------------------------------
// BatchAVLProver
// ---------------------------------------------------------------------------

/**
 * Ports batch_avl_prover.rs::BatchAVLProver (506 lines).
 *
 * Builds an in-memory AVL+ tree from a sequence of authenticated operations,
 * records traversal directions, and generates serialized AD proofs suitable
 * for verification by `BatchAVLVerifier` (verify.ts).
 *
 * The shared engine (modifyHelper / deleteHelper from modify.ts / delete.ts)
 * drives tree mutation. The prover provides callbacks that:
 *   - Compare keys via InternalNode.key (set by the shared engine's addNode
 *     and rebalance helpers).
 *   - Record the traversal direction (left/right) as a bit-packed byte array.
 *   - Track modified nodes for proof-generation traversal.
 */
export class BatchAVLProver {
  // Tree state
  root: AvlNode | null = null
  height = 0
  readonly keyLength: number
  readonly valueLengthOpt: number | null

  // Direction recording (batch_avl_prover.rs:27-28)
  private directions: number[] = [] // Uint8 bytes, grown dynamically
  private directionsBitLength = 0

  // Deletion replay (batch_avl_prover.rs:31-36)
  private replayIndex = 0
  private lastRightStep = 0

  // Operation state (batch_avl_prover.rs:40-43)
  private found = false
  oldTopNode: AvlNode | null = null

  // Modified nodes for proof generation (Rust: modified_nodes)
  private modifiedNodes: AvlNode[] = []

  // Cycle reset flag (batch_avl_prover.rs:49-50)
  private needsCycleReset = false

  // -------------------------------------------------------------------------
  // Constructor — ports batch_avl_prover.rs:54-76
  // -------------------------------------------------------------------------

  constructor(keyLength: number, valueLengthOpt: number | null) {
    this.keyLength = keyLength
    this.valueLengthOpt = valueLengthOpt

    // Rust lines 65-73: initialize empty tree with a single neg-inf sentinel leaf.
    // The leaf's nextLeafKey = posInfKey so it spans the entire key space.
    // This matches Rust's AVLTree — the empty tree is a single LeafNode, NOT an
    // internal node with two sentinel leaves.
    const negInfKey = new Uint8Array(keyLength) // all zeroes
    const posInfKey = new Uint8Array(keyLength)
    posInfKey.fill(0xff)
    const dummyValue = new Uint8Array(valueLengthOpt ?? 0)

    this.root = newLeaf(negInfKey, dummyValue, posInfKey)
    this.height = 0 // single leaf has height 0
    this.oldTopNode = this.root
  }

  // -------------------------------------------------------------------------
  // restoreRoot — ports batch_avl_prover.rs:78-108
  // -------------------------------------------------------------------------

  /**
   * Install a persisted root and rebase the proof cycle atomically.
   *
   * Must be called after loading a tree from storage (startup resume, snapshot
   * bootstrap, recovery rollback). Without this, `oldTopNode` is a stale
   * sentinel and `generateProof` produces wrong proofs.
   *
   * Ports batch_avl_prover.rs `restore_root` (commit 191052c).
   */
  restoreRoot(root: AvlNode, height: number): void {
    this.root = root
    this.height = height

    // Drop stale dirty-node bookkeeping from any previous proof cycle.
    this.modifiedNodes = []

    // Rebase the proof baseline to the freshly-restored root.
    this.oldTopNode = root

    // Clear accumulated directions from any prior (possibly failed) cycle.
    this.directions = []
    this.directionsBitLength = 0

    // Tree was just reset — don't double-reset on the next
    // performOneOperation.
    this.needsCycleReset = false
  }

  // -------------------------------------------------------------------------
  // buildCallbacks — ports batch_avl_prover.rs:409-484
  // -------------------------------------------------------------------------

  /**
   * Build prover-specific callbacks for the shared mutation engine.
   * Closes over mutable prover state (directions, found, replayIndex, etc.).
   */
  private buildCallbacks(_op: Operation): AvlTreeOpsCallbacks {
    const self = this
    return {
      // Ports batch_avl_prover.rs:409-446 — next_direction_is_left
      nextDirectionIsLeft: (key: Uint8Array, r: InternalNode): boolean => {
        // The shared engine must have set r.key on internal nodes during
        // addNode and all rebalance helpers. If it's undefined, the tree
        // is in an inconsistent state.
        if (r.key === undefined) {
          throw new Error(
            'InternalNode.key is undefined — shared engine must set key on all internal nodes',
          )
        }
        let ret: boolean
        if (self.found) {
          ret = true // after finding key, always go left to the leaf
        } else {
          const cmp = compareBytes(key, r.key)
          if (cmp === 0) {
            self.found = true
            self.lastRightStep = self.directionsBitLength
            ret = false // go right, then left to the leaf
          } else {
            ret = cmp < 0 // go left if key < node key
          }
        }
        // Encode direction bit (Rust lines 434-444)
        if ((self.directionsBitLength & 7) === 0) {
          self.directions.push(ret ? 1 : 0)
        } else if (ret) {
          const i = self.directionsBitLength >> 3
          self.directions[i] = (self.directions[i] ?? 0) | (1 << (self.directionsBitLength & 7))
        }
        self.directionsBitLength++
        return ret
      },

      // Ports batch_avl_prover.rs:455-462 — key_matches_leaf
      keyMatchesLeaf: (_key: Uint8Array, _leaf: LeafNode) => {
        const matches = self.found
        self.found = false // reset for next operation
        return { ok: true, matches }
      },

      // Ports batch_avl_prover.rs:474-484 — replay_comparison
      replayComparison: (): -1 | 0 | 1 => {
        const i = self.replayIndex
        let ret: -1 | 0 | 1
        if (i === self.lastRightStep) {
          ret = 0
        } else if (((self.directions[i >> 3] ?? 0) & (1 << (i & 7))) === 0) {
          ret = 1
        } else {
          ret = -1
        }
        self.replayIndex++
        return ret
      },

      // Ports authenticated_tree_ops.rs:100-123 — on_node_visit
      onNodeVisit: (node: AvlNode, _operation: Operation, _isRotate: boolean) => {
        self.modifiedNodes.push(node)
      },

      getFailedReason: () => null, // prover never fails direction reads
    }
  }

  // -------------------------------------------------------------------------
  // performOneOperation — ports batch_avl_prover.rs:89-110 + 226-246
  // -------------------------------------------------------------------------

  /**
   * Apply a single operation (Insert, Update, Remove, Lookup, etc.) to the
   * in-memory tree. Records traversal directions for later proof generation.
   *
   * @returns ProverOperationResult — `{ success: true, value }` on success
   *   (value is the old value or null if the key was absent), or
   *   `{ success: false }` on precondition failure.
   */
  performOneOperation(op: Operation): ProverOperationResult {
    const key = op.key
    const negInfKey = new Uint8Array(this.keyLength) // all zeroes
    const posInfKey = new Uint8Array(this.keyLength)
    posInfKey.fill(0xff)

    // Precondition checks (Rust lines 226-229)
    if (compareBytes(key, negInfKey) <= 0) {
      throw new AvlVerifyError(
        'Key is less than or equal to negative infinity',
        'invalid-config-key-length',
      )
    }
    if (compareBytes(key, posInfKey) >= 0) {
      throw new AvlVerifyError(
        'Key is greater than or equal to positive infinity',
        'invalid-config-key-length',
      )
    }
    if (key.length !== this.keyLength) {
      throw new AvlVerifyError(
        'Key length does not match tree key length',
        'invalid-config-key-length',
      )
    }
    // Value length check
    if (
      this.valueLengthOpt !== null &&
      'value' in op &&
      (op as { value: Uint8Array }).value.length !== this.valueLengthOpt
    ) {
      throw new AvlVerifyError(
        'Value length does not match fixed value length',
        'invalid-config-value-length',
      )
    }

    // Cycle reset (Rust line 90-93)
    if (this.needsCycleReset) {
      this.clearVisitedFlags(this.root)
      this.needsCycleReset = false
    }

    // Snapshot replay index (Rust line 94)
    this.replayIndex = this.directionsBitLength

    // Phase 1: modifyHelper (Rust lines 232-233)
    const callbacks = this.buildCallbacks(op)
    const modifyResult = modifyHelper(this.root!, op, callbacks)
    if (!modifyResult.ok) {
      // Rollback directions (Rust lines 96-108)
      const oldByteLength = (this.replayIndex + 7) >> 3
      this.directions.length = oldByteLength
      this.directionsBitLength = this.replayIndex
      if ((this.directionsBitLength & 7) > 0 && this.directions.length > 0) {
        const mask = (1 << (this.directionsBitLength & 7)) - 1
        const last = this.directions.length - 1
        this.directions[last] = (this.directions[last] ?? 0) & mask
      }
      return { success: false }
    }

    // Phase 2: delete if needed (Rust lines 234-246)
    if (modifyResult.needsDelete) {
      const deleteResult = deleteHelper(modifyResult.newSubtreeRoot, op, callbacks)
      if (!deleteResult.ok) {
        this.root = null
        this.height = 0
        return { success: false }
      }
      this.root = deleteResult.newSubtreeRoot
      this.height = Math.max(0, this.height + deleteResult.heightDelta)
      return { success: true, value: modifyResult.oldValue }
    }

    // No delete
    this.root = modifyResult.newSubtreeRoot
    this.height = Math.max(0, this.height + modifyResult.heightDelta)
    return { success: true, value: modifyResult.oldValue }
  }

  // -------------------------------------------------------------------------
  // digest — ports batch_avl_prover.rs:299-300 (rootHash + height)
  // -------------------------------------------------------------------------

  /**
   * Current 33-byte digest (root label || height). Null if tree poisoned.
   *
   * Ports batch_avl_prover.rs rootHash() returning a 33-byte value
   * (32-byte blake2b label + 1-byte height).
   */
  digest(): Uint8Array | null {
    if (this.root === null) return null
    const rootLabel = label(this.root)
    const out = new Uint8Array(DIGEST_LENGTH + 1)
    out.set(rootLabel, 0)
    out[DIGEST_LENGTH] = this.height & 0xff
    return out
  }

  // -------------------------------------------------------------------------
  // unauthenticatedLookup — ports batch_avl_prover.rs:302-337
  // -------------------------------------------------------------------------

  /**
   * Walk the tree without modifying it. Returns the value at `key`, or null
   * if absent. Does not record directions or touch modified-nodes tracking.
   */
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null {
    if (this.root === null) return null
    return this.lookupWalk(this.root, key)
  }

  /**
   * Internal recursive lookup walk. Descends the internal-node spine by key
   * comparison, then walks leftward from the leaf beyond the key.
   */
  private lookupWalk(node: AvlNode, key: Uint8Array): Uint8Array | null {
    if (node.kind === 'leaf') {
      return null // reached leaf without finding key
    }
    if (node.kind === 'label') {
      return null
    }
    // Internal node: compare and descend
    if (node.key === undefined) {
      return null // shouldn't happen in prover
    }
    const cmp = compareBytes(key, node.key)
    if (cmp === 0) {
      // Found — go right once, then left to the leaf
      return this.lookupFoundWalk(node.right)
    }
    return this.lookupWalk(cmp < 0 ? node.left : node.right, key)
  }

  /**
   * After finding the matching internal node (key === node.key), walk left
   * until hitting the leaf. That leaf carries the stored value.
   */
  private lookupFoundWalk(node: AvlNode): Uint8Array | null {
    if (node.kind === 'leaf') {
      return node.value
    }
    if (node.kind === 'internal') {
      return this.lookupFoundWalk(node.left)
    }
    return null
  }

  // -------------------------------------------------------------------------
  // generateProof — ports batch_avl_prover.rs:155-227
  // -------------------------------------------------------------------------

  /**
   * Serialize a proof covering all operations since the last call to
   * generateProof() (or since construction). Uses post-order traversal
   * of the modified subtree, directions bit-string, and end-of-tree marker.
   */
  generateProof(): Uint8Array {
    // NOTE: Do NOT clear modifiedNodes here — packTree relies on it for
    // wasModified checks. Clear only after packTree (Rust line ~219:
    // self.base.modified_nodes.clear() after pack_tree, not before).
    const parts: Uint8Array[] = []
    let previousLeafAvailable = false

    // Ports batch_avl_prover.rs:155-194 — pack_tree (post-order traversal)
    const packTree = (node: AvlNode): void => {
      if (!this.wasModified(node)) {
        // Unmodified node → emit label (Rust lines 165-169)
        parts.push(new Uint8Array([LABEL_IN_PACKAGED_PROOF]))
        parts.push(label(node))
        previousLeafAvailable = false
      } else if (node.kind === 'leaf') {
        // Modified leaf (Rust lines 172-183)
        parts.push(new Uint8Array([LEAF_IN_PACKAGED_PROOF]))
        if (!previousLeafAvailable) {
          parts.push(node.key)
        }
        parts.push(node.nextLeafKey)
        if (this.valueLengthOpt === null) {
          // Variable-length value: prefix with u32 length (big-endian)
          const lenBuf = new Uint8Array(4)
          new DataView(lenBuf.buffer).setUint32(0, node.value.length, false)
          parts.push(lenBuf)
        }
        parts.push(node.value)
        previousLeafAvailable = true
      } else if (node.kind === 'internal') {
        // Modified internal node: recurse into children (Rust lines 184-188)
        packTree(node.left)
        packTree(node.right)
        // Balance byte (Rust line 189)
        parts.push(new Uint8Array([node.balance & 0xff]))
      }
    }

    if (this.oldTopNode !== null) {
      packTree(this.oldTopNode)
    }

    // End of tree marker (Rust line 212)
    parts.push(new Uint8Array([END_OF_TREE_IN_PACKAGED_PROOF]))

    // Directions bit-string (Rust line 213)
    parts.push(new Uint8Array(this.directions))

    // Cycle reset (Rust lines 220-224)
    this.modifiedNodes = []
    this.needsCycleReset = true
    this.directions = []
    this.directionsBitLength = 0
    this.oldTopNode = this.root

    // Concatenate all parts
    const totalLen = parts.reduce((n, p) => n + p.length, 0)
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const p of parts) {
      result.set(p, offset)
      offset += p.length
    }
    return result
  }

  // -------------------------------------------------------------------------
  // wasModified — ports AuthenticatedTreeOpsBase::was_modified
  //   (authenticated_tree_ops.rs:39-44)
  // -------------------------------------------------------------------------

  /**
   * Check whether a node was visited (modified) during the current operation
   * batch. Uses object reference identity — our nodes are plain objects,
   * so === works correctly.
   */
  private wasModified(node: AvlNode): boolean {
    return this.modifiedNodes.includes(node)
  }

  // -------------------------------------------------------------------------
  // generateProofForOperations — ports batch_avl_prover.rs:128-141
  // -------------------------------------------------------------------------

  /**
   * Clone the current tree, apply a batch of operations on the clone,
   * and generate a proof + digest covering all operations.
   *
   * The original tree is NOT mutated. If any operation fails (precondition),
   * returns `{ success: false }`.
   */
  generateProofForOperations(
    operations: Operation[],
  ): { proof: Uint8Array; digest: Uint8Array } | { success: false } {
    // Clone the tree (deep copy nodes)
    const cloneRoot = this.deepCloneNode(this.root!)
    const clonedProver = new BatchAVLProver(this.keyLength, this.valueLengthOpt)
    clonedProver.root = cloneRoot
    clonedProver.height = this.height
    clonedProver.oldTopNode = cloneRoot

    for (const op of operations) {
      const result = clonedProver.performOneOperation(op)
      if (!result.success) {
        return { success: false }
      }
    }

    const proof = clonedProver.generateProof()
    const digest = clonedProver.digest()!
    return { proof, digest }
  }

  // -------------------------------------------------------------------------
  // deepCloneNode
  // -------------------------------------------------------------------------

  /**
   * Deep-clone a tree node and all its descendants. Preserves byte values
   * via defensive copies (newLeaf / newInternal constructors already copy).
   */
  private deepCloneNode(node: AvlNode): AvlNode {
    if (node.kind === 'leaf') {
      return newLeaf(node.key, node.value, node.nextLeafKey)
    }
    if (node.kind === 'internal') {
      return newInternal(
        this.deepCloneNode(node.left),
        this.deepCloneNode(node.right),
        node.balance,
        node.key ? new Uint8Array(node.key) : undefined,
      )
    }
    // LabelNode
    return { kind: 'label', label: new Uint8Array(node.label) }
  }

  // -------------------------------------------------------------------------
  // clearVisitedFlags
  // -------------------------------------------------------------------------

  /**
   * Recursively clear labelCache on all nodes. Called during the cycle reset
   * that follows every generateProof() call (Rust's `tree.reset()`).
   * Forces re-labeling on the next digest() call after the tree has been
   * mutated in the new cycle.
   */
  private clearVisitedFlags(node: AvlNode | null): void {
    if (node === null) return
    if (node.kind !== 'label') {
      node.labelCache = null
    }
    if (node.kind === 'internal') {
      this.clearVisitedFlags(node.left)
      this.clearVisitedFlags(node.right)
    }
  }
}
