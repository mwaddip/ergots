import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseProofPackedTree } from '../src/proof-decode.js'
import type { AvlTreeConfig } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadFixture(name: string): any {
  const path = resolve(__dirname, `fixtures/avltree/${name}.json`)
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('parseProofPackedTree — single-leaf-insert', () => {
  it('reconstructs a tree that labels to startingDigest', () => {
    const f = loadFixture('single-leaf-insert')
    const startingDigest = hexToBytes(f.startingDigestHex)
    const proof = hexToBytes(f.proofHex)
    const config: AvlTreeConfig = {
      keyLength: f.config.keyLength,
      valueLengthOpt: f.config.valueLengthOpt,
      maxNumOperations: f.config.maxNumOperations,
      maxDeletes: f.config.maxDeletes,
    }
    const result = parseProofPackedTree(proof, config, startingDigest)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.height).toBe(0)
      // directionsStart should point to the byte immediately after END_OF_TREE.
      // Proof: 1 (LEAF) + 32 (key) + 32 (nextLeafKey) + 4 (BE u32 value length) + 1 (END) = 70 bytes.
      expect(result.directionsStart).toBe(70)
      expect(result.root.kind).toBe('leaf')
    }
  })

  it('rejects truncated proof', () => {
    const f = loadFixture('single-leaf-insert')
    const truncated = hexToBytes(f.proofHex).slice(0, 5)
    const startingDigest = hexToBytes(f.startingDigestHex)
    const result = parseProofPackedTree(truncated, {
      keyLength: f.config.keyLength,
      valueLengthOpt: f.config.valueLengthOpt,
    }, startingDigest)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(['proof-truncated', 'proof-malformed']).toContain(result.reason)
  })
})
