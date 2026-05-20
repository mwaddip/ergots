/**
 * SAvlTree.updateOperations (100:8) — Tier-2 mutator op handler.
 *
 * Fixture-driven oracle suite (T2/T3 of phase 2h-d) + edge-case + mutation
 * suite (T4). The handler at `src/eval/savltree.ts:588-604` is Pattern A
 * Fixed(45): `ctx.addCost(45)` runs BEFORE the AvlTree shape check and
 * BEFORE the Byte arg-kind check, so cost-limit-exceeded fires at the
 * handler entry even on shape-failing inputs (verified in the cost-limit
 * test below).
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:77-88 — UPDATE_OPERATIONS_EVAL_FN.
 *
 * Mutation block migrated to shared harness in Phase 2h-e (mutation-harness.ts).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import type { MethodCall, SValue } from '../../src/mir/types'
import { captureEvalError, hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import { runMutationLoop, evalSafely, DEFAULT_KILL_THRESHOLD } from '../_helpers/mutation-harness'

interface UpdateOperationsEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface UpdateOperationsFixture {
  corpus: string
  entries: UpdateOperationsEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update-operations.json')
const fixture: UpdateOperationsFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.updateOperations (100:8) — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

// ---------------------------------------------------------------------------
// Edge cases (T4 — defensive throws via the dispatcher)
//
// Mirror the receiver-defense / arg-shape-defense patterns from
// test/eval/method-call.test.ts (the canonical template in this codebase for
// hand-crafted MethodCall edge-case tests). Each builds a `MethodCall` MIR
// expr with a typeId=100, methodId=8 routing to evalSAvlTreeUpdateOperations,
// then calls `evalMethodCall` directly to drive the dispatcher's full cost
// path (Pattern A: addCost(4) dispatcher + addCost(5) Const obj + addCost(5)
// Const arg + addCost(45) handler = 59 before any shape check).
// ---------------------------------------------------------------------------

/**
 * Fresh hand-crafted AvlTreeData carrier (matches the fixture's digest +
 * flags). Reused across edge cases that need a real SAvlTree-typed Const.
 */
function makeAvlTreeConstValue(): SValue {
  return {
    kind: 'AvlTree',
    value: {
      digest: new Uint8Array(33).fill(0x42),
      treeFlags: 7,
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
}

describe('SAvlTree.updateOperations — edge cases', () => {
  it("throws 'avl-tree-obj-not-avl-tree' on non-AvlTree receiver", () => {
    // obj is a Long Const — evalExpr yields { kind: 'Long' }, which fails
    // expectAvlTree (savltree.ts:71-81) → 'avl-tree-obj-not-avl-tree'.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 8,
      obj: { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 42n } },
      args: [
        { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 5 } },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('avl-tree-obj-not-avl-tree')
    expect(err.message).toContain('SAvlTree.updateOperations')
    // Pattern A: cost charged BEFORE shape check. 4 + 5 + 5 + 45 = 59.
    expect(ctx.jitCost).toBe(59)
  })

  it("throws 'method-not-implemented' when arg is not Byte", () => {
    // args[0] is a Long Const — evalExpr yields { kind: 'Long' }, which fails
    // the args[0]!.kind !== 'Byte' check (savltree.ts:596-601) →
    // 'method-not-implemented'.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 8,
      obj: {
        tag: 'Const',
        tpe: { tag: 'SAvlTree' },
        value: makeAvlTreeConstValue(),
      },
      args: [
        { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 5n } },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('method-not-implemented')
    expect(err.message).toContain('Byte')
    // 4 + 5 + 5 + 45 = 59 (Pattern A; shape check runs after addCost(45)).
    expect(ctx.jitCost).toBe(59)
  })

  it("throws 'cost-limit-exceeded' if jitCostLimit < 59 (Pattern A charges before shape check)", () => {
    // Verify the addCost(45) charge fires BEFORE any shape check — even on a
    // would-be-failing receiver, cost-limit-exceeded wins because cost is
    // first. Set jitCostLimit=50: dispatcher 4 + Const obj 5 + Const arg 5
    // = 14, then handler addCost(45) → 59 > 50 → 'cost-limit-exceeded'.
    // The receiver is intentionally a Long (would-fail receiver-defense),
    // demonstrating that cost trips first.
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 100,
      methodId: 8,
      obj: { tag: 'Const', tpe: { tag: 'SLong' }, value: { kind: 'Long', value: 42n } },
      args: [
        { tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 5 } },
      ],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({ jitCostLimit: 50 })
    const err = captureEvalError(() => evalMethodCall(e, Env.empty(), ctx))
    expect(err).toBeInstanceOf(EvalError)
    expect(err.code).toBe('cost-limit-exceeded')
  })
})

// ---------------------------------------------------------------------------
// Mutation testing (T4 — single-byte XOR mutations across tree_bytes_hex)
//
// Pattern mirrors test/eval/savltree-mutation.test.ts (Tier-2 verification-op
// mutation suite) at a smaller scope: updateOperations has no proof, so the
// mutation surface is the FULL tree_bytes_hex, not just an embedded
// Coll[Byte] proof region. Three XOR patterns per byte (0xFF, 0x01, 0x80);
// kill iff outcome diverges from baseline (throws, or returns a different
// SValue). Target ≥ 90% kill rate; tolerated mutations enumerated below.
//
// Tolerated (survived) mutations — observed for update_operations_drop_update_bit
// (44-byte tree, 132 mutations, 127 killed, 5 survived → rate 0.962):
//   - offset 0 (header byte, 0x00), xor 0x01 → 0x01 (v1 header): parses identically;
//     no constants section to validate, body is unchanged.
//   - offset 0 (header byte, 0x00), xor 0x80 → 0x80 (reserved bit set): parser
//     tolerates the reserved bit; body is unchanged.
//   - offset 38 (treeFlags=0x07 in AvlTree const), xor 0xff/0x01/0x80 → 0xf8/0x06/0x87:
//     updateOperations REPLACES the receiver's treeFlags with args[0] (0x05),
//     so input flags are discarded — mutating them is semantically invisible.
//     This is the load-bearing tolerance: handler-by-design, not a bug.
//
// Harness extracted to test/_helpers/mutation-harness.ts in Phase 2h-e.
// ---------------------------------------------------------------------------

describe('SAvlTree.updateOperations — mutation testing', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on whole-tree byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)

      // Precondition: the unmutated baseline must succeed. The harness uses
      // the same baseline internally; this explicit check provides a clean
      // failure message when the handler itself regresses (vs a confusing
      // 'kill rate < 90%' diagnostic).
      const baseline = evalSafely(treeBytes, entry.opts_json)
      expect(baseline.ok).toBe(true)

      const result = runMutationLoop({
        treeBytes,
        region: { start: 0, end: treeBytes.length },
        optsJson: entry.opts_json,
      })

      // eslint-disable-next-line no-console
      console.log(
        `[mutation] updateOperations.${entry.name}: killed=${result.killed} ` +
          `total=${result.total} rate=${result.rate.toFixed(3)} bytes=${treeBytes.length}`,
      )
      expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
    })
  }
})
