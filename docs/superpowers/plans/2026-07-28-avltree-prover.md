# AVL+ Batch Prover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `BatchAVLProver` + `PersistentBatchAVLProver` + `VersionedAVLStorage` from `ergo_avltree_rust` to `@ergots/avltree`, completing the package's coverage of the Rust reference.

**Architecture:** Extract the shared AVL+ tree mutation engine from `modify.ts`/`delete.ts` by replacing direct imports of verifier-specific `tree-traversal.ts` functions with an `AvlTreeOpsCallbacks` interface. `BatchAvlVerifier` and the new `BatchAVLProver` each implement the callbacks (verifier: consume from proof bytes; prover: record directions). The prover's `packTree` (post-order proof serialization) is new; the existing verifier's `parseProofPackedTree` is its inverse and stays unchanged.

**Tech Stack:** TypeScript ESM, `@noble/hashes` blake2b, no new dependencies.

## Global Constraints

- Browser-compat: no `Buffer`, no `node:*` imports, no WASM, ESM only
- Existing 156 verifier tests must stay green through the refactor (behavior-preserving)
- TDD: no production code without a failing test first
- Byte-equality with `~/projects/ergo_avltree_rust/` (our fork with unmerged fixes)
- `fixture-gen/` is frozen — prover fixtures generated manually against `ergo_avltree_rust`
- Source mapping comments required on new prover code (Rust file:line references)
- Per-task commits; commit message format: `feat(avltree): <description>`

---

### Task 1: Define callback interface

**Files:**
- Create: `packages/avltree/src/avl-tree-ops.ts`
- Modify: `packages/avltree/src/tree-traversal.ts` (export `KeyMatchesResult` from new location)

**Interfaces:**
- Produces: `AvlTreeOpsCallbacks` interface, `KeyMatchesResult` type (re-exported from avl-tree-ops.ts)

- [ ] **Step 1: Create `avl-tree-ops.ts` with the callback interface**

```ts
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
```

- [ ] **Step 2: Update `tree-traversal.ts` to re-export `KeyMatchesResult` from `avl-tree-ops.ts`**

The `KeyMatchesResult` type is currently defined in `tree-traversal.ts:97-99`. Import it from the new location instead, keeping the local definition for backward compatibility during the refactor.

```ts
// At the top of tree-traversal.ts, add:
import { type KeyMatchesResult } from './avl-tree-ops.js'
// Re-export so existing consumers don't break
export type { KeyMatchesResult }
```

Keep the existing local `KeyMatchesResult` definition in `tree-traversal.ts` until Task 4 (batch-verifier update) removes the need for it.

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `npx vitest run packages/avltree`
Expected: 156 passed (no behavior change yet)

- [ ] **Step 4: Commit**

```bash
git add packages/avltree/src/avl-tree-ops.ts packages/avltree/src/tree-traversal.ts
git commit -m "feat(avltree): add AvlTreeOpsCallbacks interface for shared engine"
```

---

### Task 2: Refactor modify.ts to accept callbacks

**Files:**
- Modify: `packages/avltree/src/modify.ts`

**Interfaces:**
- Consumes: `AvlTreeOpsCallbacks` from Task 1
- Produces: `modifyHelper(node: AvlNode, op: Operation, callbacks: AvlTreeOpsCallbacks): ModifyResult` (signature change — drops `proof`, `state`)

- [ ] **Step 1: Update imports in modify.ts**

Remove the imports from `tree-traversal.ts`:
```ts
// REMOVE:
import { keyMatchesLeaf, nextDirectionIsLeft, type TraversalState } from './tree-traversal.js'
// ADD:
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import { type KeyMatchesResult } from './avl-tree-ops.js'
```

- [ ] **Step 1.5: Make `InternalNode.key` carry the split key**

The prover needs to compare keys during traversal. Add an optional `key` field to `InternalNode` in `node.ts`:

```ts
export interface InternalNode {
  readonly kind: 'internal'
  /** Key stored at this internal node for prover traversal.
   *  The verifier reads keys from proof directions and ignores this field.
   *  Set by the shared engine (modify.ts/delete.ts) on every newInternal call;
   *  undefined only for proof-decode.ts reconstructed nodes (verifier-only). */
  readonly key?: Uint8Array
  left: AvlNode
  right: AvlNode
  balance: Balance
  labelCache: Uint8Array | null
}

export function newInternal(
  left: AvlNode,
  right: AvlNode,
  balance: Balance,
  key?: Uint8Array,
): InternalNode {
  return { kind: 'internal', key, left, right, balance, labelCache: null }
}
```

- [ ] **Step 2: Change `modifyHelper` signature**

```ts
// Before:
export function modifyHelper(
  node: AvlNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult

// After:
export function modifyHelper(
  node: AvlNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
): ModifyResult
```

And the body — replace the switch:
```ts
export function modifyHelper(
  node: AvlNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
): ModifyResult {
  switch (node.kind) {
    case 'leaf':
      return handleLeafNode(node, op, callbacks)
    case 'internal':
      return handleInternalNode(node, op, callbacks)
    case 'label':
      return { ok: false, reason: 'proof-malformed' }
  }
}
```

- [ ] **Step 3: Thread `callbacks` through `handleLeafNode`**

```ts
function handleLeafNode(leaf: LeafNode, op: Operation, callbacks: AvlTreeOpsCallbacks): ModifyResult {
  const m = callbacks.keyMatchesLeaf(op.key, leaf)
  if (!m.ok) {
    return { ok: false, reason: m.reason }
  }

  if (m.matches) {
    return handleLeafMatch(leaf, op, callbacks)
  }
  return handleLeafGap(leaf, op, callbacks)
}
```

- [ ] **Step 4: Thread `callbacks` through `handleLeafMatch`**

Add `callbacks` parameter. Add `onNodeVisit` call at the Rust-equivalent points (after determining the match, before returning):

```ts
function handleLeafMatch(leaf: LeafNode, op: Operation, callbacks: AvlTreeOpsCallbacks): ModifyResult {
  if (op.tag === 'Lookup' || op.tag === 'UnknownModification') {
    callbacks.onNodeVisit(leaf, op, false)
    return {
      ok: true,
      newSubtreeRoot: leaf,
      changeHappened: false,
      heightDelta: 0,
      oldValue: leaf.value,
      needsDelete: false,
    }
  }

  const u = updateFn(op, leaf.value)
  if (!u.ok) {
    return { ok: false, reason: 'operation-precondition-failed' }
  }

  if (u.newValue === null) {
    callbacks.onNodeVisit(leaf, op, false)
    return {
      ok: true,
      newSubtreeRoot: leaf,
      changeHappened: false,
      heightDelta: 0,
      oldValue: leaf.value,
      needsDelete: true,
    }
  }

  callbacks.onNodeVisit(leaf, op, false)
  const newLeafNode = newLeaf(leaf.key, u.newValue, leaf.nextLeafKey)
  return {
    ok: true,
    newSubtreeRoot: newLeafNode,
    changeHappened: true,
    heightDelta: 0,
    oldValue: leaf.value,
    needsDelete: false,
  }
}
```

- [ ] **Step 5: Thread `callbacks` through `handleLeafGap`**

Same pattern — add `callbacks` parameter, add `onNodeVisit` calls at return sites:

```ts
function handleLeafGap(leaf: LeafNode, op: Operation, callbacks: AvlTreeOpsCallbacks): ModifyResult {
  if (op.tag === 'Lookup' || op.tag === 'UnknownModification') {
    callbacks.onNodeVisit(leaf, op, false)
    return { ok: true, newSubtreeRoot: leaf, changeHappened: false, heightDelta: 0, oldValue: null, needsDelete: false }
  }
  const u = updateFn(op, null)
  if (!u.ok) {
    return { ok: false, reason: 'operation-precondition-failed' }
  }
  if (u.newValue === null) {
    callbacks.onNodeVisit(leaf, op, false)
    return { ok: true, newSubtreeRoot: leaf, changeHappened: false, heightDelta: 0, oldValue: null, needsDelete: false }
  }
  callbacks.onNodeVisit(leaf, op, false)
  return {
    ok: true,
    newSubtreeRoot: addNode(leaf, op.key, u.newValue),
    changeHappened: true,
    heightDelta: 1,
    oldValue: null,
    needsDelete: false,
  }
}
```

- [ ] **Step 5.5: Thread `key` through every `newInternal` call in modify.ts**

Every `newInternal(left, right, balance)` call must now pass the key as a 4th argument. The key for each call site:

| Call site | Key source |
|---|---|
| `addNode` | `newKey` (the key being inserted) |
| `rebalanceLeftDescent` (no rotation) | `node.key` (preserve existing) |
| `rebalanceRightDescent` (no rotation) | `node.key` |
| `rotateLeftDescent` single right rotate | `newLeftm.key` (the promoted child's key) |
| `rotateLeftDescent` double right rotate | `newLeftm.key` (temp parent uses child's key) |
| `rotateRightDescent` single left rotate | `newRightm.key` |
| `rotateRightDescent` double left rotate | `newRightm.key` |

Example — `addNode`:
```ts
function addNode(leaf: LeafNode, newKey: Uint8Array, newValue: Uint8Array): InternalNode {
  const modifiedOriginal = newLeaf(leaf.key, leaf.value, newKey)
  const newLeafNode = newLeaf(newKey, newValue, leaf.nextLeafKey)
  return newInternal(modifiedOriginal, newLeafNode, 0, newKey)
}
```

Example — `rebalanceLeftDescent` (no rotation):
```ts
const newNode = newInternal(child.newSubtreeRoot, node.right, newBalance, node.key)
```

- [ ] **Step 6: Thread `callbacks` through `handleInternalNode`**

Replace `nextDirectionIsLeft(proof, state)` + `state.failedReason` check:

```ts
function handleInternalNode(
  node: InternalNode,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
): ModifyResult {
  const goLeft = callbacks.nextDirectionIsLeft(op.key, node)
  const failedReason = callbacks.getFailedReason()
  if (failedReason !== null) {
    return { ok: false, reason: failedReason }
  }

  if (goLeft) {
    const childResult = modifyHelper(node.left, op, callbacks)
    if (!childResult.ok) return childResult
    callbacks.onNodeVisit(node, op, false)
    return rebalanceLeftDescent(node, childResult)
  }
  const childResult = modifyHelper(node.right, op, callbacks)
  if (!childResult.ok) return childResult
  callbacks.onNodeVisit(node, op, false)
  return rebalanceRightDescent(node, childResult)
}
```

- [ ] **Step 7: Run existing tests**

Run: `npx vitest run packages/avltree`
Expected: Should fail — `modifyHelper` signature changed and `batch-verifier.ts` still passes `(proof, state)`. This is expected RED. The test failure confirms the signature change propagated correctly.

- [ ] **Step 8: Commit**

```bash
git add packages/avltree/src/modify.ts
git commit -m "feat(avltree): refactor modifyHelper to accept AvlTreeOpsCallbacks"
```

---

### Task 3: Refactor delete.ts to accept callbacks

**Files:**
- Modify: `packages/avltree/src/delete.ts`

**Interfaces:**
- Consumes: `AvlTreeOpsCallbacks` from Task 1
- Produces: `deleteHelper(node: AvlNode, op: Operation, callbacks: AvlTreeOpsCallbacks): ModifyResult` (signature change — drops `proof`, `state`)

- [ ] **Step 1: Update imports in delete.ts**

Remove:
```ts
import { replayComparison, type TraversalState } from './tree-traversal.js'
```
Add:
```ts
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
```

- [ ] **Step 2: Change `deleteHelper` signature and body**

```ts
// Before:
export function deleteHelper(
  node: AvlNode,
  op: Operation,
  proof: Uint8Array,
  state: TraversalState,
): ModifyResult

// After:
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
```

- [ ] **Step 3: Change `deleteInner` signature**

```ts
function deleteInner(
  node: AvlNode,
  deleteMax: boolean,
  op: Operation,
  callbacks: AvlTreeOpsCallbacks,
  saved: SavedNodeRef,
): DeleteInner {
  const direction = deleteMax ? 1 : callbacks.replayComparison()
  if (!deleteMax) {
    const failedReason = callbacks.getFailedReason()
    if (failedReason !== null) {
      return { ok: false, reason: failedReason }
    }
  }
  // ... rest of the body unchanged except for threading callbacks instead of (proof, state)
```

- [ ] **Step 4: Thread `callbacks` through all delete helpers**

Every helper function that takes `(proof, state)` now takes `(callbacks)`:
- `tryEasyDeleteRightLeaf(node, rightLeaf, direction, deleteMax, op, callbacks, saved)`
- `tryEasyDeleteLeftLeaf(node, leftLeaf, op, callbacks)` — no proof/state previously
- `hardDeleteLeftDescent(node, direction, op, callbacks, saved)`
- `hardDeleteRightDescent(node, deleteMax, op, callbacks, saved)`
- `rebalanceShrinkLeft(newLeft, rootRight)` — no change (doesn't use directions)
- `rebalanceShrinkRight(node, newRight)` — no change

Also thread `key` through every `newInternal` call in delete.ts. The key for each call site is `node.key` (preserve existing) in most cases. The `rebalanceShrinkLeft` single-left-rotate case:
```ts
const tempParent = newInternal(newLeft, rootRight, 0, rootRight.key) // double rotate
// or
const newLeftChild = newInternal(newLeft, rootRight.left, newLeftChildBalance, rootRight.key)
const newR = newInternal(newLeftChild, rootRight.right, newRBalance, rootRight.key)
```
And `rebalanceShrinkRight` single-right-rotate case:
```ts
const tempParent = newInternal(rootLeft, newRight, 0, rootLeft.key)
// or
const newRightChild = newInternal(rootLeft.right, newRight, newRightChildBalance, rootLeft.key)
const newR = newInternal(rootLeft.left, newRightChild, newRBalance, rootLeft.key)
```

For `changeNextLeafKeyOfMaxNode` recursion and `changeKeyAndValueOfMinNode` recursion, preserve `node.key`:
```ts
return { ok: true, node: newInternal(node.left, recursed.node, node.balance, node.key) }
```

Add `callbacks.onNodeVisit(node, op, false)` at each entry point into `deleteInner` (Rust line 453: `self.on_node_visit(r_node, operation, false)`).

Add `callbacks.onNodeVisit(node, op, true)` at rotation entry points in `rebalanceShrinkLeft` (when about to call `doubleLeftRotate` — Rust line 551) and `rebalanceShrinkRight` (Rust line 600).

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run packages/avltree`
Expected: All 156 fail (batch-verifier.ts still passes old signature). RED confirms mechanical refactor is consistent.

- [ ] **Step 6: Commit**

```bash
git add packages/avltree/src/delete.ts
git commit -m "feat(avltree): refactor deleteHelper to accept AvlTreeOpsCallbacks"
```

---

### Task 4: Update batch-verifier.ts to build verifier callbacks

**Files:**
- Modify: `packages/avltree/src/batch-verifier.ts`

**Interfaces:**
- Consumes: `AvlTreeOpsCallbacks` from Task 1, refactored `modifyHelper`/`deleteHelper` from Tasks 2-3
- Produces: Behavior-preserving `BatchAvlVerifier` (existing public API unchanged)

- [ ] **Step 1: Update imports in batch-verifier.ts**

Add:
```ts
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import { nextDirectionIsLeft, keyMatchesLeaf, replayComparison, type TraversalState } from './tree-traversal.js'
```

- [ ] **Step 2: Add a private method that builds verifier callbacks**

In `BatchAvlVerifier`, add a method that creates callbacks closing over `this.proof` and `this.state`:

```ts
/**
 * Build verifier-specific callbacks that consume from the proof's
 * directions bit-string. Each callback closes over this.proof and
 * this.state for the current operation's traversal.
 */
private buildCallbacks(op: Operation): AvlTreeOpsCallbacks {
  const proof = this.proof
  const state = this.state
  return {
    nextDirectionIsLeft: (_key: Uint8Array, _r: InternalNode) => {
      return nextDirectionIsLeft(proof, state)
    },
    keyMatchesLeaf: (key: Uint8Array, leaf: LeafNode) => {
      return keyMatchesLeaf(key, leaf)
    },
    replayComparison: () => {
      return replayComparison(proof, state)
    },
    onNodeVisit: (_node: AvlNode, _operation: Operation, _isRotate: boolean) => {
      // Verifier: no-op — doesn't track modified nodes
    },
    getFailedReason: () => state.failedReason,
  }
}
```

Note: `nextDirectionIsLeft` in the callback interface takes `(key, r)` but the verifier implementation ignores them — the verifier reads direction from proof bytes, not by comparing keys. This is intentional; the prover's implementation WILL use `key` and `r`.

- [ ] **Step 3: Update `performOneOperation` to use callbacks**

Replace the `modifyHelper(this.root, op, this.proof, this.state)` call:
```ts
const callbacks = this.buildCallbacks(op)
const modifyResult = modifyHelper(this.root, op, callbacks)
```

Replace the `deleteHelper(modifyResult.newSubtreeRoot, op, this.proof, this.state)` call:
```ts
const deleteResult = deleteHelper(modifyResult.newSubtreeRoot, op, callbacks)
```

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run packages/avltree`
Expected: 156 passed (behavior-preserving refactor complete)

If any test fails, audit the callback wiring — the most likely failure mode is a stale `proof`/`state` reference in a helper that wasn't threaded through.

- [ ] **Step 5: Commit**

```bash
git add packages/avltree/src/batch-verifier.ts
git commit -m "feat(avltree): wire BatchAvlVerifier to use AvlTreeOpsCallbacks"
```

---

### Task 5: Implement BatchAVLProver class

**Files:**
- Create: `packages/avltree/src/batch-prover.ts`
- Create: `packages/avltree/test/prover.test.ts`

**Interfaces:**
- Consumes: `AvlTreeOpsCallbacks` from Task 1, `modifyHelper`/`deleteHelper` from Tasks 2-3
- Produces: `BatchAVLProver` class with `performOneOperation`, `generateProof`, `unauthenticatedLookup`, `digest`, `generateProofForOperations`

- [ ] **Step 1: Write failing test for prover construction + digest**

Create `packages/avltree/test/prover.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'

describe('BatchAVLProver', () => {
  it('constructs an empty tree and produces the expected empty digest', () => {
    const prover = new BatchAVLProver(32, null)
    const d = prover.digest()
    expect(d).not.toBeNull()
    expect(d!.length).toBe(33)
    // Height of an empty tree (with ±inf sentinel leaves only) is 0
    expect(d![32]).toBe(0)
    // The root label of an empty tree is deterministic
    // (blake2b of two sentinel leaves under a balance-0 internal node)
  })

  it('accepts an Insert and returns null old value', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32).fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(true)
    expect(result.value).toBeNull() // key was absent
  })

  it('rejects Insert on existing key', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32).fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(false)
  })
})
```

Run: `npx vitest run packages/avltree/test/prover.test.ts`
Expected: FAIL (BatchAVLProver not exported)

- [ ] **Step 2: Implement `BatchAVLProver` constructor and tree initialization**

Port `batch_avl_prover.rs:54-76`. Create `packages/avltree/src/batch-prover.ts`:

```ts
/**
 * BatchAVLProver — builds an in-memory AVL+ tree, applies authenticated
 * operations, and generates serialized AD proofs.
 *
 * Ports ergo_avltree_rust/src/batch_avl_prover.rs (506 lines).
 */
import { newLeaf, newInternal, label, type AvlNode, type InternalNode, type LeafNode } from './node.js'
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import { modifyHelper } from './modify.js'
import { deleteHelper } from './delete.js'
import { updateFn, type Operation } from './operation.js'
import type { AvlVerifyFailReason } from './errors.js'

// Token constants for packed proof format (batch_node.rs:14-16)
const LABEL_IN_PACKAGED_PROOF = 0x02
const LEAF_IN_PACKAGED_PROOF = 0x01
const END_OF_TREE_IN_PACKAGED_PROOF = 0x00
const DIGEST_LENGTH = 32

export type ProverOperationResult =
  | { success: true; value: Uint8Array | null }
  | { success: false }

export class BatchAVLProver {
  // Tree state
  root: AvlNode | null = null
  height = 0
  readonly keyLength: number
  readonly valueLengthOpt: number | null

  // Direction recording (batch_avl_prover.rs:27-28)
  private directions: number[] = []  // Uint8 bytes, grown dynamically
  private directionsBitLength = 0

  // Deletion replay (batch_avl_prover.rs:31-36)
  private replayIndex = 0
  private lastRightStep = 0

  // Operation state (batch_avl_prover.rs:40-43)
  private found = false
  private oldTopNode: AvlNode | null = null

  // Modified nodes for proof generation (Rust: modified_nodes)
  private modifiedNodes: AvlNode[] = []

  // Cycle reset flag (batch_avl_prover.rs:49-50)
  private needsCycleReset = false

  constructor(keyLength: number, valueLengthOpt: number | null) {
    this.keyLength = keyLength
    this.valueLengthOpt = valueLengthOpt

    // Rust lines 65-73: initialize empty tree with ±inf sentinel leaves
    const negInfKey = new Uint8Array(keyLength) // all zeroes
    const posInfKey = new Uint8Array(keyLength)
    posInfKey.fill(0xff)
    const dummyValue = new Uint8Array(valueLengthOpt ?? 0)

    const negInfLeaf = newLeaf(negInfKey, dummyValue, posInfKey)
    // positive-inf leaf: key=posInfKey, value=dummy, nextLeafKey=posInfKey (self-loop)
    const posInfLeaf = newLeaf(posInfKey, dummyValue, posInfKey)

    // Internal node with two sentinel leaves, balance 0
    this.root = newInternal(negInfLeaf, posInfLeaf, 0)
    this.height = 1
    this.oldTopNode = this.root
  }

  // ... (remaining methods in subsequent steps)
```

- [ ] **Step 3: Implement prover callbacks builder**

The `buildCallbacks` method creates callbacks that close over the prover's mutable state. The prover's `nextDirectionIsLeft` compares `key` against `r.key` (set by the shared engine's `addNode` and rebalance helpers — see Task 2 Step 5.5 and Task 3 Step 4).

Add a `compareBytes` helper (inline in batch-prover.ts since `tree-traversal.ts`'s version isn't exported):

```ts
  /** Build prover-specific callbacks. Ports the three AuthenticatedTreeOps
   *  method impls from batch_avl_prover.rs:409-484. */
  private buildCallbacks(op: Operation): AvlTreeOpsCallbacks {
    const self = this
    return {
      // Ports batch_avl_prover.rs:409-446 — next_direction_is_left
      nextDirectionIsLeft: (key: Uint8Array, r: InternalNode): boolean => {
        let ret: boolean
        if (self.found) {
          ret = true // after finding key, always go left to the leaf
        } else {
          const cmp = compareBytes(key, r.key) // TODO: InternalNode has no key field in TS — see Step 4
          if (cmp === 0) {
            self.found = true
            self.lastRightStep = self.directionsBitLength
            ret = false // go right, then left to the leaf
          } else {
            ret = cmp < 0 // go left if key < node key
          }
        }
        // Encode direction bit (Rust lines 434-444)
        if ((self.directionsBitLength & 7) === 0) {
          self.directions.push(ret ? 1 : 0)
        } else if (ret) {
          const i = self.directionsBitLength >> 3
          self.directions[i] |= 1 << (self.directionsBitLength & 7)
        }
        self.directionsBitLength++
        return ret
      },

      // Ports batch_avl_prover.rs:455-462 — key_matches_leaf
      keyMatchesLeaf: (_key: Uint8Array, _leaf: LeafNode) => {
        const matches = self.found
        self.found = false // reset for next operation
        return { ok: true, matches }
      },

      // Ports batch_avl_prover.rs:474-484 — replay_comparison
      replayComparison: (): -1 | 0 | 1 => {
        const i = self.replayIndex
        let ret: -1 | 0 | 1
        if (i === self.lastRightStep) {
          ret = 0
        } else if ((self.directions[i >> 3] & (1 << (i & 7))) === 0) {
          ret = 1
        } else {
          ret = -1
        }
        self.replayIndex++
        return ret
      },

      // Ports authenticated_tree_ops.rs:100-123 — on_node_visit
      onNodeVisit: (node: AvlNode, _operation: Operation, _isRotate: boolean) => {
        self.modifiedNodes.push(node)
      },

      getFailedReason: () => null, // prover never fails direction reads
    }
  }
```

- [ ] **Step 4: Implement `performOneOperation`**

Port `batch_avl_prover.rs:89-110`:

```ts
  performOneOperation(op: Operation): ProverOperationResult {
    // Precondition checks (Rust lines 226-229)
    const key = op.key
    const negInfKey = new Uint8Array(this.keyLength) // all zeroes
    const posInfKey = new Uint8Array(this.keyLength)
    posInfKey.fill(0xff)

    if (compareBytes(key, negInfKey) <= 0) {
      throw new Error('Key is less than or equal to negative infinity')
    }
    if (compareBytes(key, posInfKey) >= 0) {
      throw new Error('Key is greater than or equal to positive infinity')
    }
    if (key.length !== this.keyLength) {
      throw new Error('Key length does not match tree key length')
    }
    // Value length check
    if (this.valueLengthOpt !== null &&
        'value' in op && (op as { value: Uint8Array }).value.length !== this.valueLengthOpt) {
      throw new Error('Value length does not match fixed value length')
    }

    // Cycle reset (Rust line 90-93)
    if (this.needsCycleReset) {
      this.clearVisitedFlags(this.root)
      this.needsCycleReset = false
    }

    // Snapshot replay index (Rust line 94)
    this.replayIndex = this.directionsBitLength

    // Phase 1: modifyHelper (Rust lines 232-233)
    const callbacks = this.buildCallbacks(op)
    const modifyResult = modifyHelper(this.root!, op, callbacks)
    if (!modifyResult.ok) {
      // Rollback directions (Rust lines 96-108)
      const oldByteLength = (this.replayIndex + 7) >> 3
      this.directions.length = oldByteLength
      this.directionsBitLength = this.replayIndex
      if ((this.directionsBitLength & 7) > 0 && this.directions.length > 0) {
        const mask = (1 << (this.directionsBitLength & 7)) - 1
        this.directions[this.directions.length - 1] &= mask
      }
      return { success: false }
    }

    // Phase 2: delete if needed (Rust lines 234-246)
    if (modifyResult.needsDelete) {
      const deleteResult = deleteHelper(modifyResult.newSubtreeRoot, op, callbacks)
      if (!deleteResult.ok) {
        this.root = null
        this.height = 0
        return { success: false }
      }
      this.root = deleteResult.newSubtreeRoot
      this.height = Math.max(0, this.height + deleteResult.heightDelta)
      return { success: true, value: modifyResult.oldValue }
    }

    // No delete
    this.root = modifyResult.newSubtreeRoot
    this.height = Math.max(0, this.height + modifyResult.heightDelta)
    return { success: true, value: modifyResult.oldValue }
  }
```

Note about `clearVisitedFlags`: The Rust prover calls `tree.reset()` to clear `visited`/`is_new` flags. Our TS verifier doesn't use these flags (they're part of the `AVLTree` struct in Rust that we didn't port). For the TS prover, we need a minimal `clearVisitedFlags` that resets `labelCache` on all nodes to force re-labeling. This is needed for correct proof generation after a `generateProof()` cycle reset.

Add a helper:
```ts
  private clearVisitedFlags(node: AvlNode | null): void {
    if (node === null) return
    node.labelCache = null
    if (node.kind === 'internal') {
      this.clearVisitedFlags(node.left)
      this.clearVisitedFlags(node.right)
    }
  }
```

- [ ] **Step 5: Implement `digest`**

```ts
  /** Current 33-byte digest (root label || height). Null if tree poisoned. */
  digest(): Uint8Array | null {
    if (this.root === null) return null
    const rootLabel = label(this.root)
    const out = new Uint8Array(DIGEST_LENGTH + 1)
    out.set(rootLabel, 0)
    out[DIGEST_LENGTH] = this.height & 0xff
    return out
  }
```

- [ ] **Step 6: Implement `unauthenticatedLookup`**

Port `batch_avl_prover.rs:302-337`:

```ts
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null {
    if (this.root === null) return null
    return this.lookupWalk(this.root, key)
  }

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

  private lookupFoundWalk(node: AvlNode): Uint8Array | null {
    if (node.kind === 'leaf') {
      return node.value
    }
    if (node.kind === 'internal') {
      return this.lookupFoundWalk(node.left)
    }
    return null
  }
```

- [ ] **Step 7: Implement `generateProof` + `packTree`**

Port `batch_avl_prover.rs:155-227`:

```ts
  generateProof(): Uint8Array {
    this.modifiedNodes = []
    const parts: Uint8Array[] = []
    let previousLeafAvailable = false

    // Ports batch_avl_prover.rs:155-194 — pack_tree (post-order traversal)
    const packTree = (node: AvlNode): void => {
      if (!this.wasModified(node)) {
        // Unmodified node → emit label (Rust lines 165-169)
        parts.push(new Uint8Array([LABEL_IN_PACKAGED_PROOF]))
        parts.push(label(node))
        previousLeafAvailable = false
      } else if (node.kind === 'leaf') {
        // Modified leaf (Rust lines 172-183)
        parts.push(new Uint8Array([LEAF_IN_PACKAGED_PROOF]))
        if (!previousLeafAvailable) {
          parts.push(node.key)
        }
        parts.push(node.nextLeafKey)
        if (this.valueLengthOpt === null) {
          // Variable-length value: prefix with u32 length
          const lenBuf = new Uint8Array(4)
          new DataView(lenBuf.buffer).setUint32(0, node.value.length, false)
          parts.push(lenBuf)
        }
        parts.push(node.value)
        previousLeafAvailable = true
      } else if (node.kind === 'internal') {
        // Modified internal node: recurse (Rust lines 184-188)
        packTree(node.left)
        packTree(node.right)
        // Balance byte (Rust line 189)
        parts.push(new Uint8Array([node.balance & 0xff]))
      }
    }

    packTree(this.oldTopNode!)

    // End of tree marker (Rust line 212)
    parts.push(new Uint8Array([END_OF_TREE_IN_PACKAGED_PROOF]))

    // Directions bit-string (Rust line 213)
    parts.push(new Uint8Array(this.directions))

    // Cycle reset (Rust lines 220-224)
    this.modifiedNodes = []
    this.needsCycleReset = true
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

  /** Ports AuthenticatedTreeOpsBase::was_modified (authenticated_tree_ops.rs:39-44).
   *  Checks object reference identity — our nodes are plain objects, so === works. */
  private wasModified(node: AvlNode): boolean {
    return this.modifiedNodes.includes(node)
  }
```

- [ ] **Step 8: Implement `generateProofForOperations`**

Port `batch_avl_prover.rs:128-141`:

```ts
  generateProofForOperations(
    operations: Operation[],
  ): { proof: Uint8Array; digest: Uint8Array } | { success: false } {
    // Clone the tree (deep copy nodes)
    const cloneRoot = this.deepCloneNode(this.root!)
    const clonedProver = new BatchAVLProver(this.keyLength, this.valueLengthOpt)
    clonedProver.root = cloneRoot
    clonedProver.height = this.height
    clonedProver.oldTopNode = cloneRoot

    for (const op of operations) {
      const result = clonedProver.performOneOperation(op)
      if (!result.success) {
        return { success: false }
      }
    }

    const proof = clonedProver.generateProof()
    const digest = clonedProver.digest()!
    return { proof, digest }
  }

  /** Deep-clone a tree node and all its descendants. Preserves byte values. */
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
```

Note: The constructor creates a fresh ±inf tree and we replace `root`/`height`/`oldTopNode` immediately — this is slightly wasteful but clean. An alternative is a private constructor that skips sentinel initialization; implement that if the waste bothers the reviewer.

- [ ] **Step 10: Run prover tests**

Run: `npx vitest run packages/avltree/test/prover.test.ts`
Expected: 3/3 pass (construction + digest, Insert accept, Insert reject)

- [ ] **Step 11: Run full existing suite**

Run: `npx vitest run packages/avltree`
Expected: 156 + 3 = 159 passed

- [ ] **Step 12: Commit**

```bash
git add packages/avltree/src/batch-prover.ts packages/avltree/src/node.ts packages/avltree/test/prover.test.ts
git commit -m "feat(avltree): implement BatchAVLProver class"
```

---

### Task 6: Implement PersistentBatchAVLProver + VersionedAVLStorage

**Files:**
- Create: `packages/avltree/src/versioned-storage.ts`
- Create: `packages/avltree/src/persistent-prover.ts`

**Interfaces:**
- Consumes: `BatchAVLProver` from Task 5
- Produces: `VersionedAVLStorage` interface, `PersistentBatchAVLProver` class

- [ ] **Step 1: Create `VersionedAVLStorage` interface**

```ts
/**
 * VersionedAVLStorage — interface for persistent AVL+ tree storage.
 *
 * Ports ergo_avltree_rust/src/versioned_avl_storage.rs (69 lines).
 * No concrete implementation ships with the package; consumers provide
 * their own (in-memory for tests, redb/SQLite for production).
 */
import type { BatchAVLProver } from './batch-prover.js'

export interface VersionedAVLStorage {
  /**
   * Synchronize storage with the prover's state.
   * Called after operations are applied but before proof generation.
   */
  update(
    prover: BatchAVLProver,
    additionalData: [Uint8Array, Uint8Array][],
  ): void

  /**
   * Return the root node and tree height at the given version.
   * The return type is implementation-specific; PersistentBatchAVLProver
   * wires it to the prover's internal tree.
   */
  rollback(version: Uint8Array): [/* root */ unknown, /* height */ number]

  /** Current version digest, or null if storage is empty. */
  version(): Uint8Array | null

  /** Versions available for rollback. */
  rollbackVersions(): Uint8Array[]

  /** Force durable commit. No-op by default. */
  flush(): void
}
```

- [ ] **Step 2: Create `PersistentBatchAVLProver` class**

```ts
/**
 * PersistentBatchAVLProver — wraps a BatchAVLProver with versioned storage.
 *
 * Ports ergo_avltree_rust/src/persistent_batch_avl_prover.rs (68 lines).
 */
import { BatchAVLProver } from './batch-prover.js'
import type { VersionedAVLStorage } from './versioned-storage.js'
import type { Operation } from './operation.js'
import type { ProverOperationResult } from './batch-prover.js'

export class PersistentBatchAVLProver {
  readonly prover: BatchAVLProver
  readonly storage: VersionedAVLStorage

  constructor(
    prover: BatchAVLProver,
    storage: VersionedAVLStorage,
    additionalData: [Uint8Array, Uint8Array][],
  ) {
    this.prover = prover
    this.storage = storage

    // Rust lines 22-30
    const ver = storage.version()
    if (ver !== null) {
      this.rollback(ver)
    } else {
      this.generateProofAndUpdateStorage(additionalData)
    }
    // Rust line 31: ensure!(storage.version() == digest())
    const sv = storage.version()
    const d = this.digest()
    if (!sv || !d || compareBytes(sv, d) !== 0) {
      throw new Error('Storage version does not match prover digest')
    }
  }

  performOneOperation(operation: Operation): ProverOperationResult {
    return this.prover.performOneOperation(operation)
  }

  unauthenticatedLookup(key: Uint8Array): Uint8Array | null {
    return this.prover.unauthenticatedLookup(key)
  }

  digest(): Uint8Array | null {
    return this.prover.digest()
  }

  height(): number {
    return this.prover.height
  }

  generateProofAndUpdateStorage(
    additionalData: [Uint8Array, Uint8Array][],
  ): Uint8Array {
    this.storage.update(this.prover, additionalData)
    return this.prover.generateProof()
  }

  rollback(version: Uint8Array): void {
    const [root, height] = this.storage.rollback(version)
    this.prover.root = root as import('./node.js').AvlNode
    this.prover.height = height
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length)
  for (let i = 0; i < min; i++) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/avltree`
Expected: 159 passed (no test changes yet, but new files compile clean)

- [ ] **Step 4: Commit**

```bash
git add packages/avltree/src/versioned-storage.ts packages/avltree/src/persistent-prover.ts
git commit -m "feat(avltree): implement PersistentBatchAVLProver + VersionedAVLStorage"
```

---

### Task 7: Export new public surface

**Files:**
- Modify: `packages/avltree/src/index.ts`

- [ ] **Step 1: Add exports to index.ts**

```ts
// Add after existing exports:
export { BatchAVLProver, type ProverOperationResult } from './batch-prover.js'
export { PersistentBatchAVLProver } from './persistent-prover.js'
export type { VersionedAVLStorage } from './versioned-storage.js'
```

- [ ] **Step 2: Verify exports compile**

Run: `npx tsc --noEmit -p packages/avltree/tsconfig.json`
Expected: clean

- [ ] **Step 3: Run full suite**

Run: `npx vitest run packages/avltree`
Expected: 159 passed

- [ ] **Step 4: Commit**

```bash
git add packages/avltree/src/index.ts
git commit -m "feat(avltree): export BatchAVLProver, PersistentBatchAVLProver, VersionedAVLStorage"
```

---

### Task 8: Round-trip tests (prover → verifier)

**Files:**
- Create: `packages/avltree/test/prover-roundtrip.test.ts`

- [ ] **Step 1: Write round-trip test**

Key insight: the prover generates proofs; the existing verifier must accept them byte-identically. This is the primary correctness gate.

```ts
import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { verifyAvlBatch, verifyAvlLookup, type AvlTreeConfig } from '../src/index.js'

describe('Prover → Verifier round-trip', () => {
  const config: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }

  it('single Insert round-trips through verifier', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x42)
    const value = new Uint8Array([1, 2, 3, 4])

    const startDigest = prover.digest()!
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(true)

    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    // Verify the proof
    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Insert', key, value },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.results).toEqual([null]) // key was absent
    // Digests must match byte-for-byte
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('multi-op batch round-trips: Insert + Update + Lookup', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key1 = new Uint8Array(32).fill(0x01)
    const key2 = new Uint8Array(32).fill(0x02)
    const val1 = new Uint8Array([10, 20])
    const val1b = new Uint8Array([30, 40])
    const val2 = new Uint8Array([50, 60])

    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Insert', key: key1, value: val1 })
    prover.performOneOperation({ tag: 'Insert', key: key2, value: val2 })
    prover.performOneOperation({ tag: 'Update', key: key1, value: val1b })
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Insert', key: key1, value: val1 },
      { tag: 'Insert', key: key2, value: val2 },
      { tag: 'Update', key: key1, value: val1b },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.results).toEqual([null, null, val1]) // Insert x2 absent, Update returns old
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('Lookup round-trips', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x07)
    const value = new Uint8Array([9, 9])

    prover.performOneOperation({ tag: 'Insert', key, value })
    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Lookup', key })
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Lookup', key },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.results).toEqual([value])
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('Remove round-trips: key deleted, digest changes', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x11)
    const value = new Uint8Array([1])

    prover.performOneOperation({ tag: 'Insert', key, value })
    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Remove', key })
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, [
      { tag: 'Remove', key },
    ])
    expect(verified).not.toBeNull()
    expect(verified!.results).toEqual([value])
    expect(verified!.newDigest).toEqual(endDigest)
  })

  it('all 8 Operation variants round-trip', () => {
    // Insert, Update, InsertOrUpdate, Lookup, UnknownModification,
    // UpdateLongBy, Remove, RemoveIfExists — each applied in sequence,
    // proof verified, digests match.
    const prover = new BatchAVLProver(config.keyLength, null)
    const k1 = new Uint8Array(32).fill(0xa1)
    const k2 = new Uint8Array(32).fill(0xa2)
    const v1 = new Uint8Array([1])
    const v2 = new Uint8Array([2])

    const ops: Operation[] = [
      { tag: 'Insert', key: k1, value: v1 },
      { tag: 'InsertOrUpdate', key: k2, value: v2 },
      { tag: 'Lookup', key: k1 },
      { tag: 'Update', key: k2, value: new Uint8Array([3]) },
      { tag: 'UnknownModification', key: k2 },
      { tag: 'Remove', key: k1 },
      { tag: 'RemoveIfExists', key: k1 }, // already absent — no-op
      { tag: 'Insert', key: k1, value: new Uint8Array(8).fill(0) }, // 8-byte for UpdateLongBy
    ]

    const startDigest = prover.digest()!
    for (const op of ops) {
      const r = prover.performOneOperation(op as Operation)
      if (!r.success && op.tag !== 'Remove') throw new Error(`Op failed: ${op.tag}`)
    }
    const proof = prover.generateProof()
    const endDigest = prover.digest()!

    const verified = verifyAvlBatch(startDigest, proof, config, ops as Operation[])
    expect(verified).not.toBeNull()
    expect(verified!.newDigest).toEqual(endDigest)
  })
})
```

- [ ] **Step 2: Run round-trip tests**

Run: `npx vitest run packages/avltree/test/prover-roundtrip.test.ts`
Expected: 5 passed (or fix issues found by the round-trip)

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/test/prover-roundtrip.test.ts
git commit -m "test(avltree): prover→verifier round-trip tests"
```

---

### Task 9: Fixture-driven tests (prover proofs vs ergo_avltree_rust)

**Files:**
- Create: `packages/avltree/test/fixtures/prover/` directory
- Create: `packages/avltree/test/prover-fixtures.test.ts`

- [ ] **Step 1: Generate prover fixtures from Rust reference**

Create a Rust test in `~/projects/ergo_avltree_rust/` that exercises the prover:

```rust
// In ergo_avltree_rust/tests/prover_fixtures.rs or similar:
#[test]
fn generate_prover_fixtures() {
    let mut prover = BatchAVLProver::new(
        AVLTree::new(dummy_hash, 32, None),
        false,
    );
    // Insert key, generate proof, dump as hex
    let key1 = vec![0x42u8; 32];
    let val1 = vec![1, 2, 3, 4];
    prover.perform_one_operation(&Operation::Insert(KeyValue { key: key1.into(), value: val1.into() })).unwrap();
    let proof = prover.generate_proof();
    let digest = prover.digest().unwrap();
    println!("insert_single_proof: {}", hex::encode(&proof));
    println!("insert_single_digest: {}", hex::encode(&digest));
    // ... more cases
}
```

Run the test and capture output. Format as JSON fixtures:
```json
{
  "name": "insert_single",
  "keyLength": 32,
  "valueLengthOpt": null,
  "operations": [
    { "tag": "Insert", "key": "4242...4242", "value": "01020304" }
  ],
  "startingDigest": "...",
  "expectedProof": "...",
  "expectedDigest": "..."
}
```

Commit fixtures into `packages/avltree/test/fixtures/prover/`.

- [ ] **Step 2: Write fixture test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { BatchAVLProver } from '../src/batch-prover.js'
import { verifyAvlBatch } from '../src/index.js'

// Load fixture JSONs, decode hex, compare prover output byte-for-byte
describe('Prover fixtures vs ergo_avltree_rust', () => {
  const fixtures = ['insert_single', 'insert_multi', 'update', 'remove', 'all_eight_ops']
  for (const name of fixtures) {
    it(`matches Rust prover for ${name}`, () => {
      const fix = JSON.parse(readFileSync(`test/fixtures/prover/${name}.json`, 'utf-8'))
      const prover = new BatchAVLProver(fix.keyLength, fix.valueLengthOpt)
      const startDigest = hexToBytes(fix.startingDigest)

      // Apply ops and compare proof bytes
      for (const op of decodeOps(fix.operations)) {
        prover.performOneOperation(op)
      }
      const proof = prover.generateProof()
      expect(bytesToHex(proof)).toBe(fix.expectedProof)
      expect(bytesToHex(prover.digest()!)).toBe(fix.expectedDigest)

      // Cross-verify: prover proof must verify
      const verified = verifyAvlBatch(startDigest, proof, { keyLength: fix.keyLength, valueLengthOpt: fix.valueLengthOpt }, decodeOps(fix.operations))
      expect(verified).not.toBeNull()
    })
  }
})
```

- [ ] **Step 3: Run fixture tests**

Run: `npx vitest run packages/avltree/test/prover-fixtures.test.ts`
Expected: all fixture cases pass

- [ ] **Step 4: Commit**

```bash
git add packages/avltree/test/fixtures/prover/ packages/avltree/test/prover-fixtures.test.ts
git commit -m "test(avltree): prover fixtures vs ergo_avltree_rust"
```

---

### Task 10: Mutation tests (corrupt prover proof → verifier rejects)

**Files:**
- Create: `packages/avltree/test/prover-mutation.test.ts`

- [ ] **Step 1: Write mutation test**

```ts
describe('Prover proof mutation → verifier rejects', () => {
  it('single-byte flips in prover proof cause verification failure', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32).fill(0x55)
    const value = new Uint8Array([1, 2, 3, 4])

    const startDigest = prover.digest()!
    prover.performOneOperation({ tag: 'Insert', key, value })
    const proof = prover.generateProof()

    // Flip each byte; verify that verifier rejects at ≥90% kill rate
    let killed = 0
    const config = { keyLength: 32, valueLengthOpt: null }
    for (let i = 0; i < proof.length; i++) {
      const mutated = new Uint8Array(proof)
      mutated[i] ^= 0x01 // flip LSB
      const result = verifyAvlBatch(startDigest, mutated, config, [
        { tag: 'Insert', key, value },
      ])
      if (result === null) killed++
    }
    const killRate = killed / proof.length
    expect(killRate).toBeGreaterThanOrEqual(0.9)
  })
})
```

- [ ] **Step 2: Run mutation tests**

Run: `npx vitest run packages/avltree/test/prover-mutation.test.ts`
Expected: ≥90% kill rate

If kill rate is below 90%, enumerate tolerated positions (e.g., certain bytes in the proof may be "don't-care" for verification) and document them in a comment above the test.

- [ ] **Step 3: Commit**

```bash
git add packages/avltree/test/prover-mutation.test.ts
git commit -m "test(avltree): prover proof mutation → verifier rejection"
```

---

### Task 11: Facts + docs + close-out

**Files:**
- Modify: `facts/avltree.md`
- Modify: `packages/avltree/API.md`
- Modify: `packages/avltree/package.json`

- [ ] **Step 1: Update `facts/avltree.md`**

Add prover entries to the interface contract:
- Scope section: "Ships in this contract" now includes `BatchAVLProver`, `PersistentBatchAVLProver`, `VersionedAVLStorage`
- "Does NOT ship" entry updated: "BatchAVLProver (prover side)" moved to the shipped list
- Public surface section: add prover API documentation
- Source mapping table: add prover rows (from spec's source mapping table)

- [ ] **Step 2: Update `API.md`**

Add prover API documentation:
- `BatchAVLProver` constructor, methods, return types
- `PersistentBatchAVLProver` constructor, methods
- `VersionedAVLStorage` interface
- Usage example (insert → generate proof → verify)

- [ ] **Step 3: Update version**

In `packages/avltree/package.json`: `0.2.0` → `0.3.0`

- [ ] **Step 4: Run full monorepo gate**

```bash
npx tsc --noEmit              # clean across all packages
npm test                       # all packages green
```

Expected:
- scorex: 216
- avltree: 156 + new prover tests
- nipopow: 247
- ergoscript: 6479
- transaction: 64

- [ ] **Step 5: Rebuild dist**

```bash
npm run build  # rebuild all packages
```

- [ ] **Step 6: Verify ergoscript still works (it depends on avltree)**

Run: `npx vitest run packages/ergoscript`
Expected: 6479 passed

- [ ] **Step 7: Commit**

```bash
git add facts/avltree.md packages/avltree/API.md packages/avltree/package.json
git commit -m "docs(avltree): prover API docs + facts contract + v0.3.0 bump"
```
