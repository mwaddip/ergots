/**
 * AvlTree arm order — the cost charge fires before the array cast.
 *
 * The JVM runs each `.toArray` cast inside an `addSeqCost` envelope that
 * charges first, casts second:
 *   `createVerifier(tree, proof)` (`CErgoTreeEvaluator.scala:70-75`):
 *     `addSeqCost(CreateAvlVerifier_Info, proof.length) { CAvlTreeVerifier.apply }`
 *   `CAvlTreeVerifier.apply` (`CAvlTreeVerifier.scala:55-60`):
 *     `proof.toArray`           — cast #1 (inside Create envelope)
 *     `treeData.digest.toArray` — cast #2 (also inside Create envelope)
 *   Each per-op `addSeqCost(<OpInfo>, treeHeight) { ... }`
 *     `performLookup(ADKey @@ key.toArray)` etc. — cast #3 (per-op envelope)
 *
 * So a wrong-class proof under a tight cost limit refuses with
 * `'cost-limit-exceeded'` (the Create charge trips) rather than
 * `'coll-class-cast'` (the cast would trip on a roomy limit).
 *
 * For `AvlTree.contains` and `AvlTree.get` the arm runs one lookup op, so
 * the per-op charge also fires before the key cast. Both pairs are tested
 * here. For `AvlTree.getMany` / `AvlTree.remove` (batch lookups and
 * removes) and the entry-based `AvlTree.insert` / `AvlTree.update` /
 * `AvlTree.insertOrUpdate`, the per-op charge is summed after the batch
 * verifier runs (the verifier takes all cast keys / entries as its input);
 * only the Create charge is before the proof cast.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { tupleColl } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, specColl } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const COLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }
const COLL_COLL_BYTE: SType = { tag: 'SColl', elem: COLL_BYTE }
const PAIR_BYTES: SType = { tag: 'STuple', items: [COLL_BYTE, COLL_BYTE] }
const COLL_PAIR_BYTES: SType = { tag: 'SColl', elem: PAIR_BYTES }
const SAVLTREE: SType = { tag: 'SAvlTree' }

function byteItems(bytes: number[]): SValue[] {
  return bytes.map(
    (b) => ({ kind: 'Byte', value: (b << 24) >> 24 }) as SValue,
  )
}

function specByteColl(bytes: number[]): SValue {
  return specColl(SBYTE, byteItems(bytes))
}

function tupleOfBytes(bytes: number[]): SValue {
  return tupleColl(byteItems(bytes))
}

function anAvlTree(): SValue {
  return {
    kind: 'AvlTree',
    value: {
      digest: new Uint8Array(33),
      treeFlags: 0b00000111,
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
}

function getVarGet(varId: number, tpe: SType): Expr {
  return { tag: 'OptionGet', input: { tag: 'GetVar', varId, varTpe: tpe } }
}

/** A single-element one-byte proof whose Create charge is
 * `addPerItemCost(110, 20, 64, 1)` = 110 + chunks(1) × 20 = 110 + 20 = 130. */
const CREATE_CHARGE_ONE_BYTE_PROOF = 130

/** A single-item Lookup charge on a tree whose height is 0 (a dummy tree
 * that fails verification) is `addPerItemCost(40, 10, 1, 0)` = 40 + chunks(0) ×
 * 10 = 40 + 10 = 50. */
const LOOKUP_CHARGE_HEIGHT_ZERO = 50

function runWithVars(
  expr: Expr,
  vars: Array<{ varId: number; tpe: SType; value: SValue }>,
  jitCostLimit: number,
): SValue {
  const map = new Map<number, { tpe: SType; value: SValue }>()
  for (const v of vars) map.set(v.varId, { tpe: v.tpe, value: v.value })
  const ctx = makeContext({
    treeVersion: 3,
    jitCostLimit,
    extension: { values: map },
  })
  return evalExpr(expr, Env.empty(), ctx)
}

function expectCode(
  fn: () => unknown,
  code: 'cost-limit-exceeded' | 'coll-class-cast',
): void {
  const err = captureEvalError(fn)
  expect(err.code).toBe(code)
}

// ---------------------------------------------------------------------------
// AvlTree.contains — one-op arm; Create and Lookup charges both before casts.
// ---------------------------------------------------------------------------

describe('AvlTree.contains — the proof cast fires inside the Create cost envelope', () => {
  const makeExpr = (): Expr => ({
    tag: 'MethodCall',
    obj: {
      tag: 'OptionGet',
      input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE },
    },
    typeId: 100,
    methodId: 9,
    args: [
      { tag: 'Const', tpe: COLL_BYTE, value: specByteColl([0]) },
      getVarGet(1, COLL_BYTE),
    ],
    explicitTypeArgs: {},
  })

  it("a wrong-class proof under a tight cost limit refuses with 'cost-limit-exceeded'", () => {
    // Limit below the Create charge of 130: the charge trips before the cast.
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          CREATE_CHARGE_ONE_BYTE_PROOF - 1,
        ),
      'cost-limit-exceeded',
    )
  })

  it("a wrong-class proof under a roomy cost limit refuses with 'coll-class-cast'", () => {
    // Limit above the Create charge: the charge passes, then the cast refuses.
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          10_000,
        ),
      'coll-class-cast',
    )
  })
})

describe('AvlTree.contains — the key cast fires inside the Lookup cost envelope', () => {
  const makeExpr = (): Expr => ({
    tag: 'MethodCall',
    obj: {
      tag: 'OptionGet',
      input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE },
    },
    typeId: 100,
    methodId: 9,
    args: [
      getVarGet(1, COLL_BYTE),
      { tag: 'Const', tpe: COLL_BYTE, value: specByteColl([0]) },
    ],
    explicitTypeArgs: {},
  })

  it("a wrong-class key under a limit that covers Create but not Lookup refuses with 'cost-limit-exceeded'", () => {
    const limit = CREATE_CHARGE_ONE_BYTE_PROOF + LOOKUP_CHARGE_HEIGHT_ZERO - 1
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          limit,
        ),
      'cost-limit-exceeded',
    )
  })

  it("a wrong-class key under a roomy limit refuses with 'coll-class-cast'", () => {
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          10_000,
        ),
      'coll-class-cast',
    )
  })
})

// ---------------------------------------------------------------------------
// AvlTree.get — one-op arm; Create and Lookup charges both before casts.
// ---------------------------------------------------------------------------

describe('AvlTree.get — the proof cast fires inside the Create cost envelope', () => {
  const makeExpr = (): Expr => ({
    tag: 'MethodCall',
    obj: {
      tag: 'OptionGet',
      input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE },
    },
    typeId: 100,
    methodId: 10,
    args: [
      { tag: 'Const', tpe: COLL_BYTE, value: specByteColl([0]) },
      getVarGet(1, COLL_BYTE),
    ],
    explicitTypeArgs: {},
  })

  it("a wrong-class proof under a tight cost limit refuses with 'cost-limit-exceeded'", () => {
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          CREATE_CHARGE_ONE_BYTE_PROOF - 1,
        ),
      'cost-limit-exceeded',
    )
  })

  it("a wrong-class proof under a roomy cost limit refuses with 'coll-class-cast'", () => {
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          10_000,
        ),
      'coll-class-cast',
    )
  })
})

describe('AvlTree.get — the key cast fires inside the Lookup cost envelope', () => {
  const makeExpr = (): Expr => ({
    tag: 'MethodCall',
    obj: {
      tag: 'OptionGet',
      input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE },
    },
    typeId: 100,
    methodId: 10,
    args: [
      getVarGet(1, COLL_BYTE),
      { tag: 'Const', tpe: COLL_BYTE, value: specByteColl([0]) },
    ],
    explicitTypeArgs: {},
  })

  it("a wrong-class key under a limit that covers Create but not Lookup refuses with 'cost-limit-exceeded'", () => {
    const limit = CREATE_CHARGE_ONE_BYTE_PROOF + LOOKUP_CHARGE_HEIGHT_ZERO - 1
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          limit,
        ),
      'cost-limit-exceeded',
    )
  })
})

// ---------------------------------------------------------------------------
// AvlTree.getMany — batch; Create charge before proof cast; per-key cast
// is after per-op charge (the batch verifier takes all cast keys at once,
// so the arm's per-op cost sums after the verifier runs).
// ---------------------------------------------------------------------------

describe('AvlTree.getMany — the proof cast fires inside the Create cost envelope', () => {
  const makeExpr = (): Expr => ({
    tag: 'MethodCall',
    obj: {
      tag: 'OptionGet',
      input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE },
    },
    typeId: 100,
    methodId: 11,
    args: [
      {
        tag: 'Const',
        tpe: COLL_COLL_BYTE,
        value: specColl(COLL_BYTE, [specByteColl([0])]),
      },
      getVarGet(1, COLL_BYTE),
    ],
    explicitTypeArgs: {},
  })

  it("a wrong-class proof under a tight cost limit refuses with 'cost-limit-exceeded'", () => {
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          CREATE_CHARGE_ONE_BYTE_PROOF - 1,
        ),
      'cost-limit-exceeded',
    )
  })

  it("a wrong-class proof under a roomy cost limit refuses with 'coll-class-cast'", () => {
    expectCode(
      () =>
        runWithVars(
          makeExpr(),
          [
            { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
            { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
          ],
          10_000,
        ),
      'coll-class-cast',
    )
  })
})

// ---------------------------------------------------------------------------
// AvlTree.remove / AvlTree.insert / AvlTree.update / AvlTree.insertOrUpdate
// — batch arms. Each takes a proof; the Create charge fires before the
// proof cast.
// ---------------------------------------------------------------------------

describe.each([
  { name: 'AvlTree.remove', methodId: 14, arg1Tpe: COLL_COLL_BYTE, arg1Value: specColl(COLL_BYTE, [specByteColl([0])]) },
  {
    name: 'AvlTree.insert',
    methodId: 12,
    arg1Tpe: COLL_PAIR_BYTES,
    arg1Value: specColl(PAIR_BYTES, [{ kind: 'Tuple', items: [specByteColl([0]), specByteColl([0])] }]),
  },
  {
    name: 'AvlTree.update',
    methodId: 13,
    arg1Tpe: COLL_PAIR_BYTES,
    arg1Value: specColl(PAIR_BYTES, [{ kind: 'Tuple', items: [specByteColl([0]), specByteColl([0])] }]),
  },
  {
    name: 'AvlTree.insertOrUpdate',
    methodId: 16,
    arg1Tpe: COLL_PAIR_BYTES,
    arg1Value: specColl(PAIR_BYTES, [{ kind: 'Tuple', items: [specByteColl([0]), specByteColl([0])] }]),
  },
])(
  '$name — the proof cast fires inside the Create cost envelope',
  (m) => {
    const makeExpr = (): Expr => ({
      tag: 'MethodCall',
      obj: {
        tag: 'OptionGet',
        input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE },
      },
      typeId: 100,
      methodId: m.methodId,
      args: [
        { tag: 'Const', tpe: m.arg1Tpe, value: m.arg1Value },
        getVarGet(1, COLL_BYTE),
      ],
      explicitTypeArgs: {},
    })

    // Insert and update charge isInsertAllowed_Info / isUpdateAllowed_Info
    // first (Fixed(15) each; insertOrUpdate charges both). Tight limit is
    // Create's threshold on top of that.
    const preCharge =
      m.methodId === 12 ? 15 : m.methodId === 13 ? 15 : m.methodId === 16 ? 30 : m.methodId === 14 ? 15 : 0
    const tightLimit = preCharge + CREATE_CHARGE_ONE_BYTE_PROOF - 1

    it("a wrong-class proof under a tight cost limit refuses with 'cost-limit-exceeded'", () => {
      expectCode(
        () =>
          runWithVars(
            makeExpr(),
            [
              { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
              { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
            ],
            tightLimit,
          ),
        'cost-limit-exceeded',
      )
    })

    it("a wrong-class proof under a roomy cost limit refuses with 'coll-class-cast'", () => {
      expectCode(
        () =>
          runWithVars(
            makeExpr(),
            [
              { varId: 1, tpe: COLL_BYTE, value: tupleOfBytes([0]) },
              { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
            ],
            10_000,
          ),
        'coll-class-cast',
      )
    })
  },
)
