/**
 * AVL+ double-rotation primitives.
 *
 * Ports authenticated_tree_ops.rs::AuthenticatedTreeOps::double_left_rotate
 * (lines 135-164) and double_right_rotate (lines 171-200).
 *
 * CONSENSUS-CRITICAL — the AVL+ balance invariant is preserved only if these
 * rotations are byte-faithful with the Rust reference implementation.
 *
 * Implementation note: the Rust port uses Rc<RefCell<Node>> for shared mutable
 * nodes and calls InternalNode::update (batch_node.rs lines 234-248) which
 * either mutates in place (for "is_new" nodes) or constructs a fresh node.
 * The TS port always constructs fresh nodes via `newInternal(...)` for two
 * reasons:
 *   1. The `labelCache` invariant requires that any mutation invalidate the
 *      cache on the mutated node AND all ancestors — fresh-allocation sidesteps
 *      this cache-invalidation rabbit hole.
 *   2. TS-idiomatic decomposition (per feedback-rust-port-style) is preferred
 *      over Rust-verbatim mutation patterns.
 *
 * @see ~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs
 */

import type { Balance, InternalNode } from './node.js'
import { newInternal } from './node.js'

/**
 * Rebalances a node whose right child has a left-leaning imbalance
 * (the right-left case in standard AVL terminology). Promotes
 * `node.right.left` as the new sub-root.
 *
 * Ports authenticated_tree_ops.rs::double_left_rotate (lines 135-164).
 *
 * Preconditions (per Rust source comment lines 130-134; callers ensure):
 *   - `node.right` is an InternalNode
 *   - `node.right.left` is an InternalNode (with valid Balance ∈ {-1, 0, +1})
 *
 * Balance reassignment (Rust lines 143-148, by `new_root.balance`):
 *   -  0 → (new_left=0, new_right=0)
 *   - -1 → (new_left=0, new_right=+1)
 *   - +1 → (new_left=-1, new_right=0)
 *   - new sub-root balance is always 0.
 *
 * Pointer reassignment (Rust lines 149-161):
 *   - new_left_child  = (node.left,        new_root.left,  new_left_balance)
 *   - new_right_child = (new_root.right,   r.right,         new_right_balance)
 *   - new sub-root    = (new_left_child,   new_right_child, 0)
 *
 * @throws TypeError if preconditions are violated (defensive — Rust would panic).
 */
export function doubleLeftRotate(node: InternalNode): InternalNode {
  const r = node.right
  if (r.kind !== 'internal') {
    throw new TypeError(
      `doubleLeftRotate precondition: node.right must be Internal, got ${r.kind}`,
    )
  }
  const newRoot = r.left
  if (newRoot.kind !== 'internal') {
    throw new TypeError(
      `doubleLeftRotate precondition: node.right.left must be Internal, got ${newRoot.kind}`,
    )
  }

  // Match Rust lines 143-148 — balance cases by new_root.balance.
  const balances = balanceReassign(newRoot.balance)
  const newLeftBalance = balances[0]
  const newRightBalance = balances[1]

  // Rust lines 149-154: new_left_child = update(current_root, left_child,
  //                       new_root.left, new_left_balance)
  // i.e. the new left child inherits the original node's left as its left,
  // and new_root.left as its right.
  // Rust update() preserves the key from the template node (r_node / left_child).
  const newLeftChild = newInternal(node.left, newRoot.left, newLeftBalance, node.key)

  // Rust lines 155-160: new_right_child = update(right_child, new_root.right,
  //                       right_child.right, new_right_balance)
  const newRightChild = newInternal(newRoot.right, r.right, newRightBalance, r.key)

  // Rust line 161: root = update(new_root, new_left_child, new_right_child, 0)
  return newInternal(newLeftChild, newRightChild, 0, newRoot.key)
}

/**
 * Mirror of {@link doubleLeftRotate} for the symmetric (left-right) case.
 * Rebalances a node whose left child has a right-leaning imbalance. Promotes
 * `node.left.right` as the new sub-root.
 *
 * Ports authenticated_tree_ops.rs::double_right_rotate (lines 171-200).
 *
 * Preconditions (per Rust source comment lines 166-169; callers ensure):
 *   - `node.left` is an InternalNode
 *   - `node.left.right` is an InternalNode
 *
 * Balance reassignment (Rust lines 179-184, by `new_root.balance` —
 * identical match table as double_left_rotate):
 *   -  0 → (new_left=0,  new_right=0)
 *   - -1 → (new_left=0,  new_right=+1)
 *   - +1 → (new_left=-1, new_right=0)
 *   - new sub-root balance is always 0.
 *
 * Pointer reassignment (Rust lines 185-197):
 *   - new_right_child = (new_root.right, node.right,    new_right_balance)
 *   - new_left_child  = (l.left,         new_root.left, new_left_balance)
 *   - new sub-root    = (new_left_child, new_right_child, 0)
 *
 * @throws TypeError if preconditions are violated.
 */
export function doubleRightRotate(node: InternalNode): InternalNode {
  const l = node.left
  if (l.kind !== 'internal') {
    throw new TypeError(
      `doubleRightRotate precondition: node.left must be Internal, got ${l.kind}`,
    )
  }
  const newRoot = l.right
  if (newRoot.kind !== 'internal') {
    throw new TypeError(
      `doubleRightRotate precondition: node.left.right must be Internal, got ${newRoot.kind}`,
    )
  }

  // Match Rust lines 179-184 — same balance match table as double_left.
  const balances = balanceReassign(newRoot.balance)
  const newLeftBalance = balances[0]
  const newRightBalance = balances[1]

  // Rust lines 185-190: new_right_child = update(current_root, new_root.right,
  //                       right_child, new_right_balance)
  // Rust update() preserves the key from the template node (r_node / left_child).
  const newRightChild = newInternal(newRoot.right, node.right, newRightBalance, node.key)

  // Rust lines 191-196: new_left_child = update(left_child, left_child.left,
  //                       new_root.left, new_left_balance)
  const newLeftChild = newInternal(l.left, newRoot.left, newLeftBalance, l.key)

  // Rust line 197: root = update(new_root, new_left_child, new_right_child, 0)
  return newInternal(newLeftChild, newRightChild, 0, newRoot.key)
}

/**
 * Shared balance reassignment helper.
 * Returns [newLeftBalance, newRightBalance] given the promoted sub-root's
 * original balance. Identical match table is used by both rotation directions.
 *
 * Ports the inline `match` blocks at authenticated_tree_ops.rs lines 143-148
 * (double_left) and 179-184 (double_right) — they are textually identical.
 */
function balanceReassign(rootBalance: Balance): [Balance, Balance] {
  if (rootBalance === 0) return [0, 0]
  if (rootBalance === -1) return [0, 1]
  // rootBalance === 1
  return [-1, 0]
}
