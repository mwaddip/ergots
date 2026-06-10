import { describe, it, expect } from 'vitest'
import { propBytes, fiatShamirHash, FIAT_SHAMIR_HASH_BYTES } from '../../src/sigma/fiat-shamir'
import { parseTree } from '../../src/wire/ergo-tree'
import type { SigmaBoolean } from '../../src/mir/types'

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

// VALID compressed secp256k1 points (G and 6G). Recalibrated in F5 batch 4:
// ProveDlog.h is curve-validated at parse (GE canonical-bytes invariant,
// facts/ergoscript-sigma.md) and the previous synthetic h's (x = 0x010203… /
// 0x030507…, off-curve) are points the JVM itself rejects — hand-built
// SigmaBoolean leaves in tests must carry invariant-conforming points.
const POINT_G = hexToBytes('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
const POINT_6G = hexToBytes('03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556')

describe('Fiat-Shamir primitives', () => {
  it('FIAT_SHAMIR_HASH_BYTES === 24', () => {
    expect(FIAT_SHAMIR_HASH_BYTES).toBe(24)
  })

  it('propBytes wraps SigmaProp in ErgoTree v0 + constant-segregation=true', () => {
    // A ProveDlog leaf with a known h. propBytes(sb) should produce the
    // byte-serialization of an ErgoTree whose body is
    // ConstPlaceholder(0) referencing a segregated SSigmaProp constant,
    // and whose header is v0 with constant-segregation.
    //
    // The exact bytes depend on the ErgoTree wire format. The most direct
    // way to lock this is a fixture from sigma-rust — defer the byte-equality
    // assertion to the Task 6 verifier-fixture stage. Here we just verify
    // propBytes returns non-empty, starts with a valid ErgoTree header byte.
    const sb: SigmaBoolean = { tag: 'ProveDlog', h: POINT_G }
    const bytes = propBytes(sb)
    expect(bytes.length).toBeGreaterThan(33)  // ErgoTree envelope adds bytes
    // ErgoTree v0 + constant-segregation: header byte should be 0x10 (bit 4 set).
    // Confirmed: CONSTANT_SEGREGATION_FLAG = 0b0001_0000 = 0x10 in sigma-rust tree_header.rs:53.
    expect((bytes[0]! & 0b00010000) !== 0).toBe(true)
    // version bits (bits 0..2) should be 0 for v0
    expect(bytes[0]! & 0b00000111).toBe(0)
    // hasSize (bit 3) should be 0 for v0
    expect(bytes[0]! & 0b00001000).toBe(0)
  })

  it('propBytes round-trips through parseTree correctly', () => {
    // The constructed ErgoTree should parse back cleanly via parseTree.
    // The body after parse should be ConstPlaceholder(0) (constant-segregation mode).
    const sb: SigmaBoolean = { tag: 'ProveDlog', h: POINT_6G }
    const bytes = propBytes(sb)
    const tree = parseTree(bytes)
    expect(tree.header.version).toBe(0)
    expect(tree.header.hasSize).toBe(false)
    expect(tree.header.constantSegregation).toBe(true)
    // One segregated constant of type SSigmaProp
    expect(tree.constantTypes.length).toBe(1)
    expect(tree.constantTypes[0]).toEqual({ tag: 'SSigmaProp' })
    expect(tree.constants.length).toBe(1)
    expect(tree.constants[0]).toEqual({ kind: 'SigmaProp', value: sb })
    // Body should be ConstPlaceholder(0)
    expect(tree.body).toEqual({ tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SSigmaProp' } })
  })

  it('fiatShamirHash truncates blake2b-256 output to 24 bytes', () => {
    const result = fiatShamirHash(new Uint8Array(10))
    expect(result.length).toBe(FIAT_SHAMIR_HASH_BYTES)
  })

  it('fiatShamirHash returns deterministic output', () => {
    const input = new Uint8Array(32)
    for (let i = 0; i < 32; i++) input[i] = i
    const a = fiatShamirHash(input)
    const b = fiatShamirHash(input)
    expect(a).toEqual(b)
  })

  it('fiatShamirHash output differs for different inputs', () => {
    const a = fiatShamirHash(new Uint8Array([0x01]))
    const b = fiatShamirHash(new Uint8Array([0x02]))
    expect(a).not.toEqual(b)
  })

  // More tests added at Task 6 (byte-equivalence with sigma-rust fixtures).
})
