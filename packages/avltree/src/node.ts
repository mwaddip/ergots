/**
 * AVL+ tree node types, constructors, and blake2b-256 label computation.
 *
 * Ports batch_node.rs::Node (enum) + LeafNode / InternalNode / LabelOnly structs
 * (lines ~33-52, ~200-275) and Node::label() (lines ~83-112).
 *
 * @see ~/projects/ergo_avltree_rust/src/batch_node.rs
 */

import { blake2b } from '@noble/hashes/blake2.js'
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
 * `labelCache` is mutable because it is populated lazily by the `label()` helper.
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
 * All data fields are readonly — the engine builds fresh nodes rather than
 * mutating (independently verified: the only field write in src/ is the
 * labelCache memo in label()). readonly stops reassignment, not buffer
 * mutation; the public-boundary defensive copies close the aliasing side.
 * A fresh node starts with `labelCache: null` and is populated on the first
 * call to `label()`; because nodes are immutable, a populated cache stays
 * valid for the node's lifetime.
 */
export interface InternalNode {
  readonly kind: 'internal'
  /**
   * Key stored at this internal node for prover traversal.
   * The verifier reads keys from proof directions and ignores this field.
   * Set by the shared engine (modify.ts/delete.ts) on every newInternal call;
   * undefined only for proof-decode.ts reconstructed nodes (verifier-only).
   */
  readonly key?: Uint8Array
  readonly left: AvlNode
  readonly right: AvlNode
  readonly balance: Balance
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
 * Ports batch_node.rs::LeafNode::new (~lines 240-260).
 * Defensively copies key, value, and nextLeafKey to prevent caller-side
 * mutations from corrupting the node (or invalidating its cached label later).
 */
export function newLeaf(key: ADKey, value: ADValue, nextLeafKey: ADKey): LeafNode {
  return {
    kind: 'leaf',
    key: new Uint8Array(key),
    value: new Uint8Array(value),
    nextLeafKey: new Uint8Array(nextLeafKey),
    labelCache: null,
  }
}

/**
 * Ports batch_node.rs::InternalNode::new (~lines 212-219).
 * Note: the Rust constructor returns a NodeId = Rc<RefCell<Node>> (smart-
 * pointer wrapper). TS returns the plain InternalNode value — no ref-
 * counting needed; the GC handles reference lifecycle.
 *
 * left and right are AvlNode references (object references; no defensive
 * copy needed). balance is a primitive (Balance = -1 | 0 | 1).
 */
export function newInternal(
  left: AvlNode,
  right: AvlNode,
  balance: Balance,
  key?: Uint8Array,
): InternalNode {
  return { kind: 'internal', key, left, right, balance, labelCache: null }
}

/**
 * Ports batch_node.rs::Node::new_label (~lines 264-275).
 * Defensively copies the label bytes so caller-side mutations don't corrupt
 * the node. The label is the blake2b-256 digest of a sub-tree the verifier
 * doesn't have full data for; it MUST be exactly 32 bytes.
 * @throws RangeError if label.length !== 32 — this represents a bug in
 *   the caller (proof-decode.ts should always pass 32-byte digests).
 */
export function newLabel(label: Uint8Array): LabelNode {
  if (label.length !== 32) {
    throw new RangeError(
      `LabelNode.label must be exactly 32 bytes; got ${label.length}`,
    )
  }
  return { kind: 'label', label: new Uint8Array(label) }
}

// ---------------------------------------------------------------------------
// Label computation
// ---------------------------------------------------------------------------

/**
 * Compute the 32-byte blake2b-256 label for a node.
 *
 * Ports batch_node.rs::Node::label() (lines ~83-112).
 *
 * CONSENSUS-CRITICAL — byte layout is load-bearing:
 *
 *   LabelNode:  return stored label directly (no re-hash)
 *   LeafNode:   blake2b256(0x00 || key || value || nextLeafKey)
 *                 — Rust: hasher.update([0u8]), key, value, next_node_key (lines ~90-94)
 *   Internal:   blake2b256(0x01 || balance || leftLabel || rightLabel)
 *                 — Rust: hasher.update([1u8]), [balance as u8], left.label(), right.label() (lines ~101-105)
 *                 — NOTE: balance comes BEFORE the child labels, not after.
 *                   The PLAN.md spec had this wrong (said leftLabel || rightLabel || balance).
 *                   Source is authoritative.
 *
 * Balance encoding: i8 → u8 via `& 0xff` (-1 → 0xff, 0 → 0x00, 1 → 0x01).
 *
 * Result is memoised in `node.labelCache` (null on a freshly constructed node).
 * Nodes must not be mutated — operations build new nodes instead of editing
 * existing ones, so a populated cache never needs to be invalidated.
 *
 * Returns a defensively-sliced copy of the label so callers cannot mutate
 * the internal cache (or the LabelNode's stored digest). The cache itself
 * is preserved across calls; only the return value is fresh.
 */
export function label(node: AvlNode): Uint8Array {
  // LabelOnly: stored label IS the label; return a slice so the caller
  // cannot mutate the stored digest.
  if (node.kind === 'label') return node.label.slice()
  // Cache hit: return a fresh slice so the caller cannot corrupt the cache.
  if (node.labelCache !== null) return node.labelCache.slice()

  let result: Uint8Array
  if (node.kind === 'leaf') {
    // Leaf: 0x00 || key || value || nextLeafKey
    // Rust batch_node.rs lines ~89-98: Node::Leaf branch of Node::label()
    const input = concatBytes([
      new Uint8Array([0x00]),
      node.key,
      node.value,
      node.nextLeafKey,
    ])
    result = blake2b(input, { dkLen: 32 })
  } else {
    // Internal: 0x01 || balance || leftLabel || rightLabel
    // Rust batch_node.rs lines ~100-109: Node::Internal branch of Node::label()
    // IMPORTANT: balance precedes child labels (not follows — see JSDoc above).
    const leftLbl = label(node.left)
    const rightLbl = label(node.right)
    // Signed i8 → unsigned 8-bit byte: -1 → 0xff, 0 → 0x00, 1 → 0x01
    const balanceByte = new Uint8Array([node.balance & 0xff])
    const input = concatBytes([
      new Uint8Array([0x01]),
      balanceByte,
      leftLbl,
      rightLbl,
    ])
    result = blake2b(input, { dkLen: 32 })
  }
  node.labelCache = result
  // Return a fresh slice — the cache holds `result`; the caller gets a copy.
  return result.slice()
}

/**
 * Concatenate multiple Uint8Array parts into a single contiguous buffer.
 * Allocates exactly one output array (total length = sum of part lengths).
 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
