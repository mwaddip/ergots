/**
 * BinOp comparison/equality SameType + OnlyNumeric strictness — pre-eval pass.
 *
 * JVM-align #2: the JVM deserializer runs check2(SameType) on equality and
 * check2(OnlyNumeric)+check2(SameType) on comparison (SigmaBuilder.scala
 * equalityOp:679 / comparisonOp:689; ConstraintFailed at :287), rejecting the
 * WHOLE tree at deserialize — including never-evaluated branches. ergots mirrors
 * this with a pre-eval whole-tree pass (validateBinOpTypes) so an adversary's
 * hand-crafted box proposition can't make ergots over-accept a spend the JVM
 * rejects.
 *
 * Rule (via exprTpe; SAny operand → SKIP, per the no-false-positive policy):
 *  - Eq/NEq: differing operand types reject unless both numeric AND treeVersion<3
 *    (where #1's eval-time coercion legitimately handles them).
 *  - Lt/Le/Gt/Ge: non-numeric operand rejects (OnlyNumeric); numeric-mismatch
 *    rejects at treeVersion>=3.
 * Error codes reused: 'bin-op-kind-mismatch' (SameType), 'bin-op-not-numeric'
 * (OnlyNumeric). No cost charged — rejection is pre-eval.
 *
 * Spec: docs/specs/2026-06-02-ergoscript-binop-sametype-strictness-design.md
 */
import { describe, it, expect } from 'vitest'

import { validateBinOpTypes } from '../../src/eval/validate-bin-op-types'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr, ErgoTree } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

function intConst(v: number): Expr {
  return { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: v } }
}
function longConst(v: bigint): Expr {
  return { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: v } }
}
function boolConst(v: boolean): Expr {
  return { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: v } }
}
function rel(op: 'Eq' | 'NEq' | 'Lt' | 'Le' | 'Gt' | 'Ge', left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Relation', op }, left, right }
}
const eq = (l: Expr, r: Expr): Expr => rel('Eq', l, r)

describe('validateBinOpTypes — equality SameType strictness', () => {
  it('rejects EQ(Int, Boolean) — non-numeric mismatch, any version', () => {
    const err = captureEvalError(() => validateBinOpTypes(eq(intConst(5), boolConst(true)), 0))
    expect(err.code).toBe('bin-op-kind-mismatch')
  })

  it('rejects EQ(Int, Long) at treeVersion 3 — numeric mismatch, V3+', () => {
    const err = captureEvalError(() => validateBinOpTypes(eq(intConst(5), longConst(5n)), 3))
    expect(err.code).toBe('bin-op-kind-mismatch')
  })

  it('rejects NEq(Int, Boolean)', () => {
    const err = captureEvalError(() => validateBinOpTypes(rel('NEq', intConst(5), boolConst(true)), 0))
    expect(err.code).toBe('bin-op-kind-mismatch')
  })

  it('ALLOWS EQ(Int, Long) at treeVersion 0 — #1 coerces pre-V3 (must not reject)', () => {
    expect(() => validateBinOpTypes(eq(intConst(5), longConst(5n)), 0)).not.toThrow()
  })

  it('ALLOWS EQ(Bool, Bool) — same type', () => {
    expect(() => validateBinOpTypes(eq(boolConst(true), boolConst(false)), 3)).not.toThrow()
  })

  it('ALLOWS EQ(Int, Int) — same type', () => {
    expect(() => validateBinOpTypes(eq(intConst(1), intConst(2)), 3)).not.toThrow()
  })
})

describe('validateBinOpTypes — ordering OnlyNumeric + SameType', () => {
  it('rejects Lt(Int, Boolean) — OnlyNumeric', () => {
    const err = captureEvalError(() => validateBinOpTypes(rel('Lt', intConst(5), boolConst(true)), 0))
    expect(err.code).toBe('bin-op-not-numeric')
  })

  it('rejects Gt(Int, Long) at treeVersion 3 — numeric mismatch, V3+', () => {
    const err = captureEvalError(() => validateBinOpTypes(rel('Gt', intConst(5), longConst(5n)), 3))
    expect(err.code).toBe('bin-op-kind-mismatch')
  })

  it('ALLOWS Le(Int, Long) at treeVersion 0 — #1 coerces pre-V3', () => {
    expect(() => validateBinOpTypes(rel('Le', intConst(5), longConst(5n)), 0)).not.toThrow()
  })

  it('ALLOWS Ge(Int, Int) — same type', () => {
    expect(() => validateBinOpTypes(rel('Ge', intConst(1), intConst(2)), 3)).not.toThrow()
  })
})

describe('validateBinOpTypes — whole-tree walk + SAny skip', () => {
  it('rejects a mismatched EQ nested inside another relation (dead-branch reach)', () => {
    // Outer EQ(Boolean, Boolean) is same-type OK, but the walk recurses into the
    // inner EQ(Int, Boolean) and rejects it — proving non-top-level nodes are checked.
    const inner = eq(intConst(5), boolConst(true))
    const err = captureEvalError(() => validateBinOpTypes(eq(inner, boolConst(false)), 3))
    expect(err.code).toBe('bin-op-kind-mismatch')
  })

  it('SKIPS EQ when an operand type is SAny (no false positive)', () => {
    // exprTpe → SAny operand is a wildcard: not rejected (the eval arm handles it
    // at runtime if the node is ever evaluated).
    const anyOperand: Expr = { tag: 'Const', tpe: { tag: 'SAny' }, value: { kind: 'Int', value: 5 } }
    expect(() => validateBinOpTypes(eq(anyOperand, longConst(5n)), 3)).not.toThrow()
  })
})

describe('validateBinOpTypes — wired into evaluate (pre-eval, zero cost, dead branches)', () => {
  function treeV3(body: Expr): ErgoTree {
    return {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body,
    }
  }
  function ifExpr(condition: Expr, trueBranch: Expr, falseBranch: Expr): Expr {
    return { tag: 'If', condition, trueBranch, falseBranch }
  }

  it('evaluateWith rejects a top-level mismatched EQ tree with zero JIT cost', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() => evaluateWith(treeV3(eq(intConst(5), longConst(5n))), ctx))
    expect(err.code).toBe('bin-op-kind-mismatch')
    expect(ctx.jitCost).toBe(0)
  })

  it('rejects the whole tree for a mismatch in a NEVER-evaluated branch', () => {
    // condition=true → lazy eval would take trueBranch and return Boolean true,
    // never touching the mismatched falseBranch (if.ts is lazy). The pre-eval
    // pass rejects the whole tree anyway — matching the JVM's deserialize-time
    // rejection of dead branches. Zero cost (pass runs before any eval).
    const ctx = makeContext({ treeVersion: 3 })
    const body = ifExpr(boolConst(true), boolConst(true), eq(intConst(5), longConst(5n)))
    const err = captureEvalError(() => evaluateWith(treeV3(body), ctx))
    expect(err.code).toBe('bin-op-kind-mismatch')
    expect(ctx.jitCost).toBe(0)
  })
})
