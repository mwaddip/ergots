/**
 * Transactions whose verdict and id a live sigma-state 6.0.6 probe fixed. The JVM side parses each
 * transaction with `ErgoLikeTransactionSerializer.parse` under `VersionContext(3, 3)` and forces the
 * id, as ergo-core's eager `serializedId` does (`ErgoTransaction.scala:68`); every expected id,
 * rejection and re-encoded output tree below is that probe's output.
 *
 * Every transaction has one input (a zero box id, an empty proof and the given context extension),
 * no data inputs and no tokens; each output has value 1000 (`e8 07`), creation height 100 (`64`),
 * no tokens and the given registers.
 */
import { describe, it, expect } from 'vitest'
import { boxTreeOf, isUnparsedTree, reencodeTreeBytes } from '@ergots/ergoscript'
import { parseTransaction, transactionId } from '../../src/index.ts'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const vlq = (n: number): string => {
  let out = ''
  for (;;) {
    const low = n % 128
    n = Math.floor(n / 128)
    out += (n > 0 ? low | 0x80 : low).toString(16).padStart(2, '0')
    if (n === 0) return out
  }
}
const tx = (outs: { tree: string; regs?: string }[], ext = '00'): Uint8Array =>
  hex('01' + '00'.repeat(32) + '00' + ext + '00' + '00' + vlq(outs.length) +
    outs.map((o) => 'e807' + o.tree + '64' + '00' + (o.regs ?? '00')).join(''))
const sized = (header: string, inner: string) => header + vlq(inner.length / 2) + inner
const errorOf = (f: () => unknown): { code?: string; cause?: unknown } | undefined => {
  try { f() } catch (x) { return x as { code?: string; cause?: unknown } }
  return undefined
}
/** Box data: value 1, the tree, creation height 0, no tokens, the registers, a 0x11 tx id, the index. */
const boxData = (tree: string, regs = '00', index = '00') => '01' + tree + '0000' + regs + '11'.repeat(32) + index
/** A sized, segregated tree over one SBox constant: BoolToSigmaProp(GT(ExtractAmount(placeholder 0), 0L)). */
const treeWithBox = (header: string, box: string) => sized(header, '0163' + box + 'd191c173000500')

/** The JVM accepted the transaction: its id, and each output tree's status and re-encoding. */
function expectAccepted(bytes: Uint8Array, id: string, outputs: string[]): void {
  const parsed = parseTransaction(bytes)
  expect(toHex(transactionId(parsed))).toBe(id)
  expect(parsed.outputCandidates.map((o) =>
    `${isUnparsedTree(boxTreeOf(o.ergoTreeBytes)) ? 'U' : 'P'}:${toHex(reencodeTreeBytes(o.ergoTreeBytes))}`)).toEqual(outputs)
}

// ByIndex(Tuple(Int 0, Int 0), Int 0, None). The JVM types it as its SAny (STuple extends
// SCollection[SAny], SType.scala:838-841; ByIndex.tpe = input.tpe.elemType, transformers.scala:254),
// so rule 1001 fails a root typed through it.
const BY_INDEX_TUPLE = 'b2860204000400040000'

describe('ByIndex over a tuple: the JVM types it SAny', () => {
  it('a sized root ByIndex(tuple): the tree degrades and the transaction is accepted', () => {
    expectAccepted(tx([{ tree: '080a' + BY_INDEX_TUPLE }]),
      '74e701a076f2a103db241e729d3754be49e0c01edbe62324f6cc06837bdec9c4', ['U:080a' + BY_INDEX_TUPLE])
  })
  it('a sized If(true, ByIndex(tuple), sigmaProp(true)): the tree degrades and the transaction is accepted', () => {
    const tree = '080f950101' + BY_INDEX_TUPLE + '08d3'
    expectAccepted(tx([{ tree }]), 'f73c1c22f28ccbb94dc686c55b46c639bb751a2a767bf1f5f7319c074939ee8a', ['U:' + tree])
  })
  it('an unsized root ByIndex(tuple) rejects (the JVM SerializerException: no size bit)', () => {
    expect(() => parseTransaction(tx([{ tree: '00' + BY_INDEX_TUPLE }]))).toThrow(expect.objectContaining({ code: 'soft-fork-without-size-bit' }))
  })
  it("a nested Box's sized tree rooted at ByIndex(tuple): the output tree parses", () => {
    const tree = treeWithBox('18', boxData('080a' + BY_INDEX_TUPLE))
    expectAccepted(tx([{ tree }]), 'f31ddc965f42d058658920779b6a5a77d57ca6070cbb1be48fd562a844b7d314', ['P:' + tree])
  })
  it('a ValDef whose rhs is ByIndex(tuple): the output tree parses', () => {
    const tree = sized('08', 'd801d601' + BY_INDEX_TUPLE + '08d3')
    expectAccepted(tx([{ tree }]), 'e2f56ff75bee11b92ecd26e457619bae87ada1eea7fdbc2a9132c2f5c404b406', ['P:' + tree])
  })
})

// A Box value's index is a JVM Short (ErgoBox.scala:56, 218, 224), written back with putUShort (:211),
// which rejects 0x8000-0xFFFF: "Value -32768 is out of unsigned short range". The JVM's eager id
// writes the whole signing message, so it rejects each placement at parse. ergots forces the output
// trees' re-encoding at parse, and writes registers and extension values when it computes the id.
describe('a Box value with index 0x8000 cannot be re-encoded', () => {
  const box = (indexVlq: string) => boxData('0008d3', '00', indexVlq)
  it('index 0x7FFF, a Box constant in the output tree: accepted', () => {
    const tree = treeWithBox('18', box('ffff01'))
    expectAccepted(tx([{ tree }]), '95f4a88304fe57128fcd44cc51a38af094098d18f3474e203af2d8ec6b5d262b', ['P:' + tree])
  })
  it("a Box constant in the output tree: parseTransaction rejects 'output-tree-not-reencodable'", () => {
    const err = errorOf(() => parseTransaction(tx([{ tree: treeWithBox('18', box('808002')) }])))
    expect(err).toMatchObject({ code: 'output-tree-not-reencodable' })
    expect(err?.cause).toMatchObject({ code: 'sbox-index-out-of-range' })
  })
  it('the Box in output R4: transactionId throws', () => {
    const parsed = parseTransaction(tx([{ tree: '0008d3', regs: '0163' + box('808002') }]))
    expect(errorOf(() => transactionId(parsed))).toMatchObject({ code: 'sbox-index-out-of-range' })
  })
  it("the Box in an input's context extension: transactionId throws", () => {
    const parsed = parseTransaction(tx([{ tree: '0008d3' }], '010063' + box('808002')))
    expect(errorOf(() => transactionId(parsed))).toMatchObject({ code: 'sbox-index-out-of-range' })
  })
})
