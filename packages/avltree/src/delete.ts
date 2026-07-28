/**
 * AVL+ tree deletion engine — second pass for Remove / RemoveIfExists and
 * UpdateLongBy-result==0.
 *
 * Ports authenticated_tree_ops.rs::AuthenticatedTreeOps::delete_helper
 * (lines 446-637) plus `change_next_leaf_key_of_max_node` (lines 400-415)
 * and `change_key_and_value_of_min_node` (lines 417-432).
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
 * (authenticated_tree_ops.rs lines 221-248): modify_helper first, then
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
 * parameter is kept in the signature for API symmetry with `modifyHelper`
 * (and would be needed for `on_node_visit` tracking if/when added).
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
 * (authenticated_tree_ops.rs line 451: `saved_node: &mut Option<NodeId>`).
 *
 * Set in `tryEasyDeleteRightLeaf` when deleteMax=true (Rust line 478).
 * Read in `hardDeleteLeftDescent` when direction==0 after the recursive
 * deleteMax returned (Rust line 523).
 *
 * Always a LeafNode in practice: it is set only at line 478 where `r.right`
 * was just verified to be a Leaf via `if let Node::Leaf(right_child) = ...`
 * (Rust line 470).
 */
type SavedNodeRef = { node: LeafNode | null }

// ---------------------------------------------------------------------------
// Public entry — deleteHelper
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs::delete_helper (lines 446-637), public entry
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
 * (lines 446-637). Maintains the Rust signature's `delete_max` parameter
 * (true while descending the leftmost path to find the max for the in-order
 * predecessor swap; see file-level JSDoc above + Rust comment at lines 387-398).
 */
function deleteInner(
  node: AvlNode,
  deleteMax: boolean,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  saved: SavedNodeRef,
): DeleteInner {
  // Rust line 458: `let direction = if delete_max { 1 } else { self.replay_comparison() };`
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

  // Rust line 460: `if let Node::Internal(r) = self.tree().copy(r_node) { ... }`
  // Both branches of the `delete_helper` body assume the current node is
  // Internal. Leaf/Label here = proof-malformed.
  if (node.kind !== 'internal') {
    // Rust line 635: `panic!("Not internal node")` — for the verifier, this
    // is a malformed proof (the prover would have arranged for this branch
    // to land on an internal node).
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust line 453: `self.on_node_visit(r_node, operation, false)`
  callbacks.onNodeVisit(node, op, false)

  // Rust line 461: `assert!(!(direction < 0 && r.left.borrow().is_leaf()));`
  // If we are descending left looking for the deletion target and the left
  // child is a leaf, the target key is not in any internal node's subtree —
  // impossible for a valid proof of a present key.
  if (direction < 0 && node.left.kind === 'leaf') {
    return { ok: false, reason: 'proof-malformed' }
  }

  // Easy case 1 (Rust lines 469-494): direction >= 0 AND r.right is a Leaf.
  if (direction >= 0 && node.right.kind === 'leaf') {
    return tryEasyDeleteRightLeaf(node, node.right, direction, deleteMax, op, callbacks, saved)
  }

  // Easy case 2 (Rust lines 495-511): direction == 0 AND r.left is a Leaf.
  if (direction === 0 && node.left.kind === 'leaf') {
    return tryEasyDeleteLeftLeaf(node, node.left, op, callbacks)
  }

  // Hard cases (Rust lines 512-633).
  if (direction <= 0) {
    // Rust lines 513-585: going left (or deleteMax-from-here case).
    // The structural assertion (line 461) plus the easy-case exits above
    // guarantee node.left is Internal at this point.
    return hardDeleteLeftDescent(node, direction, op, callbacks, saved)
  }
  // Rust lines 586-633: going right. The easy-case exits guarantee node.right
  // is Internal here (line 469 fired on Leaf right-children).
  return hardDeleteRightDescent(node, deleteMax, op, callbacks, saved)
}

// ---------------------------------------------------------------------------
// Easy case 1: direction >= 0 and r.right is a Leaf
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs lines 469-494.
 *
 * Two sub-cases:
 *   - deleteMax (direction == 1): save the right leaf's info into `saved.node`
 *     (it will be promoted into the in-order successor by an ancestor frame).
 *     Return the left subtree as the new subtree root. (Rust lines 474-479.)
 *
 *   - direction == 0: we found the leaf to delete. Replace `nextLeafKey` of
 *     the rightmost leaf of `r.left` with the deleted leaf's `nextLeafKey`,
 *     then return the modified left subtree. (Rust lines 482-491.)
 *
 * Both sub-cases return heightDecreased=true: the subtree at this node was
 * `(left subtree height + 1)` deep — replacing it with the left subtree
 * decreases that subtree's height by 1.
 *
 * Note: direction is asserted to be exactly 0 in the non-deleteMax branch
 * (Rust line 483: `assert!(direction == 0)`). direction can't be < 0 here
 * because the caller already checked `direction >= 0`.
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
  if (deleteMax) {
    // Rust lines 474-479. Save the right leaf for the ancestor that started
    // this deleteMax (the one at hardDeleteLeftDescent direction==0 case).
    saved.node = rightLeaf
    // Returning r.left means: detach this internal node and the right leaf;
    // the parent picks up r.left in our place.
    return { ok: true, newSubtreeRoot: node.left, heightDecreased: true }
  }

  // Rust lines 482-491. direction == 0. Splice out the right leaf, but the
  // left subtree's max leaf must have its nextLeafKey updated to point past
  // the deleted leaf (i.e. to the deleted leaf's nextLeafKey).
  // direction asserted == 0 (Rust line 483).
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
 * Ports authenticated_tree_ops.rs lines 495-511.
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
  // Rust lines 501-509. Recurse into node.right's leftmost leaf, replacing
  // its key and value with the deleted left leaf's key and value.
  const newRight = changeKeyAndValueOfMinNode(node.right, leftLeaf.key, leftLeaf.value, callbacks, op)
  if (!newRight.ok) return newRight
  return { ok: true, newSubtreeRoot: newRight.node, heightDecreased: true }
}

// ---------------------------------------------------------------------------
// Hard case: direction <= 0 (going left, both children internal)
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs lines 512-585.
 *
 * Reached when (a) direction < 0 (target is further left; both children are
 * internal because the easy-case checks above only handled leaf right-children)
 * or (b) direction == 0 AND both children are internal (line 495's check on
 * `r.left is Leaf` failed). In sub-case (b), we still need to delete from
 * this node, but with neither child being a leaf — so we initiate a deleteMax
 * descent down the left subtree to find the in-order predecessor and copy
 * its key/value into the leftmost leaf of the right subtree.
 *
 * Recursion call (Rust line 516):
 *   `(new_left, child_height_decreased) = self.delete_helper(&r.left, direction == 0, ...)`
 * The `delete_max` arg becomes `true` exactly when direction == 0.
 *
 * Post-recursion (Rust lines 518-537):
 *   - direction == 0: take saved_node from the wrapper (the leaf the deleteMax
 *     bottomed out on). Update the right subtree's leftmost leaf's key+value
 *     to the saved leaf's key+value.
 *   - direction < 0: just propagate new_left.
 *
 * Rebalance (Rust lines 538-585):
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
  // Rust line 516: recursive call into the left subtree.
  // deleteMax becomes true iff direction == 0 (we're at the deletion site
  // with two non-leaf children — start the deleteMax descent on the left).
  const childResult = deleteInner(node.left, direction === 0, op, callbacks, saved)
  if (!childResult.ok) return childResult
  const newLeft = childResult.newSubtreeRoot
  const childHeightDecreased = childResult.heightDecreased

  // Rust lines 518-537: prepare the new root for the rebalance step.
  let newRoot: InternalNode
  if (direction === 0) {
    // Rust lines 522-534. Take saved_node — the leaf that bottomed-out on
    // the deleteMax descent. We need its key and value.
    const savedLeaf = saved.node
    if (savedLeaf === null) {
      // Defensive: deleteMax descent must set saved_node before returning.
      // If null here, the proof is malformed (a leaf wasn't reached at the
      // bottom of the deleteMax descent).
      return { ok: false, reason: 'proof-malformed' }
    }
    saved.node = null

    // Rust line 524: `InternalNode::update_key(r_node, &self.tree().key(&s))` —
    // updates this internal node's stored key to the saved leaf's key. The
    // verifier's TS InternalNode has no `key` field (see node.ts) — internal
    // node keys are reconstructed on the fly via replay_comparison. So the
    // key update is a no-op for the verifier.
    //
    // Rust lines 525-528: extract left/right/balance from the updated node.
    // For us, these are just node.left (already deleted from above) and
    // node.right.
    //
    // Rust lines 529-534: build new internal node with the modified right
    // subtree (where the leftmost leaf has been replaced with saved_leaf's
    // key+value).
    const newRightSubtree = changeKeyAndValueOfMinNode(
      node.right,
      savedLeaf.key,
      savedLeaf.value,
      callbacks,
      op,
    )
    if (!newRightSubtree.ok) return newRightSubtree
    newRoot = newInternal(newLeft, newRightSubtree.node, node.balance, node.key)
  } else {
    // Rust line 536: `r_node.clone()` — preserve the original node's right
    // and balance, but with the new left from the recursion.
    newRoot = newInternal(newLeft, node.right, node.balance, node.key)
  }

  // Rust lines 538-585: rebalance.
  // We read balance + right from newRoot (mirrors Rust's `let root_balance =
  // self.tree().balance(&new_root)` and `let root_right = self.tree().right(&new_root)`).
  const rootBalance = newRoot.balance
  const rootRight = newRoot.right

  // Rust line 540: rotation case — child shrank AND we are right-heavy.
  if (childHeightDecreased && rootBalance > 0) {
    return rebalanceShrinkLeft(newLeft, rootRight, op, callbacks, newRoot)
  }

  // Rust lines 574-584: no rotation, just balance update.
  const newBalance: Balance = childHeightDecreased
    ? ((rootBalance + 1) as Balance) // was 0 (childGrew can yield +1=balance 1, OK) or -1 → 0
    : rootBalance
  const finalNode = newInternal(newLeft, rootRight, newBalance, node.key)
  return {
    ok: true,
    newSubtreeRoot: finalNode,
    heightDecreased: childHeightDecreased && newBalance === 0,
  }
}

/**
 * Ports authenticated_tree_ops.rs lines 541-572 — rotation when left child
 * shrank and we are right-heavy.
 *
 * Sub-case selector: right child's balance.
 *   - right.balance < 0  → double left rotation. Height ALWAYS decreases.
 *     (Rust lines 547-553.)
 *   - right.balance >= 0 → single left rotation. Height decreases iff the
 *     new right-side balance == 0. (Rust lines 555-569.)
 *
 * Single left rotation construction (Rust lines 556-569):
 *   newLeftChild = (newRoot, newLeft, rightChild.left, 1 - rightChild.balance)
 *   newRBalance  = rightChild.balance - 1
 *   newR         = (rootRight, newLeftChild, rightChild.right, newRBalance)
 *   returns (newR, newRBalance == 0)
 *
 * Per the Rust comment at line 544: at this point right child is guaranteed
 * Internal — it's taller than our left subtree (rootBalance > 0 + left
 * shrank), and that requires at least an internal node on the right.
 */
function rebalanceShrinkLeft(
  newLeft: AvlNode,
  rootRight: AvlNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  rotateNode: InternalNode,
): DeleteInner {
  if (rootRight.kind !== 'internal') {
    // Defensive: per Rust line 571's panic, the verifier sees this as a
    // malformed proof.
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust line 546: `if right_child.balance < 0` — double left rotation.
  if (rootRight.balance < 0) {
    // Rust line 551: `self.on_node_visit(r_node, operation, true)`
    callbacks.onNodeVisit(rotateNode, op, true)
    // Rust line 551: `self.double_left_rotate(&new_root, &new_left, &root_right)`.
    // doubleLeftRotate takes a parent node and reads .right + .right.left
    // (we synthesize that parent here). The key must match the Rust r_node
    // (new_root / rotateNode), not the right child.
    const tempParent = newInternal(newLeft, rootRight, 0, rotateNode.key)
    const rotated = doubleLeftRotate(tempParent)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }

  // Rust lines 555-569: single left rotation.
  // Rust line 560: new_left_child balance = 1 - right_child.balance.
  //   right_child.balance == 0 → new_left_child.balance = 1.
  //   right_child.balance == 1 → new_left_child.balance = 0.
  // Rust: new_left_child template = r_node (rotateNode), key = rotateNode.key
  const newLeftChildBalance: Balance = (1 - rootRight.balance) as Balance
  const newLeftChild = newInternal(newLeft, rootRight.left, newLeftChildBalance, rotateNode.key)

  // Rust line 562: new_rbalance = right_child.balance - 1.
  //   right_child.balance == 0 → -1.
  //   right_child.balance == 1 → 0.
  const newRBalance: Balance = (rootRight.balance - 1) as Balance

  // Rust lines 563-568: new_r = update(root_right, new_left_child,
  //                       right_child.right, new_rbalance).
  const newR = newInternal(newLeftChild, rootRight.right, newRBalance, rootRight.key)

  // Rust line 569: returns (new_r, new_rbalance == 0).
  return { ok: true, newSubtreeRoot: newR, heightDecreased: newRBalance === 0 }
}

// ---------------------------------------------------------------------------
// Hard case: direction > 0 (going right, right child is internal)
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs lines 586-633.
 *
 * Mirror of `hardDeleteLeftDescent` for the right-descent case. Easy-case
 * 1 above already short-circuited when r.right was a Leaf, so here r.right
 * is guaranteed Internal.
 *
 * Recursion call (Rust line 588):
 *   `(new_right, child_height_decreased) = self.delete_helper(&r.right, delete_max, ...)`
 * `delete_max` propagates unchanged (we're still in the same deleteMax mode
 * if our caller started one).
 *
 * Rebalance (Rust lines 590-632) — symmetric:
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
  // Rust line 588: recurse right; deleteMax propagates unchanged.
  const childResult = deleteInner(node.right, deleteMax, op, callbacks, saved)
  if (!childResult.ok) return childResult
  const newRight = childResult.newSubtreeRoot
  const childHeightDecreased = childResult.heightDecreased

  // Rust line 590: rotation needed iff right subtree shrank AND we were
  // already left-heavy.
  if (childHeightDecreased && node.balance < 0) {
    return rebalanceShrinkRight(node, newRight, op, callbacks)
  }

  // Rust lines 622-631: no rotation, just balance update.
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
 * Ports authenticated_tree_ops.rs lines 592-620 — rotation when right child
 * shrank and we are left-heavy.
 *
 * Mirror of `rebalanceShrinkLeft`. Sub-case selector on LEFT child's balance.
 *   - left.balance > 0 → double right rotation. Height ALWAYS decreases.
 *     (Rust lines 597-600.)
 *   - left.balance <= 0 → single right rotation. Height decreases iff
 *     new sub-root balance == 0. (Rust lines 602-616.)
 *
 * Single right rotation construction (Rust lines 603-616):
 *   newRightChild = (r_node, leftChild.right, newRight, -leftChild.balance - 1)
 *   newRBalance   = 1 + leftChild.balance
 *   newR          = (r.left, leftChild.left, newRightChild, newRBalance)
 *   returns (newR, newRBalance == 0)
 *
 * Per Rust comment at line 594: left child is guaranteed Internal at this
 * point (taller than the right subtree).
 */
function rebalanceShrinkRight(
  node: InternalNode,
  newRight: AvlNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
): DeleteInner {
  const rootLeft = node.left
  if (rootLeft.kind !== 'internal') {
    // Defensive: per Rust line 619's panic, the verifier sees this as
    // malformed proof.
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust line 596: `if left_child.balance > 0` — double right rotation.
  if (rootLeft.balance > 0) {
    // Rust line 600: `self.on_node_visit(r_node, operation, true)`
    callbacks.onNodeVisit(node, op, true)
    // Rust line 600: `self.double_right_rotate(r_node, &r.left, &new_right)`.
    // doubleRightRotate takes a parent and reads .left + .left.right
    // (we synthesize that parent here). The key must match the Rust r_node
    // (node), not the left child.
    const tempParent = newInternal(rootLeft, newRight, 0, node.key)
    const rotated = doubleRightRotate(tempParent)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }

  // Rust lines 602-616: single right rotation.
  // Rust line 607: new_right_child balance = -left_child.balance - 1.
  //   left_child.balance ==  0 → new_right_child.balance = -1.
  //   left_child.balance == -1 → new_right_child.balance =  0.
  // Rust: new_right_child template = r_node (node), key = node.key
  const newRightChildBalance: Balance = (-rootLeft.balance - 1) as Balance
  const newRightChild = newInternal(rootLeft.right, newRight, newRightChildBalance, node.key)

  // Rust line 609: new_rbalance = 1 + left_child.balance.
  //   left_child.balance ==  0 → 1.
  //   left_child.balance == -1 → 0.
  const newRBalance: Balance = (1 + rootLeft.balance) as Balance

  // Rust lines 610-615: new_r = update(r.left, left_child.left,
  //                       new_right_child, new_rbalance).
  const newR = newInternal(rootLeft.left, newRightChild, newRBalance, rootLeft.key)

  // Rust line 616: returns (new_r, new_rbalance == 0).
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
 * (lines 400-415).
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
  // Rust lines 408-409: Leaf branch.
  if (node.kind === 'leaf') {
    // Visit the OLD leaf before creating the replacement, so packTree (which
    // traverses from oldTopNode) can find it in modifiedNodes. In Rust this is
    // unnecessary (the leaf is mutated in place, Rc identity preserved), but
    // in our immutable model the replacement is a fresh object — the old leaf
    // must be marked so the proof encoder expands it instead of emitting a label.
    callbacks.onNodeVisit(node, op, false)
    // LeafNode::update(r_node, &node.hdr.key.unwrap(), &node.value, &next_leaf_key)
    // — same key, same value, new nextLeafKey.
    return { ok: true, node: newLeaf(node.key, node.value, newNextLeafKey) }
  }
  // Rust lines 410-411: Internal branch — recurse into right.
  if (node.kind === 'internal') {
    const recursed = changeNextLeafKeyOfMaxNode(node.right, newNextLeafKey, callbacks, op)
    if (!recursed.ok) return recursed
    // InternalNode::update(r_node, &node.left, &recursed, node.balance)
    return {
      ok: true,
      node: newInternal(node.left, recursed.node, node.balance, node.key),
    }
  }
  // Rust lines 412-414: LabelOnly → panic. For the verifier this is a
  // malformed proof (the prover must have supplied the rightmost path).
  return { ok: false, reason: 'proof-malformed' }
}

/**
 * Ports authenticated_tree_ops.rs::change_key_and_value_of_min_node
 * (lines 417-432).
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
 * Note (Rust line 427): `next_node_key` is intentionally PRESERVED (not
 * replaced) — the leaf already points to its in-order successor, and that
 * relationship doesn't change as we shift its key/value.
 */
function changeKeyAndValueOfMinNode(
  node: AvlNode,
  newKey: Uint8Array,
  newValue: Uint8Array,
  callbacks: AvlTreeOpsCallbacks,
  op: Operation,
): ChangeResult {
  // Rust lines 426-427: Leaf branch.
  if (node.kind === 'leaf') {
    // Visit the OLD leaf before creating the replacement (see changeNextLeafKeyOfMaxNode
    // for rationale — same immutable-model divergence from Rust's in-place mutation).
    callbacks.onNodeVisit(node, op, false)
    // LeafNode::update(r_node, new_key, new_value, &node.next_node_key)
    return { ok: true, node: newLeaf(newKey, newValue, node.nextLeafKey) }
  }
  // Rust lines 428-429: Internal branch — recurse into left.
  if (node.kind === 'internal') {
    const recursed = changeKeyAndValueOfMinNode(node.left, newKey, newValue, callbacks, op)
    if (!recursed.ok) return recursed
    // InternalNode::update(r_node, &recursed, &node.right, node.balance)
    return {
      ok: true,
      node: newInternal(recursed.node, node.right, node.balance, node.key),
    }
  }
  // Rust lines 430-431: LabelOnly → panic. Verifier: malformed proof.
  return { ok: false, reason: 'proof-malformed' }
}
