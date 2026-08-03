import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { PersistentBatchAVLProver } from '../src/persistent-prover.js'
import {
  newLabel,
  verifyAvlBatch,
  AvlVerifyError,
  type AvlNode,
  type AvlTreeConfig,
  type InternalNode,
  type Operation,
  type VersionedAVLStorage,
} from '../src/index.js'

// C4: shared assertion helper for the prover/verifier's thrown AvlVerifyError
// codes. Fallback idiom (no prior standalone helper existed in this file;
// verify-batch.test.ts's AVL-03 pins use an inline try/catch of the same shape).
function expectAvlCode(fn: () => unknown, code: string): void {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(AvlVerifyError)
  expect((caught as AvlVerifyError).code).toBe(code)
}

describe('BatchAVLProver', () => {
  it('constructs an empty tree and produces a valid digest', () => {
    const prover = new BatchAVLProver(32, null)
    const d = prover.digest()
    expect(d).not.toBeNull()
    expect(d!.length).toBe(33)
    // Height byte is the last byte; empty tree is a single sentinel leaf → height 0
    expect(d![32]).toBe(0)
    // The root label is deterministic — blake2b of (0x00 || negInfKey || dummyValue || posInfKey)
    // Verify the root label is non-zero (not all zeroes)
    const rootLabel = d!.slice(0, 32)
    const allZero = rootLabel.every((b) => b === 0)
    expect(allZero).toBe(false)
  })

  it('accepts an Insert and returns null old value', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value).toBeNull() // key was absent
    }
  })

  it('rejects Insert on existing key', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(false)
  })

  it('digest changes after Insert', () => {
    const prover = new BatchAVLProver(32, null)
    const before = prover.digest()!
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const after = prover.digest()!
    // Digest should change after insertion
    expect(after).not.toEqual(before)
    // Height should still be valid (0 or 1 — depends on tree shape after single insert)
    expect(after[32]).toBeGreaterThanOrEqual(0)
  })

  it('unauthenticatedLookup returns the inserted value', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const lookedUp = prover.unauthenticatedLookup(key)
    expect(lookedUp).not.toBeNull()
    expect(lookedUp).toEqual(value)
  })

  it('unauthenticatedLookup returns null for absent key', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3])
    prover.performOneOperation({ tag: 'Insert', key, value })
    const absentKey = new Uint8Array(32)
    absentKey.fill(0x02)
    const lookedUp = prover.unauthenticatedLookup(absentKey)
    expect(lookedUp).toBeNull()
  })

  it('performOneOperation Lookup on an absent key succeeds with a null value', () => {
    const prover = new BatchAVLProver(32, null)
    const present = new Uint8Array(32); present.fill(0x11)
    prover.performOneOperation({ tag: 'Insert', key: present, value: new Uint8Array([1]) })
    const absent = new Uint8Array(32); absent.fill(0x22)
    const result = prover.performOneOperation({ tag: 'Lookup', key: absent })
    expect(result.success).toBe(true)
    if (result.success) expect(result.value).toBeNull()
  })

  // 'throws on key shorter than tree key length' (16-byte all-zero fixture)
  // deleted (C4): it exercised the −inf gate, not the length gate — it is
  // redundant with the 'short ALL-ZERO key fires the −inf gate' pin below.

  it('throws on key longer than tree key length', () => {
    const prover = new BatchAVLProver(32, null)
    const longKey = new Uint8Array(64)
    expectAvlCode(
      () => prover.performOneOperation({ tag: 'Insert', key: longKey, value: new Uint8Array([1]) }),
      'operation-key-length-mismatch',
    )
  })

  it('throws on value length mismatch when fixed value length is set', () => {
    const prover = new BatchAVLProver(32, 8) // fixed 8-byte values
    const key = new Uint8Array(32)
    const wrongValue = new Uint8Array([1, 2, 3]) // 3 bytes, not 8
    expect(() =>
      prover.performOneOperation({ tag: 'Insert', key, value: wrongValue }),
    ).toThrow()
  })

  it('accepts any value length when valueLengthOpt is null', () => {
    const prover = new BatchAVLProver(32, null) // variable-length values
    const key = new Uint8Array(32)
    key.fill(0x01)
    const value = new Uint8Array([1, 2, 3, 4, 5])
    const result = prover.performOneOperation({ tag: 'Insert', key, value })
    expect(result.success).toBe(true)
  })

  it('generateProof returns a non-empty proof after operations', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const proof = prover.generateProof()
    expect(proof.length).toBeGreaterThan(0)
  })

  it('generateProofForOperations returns proof and digest on success', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    // Seed with one insert so the tree is non-empty
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const result = prover.generateProofForOperations([
      { tag: 'Update', key: new Uint8Array(32).fill(0x01), value: new Uint8Array([4, 5, 6]) },
    ])
    expect(result).not.toHaveProperty('success', false)
    if ('proof' in result) {
      expect(result.proof.length).toBeGreaterThan(0)
      expect(result.digest.length).toBe(33)
    }
  })

  it('generateProofForOperations returns success:false on failed operation', () => {
    const prover = new BatchAVLProver(32, null)
    // No key inserted — Update on absent key should fail
    const result = prover.generateProofForOperations([
      { tag: 'Update', key: new Uint8Array(32).fill(0x01), value: new Uint8Array([1, 2, 3]) },
    ])
    expect(result).toEqual({ success: false })
  })

  it('supports Update operation after Insert', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const result = prover.performOneOperation({
      tag: 'Update',
      key,
      value: new Uint8Array([4, 5, 6]),
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value).toEqual(new Uint8Array([1, 2, 3])) // old value returned
    }
    // Lookup should now return updated value
    expect(prover.unauthenticatedLookup(key)).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('supports Remove operation', () => {
    const prover = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x01)
    prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1, 2, 3]) })
    const result = prover.performOneOperation({ tag: 'Remove', key })
    expect(result.success).toBe(true)
    expect(prover.unauthenticatedLookup(key)).toBeNull()
  })

  it('supports multiple inserts and lookups', () => {
    const prover = new BatchAVLProver(32, null)
    for (let i = 1; i <= 5; i++) {
      const key = new Uint8Array(32)
      key[0] = i
      const value = new Uint8Array([i])
      const result = prover.performOneOperation({ tag: 'Insert', key, value })
      expect(result.success).toBe(true)
    }
    // Verify all keys are present
    for (let i = 1; i <= 5; i++) {
      const key = new Uint8Array(32)
      key[0] = i
      expect(prover.unauthenticatedLookup(key)).toEqual(new Uint8Array([i]))
    }
    // Absent key
    const absentKey = new Uint8Array(32)
    absentKey[0] = 99
    expect(prover.unauthenticatedLookup(absentKey)).toBeNull()
  })
})

describe('performOneOperation key-gate codes (C4)', () => {
  const value = new Uint8Array([1])

  it('short ALL-ZERO key fires the −inf gate: operation-key-out-of-bounds', () => {
    const prover = new BatchAVLProver(32, null)
    expectAvlCode(
      () => prover.performOneOperation({ tag: 'Insert', key: new Uint8Array(16), value }),
      'operation-key-out-of-bounds',
    )
  })

  it('short NON-ZERO key reaches the length gate: operation-key-length-mismatch', () => {
    const prover = new BatchAVLProver(32, null)
    expectAvlCode(
      () => prover.performOneOperation({ tag: 'Insert', key: new Uint8Array(16).fill(0x42), value }),
      'operation-key-length-mismatch',
    )
  })

  it('exact −inf sentinel (32×0x00): operation-key-out-of-bounds', () => {
    const prover = new BatchAVLProver(32, null)
    expectAvlCode(
      () => prover.performOneOperation({ tag: 'Insert', key: new Uint8Array(32), value }),
      'operation-key-out-of-bounds',
    )
  })

  it('exact +inf sentinel (32×0xFF): operation-key-out-of-bounds', () => {
    const prover = new BatchAVLProver(32, null)
    expectAvlCode(
      () => prover.performOneOperation({ tag: 'Insert', key: new Uint8Array(32).fill(0xff), value }),
      'operation-key-out-of-bounds',
    )
  })

  // Regression guard, not RED — this site (verify.ts's config-shape wrapper
  // check) already carries the right code pre-fix; it constrains against a
  // future accidental rename of this specific config code, it doesn't
  // demonstrate the C4 split (Task-4-class guard). Note: brief's example
  // passed (config, operations) as ([], {keyLength:0,...}) — reversed vs the
  // real verifyAvlBatch(startingDigest, proof, config, operations) signature;
  // corrected here (see task-2-report.md deviations).
  it('config keyLength <= 0 keeps invalid-config-key-length (verify.ts wrapper)', () => {
    expectAvlCode(
      () =>
        verifyAvlBatch(new Uint8Array(33), new Uint8Array([0]), {
          keyLength: 0,
          valueLengthOpt: null,
        }, []),
      'invalid-config-key-length',
    )
  })
})

describe('BatchAVLProver hard-delete separator maintenance', () => {
  /**
   * Key whose first and last bytes are `b`. Mirrors the key shape of the
   * randomised walk that first surfaced this defect, so the tree shapes below
   * are the ones that walk actually produced.
   */
  const keyByte = (b: number): Uint8Array => {
    const k = new Uint8Array(32)
    k[0] = b
    k[31] = b
    return k
  }

  /**
   * Regression for the stale separator key on hard delete.
   *
   * `deleteHelper`'s `direction === 0` branch is reached only when the key
   * being removed sits at an internal node with TWO internal children. That
   * case cannot splice a child out directly: it runs a deleteMax descent down
   * the left subtree, promotes that subtree's max leaf (the in-order
   * predecessor) into the leftmost leaf of the right subtree, and must move
   * the node's separator key along with it.
   *
   * The insertion order below is load-bearing. It builds:
   *
   *     Int(0x12)
   *       L Int(0x0c) -> leaves 0x0b, 0x0c
   *       R Int(0x13) -> leaves 0x12, 0x13
   *
   * so Remove(0x12) lands on `Int(0x12)` with two internal children and
   * promotes leaf 0x0c. If the separator stays 0x12 the tree violates the
   * AVL+ invariant (an internal node's key must equal the minimum key of its
   * right subtree) in two visible ways: the removed key still routes to a
   * leaf (ghost key), and 0x0c — present, and never touched by the Remove —
   * compares less than the stale 0x12 and is sent down the wrong subtree,
   * becoming permanently unreachable.
   *
   * Traced from seed 3 of the randomised prover/verifier walk.
   */
  it('keeps every surviving key reachable after a hard delete promotes the predecessor', () => {
    const prover = new BatchAVLProver(32, null)
    const inserted: ReadonlyArray<readonly [number, number]> = [
      [0x12, 17],
      [0x0b, 10],
      [0x13, 18],
      [0x0c, 11],
      [0x07, 6],
      [0x05, 4],
    ]
    for (const [b, v] of inserted) {
      const result = prover.performOneOperation({
        tag: 'Insert',
        key: keyByte(b),
        value: new Uint8Array([v]),
      })
      expect(result.success, `Insert 0x${b.toString(16)} failed`).toBe(true)
    }

    const removed = prover.performOneOperation({ tag: 'Remove', key: keyByte(0x12) })
    expect(removed.success).toBe(true)

    // The removed key must be gone. A stale separator resurrects it: the
    // lookup matches at the separator and descends to the promoted leaf.
    expect(prover.unauthenticatedLookup(keyByte(0x12))).toBeNull()

    // ...and every surviving key must still resolve to its own value. 0x0c is
    // the promoted predecessor and the one a stale separator strands.
    for (const [b, v] of inserted) {
      if (b === 0x12) continue
      const found = prover.unauthenticatedLookup(keyByte(b))
      expect(found, `key 0x${b.toString(16)} unreachable after Remove(0x12)`).not.toBeNull()
      expect(Array.from(found!), `key 0x${b.toString(16)} resolved to the wrong value`).toEqual([v])
    }
  })
})

describe('BatchAVLProver per-operation proofs on the recursive delete path', () => {
  const KEY_LENGTH = 32

  const keyByte = (b: number): Uint8Array => {
    const k = new Uint8Array(KEY_LENGTH)
    k[0] = b
    k[31] = b
    return k
  }

  /**
   * Regression for the delete path's missing `onNodeVisit` calls.
   *
   * `onNodeVisit` is what puts a node into `modifiedNodes`, and `generateProof`
   * emits a node in that set as full data and a node outside it as a bare
   * 33-byte label. Every node the verifier must descend into to replay the
   * operation therefore has to be visited by the prover. `deleteHelper` skipped
   * several of the Rust reference's visits, so the prover emitted labels where
   * the verifier needed contents and rejected its own proof.
   *
   * Shape: keys 0x01..0x07 inserted in ascending order build a balanced tree
   * whose root separator is 0x04 with two INTERNAL children. `Remove(0x04)`
   * therefore cannot splice a child out directly — it enters
   * `hardDeleteLeftDescent` with direction 0 and runs a deleteMax descent down
   * the left subtree, whose bottom frame saves the max leaf (0x03) for
   * promotion. That leaf is not the leaf `modifyHelper` visited on the first
   * pass, so nothing else marks it: unvisited, it is packed as a label and the
   * verifier cannot read the key/value it must promote.
   *
   * The batched property walks cannot see this — over ~40 operations some
   * other operation visits the node anyway. The build phase is flushed with
   * `generateProof()` first precisely so this proof covers the Remove alone,
   * which is the ordinary prover→verifier usage.
   */
  it('verifies a single-Remove proof taken at a node with two internal children', () => {
    const prover = new BatchAVLProver(KEY_LENGTH, null)
    for (let b = 1; b <= 7; b++) {
      const inserted = prover.performOneOperation({
        tag: 'Insert',
        key: keyByte(b),
        value: new Uint8Array([b]),
      })
      expect(inserted.success, `Insert 0x${b.toString(16)} failed`).toBe(true)
    }

    // Flush the build phase — the proof taken below then covers only the Remove.
    prover.generateProof()

    const digestBefore = prover.digest()
    expect(digestBefore).not.toBeNull()

    // Shape anchor. The last digest byte is the tree height, and height 3 is
    // what pins the shape this test needs: a root separator with two INTERNAL
    // children, so `Remove(0x04)` cannot take an easy case and must enter
    // `hardDeleteLeftDescent` with direction 0. A change to the insert path or
    // the rotation balance table could quietly flatten the tree and route the
    // Remove elsewhere; the test would still pass and silently stop covering
    // the recursive delete path.
    expect(
      digestBefore![32],
      'tree shape drifted — this test needs the two-internal-children root (height 3)',
    ).toBe(3)

    const op: Operation = { tag: 'Remove', key: keyByte(0x04) }
    const removed = prover.performOneOperation(op)
    expect(removed.success, 'Remove(0x04) unexpectedly failed').toBe(true)

    const proof = prover.generateProof()
    const digestAfter = prover.digest()
    expect(digestAfter).not.toBeNull()

    const config: AvlTreeConfig = {
      keyLength: KEY_LENGTH,
      valueLengthOpt: null,
      maxNumOperations: 1,
      maxDeletes: 1,
    }
    const verified = verifyAvlBatch(digestBefore!, proof, config, [op])
    expect(verified, 'verifier rejected a single-Remove proof the prover produced').not.toBeNull()
    expect(
      Array.from(verified!.newDigest),
      'verifier digest disagrees with the prover after the Remove',
    ).toEqual(Array.from(digestAfter!))
  })

  /** Narrow a node to InternalNode, failing with a useful message if it isn't. */
  const asInternal = (n: AvlNode | null | undefined, what: string): InternalNode => {
    expect(n, `${what} is missing`).toBeTruthy()
    expect(n!.kind, `${what} is not an internal node`).toBe('internal')
    return n as InternalNode
  }

  /** Build a tree from an explicit insertion order and flush the build phase. */
  const buildFlushed = (order: number[]): BatchAVLProver => {
    const prover = new BatchAVLProver(KEY_LENGTH, null)
    for (const b of order) {
      const inserted = prover.performOneOperation({
        tag: 'Insert',
        key: keyByte(b),
        value: new Uint8Array([b]),
      })
      expect(inserted.success, `Insert 0x${b.toString(16).padStart(2, '0')} failed`).toBe(true)
    }
    // Flush the build phase so the proof taken afterwards covers the Remove alone.
    prover.generateProof()
    return prover
  }

  const singleOpConfig: AvlTreeConfig = {
    keyLength: KEY_LENGTH,
    valueLengthOpt: null,
    maxNumOperations: 1,
    maxDeletes: 1,
  }

  /**
   * Deterministic cover for the retargeted DOUBLE-LEFT rotation visit
   * (`delete.ts` `rebalanceShrinkLeft`, Rust line 571 @191052c —
   * `on_node_visit(&right_child.left, …)`).
   *
   * Insertion order 2,4,1,3 builds:
   *
   *   I[0x02](bal +1)
   *   ├── I[0x01](0) ── L(-inf), L(0x01)
   *   └── I[0x04](-1)
   *       ├── I[0x03](0) ── L(0x02), L(0x03)
   *       └── L(0x04)
   *
   * `Remove(0x01)` shrinks the left subtree of a right-heavy root, so
   * `hardDeleteLeftDescent` takes the rotation branch (`childHeightDecreased &&
   * rootBalance > 0`). The right child is LEFT-heavy (balance -1), which selects
   * the DOUBLE-left rotation, and the node `doubleLeftRotate` promotes to
   * sub-root is `rootRight.left` = `I[0x03]`. Nothing else on this operation's
   * path visits `I[0x03]`, so if the visit targets the wrong node it is packed
   * as a label and the verifier cannot descend into it.
   *
   * Verified discriminating: with the visit pointed back at `rotateNode` (the
   * pre-fix target) this test fails; the randomised per-operation walk catches
   * the same regression on only 1 of its 15 seeds.
   */
  it('verifies a single-Remove proof through a delete-triggered double-LEFT rotation', () => {
    const prover = buildFlushed([2, 4, 1, 3])

    const digestBefore = prover.digest()
    expect(digestBefore).not.toBeNull()
    expect(
      digestBefore![32],
      'tree shape drifted — the double-left case needs a height-3 tree',
    ).toBe(3)

    // Anchor the two balances that select this exact rotation. Without them a
    // change to the insert path could reshape the tree and route the Remove
    // down a single rotation (or no rotation) while the test still passed.
    const root = asInternal(prover.root, 'root')
    expect(root.balance, 'root must be right-heavy for the shrink-left rotation').toBe(1)
    expect(
      asInternal(root.right, 'root.right').balance,
      'root.right must be left-heavy to select the DOUBLE-left rotation',
    ).toBe(-1)

    const op: Operation = { tag: 'Remove', key: keyByte(0x01) }
    const removed = prover.performOneOperation(op)
    expect(removed.success, 'Remove(0x01) unexpectedly failed').toBe(true)

    const proof = prover.generateProof()
    const digestAfter = prover.digest()
    expect(digestAfter, 'prover has no digest after the Remove').not.toBeNull()

    const verified = verifyAvlBatch(digestBefore!, proof, singleOpConfig, [op])
    expect(
      verified,
      'verifier rejected the double-left-rotation Remove proof the prover produced',
    ).not.toBeNull()
    expect(
      Array.from(verified!.newDigest),
      'verifier digest disagrees with the prover after the double-left rotation',
    ).toEqual(Array.from(digestAfter!))
  })

  /**
   * Mirror of the test above, for the retargeted DOUBLE-RIGHT rotation visit
   * (`delete.ts` `rebalanceShrinkRight`, Rust line 621 @191052c —
   * `on_node_visit(&left_child.right, …)`).
   *
   * Insertion order 3,1,4,2 is the exact key-mirror (k → 5-k) of the shape
   * above and builds:
   *
   *   I[0x03](bal -1)
   *   ├── I[0x01](+1)
   *   │   ├── L(-inf)
   *   │   └── I[0x02](0) ── L(0x01), L(0x02)
   *   └── I[0x04](0) ── L(0x03), L(0x04)
   *
   * `Remove(0x04)` shrinks the right subtree of a left-heavy root, so
   * `hardDeleteRightDescent` takes the rotation branch (`childHeightDecreased &&
   * node.balance < 0`). The left child is RIGHT-heavy (balance +1), selecting
   * the DOUBLE-right rotation, whose promoted sub-root is `rootLeft.right` =
   * `I[0x02]`.
   *
   * Verified discriminating: with the visit pointed back at `node` (the pre-fix
   * target, already visited on the way down and therefore inert) this test
   * fails.
   */
  it('verifies a single-Remove proof through a delete-triggered double-RIGHT rotation', () => {
    const prover = buildFlushed([3, 1, 4, 2])

    const digestBefore = prover.digest()
    expect(digestBefore).not.toBeNull()
    expect(
      digestBefore![32],
      'tree shape drifted — the double-right case needs a height-3 tree',
    ).toBe(3)

    const root = asInternal(prover.root, 'root')
    expect(root.balance, 'root must be left-heavy for the shrink-right rotation').toBe(-1)
    expect(
      asInternal(root.left, 'root.left').balance,
      'root.left must be right-heavy to select the DOUBLE-right rotation',
    ).toBe(1)

    const op: Operation = { tag: 'Remove', key: keyByte(0x04) }
    const removed = prover.performOneOperation(op)
    expect(removed.success, 'Remove(0x04) unexpectedly failed').toBe(true)

    const proof = prover.generateProof()
    const digestAfter = prover.digest()
    expect(digestAfter, 'prover has no digest after the Remove').not.toBeNull()

    const verified = verifyAvlBatch(digestBefore!, proof, singleOpConfig, [op])
    expect(
      verified,
      'verifier rejected the double-right-rotation Remove proof the prover produced',
    ).not.toBeNull()
    expect(
      Array.from(verified!.newDigest),
      'verifier digest disagrees with the prover after the double-right rotation',
    ).toEqual(Array.from(digestAfter!))
  })
})

describe('BatchAVLProver.restoreRoot', () => {
  it('rebases the proof cycle on a restored tree', () => {
    // Build a tree with some entries, snapshot its root + digest.
    const src = new BatchAVLProver(32, null)
    for (let i = 0; i < 5; i++) {
      const key = new Uint8Array(32)
      key[0] = 0x10 + i
      key[31] = 0x10 + i
      const value = new Uint8Array([i, i, i])
      const r = src.performOneOperation({ tag: 'Insert', key, value })
      expect(r.success).toBe(true)
    }
    const srcDigest = src.digest()
    expect(srcDigest).not.toBeNull()

    // Snapshot root and height.
    const savedRoot = src.root
    const savedHeight = src.height
    expect(savedRoot).not.toBeNull()
    expect(savedHeight).toBeGreaterThan(0)

    // Restore into a fresh prover.
    const restored = new BatchAVLProver(32, null)
    restored.restoreRoot(savedRoot!, savedHeight)

    // Digest must match.
    const restoredDigest = restored.digest()
    expect(restoredDigest).not.toBeNull()
    expect(restoredDigest).toEqual(srcDigest)

    // Perform an operation on the restored tree — must succeed.
    // Must not be all-zeroes (negative-infinity key) or all-0xff (positive-infinity key).
    const newKey = new Uint8Array(32)
    newKey.fill(0x99)
    const r = restored.performOneOperation({
      tag: 'Insert',
      key: newKey,
      value: new Uint8Array([9, 9, 9]),
    })
    expect(r.success).toBe(true)

    // Generate a proof from the restored prover.
    const proof = restored.generateProof()
    expect(proof).not.toBeNull()
    // Proof should be non-empty (at least one operation)
    expect(proof!.length).toBeGreaterThan(0)
  })

  it('allows lookup on restored tree', () => {
    const src = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key[0] = 0x42
    key[31] = 0x42
    const value = new Uint8Array([0xab, 0xcd])
    src.performOneOperation({ tag: 'Insert', key, value })

    const restored = new BatchAVLProver(32, null)
    restored.restoreRoot(src.root!, src.height)

    // Lookup must find the inserted key.
    expect(restored.unauthenticatedLookup(key)).toEqual(value)
  })
})

describe('BatchAVLProver label cache lifecycle', () => {
  it('preserves cached labels on nodes that survive a proof cycle', () => {
    /** Collect every node reachable from `node`, in traversal order. */
    const collectNodes = (node: AvlNode, out: AvlNode[] = []): AvlNode[] => {
      out.push(node)
      if (node.kind === 'internal') {
        collectNodes(node.left, out)
        collectNodes(node.right, out)
      }
      return out
    }

    const cacheOf = (n: AvlNode): Uint8Array | null =>
      n.kind === 'label' ? null : (n as { labelCache: Uint8Array | null }).labelCache

    const prover = new BatchAVLProver(32, null)
    for (let i = 1; i <= 8; i++) {
      const key = new Uint8Array(32)
      key.fill(i)
      prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([i]) })
    }
    prover.generateProof()
    prover.digest() // populates every label in the tree

    const cachedBefore = collectNodes(prover.root!).filter((n) => cacheOf(n) !== null)
    expect(cachedBefore.length).toBeGreaterThan(0)

    // The pre-fix clear was LAZY: generateProof() only set a flag, and the
    // actual clearing happened inside the NEXT performOneOperation(). This
    // operation is what makes the assertion below discriminate — without it the
    // test passes whether or not the clearing code exists.
    const laterKey = new Uint8Array(32)
    laterKey.fill(200)
    prover.performOneOperation({ tag: 'Insert', key: laterKey, value: new Uint8Array([9]) })

    // Only assert on nodes still reachable after the insert: an immutable AVL
    // rebuilds the root-to-insertion path, so nodes on it are legitimately
    // replaced by fresh ones with a null cache. Nodes off the path are shared
    // by reference and must keep their cached labels.
    const reachableAfter = new Set(collectNodes(prover.root!))
    const survivors = cachedBefore.filter((n) => reachableAfter.has(n))
    expect(survivors.length).toBeGreaterThan(0) // guards against a vacuous filter
    for (const n of survivors) {
      expect(cacheOf(n)).not.toBeNull()
    }
  })

  it('produces correct digests across several proof cycles', () => {
    // Guards against confusing "cache preserved" with "cache stale": if a
    // preserved label were ever wrong, the digest would drift from a
    // freshly-computed tree's.
    const a = new BatchAVLProver(32, null)
    const b = new BatchAVLProver(32, null)

    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 1; i <= 4; i++) {
        const key = new Uint8Array(32)
        key[0] = cycle * 4 + i
        key[31] = cycle * 4 + i
        const value = new Uint8Array([cycle, i])
        a.performOneOperation({ tag: 'Insert', key, value })
        b.performOneOperation({ tag: 'Insert', key, value })
      }
      a.generateProof() // a takes proof cycles; b never does
      expect(a.digest()).toEqual(b.digest())
    }
  })
})

describe('BatchAVLProver modified-node tracking', () => {
  /**
   * Twelve inserts on monotonically increasing keys, then two Lookups on an
   * already-inserted key. Both tests below run this identical sequence
   * against their own prover instance — per the round-2 review, they must
   * differ only in whether a counting Set is installed afterward.
   *
   * Insert alone never revisits a node: modify.ts's ModifyOk doc explains
   * that a structural change forces every ancestor on the path to be
   * rebuilt fresh ("changeHappened" propagates true to the root), so an
   * insert-only sequence retires every node it touches — confirmed
   * empirically (addCalls === size with only the 12 inserts; see
   * task-3-report.md "Fix round 1").
   *
   * A Lookup is the case that keeps nodes alive: it never mutates the tree,
   * so "changeHappened=false propagates up ... the parent returns its
   * original node without creating a new internal node" (modify.ts
   * ModifyOk doc). handleInternalNode still calls onNodeVisit on every
   * internal node along the path regardless of op type, so repeating a
   * Lookup for the same already-inserted key visits the same surviving
   * node objects a second time.
   */
  function runSampleOperations(prover: BatchAVLProver): void {
    for (let i = 1; i <= 12; i++) {
      const key = new Uint8Array(32)
      key.fill(i)
      prover.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([i]) })
    }
    const lookupKey = new Uint8Array(32)
    lookupKey.fill(1)
    prover.performOneOperation({ tag: 'Lookup', key: lookupKey })
    prover.performOneOperation({ tag: 'Lookup', key: lookupKey })
  }

  it('tracks modified nodes in a Set, not an array', () => {
    // Prover A is never instrumented — its modifiedNodes field is read
    // exactly as the class produces it, independently re-deriving the
    // production runtime type. This (not the dedup test below) is the
    // actual regression net against a future revert to an array.
    const proverA = new BatchAVLProver(32, null)
    runSampleOperations(proverA)

    // modifiedNodes is private; reach it deliberately for this structural
    // assertion. A timing assertion would be flaky and is not written.
    const tracked = (proverA as unknown as { modifiedNodes: Set<AvlNode> | AvlNode[] })
      .modifiedNodes
    expect(tracked instanceof Set).toBe(true)
    expect((tracked as Set<AvlNode>).size).toBeGreaterThan(0)
  })

  it('collapses repeat visits to the same node into one Set entry', () => {
    /**
     * A Set cannot contain SameValueZero duplicates by specification, so
     * comparing a Set to a copy of itself (`new Set(x).size === x.size`) is
     * unconditionally true and proves nothing about deduplication. This
     * subclass counts every `add()` call so the test can compare that count
     * against the final distinct-membership size instead.
     */
    class CountingSet<T> extends Set<T> {
      addCalls = 0
      override add(value: T): this {
        this.addCalls++
        return super.add(value)
      }
    }

    // Prover B is a separate, freshly constructed instance — instrumenting
    // it never touches Prover A's field above. modifiedNodes is private;
    // reach it deliberately to install the counting Set before any
    // operations run. onNodeVisit looks up `self.modifiedNodes` fresh on
    // every call (not a captured reference), so installing the replacement
    // here redirects every subsequent .add() through it.
    const proverB = new BatchAVLProver(32, null)
    const counting = new CountingSet<AvlNode>()
    ;(proverB as unknown as { modifiedNodes: Set<AvlNode> }).modifiedNodes = counting
    runSampleOperations(proverB)

    // Prove dedup actually happened: strictly more add() calls than distinct
    // entries means at least one node was visited more than once and
    // collapsed into a single Set entry. `>=` would also pass with zero
    // duplicates and prove nothing.
    expect(counting.addCalls).toBeGreaterThan(counting.size)
  })
})

describe('BatchAVLProver height handling', () => {
  it('throws rather than wrapping when height exceeds one byte', () => {
    const prover = new BatchAVLProver(32, null)
    // Set height directly — building a real tree of this depth is infeasible,
    // which is exactly why Rust treats the bound as an assertion.
    ;(prover as unknown as { height: number }).height = 256
    expect(() => prover.digest()).toThrow(RangeError)
  })

  it('throws on a negative height', () => {
    const prover = new BatchAVLProver(32, null)
    ;(prover as unknown as { height: number }).height = -1
    expect(() => prover.digest()).toThrow(RangeError)
  })

  it('still produces a digest at the maximum valid height', () => {
    const prover = new BatchAVLProver(32, null)
    ;(prover as unknown as { height: number }).height = 255
    const d = prover.digest()
    expect(d).not.toBeNull()
    expect(d![32]).toBe(255)
  })

  // Number.isInteger is the clause the guard's own comment cites as its
  // rationale, yet none of the three cases above exercises it: 256 and -1
  // are both rejected by the plain `< 0 || > 255` range check alone. A bare
  // range check does not reject NaN or an in-range fractional value — both
  // comparisons are false for NaN, and 3.5 sits inside [0, 255]. Without the
  // guard, `out[DIGEST_LENGTH] = this.height` would coerce via Uint8Array's
  // ToUint8: NaN → byte 0, 3.5 → byte 3 — a silently wrong digest, not a
  // thrown error. (Infinity/-Infinity are included for direct regression
  // coverage; see the discrimination check in task-4-report.md for why they
  // don't specifically exercise this clause.)
  it.each([NaN, Infinity, -Infinity, 3.5])('throws on a non-integer height (%s)', (badHeight) => {
    const prover = new BatchAVLProver(32, null)
    ;(prover as unknown as { height: number }).height = badHeight
    expect(() => prover.digest()).toThrow(RangeError)
  })
})

describe('BatchAVLProver.digest root label validation', () => {
  it('throws when a restored LabelNode root carries a short digest', () => {
    const prover = new BatchAVLProver(32, null)
    // Construct as an object literal: newLabel would reject this first.
    const shortRoot = { kind: 'label' as const, label: new Uint8Array(16) }
    prover.restoreRoot(shortRoot, 3)
    // digest() has two RangeError-throwing guards (height, root-label). A bare
    // toThrow(RangeError) would also pass if the height guard fired instead —
    // anchor to the root-label guard's specific message, matching the
    // precedent set for the storage codec's child-label guards in
    // serialize.test.ts (e.g. /left child label length 16/).
    expect(() => prover.digest()).toThrow(/root label length 16/)
  })

  it('accepts a restored LabelNode root with a full 32-byte digest', () => {
    const prover = new BatchAVLProver(32, null)
    const goodRoot = newLabel(new Uint8Array(32).fill(0xab))
    prover.restoreRoot(goodRoot, 3)
    const d = prover.digest()
    expect(d).not.toBeNull()
    expect(d!.length).toBe(33)
    expect(Array.from(d!.slice(0, 32))).toEqual(Array(32).fill(0xab))
  })
})

describe('PersistentBatchAVLProver.rollback', () => {
  it('clears the aborted cycle so the next proof is not polluted', () => {
    const seed = new BatchAVLProver(32, null)
    const key = new Uint8Array(32)
    key.fill(0x11)
    seed.performOneOperation({ tag: 'Insert', key, value: new Uint8Array([1]) })
    const savedRoot = seed.root!
    const savedHeight = seed.height
    const savedDigest = seed.digest()!

    const storage: VersionedAVLStorage = {
      update: () => {},
      rollback: () => [savedRoot, savedHeight],
      version: () => savedDigest,
      rollbackVersions: () => [savedDigest],
      flush: () => {},
    }

    const prover = new BatchAVLProver(32, null)
    const persistent = new PersistentBatchAVLProver(prover, storage, [])

    // Start a cycle, then abandon it via rollback.
    const midKey = new Uint8Array(32)
    midKey.fill(0x22)
    persistent.performOneOperation({ tag: 'Insert', key: midKey, value: new Uint8Array([2]) })
    persistent.rollback(savedDigest)

    // The abandoned operation's direction bits must not appear in the proof.
    const proof = prover.generateProof()
    const fresh = new BatchAVLProver(32, null)
    fresh.restoreRoot(savedRoot, savedHeight)
    expect(Array.from(proof)).toEqual(Array.from(fresh.generateProof()))
  })
})

describe('BatchAVLProver — UpdateLongBy i64 overflow', () => {
  it('fails the operation instead of storing a wrapped-negative value', () => {
    // JVM Math.addExact semantics: MAX + 1 overflows i64 → per-op failure.
    // Pre-fix, updateFn sign-checked the TRUE bigint sum (> 0) and stored the
    // wrapped-negative 8-byte encoding. See operation.test.ts's overflow block
    // for the three-way reference comparison.
    const prover = new BatchAVLProver(1, 8)
    const key = new Uint8Array([0x10])
    const max = new Uint8Array(8)
    new DataView(max.buffer).setBigInt64(0, 2n ** 63n - 1n, false)
    expect(prover.performOneOperation({ tag: 'Insert', key, value: max }).success).toBe(true)
    const result = prover.performOneOperation({ tag: 'UpdateLongBy', key, delta: 1n })
    expect(result.success).toBe(false)
  })

  // Delta RANGE is a separate axis from sum overflow: TS `bigint` is wider
  // than the references' i64, so an out-of-range delta is representable only
  // in TS. The verifier boundary rejects it (verify.ts::validateOperationShape,
  // audit AVL-03); the prover boundary must too, else i64ToBeBytes silently
  // wraps it on the absent-key insert path (6e review finding I-1).
  it('throws operation-delta-out-of-range for delta above i64::MAX (prover boundary)', () => {
    const prover = new BatchAVLProver(1, 8)
    const key = new Uint8Array([0x10])
    expect(() =>
      prover.performOneOperation({ tag: 'UpdateLongBy', key, delta: 2n ** 63n }),
    ).toThrow(/out of signed i64 range/)
  })

  it('throws operation-delta-out-of-range for delta below i64::MIN (prover boundary)', () => {
    const prover = new BatchAVLProver(1, 8)
    const key = new Uint8Array([0x10])
    expect(() =>
      prover.performOneOperation({ tag: 'UpdateLongBy', key, delta: -(2n ** 63n) - 1n }),
    ).toThrow(/out of signed i64 range/)
  })

  // Boundary regression guards — pass pre-fix too; they pin that the range
  // check is not over-broad at the exact i64 endpoints.
  it('accepts delta exactly i64::MAX as a shape (absent key → inserts MAX)', () => {
    const prover = new BatchAVLProver(1, 8)
    const key = new Uint8Array([0x10])
    let result: ReturnType<BatchAVLProver['performOneOperation']> | undefined
    expect(() => {
      result = prover.performOneOperation({ tag: 'UpdateLongBy', key, delta: 2n ** 63n - 1n })
    }).not.toThrow()
    expect(result?.success).toBe(true)
    const stored = prover.unauthenticatedLookup(key)
    expect(stored).not.toBeNull()
    expect(Array.from(stored!)).toEqual([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  })

  it('accepts delta exactly i64::MIN as a shape (per-op semantics then reject the sum)', () => {
    const prover = new BatchAVLProver(1, 8)
    const key = new Uint8Array([0x10])
    const hundred = new Uint8Array(8)
    new DataView(hundred.buffer).setBigInt64(0, 100n, false)
    expect(prover.performOneOperation({ tag: 'Insert', key, value: hundred }).success).toBe(true)
    let result: ReturnType<BatchAVLProver['performOneOperation']> | undefined
    expect(() => {
      // 100 + MIN is IN-RANGE negative → per-op result-negative failure, not a throw.
      result = prover.performOneOperation({ tag: 'UpdateLongBy', key, delta: -(2n ** 63n) })
    }).not.toThrow()
    expect(result?.success).toBe(false)
  })
})
