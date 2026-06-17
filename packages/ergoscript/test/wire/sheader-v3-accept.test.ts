/**
 * SANTA ErgoTree.sheader_constant_v3_accept (jvm:sigma-state-6.0.3) — a size-flagged v3 ErgoTree
 * (header 0x1b = v3 + size + const-seg) with one segregated SHeader constant (typeCode 0x68). The
 * JVM's data-layer DataSerializer is version-gated on isV3OrLaterErgoTreeVersion, so at treeVersion
 * >= 3 it PARSES the SHeader constant (as a CHeader) and round-trips byte-identical — where the v2
 * form (header 0x1a) rejects. ergots must ACCEPT + round-trip, matching the JVM's version gate.
 *
 * The POSITIVE twin of the v2 reject vectors (ErgoTree.unparsed_soft_fork_header_constant /
 * Box.softfork_header_constant_reject). Regression guard pinning ergots ≡ JVM on the v3
 * SHeader-constant accept — a consensus version boundary. Confirms ergots is NOT over-rejecting a
 * valid v6.0 SHeader constant (refuting an earlier mis-flag that the JVM rejects SHeader at every
 * version; the JVM is version-gated — see docs/specs/2026-06-17-ergotree-deserialize-unification.md).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'

const VECTOR = join(
  __dirname,
  '../fixtures/conformance/wire/ErgoTree.sheader_constant_v3_accept.json',
)
const entry = JSON.parse(readFileSync(VECTOR, 'utf8')).entries[0]

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

describe('ErgoTree.sheader_constant_v3_accept (JVM-blessed: accept + identity round-trip)', () => {
  it('is the v3 accept shape we expect', () => {
    expect(entry.version.ergoTree).toBe(3)
    expect(entry.bytes_hex.slice(0, 2)).toBe('1b') // v3 + hasSize + const-seg
  })

  it('treeVersion 3 SHeader constant ACCEPTS and round-trips byte-identical (matches the JVM v3 gate)', () => {
    const bytes = hexToBytes(entry.bytes_hex)
    const tree = parseTree(bytes) // must NOT throw — v3 gate accepts the SHeader constant
    expect(bytesToHex(serializeTree(tree))).toBe(entry.bytes_hex) // identity round-trip
  })
})
