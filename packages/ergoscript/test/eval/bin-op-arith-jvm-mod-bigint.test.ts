/**
 * BinOp.Arith.Modulo — JVM-mod semantics for BigInt kind (regression for
 * 2j-b iter-9 mainnet h=670,557 cost-drift Δ52).
 *
 * Sigma-rust dispatches `eval_mod` per-type:
 *   - Byte/Short/Int/Long → Rust-stdlib `checked_rem` (truncate-toward-zero,
 *     signed remainder; matches JS BigInt `%`).
 *   - BigInt              → `BigInt256::checked_rem`, which normalizes to
 *     JVM `java.math.BigInteger.mod()` semantics: result is always in
 *     [0, |divisor|-1], and a negative divisor is rejected (`None`).
 *
 * Cite: external/sigma-rust/ergotree-ir/src/bigint256.rs:207-222
 *   if v.is_negative() { return None; }
 *   let rem = self.0.checked_rem(v.0)?;
 *   if rem.is_negative() { Some(Self(rem + v.0)) } else { Some(Self(rem)) }
 *
 * Cost for BigInt Modulo stays 25 (Pattern A, charged AFTER left-eval
 * BEFORE right-eval). With two Const operands (5 each), total = 25+5+5 = 35.
 *
 * Native-int regression: Long(-7) % Long(3) must STAY at -1 (Rust-style)
 * to match sigma-rust's per-type native `checked_rem`.
 */
import { describe, it, expect } from 'vitest'

import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Expr, SValue } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

function bigIntConst(v: bigint): Expr {
  return {
    tag: 'Const',
    tpe: { tag: 'SBigInt' },
    value: { kind: 'BigInt', value: v },
  }
}

function longConst(v: bigint): Expr {
  return {
    tag: 'Const',
    tpe: { tag: 'SLong' },
    value: { kind: 'Long', value: v },
  }
}

function bigIntModulo(left: Expr, right: Expr): Expr {
  return {
    tag: 'BinOp',
    op: { kind: 'Arith', op: 'Modulo' },
    left,
    right,
  }
}

describe('BinOp.Arith.Modulo — JVM-mod normalization for BigInt', () => {
  // Cost for each: 25 (Modulo BigInt) + 5 (left Const) + 5 (right Const) = 35
  // jitCost asserted on the test pulls only the Modulo BinOp envelope; Const
  // eval contributes 5 each via the Const arm.

  it('case 1: BigInt(-7) % BigInt(3) → BigInt(2) (mathematical mod, not -1)', () => {
    const expr = bigIntModulo(bigIntConst(-7n), bigIntConst(3n))
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'BigInt', value: 2n })
    expect(ctx.jitCost).toBe(35)
  })

  it('case 2: BigInt(-1) % BigInt(5) → BigInt(4)', () => {
    const expr = bigIntModulo(bigIntConst(-1n), bigIntConst(5n))
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'BigInt', value: 4n })
    expect(ctx.jitCost).toBe(35)
  })

  it('case 3: BigInt(7) % BigInt(3) → BigInt(1) (positive dividend unchanged)', () => {
    const expr = bigIntModulo(bigIntConst(7n), bigIntConst(3n))
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'BigInt', value: 1n })
    expect(ctx.jitCost).toBe(35)
  })

  it('case 4: BigInt(0) % BigInt(5) → BigInt(0)', () => {
    const expr = bigIntModulo(bigIntConst(0n), bigIntConst(5n))
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'BigInt', value: 0n })
    expect(ctx.jitCost).toBe(35)
  })

  it('case 5: BigInt(7) % BigInt(-3) throws arith-divide-by-zero (negative divisor rejected)', () => {
    // sigma-rust BigInt256::checked_rem returns None for negative divisor (Scala
    // BigInt semantics). Surfaced via arithmetic_err() → wired through eval_mod
    // → reported as an arithmetic-exception EvalError. In our TS interpreter we
    // reuse 'arith-divide-by-zero' for the same "modulo-undefined" condition
    // (single error code for the modulo-not-permitted bucket).
    const expr = bigIntModulo(bigIntConst(7n), bigIntConst(-3n))
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(expr, Env.empty(), ctx))
    expect(err.code).toBe('arith-divide-by-zero')
  })
})

describe('BinOp.Arith.Modulo — native-int Rust-style semantics retained', () => {
  // Sigma-rust per-type eval_mod dispatch:
  //   Byte/Short/Int/Long → Rust-stdlib checked_rem (truncate-toward-zero).
  //   Only BigInt256 normalizes to JVM-mod. Native Long(-7) % Long(3) stays -1.
  // Cost for Long Modulo: 15 (non-bigint) + 5 + 5 = 25.

  it('Long(-7) % Long(3) → Long(-1) (Rust-style remainder, unchanged)', () => {
    const expr: Expr = {
      tag: 'BinOp',
      op: { kind: 'Arith', op: 'Modulo' },
      left: longConst(-7n),
      right: longConst(3n),
    }
    const ctx = makeContext()
    const value = evalExpr(expr, Env.empty(), ctx) as SValue
    expect(value).toEqual({ kind: 'Long', value: -1n })
    expect(ctx.jitCost).toBe(25)
  })
})
