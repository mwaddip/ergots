/**
 * The JVM's method lookup at parse (sigma-state 6.0.6; spec docs/specs/2026-09-30-jvm-node-construction-design.md
 * §4a, "Method lookups"; facts/ergoscript-wire.md, "Method lookups"). `MethodCallSerializer.parse` and
 * `PropertyCallSerializer.parse` look the (typeId, methodId) pair up with `SMethod.fromIds`
 * (SMethod.scala:344-349): rule 1010 `CheckTypeWithMethods` when the typeId has no methods container, then
 * rule 1016 `CheckAndGetMethodV6` when the container lacks the method id (methods.scala:128-136), each
 * against the table of the tree's version class (`isV3OrLaterErgoTreeVersion`, methods.scala:79-111,
 * 175-189). Both are `ValidationException`s: a sized tree degrades to an `UnparsedErgoTree`, and an unsized
 * one rejects (ErgoTreeSerializer.scala:196-209).
 *
 * Each case's bytes are the bytes a local sigma-state 6.0.6 probe was given, and its comment gives the
 * probe's verdict: tree mode (`deserializeErgoTree` with `checkType = true`, under
 * `VersionContext.withVersions(3, the tree's version)`), box mode, or spend mode (the tree as SELF's, with
 * context variable 1 as given, reduced by `fullReduction`). The `W:n` names are the lines of the B-full
 * audit's witness battery (the plan's ledger, `bfull-audit.md` §5).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { jvmMethodLookup, jvmMethodTable } from '../../src/wire/jvm-method-table'
import type { MethodLookup } from '../../src/wire/jvm-method-table'
import { parseTree, ErgoTreeParseError } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { boxTreeOf } from '../../src/wire/box-tree'
import { isUnparsedTree } from '../../src/mir/types'
import type { ErgoTree, SValue } from '../../src/mir/types'
import { evaluate } from '../../src/eval/evaluate'
import type { EvalOpts } from '../../src/eval/eval-context'
import { captureEvalError } from '../_helpers'
import { T } from '../_helpers/mir-build'

const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

type LookupCode = 'method-unknown' | 'method-type-no-methods'
/** The ergots code of each JVM rule. */
const RULE: Record<1010 | 1016, LookupCode> = { 1010: 'method-type-no-methods', 1016: 'method-unknown' }

type Outcome = { status: 'parsed' } | { status: 'unparsed'; error: Error } | { status: 'rejected'; error: unknown }

/** The tree under the box rules (`checkType`), as the probe's tree mode parses it. */
function parseBoxRules(h: string): Outcome {
  let t: ErgoTree
  try {
    t = parseTree(fromHex(h), { checkType: true })
  } catch (error) {
    return { status: 'rejected', error }
  }
  return isUnparsedTree(t) ? { status: 'unparsed', error: t.error } : { status: 'parsed' }
}

function describeOutcome(o: Outcome): string {
  if (o.status === 'parsed') return 'parsed'
  const e = o.error as { name?: string; code?: string; message?: string }
  return `${o.status}: ${e.name ?? ''} ${e.code ?? ''} ${e.message ?? String(o.error)}`
}

/** The JVM degraded the tree on `rule`: ergots degrades it on that rule's code. */
function expectUnparsed(h: string, rule: 1010 | 1016): void {
  const o = parseBoxRules(h)
  if (o.status !== 'unparsed') throw new Error(`expected an unparsed tree (rule ${rule}), got ${describeOutcome(o)}`)
  expect(o.error).toBeInstanceOf(ExprParseError)
  expect((o.error as ExprParseError).code).toBe(RULE[rule])
}

/**
 * The JVM rejected the unsized tree: `SerializerException("Cannot handle ValidationException, ErgoTree
 * serialized without size bit.")` over the lookup's `ValidationException` (ErgoTreeSerializer.scala:204-207).
 */
function expectRejectedUnsized(h: string, rule: 1010 | 1016): void {
  const o = parseBoxRules(h)
  if (o.status !== 'rejected') throw new Error(`expected a reject (rule ${rule} in an unsized tree), got ${describeOutcome(o)}`)
  expect(o.error).toBeInstanceOf(ErgoTreeParseError)
  expect((o.error as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit')
  const cause = (o.error as Error).cause
  expect(cause).toBeInstanceOf(ExprParseError)
  expect((cause as ExprParseError).code).toBe(RULE[rule])
}

/** The JVM rejected the tree on a construction check or an assert: a hard reject in ergots, with `code`. */
function expectRejectedHard(h: string, code: string): void {
  const o = parseBoxRules(h)
  if (o.status !== 'rejected') throw new Error(`expected a hard reject (${code}), got ${describeOutcome(o)}`)
  expect(o.error).toBeInstanceOf(ExprParseError)
  expect((o.error as ExprParseError).code).toBe(code)
}

/**
 * The probe's `methods` dump (sigma-state 6.0.6 `SMethod.fromIds` over every (typeId, methodId), under
 * `withVersions(3, v)`): per tree version class, each typeId with a methods container and the method ids it
 * accepts. Version 0 stands for tree versions 0-2, whose dumps are identical. The probe ran the ids as the
 * JVM's signed bytes; none of the known ones is negative.
 */
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../fixtures/conformance/jvm-method-table.json'), 'utf8')) as
  Record<'0' | '3', Record<string, number[]>>

describe("the JVM's method table (SMethod.fromIds)", () => {
  it('the TS table equals the fixture: both version classes, every typeId, every method id', () => {
    for (const [version, key] of [[0, '0'], [3, '3']] as const) {
      const ts: Record<string, number[]> = {}
      for (const [typeId, ids] of jvmMethodTable(version)) ts[String(typeId)] = [...ids]
      expect(ts, `tree version ${version}`).toEqual(FIXTURE[key])
    }
  })

  it('jvmMethodLookup agrees with the fixture over all 256 × 256 (typeId, methodId) pairs, at every tree version', () => {
    // ergots' MIR holds each id as the unsigned byte it read; the JVM's is the signed byte.
    const signed = (u: number): number => (u << 24) >> 24
    const mismatches: string[] = []
    for (let v = 0; v <= 7; v++) {
      const table = FIXTURE[v >= 3 ? '3' : '0']
      for (let t = 0; t < 256; t++) {
        const ids = table[String(signed(t))]
        for (let m = 0; m < 256; m++) {
          const want: MethodLookup =
            ids === undefined ? 'method-type-no-methods' : ids.includes(signed(m)) ? 'ok' : 'method-unknown'
          const got = jvmMethodLookup(t, m, v)
          if (got !== want) mismatches.push(`v${v} ${t}:${m} ${got} (want ${want})`)
        }
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(mismatches.length).toBe(0)
  })

  it('a typeId with a container and no method fails with rule 1016; one with no container, with rule 1010', () => {
    // TypeIds 1, 96, 97, 98 and 102 at every version, and the numeric 2-6 below v3 (the fixture's empty lists).
    for (const t of [1, 96, 97, 98, 102]) {
      expect(jvmMethodLookup(t, 1, 0)).toBe('method-unknown')
      expect(jvmMethodLookup(t, 1, 3)).toBe('method-unknown')
    }
    for (const t of [2, 3, 4, 5, 6]) expect(jvmMethodLookup(t, 1, 2)).toBe('method-unknown')
    expect(jvmMethodLookup(9, 1, 2)).toBe('method-type-no-methods')
    expect(jvmMethodLookup(9, 1, 3)).toBe('ok')
  })
})

// (a) is the lookup's soft failure alone, as sigmaProp(X == X). (b) adds a later construction failure,
// EQ(Upcast(true, Long), 0L) inside a BinAnd: the lookup comes first in byte order, so the JVM degrades.
// (c) is (b) with the operands reversed: the Upcast's IllegalArgumentException comes first, a reject.
// (d) is the unsized v0 twin of (a).
describe('the witnesses: a lookup that fails degrades a sized tree and rejects an unsized one', () => {
  // Upcast(true, Long)'s require (trees.scala:398): the JVM's SerializerException over an
  // IllegalArgumentException, before the lookup's bytes.
  const UPCAST = 'numeric-cast-input-not-numeric'

  describe('M1: v0 PropertyCall Int.toBytes (4:6), found by id only from v3: rule 1016', () => {
    it('W:1 (a): the JVM degrades on rule 1016', () => expectUnparsed('080cd193db04060402db04060402', 1016))
    it('W:2 (b): the JVM degrades on rule 1016', () => expectUnparsed('0814d1ed93db04060402db04060402937e0101050500', 1016))
    it('W:3 (c): the JVM rejects (SerializerException <- IllegalArgumentException)', () =>
      expectRejectedHard('0814d1ed937e010105050093db04060402db04060402', UPCAST))
    it('W:4 (d): the JVM rejects the unsized tree (rule 1016)', () => expectRejectedUnsized('00d193db04060402db04060402', 1016))
  })

  describe('M2: v0 PropertyCall on typeId 9, which has no methods container below v3: rule 1010', () => {
    it('W:5 (a): the JVM degrades on rule 1010', () => expectUnparsed('080cd193db09010402db09010402', 1010))
    it('W:6 (b): the JVM degrades on rule 1010', () => expectUnparsed('0814d1ed93db09010402db09010402937e0101050500', 1010))
    it('W:7 (c): the JVM rejects (SerializerException <- IllegalArgumentException)', () =>
      expectRejectedHard('0814d1ed937e010105050093db09010402db09010402', UPCAST))
    it('W:8 (d): the JVM rejects the unsized tree (rule 1010)', () => expectRejectedUnsized('00d193db09010402db09010402', 1010))
  })

  describe('M3: v3 PropertyCall Int method 14, which Int does not have: rule 1016', () => {
    it('W:9 (a): the JVM degrades on rule 1016', () => expectUnparsed('0b0cd193db040e0402db040e0402', 1016))
    it('W:10 (b): the JVM degrades on rule 1016', () => expectUnparsed('0b14d1ed93db040e0402db040e0402937e0101050500', 1016))
    it('W:11 (c): the JVM rejects (SerializerException <- IllegalArgumentException)', () =>
      expectRejectedHard('0b14d1ed937e010105050093db040e0402db040e0402', UPCAST))
  })

  describe('M4: v3 PropertyCall on typeId 10, which has no methods container: rule 1010', () => {
    it('W:12 (a): the JVM degrades on rule 1010', () => expectUnparsed('0b0cd193db0a010402db0a010402', 1010))
    it('W:13 (b): the JVM degrades on rule 1010', () => expectUnparsed('0b14d1ed93db0a010402db0a010402937e0101050500', 1010))
    it('W:14 (c): the JVM rejects (SerializerException <- IllegalArgumentException)', () =>
      expectRejectedHard('0b14d1ed937e010105050093db0a010402db0a010402', UPCAST))
  })

  describe('M5: v0 MethodCall Int.bitwiseOr (4:9), a v3 method: rule 1016', () => {
    it('W:15 (a): the JVM degrades on rule 1016', () => expectUnparsed('0812d193dc04090402010402dc04090402010402', 1016))
    it('W:16 (b): the JVM degrades on rule 1016', () =>
      expectUnparsed('081ad1ed93dc04090402010402dc04090402010402937e0101050500', 1016))
    it('W:17 (c): the JVM rejects (SerializerException <- IllegalArgumentException)', () =>
      expectRejectedHard('081ad1ed937e010105050093dc04090402010402dc04090402010402', UPCAST))
    it('W:18 (d): the JVM rejects the unsized tree (rule 1016)', () =>
      expectRejectedUnsized('00d193dc04090402010402dc04090402010402', 1016))
  })

  describe("Task 3's review probes: a v6 pair below v3 is not typed, since its lookup fails first", () => {
    it('W:19: v0 sigmaProp(1.toBytes > 0): the JVM degrades on rule 1016 before GT is built', () =>
      expectUnparsed('0809d191db040604020400', 1016))
    it('W:20: v0 SHeader.checkPow (104:16) over a Filter of the JVM SAny: the JVM degrades on rule 1016', () =>
      expectUnparsed('0815d1db6810b5b2860204000400040000d90101040101', 1016))
    it('W:21: v0 Int.bitwiseOr (4:9) with a Filter of the JVM SAny argument: the JVM degrades on rule 1016', () =>
      expectUnparsed('081bd193dc0409040201b5b2860204000400040000d901010401010400', 1016))
  })

  describe('a nested tree and a box: an unsized v0 tree with an unknown method rejects', () => {
    it('W:106: a v3 tree whose SBox constant carries an unsized v0 tree with Int.toBytes: the JVM rejects (rule 1016)', () => {
      const o = parseBoxRules(
        '0b38d193c1630100d193db04060402db040604020000000000000000000000000000000000000000000000000000000000000000000000000500')
      if (o.status !== 'rejected') throw new Error(`expected a reject, got ${describeOutcome(o)}`)
      expect((o.error as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit')
      expect(((o.error as Error).cause as ExprParseError).code).toBe('method-unknown')
    })
    it('W:108: a box whose tree is unsized v0 with Int.toBytes: the JVM rejects the box (box mode, rule 1016)', () => {
      const r = new ByteReader(fromHex('0100d193db04060402db04060402000000000000000000000000000000000000000000000000000000000000000000000000'))
      let err: unknown
      try {
        parseSValue({ tag: 'SBox' }, 3, r)
      } catch (x) {
        err = x
      }
      expect(err).toBeInstanceOf(ErgoTreeParseError)
      expect((err as ErgoTreeParseError).code).toBe('soft-fork-without-size-bit')
      expect(((err as Error).cause as ExprParseError).code).toBe('method-unknown')
    })
  })
})

describe('the order: each failure at the JVM byte', () => {
  it('W:133: a v0 MethodCall without arguments (4:6) has no arity assert below v3, so the lookup fails: rule 1016', () =>
    expectUnparsed('080ed193dc0406040200dc0406040200', 1016))
  it('W:134: a v3 MethodCall without arguments: the assert comes before the lookup, an AssertionError (the JVM rejects)', () =>
    expectRejectedHard('0b0ed193dc040e040200dc040e040200', 'method-call-empty-args'))
  it("the object's own lookup comes before the call's: v0 Int.toBytes on PropertyCall(9, 1): the JVM degrades on rule 1010", () =>
    expectUnparsed('0812d193db0406db09010402db0406db09010402', 1010))
  it('the same, unsized: the JVM rejects on rule 1010', () => expectRejectedUnsized('00d193db0406db09010402db0406db09010402', 1010))
  it("an argument's own lookup comes before the call's: v0 Int.bitwiseOr with argument PropertyCall(9, 1): the JVM degrades on rule 1010", () =>
    expectUnparsed('0818d193dc0409040201db09010402dc0409040201db09010402', 1010))
  it("the object's lookup comes before the arguments and the call's: v0 MethodCall(9, 1) on Int.toBytes: the JVM degrades on rule 1016", () =>
    expectUnparsed('0818d193dc0901db04060402010402dc0901db04060402010402', 1016))
  // Type code 0x0a (a primitive id no version knows) would fail rule 1017 at the type-argument read; the
  // lookup comes first (PropertyCallSerializer.scala:34-40, MethodCallSerializer.scala:56-63).
  it('W:94: v0 Global.none[0a] (106:10, a v3 method): the lookup fails before the type argument is read: rule 1016', () =>
    expectUnparsed('0807d1e6db6a0add0a', 1016))
  it('W:137: v0 Global.some[0a](1) (106:9, a v3 method): the lookup fails before the type argument is read: rule 1016', () =>
    expectUnparsed('080ad1e6dc6a09dd0104020a', 1016))
})

describe('the spends', () => {
  const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }
  const inVar1 = (script: string): EvalOpts => ({
    extension: {
      values: new Map([[1, {
        tpe: T.Coll(T.Byte),
        value: { kind: 'Coll', elem: T.Byte, items: Array.from(fromHex(script), (x) => ({ kind: 'Byte', value: (x << 24) >> 24 })) } as SValue,
      }]]),
    },
  })
  function spend(treeHex: string, opts: EvalOpts = {}): SValue {
    return evaluate(parseTree(fromHex(treeHex), { checkType: true }), opts)
  }
  /** The decode of variable 1's script fails its lookup, which is no class cast: the spend rejects. */
  function expectDecodeReject(treeHex: string, script: string): void {
    const err = captureEvalError(() => spend(treeHex, inVar1(script)))
    expect(err.code).toBe('deserialize-parse-failed')
    expect((err.cause as ExprParseError).code).toBe('method-unknown')
  }

  it('W:116: v0 sigmaProp(DeserializeContext(Boolean, 1)), the script If(true, true, 1.toBytes == 1.toBytes): the JVM rejects (rule 1016 at the decode)', () =>
    expectDecodeReject('00d1d40101', '950101010193db04060402db04060402'))
  it('W:117: the v3 twin with Int method 14: the JVM rejects (rule 1016 at the decode)', () =>
    expectDecodeReject('0b04d1d40101', '950101010193db040e0402db040e0402'))
  it('W:120, the control: the v0 tree with the script If(true, true, true): the JVM reduces to TrueProp', () =>
    expect(spend('00d1d40101', inVar1('95010101010101'))).toEqual(TRUE_PROP))
  it('W:121: a sized v0 tree whose dead branch holds 1.toBytes: the tree degrades, and the JVM rejects the spend', () => {
    const t = parseTree(fromHex('0811d1950101010193db04060402db04060402'), { checkType: true })
    expect(isUnparsedTree(t)).toBe(true)
    expect(captureEvalError(() => evaluate(t)).code).toBe('unparsed-ergotree')
  })
  it('W:122: the v3 twin with Int method 14: the tree degrades, and the JVM rejects the spend', () => {
    const t = parseTree(fromHex('0b11d1950101010193db040e0402db040e0402'), { checkType: true })
    expect(isUnparsedTree(t)).toBe(true)
    expect(captureEvalError(() => evaluate(t)).code).toBe('unparsed-ergotree')
  })
})

describe('the ids: a degraded tree keeps its bytes', () => {
  // R:1: a box whose sized v0 tree is sigmaProp(1.toBytes == 1.toBytes && <Boolean 0x02>). The JVM degrades
  // the tree on rule 1016 before it reads the non-canonical Boolean byte, and writes the box back
  // byte for byte (box mode: accepted, tree unparsed on rule 1016, roundtrip identity). A parsed tree would
  // be re-encoded with the Boolean as 01, and the box and transaction ids would follow.
  const BOX = '01080fd1ed93db04060402db040604020102000000000000000000000000000000000000000000000000000000000000000000000000'
  it('R:1: the box re-serializes to its own bytes, its tree unparsed on rule 1016', () => {
    const box = parseSValue({ tag: 'SBox' }, 3, new ByteReader(fromHex(BOX)))
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, box, 3, w)
    expect(toHex(w.toBytes())).toBe(BOX)
    const tree = boxTreeOf((box as { value: { ergoTreeBytes: Uint8Array } }).value.ergoTreeBytes)
    if (!isUnparsedTree(tree)) throw new Error('expected an unparsed tree')
    expect((tree.error as ExprParseError).code).toBe('method-unknown')
  })
})
