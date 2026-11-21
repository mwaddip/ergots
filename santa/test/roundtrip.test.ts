import { describe, it, expect } from 'vitest'
import { decodeSValue } from '../src/decode'
import { encodeSValue } from '../src/encode'
import type { Json } from '../src/json'

type JsonObj = { [k: string]: Json }

const fixtures: JsonObj[] = [
  { kind: 'Boolean', value: true },
  { kind: 'Byte', value: -5 },
  { kind: 'Int', value: 2147483647 },
  { kind: 'Long', value: '-9223372036854775808' },
  { kind: 'BigInt', value: '170141183460469231731687303715884105727' },
  { kind: 'GroupElement', bytes_hex: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' },
  { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }] },
  { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Boolean', value: false }] },
  { kind: 'Option', value: { kind: 'Long', value: '7' } },
]

describe('SANTA JSON → decode → encode → identical', () => {
  for (const f of fixtures) {
    it(JSON.stringify(f), () => {
      const { value } = decodeSValue(f, 3)
      expect(encodeSValue(value, 3)).toEqual(f)
    })
  }
  // Option None has no decode (elem unrecoverable from JSON); test encode-only.
  it('Option None encodes from an ergots None', () => {
    expect(encodeSValue({ kind: 'Option', elem: { tag: 'SInt' }, value: null }, 3))
      .toEqual({ kind: 'Option', value: null })
  })
})
