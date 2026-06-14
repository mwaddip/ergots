import { describe, it, expect } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { exprTpe } from '../../src/mir/expr-tpe'
import type { MethodCall as MC, SType, SValue, Expr } from '../../src/mir/types'
import { groupOrder } from '../../src/crypto/secp256k1'

const SUBI: SType = { tag: 'SUnsignedBigInt' }
const v3 = () => makeContext({ treeVersion: 3 })
const ubi = (v: bigint): SValue => ({ kind: 'UnsignedBigInt', value: v })
const constOf = (tpe: SType, value: SValue): Expr => ({ tag: 'Const', tpe, value } as unknown as Expr)

/** UBI-receiver method call (typeId 9) with UBI args. */
const ubiMC = (methodId: number, recv: bigint, args: bigint[]): MC =>
  ({
    tag: 'MethodCall',
    obj: constOf(SUBI, ubi(recv)),
    args: args.map((a) => constOf(SUBI, ubi(a))),
    typeId: 9,
    methodId,
    explicitTypeArgs: {},
  } as unknown as MC)

const SBIGINT: SType = { tag: 'SBigInt' }
const big = (v: bigint): SValue => ({ kind: 'BigInt', value: v })
/** BigInt-receiver toUnsignedMod call (6:15): signed receiver, UBI modulus. */
const toUnsignedModMC = (recv: bigint, m: bigint): MC =>
  ({
    tag: 'MethodCall',
    obj: constOf(SBIGINT, big(recv)),
    args: [constOf(SUBI, ubi(m))],
    typeId: 6,
    methodId: 15,
    explicitTypeArgs: {},
  } as unknown as MC)

function expectThrow(fn: () => unknown, code: string): void {
  let threw: EvalError | undefined
  try { fn() } catch (e) { threw = e as EvalError }
  expect(threw).toBeInstanceOf(EvalError)
  expect(threw?.code).toBe(code)
}

describe('UBI.mod (9:18) — v6 P2d-1', () => {
  it('a mod m, cost 34 (4 dispatcher + 5 recv + 5 m + 20 handler)', () => {
    const c = v3()
    expect(evalMethodCall(ubiMC(18, 24n, [10n]), Env.empty(), c)).toEqual(ubi(4n))
    expect(c.jitCost).toBe(34)
  })
  it('exact multiple → 0', () => {
    expect(evalMethodCall(ubiMC(18, 24n, [24n]), Env.empty(), v3())).toEqual(ubi(0n))
  })
  it('zero dividend → 0', () => {
    expect(evalMethodCall(ubiMC(18, 0n, [10n]), Env.empty(), v3())).toEqual(ubi(0n))
  })
  it('m == 0 → arith-divide-by-zero', () => {
    expectThrow(() => evalMethodCall(ubiMC(18, 7n, [0n]), Env.empty(), v3()), 'arith-divide-by-zero')
  })
  it('m == 0: FixedCost still charged before the throw (cost-then-throw order; 4+5+5+20)', () => {
    const c = v3()
    expect(() => evalMethodCall(ubiMC(18, 7n, [0n]), Env.empty(), c)).toThrow()
    expect(c.jitCost).toBe(34)
  })
  it('wrong-kind receiver → numeric-method-bad-operand', () => {
    const bad = {
      tag: 'MethodCall',
      obj: constOf({ tag: 'SInt' }, { kind: 'Int', value: 1 } as SValue),
      args: [constOf(SUBI, ubi(10n))],
      typeId: 9,
      methodId: 18,
      explicitTypeArgs: {},
    } as unknown as MC
    expectThrow(() => evalMethodCall(bad, Env.empty(), v3()), 'numeric-method-bad-operand')
  })
  it('pre-V3 tree (treeVersion 2) → tree-version-too-low', () => {
    expectThrow(() => evalMethodCall(ubiMC(18, 24n, [10n]), Env.empty(), makeContext({ treeVersion: 2 })), 'tree-version-too-low')
  })
  it('exprTpe → SUnsignedBigInt', () => {
    expect(exprTpe(ubiMC(18, 24n, [10n]) as unknown as Expr)).toEqual(SUBI)
  })
})

describe('UBI.plusMod (9:15) — v6 P2d-1 (JVM verifyCases :2740-2752)', () => {
  it('(24).plusMod(24, 10) = 8, cost 49 (4 + 5·3 + 30)', () => {
    const c = v3()
    expect(evalMethodCall(ubiMC(15, 24n, [24n, 10n]), Env.empty(), c)).toEqual(ubi(8n))
    expect(c.jitCost).toBe(49)
  })
  it('(24).plusMod(24, 24) = 0', () => {
    expect(evalMethodCall(ubiMC(15, 24n, [24n, 24n]), Env.empty(), v3())).toEqual(ubi(0n))
  })
  it('(g).plusMod(g, g) = 0  [group order, ~2^256 operands]', () => {
    expect(evalMethodCall(ubiMC(15, groupOrder, [groupOrder, groupOrder]), Env.empty(), v3())).toEqual(ubi(0n))
  })
  it('m == 0 → arith-divide-by-zero', () => {
    expectThrow(() => evalMethodCall(ubiMC(15, 1n, [1n, 0n]), Env.empty(), v3()), 'arith-divide-by-zero')
  })
  it('wrong-kind arg → numeric-method-bad-operand', () => {
    const bad = {
      tag: 'MethodCall',
      obj: constOf(SUBI, ubi(1n)),
      args: [constOf({ tag: 'SInt' }, { kind: 'Int', value: 1 } as SValue), constOf(SUBI, ubi(10n))],
      typeId: 9, methodId: 15, explicitTypeArgs: {},
    } as unknown as MC
    expectThrow(() => evalMethodCall(bad, Env.empty(), v3()), 'numeric-method-bad-operand')
  })
  it('pre-V3 tree → tree-version-too-low', () => {
    expectThrow(() => evalMethodCall(ubiMC(15, 24n, [24n, 10n]), Env.empty(), makeContext({ treeVersion: 2 })), 'tree-version-too-low')
  })
  it('exprTpe → SUnsignedBigInt', () => {
    expect(exprTpe(ubiMC(15, 24n, [24n, 10n]) as unknown as Expr)).toEqual(SUBI)
  })
})

describe('UBI.subtractMod (9:16) — v6 P2d-1 (JVM verifyCases :2793-2802)', () => {
  it('(0).subtractMod(24, 10) = 6  [Euclidean underflow: (0-24) mod 10], cost 49', () => {
    const c = v3()
    expect(evalMethodCall(ubiMC(16, 0n, [24n, 10n]), Env.empty(), c)).toEqual(ubi(6n))
    expect(c.jitCost).toBe(49)
  })
  it('(24).subtractMod(24, 24) = 0', () => {
    expect(evalMethodCall(ubiMC(16, 24n, [24n, 24n]), Env.empty(), v3())).toEqual(ubi(0n))
  })
  it('deeper underflow: (3).subtractMod(20, 7) = 4  [(3-20) mod 7 = -17 mod 7 = 4]', () => {
    expect(evalMethodCall(ubiMC(16, 3n, [20n, 7n]), Env.empty(), v3())).toEqual(ubi(4n))
  })
  it('m == 0 → arith-divide-by-zero', () => {
    expectThrow(() => evalMethodCall(ubiMC(16, 24n, [10n, 0n]), Env.empty(), v3()), 'arith-divide-by-zero')
  })
  it('exprTpe → SUnsignedBigInt', () => {
    expect(exprTpe(ubiMC(16, 0n, [24n, 10n]) as unknown as Expr)).toEqual(SUBI)
  })
})

describe('UBI.multiplyMod (9:17) — v6 P2d-1 (JVM verifyCases :2843-2849)', () => {
  it('(g).multiplyMod(g, g) = 0  [group order], cost 59 (4 + 5·3 + 40)', () => {
    const c = v3()
    expect(evalMethodCall(ubiMC(17, groupOrder, [groupOrder, groupOrder]), Env.empty(), c)).toEqual(ubi(0n))
    expect(c.jitCost).toBe(59)
  })
  it('(7).multiplyMod(8, 10) = 6  [(7*8) mod 10 = 56 mod 10]', () => {
    expect(evalMethodCall(ubiMC(17, 7n, [8n, 10n]), Env.empty(), v3())).toEqual(ubi(6n))
  })
  it('m == 0 → arith-divide-by-zero', () => {
    expectThrow(() => evalMethodCall(ubiMC(17, 7n, [8n, 0n]), Env.empty(), v3()), 'arith-divide-by-zero')
  })
  it('exprTpe → SUnsignedBigInt', () => {
    expect(exprTpe(ubiMC(17, 7n, [8n, 10n]) as unknown as Expr)).toEqual(SUBI)
  })
})

describe('BigInt.toUnsignedMod (6:15) — v6 P2d-1 (JVM verifyCases :2466-2472)', () => {
  it('(50).toUnsignedMod(10) = 0, cost 29 (4 + 5 recv + 5 m + 15 handler)', () => {
    const c = v3()
    expect(evalMethodCall(toUnsignedModMC(50n, 10n), Env.empty(), c)).toEqual(ubi(0n))
    expect(c.jitCost).toBe(29)
  })
  it('(50).toUnsignedMod(0) → arith-divide-by-zero  [JVM: ArithmeticException "modulus not positive"]', () => {
    expectThrow(() => evalMethodCall(toUnsignedModMC(50n, 0n), Env.empty(), v3()), 'arith-divide-by-zero')
  })
  it('negative receiver: (-7).toUnsignedMod(10) = 3  [signed receiver, Euclidean — code accepts negatives]', () => {
    expect(evalMethodCall(toUnsignedModMC(-7n, 10n), Env.empty(), v3())).toEqual(ubi(3n))
  })
  it('wrong-kind receiver (not BigInt) → numeric-method-bad-operand', () => {
    const bad = {
      tag: 'MethodCall',
      obj: constOf(SUBI, ubi(50n)), // UBI, not BigInt
      args: [constOf(SUBI, ubi(10n))],
      typeId: 6, methodId: 15, explicitTypeArgs: {},
    } as unknown as MC
    expectThrow(() => evalMethodCall(bad, Env.empty(), v3()), 'numeric-method-bad-operand')
  })
  it('pre-V3 tree → tree-version-too-low', () => {
    expectThrow(() => evalMethodCall(toUnsignedModMC(50n, 10n), Env.empty(), makeContext({ treeVersion: 2 })), 'tree-version-too-low')
  })
  it('exprTpe → SUnsignedBigInt', () => {
    expect(exprTpe(toUnsignedModMC(50n, 10n) as unknown as Expr)).toEqual(SUBI)
  })
})

describe('UBI.modInverse (9:14) — v6 P2d-2 (JVM verifyCases :2874-2880; BasicOps :590-628)', () => {
  it('(12).modInverse(5) = 3, cost 164 (4 dispatcher + 5 recv + 5 m + 150 handler)', () => {
    const c = v3()
    expect(evalMethodCall(ubiMC(14, 12n, [5n]), Env.empty(), c)).toEqual(ubi(3n))
    expect(c.jitCost).toBe(164)
  })
  it('(3).modInverse(7) = 5  [3·5 = 15 ≡ 1 mod 7]', () => {
    expect(evalMethodCall(ubiMC(14, 3n, [7n]), Env.empty(), v3())).toEqual(ubi(5n))
  })
  it('m == 0 → arith-divide-by-zero  [JVM: ArithmeticException "modulus not positive"]', () => {
    expectThrow(() => evalMethodCall(ubiMC(14, 7n, [0n]), Env.empty(), v3()), 'arith-divide-by-zero')
  })
  it('m == 0: FixedCost still charged before the throw (cost-then-throw; 4+5+5+150)', () => {
    const c = v3()
    expect(() => evalMethodCall(ubiMC(14, 7n, [0n]), Env.empty(), c)).toThrow()
    expect(c.jitCost).toBe(164)
  })
  it('gcd(a,m) != 1 → unsigned-bigint-not-invertible  [(2).modInverse(4): gcd=2]', () => {
    expectThrow(() => evalMethodCall(ubiMC(14, 2n, [4n]), Env.empty(), v3()), 'unsigned-bigint-not-invertible')
  })
  it('m == 1 → 0  [trivial ring; falls out of the algorithm, no special-case branch]', () => {
    expect(evalMethodCall(ubiMC(14, 5n, [1n]), Env.empty(), v3())).toEqual(ubi(0n))
  })
  it('a == 0, m > 1 → unsigned-bigint-not-invertible  [gcd(0,5)=5]', () => {
    expectThrow(() => evalMethodCall(ubiMC(14, 0n, [5n]), Env.empty(), v3()), 'unsigned-bigint-not-invertible')
  })
  it('large 256-bit operand: a·modInverse(a, n) ≡ 1 (mod n)  [n = secp256k1 order, prime]', () => {
    const a = 2n ** 255n - 19n
    const inv = (evalMethodCall(ubiMC(14, a, [groupOrder]), Env.empty(), v3()) as { value: bigint }).value
    expect((a * inv) % groupOrder).toBe(1n)
  })
  it('wrong-kind receiver → numeric-method-bad-operand', () => {
    const bad = {
      tag: 'MethodCall',
      obj: constOf({ tag: 'SInt' }, { kind: 'Int', value: 1 } as SValue),
      args: [constOf(SUBI, ubi(5n))],
      typeId: 9, methodId: 14, explicitTypeArgs: {},
    } as unknown as MC
    expectThrow(() => evalMethodCall(bad, Env.empty(), v3()), 'numeric-method-bad-operand')
  })
  it('pre-V3 tree (treeVersion 2) → tree-version-too-low', () => {
    expectThrow(() => evalMethodCall(ubiMC(14, 12n, [5n]), Env.empty(), makeContext({ treeVersion: 2 })), 'tree-version-too-low')
  })
  it('exprTpe → SUnsignedBigInt', () => {
    expect(exprTpe(ubiMC(14, 12n, [5n]) as unknown as Expr)).toEqual(SUBI)
  })
})
