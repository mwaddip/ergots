import { describe, it, expect } from 'vitest'
import { EvalError, makeContext } from '../../src/eval/eval-context'

describe('EvalError', () => {
  it('extends Error and carries a code', () => {
    const e = new EvalError('something went wrong', 'cost-limit-exceeded')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(EvalError)
    expect(e.message).toBe('something went wrong')
    expect(e.code).toBe('cost-limit-exceeded')
    expect(e.name).toBe('EvalError')
  })
})

describe('makeContext', () => {
  it('returns an EvalContext with default cost state', () => {
    const ctx = makeContext()
    expect(ctx.jitCost).toBe(0)
    expect(ctx.jitCostLimit).toBeUndefined()
    expect(ctx.constants).toBeUndefined()
  })

  it('accepts jitCostLimit and constants in opts', () => {
    const ctx = makeContext({ jitCostLimit: 1000, constants: [{ kind: 'Boolean', value: true }] })
    expect(ctx.jitCostLimit).toBe(1000)
    expect(ctx.constants).toEqual([{ kind: 'Boolean', value: true }])
  })
})

describe('EvalContext.addCost', () => {
  it('accumulates jitCost', () => {
    const ctx = makeContext()
    ctx.addCost(5)
    ctx.addCost(10)
    expect(ctx.jitCost).toBe(15)
  })

  it('throws cost-limit-exceeded when jitCost exceeds jitCostLimit', () => {
    const ctx = makeContext({ jitCostLimit: 10 })
    ctx.addCost(5)
    expect(() => ctx.addCost(6)).toThrow(EvalError)
    try {
      ctx.addCost(100)
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('cost-limit-exceeded')
    }
  })

  it('does not throw when jitCostLimit is undefined', () => {
    const ctx = makeContext()
    expect(() => ctx.addCost(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })

  it('saturates at MAX_SAFE_INTEGER (mirrors sigma-rust saturating_add)', () => {
    const ctx = makeContext()
    ctx.addCost(Number.MAX_SAFE_INTEGER)
    ctx.addCost(1000)
    expect(ctx.jitCost).toBe(Number.MAX_SAFE_INTEGER)
  })
})
