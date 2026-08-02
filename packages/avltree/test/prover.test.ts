import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { PersistentBatchAVLProver } from '../src/persistent-prover.js'
import { newLabel, type AvlNode, type VersionedAVLStorage } from '../src/index.js'

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

  it('throws on key shorter than tree key length', () => {
    const prover = new BatchAVLProver(32, null)
    const shortKey = new Uint8Array(16)
    expect(() =>
      prover.performOneOperation({ tag: 'Insert', key: shortKey, value: new Uint8Array([1]) }),
    ).toThrow()
  })

  it('throws on key longer than tree key length', () => {
    const prover = new BatchAVLProver(32, null)
    const longKey = new Uint8Array(64)
    expect(() =>
      prover.performOneOperation({ tag: 'Insert', key: longKey, value: new Uint8Array([1]) }),
    ).toThrow()
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
    expect(() => prover.digest()).toThrow(RangeError)
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
