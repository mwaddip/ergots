/**
 * ModQ, PlusModQ, MinusModQ and TaggedVariable reject when evaluated, and
 * TrueLeaf and FalseLeaf parse as the Boolean constants (facts/
 * ergoscript-eval.md, "Nodes the JVM does not evaluate"; facts/
 * ergoscript-wire.md, "The six opcodes the JVM parses").
 *
 * None of the three JVM classes overrides `eval`: `ModQ` and `ModQArithOp`
 * (ast/trees.scala:954-970) and `TaggedVariableNode` (ast/values.scala:455-460)
 * inherit the default `Value.eval`, which throws (ast/values.scala:101-102). So
 * a spend that evaluates any of the three rejects: nothing is charged and no
 * operand is evaluated. A tree that holds one in a branch the evaluator does
 * not take (the untaken side of an `If`) stays valid.
 *
 * `TrueLeaf` (0x7f) and `FalseLeaf` (0x80) parse as Boolean constants (same
 * file as the four), which the constant arm evaluates at a constant's cost
 * (ast/values.scala:771-790): they need no arm of their own, and the pair is
 * pinned here so the evaluation of all six opcodes the JVM parses is in one
 * place.
 */
import { describe, expect, it } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, parseParsedTree } from '../_helpers'
import {
  EQ,
  MinusModQ,
  ModQ,
  Plus,
  PlusModQ,
  T,
  TaggedVariable,
  bigInt,
  dead,
  int,
  treeBytes,
} from '../_helpers/mir-build'

const TRUE_PROP: SValue = { kind: 'SigmaProp', value: { tag: 'TrivialProp', value: true } }

describe('the node itself: nothing charged, no operand evaluated', () => {
  it('ModQ(Plus(1, 2))', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(ModQ(Plus(int(1), int(2))), Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
  it('PlusModQ(Plus(1, 2), 3)', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(PlusModQ(Plus(int(1), int(2)), int(3)), Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
  it('MinusModQ(3, Plus(1, 2))', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(MinusModQ(int(3), Plus(int(1), int(2))), Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
  it('TaggedVariable(1, Bool)', () => {
    const ctx = makeContext()
    const err = captureEvalError(() => evalExpr(TaggedVariable(1, T.Bool), Env.empty(), ctx))
    expect(err.code).toBe('unsupported-eval-node')
    expect(ctx.jitCost).toBe(0)
  })
})

describe('a spend that reaches one is rejected', () => {
  // SANTA's four trees in their v0 forms (SANTA vendors them as v3 sized; the
  // reject is the same, whatever the tree version — the JVM throws before it
  // reads one). The bytes are the body under a v0 plain header: BoolToSigmaProp
  // (0xd1), then EQ (0x93) with the node on the left and a BigInt 1 on the
  // right, and the node itself.
  const SPENDS: { name: string; hex: string }[] = [
    { name: 'sigmaProp(ModQ(BigInt 1) == BigInt 1)', hex: '00d193e7060101060101' },
    { name: 'sigmaProp(PlusModQ(BigInt 1, BigInt 1) == BigInt 1)', hex: '00d193e8060101060101060101' },
    { name: 'sigmaProp(MinusModQ(BigInt 1, BigInt 1) == BigInt 1)', hex: '00d193e9060101060101060101' },
    { name: 'sigmaProp(TaggedVariable(1, Bool))', hex: '00d1710101' },
  ]
  for (const { name, hex } of SPENDS) {
    it(name, () => {
      const err = captureEvalError(() => evaluate(parseParsedTree(hexToBytes(hex))))
      expect(err.code).toBe('unsupported-eval-node')
    })
  }
})

describe('a branch that is never taken does no harm', () => {
  it('dead(EQ(ModQ(BigInt 1), BigInt 1)) reduces to the true proposition', () => {
    const bytes = treeBytes(dead(EQ(ModQ(bigInt(1)), bigInt(1))), 0x00)
    expect(evaluate(parseParsedTree(bytes))).toEqual(TRUE_PROP)
  })
  it('dead(TaggedVariable(1, Bool)) reduces to the true proposition', () => {
    const bytes = treeBytes(dead(TaggedVariable(1, T.Bool)), 0x00)
    expect(evaluate(parseParsedTree(bytes))).toEqual(TRUE_PROP)
  })
})

describe('TrueLeaf and FalseLeaf are constants', () => {
  // The constant arm evaluates both at a constant's Fixed(5), as the JVM does
  // (ast/values.scala:771-790): the value and the cost of `00d17f` are those
  // of `00d10101`, and of `00d180` are those of `00d10100`.
  function evalAndCost(hex: string): { result: SValue; jitCost: number } {
    const ctx = makeContext()
    const result = evaluateWith(parseParsedTree(hexToBytes(hex)), ctx)
    return { result, jitCost: ctx.jitCost }
  }
  it('00d17f gives the same value and jitCost as 00d10101', () => {
    expect(evalAndCost('00d17f')).toEqual(evalAndCost('00d10101'))
  })
  it('00d180 gives the same value and jitCost as 00d10100', () => {
    expect(evalAndCost('00d180')).toEqual(evalAndCost('00d10100'))
  })
})
