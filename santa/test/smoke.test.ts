import { describe, it, expect } from 'vitest'
import { parseTree, evaluateWith, makeContext } from '@ergots/ergoscript'
import type { SType, SValue } from '@ergots/ergoscript'
import { hexToBytes, bytesToHex } from '../src/hex'

describe('ergots API wiring (smoke)', () => {
  it('v1 closed tree: decode-point dp_generator → GroupElement, cost 305, at treeVersion 0', () => {
    const tree = parseTree(hexToBytes('00ee0e210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'))
    expect(tree.header.version).toBe(0) // header version == entry.version.ergoTree
    const ctx = makeContext({ treeVersion: 0 })
    const v = evaluateWith(tree, ctx) as Extract<SValue, { kind: 'GroupElement' }>
    expect(v.kind).toBe('GroupElement')
    expect(bytesToHex(v.value)).toBe('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
    expect(ctx.jitCost).toBe(305)
  })

  // NOTE (Task 1 finding): the plan's original v2 fixture used Coll.reverse
  // (SColl method 30), which this ergots build does NOT implement — eval threw
  // `method-not-implemented: typeId=12, methodId=30`. The failure was NOT in the
  // var-1 binding, treeVersion, or jitCost wiring: a decode probe confirmed the
  // tree is exactly `Apply(FuncValue([id=1:SColl[SInt]], <method on ValUse(1)>),
  // [OptionGet(GetVar(1, SColl[SInt]))])` and eval reached the method call having
  // already bound var 1, run OptionGet, and entered the function body. Only the
  // stdlib method was missing. ergots' implemented SColl methods are 14
  // (indices), 15 (flatMap), 19 (patch), 26 (indexOf), 29 (zip). We therefore
  // pin the SAME closed-function/var-1 shape but call Coll.indices (method 14,
  // no-arg, returns Coll[Int]) — proving all three deferred facts on a tree that
  // actually evaluates. Tree built from the plan's bytes with methodId 30→14 via
  // ergots' (sigma-rust-byte-compatible) serializer; value+cost read back from
  // ergots. (Reported as DONE_WITH_CONCERNS — downstream encode tasks must not
  // assume Coll.reverse is available.)
  it('v2 function tree: Coll.indices on Coll(1,2) bound at var 1 → Coll[Int][0,1], cost 96', () => {
    const tree = parseTree(hexToBytes('1b1000dad9010110db0c0e720101e4e30110'))
    expect(tree.header.version).toBe(3) // header version == entry.version.ergoTree
    const elem: SType = { tag: 'SInt' }
    const inputTpe: SType = { tag: 'SColl', elem }
    const inputVal: SValue = {
      kind: 'Coll',
      elem,
      items: [{ kind: 'Int', value: 1 }, { kind: 'Int', value: 2 }],
    }
    const ctx = makeContext({
      treeVersion: 3,
      extension: { values: { 1: { tpe: inputTpe, value: inputVal } } },
    })
    const v = evaluateWith(tree, ctx) as Extract<SValue, { kind: 'Coll' }>
    expect(v.kind).toBe('Coll')
    expect(v.items).toEqual([{ kind: 'Int', value: 0 }, { kind: 'Int', value: 1 }])
    expect(ctx.jitCost).toBe(96) // 91 + 5 AddToEnvironment lambda-arg charge (ergots fix 2026-06-01)
  })
})
