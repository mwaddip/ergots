/**
 * AVL+ tree node types, constructors, and blake2b-256 label computation.
 *
 * Ports batch_node.rs::Node (enum) + LeafNode / InternalNode / LabelOnly structs
 * (33-52 @568e7c3; constructors cited per-function below), Node::label()
 * (83-121 @568e7c3), Node::get_label() (79-81 @568e7c3, as `cachedLabel`),
 * and Node::label_subtree (130-157 @568e7c3, as `labelSubtree`) — the
 * iterative walk that keeps label()'s Internal arm off the native call
 * stack (deep-spine hardening; ports the reference's `b785d0d` fix).
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
 * Ports batch_node.rs::LeafNode (lines 41-45 @568e7c3).
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
 * Ports batch_node.rs::InternalNode (lines 33-38 @568e7c3).
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
 * Ports batch_node.rs::Node::LabelOnly(NodeHeader) (line 49 @568e7c3).
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
 * (batch_node.rs line 18 @568e7c3). TS narrows to the three valid values for type safety.
 */
export type Balance = -1 | 0 | 1

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Ports batch_node.rs::LeafNode::new (347-353 @568e7c3).
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
 * Ports batch_node.rs::InternalNode::new (277-284 @568e7c3).
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
 * Ports batch_node.rs::Node::new_label (211-216 @568e7c3).
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
 * Memoises the label of every node in the subtree rooted at `root` using an
 * explicit heap-allocated stack, so traversal cost is heap, not native call
 * stack.
 *
 * Ports batch_node.rs::Node::label_subtree (130-157 @568e7c3), called from
 * label()'s Internal arm — mirrors the reference's own call sites at
 * :108-109 @568e7c3. A verifier's tree comes from proof bytes, so before
 * this fix a crafted deep spine could exhaust the native stack computing
 * labels (an abort, not a catchable panic) before any operation ran; the
 * reference closed this in commit `b785d0d`, and this is that port.
 *
 * Nodes that already carry a label are skipped — the walk stops exactly at
 * the memo boundary the old recursive version stopped at. `label()` is only
 * ever called here on a node whose children are already labelled (an
 * internal node is re-pushed with `childrenDone = true` only after both
 * children have themselves been popped and processed by this same loop),
 * so every `label()` call this function makes computes without descending
 * further.
 */
function labelSubtree(root: AvlNode): void {
  // (node, childrenAlreadyProcessed) — mirrors the Rust `(NodeId, bool)` stack.
  const stack: Array<[AvlNode, boolean]> = [[root, false]]
  while (stack.length > 0) {
    const [node, childrenDone] = stack.pop()!

    // Memo boundary: a label-only stub carries its digest already; a
    // populated labelCache means an earlier iteration already labelled
    // this node. Two sequential checks (not a combined `||`) so the
    // discriminant narrowing each establishes survives into the code that
    // follows — see node.ts's own label() for the same pattern.
    if (node.kind === 'label') continue
    if (node.labelCache !== null) continue

    if (childrenDone) {
      // Both children were scheduled (and, by the memo-boundary checks
      // above, are now labelled) by the branch below on an earlier pop of
      // this same node — label() reads cache hits only from here.
      label(node)
      continue
    }
    if (node.kind === 'leaf') {
      // Self-contained — no children to schedule first.
      label(node)
      continue
    }
    // Internal, children not yet scheduled: push self (to revisit once
    // children are done), then right, then left. Pop order is therefore
    // left-first, matching the reference — cosmetic, since label()'s
    // Internal-arm hash input never depends on the ORDER children are
    // computed in, only their values (see label()'s JSDoc above).
    stack.push([node, true], [node.right, false], [node.left, false])
  }
}

/**
 * Returns a node's already-memoised label, throwing if it has none.
 *
 * Ports batch_node.rs::Node::get_label() (79-81 @568e7c3) —
 * `self.hdr().label.unwrap()`, a PANICKING read used only where the caller
 * has already guaranteed the node is labelled. label()'s Internal arm is
 * the sole caller here, always immediately after `labelSubtree(node.left)`
 * / `labelSubtree(node.right)` have returned — so under a correct
 * `labelSubtree` this never throws. A throw means `labelSubtree` left a
 * node unlabelled: an invariant violation inside this module, not a
 * caller-input problem, so it fails loudly here instead of silently
 * falling back into label()'s own (recursive) compute path one level down.
 *
 * Returns a defensively-sliced copy — same contract as `label()` itself.
 */
function cachedLabel(node: AvlNode): Uint8Array {
  if (node.kind === 'label') return node.label.slice()
  if (node.labelCache !== null) return node.labelCache.slice()
  throw new Error(
    'cachedLabel: node has no cached label — labelSubtree should have labelled it first',
  )
}

/**
 * Compute the 32-byte blake2b-256 label for a node.
 *
 * Ports batch_node.rs::Node::label() (lines 83-121 @568e7c3).
 *
 * CONSENSUS-CRITICAL — byte layout is load-bearing:
 *
 *   LabelNode:  return stored label directly (no re-hash)
 *   LeafNode:   blake2b256(0x00 || key || value || nextLeafKey)
 *                 — Rust: hasher.update([0u8]), key, value, next_node_key (lines 90-94 @568e7c3)
 *   Internal:   blake2b256(0x01 || balance || leftLabel || rightLabel)
 *                 — Rust: hasher.update([1u8]), [balance as u8], left/right get_label() — children pre-labelled iteratively by Node::label_subtree (:108-109 @568e7c3)
 *                 — NOTE: balance comes BEFORE the child labels, not after.
 *                   The PLAN.md spec had this wrong (said leftLabel || rightLabel || balance).
 *                   Source is authoritative.
 *
 * Balance encoding: i8 → u8 via `& 0xff` (-1 → 0xff, 0 → 0x00, 1 → 0x01).
 *
 * ITERATIVE SUBTREE LABELING (deep-spine hardening): the Internal arm does
 * not recurse into its children directly. It calls the module-private
 * `labelSubtree` helper on `node.left` and `node.right` first — an explicit
 * heap-allocated-stack walk, ports `Node::label_subtree` (130-157 @568e7c3),
 * called from the reference at :108-109 — then reads the now-memoised
 * labels back via `cachedLabel` (ports the panicking `Node::get_label()`,
 * 79-81 @568e7c3). A verifier's tree comes from proof bytes, so a crafted
 * deep spine used to be able to exhaust the native call stack computing
 * labels (an abort, not a catchable panic) before any operation ran; this
 * closes that exposure, matching the reference's own `b785d0d` fix.
 * Traversal cost is heap, not stack; call-stack depth stays bounded to a
 * small constant regardless of tree depth. See `label-deep-spine.test.ts`
 * and `docs/superpowers/specs/2026-08-04-avltree-label-iterative-design.md`.
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
    // Rust batch_node.rs lines 89-99 @568e7c3: Node::Leaf branch of Node::label()
    const input = concatBytes([
      new Uint8Array([0x00]),
      node.key,
      node.value,
      node.nextLeafKey,
    ])
    result = blake2b(input, { dkLen: 32 })
  } else {
    // Internal: 0x01 || balance || leftLabel || rightLabel
    // Rust batch_node.rs lines 100-119 @568e7c3: Node::Internal branch of Node::label()
    // IMPORTANT: balance precedes child labels (not follows — see JSDoc above).
    // Children are labelled iteratively (heap stack, not native recursion)
    // BEFORE reading them back — ports the Node::label_subtree calls at
    // :108-109 @568e7c3. cachedLabel (ports the panicking get_label(),
    // :79-81 @568e7c3) reads the now-populated cache; a labelSubtree bug
    // that left a child unlabelled fails loudly here instead of silently
    // falling back to recursion.
    labelSubtree(node.left)
    labelSubtree(node.right)
    const leftLbl = cachedLabel(node.left)
    const rightLbl = cachedLabel(node.right)
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
