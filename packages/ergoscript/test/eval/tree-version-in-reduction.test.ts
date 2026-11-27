// A tree above the activated script version, inside a reduction. The JVM reduces a tree under
// VersionContext.withVersions(activated, the tree's version) (sigma-state 6.0.7 Interpreter.scala:207), whose
// constructor requires treeVersion <= activated from activated version 2 (sigma/VersionContext.scala:20). Bytes
// parsed while that context is in force reach ErgoTreeSerializer.deserializeErgoTree for a Box constant's tree,
// which makes the same comparison (ErgoTreeSerializer.scala:150-154, :191-193): the script a Deserialize node
// decodes, the argument of Global.deserializeTo[Box], and every constant of a SubstConstants template.
//
// Each test with a verdict and a cost pins a local sigma-state 6.0.6 probe output (the cited code is the same at
// 6.0.7): the tree read as a box's tree outside any version context, then either Interpreter.fullReduction
// (where the test name says so) or Interpreter.verify with an empty proof, under the activated version given.
// Costs are block-cost units. Tests without a probe verdict pin ergots' own surface: a `treeVersion` the caller
// set, and a context that knows no activated version. The SANTA block below pins the JVM's verdicts on the ten
// entries of `transaction/v6/authored/tree-version-above-activated-eval.json` at SANTA `8885632`.
import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith, reduceWith } from '../../src/eval/evaluate'
import { EvalError, makeContext } from '../../src/eval/eval-context'
import { isUnparsedTree } from '../../src/mir/types'
import type { SValue } from '../../src/mir/types'
import { ErgoTreeParseError, parseTree } from '../../src/wire/ergo-tree'
import { hexToBytes } from '../_helpers'
import { spendContext } from './_substitution-spends'

const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }

/** A box of value 1000000000 whose tree is a sized `SigmaProp(true)` of the version given. */
const box = (treeVersion: number) =>
  `8094ebdc030${(8 + treeVersion).toString(16)}0208d3010000355c6041d6c39f3fdcf9c7b76d16aa0ac2588677ead70aa29692362f66eed26800`
/** The bytes of `sigmaProp(ExtractAmount(B) > 0L)`, B a Box constant, as a `Coll[Byte]` constant: 51 bytes. */
const script = (treeVersion: number) => `0e33d191c163${box(treeVersion)}0500`
/** The bytes of the Boolean `ExtractAmount(B) > 0L`, as a `Coll[Byte]` constant: 50 bytes. */
const boolScript = (treeVersion: number) => `0e3291c163${box(treeVersion)}0500`
/** A Box as `Global.deserializeTo[Box]` takes it, as a `Coll[Byte]` constant: 45 bytes. */
const boxBytes = (treeVersion: number) => `0e2d${box(treeVersion)}`

/** A sized `SigmaProp(true)` of the version given; version 0 is the unsized `0008d3`. */
const trueTree = (treeVersion: number) => (treeVersion === 0 ? '0008d3' : `0${(8 + treeVersion).toString(16)}0208d3`)
/** v0 `DeserializeContext(SigmaProp, 1)` as the root. */
const DC_ROOT = '00d40801'
/** v0 `DeserializeRegister(R4, SigmaProp)` as the root. */
const DR_ROOT = '00d5040800'
/** v0 `sigmaProp(If(false, DeserializeContext(Boolean, 1), true))`: the node sits in a dead branch. */
const DC_DEAD = '00d1950100d401010101'
/** v0 `sigmaProp(ExtractAmount(B) > 0L)` with B in the tree's own body. */
const bodyBox = (treeVersion: number) => `00d191c163${box(treeVersion)}0500`
/** v3 `sigmaProp(ExtractAmount(Global.deserializeTo[Box](getVar[Coll[Byte]](1).get)) > 0L)`. */
const DESERIALIZE_TO = '1b12010500d191c1dc6a04dd01e4e3010e637300'

interface SpendArgs { tree: string; r4?: string; var1?: string }

/** The spend's context at the activated version given: the JVM's context field, apart from the pre-header. */
function spent(spend: SpendArgs, activated: number, limit?: number) {
  const s = spendContext(spend, 3, limit)
  s.ctx.activatedScriptVersion = activated
  return s
}

function blockCost(spend: SpendArgs, activated: number): number {
  const { tree, ctx } = spent(spend, activated)
  expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  return Math.floor(ctx.jitCost / 10)
}

function thrown(fn: () => unknown): EvalError {
  let err: unknown
  try { fn() } catch (e) { err = e }
  expect(err).toBeInstanceOf(EvalError)
  return err as EvalError
}

const aboveMessage = (treeVersion: number, activated: number) =>
  `tree version ${treeVersion} is above the activated script version ${activated}`

/** The entry's own rejection: the spent tree, or the version the evaluation runs under, is above the activated one. */
function expectEntryReject(fn: () => unknown, treeVersion: number, activated: number): void {
  const err = thrown(fn)
  expect(err.code).toBe('tree-version-above-activated')
  expect(err.message).toBe(aboveMessage(treeVersion, activated))
}

/** A reduction-time parse's rejection: the site's own code, with the tree's error as its cause. */
function expectParseReject(fn: () => unknown, code: string, treeVersion: number, activated: number): void {
  const err = thrown(fn)
  expect(err.code).toBe(code)
  expect(err.cause).toBeInstanceOf(ErgoTreeParseError)
  expect((err.cause as ErgoTreeParseError).code).toBe('tree-version-above-activated')
  expect((err.cause as Error).message).toBe(aboveMessage(treeVersion, activated))
}

describe('the entries: a tree above the activated version, from activated version 2', () => {
  it.each([
    ['a v4 tree at activated 3', 4, 3],
    ['a v3 tree at activated 2', 3, 2],
    ['a v7 tree at activated 6', 7, 6],
  ])('%s: evaluate, evaluateWith and reduceWith each reject', (_name, treeVersion, activated) => {
    const tree = () => parseTree(hexToBytes(trueTree(treeVersion)), { checkType: true })
    expectEntryReject(() => evaluate(tree(), { activatedScriptVersion: activated }), treeVersion, activated)
    expectEntryReject(() => { const s = spent({ tree: trueTree(treeVersion) }, activated); evaluateWith(s.tree, s.ctx) }, treeVersion, activated)
    expectEntryReject(() => { const s = spent({ tree: trueTree(treeVersion) }, activated); reduceWith(s.tree, s.ctx) }, treeVersion, activated)
  })

  it.each([
    ['a v2 tree at activated 1: nothing is required below activated 2', 2, 1],
    ['a v4 tree at activated 4', 4, 4],
    ['a v0 tree at activated -1', 0, -1],
    ['a v7 tree at activated 0', 7, 0],
    ['a v7 tree at activated -128', 7, -128],
    ['a v3 tree at activated 3', 3, 3],
    ['a v7 tree at activated 127', 7, 127],
    ['a v7 tree at activated 7', 7, 7],
    ['a v1 tree at activated 2', 1, 2],
  ])('%s: reduced, cost 5', (_name, treeVersion, activated) => {
    expect(blockCost({ tree: trueTree(treeVersion) }, activated)).toBe(5)
    const s = spent({ tree: trueTree(treeVersion) }, activated)
    expect(evaluateWith(s.tree, s.ctx)).toEqual(TRUE_PROP)
    expect(evaluate(s.tree, { activatedScriptVersion: activated })).toEqual(TRUE_PROP)
  })

  it('the activated version a pre-header gives decides it too: block version 4 is activated version 3', () => {
    const s = spendContext({ tree: trueTree(4) }, 3)   // the pre-header's version is 4, and the context has no field
    expect(s.ctx.activatedScriptVersion).toBeUndefined()
    expectEntryReject(() => evaluateWith(s.tree, s.ctx), 4, 3)
    expectEntryReject(() => reduceWith(s.tree, s.ctx), 4, 3)
    expectEntryReject(() => evaluate(s.tree, { preHeader: s.ctx.preHeader }), 4, 3)
  })

  it('a treeVersion the caller set is the version the evaluation runs under: above the activated version it rejects', () => {
    const tree = parseTree(hexToBytes(trueTree(0)), { checkType: true })
    expectEntryReject(() => evaluate(tree, { treeVersion: 4, activatedScriptVersion: 3 }), 4, 3)
    const s = spent({ tree: trueTree(0) }, 2)
    s.ctx.treeVersion = 3
    expectEntryReject(() => evaluateWith(s.tree, s.ctx), 3, 2)
    const below = spent({ tree: trueTree(0) }, 1)
    below.ctx.treeVersion = 3
    expect(evaluateWith(below.tree, below.ctx)).toEqual(TRUE_PROP)   // nothing is required below activated 2
    const within = spent({ tree: trueTree(0) }, 3)
    within.ctx.treeVersion = 3
    expect(evaluateWith(within.tree, within.ctx)).toEqual(TRUE_PROP)
  })

  it("a parsed tree's own version rejects at activated 3 whatever treeVersion the caller set", () => {
    // The JVM's fullReduction enters withVersions(context.activatedScriptVersion, ergoTree.version)
    // (Interpreter.scala:207), and withVersions' constructor throws (VersionContext.scala:20) when
    // ergoTree.version > activatedScriptVersion from activated 2. A caller's treeVersion does not
    // change that: the tree's own header version decides the check too. ergots makes both checks:
    // the tree's header version against the activated version, and the caller's treeVersion when
    // set, both from activated 2.
    const v4 = () => parseTree(hexToBytes(trueTree(4)), { checkType: true })
    // caller set to 3 (equal to activated): the v4 tree's own version still fails.
    expectEntryReject(() => evaluate(v4(), { treeVersion: 3, activatedScriptVersion: 3 }), 4, 3)
    // caller set to 0 (below activated): the v4 tree's own version still fails.
    expectEntryReject(() => evaluate(v4(), { treeVersion: 0, activatedScriptVersion: 3 }), 4, 3)
    // The same through evaluateWith and reduceWith.
    const forEvalWith = () => { const s = spent({ tree: trueTree(4) }, 3); s.ctx.treeVersion = 3; return s }
    expectEntryReject(() => { const s = forEvalWith(); evaluateWith(s.tree, s.ctx) }, 4, 3)
    const forReduce = () => { const s = spent({ tree: trueTree(4) }, 3); s.ctx.treeVersion = 0; return s }
    expectEntryReject(() => { const s = forReduce(); reduceWith(s.tree, s.ctx) }, 4, 3)
  })

  it('a context that knows no activated version makes no check', () => {
    const tree = parseTree(hexToBytes(trueTree(4)), { checkType: true })
    expect(evaluate(tree)).toEqual(TRUE_PROP)
    if (isUnparsedTree(tree)) throw new Error('the tree degraded')
    expect(evaluateWith(tree, makeContext({ constants: tree.constants }))).toEqual(TRUE_PROP)
    expect(reduceWith(tree, makeContext({ constants: tree.constants }))).toEqual(TRUE_PROP)
  })

  it("an unparsed tree keeps its own rejection, whatever version its header's bits say", () => {
    // 1c 02 08 d3: sized and segregated, version bits 4; it declares 8 constants and the first type code is 211.
    const tree = parseTree(hexToBytes('1c0208d3'), { checkType: true })
    expect(isUnparsedTree(tree)).toBe(true)
    for (const activated of [3, 2, -1]) {
      expect(thrown(() => evaluate(tree, { activatedScriptVersion: activated })).code).toBe('unparsed-ergotree')
      const ctx = makeContext({ activatedScriptVersion: activated })
      expect(thrown(() => evaluateWith(tree, ctx)).code).toBe('unparsed-ergotree')
      expect(thrown(() => reduceWith(tree, ctx)).code).toBe('unparsed-ergotree')
    }
  })
})

describe("a Box constant in the spent tree's own body is parsed when the box is read, and not again", () => {
  it.each([
    ['the box tree v4', 4],
    ['the box tree v3', 3],
  ])('%s, activated 3: reduced, cost 5', (_name, boxTreeVersion) => {
    expect(blockCost({ tree: bodyBox(boxTreeVersion) }, 3)).toBe(5)
  })
})

describe('the script of a DeserializeContext node is decoded under the activated version', () => {
  it.each<[string, number, number, number]>([
    ['the box tree v3, activated 3', 3, 115, 3],
    ['the box tree v4, activated 1: nothing is compared below activated 2', 1, 107, 4],
    ['the box tree v4, activated 4', 4, 115, 4],
    ['the box tree v4, activated 127', 127, 115, 4],
    ['the box tree v2, activated 2', 2, 107, 2],
    ['the box tree v7, activated 7', 7, 115, 7],
    ['the box tree v4, activated 5', 5, 115, 4],
    ['the box tree v1, activated 1', 1, 107, 1],
    ['the box tree v1, activated 0', 0, 107, 1],
    ['the box tree v4, activated -1', -1, 107, 4],
    ['the box tree v4, activated -128', -128, 107, 4],
    ['the box tree v7, activated 1', 1, 107, 7],
  ])('%s: reduced, cost %i', (_name, activated, cost, boxTreeVersion) => {
    expect(blockCost({ tree: DC_ROOT, var1: script(boxTreeVersion) }, activated)).toBe(cost)
  })

  it.each<[string, number, number]>([
    ['the box tree v4, activated 3', 3, 4],
    ['the box tree v4, activated 2', 2, 4],
    ['the box tree v5, activated 4', 4, 5],
    ['the box tree v3, activated 2', 2, 3],
    ['the box tree v7, activated 6', 6, 7],
  ])('%s: rejected at the decode', (_name, activated, boxTreeVersion) => {
    const args = { tree: DC_ROOT, var1: script(boxTreeVersion) }
    expectParseReject(() => { const s = spent(args, activated); reduceWith(s.tree, s.ctx) }, 'deserialize-parse-failed', boxTreeVersion, activated)
    expectParseReject(() => { const s = spent(args, activated); evaluateWith(s.tree, s.ctx) }, 'deserialize-parse-failed', boxTreeVersion, activated)
  })

  // The decoded box's own tree is v3 and holds a Box constant: `1b 33 02 63 <box> 08d3 7301`, 54 bytes.
  const nested = (innermost: number) =>
    `0e64d191c1638094ebdc031b330263${box(innermost)}08d37301010000355c6041d6c39f3fdcf9c7b76d16aa0ac2588677ead70aa29692362f66eed268000500`

  it('a box two levels down has a v4 tree, activated 3: rejected at the decode', () => {
    expectParseReject(() => { const s = spent({ tree: DC_ROOT, var1: nested(4) }, 3); reduceWith(s.tree, s.ctx) }, 'deserialize-parse-failed', 4, 3)
  })

  it('the control, the innermost tree v3: reduced, cost 213', () => {
    expect(blockCost({ tree: DC_ROOT, var1: nested(3) }, 3)).toBe(213)
  })

  it('the box tree v3 at activated 3 under a cost limit of 11: the decode is charged, and the limit rejects', () => {
    const s = spent({ tree: DC_ROOT, var1: script(3) }, 3, 11)
    expect(thrown(() => reduceWith(s.tree, s.ctx)).code).toBe('cost-limit-exceeded')
  })

  it('a context that knows no activated version decodes outside any version context', () => {
    const s = spendContext({ tree: DC_ROOT, var1: script(4) }, 3)
    s.ctx.preHeader = undefined
    expect(evaluateWith(s.tree, s.ctx)).toEqual(TRUE_PROP)
  })
})

describe('the script of a DeserializeRegister node, and of a node in a dead branch', () => {
  it.each<[string, number, number, number]>([
    ['the box tree v3, activated 3', 3, 117, 3],
    ['the box tree v4, activated 1: nothing is compared below activated 2', 1, 107, 4],
    ['the box tree v4, activated 4', 4, 117, 4],
    ['the box tree v4, activated -1', -1, 107, 4],
  ])('%s: reduced, cost %i', (_name, activated, cost, boxTreeVersion) => {
    expect(blockCost({ tree: DR_ROOT, r4: script(boxTreeVersion) }, activated)).toBe(cost)
  })

  it.each<[string, number, number]>([
    ['the box tree v4, activated 3', 3, 4],
    ['the box tree v4, activated 2', 2, 4],
  ])('%s: rejected at the decode', (_name, activated, boxTreeVersion) => {
    const args = { tree: DR_ROOT, r4: script(boxTreeVersion) }
    expectParseReject(() => { const s = spent(args, activated); reduceWith(s.tree, s.ctx) }, 'deserialize-parse-failed', boxTreeVersion, activated)
    expectParseReject(() => { const s = spent(args, activated); evaluateWith(s.tree, s.ctx) }, 'deserialize-parse-failed', boxTreeVersion, activated)
  })

  it('a dead branch, the box tree v4, activated 3: rejected at the decode', () => {
    expectParseReject(() => { const s = spent({ tree: DC_DEAD, var1: boolScript(4) }, 3); reduceWith(s.tree, s.ctx) }, 'deserialize-parse-failed', 4, 3)
  })

  it.each<[string, number, number, number]>([
    ['a dead branch, the box tree v3, activated 3', 3, 123, 3],
    ['a dead branch, the box tree v4, activated 1', 1, 103, 4],
  ])('%s: reduced, cost %i', (_name, activated, cost, boxTreeVersion) => {
    expect(blockCost({ tree: DC_DEAD, var1: boolScript(boxTreeVersion) }, activated)).toBe(cost)
  })
})

describe('Global.deserializeTo[Box] parses under the activated version', () => {
  it.each<[string, number, number]>([
    ['the box tree v4, activated 4', 4, 4],
    ['the box tree v4, activated 127', 127, 4],
    ['the box tree v3, activated 3', 3, 3],
    ['the box tree v4, activated 1: nothing is compared below activated 2 (fullReduction)', 1, 4],
    ['the box tree v4, activated 0 (fullReduction)', 0, 4],
  ])('%s: reduced, cost 24', (_name, activated, boxTreeVersion) => {
    expect(blockCost({ tree: DESERIALIZE_TO, var1: boxBytes(boxTreeVersion) }, activated)).toBe(24)
  })

  it.each<[string, number, number]>([
    ['the box tree v5, activated 4', 4, 5],
    ['the box tree v4, activated 3', 3, 4],
  ])('%s: rejected at the parse', (_name, activated, boxTreeVersion) => {
    const args = { tree: DESERIALIZE_TO, var1: boxBytes(boxTreeVersion) }
    expectParseReject(() => { const s = spent(args, activated); reduceWith(s.tree, s.ctx) }, 'global-deserialize-failed', boxTreeVersion, activated)
    expectParseReject(() => { const s = spent(args, activated); evaluateWith(s.tree, s.ctx) }, 'global-deserialize-failed', boxTreeVersion, activated)
  })

  it('the v3 tree itself at activated 2 (fullReduction): the entry rejects', () => {
    expectEntryReject(() => { const s = spent({ tree: DESERIALIZE_TO, var1: boxBytes(4) }, 2); reduceWith(s.tree, s.ctx) }, 3, 2)
  })

  it('a context that knows no activated version parses outside any version context', () => {
    const s = spendContext({ tree: DESERIALIZE_TO, var1: boxBytes(4) }, 3)
    s.ctx.preHeader = undefined
    expect(evaluateWith(s.tree, s.ctx)).toEqual(TRUE_PROP)
  })
})

// SubstConstants over a template whose first constant is a Box with a tree of the given version. The template's
// bytes (as a `Coll[Byte]` context variable): a segregated header, one constant (a v3 Box so the template itself
// parses at every tree version), and the body `d191c173007301` (SigmaProp(ExtractAmount(constant 0) > 0)). The
// spent tree is a v0 segregated `sigmaProp(SubstConstants(getVar[Coll[Byte]](1).get, Coll[Int](), Coll[Int]()).size > 0)`.
const SC_ROOT = '10010400d191b174e4e3010e8300048300047300'
const scTemplate = (boxTreeVersion: number) =>
  `0e391002638094ebdc030${(8 + boxTreeVersion).toString(16)}0208d3010000355c6041d6c39f3fdcf9c7b76d16aa0ac2588677ead70aa29692362f66eed268000500d191c173007301`

describe("a SubstConstants template's Box constant is parsed under the activated version", () => {
  it.each<[string, number, number]>([
    ['the box tree v4, activated 4', 4, 4],
    ['the box tree v4, activated 127', 127, 4],
    ['the box tree v7, activated 127', 127, 7],
  ])('%s: reduced', (_name, activated, boxTreeVersion) => {
    const { tree, ctx } = spent({ tree: SC_ROOT, var1: scTemplate(boxTreeVersion) }, activated)
    expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  })

  it.each<[string, number, number]>([
    ['the box tree v4, activated 2', 2, 4],
    ['the box tree v5, activated 4', 4, 5],
    ['the box tree v4, activated 1: nothing is compared below activated 2', 1, 4],
    ['the box tree v4, activated 0', 0, 4],
  ])('%s', (name, activated, boxTreeVersion) => {
    const args = { tree: SC_ROOT, var1: scTemplate(boxTreeVersion) }
    if (activated >= 2 && boxTreeVersion > activated) {
      expectParseReject(() => { const s = spent(args, activated); reduceWith(s.tree, s.ctx) }, 'subst-constants-error', boxTreeVersion, activated)
    } else {
      const { tree, ctx } = spent(args, activated)
      expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
    }
    expect(name).toBeDefined()
  })
})

// SANTA entries: `transaction/v6/authored/tree-version-above-activated-eval.json` at SANTA `8885632`. Each entry
// below is pinned at activated 3, tree version 0, by the entry's `version.activated` and the spent tree's header
// version (v0). The `#N` suffix names the JSON entry.
describe('SANTA transaction/v6/authored/tree-version-above-activated-eval at 8885632', () => {
  // #0 and #1: a DeserializeContext root decoding a `sigmaProp(ExtractAmount(B) > 0L)` where B is a Box constant.
  it("context-deserialize-box-v4-reject#0 refused: the decoded script's Box constant is v4", () => {
    expectParseReject(() => { const s = spent({ tree: DC_ROOT, var1: script(4) }, 3); reduceWith(s.tree, s.ctx) }, 'deserialize-parse-failed', 4, 3)
  })
  it('context-deserialize-box-v3-accept#1 reduced: the box tree v3 decodes under activated 3', () => {
    const { tree, ctx } = spent({ tree: DC_ROOT, var1: script(3) }, 3)
    expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  })
  // #2 and #3: a DeserializeRegister root, R4 holds the same scripts.
  it('register-deserialize-box-v4-reject#2 refused: R4 decodes to a script whose Box constant is v4', () => {
    expectParseReject(() => { const s = spent({ tree: DR_ROOT, r4: script(4) }, 3); reduceWith(s.tree, s.ctx) }, 'deserialize-parse-failed', 4, 3)
  })
  it('register-deserialize-box-v3-accept#3 reduced: R4 decodes to a script whose Box constant is v3', () => {
    const { tree, ctx } = spent({ tree: DR_ROOT, r4: script(3) }, 3)
    expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  })
  // #4 and #5: a DeserializeContext in a dead branch; the decode runs at substitution.
  it('dead-context-deserialize-box-v4-reject#4 refused: the dead-branch decode still parses the v4 Box', () => {
    expectParseReject(() => { const s = spent({ tree: DC_DEAD, var1: boolScript(4) }, 3); reduceWith(s.tree, s.ctx) }, 'deserialize-parse-failed', 4, 3)
  })
  it('dead-context-deserialize-box-v3-accept#5 reduced: the dead-branch decode parses a v3 Box', () => {
    const { tree, ctx } = spent({ tree: DC_DEAD, var1: boolScript(3) }, 3)
    expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  })
  // #6, #7, #8: SubstConstants over a template whose first constant is a Box with a tree of the given version.
  it('substconstants-box-v4-reject#6 refused with subst-constants-error: the template holds a v4 Box constant', () => {
    expectParseReject(() => { const s = spent({ tree: SC_ROOT, var1: scTemplate(4) }, 3); reduceWith(s.tree, s.ctx) }, 'subst-constants-error', 4, 3)
  })
  it('substconstants-box-v3-accept#7 reduced: the template holds a v3 Box constant', () => {
    const { tree, ctx } = spent({ tree: SC_ROOT, var1: scTemplate(3) }, 3)
    expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  })
  it("substconstants-v4-header-template-accept#8 reduced: the template's own v4 header is read by deserializeHeaderAndSize, not deserializeErgoTree", () => {
    // A segregated sized template, v4 header, one constant `SigmaProp(TrueLeaf)` and the body `ConstantPlaceholder(0)`:
    // `1c 05 01 08 d3 73 00`, 7 bytes.
    const v4HeaderTemplate = '0e071c050108d37300'
    const { tree, ctx } = spent({ tree: SC_ROOT, var1: v4HeaderTemplate }, 3)
    expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  })
  // #9 and #10: Global.deserializeTo[Box] of a Box with the given tree version.
  it('deserializeto-box-v4-reject#9 refused with global-deserialize-failed: the box tree is v4 at activated 3', () => {
    expectParseReject(() => { const s = spent({ tree: DESERIALIZE_TO, var1: boxBytes(4) }, 3); reduceWith(s.tree, s.ctx) }, 'global-deserialize-failed', 4, 3)
  })
  it('deserializeto-box-v3-accept#10 reduced: the box tree is v3 at activated 3', () => {
    const { tree, ctx } = spent({ tree: DESERIALIZE_TO, var1: boxBytes(3) }, 3)
    expect(reduceWith(tree, ctx)).toEqual(TRUE_PROP)
  })
})
