/**
 * Task 30: Full-corpus integration test.
 *
 * Walks every fixture file under `packages/ergoscript/test/fixtures/` and
 * asserts byte-for-byte round-trip for the wire codecs. Each fixture file
 * defines a different layer:
 *
 *   - `synthetic_stype.json`  → SType parse + serialize
 *   - `synthetic_svalue.json` → SValue parse + serialize (typed; needs SType)
 *   - `synthetic_expr.json`   → body-only Expr parse + serialize (no ErgoTree
 *                               envelope; per Task 28's gotcha #6 these emit
 *                               raw Expr bytes, NOT full ErgoTree bytes)
 *   - `corpus_legacy_45.json`,
 *     `corpus_ecosystem_14.json`,
 *     `corpus_significant_15.json` → full ErgoTree parse + serialize
 *   - `mainnet_boxes.json`    → deferred (stub; gracefully skipped)
 *
 * Entries flagged `"known_unstable": true` are skipped (acknowledged
 * upstream / compile-order instability — tracked separately).
 *
 * This is the final correctness gate before Tasks 31-33. Any wire-format
 * regression in Tasks 1-29 should surface here.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SType, SValue, ErgoTree } from '../src/mir/types'
import { parseTree, serializeTree } from '../src/wire/ergo-tree'
import { parseExpr } from '../src/wire/parse'
import { serializeExpr } from '../src/wire/serialize'
import { parseSType } from '../src/wire/parse-stype'
import { serializeSType } from '../src/wire/serialize-stype'
import { parseSValue } from '../src/wire/parse-svalue'
import { serializeSValue } from '../src/wire/serialize-svalue'
import { ByteReader } from '../src/wire/reader'
import { ByteWriter } from '../src/wire/writer'

// In ESM, __dirname is not defined; derive it from import.meta.url. node:url
// is a node-only import, allowed in test files per the browser-first rule.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_DIR = path.join(__dirname, 'fixtures')

// --- helpers ---------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0) return new Uint8Array(0)
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input (${hex.length})`)
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: bad hex at offset ${i * 2}`)
    }
    out[i] = byte
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i]! < 0x10 ? '0' : '') + bytes[i]!.toString(16)
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Hydrate a JSON-stringified SValue into a runtime SValue. The fixture
 * JSON encodes:
 *   - Long, BigInt as decimal strings (JSON has no bigint literal).
 *   - GroupElement, SigmaProp payloads as hex strings.
 *   - Coll, Tuple, Option recursively as nested SValue JSON.
 *
 * Other variants (Boolean, Byte, Short, Int, Unit) map field-for-field.
 */
function hydrateSValue(json: any): SValue {
  switch (json.kind) {
    case 'Boolean':
      return { kind: 'Boolean', value: json.value }
    case 'Byte':
      return { kind: 'Byte', value: json.value }
    case 'Short':
      return { kind: 'Short', value: json.value }
    case 'Int':
      return { kind: 'Int', value: json.value }
    case 'Long':
      return { kind: 'Long', value: BigInt(json.value) }
    case 'BigInt':
      return { kind: 'BigInt', value: BigInt(json.value) }
    case 'GroupElement':
      return { kind: 'GroupElement', value: hexToBytes(json.bytes_hex) }
    case 'SigmaProp':
      return { kind: 'SigmaProp', value: { raw: hexToBytes(json.raw_hex) } }
    case 'Unit':
      return { kind: 'Unit' }
    case 'Coll':
      return {
        kind: 'Coll',
        elem: json.elem as SType,
        items: (json.items as any[]).map(hydrateSValue),
      }
    case 'Tuple':
      return {
        kind: 'Tuple',
        items: (json.items as any[]).map(hydrateSValue),
      }
    case 'Option':
      return {
        kind: 'Option',
        elem: json.elem as SType,
        value: json.value === null ? null : hydrateSValue(json.value),
      }
    default:
      throw new Error(`hydrateSValue: unknown kind ${json.kind}`)
  }
}

function loadFixture<T>(filename: string): T {
  const p = path.join(FIXTURE_DIR, filename)
  const raw = fs.readFileSync(p, 'utf8')
  return JSON.parse(raw) as T
}

// --- test bodies -----------------------------------------------------------

interface SyntheticSTypeEntry {
  name: string
  tpe: SType
  bytes_hex: string
}

interface SyntheticSValueEntry {
  name: string
  tpe: SType
  value: any
  bytes_hex: string
}

interface SyntheticExprEntry {
  name: string
  description?: string
  expr_hex: string
}

interface CorpusTreeEntry {
  name: string
  source_es?: string
  tree_bytes_hex: string
  byte_length?: number
  known_unstable?: boolean
}

interface CorpusFile<E> {
  corpus?: string
  entries: E[]
  non_deterministic?: E[]
  deferred?: boolean
}

describe('Corpus round-trip — synthetic SType', () => {
  const fixture = loadFixture<{ entries: SyntheticSTypeEntry[] }>(
    'synthetic_stype.json'
  )
  expect(fixture.entries.length).toBeGreaterThan(0)

  for (const entry of fixture.entries) {
    it(`SType: ${entry.name}`, () => {
      const bytes = hexToBytes(entry.bytes_hex)

      // Parse: bytes → SType
      const reader = new ByteReader(bytes)
      const parsed = parseSType(reader)
      expect(reader.remaining, `${entry.name}: parser left ${reader.remaining} byte(s) unread`).toBe(0)
      expect(parsed).toEqual(entry.tpe)

      // Serialize: SType → bytes (round-trip)
      const writer = new ByteWriter()
      serializeSType(parsed, writer)
      const serialized = writer.toBytes()
      expect(
        bytesEqual(serialized, bytes),
        `${entry.name}: re-serialized bytes ${bytesToHex(serialized)} !== fixture ${entry.bytes_hex}`
      ).toBe(true)
    })
  }
})

describe('Corpus round-trip — synthetic SValue', () => {
  const fixture = loadFixture<{ entries: SyntheticSValueEntry[] }>(
    'synthetic_svalue.json'
  )
  expect(fixture.entries.length).toBeGreaterThan(0)

  for (const entry of fixture.entries) {
    it(`SValue: ${entry.name}`, () => {
      const bytes = hexToBytes(entry.bytes_hex)
      const expected = hydrateSValue(entry.value)

      // Parse: bytes → SValue (type-driven)
      const reader = new ByteReader(bytes)
      const parsed = parseSValue(entry.tpe, reader)
      expect(reader.remaining, `${entry.name}: parser left ${reader.remaining} byte(s) unread`).toBe(0)
      expect(parsed).toEqual(expected)

      // Serialize: SValue → bytes (round-trip)
      const writer = new ByteWriter()
      serializeSValue(entry.tpe, parsed, writer)
      const serialized = writer.toBytes()
      expect(
        bytesEqual(serialized, bytes),
        `${entry.name}: re-serialized bytes ${bytesToHex(serialized)} !== fixture ${entry.bytes_hex}`
      ).toBe(true)
    })
  }
})

describe('Corpus round-trip — synthetic Expr (body-only)', () => {
  // Per Task 28's gotcha #6, synthetic_expr emits raw Expr body bytes
  // (no ErgoTree envelope, no constant segregation), so we drive parseExpr
  // directly with empty segregated-constant arrays.
  const fixture = loadFixture<{ entries: SyntheticExprEntry[] }>(
    'synthetic_expr.json'
  )
  expect(fixture.entries.length).toBeGreaterThan(0)

  for (const entry of fixture.entries) {
    it(`Expr: ${entry.name}`, () => {
      const bytes = hexToBytes(entry.expr_hex)

      // Parse: bytes → Expr (no segregated constants)
      const reader = new ByteReader(bytes)
      const parsed = parseExpr(reader, [], [])
      expect(reader.remaining, `${entry.name}: parser left ${reader.remaining} byte(s) unread`).toBe(0)

      // Serialize: Expr → bytes (round-trip)
      const writer = new ByteWriter()
      serializeExpr(parsed, writer)
      const serialized = writer.toBytes()
      expect(
        bytesEqual(serialized, bytes),
        `${entry.name}: re-serialized bytes ${bytesToHex(serialized)} !== fixture ${entry.expr_hex}`
      ).toBe(true)
    })
  }
})

function runCorpusFile(filename: string): void {
  describe(`Corpus round-trip — ${filename}`, () => {
    const fixture = loadFixture<CorpusFile<CorpusTreeEntry>>(filename)
    const stableEntries = fixture.entries.filter((e) => !e.known_unstable)
    const skippedCount = fixture.entries.length - stableEntries.length

    if (fixture.entries.length === 0) {
      it.skip(`${filename}: stub (no entries) — deferred`, () => {})
      return
    }

    if (skippedCount > 0) {
      it(`${filename}: skipped ${skippedCount} known-unstable entries`, () => {
        // Diagnostic-only: don't fail when entries are gated.
        expect(skippedCount).toBeGreaterThan(0)
      })
    }

    for (const entry of stableEntries) {
      it(`tree: ${entry.name}`, () => {
        const bytes = hexToBytes(entry.tree_bytes_hex)

        // Optional: assert announced byte_length matches the raw bytes.
        if (typeof entry.byte_length === 'number') {
          expect(bytes.length, `${entry.name}: byte_length mismatch`).toBe(
            entry.byte_length
          )
        }

        // Parse: bytes → ErgoTree (envelope + body)
        const parsed: ErgoTree = parseTree(bytes)
        expect(parsed.body).toBeDefined()

        // Serialize: ErgoTree → bytes (round-trip)
        const serialized = serializeTree(parsed)
        expect(
          bytesEqual(serialized, bytes),
          `${entry.name}: re-serialized bytes (${serialized.length}B) ` +
            `!== fixture (${bytes.length}B); ` +
            `re-serialized=${bytesToHex(serialized)} fixture=${entry.tree_bytes_hex}`
        ).toBe(true)
      })
    }
  })
}

runCorpusFile('corpus_legacy_45.json')
runCorpusFile('corpus_ecosystem_14.json')
runCorpusFile('corpus_significant_15.json')

interface MainnetBoxEntry {
  box_id: string
  ergo_tree_hex: string
  byte_length?: number
  block_height?: number
  round_trip_ok?: boolean
}

describe('Corpus round-trip — mainnet_boxes', () => {
  const fixture = loadFixture<CorpusFile<MainnetBoxEntry>>('mainnet_boxes.json')

  if (fixture.entries.length === 0) {
    it.skip('mainnet_boxes is a stub; no entries to exercise yet', () => {})
    return
  }

  for (const entry of fixture.entries) {
    it(`box ${entry.box_id} @ height ${entry.block_height ?? '?'}`, () => {
      const bytes = hexToBytes(entry.ergo_tree_hex)
      const parsed = parseTree(bytes)
      const serialized = serializeTree(parsed)
      expect(bytesEqual(serialized, bytes)).toBe(true)
    })
  }
})
