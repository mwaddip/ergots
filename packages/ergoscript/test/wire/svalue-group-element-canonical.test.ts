/**
 * SGroupElement SValue parse — GE canonical-bytes invariant (F5 batch 4, member D part 1).
 *
 * JVM verdict (GroupElementSerializer.scala:35-42, `parse`):
 *   - lead byte != 0 → `CryptoContext.decodePoint` curve-validates; bad prefix
 *     or x-not-on-curve THROWS.
 *   - lead byte == 0 → identity POINT; bytes 1..32 are discarded (never inspected).
 *   - serialize (:20-33) always emits canonical bytes: identity = 33 zeros,
 *     valid point = 02/03 prefix + big-endian X.
 *
 * ergots mirrors by validating + normalizing at the SValue GE data-parse arm:
 *   - 0x00-lead → NORMALIZE to the canonical 33-zero identity.
 *   - non-0x00-lead → must curve-decode or throw
 *     SValueParseError('group-element-invalid-point').
 *   - valid 02/03 points keep their input bytes verbatim (already canonical —
 *     pinned by the decodePoint→encodePoint identity test below).
 *
 * Contract: facts/ergoscript-eval.md "GE canonical-bytes invariant" (Type
 * invariants); facts/ergoscript-wire.md F5 batch 4 wire section + Round-trip
 * Carve-out 3 (garbage-tail identity encodings do not byte-round-trip — same
 * as the JVM value layer).
 */
import { describe, expect, test } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { decodePoint, encodePoint } from '../../src/crypto/secp256k1'
import { hexToBytes } from '../_helpers'
import type { SType } from '../../src/mir/types'

const SGROUP: SType = { tag: 'SGroupElement' }

// secp256k1 generator G, SEC1 compressed (02-lead, valid point).
const GENERATOR_HEX = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
// 0x00-lead with garbage tail: JVM parses to the identity POINT, tail discarded.
const GARBAGE_IDENTITY = '00' + 'aa'.repeat(32)
// Canonical identity encoding (what the JVM serializer emits for infinity).
const CANONICAL_IDENTITY = '00'.repeat(33)
// x = 2^256 - 1 > field prime p → not a curve point; JVM decodePoint throws.
const INVALID_X = '02' + 'ff'.repeat(32)
// 0x04 = uncompressed SEC1 prefix — invalid in a 33-byte payload; JVM throws.
const BAD_PREFIX = '04' + '11'.repeat(32)

function parseGe(hex: string) {
  return parseSValue(SGROUP, 0, new ByteReader(hexToBytes(hex)))
}

describe('parseSValue SGroupElement — GE canonical-bytes invariant', () => {
  test('(a) 0x00-lead garbage-tail payload normalizes to the canonical 33-zero identity', () => {
    const v = parseGe(GARBAGE_IDENTITY)
    expect(v.kind).toBe('GroupElement')
    if (v.kind !== 'GroupElement') throw new Error('unreachable')
    expect(v.value).toEqual(hexToBytes(CANONICAL_IDENTITY))
  })

  test('(b) re-serializing the normalized identity emits canonical bytes (≠ garbage input)', () => {
    const v = parseGe(GARBAGE_IDENTITY)
    const w = new ByteWriter()
    serializeSValue(SGROUP, v, 0, w)
    expect(w.toBytes()).toEqual(hexToBytes(CANONICAL_IDENTITY))
  })

  test('(c) valid 02-lead point (generator) parses verbatim', () => {
    const v = parseGe(GENERATOR_HEX)
    expect(v.kind).toBe('GroupElement')
    if (v.kind !== 'GroupElement') throw new Error('unreachable')
    expect(v.value).toEqual(hexToBytes(GENERATOR_HEX))
  })

  test('(d) 02-lead x-not-on-curve payload rejects with group-element-invalid-point', () => {
    expect(() => parseGe(INVALID_X)).toThrow(
      expect.objectContaining({
        name: 'SValueParseError',
        code: 'group-element-invalid-point',
      })
    )
  })

  test('(e) bad SEC1 prefix (0x04 in a 33-byte payload) rejects with group-element-invalid-point', () => {
    expect(() => parseGe(BAD_PREFIX)).toThrow(
      expect.objectContaining({
        name: 'SValueParseError',
        code: 'group-element-invalid-point',
      })
    )
  })

  test('(f) decodePoint→encodePoint is the identity on valid 02/03 payloads (verbatim = canonical)', () => {
    // Pins the property the helper relies on: for a payload that decodePoint
    // ACCEPTS, the input bytes are already the canonical SEC1 encoding
    // (fixed-width big-endian x + parity prefix), so returning them verbatim
    // IS returning the canonical form.
    const generatorBytes = hexToBytes(GENERATOR_HEX)
    expect(encodePoint(decodePoint(generatorBytes))).toEqual(generatorBytes)
  })
})
