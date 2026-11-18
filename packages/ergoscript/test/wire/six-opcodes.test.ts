// The six opcodes above LastConstantCode (0x70) that the JVM registers a serializer for
// (ValueSerializer.scala:79-80, 97, 145-147): TrueLeaf (0x7f) and FalseLeaf (0x80) are Boolean
// constants, TaggedVariable (0x71) reads a byte id and a type, the three ModQ operations
// (0xe7, 0xe8, 0xe9) read one or two values. All six parse here, as in the JVM. TrueLeaf and
// FalseLeaf write back through the constant path (`ValueSerializer.scala:362-370`), so a tree
// holding one comes back with `01 01` / `01 00` in its place; the other four write back to
// their own bytes.
import { describe, it, expect } from 'vitest'
import { ByteReader, ByteWriter, ReaderError } from '@ergots/scorex'
import { parseExpr, ExprParseError } from '../../src/wire/parse'
import { parseTree, serializeTree, ErgoTreeParseError } from '../../src/wire/ergo-tree'
import { parseSValue, SValueParseError } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { serializeExpr } from '../../src/wire/serialize'
import { exprTpe } from '../../src/mir/expr-tpe'
import { ExprSerializeError } from '../../src/wire/errors'
import { childrenOf } from '../../src/eval/_substitute-deserialize'
import { isUnparsedTree } from '../../src/mir/types'
import { sp, EQ, int, bool, bigInt, ModQ, PlusModQ, MinusModQ, TaggedVariable, T } from '../_helpers/mir-build'
import type { Expr } from '../../src/mir/types'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('TrueLeaf 7f and FalseLeaf 80', () => {
  it('7f parses as the node 01 01 gives', () => {
    const fromOp = parseExpr(new ByteReader(hex('7f')), [], [], new Map(), 0)
    const fromConst = parseExpr(new ByteReader(hex('0101')), [], [], new Map(), 0)
    expect(fromOp).toEqual(fromConst)
    // parseExpr reads exactly its opcode; the reader is exhausted.
    const r = new ByteReader(hex('7f'))
    parseExpr(r, [], [], new Map(), 0)
    expect(r.remaining).toBe(0)
  })

  it('80 parses as the node 01 00 gives', () => {
    const fromOp = parseExpr(new ByteReader(hex('80')), [], [], new Map(), 0)
    const fromConst = parseExpr(new ByteReader(hex('0100')), [], [], new Map(), 0)
    expect(fromOp).toEqual(fromConst)
    const r = new ByteReader(hex('80'))
    parseExpr(r, [], [], new Map(), 0)
    expect(r.remaining).toBe(0)
  })

  it('an unsized tree: 00 d1 7f round-trips to 00 d1 01 01', () => {
    // SANTA box-c3-trueleaf-opcode-accept#2: the JVM parses the opcode and writes the tree
    // from its structure, so a round-trip is not the identity.
    expect(toHex(serializeTree(parseTree(hex('00d17f'))))).toBe('00d10101')
    // box-c3-falseleaf-opcode-accept#3.
    expect(toHex(serializeTree(parseTree(hex('00d180'))))).toBe('00d10100')
  })

  it('a size-flagged tree parses and is no unparsed tree', () => {
    const t = parseTree(hex('0b02d17f'))
    expect(isUnparsedTree(t)).toBe(false)
    if (isUnparsedTree(t)) throw new Error('unreachable')
    const ref = parseTree(hex('0b03d10101'))
    if (isUnparsedTree(ref)) throw new Error('unreachable')
    expect(t.body).toEqual(ref.body)
  })

  it('a size-flagged tree holding 80: parses and its body equals that of 0b03d10100', () => {
    const t = parseTree(hex('0b02d180'))
    expect(isUnparsedTree(t)).toBe(false)
    if (isUnparsedTree(t)) throw new Error('unreachable')
    const ref = parseTree(hex('0b03d10100'))
    if (isUnparsedTree(ref)) throw new Error('unreachable')
    expect(t.body).toEqual(ref.body)
  })

  it('80 in an output box: the tree is written in the constant form with its true size', () => {
    // The bytes of SANTA box-c3-falseleaf-opcode-accept#3, with the tree `00d180` replaced by
    // `0b02d180`. The JVM re-encodes a parsed box tree from its structure
    // (ErgoBoxCandidate.scala:142; ErgoTreeSerializer.scala:105-127): the Boolean constant writes
    // back as `01 00` and the size recomputes to 3, so the tree comes back as `0b03d10100`.
    const input = hex('c0843d0b02d1800100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400')
    const expected = 'c0843d0b03d101000100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'
    const box = parseSValue({ tag: 'SBox' }, 3, new ByteReader(input))
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, box, 3, w)
    expect(toHex(w.toBytes())).toBe(expected)
  })

  it('7f takes one reader level, an inline constant two', () => {
    // ValueSerializer.scala:395-409 raises the reader level once for any value; a constant then
    // goes through the data serializer, which raises it again (CoreDataSerializer.scala:99-101),
    // and CaseObjectSerialization reads nothing (CaseObjectSerialization.scala:10-18). So the
    // deepest chain of a one-operand node over 7f that parses is exactly one deeper than the
    // deepest over `01 01`. ModQ's reader (0xe7) is the one-operand opcode, as in the ModQ
    // depth test below: its erased `asBigInt` cast accepts an operand of any type at parse.
    const maxFor = (tail: string): number => {
      let n = 1
      for (;;) {
        const body = 'e7'.repeat(n) + tail
        try {
          parseExpr(new ByteReader(hex(body)), [], [], new Map(), 0)
          n++
        } catch {
          return n - 1
        }
        if (n > 1000) throw new Error('unexpected: parseExpr never halted')
      }
    }
    expect(maxFor('7f') - maxFor('0101')).toBe(1)
  })

  it('in an output box the tree is written in the constant form with its true size', () => {
    // The bytes of SANTA box-c3-trueleaf-opcode-accept#2, with the tree `00d17f` replaced by
    // `0b02d17f` (the size-flagged variant of the same two-byte body). The JVM re-encodes a
    // parsed box tree from its structure (ErgoBoxCandidate.scala:142; ErgoTreeSerializer.scala:105-127):
    // the Boolean constant writes back as `01 01` and the size recomputes to 3, so the tree
    // comes back as `0b03d10101`.
    // Before the 7f/80 readers existed this test's input round-tripped to its own bytes: the
    // tree degraded on `7f`'s `'opcode-reserved'` and the box re-encode kept its bytes
    // verbatim (`reencodeTreeBytes` for an unparsed tree, `box-tree.ts:36`).
    const input = hex('c0843d0b02d17f0100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400')
    const expected = 'c0843d0b03d101010100001d823ee9ea823cc80232a19181efad41d66849c33ed5d0d6c5750b8d60f1d66400'
    const box = parseSValue({ tag: 'SBox' }, 3, new ByteReader(input))
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, box, 3, w)
    expect(toHex(w.toBytes())).toBe(expected)
  })

  it('beside a placeholder in a constant-segregated tree', () => {
    // v0 segregated (header 0x10), one Boolean constant (count 01, type 01, value 01), body:
    //   d1 (BoolToSigmaProp) ed (BinAnd) 73 00 (ConstantPlaceholder id 0) 7f (TrueLeaf)
    // SigmaSerializer.scala:52-57: `startWriter()` constructs the writer with
    // `constantExtractionStore = None`, so the Boolean constant goes in-line in the body, not into
    // the constants section.
    const withOp = hex('100101' + '01' + 'd1ed7300' + '7f')
    const withConst = hex('100101' + '01' + 'd1ed7300' + '0101')
    const ta = parseTree(withOp)
    const tb = parseTree(withConst)
    if (isUnparsedTree(ta) || isUnparsedTree(tb)) throw new Error('unreachable')
    expect(ta.body).toEqual(tb.body)
    expect(toHex(serializeTree(ta))).toBe(toHex(withConst))
    expect(toHex(serializeTree(tb))).toBe(toHex(withConst))
  })

  it('as the items of a collection', () => {
    // v0 plain, body: d1 (BoolToSigmaProp) b2 (ByIndex)
    //   input: 83 02 01 <a> <b>   — OP_COLL, count 2, elem SBoolean, two one-byte items
    //   index: 04 00              — Const(SInt, 0)
    //   default: 00               — None
    // With the items as 7f, 80 and with the items as 01 01, 01 00: parseTree yields the same
    // body, and serializeTree yields the same bytes (the JVM's companion writes a Coll[Boolean]
    // of constants as OP_COLL_OF_BOOL_CONST, ConcreteCollection.companion at values.scala:871-875,
    // so neither comes back as OP_COLL).
    const withOps = hex('00d1b28302017f80' + '0400' + '00')
    const withConsts = hex('00d1b283020101010100' + '0400' + '00')
    const ta = parseTree(withOps)
    const tb = parseTree(withConsts)
    if (isUnparsedTree(ta) || isUnparsedTree(tb)) throw new Error('unreachable')
    expect(ta.body).toEqual(tb.body)
    expect(toHex(serializeTree(ta))).toBe(toHex(serializeTree(tb)))
  })

  it('7f and 80: no other value of the opcode byte gives the same written tree', () => {
    // For each of `00d17f` and `00d180`, for every other value of the opcode byte, either
    // parseTree throws or serializeTree(parseTree(changed)) differs from the original's written
    // form (`00d10101` for 7f, `00d10100` for 80; 7f and 80 write back through the constant
    // path, so the round-trip is not the identity).
    for (const [input, writtenForm] of [['00d17f', '00d10101'], ['00d180', '00d10100']] as const) {
      const orig = hex(input)
      const origByte = orig[2]!
      for (let v = 0; v <= 255; v++) {
        if (v === origByte) continue
        const changed = new Uint8Array(orig)
        changed[2] = v
        let parsed: ReturnType<typeof parseTree> | undefined
        try {
          parsed = parseTree(changed)
        } catch {
          continue
        }
        let out: Uint8Array
        try {
          out = serializeTree(parsed)
        } catch {
          continue
        }
        expect(
          toHex(out),
          `${input}: changing byte 2 from 0x${origByte.toString(16)} to 0x${v.toString(16)} round-trips to the written form`,
        ).not.toBe(writtenForm)
      }
    }
  })

  describe('a v3 MethodCall with no argument whose object is TrueLeaf is a hard reject', () => {
    // The six rows of SANTA's ErgoTree.methodcall_type_id_order.json (jvm:sigma-state-6.0.7).
    // Rows #0, #1, #3 and #4 do not reach the 7f/80 readers, and are included for completeness:
    // the pair #0/#1 pin the truncation at the method id, #3 pins the SAny data read before the
    // method lookup, #4 pins the v1 degrade on rule 1010.
    type Expectation =
      | { cls: new (...args: never[]) => Error; code: string; cause?: string }
      | { parses: true; bytes: string }
    const rows: Array<{ name: string; bytes: string; expect: Expectation }> = [
      { name: 'ends-at-method-id-methodcall-v1-tree#0', bytes: '0902dcff', expect: { cls: ReaderError, code: 'truncated' } },
      { name: 'ends-at-method-id-propertycall-v1-tree#1', bytes: '0902dbff', expect: { cls: ReaderError, code: 'truncated' } },
      { name: 'v3-args-assert-tree#2', bytes: '0b05dcff017f00', expect: { cls: ExprParseError, code: 'method-call-empty-args' } },
      { name: 'sany-obj-v1-tree#3', bytes: '0905dcff016100', expect: { cls: SValueParseError, code: 'not-implemented-phase-2a' } },
      { name: 'v1-degrades-tree#4', bytes: '0905dcff017f00', expect: { parses: true, bytes: '0905dcff017f00' } },
      { name: 'v1-unsized-tree#5', bytes: '00dcff017f00', expect: { cls: ErgoTreeParseError, code: 'soft-fork-without-size-bit', cause: 'method-type-no-methods' } },
    ]
    for (const row of rows) {
      it(row.name, () => {
        if ('parses' in row.expect) {
          const t = parseTree(hex(row.bytes))
          expect(isUnparsedTree(t)).toBe(true)
          expect(toHex(serializeTree(t))).toBe(row.expect.bytes)
          return
        }
        let err: unknown
        try {
          parseTree(hex(row.bytes))
        } catch (e) {
          err = e
        }
        expect(err, `${row.name}: expected a reject`).toBeInstanceOf(row.expect.cls)
        expect((err as { code?: string }).code).toBe(row.expect.code)
        if (row.expect.cause !== undefined) {
          expect(((err as Error).cause as { code?: string }).code).toBe(row.expect.cause)
        }
      })
    }
  })
})

describe('ModQ e7, PlusModQ e8, MinusModQ e9', () => {
  it('parse to their nodes and round-trip', () => {
    // SANTA unevaluated-mod_q-v0-box#3, -plus_mod_q-v0-box#4, -minus_mod_q-v0-box#5: the trees in the
    // boxes `c0843d00d193e7060101060101…` etc. `sp(EQ(ModQ(bigInt(1)), bigInt(1)))` is the parsed body.
    const cases: Array<[string, Expr]> = [
      ['00d193e7060101060101', sp(EQ(ModQ(bigInt(1)), bigInt(1)))],
      ['00d193e8060101060101060101', sp(EQ(PlusModQ(bigInt(1), bigInt(1)), bigInt(1)))],
      ['00d193e9060101060101060101', sp(EQ(MinusModQ(bigInt(1), bigInt(1)), bigInt(1)))],
    ]
    for (const [bytes, body] of cases) {
      const t = parseTree(hex(bytes))
      if (isUnparsedTree(t)) throw new Error(`unreachable: ${bytes}`)
      expect(t.body).toEqual(body)
      expect(toHex(serializeTree(t))).toBe(bytes)
    }
  })

  // No operand check. `ModQSerializer.parse` and `ModQArithOpSerializer.parse` cast the operand(s)
  // through the erased `asBigInt` (`ast/syntax.scala:144`), so an operand of any type is accepted.
  // Neither constructor has a `require` (`ast/trees.scala:954-972`).
  it('no operand check', () => {
    // sp(EQ(ModQ(true), bigInt(1))): tree `00d193e70101060101`; the JVM parses it.
    const modq = parseTree(hex('00d193e70101060101'))
    if (isUnparsedTree(modq)) throw new Error('unreachable')
    expect(modq.body).toEqual(sp(EQ(ModQ(bool(true)), bigInt(1))))
    // sp(EQ(PlusModQ(true, false), bigInt(1))): tree `00d193e801010100060101`.
    const plus = parseTree(hex('00d193e801010100060101'))
    if (isUnparsedTree(plus)) throw new Error('unreachable')
    expect(plus.body).toEqual(sp(EQ(PlusModQ(bool(true), bool(false)), bigInt(1))))
  })

  it('the static type is BigInt', () => {
    // ModQ at v3 (reads do not matter for static type) and PlusModQ at v0.
    expect(exprTpe(ModQ(bool(true)), 3)).toEqual({ tag: 'SBigInt' })
    expect(exprTpe(PlusModQ(int(1), int(2)), 0)).toEqual({ tag: 'SBigInt' })
  })

  it('one reader level each', () => {
    // n × `e7` with a trailing `06 01 01` (Const SBigInt 1), and n × `f1` (BitInversion) with a
    // trailing `04 02` (Const SInt 1): ModQ's one-level enterDepth matches BitInversion's, so the
    // largest n for which parseExpr accepts is the same.
    const maxFor = (opcode: string, tail: string): number => {
      let n = 1
      for (;;) {
        const body = opcode.repeat(n) + tail
        try {
          parseExpr(new ByteReader(hex(body)), [], [], new Map(), 0)
          n++
        } catch {
          return n - 1
        }
        if (n > 1000) throw new Error('unexpected: parseExpr never halted')
      }
    }
    expect(maxFor('e7', '060101')).toBe(maxFor('f1', '0402'))
  })

  it('a size-flagged tree parses', () => {
    // 0b (v3 sized) + 09 (body size 9) + the 9-byte body of the ModQ tree above.
    const bytes = '0b09d193e7060101060101'
    const t = parseTree(hex(bytes))
    expect(isUnparsedTree(t)).toBe(false)
    expect(toHex(serializeTree(t))).toBe(bytes)
  })

  it('e8 and e9 in a size-flagged tree parse and round-trip to themselves', () => {
    // 0b (v3 sized) + 0c (body size 12) + the 12-byte bodies of the PlusModQ and MinusModQ trees
    // above. SANTA Box.unevaluated_node_kinds rows #17 and #18 hold these trees.
    for (const bytes of ['0b0cd193e8060101060101060101', '0b0cd193e9060101060101060101']) {
      const t = parseTree(hex(bytes))
      expect(isUnparsedTree(t)).toBe(false)
      expect(toHex(serializeTree(t))).toBe(bytes)
    }
  })
})

describe('TaggedVariable 71', () => {
  it('parses to its node and round-trips', () => {
    // SANTA unevaluated-tagged_variable-v0-box#7: `sp(TaggedVariable(1, Boolean))`, tree `00d1710101`.
    const t = parseTree(hex('00d1710101'))
    if (isUnparsedTree(t)) throw new Error('unreachable')
    expect(t.body).toEqual(sp(TaggedVariable(1, T.Bool)))
    expect(toHex(serializeTree(t))).toBe('00d1710101')
  })

  it('keeps a byte above 7f', () => {
    // The JVM reads the id with a signed `getByte()` (`TaggedVariableSerializer.scala`,
    // `TaggedVariableNode(varId, tpe)`, `values.scala:455`); ergots keeps it as an unsigned byte
    // in [0, 255]. ff is a valid id byte and round-trips verbatim.
    const t = parseTree(hex('00d171ff01'))
    if (isUnparsedTree(t)) throw new Error('unreachable')
    expect(t.body).toEqual(sp(TaggedVariable(255, T.Bool)))
    expect(toHex(serializeTree(t))).toBe('00d171ff01')
  })

  it('a size-flagged tree parses', () => {
    // 0b (v3 sized) + 04 (body size 4) + `d1 71 01 01` (sp(TaggedVariable(1, Bool))).
    const bytes = '0b04d1710101'
    const t = parseTree(hex(bytes))
    expect(isUnparsedTree(t)).toBe(false)
    expect(toHex(serializeTree(t))).toBe(bytes)
  })

  it('the static type is the type read', () => {
    expect(exprTpe(TaggedVariable(1, T.Int), 0)).toEqual(T.Int)
  })

  // The type is read at the tree's version. 0x09 is SUnsignedBigInt (id 9), which is embeddable
  // from v3 only (rule 1017 CheckPrimitiveTypeCodeV6). An unsized v0 tree wraps the soft type-read
  // failure in 'soft-fork-without-size-bit'.
  it('the type is read at the tree version', () => {
    let err: unknown
    try {
      parseTree(hex('00d1710109'))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ErgoTreeParseError)
    expect((err as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit')
    const cause = (err as Error).cause
    expect((cause as { name?: string }).name).toBe('STypeParseError')
    expect((cause as { code?: string }).code).toBe('type-code-primitive-unknown')
  })

  // The writer refuses an id that is no byte. The JVM holds the id as a signed Byte and emits it
  // via `put(varId)`; ergots keeps the unsigned byte [0, 255] and rejects at the write otherwise,
  // as `serializeGetVar` does for its id.
  it('the writer refuses an id that is no byte', () => {
    for (const id of [256, -1, 1.5]) {
      let err: unknown
      try {
        serializeExpr(TaggedVariable(id, T.Bool), new ByteWriter(), 0)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ExprSerializeError)
      expect((err as ExprSerializeError).code).toBe('tagged-variable-id-out-of-range')
    }
  })
})

describe('all four', () => {
  // A payload that ends early is a hard error. The operand reads (and the varId / type reads)
  // use the standard `parseExpr` / `r.readU8` / `parseSType` paths, which raise
  // `ReaderError('truncated')` on an empty read. The code is not in the degrade set, so a sized
  // tree does not degrade on it.
  it('a payload that ends early is a hard error', () => {
    for (const bytes of ['e7', 'e8060101', '7101']) {
      let err: unknown
      try {
        parseExpr(new ByteReader(hex(bytes)), [], [], new Map(), 0)
      } catch (e) {
        err = e
      }
      expect(err, `parseExpr(${bytes})`).toBeInstanceOf(ReaderError)
      expect((err as ReaderError).code).toBe('truncated')
    }
    // Inside a size-flagged tree the hard error propagates and the tree does not degrade.
    let err: unknown
    try {
      parseTree(hex('0b01e7'))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ReaderError)
    expect((err as ReaderError).code).toBe('truncated')
  })

  it('the substitution walks reach the operands', () => {
    const a: Expr = bigInt(1)
    const b: Expr = bigInt(2)
    expect([...childrenOf(ModQ(a))]).toEqual([a])
    expect([...childrenOf(PlusModQ(a, b))]).toEqual([a, b])
    expect([...childrenOf(TaggedVariable(1, T.Bool))]).toEqual([])
  })

  it('no byte of the node is ignored', () => {
    // For each of the four trees, and for each node-position byte, every other value of that
    // byte either fails `parseTree` or writes back to bytes different from the original. For
    // TaggedVariable's id byte every value also round-trips as the identity (the writer emits
    // the raw byte).
    type Case = { name: string; bytes: string; positions: number[]; identityIdPos?: number }
    const cases: Case[] = [
      // 00 (header) d1 (BoolToSigmaProp) 93 (EQ) e7 (ModQ opcode, index 3) 06 01 01 (BigInt 1) 06 01 01 (BigInt 1).
      { name: 'ModQ', bytes: '00d193e7060101060101', positions: [3] },
      // 00 d1 93 e8 (PlusModQ opcode, index 3) 06 01 01 06 01 01 (two PlusModQ operands) 06 01 01 (EQ right).
      { name: 'PlusModQ', bytes: '00d193e8060101060101060101', positions: [3] },
      // 00 d1 93 e9 (MinusModQ opcode, index 3) 06 01 01 06 01 01 06 01 01.
      { name: 'MinusModQ', bytes: '00d193e9060101060101060101', positions: [3] },
      // 00 d1 71 (TaggedVariable opcode, index 2) 01 (varId, index 3) 01 (SBoolean type, index 4).
      // The id writer is the identity for every value.
      { name: 'TaggedVariable', bytes: '00d1710101', positions: [2, 3, 4], identityIdPos: 3 },
    ]
    for (const c of cases) {
      const orig = hex(c.bytes)
      for (const pos of c.positions) {
        const origByte = orig[pos]
        for (let v = 0; v <= 255; v++) {
          if (v === origByte) continue
          const changed = new Uint8Array(orig)
          changed[pos] = v
          let parsed: ReturnType<typeof parseTree> | undefined
          try {
            parsed = parseTree(changed)
          } catch {
            continue
          }
          let out: Uint8Array
          try {
            out = serializeTree(parsed)
          } catch {
            continue
          }
          expect(
            toHex(out),
            `${c.name}: changing byte ${pos} from 0x${origByte!.toString(16)} to 0x${v.toString(16)} round-trips to the original bytes`,
          ).not.toBe(c.bytes)
          if (pos === c.identityIdPos) {
            expect(
              toHex(out),
              `${c.name}: changing id byte ${pos} to 0x${v.toString(16)} should round-trip as itself`,
            ).toBe(toHex(changed))
          }
        }
      }
    }
  })
})
