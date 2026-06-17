/**
 * Transaction-tier twin of the ergoscript box-reject guard: the ErgoBoxCandidate
 * codec shares `parseErgoTreeBytes`, so an SHeader-constant propBytes box must reject
 * here too (it throws at the propBytes tree, before reading txId/index). Vector is the
 * JVM-blessed SANTA Box.softfork_header_constant_reject.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader } from '@ergots/scorex'
import { parseBoxCandidate } from '../src/wire/box-candidate'

const VECTOR = join(
  __dirname,
  '../../ergoscript/test/fixtures/conformance/wire/Box.softfork_header_constant_reject.json',
)
const entry = JSON.parse(readFileSync(VECTOR, 'utf8')).entries[0]
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('transaction box codec rejects SHeader-constant propBytes', () => {
  it('rejects the SANTA box (shared parseErgoTreeBytes)', () => {
    // parseBoxCandidate requires a tokenTable (Uint8Array[]) as the second arg.
    // The parse throws inside parseErgoTreeBytes — before it ever reaches the
    // token section — so an empty table is correct here.
    const r = new ByteReader(hexToBytes(entry.bytes_hex))
    expect(() => parseBoxCandidate(r, [])).toThrow()
  })
})
