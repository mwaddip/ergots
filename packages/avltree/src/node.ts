/**
 * AVL+ tree node types and constructors.
 *
 * Ports batch_node.rs::Node (enum) + LeafNode / InternalNode / LabelOnly structs
 * (lines ~33-52, ~200-275). Labeling logic (blake2b-256 hashing) lives in Task 7.
 *
 * @see ~/projects/ergo_avltree_rust/src/batch_node.rs
 */

import type { ADKey, ADValue } from './types.js'

// ---------------------------------------------------------------------------
// Node union
// ---------------------------------------------------------------------------

/** Tree node — discriminated union over Leaf, Internal, Label. Ports batch_node.rs::Node. */
export type AvlNode = LeafNode | InternalNode | LabelNode

// ---------------------------------------------------------------------------
// Variant interfaces
// ---------------------------------------------------------------------------

/**
 * A real leaf with key, value, and pointer-to-next-leaf-key.
 *
 * Ports batch_node.rs::LeafNode (lines ~41-45).
 * `labelCache` is mutable because it is populated lazily by the `label()` helper in Task 7.
 */
export interface LeafNode {
  readonly kind: 'leaf'
  readonly key: ADKey
  readonly value: ADValue
  readonly nextLeafKey: ADKey
  /** Cached blake2b-256 label; null until first call to `label()`. */
  labelCache: Uint8Array | null
}

/**
 * Internal node with left/right subtrees and AVL balance ∈ {-1, 0, 1}.
 *
 * Ports batch_node.rs::InternalNode (lines ~33-38).
 * Children and balance are mutable to support in-place rebalancing.
 * `labelCache` is invalidated (set to null) whenever the subtree is mutated.
 */
export interface InternalNode {
  readonly kind: 'internal'
  left: AvlNode
  right: AvlNode
  balance: Balance
  /** Cached blake2b-256 label; null until first call to `label()`. */
  labelCache: Uint8Array | null
}

/**
 * Label-only node — a stub that exists only as a hash reference
 * (from a `LABEL_IN_PACKAGED_PROOF` token in the serialized proof stream).
 *
 * Ports batch_node.rs::Node::LabelOnly(NodeHeader) (line ~49).
 * The label IS the data; no separate cache needed.
 */
export interface LabelNode {
  readonly kind: 'label'
  /** 32-byte blake2b-256 digest of the sub-tree this stub replaces. */
  readonly label: Uint8Array
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/**
 * AVL balance bit.
 *
 * Rust uses `pub type Balance = i8` with valid values -1, 0, 1
 * (batch_node.rs line ~18). TS narrows to the three valid values for type safety.
 */
export type Balance = -1 | 0 | 1

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Construct a new leaf node with an empty label cache.
 *
 * Ports LeafNode::new (batch_node.rs lines ~268-274).
 */
export function newLeaf(key: ADKey, value: ADValue, nextLeafKey: ADKey): LeafNode {
  return { kind: 'leaf', key, value, nextLeafKey, labelCache: null }
}

/**
 * Construct a new internal node with an empty label cache.
 *
 * Ports InternalNode::new (batch_node.rs lines ~212-219).
 */
export function newInternal(
  left: AvlNode,
  right: AvlNode,
  balance: Balance,
): InternalNode {
  return { kind: 'internal', left, right, balance, labelCache: null }
}

/**
 * Construct a label-only stub node.
 * Performs a defensive copy so the caller's buffer cannot alias the stored label.
 *
 * Ports Node::new_label (batch_node.rs lines ~166-171).
 */
export function newLabel(label: Uint8Array): LabelNode {
  return { kind: 'label', label: new Uint8Array(label) }
}
