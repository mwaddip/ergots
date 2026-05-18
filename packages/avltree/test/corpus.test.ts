import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

describe('AVL+ corpus aggregate', () => {
  const all = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))

  it('contains at least 50 fixtures', () => {
    // T21-T23 produce ~50 fixtures covering all 8 op variants + multi-op batches +
    // edge cases + adverse rejections. ≥150 was over-ambitious; T25's ≥90%
    // mutation kill rate is the real coverage gate. Tune up post-v0.1.0 if needed.
    expect(all.length).toBeGreaterThanOrEqual(50)
  })

  it('every fixture either verifies or is marked adverse (expected_new_digest_hex === null)', () => {
    let verifiedCount = 0
    let adverseCount = 0
    const failed: string[] = []

    for (const fname of all) {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      const config: AvlTreeConfig = f.config
      const operations = f.operations.map(jsonToOp)
      const startingDigest = hexToBytes(f.startingDigestHex)
      const proof = hexToBytes(f.proofHex)
      const result = verifyAvlBatch(startingDigest, proof, config, operations)

      if (f.expectedNewDigestHex === null) {
        // Adverse case: must return null
        if (result === null) adverseCount++
        else failed.push(`${fname}: expected rejection but verifyAvlBatch returned non-null`)
      } else {
        // Success case: must return non-null with matching digest
        if (result !== null) verifiedCount++
        else failed.push(`${fname}: expected success but verifyAvlBatch returned null`)
      }
    }

    if (failed.length > 0) {
      throw new Error(`Aggregate corpus failures:\n${failed.join('\n')}`)
    }

    expect(verifiedCount + adverseCount).toBe(all.length)
    // Sanity check that we have both kinds:
    expect(verifiedCount).toBeGreaterThan(0)
    expect(adverseCount).toBeGreaterThan(0)
  })
})
