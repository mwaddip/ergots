/**
 * BinOp comparison/equality SameType + OnlyNumeric strictness, at parse.
 *
 * The JVM's deserializing builder runs check2(SameType) on equality, and check2(OnlyNumeric) then
 * check2(SameType) on comparison (SigmaBuilder.scala:686-704; ConstraintFailed, :286-295), as each
 * node is built. So a mismatched relation rejects the whole tree at parse, a never-evaluated branch
 * included. ergots makes the same checks at parse (wire/check-build.ts; facts/ergoscript-wire.md,
 * "Node construction"). Until 2026-09-30 it made them in a pre-eval pass over the tree
 * (validateBinOpTypes), with the EvalError codes 'bin-op-kind-mismatch' and 'bin-op-not-numeric';
 * each case below is one of that pass's, moved to the parse with the same tree. Every verdict is a
 * local sigma-state 6.0.6 probe's (tree mode, checkType = false; the relation is the root).
 *
 * Specs: docs/specs/2026-06-02-ergoscript-binop-sametype-strictness-design.md,
 * docs/specs/2026-09-30-jvm-node-construction-design.md §3.
 */
import { describe, it, expect } from 'vitest'

import { parseTree } from '../../src/wire/ergo-tree'
import { ExprParseError } from '../../src/wire/errors'
import { isUnparsedTree } from '../../src/mir/types'
import type { Expr } from '../../src/mir/types'
import { PC, Ctx, If, bool, hex, int, long, treeBytes } from '../_helpers/mir-build'

type RelationOp = 'Eq' | 'NEq' | 'Lt' | 'Le' | 'Gt' | 'Ge'
function rel(op: RelationOp, left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Relation', op }, left, right }
}
const eq = (l: Expr, r: Expr): Expr => rel('Eq', l, r)

/** The tree's bytes, checked against the bytes the probe was given. */
function probed(body: Expr, header: number, probedHex: string): Uint8Array {
  const b = treeBytes(body, header)
  expect(hex(b)).toBe(probedHex)
  return b
}

function expectRejects(b: Uint8Array, code: string): void {
  let err: unknown
  try {
    parseTree(b)
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(ExprParseError)
  expect((err as ExprParseError).code).toBe(code)
}

function expectParses(b: Uint8Array): void {
  expect(isUnparsedTree(parseTree(b))).toBe(false)
}

describe('equality: check2(SameType)', () => {
  it('rejects EQ(Int, Boolean): a non-numeric mismatch, any version (the JVM: ConstraintFailed)', () => {
    expectRejects(probed(eq(int(5), bool(true)), 0x00, '0093040a0101'), 'relation-operand-type-mismatch')
  })

  it('rejects EQ(Int, Long) at tree version 3: a numeric mismatch, v3 and later (the JVM: ConstraintFailed)', () => {
    expectRejects(probed(eq(int(5), long(5)), 0x0b, '0b0593040a050a'), 'relation-operand-type-mismatch')
  })

  it('rejects NEq(Int, Boolean) (the JVM: ConstraintFailed)', () => {
    expectRejects(probed(rel('NEq', int(5), bool(true)), 0x00, '0094040a0101'), 'relation-operand-type-mismatch')
  })

  it('allows EQ(Int, Long) at tree version 0: the builder upcasts before v3 (the JVM: parsed)', () => {
    expectParses(probed(eq(int(5), long(5)), 0x00, '0093040a050a'))
  })

  it('allows EQ(Bool, Bool): the same type, written as the packed pair (the JVM: parsed)', () => {
    expectParses(probed(eq(bool(true), bool(false)), 0x0b, '0b03938501'))
  })

  it('allows EQ(Int, Int): the same type (the JVM: parsed)', () => {
    expectParses(probed(eq(int(1), int(2)), 0x0b, '0b059304020404'))
  })
})

describe('ordering: check2(OnlyNumeric), then check2(SameType)', () => {
  it('rejects Lt(Int, Boolean): OnlyNumeric (the JVM: ConstraintFailed)', () => {
    expectRejects(probed(rel('Lt', int(5), bool(true)), 0x00, '008f040a0101'), 'relation-operand-not-numeric')
  })

  it('rejects Gt(Int, Long) at tree version 3: a numeric mismatch (the JVM: ConstraintFailed)', () => {
    expectRejects(probed(rel('Gt', int(5), long(5)), 0x0b, '0b0591040a050a'), 'relation-operand-type-mismatch')
  })

  it('allows Le(Int, Long) at tree version 0: the builder upcasts before v3 (the JVM: parsed)', () => {
    expectParses(probed(rel('Le', int(5), long(5)), 0x00, '0090040a050a'))
  })

  it('allows Ge(Int, Int): the same type (the JVM: parsed)', () => {
    expectParses(probed(rel('Ge', int(1), int(2)), 0x0b, '0b059204020404'))
  })
})

describe('every relation is checked where it sits', () => {
  it('rejects a mismatched EQ nested inside another relation (the JVM: ConstraintFailed)', () => {
    // The outer EQ(Boolean, Boolean) is well-typed; the inner EQ(Int, Boolean) is built first, and fails.
    expectRejects(probed(eq(eq(int(5), bool(true)), bool(false)), 0x0b, '0b089393040a01010100'), 'relation-operand-type-mismatch')
  })

  it("passes an operand typed as ergots' own SAny (residual 1; the JVM types the timestamp Long: parsed)", () => {
    // CONTEXT.preHeader.timestamp: a method ergots' catalog lacks, so its type is unknown to ergots.
    const ts = PC(105, 3, PC(101, 3, Ctx))
    expectParses(probed(eq(ts, long(5)), 0x0b, '0b0a93db6903db6503fe050a'))
  })

  it('rejects the whole tree for a mismatch in a never-evaluated branch (the JVM: ConstraintFailed)', () => {
    // condition = true: evaluation would take the true branch and never reach the false one. The
    // parse rejects the tree first, as the JVM does, so it is never evaluated.
    const body = If(bool(true), bool(true), eq(int(5), long(5)))
    expectRejects(probed(body, 0x0b, '0b0a950101010193040a050a'), 'relation-operand-type-mismatch')
  })
})
