/**
 * Unit tests for `_sigma-helpers.ts`: `expectSigmaProp`.
 *
 * The helper has three callers: `SigmaAnd` (`sigma-and.ts`), `SigmaOr`
 * (`sigma-or.ts`), and `AtLeast`'s defensive per-item check after the array
 * cast (`atleast.ts`).
 *
 * Source cross-reference: `data/shared/src/main/scala/sigma/ast/trees.scala`
 * — `SigmaAnd.eval`, `SigmaOr.eval`, `AtLeast.eval`.
 */
import { describe, expect, it } from 'vitest'
import { expectSigmaProp } from '../../src/eval/_sigma-helpers'

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
