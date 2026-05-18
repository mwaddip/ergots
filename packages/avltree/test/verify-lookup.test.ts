import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyAvlLookup } from '../src/verify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, 'fixtures/avltree')

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('verifyAvlLookup — Lookup fixtures', () => {
  const fixtures = readdirSync(FIXTURES).filter((f) => f.startsWith('lookup-'))
  for (const fname of fixtures) {
    it(`returns expected value for ${fname}`, () => {
      const f = JSON.parse(readFileSync(resolve(FIXTURES, fname), 'utf-8'))
      // Lookup fixtures contain exactly one Lookup operation.
      expect(f.operations.length).toBe(1)
      expect(f.operations[0].tag).toBe('Lookup')
      const key = hexToBytes(f.operations[0].keyHex)
      const result = verifyAvlLookup(
        hexToBytes(f.startingDigestHex),
        hexToBytes(f.proofHex),
        f.config,  // camelCase JSON deserializes directly to AvlTreeConfig
        key,
      )
      // Match expected:
      const expected = f.expectedResultsHex[0]
      expect(result).not.toBeNull()
      if (expected === null) expect(result!.value).toBeNull()
      else expect(Array.from(result!.value!)).toEqual(Array.from(hexToBytes(expected)))
    })
  }
})
