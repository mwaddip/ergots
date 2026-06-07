import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parsePropertyCall, serializePropertyCall } from '../../src/wire/mir/property-call'
import type { PropertyCall, SType } from '../../src/mir/types'

describe('PropertyCall explicit type args', () => {
  it('round-trips none[Byte] (typeId 106, methodId 10) with explicit T=SByte', () => {
    const node: PropertyCall = {
      tag: 'PropertyCall', obj: { tag: 'Global' }, typeId: 106, methodId: 10,
      explicitTypeArgs: { T: { tag: 'SByte' } as SType },
    }
    const w = new ByteWriter(); serializePropertyCall(node, w, 0)
    const bytes = w.toBytes()
    const parsed = parsePropertyCall(new ByteReader(bytes), [], [], new Map(), 0)
    expect(parsed.typeId).toBe(106)
    expect(parsed.methodId).toBe(10)
    expect(parsed.explicitTypeArgs).toEqual({ T: { tag: 'SByte' } })
    const w2 = new ByteWriter(); serializePropertyCall(parsed, w2, 0)
    expect(w2.toBytes()).toEqual(bytes) // byte-roundtrip
  })

  it('round-trips a no-type-arg PropertyCall (groupGenerator 106:1) unchanged', () => {
    const node: PropertyCall = { tag: 'PropertyCall', obj: { tag: 'Global' }, typeId: 106, methodId: 1, explicitTypeArgs: {} }
    const w = new ByteWriter(); serializePropertyCall(node, w, 0)
    const bytes = w.toBytes()
    const parsed = parsePropertyCall(new ByteReader(bytes), [], [], new Map(), 0)
    expect(parsed.explicitTypeArgs).toEqual({}) // registry has no names for 106:1; no bytes consumed
    const w2 = new ByteWriter(); serializePropertyCall(parsed, w2, 0)
    expect(w2.toBytes()).toEqual(bytes)
  })
})
