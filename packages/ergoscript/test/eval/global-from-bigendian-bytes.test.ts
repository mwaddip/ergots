import { describe, expect, it } from 'vitest'
import { evalGlobalFromBigEndianBytes } from '../../src/eval/global-from-bigendian-bytes'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SType, SValue } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const FAIL = 'global-from-bigendian-bytes-failed'

/** Build a Coll[Byte] SValue from raw u8 values (sign-extended like the parser). */
function collByte(bytes: number[]): SValue {
  return { kind: 'Coll', elem: SBYTE, items: bytes.map((b) => ({ kind: 'Byte', value: (b << 24) >> 24 })) }
}

/** Direct handler call. `ctx` is returned for cost assertions. */
function decode(T: SType, bytes: number[], ctx = makeContext({ treeVersion: 3 })): SValue {
  return evalGlobalFromBigEndianBytes({ kind: 'Global' }, [collByte(bytes)], ctx, { T })
}

/** Assert a direct call throws EvalError with the given code. */
function expectFail(T: SType, bytes: number[], code: string): void {
  try {
    decode(T, bytes)
    throw new Error('expected EvalError, but the call returned')
  } catch (e) {
    expect(e).toBeInstanceOf(EvalError)
    expect((e as EvalError).code).toBe(code)
  }
}

describe('Global.fromBigEndianBytes (106:5) — fixed-width', () => {
  it('Byte: 1 byte, signed', () => {
    expect(decode({ tag: 'SByte' }, [0x7f])).toEqual({ kind: 'Byte', value: 127 })
    expect(decode({ tag: 'SByte' }, [0xff])).toEqual({ kind: 'Byte', value: -1 })
  })
  it('Short: 2 bytes big-endian, signed', () => {
    expect(decode({ tag: 'SShort' }, [0x00, 0x01])).toEqual({ kind: 'Short', value: 1 })
    expect(decode({ tag: 'SShort' }, [0xff, 0xff])).toEqual({ kind: 'Short', value: -1 })
    expect(decode({ tag: 'SShort' }, [0x80, 0x00])).toEqual({ kind: 'Short', value: -32768 })
  })
  it('Int: 4 bytes big-endian, signed', () => {
    expect(decode({ tag: 'SInt' }, [0x00, 0x00, 0x00, 0x05])).toEqual({ kind: 'Int', value: 5 })
    expect(decode({ tag: 'SInt' }, [0xff, 0xff, 0xff, 0xff])).toEqual({ kind: 'Int', value: -1 })
    expect(decode({ tag: 'SInt' }, [0x80, 0x00, 0x00, 0x00])).toEqual({ kind: 'Int', value: -2147483648 })
  })
  it('Long: 8 bytes big-endian, signed', () => {
    expect(decode({ tag: 'SLong' }, [0, 0, 0, 0, 0, 0, 0, 7])).toEqual({ kind: 'Long', value: 7n })
    expect(decode({ tag: 'SLong' }, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).toEqual({ kind: 'Long', value: -1n })
  })
  it('charges FixedCost(10) (handler-local, before decode)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    decode({ tag: 'SInt' }, [0, 0, 0, 1], ctx)
    expect(ctx.jitCost).toBe(10)
  })
  it('rejects wrong exact length per fixed-width type', () => {
    expectFail({ tag: 'SByte' }, [], FAIL)
    expectFail({ tag: 'SByte' }, [1, 2], FAIL)
    expectFail({ tag: 'SShort' }, [1], FAIL)
    expectFail({ tag: 'SInt' }, [1, 2, 3], FAIL)
    expectFail({ tag: 'SLong' }, [1, 2, 3, 4, 5, 6, 7], FAIL)
  })
  it('charges FixedCost(10) even when length validation fails', () => {
    const ctx = makeContext({ treeVersion: 3 })
    try { decode({ tag: 'SInt' }, [1, 2, 3], ctx) } catch { /* expected */ }
    expect(ctx.jitCost).toBe(10)
  })
})
