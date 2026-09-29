/**
 * `parseErgoTreeBytes` — the box path's ErgoTree consumer (the SBox value arm and
 * `@ergots/transaction`'s ErgoBoxCandidate codec). It calls `parseTreeFromReader(r,
 * { checkType: true })`, the JVM box parser's `deserializeErgoTree` (ErgoBoxCandidate.scala:194,
 * checkType = true): the tree is parsed on the arriving reader, its declared size is used only
 * when it degrades, and rule 1001 (the root must type as SigmaProp) applies. Non-soft-forkable
 * failures (e.g. SHeader constants, whose `SerializerException` escapes the `UnparsedErgoTree`
 * fallback) reject; soft-forkable ones (reserved opcodes, rule 1001) degrade a sized tree. The
 * bare `parseTreeFromReader` / `parseTree` are lenient: no rule 1001.
 *
 * The mainnet h=545,684 burn box (header 0xcd, declared size 7, body a Byte constant `02 1a`
 * followed by five trailing bytes) parses leniently and stops after its 2-byte body; on the
 * box path rule 1001 fails, the tree degrades to its declared span, and the box continues at
 * byte 9, as in the JVM (spec 2026-09-28, "The burn box").
 */

import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseErgoTreeBytes, parseTreeFromReader, ErgoTreeParseError } from '../../src/wire/ergo-tree'
import { isUnparsedTree } from '../../src/mir/types'

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
  it('parseErgoTreeBytes lands on byte 9 through rule 1001\'s degrade', () => {
    // Mainnet h=545,684 tx 1 output 0 ergoTree: 9 bytes total.
    //   byte 0: 0xcd — header (version=5, hasSize=true, reserved bits 6-7 set)
    //   byte 1: 0x07 — VLQ declared size = 7
    //   bytes 2-3: body `02 1a` — a Byte constant; bytes 4-8 `8e 6f 59 fd 4a` trail it.
    // The root types as Byte, not SigmaProp: rule 1001 fails (a ValidationException in the
    // JVM, ValidationRules.scala:39-52), the size-flagged tree degrades, and the degrade
    // re-reads its declared span, numBytes = 2 + 7 = 9 (ErgoTreeSerializer.scala:199-202).
    const bytes = hex('cd07021a8e6f59fd4a')
    const r = new ByteReader(bytes)
    expect(Array.from(parseErgoTreeBytes(r))).toEqual(Array.from(bytes))
    expect(r.position).toBe(9)
    expect(r.remaining).toBe(0)
    // The same parse with the tree kept: an UnparsedErgoTree carrying rule 1001's error.
    const tree = parseTreeFromReader(new ByteReader(bytes), { checkType: true })
    expect(isUnparsedTree(tree)).toBe(true)
    if (isUnparsedTree(tree)) expect((tree.error as ErgoTreeParseError).code).toBe('root-not-sigma-prop')
  })

  it('the lenient parseTreeFromReader ignores the declared size and stops after the body', () => {
    // No rule 1001 (the JVM's checkType = false): the Byte-constant root parses and the
    // cursor stops at the parse end, byte 4. The declared size plays no part on a parse
    // that succeeds (the JVM re-reads [startPos, r.position), ErgoTreeSerializer.scala:179-181).
    const bytes = hex('cd07021a8e6f59fd4a')
    const r = new ByteReader(bytes)
    expect(isUnparsedTree(parseTreeFromReader(r))).toBe(false)
    expect(r.position).toBe(4)
  })

  it('a degrade whose declared span runs past the end throws body-size-overflow', () => {
    // header 0x08 (version 0, hasSize), size VLQ ff 7f (= 16383), then a Boolean constant
    // `01 02` (JVM Boolean data is non-zero-true, CoreDataSerializer.scala:99). On the box
    // path the Boolean root fails rule 1001 and the tree degrades; its span
    // numBytes = 3 + 16383 = 16386 runs past the 5-byte input, where the JVM's getBytes
    // fails, a hard reject (ErgoTreeSerializer.scala:199-202).
    const bytes = hex('08ff7f0102')
    const r = new ByteReader(bytes)
    let err: unknown
    try { parseErgoTreeBytes(r) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ErgoTreeParseError)
    expect((err as ErgoTreeParseError).code).toBe('body-size-overflow')
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
