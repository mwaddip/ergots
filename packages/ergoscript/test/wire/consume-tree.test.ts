/**
 * `consumeTreeFromReader` — lenient ErgoTree consumer for the SBox parse
 * path, mirroring sigma-rust's `ErgoTree::Unparsed { tree_bytes, error }`
 * fallback at `ergo_tree.rs:425-433`.
 *
 * First surfaced: mainnet h=545,684 tx 1 output 0 with header `0xcd`
 * (version=5, hasSize=true; the body parses an Expr but leaves trailing
 * bytes — sigma-rust would produce a non-SSigmaProp root, fail with
 * RootTpeError, and wrap as Unparsed).
 */

import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { consumeTreeFromReader, parseTreeFromReader, ErgoTreeParseError } from '../../src/wire/ergo-tree'

function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

describe('consumeTreeFromReader — hasSize=true unparseable body (mainnet h=545,684 shape)', () => {
  it('skips past the body region without throwing, even when strict parse would fail', () => {
    // Mainnet h=545,684 tx 1 output 0 ergoTree: 9 bytes total.
    //   byte 0: 0xcd — header (version=5, hasSize=true, reserved bits 5-7 set)
    //   byte 1: 0x07 — VLQ body size = 7
    //   bytes 2-8: body `02 1a 8e 6f 59 fd 4a` — opcode 0x02 produces a non-
    //              SSigmaProp Expr; sigma-rust would wrap as Unparsed.
    const bytes = hex('cd07021a8e6f59fd4a')
    const r = new ByteReader(bytes)
    expect(() => consumeTreeFromReader(r)).not.toThrow()
    // Cursor advanced past the full tree (1 header + 1 size VLQ + 7 body = 9):
    expect(r.position).toBe(9)
    expect(r.remaining).toBe(0)
  })

  it('strict parseTreeFromReader still throws on the same input (no regression for direct callers)', () => {
    const bytes = hex('cd07021a8e6f59fd4a')
    const r = new ByteReader(bytes)
    expect(() => parseTreeFromReader(r)).toThrow(ErgoTreeParseError)
  })

  it('still throws body-size-overflow if the declared size exceeds remaining (structural malformation, not lenient)', () => {
    // header=0xc8 (version=0, hasSize=true), size VLQ=0xff 0x7f (= 16383, huge),
    // followed by only 2 body bytes. Sigma-rust similarly fails outright
    // (read_exact errors before the parse attempt).
    const bytes = hex('08ff7f0102')
    const r = new ByteReader(bytes)
    expect(() => consumeTreeFromReader(r)).toThrow(ErgoTreeParseError)
  })
})

describe('consumeTreeFromReader — hasSize=true parseable body (no regression)', () => {
  it('consumes a well-formed hasSize=true P2PK-ish tree and lands cursor at end', () => {
    // Construct: header=0x08 (hasSize, version=0, no constant-seg), size VLQ=...,
    // body=full P2PK shape `08cd02<33-byte pk>`. Total body = 1+1+33 = 35.
    // VLQ for 35 = 0x23 (single byte). So full tree = 1 + 1 + 35 = 37 bytes.
    const pk = new Uint8Array(33)
    pk[0] = 0x02
    for (let i = 1; i < 33; i++) pk[i] = i
    const body = new Uint8Array([0x08, 0xcd, ...pk])  // SigmaPropConstant + ProveDlog
    const tree = new Uint8Array(2 + body.length)
    tree[0] = 0x08         // hasSize, version=0
    tree[1] = body.length  // VLQ size = 35
    tree.set(body, 2)
    const r = new ByteReader(tree)
    expect(() => consumeTreeFromReader(r)).not.toThrow()
    expect(r.position).toBe(tree.length)
  })
})

describe('consumeTreeFromReader — hasSize=false (strict; matches sigma-rust)', () => {
  it('parses a well-formed hasSize=false tree (delegates to strict parser)', () => {
    // Standard P2PK: header=0x00 (hasSize=false, version=0), then SigmaPropConstant
    // + ProveDlog + 33-byte pk. Total = 1 + 1 + 1 + 33 = 36 bytes.
    const pk = new Uint8Array(33)
    pk[0] = 0x02
    for (let i = 1; i < 33; i++) pk[i] = i
    const tree = new Uint8Array([0x00, 0x08, 0xcd, ...pk])
    const r = new ByteReader(tree)
    expect(() => consumeTreeFromReader(r)).not.toThrow()
    expect(r.position).toBe(tree.length)
  })

  it('STILL THROWS on hasSize=false trees with malformed body (no Unparsed fallback for non-sized — sigma-rust parity)', () => {
    // header=0x00 (hasSize=false), then garbage that won't parse as an Expr.
    // Opcode 0xff is reserved/unimplemented → throws.
    const bytes = new Uint8Array([0x00, 0xff, 0xff, 0xff])
    const r = new ByteReader(bytes)
    expect(() => consumeTreeFromReader(r)).toThrow()
  })
})
