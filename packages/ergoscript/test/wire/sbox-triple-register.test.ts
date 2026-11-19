/**
 * A box whose R4 holds the CONSTANT `(1, 2, 3)` of type `(Int, Int, Int)`
 * keeps its bytes and its id across a parse. The data reader's STuple arm
 * builds `tupleColl([1, 2, 3])` for the value (per `CoreDataSerializer.scala:139-144`
 * through `Evaluation.toDslTuple` `Evaluation.scala:99-102`), and the box's
 * `retainedBytes` are the span the reader snapshotted (`ErgoBox.scala:87-92`,
 * `:214-225`): `boxBytesOf(box) === rawBytes` and `boxIdOf(box) === blake2b256(rawBytes)`.
 *
 * The register wire shape:
 *   48 04 04 04  — type: Triple (containerId=6, primId=0), then three SInt type codes
 *   02 04 06     — values: ZigZag 1, 2, 3 for the three Ints
 */
import { describe, it, expect } from 'vitest'
import { parseSValue } from '../../src/wire/parse-svalue'
import { boxBytesOf, boxIdOf } from '../../src/eval/_box-id'
import { tupleColl } from '../../src/coll'
import { ByteReader } from '@ergots/scorex'
import { blake2b256 } from '../../src/crypto/hashes'
import { hexToBytes } from '../_helpers'

/** The full box bytes:
 *   64                                                           value VLQ u64 = 100
 *   0008d3                                                       ergoTree: header 0x00 (v0), body 08 d3 (an SSigmaProp constant)
 *   00                                                           creation_height VLQ = 0
 *   00                                                           tokens_count raw u8 = 0
 *   01                                                           additional_regs count raw u8 = 1
 *   48 04 04 04 02 04 06                                         R4: STuple[SInt, SInt, SInt] = (1, 2, 3)
 *   00...00 (32 bytes)                                           transaction_id
 *   00                                                           index VLQ u16 = 0
 */
const BOX_HEX =
  '64' +
  '0008d3' +
  '00' +
  '00' +
  '01' +
  '48040404020406' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '00'

const int = (v: number) => ({ kind: 'Int' as const, value: v })

describe('a box whose R4 is the CONSTANT (1, 2, 3) keeps its bytes and its id', () => {
  const rawBytes = hexToBytes(BOX_HEX)

  it('parses R4 as tupleColl([1, 2, 3])', () => {
    const r = new ByteReader(rawBytes)
    const sv = parseSValue({ tag: 'SBox' }, 3, r)
    expect(sv.kind).toBe('Box')
    if (sv.kind !== 'Box') return
    const r4 = sv.value.registers[4]
    expect(r4).toBeDefined()
    expect(r4!.tpe).toEqual({
      tag: 'STuple',
      items: [{ tag: 'SInt' }, { tag: 'SInt' }, { tag: 'SInt' }],
    })
    expect(r4!.value).toEqual(tupleColl([int(1), int(2), int(3)]))
  })

  it('`boxBytesOf(parsed)` equals the input bytes (retained slice)', () => {
    const sv = parseSValue({ tag: 'SBox' }, 3, new ByteReader(rawBytes))
    if (sv.kind !== 'Box') throw new Error(`unreachable: ${sv.kind}`)
    const bytes = boxBytesOf(sv.value)
    expect(bytes).toEqual(rawBytes)
  })

  it('`boxIdOf(parsed)` equals blake2b256(rawBytes)', () => {
    const sv = parseSValue({ tag: 'SBox' }, 3, new ByteReader(rawBytes))
    if (sv.kind !== 'Box') throw new Error(`unreachable: ${sv.kind}`)
    const id = boxIdOf(sv.value)
    expect(id).toEqual(blake2b256(rawBytes))
  })
})
