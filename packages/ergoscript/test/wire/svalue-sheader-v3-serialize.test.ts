/**
 * SHeader SValue serialize — V3-gating + byte-exact round-trip tests.
 *
 * Phase 2h-c.1 Step 2. Validates that:
 *   - serializeSValue(SHeader, v, treeVersion=3, w) emits bytes byte-identical to
 *     the source fixture (parse → serialize round-trip equality).
 *   - serializeSValue(SHeader, v, treeVersion=2, w) throws SValueSerializeError with
 *     code 'sheader-tree-version-too-low'.
 *
 * Fixture: same header-v2-mainnet.bin used by the parse test.
 */
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue, SValueSerializeError } from '../../src/wire/serialize-svalue'
import type { SType } from '../../src/mir/types'

const SHEADER: SType = { tag: 'SHeader' }

const FIXTURE_PATH = join(
  import.meta.dirname ?? __dirname,
  '../fixtures/headers/header-v2-mainnet.bin'
)

function loadHeaderFixtureBytes(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE_PATH))
}

describe('serializeSValue SHeader V3 gating', () => {
  test('serializes SHeader at tree-version 3 byte-equal to source bytes', () => {
    const headerBytes = loadHeaderFixtureBytes()
    // Parse at V3 to get the Header SValue.
    const v = parseSValue(SHEADER, 3, new ByteReader(headerBytes))

    const w = new ByteWriter()
    serializeSValue(SHEADER, v, 3, w)
    expect(w.toBytes()).toEqual(headerBytes)
  })

  test('rejects SHeader at tree-version 2 with sheader-tree-version-too-low', () => {
    const headerBytes = loadHeaderFixtureBytes()
    // Parse at V3 to get a valid Header SValue; then attempt to serialize at V2.
    const v = parseSValue(SHEADER, 3, new ByteReader(headerBytes))

    const w = new ByteWriter()
    expect(() => serializeSValue(SHEADER, v, 2, w)).toThrow(
      expect.objectContaining({ code: 'sheader-tree-version-too-low' })
    )
  })

  test('throws type-value-mismatch when value kind is not Header', () => {
    const w = new ByteWriter()
    expect(() =>
      serializeSValue(SHEADER, { kind: 'Int', value: 42 }, 3, w)
    ).toThrow(
      expect.objectContaining({ code: 'type-value-mismatch' })
    )
    expect(() =>
      serializeSValue(SHEADER, { kind: 'Int', value: 42 }, 3, w)
    ).toThrow(SValueSerializeError)
  })
})
