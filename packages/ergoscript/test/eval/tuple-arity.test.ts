/**
 * Tuple EXPR arity gate — JVM values.scala:795-808.
 *
 * The v5.0+ JVM evaluator supports only pairs: `if (items.length != 2)
 * syntax.error(s"Invalid tuple $this")`, thrown BEFORE any item is evaluated
 * and BEFORE the Fixed(15) envelope. Inline tuple-N constants at
 * non-checkType'd positions evaluate on both sides; at checkType'd positions
 * the JVM rejects (Value.checkType, values.scala:801,804) — residual
 * over-accept tracked as the F5 checkType-class ledger item, NOT pinned here.
 *
 * Arity-0/1 EXPR trees become parseable in the wire-window task (the JVM
 * parses them too); their eval-reject pins live there to keep this task's
 * suite green at every commit.
 */
import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, captureEvalError } from '../_helpers'

describe('Tuple eval arity gate (values.scala:795-808)', () => {
  it('arity-3 Tuple EXPR throws tuple-invalid-arity before charging any cost', () => {
    const tree = parseTree(hexToBytes('0086030101020703a413'))
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    const costBefore = ctx.jitCost
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('tuple-invalid-arity')
    // values.scala order: the arity error fires before item eval AND before
    // the Fixed(15) envelope — the Tuple arm contributes zero cost.
    expect(ctx.jitCost).toBe(costBefore)
  })

  it('arity-2 Tuple still evaluates (regression)', () => {
    // Derive from the arity-3 tree: count byte 03→02, drop the SShort
    // constant bytes (03a413): v0 + OP_TUPLE(0x86) count 2 + true + 7.toByte.
    const tree = parseTree(hexToBytes('00860201010207'))
    const ctx = makeContext({ treeVersion: 0, constants: tree.constants })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({
      kind: 'Tuple',
      items: [
        { kind: 'Boolean', value: true },
        { kind: 'Byte', value: 7 },
      ],
    })
  })
})
