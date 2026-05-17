/**
 * `Gf2_192Poly` cross-validation tests (phase 2g-combinators Task 3).
 *
 * Each entry in `crypto/gf2_192-poly-ops.json` is the output of sigma-rust's
 * `gf2_192::gf2_192poly::Gf2_192Poly` reference implementation. The TS port
 * must produce the same bytes / element byte-for-byte. A passing suite is
 * byte-equality with sigma-rust, which is the only correctness signal for
 * this crypto-adjacent primitive (the Lagrange interpolation drives the
 * Cthreshold conjecture verifier in Task 9).
 *
 * Source oracle: ~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192poly.rs
 * (HEAD ed5452cf, branch `integration/ergots`).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Gf2_192Element, Gf2_192Poly } from '../../src/crypto/gf2_192'
import { hexToBytes } from '../_helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface PolyOpFixture {
  name: string
  op: 'interpolate' | 'evaluate' | 'to_bytes' | 'from_coeffs_and_const'
  inputs: {
    points?: number[]
    values_hex?: string[]
    value_at_zero_hex?: string
    poly_bytes_hex?: string
    eval_point?: number
  }
  expected: string
}

const fixtures: PolyOpFixture[] = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/crypto/gf2_192-poly-ops.json'), 'utf-8'),
) as PolyOpFixture[]

function bytesToHex(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i++) {
    out += (b[i]! < 16 ? '0' : '') + b[i]!.toString(16)
  }
  return out
}

describe('Gf2_192Poly — cross-validated against sigma-rust', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      switch (f.op) {
        case 'interpolate': {
          const values = f.inputs.values_hex!.map((h) =>
            Gf2_192Element.fromBytes(hexToBytes(h)),
          )
          const valueAtZero = Gf2_192Element.fromBytes(
            hexToBytes(f.inputs.value_at_zero_hex!),
          )
          const poly = Gf2_192Poly.interpolate(
            f.inputs.points!,
            values,
            valueAtZero,
          )
          expect(bytesToHex(poly.toBytes())).toBe(f.expected)
          break
        }
        case 'evaluate': {
          const poly = Gf2_192Poly.fromCoefficientsAndConstant(
            hexToBytes(f.inputs.poly_bytes_hex!),
            Gf2_192Element.fromBytes(hexToBytes(f.inputs.value_at_zero_hex!)),
          )
          const result = poly.evaluate(f.inputs.eval_point!)
          expect(bytesToHex(result.toBytes())).toBe(f.expected)
          break
        }
        case 'to_bytes': {
          const values = f.inputs.values_hex!.map((h) =>
            Gf2_192Element.fromBytes(hexToBytes(h)),
          )
          const valueAtZero = Gf2_192Element.fromBytes(
            hexToBytes(f.inputs.value_at_zero_hex!),
          )
          const poly = Gf2_192Poly.interpolate(
            f.inputs.points!,
            values,
            valueAtZero,
          )
          expect(bytesToHex(poly.toBytes())).toBe(f.expected)
          break
        }
        case 'from_coeffs_and_const': {
          const poly = Gf2_192Poly.fromCoefficientsAndConstant(
            hexToBytes(f.inputs.poly_bytes_hex!),
            Gf2_192Element.fromBytes(hexToBytes(f.inputs.value_at_zero_hex!)),
          )
          const evaluated = poly.evaluate(f.inputs.eval_point!)
          expect(bytesToHex(evaluated.toBytes())).toBe(f.expected)
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

describe('Gf2_192Poly invariants', () => {
  it('interpolate creates polynomial passing through (0, value_at_zero) and each (points[i], values[i])', () => {
    const valueAtZero = Gf2_192Element.fromBytes(new Uint8Array(24).fill(0x42))
    const points = [1, 2, 3]
    const values = points.map((p) =>
      Gf2_192Element.fromBytes(new Uint8Array(24).fill(p)),
    )
    const poly = Gf2_192Poly.interpolate(points, values, valueAtZero)

    expect(poly.evaluate(0).equals(valueAtZero)).toBe(true)
    for (let i = 0; i < points.length; i++) {
      expect(poly.evaluate(points[i]!).equals(values[i]!)).toBe(true)
    }
  })

  it('degree property equals (number of nonzero points)', () => {
    const valueAtZero = Gf2_192Element.ZERO
    const points = [1, 2, 3, 5]
    const values = points.map((p) =>
      Gf2_192Element.fromBytes(new Uint8Array(24).fill(p)),
    )
    const poly = Gf2_192Poly.interpolate(points, values, valueAtZero)
    expect(poly.degree).toBe(4)
    expect(poly.toBytes().length).toBe(4 * 24)
  })

  it('empty points produces a degree-0 constant polynomial', () => {
    const constant = Gf2_192Element.fromBytes(hexToBytes('deadbeef'.repeat(6)))
    const poly = Gf2_192Poly.interpolate([], [], constant)
    expect(poly.degree).toBe(0)
    expect(poly.toBytes().length).toBe(0)
    expect(poly.evaluate(0).equals(constant)).toBe(true)
    expect(poly.evaluate(5).equals(constant)).toBe(true)
    expect(poly.evaluate(255).equals(constant)).toBe(true)
  })

  it('evaluate at 0 returns the constant coefficient', () => {
    const constant = Gf2_192Element.fromBytes(new Uint8Array(24).fill(0x33))
    const points = [1, 2, 3]
    const values = points.map((p) =>
      Gf2_192Element.fromBytes(new Uint8Array(24).fill(p)),
    )
    const poly = Gf2_192Poly.interpolate(points, values, constant)
    expect(poly.evaluate(0).equals(constant)).toBe(true)
  })

  it('fromCoefficientsAndConstant reconstructs an equivalent polynomial', () => {
    const valueAtZero = Gf2_192Element.fromBytes(
      hexToBytes('aabbccddeeff0011223344556677889900aabbccddeeff00'),
    )
    const points = [1, 7, 13]
    const values = points.map((p) =>
      Gf2_192Element.fromBytes(new Uint8Array(24).fill(p)),
    )
    const original = Gf2_192Poly.interpolate(points, values, valueAtZero)
    const reconstructed = Gf2_192Poly.fromCoefficientsAndConstant(
      original.toBytes(),
      valueAtZero,
    )
    // Same evaluation at every point (covers the full byte range).
    for (let x = 0; x < 256; x++) {
      expect(reconstructed.evaluate(x).equals(original.evaluate(x))).toBe(true)
    }
  })
})

describe('Gf2_192Poly input validation', () => {
  it('throws when points and values lengths differ', () => {
    expect(() =>
      Gf2_192Poly.interpolate(
        [1, 2],
        [Gf2_192Element.ONE],
        Gf2_192Element.ZERO,
      ),
    ).toThrow(/length/i)
  })

  it('throws when points contain zero', () => {
    expect(() =>
      Gf2_192Poly.interpolate(
        [0, 1],
        [Gf2_192Element.ONE, Gf2_192Element.ONE],
        Gf2_192Element.ZERO,
      ),
    ).toThrow(/!= 0|not.*zero/i)
  })

  it('throws when points contain duplicates', () => {
    expect(() =>
      Gf2_192Poly.interpolate(
        [3, 3],
        [Gf2_192Element.ONE, Gf2_192Element.ONE],
        Gf2_192Element.ZERO,
      ),
    ).toThrow(/duplicate/i)
  })

  it('throws when points contain a non-u8 value (out of range)', () => {
    expect(() =>
      Gf2_192Poly.interpolate(
        [256],
        [Gf2_192Element.ONE],
        Gf2_192Element.ZERO,
      ),
    ).toThrow(/u8/)
  })

  it('throws when fromCoefficientsAndConstant input length is not a multiple of 24', () => {
    expect(() =>
      Gf2_192Poly.fromCoefficientsAndConstant(
        new Uint8Array(23),
        Gf2_192Element.ZERO,
      ),
    ).toThrow(/24/)
  })

  it('throws when evaluate is called with non-u8 x', () => {
    const poly = Gf2_192Poly.interpolate(
      [1],
      [Gf2_192Element.ONE],
      Gf2_192Element.ZERO,
    )
    expect(() => poly.evaluate(256)).toThrow(/u8/)
    expect(() => poly.evaluate(-1)).toThrow(/u8/)
  })
})
