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
