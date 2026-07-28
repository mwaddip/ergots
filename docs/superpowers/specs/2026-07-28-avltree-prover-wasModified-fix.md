# `@ergots/avltree` — Fix `wasModified` object-identity bug in BatchAVLProver

**Status:** Draft
**Date:** 2026-07-28
**Package:** `@ergots/avltree` (bugfix; v0.3.0 local only)
**Reference:** `~/projects/ergo_avltree_rust/src/batch_avl_prover.rs`

## Problem

`BatchAVLProver.generateProof()` produces incorrect proofs when called between
operations (e.g. Insert → generateProof → Remove → generateProof). The
left-sibling leaf of a removed key is emitted as `LABEL_IN_PACKAGED_PROOF`
instead of `LEAF_IN_PACKAGED_PROOF`, causing verifier rejection.

### Root cause

Two interacting issues:

1. **`packTree` traverses a stale tree.** `generateProof()` sets `oldTopNode =
   this.root`, then traverses from `oldTopNode` during the next proof
   generation. In Rust, this works because the tree is mutated in-place
   (`Rc<RefCell<>>`) — `old_top_node` is a stable pointer whose contents
   reflect current state. In TS, nodes are immutable — after the next operation
   creates a fresh tree, `oldTopNode` points to the **old** object graph, not
   the current tree.

2. **`onNodeVisit` fires before node creation.** Several call sites visit the
   pre-mutation node, then create a replacement. The visited object is
   discarded; the replacement (which ends up in the tree) is never visited.
   `packTree` traverses the current tree, checks `modifiedNodes.includes(node)`
   — the current node was never pushed, so `wasModified` returns false → label.

The interaction: `oldTopNode` points to stale objects; `modifiedNodes` contains
a mix of stale objects (from pre-mutation visits) and current objects (from
sites that already visit post-creation). `wasModified` using `===` on these
mixed sets produces wrong answers. The bug is masked in single-batch tests
because `oldTopNode` is the constructor root which shares some objects with
the post-operation tree through unmodified subtrees.

## Design

Two mechanical rules fix both issues:

### Rule 1: `onNodeVisit` fires on the node that ends up in the final tree

Every call site that currently visits a node then creates a replacement is
reordered: create first, visit the replacement. Sites that return the node
unchanged (Lookup, no-op UpdateLongBy, needsDelete) are already correct.

### Rule 2: `packTree` traverses from `this.root` instead of `oldTopNode`

After the operation batch, `this.root` is the current tree. `packTree` walks
it bottom-up, expanding nodes in `modifiedNodes` and emitting labels for the
rest. This matches Rust's semantics — nodes not on the traversal path get
labels computed from their current state. Rust reaches current state through
in-place mutation; we reach it directly.

### Removals

- `oldTopNode` field — no longer needed
- `needsCycleReset` field — no flags to clear
- `clearVisitedFlags` method — no flags to clear
- The `needsCycleReset` block at the top of `performOneOperation`

## File changes

### `batch-prover.ts`

**Fields removed:**
- `oldTopNode: AvlNode | null` (line 92)
- `needsCycleReset: boolean` (line 98)

**Constructor:** Drop `this.oldTopNode = this.root` (line 121). Add
`this.oldTopNode = this.root` removal.

**`performOneOperation`:** Drop the cycle-reset block (lines 250-253):
```ts
if (this.needsCycleReset) {
  this.clearVisitedFlags(this.root)
  this.needsCycleReset = false
}
```

**`generateProof`:**
- Change `packTree(this.oldTopNode!)` → `packTree(this.root!)` (line 410)
- Drop `this.needsCycleReset = true` (line 421)
- Drop `this.oldTopNode = this.root` (line 424)

**`clearVisitedFlags`:** Remove the entire method (lines 518-527).

**`deepCloneNode`:** The `generateProofForOperations` method clones the tree
and creates a temporary prover. The clone prover's constructor no longer sets
`oldTopNode` (removed). The `generateProofForOperations` method no longer
reads `oldTopNode` (line 470: drop `clonedProver.oldTopNode = cloneRoot`).

### `modify.ts`

Four call sites, two changed:

**`handleLeafMatch` — value update (line 236):**
Move `onNodeVisit` from before `newLeaf(...)` to after:
```ts
// BEFORE:
callbacks.onNodeVisit(leaf, op, false)
const newLeafNode = newLeaf(leaf.key, u.newValue, leaf.nextLeafKey)
// AFTER:
const newLeafNode = newLeaf(leaf.key, u.newValue, leaf.nextLeafKey)
callbacks.onNodeVisit(newLeafNode, op, false)
```

**`handleLeafGap` — Insert/split (line 316):**
Remove the `onNodeVisit` call entirely. The `addNode` result is an indirect
creation (not on the traversal path). The parent `handleInternalNode` visits
the rebalanced wrapper that embeds it.

```ts
// BEFORE:
callbacks.onNodeVisit(leaf, op, false)
return { ...newSubtreeRoot: addNode(leaf, op.key, u.newValue)... }
// AFTER:
return { ...newSubtreeRoot: addNode(leaf, op.key, u.newValue)... }
```

**`handleInternalNode` — left descent (line 387):**
Move `onNodeVisit` from before `rebalanceLeftDescent` to after:
```ts
// BEFORE:
callbacks.onNodeVisit(node, op, false)
return rebalanceLeftDescent(node, childResult)
// AFTER:
const result = rebalanceLeftDescent(node, childResult)
callbacks.onNodeVisit(result.newSubtreeRoot, op, false)
return result
```

**`handleInternalNode` — right descent (line 392):**
Same transformation for `rebalanceRightDescent`.

### `delete.ts`

One structural change in `deleteInner` (line 176): move `onNodeVisit` from
the function entry to after the result is computed, visiting
`result.newSubtreeRoot`. Applied uniformly across all four exit paths by
restructuring the dispatch:

```ts
function deleteInner(...): DeleteInner {
  const direction = deleteMax ? 1 : callbacks.replayComparison()
  // ... validation ...

  let result: DeleteInner
  if (direction >= 0 && node.right.kind === 'leaf') {
    result = tryEasyDeleteRightLeaf(node, node.right, direction, deleteMax, op, saved)
  } else if (direction === 0 && node.left.kind === 'leaf') {
    result = tryEasyDeleteLeftLeaf(node, node.left, op)
  } else if (direction <= 0) {
    result = hardDeleteLeftDescent(node, direction, op, callbacks, saved)
  } else {
    result = hardDeleteRightDescent(node, deleteMax, op, callbacks, saved)
  }
  if (result.ok) {
    callbacks.onNodeVisit(result.newSubtreeRoot, op, false)
  }
  return result
}
```

The `onNodeVisit` at each recursion level visits the replacement node — the
node that will reside in the final tree. When a delete case promotes a sibling
(e.g. `tryEasyDeleteRightLeaf` returning `node.left`), that sibling is visited
because it now sits on the path in the final tree. This matches Rust's outcome
(the promoted node is part of the expanded proof) even though the mechanism
(visiting post-mutation vs pre-mutation) differs.

**Rotation helpers** — two additional sites in delete.ts, same pattern:

`rebalanceShrinkLeft` (line 445): move `onNodeVisit` from before
`doubleLeftRotate` to after, visiting the `rotated` result.

`rebalanceShrinkRight` (line 564): move `onNodeVisit` from before
`doubleRightRotate` to after, visiting the `rotated` result.

Both currently pass `isRotate: true`; that flag is preserved.

### `persistent-prover.ts`

No changes. `PersistentBatchAVLProver` delegates to `BatchAVLProver`'s public
API; the internal refactor is transparent to it.

## Testing

### New tests

1. **Round-trip: Insert → generateProof → Remove → generateProof**
   The exact scenario that triggers the bug. Create a prover, insert a key,
   call `generateProof()`, remove the key, call `generateProof()` again.
   Feed both proofs to `verifyAvlBatch`. Assert both verify and produce
   correct digests.

2. **Multi-batch round-trip: 3 batches across 3 generateProof calls**
   Insert key1 → generateProof → Insert key2 → generateProof → Update key1 →
   generateProof. Three proofs verified sequentially.

### Gate checks

- All 179 existing tests must stay green (156 verifier regression + 17 prover
  unit + 6 round-trip + 1 mutation)
- Mutation test must maintain ≥90% kill rate — if `packTree` traversal is
  wrong, proof structure changes and the kill rate drops
- `tsc --noEmit` clean
- Build clean

### No new fixtures

Fixture-gen is frozen. These are round-trip tests; no Rust-generated fixtures
needed.

## Risk assessment

- **Low risk.** The change is mechanical — reorder visit calls, change one
  traversal entry point, remove dead fields. No new logic.
- The existing test suite is the safety net: 179 tests covering the full
  verifier + prover surface.
- The mutation test specifically guards against proof-structure regressions.
- If a call site is missed, the new round-trip test (Insert → genProof →
  Remove → genProof) catches it — that scenario currently fails.

## Cross-references

- `facts/avltree.md` — interface contract (no changes needed; public API unchanged)
- `docs/superpowers/specs/2026-07-28-avltree-prover-design.md` — original prover design
- `SESSION_CONTEXT.md` — bug description and fix shapes
- `~/projects/ergo_avltree_rust/src/batch_avl_prover.rs` — Rust reference (prover)
- `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs` — Rust reference (shared engine, `was_modified`, `on_node_visit`)
