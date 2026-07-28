/**
 * AVL+ tree operations callback interface.
 *
 * The shared mutation engine (modifyHelper, deleteHelper) calls these
 * at direction/replay/visit points. The verifier and prover implement
 * them differently — the verifier consumes proof bytes, the prover records
 * directions for proof generation.
 *
 * Ports the three trait methods from ergo_avltree_rust's AuthenticatedTreeOps:
 *   - next_direction_is_left (prover: batch_avl_prover.rs:409-446;
 *                            verifier: batch_avl_verifier.rs:192-203)
 *   - key_matches_leaf       (prover: batch_avl_prover.rs:455-462;
 *                            verifier: batch_avl_verifier.rs:213-227)
 *   - replay_comparison      (prover: batch_avl_prover.rs:474-484;
 *                            verifier: batch_avl_verifier.rs:239-251)
 * Plus on_node_visit (authenticated_tree_ops.rs:100-123) for proof-generation
 * tracking — no-op on the verifier, records modified nodes on the prover.
 */

import type { InternalNode } from './node.js'
import type { LeafNode } from './node.js'
import type { AvlNode } from './node.js'
import type { Operation } from './operation.js'
import type { AvlVerifyFailReason } from './errors.js'

/** Result type for keyMatchesLeaf. */
export type KeyMatchesResult =
  | { ok: true; matches: boolean }
  | { ok: false; reason: AvlVerifyFailReason }

export interface AvlTreeOpsCallbacks {
  /** Return true to go left, false to go right. */
  nextDirectionIsLeft(key: Uint8Array, r: InternalNode): boolean

  /** Check if key matches the leaf. */
  keyMatchesLeaf(key: Uint8Array, leaf: LeafNode): KeyMatchesResult

  /** Replay the next comparison: -1 (left), 0 (equal), 1 (right). */
  replayComparison(): -1 | 0 | 1

  /**
   * Called when a node is visited during tree traversal.
   * Verifier: no-op. Prover: records the node for proof generation.
   *
   * @param node     The visited node
   * @param operation The current operation
   * @param isRotate  True if this visit is during a rotation (affects
   *                  changed-nodes tracking per Rust lines 104-121)
   */
  onNodeVisit(node: AvlNode, operation: Operation, isRotate: boolean): void

  /** Returns the failure reason if a direction/replay read went out of bounds.
   *  Must return null when the tree is healthy. */
  getFailedReason(): AvlVerifyFailReason | null
}
