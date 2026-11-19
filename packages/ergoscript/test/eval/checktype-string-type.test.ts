/**
 * `assertCheckedType` refuses an `SString`-typed checked node, as the JVM's
 * `isValueOfType` does (`SType.scala:187-213`: the `case _` throw at `:212`
 * fires for `SString`, which has no arm).
 *
 * The 6.0.7 probe at
 * `.superpowers/sdd/2026-11-19-collection-value-model-stage-2/final-review-probe/batch2.out`
 * line 1 rejects `sigmaProp("a" == "a")` (`0b08d193660161660161`) at reduce
 * with `java.lang.RuntimeException: Unknown type SString`: the EQ node's
 * operand type check is one of the `Value.checkType` sites
 * (`trees.scala:1204-1210`), and the operand's `exprTpe` is `SString`.
 *
 * The control: a `String` constant that no `Value.checkType` site reads
 * (evaluated at the top level, where `evalExpr` for a `Const` makes no
 * `checkType` call) still returns its value.
 */
import { describe, it, expect } from 'vitest'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'
import { captureEvalError, hexToBytes, parseParsedTree } from '../_helpers'

describe("assertCheckedType on SString (SType.scala:212, case _ throws 'Unknown type SString')", () => {
  it("sigmaProp(\"a\" == \"a\") refuses at reduce with 'unsupported-value-type' (6.0.7 probe batch2.out line 1)", () => {
    // 0b08d193660161660161 — v3, SSigmaProp, EQ of two SString constants.
    // The EQ's operand is a Value.checkType site (trees.scala:1204-1210),
    // whose isValueOfType call throws on SString (SType.scala:212).
    const tree = parseParsedTree(hexToBytes('0b08d193660161660161'))
    const ctx = makeContext({ treeVersion: tree.header.version, constants: tree.constants })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('unsupported-value-type')
  })

  it("a String constant evaluated at the top level returns its value (no Value.checkType site above it)", () => {
    // A Const(SString, "hello") at the top of evalExpr makes no checkType
    // call: assertCheckedType runs only at the checked sites listed under
    // "The checkType sites" in facts/ergoscript-eval.md ("Tuples and non-pair
    // tuple values"). The value is returned as the runtime String SValue.
    const stringConst: Expr = {
      tag: 'Const',
      tpe: { tag: 'SString' },
      value: { kind: 'String', value: 'hello' },
    }
    const ctx = makeContext({ treeVersion: 3 })
    const value = evalExpr(stringConst, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'String', value: 'hello' })
  })
})
