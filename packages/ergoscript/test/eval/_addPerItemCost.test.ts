/**
 * Unit tests for EvalContext.addPerItemCost.
 *
 * Formula (sigma-rust `ergotree-ir/src/chain/context.rs`, commit f6b2dd7f —
 * Scala consensus PerItemCost.chunks):
 *   chunks = (nItems - 1) / chunkSize + 1   (signed, toward-zero division)
 *   cost   = base + chunks * perChunk
 * Equals ceil(nItems / chunkSize) for nItems >= 1; differs only at nItems=0.
 *
 * Edge:
 *   items=0, chunkSize>=2 → chunks=1 → cost = base + perChunk (the JVM charges 1 chunk).
 *   items=0, chunkSize==1 → chunks=0 → cost = base only.
 *   items=chunkSize → chunks=1 → cost = base + perChunk.
 *   items=chunkSize+1 → chunks=2 → cost = base + 2*perChunk.
 */
import { describe, it, expect } from 'vitest'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'

describe('EvalContext.addPerItemCost', () => {
  it('charges base + one chunk when items=0 and chunkSize>=2 (Scala n=0 ⇒ 1 chunk)', () => {
    // items=0, chunkSize=100 → (0-1)/100+1 = 1 chunk → cost = 20 + 2*1 = 22
    const ctx = makeContext()
    ctx.addPerItemCost(20, 2, 100, 0)
    expect(ctx.jitCost).toBe(22)
  })

  it('charges only base when items=0 and chunkSize==1', () => {
    // items=0, chunkSize=1 → (0-1)/1+1 = 0 chunks → cost = 20 + 2*0 = 20
    const ctx = makeContext()
    ctx.addPerItemCost(20, 2, 1, 0)
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
    // limit=25; first call cost=22 (n=0, chunkSize=100 ⇒ 1 chunk) → jitCost=22 ≤ 25 OK;
    // second call → 44 > 25 → throws
    const ctx = makeContext({ jitCostLimit: 25 })
    ctx.addPerItemCost(20, 2, 100, 0) // cost=22, jitCost=22, under limit
    const err = captureEvalError(() => ctx.addPerItemCost(20, 2, 100, 0))
    expect(err.code).toBe('cost-limit-exceeded')
  })
})
