/**
 * Nodes the JVM does not evaluate (docs/specs/2026-09-30-jvm-node-construction-design.md §9).
 *
 * The JVM 6.0.6 gives a raw `BitOp` (all six: BitOr, BitAnd, BitXor, BitShiftLeft, BitShiftRight,
 * BitShiftRightZeroed) and `BitInversion` no `eval`. Neither class overrides it (trees.scala:898-917, and
 * the companions at :923-942 carry a cost kind only), so the default `Value.eval` runs and throws
 * `sys.error("Should be overriden ...")` (values.scala:101-102). A spend that evaluates one is rejected, at tree
 * v0 and at v3, whatever its operands: the throw comes before either operand is evaluated and before any
 * cost is charged. A tree that holds one only in a branch that is never evaluated stays valid.
 *
 * ergots followed sigma-rust and evaluated BitOr, BitAnd, BitXor and BitInversion (an over-accept), and
 * threw 'not-implemented-yet' for the three shifts. All seven nodes now reject with `'unsupported-eval-node'`
 * (the code CreateAvlTree and TreeLookup already use), charged nothing, with no operand evaluated.
 * `SigmaPropIsProven` also has no JVM eval; ergots already rejected it without evaluating its operand,
 * under its own code 'sigma-prop-is-proven-no-eval', which stays.
 *
 * The v6 method forms of the same operations (`Int.bitwiseOr` 4:9 and the rest) are method calls with their
 * own handlers, which the JVM evaluates. They are the controls: unchanged.
 *
 * Every JVM verdict below is a local sigma-state 6.0.6 probe, spend mode (the tree parsed by the box rules,
 * then `ErgoLikeInterpreter.fullReduction` over SELF with no R4 unless the case needs one). A row is one probe
 * line: its name, the tree's version, its bytes, and the verdict the probe printed:
 *   - `rej(.., klass)`: rejected at reduce with `java.lang.RuntimeException: Should be overriden in class
 *     sigma.ast.<klass>` (for `twin-...-divzero`, `java.lang.ArithmeticException: / by zero`, the method's operand);
 *   - `acc(.., sigma, cost)`: reduced to `sigma`, at the probe's block cost (the JIT cost ÷ 10).
 */
import { describe, expect, it } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { BitOp, ConstPlaceholder, CreateAvlTree, Expr, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, parseParsedTree } from '../_helpers'
import { MC, OptionGet, PC, Plus, SigmaPropIsProven, T, TreeLookup, ValUse, bin, int, sp } from '../_helpers/mir-build'

type Probed = {
  name: string
  version: number
  hex: string
  verdict: { reject: string } | { sigma: 'TrueProp' | 'FalseProp'; blockCost: number }
}
const rej = (name: string, version: number, hex: string, reject: string): Probed => ({ name, version, hex, verdict: { reject } })
const acc = (name: string, version: number, hex: string, sigma: 'TrueProp' | 'FalseProp', blockCost: number): Probed => ({
  name,
  version,
  hex,
  verdict: { sigma, blockCost },
})

// ─── The probed trees ──────────────────────────────────────────────────────────────────────────────────────
// `BitOr` .. `BitShiftRightZeroed` and `BitInv` are the basic forms, over Int operands. The rest add other operand
// kinds, mismatched operands, nested nodes, operands that would throw differently, and the other positions in
// which the node is live (the taken If branch, the right side of a || whose left side is false, a ^, the body of a
// lambda that is applied, the right-hand side of a ValDef, which is evaluated eagerly whether it is used or not).
// The dead-branch rows add the positions that are never evaluated: a lambda over an empty collection is never applied.

const RAW_BIT_NODES: Probed[] = [
  rej('BitOr', 0, '00d193f2040204040406', 'BitOp'),
  rej('BitOr', 3, '0b09d193f2040204040406', 'BitOp'),
  rej('BitAnd', 0, '00d193f3040604020402', 'BitOp'),
  rej('BitAnd', 3, '0b09d193f3040604020402', 'BitOp'),
  rej('BitXor', 0, '00d193f5040204060404', 'BitOp'),
  rej('BitXor', 3, '0b09d193f5040204060404', 'BitOp'),
  rej('BitShiftLeft', 0, '00d193f7040204020404', 'BitOp'),
  rej('BitShiftLeft', 3, '0b09d193f7040204020404', 'BitOp'),
  rej('BitShiftRight', 0, '00d193f6040804020404', 'BitOp'),
  rej('BitShiftRight', 3, '0b09d193f6040804020404', 'BitOp'),
  rej('BitShiftRightZeroed', 0, '00d193f8040804020404', 'BitOp'),
  rej('BitShiftRightZeroed', 3, '0b09d193f8040804020404', 'BitOp'),
  rej('BitInv', 0, '00d193f104020403', 'BitInversion'),
  rej('BitInv', 3, '0b07d193f104020403', 'BitInversion'),
  rej('BitInv-byte', 0, '00d193f1020102fe', 'BitInversion'),
  rej('BitInv-byte', 3, '0b07d193f1020102fe', 'BitInversion'),
  rej('BitInv-bigint', 0, '00d193f10601010601fe', 'BitInversion'),
  rej('BitInv-bigint', 3, '0b09d193f10601010601fe', 'BitInversion'),
  rej('BitOr-byte', 0, '00d193f2020102020203', 'BitOp'),
  rej('BitOr-byte', 3, '0b09d193f2020102020203', 'BitOp'),
  rej('BitOr-bigint', 0, '00d193f2060101060102060103', 'BitOp'),
  rej('BitOr-bigint', 3, '0b0cd193f2060101060102060103', 'BitOp'),
  rej('BitAnd-IntLong-mismatch', 0, '00d193f3040205020402', 'BitOp'),
  rej('BitAnd-IntLong-mismatch', 3, '0b09d193f3040205020402', 'BitOp'),
  rej('BitShiftLeft-LongInt', 0, '00d193f7050204020504', 'BitOp'),
  rej('BitShiftLeft-LongInt', 3, '0b09d193f7050204020504', 'BitOp'),
  rej('BitOr-nested', 0, '00d193f2f2040204040408040e', 'BitOp'),
  rej('BitOr-nested', 3, '0b0cd193f2f2040204040408040e', 'BitOp'),
  rej('BitOr-operand-divzero', 0, '00d193f29d0402040004020402', 'BitOp'),
  rej('BitOr-operand-divzero', 3, '0b0cd193f29d0402040004020402', 'BitOp'),
  rej('BitOr-rightoperand-divzero', 0, '00d193f204029d040204000402', 'BitOp'),
  rej('BitOr-rightoperand-divzero', 3, '0b0cd193f204029d040204000402', 'BitOp'),
  rej('BitInv-operand-divzero', 0, '00d193f19d040204000400', 'BitInversion'),
  rej('BitInv-operand-divzero', 3, '0b0ad193f19d040204000400', 'BitInversion'),
  rej('BitOr-operand-optionget-none', 3, '0b0ad193f2e4280004020402', 'BitOp'),
  rej('BitInv-operand-optionget-none', 3, '0b08d193f1e428000400', 'BitInversion'),
  rej('If-true-BitOr', 0, '00d195010193f20402040404060100', 'BitOp'),
  rej('If-true-BitOr', 3, '0b0ed195010193f20402040404060100', 'BitOp'),
  rej('BinOr-left-false-then-BitOr', 0, '00d1ec010093f2040204040406', 'BitOp'),
  rej('BinOr-left-false-then-BitOr', 3, '0b0cd1ec010093f2040204040406', 'BitOp'),
  rej('BinXor-BitOr', 0, '00d1f4010093f2040204040406', 'BitOp'),
  rej('BinXor-BitOr', 3, '0b0cd1f4010093f2040204040406', 'BitOp'),
  rej('exists-nonempty', 0, '00d1ae100102d901010493f2720104020402', 'BitOp'),
  rej('exists-nonempty', 3, '0b11d1ae100102d901010493f2720104020402', 'BitOp'),
  rej('forall-nonempty', 0, '00d1af10020204d901010493f2720104020402', 'BitOp'),
  rej('forall-nonempty', 3, '0b12d1af10020204d901010493f2720104020402', 'BitOp'),
  rej('map-nonempty', 0, '00d193b1ad100102d9010104f2720104020402', 'BitOp'),
  rej('map-nonempty', 3, '0b12d193b1ad100102d9010104f2720104020402', 'BitOp'),
  rej('exists-BitInv', 0, '00d1ae100102d901010493f172010400', 'BitInversion'),
  rej('exists-BitInv', 3, '0b0fd1ae100102d901010493f172010400', 'BitInversion'),
  rej('ValDef-unused', 0, '00d1d801d601f2040204040101', 'BitOp'),
  rej('ValDef-unused', 3, '0b0cd1d801d601f2040204040101', 'BitOp'),
  rej('ValDef-unused-BitInv', 0, '00d1d801d601f104020101', 'BitInversion'),
  rej('ValDef-unused-BitInv', 3, '0b0ad1d801d601f104020101', 'BitInversion'),
]

const ALREADY_REJECTED: Probed[] = [
  rej('IsProven', 0, '00d1cfd10101', 'SigmaPropIsProven'),
  rej('TreeLookup', 0, '00d1e6b7e4c6a704640e01010e00', 'TreeLookup'),
  rej('IsProven', 3, '0b05d1cfd10101', 'SigmaPropIsProven'),
  rej('CreateAvlTree', 3,
    '0b56d193b602070e2100000000000000000000000000000000000000000000000000000000000000000004402800b602070e2100000000000000000000000000000000000000000000000000000000000000000004402800', 'CreateAvlTree'),
  rej('TreeLookup', 3, '0b0dd1e6b7e4c6a704640e01010e00', 'TreeLookup'),
]

const DEAD_BRANCH: Probed[] = [
  acc('dead-BitOr', 0, '00d195010093f20402040404060101', 'TrueProp', 3),
  acc('dead-BitOr', 3, '0b0ed195010093f20402040404060101', 'TrueProp', 3),
  acc('dead-BitAnd', 0, '00d195010093f30406040204020101', 'TrueProp', 3),
  acc('dead-BitAnd', 3, '0b0ed195010093f30406040204020101', 'TrueProp', 3),
  acc('dead-BitXor', 0, '00d195010093f50402040604040101', 'TrueProp', 3),
  acc('dead-BitXor', 3, '0b0ed195010093f50402040604040101', 'TrueProp', 3),
  acc('dead-BitShiftLeft', 0, '00d195010093f70402040204040101', 'TrueProp', 3),
  acc('dead-BitShiftLeft', 3, '0b0ed195010093f70402040204040101', 'TrueProp', 3),
  acc('dead-BitShiftRight', 0, '00d195010093f60408040204040101', 'TrueProp', 3),
  acc('dead-BitShiftRight', 3, '0b0ed195010093f60408040204040101', 'TrueProp', 3),
  acc('dead-BitShiftRightZeroed', 0, '00d195010093f80408040204040101', 'TrueProp', 3),
  acc('dead-BitShiftRightZeroed', 3, '0b0ed195010093f80408040204040101', 'TrueProp', 3),
  acc('dead-BitInv', 0, '00d195010093f1040204030101', 'TrueProp', 3),
  acc('dead-BitInv', 3, '0b0cd195010093f1040204030101', 'TrueProp', 3),
  acc('dead-IsProven', 0, '00d1950100cfd101010101', 'TrueProp', 3),
  acc('dead-IsProven', 3, '0b0ad1950100cfd101010101', 'TrueProp', 3),
  acc('dead-CreateAvlTree', 3,
    '0b5bd195010093b602070e2100000000000000000000000000000000000000000000000000000000000000000004402800b602070e21000000000000000000000000000000000000000000000000000000000000000000044028000101', 'TrueProp', 3),
  acc('dead-TreeLookup', 0, '00d1950100e6b7e4c6a704640e01010e000101', 'TrueProp', 3),
  acc('dead-TreeLookup', 3, '0b12d1950100e6b7e4c6a704640e01010e000101', 'TrueProp', 3),
  acc('dead-BinOr-short-circuit', 0, '00d1ec010193f2040204040406', 'TrueProp', 4),
  acc('dead-BinOr-short-circuit', 3, '0b0cd1ec010193f2040204040406', 'TrueProp', 4),
  acc('dead-BinAnd-short-circuit', 0, '00d1ed010093f2040204040406', 'FalseProp', 4),
  acc('dead-BinAnd-short-circuit', 3, '0b0cd1ed010093f2040204040406', 'FalseProp', 4),
  acc('dead-BinOr-short-circuit-BitInv', 0, '00d1ec010193f104020403', 'TrueProp', 4),
  acc('dead-BinOr-short-circuit-BitInv', 3, '0b0ad1ec010193f104020403', 'TrueProp', 4),
  acc('dead-exists-empty', 0, '00d1ae1000d901010493f2720104020402', 'FalseProp', 2),
  acc('dead-exists-empty', 3, '0b10d1ae1000d901010493f2720104020402', 'FalseProp', 2),
  acc('dead-forall-empty', 0, '00d1af1000d901010493f2720104020402', 'TrueProp', 2),
  acc('dead-forall-empty', 3, '0b10d1af1000d901010493f2720104020402', 'TrueProp', 2),
  acc('dead-map-empty', 0, '00d193b1ad1000d9010104f2720104020400', 'TrueProp', 6),
  acc('dead-map-empty', 3, '0b11d193b1ad1000d9010104f2720104020400', 'TrueProp', 6),
  acc('dead-exists-empty-BitInv', 0, '00d1ae1000d901010493f172010400', 'FalseProp', 2),
  acc('dead-exists-empty-BitInv', 3, '0b0ed1ae1000d901010493f172010400', 'FalseProp', 2),
]

const METHOD_TWINS: Probed[] = [
  acc('twin-Int.bitwiseOr-4:9', 3, '0b0cd193dc040904020104040406', 'TrueProp', 4),
  acc('twin-Int.bitwiseAnd-4:10', 3, '0b0cd193dc040a04060104020402', 'TrueProp', 4),
  acc('twin-Int.bitwiseXor-4:11', 3, '0b0cd193dc040b04020104060404', 'TrueProp', 4),
  acc('twin-Int.shiftLeft-4:12', 3, '0b0cd193dc040c04020104020404', 'TrueProp', 4),
  acc('twin-Int.shiftRight-4:13', 3, '0b0cd193dc040d04080104020404', 'TrueProp', 4),
  acc('twin-Int.bitwiseInverse-4:8', 3, '0b09d193db040804020403', 'TrueProp', 3),
  acc('twin-BigInt.bitwiseOr-6:9', 3, '0b0fd193dc060906010101060102060103', 'TrueProp', 4),
]

const TWIN_OPERAND_EVALUATED: Probed[] = [
  rej('twin-Int.bitwiseOr-operand-divzero', 3, '0b0fd193dc04099d040204000104040406', 'ArithmeticException'),
]

// ─── Builders ──────────────────────────────────────────────────────────────────────────────────────────────

const BIT_OPS: BitOp[] = ['BitOr', 'BitAnd', 'BitXor', 'BitShiftLeft', 'BitShiftRight', 'BitShiftRightZeroed']
const bit = (op: BitOp, l: Expr, r: Expr): Expr => bin({ kind: 'Bit', op }, l, r)
const bitInversion = (input: Expr): Expr => ({ tag: 'BitInversion', input })
const noneInt: Expr = { tag: 'Const', tpe: T.Option(T.Int), value: { kind: 'Option', elem: T.Int, value: null } }
const bigint = (n: bigint): Expr => ({ tag: 'Const', tpe: { tag: 'SBigInt' }, value: { kind: 'BigInt', value: n } })
const createAvlTree = (operand: Expr): CreateAvlTree => ({
  tag: 'CreateAvlTree',
  flags: operand,
  digest: operand,
  keyLength: operand,
  valueLength: operand,
})

/** Operands that throw a different code if they are evaluated. */
const divZero = bin({ kind: 'Arith', op: 'Divide' }, int(1), int(0)) // 'arith-divide-by-zero'
const optionGetNone = OptionGet(noneInt) // 'option-empty'
const unboundValUse = ValUse(99, T.Int) // 'val-use-unbound'
const unboundPlaceholder: ConstPlaceholder = { tag: 'ConstPlaceholder', id: 7, tpe: T.Int } // 'const-placeholder-no-constants'
/** An operand that evaluates fine and charges: Const 5 + Const 5 + Plus. */
const costly = Plus(int(1), int(2))
const THROWING: [string, Expr][] = [
  ['a division by zero', divZero],
  ['OptionGet over None', optionGetNone],
  ['an unbound ValUse', unboundValUse],
  ['an unbound ConstPlaceholder', unboundPlaceholder],
]

const treeOf = (p: Probed) => {
  const tree = parseParsedTree(hexToBytes(p.hex))
  expect(tree.header.version).toBe(p.version)
  return tree
}

// ─── The tests ─────────────────────────────────────────────────────────────────────────────────────────────

describe('raw BitOp and BitInversion nodes reject when evaluated (the JVM gives them no eval)', () => {
  for (const p of RAW_BIT_NODES) {
    const reject = 'reject' in p.verdict ? p.verdict.reject : ''
    it(`${p.name} at v${p.version}: the JVM rejects at reduce ("Should be overriden in ${reject}")`, () => {
      const err = captureEvalError(() => evaluate(treeOf(p)))
      expect(err.code).toBe('unsupported-eval-node')
    })
  }
})

describe('the node itself: nothing charged, no operand evaluated', () => {
  for (const op of BIT_OPS) {
    for (const [what, operand] of THROWING) {
      it(`${op} with ${what} as its left operand`, () => {
        const ctx = makeContext()
        const err = captureEvalError(() => evalExpr(bit(op, operand, int(1)), Env.empty(), ctx))
        expect(err.code).toBe('unsupported-eval-node')
        expect(ctx.jitCost).toBe(0)
      })
      it(`${op} with ${what} as its right operand`, () => {
        const ctx = makeContext()
        const err = captureEvalError(() => evalExpr(bit(op, int(1), operand), Env.empty(), ctx))
        expect(err.code).toBe('unsupported-eval-node')
        expect(ctx.jitCost).toBe(0)
      })
    }
    it(`${op} over operands that evaluate and charge`, () => {
      const ctx = makeContext()
      const err = captureEvalError(() => evalExpr(bit(op, costly, costly), Env.empty(), ctx))
      expect(err.code).toBe('unsupported-eval-node')
      expect(ctx.jitCost).toBe(0)
    })
    it(`${op} over nested BitOps`, () => {
      const ctx = makeContext()
      const err = captureEvalError(() => evalExpr(bit(op, bit('BitOr', int(1), int(2)), int(3)), Env.empty(), ctx))
      expect(err.code).toBe('unsupported-eval-node')
      expect(ctx.jitCost).toBe(0)
    })
  }

  for (const [what, operand] of THROWING) {
    it(`BitInversion with ${what} as its operand`, () => {
      const ctx = makeContext()
      const err = captureEvalError(() => evalExpr(bitInversion(operand), Env.empty(), ctx))
      expect(err.code).toBe('unsupported-eval-node')
      expect(ctx.jitCost).toBe(0)
    })
  }
  it('BitInversion over an operand that evaluates and charges', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(bitInversion(costly), Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
  it('the rejection does not depend on the tree version in the context', () => {
    for (const treeVersion of [0, 1, 2, 3]) {
      const ctx = makeContext({ treeVersion })
      expect(captureEvalError(() => evalExpr(bit('BitOr', int(1), int(2)), Env.empty(), ctx)).code).toBe('unsupported-eval-node')
      expect(captureEvalError(() => evalExpr(bitInversion(int(1)), Env.empty(), ctx)).code).toBe('unsupported-eval-node')
      expect(ctx.jitCost).toBe(0)
    }
  })
})

describe('the nodes that already rejected keep their codes (pinned)', () => {
  const CODE: Record<string, string> = {
    SigmaPropIsProven: 'sigma-prop-is-proven-no-eval',
    TreeLookup: 'unsupported-eval-node',
    CreateAvlTree: 'unsupported-eval-node',
  }
  for (const p of ALREADY_REJECTED) {
    const reject = 'reject' in p.verdict ? p.verdict.reject : ''
    it(`${p.name} at v${p.version}: the JVM rejects at reduce ("Should be overriden in ${reject}")`, () => {
      const err = captureEvalError(() => evaluate(treeOf(p)))
      expect(err.code).toBe(CODE[reject])
    })
  }

  it('SigmaPropIsProven: its own code, nothing charged, the operand not evaluated', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(SigmaPropIsProven(sp(optionGetNone)), Env.empty(), ctx))
    expect(err.code).toBe('sigma-prop-is-proven-no-eval')
    expect(ctx.jitCost).toBe(0)
  })
  it('TreeLookup: nothing charged, no operand evaluated', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(TreeLookup(optionGetNone, divZero, unboundValUse), Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
  it('CreateAvlTree: nothing charged, no operand evaluated', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(createAvlTree(divZero), Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
})

describe('a node the JVM does not evaluate, in a position that is never evaluated, stays valid', () => {
  for (const p of DEAD_BRANCH) {
    const v = p.verdict
    it(`${p.name} at v${p.version}: the JVM reduces to ${'sigma' in v ? v.sigma : '?'}`, () => {
      if (!('sigma' in v)) throw new Error('a dead-branch case is an acceptance')
      const tree = treeOf(p)
      const ctx = makeContext()
      expect(evaluateWith(tree, ctx)).toEqual({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: v.sigma === 'TrueProp' } })
      // The JVM's block cost is the JIT cost ÷ 10: no node in the dead position was charged.
      expect(Math.floor(ctx.jitCost / 10)).toBe(v.blockCost)
    })
  }
})

describe('the v6 method forms still evaluate (control)', () => {
  for (const p of METHOD_TWINS) {
    const v = p.verdict
    it(`${p.name} at v${p.version}: the JVM reduces to ${'sigma' in v ? v.sigma : '?'}`, () => {
      if (!('sigma' in v)) throw new Error('a method twin is an acceptance')
      const ctx = makeContext()
      expect(evaluateWith(treeOf(p), ctx)).toEqual({ kind: 'SigmaProp', value: { tag: 'TrivialProp', value: v.sigma === 'TrueProp' } })
      expect(Math.floor(ctx.jitCost / 10)).toBe(v.blockCost)
    })
  }

  const v3 = () => makeContext({ treeVersion: 3 })
  const TWIN_VALUES: [string, Expr, SValue][] = [
    ['Int.bitwiseOr 4:9 (1, 2)', MC(4, 9, int(1), [int(2)]), { kind: 'Int', value: 3 }],
    ['Int.bitwiseAnd 4:10 (3, 1)', MC(4, 10, int(3), [int(1)]), { kind: 'Int', value: 1 }],
    ['Int.bitwiseXor 4:11 (1, 3)', MC(4, 11, int(1), [int(3)]), { kind: 'Int', value: 2 }],
    ['Int.shiftLeft 4:12 (1, 1)', MC(4, 12, int(1), [int(1)]), { kind: 'Int', value: 2 }],
    ['Int.shiftRight 4:13 (4, 1)', MC(4, 13, int(4), [int(1)]), { kind: 'Int', value: 2 }],
    ['Int.bitwiseInverse 4:8 (1)', PC(4, 8, int(1)), { kind: 'Int', value: -2 }],
    ['BigInt.bitwiseOr 6:9 (1, 2)', MC(6, 9, bigint(1n), [bigint(2n)]), { kind: 'BigInt', value: 3n }],
  ]
  for (const [name, expr, value] of TWIN_VALUES) {
    it(`${name} evaluates to its value`, () => {
      expect(evalExpr(expr, Env.empty(), v3())).toEqual(value)
    })
  }
  it('the same operands: the BitOr node rejects, Int.bitwiseOr evaluates', () => {
    expect(captureEvalError(() => evalExpr(bit('BitOr', int(1), int(2)), Env.empty(), v3())).code).toBe('unsupported-eval-node')
    expect(evalExpr(MC(4, 9, int(1), [int(2)]), Env.empty(), v3())).toEqual({ kind: 'Int', value: 3 })
  })
  for (const p of TWIN_OPERAND_EVALUATED) {
    const reject = 'reject' in p.verdict ? p.verdict.reject : ''
    it(`${p.name} at v${p.version}: the method evaluates its operands (the JVM: ${reject})`, () => {
      const err = captureEvalError(() => evaluate(treeOf(p)))
      expect(err.code).toBe('arith-divide-by-zero')
    })
  }
})
