/**
 * Mutation tests: for each non-adverse fixture, flip every byte of the proof
 * one at a time (XOR 0xff) and assert that the verifier either:
 *   (a) returns null — mutation killed (the expected outcome for most flips), OR
 *   (b) returns byte-identical result to the original — mutation landed in a
 *       tolerated no-op region (rare but legitimate).
 *
 * Target: ≥90% kill rate per fixture.
 *
 * Adverse fixtures are excluded because they already return null; running
 * byte-flips on a proof that is already invalid has no meaningful coverage
 * value (every flip would "kill" for trivial reasons).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('AVL+ mutation testing', () => {
  const fixtures = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !f.startsWith('adverse-'))
    // Also exclude any fixture whose expectedNewDigestHex is null — those are
    // precondition-fail fixtures (e.g. Remove/Update on absent key) whose
    // baseline verifyAvlBatch already returns null.  Mutation testing against
    // a baseline-null fixture is meaningless for the same reason as adverse
    // fixtures: every flip would trivially "kill", inflating kill-rate with no
    // coverage value.
    .filter((f) => {
      const data = JSON.parse(readFileSync(resolve(FIXTURES, f), 'utf-8'))
      return data.expectedNewDigestHex !== null
    })

  for (const fname of fixtures) {
    it(`≥90% byte-flip kill rate on ${fname}`, () => {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      const startingDigest = hexToBytes(f.startingDigestHex)
      const config: AvlTreeConfig = f.config
      const operations: Operation[] = f.operations.map(jsonToOp)
      const proof = hexToBytes(f.proofHex)

      // Capture expected result from the valid proof.
      const expected = verifyAvlBatch(startingDigest, proof, config, operations)
      if (expected === null) {
        throw new Error(
          `${fname}: should not be in mutation test — baseline verifyAvlBatch returned null (is this an adverse fixture?)`,
        )
      }

      let killed = 0
      let survived = 0

      for (let i = 0; i < proof.length; i++) {
        const origByte = proof[i] as number
        const mutated = proof.slice() // copy
        mutated[i] = origByte ^ 0xff // flip all 8 bits of byte i
        const mutatedByte = mutated[i] as number

        const result = verifyAvlBatch(startingDigest, mutated, config, operations)
        if (result === null) {
          killed++
        } else {
          // The verifier accepted the mutated proof.
          // Two sub-cases:
          //   (a) Byte-identical result to expected — tolerated no-op region, survives.
          //   (b) Different result — CRITICAL: verifier accepted a mutated proof producing
          //       a different digest/results. This is a security bug.
          const digestMatch = uint8ArrayEquals(result.newDigest, expected.newDigest)
          const resultsMatch =
            result.results.length === expected.results.length &&
            result.results.every((r, j) => {
              const exp = expected.results[j] as Uint8Array | null | undefined
              if (r === null && (exp === null || exp === undefined)) return true
              if (r !== null && exp != null) return uint8ArrayEquals(r, exp)
              return false
            })

          if (digestMatch && resultsMatch) {
            survived++
          } else {
            // CRITICAL: mutation produced a non-null result differing from expected.
            throw new Error(
              `${fname}: mutation at byte ${i} (0x${origByte.toString(16).padStart(2, '0')} → 0x${mutatedByte.toString(16).padStart(2, '0')}) produced a non-rejection result that DIFFERS from expected.\n` +
                `  Original newDigest: ${Array.from(expected.newDigest).map((b) => b.toString(16).padStart(2, '0')).join('')}\n` +
                `  Mutated  newDigest: ${Array.from(result.newDigest).map((b) => b.toString(16).padStart(2, '0')).join('')}\n` +
                `This indicates the verifier is accepting a malicious proof — a CRITICAL security bug.`,
            )
          }
        }
      }

      const total = killed + survived
      expect(total).toBe(proof.length)
      const killRate = killed / proof.length
      expect(killRate).toBeGreaterThanOrEqual(0.9)
    })
  }
})
