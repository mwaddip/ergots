// reduceWith: the JVM's Interpreter.fullReduction (sigma-state 6.0.6, Interpreter.scala:203-229), the reduction a
// spend is charged for. For a tree with a Deserialize node the interpreter charges, in block-cost units:
//  - the tree's bytes x 2 (CostPerTreeByte, :88, :246-248): checked against the limit at every activation, and added
//    from activated version 3 only (:249-260);
//  - each decode's bytes x 2 once the decode completes (CostPerByteDeserialized, :81, :99-107), at every activation:
//    on the whole array, before the script's type check;
//  - the substituted body's evaluation, whatever the body is (:171-186): a SigmaProp constant costs a Constant's 5
//    JitCost, not the 50 of a tree that is one (:211-217).
// A block-cost unit is 10 JitCost (JitCost.scala:29-34), so each per-byte charge is 20 JitCost.
//
// Every expected cost and verdict below is a local sigma-state 6.0.6 probe's (spend mode: fullReduction, with
// initCost 0 unless the row gives one, and the limit as the context's costLimit), in block-cost units, and so is the
// proposition each spend reduces to. The row names are the probe's.
import { describe, it, expect } from 'vitest'
import { ByteWriter } from '@ergots/scorex'
import { evaluateWith, reduceWith } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'
import { parseTree } from '../../src/wire/ergo-tree'
import { SValueParseError } from '../../src/wire/parse-svalue'
import { serializeSigmaBoolean } from '../../src/wire/sigma-boolean'
import { hexToBytes } from '../_helpers'
import { SPENDS, spendContext, type Spend, type SpendName } from './_substitution-spends'

/** A reduced value's proposition, serialized: what the probe reports as `sigma_hex`. */
function sigmaHex(value: SValue): string {
  if (value.kind !== 'SigmaProp') throw new Error(`reduced to ${value.kind}, not to a SigmaProp`)
  const w = new ByteWriter()
  serializeSigmaBoolean(value.value, w)
  return Array.from(w.toBytes(), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The reduction's cost as the JVM reports it: JitCost / 10, truncated (JitCost.toBlockCost). Also checks that the
 * spend reduces to the probe's proposition. `init` is the cost at entry, in block-cost units.
 */
function blockCost(name: SpendName, activated: number, limit?: number, init?: number): number {
  const spend: Spend = SPENDS[name]
  const { tree, ctx } = spendContext(spend, activated, limit, init)
  expect(sigmaHex(reduceWith(tree, ctx))).toBe(spend.sigma)
  return Math.floor(ctx.jitCost / 10)
}

function rejection(name: SpendName, activated: number, limit?: number, init?: number): EvalError {
  const { tree, ctx } = spendContext(SPENDS[name], activated, limit, init)
  let err: unknown
  try { reduceWith(tree, ctx) } catch (e) { err = e }
  expect(err).toBeInstanceOf(EvalError)
  return err as EvalError
}

describe('reduceWith: the tree charge', () => {
  it.each<[string, SpendName, number, number]>([
    ['C1', 'C', 3, 35], // 32 for the 16-byte tree, 3 for the evaluation
    ['C2', 'C', 2, 3],
    ['R1b', 'C', 1, 3],
    ['R1a', 'C', 0, 3],
  ])('%s: a dead Deserialize node and no decode', (_row, name, activated, cost) => {
    expect(blockCost(name, activated)).toBe(cost)
  })

  it.each<[string, SpendName, number, number, number | null]>([
    ['E1', 'C', 3, 31, null], // the tree charge, 32, exceeds it
    ['E2', 'C', 3, 32, null], // the evaluation's first charge exceeds it
    ['E3', 'C', 3, 35, null], // JitCost 355 over 350
    ['E4', 'C', 3, 36, 35],
    ['E5', 'C', 2, 31, null], // the tree charge is checked, and never added
    ['E6', 'C', 2, 32, 3],
    ['E7', 'C', 2, 3, null],
    ['R1d', 'C', 1, 31, null],
    ['R1c', 'C', 0, 31, null],
  ])('%s: spend %s at activated %i, limit %i', (_row, name, activated, limit, cost) => {
    if (cost === null) expect(rejection(name, activated, limit).code).toBe('cost-limit-exceeded')
    else expect(blockCost(name, activated, limit)).toBe(cost)
  })

  it.each<[string, SpendName, number, number]>([
    ['J1', 'J1', 3, 24], // 9 bytes: the constant's over-long VLQ counts
    ['J2', 'J2', 3, 22], // 8 bytes
    ['J3', 'J3', 3, 26], // 10 bytes: the size's over-long VLQ counts
    ['J4', 'J4', 3, 24], // 9 bytes
    ['SEG1', 'SEG1', 3, 18], // 7 bytes: a segregated tree's constants count
    ['SEG2', 'SEG1', 2, 4],
    ['R8a', 'R8a', 3, 16], // a sized version-1 tree, 6 bytes
  ])('%s: the charge is over the bytes as received', (_row, name, activated, cost) => {
    expect(blockCost(name, activated)).toBe(cost)
  })

  it.each<[string, SpendName, number, number]>([
    ['N1', 'N1', 3, 24], // a version-3 tree
    ['N2', 'N2', 3, 24], // a version-2 tree
    ['N3', 'N2', 2, 6],
  ])("%s: the charge follows the activated version, whatever the tree's own", (_row, name, activated, cost) => {
    expect(blockCost(name, activated)).toBe(cost)
  })

  it('a context without a pre-header rejects a tree with a Deserialize node', () => {
    const { tree, ctx } = spendContext(SPENDS.C, 3)
    ctx.preHeader = undefined
    let err: unknown
    try { reduceWith(tree, ctx) } catch (e) { err = e }
    expect(err).toBeInstanceOf(EvalError)
    expect((err as EvalError).code).toBe('context-field-missing')
    expect((err as EvalError).message).toBe('reduceWith: ctx.preHeader is undefined')
  })
})

describe('reduceWith: the decode charge', () => {
  it.each<[string, SpendName, number, number]>([
    ['D1', 'D', 3, 103], // 66 + 34 + 3: the decode completes, and its type read is a class cast
    ['D2', 'D', 2, 37],
    ['K1', 'K1', 3, 35], // the register's decode is a class cast: no decode charge
    ['K2', 'K1', 2, 3],
    ['K3', 'K3', 3, 67], // 30 + 34 + 3
    ['K4', 'K3', 2, 37],
    ['K5', 'K5', 3, 33], // the variable's decode is a class cast
    ['K6', 'K5', 2, 3],
  ])('%s: a decode is charged once it completes, before its type read', (_row, name, activated, cost) => {
    expect(blockCost(name, activated)).toBe(cost)
  })

  it.each<[string, SpendName, number, number]>([
    ['H1', 'H1', 3, 30], // 20 + 4 + 4 + 2
    ['H2', 'H1', 2, 10],
    ['H3', 'H3', 3, 32], // 22 + 4 + 4 + 2: one register, decoded by two nodes
    ['H4', 'H3', 2, 10],
    ['I1', 'I', 3, 18],
    ['I2', 'I', 2, 6],
  ])('%s: each decode is charged', (_row, name, activated, cost) => {
    expect(blockCost(name, activated)).toBe(cost)
  })

  it.each<[string, SpendName, number, number, number | null]>([
    ['H5', 'H1', 3, 27, null], // the second decode's charge exceeds it: 20 + 4 + 4
    ['H6', 'H1', 3, 28, null], // the evaluation exceeds it
    ['H7', 'H1', 3, 31, 30],
    ['H8', 'H1', 2, 19, null], // the tree charge, 20, is checked
    ['H9', 'H1', 2, 20, 10],
  ])('%s: spend %s at activated %i, limit %i', (_row, name, activated, limit, cost) => {
    if (cost === null) expect(rejection(name, activated, limit).code).toBe('cost-limit-exceeded')
    else expect(blockCost(name, activated, limit)).toBe(cost)
  })

  it.each<[string, SpendName, number, number]>([
    ['L1', 'L1', 3, 28], // 18 + 4 + 4 + 2: the default's variable is decoded although the register is present
    ['L5', 'L1', 2, 10],
    ['L2', 'L2', 3, 24], // the register is absent: the default, with its decoded variable
    ['L3', 'L3', 3, 24], // the variable is absent: the register's decode alone
  ])("%s: a default's Deserialize node is substituted before its register is looked at", (_row, name, activated, cost) => {
    expect(blockCost(name, activated)).toBe(cost)
  })

  it("L4: a failing decode in a default rejects, although the register is present", () => {
    expect(rejection('L4', 3).code).toBe('deserialize-parse-failed')
  })

  it('R10a: a Deserialize node inside a decoded script stays, and rejects when it is evaluated', () => {
    expect(rejection('R10a', 3).code).toBe('deserialize-not-substituted')
  })
})

describe('reduceWith: the substituted body is evaluated as it is', () => {
  it.each<[string, SpendName, number, number]>([
    ['A1', 'A1', 3, 14], // 10 + 4 + 0: the constant costs 5 JitCost
    ['A2', 'A1', 2, 4],
    ['A3', 'A3', 3, 80], // 10 + 70 + 0
    ['A4', 'A3', 2, 70],
    ['B1', 'B', 3, 12], // 8 + 4 + 0
    ['B2', 'B', 2, 4],
    ['T1', 'T1', 3, 18], // 10 + 8 + 0: the decode charge is on the whole array, two bytes more than the script
    ['T2', 'T1', 2, 8],
  ])('%s: a decoded SigmaProp constant at the root', (_row, name, activated, cost) => {
    expect(blockCost(name, activated)).toBe(cost)
  })

  it.each<[string, SpendName, number, number, number | null]>([
    ['F1', 'A3', 2, 69, null], // the decode charge, 70, exceeds it
    ['F2', 'A3', 2, 70, null], // JitCost 705 over 700
    ['F3', 'A3', 2, 71, 70],
    ['F4', 'A3', 3, 79, null], // 10 + 70 exceeds it
    ['F5', 'A3', 3, 80, null],
    ['F6', 'A3', 3, 81, 80],
    ['T3', 'T1', 2, 7, null], // the tree charge, 10, is checked
    ['T4', 'T1', 2, 8, null],
  ])('%s: spend %s at activated %i, limit %i', (_row, name, activated, limit, cost) => {
    if (cost === null) expect(rejection(name, activated, limit).code).toBe('cost-limit-exceeded')
    else expect(blockCost(name, activated, limit)).toBe(cost)
  })
})

describe('reduceWith: a tree without a Deserialize node', () => {
  it.each<[string, SpendName]>([
    ['A5', 'A5'], // a SigmaProp-constant tree: the flat 50 JitCost
    ['A6', 'A6'], // P2PK
    ['Q1', 'SEG_TRUE'], // the same two with the constant segregated: the root is a placeholder
    ['Q3', 'SEG_P2PK'],
  ])('%s costs 5, at either activation, as evaluateWith does', (_row, name) => {
    expect(blockCost(name, 3)).toBe(5)
    expect(blockCost(name, 2)).toBe(5)
    const spend: Spend = SPENDS[name]
    const { tree, ctx } = spendContext(spend, 3)
    expect(sigmaHex(evaluateWith(tree, ctx))).toBe(spend.sigma)
    expect(ctx.jitCost).toBe(50)
  })

  it('needs no pre-header', () => {
    const { tree, ctx } = spendContext(SPENDS.A6, 3)
    ctx.preHeader = undefined
    expect(reduceWith(tree, ctx).kind).toBe('SigmaProp')
    expect(ctx.jitCost).toBe(50)
  })
})

describe('reduceWith: a cost at entry counts in every limit check', () => {
  // The probe with initCost 10: the JVM checks each charge as initCost + charge against the limit
  // (addCostChecked, eval/package.scala:38-52), and the reported cost holds the entry cost.
  it.each<[string, SpendName, number, number, number | null]>([
    ['P1', 'C', 2, 41, null], // before V6 the tree charge is checked on top of it: 10 + 32 exceeds 41
    ['P2', 'C', 2, 42, 13], // and is never added: 10 + 3
    ['P3', 'C', 3, 41, null], // 10 + 32 exceeds 41
    ['P4', 'C', 3, 45, null], // JitCost 455 over 450
    ['P5', 'C', 3, 46, 45], // 10 + 32 + 3
    ['P6', 'A3', 2, 79, null], // the decode charge: 10 + 70 exceeds 79
    ['P7', 'A3', 2, 80, null], // JitCost 805 over 800
    ['P8', 'A3', 2, 81, 80],
    ['Q5', 'SEG_P2PK', 3, 14, null], // the flat 5 of a tree that is a SigmaProp constant: 10 + 5 exceeds 14
    ['Q6', 'SEG_P2PK', 3, 15, 15],
  ])('%s: spend %s at activated %i, limit %i, entry cost 10', (_row, name, activated, limit, cost) => {
    if (cost === null) expect(rejection(name, activated, limit, 10).code).toBe('cost-limit-exceeded')
    else expect(blockCost(name, activated, limit, 10)).toBe(cost)
  })
})

describe('reduceWith: a context is not marked by the entry it went through', () => {
  it('evaluateWith after reduceWith, on one context, adds the evaluator\'s cost only', () => {
    const { tree, ctx } = spendContext(SPENDS.C, 3)
    reduceWith(tree, ctx)
    expect(ctx.jitCost).toBe(355)
    evaluateWith(tree, ctx)
    expect(ctx.jitCost).toBe(355 + 35)
  })
})

// Residual: the JVM also takes this path for a tree whose only Deserialize node sits in a register of a nested Box
// constant, since that node sets the reader's flag for the enclosing tree (ErgoTreeSerializer.scala:160-168). The
// probe parses G1 with hasDeserialize = true and spends it at 111 (activated 3) and 3 (activated 2). ergots rejects
// the tree at parse, in the register grammar, so reduceWith never sees it. The pin flips when that grammar closes:
// treeHasDeserialize must then follow the reader's flag.
describe('reduceWith: a Deserialize node inside a nested box register (known divergence)', () => {
  const Z = '00'.repeat(32)
  const G1 = `00d193c163010008d30000018602d401050402${Z}000502`

  it('G1 is rejected at parse', () => {
    let err: unknown
    try { parseTree(hexToBytes(G1), { checkType: true }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(SValueParseError)
    expect((err as SValueParseError).code).toBe('sbox-register-unsupported-expr')
  })
})
