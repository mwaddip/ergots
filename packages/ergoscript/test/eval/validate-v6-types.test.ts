/**
 * validateV6Types — the v6-type version gate (P2a Task 5).
 *
 * The JVM rejects a v3+-only type construct (`SUnsignedBigInt` type code 9,
 * `SFunc` type code 112) carried by a pre-V3 ErgoTree at *deserialization*.
 * ergots' parser is deliberately permissive (accepts code 9 at any version,
 * byte-roundtrip is load-bearing), so this pre-eval whole-tree pass enforces
 * the same accept/reject outcome at the `dispatchTreeBody` chokepoint —
 * keyed on the authoritative `ctx.treeVersion`, before any eval or cost.
 *
 * These adversarial vectors place a UBI construct in each surface the JVM
 * deserializes eagerly:
 *   - the body (an inline Const annotation), incl. a never-evaluated `If`
 *     branch (whole-tree, not just the taken path),
 *   - a `Coll[UBI]` body annotation (deep-walk through SColl.elem) — empty,
 *     so no UBI *value* is decoded; only its *type* reveals the construct,
 *   - the segregated constant block `tree.constantTypes[]` — a DEAD scalar
 *     UBI constant (no ConstPlaceholder references it) and an EMPTY Coll[UBI]
 *     segregated constant. These prove the constantTypes[] walk is mandatory:
 *     the JVM deserializes all segregated constants eagerly, a body-only walk
 *     misses them.
 *
 * v6 trees (version 3) carrying the same construct are accepted and evaluate
 * normally (no gate fires). Spec: docs/specs/2026-06-03-…-p2a-…-design.md §4.
 */
import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { validateV6Types } from '../../src/eval/validate-v6-types'
import type { ErgoTree, Expr, TreeHeader } from '../../src/mir/types'
import { captureEvalError } from '../_helpers'

// ── tree builders ─────────────────────────────────────────────────────────────

/** Header for a non-segregated tree at the given language version. */
function header(version: TreeHeader['version']): TreeHeader {
  return { version, hasSize: false, constantSegregation: false, rawHeader: version }
}

/** Header with constant segregation on (bit 4 set) at the given version. */
function segHeader(version: TreeHeader['version']): TreeHeader {
  return {
    version,
    hasSize: false,
    constantSegregation: true,
    rawHeader: version | 0x10,
  }
}

const ubiConst = (value: bigint): Expr => ({
  tag: 'Const',
  tpe: { tag: 'SUnsignedBigInt' },
  value: { kind: 'UnsignedBigInt', value },
})

const intConst = (value: number): Expr => ({
  tag: 'Const',
  tpe: { tag: 'SInt' },
  value: { kind: 'Int', value },
})

const boolConst = (value: boolean): Expr => ({
  tag: 'Const',
  tpe: { tag: 'SBoolean' },
  value: { kind: 'Boolean', value },
})

/** Non-segregated tree at `version` with a single UBI Const body. */
function ubiBodyTree(version: TreeHeader['version']): ErgoTree {
  return { header: header(version), constantTypes: [], constants: [], body: ubiConst(5n) }
}

// ── accept: v6 (version 3) ────────────────────────────────────────────────────

describe('validateV6Types — v6 tree (version 3) accepts the UBI construct', () => {
  it('a UBI Const body evaluates to its value (no throw, gate does not fire)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const value = evaluateWith(ubiBodyTree(3), ctx)
    expect(value).toEqual({ kind: 'UnsignedBigInt', value: 5n })
  })

  it('validateV6Types is a no-op on a version-3 tree carrying UBI (direct call)', () => {
    const tree = ubiBodyTree(3)
    expect(() => validateV6Types(tree, tree.body, 3)).not.toThrow()
  })

  it('a Coll[UBI] body annotation under version 3 is accepted', () => {
    const tree: ErgoTree = {
      header: header(3),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: { tag: 'SUnsignedBigInt' },
        items: [],
      },
    }
    expect(() => validateV6Types(tree, tree.body, 3)).not.toThrow()
  })

  it('a UBI segregated constant under version 3 is accepted', () => {
    const tree: ErgoTree = {
      header: segHeader(3),
      constantTypes: [{ tag: 'SUnsignedBigInt' }],
      constants: [{ kind: 'UnsignedBigInt', value: 7n }],
      body: intConst(0),
    }
    expect(() => validateV6Types(tree, tree.body, 3)).not.toThrow()
  })
})

// ── reject: v5 (version 2), body annotations ──────────────────────────────────

describe('validateV6Types — v5 tree (version 2) rejects the UBI construct (body)', () => {
  it('a UBI Const body rejects with v6-type-in-pre-v3-tree AND charges zero JIT cost', () => {
    const ctx = makeContext({ treeVersion: 2 })
    const err = captureEvalError(() => evaluateWith(ubiBodyTree(2), ctx))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
    // Zero-cost reject: the cost counter must be untouched by the pre-eval pass.
    expect(ctx.jitCost).toBe(0)
  })

  it('rejects via the high-level evaluate() entry (treeVersion derived from header)', () => {
    const err = captureEvalError(() => evaluate(ubiBodyTree(2)))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('UBI nested in an (empty) Coll[UBI] body annotation rejects — no UBI value decoded', () => {
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: { tag: 'SUnsignedBigInt' },
        items: [],
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('UBI nested in an Option[UBI] body annotation rejects (deep-walk SOption.elem)', () => {
    // ExtractRegisterAs carries elemTpe; Option[UBI] is reachable via the
    // SOption deep-walk too. Use a GetVar whose varTpe is Option[UBI].
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'GetVar',
        varId: 1,
        varTpe: { tag: 'SOption', elem: { tag: 'SUnsignedBigInt' } },
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('UBI nested in an STuple body annotation rejects (deep-walk STuple.items)', () => {
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'GetVar',
        varId: 1,
        varTpe: { tag: 'STuple', items: [{ tag: 'SInt' }, { tag: 'SUnsignedBigInt' }] },
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('UBI in MethodCall.explicitTypeArgs rejects (enumerator covers the type-arg map)', () => {
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'MethodCall',
        obj: intConst(0),
        typeId: 1,
        methodId: 1,
        args: [],
        explicitTypeArgs: { T: { tag: 'SUnsignedBigInt' } },
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('UBI in a FuncValue arg type rejects (FuncValue.args[].tpe)', () => {
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'FuncValue',
        args: [{ id: 1, tpe: { tag: 'SUnsignedBigInt' } }],
        body: intConst(0),
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('UBI in a never-evaluated If branch rejects (whole-tree, not just the taken path)', () => {
    // condition=true → falseBranch is never evaluated, yet its UBI annotation
    // must still reject the whole tree (matching JVM deserialize-time rejection).
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'If',
        condition: boolConst(true),
        trueBranch: intConst(1),
        falseBranch: ubiConst(2n),
      },
    }
    const ctx = makeContext({ treeVersion: 2 })
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
    expect(ctx.jitCost).toBe(0)
  })
})

// ── reject: v5 (version 2), segregated constant block ─────────────────────────

describe('validateV6Types — v5 tree rejects UBI in tree.constantTypes[] (mandatory walk)', () => {
  it('a DEAD scalar UBI segregated constant rejects (no ConstPlaceholder references it)', () => {
    // constants[0] is UBI-typed but the body never emits ConstPlaceholder(0).
    // A body-only walk would miss it; the JVM deserializes it eagerly → reject.
    const tree: ErgoTree = {
      header: segHeader(2),
      constantTypes: [{ tag: 'SUnsignedBigInt' }],
      constants: [{ kind: 'UnsignedBigInt', value: 9n }],
      body: intConst(0), // does NOT reference constants[0]
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('an EMPTY Coll[UBI] segregated constant rejects (no UBI value decoded — type-only)', () => {
    // The proof case: the segregated constant is an empty Coll[UBI]. No UBI
    // element value exists, so only its declared SType reveals the v6 construct.
    // A value-level check cannot catch it; the constantTypes[] type-walk must.
    const tree: ErgoTree = {
      header: segHeader(2),
      constantTypes: [{ tag: 'SColl', elem: { tag: 'SUnsignedBigInt' } }],
      constants: [{ kind: 'Coll', elem: { tag: 'SUnsignedBigInt' }, items: [] }],
      body: intConst(0),
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('a UBI segregated constant referenced only in a dead If branch rejects', () => {
    // The placeholder lives in a never-evaluated branch; the segregated-constant
    // walk rejects regardless of body reachability (and the body walk would too).
    const tree: ErgoTree = {
      header: segHeader(2),
      constantTypes: [{ tag: 'SUnsignedBigInt' }],
      constants: [{ kind: 'UnsignedBigInt', value: 3n }],
      body: {
        tag: 'If',
        condition: boolConst(true),
        trueBranch: intConst(1),
        falseBranch: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SUnsignedBigInt' } },
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })
})

// ── faithfulness: a valid v5 lambda must NOT false-reject ──────────────────────

describe('validateV6Types — does not false-reject a valid v5 tree', () => {
  it('a v5 tree with a first-order FuncValue (computed type SFunc, no SFunc annotation) passes', () => {
    // The lambda's *computed* type is SFunc, but no SFunc type *code* is
    // serialized for a first-order v5 lambda, and its arg types are first-order
    // (SInt here). The pass inspects serialized annotations, not computed types,
    // so it must NOT fire. Guards the §4.1 computed-vs-serialized trap.
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'FuncValue',
        args: [{ id: 1, tpe: { tag: 'SInt' } }],
        body: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
      },
    }
    expect(() => validateV6Types(tree, tree.body, 2)).not.toThrow()
  })

  it('a v5 tree with plain Int constants is untouched', () => {
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: { tag: 'BinOp', op: { kind: 'Arith', op: 'Plus' }, left: intConst(1), right: intConst(2) },
    }
    expect(() => validateV6Types(tree, tree.body, 2)).not.toThrow()
  })
})

// ── direct-call coverage of every annotation-carrying node ─────────────────────

describe('validateV6Types — per-annotation-position enumerator (v5, direct call)', () => {
  const cases: { name: string; node: Expr }[] = [
    {
      name: 'Const.tpe',
      node: ubiConst(1n),
    },
    {
      name: 'ConstPlaceholder.tpe',
      node: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SUnsignedBigInt' } },
    },
    {
      name: 'Collection.elemTpe',
      node: { tag: 'Collection', kind: 'Exprs', elemTpe: { tag: 'SUnsignedBigInt' }, items: [] },
    },
    {
      name: 'Upcast.tpe',
      node: { tag: 'Upcast', input: intConst(0), tpe: { tag: 'SUnsignedBigInt' } },
    },
    {
      name: 'Downcast.tpe',
      node: { tag: 'Downcast', input: intConst(0), tpe: { tag: 'SUnsignedBigInt' } },
    },
    {
      name: 'GetVar.varTpe',
      node: { tag: 'GetVar', varId: 1, varTpe: { tag: 'SUnsignedBigInt' } },
    },
    {
      name: 'ExtractRegisterAs.elemTpe',
      node: {
        tag: 'ExtractRegisterAs',
        input: { tag: 'GlobalVars', kind: 'SelfBox' },
        registerId: 4,
        elemTpe: { tag: 'SUnsignedBigInt' },
      },
    },
    {
      name: 'DeserializeContext.tpe',
      node: { tag: 'DeserializeContext', tpe: { tag: 'SUnsignedBigInt' }, id: 1 },
    },
    {
      name: 'DeserializeRegister.tpe',
      node: { tag: 'DeserializeRegister', reg: 4, tpe: { tag: 'SUnsignedBigInt' }, default: null },
    },
  ]

  for (const { name, node } of cases) {
    it(`${name} carrying UBI rejects under v5`, () => {
      const tree: ErgoTree = { header: header(2), constantTypes: [], constants: [], body: node }
      const err = captureEvalError(() => validateV6TypesThrow(tree))
      expect(err.code).toBe('v6-type-in-pre-v3-tree')
    })
  }
})

// ── local helper ──────────────────────────────────────────────────────────────

/**
 * Run validateV6Types at version 2 on a tree (both constantTypes[] and body),
 * for the cases asserted via captureEvalError. Mirrors how dispatchTreeBody
 * calls it (non-deserialize branch).
 */
function validateV6TypesThrow(tree: ErgoTree): void {
  validateV6Types(tree, tree.body, 2)
}
