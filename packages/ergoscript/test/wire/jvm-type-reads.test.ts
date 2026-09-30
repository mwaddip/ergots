/**
 * The JVM's type reads at parse (sigma-state 6.0.6; spec docs/specs/2026-09-30-jvm-node-construction-design.md
 * §4a, "Type reads", "SFunc data" and "A Coll's element type"; facts/ergoscript-wire.md, "Type reads").
 *
 * `TypeSerializer.deserialize` (core/shared/src/main/scala/sigma/serialization/TypeSerializer.scala:130-237)
 * decides two things by `isV3OrLaterErgoTreeVersion`, the tree version in force at the read:
 * - an embeddable primitive id is checked against a table of 9 entries below v3 and 10 from v3
 *   (UnsignedBigInt, id 9; :16-25, :257-267): rule 1017 `CheckPrimitiveTypeCodeV6` (1007 before 6.0
 *   activation, the same check) for 9 below v3 and for 10 and 11 at every version;
 * - a code the match does not take (107-111, 113-255, and SFunc's 112 below v3; :187-233) fails rule 1018
 *   `CheckTypeCodeV6` (1008 before activation).
 * Both are `ValidationException`s, which a sized tree degrades on. Code 0 is `InvalidTypePrefix`, a hard
 * reject. Data of an SFunc type fails rule 1009 (`CoreDataSerializer.scala:144-146`, soft), and a `Coll`'s
 * element type goes through `Evaluation.stypeToRType` before any item (`CoreDataSerializer.scala:152-166`,
 * hard).
 *
 * The version at each read site (§4a's table): a tree's own header version for its constants and body; the
 * ENCLOSING tree's for a nested box's registers; the spent tree's for a script decoded at spend and for a
 * SubstConstants template; 3 for a box's registers at the top level.
 *
 * Every expectation is a local sigma-state 6.0.6 probe's verdict, as each section says: the `types` mode
 * (`TypeSerializer.deserialize` under `withVersions(3, v)`), the `tree` mode (`deserializeErgoTree` with the
 * `checkType` given), the `box` mode (`ErgoBox.sigmaSerializer.parse` under `withVersions(a, v)`, by default
 * (3, 3)) and the `spend` mode (the tree as SELF's, context variable 1 as given, reduced by
 * `fullReduction`). The `W:n` names are the lines of the B-full audit's witness battery (the plan's ledger,
 * `bfull-audit.md` §5), `NT:n` its nested-type probes, and `R1`-`R19` the §4a review's probes.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSType, STypeParseError } from '../../src/wire/parse-stype'
import { parseTree } from '../../src/wire/ergo-tree'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { boxTreeOf } from '../../src/wire/box-tree'
import { isUnparsedTree } from '../../src/mir/types'
import type { ErgoTree, ParsedErgoTree, SType, SValue } from '../../src/mir/types'
import { evaluate } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'
import type { EvalOpts } from '../../src/eval/eval-context'

const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** A type as the JVM's `toString` prints it (the probe's `tpe`). */
function jvmStr(t: SType): string {
  switch (t.tag) {
    case 'SByte':
    case 'SShort':
    case 'SInt':
    case 'SLong':
    case 'SBigInt':
    case 'SUnsignedBigInt':
      return `${t.tag}$`
    case 'SColl':
      return `Coll[${jvmStr(t.elem)}]`
    case 'SOption':
      return `Option[${jvmStr(t.elem)}]`
    case 'STuple':
      return `(${t.items.map(jvmStr).join(',')})`
    case 'STypeVar':
      return t.name
    case 'SFunc': {
      const params = t.tpeParams.length > 0 ? `[${t.tpeParams.map((p) => p.name).join(',')}]` : ''
      return `${params}(${t.args.map(jvmStr).join(',')}) => ${jvmStr(t.result)}`
    }
    default:
      return t.tag
  }
}

/**
 * `parseSType(hex, v)` in the probe's `types` vocabulary: `<type>/<bytes consumed>`, `1017` and `1018` for
 * the two soft rules, `prefix` for `InvalidTypePrefix`, and `hard <class>:<code>` for any other failure.
 */
function typeCell(hex: string, v: number): string {
  const r = new ByteReader(fromHex(hex))
  try {
    const t = parseSType(r, v)
    return `${jvmStr(t)}/${r.position}`
  } catch (err) {
    if (err instanceof STypeParseError) {
      if (err.code === 'type-code-primitive-unknown') return '1017'
      if (err.code === 'type-code-unknown') return '1018'
      if (err.code === 'type-prefix-invalid') return 'prefix'
    }
    const e = err as { name?: string; code?: string }
    return `hard ${e.name}:${e.code}`
  }
}

/** The audit's padding of a first byte to a well-formed type (`bfull/sweep-types-gen.mjs`). */
function pad(c: number): string {
  const h = (x: number): string => x.toString(16).padStart(2, '0')
  if (c === 0) return h(c)
  if (c < 96) {
    const constr = Math.floor(c / 12)
    const prim = c % 12
    switch (constr) {
      case 0:
        return h(c)
      case 1:
      case 2:
      case 3:
      case 4:
        return prim === 0 ? `${h(c)}04` : h(c)
      case 5:
        return prim === 0 ? `${h(c)}0404` : `${h(c)}04`
      case 6:
        return prim === 0 ? `${h(c)}040404` : `${h(c)}04`
      default:
        return prim === 0 ? `${h(c)}04040404` : h(c)
    }
  }
  if (c === 96) return '60020404'
  if (c === 103) return '670154'
  if (c === 112) return '7001040400'
  return h(c)
}

/**
 * The map: every first byte, padded, at tree versions 0 and 3 (`types` mode; `bfull/sweep-types.batch`,
 * lines c+1 and 257+c; verdicts in `sweep-types.jvm.out`). `[code, v0, v3]`. Codes 113-255 are all rule
 * 1018 at both versions (below).
 */
const MAP: [number, string, string][] = [
  [0, 'prefix', 'prefix'],
  [1, 'SBoolean/1', 'SBoolean/1'],
  [2, 'SByte$/1', 'SByte$/1'],
  [3, 'SShort$/1', 'SShort$/1'],
  [4, 'SInt$/1', 'SInt$/1'],
  [5, 'SLong$/1', 'SLong$/1'],
  [6, 'SBigInt$/1', 'SBigInt$/1'],
  [7, 'SGroupElement/1', 'SGroupElement/1'],
  [8, 'SSigmaProp/1', 'SSigmaProp/1'],
  [9, '1017', 'SUnsignedBigInt$/1'],
  [10, '1017', '1017'],
  [11, '1017', '1017'],
  [12, 'Coll[SInt$]/2', 'Coll[SInt$]/2'],
  [13, 'Coll[SBoolean]/1', 'Coll[SBoolean]/1'],
  [14, 'Coll[SByte$]/1', 'Coll[SByte$]/1'],
  [15, 'Coll[SShort$]/1', 'Coll[SShort$]/1'],
  [16, 'Coll[SInt$]/1', 'Coll[SInt$]/1'],
  [17, 'Coll[SLong$]/1', 'Coll[SLong$]/1'],
  [18, 'Coll[SBigInt$]/1', 'Coll[SBigInt$]/1'],
  [19, 'Coll[SGroupElement]/1', 'Coll[SGroupElement]/1'],
  [20, 'Coll[SSigmaProp]/1', 'Coll[SSigmaProp]/1'],
  [21, '1017', 'Coll[SUnsignedBigInt$]/1'],
  [22, '1017', '1017'],
  [23, '1017', '1017'],
  [24, 'Coll[Coll[SInt$]]/2', 'Coll[Coll[SInt$]]/2'],
  [25, 'Coll[Coll[SBoolean]]/1', 'Coll[Coll[SBoolean]]/1'],
  [26, 'Coll[Coll[SByte$]]/1', 'Coll[Coll[SByte$]]/1'],
  [27, 'Coll[Coll[SShort$]]/1', 'Coll[Coll[SShort$]]/1'],
  [28, 'Coll[Coll[SInt$]]/1', 'Coll[Coll[SInt$]]/1'],
  [29, 'Coll[Coll[SLong$]]/1', 'Coll[Coll[SLong$]]/1'],
  [30, 'Coll[Coll[SBigInt$]]/1', 'Coll[Coll[SBigInt$]]/1'],
  [31, 'Coll[Coll[SGroupElement]]/1', 'Coll[Coll[SGroupElement]]/1'],
  [32, 'Coll[Coll[SSigmaProp]]/1', 'Coll[Coll[SSigmaProp]]/1'],
  [33, '1017', 'Coll[Coll[SUnsignedBigInt$]]/1'],
  [34, '1017', '1017'],
  [35, '1017', '1017'],
  [36, 'Option[SInt$]/2', 'Option[SInt$]/2'],
  [37, 'Option[SBoolean]/1', 'Option[SBoolean]/1'],
  [38, 'Option[SByte$]/1', 'Option[SByte$]/1'],
  [39, 'Option[SShort$]/1', 'Option[SShort$]/1'],
  [40, 'Option[SInt$]/1', 'Option[SInt$]/1'],
  [41, 'Option[SLong$]/1', 'Option[SLong$]/1'],
  [42, 'Option[SBigInt$]/1', 'Option[SBigInt$]/1'],
  [43, 'Option[SGroupElement]/1', 'Option[SGroupElement]/1'],
  [44, 'Option[SSigmaProp]/1', 'Option[SSigmaProp]/1'],
  [45, '1017', 'Option[SUnsignedBigInt$]/1'],
  [46, '1017', '1017'],
  [47, '1017', '1017'],
  [48, 'Option[Coll[SInt$]]/2', 'Option[Coll[SInt$]]/2'],
  [49, 'Option[Coll[SBoolean]]/1', 'Option[Coll[SBoolean]]/1'],
  [50, 'Option[Coll[SByte$]]/1', 'Option[Coll[SByte$]]/1'],
  [51, 'Option[Coll[SShort$]]/1', 'Option[Coll[SShort$]]/1'],
  [52, 'Option[Coll[SInt$]]/1', 'Option[Coll[SInt$]]/1'],
  [53, 'Option[Coll[SLong$]]/1', 'Option[Coll[SLong$]]/1'],
  [54, 'Option[Coll[SBigInt$]]/1', 'Option[Coll[SBigInt$]]/1'],
  [55, 'Option[Coll[SGroupElement]]/1', 'Option[Coll[SGroupElement]]/1'],
  [56, 'Option[Coll[SSigmaProp]]/1', 'Option[Coll[SSigmaProp]]/1'],
  [57, '1017', 'Option[Coll[SUnsignedBigInt$]]/1'],
  [58, '1017', '1017'],
  [59, '1017', '1017'],
  [60, '(SInt$,SInt$)/3', '(SInt$,SInt$)/3'],
  [61, '(SBoolean,SInt$)/2', '(SBoolean,SInt$)/2'],
  [62, '(SByte$,SInt$)/2', '(SByte$,SInt$)/2'],
  [63, '(SShort$,SInt$)/2', '(SShort$,SInt$)/2'],
  [64, '(SInt$,SInt$)/2', '(SInt$,SInt$)/2'],
  [65, '(SLong$,SInt$)/2', '(SLong$,SInt$)/2'],
  [66, '(SBigInt$,SInt$)/2', '(SBigInt$,SInt$)/2'],
  [67, '(SGroupElement,SInt$)/2', '(SGroupElement,SInt$)/2'],
  [68, '(SSigmaProp,SInt$)/2', '(SSigmaProp,SInt$)/2'],
  [69, '1017', '(SUnsignedBigInt$,SInt$)/2'],
  [70, '1017', '1017'],
  [71, '1017', '1017'],
  [72, '(SInt$,SInt$,SInt$)/4', '(SInt$,SInt$,SInt$)/4'],
  [73, '(SInt$,SBoolean)/2', '(SInt$,SBoolean)/2'],
  [74, '(SInt$,SByte$)/2', '(SInt$,SByte$)/2'],
  [75, '(SInt$,SShort$)/2', '(SInt$,SShort$)/2'],
  [76, '(SInt$,SInt$)/2', '(SInt$,SInt$)/2'],
  [77, '(SInt$,SLong$)/2', '(SInt$,SLong$)/2'],
  [78, '(SInt$,SBigInt$)/2', '(SInt$,SBigInt$)/2'],
  [79, '(SInt$,SGroupElement)/2', '(SInt$,SGroupElement)/2'],
  [80, '(SInt$,SSigmaProp)/2', '(SInt$,SSigmaProp)/2'],
  [81, '1017', '(SInt$,SUnsignedBigInt$)/2'],
  [82, '1017', '1017'],
  [83, '1017', '1017'],
  [84, '(SInt$,SInt$,SInt$,SInt$)/5', '(SInt$,SInt$,SInt$,SInt$)/5'],
  [85, '(SBoolean,SBoolean)/1', '(SBoolean,SBoolean)/1'],
  [86, '(SByte$,SByte$)/1', '(SByte$,SByte$)/1'],
  [87, '(SShort$,SShort$)/1', '(SShort$,SShort$)/1'],
  [88, '(SInt$,SInt$)/1', '(SInt$,SInt$)/1'],
  [89, '(SLong$,SLong$)/1', '(SLong$,SLong$)/1'],
  [90, '(SBigInt$,SBigInt$)/1', '(SBigInt$,SBigInt$)/1'],
  [91, '(SGroupElement,SGroupElement)/1', '(SGroupElement,SGroupElement)/1'],
  [92, '(SSigmaProp,SSigmaProp)/1', '(SSigmaProp,SSigmaProp)/1'],
  [93, '1017', '(SUnsignedBigInt$,SUnsignedBigInt$)/1'],
  [94, '1017', '1017'],
  [95, '1017', '1017'],
  [96, '(SInt$,SInt$)/4', '(SInt$,SInt$)/4'],
  [97, 'SAny/1', 'SAny/1'],
  [98, 'SUnit/1', 'SUnit/1'],
  [99, 'SBox/1', 'SBox/1'],
  [100, 'SAvlTree/1', 'SAvlTree/1'],
  [101, 'SContext/1', 'SContext/1'],
  [102, 'SString/1', 'SString/1'],
  [103, 'T/3', 'T/3'],
  [104, 'SHeader/1', 'SHeader/1'],
  [105, 'SPreHeader/1', 'SPreHeader/1'],
  [106, 'SGlobal/1', 'SGlobal/1'],
  [107, '1018', '1018'],
  [108, '1018', '1018'],
  [109, '1018', '1018'],
  [110, '1018', '1018'],
  [111, '1018', '1018'],
  [112, '1018', '(SInt$) => SInt$/5'],
]

describe('the map: every first byte of a type, as the JVM reads it at tree versions 0 and 3', () => {
  for (const v of [0, 3] as const) {
    it(`tree version ${v}: the 256 codes`, () => {
      const mismatches: string[] = []
      for (const [c, v0, v3] of MAP) {
        const want = v === 0 ? v0 : v3
        const got = typeCell(pad(c), v)
        if (got !== want) mismatches.push(`code ${c} (${pad(c)}): ${got}, the JVM ${want}`)
      }
      for (let c = 113; c < 256; c++) {
        const got = typeCell(pad(c), v)
        if (got !== '1018') mismatches.push(`code ${c} (${pad(c)}): ${got}, the JVM 1018`)
      }
      expect(mismatches).toEqual([])
    })
  }
})

/**
 * Nested positions (`types` mode; `bfull/nested-types.batch`, NT:1-19): the same rules at an inner byte.
 * The JVM's three `IllegalArgumentException`s are hard, as ergots' codes are: an SFunc type parameter that
 * is not an STypeVar (`require`, TypeSerializer.scala:221) and a truncated STypeVar name (`getBytes`).
 */
const NESTED: [string, string, number, string][] = [
  ['NT:1 Coll[<9>] at v0', '0c09', 0, '1017'],
  ['NT:2 Coll[<9>] at v3', '0c09', 3, 'Coll[SUnsignedBigInt$]/2'],
  ['NT:3 Coll[SFunc] at v0', '0c7001040400', 0, '1018'],
  ['NT:4 Coll[SFunc] at v3', '0c7001040400', 3, 'Coll[(SInt$) => SInt$]/6'],
  ['NT:5 Pair1 (Int, <9>) at v0', '3c0409', 0, '1017'],
  ['NT:6 Pair1 (Int, <9>) at v3', '3c0409', 3, '(SInt$,SUnsignedBigInt$)/3'],
  ['NT:7 a 2-tuple (Int, <0x71>) at v0', '60020471', 0, '1018'],
  ['NT:8 a 2-tuple (Int, <0x71>) at v3', '60020471', 3, '1018'],
  ['NT:9 SFunc (UnsignedBigInt) => Int at v3', '7001090400', 3, '(SUnsignedBigInt$) => SInt$/5'],
  ['NT:10 the same SFunc at v0 (its first byte)', '7001090400', 0, '1018'],
  ['NT:11 an SFunc argument <0a> at v3', '70010a0400', 3, '1017'],
  ['NT:12 an SFunc type parameter that is not an STypeVar (IllegalArgumentException)', '700104040104', 3, 'hard STypeParseError:invalid-sfunc-tpe-params'],
  ['NT:13 an SFunc type parameter T with a truncated name (IllegalArgumentException)', '70010404016701', 3, 'hard ReaderError:truncated'],
  ['NT:14 SFunc [T](Int) => Int at v3', '7001040401670154', 3, '[T](SInt$) => SInt$/8'],
  ['NT:15 an STypeVar with an empty name at v0', '6700', 0, '/2'],
  ['NT:16 Pair1, primitive 1, then <0a> at v0', '3d0a', 0, '1017'],
  ['NT:17 Pair2, primitive 1, then <0a> at v3', '490a', 3, '1017'],
  ['NT:18 PairSymmetric of primitive 9 at v3', '5d', 3, '(SUnsignedBigInt$,SUnsignedBigInt$)/1'],
  ['NT:19 an STypeVar with a truncated name at v0 (IllegalArgumentException)', '670254', 0, 'hard ReaderError:truncated'],
]

describe('nested positions: the same rules at an inner byte', () => {
  for (const [name, hex, v, want] of NESTED) {
    it(`${name}: the JVM ${want}`, () => expect(typeCell(hex, v)).toBe(want))
  }
})

// The review of §4a, M2 (`types` mode; `bfull/review/review6`): a Pair1 or Pair2 primitive id is checked
// before the next type is read (TypeSerializer.scala:160, 170-171), so each of these fails rule 1017 where
// reading the next type first would give `InvalidTypePrefix` on the 00.
describe('the Pair order: a primitive id before the next type', () => {
  it('46 00 at v0: Pair1 with primitive 10: the JVM fails rule 1017', () => expect(typeCell('4600', 0)).toBe('1017'))
  it('52 00 at v3: Pair2 with primitive 10: the JVM fails rule 1017', () => expect(typeCell('5200', 3)).toBe('1017'))
  it('45 00 at v0: Pair1 with primitive 9: the JVM fails rule 1017', () => expect(typeCell('4500', 0)).toBe('1017'))
  it('45 00 at v3, the control: UnsignedBigInt is known, and the 00 is InvalidTypePrefix (hard)', () =>
    expect(typeCell('4500', 3)).toBe('prefix'))
})

// ---------------------------------------------------------------------------------------------------------
// The witness table
// ---------------------------------------------------------------------------------------------------------

type Want =
  | { kind: 'parsed' }
  | { kind: 'unparsed'; code: string }
  | { kind: 'rejected'; code: string; cause?: string }
  | { kind: 'box-accepted'; treeCode: string }
  | { kind: 'reduced' }
  | { kind: 'spend-rejected'; code: string; cause: string }
  | { kind: 'spend-unparsed'; code: string }

/** The tree parses. */
const PARSED: Want = { kind: 'parsed' }
/** The tree degrades to an `UnparsedErgoTree` on `code`. */
const unparsed = (code: string): Want => ({ kind: 'unparsed', code })
/** A hard reject with `code`; for the unsized-tree wrapper, `cause` is the soft code it wraps. */
const rejected = (code: string, cause?: string): Want => ({ kind: 'rejected', code, cause })
/** The box is accepted and writes back its own bytes, its tree unparsed on `treeCode`. */
const boxAccepted = (treeCode: string): Want => ({ kind: 'box-accepted', treeCode })
/** The spend reduces to `TrueProp`. */
const REDUCED: Want = { kind: 'reduced' }
/** The spend rejects with `EvalError(code)`, whose cause has `cause`. */
const spendRejected = (code: string, cause: string): Want => ({ kind: 'spend-rejected', code, cause })
/** The tree degrades on `code`, and its spend rejects (`unparsed-ergotree`). */
const spendUnparsed = (code: string): Want => ({ kind: 'spend-unparsed', code })

interface Row {
  w: number
  name: string
  /** tree mode, `checkType = true`, at the tree's own version */
  tree?: string
  /** box mode, at (3, `ergoTree`) */
  box?: string
  ergoTree?: number
  /** spend mode: the tree, and context variable 1 as a constant (type and data) */
  spend?: string
  var1?: string
  jvm: string
  want: Want
}

const codeOf = (e: unknown): string | undefined => (e as { code?: string } | undefined)?.code
function describeError(e: unknown): string {
  const err = e as { name?: string; code?: string; message?: string; cause?: unknown }
  const cause = err.cause === undefined ? '' : ` <- ${describeError(err.cause)}`
  return `${err.name ?? ''}:${err.code ?? ''} (${err.message ?? String(e)})${cause}`
}

function expectReject(err: unknown, code: string, cause?: string): void {
  expect(codeOf(err), describeError(err)).toBe(code)
  if (cause !== undefined) expect(codeOf((err as Error).cause), describeError(err)).toBe(cause)
}

function checkTree(hex: string, want: Want): void {
  let t: ErgoTree
  try {
    t = parseTree(fromHex(hex), { checkType: true })
  } catch (err) {
    if (want.kind !== 'rejected') throw new Error(`expected ${want.kind}, got a reject: ${describeError(err)}`)
    expectReject(err, want.code, want.cause)
    return
  }
  if (isUnparsedTree(t)) {
    if (want.kind !== 'unparsed') throw new Error(`expected ${want.kind}, got a tree unparsed on ${describeError(t.error)}`)
    expect(codeOf(t.error), describeError(t.error)).toBe(want.code)
    return
  }
  if (want.kind !== 'parsed') throw new Error(`expected ${want.kind} (${JSON.stringify(want)}), got a parsed tree`)
}

function checkBox(hex: string, version: number, want: Want): void {
  let box: SValue
  try {
    box = parseSValue({ tag: 'SBox' }, version, new ByteReader(fromHex(hex)))
  } catch (err) {
    if (want.kind !== 'rejected') throw new Error(`expected ${want.kind}, got a reject: ${describeError(err)}`)
    expectReject(err, want.code, want.cause)
    return
  }
  if (want.kind !== 'box-accepted') throw new Error(`expected ${want.kind} (${JSON.stringify(want)}), got an accepted box`)
  const w = new ByteWriter()
  serializeSValue({ tag: 'SBox' }, box, version, w)
  expect(toHex(w.toBytes())).toBe(hex)
  const tree = boxTreeOf((box as { value: { ergoTreeBytes: Uint8Array } }).value.ergoTreeBytes)
  if (!isUnparsedTree(tree)) throw new Error('expected the box tree unparsed')
  expect(codeOf(tree.error), describeError(tree.error)).toBe(want.treeCode)
}

const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }

/** Context variable 1, as the probe's `spend` mode gives it: a `Coll[Byte]` constant, `0e <length> <bytes>`. */
function var1Opts(var1: string | undefined): EvalOpts {
  if (var1 === undefined) return {}
  const b = fromHex(var1)
  if (b[0] !== 0x0e || b[1] !== b.length - 2) throw new Error(`not a short Coll[Byte] constant: ${var1}`)
  const items: SValue[] = Array.from(b.subarray(2), (x) => ({ kind: 'Byte', value: (x << 24) >> 24 }))
  return {
    extension: {
      values: new Map([[1, { tpe: { tag: 'SColl', elem: { tag: 'SByte' } }, value: { kind: 'Coll', elem: { tag: 'SByte' }, items } }]]),
    },
  }
}

function checkSpend(treeHex: string, var1: string | undefined, want: Want): void {
  const tree = parseTree(fromHex(treeHex), { checkType: true })
  if (want.kind === 'spend-unparsed') {
    if (!isUnparsedTree(tree)) throw new Error('expected the spent tree unparsed')
    expect(codeOf(tree.error), describeError(tree.error)).toBe(want.code)
  } else if (isUnparsedTree(tree)) {
    throw new Error(`expected the spent tree parsed, got it unparsed on ${describeError(tree.error)}`)
  }
  let result: SValue
  try {
    result = evaluate(tree, var1Opts(var1))
  } catch (err) {
    if (want.kind === 'spend-unparsed') {
      expect(err).toBeInstanceOf(EvalError)
      expect(codeOf(err)).toBe('unparsed-ergotree')
      return
    }
    if (want.kind !== 'spend-rejected') throw new Error(`expected ${want.kind}, got a reject: ${describeError(err)}`)
    expect(err).toBeInstanceOf(EvalError)
    expectReject(err, want.code, want.cause)
    return
  }
  if (want.kind !== 'reduced') throw new Error(`expected ${want.kind} (${JSON.stringify(want)}), got ${JSON.stringify(result, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))}`)
  expect(result).toEqual(TRUE_PROP)
}

function checkRow(row: Row): void {
  if (row.tree !== undefined) checkTree(row.tree, row.want)
  else if (row.box !== undefined) checkBox(row.box, row.ergoTree ?? 3, row.want)
  else checkSpend(row.spend!, row.var1, row.want)
}

/**
 * The witness battery, every row (`bfull/witness.batch`, line n = W:n; the JVM's verdicts in
 * `witness.jvm.out`). (a) is a soft failure alone, as sigmaProp(X == X); (b) adds a later
 * `EQ(Upcast(true, Long), 0L)` inside a BinAnd, so the soft failure comes first in byte order and the JVM
 * degrades; (c) is (b) with the operands reversed, so the Upcast's IllegalArgumentException comes first, a
 * reject; (d) is the unsized v0 twin of (a), which the JVM rejects (`SerializerException` "... without size
 * bit." over the `ValidationException`, ErgoTreeSerializer.scala:204-207).
 *
 * The ergots code of each JVM rule: 1010 `method-type-no-methods`, 1016 `method-unknown`, 1017 (1007 before
 * activation) `type-code-primitive-unknown`, 1018 `type-code-unknown`, 1009 `data-type-not-serializable` for
 * SFunc data and `soption-tree-version-too-low` for Option data, 1019 `register-v6-type`.
 */
const WITNESSES: Row[] = [
  { w: 1, name: 'M1-v0-1016-PC(Int.toBytes)-a', tree: '080cd193db04060402db04060402',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 2, name: 'M1-v0-1016-PC(Int.toBytes)-b', tree: '0814d1ed93db04060402db04060402937e0101050500',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 3, name: 'M1-v0-1016-PC(Int.toBytes)-c', tree: '0814d1ed937e010105050093db04060402db04060402',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 4, name: 'M1-v0-1016-PC(Int.toBytes)-d', tree: '00d193db04060402db04060402',
    jvm: 'rejected SerializerException <- ValidationException 1016 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'method-unknown') },
  { w: 5, name: 'M2-v0-1010-PC(typeId9)-a', tree: '080cd193db09010402db09010402',
    jvm: 'unparsed 1010', want: unparsed('method-type-no-methods') },
  { w: 6, name: 'M2-v0-1010-PC(typeId9)-b', tree: '0814d1ed93db09010402db09010402937e0101050500',
    jvm: 'unparsed 1010', want: unparsed('method-type-no-methods') },
  { w: 7, name: 'M2-v0-1010-PC(typeId9)-c', tree: '0814d1ed937e010105050093db09010402db09010402',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 8, name: 'M2-v0-1010-PC(typeId9)-d', tree: '00d193db09010402db09010402',
    jvm: 'rejected SerializerException <- ValidationException 1010 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'method-type-no-methods') },
  { w: 9, name: 'M3-v3-1016-PC(Int.m14)-a', tree: '0b0cd193db040e0402db040e0402',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 10, name: 'M3-v3-1016-PC(Int.m14)-b', tree: '0b14d1ed93db040e0402db040e0402937e0101050500',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 11, name: 'M3-v3-1016-PC(Int.m14)-c', tree: '0b14d1ed937e010105050093db040e0402db040e0402',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 12, name: 'M4-v3-1010-PC(typeId10)-a', tree: '0b0cd193db0a010402db0a010402',
    jvm: 'unparsed 1010', want: unparsed('method-type-no-methods') },
  { w: 13, name: 'M4-v3-1010-PC(typeId10)-b', tree: '0b14d1ed93db0a010402db0a010402937e0101050500',
    jvm: 'unparsed 1010', want: unparsed('method-type-no-methods') },
  { w: 14, name: 'M4-v3-1010-PC(typeId10)-c', tree: '0b14d1ed937e010105050093db0a010402db0a010402',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 15, name: 'M5-v0-1016-MC(Int.bitwiseOr)-a', tree: '0812d193dc04090402010402dc04090402010402',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 16, name: 'M5-v0-1016-MC(Int.bitwiseOr)-b', tree: '081ad1ed93dc04090402010402dc04090402010402937e0101050500',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 17, name: 'M5-v0-1016-MC(Int.bitwiseOr)-c', tree: '081ad1ed937e010105050093dc04090402010402dc04090402010402',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 18, name: 'M5-v0-1016-MC(Int.bitwiseOr)-d', tree: '00d193dc04090402010402dc04090402010402',
    jvm: 'rejected SerializerException <- ValidationException 1016 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'method-unknown') },
  { w: 19, name: 'M6-rev1-reviewer', tree: '0809d191db040604020400',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 20, name: 'M6-rev2-reviewer', tree: '0815d1db6810b5b2860204000400040000d90101040101',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 21, name: 'M6-rev3-reviewer', tree: '081bd193dc0409040201b5b2860204000400040000d901010401010400',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 22, name: 'T1-v0-1017-inlineConst-a', tree: '0808d193090101090101',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 23, name: 'T1-v0-1017-inlineConst-b', tree: '0810d1ed93090101090101937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 24, name: 'T1-v0-1017-inlineConst-c', tree: '0810d1ed937e010105050093090101090101',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 25, name: 'T1-v0-1017-inlineConst-d', tree: '00d193090101090101',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 26, name: 'T1-v0-1017-segConst-a', tree: '180a01090101d19373007300',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 27, name: 'T1-v0-1017-segConst-b', tree: '181201090101d1ed9373007300937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 28, name: 'T1-v0-1017-segConst-d', tree: '1001090101d19373007300',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 29, name: 'T1-v0-1017-GetVar-a', tree: '0805d1e6e30109',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 30, name: 'T1-v0-1017-GetVar-b', tree: '080dd1ede6e30109937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 31, name: 'T1-v0-1017-GetVar-c', tree: '080dd1ed937e0101050500e6e30109',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 32, name: 'T1-v0-1017-GetVar-d', tree: '00d1e6e30109',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 33, name: 'T1-v0-1017-ConcreteColl-a', tree: '0808d193b18300090400',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 34, name: 'T1-v0-1017-ConcreteColl-b', tree: '0810d1ed93b18300090400937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 35, name: 'T1-v0-1017-ConcreteColl-c', tree: '0810d1ed937e010105050093b18300090400',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 36, name: 'T1-v0-1017-ConcreteColl-d', tree: '00d193b18300090400',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 37, name: 'T1-v0-1017-ExtractRegisterAs-a', tree: '0806d1e6c6a70409',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 38, name: 'T1-v0-1017-ExtractRegisterAs-b', tree: '080ed1ede6c6a70409937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 39, name: 'T1-v0-1017-ExtractRegisterAs-c', tree: '080ed1ed937e0101050500e6c6a70409',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 40, name: 'T1-v0-1017-ExtractRegisterAs-d', tree: '00d1e6c6a70409',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 41, name: 'T1-v0-1017-DeserializeContext-a', tree: '0808d193d40901d40901',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 42, name: 'T1-v0-1017-DeserializeContext-b', tree: '0810d1ed93d40901d40901937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 43, name: 'T1-v0-1017-DeserializeContext-c', tree: '0810d1ed937e010105050093d40901d40901',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 44, name: 'T1-v0-1017-DeserializeContext-d', tree: '00d193d40901d40901',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 45, name: 'T1-v0-1017-DeserializeRegister-a', tree: '080ad193d5040900d5040900',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 46, name: 'T1-v0-1017-DeserializeRegister-b', tree: '0812d1ed93d5040900d5040900937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 47, name: 'T1-v0-1017-DeserializeRegister-c', tree: '0812d1ed937e010105050093d5040900d5040900',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 48, name: 'T1-v0-1017-DeserializeRegister-d', tree: '00d193d5040900d5040900',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 49, name: 'T1-v0-1017-Upcast-a', tree: '080ad1937e0402097e040209',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 50, name: 'T1-v0-1017-Upcast-b', tree: '0812d1ed937e0402097e040209937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 51, name: 'T1-v0-1017-Upcast-c', tree: '0812d1ed937e0101050500937e0402097e040209',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 52, name: 'T1-v0-1017-Upcast-d', tree: '00d1937e0402097e040209',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 53, name: 'T1-v0-1017-Downcast-a', tree: '080ad1937d0402097d040209',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 54, name: 'T1-v0-1017-Downcast-b', tree: '0812d1ed937d0402097d040209937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 55, name: 'T1-v0-1017-Downcast-c', tree: '0812d1ed937e0101050500937d0402097d040209',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 56, name: 'T1-v0-1017-Downcast-d', tree: '00d1937d0402097d040209',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 57, name: 'T1-v0-1017-FuncValueArg-a', tree: '080ad1ae1000d90101090101',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 58, name: 'T1-v0-1017-FuncValueArg-b', tree: '0812d1edae1000d90101090101937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 59, name: 'T1-v0-1017-FuncValueArg-c', tree: '0812d1ed937e0101050500ae1000d90101090101',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 60, name: 'T1-v0-1017-FuncValueArg-d', tree: '00d1ae1000d90101090101',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 61, name: 'T1-v0-1017-FunDefTypeArg-a', tree: '080bd801d70101090101d10101',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 62, name: 'T1-v0-1017-FunDefTypeArg-b', tree: '0810d801d70101090101d1937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 63, name: 'T1-v3-FunDefTypeArg-UBI', tree: '0b0bd801d70101090101d10101',
    jvm: 'rejected ClassCastException', want: rejected('fun-def-tpe-arg-not-type-var') },
  { w: 64, name: 'T1-rev1-reviewer', tree: '080bd801d6017e010109d10101',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 65, name: 'T1-rev2-reviewer', tree: '0807d1910901010101',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 66, name: 'T1-v0-1017-nestedBoxReg-a', tree: '0832d193c1630100d101010000010901010000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 67, name: 'T1-v0-1017-nestedBoxReg-badData', tree: '0831d193c1630100d1010100000109210000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 68, name: 'T1-v3-nestedBoxReg-a', tree: '0b32d193c1630100d101010000010901010000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1019', want: unparsed('register-v6-type') },
  { w: 69, name: 'T1-v3-nestedBoxReg-badData', tree: '0b31d193c1630100d1010100000109210000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'rejected SerializerException', want: rejected('unsigned-bigint-too-large') },
  { w: 70, name: 'T2-v0-1018-GetVar-a', tree: '0809d1e6e3017001040400',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 71, name: 'T2-v0-1018-GetVar-b', tree: '0811d1ede6e3017001040400937e0101050500',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 72, name: 'T2-v0-1018-GetVar-c', tree: '0811d1ed937e0101050500e6e3017001040400',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 73, name: 'T2-v0-1018-GetVar-d', tree: '00d1e6e3017001040400',
    jvm: 'rejected SerializerException <- ValidationException 1018 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-unknown') },
  { w: 74, name: 'T2-v0-1018-inlineConst-a', tree: '080cd19370010404007001040400',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 75, name: 'T2-v3-1009-inlineConst-a', tree: '0b0cd19370010404007001040400',
    jvm: 'unparsed 1009', want: unparsed('data-type-not-serializable') },
  { w: 76, name: 'T2-v3-1009-inlineConst-c', tree: '0b14d1ed937e01010505009370010404007001040400',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 77, name: 'T2-v3-1009-segConst-a', tree: '1b0c017001040400d19373007300',
    jvm: 'unparsed 1009', want: unparsed('data-type-not-serializable') },
  { w: 78, name: 'T2-v0-1018-nestedBoxReg-a', tree: '0834d193c1630100d1010100000170010404000000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 79, name: 'T2-v3-1009-nestedBoxReg-a', tree: '0b34d193c1630100d1010100000170010404000000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1009', want: unparsed('data-type-not-serializable') },
  { w: 80, name: 'T2-v3-GetVar-SFunc-ok', tree: '0b09d1e6e3017001040400',
    jvm: 'parsed', want: PARSED },
  { w: 81, name: 'T3-v0-1017-GetVar(0a)-a', tree: '0805d1e6e3010a',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 82, name: 'T3-v0-1017-GetVar(0a)-b', tree: '080dd1ede6e3010a937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 83, name: 'T3-v0-1017-GetVar(0a)-c', tree: '080dd1ed937e0101050500e6e3010a',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 84, name: 'T3-v0-1017-GetVar(0a)-d', tree: '00d1e6e3010a',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 85, name: 'T3-v3-1017-GetVar(0a)-a', tree: '0b05d1e6e3010a',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 86, name: 'T3-v3-1017-GetVar(0a)-b', tree: '0b0dd1ede6e3010a937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 87, name: 'T3-v3-1017-GetVar(0a)-c', tree: '0b0dd1ed937e0101050500e6e3010a',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 88, name: 'T3-v0-1017-inlineConst(0b)-a', tree: '0804d1930b0b',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 89, name: 'T3-v0-1017-segConst(0a)-a', tree: '1808010ad19373007300',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 90, name: 'T3-v0-1017-ConcreteColl(0a)-a', tree: '0808d193b183000a0400',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 91, name: 'T3-v0-1017-FunDefTypeArg(0a)-a', tree: '080bd801d701010a0101d10101',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 92, name: 'T3-v3-1017-ExplicitTypeArg(none[0a])-a', tree: '0b07d1e6db6a0add0a',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 93, name: 'T3-v3-1017-ExplicitTypeArg(none[0a])-b', tree: '0b0fd1ede6db6a0add0a937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 94, name: 'T3-v0-ExplicitTypeArg(none[0a])-lookupFirst', tree: '0807d1e6db6a0add0a',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 95, name: 'T4-v0-1018-GetVar(71)-a', tree: '0805d1e6e30171',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 96, name: 'T4-v0-1018-GetVar(71)-b', tree: '080dd1ede6e30171937e0101050500',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 97, name: 'T4-v0-1018-GetVar(71)-c', tree: '080dd1ed937e0101050500e6e30171',
    jvm: 'rejected SerializerException <- IllegalArgumentException', want: rejected('numeric-cast-input-not-numeric') },
  { w: 98, name: 'T4-v0-1018-GetVar(71)-d', tree: '00d1e6e30171',
    jvm: 'rejected SerializerException <- ValidationException 1018 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-unknown') },
  { w: 99, name: 'T4-v3-1018-GetVar(71)-a', tree: '0b05d1e6e30171',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 100, name: 'T4-v0-1018-segConst(71)-a', tree: '18080171d19373007300',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 101, name: 'T4-v0-1018-nestedTypeColl(71)-a', tree: '0806d1930c710c71',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 102, name: 'T4-v3-1018-ExplicitTypeArg(none[71])-a', tree: '0b07d1e6db6a0add71',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 103, name: 'T5-v0-1018-inlineConst(6b)-a', tree: '0804d1936b6b',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 104, name: 'T5-v3-1018-inlineConst(6b)-a', tree: '0b04d1936b6b',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 105, name: 'N1-v3-nestedUnsizedTree-UBI', tree: '0b34d193c1630100d1930901010901010000000000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 106, name: 'N2-v3-nestedUnsizedTree-method', tree: '0b38d193c1630100d193db04060402db040604020000000000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'rejected SerializerException <- ValidationException 1016 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'method-unknown') },
  { w: 107, name: 'N3-v3-nestedSizedTree-UBI', tree: '0b35d193c163010808d1930901010901010000000000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'parsed', want: PARSED },
  { w: 108, name: 'B1-box-unsizedV0Tree-method', box: '0100d193db04060402db04060402000000000000000000000000000000000000000000000000000000000000000000000000',
    jvm: 'rejected SerializerException <- ValidationException 1016 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'method-unknown') },
  { w: 109, name: 'B2-box-unsizedV0Tree-UBI', box: '0100d193090101090101000000000000000000000000000000000000000000000000000000000000000000000000',
    jvm: 'rejected SerializerException <- ValidationException 1017 <- SerializerException', want: rejected('soft-fork-without-size-bit', 'type-code-primitive-unknown') },
  { w: 110, name: 'B3-box-sizedV0Tree-UBI', box: '010808d193090101090101000000000000000000000000000000000000000000000000000000000000000000000000',
    jvm: 'accepted, tree unparsed 1017, identity', want: boxAccepted('type-code-primitive-unknown') },
  { w: 111, name: 'B4-box-R4-SFunc', box: '0100d101010000017001040400000000000000000000000000000000000000000000000000000000000000000000',
    jvm: 'rejected ValidationException 1009 <- SerializerException', want: rejected('data-type-not-serializable') },
  { w: 112, name: 'B5-box-R4-UBI', box: '0100d10101000001090101000000000000000000000000000000000000000000000000000000000000000000',
    jvm: 'rejected ValidationException 1019 <- SerializerException', want: rejected('register-v6-type') },
  { w: 113, name: 'B6-box-R4-type0a', box: '0100d101010000010a000000000000000000000000000000000000000000000000000000000000000000',
    jvm: 'rejected ValidationException 1017 <- SerializerException', want: rejected('type-code-primitive-unknown') },
  { w: 114, name: 'B7-box-R4-UBI-activated1', box: '0100d10101000001090101000000000000000000000000000000000000000000000000000000000000000000', ergoTree: 1,
    jvm: 'rejected ValidationException 1007 <- SerializerException', want: rejected('type-code-primitive-unknown') },
  { w: 115, name: 'B8-box-R4-Option-activated3-ergoTree0', box: '0100d1010100000124020102000000000000000000000000000000000000000000000000000000000000000000', ergoTree: 0,
    jvm: 'rejected ValidationException 1009 <- SerializerException', want: rejected('soption-tree-version-too-low') },
  { w: 116, name: 'S1-spend-v0-decoded-method', spend: '00d1d40101', var1: '0e10950101010193db04060402db04060402',
    jvm: 'rejected ValidationException 1016 <- SerializerException', want: spendRejected('deserialize-parse-failed', 'method-unknown') },
  { w: 117, name: 'S2-spend-v3-decoded-method', spend: '0b04d1d40101', var1: '0e10950101010193db040e0402db040e0402',
    jvm: 'rejected ValidationException 1016 <- SerializerException', want: spendRejected('deserialize-parse-failed', 'method-unknown') },
  { w: 118, name: 'S3-spend-v0-decoded-UBI', spend: '00d1d40101', var1: '0e0c950101010193090101090101',
    jvm: 'rejected ValidationException 1017 <- SerializerException', want: spendRejected('deserialize-parse-failed', 'type-code-primitive-unknown') },
  { w: 119, name: 'S4-spend-v0-decoded-type0a', spend: '00d1d40101', var1: '0e099501010101e6e3010a',
    jvm: 'rejected ValidationException 1017 <- SerializerException', want: spendRejected('deserialize-parse-failed', 'type-code-primitive-unknown') },
  { w: 120, name: 'S5-spend-v0-control-ok', spend: '00d1d40101', var1: '0e0795010101010101',
    jvm: 'reduced TrueProp', want: REDUCED },
  { w: 121, name: 'S6-spend-v0sized-deadbranch-method', spend: '0811d1950101010193db04060402db04060402',
    jvm: 'rejected InterpreterException <- ValidationException 1016 <- SerializerException', want: spendUnparsed('method-unknown') },
  { w: 122, name: 'S7-spend-v3-deadbranch-method', spend: '0b11d1950101010193db040e0402db040e0402',
    jvm: 'rejected InterpreterException <- ValidationException 1016 <- SerializerException', want: spendUnparsed('method-unknown') },
  { w: 123, name: 'S8-spend-v0sized-deadbranch-UBI', spend: '080dd1950101010193090101090101',
    jvm: 'rejected InterpreterException <- ValidationException 1017 <- SerializerException', want: spendUnparsed('type-code-primitive-unknown') },
  { w: 124, name: 'S9-spend-v0sized-deadbranch-SFuncGetVar', spend: '080ed19501010101e6e3017001040400',
    jvm: 'rejected InterpreterException <- ValidationException 1018 <- SerializerException', want: spendUnparsed('type-code-unknown') },
  { w: 125, name: 'S10-spend-v0sized-control', spend: '080ad19501010101e6e30104',
    jvm: 'reduced TrueProp', want: REDUCED },
  { w: 126, name: 'NR1-encl-v0-nestedTree-v3-R4-SFunc', tree: '0835d193c163010b03d1010100000170010404000000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1018', want: unparsed('type-code-unknown') },
  { w: 127, name: 'NR2-encl-v3-nestedTree-v0-R4-SFunc', tree: '0b34d193c1630100d1010100000170010404000000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1009', want: unparsed('data-type-not-serializable') },
  { w: 128, name: 'NR3-encl-v3-nestedTree-v0-R4-UBI', tree: '0b32d193c1630100d101010000010901010000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1019', want: unparsed('register-v6-type') },
  { w: 129, name: 'NR4-encl-v0-nestedTree-v3-R4-UBI', tree: '0833d193c163010b03d101010000010901010000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 130, name: 'RL1-encl-v0-R4-PropertyCall-1016', tree: '0834d193c1630100d10101000001db040604020000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1016', want: rejected('sbox-register-unsupported-expr') },
  { w: 131, name: 'RL2-encl-v0-R4-GetVar(0a)-1017', tree: '0832d193c1630100d10101000001e3010a0000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'unparsed 1017', want: rejected('sbox-register-unsupported-expr') },
  { w: 132, name: 'RL3-encl-v0-R4-GetVar(Int)-control', tree: '0832d193c1630100d10101000001e301040000000000000000000000000000000000000000000000000000000000000000000500',
    jvm: 'rejected ClassCastException', want: rejected('sbox-register-unsupported-expr') },
  { w: 133, name: 'MA0-v0-MC-0args-unknown', tree: '080ed193dc0406040200dc0406040200',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 134, name: 'MA3-v3-MC-0args-unknown', tree: '0b0ed193dc040e040200dc040e040200',
    jvm: 'rejected AssertionError', want: rejected('method-call-empty-args') },
  { w: 135, name: 'MT3-v3-MC-some[0a]', tree: '0b0ad1e6dc6a09dd0104020a',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 136, name: 'MT3b-v3-MC-some[0a]-then-BAD', tree: '0b12d1ede6dc6a09dd0104020a937e0101050500',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
  { w: 137, name: 'MT0-v0-MC-some[0a]-lookupFirst', tree: '080ad1e6dc6a09dd0104020a',
    jvm: 'unparsed 1016', want: unparsed('method-unknown') },
  { w: 138, name: 'SC0-spend-v0-substConstants-UBI-template', spend: '00d191b1740e081001090101d17300100010000400',
    jvm: 'rejected ValidationException 1017 <- SerializerException', want: spendRejected('subst-constants-error', 'type-code-primitive-unknown') },
  { w: 139, name: 'SC3-spend-v3-substConstants-UBI-template', spend: '0b14d191b1740e081001090101d17300100010000400',
    jvm: 'reduced TrueProp', want: REDUCED },
  { w: 140, name: 'SC0b-spend-v0-substConstants-type0a-template', spend: '00d191b1740e0610010ad17300100010000400',
    jvm: 'rejected ValidationException 1017 <- SerializerException', want: spendRejected('subst-constants-error', 'type-code-primitive-unknown') },
  { w: 141, name: 'O1-v0-ExtractRegisterAs-reg10-type09', tree: '0806d1e6c6a70a09',
    jvm: 'rejected NoSuchElementException', want: rejected('extract-register-as-id-out-of-range') },
  { w: 142, name: 'O2-v0-DeserializeRegister-reg10-type0a', tree: '080ad193d50a0a00d50a0a00',
    jvm: 'rejected NoSuchElementException', want: rejected('deserialize-register-id-out-of-range') },
  { w: 143, name: 'O3-v0-MC-unknown-arg-UBI', tree: '0814d193dc0409040201090101dc0409040201090101',
    jvm: 'unparsed 1017', want: unparsed('type-code-primitive-unknown') },
]

/** The rows a mutation of a read's version or order is caught by, and residual 8's pair. */
const TITLES: Record<number, string> = {
  69:
    'enclosing v3, a nested v0 tree, R4 an UnsignedBigInt of declared size 33: read at the enclosing v3, the ' +
    "type is known and the data's 32-byte bound fails, a SerializerException. The one row whose verdict " +
    "flips if a nested box's registers are read at the nested tree's version (at v0 the type fails rule 1017 first)",
  126:
    'enclosing v0, a nested v3 tree, R4 typed SFunc: the register is read at the enclosing v0, where 112 is no ' +
    'type, rule 1018 (at the nested v3 it would be the data, rule 1009)',
  127:
    'enclosing v3, a nested v0 tree, R4 typed SFunc: read at the enclosing v3, the type is known and its data ' +
    'fails rule 1009 (at the nested v0 it would be rule 1018)',
  128:
    'enclosing v3, a nested v0 tree, R4 an UnsignedBigInt: read at the enclosing v3, the value parses and rule ' +
    '1019 refuses it (at the nested v0 it would be rule 1017)',
  129:
    'enclosing v0, a nested v3 tree, R4 an UnsignedBigInt: read at the enclosing v0, type 9 fails rule 1017 (at ' +
    'the nested v3 it would be rule 1019)',
  130:
    'residual 8: a nested register led by a PropertyCall whose lookup fails rule 1016. The JVM builds the ' +
    'payload before its EvaluatedValue cast (ErgoBoxCandidate.scala:231) and degrades; ergots still rejects on the lead byte',
  131:
    'residual 8: a nested register led by GetVar(1, <0a>), whose type fails rule 1017. The JVM builds the ' +
    'payload and degrades; ergots still rejects on the lead byte',
  135: 'v3 Global.some[<0a>](1): the lookup finds 106:9, then its explicit type argument fails rule 1017',
  136: "the same, then a later Upcast(true, Long): the type argument's rule 1017 comes first",
  141:
    'v0 ExtractRegisterAs, register id 10, type 09: the id is checked before the type is read ' +
    '(ExtractRegisterAsSerializer.scala:28, a NoSuchElementException), not rule 1017',
  142:
    'v0 DeserializeRegister, register id 10, type 0a: the id before the type (DeserializeRegisterSerializer.scala:28, ' +
    'a NoSuchElementException)',
  143:
    'v0 MethodCall Int.bitwiseOr (4:9, a v3 method) whose argument is an UnsignedBigInt: the argument is read ' +
    'before the lookup (MethodCallSerializer.scala:51-56), so its rule 1017 comes first, not 1016',
}

describe("the witness table: every row of the audit's battery", () => {
  it('holds all 143 rows, in order', () =>
    expect(WITNESSES.map((r) => r.w)).toEqual(Array.from({ length: 143 }, (_x, i) => i + 1)))
  for (const row of WITNESSES) {
    it(`W:${row.w} ${TITLES[row.w] ?? row.name}: the JVM ${row.jvm}`, () => checkRow(row))
  }
})

// Type code 0 stays hard in a sized tree: InvalidTypePrefix is no ValidationException (TypeSerializer.scala:
// 133-135), so the tree does not degrade on it (tree mode, `checkType = true`).
describe('type code 0 in a sized tree', () => {
  it('sized v3 sigmaProp(GetVar(1, <00>).isDefined): the JVM rejects (InvalidTypePrefix)', () =>
    checkTree('0b05d1e6e30100', rejected('type-prefix-invalid')))
  it('the sized v0 twin: the JVM rejects (InvalidTypePrefix)', () =>
    checkTree('0805d1e6e30100', rejected('type-prefix-invalid')))
})

// ---------------------------------------------------------------------------------------------------------
// A Coll's element type
// ---------------------------------------------------------------------------------------------------------

/**
 * `CoreDataSerializer.deserializeColl` builds the item RType before it reads any item, an empty collection
 * included, for every element type but Boolean and Byte: `Evaluation.stypeToRType(elem)`, except for a
 * tuple element of other than two items, which takes `collRType(AnyType)` unchecked
 * (CoreDataSerializer.scala:152-166). `stypeToRType` (Evaluation.scala:18-56) recurses through a pair, any
 * tuple below the element, Coll, Option and a one-argument SFunc with no type parameters, and throws a
 * RuntimeException (`sys.error`), a hard reject, for an STypeVar or any other SFunc. Tree mode,
 * `checkType = true`; `bfull/review/review1`-`review5` (R11, R15 and R19 in their corrected forms, review3
 * and review5) and this task's P1-P3.
 */
const COLL_ELEM: { name: string; tree: string; jvm: string; want: Want }[] = [
  {
    name: 'R1: a sized v3 Coll[(Int, Int) => Int] with one item: the element check fails before the item, and the tree does not degrade',
    tree: '0b12d1930c700204040400010c70020404040001',
    jvm: "rejected RuntimeException (Don't know how to convert SType (SInt$,SInt$) => SInt$ to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R3: the same, empty',
    tree: '0b12d1930c700204040400000c70020404040000',
    jvm: 'rejected RuntimeException',
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R13: a sized v3 Coll[Int => T] with one item',
    tree: '0b14d1930c70010467015400010c7001046701540001',
    jvm: "rejected RuntimeException (Don't know how to convert SType T to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R14: a sized v3 Coll[[T](Int) => Int] with one item',
    tree: '0b16d1930c7001040401670154010c700104040167015401',
    jvm: 'rejected RuntimeException',
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R12: a sized v3 Coll[((Int, Int) => Int, Int)] with one item: a pair element is checked',
    tree: '0b14d1930c4c700204040400010c4c70020404040001',
    jvm: 'rejected RuntimeException',
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R16: a sized v3 Coll[Option[(Int, Int) => Int]] with one item: the check recurses through Option',
    tree: '0b14d1930c24700204040400010c2470020404040001',
    jvm: 'rejected RuntimeException',
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'P1: a sized v3 Coll[((Int, T, Int), Int)], empty: a tuple of three below the pair element is recursed into',
    tree: '0b14d1930c4c480467015404000c4c48046701540400',
    jvm: "rejected RuntimeException (Don't know how to convert SType T to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'P2: a sized v3 Coll[Coll[(Int, Int) => Int]], empty: the check recurses through Coll',
    tree: '0b14d1930c0c700204040400000c0c70020404040000',
    jvm: "rejected RuntimeException (Don't know how to convert SType (SInt$,SInt$) => SInt$ to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  // Two over-accepts older than this branch: ergots degraded these on the item's Option data (rule 1009),
  // or read no item at all.
  {
    name: "R17: a sized v0 Coll[Option[T]] with one item: the check fails before the item's Option data",
    tree: '0812d1930c246701540101040c24670154010104',
    jvm: "rejected RuntimeException (Don't know how to convert SType T to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R19: a sized v0 Coll[(Option[Int], T)] with one item',
    tree: '0816d1930c3c24046701540101040c3c2404670154010104',
    jvm: "rejected RuntimeException (Don't know how to convert SType T to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R5: an unsized v0 tree with an empty Coll[T]',
    tree: '00d1930c670154000c67015400',
    jvm: "rejected RuntimeException (Don't know how to convert SType T to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  {
    name: 'R6: a sized v0 tree with an empty Coll[T]',
    tree: '080cd1930c670154000c67015400',
    jvm: "rejected RuntimeException (Don't know how to convert SType T to RType)",
    want: rejected('coll-elem-type-no-rtype'),
  },
  // The controls: the element passes, or is not checked, and the data read decides.
  {
    name: "R2: a sized v3 Coll[Int => Int] with one item: a one-argument SFunc element passes, and the item's SFunc data fails rule 1009",
    tree: '0b10d1930c7001040400010c700104040001',
    jvm: 'unparsed 1009',
    want: unparsed('data-type-not-serializable'),
  },
  {
    name: 'R4: the same, empty: no item is read',
    tree: '0b10d1930c7001040400000c700104040000',
    jvm: 'parsed',
    want: PARSED,
  },
  {
    name: "R10: a sized v3 Coll[((Int, Int) => Int, Int, Int)] with one item: a tuple element of three is not checked, and the item's SFunc data fails rule 1009",
    tree: '0b18d1930c487002040404000404010c48700204040400040401',
    jvm: 'unparsed 1009',
    want: unparsed('data-type-not-serializable'),
  },
  {
    name: 'P3: a sized v3 Coll[(Int, T, Int)], empty: a tuple element of three is not checked',
    tree: '0b12d1930c480467015404000c48046701540400',
    jvm: 'parsed',
    want: PARSED,
  },
  {
    name: "R11: a sized v3 Coll[(Int => Int, Int)] with one item: the pair passes, and the item's SFunc data fails rule 1009",
    tree: '0b12d1930c4c7001040400010c4c700104040001',
    jvm: 'unparsed 1009',
    want: unparsed('data-type-not-serializable'),
  },
  {
    name: 'R15: a sized v3 Option[(Int, Int) => Int] Some, outside a Coll: no element check, and the SFunc data fails rule 1009',
    tree: '0b12d19324700204040400012470020404040001',
    jvm: 'unparsed 1009',
    want: unparsed('data-type-not-serializable'),
  },
  {
    name: "R18: a sized v0 Coll[Option[Int]] with one item: the element passes, and the item's Option data fails rule 1009",
    tree: '080ed1930c24040101040c2404010104',
    jvm: 'unparsed 1009',
    want: unparsed('soption-tree-version-too-low'),
  },
]

describe("a Coll's element type: Evaluation.stypeToRType before any item", () => {
  for (const c of COLL_ELEM) {
    it(`${c.name}: the JVM ${c.jvm}`, () => checkTree(c.tree, c.want))
  }
})

// ---------------------------------------------------------------------------------------------------------
// The top-level version
// ---------------------------------------------------------------------------------------------------------

// The review of §4a, I1 (box mode; `bfull/review/review1` R7-R9): the node reads a block's transactions at
// (3, 3) since 6.0. A box whose R4 is an empty Coll[Int => Int] parses there, and fails the type read at
// (1, 1) (rule 1008, the pre-activation 1018) and at (3, 0) (rule 1018): the version at the top level decides
// a verdict. The transaction package's box and extension tests pin that it reads at 3.
describe('the top-level version: a box whose R4 is an empty Coll[Int => Int]', () => {
  const BOX = `0100d101010000010c700104040000${'00'.repeat(33)}`
  it('R7: read at 3, the JVM accepts it, and writes it back as read', () => {
    const box = parseSValue({ tag: 'SBox' }, 3, new ByteReader(fromHex(BOX)))
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, box, 3, w)
    expect(toHex(w.toBytes())).toBe(BOX)
    const r4 = (box as { value: { registers: Record<number, { tpe: SType; value: SValue } | undefined> } }).value.registers[4]
    expect(r4?.tpe).toEqual({ tag: 'SColl', elem: { tag: 'SFunc', args: [{ tag: 'SInt' }], result: { tag: 'SInt' }, tpeParams: [] } })
  })
  it('R8: read at (1, 1), the JVM rejects it (rule 1008)', () => checkBox(BOX, 1, rejected('type-code-unknown')))
  it('R9: read at (3, 0), the JVM rejects it (rule 1018)', () => checkBox(BOX, 0, rejected('type-code-unknown')))
})

// ---------------------------------------------------------------------------------------------------------
// SANTA Box.tree_nested_degrade
// ---------------------------------------------------------------------------------------------------------

// SANTA JVM-blessed Box vectors (jvm:sigma-state-6.0.6, santa 9fa5036): Box.tree_nested_degrade, copied
// verbatim, replayed as Dasher does: parseSValue(SBox) at the vector's version, then serializeSValue(SBox);
// the expected bytes are expected_bytes_hex ?? bytes_hex. #0-#10 come from the sized-tree work, and ergots
// matches each already. #11-#19 are the enclosing version of a nested box's registers: #14/#15 the SHeader
// pair (a reject under an enclosing v0, which has no SHeader data; a degrade on rule 1019 under v3), #17/#18
// the audit's W:69 mirror (a reject under an enclosing v3; a degrade on rule 1017 under v0).
interface SantaEntry {
  name: string
  bytes_hex: string
  expected_bytes_hex?: string
  error?: string
  version: { activated: number; ergoTree: number }
}

/** Each errored entry's reject, as its description gives it: the code, and the wrapped soft code. */
const NESTED_ERRORS: Record<string, { code: string; cause?: string }> = {
  'box-nested-unsized-softfork-reject#0': { code: 'soft-fork-without-size-bit', cause: 'opcode-reserved' },
  'box-nested-rule-1012-unsized-outer-reject#3': { code: 'soft-fork-without-size-bit', cause: 'header-version-requires-size' },
  'box-nested-option-register-unsized-outer-reject#5': { code: 'soft-fork-without-size-bit', cause: 'soption-tree-version-too-low' },
  'box-nested-sheader-register-v1-reject#6': { code: 'sheader-tree-version-too-low' },
  'box-nested-unsized-int-root-reject#9': { code: 'soft-fork-without-size-bit', cause: 'root-not-sigma-prop' },
  'box-nested-enclosing-v0-int-register-body-reject#12': { code: 'numeric-cast-input-not-numeric' },
  'box-nested-enclosing-v0-sheader-register-reject#14': { code: 'sheader-tree-version-too-low' },
  'box-nested-enclosing-v3-ubi-size-33-register-reject#17': { code: 'unsigned-bigint-too-large' },
}

/** Each accepted entry whose own tree degrades, with the code it degrades on; the others' trees parse. */
const NESTED_UNPARSED: Record<string, string> = {
  'box-nested-rule-1012-degrade-accept#2': 'header-version-requires-size',
  'box-nested-rule-1019-degrade-accept#4': 'register-v6-type',
  'box-nested-sheader-register-v3-degrade-accept#7': 'register-v6-type',
  'box-nested-seven-registers-r4-degrade-accept#8': 'register-v6-type',
  'box-nested-enclosing-v0-ubi-register-degrade-accept#11': 'type-code-primitive-unknown',
  'box-nested-enclosing-v0-func-register-degrade-accept#13': 'type-code-unknown',
  'box-nested-enclosing-v3-sheader-register-degrade-accept#15': 'register-v6-type',
  'box-nested-enclosing-v3-ubi-register-degrade-accept#16': 'register-v6-type',
  'box-nested-enclosing-v0-ubi-size-33-register-degrade-accept#18': 'type-code-primitive-unknown',
  'box-nested-enclosing-v3-ubi-size-32-register-degrade-accept#19': 'register-v6-type',
}

describe('SANTA Box.tree_nested_degrade.json (jvm:sigma-state-6.0.6, santa 9fa5036)', () => {
  const entries: SantaEntry[] = JSON.parse(
    readFileSync(join(__dirname, '../fixtures/conformance/wire/Box.tree_nested_degrade.json'), 'utf8'),
  ).entries
  it('holds 20 entries', () => expect(entries.length).toBe(20))
  for (const e of entries) {
    it(e.name, () => {
      if (e.error === 'errored') {
        const want = NESTED_ERRORS[e.name]
        if (want === undefined) throw new Error(`no reject pinned for ${e.name}`)
        checkBox(e.bytes_hex, e.version.ergoTree, rejected(want.code, want.cause))
        return
      }
      expect(NESTED_ERRORS[e.name]).toBeUndefined()
      const box = parseSValue({ tag: 'SBox' }, e.version.ergoTree, new ByteReader(fromHex(e.bytes_hex)))
      const w = new ByteWriter()
      serializeSValue({ tag: 'SBox' }, box, e.version.ergoTree, w)
      expect(toHex(w.toBytes())).toBe(e.expected_bytes_hex ?? e.bytes_hex)
      const tree = boxTreeOf((box as { value: { ergoTreeBytes: Uint8Array } }).value.ergoTreeBytes)
      const code = NESTED_UNPARSED[e.name]
      if (code === undefined) {
        expect(isUnparsedTree(tree), `${e.name}: expected its tree parsed`).toBe(false)
      } else {
        if (!isUnparsedTree(tree)) throw new Error(`${e.name}: expected its tree unparsed on ${code}`)
        expect(codeOf(tree.error), describeError(tree.error)).toBe(code)
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------------------
// validateV6Types, moved to the parse
// ---------------------------------------------------------------------------------------------------------

/**
 * The pre-eval pass `validateV6Types` is gone (spec §4a): every type it walked now comes from a read at the
 * JVM's version. Each of its tests' trees, written with ergots' serializer under a size-flagged v2 header
 * (0x0a, or 0x1a with segregated constants), an unsized v0 one (0x00 / 0x10) and a size-flagged v3 one
 * (0x0b / 0x1b), parsed leniently (tree mode, `checkType = false`): the JVM degrades the sized v2 tree on the
 * rule, rejects the unsized v0 one, and parses the v3 one. The explicit type arguments are read only after
 * the lookup, and their six methods exist only from v3, so below v3 they fail rule 1016 first.
 */
const MOVED: [string, string, string, string, 1016 | 1017 | 1018][] = [
  ['a UBI Const body', '0a03090105', '00090105', '0b03090105', 1017],
  ['an empty Coll[UBI] body (no UBI value is read)', '0a03830009', '00830009', '0b03830009', 1017],
  ['GetVar Option[UBI]', '0a03e3012d', '00e3012d', '0b03e3012d', 1017],
  ['GetVar (Int, UBI)', '0a04e3014009', '00e3014009', '0b04e3014009', 1017],
  ['GetVar UBI', '0a03e30109', '00e30109', '0b03e30109', 1017],
  ['a FuncValue argument typed UBI', '0a06d90101090400', '00d90101090400', '0b06d90101090400', 1017],
  ['a UBI Const in a dead If branch', '0a089501010402090102', '009501010402090102', '0b089501010402090102', 1017],
  ['Upcast to UBI', '0a047e040009', '007e040009', '0b047e040009', 1017],
  ['Downcast to UBI', '0a047d040009', '007d040009', '0b047d040009', 1017],
  ['ExtractRegisterAs UBI', '0a04c6a70409', '00c6a70409', '0b04c6a70409', 1017],
  ['DeserializeContext UBI', '0a03d40901', '00d40901', '0b03d40901', 1017],
  ['DeserializeRegister UBI', '0a04d5040900', '00d5040900', '0b04d5040900', 1017],
  ['a dead UBI segregated constant', '1a06010901090400', '10010901090400', '1b06010901090400', 1017],
  ['an empty Coll[UBI] segregated constant (no UBI value is read)', '1a050115000400', '100115000400', '1b050115000400', 1017],
  ['a UBI segregated constant a dead If branch refers to', '1a0b0109010395010104027300', '100109010395010104027300', '1b0b0109010395010104027300', 1017],
  ['GetVar (Int) => Boolean', '0a07e3017001040100', '00e3017001040100', '0b07e3017001040100', 1018],
  ['an empty Coll[(Int) => Boolean] body', '0a0783007001040100', '0083007001040100', '0b0783007001040100', 1018],
  ['Global.none[UBI] (106:10)', '0a05db6a0add09', '00db6a0add09', '0b05db6a0add09', 1016],
  ['Global.some[UBI](1) (106:9)', '0a08dc6a09dd01040209', '00dc6a09dd01040209', '0b08dc6a09dd01040209', 1016],
  ['Global.none[UBI] in a dead If branch', '0a0a9501010101db6a0add09', '009501010101db6a0add09', '0b0a9501010101db6a0add09', 1016],
]
const MOVED_CODE: Record<1016 | 1017 | 1018, string> = {
  1016: 'method-unknown',
  1017: 'type-code-primitive-unknown',
  1018: 'type-code-unknown',
}

function lenientTree(hex: string): ErgoTree | { rejected: unknown } {
  try {
    return parseTree(fromHex(hex))
  } catch (err) {
    return { rejected: err }
  }
}

describe('the trees of the retired validateV6Types pass, at parse', () => {
  for (const [name, v2, v0, v3, rule] of MOVED) {
    const code = MOVED_CODE[rule]
    it(`${name}, sized v2: the JVM degrades the tree (rule ${rule})`, () => {
      const t = lenientTree(v2)
      if ('rejected' in t || !isUnparsedTree(t)) throw new Error(`expected an unparsed tree, got ${JSON.stringify('rejected' in t ? describeError(t.rejected) : 'parsed')}`)
      expect(codeOf(t.error), describeError(t.error)).toBe(code)
    })
    it(`${name}, unsized v0: the JVM rejects the tree (rule ${rule})`, () => {
      const t = lenientTree(v0)
      if (!('rejected' in t)) throw new Error('expected a reject')
      expectReject(t.rejected, 'soft-fork-without-size-bit', code)
    })
    it(`${name}, sized v3: the JVM parses the tree`, () => {
      const t = lenientTree(v3)
      if ('rejected' in t) throw new Error(`expected a parsed tree, got ${describeError(t.rejected)}`)
      expect(isUnparsedTree(t)).toBe(false)
    })
  }

  it('a dead segregated constant typed (Int) => Boolean: sized v2, the JVM degrades the tree (rule 1018)', () => {
    const t = lenientTree('1a080170010401000400')
    if ('rejected' in t || !isUnparsedTree(t)) throw new Error('expected an unparsed tree')
    expect(codeOf(t.error)).toBe('type-code-unknown')
  })
  it('the same, unsized v0: the JVM rejects the tree (rule 1018)', () => {
    const t = lenientTree('100170010401000400')
    if (!('rejected' in t)) throw new Error('expected a reject')
    expectReject(t.rejected, 'soft-fork-without-size-bit', 'type-code-unknown')
  })

  // A v2 tree whose lambdas are first-order carries no SFunc type code, though its computed type is one.
  for (const [name, hex] of [
    ['a first-order FuncValue', '0a06d90101047201'],
    ['Int arithmetic', '0a059a04020404'],
    ['a Map over Coll[Int](1, 2) with a first-order lambda', '0a0bad10020204d90101047201'],
  ] as const) {
    it(`${name}, sized v2: the JVM parses the tree`, () => {
      const t = lenientTree(hex)
      if ('rejected' in t) throw new Error(`expected a parsed tree, got ${describeError(t.rejected)}`)
      expect(isUnparsedTree(t)).toBe(false)
    })
  }

  it('a v3 UBI Const body evaluates to its value', () => {
    const t = lenientTree('0b03090105') as ErgoTree
    expect(evaluate(t)).toEqual({ kind: 'UnsignedBigInt', value: 5n })
  })
  it('a v3 If(true, true, Global.none[UBI]) evaluates to true', () => {
    const t = lenientTree('0b0a9501010101db6a0add09') as ErgoTree
    expect(evaluate(t)).toEqual({ kind: 'Boolean', value: true })
  })

  // The API change (spec §4a): evaluate on MIR a caller builds no longer rejects a v6 type in a pre-v3 tree,
  // since the parse is where the JVM's version gate is, and 'v6-type-in-pre-v3-tree' is retired.
  it('evaluate on built MIR: a UBI constant in a v2 tree is no longer rejected', () => {
    const built: ParsedErgoTree = {
      header: { version: 2, hasSize: true, constantSegregation: false, rawHeader: 0x0a },
      constantTypes: [],
      constants: [],
      body: { tag: 'Const', tpe: { tag: 'SUnsignedBigInt' }, value: { kind: 'UnsignedBigInt', value: 5n } },
    }
    expect(evaluate(built)).toEqual({ kind: 'UnsignedBigInt', value: 5n })
  })
})
