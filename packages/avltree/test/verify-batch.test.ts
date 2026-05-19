import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { verifyAvlBatch } from '../src/verify.js'
import { parseProofPackedTree } from '../src/proof-decode.js'
import { AvlVerifyError } from '../src/errors.js'
import type { Operation } from '../src/operation.js'
import type { AvlTreeConfig } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/avltree')

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

function jsonToOp(o: any): Operation {
  switch (o.tag) {
    case 'Lookup':
    case 'UnknownModification':
    case 'Remove':
    case 'RemoveIfExists':
      return { tag: o.tag, key: hexToBytes(o.keyHex) }
    case 'Insert':
    case 'Update':
    case 'InsertOrUpdate':
      return { tag: o.tag, key: hexToBytes(o.keyHex), value: hexToBytes(o.valueHex) }
    case 'UpdateLongBy':
      return { tag: o.tag, key: hexToBytes(o.keyHex), delta: BigInt(o.delta) }
    default:
      throw new Error(`Unknown op tag: ${o.tag}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AVL-01 regression — truncated direction bits must fail, not silently verify
//
// Audit found that `nextDirectionIsLeft` and `replayComparison` defaulted
// out-of-bounds proof reads to 0 (the byte being read returns `undefined` →
// `undefined & mask` is 0). With direction bytes removed, operations descend
// as if every step is "right" (bit unset), producing a digest that the
// verifier accepts. Post-fix the verifier emits `directions-exhausted` (in
// `lastFailReason`) and the public `verifyAvlBatch` returns null.
// ─────────────────────────────────────────────────────────────────────────────
describe('AVL-01: truncated direction bits are rejected', () => {
  const AUDIT_REPRO_FIXTURES = [
    'balanced-1000leaves.json',
    'batch-256ops-inserts.json',
    'batch-2ops-insert-then-lookup.json',
  ]

  for (const fname of AUDIT_REPRO_FIXTURES) {
    it(`rejects ${fname} when truncated at directionsStart`, () => {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      // Original fixture must verify on the un-truncated proof.
      if (f.expectedNewDigestHex === null) {
        throw new Error(`AVL-01 fixture must be a success fixture (got rejection): ${fname}`)
      }
      const startingDigest = hexToBytes(f.startingDigestHex)
      const fullProof = hexToBytes(f.proofHex)
      const config: AvlTreeConfig = f.config
      const operations = f.operations.map(jsonToOp)

      // Locate where direction bytes begin and truncate to that offset (0 direction bytes available).
      const tree = parseProofPackedTree(fullProof, config, startingDigest)
      expect(tree.ok).toBe(true)
      const dirStart = tree.ok ? tree.directionsStart : 0
      const truncated = fullProof.slice(0, dirStart)

      const result = verifyAvlBatch(startingDigest, truncated, config, operations)
      expect(result).toBeNull()
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// AVL-03 / AVL-04 / AVL-05 regressions — verifyAvlBatch programmer-error
// gates. Each invalid input throws AvlVerifyError (not return null).
// ─────────────────────────────────────────────────────────────────────────────
describe('AVL-03/04/05: config + operation shape validation', () => {
  const startingDigest = new Uint8Array(33)
  const proof = new Uint8Array(0)
  const validConfig: AvlTreeConfig = { keyLength: 1, valueLengthOpt: null }

  // AVL-03: UpdateLongBy.delta outside signed i64
  it('AVL-03: rejects UpdateLongBy with delta > i64::MAX', () => {
    const ops: Operation[] = [{ tag: 'UpdateLongBy', key: new Uint8Array(1), delta: 1n << 63n }]
    try {
      verifyAvlBatch(startingDigest, proof, validConfig, ops)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AvlVerifyError)
      expect((e as AvlVerifyError).code).toBe('operation-delta-out-of-range')
    }
  })

  it('AVL-03: rejects UpdateLongBy with delta < i64::MIN', () => {
    const ops: Operation[] = [{ tag: 'UpdateLongBy', key: new Uint8Array(1), delta: -(1n << 63n) - 1n }]
    try {
      verifyAvlBatch(startingDigest, proof, validConfig, ops)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AvlVerifyError)
      expect((e as AvlVerifyError).code).toBe('operation-delta-out-of-range')
    }
  })

  // AVL-04: maxNumOperations / maxDeletes safe-integer requirement
  it.each([NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'AVL-04: rejects config.maxNumOperations = %s',
    (badValue) => {
      const cfg: AvlTreeConfig = { keyLength: 1, valueLengthOpt: null, maxNumOperations: badValue }
      try {
        verifyAvlBatch(startingDigest, proof, cfg, [])
        throw new Error('expected throw')
      } catch (e) {
        expect(e).toBeInstanceOf(AvlVerifyError)
        expect((e as AvlVerifyError).code).toBe('invalid-config-max-ops')
      }
    },
  )

  // AVL-05: valueLengthOpt is required (must be number or null, NOT undefined)
  it('AVL-05: rejects config with valueLengthOpt = undefined', () => {
    const cfg = { keyLength: 1 } as unknown as AvlTreeConfig
    try {
      verifyAvlBatch(startingDigest, proof, cfg, [])
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(AvlVerifyError)
      expect((e as AvlVerifyError).code).toBe('invalid-config-value-length')
    }
  })
})

describe('verifyAvlBatch — per-fixture corpus', () => {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
  for (const fname of fixtures) {
    it(`matches Rust verifier output: ${fname}`, () => {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      const startingDigest = hexToBytes(f.startingDigestHex)
      const proof = hexToBytes(f.proofHex)
      const config: AvlTreeConfig = f.config
      const operations = f.operations.map(jsonToOp)
      const result = verifyAvlBatch(startingDigest, proof, config, operations)
      // Rejection fixtures have expectedNewDigestHex: null
      if (f.expectedNewDigestHex === null) {
        expect(result).toBeNull()
        return
      }
      expect(result).not.toBeNull()
      expect(Array.from(result!.newDigest)).toEqual(Array.from(hexToBytes(f.expectedNewDigestHex)))
      const expectedResults = f.expectedResultsHex.map((h: string | null) =>
        h === null ? null : hexToBytes(h),
      )
      expect(result!.results.length).toBe(expectedResults.length)
      for (let i = 0; i < result!.results.length; i++) {
        const got = result!.results[i]
        const expected = expectedResults[i]
        if (expected === null) expect(got).toBeNull()
        else expect(Array.from(got!)).toEqual(Array.from(expected))
      }
    })
  }
})
