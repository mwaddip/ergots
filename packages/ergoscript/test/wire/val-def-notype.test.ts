// A ValDef's right-hand side type read (sigma-state 6.0.6): ValDefSerializer.parse stores
// `valDefTypeStore(id) = rhs.tpe` after the rhs is read (ValDefSerializer.scala:47-49). An Apply of a
// non-function types as NoType there (values.scala:1247-1251) and never throws, so the tree parses:
// residual 8 of the sized-tree spec, closed by spec 2026-09-30 §1. A type read that does throw
// propagates as its own ExprTpeError, the JVM's exception class (the retired 'val-def-rhs-tpe' hid it).
import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { ExprTpeError } from '../../src/mir/expr-tpe'
import { NOTYPE_JVM, isUnparsedTree } from '../../src/mir/types'
import type { Expr } from '../../src/mir/types'
import { Apply, Block, Filter, Negation, ValDef, bool, hex, int, sp, treeBytes } from '../_helpers/mir-build'

describe('a ValDef bound to an Apply of a non-function', () => {
  it('{ val v1 = Apply(Int 0, [Int 0]); sigmaProp(true) } parses (residual 8 closed)', () => {
    // A local sigma-state 6.0.6 probe: tree 00d801d601da0400010400d10101, checkType = true, v0: parsed,
    // root type SSigmaProp.
    const bytes = treeBytes(Block([ValDef(1, Apply(int(0), [int(0)]))], sp(bool(true))), 0x00)
    expect(hex(bytes)).toBe('00d801d601da0400010400d10101')
    for (const t of [parseTree(bytes), parseTree(bytes, { checkType: true })]) {
      expect(isUnparsedTree(t)).toBe(false)
    }
  })
  it('a ValUse of it types as the JVM NoType, which Negation accepts', () => {
    // A local sigma-state 6.0.6 probe: tree 00d802d601da0400010400d602f07201d10101
    // ({ val v1 = Apply(Int 0, [0]); val v2 = -v1; sigmaProp(true) }), checkType = true, v0: parsed
    // (isNumTypeOrNoType passes NoType, trees.scala:882).
    const valUse: Expr = { tag: 'ValUse', valId: 1, tpe: NOTYPE_JVM }
    const body = Block([ValDef(1, Apply(int(0), [int(0)])), ValDef(2, Negation(valUse))], sp(bool(true)))
    const bytes = treeBytes(body, 0x00)
    expect(hex(bytes)).toBe('00d802d601da0400010400d602f07201d10101')
    const t = parseTree(bytes, { checkType: true })
    if (isUnparsedTree(t)) throw new Error('expected a parsed tree')
    const parsed = t.body.tag === 'BlockValue' ? t.body.items[1] : undefined
    const use = parsed?.tag === 'ValDef' && parsed.rhs.tag === 'Negation' ? parsed.rhs.input : undefined
    expect(use?.tag).toBe('ValUse')
    expect(use?.tag === 'ValUse' && use.tpe).toBe(NOTYPE_JVM)
  })
})

describe("a ValDef's type read that throws propagates as itself", () => {
  it('{ val v1 = Filter(Int 1, f); sigmaProp(true) } rejects with the ExprTpeError of the Filter', () => {
    // A local sigma-state 6.0.6 probe: tree 00d801d601b50402d90101040101d10101, checkType = true, v0:
    // rejected, ClassCastException (SInt$ cannot be cast to SCollection) from Filter's tpe.
    const bytes = treeBytes(Block([ValDef(1, Filter(int(1)))], sp(bool(true))), 0x00)
    expect(hex(bytes)).toBe('00d801d601b50402d90101040101d10101')
    let err: unknown
    try {
      parseTree(bytes)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ExprTpeError)
    expect((err as ExprTpeError).code).toBe('filter-input-not-scoll')
  })
})
