/**
 * BatchAVLProver — builds an in-memory AVL+ tree, applies authenticated
 * operations, and generates serialized AD proofs.
 *
 * Consumes the shared mutation engine (modifyHelper, deleteHelper) through
 * the AvlTreeOpsCallbacks interface (Task 1), with prover-specific callbacks
 * that record traversal directions for later proof serialization.
 *
 * Ports ergo_avltree_rust/src/batch_avl_prover.rs (537 lines).
 *
 * @see ~/projects/ergo_avltree_rust/src/batch_avl_prover.rs
 */

import { newLeaf, newInternal, label, type AvlNode, type InternalNode, type LeafNode } from './node.js'
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import { modifyHelper } from './modify.js'
import { deleteHelper } from './delete.js'
import { I64_MAX, I64_MIN, type Operation } from './operation.js'
import { AvlVerifyError } from './errors.js'
import { compareBytes } from './compare-bytes.js'

// ---------------------------------------------------------------------------
// Token constants for packed proof format (batch_node.rs:14-16)
// ---------------------------------------------------------------------------

const LEAF_IN_PACKAGED_PROOF = 0x02
const LABEL_IN_PACKAGED_PROOF = 0x03
const END_OF_TREE_IN_PACKAGED_PROOF = 0x04
const DIGEST_LENGTH = 32

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
 * Ports batch_avl_prover.rs::BatchAVLProver (537 lines).
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
  root: AvlNode
  height = 0
  readonly keyLength: number
  readonly valueLengthOpt: number | null
  /** All-zero key, the exclusive lower bound. Depends only on keyLength. */
  private readonly negInfKey: Uint8Array
  /** All-0xff key, the exclusive upper bound. Depends only on keyLength. */
  private readonly posInfKey: Uint8Array

  // Direction recording (batch_avl_prover.rs:27-28)
  private directions: number[] = [] // Uint8 bytes, grown dynamically
  private directionsBitLength = 0

  // Deletion replay (batch_avl_prover.rs:31-36)
  private replayIndex = 0
  private lastRightStep = 0

  // Operation state (batch_avl_prover.rs:40-43)
  private found = false
  oldTopNode: AvlNode

  // Modified nodes for proof generation (Rust: per-node `visited` flag).
  // A Set gives O(1) membership — the array this replaced made packTree
  // O(n*m) — and deduplicates the repeat visits that descent and rotation
  // produce. Reference identity is the right equality: nodes are plain
  // objects and Set uses SameValueZero.
  private modifiedNodes: Set<AvlNode> = new Set()

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
    this.negInfKey = new Uint8Array(keyLength) // all zeroes
    this.posInfKey = new Uint8Array(keyLength)
    this.posInfKey.fill(0xff)
    const dummyValue = new Uint8Array(valueLengthOpt ?? 0)

    // Direct triple-assignment, deliberately NOT routed through restoreRoot():
    // (a) keeps TS's definite-assignment proof for the non-null `root`;
    // (b) avoids calling an overridable public method from the constructor;
    // (c) matches Rust's BatchAVLProver::new, which does not call restore_root
    //     (batch_avl_prover.rs @191052c).
    this.root = newLeaf(this.negInfKey, dummyValue, this.posInfKey)
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
    this.modifiedNodes = new Set()

    // Rebase the proof baseline to the freshly-restored root.
    this.oldTopNode = root

    // Clear accumulated directions from any prior (possibly failed) cycle.
    this.directions = []
    this.directionsBitLength = 0
  }

  // -------------------------------------------------------------------------
  // buildCallbacks — ports batch_avl_prover.rs::next_direction_is_left (440-477), key_matches_leaf (486-493), replay_comparison (505-515)
  // -------------------------------------------------------------------------

  /**
   * Build prover-specific callbacks for the shared mutation engine.
   * Closes over mutable prover state (directions, found, replayIndex, etc.).
   */
  private buildCallbacks(_op: Operation): AvlTreeOpsCallbacks {
    const self = this
    return {
      // Ports batch_avl_prover.rs:440-477 — next_direction_is_left
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
        // Encode direction bit (batch_avl_prover.rs:464-475)
        if ((self.directionsBitLength & 7) === 0) {
          self.directions.push(ret ? 1 : 0)
        } else if (ret) {
          const i = self.directionsBitLength >> 3
          self.directions[i] = (self.directions[i] ?? 0) | (1 << (self.directionsBitLength & 7))
        }
        self.directionsBitLength++
        return ret
      },

      // Ports batch_avl_prover.rs:486-493 — key_matches_leaf
      keyMatchesLeaf: (_key: Uint8Array, _leaf: LeafNode) => {
        const matches = self.found
        self.found = false // reset for next operation
        return { ok: true, matches }
      },

      // Ports batch_avl_prover.rs:505-515 — replay_comparison
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

      // Ports authenticated_tree_ops.rs:98-122 — on_node_visit
      onNodeVisit: (node: AvlNode, _operation: Operation, _isRotate: boolean) => {
        self.modifiedNodes.add(node)
      },

      getFailedReason: () => null, // prover never fails direction reads
    }
  }

  // -------------------------------------------------------------------------
  // performOneOperation — ports batch_avl_prover.rs::perform_one_operation (120-141) + authenticated_tree_ops.rs::return_result_of_one_operation (237-264)
  // -------------------------------------------------------------------------

  /**
   * Apply a single operation (Insert, Update, Remove, Lookup, etc.) to the
   * in-memory tree. Records traversal directions for later proof generation.
   *
   * Failure model is two-tier: shape-invalid ops (±inf key, wrong key/value
   * length, out-of-range delta) THROW `AvlVerifyError`; engine-level op
   * failure (e.g. Insert on an existing key) returns `{ success: false }`.
   *
   * @returns ProverOperationResult — `{ success: true, value }` on success
   *   (value is the old value or null if the key was absent), or
   *   `{ success: false }` on engine-level operation failure.
   */
  performOneOperation(op: Operation): ProverOperationResult {
    const key = op.key

    // Precondition checks (authenticated_tree_ops.rs:243-245)
    // Reference check order: −inf, +inf, then length (authenticated_tree_ops.rs
    // entry requires). compareBytes length-tiebreaks, so a SHORT all-zero key
    // is < −inf and fires here — same caller mistake, different code than the
    // length gate below. Faithful to both references; do not reorder.
    if (compareBytes(key, this.negInfKey) <= 0) {
      throw new AvlVerifyError(
        'Key is less than or equal to negative infinity',
        'operation-key-out-of-bounds',
      )
    }
    if (compareBytes(key, this.posInfKey) >= 0) {
      throw new AvlVerifyError(
        'Key is greater than or equal to positive infinity',
        'operation-key-out-of-bounds',
      )
    }
    if (key.length !== this.keyLength) {
      throw new AvlVerifyError(
        'Key length does not match tree key length',
        'operation-key-length-mismatch',
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
        'operation-value-length-mismatch',
      )
    }
    // Delta range check (AVL-03 class, prover boundary) — mirrors
    // verify.ts::validateOperationShape. TS `bigint` is wider than the
    // references' i64; an unvalidated out-of-range delta would silently wrap
    // inside i64ToBeBytes (DataView.setBigInt64) on the absent-key insert
    // path. 6e review finding I-1.
    if (op.tag === 'UpdateLongBy' && (op.delta < I64_MIN || op.delta > I64_MAX)) {
      throw new AvlVerifyError(
        `op UpdateLongBy: delta=${op.delta} out of signed i64 range`,
        'operation-delta-out-of-range',
      )
    }

    // Snapshot replay index (batch_avl_prover.rs:125)
    this.replayIndex = this.directionsBitLength

    // Phase 1: modifyHelper (authenticated_tree_ops.rs:248-249)
    const callbacks = this.buildCallbacks(op)
    const modifyResult = modifyHelper(this.root, op, callbacks)
    if (!modifyResult.ok) {
      // Rollback directions (batch_avl_prover.rs:127-139)
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

    // Phase 2: delete if needed (authenticated_tree_ops.rs:250-262)
    if (modifyResult.needsDelete) {
      const deleteResult = deleteHelper(modifyResult.newSubtreeRoot, op, callbacks)
      if (!deleteResult.ok) {
        // Unreachable for the prover: the getFailedReason() exit never fires
        // because directions come from the prover's own just-recorded bits,
        // not a byte-bounded external proof. Three of deleteHelper's other
        // exits check that a node expected to be Internal isn't a Leaf or a
        // Label — also unreachable, since the prover's tree is always fully
        // materialized (no LabelNodes) and satisfies the AVL balance invariant
        // by construction. The previous code nulled the root on this branch
        // instead, permanently poisoning the tree and skipping the direction
        // rollback the modify phase performs.
        throw new Error(
          `BatchAVLProver: deleteHelper reported failure (${deleteResult.reason}), which cannot happen for a prover — the shared engine is in an inconsistent state`,
        )
      }
      this.root = deleteResult.newSubtreeRoot
      this.height = this.applyHeightDelta(deleteResult.heightDelta)
      // Defensive copy: the engine returns the leaf's LIVE value buffer (a blake2b
      // label input); handing it out uncopied lets a caller corrupt cached labels
      // and the next proof's packTree bytes. modify.ts stays alias-internal (C7).
      return { success: true, value: modifyResult.oldValue === null ? null : modifyResult.oldValue.slice() }
    }

    // No delete
    this.root = modifyResult.newSubtreeRoot
    this.height = this.applyHeightDelta(modifyResult.heightDelta)
    // Defensive copy: the engine returns the leaf's LIVE value buffer (a blake2b
    // label input); handing it out uncopied lets a caller corrupt cached labels
    // and the next proof's packTree bytes. modify.ts stays alias-internal (C7).
    return { success: true, value: modifyResult.oldValue === null ? null : modifyResult.oldValue.slice() }
  }

  /**
   * Apply a height delta from the shared engine.
   *
   * Rust does a guarded `height += 1` / `height -= 1`. The clamp this replaces
   * (`Math.max(0, height + delta)`) hid a wrong delta instead of surfacing it —
   * a negative result means the engine miscounted, which is a bug to report.
   */
  private applyHeightDelta(delta: number): number {
    const next = this.height + delta
    if (next < 0) {
      throw new Error(
        `BatchAVLProver: height delta ${delta} would take height ${this.height} negative — the mutation engine returned an inconsistent result`,
      )
    }
    return next
  }

  // -------------------------------------------------------------------------
  // digest — ports authenticated_tree_ops.rs::digest (128-144)
  // -------------------------------------------------------------------------

  /**
   * Current 33-byte digest (root label || height). Throws `RangeError` in
   * three cases: (1) the root has been forced to `null` by a type-unsafe
   * caller — reachable only via a direct cast on `root` itself, since
   * `restoreRoot`'s parameter is typed non-nullable and cannot carry `null`
   * without its own cast; (2) the tree height is outside `0..=255` —
   * reachable via a `restoreRoot`-installed height, an unchecked `number`;
   * (3) the root is a `LabelNode` whose stored digest is not exactly 32
   * bytes — reachable via a hand-built `LabelNode` or one installed through
   * `restoreRoot`, since `label` is a plain `Uint8Array` with no length
   * captured in its type. All three are unreachable through this API's own
   * operations alone.
   *
   * Ports authenticated_tree_ops.rs's digest() trait method, returning a 33-byte value
   * (32-byte blake2b label + 1-byte height).
   */
  digest(): Uint8Array {
    // JS callers can still violate the non-null type; fail legibly (package
    // precedent: the height/label RangeError guards below). Rust returns Option
    // here only because prover+verifier share one AVLTree struct — separate
    // classes make non-null the faithful shape (see facts/avltree.md).
    if ((this.root as AvlNode | null) === null) {
      throw new RangeError('BatchAVLProver.digest: root is null — tree invariant violated by a type-unsafe caller')
    }
    // Rust asserts height < 256 (authenticated_tree_ops.rs::digest). The bound
    // is unreachable for a real tree — height 256 needs more leaves than there
    // are atoms on Earth — so reaching it means the height counter is wrong.
    // Masking with & 0xff would emit a plausible but incorrect 33-byte digest,
    // which is a consensus fault rather than a local error.
    if (!Number.isInteger(this.height) || this.height < 0 || this.height > 255) {
      throw new RangeError(
        `BatchAVLProver.digest: tree height ${this.height} is outside the encodable range 0..255`,
      )
    }
    const rootLabel = label(this.root)
    // Same defect class as the storage codec's child-label guard: out.set()
    // zero-pads a short array, so an undersized root digest would produce a
    // plausible but wrong 33-byte result. newLabel enforces the length, but a
    // hand-built LabelNode installed via restoreRoot bypasses it.
    if (rootLabel.length !== DIGEST_LENGTH) {
      throw new RangeError(
        `BatchAVLProver.digest: root label length ${rootLabel.length} does not match required digest length ${DIGEST_LENGTH}`,
      )
    }
    const out = new Uint8Array(DIGEST_LENGTH + 1)
    out.set(rootLabel, 0)
    out[DIGEST_LENGTH] = this.height
    return out
  }

  // -------------------------------------------------------------------------
  // unauthenticatedLookup — ports batch_avl_prover.rs:333-368
  // -------------------------------------------------------------------------

  /**
   * Walk the tree without modifying it. Returns the value at `key`, or null
   * if absent. Does not record directions or touch modified-nodes tracking.
   */
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null {
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
      // Defensive copy: node.value is the leaf's LIVE value buffer (a blake2b
      // label input); handing it out uncopied lets a caller corrupt cached
      // labels and the next proof's packTree bytes (C7).
      return node.value.slice()
    }
    if (node.kind === 'internal') {
      return this.lookupFoundWalk(node.left)
    }
    return null
  }

  // -------------------------------------------------------------------------
  // generateProof — ports batch_avl_prover.rs:186-258
  // -------------------------------------------------------------------------

  /**
   * Serialize a proof covering all operations since the last call to
   * generateProof() (or since construction). Uses post-order traversal
   * of the modified subtree, directions bit-string, and end-of-tree marker.
   */
  generateProof(): Uint8Array {
    // NOTE: Do NOT clear modifiedNodes here — packTree relies on it for
    // wasModified checks. Clear only after packTree (batch_avl_prover.rs:251:
    // self.base.modified_nodes.clear() after pack_tree, not before).
    const parts: Uint8Array[] = []
    let previousLeafAvailable = false

    // Ports batch_avl_prover.rs:186-225 — pack_tree (post-order traversal)
    const packTree = (node: AvlNode): void => {
      if (!this.wasModified(node)) {
        // Unmodified node → emit label (batch_avl_prover.rs:195-200)
        parts.push(new Uint8Array([LABEL_IN_PACKAGED_PROOF]))
        parts.push(label(node))
        previousLeafAvailable = false
      } else if (node.kind === 'leaf') {
        // Modified leaf (batch_avl_prover.rs:203-214)
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
        // Modified internal node: recurse into children (batch_avl_prover.rs:215-219)
        packTree(node.left)
        packTree(node.right)
        // Balance byte (batch_avl_prover.rs:218)
        parts.push(new Uint8Array([node.balance & 0xff]))
      }
    }

    packTree(this.oldTopNode)

    // End of tree marker (batch_avl_prover.rs:243)
    parts.push(new Uint8Array([END_OF_TREE_IN_PACKAGED_PROOF]))

    // Directions bit-string (batch_avl_prover.rs:244)
    parts.push(new Uint8Array(this.directions))

    // Cycle reset (batch_avl_prover.rs:251-255). Rust also calls tree.reset()
    // here, which clears its per-node is_new/visited flags while PRESERVING
    // each node's cached label. We have no equivalent flags — `visited` is
    // membership in modifiedNodes, cleared below, and `is_new` has no meaning
    // in an immutable model — so there is nothing left to reset.
    //
    // Labels are deliberately NOT cleared. Nodes are immutable, so an
    // unmodified node's cached label stays valid for its lifetime; modified
    // subtrees are rebuilt as fresh nodes with labelCache: null. Clearing here
    // would force a full O(n) re-hash on the next digest().
    this.modifiedNodes = new Set()
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
  //   (authenticated_tree_ops.rs:39-42)
  // -------------------------------------------------------------------------

  /**
   * Check whether a node was visited (modified) during the current operation
   * batch. Uses object reference identity — our nodes are plain objects,
   * so === works correctly.
   */
  private wasModified(node: AvlNode): boolean {
    return this.modifiedNodes.has(node)
  }

  // -------------------------------------------------------------------------
  // generateProofForOperations — ports batch_avl_prover.rs:159-172
  // -------------------------------------------------------------------------

  /**
   * Clone the current tree, apply a batch of operations on the clone,
   * and generate a proof + digest covering all operations.
   *
   * The original tree is NOT mutated. Failure model is two-tier:
   * shape-invalid ops (±inf key, wrong key/value length, out-of-range delta)
   * THROW AvlVerifyError, propagated from performOneOperation; engine-level
   * op failure (e.g. Insert on an existing key) returns { success: false }.
   */
  generateProofForOperations(
    operations: Operation[],
  ): { success: true; proof: Uint8Array; digest: Uint8Array } | { success: false } {
    // Clone the tree (deep copy nodes)
    const cloneRoot = this.deepCloneNode(this.root)
    const clonedProver = new BatchAVLProver(this.keyLength, this.valueLengthOpt)
    clonedProver.restoreRoot(cloneRoot, this.height)

    for (const op of operations) {
      const result = clonedProver.performOneOperation(op)
      if (!result.success) {
        return { success: false }
      }
    }

    const proof = clonedProver.generateProof()
    const digest = clonedProver.digest()
    return { success: true, proof, digest }
  }

  // -------------------------------------------------------------------------
  // removedNodes — output-contract port of batch_avl_prover.rs removed_nodes
  //   (derived walk; see facts/avltree.md for the divergence table. Rust
  //   range verified via `git show 568e7c3:src/batch_avl_prover.rs`:
  //   removed_nodes spans lines 146-153 — signature through closing brace.)
  // -------------------------------------------------------------------------

  /**
   * Nodes of the previous cycle's tree whose labels are no longer in the
   * current tree — the rows a storage backend should delete.
   *
   * ORDERING: call after the batch's operations and BEFORE `generateProof()`
   * or `restoreRoot()`; both rebase the proof cycle, after which this
   * returns `[]` (the reference's cleared-buffer observable — misordering is
   * the ergo-node-rust 235 GB orphan incident). Calling from inside
   * `VersionedAVLStorage.update()` is correct by construction:
   * `generateProofAndUpdateStorage` runs update before generateProof.
   *
   * Pure and idempotent; mid-batch calls allowed (diff as of the current
   * tree). Order of returned nodes unspecified — treat as a set. Returned
   * nodes are live tree objects: do not mutate; derive storage keys via the
   * exported `label()`. The never-persisted first-cycle sentinel leaf is
   * reported on the first mutating cycle (reference parity) — storage must
   * tolerate deleting absent rows.
   *
   * Throws a plain `Error` (not `AvlVerifyError`) on a key-less candidate or
   * descent node — reachable only via an invariant-violating `restoreRoot`
   * tree; see facts/avltree.md's invariant-throws bullet.
   */
  removedNodes(): AvlNode[] {
    const out: AvlNode[] = []
    const walk = (node: AvlNode): void => {
      // Unvisited ⇒ subtree untouched this cycle ⇒ shared with the current
      // tree by structural sharing ⇒ nothing under it was removed.
      if (!this.modifiedNodes.has(node)) return
      if (!containsLabel(this.root, node)) out.push(node)
      if (node.kind === 'internal') {
        walk(node.left)
        walk(node.right)
      }
    }
    walk(this.oldTopNode)
    return out
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
}

// ---------------------------------------------------------------------------
// containsLabel — behavioral port of batch_node.rs contains/contains_recursive
//   (verified via `git show 568e7c3:src/batch_node.rs`: `contains` 519-525,
//   `contains_recursive` 535-607 — pub fn/fn through closing brace)
// ---------------------------------------------------------------------------

/**
 * Whether the tree rooted at `root` contains a node whose label equals
 * `candidate`'s. Descends by the candidate's key (key-equal → one step right,
 * then left to the leaf), label-comparing every node on the path.
 *
 * A `LabelNode` stub encountered ON THE PATH is fail-safe `true`: inside an
 * unresolved subtree we cannot prove absence, and deleting a node still
 * referenced from it would leave dangling parent→child references on disk
 * (the reference documents exactly this hazard in contains_recursive).
 *
 * A candidate (or descent node) without a key is an invariant violation —
 * unreachable through the prover's own operations, reachable only via an
 * invariant-violating restoreRoot tree; the reference panics on the same
 * input. Internal, not exported from index.ts.
 */
export function containsLabel(root: AvlNode, candidate: AvlNode): boolean {
  const key = requiredCandidateKey(candidate)
  const target = label(candidate)

  const walk = (node: AvlNode, keyFound: boolean): boolean => {
    if (compareBytes(label(node), target) === 0) return true
    if (node.kind === 'label') return true // fail-safe: unresolved subtree
    if (node.kind === 'leaf') return false
    if (node.key === undefined) {
      throw new Error(
        'removedNodes: internal node without key on containsLabel descent — tree invariant violated',
      )
    }
    if (keyFound) return walk(node.left, true)
    const cmp = compareBytes(key, node.key)
    if (cmp === 0) return walk(node.right, true)
    return walk(cmp < 0 ? node.left : node.right, false)
  }
  return walk(root, false)
}

/**
 * Candidate's key, or throws the invariant error for a label-only or
 * key-less-internal candidate (see `containsLabel`'s JSDoc).
 *
 * Written as one early return per branch rather than a single `candidate.kind
 * === 'label' || (candidate.kind === 'internal' && candidate.key ===
 * undefined)` guard: TS's control-flow analysis narrows the `kind`
 * discriminant across a branch join, but does not carry a *property*-level
 * refinement (`key !== undefined`) established inside only one arm through
 * that same join — confirmed against tsc directly (a `||`-guard and a
 * nested-if-no-else version both leave `candidate.key` typed
 * `Uint8Array | undefined` at the use site; only per-branch early return
 * type-checks). Runtime behavior is identical to the single-guard form.
 */
function requiredCandidateKey(candidate: AvlNode): Uint8Array {
  if (candidate.kind === 'label') {
    throw new Error(
      'removedNodes: candidate node carries no key (label-only or key-less internal) — old-tree invariant violated; a well-formed prover tree cannot produce this candidate',
    )
  }
  if (candidate.kind === 'leaf') {
    return candidate.key
  }
  if (candidate.key === undefined) {
    throw new Error(
      'removedNodes: candidate node carries no key (label-only or key-less internal) — old-tree invariant violated; a well-formed prover tree cannot produce this candidate',
    )
  }
  return candidate.key
}
