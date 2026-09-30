// Rule 1001 and an SAny the tree declares (sigma-state 6.0.6). The JVM fails a root whose type is
// SAny: the rule requires root.tpe.isSigmaProp, an isInstanceOf[SSigmaProp.type]
// (core/.../sigma/ast/package.scala:121). Type code 97 parses as SAny (TypeSerializer.scala:196);
// GetVar and DeserializeContext are built with no type check (SigmaBuilder.scala:479-480, 607-608);
// OptionGet.tpe = input.tpe.elemType (sigma/ast/transformers.scala:601); an Apply of an SAny
// function is NoType (sigma/ast/values.scala:1247-1251). ergots marks the declared SAny at its
// origin (parseSType returns SANY_JVM, the JVM's SAny). exprTpe mirrors the JVM node's tpe: it passes
// the JVM's SAny through where the JVM types it, and throws where the JVM's tpe casts it. A
// constructor's require of a numeric type is checkBuild's (wire/check-build.ts). ergots' own SAny, a
// fresh object its method typing makes (residual 1), keeps passing, and keeps passing rule 1001.
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseTree, parseErgoTreeBytes, parseTreeFromReader, serializeTree } from '../../src/wire/ergo-tree'
import { boxTreeOf } from '../../src/wire/box-tree'
import { parseSType } from '../../src/wire/parse-stype'
import { checkBuild } from '../../src/wire/check-build'
import { exprTpe } from '../../src/mir/expr-tpe'
import { isUnparsedTree, NOTYPE_JVM, SANY_JVM } from '../../src/mir/types'
import type { Expr, SType } from '../../src/mir/types'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const errOf = (f: () => unknown): unknown => { try { f(); return undefined } catch (e) { return e } }

// OptionGet(GetVar(1, SAny)): e4 OptionGet, e3 GetVar, id 01, type 61 (97, SAny)
// (GetVarSerializer.scala:18-19 reads the id, then the type).
const OPTION_GET_OF_GETVAR_SANY = 'e4e30161'
// DeserializeContext(SAny, 1): d4, type 61, id 01 (DeserializeContextSerializer.scala:20-21 reads the
// type, then the id).
const DESERIALIZE_CONTEXT_SANY = 'd46101'
// Apply(DeserializeContext(SAny, 1), [Int 0]): da, the function, one argument, 04 00.
const APPLY_OF_DECLARED_SANY = 'da' + DESERIALIZE_CONTEXT_SANY + '01' + '0400'

const PROBES: [string, string][] = [
  ['OptionGet(GetVar(1, SAny))', OPTION_GET_OF_GETVAR_SANY],
  ['DeserializeContext(SAny, 1)', DESERIALIZE_CONTEXT_SANY],
  ['Apply of a declared-SAny function (the JVM NoType)', APPLY_OF_DECLARED_SANY],
]

describe('rule 1001 fails a root typed as a declared SAny', () => {
  for (const [name, body] of PROBES) {
    it(`${name}, unsized: box ingest and parseTree with checkType reject`, () => {
      const bytes = hex('00' + body)
      for (const run of [() => parseErgoTreeBytes(new ByteReader(bytes)), () => parseTree(bytes, { checkType: true })]) {
        const err = errOf(run)
        expect(err).toMatchObject({ code: 'soft-fork-without-size-bit' })
        expect((err as Error).cause).toMatchObject({ code: 'root-not-sigma-prop' })
      }
    })
    it(`${name}, unsized: the lenient parse accepts`, () => {
      expect(isUnparsedTree(parseTree(hex('00' + body)))).toBe(false)
    })
    it(`${name}, sized: box ingest degrades it to the declared span`, () => {
      const bytes = hex('08' + (body.length / 2).toString(16).padStart(2, '0') + body)
      const r = new ByteReader(bytes)
      const tree = parseTreeFromReader(r, { checkType: true })
      expect(isUnparsedTree(tree)).toBe(true)
      if (isUnparsedTree(tree)) expect(tree.error).toMatchObject({ code: 'root-not-sigma-prop' })
      expect(r.position).toBe(bytes.length)
    })
  }
})

describe('the declared SAny is one object, from parseSType through exprTpe', () => {
  it('parseSType returns SANY_JVM for type code 97, also nested', () => {
    expect(parseSType(new ByteReader(hex('61')), 3)).toBe(SANY_JVM)
    // Option[SAny]: 0x24 (Option, recursive) then 0x61.
    const opt = parseSType(new ByteReader(hex('2461')), 3)
    expect(opt.tag === 'SOption' && opt.elem).toBe(SANY_JVM)
    expect(SANY_JVM).toEqual({ tag: 'SAny' })
  })
  it('exprTpe of OptionGet(GetVar(1, SAny)) is SANY_JVM', () => {
    const t = parseTree(hex('00' + OPTION_GET_OF_GETVAR_SANY))
    if (isUnparsedTree(t)) throw new Error('expected a parsed tree')
    expect(exprTpe(t.body, t.header.version)).toBe(SANY_JVM)
  })
})

// exprTpe mirrors the JVM node's tpe, including where that tpe throws. Three inputs: the JVM's SAny
// (a DeserializeContext declared SAny); the JVM's NoType, an Apply of that function
// (sigma/ast/values.scala:1247-1251), which exprTpe types as NOTYPE_JVM; and ergots' own SAny, a
// PropertyCall with an unregistered (typeId, methodId), whose exprTpe is a fresh { tag: 'SAny' } (the
// A3 fallback, residual 1). Every JVM verdict below is a live sigma-state 6.0.6 probe's (see
// rule-1001-jvm-sany-arms.test.ts for the trees).
const DECLARED: Expr = { tag: 'DeserializeContext', tpe: SANY_JVM, id: 1 }
const INT0: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }
const NOTYPE: Expr = { tag: 'Apply', func: DECLARED, args: [INT0] }
const UNRESOLVED: Expr = {
  tag: 'PropertyCall',
  obj: { tag: 'Const', tpe: { tag: 'SGroupElement' }, value: { kind: 'GroupElement', value: new Uint8Array(33) } },
  typeId: 999,
  methodId: 999,
  explicitTypeArgs: {},
}
const COLL_INT: Expr = { tag: 'Collection', kind: 'Exprs', elemTpe: { tag: 'SInt' }, items: [] }
const TRUE: Expr = { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } }
const FUNC: Expr = { tag: 'FuncValue', args: [{ id: 1, tpe: { tag: 'SInt' } }], body: TRUE }
const bitOr = (left: Expr, right: Expr): Expr => ({ tag: 'BinOp', op: { kind: 'Bit', op: 'BitOr' }, left, right })
// Apply(Int 0, []): the JVM's NoType for a function of a concrete type, which exprTpe types as
// NOTYPE_JVM (it threw 'apply-func-no-type' until 2026-09-30).
const CONCRETE_NOTYPE: Expr = { tag: 'Apply', func: INT0, args: [] }
const codeOf = (f: () => unknown): string | undefined => (errOf(f) as { code?: string } | undefined)?.code

describe('exprTpe types an Apply of the JVM SAny as the JVM NoType', () => {
  it('the JVM SAny function gives NOTYPE_JVM', () => {
    expect(exprTpe(NOTYPE, 0)).toBe(NOTYPE_JVM)
  })
  it('a NoType function gives NOTYPE_JVM', () => {
    expect(exprTpe({ tag: 'Apply', func: NOTYPE, args: [INT0] }, 0)).toBe(NOTYPE_JVM)
  })
  it("ergots' own SAny function stays that object", () => {
    const t = exprTpe({ tag: 'Apply', func: UNRESOLVED, args: [INT0] }, 0)
    expect(t).toEqual({ tag: 'SAny' })
    expect(t).not.toBe(SANY_JVM)
    expect(t).not.toBe(NOTYPE_JVM)
  })
})

// The JVM casts the input's type while it builds or types these nodes, a ClassCastException for SAny
// and NoType alike.
const CASTS: [string, string, (x: Expr) => Expr][] = [
  ['ByIndex', 'by-index-input-class-cast', (x) => ({ tag: 'ByIndex', input: x, index: INT0, default: null })],
  ['OptionGet', 'option-get-input-class-cast', (x) => ({ tag: 'OptionGet', input: x })],
  ['SelectField', 'select-field-input-class-cast', (x) => ({ tag: 'SelectField', input: x, fieldIndex: 1 })],
  ['Map (the mapper)', 'map-mapper-class-cast', (x) => ({ tag: 'Map', input: COLL_INT, mapper: x })],
  ['OptionGetOrElse', 'option-get-or-else-input-class-cast', (x) => ({ tag: 'OptionGetOrElse', input: x, default: INT0 })],
  ['Filter', 'filter-input-class-cast', (x) => ({ tag: 'Filter', input: x, condition: FUNC })],
  ['Slice', 'slice-input-class-cast', (x) => ({ tag: 'Slice', input: x, from: INT0, until: INT0 })],
  ['Append', 'append-input-class-cast', (x) => ({ tag: 'Append', input: x, col2: x })],
]

describe('an arm that casts its input type throws for the JVM SAny and NoType', () => {
  for (const [arm, code, build] of CASTS) {
    it(`${arm}: the JVM SAny throws '${code}'`, () => {
      expect(codeOf(() => exprTpe(build(DECLARED), 0))).toBe(code)
    })
    it(`${arm}: the JVM NoType throws '${code}'`, () => {
      expect(codeOf(() => exprTpe(build(NOTYPE), 0))).toBe(code)
    })
    it(`${arm}: ergots' own SAny passes through as itself`, () => {
      const t = exprTpe(build(UNRESOLVED), 0)
      expect(t).toEqual({ tag: 'SAny' })
      expect(t).not.toBe(SANY_JVM)
      expect(t).not.toBe(NOTYPE_JVM)
    })
  }
})

// The JVM requires a numeric type or NoType while it builds these nodes (isNumTypeOrNoType,
// core/.../sigma/ast/package.scala:139): SAny fails the require, NoType passes it. The require is the
// constructor's, which checkBuild makes when the node is built (an ExprParseError; until 2026-09-30
// exprTpe threw the '*-jvm-sany' codes for the JVM's SAny); exprTpe types the node from its input or
// left operand.
const REQUIRES: [string, string, (x: Expr) => Expr][] = [
  ['Negation', 'negation-input-not-numeric', (x) => ({ tag: 'Negation', input: x })],
  ['BitInversion', 'bit-inversion-input-not-numeric', (x) => ({ tag: 'BitInversion', input: x })],
  ['BitOp (the left operand)', 'bit-op-operand-not-numeric', (x) => bitOr(x, INT0)],
]

describe('an arm that requires a numeric input rejects the JVM SAny as it is built, not NoType', () => {
  for (const [arm, code, build] of REQUIRES) {
    it(`${arm}: the JVM SAny fails the require ('${code}'), and the node types as it`, () => {
      expect(codeOf(() => checkBuild(build(DECLARED), 'parse', 0))).toBe(code)
      expect(exprTpe(build(DECLARED), 0)).toBe(SANY_JVM)
    })
    it(`${arm}: the JVM NoType passes, as NOTYPE_JVM`, () => {
      expect(codeOf(() => checkBuild(build(NOTYPE), 'parse', 0))).toBeUndefined()
      expect(exprTpe(build(NOTYPE), 0)).toBe(NOTYPE_JVM)
    })
    it(`${arm}: ergots' own SAny passes through as itself`, () => {
      expect(codeOf(() => checkBuild(build(UNRESOLVED), 'parse', 0))).toBeUndefined()
      const t = exprTpe(build(UNRESOLVED), 0)
      expect(t).toEqual({ tag: 'SAny' })
      expect(t).not.toBe(SANY_JVM)
    })
  }
  it("BitOp (the right operand): the JVM SAny fails the require ('bit-op-operand-not-numeric')", () => {
    expect(codeOf(() => checkBuild(bitOr(INT0, DECLARED), 'parse', 0))).toBe('bit-op-operand-not-numeric')
  })
  it('BitOp (the right operand): the JVM NoType passes, and the node types as its left operand', () => {
    expect(codeOf(() => checkBuild(bitOr(INT0, NOTYPE), 'parse', 0))).toBeUndefined()
    expect(exprTpe(bitOr(INT0, NOTYPE), 0)).toEqual({ tag: 'SInt' })
    expect(exprTpe(bitOr(INT0, CONCRETE_NOTYPE), 0)).toEqual({ tag: 'SInt' })
  })
  it('BitOp: a NoType left operand passes, and the JVM then reads the right one', () => {
    // BitOp's require reads left.tpe, then right.tpe (trees.scala:913).
    expect(codeOf(() => checkBuild(bitOr(CONCRETE_NOTYPE, DECLARED), 'parse', 0))).toBe('bit-op-operand-not-numeric')
    // A NoType left and a numeric right pass, and the node types as its left operand, NoType.
    expect(codeOf(() => checkBuild(bitOr(CONCRETE_NOTYPE, INT0), 'parse', 0))).toBeUndefined()
    expect(exprTpe(bitOr(CONCRETE_NOTYPE, INT0), 0)).toBe(NOTYPE_JVM)
  })
})

describe('an arm the JVM types keeps typing the JVM SAny and NoType', () => {
  const KEEPS: [string, (x: Expr) => Expr, (t: SType) => SType | undefined][] = [
    ['If (the true branch)', (x) => ({ tag: 'If', condition: TRUE, trueBranch: x, falseBranch: x }), (t) => t],
    ['BlockValue (the result)', (x) => ({ tag: 'BlockValue', items: [], result: x }), (t) => t],
    ['Fold (the zero)', (x) => ({ tag: 'Fold', input: COLL_INT, zero: x, foldOp: FUNC }), (t) => t],
    ['Plus (the left operand)', (x) => ({ tag: 'BinOp', op: { kind: 'Arith', op: 'Plus' }, left: x, right: INT0 }), (t) => t],
    ['Tuple (an item)', (x) => ({ tag: 'Tuple', items: [x, INT0] }), (t) => (t.tag === 'STuple' ? t.items[0] : undefined)],
    ['FuncValue (the body)', (x) => ({ tag: 'FuncValue', args: [{ id: 1, tpe: { tag: 'SInt' } }], body: x }), (t) => (t.tag === 'SFunc' ? t.result : undefined)],
  ]
  for (const [arm, build, pick] of KEEPS) {
    it(`${arm}: the JVM SAny stays SANY_JVM`, () => {
      expect(pick(exprTpe(build(DECLARED), 0))).toBe(SANY_JVM)
    })
    it(`${arm}: the JVM NoType stays NOTYPE_JVM`, () => {
      expect(pick(exprTpe(build(NOTYPE), 0))).toBe(NOTYPE_JVM)
    })
  }
  const FIXED: [string, (x: Expr) => Expr, SType][] = [
    ['SizeOf', (x) => ({ tag: 'SizeOf', input: x }), { tag: 'SInt' }],
    ['Exists', (x) => ({ tag: 'Exists', input: x, condition: FUNC }), { tag: 'SBoolean' }],
    ['ForAll', (x) => ({ tag: 'ForAll', input: x, condition: FUNC }), { tag: 'SBoolean' }],
    ['OptionIsDefined', (x) => ({ tag: 'OptionIsDefined', input: x }), { tag: 'SBoolean' }],
    ['EQ', (x) => ({ tag: 'BinOp', op: { kind: 'Relation', op: 'Eq' }, left: x, right: x }), { tag: 'SBoolean' }],
  ]
  for (const [arm, build, tpe] of FIXED) {
    it(`${arm}: types as ${tpe.tag} over the JVM SAny and NoType`, () => {
      expect(exprTpe(build(DECLARED), 0)).toEqual(tpe)
      expect(exprTpe(build(NOTYPE), 0)).toEqual(tpe)
    })
  }
})

describe("a PropertyCall with explicit type arguments does not type its object, as the JVM's", () => {
  // Global.none[SigmaProp] (106:10). PropertyCallSerializer specializes the method for obj.tpe only
  // when it has no explicit type arguments (PropertyCallSerializer.scala:36-50), and Filter reads its
  // input's type only when its own type is read (def tpe, sigma/ast/transformers.scala:121), so the
  // JVM parses OptionGet(Global.none[SigmaProp] on Filter(ByIndex(tuple), f)) as a SigmaProp root.
  it('Global.none[SigmaProp] on a Filter over the JVM SAny types as Option[SigmaProp]', () => {
    const none: Expr = {
      tag: 'PropertyCall',
      obj: { tag: 'Filter', input: DECLARED, condition: FUNC },
      typeId: 106,
      methodId: 10,
      explicitTypeArgs: { T: { tag: 'SSigmaProp' } },
    }
    expect(exprTpe(none, 3)).toEqual({ tag: 'SOption', elem: { tag: 'SSigmaProp' } })
  })
})

describe("ergots' own SAny still passes rule 1001 (residual 1)", () => {
  it('a root typed by an unregistered method signature parses under checkType', () => {
    // 00 db 65 01 fe: PropertyCall typeId 101 (SContext) methodId 1 on CONTEXT, which ergots'
    // catalog does not register. Pins residual 1 (facts/ergoscript-wire.md): ergots cannot type
    // the root, and failing its SAny would over-reject honest trees whose root method the catalog
    // lacks. The JVM knows this method (dataInputs, a Coll[Box]) and fails the root; the method
    // catalog follow-up closes that.
    const t = parseTree(hex('00db6501fe'), { checkType: true })
    expect(isUnparsedTree(t)).toBe(false)
    if (!isUnparsedTree(t)) {
      const tpe = exprTpe(t.body, t.header.version)
      expect(tpe).toEqual({ tag: 'SAny' })
      expect(tpe).not.toBe(SANY_JVM)
    }
  })
})

// ByIndex over a tuple. STuple extends SCollection[SAny] with elemType = SAny
// (core/.../sigma/ast/SType.scala:838-841), and ByIndex.tpe = input.tpe.elemType
// (sigma/ast/transformers.scala:254), so the JVM types the node as its SAny, the same object as
// type code 97, and rule 1001 fails a root typed through it. Every expectation below is the verdict
// and the re-encoding of a live sigma-state 6.0.6 probe (deserializeErgoTree under
// VersionContext(3, 3), then serializeErgoTree).
// ByIndex(Tuple(Int 0, Int 0), Int 0, None): b2, the tuple 86 02 04 00 04 00, the index 04 00, 00.
const BY_INDEX_TUPLE = 'b2860204000400040000'

/** The box-rules parse of `h`, on one reader, with the cursor after it. */
const boxRules = (h: string) => {
  const r = new ByteReader(hex(h))
  const tree = parseTreeFromReader(r, { checkType: true })
  return { tree, position: r.position }
}

describe("rule 1001 fails a root typed through ByIndex over a tuple, the JVM's SAny", () => {
  it('exprTpe of ByIndex over a tuple is SANY_JVM', () => {
    const t = parseTree(hex('00' + BY_INDEX_TUPLE))
    if (isUnparsedTree(t)) throw new Error('expected a parsed tree')
    expect(exprTpe(t.body, t.header.version)).toBe(SANY_JVM)
  })
  // JVM: Unparsed (rule 1001), re-encoded as received.
  for (const [name, h] of [
    ['a sized root ByIndex(tuple)', '080a' + BY_INDEX_TUPLE],
    ['a sized If(true, ByIndex(tuple), sigmaProp(true))', '080f950101' + BY_INDEX_TUPLE + '08d3'],
    ['a sized root ByIndex over a tuple constant', '080ab2600204040000040000'],
    ['a sized root ByIndex(tuple) with a default', '080cb28602040004000400010400'],
    ['a sized root ValUse of a val bound to ByIndex(tuple)', '0810d801d601' + BY_INDEX_TUPLE + '7201'],
  ] as const) {
    it(`${name} degrades under the box rules, to its declared span`, () => {
      const { tree, position } = boxRules(h)
      expect(isUnparsedTree(tree)).toBe(true)
      if (isUnparsedTree(tree)) expect(tree.error).toMatchObject({ code: 'root-not-sigma-prop' })
      expect(position).toBe(h.length / 2)
      expect(toHex(serializeTree(tree))).toBe(h)
    })
  }
  it('an unsized root ByIndex(tuple) rejects under the box rules (the JVM SerializerException)', () => {
    const err = errOf(() => parseErgoTreeBytes(new ByteReader(hex('00' + BY_INDEX_TUPLE))))
    expect(err).toMatchObject({ code: 'soft-fork-without-size-bit' })
    expect((err as Error).cause).toMatchObject({ code: 'root-not-sigma-prop' })
  })
  it('the lenient parse accepts an unsized root ByIndex(tuple), as the JVM checkType = false', () => {
    expect(isUnparsedTree(parseTree(hex('00' + BY_INDEX_TUPLE)))).toBe(false)
  })
  // JVM: Parsed, re-encoded as received. The ValDef's type is the rhs's, the JVM's SAny
  // (ValDef.tpe = rhs.tpe), which the result, a SigmaProp constant, does not use.
  for (const [name, h] of [
    ['a sized tree with a ValDef whose rhs is ByIndex(tuple)', '0810d801d601' + BY_INDEX_TUPLE + '08d3'],
    ['an unsized tree with a ValDef whose rhs is ByIndex(tuple)', '00d801d601' + BY_INDEX_TUPLE + '08d3'],
  ] as const) {
    it(`${name} parses under the box rules and re-encodes as received`, () => {
      const { tree, position } = boxRules(h)
      expect(isUnparsedTree(tree)).toBe(false)
      expect(position).toBe(h.length / 2)
      expect(toHex(serializeTree(tree))).toBe(h)
    })
  }
  it("a nested Box's sized tree rooted at ByIndex(tuple) degrades, and the enclosing tree parses", () => {
    // T: header 0x18 (sized, segregated), one SBox constant whose tree is the sized ByIndex(tuple)
    // root, then BoolToSigmaProp(GT(ExtractAmount(placeholder 0), Long 0)). JVM: T Parsed, re-encoded
    // as received (the nested tree re-encodes to its raw bytes).
    const nestedTree = '080a' + BY_INDEX_TUPLE
    const box = '01' + nestedTree + '000000' + '11'.repeat(32) + '00'
    const inner = '0163' + box + 'd191c173000500'
    const t = '18' + (inner.length / 2).toString(16) + inner
    const { tree } = boxRules(t)
    if (isUnparsedTree(tree)) throw new Error('expected the enclosing tree to parse')
    const nested = tree.constants[0]
    if (nested?.kind !== 'Box') throw new Error('expected a Box constant')
    const nestedBoxTree = boxTreeOf(nested.value.ergoTreeBytes)
    expect(isUnparsedTree(nestedBoxTree)).toBe(true)
    if (isUnparsedTree(nestedBoxTree)) expect(nestedBoxTree.error).toMatchObject({ code: 'root-not-sigma-prop' })
    expect(toHex(serializeTree(tree))).toBe(t)
  })
})
