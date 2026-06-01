/**
 * substituteConstantsBytes — serializer-level constant substitution (wire layer).
 *
 * CONSENSUS-CRITICAL: output bytes go on-chain. Mirrors JVM
 * `ErgoTreeSerializer.substituteConstants` (sigma-state 6.0.3): the header +
 * constants segment are re-serialized, the body is copied VERBATIM (never
 * parsed). The JVM-blessed end-to-end byte-equality oracle is the SANTA
 * conformance vector (`test/conformance/cost-v5.test.ts`,
 * `substConstants_equivalence.json`, entries #0–#6). These unit tests cover the
 * primitive in isolation + the duplicate-position case, which has no SANTA
 * vector.
 *
 * Templates here use a single SInt constant (`04 0a` = SInt(5)) because SInt
 * round-trips trivially; the body bytes are arbitrary (and deliberately
 * non-Expr in the "verbatim" tests) to prove the body is never parsed.
 */
import { describe, it, expect } from 'vitest'
import { substituteConstantsBytes } from '../../src/wire/ergo-tree'
import type { SType, SValue } from '../../src/mir/types'

const SINT: SType = { tag: 'SInt' }
const intVal = (value: number): SValue => ({ kind: 'Int', value })

describe('substituteConstantsBytes — body copied verbatim (never parsed)', () => {
  it('seg-off template with an unparseable body returns bytes unchanged (JVM #1)', () => {
    // header 0x00 (seg off) → 0 constants; body [0x00,0x08,0xD3] is not a valid
    // Expr (leads with opcode 0x00). JVM copies it verbatim and position 0 is
    // out of range (0 constants) → no-op. The parseTree-based path throws here.
    const template = new Uint8Array([0x00, 0x00, 0x08, 0xd3])
    const { bytes, numConstants } = substituteConstantsBytes(template, [0], [intVal(0)], SINT, 0)
    expect(Array.from(bytes)).toEqual([0x00, 0x00, 0x08, 0xd3])
    expect(numConstants).toBe(0)
  })

  it('seg-on template substitutes the constant while copying an unparseable body', () => {
    // header 0x10 (seg), count 1, SInt const (=5), body [0xFF,0xFF] (invalid Expr).
    const template = new Uint8Array([0x10, 0x01, 0x04, 0x0a, 0xff, 0xff])
    const r7 = substituteConstantsBytes(template, [0], [intVal(7)], SINT, 0)
    const r9 = substituteConstantsBytes(template, [0], [intVal(9)], SINT, 0)
    // the substitution actually changed the constant bytes...
    expect(Array.from(r7.bytes)).not.toEqual(Array.from(r9.bytes))
    // ...and the unparseable body survived verbatim in both.
    expect(Array.from(r7.bytes.slice(-2))).toEqual([0xff, 0xff])
    expect(Array.from(r9.bytes.slice(-2))).toEqual([0xff, 0xff])
    expect(r7.numConstants).toBe(1)
  })
})

describe('substituteConstantsBytes — duplicate positions are first-wins (JVM getPositionsBackref)', () => {
  it('positions [0,0] applies newValues[0] and ignores newValues[1]', () => {
    const template = new Uint8Array([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad])
    const A = intVal(7)
    const B = intVal(9)
    const dup = substituteConstantsBytes(template, [0, 0], [A, B], SINT, 0)
    const firstOnly = substituteConstantsBytes(template, [0], [A], SINT, 0)
    const secondOnly = substituteConstantsBytes(template, [0], [B], SINT, 0)
    // JVM is first-wins: dup == apply(A), and != apply(B).
    expect(Array.from(dup.bytes)).toEqual(Array.from(firstOnly.bytes))
    expect(Array.from(dup.bytes)).not.toEqual(Array.from(secondOnly.bytes))
  })
})

describe('substituteConstantsBytes — out-of-range positions are a no-op', () => {
  const template = new Uint8Array([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad])
  it('position >= numConstants leaves the template unchanged', () => {
    const { bytes } = substituteConstantsBytes(template, [5], [intVal(7)], SINT, 0)
    expect(Array.from(bytes)).toEqual([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad])
  })
  it('negative position leaves the template unchanged', () => {
    const { bytes } = substituteConstantsBytes(template, [-1], [intVal(7)], SINT, 0)
    expect(Array.from(bytes)).toEqual([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad])
  })
})

describe('substituteConstantsBytes — type-equality + length guards', () => {
  const template = new Uint8Array([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad]) // SInt const
  it('throws when newValues elem type differs from the constant type', () => {
    expect(() =>
      substituteConstantsBytes(template, [0], [{ kind: 'Long', value: 7n }], { tag: 'SLong' }, 0),
    ).toThrow(/type mismatch/)
  })
  it('throws when positions and newValues lengths differ', () => {
    expect(() => substituteConstantsBytes(template, [0, 0], [intVal(7)], SINT, 0)).toThrow(/length/)
  })
})
