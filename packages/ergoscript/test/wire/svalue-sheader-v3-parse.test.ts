/**
 * SHeader SValue parse — V3-gating tests.
 *
 * Phase 2h-c.1 Step 2. Validates that:
 *   - parseSValue(SHeader, treeVersion=3, r) delegates to @ergots/scorex parseHeader
 *     and returns a { kind: 'Header', value: Header } with a valid 32-byte id.
 *   - parseSValue(SHeader, treeVersion=2, r) throws SValueParseError with code
 *     'sheader-tree-version-too-low' (mirrors sigma-rust data.rs:196 V3 gate).
 *
 * Fixture: header-v2-mainnet.bin — the `synthetic-h1` entry in
 * `packages/nipopow/test/fixtures/header.json` (`bytes_hex` field), converted
 * to binary (215 bytes). parseHeader can parse it regardless of treeVersion
 * (the treeVersion gate is on the SValue wrapper, not parseHeader itself).
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import type { SType } from '../../src/mir/types'

const SHEADER: SType = { tag: 'SHeader' }

// Fixture path relative to the ergoscript package root.
const FIXTURE_PATH = join(
  import.meta.dirname ?? __dirname,
  '../fixtures/headers/header-v2-mainnet.bin'
)

function loadHeaderFixtureBytes(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE_PATH))
}

describe('parseSValue SHeader V3 gating', () => {
  test('parses SHeader at tree-version 3', () => {
    const headerBytes = loadHeaderFixtureBytes()
    const r = new ByteReader(headerBytes)

    const v = parseSValue(SHEADER, 3, r)

    expect(v.kind).toBe('Header')
    if (v.kind !== 'Header') throw new Error('unreachable')
    expect(v.value.id).toBeInstanceOf(Uint8Array)
    expect(v.value.id.length).toBe(32)
    // All fixture bytes consumed — no trailing data.
    expect(r.isExhausted).toBe(true)
  })

  test('rejects SHeader at tree-version 2 with sheader-tree-version-too-low', () => {
    const headerBytes = loadHeaderFixtureBytes()
    const r = new ByteReader(headerBytes)

    expect(() => parseSValue(SHEADER, 2, r)).toThrow(
      expect.objectContaining({ code: 'sheader-tree-version-too-low' })
    )
  })

  test('rejects SHeader at tree-version 0 with sheader-tree-version-too-low', () => {
    const headerBytes = loadHeaderFixtureBytes()
    const r = new ByteReader(headerBytes)

    expect(() => parseSValue(SHEADER, 0, r)).toThrow(
      expect.objectContaining({ code: 'sheader-tree-version-too-low' })
    )
  })
})
