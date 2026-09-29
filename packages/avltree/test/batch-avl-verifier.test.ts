import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BatchAVLProver } from '../src/batch-prover.js'
import { AvlVerifyError } from '../src/errors.js'
import type { Operation } from '../src/operation.js'
import type { AvlTreeConfig } from '../src/types.js'
import { BatchAVLVerifier, verifyAvlBatch } from '../src/verify.js'
import { ViewSlicingBytes } from './helpers/buffer-like.js'
import { SPINE_CONFIG, buildSpineDigest, buildSpineProof } from './helpers/deep-spine.js'
import { fromHex, toHex } from './helpers/tree-harness.js'

const KL = 32
const CONFIG: AvlTreeConfig = { keyLength: KL, valueLengthOpt: null }
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function key(b: number): Uint8Array {
  const k = new Uint8Array(KL)
  k[0] = b
  k[KL - 1] = b
  return k
}

/** Starting digest and proof for `ops` over a tree holding keys 10..50 (value = [b]). */
function scenario(ops: Operation[]): { digest: Uint8Array; proof: Uint8Array } {
  const p = new BatchAVLProver(KL, null)
  for (const b of [10, 20, 30, 40, 50]) {
    p.performOneOperation({ tag: 'Insert', key: key(b), value: new Uint8Array([b]) })
  }
  p.generateProof()
  const digest = p.digest()
  const r = p.generateProofForOperations(ops)
  if (!r.success) throw new Error('scenario operations must succeed on the prover')
  return { digest, proof: r.proof }
}

function codeOf(f: () => unknown): string {
  try {
    f()
  } catch (e) {
    if (e instanceof AvlVerifyError) return e.code
    throw e
  }
  return 'no throw'
}

function jsonToOp(o: { tag: string; keyHex: string; valueHex?: string; delta?: string | number }): Operation {
  const k = fromHex(o.keyHex)
  switch (o.tag) {
    case 'Lookup':
    case 'UnknownModification':
    case 'Remove':
    case 'RemoveIfExists':
      return { tag: o.tag, key: k }
    case 'Insert':
    case 'Update':
    case 'InsertOrUpdate':
      return { tag: o.tag, key: k, value: fromHex(o.valueHex ?? '') }
    case 'UpdateLongBy':
      return { tag: 'UpdateLongBy', key: k, delta: BigInt(o.delta ?? 0) }
    default:
      throw new Error(`unknown op tag ${o.tag}`)
  }
}

describe('BatchAVLVerifier — construction', () => {
  it('validates like verifyAvlBatchPartial', () => {
    const { digest, proof } = scenario([{ tag: 'Lookup', key: key(20) }])
    expect(codeOf(() => new BatchAVLVerifier(digest, proof, { keyLength: 0, valueLengthOpt: null }))).toBe('invalid-config-key-length')
    expect(codeOf(() => new BatchAVLVerifier(digest, proof, { keyLength: KL, valueLengthOpt: -1 }))).toBe('invalid-config-value-length')
    expect(
      codeOf(() => new BatchAVLVerifier(digest, proof, { keyLength: KL, valueLengthOpt: null, maxNumOperations: 1, maxDeletes: 2 })),
    ).toBe('invalid-config-max-ops')
    expect(codeOf(() => new BatchAVLVerifier(digest.subarray(0, 32), proof, CONFIG))).toBe('invalid-starting-digest-length')
  })

  it('a proof that fails to anchor leaves the verifier poisoned from birth', () => {
    const { digest, proof } = scenario([{ tag: 'Lookup', key: key(20) }])
    const wrong = new Uint8Array(digest)
    wrong[0] = wrong[0]! ^ 1
    const v = new BatchAVLVerifier(wrong, proof, CONFIG)
    expect(v.digest()).toBeNull()
    expect(v.getLastFailReason()).toBe('digest-mismatch')
    expect(v.performOneOperation({ tag: 'Lookup', key: key(20) })).toEqual({ success: false })
    expect(v.getLastFailReason()).toBe('digest-mismatch')
    expect(new BatchAVLVerifier(digest, proof.subarray(0, 3), CONFIG).getLastFailReason()).toBe('proof-truncated')
  })

  it('owns its proof and config: caller mutation after construction changes nothing', () => {
    const ops: Operation[] = [
      { tag: 'Lookup', key: key(20) },
      { tag: 'Lookup', key: key(40) },
    ]
    const { digest, proof } = scenario(ops)
    const config: AvlTreeConfig = { keyLength: KL, valueLengthOpt: null }
    const bufferLike = new ViewSlicingBytes(proof) // slice() would be a view, as on a Buffer
    const v = new BatchAVLVerifier(digest, bufferLike, config)
    bufferLike.fill(0) // the caller reuses its proof buffer
    config.keyLength = 99
    expect(v.performOneOperation(ops[0]!)).toEqual({ success: true, value: new Uint8Array([20]) })
    expect(v.performOneOperation(ops[1]!)).toEqual({ success: true, value: new Uint8Array([40]) })
  })
})

describe('BatchAVLVerifier — operations', () => {
  it('a shape error throws without poisoning', () => {
    const { digest, proof } = scenario([{ tag: 'Lookup', key: key(20) }])
    const v = new BatchAVLVerifier(digest, proof, CONFIG)
    expect(() => v.performOneOperation({ tag: 'Lookup', key: new Uint8Array(KL - 1).fill(1) })).toThrow(AvlVerifyError)
    expect(v.getLastFailReason()).toBeNull()
    expect(v.performOneOperation({ tag: 'Lookup', key: key(20) })).toEqual({ success: true, value: new Uint8Array([20]) })
  })

  it('a sentinel key fails and poisons', () => {
    const { digest, proof } = scenario([{ tag: 'Lookup', key: key(20) }])
    const v = new BatchAVLVerifier(digest, proof, CONFIG)
    expect(v.performOneOperation({ tag: 'Lookup', key: new Uint8Array(KL) })).toEqual({ success: false })
    expect(v.getLastFailReason()).toBe('key-out-of-bounds')
    expect(v.digest()).toBeNull()
    expect(v.performOneOperation({ tag: 'Lookup', key: key(20) })).toEqual({ success: false })
    expect(v.getLastFailReason()).toBe('key-out-of-bounds')
  })

  it('after a failed operation every later one fails, and the first reason is kept', () => {
    const { digest, proof } = scenario([{ tag: 'Lookup', key: key(20) }])
    const v = new BatchAVLVerifier(digest, proof, CONFIG)
    expect(v.performOneOperation({ tag: 'Insert', key: key(20), value: new Uint8Array([9]) })).toEqual({ success: false })
    expect(v.getLastFailReason()).toBe('operation-precondition-failed')
    expect(v.performOneOperation({ tag: 'Lookup', key: key(20) })).toEqual({ success: false })
    expect(v.getLastFailReason()).toBe('operation-precondition-failed')
  })

  it('returned values and digests are copies: mutating them leaves later results intact', () => {
    // Lookup(20), then Insert(25): addNode rebuilds leaf 20 from its live value.
    const ops: Operation[] = [
      { tag: 'Lookup', key: key(20) },
      { tag: 'Insert', key: key(25), value: new Uint8Array([25]) },
    ]
    const { digest, proof } = scenario(ops)
    const expected = verifyAvlBatch(digest, proof, CONFIG, ops)?.newDigest
    const v = new BatchAVLVerifier(digest, proof, CONFIG)
    const r = v.performOneOperation(ops[0]!)
    if (!r.success || r.value === null) throw new Error('expected a value')
    r.value.fill(0xee)
    expect(v.performOneOperation(ops[1]!).success).toBe(true)
    expect(v.digest()).toEqual(expected)
    v.digest()!.fill(0)
    expect(v.digest()).toEqual(expected)
  })

  it('an engine throw leaves the verifier unusable — never a rejection', () => {
    const depth = 100_000
    const v = new BatchAVLVerifier(
      buildSpineDigest(depth, 0xff),
      buildSpineProof(depth, Math.ceil(depth / 8)),
      SPINE_CONFIG,
    )
    expect(v.digest()).not.toBeNull()
    const lookup: Operation = { tag: 'Lookup', key: new Uint8Array([0x10]) }
    expect(() => v.performOneOperation(lookup)).toThrow(RangeError)
    expect(() => v.performOneOperation(lookup)).toThrow(/indeterminate/)
    expect(() => v.digest()).toThrow(/indeterminate/)
  })
})

describe('BatchAVLVerifier — Rust byte-equality, step by step', () => {
  it('reproduces every corpus fixture', () => {
    const dir = resolve(FIXTURES, 'avltree')
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(50)
    for (const f of files) {
      const j = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'))
      const ops: Operation[] = j.operations.map(jsonToOp)
      const v = new BatchAVLVerifier(fromHex(j.startingDigestHex), fromHex(j.proofHex), j.config)
      let failed = v.digest() === null
      const results: (string | null)[] = []
      for (const op of ops) {
        if (failed) break
        const r = v.performOneOperation(op)
        if (!r.success) {
          failed = true
          break
        }
        results.push(r.value === null ? null : toHex(r.value))
      }
      if (j.expectedNewDigestHex === null) {
        expect(failed, f).toBe(true)
      } else {
        expect(failed, f).toBe(false)
        expect(results, f).toEqual(j.expectedResultsHex)
        expect(toHex(v.digest()!), f).toBe(j.expectedNewDigestHex)
      }
    }
  })

  it('reproduces the partial fixture: fails at its recorded index, with the pre-failure digest', () => {
    const j = JSON.parse(readFileSync(resolve(FIXTURES, 'partial/insert-fail-at-3-of-5.json'), 'utf-8'))
    const ops: Operation[] = j.operations.map(jsonToOp)
    const v = new BatchAVLVerifier(fromHex(j.starting_digest_hex), fromHex(j.proof_hex), j.config)
    let completed = 0
    let lastHealthy = v.digest()
    for (const op of ops) {
      if (!v.performOneOperation(op).success) break
      completed++
      lastHealthy = v.digest()
    }
    expect(completed).toBe(j.expected_ops_completed)
    expect(toHex(lastHealthy!)).toBe(j.expected_digest_after_2_ops_hex)
  })
})
