/**
 * Equality for the 4 composite SValue kinds: Box / AvlTree / PreHeader / Header.
 *
 * Sigma-rust mirrors these via `#[derive(PartialEq, Eq, ...)]` on the
 * underlying types and the catch-all arms in `data_value_comparer.rs:73-128`:
 *
 *   (Value::CBox(_), Value::CBox(_))      → EQ_BOX_COST       = 6
 *   (Value::AvlTree(_), Value::AvlTree(_))→ EQ_AVL_TREE_COST  = 6
 *   (Value::Header(_), Value::Header(_))  → EQ_HEADER_COST    = 6
 *   `Value::PreHeader(_)`                 → EQ_PREHEADER_COST = 4
 *     (PreHeader falls into the same catch-all family; const value 4
 *      per `data_value_comparer.rs` import block.)
 *
 * Each follows `Ok(lv == rv)` — Rust auto-derived field-by-field structural
 * equality. Our TS impl mirrors by field-by-field comparison.
 *
 * Triggering case: mainnet h=448,658 tx 1 input 0 — a `Coll[Box]` equality
 * check ([[reference-source-first-discipline]] applied: source-read landed
 * confidence at ~96%).
 */

import { describe, it, expect } from 'vitest'
import { sValueEquals } from '../../src/eval/bin-op/relation'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SValue, ErgoBox, AvlTreeData, PreHeader } from '../../src/mir/types'
import type { Header } from '@ergots/scorex'

function syntheticBox(opts?: Partial<ErgoBox>): ErgoBox {
  return {
    value: 1000n,
    ergoTreeBytes: new Uint8Array([0x00, 0x08, 0xcd]),
    registers: {},
    tokens: [],
    creationHeight: 100,
    txId: new Uint8Array(32),
    index: 0,
    ...opts,
  }
}

function syntheticAvlTree(opts?: Partial<AvlTreeData>): AvlTreeData {
  return {
    digest: new Uint8Array(33),
    treeFlags: 0b00000111,
    keyLength: 32,
    valueLengthOpt: null,
    ...opts,
  }
}

function syntheticPreHeader(opts?: Partial<PreHeader>): PreHeader {
  return {
    version: 2,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
    ...opts,
  }
}

function syntheticHeader(opts?: Partial<Header>): Header {
  return {
    version: 2,
    id: new Uint8Array(32),
    parentId: new Uint8Array(32),
    adProofsRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(33),
    transactionRoot: new Uint8Array(32),
    timestamp: 1700000000000,
    nBits: 0x18000000,
    height: 1000,
    extensionRoot: new Uint8Array(32),
    autolykosSolution: {
      minerPk: new Uint8Array(33),
      powOnetimePk: null,
      nonce: new Uint8Array(8),
      powDistance: null,
    },
    votes: new Uint8Array(3),
    unparsedBytes: new Uint8Array(),
    ...opts,
  }
}

function vBox(b: ErgoBox): SValue { return { kind: 'Box', value: b } }
function vAvl(a: AvlTreeData): SValue { return { kind: 'AvlTree', value: a } }
function vPh(p: PreHeader): SValue { return { kind: 'PreHeader', value: p } }
function vHd(h: Header): SValue { return { kind: 'Header', value: h } }

describe('sValueEquals — Box', () => {
  it('returns true for two structurally-equal boxes; charges EQ_BOX_COST=6', () => {
    const ctx = makeContext({})
    const a = syntheticBox()
    const b = syntheticBox()
    expect(sValueEquals(vBox(a), vBox(b), ctx)).toBe(true)
    expect(ctx.jitCost).toBe(6)
  })
  it('returns false when value differs', () => {
    const ctx = makeContext({})
    expect(sValueEquals(vBox(syntheticBox()), vBox(syntheticBox({ value: 999n })), ctx)).toBe(false)
    expect(ctx.jitCost).toBe(6)
  })
  it('returns false when ergoTreeBytes differs', () => {
    const ctx = makeContext({})
    expect(sValueEquals(vBox(syntheticBox()), vBox(syntheticBox({ ergoTreeBytes: new Uint8Array([0xff]) })), ctx)).toBe(false)
  })
  it('returns false when creationHeight differs', () => {
    expect(sValueEquals(vBox(syntheticBox()), vBox(syntheticBox({ creationHeight: 999 })), makeContext({}))).toBe(false)
  })
  it('returns false when index differs', () => {
    expect(sValueEquals(vBox(syntheticBox()), vBox(syntheticBox({ index: 1 })), makeContext({}))).toBe(false)
  })
  it('returns false when txId differs by one byte', () => {
    const txA = new Uint8Array(32)
    const txB = new Uint8Array(32); txB[5] = 0xff
    expect(sValueEquals(vBox(syntheticBox({ txId: txA })), vBox(syntheticBox({ txId: txB })), makeContext({}))).toBe(false)
  })
  it('compares tokens positionally', () => {
    const t1 = { id: new Uint8Array(32), amount: 100n }
    const t2 = { id: new Uint8Array(32), amount: 200n }
    expect(sValueEquals(vBox(syntheticBox({ tokens: [t1, t2] })), vBox(syntheticBox({ tokens: [t1, t2] })), makeContext({}))).toBe(true)
    // Different amount → false
    expect(sValueEquals(vBox(syntheticBox({ tokens: [t1] })), vBox(syntheticBox({ tokens: [t2] })), makeContext({}))).toBe(false)
    // Different length → false
    expect(sValueEquals(vBox(syntheticBox({ tokens: [t1] })), vBox(syntheticBox({ tokens: [t1, t2] })), makeContext({}))).toBe(false)
  })
  it('compares registers presence-and-value (sparse Record matches Vec PartialEq mainnet convention)', () => {
    const rA: ErgoBox['registers'] = {
      4: { tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
    }
    const rB: ErgoBox['registers'] = {
      4: { tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
    }
    expect(sValueEquals(vBox(syntheticBox({ registers: rA })), vBox(syntheticBox({ registers: rB })), makeContext({}))).toBe(true)
    // One missing R4 → false
    expect(sValueEquals(vBox(syntheticBox({ registers: rA })), vBox(syntheticBox({ registers: {} })), makeContext({}))).toBe(false)
    // Different value at R4 → false
    const rC: ErgoBox['registers'] = {
      4: { tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 99 } },
    }
    expect(sValueEquals(vBox(syntheticBox({ registers: rA })), vBox(syntheticBox({ registers: rC })), makeContext({}))).toBe(false)
  })
})

describe('sValueEquals — AvlTree', () => {
  it('returns true for equal AvlTrees; charges EQ_AVL_TREE_COST=6', () => {
    const ctx = makeContext({})
    expect(sValueEquals(vAvl(syntheticAvlTree()), vAvl(syntheticAvlTree()), ctx)).toBe(true)
    expect(ctx.jitCost).toBe(6)
  })
  it('returns false on digest difference', () => {
    const d = new Uint8Array(33); d[0] = 0xff
    expect(sValueEquals(vAvl(syntheticAvlTree()), vAvl(syntheticAvlTree({ digest: d })), makeContext({}))).toBe(false)
  })
  it('returns false on treeFlags difference', () => {
    expect(sValueEquals(vAvl(syntheticAvlTree()), vAvl(syntheticAvlTree({ treeFlags: 0 })), makeContext({}))).toBe(false)
  })
  it('handles valueLengthOpt null vs number', () => {
    expect(sValueEquals(vAvl(syntheticAvlTree()), vAvl(syntheticAvlTree({ valueLengthOpt: 8 })), makeContext({}))).toBe(false)
    expect(sValueEquals(vAvl(syntheticAvlTree({ valueLengthOpt: 8 })), vAvl(syntheticAvlTree({ valueLengthOpt: 8 })), makeContext({}))).toBe(true)
  })
})

describe('sValueEquals — PreHeader', () => {
  it('returns true for equal PreHeaders; charges EQ_PREHEADER_COST=4', () => {
    const ctx = makeContext({})
    expect(sValueEquals(vPh(syntheticPreHeader()), vPh(syntheticPreHeader()), ctx)).toBe(true)
    expect(ctx.jitCost).toBe(4)
  })
  it('returns false on each field difference', () => {
    expect(sValueEquals(vPh(syntheticPreHeader()), vPh(syntheticPreHeader({ version: 3 })), makeContext({}))).toBe(false)
    expect(sValueEquals(vPh(syntheticPreHeader()), vPh(syntheticPreHeader({ timestamp: 99n })), makeContext({}))).toBe(false)
    expect(sValueEquals(vPh(syntheticPreHeader()), vPh(syntheticPreHeader({ height: 9999 })), makeContext({}))).toBe(false)
    const pk = new Uint8Array(33); pk[0] = 0xff
    expect(sValueEquals(vPh(syntheticPreHeader()), vPh(syntheticPreHeader({ minerPk: pk })), makeContext({}))).toBe(false)
  })
})

describe('sValueEquals — Header', () => {
  it('returns true for equal Headers; charges EQ_HEADER_COST=6', () => {
    const ctx = makeContext({})
    expect(sValueEquals(vHd(syntheticHeader()), vHd(syntheticHeader()), ctx)).toBe(true)
    expect(ctx.jitCost).toBe(6)
  })
  it('returns false on top-level field difference', () => {
    expect(sValueEquals(vHd(syntheticHeader()), vHd(syntheticHeader({ height: 9999 })), makeContext({}))).toBe(false)
  })
  it('returns false on nested AutolykosSolution.nonce difference', () => {
    const otherNonce = new Uint8Array(8); otherNonce[3] = 0xab
    const hB = syntheticHeader()
    hB.autolykosSolution = { ...hB.autolykosSolution, nonce: otherNonce }
    expect(sValueEquals(vHd(syntheticHeader()), vHd(hB), makeContext({}))).toBe(false)
  })
  it('handles AutolykosSolution.powDistance bigint null/value', () => {
    const hA = syntheticHeader()
    const hB = syntheticHeader()
    hB.autolykosSolution = { ...hB.autolykosSolution, powDistance: 12345n }
    expect(sValueEquals(vHd(hA), vHd(hB), makeContext({}))).toBe(false)
    // Both same bigint:
    const hC = syntheticHeader()
    hC.autolykosSolution = { ...hC.autolykosSolution, powDistance: 12345n }
    expect(sValueEquals(vHd(hB), vHd(hC), makeContext({}))).toBe(true)
  })
  it('handles AutolykosSolution.powOnetimePk null vs bytes', () => {
    const hA = syntheticHeader()
    const hB = syntheticHeader()
    hB.autolykosSolution = { ...hB.autolykosSolution, powOnetimePk: new Uint8Array(33) }
    expect(sValueEquals(vHd(hA), vHd(hB), makeContext({}))).toBe(false)
  })
})

describe('sValueEquals — Coll[Box] (the iter-7 mainnet trigger pattern)', () => {
  it('compares two Coll[Box] element-wise via primitiveValueEqual', () => {
    const a: SValue = {
      kind: 'Coll',
      elem: { tag: 'SBox' },
      items: [vBox(syntheticBox()), vBox(syntheticBox({ value: 2000n }))],
    }
    const b: SValue = {
      kind: 'Coll',
      elem: { tag: 'SBox' },
      items: [vBox(syntheticBox()), vBox(syntheticBox({ value: 2000n }))],
    }
    expect(sValueEquals(a, b, makeContext({}))).toBe(true)
    // Different element → false (no more 'not-implemented-yet' throw)
    const c: SValue = {
      kind: 'Coll',
      elem: { tag: 'SBox' },
      items: [vBox(syntheticBox()), vBox(syntheticBox({ value: 9999n }))],
    }
    expect(sValueEquals(a, c, makeContext({}))).toBe(false)
  })
  it('does NOT throw not-implemented-yet for Coll[Box] equality (regression for h=448,658)', () => {
    const a: SValue = { kind: 'Coll', elem: { tag: 'SBox' }, items: [vBox(syntheticBox())] }
    const b: SValue = { kind: 'Coll', elem: { tag: 'SBox' }, items: [vBox(syntheticBox())] }
    let threw = false
    try { sValueEquals(a, b, makeContext({})) } catch (e) {
      if (e instanceof EvalError && e.code === 'not-implemented-yet') threw = true
    }
    expect(threw).toBe(false)
  })
})
