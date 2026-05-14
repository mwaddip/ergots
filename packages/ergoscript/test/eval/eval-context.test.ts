import { describe, it, expect } from 'vitest'
import { EvalError } from '../../src/eval/eval-context'

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
