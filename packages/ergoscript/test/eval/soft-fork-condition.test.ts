// checkSoftForkCondition: the JVM's check of a spent tree's version before the reduction
// (sigma-state Interpreter.scala:298-331; Interpreter.verify calls it first, :362-365).
//
// Each row is a sigma-state 6.0.6 probe's: the tree read as a box's tree outside any version context, then
// Interpreter.verify with an empty proof under the activated version given. The function answers for the check alone:
//  - the JVM threw "ErgoTree version N is higher than activated A": the function throws the same sentence;
//  - the JVM accepted at the cost the context entered with: 'accept-unverified';
//  - anything else, a verdict of the reduction or of the proof: 'proceed'.
import { describe, it, expect } from 'vitest'
import { checkSoftForkCondition } from '../../src/eval/soft-fork-condition'
import { EvalError } from '../../src/eval/eval-context'
import { evaluate } from '../../src/eval/evaluate'
import { isUnparsedTree } from '../../src/mir/types'
import { parseTree } from '../../src/wire/ergo-tree'
import * as pkg from '../../src'
import { hexToBytes } from '../_helpers'

type Want = 'proceed' | 'accept-unverified' | { above: number }
type Row = [name: string, activated: number, want: Want, tree: string]

/** The tree as a box's: read outside any version context, with rule 1001. */
const boxTree = (tree: string) => parseTree(hexToBytes(tree), { checkType: true })

function check([, activated, want, tree]: Row): void {
  const parsed = boxTree(tree)
  if (typeof want === 'string') {
    expect(checkSoftForkCondition(parsed, activated)).toBe(want)
    return
  }
  let err: unknown
  try { checkSoftForkCondition(parsed, activated) } catch (e) { err = e }
  expect(err).toBeInstanceOf(EvalError)
  expect((err as EvalError).code).toBe('tree-version-above-activated')
  expect((err as Error).message).toBe(`ErgoTree version ${want.above} is higher than activated ${activated}`)
}

const title = '%s (activated %i)'

// A sized `SigmaProp(true)` of each version (`0008d3` at version 0).
const UP_TO_3: Row[] = [
  ['a v4 tree is refused', 3, { above: 4 }, '0c0208d3'],
  ['a v3 tree goes on', 3, 'proceed', '0b0208d3'],
  ['a v3 tree is refused', 2, { above: 3 }, '0b0208d3'],
  ['a v2 tree goes on', 2, 'proceed', '0a0208d3'],
  ['a v2 tree is refused: no floor at 2', 1, { above: 2 }, '0a0208d3'],
  ['a v1 tree goes on', 1, 'proceed', '090208d3'],
  ['a v1 tree is refused', 0, { above: 1 }, '090208d3'],
  ['a v0 tree goes on', 0, 'proceed', '0008d3'],
  ['a v0 tree is refused', -1, { above: 0 }, '0008d3'],
  ['a v0 tree is refused', -57, { above: 0 }, '0008d3'],
  ['a v0 tree is refused', -128, { above: 0 }, '0008d3'],
]

// `…d2` is `SigmaProp(false)`.
const ABOVE_3: Row[] = [
  ['a v0 tree goes on', 127, 'proceed', '0008d3'],
  ['a v4 tree is accepted unverified', 127, 'accept-unverified', '0c0208d3'],
  ['a v4 tree is accepted unverified', 4, 'accept-unverified', '0c0208d3'],
  ['a v4 SigmaProp(false) is accepted unverified', 4, 'accept-unverified', '0c0208d2'],
  ['a v7 SigmaProp(false) is accepted unverified', 4, 'accept-unverified', '0f0208d2'],
  ['a v3 SigmaProp(false) goes on to the reduction', 4, 'proceed', '0b0208d2'],
  ['a v3 SigmaProp(true) goes on to the reduction', 4, 'proceed', '0b0208d3'],
]

// `1c0208d3` and `1b0208d3` degrade (a constant of type code 211), so the tree object's version is 0 whatever its
// header's bits say.
const DEGRADED: Row[] = [
  ['a degraded v4 tree goes on to the reduction', 3, 'proceed', '1c0208d3'],
  ['a degraded v4 tree goes on to the reduction', 4, 'proceed', '1c0208d3'],
  ['a degraded v4 tree is refused with version 0', -1, { above: 0 }, '1c0208d3'],
  ['a degraded v3 tree goes on to the reduction', 2, 'proceed', '1b0208d3'],
  ['a degraded v3 tree goes on to the reduction', 3, 'proceed', '1b0208d3'],
]

describe('checkSoftForkCondition: up to activated version 3 a tree above it is refused', () => {
  it.each(UP_TO_3)(title, (...row) => check(row))
})

describe('checkSoftForkCondition: above activated version 3 a tree above 3 is accepted unverified', () => {
  it.each(ABOVE_3)(title, (...row) => check(row))
})

describe("checkSoftForkCondition: an unparsed tree's version is 0", () => {
  it.each(DEGRADED)(title, (...row) => check(row))

  it('each of these trees is unparsed', () => {
    for (const [, , , tree] of DEGRADED) expect(isUnparsedTree(boxTree(tree))).toBe(true)
  })
})

describe('checkSoftForkCondition: the trees whose parse verdict decides', () => {
  // The JVM parses `sigmaProp(TrueLeaf)` and `sigmaProp(FalseLeaf)` (opcodes 7f, 80), and accepts a v4 tree of
  // either unverified at activated 4.
  it.each([
    ['sigmaProp(TrueLeaf)', '0c02d17f'],
    ['sigmaProp(FalseLeaf)', '0c02d180'],
  ])('a v4 %s parses and is accepted unverified at activated 4', (_name, hex) => {
    const tree = boxTree(hex)
    expect(isUnparsedTree(tree)).toBe(false)
    expect(checkSoftForkCondition(tree, 4)).toBe('accept-unverified')
  })

  it('a v3 sigmaProp(TrueLeaf) goes on to the reduction at activated 3', () => {
    expect(checkSoftForkCondition(boxTree('0b02d17f'), 3)).toBe('proceed')
  })

  it('an unparsed tree is no reduction input: evaluate refuses it', () => {
    const tree = boxTree('1c0208d3')
    let err: unknown
    try { evaluate(tree, { activatedScriptVersion: 4 }) } catch (e) { err = e }
    expect((err as EvalError).code).toBe('unparsed-ergotree')
  })
})

// `0c04db6501fe` is a v4 tree whose root is CONTEXT.dataInputs. The JVM types the root as a collection, degrades
// the tree (rule 1001) and so refuses the spend at activated 4 and 127 ("Script has not been recognized due to
// ValidationException"). ergots types the root as its own unknown type and parses the tree, so its version is 4.
describe("checkSoftForkCondition: a root of ergots' own unknown type, a known difference (the JVM refuses these spends)", () => {
  it.each([4, 127])('a v4 tree is accepted unverified at activated %i, where the JVM refuses', (activated) => {
    const tree = boxTree('0c04db6501fe')
    expect(isUnparsedTree(tree)).toBe(false)
    expect(checkSoftForkCondition(tree, activated)).toBe('accept-unverified')
  })

  it('the v3 twin goes on to the reduction at activated 3, as in the JVM', () => {
    expect(checkSoftForkCondition(boxTree('0b04db6501fe'), 3)).toBe('proceed')
  })
})

describe('checkSoftForkCondition: its surface', () => {
  it('is exported from the package', () => {
    expect((pkg as Record<string, unknown>).checkSoftForkCondition).toBe(checkSoftForkCondition)
  })

  it.each([3.5, 128, -129, NaN, undefined as unknown as number])('an activated version of %s is a TypeError', (activated) => {
    expect(() => checkSoftForkCondition(boxTree('0008d3'), activated)).toThrow(TypeError)
  })
})
