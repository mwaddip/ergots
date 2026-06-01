/**
 * Audit follow-up (out-of-scope observation from audit20260601): SBox integer
 * fields must match sigma-rust's wire widths. `creation_height` is `get_u32`
 * (ergo_box.rs:351) and `index` is `get_u16` (ergo_box.rs:220), but our parser
 * read both via the generic `readVlqU()` with no ceiling — more permissive than
 * sigma-rust. The serializer already bounds `index` (`sbox-index-out-of-range`,
 * serialize-svalue.ts:373) but NOT `creation_height` (it just `writeVlqU`s it).
 * These tests pin both bounds on both sides.
 *
 * RED before the fix: an over-u32 creation_height and an over-u16 index both
 * parse successfully; an over-u32 creation_height also serializes successfully.
 *
 * Sibling of `svalue-u32-length-bounds.test.ts` (audit ERG-PARSE-01), which
 * covers the SAvlTree/SString *length* fields.
 */

import { describe, it, expect } from 'vitest'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { ByteReader, ByteWriter } from '@ergots/scorex'

// Minimal v0+hasSize=false P2PK ErgoTree (36 bytes): header + SSigmaProp +
// ProveDlog opcode + 33-byte point (test data, need not be a real curve point).
const P2PK_TREE = [0x00, 0x08, 0xcd, 0x02, ...Array.from({ length: 32 }, () => 0xaa)]
const TXID = Array.from({ length: 32 }, () => 0xbb)

// SBox wire layout (chain/ergo_box.rs:201-223): value VLQ u64 | ergo_tree |
// creation_height VLQ u32 | tokens_count u8 | regs u8 | txId(32) | index VLQ u16.
function sboxBytes(creationHeightVlq: number[], indexVlq: number[]): Uint8Array {
  return new Uint8Array([
    0x80, 0x01, // value VLQ u64 = 128
    ...P2PK_TREE,
    ...creationHeightVlq,
    0x00, // tokens_count
    0x00, // additional_regs
    ...TXID,
    ...indexVlq,
  ])
}

// VLQ(2^32) — first value strictly above the u32 ceiling (0xffffffff).
const VLQ_2_POW_32 = [0x80, 0x80, 0x80, 0x80, 0x10]
// VLQ(65536) — first value strictly above the u16 ceiling (0xffff).
const VLQ_65536 = [0x80, 0x80, 0x04]

describe('SBox integer field bounds (audit follow-up)', () => {
  it('parser rejects creation_height above u32', () => {
    const bytes = sboxBytes(VLQ_2_POW_32, [0x00])
    expect(() => parseSValue({ tag: 'SBox' }, 0, new ByteReader(bytes))).toThrow(
      /creation_height.*out of u32 range/,
    )
  })

  it('parser rejects index above u16', () => {
    const bytes = sboxBytes([0x01], VLQ_65536)
    expect(() => parseSValue({ tag: 'SBox' }, 0, new ByteReader(bytes))).toThrow(
      /index.*out of u16 range/,
    )
  })

  it('serializer rejects creation_height above u32', () => {
    // Parse a valid box, bump creation_height past u32, expect serialize to reject.
    const sbox = parseSValue({ tag: 'SBox' }, 0, new ByteReader(sboxBytes([0x01], [0x00])))
    if (sbox.kind !== 'Box') throw new Error(`expected Box, got ${sbox.kind}`)
    sbox.value.creationHeight = 0x1_0000_0000 // 2^32, > u32 max
    const w = new ByteWriter()
    expect(() => serializeSValue({ tag: 'SBox' }, sbox, 0, w)).toThrow(
      /creation_height.*out of u32 range/,
    )
  })
})
