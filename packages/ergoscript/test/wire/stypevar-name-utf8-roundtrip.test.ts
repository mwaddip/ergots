/**
 * SANTA wire-tier conformance — STypeVar name UTF-8 byte-exact round-trip.
 *
 * Vendored JVM-blessed vector (jvm:sigma-state-6.0.3) at
 * test/fixtures/conformance/wire/STypeVar.name_utf8_roundtrip.json. Each entry
 * is a full ErgoTree carrying a type-var name with ill-formed UTF-8 bytes; the
 * `expected_bytes_hex` is the JVM's structural re-serialization (a NON-identity
 * round-trip — the name re-encodes to canonical U+FFFD bytes).
 *
 * parseTree lossy-decodes the name (decodeUtf8Lossy, JVM `new String(_, UTF_8)`
 * counts) and serializeTree re-encodes it from structure, so the round-trip must
 * equal the JVM canonical for all 5 — including `ed a0 80`, the surrogate case
 * where the JVM collapses to ONE U+FFFD and Rust `from_utf8_lossy` gives three.
 * See SANTA finding wire-stypevar-utf8-byte-exactness.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface WireEntry {
  name: string
  bytes_hex: string
  expected_bytes_hex: string
}
const vector = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../fixtures/conformance/wire/STypeVar.name_utf8_roundtrip.json'),
    'utf8',
  ),
) as { op: string; blessed_by: string; entries: WireEntry[] }

const hexToBytes = (h: string): Uint8Array => {
  const a = new Uint8Array(h.length / 2)
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return a
}
const bytesToHex = (u: Uint8Array): string => {
  let h = ''
  for (const x of u) h += x.toString(16).padStart(2, '0')
  return h
}

describe(`SANTA wire conformance — ${vector.op} (${vector.blessed_by})`, () => {
  it('vendored vector has the expected 5 entries', () => {
    expect(vector.entries.length).toBe(5)
  })

  for (const e of vector.entries) {
    it(`${e.name}: serializeTree(parseTree(input)) === JVM canonical`, () => {
      const tree = parseTree(hexToBytes(e.bytes_hex))
      expect(bytesToHex(serializeTree(tree))).toBe(e.expected_bytes_hex)
    })
  }
})
