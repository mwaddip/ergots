import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { ErgoTree } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

const treeWithConstBody = (): ErgoTree => ({
  header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
  constantTypes: [],
  constants: [],
  body: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
})

// A tree whose body is an unported variant — `Append`. `Const` itself is
// wired (Task 8), so the previous "anything throws" form no longer
// observes the dispatch path. `Append` keeps falling through to the
// `not-implemented-yet` arm until its own per-arm task lands.
const treeWithAppendBody = (): ErgoTree => {
  const innerColl = {
    tag: 'Const' as const,
    tpe: { tag: 'SColl' as const, elem: { tag: 'SInt' as const } },
    value: { kind: 'Coll' as const, elem: { tag: 'SInt' as const }, items: [] },
  }
  return {
    header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
    constantTypes: [],
    constants: [],
    body: { tag: 'Append', input: innerColl, col2: innerColl },
  }
}

describe('evaluate', () => {
  it('routes through dispatch — Const body returns the literal and charges 5', () => {
    const tree = treeWithConstBody()
    const ctx = makeContext()
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'Int', value: 42 })
    expect(ctx.jitCost).toBe(5)
  })

  it('accepts EvalOpts with jitCostLimit + constants and still produces the value', () => {
    const value = evaluate(treeWithConstBody(), { jitCostLimit: 1000, constants: [] })
    expect(value).toEqual({ kind: 'Int', value: 42 })
  })

  it('honors jitCostLimit — throws cost-limit-exceeded when the per-Const charge of 5 overflows', () => {
    // Limit < 5 forces the very first add to overshoot.
    const err = captureEvalError(() => evaluate(treeWithConstBody(), { jitCostLimit: 4 }))
    expect(err.code).toBe('cost-limit-exceeded')
  })

  it('still throws not-implemented-yet for variants with no arm wired (e.g. Append)', () => {
    const err = captureEvalError(() => evaluate(treeWithAppendBody()))
    expect(err.code).toBe('not-implemented-yet')
  })
})

describe('evaluateWith', () => {
  it('takes a pre-built EvalContext (caller can inspect ctx.jitCost after)', () => {
    const ctx = makeContext()
    const value = evaluateWith(treeWithConstBody(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 42 })
    expect(ctx.jitCost).toBe(5)
  })

  it('leaves ctx.jitCost at 0 if dispatch throws before any addCost runs', () => {
    const ctx = makeContext()
    expect(() => evaluateWith(treeWithAppendBody(), ctx)).toThrow(EvalError)
    expect(ctx.jitCost).toBe(0)
  })
})
