// Rule 1001 and an SAny the tree declares (sigma-state 6.0.6). The JVM fails a root whose type is
// SAny: the rule requires root.tpe.isSigmaProp, an isInstanceOf[SSigmaProp.type]
// (core/.../sigma/ast/package.scala:121). Type code 97 parses as SAny (TypeSerializer.scala:196);
// GetVar and DeserializeContext are built with no type check (SigmaBuilder.scala:479-480, 607-608);
// OptionGet.tpe = input.tpe.elemType (sigma/ast/transformers.scala:601); an Apply of an SAny
// function is NoType (sigma/ast/values.scala:1247-1251). ergots marks the declared SAny at its
// origin (parseSType returns SANY_JVM, the JVM's SAny) and exprTpe passes it through, while ergots'
// own SAny, a fresh object its method typing makes (residual 1), keeps passing rule 1001.
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseTree, parseErgoTreeBytes, parseTreeFromReader } from '../../src/wire/ergo-tree'
import { parseSType } from '../../src/wire/parse-stype'
import { exprTpe } from '../../src/mir/expr-tpe'
import { isUnparsedTree, SANY_JVM } from '../../src/mir/types'
import type { Expr } from '../../src/mir/types'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
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
    expect(parseSType(new ByteReader(hex('61')))).toBe(SANY_JVM)
    // Option[SAny]: 0x24 (Option, recursive) then 0x61.
    const opt = parseSType(new ByteReader(hex('2461')))
    expect(opt.tag === 'SOption' && opt.elem).toBe(SANY_JVM)
    expect(SANY_JVM).toEqual({ tag: 'SAny' })
  })
  it('exprTpe of OptionGet(GetVar(1, SAny)) is SANY_JVM', () => {
    const t = parseTree(hex('00' + OPTION_GET_OF_GETVAR_SANY))
    if (isUnparsedTree(t)) throw new Error('expected a parsed tree')
    expect(exprTpe(t.body)).toBe(SANY_JVM)
  })
})

// An input typed as the declared SAny, and one typed as ergots' own SAny: a PropertyCall with an
// unregistered (typeId, methodId), whose exprTpe is a fresh { tag: 'SAny' } (the A3 fallback).
const DECLARED: Expr = { tag: 'DeserializeContext', tpe: SANY_JVM, id: 1 }
const UNRESOLVED: Expr = {
  tag: 'PropertyCall',
  obj: { tag: 'Const', tpe: { tag: 'SGroupElement' }, value: { kind: 'GroupElement', value: new Uint8Array(33) } },
  typeId: 999,
  methodId: 999,
  explicitTypeArgs: {},
}
const INT0: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } }
const CASCADES: [string, (x: Expr) => Expr][] = [
  ['Apply', (x) => ({ tag: 'Apply', func: x, args: [INT0] })],
  ['ByIndex', (x) => ({ tag: 'ByIndex', input: x, index: INT0, default: null })],
  ['OptionGet', (x) => ({ tag: 'OptionGet', input: x })],
  ['SelectField', (x) => ({ tag: 'SelectField', input: x, fieldIndex: 1 })],
  ['Map', (x) => ({ tag: 'Map', input: x, mapper: x })],
  ['OptionGetOrElse', (x) => ({ tag: 'OptionGetOrElse', input: x, default: INT0 })],
]

describe('exprTpe passes an SAny input through as the same object', () => {
  for (const [arm, build] of CASCADES) {
    it(`${arm}: a declared-SAny input gives SANY_JVM`, () => {
      expect(exprTpe(build(DECLARED))).toBe(SANY_JVM)
    })
    it(`${arm}: an unresolved SAny input stays ergots' own SAny, not SANY_JVM`, () => {
      const t = exprTpe(build(UNRESOLVED))
      expect(t).toEqual({ tag: 'SAny' })
      expect(t).not.toBe(SANY_JVM)
    })
  }
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
      const tpe = exprTpe(t.body)
      expect(tpe).toEqual({ tag: 'SAny' })
      expect(tpe).not.toBe(SANY_JVM)
    }
  })
})
