/**
 * Spec 2026-09-28 §9-§10: the transaction id and serialization write each output tree re-encoded, as
 * the JVM's candidate serializer does (ErgoBoxCandidate.scala:142); an input box's id and its
 * storage-rent fee use the box's bytes as received (ErgoBox.bytes, ErgoBox.scala:87-92); the spend
 * evaluates the box-rules tree (ErgoTransaction.scala:138); and parseTransaction forces each output
 * tree's re-encoding, as ergo-core's eager serializedId does (ErgoTransaction.scala:68, :497-502).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { blake2b256, ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue, boxBytesOf, reencodeTreeBytes } from '@ergots/ergoscript'
import type { ErgoBox } from '@ergots/ergoscript'
import { parseTransaction, transactionId, validateStateful, TxParseError } from '../../src/index.ts'
import { computeBoxId } from '../../src/validate/stateful.ts'
import { checkExpiredBox } from '../../src/validate/storage-rent.ts'
import { parseInput, parseContextExtension, serializeInput } from '../../src/wire/input.ts'
import { loadSantaTxEntries, santaTxInputs } from './_santa-tx'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, '../fixtures/conformance', f), 'utf8')).entries
const vec = fx('Transaction.sized_tree_declared_size.json')

/** Unsigned VLQ, as hex. */
const vlq = (n: number): string => {
  let out = ''
  for (;;) {
    const low = n % 128
    n = Math.floor(n / 128)
    out += (n > 0 ? low | 0x80 : low).toString(16).padStart(2, '0')
    if (n === 0) return out
  }
}
const errorOf = (f: () => unknown): { code?: string; cause?: { code?: string } } | undefined => {
  try { f() } catch (x) { return x as { code?: string; cause?: { code?: string } } }
  return undefined
}

describe('Review Focus 3: a wrong declared size does not move the tx id; R1 stays raw', () => {
  it('over and under have the control tx id', () => {
    const ids = vec.map((e: { bytes_hex: string }) => transactionId(parseTransaction(hex(e.bytes_hex))))
    expect(ids[1]).toEqual(ids[0])
    expect(ids[2]).toEqual(ids[0])
  })
  it('the over output keeps its declared size in ergoTreeBytes', () => {
    const tx = parseTransaction(hex(vec[1].bytes_hex))
    expect(Array.from(tx.outputCandidates[0]!.ergoTreeBytes)).toEqual([0x09, 0x03, 0x08, 0xd3])
  })
})

// SANTA Box.sized_tree_declared_size#1 (santa 2b1acee): tree declared 3 over a 2-byte body.
const OVER_BOX_HEX = 'c0843d090308d3010000cb56144443fa2e5da7c7da46a8fcb044f30c5161d9d4a3c83ee41c1faf3a65e500'
const overBox = (): ErgoBox => (parseSValue({ tag: 'SBox' }, 3, new ByteReader(hex(OVER_BOX_HEX))) as { value: ErgoBox }).value

describe('Review Focus 4: an input box id is over its bytes as received', () => {
  it('computeBoxId of an over-declared box hashes the raw box bytes', () => {
    expect(computeBoxId(overBox())).toEqual(blake2b256(hex(OVER_BOX_HEX)))
  })
  it('the rent fee basis is the bytes as received: checkExpiredBox charges the fee on them (ErgoInterpreter.scala:43)', () => {
    // The tree declares 200 bytes (`c8 01`) over the 2-byte body `08 d3`, so the box as received is one
    // byte longer than its re-encoding. Its value is the fee on the 45 received bytes: the fee is not
    // covered and the verdict is true whatever the output. On the 44 re-encoded bytes the value would
    // cover the fee, and the output (creation height 0, not the current height) would fail the check.
    const factor = 1_250_000
    const received = 45
    const boxHex = vlq(factor * received) + '09c80108d3' + '000000' + 'cb'.repeat(32) + '00'
    const box = (parseSValue({ tag: 'SBox' }, 0, new ByteReader(hex(boxHex))) as { value: ErgoBox }).value
    expect(boxBytesOf(box).length).toBe(received)
    expect(reencodeTreeBytes(box.ergoTreeBytes).length).toBe(box.ergoTreeBytes.length - 1)
    const output = { value: 0n, ergoTreeBytes: hex('0008d3'), creationHeight: 0, tokens: [], registers: {} }
    expect(checkExpiredBox(box, output, 1_051_200, factor)).toBe(true)
  })
})

describe('the spend evaluates the box-rules tree', () => {
  it('a sized Int-root input tree (rule 1001 degrade) is unspendable: unparsed-ergotree', () => {
    // rent-gate-age-below-period-accept runs the script path (the rent gate is not met).
    const e = loadSantaTxEntries('storage-rent-gate.json').find((x) => x.name === 'rent-gate-age-below-period-accept')!
    const { tx, deps } = santaTxInputs(e)
    // Keep retainedBytes (the id check uses the bytes as received); swap only the tree.
    deps.inputBoxes[0] = { ...deps.inputBoxes[0]!, ergoTreeBytes: hex('08020402') }
    let err: unknown
    try { validateStateful(tx, deps) } catch (x) { err = x }
    expect((err as { code?: string }).code).toBe('unparsed-ergotree')
  })
})

// The control transaction's only output: the tree `09 02 08 d3`, then creation height 1, no tokens
// and no registers (`01 00 00`). The shapes below replace that tree.
const CONTROL = vec[0].bytes_hex as string
const CONTROL_TREE = '090208d3'
const TREE_AT = CONTROL.length - CONTROL_TREE.length - '010000'.length
const txHexWithOutputTree = (tree: string): string =>
  CONTROL.slice(0, TREE_AT) + tree + CONTROL.slice(TREE_AT + CONTROL_TREE.length)
const withOutputTree = (tree: string): Uint8Array => hex(txHexWithOutputTree(tree))
/** A size-flagged tree whose declared size is its body's length (constants and root). */
const sized = (header: string, body: string): string => header + vlq(body.length / 2) + body
// A BlockValue whose one item is `item`, with the root sigmaProp(true) (`08 d3`) as its result.
const inBlock = (item: string): string => 'd801' + item + '08d3'
// FunDef (0xd7) id 1 with one type argument, an STypeVar (type code 0x67) named by `n` bytes of 0xff,
// over the Int 0. Each 0xff decodes to one U+FFFD (Java's UTF-8 decoder, as `decodeUtf8Lossy`), which
// re-encodes as 3 bytes.
const funDefTypeVar = (n: number): string => 'd70101' + '67' + n.toString(16).padStart(2, '0') + 'ff'.repeat(n) + '0400'
// ValDef (0xd6) id 1 of a FuncValue (0xd9) with one SInt argument of the given id, over the Int 0.
const funcValueArg = (id: number): string => 'd601' + 'd901' + vlq(id) + '04' + '0400'
// One segregated SAvlTree (type code 0x64) constant: a 33-byte digest, flags, keyLength, no value length.
const avlTreeConstant = (keyLength: number): string => '01' + '64' + '00'.repeat(33) + '07' + vlq(keyLength) + '00'

// Each shape parses under the box rules but its tree cannot be written: [what, tree, the writer's
// code, a writable twin that parses].
const NOT_REENCODABLE: [string, string, string, string][] = [
  ['a segregated constant of a 1-item tuple type (TypeSerializer.scala:93-94)',
    sized('19', '01' + '600104' + '0a' + '08d3'), 'tuple-too-short',
    sized('19', '01' + '60020404' + '0a0a' + '08d3')],
  ['a FuncValue argument id of 2^31, read wrapped negative (FuncValueSerializer.scala:23, :36)',
    sized('09', inBlock(funcValueArg(2 ** 31))), 'func-value-arg-id-out-of-range',
    sized('09', inBlock(funcValueArg(2 ** 31 - 1)))],
  ['an AvlTree constant with keyLength 0x80000000, read wrapped negative (AvlTreeData.scala:77, :84)',
    sized('19', avlTreeConstant(0x80000000) + '08d3'), 'savltree-key-length-out-of-range',
    sized('19', avlTreeConstant(0x7fffffff) + '08d3')],
  ['an STypeVar name of 86 0xff bytes, 258 bytes re-encoded (TypeSerializer.scala:122-126, :202-205)',
    sized('09', inBlock(funDefTypeVar(86))), 'stypevar-name-length',
    sized('09', inBlock(funDefTypeVar(85)))],
]

describe("parseTransaction forces each output tree's re-encoding (ErgoTransaction.scala:68, :497-502)", () => {
  it('the splice reproduces the control transaction', () => {
    expect(withOutputTree(CONTROL_TREE)).toEqual(hex(CONTROL))
  })
  for (const [what, tree, writerCode, twin] of NOT_REENCODABLE) {
    it(`${what}: TxParseError('output-tree-not-reencodable'), cause '${writerCode}'`, () => {
      const err = errorOf(() => parseTransaction(withOutputTree(tree)))
      expect(err).toBeInstanceOf(TxParseError)
      expect(err?.code).toBe('output-tree-not-reencodable')
      expect(err?.cause?.code).toBe(writerCode)
    })
    it(`${what}: the writable twin parses`, () => {
      expect(() => parseTransaction(withOutputTree(twin))).not.toThrow()
    })
  }
  it('an STypeVar name of 255 0xff bytes, 765 bytes re-encoded', () => {
    const err = errorOf(() => parseTransaction(withOutputTree(sized('09', inBlock(funDefTypeVar(255))))))
    expect(err?.code).toBe('output-tree-not-reencodable')
    expect(err?.cause?.code).toBe('stypevar-name-length')
  })
  it('runs once every output is parsed: a later output that fails to parse rejects with its own error', () => {
    // ergo-core constructs the transaction, and so computes its id, only after the last output is read.
    const value = CONTROL.slice(TREE_AT - 10, TREE_AT)
    expect(CONTROL.slice(TREE_AT - 12, TREE_AT - 10)).toBe('01')   // the output count
    const tupleTree = NOT_REENCODABLE[0]![1]
    const twoOutputs = CONTROL.slice(0, TREE_AT - 12) + '02' + value + tupleTree + '010000' + value
    expect(errorOf(() => parseTransaction(hex(twoOutputs)))?.code).toBe('truncated')
  })
  it('runs before the trailing-bytes check', () => {
    // The JVM's parseBytes has no trailing-bytes check (ErgoSerializer.scala:27-30): the id's failure is
    // the one it reports, whatever follows the transaction.
    const tupleTree = NOT_REENCODABLE[0]![1]
    const err = errorOf(() => parseTransaction(hex(txHexWithOutputTree(tupleTree) + '00')))
    expect(err?.code).toBe('output-tree-not-reencodable')
  })
})

describe('the proof length is a getUShort (ProverResult.scala:34, :40)', () => {
  const boxId = new Array<number>(32).fill(0)
  it('a proof length of 0x10000 rejects: count-out-of-range', () => {
    const err = errorOf(() => parseInput(new ByteReader(Uint8Array.from([...boxId, 0x80, 0x80, 0x04]))))
    expect(err).toBeInstanceOf(TxParseError)
    expect(err?.code).toBe('count-out-of-range')
  })
  it('a proof length of 0xffff is read', () => {
    const input = parseInput(new ByteReader(Uint8Array.from([...boxId, 0xff, 0xff, 0x03, ...new Array<number>(0xffff).fill(7), 0x00])))
    expect(input.spendingProof.proofBytes.length).toBe(0xffff)
  })
  it('a proof longer than 0xffff bytes is not written: count-out-of-range', () => {
    const input = {
      boxId: new Uint8Array(32),
      spendingProof: { proofBytes: new Uint8Array(0x10000), contextExtension: { values: new Map() } },
    }
    expect(errorOf(() => serializeInput(input, new ByteWriter()))?.code).toBe('count-out-of-range')
  })
})

describe('a context-extension value peeks before its checked read (ValueSerializer.scala:396-411)', () => {
  it('at the end of the input, past a window: the peek fails first, truncated', () => {
    // Count 1, variable id 0, then the input ends where the value's first byte would be. No window is
    // open while a transaction's inputs parse (they precede every output), so the order shows only under
    // a window: here one that ends before the value, which the checked read would trip first.
    const r = new ByteReader(Uint8Array.from([0x01, 0x00]))
    r.positionLimit = 1
    expect(errorOf(() => parseContextExtension(r))?.code).toBe('truncated')
  })
})
