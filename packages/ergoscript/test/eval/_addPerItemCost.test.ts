/**
 * Unit tests for EvalContext.addPerItemCost.
 *
 * Formula (sigma-rust `ergotree-ir/src/chain/context.rs:88-99`):
 *   chunks = ceil(nItems / chunkSize) = (nItems + chunkSize - 1) / chunkSize
 *   cost   = base + chunks * perChunk
 *
 * Edge:
 *   items=0 → chunks=0 (ceil(0/N) = 0) → cost = base only.
 *   items=chunkSize → chunks=1 → cost = base + perChunk.
 *   items=chunkSize+1 → chunks=2 → cost = base + 2*perChunk.
 */
import { describe, it, expect } from 'vitest'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'

describe('EvalContext.addPerItemCost', () => {
  it('charges only base when items=0', () => {
    // items=0 → ceil(0/100)=0 → cost = 20 + 2*0 = 20
    const ctx = makeContext()
    ctx.addPerItemCost(20, 2, 100, 0)
    expect(ctx.jitCost).toBe(20)
  })

  it('charges base + perChunk when items=chunkSize (exactly 1 chunk)', () => {
    // items=100 → ceil(100/100)=1 → cost = 20 + 2*1 = 22
    const ctx = makeContext()
    ctx.addPerItemCost(20, 2, 100, 100)
    expect(ctx.jitCost).toBe(22)
  })

  it('charges base + 2*perChunk when items=chunkSize+1 (spills into second chunk)', () => {
    // items=101 → ceil(101/100)=2 → cost = 20 + 2*2 = 24
    const ctx = makeContext()
    ctx.addPerItemCost(20, 2, 100, 101)
    expect(ctx.jitCost).toBe(24)
  })

  it('charges base + N*perChunk when items=N*chunkSize (10 full chunks)', () => {
    // items=1000 → ceil(1000/100)=10 → cost = 20 + 2*10 = 40
    const ctx = makeContext()
    ctx.addPerItemCost(20, 2, 100, 1000)
    expect(ctx.jitCost).toBe(40)
  })

  it('throws cost-limit-exceeded when accumulator would overflow jitCostLimit', () => {
    // limit=25; base=20 → first call OK (jitCost=20); second call base=10 → 20+10=30 > 25 → throws
    const ctx = makeContext({ jitCostLimit: 25 })
    ctx.addPerItemCost(20, 2, 100, 0) // cost=20, jitCost=20, under limit
    const err = captureEvalError(() => ctx.addPerItemCost(20, 2, 100, 0))
    expect(err.code).toBe('cost-limit-exceeded')
  })
})
