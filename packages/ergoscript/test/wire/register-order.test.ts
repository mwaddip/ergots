// JVM ErgoBoxCandidate.scala:226-234: for each register, resolve its id (an index error at the
// 7th), read the whole value (r.getValue()), THEN run CheckV6Type (rule 1019).
import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseAdditionalRegisters } from '../../src/wire/parse-svalue'
import { parseTree } from '../../src/wire/ergo-tree'
import { isUnparsedTree } from '../../src/mir/types'
import { validHeaderData } from './_helpers'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const codeOf = (f: () => unknown) => { try { f(); return 'no-throw' } catch (e) { return (e as { code?: string }).code } }

// SType codes as in register-v6-type-rule1019.test.ts: Option[Int] = 0x28 (3*12 + 4),
// Int = 0x04, SHeader = 0x68 (104). Some(Int 5) = 01 0a; Int 5 = 0a.
describe('rule 1019 after the value', () => {
  it('an SHeader register at tree version 0 fails on its data first (hard), not rule 1019', () => {
    const code = codeOf(() => parseAdditionalRegisters(new ByteReader(hex('016800')), 0))
    expect(code).toBe('sheader-tree-version-too-low')
  })
  it('a well-formed Option[Int] register at tree version 3 still fails rule 1019', () => {
    expect(codeOf(() => parseAdditionalRegisters(new ByteReader(hex('0128010a')), 3))).toBe('register-v6-type')
  })
  it('a Tuple register (Option[Int], Int) fails rule 1019 only after both items are read', () => {
    // 01 (1 register) | 86 02 (Tuple, 2 items) | 28 01 0a (Option[Int] Some 5) | 04 0a (Int 5)
    const r = new ByteReader(hex('018602' + '28010a' + '040a'))
    expect(codeOf(() => parseAdditionalRegisters(r, 3))).toBe('register-v6-type')
    expect(r.position).toBe(8)   // all bytes read before the check
  })
  it('an UnsignedBigInt register longer than 32 bytes fails on its data first (hard), not rule 1019', () => {
    // 09 (UnsignedBigInt) | 21 (length 33): a SerializerException in the data read (CoreDataSerializer.scala:118-122).
    expect(codeOf(() => parseAdditionalRegisters(new ByteReader(hex('010921')), 3))).toBe('unsigned-bigint-too-large')
  })
})

describe('the seventh register', () => {
  it('seven registers: R4–R9 are read before the reject', () => {
    const r = new ByteReader(hex('07' + '040a'.repeat(7)))
    expect(codeOf(() => parseAdditionalRegisters(r, 0))).toBe('sbox-registers-out-of-range')
    expect(r.position).toBe(1 + 6 * 2)
  })
})

describe('register Tuple arity (TupleSerializer.scala:28-31: a signed getByte, then safeNewArray)', () => {
  it('an arity of 128 rejects right after the count, before any item', () => {
    const r = new ByteReader(hex('018680' + '040a'))
    expect(codeOf(() => parseAdditionalRegisters(r, 0))).toBe('sbox-register-tuple-arity')
    expect(r.position).toBe(3)
  })
  it('an arity of 127 is within the bound: its items are read', () => {
    // Item 1 (Int 5) is read; item 2's first-byte peek meets the end of the input.
    const r = new ByteReader(hex('01867f' + '040a'))
    expect(codeOf(() => parseAdditionalRegisters(r, 0))).toBe('truncated')
    expect(r.position).toBe(5)
  })
})

// r.getValue() lowers the level it raised once the value is read (ValueSerializer.scala:409),
// and only then does CheckV6Type run (ErgoBoxCandidate.scala:231-232). So a rule-1019 failure
// leaves none of the register's levels on the reader, which matters when a degrade catches it.
describe('the register value lowers its level before rule 1019', () => {
  it.each([
    ['Constant', '0128010a'],
    ['Tuple', '018602' + '28010a' + '040a'],
  ])('a %s register failing rule 1019 leaves the reader at the level the loop began at', (_, regs) => {
    const r = new ByteReader(hex(regs))
    expect(codeOf(() => parseAdditionalRegisters(r, 3))).toBe('register-v6-type')
    expect(r.level).toBe(0)
  })
})

// A sized tree whose one segregated constant is a Box (the W7 layout, register-v6-type-rule1019.test.ts):
//   header | declared size (VLQ) | 01 (one constant) | 63 (SBox) | c0843d (value) | the Box's tree
//   | 00 (creation height) | 00 (tokens) | register count | registers | 32 × 00 (txId) | 00 (index) | c17300 (body)
// The declared size is everything after it, so a degrade's span is the whole input.
// Rule 1019 is a ValidationException (ValidationRules.scala:174-176), which the enclosing sized tree's
// catch turns into an UnparsedErgoTree (ErgoTreeSerializer.scala:196-203); a hard error escapes it.
const sizedTreeWithBox = (header: string, boxTree: string, regCount: string, regs: string): Uint8Array => {
  const rest = hex('01' + '63' + 'c0843d' + boxTree + '00' + '00' + regCount + regs + '00'.repeat(32) + '00' + 'c17300')
  const w = new ByteWriter()
  w.writeU8(parseInt(header, 16))
  w.writeVlqU(rest.length)
  w.writeBytes(rest)
  return w.toBytes()
}

describe('inside a sized tree (a nested Box constant\'s registers)', () => {
  it('seven registers whose R4 fails rule 1019: the tree degrades before the seventh is reached', () => {
    // v3 tree (1b), its Box's tree v3 sized with a SigmaProp root (0b 02 08 d3), 7 registers, R4 = Option[Int] Some 5.
    const bytes = sizedTreeWithBox('1b', '0b0208d3', '07', '28010a')
    const tree = parseTree(bytes)
    if (!isUnparsedTree(tree)) throw new Error('expected the tree to degrade')
    expect(tree.unparsedBytes).toEqual(bytes)   // bodyPos 2 + declared 51 = all 53 bytes
    expect((tree.error as { code?: string }).code).toBe('register-v6-type')
  })
  it.each([
    // The index error on the 6-element nonMandatoryRegisters (ErgoBoxCandidate.scala:230; ErgoBox.scala:178-179).
    ['a seventh register', '07', '040a'.repeat(6), 'sbox-registers-out-of-range'],
    // A negative arity: NegativeArraySizeException in safeNewArray (TupleSerializer.scala:28-31).
    ['a register Tuple of arity 128', '01', '8680', 'sbox-register-tuple-arity'],
  ])('%s is a hard error: the tree rejects with it and does not degrade', (_, regCount, regs, code) => {
    // Neither is a ValidationException, the only kind the degrade catches (ErgoTreeSerializer.scala:196-197),
    // nor one its inner catch converts (:188-194).
    expect(codeOf(() => parseTree(sizedTreeWithBox('1b', '0b0208d3', regCount, regs)))).toBe(code)
  })

  // A Box's registers are read under the ENCLOSING tree's version, not the Box tree's own:
  // VersionContext.withVersions (a DynamicVariable, VersionContext.scala:99-100) covers only the Box
  // tree's own parse (ErgoTreeSerializer.scala:154), which returns (ErgoBoxCandidate.scala:194) before
  // the registers are read (:226). The two tests below give the two trees different versions.
  it('a v1 tree whose Box tree is v3 reads its SHeader register at v1: a hard error, the tree does not degrade', () => {
    // v1 tree (19); its Box's tree v3 (0b 02 08 d3); R4 = SHeader. SHeader data below v3 is a
    // SerializerException (DataSerializer.scala:45-46 → CoreDataSerializer.scala:144-146).
    const bytes = sizedTreeWithBox('19', '0b0208d3', '01', '68010a')
    expect(codeOf(() => parseTree(bytes))).toBe('sheader-tree-version-too-low')
  })
  it('a v3 tree whose Box tree is v1 reads its valid SHeader register at v3: rule 1019 degrades the tree', () => {
    // v3 tree (1b); its Box's tree v1 (09 02 08 d3); R4 = SHeader with valid data. At v3 the data parses
    // (DataSerializer.scala:39-44), then rule 1019 fails it: a ValidationException, so the sized tree
    // degrades. Read at the Box tree's v1, the data would be a hard error and the tree would reject.
    const bytes = sizedTreeWithBox('1b', '090208d3', '01', '68' + toHex(validHeaderData()))
    const tree = parseTree(bytes)
    if (!isUnparsedTree(tree)) throw new Error('expected the tree to degrade')
    expect(tree.unparsedBytes).toEqual(bytes)
    expect((tree.error as { code?: string }).code).toBe('register-v6-type')
  })
})
