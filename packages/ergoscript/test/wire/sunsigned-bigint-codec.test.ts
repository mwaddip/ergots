import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSType } from '../../src/wire/parse-stype'
import { serializeSType } from '../../src/wire/serialize-stype'
import type { SType } from '../../src/mir/types'

describe('SUnsignedBigInt type code (9)', () => {
  it('parses embeddable type code 9 as SUnsignedBigInt', () => {
    const r = new ByteReader(new Uint8Array([9]))
    expect(parseSType(r)).toEqual({ tag: 'SUnsignedBigInt' })
  })
  it('serializes SUnsignedBigInt to code 9', () => {
    const w = new ByteWriter()
    serializeSType({ tag: 'SUnsignedBigInt' }, w)
    expect(w.toBytes()).toEqual(new Uint8Array([9]))
  })
  it('round-trips Coll[SUnsignedBigInt] (compact form code 12+9=21)', () => {
    const t: SType = { tag: 'SColl', elem: { tag: 'SUnsignedBigInt' } }
    const w = new ByteWriter()
    serializeSType(t, w)
    const bytes = w.toBytes()
    expect(bytes).toEqual(new Uint8Array([21]))
    expect(parseSType(new ByteReader(bytes))).toEqual(t)
  })
})
