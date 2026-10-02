// treeByteLength: the JVM's ErgoTree.bytes.length (sigma-state 6.0.6, sigma/ast/ErgoTree.scala:123-131). A parsed
// tree keeps the span its parse consumed (ErgoTreeSerializer.scala:179-181), as received; a tree built any other way
// has the length of its serialization. A local sigma-state 6.0.6 probe charges a spend by that span: 9 bytes for J1
// and 10 for J3, where their re-encodings are 8 and 9 (see test/eval/reduce-with.test.ts).
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseTree, parseErgoTreeBytes, serializeTree, treeByteLength } from '../../src/wire/ergo-tree'
import { boxTreeOf } from '../../src/wire/box-tree'
import { isUnparsedTree, type ParsedErgoTree } from '../../src/mir/types'
import { hexToBytes } from '../_helpers'

function parsed(hex: string): ParsedErgoTree {
  const tree = parseTree(hexToBytes(hex))
  if (isUnparsedTree(tree)) throw new Error(`expected a parsed tree: ${tree.error.message}`)
  return tree
}

describe('treeByteLength', () => {
  it('a parsed tree: the length of its bytes', () => {
    expect(treeByteLength(parsed('00d193d404010402'))).toBe(8)
  })

  it('a constant written with an over-long VLQ counts at its written length (J1)', () => {
    const tree = parsed('00d193d40401048200')
    expect(serializeTree(tree).length).toBe(8)
    expect(treeByteLength(tree)).toBe(9)
  })

  it('a size written with an over-long VLQ counts at its written length (J3)', () => {
    const tree = parsed('088700d193d404010402')
    expect(serializeTree(tree).length).toBe(9)
    expect(treeByteLength(tree)).toBe(10)
  })

  it('a segregated tree: its whole span, constants included (SEG1)', () => {
    expect(treeByteLength(parsed('10010402d40801'))).toBe(7)
  })

  it('a tree built without a parse: the length of its serialization', () => {
    const source = parsed('00d193d40401048200')
    const copy: ParsedErgoTree = { ...source }
    expect(treeByteLength(copy)).toBe(serializeTree(source).length)
    expect(treeByteLength(copy)).toBe(8)
  })

  it("a box's tree: the length of the span box ingest kept", () => {
    // The tree, then two bytes that belong to the box after it.
    const r = new ByteReader(hexToBytes('00d193d40401048200' + 'ffff'))
    const span = parseErgoTreeBytes(r)
    expect(span.length).toBe(9)
    const tree = boxTreeOf(span)
    if (isUnparsedTree(tree)) throw new Error('expected a parsed tree')
    expect(treeByteLength(tree)).toBe(span.length)
  })

  it('a tree parsed on a cache miss: the length of the bytes given', () => {
    const bytes = hexToBytes('088700d193d404010402')
    const tree = boxTreeOf(bytes)
    if (isUnparsedTree(tree)) throw new Error('expected a parsed tree')
    expect(treeByteLength(tree)).toBe(10)
  })
})
