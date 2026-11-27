/**
 * SubstConstants lifts every item of `newValues` to a constant by its runtime class before it reads the
 * template, and compares and writes a named template constant by its item's lifted type.
 *
 * JVM (sigma-state 6.0.7): `SubstConstants.eval` (data/shared/src/main/scala/sigma/ast/trees.scala:628-651),
 * `toArrayOfConstants` (data/shared/src/main/scala/sigma/eval/Extensions.scala:53-64), `Platform.liftToConstant`
 * (data/jvm/src/main/scala/sigma/Platform.scala:16-63), `ErgoTreeSerializer.substituteConstants`
 * (data/shared/src/main/scala/sigma/serialization/ErgoTreeSerializer.scala:320-379).
 *
 * The rows are JVM-blessed: SANTA `vectors/eval/v6/authored/SubstConstants.lift_by_class_v6.json` at commit
 * 0f2fc79, each named by its row. A row's tree reads nothing of the context.
 */
import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith, reduceWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { byteColl, fromArray } from '../../src/coll/build'
import { serializeSigmaBoolean } from '../../src/wire/sigma-boolean'
import { ByteWriter } from '@ergots/scorex'
import type { Expr, SubstConstants as SubstConstantsExpr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, synthesizeStubBox } from '../_helpers'
import { spendContext } from './_substitution-spends'

const toHex = (v: SValue): string => {
  if (v.kind !== 'Coll') throw new Error(`expected a Coll[Byte], got ${v.kind}`)
  return v.items
    .map((b) => {
      if (b.kind !== 'Byte') throw new Error(`expected a Byte item, got ${b.kind}`)
      return (b.value & 0xff).toString(16).padStart(2, '0')
    })
    .join('')
}

/** Evaluates a row's tree under its tree version, with a context that holds no pre-header. */
function run(treeHex: string, treeVersion: number): { value: SValue; cost: number } {
  const tree = parseTree(hexToBytes(treeHex))
  if (!('constants' in tree)) throw new Error('the row has a parsed tree')
  const ctx = makeContext({ treeVersion, constants: tree.constants })
  const value = evaluateWith(tree, ctx)
  return { value, cost: ctx.jitCost }
}

// One-constant template (an AvlTree constant), read by the `pos7` and `other` rows.
const T = '00740e2910016415cc1ba1054bf74431a2ccfc57e6051b9d0e7561f70586e5512c0ae3f3bac4fd020701007300'
const T3 = '0b{size}740e2910016415cc1ba1054bf74431a2ccfc57e6051b9d0e7561f70586e5512c0ae3f3bac4fd020701007300'
const TEMPLATE_BYTES = '10016415cc1ba1054bf74431a2ccfc57e6051b9d0e7561f70586e5512c0ae3f3bac4fd020701007300'

/** [row, tree version, tree bytes] */
const REFUSED_BY_THE_LIFT: [string, number, string][] = [
  ['item-unit-pos7-v0-a3#94', 0, T + '10010e83016262'],
  ['item-pair-pos7-v0-a3#112', 0, T + '10010e830158580204'],
  ['item-context-pos7-v0-a3#169', 0, T + '10010e830165fe'],
  ['item-global-pos7-v0-a3#178', 0, T + '10010e83016add'],
  ['item-lambda-pos7-v0-a3#214', 0, T + '10010ead100102d9010104d90102047202'],
  ['tuple-const-pair-nocon-v0-a3#288', 0, '00740e041000730010030002044804580402020404'],
  ['tuple-const-unit-nocon-v0-a3#284', 0, '00740e04100073001003000204480462040204'],
  ['tuple-const-option-const-nocon-v3-a3#1237', 3, '0b14740e041000730010030002044804280402010204'],
  ['tuple-const-string-nocon-v3-a3#1225', 3, '0b14740e041000730010030002044804660402014104'],
  ['new-values-coll-string-const-pos7-v3-a3#1244', 3, T3.replace('{size}', '34') + '10010e0c66010141'],
  ['string-tuple-const-none-written-v3-a3#1272', 3, '0b1c740e0c1b0a0304026601410404730010030e0e0e480466040a01430c'],
  ['string-tuple-const-written-012-v3-a3#1270', 3, '0b1c740e0c1b0a030402660141040473001003000204480466040a01430c'],
]

/** [row, tree version, tree bytes, the bytes answered, the cost] */
const ANSWERED: [string, number, string, string, number][] = [
  ['string-tuple-const-written-012-v0-a3#1252', 0, '00740e0b10030402660141040473001003000204480466040a01430c', '1003040a660143040c7300', 415],
  ['string-tuple-const-none-written-v0-a3#1254', 0, '00740e0b100304026601410404730010030e0e0e480466040a01430c', '1003040266014104047300', 415],
  ['item-int-pos7-v0-a3#27', 0, T + '10010e8301040402', TEMPLATE_BYTES, 235],
  ['tuple-const-string-nocon-v0-a3#286', 0, '00740e041000730010030002044804660402014104', '10007300', 115],
  ['tuple-const-tuple3-nocon-v0-a3#290', 0, '00740e04100073001003000204480448040404040202040604', '10007300', 115],
  ['new-values-coll-string-const-pos7-v0-a3#305', 0, T + '10010e0c66010141', TEMPLATE_BYTES, 215],
  ['item-ubi-own-v3-a3#1101', 3, '0b14740e081b06010901077300100100830109090107', '1b06010901077300', 235],
]

describe('SubstConstants: an item of newValues with no lift refuses the call (Platform.scala:62, Extensions.scala:60)', () => {
  for (const [row, treeVersion, tree] of REFUSED_BY_THE_LIFT) {
    it(row, () => {
      const err = captureEvalError(() => run(tree, treeVersion))
      expect(err.code).toBe('subst-constants-error')
      expect(err.message).toMatch(/has no lift to a constant/)
    })
  }
})

describe('SubstConstants: every item lifts and the call answers', () => {
  for (const [row, treeVersion, tree, bytes, cost] of ANSWERED) {
    it(row, () => {
      const { value, cost: actualCost } = run(tree, treeVersion)
      expect(toHex(value)).toBe(bytes)
      expect(actualCost).toBe(cost)
    })
  }
})

describe('SubstConstants: a lifted item of another type than the constant it names (ErgoTreeSerializer.scala:356)', () => {
  it('item-int-other-v0-a3#29', () => {
    const tree =
      '00740e2910016415cc1ba1054bf74431a2ccfc57e6051b9d0e7561f70586e5512c0ae3f3bac4fd0207010073001001008301040402'
    const err = captureEvalError(() => run(tree, 0))
    expect(err.code).toBe('subst-constants-error')
    expect(err.message).toMatch(/type mismatch/)
  })
})

describe('SubstConstants: the lift comes first (trees.scala:634-644)', () => {
  const constant = (tpe: SType, value: SValue): Expr => ({ tag: 'Const', tpe, value })
  const bytes = (hex: string): Expr =>
    constant({ tag: 'SColl', elem: { tag: 'SByte' } }, byteColl(hexToBytes(hex), true))
  const ints = (ns: number[]): Expr =>
    constant(
      { tag: 'SColl', elem: { tag: 'SInt' } },
      fromArray({ tag: 'SInt' }, ns.map((value): SValue => ({ kind: 'Int', value })), true),
    )
  const units = (n: number): Expr =>
    constant(
      { tag: 'SColl', elem: { tag: 'SUnit' } },
      fromArray({ tag: 'SUnit' }, Array.from({ length: n }, (): SValue => ({ kind: 'Unit' })), false),
    )
  const subst = (scriptBytes: Expr, positions: Expr, newValues: Expr): SubstConstantsExpr => ({
    tag: 'SubstConstants',
    scriptBytes,
    positions,
    newValues,
  })
  // One Int constant, 1; body 73 00.
  const ONE = '100104027300'

  it('before the lengths of positions and newValues are compared', () => {
    const err = captureEvalError(() => evalExpr(subst(bytes(ONE), ints([0, 0]), units(1)), Env.empty(), makeContext()))
    expect(err.code).toBe('subst-constants-error')
    expect(err.message).toMatch(/has no lift to a constant/)
  })

  it('before the template is read', () => {
    const err = captureEvalError(() => evalExpr(subst(bytes('ff'), ints([0]), units(1)), Env.empty(), makeContext()))
    expect(err.code).toBe('subst-constants-error')
    expect(err.message).toMatch(/has no lift to a constant/)
  })

  it('newValues without an item: the template comes back', () => {
    const value = evalExpr(subst(bytes(ONE), ints([]), ints([])), Env.empty(), makeContext())
    expect(toHex(value)).toBe(ONE)
  })

  it('a refused call adds nothing to the cost of its three operands (CErgoTreeEvaluator.scala:399-415)', () => {
    const scriptBytes = bytes(ONE)
    const positions = ints([0, 0])
    const newValues = units(1)
    const operands = makeContext()
    evalExpr(scriptBytes, Env.empty(), operands)
    evalExpr(positions, Env.empty(), operands)
    evalExpr(newValues, Env.empty(), operands)

    const ctx = makeContext()
    captureEvalError(() => evalExpr(subst(scriptBytes, positions, newValues), Env.empty(), ctx))
    expect(ctx.jitCost).toBe(operands.jitCost)
  })

  it('a call refused after the lift adds nothing to the cost of its three operands', () => {
    const scriptBytes = bytes(ONE)
    const positions = ints([0, 0])
    const newValues = ints([5])
    const operands = makeContext()
    evalExpr(scriptBytes, Env.empty(), operands)
    evalExpr(positions, Env.empty(), operands)
    evalExpr(newValues, Env.empty(), operands)

    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(subst(scriptBytes, positions, newValues), Env.empty(), ctx))
    expect(err.message).toMatch(/length/)
    expect(ctx.jitCost).toBe(operands.jitCost)
  })
})

/**
 * A Box lifts at every activated version. The tree is `sigmaProp(substConstants(T, Coll(7), Coll(SELF)).size > 0)`,
 * version 0, the position naming nothing. Verdicts and costs are a local sigma-state 6.0.7 probe's (spend mode:
 * the tree put in SELF and reduced by `fullReduction`), TrueProp at block cost 29 at activated 2 and 3.
 */
describe('SubstConstants: a Box among newValues lifts at every activated version', () => {
  const SELF_AT_POS7 = `00d191b1740e29${TEMPLATE_BYTES}10010e830163a70400`
  const TRUE_PROP = 'd3'
  const sigmaHex = (value: SValue): string => {
    if (value.kind !== 'SigmaProp') throw new Error(`expected a SigmaProp, got ${value.kind}`)
    const w = new ByteWriter()
    serializeSigmaBoolean(value.value, w)
    return Array.from(w.toBytes(), (b) => b.toString(16).padStart(2, '0')).join('')
  }

  for (const activated of [0, 1, 2, 3]) {
    it(`activated ${activated}: lifted, TrueProp at block cost 29`, () => {
      const { tree, ctx } = spendContext({ tree: SELF_AT_POS7 }, activated)
      expect(sigmaHex(reduceWith(tree, ctx))).toBe(TRUE_PROP)
      expect(Math.floor(ctx.jitCost / 10)).toBe(29)
    })
  }

  it('a context with no pre-header and no activated version field: a Box is lifted', () => {
    const tree = parseTree(hexToBytes(SELF_AT_POS7))
    if (!('constants' in tree)) throw new Error('the tree is parsed')
    const selfBox = { ...synthesizeStubBox(), ergoTreeBytes: hexToBytes(SELF_AT_POS7) }
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants, selfBox, inputs: [selfBox] })
    expect(sigmaHex(evaluateWith(tree, ctx) as SValue)).toBe(TRUE_PROP)
  })
})
