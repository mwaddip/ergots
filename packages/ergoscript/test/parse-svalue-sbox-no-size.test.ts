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
})
