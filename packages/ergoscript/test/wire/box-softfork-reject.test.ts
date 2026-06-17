/**
 * SANTA Box.softfork_header_constant_reject (jvm:sigma-state-6.0.3) — a box whose
 * propositionBytes are a size-flagged ErgoTree with one segregated SHeader constant
 * (typeCode 0x68, treeVersion 2). The JVM REJECTS the box (the SHeader DataSerializer
 * throws a non-soft-forkable SerializerException that escapes the UnparsedErgoTree
 * fallback). ergots must reject it via the box→tree (boxId) path, matching the bare
 * `parseTree` reject. Regression guard for the deserialize-unification fix.
 * Spec: docs/specs/2026-06-17-ergotree-deserialize-unification.md
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader } from '@ergots/scorex'
import { parseSValue, SValueParseError } from '../../src/wire/parse-svalue'
import { parseErgoTreeBytes } from '../../src/wire/ergo-tree'

const VECTOR = join(
  __dirname,
  '../fixtures/conformance/wire/Box.softfork_header_constant_reject.json',
)
const vec = JSON.parse(readFileSync(VECTOR, 'utf8'))
const entry = vec.entries[0]
const TREE_VERSION: number = entry.version.ergoTree

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('Box.softfork_header_constant_reject (JVM-blessed: errored)', () => {
  it('the vector is the reject shape we expect', () => {
    expect(entry.error).toBe('errored')
    expect(TREE_VERSION).toBe(2)
  })

  it('parseSValue(SBox) REJECTS the box (consensus boxId path)', () => {
    const r = new ByteReader(hexToBytes(entry.bytes_hex))
    expect(() => parseSValue({ tag: 'SBox' }, TREE_VERSION, r)).toThrow(SValueParseError)
  })

  it('the embedded propBytes reject identically bare (parseErgoTreeBytes)', () => {
    const boxBytes = hexToBytes(entry.bytes_hex)
    const r = new ByteReader(boxBytes)
    r.readVlqBigInt() // skip the box value VLQ (c0843d) so the cursor is at the tree
    expect(() => parseErgoTreeBytes(r)).toThrow(SValueParseError)
  })
})
