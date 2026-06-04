import { describe, expect, it } from 'vitest'
import { encodeCompactBits } from '../../src/eval/_nbits'

describe('encodeCompactBits — JVM NBitsUtils port (v6 P5b-2)', () => {
  // JVM-blessed (LanguageSpecificationV6.scala:2385-2387), positive path.
  it('JVM-blessed positive vectors', () => {
    expect(encodeCompactBits(1146584469340160n)).toBe(117707472n)
    expect(encodeCompactBits(0x130e0n << 168n)).toBe(0x180130e0n)
    expect(encodeCompactBits(0x7fffffn << 232n)).toBe(0x207fffffn)
  })
  // sigma-rust ergo-node-integration cross-check (test_eval_encode_nbits).
  it('positive round-trip of a blessed decode vector', () => {
    expect(encodeCompactBits(0x12345600n)).toBe(0x04123456n)
  })
  it('negative input is not a clean inverse (sign-bit carry quirk)', () => {
    expect(encodeCompactBits(-0x12345600n)).toBe(-0x1235n)
  })
  it('zero encodes with size byte 1', () => {
    expect(encodeCompactBits(0n)).toBe(0x01000000n)
  })
})
