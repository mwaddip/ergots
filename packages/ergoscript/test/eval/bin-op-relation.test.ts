/**
 * BinOp.Relation family — fixture-driven evaluation tests.
 *
 * Covers all six relational ops:
 *   - Ordering (Lt/Le/Gt/Ge): numeric types only; Fixed(20) envelope cost.
 *   - Equality (Eq/NEq): all SValue kinds; no envelope cost (cost charged
 *     inside sValueEquals, mirroring sigma-rust's eq_with_cost).
 *
 * Ordering cost per sigma-rust bin_op.rs:205-211:
 *   BinOpKind::Relation(op) => match op {
 *       RelationOp::Eq | RelationOp::NEq => {}  // cost charged inside eq_with_cost
 *       _ => { ctx.add_jit_cost(20)?; }  // LT, LE, GT, GE = Fixed(20)
 *   }
 * Total for Const+Const ordering: 20 (envelope) + 5 (left) + 5 (right) = 30.
 *
 * Equality cost (data_value_comparer.rs):
 *   Primitives (Boolean/Byte/Short/Int/Long): EQ_PRIM_COST=3 → total = 5+5+3 = 13.
 *   BigInt: EQ_BIGINT_COST=5 → total = 5+5+5 = 15.
 *   GroupElement: EQ_GROUP_ELEMENT_COST=172 → total = 5+5+172 = 182.
 *   Unit/SigmaProp/cross-type: catch-all → EQ_PRIM_COST=3 → total = 13.
 *   Coll: COLL_MATCH_TYPE_COST=1 + (if same length) per-item bulk cost.
 *
 * Error cases:
 *   - 'bin-op-not-numeric': non-numeric operand for ordering op (e.g. Boolean).
 *   - 'bin-op-kind-mismatch': left and right are different numeric kinds for ordering op.
 *
 * Option equality is NOT in the fixture file (Literal::Opt requires ErgoTree v3+
 * for serialization; our fixture format uses v0). It is tested below via direct
 * unit tests that construct SValues without going through the serialization round-trip.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/bin_op.rs,
 *                 ergotree-interpreter/src/eval/data_value_comparer.rs
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { captureEvalError, hexToBytes, hydrateSValue } from '../_helpers'
import { sValueEquals, sTypeEquals } from '../../src/eval/bin-op/relation'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/bin-op-relation.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: any
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

describe('BinOp.Relation family — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: ${entry.expected_error_code ?? 'value + cost'}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ jitCostLimit: entry.opts_json.jitCostLimit })
      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})

// ---------------------------------------------------------------------------
// sValueEquals unit tests: Option[Int] (not fixture-driven due to v0 tree limit)
// ---------------------------------------------------------------------------
// These directly call sValueEquals to verify Option equality semantics without
// going through the serialize/parse/evaluate pipeline.
// EQ_OPTION_COST = 4 per data_value_comparer.rs:19; total for None/None or
// None/Some: 4 (no inner recurse on mismatch). For Some/Some: 4 + EQ_PRIM_COST(3) = 7.

describe('sValueEquals — Option[Int] (unit tests, no fixture)', () => {
  it('None == None → true, cost 4', () => {
    const ctx = makeContext()
    const none = { kind: 'Option' as const, elem: { tag: 'SInt' as const }, value: null }
    const result = sValueEquals(none, none, ctx)
    expect(result).toBe(true)
    expect(ctx.jitCost).toBe(4)
  })

  it('Some(5) == Some(5) → true, cost 7', () => {
    const ctx = makeContext()
    const some5 = { kind: 'Option' as const, elem: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 5 } }
    const result = sValueEquals(some5, some5, ctx)
    expect(result).toBe(true)
    expect(ctx.jitCost).toBe(7)
  })

  it('Some(5) == Some(6) → false, cost 7', () => {
    const ctx = makeContext()
    const some5 = { kind: 'Option' as const, elem: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 5 } }
    const some6 = { kind: 'Option' as const, elem: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 6 } }
    const result = sValueEquals(some5, some6, ctx)
    expect(result).toBe(false)
    expect(ctx.jitCost).toBe(7)
  })

  it('None == Some(5) → false, cost 4', () => {
    const ctx = makeContext()
    const none = { kind: 'Option' as const, elem: { tag: 'SInt' as const }, value: null }
    const some5 = { kind: 'Option' as const, elem: { tag: 'SInt' as const }, value: { kind: 'Int' as const, value: 5 } }
    const result = sValueEquals(none, some5, ctx)
    expect(result).toBe(false)
    expect(ctx.jitCost).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// sTypeEquals unit tests
// ---------------------------------------------------------------------------
describe('sTypeEquals', () => {
  it('SInt === SInt', () => expect(sTypeEquals({ tag: 'SInt' }, { tag: 'SInt' })).toBe(true))
  it('SInt !== SLong', () => expect(sTypeEquals({ tag: 'SInt' }, { tag: 'SLong' })).toBe(false))
  it('SColl(SInt) === SColl(SInt)', () => expect(sTypeEquals(
    { tag: 'SColl', elem: { tag: 'SInt' } },
    { tag: 'SColl', elem: { tag: 'SInt' } },
  )).toBe(true))
  it('SColl(SInt) !== SColl(SLong)', () => expect(sTypeEquals(
    { tag: 'SColl', elem: { tag: 'SInt' } },
    { tag: 'SColl', elem: { tag: 'SLong' } },
  )).toBe(false))
  it('SOption(SBoolean) === SOption(SBoolean)', () => expect(sTypeEquals(
    { tag: 'SOption', elem: { tag: 'SBoolean' } },
    { tag: 'SOption', elem: { tag: 'SBoolean' } },
  )).toBe(true))
  it('STypeVar("T") === STypeVar("T")', () => expect(sTypeEquals(
    { tag: 'STypeVar', name: 'T' },
    { tag: 'STypeVar', name: 'T' },
  )).toBe(true))
  it('STypeVar("T") !== STypeVar("IV")', () => expect(sTypeEquals(
    { tag: 'STypeVar', name: 'T' },
    { tag: 'STypeVar', name: 'IV' },
  )).toBe(false))
})
