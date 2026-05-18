import { describe, it, expect } from 'vitest'
import { KNOWN_METHODS } from '../../scripts/_known-methods'

describe('KNOWN_METHODS', () => {
  it('has entries for all 2g.5-implemented method pairs', () => {
    expect(KNOWN_METHODS.get('99:8')?.name).toBe('SBox.tokens')
    expect(KNOWN_METHODS.get('99:8')?.implemented).toBe(true)
    expect(KNOWN_METHODS.get('99:8')?.implementedIn).toBe('2g.5')

    expect(KNOWN_METHODS.get('101:1')?.name).toBe('SContext.dataInputs')
    expect(KNOWN_METHODS.get('101:1')?.implemented).toBe(true)

    expect(KNOWN_METHODS.get('12:26')?.name).toBe('SColl.indexOf')
    expect(KNOWN_METHODS.get('12:26')?.implemented).toBe(true)
  })

  it('marks 2g.6 candidate methods as not implemented', () => {
    const candidates = ['12:14', '12:29', '12:30', '12:21', '12:15', '12:25']
    for (const key of candidates) {
      const entry = KNOWN_METHODS.get(key)
      expect(entry?.implemented).toBe(false)
    }
  })
})
