import { describe, it, expect } from 'vitest'
import type { SValue } from '@ergots/ergoscript'
import { parseSValue } from '@ergots/ergoscript'
import { ByteReader } from '@ergots/scorex'
import { encodeSValue } from '../src/encode'
import { hexToBytes } from '../src/hex'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

describe('encode — primitives', () => {
  it('Boolean → bare bool', () => {
    expect(encodeSValue({ kind: 'Boolean', value: true }, 3)).toEqual({ kind: 'Boolean', value: true })
  })
  it('Byte/Short/Int → bare number', () => {
    expect(encodeSValue({ kind: 'Byte', value: -5 }, 3)).toEqual({ kind: 'Byte', value: -5 })
    expect(encodeSValue({ kind: 'Short', value: 300 }, 3)).toEqual({ kind: 'Short', value: 300 })
    expect(encodeSValue({ kind: 'Int', value: 2147483647 }, 3)).toEqual({ kind: 'Int', value: 2147483647 })
  })
  it('Long → decimal STRING (beyond JS safe int)', () => {
    expect(encodeSValue({ kind: 'Long', value: 9223372036854775807n }, 3))
      .toEqual({ kind: 'Long', value: '9223372036854775807' })
    expect(encodeSValue({ kind: 'Long', value: -1n }, 3)).toEqual({ kind: 'Long', value: '-1' })
  })
  it('BigInt → decimal string', () => {
    expect(encodeSValue({ kind: 'BigInt', value: -170141183460469231731687303715884105728n }, 3))
      .toEqual({ kind: 'BigInt', value: '-170141183460469231731687303715884105728' })
  })
  it('GroupElement → lower-case bytes_hex', () => {
    const v: SValue = { kind: 'GroupElement', value: new Uint8Array([0x02, 0xAB, 0xff]) }
    expect(encodeSValue(v, 3)).toEqual({ kind: 'GroupElement', bytes_hex: '02abff' })
  })
  it('unmodeled result kind (String) → loud throw', () => {
    expect(() => encodeSValue({ kind: 'String', value: 'x' } as SValue, 3)).toThrow(/unmodeled|unexpected/i)
  })
  it('UnsignedBigInt → decimal string (decode-consistent)', () => {
    expect(encodeSValue({ kind: 'UnsignedBigInt', value: 115792089237316195423570985008687907852837564279074904382605163141518161494337n }, 3))
      .toEqual({ kind: 'UnsignedBigInt', value: '115792089237316195423570985008687907852837564279074904382605163141518161494337' })
  })
})

describe('encode — composites', () => {
  it('Coll → {elem, items} (elem via SType bridge)', () => {
    expect(encodeSValue({ kind: 'Coll', elem: { tag: 'SInt' }, items: [
      { kind: 'Int', value: 2 }, { kind: 'Int', value: 1 },
    ] }, 3)).toEqual({ kind: 'Coll', elem: { tag: 'SInt' }, items: [
      { kind: 'Int', value: 2 }, { kind: 'Int', value: 1 },
    ] })
  })
  it('Tuple → positional items', () => {
    expect(encodeSValue({ kind: 'Tuple', items: [
      { kind: 'Int', value: 1 }, { kind: 'Boolean', value: false },
    ] }, 3)).toEqual({ kind: 'Tuple', items: [
      { kind: 'Int', value: 1 }, { kind: 'Boolean', value: false },
    ] })
  })
  it('Option Some → {value: inner} (drops ergots elem)', () => {
    expect(encodeSValue({ kind: 'Option', elem: { tag: 'SLong' }, value: { kind: 'Long', value: 7n } }, 3))
      .toEqual({ kind: 'Option', value: { kind: 'Long', value: '7' } })
  })
  it('Option None → {value: null}', () => {
    expect(encodeSValue({ kind: 'Option', elem: { tag: 'SInt' }, value: null }, 3))
      .toEqual({ kind: 'Option', value: null })
  })
})

describe('encode — bytes-kinds (Box round-trip)', () => {
  const BOX_HEX = '0a0b0208d3000000000000000000000000000000000000000000000000000000000000000000000000'
  it('Box → bytes_hex equals ergots box serialization (round-trip)', () => {
    const box = parseSValue({ tag: 'SBox' }, 3, new ByteReader(hexToBytes(BOX_HEX)))
    expect(box.kind).toBe('Box')
    expect(encodeSValue(box, 3)).toEqual({ kind: 'Box', bytes_hex: BOX_HEX })
  })
})

describe('encode — bytes-kinds (AvlTree round-trip)', () => {
  // vectors/eval/v5/spec/AvlTree_properties_equivalence.json entry #0 input.
  const AVL_HEX = '000183807f66b301530120ff7fc6bd6601ff01ff7f7d2bedbbffff00187fe8909406010101'
  it('AvlTree → bytes_hex equals ergots AvlTreeData serialization (round-trip)', () => {
    const tree = parseSValue({ tag: 'SAvlTree' }, 3, new ByteReader(hexToBytes(AVL_HEX)))
    expect(tree.kind).toBe('AvlTree')
    expect(encodeSValue(tree, 3)).toEqual({ kind: 'AvlTree', bytes_hex: AVL_HEX })
  })
})

describe('encode — a Box is the bytes it was read from', () => {
  // The JVM encodes a Box value as `ebox.bytes`, the slice the box was parsed from, which ergots surfaces as
  // `boxBytesOf` (the basis of its `Box.bytes`). These boxes name a type variable whose text the reader builds from
  // FF bytes (each one U+FFFD): written back, the 255-byte text becomes EF BF BD x 85, and the 256- and 258-byte
  // texts cannot be written at all. So an encoder that WRITES the box gives other bytes, or throws.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const vec = JSON.parse(readFileSync(path.resolve(here,
    'fixtures/eval/v6/authored/Global.deserializeTo_Box_type_var_name_range.json'), 'utf8')) as
    { entries: { name: string; expected: { value?: { kind: string; bytes_hex: string } } }[] }
  const boxes = vec.entries.filter((e) => /-just-/.test(e.name))
  it('the six `just` rows: parsed, then encoded, give back their bytes', () => {
    expect(boxes.length).toBe(6)
    for (const e of boxes) {
      const hex = e.expected.value!.bytes_hex
      const box = parseSValue({ tag: 'SBox' }, 3, new ByteReader(hexToBytes(hex)))
      expect(encodeSValue(box, 3), e.name).toEqual({ kind: 'Box', bytes_hex: hex })
    }
  })
})
