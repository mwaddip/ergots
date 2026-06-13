/**
 * Audit follow-up (out-of-scope observation from audit20260601): SBox integer
 * fields must match the JVM consensus reader's wire widths.
 *
 * `creation_height` is read by the JVM via `r.getUIntExact`
 * (ErgoBoxCandidate.scala:195) = `getUInt().toIntExact` (CoreByteReader.scala:73),
 * which throws an `ArithmeticException` for any value > `Int.MaxValue`
 * (2^31-1 = 0x7fffffff). So the consensus ceiling is i32 (2^31-1), NOT u32 —
 * a 5-byte VLQ height in (2^31, 2^32) parses for a u32-permissive reader but
 * the JVM (v5.x+) rejects it at parse. The NO-FORK comment at
 * ErgoBoxCandidate.scala:195-199 confirms this tightening is consensus-safe:
 * v4.x used `.toInt` (wrapping to a negative Int, then rejected later by
 * tx-validation rule #122), v5.x throws at the parse layer — same accept/reject
 * outcome. ergots is a v5+/v6 validator, so the faithful behavior is
 * parse-reject at > 0x7fffffff.
 *
 * `index` is read via `r.getUShort` (ErgoBox.scala) — a u16 ceiling (0xffff).
 * The serializer mirrors both bounds (round-trip-stable: a box can never arrive
 * from a JVM-faithful parse with an out-of-bounds field, so mirroring keeps the
 * parse/serialize bounds identical).
 *
 * (The earlier u32 framing cited sigma-rust `get_u32` (ergo_box.rs:351) — the
 * non-canonical source and the source of the wrong, looser bound. Re-anchored
 * to the JVM per the 2026-06-11 fork-closure pass.)
 *
 * Sibling of `svalue-u32-length-bounds.test.ts` (audit ERG-PARSE-01), which
 * covers the SAvlTree/SString *length* fields. The scorex header-height u32
 * sibling is deferred to its own branch.
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

// VLQ(2^31) = 0x80000000 — first value strictly above the i32 ceiling
// (Int.MaxValue = 0x7fffffff). The JVM `getUIntExact.toIntExact` throws here.
const VLQ_2_POW_31 = [0x80, 0x80, 0x80, 0x80, 0x08]
// VLQ(2^31 - 1) = 0x7fffffff — the largest accepted creation_height.
const VLQ_I32_MAX = [0xff, 0xff, 0xff, 0xff, 0x07]
// VLQ(65536) — first value strictly above the u16 ceiling (0xffff).
const VLQ_65536 = [0x80, 0x80, 0x04]

describe('SBox integer field bounds (audit follow-up)', () => {
  it('parser rejects creation_height above i32 (2^31, > Int.MaxValue)', () => {
    const bytes = sboxBytes(VLQ_2_POW_31, [0x00])
    expect(() => parseSValue({ tag: 'SBox' }, 0, new ByteReader(bytes))).toThrow(
      /creation_height.*exceeds 2\^31-1/,
    )
  })

  it('parser accepts creation_height at the i32 ceiling (2^31 - 1)', () => {
    const sbox = parseSValue({ tag: 'SBox' }, 0, new ByteReader(sboxBytes(VLQ_I32_MAX, [0x00])))
    if (sbox.kind !== 'Box') throw new Error(`expected Box, got ${sbox.kind}`)
    expect(sbox.value.creationHeight).toBe(0x7fffffff)
  })

  it('parser rejects index above u16', () => {
    const bytes = sboxBytes([0x01], VLQ_65536)
    expect(() => parseSValue({ tag: 'SBox' }, 0, new ByteReader(bytes))).toThrow(
      /index.*out of u16 range/,
    )
  })

  it('serializer rejects creation_height above i32 (2^31, > Int.MaxValue)', () => {
    // Parse a valid box, bump creation_height past i32 max, expect serialize to reject.
    const sbox = parseSValue({ tag: 'SBox' }, 0, new ByteReader(sboxBytes([0x01], [0x00])))
    if (sbox.kind !== 'Box') throw new Error(`expected Box, got ${sbox.kind}`)
    sbox.value.creationHeight = 0x8000_0000 // 2^31, > Int.MaxValue
    const w = new ByteWriter()
    expect(() => serializeSValue({ tag: 'SBox' }, sbox, 0, w)).toThrow(
      /creation_height.*exceeds 2\^31-1/,
    )
  })

  it('serializer accepts (round-trips) creation_height at the i32 ceiling', () => {
    const sbox = parseSValue({ tag: 'SBox' }, 0, new ByteReader(sboxBytes(VLQ_I32_MAX, [0x00])))
    if (sbox.kind !== 'Box') throw new Error(`expected Box, got ${sbox.kind}`)
    expect(sbox.value.creationHeight).toBe(0x7fffffff)
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, sbox, 0, w)
    // round-trips: re-parse yields the same height
    const reparsed = parseSValue({ tag: 'SBox' }, 0, new ByteReader(w.toBytes()))
    if (reparsed.kind !== 'Box') throw new Error(`expected Box, got ${reparsed.kind}`)
    expect(reparsed.value.creationHeight).toBe(0x7fffffff)
  })
})
