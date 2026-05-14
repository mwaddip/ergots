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

describe('EvalContext.addPerItemCost', () => {
  // Mirrors sigma-rust's add_per_item_jit_cost(base, per_chunk, chunk_size, n_items)
  // formula: base + ceil(n_items / chunk_size) * per_chunk
  it('charges base + ceil(nItems/chunkSize) * perChunk', () => {
    const ctx = makeContext()
    // BlockValue's call: addPerItemCost(1, 1, 10, items.length)
    ctx.addPerItemCost(1, 1, 10, 0)   // 1 + ceil(0/10)*1 = 1
    expect(ctx.jitCost).toBe(1)
    ctx.addPerItemCost(1, 1, 10, 5)   // 1 + ceil(5/10)*1 = 2
    expect(ctx.jitCost).toBe(3)
    ctx.addPerItemCost(1, 1, 10, 10)  // 1 + 1 = 2
    expect(ctx.jitCost).toBe(5)
    ctx.addPerItemCost(1, 1, 10, 11)  // 1 + 2 = 3
    expect(ctx.jitCost).toBe(8)
    ctx.addPerItemCost(1, 1, 10, 25)  // 1 + 3 = 4
    expect(ctx.jitCost).toBe(12)
  })
})
