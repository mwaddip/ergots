/**
 * A register value, and a register Tuple's item, is read with the JVM's `r.getValue()`
 * (ErgoBoxCandidate.scala:231, TupleSerializer.scala:32-34), which looks up the serializer for the
 * value's first byte and runs rule 1002 `CheckValidOpCode` on it (ValueSerializer.scala:171-175): an
 * opcode with no serializer raises a ValidationException, which degrades an enclosing sized tree
 * and, without a size bit, rejects it. An opcode the JVM does parse builds a node that the register
 * then casts to an evaluated value (`asInstanceOf[EvaluatedValue]`, :231): a hard reject for a node
 * like HEIGHT (a ClassCastException).
 *
 * ergots classifies a lead byte as `parseExpr` does, without parsing the node's payload: an opcode
 * with no serializer throws `parseExpr`'s soft code, `'opcode-reserved'` or `'unknown-opcode'`; a
 * known opcode keeps the hard `'sbox-register-unsupported-expr'`. The six opcodes the JVM parses but
 * `parseExpr` rejects (residual 5) stay hard too.
 *
 * Every JVM verdict below is from a live sigma-state 6.0.6 probe (the tree as output 0 of a
 * transaction, parsed under VersionContext(3, 3)).
 */
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseTreeFromReader } from '../../src/wire/ergo-tree'
import { parseAdditionalRegisters } from '../../src/wire/parse-svalue'
import { isUnparsedTree } from '../../src/mir/types'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const errOf = (f: () => unknown): unknown => { try { f(); return undefined } catch (e) { return e } }

/** Box data: value 1, the tree `00 08 d3`, creation height 0, no tokens, the registers, a 0x11 tx id, index 0. */
const boxData = (regs: string) => '01' + '0008d3' + '0000' + regs + '11'.repeat(32) + '00'
/** A tree over one SBox constant: BoolToSigmaProp(GT(ExtractAmount(placeholder 0), 0L)). `18`: sized, segregated. */
const treeWithBox = (header: string, box: string) => {
  const inner = '0163' + box + 'd191c173000500'
  return header === '18' ? header + (inner.length / 2).toString(16) + inner : header + inner
}
/** The box-rules parse (rule 1001) of `t`, with the cursor after it. */
const boxRules = (t: string) => {
  const r = new ByteReader(hex(t))
  return { tree: parseTreeFromReader(r, { checkType: true }), position: r.position }
}

describe('a nested register lead with no JVM serializer degrades the enclosing sized tree', () => {
  for (const [name, r4, code] of [
    // The reviewer's example: 18 32 01 63 01 00 08 d3 00 00 01 84 <11 x 32> 00 d1 91 c1 73 00 05 00.
    ['lead 0x84, a byte in no opcode table', '84', 'unknown-opcode'],
    ['lead 0xd3, TrivialPropTrue, reserved', 'd3', 'opcode-reserved'],
    ['a Tuple item whose lead is 0x84', '860204' + '00' + '84', 'unknown-opcode'],
  ] as const) {
    it(`${name}: the JVM degrades T, and so does ergots`, () => {
      const t = treeWithBox('18', boxData('01' + r4))
      const { tree, position } = boxRules(t)
      expect(isUnparsedTree(tree)).toBe(true)
      if (isUnparsedTree(tree)) expect(tree.error).toMatchObject({ code })
      expect(position).toBe(t.length / 2)
    })
  }
  it('lead 0x84 in an unsized tree: rejected (the JVM SerializerException: no size bit)', () => {
    const err = errOf(() => boxRules(treeWithBox('10', boxData('0184'))))
    expect(err).toMatchObject({ code: 'soft-fork-without-size-bit' })
    expect((err as Error).cause).toMatchObject({ code: 'unknown-opcode' })
  })
  it('lead 0x84 outside any tree rejects with the soft code, which nothing degrades there', () => {
    // A top-level output's registers: the JVM rejects the transaction (ValidationException, rule 1002).
    expect(errOf(() => parseAdditionalRegisters(new ByteReader(hex('0184')), 0))).toMatchObject({ code: 'unknown-opcode' })
  })
})

describe('a nested register lead the JVM parses stays a hard reject', () => {
  for (const [name, r4] of [
    // JVM: ClassCastException, Height$ cannot be cast to EvaluatedValue.
    ['lead 0xa3, HEIGHT', 'a3'],
    // JVM: ClassCastException for ModQ and TaggedVariableNode (residual 5: parseExpr rejects both).
    ['lead 0xe7, ModQ(BigInt 5)', 'e7060105'],
    ['lead 0x71, TaggedVariable(1, Int)', '710104'],
  ] as const) {
    it(`${name}: rejected, as in the JVM`, () => {
      const t = treeWithBox('18', boxData('01' + r4))
      expect(errOf(() => boxRules(t))).toMatchObject({ code: 'sbox-register-unsupported-expr' })
    })
  }
})

describe('documented divergences at the register lead (residuals 4 and 5)', () => {
  // Pinned so a change to either is deliberate. Each JVM verdict is the probe's.
  for (const [name, r4, jvm] of [
    ['lead 0x7f, TrueLeaf (residual 5)', '7f', 'the JVM parses T and accepts R4 as a Boolean constant'],
    ['lead 0x80, FalseLeaf (residual 5)', '80', 'the JVM parses T and accepts R4 as a Boolean constant'],
    ['lead 0xd1 over a payload led by 0x84 (residual 4)', 'd184', 'the JVM reads the payload and degrades T'],
    ['lead 0xe7, ModQ, over a payload led by 0x84 (residual 5)', 'e784', 'the JVM reads the payload and degrades T'],
    ['a Tuple item led by 0xa3, HEIGHT (residual 4)', '860204' + '00' + 'a3', 'the JVM parses T: it casts only the Tuple node'],
  ] as const) {
    it(`${name}: ergots rejects, where ${jvm}`, () => {
      const t = treeWithBox('18', boxData('01' + r4))
      expect(errOf(() => boxRules(t))).toMatchObject({ code: 'sbox-register-unsupported-expr' })
    })
  }
})
