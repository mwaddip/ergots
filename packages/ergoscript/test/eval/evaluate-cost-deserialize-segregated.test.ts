/**
 * Cost-calibration regression: segregated-tree deserialize substitute-pre-pass.
 *
 * Phase 2j-b/iter-1 RED. Aligned with the cost-drift halt site surfaced at
 * h=3850 in the 2j-a Layer-5 validation smoke
 * (`tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md`):
 * oracle 434 vs ours 410 (delta 24 = 6 × 4, one +4 per ConstPlaceholder that
 * reaches eval after substitution).
 *
 * The bug: when `treeHasDeserialize(tree)` is true, our `dispatchTreeBody`
 * (`packages/ergoscript/src/eval/evaluate.ts:97-103`) ran only
 * `substituteDeserialize` and relied on lazy `ctx.constants` lookup for any
 * surviving `ConstPlaceholder` nodes — which the `ConstPlaceholder` arm
 * charges at **1 JitCost** (`eval/const-placeholder.ts:45`, mirrors
 * sigma-rust `eval/expr.rs:52-53` `ConstantPlaceholder = Fixed(1)`).
 *
 * Sigma-rust's deserialize path (`eval.rs:205-207`) instead calls
 * `tree.proposition()` FIRST, which (when `header.is_constant_segregation()`)
 * runs `substitute_constants` (`ergo_tree.rs:248-258`,
 * `mir/expr.rs:500-514`) to eagerly rewrite EVERY `ConstPlaceholder(id)` into
 * `Const(constants[id])` BEFORE `substitute_deserialize`. The post-substitute
 * body therefore charges **5 JitCost per ex-CP** (`Const = Fixed(5)`,
 * `eval/const.ts:28`, sigma-rust `eval/expr.rs:21-23`).
 *
 * Per-CP delta: 5 - 1 = +4. The h=3850 timelock-pool tree (14 segregated
 * constants, 6 reaching eval after If short-circuit + script-bytes equality)
 * yields exactly 6 × 4 = 24 JitCost — matching the observed
 * `evaluateCost.delta`.
 *
 * Architecture context: the prior `evaluate.ts:88-95` "architectural
 * divergence" note claimed cost-equivalence on the assumption that the
 * substitute path's only consumer of `ConstPlaceholder` was the
 * `tryTrivialReduceExpr` P2PK 50-cost short-circuit (validated by
 * `dc_const_sigmaprop_inner` in `deserialize-context.json`, which never
 * reaches `evalExpr`). The general post-substitute path — a non-trivial body
 * with CPs reaching `evalExpr` — was missed and produced this 4-per-CP
 * undercharge.
 *
 * Test shape:
 *   Hand-built segregated `ErgoTree` (constructed via the public type;
 *   parsing/serializing not needed). The body is an `If` whose true branch
 *   reads a `ConstPlaceholder`; the false branch is an unresolvable
 *   `DeserializeRegister` (forces `treeHasDeserialize === true` → substitute
 *   branch) that the If short-circuit never evaluates.
 *
 * RED expectations (commit `loop(2j-b/iter-1)` produces GREEN):
 *   - Single-CP variant: cost transitions 16 → 20 (delta +4).
 *   - Three-CP variant: cost transitions 48 → 60 (delta +12 = 3 × 4),
 *     proving the linear 4-per-CP pattern that explains the h=3850 delta.
 */

import { describe, it, expect } from 'vitest'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { ErgoTree } from '../../src/mir/types'

/**
 * Minimal stub box used as `selfBox` so DeserializeRegister can read R4 (it
 * does not in these fixtures — R4 is absent and `default` is null, so the
 * substitute pass LEAVES the DR node unchanged, and the If short-circuit
 * means evaluation never touches it). Pattern copied from `synthesizeStubBox`
 * in `test/_helpers/index.ts` but inlined to keep this test self-contained.
 */
function stubBox() {
  return {
    value: 1_000_000n,
    ergoTreeBytes: new Uint8Array([0x09, 0x02, 0x01, 0x01]),
    registers: {},
    tokens: [],
    creationHeight: 0,
    txId: new Uint8Array(32),
    index: 0,
  }
}

describe('cost: segregated tree + DeserializeRegister + ConstPlaceholder reaching eval', () => {
  it('single CP — segregated body charges 5 (Const) not 1 (CP) under substitute-pre-pass', () => {
    // tree:
    //   header: segregated v0
    //   constants: [Int(42)]
    //   body: If(Const(true), CP(0:SInt), DR(R4, SInt, default=null))
    //
    // Path: `treeHasDeserialize` → substitute path.
    // - Pre-fix: substituteDeserialize leaves CP(0) intact (it only rewrites
    //   DC/DR). The DR (R4 absent, default null) stays as-is. evalExpr hits
    //   If(10) + Const(5) + CP(1) = 16. Total = 16.
    // - Post-fix: substituteConstants(body, constants, constantTypes) first
    //   rewrites CP(0) → Const(SInt, 42). substituteDeserialize then leaves
    //   that Const alone. evalExpr hits If(10) + Const(5) + Const(5) = 20.
    //   Total = 20.
    const tree: ErgoTree = {
      header: { version: 0, hasSize: false, constantSegregation: true, rawHeader: 0x10 },
      constantTypes: [{ tag: 'SInt' }],
      constants: [{ kind: 'Int', value: 42 }],
      body: {
        tag: 'If',
        condition: {
          tag: 'Const',
          tpe: { tag: 'SBoolean' },
          value: { kind: 'Boolean', value: true },
        },
        trueBranch: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SInt' } },
        falseBranch: {
          tag: 'DeserializeRegister',
          reg: 4,
          tpe: { tag: 'SInt' },
          default: null,
        },
      },
    }

    const ctx = makeContext({
      constants: tree.constants,
      treeVersion: tree.header.version,
      selfBox: stubBox(),
    })

    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'Int', value: 42 })
    expect(ctx.jitCost).toBe(20)
  })

  it('three CPs — segregated body charges +4 per CP that survives to eval', () => {
    // tree:
    //   header: segregated v0
    //   constants: [Int(42), Int(42), Int(0)]
    //   body: If(Const(true),
    //           BinOp(Plus,
    //                 BinOp(Plus, CP(0), CP(1)),  // ((42 + 42)
    //                 CP(2)),                     //  + 0) → 84
    //           DR(R4, SInt))
    //
    // Path: substitute path. Cost breakdown (sigma-rust eval order: eval
    // left, charge op envelope, eval right — see bin-op/arith.ts:96-99):
    //   Const(SBoolean,true): 5
    //   If envelope:          10
    //   CP(0):                1 (pre-fix) / 5 (post-fix)
    //   inner Plus envelope:  15 (Plus(Int) = Fixed(15), arith.ts:60)
    //   CP(1):                1 / 5
    //   outer Plus envelope:  15
    //   CP(2):                1 / 5
    // Pre-fix total:  48; post-fix total: 60 (delta +12 = 3 × 4).
    const tree: ErgoTree = {
      header: { version: 0, hasSize: false, constantSegregation: true, rawHeader: 0x10 },
      constantTypes: [{ tag: 'SInt' }, { tag: 'SInt' }, { tag: 'SInt' }],
      constants: [
        { kind: 'Int', value: 42 },
        { kind: 'Int', value: 42 },
        { kind: 'Int', value: 0 },
      ],
      body: {
        tag: 'If',
        condition: {
          tag: 'Const',
          tpe: { tag: 'SBoolean' },
          value: { kind: 'Boolean', value: true },
        },
        trueBranch: {
          tag: 'BinOp',
          op: { kind: 'Arith', op: 'Plus' },
          left: {
            tag: 'BinOp',
            op: { kind: 'Arith', op: 'Plus' },
            left: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SInt' } },
            right: { tag: 'ConstPlaceholder', id: 1, tpe: { tag: 'SInt' } },
          },
          right: { tag: 'ConstPlaceholder', id: 2, tpe: { tag: 'SInt' } },
        },
        falseBranch: {
          tag: 'DeserializeRegister',
          reg: 4,
          tpe: { tag: 'SInt' },
          default: null,
        },
      },
    }

    const ctx = makeContext({
      constants: tree.constants,
      treeVersion: tree.header.version,
      selfBox: stubBox(),
    })

    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'Int', value: 84 })
    // Post-fix: 3 CPs × 5 = 15 + 2 × Plus(15) + Const(5) + If(10) = 60.
    expect(ctx.jitCost).toBe(60)
  })
})
