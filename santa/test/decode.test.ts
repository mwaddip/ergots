import { describe, it, expect } from 'vitest'
import { tupleColl } from '@ergots/ergoscript'
import { decodeSValue } from '../src/decode'

describe('decode — value + tpe', () => {
  it('Int → {value, tpe SInt}', () => {
    expect(decodeSValue({ kind: 'Int', value: 5 }, 3))
      .toEqual({ value: { kind: 'Int', value: 5 }, tpe: { tag: 'SInt' } })
  })
  it('Long string → bigint, tpe SLong', () => {
    expect(decodeSValue({ kind: 'Long', value: '9223372036854775807' }, 3))
      .toEqual({ value: { kind: 'Long', value: 9223372036854775807n }, tpe: { tag: 'SLong' } })
  })
  it('GroupElement hex → Uint8Array, tpe SGroupElement', () => {
    const r = decodeSValue({ kind: 'GroupElement', bytes_hex: '02abff' }, 3)
    expect(r.tpe).toEqual({ tag: 'SGroupElement' })
    expect(r.value).toEqual({ kind: 'GroupElement', value: new Uint8Array([0x02, 0xab, 0xff]) })
  })
  it('Coll → {value with elem, tpe SColl}', () => {
    expect(decodeSValue({ kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }] }, 3))
      .toEqual({
        value: { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }] },
        tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
      })
  })
  it('Tuple → {value, tpe STuple from item tpes}', () => {
    const r = decodeSValue({ kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Boolean', value: true }] }, 3)
    expect(r.tpe).toEqual({ tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SBoolean' }] })
    expect(r.value).toEqual({ kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Boolean', value: true }] })
  })
  it('a non-pair Tuple → tupleColl(items): a Coll[Any] whose elem the readers recognise by IDENTITY; tpe the STuple', () => {
    const items = [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Boolean', value: true }]
    const r = decodeSValue({ kind: 'Tuple', items }, 3)
    expect(r.tpe).toEqual({ tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }, { tag: 'SBoolean' }] })
    const want = tupleColl([{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Boolean', value: true }])
    expect(r.value).toEqual(want)
    // a literal { tag: 'SAny' } would be EQUAL but not the reader's object (ergots, 2026-11-20)
    expect((r.value as { elem: unknown }).elem).toBe(want.elem)
  })
  it('a Coll of non-pair tuples → each item a tupleColl, elem the STuple', () => {
    const t3 = { kind: 'Tuple', items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }, { kind: 'Int', value: 3 }] }
    const tt = { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SInt' }, { tag: 'SInt' }] }
    const r = decodeSValue({ kind: 'Coll', elem: tt, items: [t3] }, 3)
    expect(r.tpe).toEqual({ tag: 'SColl', elem: tt })
    const item = (r.value as { items: { elem: unknown }[] }).items[0]
    expect(item.elem).toBe(tupleColl([]).elem)
  })
  it('Option Some → infers elem from inner', () => {
    const r = decodeSValue({ kind: 'Option', value: { kind: 'Long', value: '7' } }, 3)
    expect(r.tpe).toEqual({ tag: 'SOption', elem: { tag: 'SLong' } })
    expect(r.value).toEqual({ kind: 'Option', elem: { tag: 'SLong' }, value: { kind: 'Long', value: 7n } })
  })
  it('UnsignedBigInt string → bigint, tpe SUnsignedBigInt (bridged since ergots shipped UBI)', () => {
    expect(decodeSValue({ kind: 'UnsignedBigInt', value: '115792089237316195423570985008687907852837564279074904382605163141518161494337' }, 3))
      .toEqual({
        value: { kind: 'UnsignedBigInt', value: 115792089237316195423570985008687907852837564279074904382605163141518161494337n },
        tpe: { tag: 'SUnsignedBigInt' },
      })
  })
})
