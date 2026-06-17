/**
 * `parseErgoTreeBytes` — unified ErgoTree consumer for the SBox / ErgoBoxCandidate
 * parse path. After the deserialize-unification fix, `parseErgoTreeBytes` calls
 * `parseTreeFromReader` (the same deserialize as bare `parseTree`), so the box
 * path rejects exactly what the tree path rejects — including the non-soft-forkable
 * class (e.g. SHeader constants whose `SerializerException` escapes the
 * `UnparsedErgoTree` fallback). Soft-forkable failures (reserved opcodes) are still
 * degraded to `UnparsedErgoTree` exactly as before.
 *
 * The mainnet h=545,684 burn box (header 0xcd, body `02 1a 8e 6f 59 fd 4a`) that
 * previously triggered the inner-trailing check now passes: the inner-trailing check
 * has been removed, matching the JVM (parse-determined end) and sigma-rust (sized-
 * buffer leftover ignored).
 */

import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseErgoTreeBytes, parseTreeFromReader, ErgoTreeParseError } from '../../src/wire/ergo-tree'

function hex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

// secp256k1 generator G — a VALID compressed point (33 bytes). Recalibrated in
// F5 batch 4: ProveDlog leaves are now curve-validated at parse (JVM
// SigmaBoolean.scala:36-44,71-80 via GroupElementSerializer), and the previous
// synthetic pk (x = 0x0102…20, off-curve) is one the JVM itself rejects. The
// "parseable body" tests below must embed a genuinely parseable pk to keep
// testing consumption/delegation rather than the GE reject path.
const VALID_PK = hex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')

describe('parseErgoTreeBytes — hasSize=true (mainnet h=545,684 burn box shape)', () => {
  it('parseErgoTreeBytes accepts the burn box (inner-trailing now tolerated; unified parser)', () => {
    // Mainnet h=545,684 tx 1 output 0 ergoTree: 9 bytes total.
    //   byte 0: 0xcd — header (version=5, hasSize=true, reserved bits 5-7 set)
    //   byte 1: 0x07 — VLQ body size = 7
    //   bytes 2-8: body `02 1a 8e 6f 59 fd 4a` — the SigmaPropValue tag + bytes;
    //              sigma-rust would produce a non-SSigmaProp root and wrap as Unparsed.
    //   The inner-trailing check that previously rejected this input is REMOVED;
    //   the body parses successfully and the leftover inside the declared size is
    //   tolerated — matching the JVM and sigma-rust.
    const bytes = hex('cd07021a8e6f59fd4a')
    const r = new ByteReader(bytes)
    expect(() => parseErgoTreeBytes(r)).not.toThrow()
    // Cursor advanced past the full declared size (1 header + 1 size VLQ + 7 body = 9):
    expect(r.position).toBe(9)
    expect(r.remaining).toBe(0)
  })

  it('parseTreeFromReader now ALSO accepts the burn box (unified; inner-trailing tolerated)', () => {
    const bytes = hex('cd07021a8e6f59fd4a')
    const r = new ByteReader(bytes)
    expect(() => parseTreeFromReader(r)).not.toThrow()
    expect(r.position).toBe(9) // full declared size consumed
  })

  it('still throws body-size-overflow if the declared size exceeds remaining (structural malformation)', () => {
    // header=0xc8 (version=0, hasSize=true), size VLQ=0xff 0x7f (= 16383, huge),
    // followed by only 2 body bytes. Sigma-rust similarly fails outright
    // (read_exact errors before the parse attempt).
    const bytes = hex('08ff7f0102')
    const r = new ByteReader(bytes)
    expect(() => parseErgoTreeBytes(r)).toThrow(ErgoTreeParseError)
  })
})

describe('parseErgoTreeBytes — hasSize=true parseable body (no regression)', () => {
  it('accepts a well-formed hasSize=true P2PK-ish tree and lands cursor at end', () => {
    // Construct: header=0x08 (hasSize, version=0, no constant-seg), size VLQ=...,
    // body=full P2PK shape `08cd02<33-byte pk>`. Total body = 1+1+33 = 35.
    // VLQ for 35 = 0x23 (single byte). So full tree = 1 + 1 + 35 = 37 bytes.
    const body = new Uint8Array([0x08, 0xcd, ...VALID_PK])  // SigmaPropConstant + ProveDlog
    const tree = new Uint8Array(2 + body.length)
    tree[0] = 0x08         // hasSize, version=0
    tree[1] = body.length  // VLQ size = 35
    tree.set(body, 2)
    const r = new ByteReader(tree)
    expect(() => parseErgoTreeBytes(r)).not.toThrow()
    expect(r.position).toBe(tree.length)
  })
})

describe('parseErgoTreeBytes — hasSize=false (strict; matches sigma-rust)', () => {
  it('accepts a well-formed hasSize=false tree (delegates to unified parser)', () => {
    // Standard P2PK: header=0x00 (hasSize=false, version=0), then SigmaPropConstant
    // + ProveDlog + 33-byte pk. Total = 1 + 1 + 1 + 33 = 36 bytes.
    const tree = new Uint8Array([0x00, 0x08, 0xcd, ...VALID_PK])
    const r = new ByteReader(tree)
    expect(() => parseErgoTreeBytes(r)).not.toThrow()
    expect(r.position).toBe(tree.length)
  })

  it('STILL THROWS on hasSize=false trees with malformed body (no Unparsed fallback for non-sized — sigma-rust parity)', () => {
    // header=0x00 (hasSize=false), then garbage that won't parse as an Expr.
    // Opcode 0xff is reserved/unimplemented → throws.
    const bytes = new Uint8Array([0x00, 0xff, 0xff, 0xff])
    const r = new ByteReader(bytes)
    expect(() => parseErgoTreeBytes(r)).toThrow()
  })
})
