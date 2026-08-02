import { describe, it, expect } from 'vitest'
import {
  BatchAVLProver,
  verifyAvlBatch,
  type AvlTreeConfig,
  type Operation,
} from '../src/index.js'

/**
 * Deterministic PRNG (mulberry32). Seeded per iteration so any failure is
 * reproducible from the seed printed in the assertion message — an
 * unreproducible property failure is nearly worthless.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KEY_LENGTH = 32
/** Small key space so collisions, updates and absent-key paths occur often. */
const KEY_SPACE = 24

function keyFor(n: number): Uint8Array {
  const k = new Uint8Array(KEY_LENGTH)
  // Non-zero, non-0xff: the sentinels are excluded from the tree's key range.
  k[0] = 1 + (n % KEY_SPACE)
  k[KEY_LENGTH - 1] = 1 + (n % KEY_SPACE)
  return k
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * One random walk: build a sequence, apply it to the prover, then prove it to
 * the verifier and check the model agrees.
 */
function runWalk(seed: number, opCount: number): void {
  const rand = rng(seed)
  const config: AvlTreeConfig = {
    keyLength: KEY_LENGTH,
    valueLengthOpt: null,
    maxNumOperations: opCount + 8,
    maxDeletes: opCount + 8,
  }

  const prover = new BatchAVLProver(KEY_LENGTH, null)
  /** Model of expected tree contents, keyed by the key's hex. */
  const model = new Map<string, Uint8Array>()

  const startingDigest = prover.digest()
  expect(startingDigest).not.toBeNull()

  const applied: Operation[] = []
  const expectedOldValues: (Uint8Array | null)[] = []

  for (let i = 0; i < opCount; i++) {
    const key = keyFor(Math.floor(rand() * KEY_SPACE))
    const hex = Array.from(key, (x) => x.toString(16).padStart(2, '0')).join('')
    const present = model.has(hex)
    const roll = rand()

    // Every branch is chosen so the operation is valid for the CURRENT model
    // state, which is what lets the assertion below be unconditional. Note
    // Lookup is only issued for keys known to be present: whether the prover
    // treats an absent-key Lookup as success-with-null or as a failure is not
    // settled here, and guessing would make the walk assert the wrong thing.
    // Absent-key paths are still exercised — every Insert is on an absent key —
    // and the committed fixture suite covers absent-key Lookup directly.
    let op: Operation
    if (!present) {
      op = { tag: 'Insert', key, value: new Uint8Array([i & 0xff, (i >> 8) & 0xff]) }
    } else if (roll < 0.35) {
      op = { tag: 'Update', key, value: new Uint8Array([(i * 7) & 0xff]) }
    } else if (roll < 0.6) {
      op = { tag: 'Remove', key }
    } else {
      op = { tag: 'Lookup', key }
    }

    const before = model.get(hex) ?? null
    const result = prover.performOneOperation(op)

    // Every operation constructed above is valid for the current model state,
    // so none may fail. A failure here is itself the finding.
    expect(result.success, `seed=${seed} op#${i} tag=${op.tag} unexpectedly failed`).toBe(true)

    applied.push(op)
    expectedOldValues.push(before)

    if (op.tag === 'Insert' || op.tag === 'Update') {
      model.set(hex, (op as { value: Uint8Array }).value)
    } else if (op.tag === 'Remove') {
      model.delete(hex)
    }
  }

  const proof = prover.generateProof()
  const finalDigest = prover.digest()
  expect(finalDigest).not.toBeNull()

  const verified = verifyAvlBatch(startingDigest!, proof, config, applied)
  expect(verified, `seed=${seed}: verifier rejected a proof the prover produced`).not.toBeNull()
  expect(
    bytesEqual(verified!.newDigest, finalDigest),
    `seed=${seed}: verifier digest does not match prover digest`,
  ).toBe(true)

  expect(verified!.results.length, `seed=${seed}: result count mismatch`).toBe(applied.length)
  for (let i = 0; i < applied.length; i++) {
    expect(
      bytesEqual(verified!.results[i]!, expectedOldValues[i]!),
      `seed=${seed} op#${i} tag=${applied[i]!.tag}: old value disagrees with the model`,
    ).toBe(true)
  }
}

/**
 * The same random walk, proved one operation at a time.
 *
 * `runWalk` above batches every operation into a single `generateProof()`, and
 * that batching hides a whole class of defect: `generateProof` expands a node
 * only if some operation in the batch visited it, so over ~40 operations one
 * operation's visits cover another's omissions. Proving each operation on its
 * own — the ordinary prover→verifier usage — removes that cover, and each proof
 * is checked against the digest immediately before and after its operation.
 */
function runPerOperationWalk(seed: number, opCount: number): void {
  const rand = rng(seed)
  const config: AvlTreeConfig = {
    keyLength: KEY_LENGTH,
    valueLengthOpt: null,
    maxNumOperations: 1,
    maxDeletes: 1,
  }

  const prover = new BatchAVLProver(KEY_LENGTH, null)
  const model = new Map<string, Uint8Array>()

  for (let i = 0; i < opCount; i++) {
    const key = keyFor(Math.floor(rand() * KEY_SPACE))
    const hex = Array.from(key, (x) => x.toString(16).padStart(2, '0')).join('')
    const present = model.has(hex)
    const roll = rand()

    // Same generator as runWalk — see the rationale on operation choice there.
    let op: Operation
    if (!present) {
      op = { tag: 'Insert', key, value: new Uint8Array([i & 0xff, (i >> 8) & 0xff]) }
    } else if (roll < 0.35) {
      op = { tag: 'Update', key, value: new Uint8Array([(i * 7) & 0xff]) }
    } else if (roll < 0.6) {
      op = { tag: 'Remove', key }
    } else {
      op = { tag: 'Lookup', key }
    }

    const digestBefore = prover.digest()
    expect(digestBefore, `seed=${seed} op#${i}: prover has no digest`).not.toBeNull()

    const before = model.get(hex) ?? null
    const result = prover.performOneOperation(op)
    expect(result.success, `seed=${seed} op#${i} tag=${op.tag} unexpectedly failed`).toBe(true)

    const proof = prover.generateProof()
    const digestAfter = prover.digest()
    expect(digestAfter).not.toBeNull()

    const verified = verifyAvlBatch(digestBefore!, proof, config, [op])
    expect(
      verified,
      `seed=${seed} op#${i} tag=${op.tag}: verifier rejected the per-operation proof`,
    ).not.toBeNull()
    expect(
      bytesEqual(verified!.newDigest, digestAfter),
      `seed=${seed} op#${i} tag=${op.tag}: verifier digest does not match prover digest`,
    ).toBe(true)
    expect(
      bytesEqual(verified!.results[0] ?? null, before),
      `seed=${seed} op#${i} tag=${op.tag}: old value disagrees with the model`,
    ).toBe(true)

    if (op.tag === 'Insert' || op.tag === 'Update') {
      model.set(hex, (op as { value: Uint8Array }).value)
    } else if (op.tag === 'Remove') {
      model.delete(hex)
    }
  }
}

describe('BatchAVLProver ↔ verifier property', () => {
  // Fixed seed list, not time-derived: the suite must be deterministic, and the
  // value is in covering a wide fixed space rather than differing each run.
  const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987]

  for (const seed of SEEDS) {
    it(`round-trips a random operation walk (seed ${seed})`, () => {
      runWalk(seed, 40)
    })
  }

  it('round-trips a longer walk', () => {
    runWalk(20260802, 200)
  })

  for (const seed of SEEDS) {
    it(`round-trips the same walk one proof per operation (seed ${seed})`, () => {
      runPerOperationWalk(seed, 40)
    })
  }
})
