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
    const { bytes, numConstants } = substituteConstantsBytes(template, [0], [{ tpe: SINT, value: intVal(0) }], 0, undefined)
    expect(Array.from(bytes)).toEqual([0x00, 0x00, 0x08, 0xd3])
    expect(numConstants).toBe(0)
  })

  it('seg-on template substitutes the constant while copying an unparseable body', () => {
    // header 0x10 (seg), count 1, SInt const (=5), body [0xFF,0xFF] (invalid Expr).
    const template = new Uint8Array([0x10, 0x01, 0x04, 0x0a, 0xff, 0xff])
    const r7 = substituteConstantsBytes(template, [0], [{ tpe: SINT, value: intVal(7) }], 0, undefined)
    const r9 = substituteConstantsBytes(template, [0], [{ tpe: SINT, value: intVal(9) }], 0, undefined)
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
    const dup = substituteConstantsBytes(template, [0, 0], [{ tpe: SINT, value: A }, { tpe: SINT, value: B }], 0, undefined)
    const firstOnly = substituteConstantsBytes(template, [0], [{ tpe: SINT, value: A }], 0, undefined)
    const secondOnly = substituteConstantsBytes(template, [0], [{ tpe: SINT, value: B }], 0, undefined)
    // JVM is first-wins: dup == apply(A), and != apply(B).
    expect(Array.from(dup.bytes)).toEqual(Array.from(firstOnly.bytes))
    expect(Array.from(dup.bytes)).not.toEqual(Array.from(secondOnly.bytes))
  })
})

describe('substituteConstantsBytes — out-of-range positions are a no-op', () => {
  const template = new Uint8Array([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad])
  it('position >= numConstants leaves the template unchanged', () => {
    const { bytes } = substituteConstantsBytes(template, [5], [{ tpe: SINT, value: intVal(7) }], 0, undefined)
    expect(Array.from(bytes)).toEqual([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad])
  })
  it('negative position leaves the template unchanged', () => {
    const { bytes } = substituteConstantsBytes(template, [-1], [{ tpe: SINT, value: intVal(7) }], 0, undefined)
    expect(Array.from(bytes)).toEqual([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad])
  })
})

describe('substituteConstantsBytes — type-equality + length guards', () => {
  const template = new Uint8Array([0x10, 0x01, 0x04, 0x0a, 0xde, 0xad]) // SInt const
  it('throws when a value\'s type differs from the constant type', () => {
    expect(() =>
      substituteConstantsBytes(template, [0], [{ tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 7n } }], 0, undefined),
    ).toThrow(/type mismatch/)
  })
  it('throws when positions and newValues lengths differ', () => {
    expect(() => substituteConstantsBytes(template, [0, 0], [{ tpe: SINT, value: intVal(7) }], 0, undefined)).toThrow(/length/)
  })
})

describe('SubstConstants header read (deserializeHeaderWithTreeBytes, ErgoTreeSerializer.scala:269-274)', () => {
  const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
  const codeOf = (f: () => unknown) => { try { f(); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }
  it('a declared size above 2^32-1 is rejected (getUInt)', () => {
    expect(codeOf(() => substituteConstantsBytes(hex('18808080801000' + '08d3'), [], [], 0, undefined))).toBe('vlq-overflow')
  })
  it('a constants count that wraps negative gives no constants', () => {
    const out = substituteConstantsBytes(hex('10' + '8080808008' + '08d3'), [], [], 0, undefined)
    expect(out.numConstants).toBe(0)
  })
})

describe('substituteConstantsBytes: each constant of newConstants has its own type', () => {
  const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
  const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  const codeOf = (f: () => unknown) => { try { f(); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }
  const SLONG: SType = { tag: 'SLong' }
  const SSTRING: SType = { tag: 'SString' }
  // Constants 1: Int, "A": String, 2: Int; body 73 00.
  const THREE = hex('1003040266014104047300')
  // One Int constant, 1; body 73 00.
  const ONE = hex('100104027300')

  // JVM-blessed bytes: SANTA vectors/eval/v6/authored/SubstConstants.lift_by_class_v6.json at 0f2fc79, row
  // `string-tuple-const-written-012-v0-a3#1252` (the tuple constant (5, "C", 6) over the constants 1, "A", 2).
  it('writes each named constant by the type of its value (ErgoTreeSerializer.scala:356-358)', () => {
    const { bytes, numConstants } = substituteConstantsBytes(
      THREE,
      [0, 1, 2],
      [
        { tpe: SINT, value: intVal(5) },
        { tpe: SSTRING, value: { kind: 'String', value: 'C' } },
        { tpe: SINT, value: intVal(6) },
      ],
      0,
      undefined,
    )
    expect(toHex(bytes)).toBe('1003040a660143040c7300')
    expect(numConstants).toBe(3)
  })

  it('refuses a value whose type differs from the type of the constant it names', () => {
    expect(
      codeOf(() => substituteConstantsBytes(THREE, [0, 1, 2], [{ tpe: SINT, value: intVal(5) }, { tpe: SINT, value: intVal(10) }, { tpe: SINT, value: intVal(6) }], 0, undefined)),
    ).toBe('subst-type-mismatch')
  })

  it('two positions naming one constant: the first value and its type are taken', () => {
    const first = substituteConstantsBytes(ONE, [0, 0], [{ tpe: SINT, value: intVal(7) }, { tpe: SLONG, value: { kind: 'Long', value: 9n } }], 0, undefined)
    const alone = substituteConstantsBytes(ONE, [0], [{ tpe: SINT, value: intVal(7) }], 0, undefined)
    expect(toHex(first.bytes)).toBe(toHex(alone.bytes))
    expect(toHex(first.bytes)).toBe('1001040e7300')
  })

  it('two positions naming one constant: a first value of another type refuses', () => {
    expect(
      codeOf(() => substituteConstantsBytes(ONE, [0, 0], [{ tpe: SLONG, value: { kind: 'Long', value: 9n } }, { tpe: SINT, value: intVal(7) }], 0, undefined)),
    ).toBe('subst-type-mismatch')
  })

  it('a value that no position names is neither compared nor written', () => {
    const { bytes } = substituteConstantsBytes(ONE, [5], [{ tpe: SLONG, value: { kind: 'Long', value: 9n } }], 0, undefined)
    expect(toHex(bytes)).toBe('100104027300')
  })
})
