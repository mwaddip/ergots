import { describe, it, expect } from 'vitest'
import { umod } from '../../src/eval/_ubi-modular'
import { EvalError } from '../../src/eval/eval-context'
import { groupOrder } from '../../src/crypto/secp256k1'

function expectThrow(fn: () => unknown, code: string): void {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError)
  expect(threw?.code).toBe(code)
}

describe('umod — Euclidean modulo (v6 P2d-1)', () => {
  it('non-negative dividend: plain residue', () => {
    expect(umod(0n, 10n)).toBe(0n)
    expect(umod(24n, 10n)).toBe(4n)
    expect(umod(48n, 24n)).toBe(0n)
  })
  it('negative dividend: wraps into [0, m) (Euclidean, not JS remainder)', () => {
    expect(umod(-24n, 10n)).toBe(6n) // JS: -24 % 10 === -4; Euclidean === 6
    expect(umod(-7n, 10n)).toBe(3n)
  })
  it('large operands near 2^256 (secp256k1 group order)', () => {
    expect(umod(groupOrder * 2n, groupOrder)).toBe(0n)
    expect(umod(groupOrder + 5n, groupOrder)).toBe(5n)
  })
  it('m === 0n throws arith-divide-by-zero', () => {
    expectThrow(() => umod(5n, 0n), 'arith-divide-by-zero')
    expectThrow(() => umod(0n, 0n), 'arith-divide-by-zero')
  })
})
