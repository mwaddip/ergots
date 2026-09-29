/**
 * A Box value's index is a JVM Short. `ErgoBox.sigmaSerializer.parse` reads it with `getUShort` and
 * stores `index.toShort` (ErgoBox.scala:218, 224; the field is `index: Short`, :56), so 0x8000-0xFFFF
 * parse to a negative Short, and the write, `putUShort(obj.index)` (:211), rejects a negative one
 * (scorex-util 0.2.1 VLQWriter.scala:36-39: "Value -32768 is out of unsigned short range"). Such a
 * box parses, and keeps its bytes as received for its `bytes` and id (:87-92), but cannot be
 * re-encoded: not as a Box constant in a tree, and not by `Global.serialize`, whose body is
 * `DataSerializer.serialize` (CSigmaDslBuilder.scala:264-269; DataSerializer.scala:16-18).
 *
 * Every verdict and re-encoding below is from a live sigma-state 6.0.6 probe.
 */
import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { serializeBoxBytes } from '../../src/wire/ergo-box-bytes'
import { parseTree, serializeTree, parseErgoTreeBytes } from '../../src/wire/ergo-tree'
import { reencodeTreeBytes, seedBoxTree } from '../../src/wire/box-tree'
import { boxBytesOf } from '../../src/eval/_box-id'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { isUnparsedTree } from '../../src/mir/types'
import type { ErgoBox, MethodCall, SValue } from '../../src/mir/types'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const errOf = (f: () => unknown): unknown => { try { f(); return undefined } catch (e) { return e } }

/** Box data: value 1, the tree `00 08 d3`, creation height 0, no tokens or registers, a 0x11 tx id, the index. */
const boxData = (indexVlq: string) => '01' + '0008d3' + '000000' + '11'.repeat(32) + indexVlq
const parseBox = (h: string): SValue => parseSValue({ tag: 'SBox' }, 0, new ByteReader(hex(h)))
const writeBox = (v: SValue): string => {
  const w = new ByteWriter()
  serializeSValue({ tag: 'SBox' }, v, 0, w)
  return toHex(w.toBytes())
}
/** A sized, segregated tree over one SBox constant: BoolToSigmaProp(GT(ExtractAmount(placeholder 0), 0L)). */
const treeWithBox = (box: string) => {
  const inner = '0163' + box + 'd191c173000500'
  return '18' + (inner.length / 2).toString(16) + inner
}

const INDEX_7FFF = 'ffff01'
const INDEX_8000 = '808002'
const INDEX_FFFF = 'ffff03'

describe('the Box index is written within [0, 0x7FFF], the JVM Short that putUShort takes', () => {
  it('a box with index 0x7FFF re-encodes as received', () => {
    expect(writeBox(parseBox(boxData(INDEX_7FFF)))).toBe(boxData(INDEX_7FFF))
  })
  for (const [name, idx] of [['0x8000', INDEX_8000], ['0xFFFF', INDEX_FFFF]] as const) {
    it(`a box with index ${name} parses and keeps its bytes as received, but cannot be re-encoded`, () => {
      const v = parseBox(boxData(idx))
      if (v.kind !== 'Box') throw new Error('expected a Box')
      expect(toHex(boxBytesOf(v.value))).toBe(boxData(idx))
      expect(errOf(() => writeBox(v))).toMatchObject({ name: 'SValueSerializeError', code: 'sbox-index-out-of-range' })
    })
  }
  it('serializeBoxBytes of a constructed box writes index 0x7FFF and rejects 0x8000', () => {
    const ergoTreeBytes = hex('0008d3')
    seedBoxTree(ergoTreeBytes, parseTree(ergoTreeBytes))
    const box = (index: number): ErgoBox => ({
      value: 1n, ergoTreeBytes, creationHeight: 0, tokens: [], registers: {}, txId: hex('11'.repeat(32)), index,
    })
    expect(toHex(serializeBoxBytes(box(0x7fff)))).toBe(boxData(INDEX_7FFF))
    expect(errOf(() => serializeBoxBytes(box(0x8000)))).toMatchObject({ code: 'sbox-index-out-of-range' })
  })
})

describe('a tree carrying a Box constant with index 0x8000 parses but cannot be re-encoded', () => {
  it('index 0x7FFF: the tree parses under the box rules and re-encodes as received', () => {
    const t = treeWithBox(boxData(INDEX_7FFF))
    const tree = parseTree(hex(t), { checkType: true })
    expect(isUnparsedTree(tree)).toBe(false)
    expect(toHex(serializeTree(tree))).toBe(t)
  })
  it('index 0x8000: the tree parses under the box rules, and serializeTree and reencodeTreeBytes throw', () => {
    const t = treeWithBox(boxData(INDEX_8000))
    expect(isUnparsedTree(parseTree(hex(t), { checkType: true }))).toBe(false)
    expect(errOf(() => serializeTree(parseTree(hex(t), { checkType: true })))).toMatchObject({ code: 'sbox-index-out-of-range' })
    const span = parseErgoTreeBytes(new ByteReader(hex(t)))
    expect(errOf(() => reencodeTreeBytes(span))).toMatchObject({ code: 'sbox-index-out-of-range' })
  })
})

describe('Global.serialize of a Box with index 0x8000 fails', () => {
  const serialize = (box: SValue): MethodCall => ({
    tag: 'MethodCall', obj: { tag: 'Global' }, typeId: 106, methodId: 3,
    args: [{ tag: 'Const', tpe: { tag: 'SBox' }, value: box }], explicitTypeArgs: {},
  })
  it('index 0x7FFF: the bytes are the box as received', () => {
    const r = evalMethodCall(serialize(parseBox(boxData(INDEX_7FFF))), Env.empty(), makeContext({ treeVersion: 3 }))
    if (r.kind !== 'Coll') throw new Error('expected a Coll[Byte]')
    expect(toHex(new Uint8Array(r.items.map((it) => (it as { value: number }).value & 0xff)))).toBe(boxData(INDEX_7FFF))
  })
  it("index 0x8000: EvalError('global-serialize-failed'), with the write's error as cause", () => {
    const err = errOf(() => evalMethodCall(serialize(parseBox(boxData(INDEX_8000))), Env.empty(), makeContext({ treeVersion: 3 })))
    expect(err).toBeInstanceOf(EvalError)
    expect(err).toMatchObject({ code: 'global-serialize-failed' })
    expect((err as Error).cause).toMatchObject({ name: 'SValueSerializeError', code: 'sbox-index-out-of-range' })
  })
})
