/**
 * AVL+ tree modification engine — Lookup / Insert / Update / InsertOrUpdate /
 * UpdateLongBy / UnknownModification.
 *
 * Ports authenticated_tree_ops.rs::AuthenticatedTreeOps::modify_helper
 * (lines 262-385) plus `add_node` (lines 205-219).
 *
 * CONSENSUS-CRITICAL — every branch is byte-faithful with the Rust
 * reference. Tree-shape changes (Insert split ordering, balance updates,
 * rotation selection) must match exactly or downstream digest comparisons fail.
 *
 * THIS FILE handles six Operation variants:
 *   - Lookup             — short-circuit at the matching leaf; never invokes updateFn.
 *   - Insert             — succeeds on absent key (tree split), fails on present (precondition).
 *   - Update             — succeeds on present key (value swap), fails on absent.
 *   - InsertOrUpdate     — unconditional set (split on absent, value swap on present).
 *   - UpdateLongBy       — add delta to existing i64; result=0 signals needsDelete (T15).
 *   - UnknownModification — passthrough; tree shape never changes (T15).
 *
 * Remove + RemoveIfExists live in delete.ts (T16) — a structurally different
 * code path.
 *
 * Per [[feedback-rust-port-style]]: decomposed into TS-idiomatic helpers
 * rather than one ~140-line function, each with per-section source-line
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
import {
  keyMatchesLeaf,
  nextDirectionIsLeft,
  type TraversalState,
} from './tree-traversal.js'
import { updateFn, type Operation } from './operation.js'
import type { AvlVerifyFailReason } from './errors.js'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Success result of `modifyHelper`. Mirrors all five Rust return tuple fields:
 * (new_root_node, change_happened, height_increased, to_delete, old_value).
 *
 * `changeHappened` distinguishes "the subtree was structurally modified"
 * (Insert/Update/InsertOrUpdate) from "nothing changed" (Lookup). Critical
 * for the recursive rebalance branch: when no change happened the parent
 * returns its original node without creating a new internal node.
 *
 * `needsDelete` mirrors Rust's `to_delete` flag (authenticated_tree_ops.rs:234,
 * lines 288, 351, 377). When true, the leaf at the matching key must be removed
 * by the caller via `deleteHelper` (T16). The caller (`return_result_of_one_operation`
 * in T17/BatchAvlVerifier) handles this two-phase dispatch:
 *   1. modifyHelper returns needsDelete=true (UpdateLongBy result=0 case)
 *   2. caller calls deleteHelper on the returned newSubtreeRoot
 * The flag propagates upward through internal nodes in the !changeHappened path
 * (Rust lines 351, 377 — `(r_node.clone(), false, false, to_delete, old_value)`).
 */
export type ModifyOk = {
  readonly ok: true
  readonly newSubtreeRoot: AvlNode
  /** Did this subtree's structure change? Mirrors Rust `ChangeHappened`. */
  readonly changeHappened: boolean
  /**
   * Change in subtree height. 0 or +1 for insertions (Insert/UpdateLongBy absent);
   * 0 for updates and lookups. Delete paths (T16) can return -1.
   */
  readonly heightDelta: -1 | 0 | 1
  /** Old value at this key, or null if key was absent. */
  readonly oldValue: Uint8Array | null
  /**
   * Mirrors Rust `to_delete` (authenticated_tree_ops.rs line 288).
   * True only when UpdateLongBy result == 0: the leaf must be deleted by the
   * caller via deleteHelper (T16). Always false for all other operations handled
   * here. When true, changeHappened is always false and newSubtreeRoot is the
   * unchanged original node (mirroring Rust line 288: `(r_node.clone(), false, false, true, ...)`).
   */
  readonly needsDelete: boolean
}
export type ModifyFail = { readonly ok: false; readonly reason: AvlVerifyFailReason }
export type ModifyResult = ModifyOk | ModifyFail

// ---------------------------------------------------------------------------
// Public entry — modifyHelper
// ---------------------------------------------------------------------------

/**
 * Ports authenticated_tree_ops.rs::modify_helper (lines 262-385).
 * Walks the tree per the proof's directions, applies the operation at the
 * matching leaf, and rebalances the subtree on the way back up.
 *
 * Top-level dispatch on `node.kind`:
 *  - 'leaf'      → handleLeafNode (leaf-match check + per-op semantics)
 *  - 'internal'  → handleInternalNode (recurse + rebalance, consumes one direction bit)
 *  - 'label'     → 'proof-malformed' (mirrors Rust line 381-382 bail)
 *
 * `proof` and `state` are threaded through to handleInternalNode where the
 * directions bit-string is consumed during descent (nextDirectionIsLeft).
 */
export function modifyHelper(
  node: AvlNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult {
  switch (node.kind) {
    case 'leaf':
      return handleLeafNode(node, op)
    case 'internal':
      return handleInternalNode(node, op, proof, state)
    case 'label':
      // Rust line 381-382: `_ => bail!("...this proof is wrong")`.
      // A LabelNode at this point means the proof's "directions" descended
      // into a subtree we don't have full data for — the prover should have
      // included the path.
      return { ok: false, reason: 'proof-malformed' }
  }
}

// ---------------------------------------------------------------------------
// Leaf-branch handler
// ---------------------------------------------------------------------------

/**
 * Ports the leaf branch of modify_helper (lines 277-322 — `Node::Leaf(r) => { ... }`).
 *
 * Two top-level sub-branches keyed off `keyMatchesLeaf`:
 *   - matches=true  (key === leaf.key): the leaf IS the target.
 *   - matches=false (leaf.key < key < leaf.nextLeafKey): key would slot between.
 *
 * Within each sub-branch, Lookup is short-circuited (no updateFn call).
 * Other ops go through updateFn, which determines per-op semantics
 * (insert / update / fail).
 *
 * Rust source uses `key_matches_leaf` returning bool (true = match);
 * the TS variant returns a result with an explicit failure mode for
 * "leaf-key-out-of-order" (proof-malformed → caller rejects).
 */
function handleLeafNode(leaf: LeafNode, op: Operation): ModifyResult {
  // Rust line 278: `if self.key_matches_leaf(key, &r)? { ... }`
  const m = keyMatchesLeaf(op.key, leaf)
  if (!m.ok) {
    // 'leaf-key-out-of-order' propagates as a verification failure.
    return { ok: false, reason: m.reason }
  }

  if (m.matches) {
    return handleLeafMatch(leaf, op)
  }
  return handleLeafGap(leaf, op)
}

/**
 * Ports Rust modify_helper lines 278-299 — the `if key_matches_leaf(...)` true branch.
 *
 * key === leaf.key. Behavior by operation:
 *   - Lookup             — short-circuit; return leaf.value as oldValue, no change.
 *                          (Rust lines 280-283.)
 *   - UnknownModification — short-circuit; return leaf.value as oldValue, no change.
 *                          (Rust lines 280-283 — same path as Lookup: updateFn returns
 *                          oldValue, so changeHappened=false, tree unmodified.)
 *   - Insert             — updateFn returns 'key-already-exists' → fail.
 *   - Update             — updateFn returns newValue; replace leaf with new value.
 *                          oldValue = leaf.value. (Rust lines 290-296.)
 *   - InsertOrUpdate     — same as Update on match.
 *   - UpdateLongBy       — updateFn computes delta+existing. Three sub-cases:
 *                          a. result > 0  → update leaf value (Rust lines 290-296).
 *                          b. result == 0 → signal needsDelete=true; tree not yet
 *                             modified (Rust lines 286-289: to_delete=true,
 *                             change_happened=false, returns r_node unchanged).
 *                          c. updateFn fails (result < 0, decrement-on-absent-key)
 *                             → 'operation-precondition-failed'.
 *   - (Remove, RemoveIfExists — live in delete.ts T16.)
 */
function handleLeafMatch(leaf: LeafNode, op: Operation): ModifyResult {
  // Lookup + UnknownModification short-circuit (Rust lines 280-283).
  // UnknownModification's updateFn returns oldValue unchanged — equivalent to
  // Lookup at the tree-structure level (no modification, return existing value).
  // We short-circuit before calling updateFn for UnknownModification too, matching
  // Rust's Lookup branch: (r_node.clone(), false, false, false, Some(r.value)).
  if (op.tag === 'Lookup' || op.tag === 'UnknownModification') {
    return {
      ok: true,
      newSubtreeRoot: leaf,
      changeHappened: false,
      heightDelta: 0,
      oldValue: leaf.value,
      needsDelete: false,
    }
  }

  // Modification: invoke updateFn with the existing value (Rust line 285).
  const u = updateFn(op, leaf.value)
  if (!u.ok) {
    // key-already-exists (Insert), result-negative (UpdateLongBy), etc.
    // Rust returns `Err(anyhow!(...))?` — TS maps all updateFn failures
    // to 'operation-precondition-failed' (per spec).
    return { ok: false, reason: 'operation-precondition-failed' }
  }

  // newValue === null means "delete this leaf" — UpdateLongBy result==0.
  // Rust lines 286-289:
  //   None => {  // delete key
  //     self.on_node_visit(r_node, operation, false);
  //     (r_node.clone(), false, false, true, Some(r.value))
  //   }
  // We return the leaf unchanged (newSubtreeRoot=leaf, changeHappened=false)
  // and signal needsDelete=true. The caller (BatchAvlVerifier T17) routes this
  // to deleteHelper (T16) after modifyHelper completes.
  // Note: Remove/RemoveIfExists (also null) are dispatched through delete.ts
  // directly (T16) and never reach this function.
  if (u.newValue === null) {
    return {
      ok: true,
      newSubtreeRoot: leaf,      // Rust: r_node.clone() — unchanged
      changeHappened: false,     // Rust: false
      heightDelta: 0,
      oldValue: leaf.value,
      needsDelete: true,         // Rust: to_delete=true
    }
  }

  // Update / InsertOrUpdate / UpdateLongBy (non-zero result): replace the leaf
  // with a new one carrying the new value, same key and nextLeafKey (Rust line 293).
  // The Rust impl uses `LeafNode::update(r_node, &r.hdr.key.unwrap(), &v, &r.next_node_key)`.
  const newLeafNode = newLeaf(leaf.key, u.newValue, leaf.nextLeafKey)
  return {
    ok: true,
    newSubtreeRoot: newLeafNode,
    changeHappened: true,
    heightDelta: 0, // value swap doesn't change subtree height
    oldValue: leaf.value,
    needsDelete: false,
  }
}

/**
 * Ports Rust modify_helper lines 300-321 — the `else` branch
 * (key falls in the gap [leaf.key, leaf.nextLeafKey)).
 *
 * leaf.key < op.key < leaf.nextLeafKey. Behavior by operation:
 *   - Lookup             — short-circuit; oldValue = null, no change.
 *                          (Rust lines 303-305.)
 *   - UnknownModification — short-circuit; oldValue = null, no change.
 *                          (Rust lines 303-305 — same path as Lookup: updateFn returns
 *                          null on absent, so no change happens.)
 *   - Insert             — updateFn returns newValue; SPLIT the leaf via add_node.
 *                          oldValue = null, heightDelta = +1. (Rust lines 313-317.)
 *   - Update             — updateFn returns 'key-not-found' → fail.
 *   - InsertOrUpdate     — same as Insert on absent.
 *   - UpdateLongBy delta > 0 — same as Insert on absent (new key inserted with delta).
 *   - UpdateLongBy delta < 0 — updateFn returns 'decrement-on-absent-key' → fail.
 *   - UpdateLongBy delta == 0 — updateFn returns null (no-op passthrough) → no change.
 *   - (Remove, RemoveIfExists — live in delete.ts T16.)
 */
function handleLeafGap(leaf: LeafNode, op: Operation): ModifyResult {
  // Lookup + UnknownModification short-circuit (Rust lines 303-305).
  // For UnknownModification on an absent key: updateFn returns null (oldValue=null),
  // which we handle in the null branch below — but we short-circuit here for
  // clarity and to match the Rust structural pattern exactly.
  if (op.tag === 'Lookup' || op.tag === 'UnknownModification') {
    return {
      ok: true,
      newSubtreeRoot: leaf,
      changeHappened: false,
      heightDelta: 0,
      oldValue: null,
      needsDelete: false,
    }
  }

  // Modification: invoke updateFn with null (absent) — Rust line 308.
  const u = updateFn(op, null)
  if (!u.ok) {
    // key-not-found (Update / Remove), key-already-exists (impossible here),
    // decrement-on-absent-key (UpdateLongBy with delta < 0 on absent key).
    return { ok: false, reason: 'operation-precondition-failed' }
  }

  // newValue === null on absent key means "no insertion needed" — matches
  // Rust lines 309-311:
  //   None => {  // don't change anything, just lookup
  //     self.on_node_visit(r_node, operation, false);
  //     (r_node.clone(), false, false, false, None)
  //   }
  // Reachable for: RemoveIfExists (absent — no-op), UpdateLongBy delta=0 (no-op).
  // Both: no structural change, no delete needed.
  if (u.newValue === null) {
    return {
      ok: true,
      newSubtreeRoot: leaf,
      changeHappened: false,
      heightDelta: 0,
      oldValue: null,
      needsDelete: false,
    }
  }

  // Insert / InsertOrUpdate / UpdateLongBy (absent, delta > 0): SPLIT — wrap
  // the existing leaf and the new leaf into a new internal node.
  // Rust line 316: `self.add_node(r_node, &key, &v)`.
  // The new subtree grew by 1 level. (Rust line 316: heightIncreased=true.)
  return {
    ok: true,
    newSubtreeRoot: addNode(leaf, op.key, u.newValue),
    changeHappened: true,
    heightDelta: 1,
    oldValue: null,
    needsDelete: false,
  }
}

/**
 * Ports authenticated_tree_ops.rs::add_node (lines 205-219).
 *
 * Constructs a new internal node containing:
 *   - left:  modified original leaf with nextLeafKey = newKey (was leaf.nextLeafKey)
 *   - right: new leaf (newKey, newValue, nextLeafKey = leaf's old nextLeafKey)
 *
 * Ordering is correct because handleLeafGap is only entered when
 * leaf.key < newKey < leaf.nextLeafKey — so the original leaf (smaller key)
 * goes LEFT and the new leaf (larger key) goes RIGHT.
 *
 * Balance is 0 (perfectly balanced — two leaf children of equal height).
 *
 * Rust source — LeafNode::update preserves the leaf identity in storage,
 * but the TS port allocates fresh leaves (mirrors rotation.ts policy of
 * always-fresh-allocation to sidestep labelCache invalidation).
 */
function addNode(leaf: LeafNode, newKey: Uint8Array, newValue: Uint8Array): InternalNode {
  // Original leaf is rebound with nextLeafKey = newKey (we're inserting
  // between this leaf and its old successor).
  const modifiedOriginal = newLeaf(leaf.key, leaf.value, newKey)
  // New leaf points at the old successor.
  const newLeafNode = newLeaf(newKey, newValue, leaf.nextLeafKey)
  // Balance 0: two leaf children of equal height.
  return newInternal(modifiedOriginal, newLeafNode, 0)
}

// ---------------------------------------------------------------------------
// Internal-branch handler
// ---------------------------------------------------------------------------

/**
 * Ports the internal branch of modify_helper (lines 323-380 — `Node::Internal(r) => { ... }`).
 *
 * 1. Read direction bit from the proof: goLeft = nextDirectionIsLeft(...).
 * 2. Recurse into the chosen child.
 * 3. On recursive failure, propagate.
 * 4. On recursive success: if changeHappened, possibly rotate; otherwise return
 *    the original node unchanged.
 *
 * The post-recursion logic mirrors Rust lines 332-352 (left descent) and
 * 358-378 (right descent), factored into the helper rebalanceLeftDescent /
 * rebalanceRightDescent below.
 */
function handleInternalNode(
  node: InternalNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult {
  // Rust line 327: `if self.next_direction_is_left(key, &r) { ... }`
  // Consumes one direction bit unconditionally (off-by-one in direction
  // consumption is one of the primary failure modes byte-equality tests catch).
  const goLeft = nextDirectionIsLeft(proof, state)

  if (goLeft) {
    const childResult = modifyHelper(node.left, op, proof, state)
    if (!childResult.ok) return childResult
    return rebalanceLeftDescent(node, childResult)
  }
  const childResult = modifyHelper(node.right, op, proof, state)
  if (!childResult.ok) return childResult
  return rebalanceRightDescent(node, childResult)
}

/**
 * Ports Rust modify_helper lines 332-352 — post-recursion logic for left descent.
 *
 * Cases (in order, per Rust):
 *   1. !changeHappened  → return original node, propagate oldValue (line 351).
 *                         (Lookups and no-op modifications take this path.)
 *   2. childHeightIncreased && node.balance < 0  → ROTATE.
 *      Sub-case by new left child's balance:
 *        a. newLeft.balance < 0  → single right rotation (line 336-339).
 *        b. newLeft.balance >= 0 → double right rotation (line 341).
 *      Rotation absorbs the height growth: returned heightDelta = 0.
 *   3. !rotate (no rotation needed):
 *      - If childHeightIncreased && node.balance == 0: my height grew (line 345).
 *      - new balance = balance - 1 if child grew, else balance unchanged (line 346).
 *      - Construct new internal node with the new left child (line 347).
 */
function rebalanceLeftDescent(node: InternalNode, child: ModifyOk): ModifyResult {
  // Case 1: no change happened. Rust line 351:
  //   `(r_node.clone(), false, false, to_delete, old_value)`
  // to_delete propagates upward here — if the child signals needsDelete=true,
  // the parent returns the original node unchanged but propagates needsDelete.
  if (!child.changeHappened) {
    return {
      ok: true,
      newSubtreeRoot: node,
      changeHappened: false,
      heightDelta: 0,
      oldValue: child.oldValue,
      needsDelete: child.needsDelete,  // Rust: to_delete propagated upward
    }
  }

  const childGrew = child.heightDelta === 1

  // Case 2: rotation needed (child grew AND we were already left-heavy).
  // Rust line 333: `if child_height_increased && r.balance < 0`.
  if (childGrew && node.balance < 0) {
    return rotateLeftDescent(node, child.newSubtreeRoot, child.oldValue)
  }

  // Case 3: no rotation. Update balance and possibly height.
  // Rust line 345: `my_height_increased = child_height_increased && r.balance == 0`.
  const myHeightIncreased: 0 | 1 = childGrew && node.balance === 0 ? 1 : 0
  // Rust line 346: `r_balance = if child_height_increased { r.balance - 1 } else { r.balance }`.
  const newBalance: Balance = childGrew
    ? ((node.balance - 1) as Balance) // -1 → -2 is impossible here (would have rotated)
    : node.balance

  // Rust line 347: new internal node with new left, same right, new balance.
  const newNode = newInternal(child.newSubtreeRoot, node.right, newBalance)
  return {
    ok: true,
    newSubtreeRoot: newNode,
    changeHappened: true,
    heightDelta: myHeightIncreased,
    oldValue: child.oldValue,
    needsDelete: false,  // changeHappened=true implies to_delete=false in Rust
  }
}

/**
 * Ports Rust modify_helper lines 336-342 — rotation when descending left.
 *
 * Selects single-right vs double-right rotation by the new left child's balance:
 *   - balance < 0  (left-heavy)  → single right rotation (Rust line 338-339).
 *   - balance >= 0 (right-heavy) → double right rotation (Rust line 341).
 *
 * Single right rotation construction (Rust lines 338-339):
 *   newR = (r_node, newLeftm.right, r.right, balance=0)
 *   root = (newLeftm.left, newR, balance=0)
 *
 * The promoted newLeftm becomes the sub-root; its old left stays as the
 * new sub-root's left; its old right joins r.right under a new internal
 * node (which becomes the sub-root's right).
 *
 * Per the Rust source comment at line 335: at this point we know newLeftm
 * is an InternalNode (not a LeafNode) — because the height increased,
 * which a leaf-replacement can never cause. If it's a LabelNode here, the
 * proof is malformed.
 *
 * Both rotation cases return heightDelta=0: the rotation absorbs the height growth.
 */
function rotateLeftDescent(
  node: InternalNode,
  newLeftm: AvlNode,
  oldValue: Uint8Array | null,
): ModifyResult {
  if (newLeftm.kind !== 'internal') {
    // Defensive: the Rust source asserts this implicitly via balance() returning
    // 0 for leaf/label. If we hit this in practice, the proof is malformed.
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust line 336: `if self.tree().balance(&new_leftm) < 0` — single right rotate.
  if (newLeftm.balance < 0) {
    // Rust line 338-339:
    //   new_r = InternalNode::update(r_node, new_leftm.right, r.right, 0)
    //   root  = InternalNode::update(new_leftm, new_leftm.left, new_r, 0)
    const newR = newInternal(newLeftm.right, node.right, 0)
    const newRoot = newInternal(newLeftm.left, newR, 0)
    return {
      ok: true,
      newSubtreeRoot: newRoot,
      changeHappened: true,
      heightDelta: 0, // rotation absorbs the height growth
      oldValue,
      needsDelete: false,
    }
  }

  // Rust line 341: `else { self.double_right_rotate(r_node, &new_leftm, &r.right) }`.
  // doubleRightRotate from rotation.ts takes (parent) and reads .left/.right
  // internally — so we synthesize a parent whose left = newLeftm, right = node.right.
  // The temporary parent's balance is irrelevant — doubleRightRotate ignores it.
  const tempParent = newInternal(newLeftm, node.right, 0)
  const rotated = doubleRightRotate(tempParent)
  return {
    ok: true,
    newSubtreeRoot: rotated,
    changeHappened: true,
    heightDelta: 0,
    oldValue,
    needsDelete: false,
  }
}

/**
 * Mirror of `rebalanceLeftDescent` for right descents.
 * Ports Rust modify_helper lines 358-378.
 *
 * Sign flips throughout:
 *   - Rust line 359: `if child_height_increased && r.balance > 0` (was < 0).
 *   - Rust line 362: `if self.tree().balance(&new_rightm) > 0` (was < 0).
 *   - Rust line 372: `r_balance = r.balance + 1` (was -1).
 */
function rebalanceRightDescent(node: InternalNode, child: ModifyOk): ModifyResult {
  // Case 1: no change. Rust line 377:
  //   `(r_node.clone(), false, false, to_delete, old_value)`
  // to_delete (needsDelete) propagates upward here too.
  if (!child.changeHappened) {
    return {
      ok: true,
      newSubtreeRoot: node,
      changeHappened: false,
      heightDelta: 0,
      oldValue: child.oldValue,
      needsDelete: child.needsDelete,  // Rust: to_delete propagated upward
    }
  }

  const childGrew = child.heightDelta === 1

  // Case 2: rotation needed (child grew AND we were already right-heavy).
  // Rust line 359.
  if (childGrew && node.balance > 0) {
    return rotateRightDescent(node, child.newSubtreeRoot, child.oldValue)
  }

  // Case 3: no rotation. Rust lines 371-373.
  const myHeightIncreased: 0 | 1 = childGrew && node.balance === 0 ? 1 : 0
  const newBalance: Balance = childGrew
    ? ((node.balance + 1) as Balance)
    : node.balance

  // Rust line 373.
  const newNode = newInternal(node.left, child.newSubtreeRoot, newBalance)
  return {
    ok: true,
    newSubtreeRoot: newNode,
    changeHappened: true,
    heightDelta: myHeightIncreased,
    oldValue: child.oldValue,
    needsDelete: false,  // changeHappened=true implies to_delete=false in Rust
  }
}

/**
 * Mirror of `rotateLeftDescent` for right descents.
 * Ports Rust modify_helper lines 362-368.
 *
 * Single left rotation construction (Rust lines 364-365):
 *   newR = (r_node, r.left, newRightm.left, balance=0)
 *   root = (newRightm, newR, newRightm.right, balance=0)
 *
 * Sub-case by new right child's balance:
 *   - balance > 0  (right-heavy) → single left rotation.
 *   - balance <= 0 (left-heavy or balanced) → double left rotation.
 */
function rotateRightDescent(
  node: InternalNode,
  newRightm: AvlNode,
  oldValue: Uint8Array | null,
): ModifyResult {
  if (newRightm.kind !== 'internal') {
    return { ok: false, reason: 'proof-malformed' }
  }

  // Rust line 362: `if self.tree().balance(&new_rightm) > 0` — single left rotate.
  if (newRightm.balance > 0) {
    // Rust lines 364-365:
    //   new_r = InternalNode::update(r_node, r.left, new_rightm.left, 0)
    //   root  = InternalNode::update(new_rightm, new_r, new_rightm.right, 0)
    const newR = newInternal(node.left, newRightm.left, 0)
    const newRoot = newInternal(newR, newRightm.right, 0)
    return {
      ok: true,
      newSubtreeRoot: newRoot,
      changeHappened: true,
      heightDelta: 0,
      oldValue,
      needsDelete: false,
    }
  }

  // Rust line 367: `else { self.double_left_rotate(r_node, &r.left, &new_rightm) }`.
  // doubleLeftRotate takes (parent) and reads .left/.right internally.
  // Synthesize a parent whose left = node.left, right = newRightm.
  const tempParent = newInternal(node.left, newRightm, 0)
  const rotated = doubleLeftRotate(tempParent)
  return {
    ok: true,
    newSubtreeRoot: rotated,
    changeHappened: true,
    heightDelta: 0,
    oldValue,
    needsDelete: false,
  }
}

