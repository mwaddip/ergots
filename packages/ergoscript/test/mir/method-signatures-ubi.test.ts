/**
 * method-signatures.ts: SUnsignedBigInt (typeId 9) — v6 P2b.
 *
 * `numericV6Signatures()` iterates `NUMERIC_STYPE` to generate method-id 6–13
 * signatures with a `tNum → ownerType` substitution. Before this task,
 * `NUMERIC_STYPE` had only typeIds 2–6 (Byte/Short/Int/Long/BigInt); UBI (9)
 * was absent, so `exprTpe` returned `SAny` for every UBI method call.
 *
 * This test verifies the three representative return types specified in JVM
 * `SNumericTypeMethods.v6Methods`:
 *   - methodId 6 (toBytes)         → Coll[SByte]      (closed tRange)
 *   - methodId 7 (toBits)          → Coll[SBoolean]   (closed tRange)
 *   - methodId 8 (bitwiseInverse)  → SUnsignedBigInt  (tNum substitution)
 *
 * JVM source: sigma/ast/methods.scala — SNumericTypeMethods.v6Methods
 * Spec: docs/specs/2026-06-02-ergoscript-v6-p1-numeric-methods-design.md
 */
import { describe, it, expect } from 'vitest'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { Expr, SType } from '../../src/mir/types'

const SUBI: SType = { tag: 'SUnsignedBigInt' }

const ubiConst: Expr = {
  tag: 'Const',
  tpe: SUBI,
  // SValue: { kind: 'UnsignedBigInt'; value: bigint }
  value: { kind: 'UnsignedBigInt', value: 7n } as any,
}

function mc(methodId: number, args: Expr[] = []): Expr {
  return {
    tag: 'MethodCall',
    obj: ubiConst,
    typeId: 9,
    methodId,
    args,
    explicitTypeArgs: {},
  }
}

describe('method-signatures: SUnsignedBigInt (typeId 9)', () => {
  it('bitwiseInverse (8) returns SUnsignedBigInt, not SAny', () => {
    expect(exprTpe(mc(8))).toEqual({ tag: 'SUnsignedBigInt' })
  })

  it('toBytes (6) returns Coll[SByte]', () => {
    expect(exprTpe(mc(6))).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
  })

  it('toBits (7) returns Coll[SBoolean]', () => {
    expect(exprTpe(mc(7))).toEqual({ tag: 'SColl', elem: { tag: 'SBoolean' } })
  })
})
