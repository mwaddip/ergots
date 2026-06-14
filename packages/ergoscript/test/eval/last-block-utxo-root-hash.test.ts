/**
 * LastBlockUtxoRootHash — the bare dedicated-opcode form (0xa6) of the
 * CONTEXT.LastBlockUtxoRootHash property (F5 batch 4, Ask-13).
 *
 * Also: type-gate interplay with validateBinOpTypes (F5 batch 4, Ask-13 T4.5
 * minor). exprTpe returns SAvlTree for 0xa6 nodes; the pre-eval pass therefore
 * accepts EQ(0xa6, AvlTree-const) and rejects EQ(0xa6, Int-const) with zero
 * cost, matching the JVM's deserialize-time SameType gate.
 *
 * JVM (canonical): `sigma.ast.LastBlockUtxoRootHash` case object,
 * values.scala:1490-1501 — `costKind = FixedCost(JitCost(15))` (line 1495),
 * eval = `addCost(this.costKind); E.context.LastBlockUtxoRootHash`.
 *
 * Same value path as the PropertyCall form's 101:9 handler (method-call.ts):
 * reads the INDEPENDENT `EvalOpts.lastBlockUtxoRootHash` field (F5 batch 2),
 * absent ⇒ 'context-field-missing'. The cost DIFFERS by wire shape: the
 * op-form charges only the op's own FixedCost 15, while the PropertyCall
 * form observably totals 20 (4 dispatcher + 1 Context obj arm + 15 handler)
 * — pinned by the SANTA batch-2 `Context.properties.json` fixture
 * (`CONTEXT.LastBlockUtxoRootHash#dummy`).
 */
import { describe, expect, it } from 'vitest'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, captureEvalError } from '../_helpers'
import type { AvlTreeData, Expr, ErgoTree } from '../../src/mir/types'

// A representative AvlTreeData field value (distinct, non-zero digest so an
// accidental fallback to another source would be caught).
const sampleField: AvlTreeData = {
  digest: hexToBytes('01' + '00'.repeat(32)),
  treeFlags: 0b00000111,
  keyLength: 32,
  valueLengthOpt: null,
}

const TREE_BYTES = new Uint8Array([0x00, 0xa6]) // v0 header + bare op-form

describe('LastBlockUtxoRootHash op-form — field present', () => {
  it('evaluates to {kind:AvlTree, value:<the field>} at the JVM FixedCost 15', () => {
    const tree = parseTree(TREE_BYTES)
    const ctx = makeContext({ lastBlockUtxoRootHash: sampleField })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'AvlTree', value: sampleField })
    // values.scala:1495 — FixedCost(JitCost(15)); no PropertyCall envelope.
    expect(ctx.jitCost).toBe(15)
  })
})

describe('LastBlockUtxoRootHash op-form — field absent', () => {
  it('throws context-field-missing when ctx.lastBlockUtxoRootHash is undefined', () => {
    const tree = parseTree(TREE_BYTES)
    const ctx = makeContext({})
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('context-field-missing')
    // Pattern A: the op's cost 15 is charged BEFORE the field check throws —
    // same posture as the 101:9 handler and the JVM (addCost first).
    expect(ctx.jitCost).toBe(15)
  })
})

describe('LastBlockUtxoRootHash op-form — type-gate interplay', () => {
  // Helpers to build an ErgoTree directly without going through the wire parser
  // (mirrors the bin-op-sametype-strictness.test.ts pattern).
  function treeV0(body: Expr): ErgoTree {
    return {
      header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
      constantTypes: [],
      constants: [],
      body,
    }
  }
  function avlConst(v: AvlTreeData): Expr {
    return { tag: 'Const', tpe: { tag: 'SAvlTree' }, value: { kind: 'AvlTree', value: v } }
  }
  function intConst(v: number): Expr {
    return { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: v } }
  }
  const opNode: Expr = { tag: 'LastBlockUtxoRootHash' }
  function eq(l: Expr, r: Expr): Expr {
    return { tag: 'BinOp', op: { kind: 'Relation', op: 'Eq' }, left: l, right: r }
  }

  it('EQ(0xa6, AvlTree-const) evaluates (boolean) with the field set', () => {
    // exprTpe(LastBlockUtxoRootHash) = SAvlTree = exprTpe(Const{SAvlTree}) →
    // validateBinOpTypes passes; eval runs and returns Boolean.
    const ctx = makeContext({ lastBlockUtxoRootHash: sampleField })
    const value = evaluateWith(treeV0(eq(opNode, avlConst(sampleField))), ctx)
    expect(value).toEqual({ kind: 'Boolean', value: true })
  })

  it('EQ(0xa6, Int-const) throws bin-op-kind-mismatch with zero cost', () => {
    // SAvlTree vs SInt — SameType gate fires in the pre-eval pass before any
    // cost is charged (mirrors the JVM's deserialize-time ConstraintFailed).
    const ctx = makeContext({ lastBlockUtxoRootHash: sampleField })
    const err = captureEvalError(() => evaluateWith(treeV0(eq(opNode, intConst(0))), ctx))
    expect(err.code).toBe('bin-op-kind-mismatch')
    expect(ctx.jitCost).toBe(0)
  })
})
