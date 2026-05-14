import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { ErgoTree } from '../../src/mir/types'

const treeWithConstBody = (): ErgoTree => ({
  header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
  constantTypes: [],
  constants: [],
  body: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
})

describe('evaluate', () => {
  it('routes through dispatch — currently throws not-implemented-yet for Const (chassis-only state)', () => {
    expect(() => evaluate(treeWithConstBody())).toThrow(EvalError)
    try {
      evaluate(treeWithConstBody())
    } catch (e) {
      expect((e as EvalError).code).toBe('not-implemented-yet')
    }
  })

  it('accepts EvalOpts with jitCostLimit + constants', () => {
    expect(() =>
      evaluate(treeWithConstBody(), { jitCostLimit: 1000, constants: [] })
    ).toThrow(EvalError)  // still 'not-implemented-yet' until Task 8
  })
})

describe('evaluateWith', () => {
  it('takes a pre-built EvalContext (caller can inspect ctx.jitCost after)', () => {
    const ctx = makeContext()
    expect(() => evaluateWith(treeWithConstBody(), ctx)).toThrow(EvalError)
    // ctx.jitCost remains 0 because dispatch threw before any addCost
    expect(ctx.jitCost).toBe(0)
  })
})
