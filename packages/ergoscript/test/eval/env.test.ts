import { describe, it, expect } from 'vitest'
import { Env } from '../../src/eval/env'

describe('Env', () => {
  it('Env.empty() has no bindings', () => {
    const env = Env.empty()
    expect(env.has(0)).toBe(false)
    expect(env.get(0)).toBeUndefined()
  })

  it('extend returns a new Env with the binding', () => {
    const env = Env.empty()
    const extended = env.extend(5, { kind: 'Int', value: 42 })
    expect(extended.has(5)).toBe(true)
    expect(extended.get(5)).toEqual({ kind: 'Int', value: 42 })
  })

  it('extend does NOT mutate the original Env', () => {
    const env = Env.empty()
    env.extend(5, { kind: 'Int', value: 42 })
    expect(env.has(5)).toBe(false)
  })

  it('extend supports overwriting existing bindings (last-write-wins)', () => {
    const env = Env.empty()
      .extend(1, { kind: 'Int', value: 10 })
      .extend(1, { kind: 'Int', value: 20 })
    expect(env.get(1)).toEqual({ kind: 'Int', value: 20 })
  })

  it('extend chains build a multi-binding scope', () => {
    const env = Env.empty()
      .extend(1, { kind: 'Int', value: 1 })
      .extend(2, { kind: 'Int', value: 2 })
      .extend(3, { kind: 'Int', value: 3 })
    expect(env.get(1)).toEqual({ kind: 'Int', value: 1 })
    expect(env.get(2)).toEqual({ kind: 'Int', value: 2 })
    expect(env.get(3)).toEqual({ kind: 'Int', value: 3 })
  })
})
