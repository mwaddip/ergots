import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSType } from '../../src/wire/parse-stype'
import { serializeSType } from '../../src/wire/serialize-stype'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import type { SType, SValue } from '../../src/mir/types'

const UBI: SType = { tag: 'SUnsignedBigInt' }
function enc(v: bigint): Uint8Array {
  const w = new ByteWriter()
  serializeSValue(UBI, { kind: 'UnsignedBigInt', value: v }, 3, w)
  return w.toBytes()
}
function dec(bytes: Uint8Array): SValue {
  return parseSValue(UBI, 3, new ByteReader(bytes))
}

describe('SUnsignedBigInt value codec (unsigned magnitude BE)', () => {
  it('0 -> wire 00 (VLQ len 0, no value bytes) — NOT [0x00] value', () => {
    expect(enc(0n)).toEqual(new Uint8Array([0x00]))           // wire = length byte 0, no value bytes
    expect(dec(new Uint8Array([0x00]))).toEqual({ kind: 'UnsignedBigInt', value: 0n })
  })
  it('128 -> [0x80] (1 byte, no sign pad) — differs from SBigInt [0x00,0x80]', () => {
    expect(enc(128n)).toEqual(new Uint8Array([0x01, 0x80]))   // len 1 + 0x80
    expect(dec(new Uint8Array([0x01, 0x80]))).toEqual({ kind: 'UnsignedBigInt', value: 128n })
  })
  it('5 -> [0x05]', () => {
    expect(enc(5n)).toEqual(new Uint8Array([0x01, 0x05]))
  })
  it('2^256-1 -> 32 x 0xFF', () => {
    const v = (1n << 256n) - 1n
    expect(enc(v)).toEqual(new Uint8Array([32, ...Array(32).fill(0xff)]))
    expect(dec(enc(v))).toEqual({ kind: 'UnsignedBigInt', value: v })
  })
  it('decode rejects > 32 value bytes', () => {
    const bytes = new Uint8Array([33, ...Array(33).fill(0xff)])
    expect(() => dec(bytes)).toThrow()
  })
  it('non-canonical [0x00,0x05] decodes to 5 (re-encodes [0x05])', () => {
    expect(dec(new Uint8Array([0x02, 0x00, 0x05]))).toEqual({ kind: 'UnsignedBigInt', value: 5n })
  })
})

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
