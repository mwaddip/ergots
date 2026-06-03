/**
 * validateV6Types — the v6-type version gate (P2a Task 5 + Task 6).
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
 * Task 6 adds the parallel SFunc-112 closure vectors (see §5 of the P2a
 * spec): a serialized SFunc type annotation in a pre-V3 tree must be rejected
 * by the same pass; a v6 tree carrying it must be accepted; a v5 first-order
 * lambda (whose *computed* type is SFunc but whose wire bytes carry no code
 * 112) must NOT be false-rejected.
 *
 * v6 trees (version 3) carrying the same construct are accepted and evaluate
 * normally (no gate fires). Spec: docs/specs/2026-06-03-…-p2a-…-design.md §4.
 */
import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import { validateV6Types } from '../../src/eval/validate-v6-types'
import type { ErgoTree, Expr, SType, TreeHeader } from '../../src/mir/types'
import { serializeSType } from '../../src/wire/serialize-stype'
import { captureEvalError } from '../_helpers'
import { ByteWriter } from '@ergots/scorex'

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

// ── validateV6Types — SFunc-112 v5 over-accept closure (P2a Task 6) ──────────
//
// SFunc (wire type code 112) is a v3+-only construct, gated by the JVM at
// TypeSerializer.scala:211 under `isV3OrLaterErgoTreeVersion`. A pre-V3 tree
// carrying a serialized SFunc type annotation is JVM-rejected at deserialization
// → the same `validateV6Types` pass that covers UBI also covers SFunc
// (`containsV6Type` returns true for `SFunc`, `SUnsignedBigInt`). These tests
// prove the closure is in place (no src change needed — the pass already walks
// for SFunc) and guard the §4.1 computed-vs-serialized trap: a v5 first-order
// lambda whose *computed* type is SFunc must NOT be false-rejected.
//
// Construction: SFunc is placed at annotation positions that `annotationsOf`
// enumerates (GetVar.varTpe, Collection.elemTpe, tree.constantTypes[]). The
// tests first assert that the serialized type bytes actually contain code 112
// (byte 0x70) — if that invariant breaks the tests prove nothing.

/** A simple SFunc type: (SInt) => SBoolean, no tpe-params. */
const sfuncIntToBool: SType = {
  tag: 'SFunc',
  args: [{ tag: 'SInt' }],
  result: { tag: 'SBoolean' },
  tpeParams: [],
}

/**
 * Serialize `sfuncIntToBool` into bytes. Used to confirm code 112 is
 * present before the rejection tests run (if serializeSType changes, fail
 * here — the vectors below would no longer prove wire-code 112 rejection).
 */
function sfuncBytes(): Uint8Array {
  const w = new ByteWriter()
  serializeSType(sfuncIntToBool, w)
  return w.toBytes()
}

describe('validateV6Types — SFunc-112 v5 over-accept closure', () => {
  // ── byte-presence guard ──────────────────────────────────────────────────
  it('serializeSType(SFunc(SInt→SBoolean)) produces byte 112 (0x70) — vector validity guard', () => {
    // SFunc wire: [112, t_dom_len=1, SInt=4, t_range=SBoolean=1, tpe_params_len=0]
    const bytes = sfuncBytes()
    expect(bytes[0]).toBe(112) // TYPE_CODE_SFUNC
    expect(bytes[1]).toBe(1) // t_dom_len
    expect(bytes[2]).toBe(4) // SInt
    expect(bytes[3]).toBe(1) // SBoolean
    expect(bytes[4]).toBe(0) // tpe_params_len
    expect(bytes.length).toBe(5)
  })

  it('Coll[SFunc(SInt→SBoolean)] serializes with byte 112 inside the element type', () => {
    // serializeSColl: embeddablePrimitiveCode(SFunc)=null, not SColl → writes
    // COLL_TYPECODE(12) then serializeSType(SFunc) → byte 12 then 112.
    const w = new ByteWriter()
    serializeSType({ tag: 'SColl', elem: sfuncIntToBool }, w)
    const bytes = w.toBytes()
    expect(bytes[0]).toBe(12) // COLL_TYPECODE
    expect(bytes[1]).toBe(112) // SFunc type code — the wire annotation
  })

  // ── reject: v5 (version 2) — body annotations ───────────────────────────

  it('v5 tree: GetVar.varTpe = SFunc(SInt→SBoolean) rejects with v6-type-in-pre-v3-tree', () => {
    // GetVar.varTpe is a wire-serialized annotation (parseSType populates it).
    // annotationsOf(GetVar) = [e.varTpe]; containsV6Type({tag:'SFunc'}) = true.
    // The bytes contain code 112 (per the guard above). JVM: TypeSerializer
    // encounters 112 under a pre-V3 tree → check-type-code ⇒ reject.
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'GetVar',
        varId: 1,
        varTpe: sfuncIntToBool,
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  it('v5 tree: Coll[SFunc] elemTpe annotation rejects (deep-walk SColl.elem)', () => {
    // The SFunc is nested inside an SColl.elem annotation — containsV6Type
    // recurses into SColl.elem and hits SFunc. The Collection is empty so no
    // SFunc *value* is decoded; the type annotation alone triggers the gate.
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'Collection',
        kind: 'Exprs',
        elemTpe: sfuncIntToBool,
        items: [],
      },
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  // ── reject: v5 — segregated constant block ───────────────────────────────

  it('v5 tree: dead SFunc-typed segregated constant rejects (constantTypes[] walk mandatory)', () => {
    // constants[0] is SFunc-typed but the body never emits ConstPlaceholder(0).
    // A body-only walk would miss it; the constantTypes[] walk catches it.
    // Parallels the UBI dead-segregated-constant test (Task 5).
    const tree: ErgoTree = {
      header: segHeader(2),
      constantTypes: [sfuncIntToBool],
      constants: [],
      body: intConst(0),
    }
    const err = captureEvalError(() => validateV6TypesThrow(tree))
    expect(err.code).toBe('v6-type-in-pre-v3-tree')
  })

  // ── accept: v6 (version 3) ───────────────────────────────────────────────

  it('v6 tree (version 3): GetVar.varTpe = SFunc is accepted — gate is no-op for treeVersion >= 3', () => {
    // validateV6Types returns immediately for treeVersion >= 3; no rejection.
    const tree: ErgoTree = {
      header: header(3),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'GetVar',
        varId: 1,
        varTpe: sfuncIntToBool,
      },
    }
    expect(() => validateV6Types(tree, tree.body, 3)).not.toThrow()
  })

  // ── no false-reject: v5 first-order lambda ───────────────────────────────

  it('v5 tree with a Map over a non-empty Coll — first-order FuncValue passes (no code-112 in wire bytes)', () => {
    // A v5 map whose mapper arg type is first-order (SInt). The *computed*
    // type of the FuncValue is SFunc(SInt→SInt), but no SFunc TYPE CODE is
    // serialized: the wire carries only the FuncValue.args[].tpe = SInt (code 4).
    // The pass reads wire-serialized annotations only (§4.1); the computed type
    // is never checked. This guards the distinct trap from the Task 5 companion
    // (which used a bare FuncValue) by exercising a Map structure that actually
    // evaluates through a lambda body — a realistic v5 tree shape.
    const tree: ErgoTree = {
      header: header(2),
      constantTypes: [],
      constants: [],
      body: {
        tag: 'Map',
        input: {
          tag: 'Const',
          tpe: { tag: 'SColl', elem: { tag: 'SInt' } },
          value: {
            kind: 'Coll',
            elem: { tag: 'SInt' },
            items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }],
          },
        },
        mapper: {
          tag: 'FuncValue',
          // arg type SInt = code 4; no SFunc code 112 anywhere in wire bytes
          args: [{ id: 1, tpe: { tag: 'SInt' } }],
          body: { tag: 'ValUse', valId: 1, tpe: { tag: 'SInt' } },
        },
      },
    }
    // The pass must NOT throw v6-type-in-pre-v3-tree.
    expect(() => validateV6Types(tree, tree.body, 2)).not.toThrow()
  })
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
