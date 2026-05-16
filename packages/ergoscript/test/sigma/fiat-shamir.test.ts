import { describe, it, expect } from 'vitest'
import { propBytes, fiatShamirHash, FIAT_SHAMIR_HASH_BYTES } from '../../src/sigma/fiat-shamir'
import { parseTree } from '../../src/wire/ergo-tree'
import type { SigmaBoolean } from '../../src/mir/types'

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
    const h = new Uint8Array(33)
    h[0] = 0x02  // SEC1 compressed pubkey tag
    for (let i = 1; i < 33; i++) h[i] = i
    const sb: SigmaBoolean = { tag: 'ProveDlog', h }
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
    const h = new Uint8Array(33)
    h[0] = 0x02
    for (let i = 1; i < 33; i++) h[i] = i * 2 + 1
    const sb: SigmaBoolean = { tag: 'ProveDlog', h }
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
