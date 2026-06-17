/**
 * SANTA wire-tier conformance — ErgoTree unparsed soft-fork body round-trip.
 *
 * Vendored JVM-blessed vector (jvm:sigma-state-6.0.3) at
 * test/fixtures/conformance/wire/ErgoTree.unparsed_soft_fork_roundtrip.json.
 * Each entry is a size-flagged ErgoTree (header 0x0b = v3 + size bit) whose
 * body is the unknown/reserved opcode 0xfd. The JVM (and sigma-rust) wrap such
 * a tree as Unparsed and re-serialize byte-IDENTICAL (the declared-size body is
 * preserved verbatim) — an IDENTITY round-trip (no `expected_bytes_hex`).
 *
 * ergots previously eager-parsed the hasSize body, hit reserved 0xfd, and threw
 * `ExprParseError('opcode-reserved')`. The fix mirrors both references: a
 * hasSize body that fails to parse is preserved as an UnparsedErgoTree and
 * re-serialized verbatim. See docs/specs/2026-06-17-ergotree-unparsed-soft-fork-preservation.md.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { evaluate } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'
import { ExprParseError } from '../../src/wire/errors'
import { isUnparsedTree } from '../../src/mir/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface WireEntry {
  name: string
  bytes_hex: string
}
const vector = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../fixtures/conformance/wire/ErgoTree.unparsed_soft_fork_roundtrip.json'),
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
  it('vendored vector has the expected 2 entries', () => {
    expect(vector.entries.length).toBe(2)
  })

  for (const e of vector.entries) {
    it(`${e.name}: serializeTree(parseTree(input)) === input (byte-identical)`, () => {
      const tree = parseTree(hexToBytes(e.bytes_hex))
      expect(bytesToHex(serializeTree(tree))).toBe(e.bytes_hex)
    })
  }
})

describe('ErgoTree unparsed soft-fork — eval rejects + hasSize gating', () => {
  it('parses to the unparsed arm and evaluating it rejects with unparsed-ergotree', () => {
    const tree = parseTree(hexToBytes('0b01fd'))
    expect(isUnparsedTree(tree)).toBe(true)
    // Permanently unevaluable: both references reject the spend at reduction.
    let err: unknown
    try {
      evaluate(tree)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EvalError)
    expect((err as EvalError).code).toBe('unparsed-ergotree')
  })

  it('the soft-fork tolerance is hasSize-ONLY: a non-sized reserved-opcode tree still rejects', () => {
    // header 0x00 (v0, NO size bit) + reserved opcode 0xfd body. Without the size
    // prefix a reader cannot skip the body, so both references — and ergots — reject
    // rather than preserve. The catch in parseTreeFromReader is gated on hasSize.
    expect(() => parseTree(hexToBytes('00fd'))).toThrow(ExprParseError)
  })
})
