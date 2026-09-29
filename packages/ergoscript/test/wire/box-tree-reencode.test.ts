import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseErgoTreeBytes, parseTree, serializeTree } from '../../src/wire/ergo-tree'
import { boxTreeOf, reencodeTreeBytes, seedBoxTree } from '../../src/wire/box-tree'
import { isUnparsedTree } from '../../src/mir/types'
import type { ErgoBox, SValue } from '../../src/mir/types'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { serializeBoxBytes, serializeBoxBytesWithoutRef } from '../../src/wire/ergo-box-bytes'
import { boxBytesOf, boxIdOf } from '../../src/eval/_box-id'
import { serializeCost } from '../../src/eval/serialize-cost'
import { makeContext } from '../../src/eval/eval-context'
import { blake2b256 } from '../../src/crypto/hashes'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const codeOf = (f: () => unknown) => { try { f(); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }

describe('reencodeTreeBytes', () => {
  it('a seeded over-declared tree re-encodes with the true size', () => {
    const span = parseErgoTreeBytes(new ByteReader(hex('090308d301')))
    expect(Array.from(span)).toEqual([0x09, 0x03, 0x08, 0xd3])       // raw (R1)
    expect(Array.from(reencodeTreeBytes(span))).toEqual([0x09, 0x02, 0x08, 0xd3])
  })
  it('an unparsed tree re-encodes to its raw bytes', () => {
    const span = parseErgoTreeBytes(new ByteReader(hex('0901d1fd00')))
    expect(Array.from(reencodeTreeBytes(span))).toEqual([0x09, 0x01, 0xd1])
  })
  it('a miss parses with the box rules (identity key: a copy is a miss)', () => {
    const bytes = hex('090308d3')
    // A tree seeded on this instance, told apart from the bytes' own tree by its re-encoding.
    seedBoxTree(bytes, parseTree(hex('000402')))
    expect(Array.from(reencodeTreeBytes(bytes))).toEqual([0x00, 0x04, 0x02])                  // the instance: a hit
    expect(Array.from(reencodeTreeBytes(bytes.slice()))).toEqual([0x09, 0x02, 0x08, 0xd3])    // an equal copy: a miss
  })
  it('a miss applies rule 1001: an unsized Int root rejects, a sized one degrades', () => {
    expect(codeOf(() => boxTreeOf(hex('000402')))).toBe('soft-fork-without-size-bit')
    expect(isUnparsedTree(boxTreeOf(hex('08020402')))).toBe(true)
  })
  it('a miss on a sized tree whose own reads run out gives the raw bytes (Unparsed)', () => {
    const t = boxTreeOf(hex('0901d1'))
    expect(isUnparsedTree(t)).toBe(true)
    if (isUnparsedTree(t)) expect(Array.from(t.unparsedBytes)).toEqual([0x09, 0x01, 0xd1])
  })
  it('a miss on a sized tree whose own reads run out throws when the bytes are not its declared span', () => {
    // In its box such a tree degraded, so box ingest kept exactly [0, bodyPos + declared)
    // (ErgoTreeSerializer.scala:200-202). Bytes of another length are no box span.
    for (const h of [
      '0905d1',           // declared 5 over 3 bytes: the span would be 7 bytes
      '0900d1',           // declared 0: the span would be 2 bytes
      '09feffffff0fd1',   // declared toInt -2: the span would be 4 bytes, ending inside the size
    ]) {
      expect(codeOf(() => boxTreeOf(hex(h)))).toBe('truncated')
    }
  })
  it('a miss on bytes that end inside the size VLQ: Unparsed exactly when a JVM degrade keeps them', () => {
    // A degrade keeps [0, bodyPos - start + toInt(size)) (ErgoTreeSerializer.scala:198-201, 220),
    // which ends inside the size VLQ when toInt(size) < 0: bytes of length n are such a span iff some
    // VLQ length L in [max(n, 5), 10] writes v = 2^32 + (n - 1 - L) with the bytes after the header
    // as its first n - 1 bytes (scorex-util 0.2.1 VLQReader.scala:54-58, 75-89). A sigma-state 6.0.6
    // probe kept each span below: 09, then the size v written in L bytes, then an Int root, which
    // degrades (m = n - 1 of the size bytes kept, for every L).
    const spans = [
      '09',                                                                  // m = 0, L = 5..10
      '09fc', '09fb', '09fa', '09f9', '09f8', '09f7',                        // m = 1, L = 5..10
      '09fdff', '09fcff', '09fbff', '09faff', '09f9ff', '09f8ff',            // m = 2
      '09feffff', '09fdffff', '09fcffff', '09fbffff', '09faffff', '09f9ffff', // m = 3
      '09ffffffff', '09feffffff', '09fdffffff', '09fcffffff', '09fbffffff', '09faffffff',
      '09ffffffff8f', '09feffffff8f', '09fdffffff8f', '09fcffffff8f', '09fbffffff8f',
      '09ffffffff8f80', '09feffffff8f80', '09fdffffff8f80', '09fcffffff8f80',
      '09ffffffff8f8080', '09feffffff8f8080', '09fdffffff8f8080',
      '09ffffffff8f808080', '09feffffff8f808080',
      '09ffffffff8f80808080',                                                // m = 9, L = 10
    ]
    for (const h of spans) {
      const t = boxTreeOf(hex(h))
      expect(isUnparsedTree(t), h).toBe(true)
      if (isUnparsedTree(t)) expect(Array.from(t.unparsedBytes)).toEqual(Array.from(hex(h)))
    }
    // No size of any admissible length begins with these bytes: the run-out propagates.
    for (const h of [
      '09fe',                   // v = 2^32 - 2 would need L = 3
      '0980',                   // v's low group would be 0
      '09ffff',                 // v = 2^32 - 1 would need L = 3
      '09fd', '09ff',           // L = 4 and L = 2
      '09f6', '09f7ff',         // L = 11 and L = 11
      '09fcfe',                 // a size's second group is 0x7f
      '09ffffffff8e',           // a size's fifth group is 0x0f
      '09ffffffff8f81',         // a size's sixth group is 0
      '09feffffff8f80808080',   // L = 11
    ]) {
      expect(codeOf(() => boxTreeOf(hex(h))), h).toBe('truncated')
    }
  })
  it('a miss whose nested tree runs out needs box context', () => {
    // sized outer, nested Box whose sized tree reads past the outer end
    expect(codeOf(() => boxTreeOf(hex('0b08' + '63c0843d' + '097f' + 'd1')))).toBe('box-context-required')
  })
  it('a miss on an unsized failure propagates', () => {
    expect(codeOf(() => boxTreeOf(hex('00fd')))).toBe('soft-fork-without-size-bit')
  })
  it('Review Focus 2: trailing bytes on a miss throw trailing-bytes', () => {
    expect(codeOf(() => reencodeTreeBytes(hex('0008d300')))).toBe('trailing-bytes')
  })
  it('seedBoxTree attaches a leniently parsed tree (an Int root)', () => {
    const bytes = hex('000402')
    seedBoxTree(bytes, parseTree(bytes))
    expect(Array.from(reencodeTreeBytes(bytes))).toEqual([0x00, 0x04, 0x02])
  })
})

describe('serializeTree writes the header byte as stored', () => {
  it('a parsed tree with bits 5–7 set round-trips', () => {
    // 0x28 = bit 5 | size flag, version 0; size 2; body SigmaProp(true)
    const t = parseTree(hex('280208d3'))
    expect(Array.from(serializeTree(t))).toEqual([0x28, 0x02, 0x08, 0xd3])
  })
})

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const boxOf = (v: SValue): ErgoBox => (v as Extract<SValue, { kind: 'Box' }>).value

describe('box ingest seeds the cache (spec 2026-09-28 §8)', () => {
  it('an empty span re-encodes to an empty array; a copy of it is a miss that throws', () => {
    // 09 | size fa ff ff ff 0f = 0xfffffffa, toInt -6 | root Int 1: rule 1001 degrades the tree and
    // numBytes = (6 - 0 + -6) | 0 = 0 (ErgoTreeSerializer.scala:200), an empty UnparsedErgoTree; the
    // box reads on from the tree's first byte.
    const r = new ByteReader(hex('09faffffff0f0402'))
    const span = parseErgoTreeBytes(r)
    expect(span.length).toBe(0)
    expect(r.position).toBe(0)
    expect(Array.from(reencodeTreeBytes(span))).toEqual([])
    // An empty array has no header byte: the miss reads it as unsized, and the parse runs out.
    expect(codeOf(() => boxTreeOf(span.slice()))).toBe('truncated')
  })
  it('a span that ends inside the size VLQ: the seed and a miss agree (Unparsed, raw)', () => {
    // 09 | size fe ff ff ff 0f = toInt -2 | root Int 1: numBytes = (6 - 0 + -2) | 0 = 4.
    const r = new ByteReader(hex('09feffffff0f0402'))
    const span = parseErgoTreeBytes(r)
    expect(Array.from(span)).toEqual([0x09, 0xfe, 0xff, 0xff])
    expect(Array.from(reencodeTreeBytes(span))).toEqual([0x09, 0xfe, 0xff, 0xff])
    // A miss: the size read runs out on a sized header, the tree's own read.
    const copy = span.slice()
    expect(isUnparsedTree(boxTreeOf(copy))).toBe(true)
    expect(Array.from(reencodeTreeBytes(copy))).toEqual([0x09, 0xfe, 0xff, 0xff])
  })
  it('a nested tree that read past the outer end and degraded: the seed keeps the parse, a miss needs box context', () => {
    // A box whose unsized, segregated tree holds one Box constant. That nested box's sized tree
    // (declared 3) reads a Coll[Byte](4100) from the outer box's later bytes; EQ's right operand then
    // begins past the nested tree's 4096 window (rule 1014), and the nested tree degrades to its
    // declared 5 bytes (ErgoTreeSerializer.scala:196-209). The nested box reads on from offset 14
    // (height 4100, no tokens, no registers, txId, index), the outer body SigmaProp(true) follows at
    // 51, and the outer tree PARSES: its span is [3, 53). The outer box ends at 89.
    const data = new Uint8Array(4101) // box offsets 16..4116: the Coll's 4100 bytes, then EQ's peek byte
    data[35] = 0x08; data[36] = 0xd3  // offset 51: the outer body
    data[37] = 0x01                   // offset 53: the outer box's creation height
    const bytes = Uint8Array.from([
      0xc0, 0x84, 0x3d,                               // 0: value
      0x10, 0x01, 0x63,                               // 3: tree, unsized and segregated; 1 constant, SBox
      0xc0, 0x84, 0x3d,                               // 6: the nested box's value
      0x08, 0x03, 0xd1, 0x93, 0x0e, 0x84, 0x20,       // 9: its tree: BoolToSigmaProp(EQ(Coll[Byte](4100), …
      ...data,
    ])
    const r = new ByteReader(bytes)
    const v = parseSValue({ tag: 'SBox' }, 0, r)
    expect(r.position).toBe(89)
    const span = boxOf(v).ergoTreeBytes
    expect(span.length).toBe(50)
    const tree = boxTreeOf(span)
    expect(isUnparsedTree(tree)).toBe(false)
    if (isUnparsedTree(tree)) return
    const nested = boxOf(tree.constants[0]!)
    expect(Array.from(nested.ergoTreeBytes)).toEqual([0x08, 0x03, 0xd1, 0x93, 0x0e])
    expect(isUnparsedTree(boxTreeOf(nested.ergoTreeBytes))).toBe(true)
    // The re-encoding is the span itself, and the box re-serializes as received.
    expect(Array.from(reencodeTreeBytes(span))).toEqual(Array.from(span))
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, v, 0, w)
    expect(toHex(w.toBytes())).toBe(toHex(bytes.subarray(0, 89)))
    // A copy is a miss: standalone, the nested Coll runs out of input.
    expect(codeOf(() => boxTreeOf(span.slice()))).toBe('box-context-required')
  })
  it('a nested degrade whose re-read runs past the end: the seed keeps the ingest result, a miss needs box context', () => {
    // The outer tree (sized, segregated, declared 8) holds a Box constant whose own sized tree
    // (declared 60, body the reserved opcode fd) degrades over 62 bytes, past the outer tree's end;
    // the outer root, typed SBox, then fails rule 1001 and the outer tree degrades to its 10-byte
    // span (ErgoTreeSerializer.scala:196-209). The box reads on from offset 13 and ends at 49.
    const tail = [0x01, 0x00, 0x00, ...new Array(32).fill(0), 0x00] // height 1, no tokens, no registers, txId, index 0
    const tree = [
      0x18, 0x08, 0x01, 0x63,           // 0: sized + segregated v0, declared 8; 1 constant, SBox
      0xc0, 0x84, 0x3d,                 // 4: the nested box's value
      0x08, 0x3c, 0xfd,                 // 7: its tree: sized v0, declared 60, fd -> degrades over 62 bytes
      ...tail,                          // 10: the outer box's tail, read after the outer degrade
      ...new Array(23).fill(0),         // 46: the rest of the nested degrade span
      ...tail,                          // 69: the nested box's tail
      0x73, 0x00,                       // 105: outer body ConstantPlaceholder(0), typed SBox
    ]
    const bytes = Uint8Array.from([0xc0, 0x84, 0x3d, ...tree])
    const r = new ByteReader(bytes)
    const v = parseSValue({ tag: 'SBox' }, 0, r)
    expect(r.position).toBe(49)
    const span = boxOf(v).ergoTreeBytes
    expect(toHex(span)).toBe('18080163c0843d083cfd')
    expect(isUnparsedTree(boxTreeOf(span))).toBe(true)
    expect(toHex(reencodeTreeBytes(span))).toBe(toHex(span))
    // A copy is a miss: standalone, the nested degrade's re-read runs past the input. In its box it
    // may have fitted (ErgoTreeSerializer.scala:199-202), so the verdict needs box context.
    expect(codeOf(() => boxTreeOf(span.slice()))).toBe('box-context-required')
    // Box ingest on those bytes alone (nothing after them) rejects hard, as the JVM's getBytes
    // does, marked as a nested run-out whose cause is the error being degraded.
    let err: unknown
    try { parseErgoTreeBytes(new ByteReader(span.slice())) } catch (e) { err = e }
    expect((err as { code?: string }).code).toBe('nested-tree-truncated')
    expect(((err as Error).cause as { code?: string }).code).toBe('opcode-reserved')
  })
})

describe('a tree that parses but cannot be re-encoded', () => {
  it('a FuncValue arg id of 2^31 (Carve-out 5): reencodeTreeBytes throws, and throws again (no cached failure)', () => {
    // 00 | Apply(FuncValue([(2^31 → toInt -2^31, SInt)], SigmaProp(true)), [Int 1]): the root types as
    // SigmaProp, so box ingest parses it; putUInt rejects the negative id (FuncValueSerializer.scala:23).
    const span = parseErgoTreeBytes(new ByteReader(hex('00' + 'da' + 'd901' + '8080808008' + '04' + '08d3' + '01' + '0402')))
    expect(codeOf(() => reencodeTreeBytes(span))).toBe('func-value-arg-id-out-of-range')
    expect(codeOf(() => reencodeTreeBytes(span))).toBe('func-value-arg-id-out-of-range')
  })
  it('an AvlTree keyLength of 0x80000000 (Carve-out 6), seeded: throws on every call', () => {
    const bytes = hex('1001' + '64' + '11'.repeat(33) + '07' + '8080808008' + '00' + '7300')
    seedBoxTree(bytes, parseTree(bytes))
    expect(codeOf(() => reencodeTreeBytes(bytes))).toBe('savltree-key-length-out-of-range')
    expect(codeOf(() => reencodeTreeBytes(bytes))).toBe('savltree-key-length-out-of-range')
  })
})

describe('the write sites emit the re-encoded tree; ergoTreeBytes stay as received', () => {
  const box = (ergoTreeBytes: Uint8Array): ErgoBox => ({
    value: 1000000n, ergoTreeBytes, registers: {}, tokens: [], creationHeight: 1, txId: new Uint8Array(32), index: 0,
  })
  // value c0843d | tree | height 01 | no tokens 00 | no registers 00  (+ txId, index 00 for the full box)
  const candidate = (tree: string) => 'c0843d' + tree + '01' + '00' + '00'
  const full = (tree: string) => candidate(tree) + '00'.repeat(32) + '00'

  it('a constructed box: bytesWithoutRef, bytes and id carry the true size; R1 stays raw', () => {
    const b = box(hex('090308d3'))
    expect(toHex(serializeBoxBytesWithoutRef(b))).toBe(candidate('090208d3'))
    expect(toHex(serializeBoxBytes(b))).toBe(full('090208d3'))
    expect(toHex(boxBytesOf(b))).toBe(full('090208d3'))
    expect(toHex(boxIdOf(b))).toBe(toHex(boxIdOf(box(hex('090208d3')))))
    expect(toHex(b.ergoTreeBytes)).toBe('090308d3')
  })
  it('a parsed box: bytes and id as received; its re-serialization re-encodes', () => {
    const received = hex(full('090308d3'))
    const b = boxOf(parseSValue({ tag: 'SBox' }, 0, new ByteReader(received)))
    expect(toHex(b.ergoTreeBytes)).toBe('090308d3')
    expect(toHex(boxBytesOf(b))).toBe(toHex(received))
    // The id is over the bytes as received (ErgoBox.scala:87-92); a constructed box with the same
    // fields hashes its re-encoding instead.
    expect(toHex(boxIdOf(b))).toBe(toHex(blake2b256(received)))
    expect(toHex(boxIdOf(box(hex('090308d3'))))).toBe(toHex(blake2b256(hex(full('090208d3')))))
    expect(toHex(serializeBoxBytes(b))).toBe(full('090208d3'))
    expect(toHex(serializeBoxBytesWithoutRef(b))).toBe(candidate('090208d3'))
  })
  it('the serialize cost of a Box charges the re-encoded length (putBytes(serializeErgoTree(tree)))', () => {
    // 09 | size ff 7f (16383) | SigmaProp(true): 5 bytes as received, 09 02 08 d3 re-encoded.
    const ctx = makeContext({ treeVersion: 3 })
    serializeCost({ tag: 'SBox' }, { kind: 'Box', value: box(hex('09ff7f08d3')) }, ctx)
    // putULong 3 + putBytes(tree) 3 + 4 + putUInt 0 + putUByte 1 + putUByte 1 + putBytes(txId) 35 + putUShort 3
    expect(ctx.jitCost).toBe(50)
  })
  it('Review Focus 2: a hand-built box whose tree bytes trail throws trailing-bytes when serialized', () => {
    expect(codeOf(() => serializeBoxBytes(box(hex('0008d300'))))).toBe('trailing-bytes')
  })
})
