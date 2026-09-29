/**
 * The JVM re-encodes a parsed tree from its structure (serializeErgoTree, ErgoTreeSerializer.scala
 * :105-127), and each node is written by its `companion`'s serializer, which can differ from the
 * opcode it was read with:
 *   - a ConcreteCollection whose element type is SBoolean and whose items are all Constants is
 *     written as a Boolean-constant collection, 0x85 with packed bits
 *     (`isBooleanConstants`, sigma/ast/values.scala:871-875; ConcreteCollectionBooleanConstantSerializer);
 *   - a MethodCall without arguments is written as a PropertyCall, 0xdb
 *     (`companion = if (args.isEmpty) PropertyCall else MethodCall`, values.scala:1351;
 *     PropertyCallSerializer.scala:20-28).
 * Every expected re-encoding below is from a live sigma-state 6.0.6 probe (deserializeErgoTree under
 * VersionContext(3, 3), then serializeErgoTree).
 */
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseTree, serializeTree, parseErgoTreeBytes } from '../../src/wire/ergo-tree'
import { reencodeTreeBytes } from '../../src/wire/box-tree'
import { isUnparsedTree } from '../../src/mir/types'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const errOf = (f: () => unknown): unknown => { try { f(); return undefined } catch (e) { return e } }

/** The box-rules parse (rule 1001) of `h`, re-encoded, as the JVM's box path writes it. */
const reencoded = (h: string): string => toHex(reencodeTreeBytes(parseErgoTreeBytes(new ByteReader(hex(h)))))

describe('a ConcreteCollection of Boolean constants re-encodes as 0x85', () => {
  for (const [name, wire, jvm] of [
    ['two items (AND(Coll(true, false)))', '00d19683020101010100', '00d196850201'],
    ['no items', '00d196830001', '00d1968500'],
    ['nine items, packed over two bytes', '00d196830901' + '0101'.repeat(4) + '0100'.repeat(4) + '0101', '00d19685090f01'],
    ['in a sized v3 tree, whose size is recomputed', '0b09d19683020101010100', '0b05d196850201'],
    ['the inner collection of a Coll[Coll[Boolean]]', '00d193b183010d83010101010402', '00d193b183010d8501010402'],
  ] as const) {
    it(`${name}: ${wire} → ${jvm}`, () => {
      expect(toHex(serializeTree(parseTree(hex(wire))))).toBe(jvm)
      expect(reencoded(wire)).toBe(jvm)
    })
  }
  for (const [name, wire] of [
    ['a placeholder is not a constant: the collection stays 0x83', '10010101d19683020173000100'],
    ['a Coll[Int] of Int constants stays 0x83', '00d193b1830204040004020404'],
    ['a 0x85 collection re-encodes as received', '00d196850201'],
  ] as const) {
    it(`${name}`, () => {
      expect(reencoded(wire)).toBe(wire)
    })
  }
  it('a Coll[Boolean] whose constant item is not a Boolean cannot be re-encoded', () => {
    // 00 d1 96 83 01 01 04 00: AND(Coll[Boolean](Int 0)). The JVM rejects it at parse, where
    // ConcreteCollectionSerializer asserts each item's type (:38); ergots does not check item
    // types (residual 9), so it parses, and its re-encoding fails where the JVM's
    // ConcreteCollectionBooleanConstantSerializer (:22-27) would: an item is a Constant, but not a
    // Boolean one.
    const tree = parseTree(hex('00d1968301010400'))
    expect(isUnparsedTree(tree)).toBe(false)
    expect(errOf(() => serializeTree(tree))).toMatchObject({ name: 'ExprSerializeError', code: 'collection-item-not-boolean-constant' })
  })
})

describe('a MethodCall without arguments re-encodes as a PropertyCall, 0xdb', () => {
  for (const [name, wire, jvm] of [
    ['SELF.value > 0L in a v0 tree', '00d191dc6301a7000500', '00d191db6301a70500'],
    ['the same in a sized v1 tree, whose size is recomputed', '0909d191dc6301a7000500', '0908d191db6301a70500'],
  ] as const) {
    it(`${name}: ${wire} → ${jvm}`, () => {
      expect(toHex(serializeTree(parseTree(hex(wire))))).toBe(jvm)
      expect(reencoded(wire)).toBe(jvm)
    })
  }
  it('the re-encoding reads back as a PropertyCall with the same method and receiver', () => {
    const again = parseTree(hex('00d191db6301a70500'))
    if (isUnparsedTree(again) || again.body.tag !== 'BoolToSigmaProp') throw new Error('unexpected tree')
    const gt = again.body.input
    if (gt.tag !== 'BinOp') throw new Error('expected GT')
    expect(gt.left).toMatchObject({ tag: 'PropertyCall', typeId: 99, methodId: 1, obj: { tag: 'GlobalVars', kind: 'SelfBox' } })
  })
  for (const [name, wire] of [
    ['Coll.indexOf with two arguments stays 0xdc', '00d193dc0c1a10010202040204000400'],
    ['the same in a sized v1 tree', '090fd193dc0c1a10010202040204000400'],
  ] as const) {
    it(name, () => {
      expect(reencoded(wire)).toBe(wire)
    })
  }
})
