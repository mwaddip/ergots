/**
 * BinOp mismatched-numeric coercion — eval-time upcast, version-gated.
 *
 * Mirrors the JVM deserializer `DeserializationSigmaBuilder.applyUpcast`
 * (sigmastate-interpreter SigmaBuilder.scala:750-756), which — ONLY for
 * pre-V3 ErgoTree versions (ergoTreeVersion < 3) — inserts an Upcast on the
 * narrower operand of a mismatched-numeric BinOp so the op runs at the wider
 * type. For V3+ the deserializer keeps the tree raw and the mismatch is
 * rejected, matching ergots' existing throw.
 *
 * Cost = cost(same-width op at the wider kind) + one Upcast charge
 * (10 for non-BigInt target, 30 for BigInt target — upcast.rs:80). Const eval
 * is a flat 5 (const.ts:28), so the totals below are exact.
 *
 * Spec: docs/specs/2026-06-01-ergoscript-mismatched-numeric-coercion-design.md
 * These hand-built expectations get re-blessed from the SANTA conformance
 * vector when it lands (do not rederive).
 */
import { describe, it, expect } from 'vitest'

import { evalExpr } from '../../src/eval/eval'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { parseTree } from '../../src/wire/ergo-tree'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes } from '../_helpers'

function intConst(v: number): Expr {
  return { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: v } }
}
function longConst(v: bigint): Expr {
  return { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: v } }
}
function bigIntConst(v: bigint): Expr {
  return { tag: 'Const', tpe: { tag: 'SBigInt' }, value: { kind: 'BigInt', value: v } }
}
function arith(op: 'Plus' | 'Max', left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Arith', op }, left, right }
}
const plus = (l: Expr, r: Expr): Expr => arith('Plus', l, r)

function relation(op: 'Lt' | 'Le' | 'Gt' | 'Ge', left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Relation', op }, left, right }
}
function rel(op: 'Eq' | 'NEq', left: Expr, right: Expr): Expr {
  return { tag: 'BinOp', op: { kind: 'Relation', op }, left, right }
}

describe('BinOp.Arith mismatched-numeric coercion (pre-V3)', () => {
  it('Plus(Int 2, Long 3) at treeVersion 0 → Long 5, cost 35', () => {
    // 5 (Int const) + 15 (Plus, wider=Long non-bigint) + 5 (Long const) + 10 (Upcast Int→Long) = 35
    const ctx = makeContext()
    const value = evalExpr(plus(intConst(2), longConst(3n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Long', value: 5n })
    expect(ctx.jitCost).toBe(35)
  })

  it('Plus(Long 2, Int 3) — narrower on the right → Long 5, cost 35', () => {
    // Symmetric: the Upcast wraps the right (Int) operand; total is identical.
    const ctx = makeContext()
    const value = evalExpr(plus(longConst(2n), intConst(3)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Long', value: 5n })
    expect(ctx.jitCost).toBe(35)
  })

  it('Plus(Int 2, BigInt 3) → BigInt 5, cost 60 (BigInt-target rate flip)', () => {
    // 5 + 15 (Plus at lv=Int rate) + 5 + 30 (Upcast→BigInt) + 5 (rate delta 20-15) = 60
    const ctx = makeContext()
    const value = evalExpr(plus(intConst(2), bigIntConst(3n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'BigInt', value: 5n })
    expect(ctx.jitCost).toBe(60)
  })

  it('Max(Int 2, BigInt 7) → BigInt 7, cost 50 (Max rate flip 5→10)', () => {
    // 5 + 5 (Max at lv=Int rate) + 5 + 30 (Upcast→BigInt) + 5 (rate delta 10-5) = 50
    const ctx = makeContext()
    const value = evalExpr(arith('Max', intConst(2), bigIntConst(7n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'BigInt', value: 7n })
    expect(ctx.jitCost).toBe(50)
  })
})

describe('BinOp.Arith mismatched-numeric — V3+ still rejects (gate)', () => {
  it('Plus(Int 2, Long 3) at treeVersion 3 throws bin-op-kind-mismatch', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() => evalExpr(plus(intConst(2), longConst(3n)), Env.empty(), ctx))
    expect(err.code).toBe('bin-op-kind-mismatch')
  })
})

describe('BinOp.Relation ordering mismatched-numeric coercion (pre-V3)', () => {
  it('Lt(Int 2, Long 3) at treeVersion 0 → Boolean true, cost 40', () => {
    // 5 (Int const) + 20 (ordering, fixed) + 5 (Long const) + 10 (Upcast Int→Long) = 40
    const ctx = makeContext()
    const value = evalExpr(relation('Lt', intConst(2), longConst(3n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(40)
  })

  it('Ge(Short 3, Int 3) at treeVersion 0 → Boolean true, cost 40', () => {
    const ctx = makeContext()
    const value = evalExpr(
      relation('Ge', { tag: 'Const', tpe: { tag: 'SShort' }, value: { kind: 'Short', value: 3 } }, intConst(3)),
      Env.empty(),
      ctx,
    ) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(40)
  })

  it('Gt(Int 2, BigInt 3) at treeVersion 0 → Boolean false, cost 60 (BigInt upcast 30, ordering still fixed-20)', () => {
    // 5 + 20 (ordering, fixed — NO rate flip) + 5 + 30 (Upcast→BigInt) = 60
    const ctx = makeContext()
    const value = evalExpr(relation('Gt', intConst(2), bigIntConst(3n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(60)
  })
})

describe('BinOp.Relation ordering mismatched-numeric — V3+ still rejects (gate)', () => {
  it('Lt(Int 2, Long 3) at treeVersion 3 throws bin-op-kind-mismatch', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const err = captureEvalError(() =>
      evalExpr(relation('Lt', intConst(2), longConst(3n)), Env.empty(), ctx),
    )
    expect(err.code).toBe('bin-op-kind-mismatch')
  })
})

describe('BinOp.Relation equality mismatched-numeric coercion (pre-V3)', () => {
  it('EQ(Int 5, Long 5) at treeVersion 0 → Boolean true, cost 23', () => {
    // 5 (Int) + 5 (Long) + 10 (Upcast Int→Long) + 3 (EQ_PRIM, wider=Long) = 23.
    // Cross-kind would be `false`; coercion makes it Long==Long → true.
    const ctx = makeContext()
    const value = evalExpr(rel('Eq', intConst(5), longConst(5n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(23)
  })

  it('EQ(Int 5, Long 6) at treeVersion 0 → Boolean false, cost 23', () => {
    const ctx = makeContext()
    const value = evalExpr(rel('Eq', intConst(5), longConst(6n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(23)
  })

  it('EQ(Int 5, BigInt 5) at treeVersion 0 → Boolean true, cost 45 (BigInt upcast 30 + EQ_BIGINT 5)', () => {
    // 5 + 5 + 30 (Upcast→BigInt) + 5 (EQ_BIGINT, wider=BigInt) = 45
    const ctx = makeContext()
    const value = evalExpr(rel('Eq', intConst(5), bigIntConst(5n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(45)
  })

  it('NEq(Int 5, Long 6) at treeVersion 0 → Boolean true, cost 23', () => {
    const ctx = makeContext()
    const value = evalExpr(rel('NEq', intConst(5), longConst(6n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(23)
  })

  it('EQ(Byte 1, Short 1) at treeVersion 0 → Boolean true, cost 23', () => {
    const ctx = makeContext()
    const value = evalExpr(
      rel(
        'Eq',
        { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 1 } },
        { tag: 'Const', tpe: { tag: 'SShort' }, value: { kind: 'Short', value: 1 } },
      ),
      Env.empty(),
      ctx,
    ) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(23)
  })
})

describe('BinOp.Relation equality mismatched-numeric — V3+ residual (deferred mechanism #2)', () => {
  it('EQ(Int 5, Long 5) at treeVersion 3 → Boolean false, cost 13 (current behavior, NOT coerced)', () => {
    // V3+ JVM rejects this at deserialize (SameType check); ergots still returns
    // cross-kind false. Closing that is deferred mechanism #2 (parser strictness).
    // 5 + 5 + 3 (EQ_PRIM cross-kind) = 13.
    const ctx = makeContext({ treeVersion: 3 })
    const value = evalExpr(rel('Eq', intConst(5), longConst(5n)), Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(13)
  })
})

describe('BinOp.Arith mismatched-numeric — production parse path (header sources the gate)', () => {
  // These v0 tree bytes were the old fixture-gen kind-mismatch rejection cases
  // (plus_kind_mismatch_int_long / multiply_kind_mismatch_byte_short), removed
  // from fixture-gen because sigma-rust can't produce the JVM-correct value.
  // evaluate() sources treeVersion from tree.header.version (= 0 here, pre-V3),
  // so the coercion fires on the realistic parse → eval path.

  it('parse Plus(Int 1, Long 2) v0 → Long 3, cost 35 (evaluateWith, header version)', () => {
    const tree = parseTree(hexToBytes('009a04020504'))
    const ctx = makeContext({ treeVersion: tree.header.version })
    const value = evaluateWith(tree, ctx) as SValue
    expect(value).toEqual({ kind: 'Long', value: 3n })
    expect(ctx.jitCost).toBe(35)
  })

  it('parse Multiply(Byte 1, Short 2) v0 → Short 2 via evaluate() (auto-sources header version)', () => {
    // evaluate() reads treeVersion from tree.header.version (= 0) internally.
    const tree = parseTree(hexToBytes('009c02010304'))
    const value = evaluate(tree) as SValue
    expect(value).toEqual({ kind: 'Short', value: 2 })
  })

  it('parse Lt(Int 1, Long 2) v0 → Boolean true, cost 40', () => {
    const tree = parseTree(hexToBytes('008f04020504'))
    const ctx = makeContext({ treeVersion: tree.header.version })
    const value = evaluateWith(tree, ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(40)
  })

  it('parse Ge(Short 1, Int 2) v0 → Boolean false, cost 40', () => {
    const tree = parseTree(hexToBytes('009203020404'))
    const ctx = makeContext({ treeVersion: tree.header.version })
    const value = evaluateWith(tree, ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(40)
  })

  it('parse EQ(Int 5, Long 5) v0 → Boolean true, cost 23', () => {
    const tree = parseTree(hexToBytes('0093040a050a'))
    const ctx = makeContext({ treeVersion: tree.header.version })
    const value = evaluateWith(tree, ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(23)
  })

  it('parse EQ(Byte 1, Short 1) v0 → Boolean true, cost 23', () => {
    const tree = parseTree(hexToBytes('009302010302'))
    const ctx = makeContext({ treeVersion: tree.header.version })
    const value = evaluateWith(tree, ctx) as SValue
    expect(value).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(23)
  })
})
