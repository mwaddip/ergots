/**
 * Every exprTpe arm that forwards or reads a child's type, over the JVM's SAny and the JVM's NoType,
 * at the positions where the JVM reads a node's type: a sized root and an unsized root under the box
 * rules (rule 1001), a root parsed without checkType, and a ValDef's right-hand side
 * (`ValDefSerializer` stores `rhs.tpe`) in an unsized and a sized tree.
 *
 * Every expectation is the verdict of a live sigma-state 6.0.6 probe:
 * `ErgoTreeSerializer.deserializeErgoTree` under `VersionContext(3, 3)`, with checkType for the box
 * rules and without it for the lenient root. The probe re-encoded every tree it accepted as received.
 * The verdicts are the same for each source of the JVM's SAny (ByIndex over a tuple, and GetVar and
 * DeserializeContext of type code 97) and for each source of its NoType (an Apply of one of those).
 */
import { describe, it, expect } from 'vitest'
import { ByteReader } from '@ergots/scorex'
import { parseTree, parseTreeFromReader, serializeTree } from '../../src/wire/ergo-tree'
import { isUnparsedTree } from '../../src/mir/types'

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
const sized = (header: string, body: string) => header + vlq(body.length / 2) + body

// ByIndex(Tuple(Int 0, Int 0), Int 0, None): the JVM's SAny (SType.scala:838-841, transformers.scala:254).
const BI = 'b2860204000400040000'
// OptionGet(GetVar(1, SAny)) and DeserializeContext(SAny, 1): type code 97 (TypeSerializer.scala:196).
const GV = 'e4e30161'
const DC = 'd46101'
// Apply(x, [Int 0]): the JVM's NoType for an SAny function (values.scala:1247-1251).
const AP = (x: string) => 'da' + x + '01' + '0400'
// FuncValue((1: Int) => true).
const F = 'd9010104' + '0101'

const SANY: [string, string][] = [['ByIndex(tuple)', BI], ['OptionGet(GetVar(1, SAny))', GV], ['DeserializeContext(SAny, 1)', DC]]
const NOTYPE: [string, string][] = [['Apply(ByIndex(tuple), [0])', AP(BI)], ['Apply(OptionGet(GetVar(1, SAny)), [0])', AP(GV)]]

type Verdict = 'R' | 'U' | 'P'
const POSITIONS: [string, (body: string) => { mode: 'box' | 'lenient'; tree: string }][] = [
  ['a sized root', (b) => ({ mode: 'box', tree: sized('08', b) })],
  ['an unsized root', (b) => ({ mode: 'box', tree: '00' + b })],
  ['a root parsed without checkType', (b) => ({ mode: 'lenient', tree: '00' + b })],
  ['a ValDef rhs (unsized tree)', (b) => ({ mode: 'box', tree: '00d801d601' + b + '08d3' })],
  ['a ValDef rhs (sized tree)', (b) => ({ mode: 'box', tree: sized('08', 'd801d601' + b + '08d3') })],
]

// The JVM's verdicts, one letter per position above: R rejects, U degrades to Unparsed (rule 1001),
// P parses. Casts: the JVM casts the input's type (a ClassCastException); Filter's tpe is a def
// (transformers.scala:121), read only where its type is, so a root parsed without checkType keeps
// it. Requires: isNumTypeOrNoType (core/.../sigma/ast/package.scala:139, trees.scala:882, 900, 913)
// fails SAny and passes NoType.
const ARMS: { arm: string; build: (x: string) => string; sany: string; noType: string }[] = [
  { arm: 'ByIndex(X, 0)', build: (x) => 'b2' + x + '0400' + '00', sany: 'RRRRR', noType: 'RRRRR' },
  { arm: 'OptionGet(X)', build: (x) => 'e4' + x, sany: 'RRRRR', noType: 'RRRRR' },
  { arm: 'SelectField(X, 1)', build: (x) => '8c' + x + '01', sany: 'RRRRR', noType: 'RRRRR' },
  { arm: 'Map(Coll[Int](), X)', build: (x) => 'ad1000' + x, sany: 'RRRRR', noType: 'RRRRR' },
  { arm: 'OptionGetOrElse(X, 0)', build: (x) => 'e5' + x + '0400', sany: 'RRRRR', noType: 'RRRRR' },
  { arm: 'Filter(X, f)', build: (x) => 'b5' + x + F, sany: 'RRPRR', noType: 'RRPRR' },
  { arm: 'Slice(X, 0, 1)', build: (x) => 'b4' + x + '0400' + '0402', sany: 'RRRRR', noType: 'RRRRR' },
  { arm: 'Append(X, X)', build: (x) => 'b3' + x + x, sany: 'RRRRR', noType: 'RRRRR' },
  { arm: 'Negation(X)', build: (x) => 'f0' + x, sany: 'RRRRR', noType: 'URPPP' },
  { arm: 'BitInversion(X)', build: (x) => 'f1' + x, sany: 'RRRRR', noType: 'URPPP' },
  { arm: 'BitOr(X, 0)', build: (x) => 'f2' + x + '0400', sany: 'RRRRR', noType: 'URPPP' },
  { arm: 'BitOr(0, X)', build: (x) => 'f2' + '0400' + x, sany: 'RRRRR', noType: 'URPPP' },
  { arm: 'Apply(X, [0])', build: (x) => AP(x), sany: 'URPPP', noType: 'URPPP' },
  { arm: 'If(true, X, X)', build: (x) => '950101' + x + x, sany: 'URPPP', noType: 'URPPP' },
  { arm: 'Plus(X, 0)', build: (x) => '9a' + x + '0400', sany: 'URPPP', noType: 'URPPP' },
  { arm: 'SizeOf(X)', build: (x) => 'b1' + x, sany: 'URPPP', noType: 'URPPP' },
  { arm: 'Exists(X, f)', build: (x) => 'ae' + x + F, sany: 'URPPP', noType: 'URPPP' },
  { arm: 'ForAll(X, f)', build: (x) => 'af' + x + F, sany: 'URPPP', noType: 'URPPP' },
  { arm: 'Fold(Coll[Int](), X, f)', build: (x) => 'b0' + '1000' + x + F, sany: 'URPPP', noType: 'URPPP' },
  { arm: 'OptionIsDefined(X)', build: (x) => 'e6' + x, sany: 'URPPP', noType: 'URPPP' },
  { arm: 'SelectField(Tuple(X, sigmaProp), 2)', build: (x) => '8c' + '8602' + x + '08d3' + '02', sany: 'PPPPP', noType: 'PPPPP' },
]

/** ergots' verdict for `tree`: the box rules on one reader (to its end), or the lenient parse. */
function verdictOf(mode: 'box' | 'lenient', tree: string): Verdict {
  let t
  let end = tree.length / 2
  try {
    if (mode === 'lenient') {
      t = parseTree(hex(tree))
    } else {
      const r = new ByteReader(hex(tree))
      t = parseTreeFromReader(r, { checkType: true })
      end = r.position
    }
  } catch {
    return 'R'
  }
  expect(end).toBe(tree.length / 2)
  expect(toHex(serializeTree(t))).toBe(tree)
  if (isUnparsedTree(t)) {
    expect(t.error).toMatchObject({ code: 'root-not-sigma-prop' })
    return 'U'
  }
  return 'P'
}

describe('exprTpe over the JVM SAny and NoType: the verdicts of the JVM probe', () => {
  for (const { arm, build, sany, noType } of ARMS) {
    for (const [sources, verdicts] of [[SANY, sany], [NOTYPE, noType]] as const) {
      for (const [source, x] of sources) {
        POSITIONS.forEach(([position, place], i) => {
          const jvm = verdicts[i] as Verdict
          const { mode, tree } = place(build(x))
          // A root parsed without checkType is a position ergots does not type: the JVM rejects there
          // only while it builds the node, a check ergots does not make at parse (the node-construction
          // follow-up), so ergots parses it.
          const residual = mode === 'lenient' && jvm === 'R'
          const name = `${arm.replace(/X/g, source)} at ${position}: the JVM ${jvm}` +
            (residual ? ', ergots P (the node-construction follow-up)' : '')
          it(name, () => {
            expect(verdictOf(mode, tree)).toBe(residual ? 'P' : jvm)
          })
        })
      }
    }
  }
})

// The re-review's 25 shapes (final fix round 2): each rejected by the JVM with a ClassCastException, or
// a require failure for Negation and BitInversion, and each accepted by ergots at 9c87a5a.
describe("the re-review's 25 shapes reject under the box rules", () => {
  const SHAPES: [string, string][] = [
    ['OptionGet(BI) sized root', '080be4b2860204000400040000'],
    ['OptionGet(BI) ValDef rhs unsized', '00d801d601e4b286020400040004000008d3'],
    ['OptionGet(BI) ValDef rhs sized', '0811d801d601e4b286020400040004000008d3'],
    ['SelectField(BI,1) sized root', '080c8cb286020400040004000001'],
    ['SelectField(BI,1) ValDef rhs unsized', '00d801d6018cb28602040004000400000108d3'],
    ['SelectField(BI,1) ValDef rhs sized', '0812d801d6018cb28602040004000400000108d3'],
    ['ByIndex(BI,0) sized root', '080eb2b2860204000400040000040000'],
    ['ByIndex(BI,0) ValDef rhs unsized', '00d801d601b2b286020400040004000004000008d3'],
    ['ByIndex(BI,0) ValDef rhs sized', '0814d801d601b2b286020400040004000004000008d3'],
    ['OptionGetOrElse(BI,0) sized root', '080de5b28602040004000400000400'],
    ['OptionGetOrElse(BI,0) ValDef rhs unsized', '00d801d601e5b2860204000400040000040008d3'],
    ['OptionGetOrElse(BI,0) ValDef rhs sized', '0813d801d601e5b2860204000400040000040008d3'],
    ['Map(Coll[Int](),BI) sized root', '080dad1000b2860204000400040000'],
    ['Map(Coll[Int](),BI) ValDef rhs unsized', '00d801d601ad1000b286020400040004000008d3'],
    ['Map(Coll[Int](),BI) ValDef rhs sized', '0813d801d601ad1000b286020400040004000008d3'],
    ['Slice(BI,0,1) sized root', '080fb4b286020400040004000004000402'],
    ['Slice(BI,0,1) ValDef rhs unsized', '00d801d601b4b28602040004000400000400040208d3'],
    ['Append(BI,BI) sized root', '0815b3b2860204000400040000b2860204000400040000'],
    ['Append(BI,BI) ValDef rhs unsized', '00d801d601b3b2860204000400040000b286020400040004000008d3'],
    ['Filter(BI,f) sized root', '0811b5b2860204000400040000d90101040101'],
    ['Filter(BI,f) ValDef rhs unsized', '00d801d601b5b2860204000400040000d9010104010108d3'],
    ['Negation(BI) sized root', '080bf0b2860204000400040000'],
    ['Negation(BI) ValDef rhs unsized', '00d801d601f0b286020400040004000008d3'],
    ['BitInversion(BI) sized root', '080bf1b2860204000400040000'],
    ['BitInversion(BI) ValDef rhs unsized', '00d801d601f1b286020400040004000008d3'],
  ]
  for (const [name, tree] of SHAPES) {
    it(name, () => {
      expect(verdictOf('box', tree)).toBe('R')
    })
  }
})

// Global.none[SigmaProp] (106:10) has an explicit type argument, so the JVM builds it without reading
// its object's type (PropertyCallSerializer.scala:36-50), and a Filter's type is read only where it
// is needed. JVM: each tree parses (v3, sized) and re-encodes as received.
describe("a PropertyCall with explicit type arguments leaves its object's type unread", () => {
  const NONE = (obj: string) => 'db6a0a' + obj + '08'
  for (const [name, obj] of [
    ['Global', 'dd'],
    ['Filter(ByIndex(tuple), f)', 'b5' + BI + F],
    ['Filter(OptionGet(GetVar(1, SAny)), f)', 'b5' + GV + F],
    ['Filter(Apply(ByIndex(tuple), [0]), f)', 'b5' + AP(BI) + F],
  ] as const) {
    it(`OptionGet(Global.none[SigmaProp] on ${name}) as a sized v3 root parses`, () => {
      expect(verdictOf('box', sized('0b', 'e4' + NONE(obj)))).toBe('P')
    })
    it(`Global.none[SigmaProp] on ${name} as a ValDef rhs parses`, () => {
      expect(verdictOf('box', sized('0b', 'd801d601' + NONE(obj) + '08d3'))).toBe('P')
    })
  }
})
