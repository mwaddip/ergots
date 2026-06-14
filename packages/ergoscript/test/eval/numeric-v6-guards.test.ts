/**
 * Adversarial wrong-kind operand guards for v6 numeric methods.
 * Final-review C1 — consensus over-accept fix.
 *
 * Before the guard fix, wrong-kind obj/args returned garbage (Byte/Short/Int,
 * where the receiver's .value happened to be 0 or undefined) or a raw TypeError
 * (Long/BigInt, where JS bitwise coercion on a non-bigint throws). Both are
 * wrong: the JVM's asInstanceOf + sigma-rust's try_extract_into REJECT at eval
 * with a typed error. After the fix every handler must throw a typed EvalError
 * with code 'numeric-method-bad-operand'.
 *
 * Adversarial MIR shape: MethodCall with the numeric method's typeId/methodId
 * but obj = a Const whose evaluated kind is wrong (Coll, not the numeric kind).
 * This PARSES — sigma-rust / JVM reject at eval, not at parse; our guard must
 * be the runtime line of defense.
 */
import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const v3 = () => makeContext({ treeVersion: 3 })

/** A Const node whose runtime value is an empty Coll[Byte] — wrong kind for any numeric method. */
const collByteTpe: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
const collByteValue: SValue = { kind: 'Coll', elem: { tag: 'SByte' }, items: [] }
const collByteConst = { tag: 'Const', tpe: collByteTpe, value: collByteValue } as any

/** A Const node whose runtime value is a Long — wrong kind for Byte/Short/Int slots. */
const longConst = (v: bigint) => ({ tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: v } } as any)

/** A Const node whose runtime value is an Int (correct for bits arg). */
const intConst = (v: number) => ({ tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: v } } as any)

/** A Const node whose runtime value is a numeric SValue. */
function numConst(kind: string, tpeTag: string, value: number | bigint) {
  return { tag: 'Const', tpe: { tag: tpeTag }, value: { kind, value } } as any
}

const GUARD_CODE = 'numeric-method-bad-operand'

// Helper: assert that expr throws EvalError with GUARD_CODE.
// The capture pattern avoids vitest expect().toThrow() swallowing non-Error objects.
function expectGuard(expr: MethodCallExpr, desc: string): void {
  let threw: unknown
  try { evalMethodCall(expr, Env.empty(), v3()) } catch (e) { threw = e }
  expect(threw, `${desc}: expected EvalError to be thrown`).toBeInstanceOf(EvalError)
  expect((threw as EvalError).code, `${desc}: expected code '${GUARD_CODE}'`).toBe(GUARD_CODE)
}

// -------------------------------------------------------------------------
// toBytes (methodId 6) — receiver wrong-kind
// -------------------------------------------------------------------------
describe('numeric-v6 guards: toBytes receiver wrong-kind', () => {
  it('Byte.toBytes(obj=Coll) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [],
      typeId: 2, methodId: 6, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Byte.toBytes(Coll)')
  })

  it('Long.toBytes(obj=Coll) -> EvalError numeric-method-bad-operand (was raw TypeError)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [],
      typeId: 5, methodId: 6, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Long.toBytes(Coll)')
  })

  it('BigInt.toBytes(obj=Coll) -> EvalError numeric-method-bad-operand (was raw TypeError)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [],
      typeId: 6, methodId: 6, explicitTypeArgs: {},
    }
    expectGuard(expr, 'BigInt.toBytes(Coll)')
  })
})

// -------------------------------------------------------------------------
// toBits (methodId 7) — receiver wrong-kind
// -------------------------------------------------------------------------
describe('numeric-v6 guards: toBits receiver wrong-kind', () => {
  it('Int.toBits(obj=Coll) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [],
      typeId: 4, methodId: 7, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Int.toBits(Coll)')
  })
})

// -------------------------------------------------------------------------
// bitwiseInverse (methodId 8) — receiver wrong-kind
// -------------------------------------------------------------------------
describe('numeric-v6 guards: bitwiseInverse receiver wrong-kind', () => {
  it('Int.bitwiseInverse(obj=Coll) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [],
      typeId: 4, methodId: 8, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Int.bitwiseInverse(Coll)')
  })

  it('Long.bitwiseInverse(obj=Coll) -> EvalError numeric-method-bad-operand (was raw TypeError)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [],
      typeId: 5, methodId: 8, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Long.bitwiseInverse(Coll)')
  })
})

// -------------------------------------------------------------------------
// bitwiseOr/And/Xor (methodIds 9/10/11) — receiver wrong-kind AND arg wrong-kind
// -------------------------------------------------------------------------
describe('numeric-v6 guards: binary bitwise receiver wrong-kind', () => {
  it('Byte.bitwiseOr(obj=Coll, Byte(1)) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [numConst('Byte', 'SByte', 1)],
      typeId: 2, methodId: 9, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Byte.bitwiseOr(Coll, Byte)')
  })

  it('Long.bitwiseAnd(obj=Coll, Long(1)) -> EvalError numeric-method-bad-operand (was raw TypeError)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [numConst('Long', 'SLong', 1n)],
      typeId: 5, methodId: 10, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Long.bitwiseAnd(Coll, Long)')
  })
})

describe('numeric-v6 guards: binary bitwise arg wrong-kind', () => {
  it('Byte.bitwiseOr(Byte(1), arg=Coll) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: numConst('Byte', 'SByte', 1),
      args: [collByteConst],
      typeId: 2, methodId: 9, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Byte.bitwiseOr(Byte, Coll)')
  })

  it('Int.bitwiseXor(Int(5), arg=Long) -> EvalError numeric-method-bad-operand', () => {
    // arg is Long SValue but method is Int — wrong kind for Int.bitwiseXor
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: numConst('Int', 'SInt', 5),
      args: [longConst(1n)],
      typeId: 4, methodId: 11, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Int.bitwiseXor(Int, Long)')
  })

  it('BigInt.bitwiseOr(BigInt(1), arg=Coll) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: numConst('BigInt', 'SBigInt', 1n),
      args: [collByteConst],
      typeId: 6, methodId: 9, explicitTypeArgs: {},
    }
    expectGuard(expr, 'BigInt.bitwiseOr(BigInt, Coll)')
  })
})

// -------------------------------------------------------------------------
// shiftLeft/shiftRight (methodIds 12/13) — receiver wrong-kind AND bits-arg wrong-kind
// -------------------------------------------------------------------------
describe('numeric-v6 guards: shift receiver wrong-kind', () => {
  it('Byte.shiftLeft(obj=Coll, bits=Int(1)) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [intConst(1)],
      typeId: 2, methodId: 12, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Byte.shiftLeft(Coll, Int)')
  })

  it('BigInt.shiftLeft(obj=Coll, bits=Int(1)) -> EvalError numeric-method-bad-operand (was raw TypeError)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [intConst(1)],
      typeId: 6, methodId: 12, explicitTypeArgs: {},
    }
    expectGuard(expr, 'BigInt.shiftLeft(Coll, Int)')
  })

  it('Long.shiftRight(obj=Coll, bits=Int(1)) -> EvalError numeric-method-bad-operand (was raw TypeError)', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: collByteConst,
      args: [intConst(1)],
      typeId: 5, methodId: 13, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Long.shiftRight(Coll, Int)')
  })
})

describe('numeric-v6 guards: shift bits-arg wrong-kind', () => {
  it('Byte.shiftLeft(Byte(1), bits=Long) -> EvalError numeric-method-bad-operand', () => {
    // bits must be Int; Long is wrong kind
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: numConst('Byte', 'SByte', 1),
      args: [longConst(1n)],
      typeId: 2, methodId: 12, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Byte.shiftLeft(Byte, bits=Long)')
  })

  it('Int.shiftRight(Int(8), bits=Coll) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: numConst('Int', 'SInt', 8),
      args: [collByteConst],
      typeId: 4, methodId: 13, explicitTypeArgs: {},
    }
    expectGuard(expr, 'Int.shiftRight(Int, bits=Coll)')
  })

  it('BigInt.shiftRight(BigInt(8), bits=Coll) -> EvalError numeric-method-bad-operand', () => {
    const expr: MethodCallExpr = {
      tag: 'MethodCall',
      obj: numConst('BigInt', 'SBigInt', 8n),
      args: [collByteConst],
      typeId: 6, methodId: 13, explicitTypeArgs: {},
    }
    expectGuard(expr, 'BigInt.shiftRight(BigInt, bits=Coll)')
  })
})
