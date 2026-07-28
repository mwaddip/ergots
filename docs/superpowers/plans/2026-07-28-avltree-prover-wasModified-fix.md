# Fix `wasModified` Object-Identity Bug in BatchAVLProver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `generateProof()` producing incorrect proofs when called between operations (Insert → generateProof → Remove → generateProof) by moving `onNodeVisit` calls after node creation and switching `packTree` to traverse from `this.root`.

**Architecture:** Two mechanical rules applied across three files. Rule 1: `onNodeVisit` fires on the replacement node (the one in the final tree), not the pre-mutation node. Rule 2: `packTree` traverses from `this.root` (current tree) instead of the stale `oldTopNode`. Remove `oldTopNode`, `needsCycleReset`, and `clearVisitedFlags` — dead after the switch.

**Tech Stack:** TypeScript, vitest, `@ergots/avltree` (local v0.3.0)

## Global Constraints

- TDD discipline: no production code without a failing test first (CLAUDE.md Iron Law)
- Browser-compat: no `Buffer`, no `node:*` imports, no WASM, ESM only
- All 179 existing tests must stay green
- `tsc --noEmit` clean across all packages
- `npm test` passes across all packages

---

### Task 1: Write the failing test — Insert → generateProof → Remove → generateProof

**Files:**
- Create: `packages/avltree/test/prover-wasModified-fix.test.ts`

**Interfaces:**
- Consumes: `BatchAVLProver` (from `../src/batch-prover.js`), `verifyAvlBatch`, `AvlTreeConfig`, `Operation` (from `../src/index.js`)
- Produces: Two test cases that exercise the bug scenario and the multi-batch scenario

- [ ] **Step 1: Write the failing test file**

```ts
import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { verifyAvlBatch, type AvlTreeConfig, type Operation } from '../src/index.js'

describe('BatchAVLProver wasModified fix', () => {
  const config: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }

  it('Insert → generateProof → Remove → generateProof round-trips', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key = new Uint8Array(32).fill(0x42)
    const value = new Uint8Array([1, 2, 3, 4])

    // Batch 1: Insert
    const startDigest1 = prover.digest()!
    const r1 = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(r1.success).toBe(true)

    const proof1 = prover.generateProof()
    const endDigest1 = prover.digest()!

    // Verify first proof
    const verified1 = verifyAvlBatch(startDigest1, proof1, config, [
      { tag: 'Insert', key, value },
    ])
    expect(verified1).not.toBeNull()
    expect(verified1!.results).toEqual([null]) // key was absent
    expect(verified1!.newDigest).toEqual(endDigest1)

    // Batch 2: Remove — uses endDigest1 as starting digest
    const r2 = prover.performOneOperation({ tag: 'Remove', key })
    expect(r2.success).toBe(true)

    const proof2 = prover.generateProof()
    const endDigest2 = prover.digest()!

    // Verify second proof — THIS IS THE BUG: currently fails because
    // the left-sibling leaf is emitted as LABEL instead of LEAF
    const verified2 = verifyAvlBatch(endDigest1, proof2, config, [
      { tag: 'Remove', key },
    ])
    expect(verified2).not.toBeNull()
    expect(verified2!.results).toEqual([value]) // Remove returns old value
    expect(verified2!.newDigest).toEqual(endDigest2)
  })
})
```

- [ ] **Step 2: Run test to confirm it fails (RED)**

```bash
cd packages/avltree && npx vitest run test/prover-wasModified-fix.test.ts
```

Expected: FAIL. The second `verifyAvlBatch` returns `null` (verification failure). The error from `lastFailReason()` should indicate the proof is malformed (a LABEL token where LEAF data was expected).

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/avltree/test/prover-wasModified-fix.test.ts
git commit -m "test(avltree): add failing wasModified multi-generateProof round-trip

RED — Insert → generateProof → Remove → generateProof fails verification.
The left-sibling leaf of the removed key is emitted as LABEL_IN_PACKAGED_PROOF
instead of LEAF_IN_PACKAGED_PROOF.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Fix `modify.ts` — move `onNodeVisit` calls after node creation

**Files:**
- Modify: `packages/avltree/src/modify.ts:236,316,387,392`

**Interfaces:**
- Consumes: `AvlTreeOpsCallbacks.onNodeVisit` (existing interface, unchanged)
- Produces: `onNodeVisit` now called on replacement nodes that reside in the final tree

- [ ] **Step 1: Fix `handleLeafMatch` value update (line 236)**

Change from visiting the old leaf to visiting the new leaf:

```ts
// BEFORE (lines 236-245):
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

// AFTER:
      const newLeafNode = newLeaf(leaf.key, u.newValue, leaf.nextLeafKey)
      callbacks.onNodeVisit(newLeafNode, op, false)
      return {
        ok: true,
        newSubtreeRoot: newLeafNode,
        changeHappened: true,
        heightDelta: 0,
        oldValue: leaf.value,
        needsDelete: false,
      }
```

- [ ] **Step 2: Fix `handleLeafGap` Insert/split (line 316)**

Remove the `onNodeVisit` call entirely. The `addNode` result is an indirect creation — not on the traversal path. The parent `handleInternalNode` visits the rebalanced wrapper that embeds it.

```ts
// BEFORE (lines 316-324):
      callbacks.onNodeVisit(leaf, op, false)
      return {
        ok: true,
        newSubtreeRoot: addNode(leaf, op.key, u.newValue),
        changeHappened: true,
        heightDelta: 1,
        oldValue: null,
        needsDelete: false,
      }

// AFTER:
      return {
        ok: true,
        newSubtreeRoot: addNode(leaf, op.key, u.newValue),
        changeHappened: true,
        heightDelta: 1,
        oldValue: null,
        needsDelete: false,
      }
```

- [ ] **Step 3: Fix `handleInternalNode` left descent (line 387)**

Move `onNodeVisit` from before `rebalanceLeftDescent` to after, visiting the result:

```ts
// BEFORE (lines 384-388):
      if (goLeft) {
        const childResult = modifyHelper(node.left, op, callbacks)
        if (!childResult.ok) return childResult
        callbacks.onNodeVisit(node, op, false)
        return rebalanceLeftDescent(node, childResult)
      }

// AFTER:
      if (goLeft) {
        const childResult = modifyHelper(node.left, op, callbacks)
        if (!childResult.ok) return childResult
        const result = rebalanceLeftDescent(node, childResult)
        callbacks.onNodeVisit(result.newSubtreeRoot, op, false)
        return result
      }
```

- [ ] **Step 4: Fix `handleInternalNode` right descent (line 392)**

Same transformation:

```ts
// BEFORE (lines 390-393):
      const childResult = modifyHelper(node.right, op, callbacks)
      if (!childResult.ok) return childResult
      callbacks.onNodeVisit(node, op, false)
      return rebalanceRightDescent(node, childResult)

// AFTER:
      const childResult = modifyHelper(node.right, op, callbacks)
      if (!childResult.ok) return childResult
      const result = rebalanceRightDescent(node, childResult)
      callbacks.onNodeVisit(result.newSubtreeRoot, op, false)
      return result
```

- [ ] **Step 5: Commit**

```bash
git add packages/avltree/src/modify.ts
git commit -m "fix(avltree): move onNodeVisit calls after node creation in modify.ts

Rule 1: onNodeVisit fires on the replacement node that ends up in the tree,
not the pre-mutation node that is discarded.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Fix `delete.ts` — restructure `deleteInner` dispatch, move rotation-site visits

**Files:**
- Modify: `packages/avltree/src/delete.ts:176,445,564`

**Interfaces:**
- Consumes: `AvlTreeOpsCallbacks.onNodeVisit` (existing interface, unchanged)
- Produces: `onNodeVisit` called on `result.newSubtreeRoot` at each recursion level; rotation helpers visit post-rotation node

- [ ] **Step 1: Restructure `deleteInner` dispatch (line 176)**

Remove the `onNodeVisit` call at the top of `deleteInner` (line 176). Restructure the four exit paths to assign to a `result` variable, then visit `result.newSubtreeRoot` before returning. The early error return (`proof-malformed` when `direction < 0 && node.left.kind === 'leaf'`) stays as-is — no visit on error.

```ts
// BEFORE (lines 146-206, key section lines 176-206):
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

  if (node.kind !== 'internal') {
    return { ok: false, reason: 'proof-malformed' }
  }

  callbacks.onNodeVisit(node, op, false)   // ← REMOVE THIS LINE

  if (direction < 0 && node.left.kind === 'leaf') {
    return { ok: false, reason: 'proof-malformed' }
  }

  if (direction >= 0 && node.right.kind === 'leaf') {
    return tryEasyDeleteRightLeaf(node, node.right, direction, deleteMax, op, saved)
  }

  if (direction === 0 && node.left.kind === 'leaf') {
    return tryEasyDeleteLeftLeaf(node, node.left, op)
  }

  if (direction <= 0) {
    return hardDeleteLeftDescent(node, direction, op, callbacks, saved)
  }
  return hardDeleteRightDescent(node, deleteMax, op, callbacks, saved)
}

// AFTER:
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

  if (node.kind !== 'internal') {
    return { ok: false, reason: 'proof-malformed' }
  }

  if (direction < 0 && node.left.kind === 'leaf') {
    return { ok: false, reason: 'proof-malformed' }
  }

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

- [ ] **Step 2: Fix `rebalanceShrinkLeft` rotation visit (line 445)**

Move `onNodeVisit` from before `doubleLeftRotate` to after, visiting `rotated`:

```ts
// BEFORE (lines 443-452):
  if (rootRight.balance < 0) {
    callbacks.onNodeVisit(rotateNode, op, true)
    const tempParent = newInternal(newLeft, rootRight, 0, rotateNode.key)
    const rotated = doubleLeftRotate(tempParent)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }

// AFTER:
  if (rootRight.balance < 0) {
    const tempParent = newInternal(newLeft, rootRight, 0, rotateNode.key)
    const rotated = doubleLeftRotate(tempParent)
    callbacks.onNodeVisit(rotated, op, true)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }
```

- [ ] **Step 3: Fix `rebalanceShrinkRight` rotation visit (line 564)**

Same transformation:

```ts
// BEFORE (lines 562-571):
  if (rootLeft.balance > 0) {
    callbacks.onNodeVisit(node, op, true)
    const tempParent = newInternal(rootLeft, newRight, 0, node.key)
    const rotated = doubleRightRotate(tempParent)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }

// AFTER:
  if (rootLeft.balance > 0) {
    const tempParent = newInternal(rootLeft, newRight, 0, node.key)
    const rotated = doubleRightRotate(tempParent)
    callbacks.onNodeVisit(rotated, op, true)
    return { ok: true, newSubtreeRoot: rotated, heightDecreased: true }
  }
```

- [ ] **Step 4: Commit**

```bash
git add packages/avltree/src/delete.ts
git commit -m "fix(avltree): move onNodeVisit calls after result computation in delete.ts

Restructure deleteInner dispatch to visit result.newSubtreeRoot at each
recursion level. Move rotation-site visits to after doubleLeftRotate/
doubleRightRotate, visiting the rotated result.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Fix `batch-prover.ts` — switch `packTree` to `this.root`, remove dead fields

**Files:**
- Modify: `packages/avltree/src/batch-prover.ts:92,98,119,121,250-253,371,409-411,420-421,424,470,518-527`

**Interfaces:**
- Consumes: (none — internal refactor)
- Produces: `packTree` now traverses from `this.root`; `oldTopNode`, `needsCycleReset`, `clearVisitedFlags` removed

- [ ] **Step 1: Remove `oldTopNode` and `needsCycleReset` field declarations**

Remove lines 92 and 98:

```ts
// REMOVE line 92:
  private oldTopNode: AvlNode | null = null

// REMOVE line 98:
  private needsCycleReset = false
```

- [ ] **Step 2: Remove `this.oldTopNode = this.root` from constructor**

Remove line 121 from the constructor (the line after `this.height = 1`):

```ts
// BEFORE (lines 119-121):
      this.root = newInternal(negInfLeaf, posInfLeaf, 0, posInfKey)
      this.height = 1
      this.oldTopNode = this.root

// AFTER:
      this.root = newInternal(negInfLeaf, posInfLeaf, 0, posInfKey)
      this.height = 1
```

- [ ] **Step 3: Remove `needsCycleReset` block from `performOneOperation`**

Remove lines 250-253:

```ts
// REMOVE these four lines:
    if (this.needsCycleReset) {
      this.clearVisitedFlags(this.root)
      this.needsCycleReset = false
    }
```

- [ ] **Step 4: Switch `packTree` entry point in `generateProof`**

Change line 409-411 from `packTree(this.oldTopNode!)` to `packTree(this.root!)`:

```ts
// BEFORE (lines 409-411):
    if (this.oldTopNode !== null) {
      packTree(this.oldTopNode)
    }

// AFTER:
    if (this.root !== null) {
      packTree(this.root)
    }
```

- [ ] **Step 5: Remove `needsCycleReset` and `oldTopNode` assignments from `generateProof`**

Remove lines 420-421 (`this.needsCycleReset = true`) and line 424 (`this.oldTopNode = this.root`):

```ts
// BEFORE (lines 419-424):
    this.modifiedNodes = []
    this.needsCycleReset = true
    this.directions = []
    this.directionsBitLength = 0
    this.oldTopNode = this.root

// AFTER:
    this.modifiedNodes = []
    this.directions = []
    this.directionsBitLength = 0
```

- [ ] **Step 6: Remove `clonedProver.oldTopNode = cloneRoot` from `generateProofForOperations`**

Remove line 470:

```ts
// BEFORE (lines 466-470):
    clonedProver.root = cloneRoot
    clonedProver.height = this.height
    clonedProver.oldTopNode = cloneRoot

// AFTER:
    clonedProver.root = cloneRoot
    clonedProver.height = this.height
```

- [ ] **Step 7: Remove `clearVisitedFlags` method**

Remove the entire method (lines 518-527):

```ts
// REMOVE these 10 lines:
  private clearVisitedFlags(node: AvlNode | null): void {
    if (node === null) return
    if (node.kind !== 'label') {
      node.labelCache = null
    }
    if (node.kind === 'internal') {
      this.clearVisitedFlags(node.left)
      this.clearVisitedFlags(node.right)
    }
  }
```

- [ ] **Step 8: Commit**

```bash
git add packages/avltree/src/batch-prover.ts
git commit -m "fix(avltree): switch packTree to this.root, remove oldTopNode/needsCycleReset

packTree now traverses from this.root (current tree) instead of stale
oldTopNode. Remove oldTopNode, needsCycleReset, and clearVisitedFlags —
all dead after the switch.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Verify the failing test passes + all existing tests green

**Files:**
- Verify: all test files unchanged

- [ ] **Step 1: Run the wasModified test — must PASS**

```bash
cd packages/avltree && npx vitest run test/prover-wasModified-fix.test.ts
```

Expected: PASS. Both `verifyAvlBatch` calls return non-null with correct results and digests.

- [ ] **Step 2: Run full avltree test suite — all 180 tests green**

```bash
cd packages/avltree && npx vitest run
```

Expected: 180 tests pass (179 existing + 1 new). No regressions. Mutation test kill rate ≥90%.

- [ ] **Step 3: Typecheck**

```bash
cd packages/avltree && npx tsc --noEmit
```

Expected: clean, no errors.

- [ ] **Step 4: Run full monorepo test suite**

```bash
npm test
```

Expected: all packages pass (scorex, avltree, nipopow, ergoscript, transaction).

- [ ] **Step 5: Commit (squash with previous if desired, or amend)**

```bash
# Verify all green, then:
git add -A
git commit -m "test(avltree): wasModified fix verified — all 180 tests green

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Add multi-batch round-trip test (3 batches, 3 generateProof calls)

**Files:**
- Modify: `packages/avltree/test/prover-wasModified-fix.test.ts`

**Interfaces:**
- Consumes: `BatchAVLProver`, `verifyAvlBatch`, `AvlTreeConfig` (already imported)
- Produces: Additional test case for multi-batch scenario

- [ ] **Step 1: Add the multi-batch test**

Append to the existing `describe` block in `prover-wasModified-fix.test.ts`:

```ts
  it('multi-batch round-trip: Insert → genProof → Insert → genProof → Update → genProof', () => {
    const prover = new BatchAVLProver(config.keyLength, config.valueLengthOpt)
    const key1 = new Uint8Array(32).fill(0x01)
    const key2 = new Uint8Array(32).fill(0x02)
    const val1 = new Uint8Array([10, 20])
    const val2 = new Uint8Array([30, 40])
    const val2b = new Uint8Array([50, 60])

    // Batch 1: Insert key1
    const digest0 = prover.digest()!
    prover.performOneOperation({ tag: 'Insert', key: key1, value: val1 })
    const proof1 = prover.generateProof()
    const digest1 = prover.digest()!

    const v1 = verifyAvlBatch(digest0, proof1, config, [
      { tag: 'Insert', key: key1, value: val1 },
    ])
    expect(v1).not.toBeNull()
    expect(v1!.results).toEqual([null])
    expect(v1!.newDigest).toEqual(digest1)

    // Batch 2: Insert key2
    prover.performOneOperation({ tag: 'Insert', key: key2, value: val2 })
    const proof2 = prover.generateProof()
    const digest2 = prover.digest()!

    const v2 = verifyAvlBatch(digest1, proof2, config, [
      { tag: 'Insert', key: key2, value: val2 },
    ])
    expect(v2).not.toBeNull()
    expect(v2!.results).toEqual([null])
    expect(v2!.newDigest).toEqual(digest2)

    // Batch 3: Update key2
    prover.performOneOperation({ tag: 'Update', key: key2, value: val2b })
    const proof3 = prover.generateProof()
    const digest3 = prover.digest()!

    const v3 = verifyAvlBatch(digest2, proof3, config, [
      { tag: 'Update', key: key2, value: val2b },
    ])
    expect(v3).not.toBeNull()
    expect(v3!.results).toEqual([val2]) // Update returns old value
    expect(v3!.newDigest).toEqual(digest3)
  })
```

- [ ] **Step 2: Run the test — must PASS**

```bash
cd packages/avltree && npx vitest run test/prover-wasModified-fix.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 3: Run full suite again to confirm no regressions**

```bash
cd packages/avltree && npx vitest run
```

Expected: 181 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/avltree/test/prover-wasModified-fix.test.ts
git commit -m "test(avltree): add multi-batch round-trip test (3 × generateProof)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Update `facts/avltree.md` — drop stale field contract notes

**Files:**
- Modify: `facts/avltree.md`

- [ ] **Step 1: Check facts/avltree.md for any documentation of removed fields**

```bash
grep -n "oldTopNode\|needsCycleReset\|clearVisitedFlags" facts/avltree.md
```

- [ ] **Step 2: If any references found, update them to reflect current state**

Remove or update any documentation of `oldTopNode`, `needsCycleReset`, or `clearVisitedFlags` — these are internal implementation details that no longer exist. The public API is unchanged.

- [ ] **Step 3: Commit if changes made**

```bash
git add facts/avltree.md
git commit -m "docs(avltree): update facts for wasModified fix (remove stale internals)

Co-Authored-By: Claude <noreply@anthropic.com>"
```
