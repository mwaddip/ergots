/**
 * exprTpe arms for Or, Xor, Atleast (phase 2j-pre fix-3).
 *
 * Foundation 2-of-3 multisig at h=3850 tx#2 input 0 trips
 * `case 'Atleast':` — missing from the projection switch. Or and Xor
 * are the same gap at the same call site; they ship together as one
 * focused fix.
 *
 * Sigma-rust source:
 *   - mir/or.rs::Or::tpe        → SBoolean
 *   - mir/xor.rs::Xor::tpe      → SColl(SByte)
 *   - mir/atleast.rs::Atleast::tpe → SSigmaProp
 *
 * Spec: docs/specs/2026-05-22-ergoscript-2j-pre-fix-3-atleast-exprtpe-design.md
 */

import { describe, it, expect } from 'vitest'
import { exprTpe } from '../src/mir/expr-tpe'
import type { Expr, SType } from '../src/mir/types'

const SBOOLEAN: SType = { tag: 'SBoolean' }
const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SSIGMAPROP: SType = { tag: 'SSigmaProp' }
const SCOLL_SBOOLEAN: SType = { tag: 'SColl', elem: SBOOLEAN }
const SCOLL_SBYTE: SType = { tag: 'SColl', elem: SBYTE }
const SCOLL_SSIGMAPROP: SType = { tag: 'SColl', elem: SSIGMAPROP }

// Minimal Const sub-Exprs for use as Or/Xor/Atleast sub-fields. The
// projection arm doesn't recurse; these just need to be syntactically
// valid Expr nodes.
const constCollBoolean: Expr = {
  tag: 'Const',
  tpe: SCOLL_SBOOLEAN,
  value: { kind: 'Coll', elem: SBOOLEAN, items: [] },
}
const constCollByte: Expr = {
  tag: 'Const',
  tpe: SCOLL_SBYTE,
  value: { kind: 'Coll', elem: SBYTE, items: [] },
}
const constInt: Expr = {
  tag: 'Const',
  tpe: SINT,
  value: { kind: 'Int', value: 1 },
}
const constCollSigma: Expr = {
  tag: 'Const',
  tpe: SCOLL_SSIGMAPROP,
  value: { kind: 'Coll', elem: SSIGMAPROP, items: [] },
}

describe('exprTpe (phase 2j-pre fix-3 arms)', () => {
  it('Or returns SBoolean', () => {
    const e: Expr = { tag: 'Or', input: constCollBoolean }
    expect(exprTpe(e)).toEqual({ tag: 'SBoolean' })
  })

  it('Xor returns SColl[SByte]', () => {
    const e: Expr = { tag: 'Xor', left: constCollByte, right: constCollByte }
    expect(exprTpe(e)).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
  })

  it('Atleast returns SSigmaProp', () => {
    const e: Expr = { tag: 'Atleast', bound: constInt, input: constCollSigma }
    expect(exprTpe(e)).toEqual({ tag: 'SSigmaProp' })
  })
})

/**
 * GroupElement-arithmetic arms (MultiplyGroup, Exponentiate).
 *
 * Walker halt at mainnet h=1,140,116 tx#6 input 0: `ValDef(id=9)` rhs is a
 * `MultiplyGroup`, which had no `exprTpe` arm → `parseTree` failed with
 * "variant 'MultiplyGroup' not yet supported". `Exponentiate` is the identical
 * gap at the same call site (both are GroupElement arithmetic → SGroupElement),
 * so the class ships together.
 *
 * Sigma-rust source:
 *   - mir/multiply_group.rs::MultiplyGroup::tpe → SGroupElement
 *   - mir/exponentiate.rs::Exponentiate::tpe    → SGroupElement
 *
 * The arms don't recurse; the left/right sub-Exprs just need to be
 * syntactically valid Expr nodes (reusing `constInt`).
 */
describe('exprTpe — GroupElement arithmetic arms', () => {
  it('MultiplyGroup returns SGroupElement', () => {
    const e: Expr = { tag: 'MultiplyGroup', left: constInt, right: constInt }
    expect(exprTpe(e)).toEqual({ tag: 'SGroupElement' })
  })

  it('Exponentiate returns SGroupElement', () => {
    const e: Expr = { tag: 'Exponentiate', left: constInt, right: constInt }
    expect(exprTpe(e)).toEqual({ tag: 'SGroupElement' })
  })
})

/**
 * exprTpe coverage completion (walker h=1,140,116 tx#6).
 *
 * The halting contract's ValDef rhs's exercised a dozen Expr variants the lazy
 * switch had no arms for. All result types verified against sigma-rust mir/*.rs.
 * Fixed-type arms read only `.tag` (no recursion), so a tag-only stub is a
 * sufficient input; BitInversion recurses (returns the operand type) so it
 * gets a real rhs.
 */
describe('exprTpe — coverage completion arms', () => {
  const stub = (tag: Expr['tag']): Expr => ({ tag }) as unknown as Expr
  const cases: Array<[Expr['tag'], SType]> = [
    ['CalcSha256', SCOLL_SBYTE],
    ['CreateAvlTree', { tag: 'SAvlTree' }],
    ['CreateProveDhTuple', SSIGMAPROP],
    ['ExtractBytes', SCOLL_SBYTE],
    ['SubstConstants', SCOLL_SBYTE],
    ['TreeLookup', { tag: 'SOption', elem: SCOLL_SBYTE }],
    ['XorOf', SBOOLEAN],
    ['SigmaPropIsProven', SBOOLEAN],
    ['Global', { tag: 'SGlobal' }],
    ['Context', { tag: 'SContext' }],
    ['ZkProofBlock', SBOOLEAN],
  ]
  for (const [tag, expected] of cases) {
    it(`${tag} returns ${expected.tag}`, () => {
      expect(exprTpe(stub(tag))).toEqual(expected)
    })
  }

  it('BitInversion returns the operand type (recurses into input)', () => {
    const e: Expr = { tag: 'BitInversion', input: constInt }
    expect(exprTpe(e)).toEqual({ tag: 'SInt' })
  })
})

/**
 * MethodCall/PropertyCall return-type resolution (A3 — 2026-06-01).
 *
 * exprTpe consults the mir/method-signatures.ts catalog for method/property
 * calls. getEncoded (7:2) → Coll[SByte], indices (12:14) → Coll[SInt] (both
 * closed t_range). Unregistered (typeId, methodId) → SAny (load-bearing cascade
 * fallback). Both target methods are PropertyCall on the wire (0xdb); the
 * MethodCall arm consults the same catalog.
 *
 * Spec: docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md
 */
describe('exprTpe — method-call return-type resolution (A3)', () => {
  const groupElemConst: Expr = {
    tag: 'Const',
    tpe: { tag: 'SGroupElement' },
    value: { kind: 'GroupElement', value: new Uint8Array(33) },
  }
  const collLongConst: Expr = {
    tag: 'Const',
    tpe: { tag: 'SColl', elem: { tag: 'SLong' } },
    value: { kind: 'Coll', elem: { tag: 'SLong' }, items: [] },
  }
  const collByteConst: Expr = {
    tag: 'Const',
    tpe: SCOLL_SBYTE,
    value: { kind: 'Coll', elem: SBYTE, items: [] },
  }

  it('PropertyCall getEncoded (7:2) returns Coll[SByte]', () => {
    const e: Expr = { tag: 'PropertyCall', obj: groupElemConst, typeId: 7, methodId: 2 }
    expect(exprTpe(e)).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
  })

  it('PropertyCall indices (12:14) returns Coll[SInt], ignoring the receiver elem', () => {
    const onLong: Expr = { tag: 'PropertyCall', obj: collLongConst, typeId: 12, methodId: 14 }
    expect(exprTpe(onLong)).toEqual({ tag: 'SColl', elem: { tag: 'SInt' } })
    // indices' t_range is closed (Coll[Int] regardless of the receiver's T).
    const onByte: Expr = { tag: 'PropertyCall', obj: collByteConst, typeId: 12, methodId: 14 }
    expect(exprTpe(onByte)).toEqual({ tag: 'SColl', elem: { tag: 'SInt' } })
  })

  it('MethodCall arm consults the same catalog (7:2 → Coll[SByte])', () => {
    const e: Expr = {
      tag: 'MethodCall',
      obj: groupElemConst,
      typeId: 7,
      methodId: 2,
      args: [],
      explicitTypeArgs: {},
    }
    expect(exprTpe(e)).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
  })

  it('unregistered (typeId, methodId) falls back to SAny (cascade guard)', () => {
    const e: Expr = { tag: 'PropertyCall', obj: groupElemConst, typeId: 999, methodId: 999 }
    expect(exprTpe(e)).toEqual({ tag: 'SAny' })
  })
})
