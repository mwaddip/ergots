/**
 * Audit ERG-PARSE-01: SValue length fields must reject values above u32.
 *
 * sigma-rust reads `SAvlTree.keyLength`, `SAvlTree.valueLengthOpt`, and
 * `SString.len` via `get_u32` (a u32-bounded VLQ read — `serialization/data.rs`
 * and `mir/avl_tree_data.rs`). Our parser used the generic `readVlqU()`, which
 * accepts any VLQ up to the 10-byte cap — so a crafted length > u32 parsed
 * instead of being rejected, diverging from sigma-rust AND from our own
 * serializer (which already caps these fields at `0xffffffff` via
 * `savltree-{key,value}-length-out-of-range`).
 *
 * The fix swaps the three reads to scorex `readVlqU32`, which throws
 * `ReaderError('vlq-overflow')` with message "...exceeds u32 range".
 *
 * RED before the fix:
 *   - SAvlTree keyLength / valueLengthOpt > u32 parse successfully (no throw).
 *   - SString len > u32 DOES throw today, but from the downstream `readBytes`
 *     (buffer exhausted) — NOT the length check — so the specific
 *     "exceeds u32 range" assertion still fails.
 */

import { describe, it, expect } from 'vitest'
import { parseSValue } from '../../src/wire/parse-svalue'
import { ByteReader } from '@ergots/scorex'

// VLQ(2^32) = 0x1_0000_0000 — the first value strictly above the u32 ceiling
// (0xffffffff). 7 bits/byte, LSB-first: four 0x80 continuation bytes then 0x10.
const VLQ_2_POW_32 = [0x80, 0x80, 0x80, 0x80, 0x10]
const DIGEST_33 = Array.from({ length: 33 }, () => 0x00)

describe('SValue length fields reject > u32 (audit ERG-PARSE-01)', () => {
  it('rejects SAvlTree keyLength above u32', () => {
    const bytes = new Uint8Array([
      ...DIGEST_33, // digest (33 raw bytes)
      0x00, // treeFlags
      ...VLQ_2_POW_32, // keyLength = 2^32 (> u32 max)
      0x00, // valueLengthOpt tag = None
    ])
    expect(() => parseSValue({ tag: 'SAvlTree' }, 0, new ByteReader(bytes))).toThrow(
      /exceeds u32 range/,
    )
  })

  it('rejects SAvlTree valueLengthOpt above u32', () => {
    const bytes = new Uint8Array([
      ...DIGEST_33, // digest
      0x00, // treeFlags
      0x20, // keyLength = 32 (valid)
      0x01, // valueLengthOpt tag = Some
      ...VLQ_2_POW_32, // valueLengthOpt = 2^32 (> u32 max)
    ])
    expect(() => parseSValue({ tag: 'SAvlTree' }, 0, new ByteReader(bytes))).toThrow(
      /exceeds u32 range/,
    )
  })

  it('rejects SString length above u32 at the length read', () => {
    const bytes = new Uint8Array([...VLQ_2_POW_32]) // len = 2^32
    expect(() => parseSValue({ tag: 'SString' }, 0, new ByteReader(bytes))).toThrow(
      /exceeds u32 range/,
    )
  })
})
