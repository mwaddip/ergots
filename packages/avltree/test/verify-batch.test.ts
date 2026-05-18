import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { verifyAvlBatch } from '../src/verify.js'
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
