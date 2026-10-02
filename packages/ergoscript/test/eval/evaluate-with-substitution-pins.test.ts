// evaluateWith is the evaluator's entry, and the interpreter's charges are reduceWith's (facts/ergoscript-eval.md,
// "The Deserialize substitution"). These pins hold what evaluateWith gives for the substitution-cost probe's spends:
// the substituted body's evaluation, with the flat 50 for a body that is a SigmaProp constant, and no charge for the
// tree's bytes or for a decode. SANTA's eval tier is blessed at this entry (CErgoTreeEvaluator.eval), so a charge
// that leaked in here would move its costs.
import { describe, it, expect } from 'vitest'
import { evaluateWith } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'
import { SPENDS, spendContext, type SpendName } from './_substitution-spends'

/** Each spend's JitCost through evaluateWith, at activated version 3. */
const JIT: Partial<Record<SpendName, number>> = {
  A1: 50, A3: 50, A5: 50, A6: 50, B: 50,
  C: 35, D: 35,
  H1: 28, H3: 28,
  I: 20,
  J1: 28, J2: 28, J3: 28, J4: 28,
  K1: 35, K3: 35, K5: 35,
  L1: 20, L2: 20, L3: 20,
  N1: 28, N2: 28,
  R8a: 50, SEG1: 50, T1: 50,
}

/** The spends that reject, with nothing charged: the substitution fails, or leaves a node that is then evaluated. */
const REJECTS: Partial<Record<SpendName, string>> = {
  L4: 'deserialize-parse-failed',
  R10a: 'deserialize-not-substituted',
}

describe('evaluateWith on the substitution-cost spends', () => {
  it('every spend is pinned', () => {
    expect([...Object.keys(JIT), ...Object.keys(REJECTS)].sort()).toEqual(Object.keys(SPENDS).sort())
  })

  it.each(Object.entries(JIT) as [SpendName, number][])('%s reduces to a SigmaProp at %i JitCost', (name, jit) => {
    const { tree, ctx } = spendContext(SPENDS[name], 3)
    expect(evaluateWith(tree, ctx).kind).toBe('SigmaProp')
    expect(ctx.jitCost).toBe(jit)
  })

  it.each(Object.entries(REJECTS) as [SpendName, string][])('%s rejects with %s, at no cost', (name, code) => {
    const { tree, ctx } = spendContext(SPENDS[name], 3)
    let err: unknown
    try { evaluateWith(tree, ctx) } catch (e) { err = e }
    expect(err).toBeInstanceOf(EvalError)
    expect((err as EvalError).code).toBe(code)
    expect(ctx.jitCost).toBe(0)
  })

  it('the activated version does not move its cost', () => {
    for (const activated of [0, 1, 2, 3]) {
      const { tree, ctx } = spendContext(SPENDS.C, activated)
      evaluateWith(tree, ctx)
      expect(ctx.jitCost).toBe(35)
    }
  })

  it('a context without a pre-header evaluates a tree with a Deserialize node', () => {
    const { tree, ctx } = spendContext(SPENDS.C, 3)
    ctx.preHeader = undefined
    expect(evaluateWith(tree, ctx).kind).toBe('SigmaProp')
    expect(ctx.jitCost).toBe(35)
  })
})
