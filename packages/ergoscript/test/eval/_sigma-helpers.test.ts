/**
 * Unit tests for `_sigma-helpers.ts`: `expectSigmaProp` + `extractSigmaPropColl`.
 *
 * These helpers are promoted ahead of the YAGNI threshold because they have
 * 3 callers across 3 files in Tasks 4-6 (Atleast, SigmaAnd, SigmaOr).
 *
 * Design: PLAN.md Task 4, Step 2.
 * Source cross-reference: ergotree-interpreter/src/eval/atleast.rs:31-46
 */
import { describe, expect, it } from 'vitest'
import { expectSigmaProp, extractSigmaPropColl } from '../../src/eval/_sigma-helpers'

describe('expectSigmaProp', () => {
  it('returns inner SigmaBoolean on success', () => {
    const sb = { tag: 'TrivialProp' as const, value: true }
    expect(expectSigmaProp({ kind: 'SigmaProp', value: sb }, 'test')).toEqual(sb)
  })
  it('throws sigma-prop-coll-elem-not-sigma-prop on non-SigmaProp', () => {
    expect(() => expectSigmaProp({ kind: 'Int', value: 42 }, 'test')).toThrow(
      expect.objectContaining({ code: 'sigma-prop-coll-elem-not-sigma-prop' }),
    )
  })
})

describe('extractSigmaPropColl', () => {
  it('returns SigmaBoolean[] on Coll[SigmaProp] input', () => {
    const sb1 = { tag: 'TrivialProp' as const, value: true }
    const sb2 = { tag: 'TrivialProp' as const, value: false }
    const value = {
      kind: 'Coll' as const,
      elem: { tag: 'SSigmaProp' as const },
      items: [
        { kind: 'SigmaProp' as const, value: sb1 },
        { kind: 'SigmaProp' as const, value: sb2 },
      ],
    }
    expect(extractSigmaPropColl(value, 'test')).toEqual([sb1, sb2])
  })
  it('throws sigma-prop-input-not-coll on non-Coll', () => {
    expect(() =>
      extractSigmaPropColl({ kind: 'Int', value: 42 }, 'test'),
    ).toThrow(expect.objectContaining({ code: 'sigma-prop-input-not-coll' }))
  })
  it('throws sigma-prop-coll-elem-not-sigma-prop on non-SigmaProp item', () => {
    const value = {
      kind: 'Coll' as const,
      elem: { tag: 'SAny' as const },
      items: [{ kind: 'Int' as const, value: 42 }],
    }
    expect(() => extractSigmaPropColl(value, 'test')).toThrow(
      expect.objectContaining({ code: 'sigma-prop-coll-elem-not-sigma-prop' }),
    )
  })
})
