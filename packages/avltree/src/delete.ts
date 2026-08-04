/**
 * AVL+ tree deletion engine — second pass for Remove / RemoveIfExists and
 * UpdateLongBy-result==0.
 *
 * Ports authenticated_tree_ops.rs::AuthenticatedTreeOps::delete_helper
 * (492-699 @568e7c3) plus `change_next_leaf_key_of_max_node` (446-461 @568e7c3)
 * and `change_key_and_value_of_min_node` (463-479 @568e7c3).
 *
 * CONSENSUS-CRITICAL — every branch is byte-faithful with the Rust reference.
 * Structural changes during deletion (which leaf is spliced out, which nextLeafKey
 * is updated, balance updates on rebalance, rotation selection) must match
 * exactly or downstream digest comparisons fail.
 *
 * Why deletion is structurally different from `modifyHelper` (see modify.ts):
 *   - Deletions traverse the tree TWICE.
 *   - First pass — `modifyHelper` walks via `nextDirectionIsLeft`, finds the
 *     leaf, invokes `updateFn`, and signals `needsDelete: true` when the
 *     operation requires removing the leaf (Remove, RemoveIfExists with
 *     existing key, or UpdateLongBy with result == 0).
 *   - Second pass — `deleteHelper` (THIS FILE) walks the same directions via
 *     `replayComparison`, finds the same leaf, splices it out, and rebalances
 *     up the tree.
 *
 * The Rust orchestration is at `return_result_of_one_operation`
 * (authenticated_tree_ops.rs 261-288 @568e7c3): modify_helper first, then
 * delete_helper if to_delete=true. The same dispatch pattern lives in T17's
 * BatchAvlVerifier::performOneOperation.
 *
 * `deleteHelper` does NOT invoke `updateFn` — modifyHelper already did the
 * per-operation precondition check (Remove on absent key already failed; the
 * structural delete only runs when the leaf actually needs to go).
 *
 * `deleteHelper` does NOT inspect `op.tag` — once we reach this code, the
 * structural operation is the same regardless of which operation triggered
 * the delete (Remove, RemoveIfExists, or UpdateLongBy result==0). The `op`
 * parameter is threaded through solely to reach `callbacks.onNodeVisit`, which
 * the Rust reference calls nine times across this span — see each call site for
 * its `authenticated_tree_ops.rs` counterpart. Every one is load-bearing for
 * proof generation: `onNodeVisit` is what puts a node into `modifiedNodes`, and
 * `generateProof` packs a node outside that set as a bare label. A structurally
 * involved node that goes unvisited is emitted as a label the verifier cannot
 * descend into, and the prover's own proof is rejected.
 *
 * Per [[feedback-rust-port-style]]: decomposed into TS-idiomatic helpers
 * rather than one ~95-line function, each with per-section source-line
 * references back to the Rust port.
 *
 * @see ~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs
 */

import {
  newInternal,
  newLeaf,
  type AvlNode,
  type Balance,
  type InternalNode,
  type LeafNode,
} from './node.js'
import {
  doubleLeftRotate,
  doubleRightRotate,
} from './rotation.js'
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import type { Operation } from './operation.js'
import type { ModifyResult } from './modify.js'
import type { AvlVerifyFailReason } from './errors.js'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal recursive result. Mirrors the Rust `(NodeId, bool)` tuple from
 * `delete_helper` where the bool is `heightDecreased`.
 *
 * Promoted to a ModifyResult at the entry point (`deleteHelper`).
 */
type DeleteInner =
  | { readonly ok: true; readonly newSubtreeRoot: AvlNode; readonly heightDecreased: boolean }
  | { readonly ok: false; readonly reason: AvlVerifyFailReason }

/**
 * Out-parameter wrapper for the `saved_node` reference in the Rust source
 * (authenticated_tree_ops.rs line 497 @568e7c3: `saved_node: &mut Option<NodeId>`).
 *
 * Set in `tryEasyDeleteRightLeaf` when deleteMax=true (Rust line 534 @568e7c3).
 * Read in `hardDeleteLeftDescent` when direction==0 after the recursive
 * deleteMax returned (Rust lines 583-585 @568e7c3).
 *
 * Always a LeafNode in practice: it is set only at line 534 @568e7c3 where `r.right`
 * was just verified to be a Leaf via `if let Node::Leaf(right_child) = ...`
 * (Rust line 526 @568e7c3).
 */
type SavedNodeRef = { node: LeafNode | null }

// ---------------------------------------------------------------------------
// Public entry — deleteHelper
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs::delete_helper (492-699 @568e7c3), public entry
 * variant. Begins the second-pass descent at `node` and returns a
 * ModifyResult for uniform consumption by T17's BatchAvlVerifier.
 *
 * Preconditions (caller-enforced):
 *   - The callbacks' replayComparison replays the same directions used during
 *     the prior modifyHelper first pass.
 *   - `node` is the subtree root that modifyHelper returned (unchanged when
 *     needsDelete=true; see modify.ts handleLeafMatch's needsDelete branch).
 *
 * Result mapping into ModifyResult (delete always changes the tree at the
 * matching leaf):
 *   - changeHappened = true
 *   - heightDelta    = -1 if heightDecreased else 0
 *   - oldValue       = null (modifyHelper already returned the oldValue)
 *   - needsDelete    = false (the delete IS being performed)
 *
 * `callbacks.replayComparison()` replays the comparison from the first pass
 * during descent. `op` is unused for structural behavior (deleteHelper
 * doesn't inspect op.tag — see file-level JSDoc) but kept in the signature
 * for symmetry with modifyHelper and onNodeVisit tracking.
 */
export function deleteHelper(
  node: AvlNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
): ModifyResult {
  const saved: SavedNodeRef = { node: null }
  const result = deleteInner(node, /* deleteMax */ false, op, callbacks, saved)
  if (!result.ok) return result
  return {
    ok: true,
    newSubtreeRoot: result.newSubtreeRoot,
    changeHappened: true,
    heightDelta: result.heightDecreased ? -1 : 0,
    oldValue: null,
    needsDelete: false,
  }
}

// ---------------------------------------------------------------------------
// Internal recursive worker
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs::delete_helper recursive body
 * (Rust lines 492-699 @568e7c3). Maintains the Rust signature's `delete_max`
 * parameter (true while descending the leftmost path to find the max for the
 * in-order predecessor swap; see file-level JSDoc above + the strategy comment
 * at Rust lines 433-444 @568e7c3).
 */
function deleteInner(
  node: AvlNode,
  deleteMax: boolean,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  saved: SavedNodeRef,
): DeleteInner {
  // Rust line 499 @568e7c3: `self.on_node_visit(r_node, operation, false)` — the
  // FIRST statement of `delete_helper`, ahead of both the direction computation
  // and the node-kind match. Placed identically here so the visit ORDER matches
  // the reference and not merely the visit set. (`removedNodes()` consumes
  // membership only — the derived walk is order-insensitive, like `packTree`;
  // the placement is reference fidelity, not a consumer constraint.)
  //
  // Hoisting it above the guards below is behaviour-preserving on both
  // consumers: neither `replayComparison` nor `getFailedReason` touches
  // `modifiedNodes`, the prover cannot reach this frame with a non-internal node
  // (batch-prover.ts::performOneOperation's deleteHelper-failure branch), and
  // the verifier's `onNodeVisit` is a no-op
  // (batch-verifier.ts::buildCallbacks's onNodeVisit no-op).
  callbacks.onNodeVisit(node, op, false)

  // Rust lines 501-505 @568e7c3:
  // `let direction = if delete_max { 1 } else { self.replay_comparison() };`
  // deleteMax=true forces direction=1 (we are not searching for a specific key
  // anymore; we are descending the rightmost path of a subtree to find its max).
  const direction = deleteMax ? 1 : callbacks.replayComparison()
  // Audit AVL-01: replay-bit read may have run past proof bounds; surface as failure.
  if (!deleteMax) {
    const failedReason = callbacks.getFailedReason()
    if (failedReason !== null) {
      return { ok: false, reason: failedReason }
    }
  }

  // Rust line 506 @568e7c3: `if let Node::Internal(r) = self.tree().copy(r_node) { ... }`
  // Both branches of the `delete_helper` body assume the current node is
  // Internal. Leaf/Label here = proof-malformed.
  if (node.kind !== 'internal') {
    // Rust line 697 @568e7c3: `bail!("Malformed AVL proof: delete on a
    // non-internal node")` — for the verifier, this is a malformed proof (the
    // prover would have arranged for this branch to land on an internal node).
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust lines 514-517 @568e7c3: `ensure!(!(direction < 0 && r.left.borrow().is_leaf()), ...)`
  // If we are descending left looking for the deletion target and the left
  // child is a leaf, the target key is not in any internal node's subtree —
  // impossible for a valid proof of a present key.
  if (direction < 0 && node.left.kind === 'leaf') {
    return { ok: false, reason: 'proof-malformed' }
  }

  // Easy case 1 (Rust lines 525-554 @568e7c3): direction >= 0 AND r.right is a Leaf.
  if (direction >= 0 && node.right.kind === 'leaf') {
    return tryEasyDeleteRightLeaf(node, node.right, direction, deleteMax, op, callbacks, saved)
  }

  // Easy case 2 (Rust lines 555-571 @568e7c3): direction == 0 AND r.left is a Leaf.
  if (direction === 0 && node.left.kind === 'leaf') {
    return tryEasyDeleteLeftLeaf(node, node.left, op, callbacks)
  }

  // Hard cases (Rust lines 572-695 @568e7c3).
  if (direction <= 0) {
    // Rust lines 573-647 @568e7c3: going left (or deleteMax-from-here case).
    // The structural assertion (Rust lines 514-517 @568e7c3) plus the easy-case exits
    // above guarantee node.left is Internal at this point.
    return hardDeleteLeftDescent(node, direction, op, callbacks, saved)
  }
  // Rust lines 648-695 @568e7c3: going right. The easy-case exits guarantee
  // node.right is Internal here (Rust line 525 @568e7c3 fired on Leaf
  // right-children).
  return hardDeleteRightDescent(node, deleteMax, op, callbacks, saved)
}

// ---------------------------------------------------------------------------
// Easy case 1: direction >= 0 and r.right is a Leaf
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs Rust lines 525-554 @568e7c3.
 *
 * Two sub-cases:
 *   - deleteMax (direction == 1): save the right leaf's info into `saved.node`
 *     (it will be promoted into the in-order successor by an ancestor frame).
 *     Return the left subtree as the new subtree root.
 *     (Rust lines 530-535 @568e7c3.)
 *
 *   - direction == 0: we found the leaf to delete. Replace `nextLeafKey` of
 *     the rightmost leaf of `r.left` with the deleted leaf's `nextLeafKey`,
 *     then return the modified left subtree. (Rust lines 538-551 @568e7c3.)
 *
 * Both sub-cases return heightDecreased=true: the subtree at this node was
 * `(left subtree height + 1)` deep — replacing it with the left subtree
 * decreases that subtree's height by 1.
 *
 * Note: direction is asserted to be exactly 0 in the non-deleteMax branch
 * (Rust lines 539-543 @568e7c3: `ensure!(direction == 0, ...)`). direction can't be < 0
 * here because the caller already checked `direction >= 0`.
 */
function tryEasyDeleteRightLeaf(
  node: InternalNode,
  rightLeaf: LeafNode,
  direction: -1 | 0 | 1,
  deleteMax: boolean,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  saved: SavedNodeRef,
): DeleteInner {
  // Rust line 529 @568e7c3: `self.on_node_visit(&r.right, operation, false)`,
  // ahead of the deleteMax branch and so covering both sub-cases.
  //
  // Load-bearing in the deleteMax sub-case: this leaf is the max of an
  // ancestor's left subtree, not the leaf `modifyHelper` matched on the first
  // pass, so no other visit reaches it. Left unvisited it is packed as a bare
  // label, and the verifier cannot read the key and value it has to promote.
  callbacks.onNodeVisit(rightLeaf, op, false)

  if (deleteMax) {
    // Rust lines 530-535 @568e7c3. Save the right leaf for the ancestor that
    // started this deleteMax (the one at hardDeleteLeftDescent direction==0 case).
    saved.node = rightLeaf
    // Returning r.left means: detach this internal node and the right leaf;
    // the parent picks up r.left in our place.
    return { ok: true, newSubtreeRoot: node.left, heightDecreased: true }
  }

  // Rust lines 538-551 @568e7c3. direction == 0. Splice out the right leaf, but
  // the left subtree's max leaf must have its nextLeafKey updated to point past
  // the deleted leaf (i.e. to the deleted leaf's nextLeafKey).
  // direction asserted == 0 (Rust lines 539-543 @568e7c3).
  if (direction !== 0) {
    // Defensive: caller invariant says direction >= 0 here; combined with
    // !deleteMax, direction must be exactly 0. If 1, we'd be in deleteMax
    // mode but flag is false — proof inconsistency.
    return { ok: false, reason: 'proof-malformed' }
  }
  const newLeft = changeNextLeafKeyOfMaxNode(node.left, rightLeaf.nextLeafKey, callbacks, op)
  if (!newLeft.ok) return newLeft
  return { ok: true, newSubtreeRoot: newLeft.node, heightDecreased: true }
}

// ---------------------------------------------------------------------------
// Easy case 2: direction == 0 and r.left is a Leaf
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs Rust lines 555-571 @568e7c3.
 *
 * Entered when the target was found (direction == 0) and the left child is
 * a Leaf (but the right child is NOT a Leaf, else easy case 1 would have
 * fired). We delete the node and its left child leaf; the right subtree
 * becomes the new subtree, but with its leftmost leaf updated to carry the
 * deleted left child's key and value (it now occupies the slot the deleted
 * leaf used to fill).
 *
 * Note: the leaf's `nextLeafKey` is NOT changed — the deleted leaf's
 * `nextLeafKey` is the right subtree's leftmost leaf's existing key
 * (preserved as the new leftmost leaf's `nextLeafKey`). This is consistent
 * with `change_key_and_value_of_min_node`'s implementation, which leaves
 * `next_node_key` untouched for the leftmost leaf.
 *
 * heightDecreased=true: same height-1 logic as easy case 1.
 */
function tryEasyDeleteLeftLeaf(
  node: InternalNode,
  leftLeaf: LeafNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
): DeleteInner {
  // Rust line 560 @568e7c3: `self.on_node_visit(&r.left, operation, false)`.
  // This leaf is spliced out of the tree; the leaf `modifyHelper` matched is
  // the minimum of `node.right`, so nothing else visits this one. Its key and
  // value are exactly what the verifier writes into that minimum leaf below.
  callbacks.onNodeVisit(leftLeaf, op, false)

  // Rust lines 561-569 @568e7c3. Recurse into node.right's leftmost leaf,
  // replacing its key and value with the deleted left leaf's key and value.
  const newRight = changeKeyAndValueOfMinNode(node.right, leftLeaf.key, leftLeaf.value, callbacks, op)
  if (!newRight.ok) return newRight
  return { ok: true, newSubtreeRoot: newRight.node, heightDecreased: true }
}

// ---------------------------------------------------------------------------
// Hard case: direction <= 0 (going left, both children internal)
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs 573-647 @568e7c3.
 *
 * Reached when (a) direction < 0 (target is further left; both children are
 * internal because the easy-case checks above only handled leaf right-children)
 * or (b) direction == 0 AND both children are internal (line 556 @568e7c3's check on
 * `r.left is Leaf` failed). In sub-case (b), we still need to delete from
 * this node, but with neither child being a leaf — so we initiate a deleteMax
 * descent down the left subtree to find the in-order predecessor and copy
 * its key/value into the leftmost leaf of the right subtree.
 *
 * Recursion call (Rust lines 575-576 @568e7c3):
 *   `(new_left, child_height_decreased) = self.delete_helper(&r.left, direction == 0, ...)`
 * The `delete_max` arg becomes `true` exactly when direction == 0.
 *
 * Post-recursion (Rust lines 578-599 @568e7c3):
 *   - direction == 0: take saved_node from the wrapper (the leaf the deleteMax
 *     bottomed out on). Update the right subtree's leftmost leaf's key+value
 *     to the saved leaf's key+value.
 *   - direction < 0: just propagate new_left.
 *
 * Rebalance (Rust lines 600-647 @568e7c3):
 *   - if child shrank and our balance was right-heavy (> 0), we must rotate.
 *     The right child is the offending taller subtree.
 *     - right.balance < 0 → double-left rotation, height decreases.
 *     - right.balance >= 0 → single-left rotation (constructed inline below).
 *   - else, recompute our balance and check whether our subtree height decreased.
 */
function hardDeleteLeftDescent(
  node: InternalNode,
  direction: -1 | 0 | 1,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  saved: SavedNodeRef,
): DeleteInner {
  // Rust lines 575-576 @568e7c3: recursive call into the left subtree.
  // deleteMax becomes true iff direction == 0 (we're at the deletion site
  // with two non-leaf children — start the deleteMax descent on the left).
  const childResult = deleteInner(node.left, direction === 0, op, callbacks, saved)
  if (!childResult.ok) return childResult
  const newLeft = childResult.newSubtreeRoot
  const childHeightDecreased = childResult.heightDecreased

  // Rust lines 578-599 @568e7c3: prepare the new root for the rebalance step.
  let newRoot: InternalNode
  if (direction === 0) {
    // Rust lines 583-585 @568e7c3. Take saved_node — the leaf that bottomed-out on
    // the deleteMax descent. We need its key and value.
    const savedLeaf = saved.node
    if (savedLeaf === null) {
      // Defensive: deleteMax descent must set saved_node before returning.
      // If null here, the proof is malformed (a leaf wasn't reached at the
      // bottom of the deleteMax descent).
      return { ok: false, reason: 'proof-malformed' }
    }
    saved.node = null

    // Rust line 586 @568e7c3:
    // `InternalNode::update_key(r_node, &self.tree().key(&s))` —
    // this node's separator key becomes the saved (promoted) leaf's key, and
    // every node built from it downstream inherits that key, because Rust's
    // `InternalNode::update` takes its key from the template node it is
    // handed (batch_node.rs:321 @568e7c3).
    //
    // The update is REQUIRED, not cosmetic. `deleteHelper` is shared by the
    // prover and the verifier, and the two read this field differently:
    //
    //   - The prover navigates BY key. `BatchAVLProver.nextDirectionIsLeft`
    //     and `unauthenticatedLookup` both do `compareBytes(key, node.key)`,
    //     and `serialize.ts` writes the field into stored trees. A stale
    //     separator here silently corrupts every later traversal through this
    //     subtree — the removed key still routes to a leaf, and a surviving
    //     key on the wrong side of the stale separator becomes unreachable.
    //   - The verifier ignores it: it replays proof direction bits rather
    //     than comparing keys, and `label()` does not hash the key, so proof
    //     bytes and digests are identical either way.
    //
    // An earlier comment here concluded "no-op for the verifier" and dropped
    // the update. That was true of the verifier and false of the prover.
    //
    // The invariant being restored: an internal node's key equals the minimum
    // key of its right subtree. The deleteMax descent above pulled the left
    // subtree's max leaf out; `changeKeyAndValueOfMinNode` below writes that
    // leaf's key/value into the right subtree's leftmost leaf, which makes
    // `savedLeaf.key` the new minimum of the right subtree.
    //
    // Rust lines 587-596 @568e7c3: build the new internal node from the re-keyed one,
    // with the modified right subtree.
    const newRightSubtree = changeKeyAndValueOfMinNode(
      node.right,
      savedLeaf.key,
      savedLeaf.value,
      callbacks,
      op,
    )
    if (!newRightSubtree.ok) return newRightSubtree
    newRoot = newInternal(newLeft, newRightSubtree.node, node.balance, savedLeaf.key)
  } else {
    // Rust line 598 @568e7c3: `r_node.clone()` — preserve the original node's right
    // and balance, but with the new left from the recursion.
    newRoot = newInternal(newLeft, node.right, node.balance, node.key)
  }

  // Rust lines 600-647 @568e7c3: rebalance.
  // We read balance + right from newRoot (mirrors Rust's `let root_balance =
  // self.tree().balance(&new_root)` and `let root_right = self.tree().right(&new_root)`).
  const rootBalance = newRoot.balance
  const rootRight = newRoot.right

  // Rust line 602 @568e7c3: rotation case — child shrank AND we are right-heavy.
  if (childHeightDecreased && rootBalance > 0) {
    return rebalanceShrinkLeft(newLeft, rootRight, op, callbacks, newRoot)
  }

  // Rust lines 636-646 @568e7c3: no rotation, just balance update.
  const newBalance: Balance = childHeightDecreased
    ? ((rootBalance + 1) as Balance) // was 0 (childGrew can yield +1=balance 1, OK) or -1 → 0
    : rootBalance
  // Rust line 644 @568e7c3 templates this node on `&new_root`, so it inherits
  // new_root's key — which the direction === 0 branch above re-keyed to the
  // promoted leaf. Reading `node.key` here instead would throw that update
  // away on the whole no-rotation path, which is the common one: the repro
  // above (Remove of a two-internal-children separator, child shrank, node
  // balance 0) lands here, not in rebalanceShrinkLeft. The rotation path is
  // already correct because it receives `newRoot` as its template.
  const finalNode = newInternal(newLeft, rootRight, newBalance, newRoot.key)
  return {
    ok: true,
    newSubtreeRoot: finalNode,
    heightDecreased: childHeightDecreased && newBalance === 0,
  }
}

/**
 * Ports authenticated_tree_ops.rs Rust lines 604-634 @568e7c3 — rotation when
 * left child shrank and we are right-heavy.
 *
 * Sub-case selector: right child's balance.
 *   - right.balance < 0  → double left rotation. Height ALWAYS decreases.
 *     (Rust lines 608-615 @568e7c3.)
 *   - right.balance >= 0 → single left rotation. Height decreases iff the
 *     new right-side balance == 0. (Rust lines 616-632 @568e7c3.)
 *
 * Single left rotation construction (Rust lines 618-631 @568e7c3):
 *   newLeftChild = (newRoot, newLeft, rightChild.left, 1 - rightChild.balance)
 *   newRBalance  = rightChild.balance - 1
 *   newR         = (rootRight, newLeftChild, rightChild.right, newRBalance)
 *   returns (newR, newRBalance == 0)
 *
 * Per the Rust comment at line 606 @568e7c3: at this point right child is
 * guaranteed Internal — it's taller than our left subtree (rootBalance > 0 +
 * left shrank), and that requires at least an internal node on the right.
 */
function rebalanceShrinkLeft(
  newLeft: AvlNode,
  rootRight: AvlNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  rotateNode: InternalNode,
): DeleteInner {
  // Rust line 604 @568e7c3: `self.on_node_visit(&root_right, operation, true)`,
  // UNCONDITIONAL and ahead of the `if let Node::Internal(right_child)` copy at
  // Rust line 607 @568e7c3 — so it precedes the guard below, and it covers the
  // single-rotate sub-case too. When the caller descended with direction < 0
  // this is the original right child, which the rotation re-parents but never
  // rebuilds wholesale; the verifier must descend into it to replay the rotation.
  callbacks.onNodeVisit(rootRight, op, true)

  if (rootRight.kind !== 'internal') {
    // Defensive: mirrors the `bail!` at Rust line 634 @568e7c3 — the verifier sees
    // this as a malformed proof.
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust line 608 @568e7c3: `if right_child.balance < 0` — double left rotation.
  if (rootRight.balance < 0) {
    // Rust line 611 @568e7c3:
    // `self.on_node_visit(&right_child.left, operation, true)`.
    // `right_child.left` is `rootRight.left` — the node `doubleLeftRotate`
    // promotes to sub-root. An earlier port visited `rotateNode` here instead;
    // that node is built by `newInternal` in this same frame, so it is
    // unreachable from `oldTopNode` and `generateProof` never queries it. The
    // node the proof actually needs went unvisited.
    callbacks.onNodeVisit(rootRight.left, op, true)
    // Grandchild guard — the promoted sub-root. `doubleLeftRotate` reads
    // `node.right.left` (rotation.ts::doubleLeftRotate's grandchild guard)
    // and this is that node.
    //
    // Formerly a DELIBERATE DIVERGENCE from the reference, which PANICKED here
    // pre-568e7c3: `double_left_rotate` read `new_root` and called `.balance()`
    // on it directly, so a non-internal `new_root` (Leaf or LabelOnly) hit the
    // panic inside `Node::balance`. As of `double_left_rotate`
    // (authenticated_tree_ops.rs:156-198 @568e7c3), the reference checks
    // explicitly instead — `ensure!(new_root.borrow().is_internal(), ...)` at
    // :171-174, before calling `.balance()` at :175 — so this guard now mirrors
    // the reference's own check rather than diverging from it.
    //
    // The verifier's tree is materialised from attacker-chosen proof bytes, so
    // a crafted proof can put a LABEL (or, with a crafted balance byte, a LEAF)
    // in this slot. Per facts/avltree.md's no-throw contract we reject instead —
    // the same treatment scrypto's JVM `BatchAVLVerifier` gives it by wrapping
    // replay in a `Try`. Mirrors the child guard above (`rootRight.kind`).
    if (rootRight.left.kind !== 'internal') {
      return { ok: false, reason: 'proof-malformed' }
    }
    // Rust line 613 @568e7c3:
    // `self.double_left_rotate(&new_root, &new_left, &root_right)`.
    // doubleLeftRotate takes a parent node and reads .right + .right.left
    // (we synthesize that parent here). The key must match the Rust r_node
    // (new_root / rotateNode), not the right child.
    const tempParent = newInternal(newLeft, rootRight, 0, rotateNode.key)
    const rotated = doubleLeftRotate(tempParent)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }

  // Rust lines 616-632 @568e7c3: single left rotation.
  // Rust line 622 @568e7c3: new_left_child balance = 1 - right_child.balance.
  //   right_child.balance == 0 → new_left_child.balance = 1.
  //   right_child.balance == 1 → new_left_child.balance = 0.
  // Rust: new_left_child template = r_node (rotateNode), key = rotateNode.key
  const newLeftChildBalance: Balance = (1 - rootRight.balance) as Balance
  const newLeftChild = newInternal(newLeft, rootRight.left, newLeftChildBalance, rotateNode.key)

  // Rust line 624 @568e7c3: new_rbalance = right_child.balance - 1.
  //   right_child.balance == 0 → -1.
  //   right_child.balance == 1 → 0.
  const newRBalance: Balance = (rootRight.balance - 1) as Balance

  // Rust lines 625-630 @568e7c3: new_r = update(root_right, new_left_child,
  //                              right_child.right, new_rbalance).
  const newR = newInternal(newLeftChild, rootRight.right, newRBalance, rootRight.key)

  // Rust line 631 @568e7c3: returns (new_r, new_rbalance == 0).
  return { ok: true, newSubtreeRoot: newR, heightDecreased: newRBalance === 0 }
}

// ---------------------------------------------------------------------------
// Hard case: direction > 0 (going right, right child is internal)
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs 648-695 @568e7c3.
 *
 * Mirror of `hardDeleteLeftDescent` for the right-descent case. Easy-case
 * 1 above already short-circuited when r.right was a Leaf, so here r.right
 * is guaranteed Internal.
 *
 * Recursion call (Rust lines 650-651 @568e7c3):
 *   `(new_right, child_height_decreased) = self.delete_helper(&r.right, delete_max, ...)`
 * `delete_max` propagates unchanged (we're still in the same deleteMax mode
 * if our caller started one).
 *
 * Rebalance (Rust lines 652-694 @568e7c3) — symmetric:
 *   - child shrank AND we were left-heavy (balance < 0) → rotate.
 *     - left.balance > 0 → double-right rotation, height decreases.
 *     - left.balance <= 0 → single-right rotation (inline below).
 *   - else, recompute balance and check height-decrease propagation.
 */
function hardDeleteRightDescent(
  node: InternalNode,
  deleteMax: boolean,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  saved: SavedNodeRef,
): DeleteInner {
  // Rust lines 650-651 @568e7c3: recurse right; deleteMax propagates unchanged.
  const childResult = deleteInner(node.right, deleteMax, op, callbacks, saved)
  if (!childResult.ok) return childResult
  const newRight = childResult.newSubtreeRoot
  const childHeightDecreased = childResult.heightDecreased

  // Rust line 652 @568e7c3: rotation needed iff right subtree shrank AND we were
  // already left-heavy.
  if (childHeightDecreased && node.balance < 0) {
    return rebalanceShrinkRight(node, newRight, op, callbacks)
  }

  // Rust lines 684-693 @568e7c3: no rotation, just balance update.
  const newBalance: Balance = childHeightDecreased
    ? ((node.balance - 1) as Balance) // was 0 → -1 (still valid); +1 → 0 (still valid)
    : node.balance
  const finalNode = newInternal(node.left, newRight, newBalance, node.key)
  return {
    ok: true,
    newSubtreeRoot: finalNode,
    heightDecreased: childHeightDecreased && newBalance === 0,
  }
}

/**
 * Ports authenticated_tree_ops.rs Rust lines 654-681 @568e7c3 — rotation when
 * right child shrank and we are left-heavy.
 *
 * Mirror of `rebalanceShrinkLeft`. Sub-case selector on LEFT child's balance.
 *   - left.balance > 0 → double right rotation. Height ALWAYS decreases.
 *     (Rust lines 658-662 @568e7c3.)
 *   - left.balance <= 0 → single right rotation. Height decreases iff
 *     new sub-root balance == 0. (Rust lines 663-679 @568e7c3.)
 *
 * Single right rotation construction (Rust lines 665-678 @568e7c3):
 *   newRightChild = (r_node, leftChild.right, newRight, -leftChild.balance - 1)
 *   newRBalance   = 1 + leftChild.balance
 *   newR          = (r.left, leftChild.left, newRightChild, newRBalance)
 *   returns (newR, newRBalance == 0)
 *
 * Per the Rust comment at line 656 @568e7c3: left child is guaranteed Internal
 * at this point (taller than the right subtree).
 */
function rebalanceShrinkRight(
  node: InternalNode,
  newRight: AvlNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
): DeleteInner {
  const rootLeft = node.left

  // Rust line 654 @568e7c3: `self.on_node_visit(&r.left, operation, true)`,
  // UNCONDITIONAL and ahead of the `if let Node::Internal(left_child)` copy at
  // Rust line 657 @568e7c3 — the mirror of rebalanceShrinkLeft's visit at Rust
  // line 604 @568e7c3, and it covers the single-rotate sub-case too. `r.left`
  // is the original left child; the rotation re-parents it and the verifier
  // must descend into it.
  callbacks.onNodeVisit(rootLeft, op, true)

  if (rootLeft.kind !== 'internal') {
    // Defensive: mirrors the `bail!` at Rust line 681 @568e7c3 — the verifier sees
    // this as a malformed proof.
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust line 658 @568e7c3: `if left_child.balance > 0` — double right rotation.
  if (rootLeft.balance > 0) {
    // Rust line 661 @568e7c3:
    // `self.on_node_visit(&left_child.right, operation, true)`.
    // `left_child.right` is `rootLeft.right` — the node `doubleRightRotate`
    // promotes to sub-root. An earlier port visited `node` here instead, which
    // `deleteInner` had already visited on the way down, so the call added
    // nothing and the promoted node was left unvisited.
    callbacks.onNodeVisit(rootLeft.right, op, true)
    // Grandchild guard — mirror of `rebalanceShrinkLeft`'s. `doubleRightRotate`
    // reads `node.left.right`
    // (rotation.ts::doubleRightRotate's grandchild guard) and this is that node.
    //
    // Formerly a DELIBERATE DIVERGENCE from the reference, which PANICKED here
    // pre-568e7c3: `double_right_rotate` read `new_root` and called `.balance()`
    // on it directly, so a non-internal `new_root` (Leaf or LabelOnly) hit the
    // panic inside `Node::balance`. As of `double_right_rotate`
    // (authenticated_tree_ops.rs:205-240 @568e7c3), the reference checks
    // explicitly instead — `ensure!(new_root.borrow().is_internal(), ...)` at
    // :215-218, before calling `.balance()` at :219 — so this guard now mirrors
    // the reference's own check rather than diverging from it. We reject per
    // facts/avltree.md's no-throw contract, as scrypto's JVM `BatchAVLVerifier`
    // effectively does via `Try`.
    if (rootLeft.right.kind !== 'internal') {
      return { ok: false, reason: 'proof-malformed' }
    }
    // Rust line 662 @568e7c3:
    // `self.double_right_rotate(r_node, &r.left, &new_right)`.
    // doubleRightRotate takes a parent and reads .left + .left.right
    // (we synthesize that parent here). The key must match the Rust r_node
    // (node), not the left child.
    const tempParent = newInternal(rootLeft, newRight, 0, node.key)
    const rotated = doubleRightRotate(tempParent)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }

  // Rust lines 663-679 @568e7c3: single right rotation.
  // Rust line 669 @568e7c3: new_right_child balance = -left_child.balance - 1.
  //   left_child.balance ==  0 → new_right_child.balance = -1.
  //   left_child.balance == -1 → new_right_child.balance =  0.
  // Rust: new_right_child template = r_node (node), key = node.key
  const newRightChildBalance: Balance = (-rootLeft.balance - 1) as Balance
  const newRightChild = newInternal(rootLeft.right, newRight, newRightChildBalance, node.key)

  // Rust line 671 @568e7c3: new_rbalance = 1 + left_child.balance.
  //   left_child.balance ==  0 → 1.
  //   left_child.balance == -1 → 0.
  const newRBalance: Balance = (1 + rootLeft.balance) as Balance

  // Rust lines 672-677 @568e7c3: new_r = update(r.left, left_child.left,
  //                              new_right_child, new_rbalance).
  const newR = newInternal(rootLeft.left, newRightChild, newRBalance, rootLeft.key)

  // Rust line 678 @568e7c3: returns (new_r, new_rbalance == 0).
  return { ok: true, newSubtreeRoot: newR, heightDecreased: newRBalance === 0 }
}

// ---------------------------------------------------------------------------
// Helpers: change_next_leaf_key_of_max_node + change_key_and_value_of_min_node
// ---------------------------------------------------------------------------

/** Internal result type for the two change-* helpers below. */
type ChangeResult =
  | { readonly ok: true; readonly node: AvlNode }
  | { readonly ok: false; readonly reason: AvlVerifyFailReason }

/**
 * Ports authenticated_tree_ops.rs::change_next_leaf_key_of_max_node
 * (Rust lines 446-461 @568e7c3).
 *
 * Walks down the rightmost path of the given subtree (always recursing into
 * `right`) until hitting a Leaf; replaces that leaf's `nextLeafKey`. Returns
 * a freshly-built subtree (no in-place mutation, per the package convention).
 *
 * Caller context: we just deleted a leaf at the deletion site. The leaf
 * immediately to the deleted leaf's left (i.e., the rightmost leaf of the
 * left subtree) now points its `nextLeafKey` past the deleted leaf to where
 * the deleted leaf was pointing.
 *
 * Encountering a LabelNode is a proof error: the prover must have included
 * the full rightmost path in the proof.
 */
function changeNextLeafKeyOfMaxNode(
  node: AvlNode,
  newNextLeafKey: Uint8Array,
  callbacks: AvlTreeOpsCallbacks,
  op: Operation,
): ChangeResult {
  // Rust line 452 @568e7c3: `self.on_node_visit(r_node, operation, false)` sits
  // at the top of the function, AHEAD of the node-kind match — so every node on
  // this descent is visited, internal nodes included, not only the leaf it
  // bottoms out on.
  //
  // An earlier port visited the leaf alone. That left the right spine of
  // `node.left` packed as labels: `modifyHelper` went down the other side on
  // the first pass, so nothing else visits these nodes, and the verifier's own
  // walk down the spine hits a label and rejects the proof.
  callbacks.onNodeVisit(node, op, false)

  // Rust lines 454-455 @568e7c3: Leaf branch.
  if (node.kind === 'leaf') {
    // LeafNode::update(r_node, &node.hdr.key.unwrap(), &node.value, &next_leaf_key)
    // — same key, same value, new nextLeafKey.
    return { ok: true, node: newLeaf(node.key, node.value, newNextLeafKey) }
  }
  // Rust lines 456-457 @568e7c3: Internal branch — recurse into right.
  if (node.kind === 'internal') {
    const recursed = changeNextLeafKeyOfMaxNode(node.right, newNextLeafKey, callbacks, op)
    if (!recursed.ok) return recursed
    // InternalNode::update(r_node, &node.left, &recursed, node.balance)
    return {
      ok: true,
      node: newInternal(node.left, recursed.node, node.balance, node.key),
    }
  }
  // Rust lines 458-459 @568e7c3: LabelOnly → bail. For the verifier this is a
  // malformed proof (the prover must have supplied the rightmost path).
  return { ok: false, reason: 'proof-malformed' }
}

/**
 * Ports authenticated_tree_ops.rs::change_key_and_value_of_min_node
 * (Rust lines 463-479 @568e7c3).
 *
 * Walks down the leftmost path of the given subtree (always recursing into
 * `left`) until hitting a Leaf; replaces that leaf's `key` and `value`
 * (preserving `nextLeafKey`). Returns a freshly-built subtree.
 *
 * Caller context: see `tryEasyDeleteLeftLeaf` and `hardDeleteLeftDescent`
 * (direction == 0 branch). The leftmost leaf of the right subtree takes
 * over the deleted leaf's logical slot, hence inheriting the deleted leaf's
 * (or the saved-node's) key + value.
 *
 * Note (Rust line 473 @568e7c3): `next_node_key` is intentionally PRESERVED
 * (not replaced) — the leaf already points to its in-order successor, and that
 * relationship doesn't change as we shift its key/value.
 */
function changeKeyAndValueOfMinNode(
  node: AvlNode,
  newKey: Uint8Array,
  newValue: Uint8Array,
  callbacks: AvlTreeOpsCallbacks,
  op: Operation,
): ChangeResult {
  // Rust line 470 @568e7c3: `self.on_node_visit(r_node, operation, false)` at
  // the top of the function, ahead of the node-kind match — the mirror of
  // `changeNextLeafKeyOfMaxNode`'s visit at Rust line 452 @568e7c3. Every node
  // on the left-spine descent is visited, not only the leaf; see that function
  // for what visiting the leaf alone costs.
  callbacks.onNodeVisit(node, op, false)

  // Rust lines 472-473 @568e7c3: Leaf branch.
  if (node.kind === 'leaf') {
    // LeafNode::update(r_node, new_key, new_value, &node.next_node_key)
    return { ok: true, node: newLeaf(newKey, newValue, node.nextLeafKey) }
  }
  // Rust lines 474-475 @568e7c3: Internal branch — recurse into left.
  if (node.kind === 'internal') {
    const recursed = changeKeyAndValueOfMinNode(node.left, newKey, newValue, callbacks, op)
    if (!recursed.ok) return recursed
    // InternalNode::update(r_node, &recursed, &node.right, node.balance)
    return {
      ok: true,
      node: newInternal(recursed.node, node.right, node.balance, node.key),
    }
  }
  // Rust lines 476-477 @568e7c3: LabelOnly → bail. Verifier: malformed proof.
  return { ok: false, reason: 'proof-malformed' }
}
