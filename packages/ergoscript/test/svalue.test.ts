import { describe, it, expect } from 'vitest'
import type { SValue } from '../src/mir/types'

describe('SValue', () => {
  it('Boolean variant', () => {
    const v: SValue = { kind: 'Boolean', value: true }
    expect(v.kind).toBe('Boolean')
    expect(v.value).toBe(true)
  })
  it('Long variant uses bigint', () => {
    const v: SValue = { kind: 'Long', value: 1234567890123456789n }
    expect(v.value).toBe(1234567890123456789n)
  })
  it('Coll variant carries element type', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: { tag: 'SInt' },
      items: [
        { kind: 'Int', value: 1 },
        { kind: 'Int', value: 2 },
      ],
    }
    expect(v.items.length).toBe(2)
    expect(v.elem.tag).toBe('SInt')
  })
})
