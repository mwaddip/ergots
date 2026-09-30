import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parsePropertyCall, serializePropertyCall } from '../../src/wire/mir/property-call'
import { ExprParseError } from '../../src/wire/errors'
import type { PropertyCall, SType } from '../../src/mir/types'

describe('PropertyCall explicit type args', () => {
  it('round-trips none[Byte] (typeId 106, methodId 10) with explicit T=SByte', () => {
    // Global.none exists from tree v3, so the payload is read at v3. The JVM decodes
    // `db 6a 0a dd 02` at v3 as Global.none[Byte], an Option[Byte] (a local sigma-state 6.0.6 probe,
    // decode mode).
    const node: PropertyCall = {
      tag: 'PropertyCall', obj: { tag: 'Global' }, typeId: 106, methodId: 10,
      explicitTypeArgs: { T: { tag: 'SByte' } as SType },
    }
    const w = new ByteWriter(); serializePropertyCall(node, w, 3)
    const bytes = w.toBytes()
    const parsed = parsePropertyCall(new ByteReader(bytes), [], [], new Map(), 3)
    expect(parsed.typeId).toBe(106)
    expect(parsed.methodId).toBe(10)
    expect(parsed.explicitTypeArgs).toEqual({ T: { tag: 'SByte' } })
    const w2 = new ByteWriter(); serializePropertyCall(parsed, w2, 3)
    expect(w2.toBytes()).toEqual(bytes) // byte-roundtrip
  })

  it('below v3, none[Byte] fails the method lookup before its type argument is read (rule 1016)', () => {
    // SMethod.fromIds (PropertyCallSerializer.scala:34) finds no method 10 in Global's v0-v2 table. The JVM
    // rejects the same payload at v0 with the ValidationException of rule 1016 (a local sigma-state 6.0.6
    // probe, decode mode).
    const w = new ByteWriter()
    serializePropertyCall({
      tag: 'PropertyCall', obj: { tag: 'Global' }, typeId: 106, methodId: 10,
      explicitTypeArgs: { T: { tag: 'SByte' } as SType },
    }, w, 3)
    let err: unknown
    try {
      parsePropertyCall(new ByteReader(w.toBytes()), [], [], new Map(), 0)
    } catch (x) {
      err = x
    }
    expect(err).toBeInstanceOf(ExprParseError)
    expect((err as ExprParseError).code).toBe('method-unknown')
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
