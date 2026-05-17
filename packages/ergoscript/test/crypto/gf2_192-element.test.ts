/**
 * `Gf2_192Element` cross-validation tests (phase 2g-combinators Task 2).
 *
 * Each entry in `crypto/gf2_192-element-ops.json` is the output of sigma-rust's
 * `gf2_192::Gf2_192` reference implementation. The TS port must produce the
 * same 24-byte result byte-for-byte. A passing suite is byte-equality with
 * sigma-rust, which is the only correctness signal for this crypto primitive.
 *
 * Source oracle: ~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192.rs
 * (HEAD ed5452cf, branch `integration/ergots`).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Gf2_192Element } from '../../src/crypto/gf2_192'
import { hexToBytes } from '../_helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface ElementOpFixture {
  name: string
  op:
    | 'add'
    | 'multiply'
    | 'sqr'
    | 'invert'
    | 'equals'
    | 'round_trip'
  inputs: string[]
  expected: string
}

const fixtures: ElementOpFixture[] = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/crypto/gf2_192-element-ops.json'), 'utf-8'),
) as ElementOpFixture[]

function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) {
    out += (b[i]! < 16 ? '0' : '') + b[i]!.toString(16)
  }
  return out
}

describe('Gf2_192Element — cross-validated against sigma-rust', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      switch (f.op) {
        case 'add': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          const b = Gf2_192Element.fromBytes(hexToBytes(f.inputs[1]!))
          expect(bytesToHex(a.add(b).toBytes())).toBe(f.expected)
          break
        }
        case 'multiply': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          const b = Gf2_192Element.fromBytes(hexToBytes(f.inputs[1]!))
          expect(bytesToHex(a.multiply(b).toBytes())).toBe(f.expected)
          break
        }
        case 'sqr': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          expect(bytesToHex(a.sqr().toBytes())).toBe(f.expected)
          break
        }
        case 'invert': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          expect(bytesToHex(a.invert().toBytes())).toBe(f.expected)
          // Cross-validation: x * invert(x) must equal ONE for every fixture entry.
          const prod = a.multiply(a.invert())
          expect(prod.isOne()).toBe(true)
          break
        }
        case 'equals': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          const b = Gf2_192Element.fromBytes(hexToBytes(f.inputs[1]!))
          expect(a.equals(b)).toBe(f.expected === 'true')
          break
        }
        case 'round_trip': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          expect(bytesToHex(a.toBytes())).toBe(f.expected)
          break
        }
        default: {
          // Exhaustiveness — TypeScript will warn if a new op is added.
          const _exhaustive: never = f.op
          throw new Error(`unhandled op: ${String(_exhaustive)}`)
        }
      }
    })
  }
})

describe('Gf2_192Element static constants', () => {
  it('ZERO encodes to 24 zero bytes', () => {
    expect(bytesToHex(Gf2_192Element.ZERO.toBytes())).toBe('00'.repeat(24))
    expect(Gf2_192Element.ZERO.isZero()).toBe(true)
    expect(Gf2_192Element.ZERO.isOne()).toBe(false)
  })

  it('ONE encodes to 01 followed by 23 zero bytes', () => {
    expect(bytesToHex(Gf2_192Element.ONE.toBytes())).toBe('01' + '00'.repeat(23))
    expect(Gf2_192Element.ONE.isOne()).toBe(true)
    expect(Gf2_192Element.ONE.isZero()).toBe(false)
  })

  it('ONE is the multiplicative identity (ONE * x == x)', () => {
    const x = Gf2_192Element.fromBytes(hexToBytes('12'.repeat(24)))
    expect(bytesToHex(Gf2_192Element.ONE.multiply(x).toBytes())).toBe('12'.repeat(24))
    expect(bytesToHex(x.multiply(Gf2_192Element.ONE).toBytes())).toBe('12'.repeat(24))
  })

  it('ZERO is the additive identity', () => {
    const x = Gf2_192Element.fromBytes(hexToBytes('deadbeef'.repeat(6)))
    expect(bytesToHex(Gf2_192Element.ZERO.add(x).toBytes())).toBe('deadbeef'.repeat(6))
    expect(bytesToHex(x.add(Gf2_192Element.ZERO).toBytes())).toBe('deadbeef'.repeat(6))
  })
})

describe('Gf2_192Element fromBytes / toBytes invariants', () => {
  it('fromBytes(toBytes(x)) round-trips for a non-trivial value', () => {
    const original = hexToBytes('deadbeef'.repeat(6))
    const roundTrip = Gf2_192Element.fromBytes(original).toBytes()
    expect(bytesToHex(roundTrip)).toBe(bytesToHex(original))
  })

  it('toBytes returns a fresh array (no shared buffer)', () => {
    const x = Gf2_192Element.fromBytes(hexToBytes('ab'.repeat(24)))
    const a = x.toBytes()
    const b = x.toBytes()
    expect(a).not.toBe(b)
    a[0] = 0xff
    expect(b[0]).not.toBe(0xff)
  })

  it('throws on wrong-length input (23 bytes)', () => {
    expect(() => Gf2_192Element.fromBytes(new Uint8Array(23))).toThrow(/24 bytes/)
  })

  it('throws on wrong-length input (25 bytes)', () => {
    expect(() => Gf2_192Element.fromBytes(new Uint8Array(25))).toThrow(/24 bytes/)
  })

  it('throws on invert(0)', () => {
    expect(() => Gf2_192Element.ZERO.invert()).toThrow(/invert/i)
  })
})

describe('Gf2_192Element algebraic properties (smoke checks)', () => {
  // These complement the fixture-driven byte tests by exercising the algebra
  // at the TS level — if a TS-only refactor breaks an invariant, these catch
  // it even when no fixture happens to hit that exact path.
  const samples = [
    '0123456789abcdef0123456789abcdef0123456789abcdef',
    'fedcba9876543210fedcba9876543210fedcba9876543210',
    'deadbeefcafef00d1122334455667788aabbccddee001122',
    'ffffffffffffffffffffffffffffffffffffffffffffffff',
    '010000000000000000000000000000000000000000000080',
  ]

  for (const hex of samples) {
    it(`(x * x) == sqr(x) for x=${hex.slice(0, 12)}…`, () => {
      const x = Gf2_192Element.fromBytes(hexToBytes(hex))
      expect(bytesToHex(x.multiply(x).toBytes())).toBe(bytesToHex(x.sqr().toBytes()))
    })

    it(`x + x == 0 (characteristic 2) for x=${hex.slice(0, 12)}…`, () => {
      const x = Gf2_192Element.fromBytes(hexToBytes(hex))
      expect(x.add(x).isZero()).toBe(true)
    })

    it(`x * invert(x) == 1 for x=${hex.slice(0, 12)}…`, () => {
      const x = Gf2_192Element.fromBytes(hexToBytes(hex))
      expect(x.multiply(x.invert()).isOne()).toBe(true)
    })
  }
})
