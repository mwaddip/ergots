/**
 * SBox v0+hasSize=false parse (phase 2j-pre fix-1 RED tests).
 *
 * The 2j-pre Layer-3 smoke walk against a mainnet bootstrap-data snapshot
 * surfaced that ~99% of mainnet ErgoBoxes carry v0+hasSize=false (P2PK)
 * ErgoTrees — the very shape that `parseSValue(SBox)` rejects with
 * `SValueParseError('sbox-ergo-tree-no-size')` at parse-svalue.ts:278-287.
 * These tests are the RED step: 3 of them throw against the current parser;
 * 1 (the public parseTree wrapper test) already passes today, and locks in
 * parity post-refactor.
 *
 * After T3 lands, all 4 tests should pass.
 *
 * Spec: docs/specs/2026-05-22-ergoscript-2j-pre-fix-1-sbox-no-size-design.md
 *
 * Synthetic fixture: a canonical v0+hasSize=false P2PK ErgoTree is 36 bytes:
 *   byte 0: 0x00 — header (version=0, hasSize=false, no segregation)
 *   byte 1: 0x08 — SType code for SSigmaProp
 *   byte 2: 0xcd — ProveDlog::OP_CODE (sigma-rust
 *                  ergotree-ir/src/serialization/sigmaboolean.rs:50, value
 *                  PROVE_DLOG = 205)
 *   bytes 3-35: 33 bytes — compressed secp256k1 EcPoint (test data; doesn't
 *                          need to be a real curve point for parse-only tests).
 *
 * Wrapped in a 74-byte SBox per `chain/ergo_box.rs:201-223`.
 */

import { describe, it, expect } from 'vitest'
import { parseSValue } from '../src/wire/parse-svalue'
import { serializeSValue } from '../src/wire/serialize-svalue'
import { parseTree, serializeTree } from '../src/wire/ergo-tree'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import type { ErgoBox } from '../src/mir/types'

// Minimal v0+hasSize=false P2PK ErgoTree (36 bytes total).
const P2PK_PUBKEY_TEST = new Uint8Array([
  0x02,
  ...Array.from({ length: 32 }, () => 0xaa),
])
const P2PK_TREE_V0_NO_SIZE = new Uint8Array([
  0x00, // header: version=0, hasSize=false, no segregation
  0x08, // SType code: SSigmaProp
  0xcd, // ProveDlog::OP_CODE
  ...P2PK_PUBKEY_TEST,
])

// Minimal full SBox containing the v0+hasSize=false P2PK tree.
// Field layout per chain/ergo_box.rs:201-223:
//   value           — VLQ u64
//   ergo_tree_bytes — self-delimiting (36 bytes above)
//   creation_height — VLQ u32
//   tokens_count    — raw u8
//   additional_regs — raw u8 (count) + per-register Const wire
//   transaction_id  — 32 raw bytes
//   index           — VLQ u16
const SYNTHETIC_SBOX_V0_NO_SIZE = new Uint8Array([
  0x80, 0x01, // value VLQ u64 = 128 (0x80 = continuation+0; 0x01 = bit 7)
  ...P2PK_TREE_V0_NO_SIZE, // 36 bytes ergo_tree
  0x01, // creation_height VLQ u32 = 1
  0x00, // tokens_count u8 = 0
  0x00, // additional_regs u8 = 0
  ...Array.from({ length: 32 }, () => 0xbb), // transaction_id
  0x00, // index VLQ u16 = 0
])

// Real mainnet box captured from the bootstrap-data snapshot at h=1, tx 0,
// output 0 (273 bytes). The ErgoTree header byte (byte 9, after the multi-byte
// VLQ value prefix) is 0x10 — version=0, hasSize=false, constantSegregation=true.
// Captured via tools/mainnet-validate/harness/scripts/dump-output.mjs against
// /tmp/ergots-2j-pre-smoke-data/modifiers.redb on 2026-05-22.
const MAINNET_H1_TX0_OUT0_HEX =
  '80b481d1cbe1f6a501101004020e36100204a00b08cd0279be667ef9dcbbac55a062' +
  '95ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073' +
  '0110010204020404040004c0fd4f05808c82f5f6030580b8c9e5ae040580f882ad16' +
  '040204c0944004c0f407040004000580f882ad16d19683030191a38cc7a701968302' +
  '0193c2b2a57300007473017302830108cdeeac93a38cc7b2a573030001978302019683' +
  '040193b1a5730493c2a7c2b2a573050093958fa3730673079973089c73097e9a730a' +
  '9d99a3730b730c0599c1a7c1b2a5730d00938cc7b2a5730e0001a390c1a7730f0100' +
  '004c6282be413c6e300a530618b37790be5f286ded758accc2aebd41554a1be30800'

function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return result
}

describe('SBox v0+hasSize=false parse (phase 2j-pre fix-1)', () => {
  it('parses v0+hasSize=false P2PK SBox without throwing', () => {
    const r = new ByteReader(SYNTHETIC_SBOX_V0_NO_SIZE)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    expect(sbox.kind).toBe('Box')
  })

  it('round-trips byte-equal', () => {
    const r = new ByteReader(SYNTHETIC_SBOX_V0_NO_SIZE)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, sbox, 0, w)
    expect(w.toBytes()).toEqual(SYNTHETIC_SBOX_V0_NO_SIZE)
  })

  it('ergoTreeBytes captures exactly the tree bytes', () => {
    const r = new ByteReader(SYNTHETIC_SBOX_V0_NO_SIZE)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    // The SValue.Box discriminator wraps an ErgoBox. Narrow + extract.
    if (sbox.kind !== 'Box') {
      throw new Error(`expected Box, got ${sbox.kind}`)
    }
    const box: ErgoBox = sbox.value
    expect(box.ergoTreeBytes).toEqual(P2PK_TREE_V0_NO_SIZE)
  })

  it('public-API parseTree handles the same v0+hasSize=false bytes', () => {
    // This test pins the public parseTree(bytes) wrapper's behavior on
    // v0+hasSize=false trees. It passes today (the public function
    // already handles this case internally) and locks in parity through
    // the T3 refactor.
    const tree = parseTree(P2PK_TREE_V0_NO_SIZE)
    expect(tree.header.version).toBe(0)
    expect(tree.header.hasSize).toBe(false)
    expect(tree.header.constantSegregation).toBe(false)
    expect(serializeTree(tree)).toEqual(P2PK_TREE_V0_NO_SIZE)
  })

  // ────────────────────────────────────────────────────────────────────
  // Layer 2 — real-mainnet fixture
  // ────────────────────────────────────────────────────────────────────

  it('parses real mainnet v0+hasSize=false+segregation SBox (h=1 tx 0 out 0)', () => {
    const bytes = hexToBytes(MAINNET_H1_TX0_OUT0_HEX)
    const r = new ByteReader(bytes)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    expect(sbox.kind).toBe('Box')
    expect(r.isExhausted).toBe(true)  // exact consumption — no leftover
  })

  it('real mainnet SBox round-trips byte-equal', () => {
    const bytes = hexToBytes(MAINNET_H1_TX0_OUT0_HEX)
    const r = new ByteReader(bytes)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, sbox, 0, w)
    expect(w.toBytes()).toEqual(bytes)
  })

  it('real mainnet ErgoTree header is 0x10 (v0+segregation+!hasSize)', () => {
    const bytes = hexToBytes(MAINNET_H1_TX0_OUT0_HEX)
    const r = new ByteReader(bytes)
    const sbox = parseSValue({ tag: 'SBox' }, 0, r)
    if (sbox.kind !== 'Box') throw new Error(`expected Box, got ${sbox.kind}`)
    // Confirm via parseTree on the captured tree bytes — this slice should
    // round-trip and report the expected header flags.
    const tree = parseTree(sbox.value.ergoTreeBytes)
    expect(tree.header.rawHeader).toBe(0x10)
    expect(tree.header.version).toBe(0)
    expect(tree.header.hasSize).toBe(false)
    expect(tree.header.constantSegregation).toBe(true)
  })
})
