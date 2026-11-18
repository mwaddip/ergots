/**
 * End-to-end evaluation of the trees measured on sigma-state 6.0.7 under
 * spend mode with an empty `CONTEXT.headers` and a dummy self box. The
 * tree version lives in the header byte's low three bits, with `0x08` as
 * the size bit: header `0x08` is version 0, `0x0b` is version 3.
 */

import { describe, it, expect } from 'vitest'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes, synthesizeStubBox } from '../_helpers'

/** Reduce `treeHex` under a context that carries a self box and empty
 *  outputs / headers, like the JVM probe's dummy context. */
function reduce(treeHex: string): { verdict: 'reduced'; value: unknown } | { verdict: 'errored'; code: string } {
  const tree = parseTree(hexToBytes(treeHex))
  const self = synthesizeStubBox()
  const ctx = makeContext({ selfBox: self, outputs: [self], headers: [] })
  try {
    const value = evaluateWith(tree, ctx)
    return { verdict: 'reduced', value }
  } catch (e) {
    if (e instanceof EvalError) return { verdict: 'errored', code: e.code }
    throw e
  }
}

describe('C1 — a map/flatMap empty result typed as SAny is accepted by a class reader', () => {
  // F1: sigmaProp(size(blake2b256(Coll[Byte]()) ++ CONTEXT.headers.flatMap({(h: Header) => h.id})) == 32)
  // The flatMap body `h.id`'s exprTpe is ergots' own SAny, since SHeader
  // properties have no signature entry. With empty CONTEXT.headers, the
  // result is empty of unknown class; `append` on a specialised byte
  // receiver with an unknown empty operand gives the receiver back.
  it('F1 at tree v0: flatMap over empty CONTEXT.headers appends into a byte receiver', () => {
    const r = reduce('081ad193b1b3cb0e00dc0c0fdb6502fe01d9010168db680172010440')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('F1 at tree v3: the same tree answers', () => {
    const r = reduce('0b1ad193b1b3cb0e00dc0c0fdb6502fe01d9010168db680172010440')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('F1-control at tree v0: flatMap body ergots types concretely answers too', () => {
    const r = reduce('0815d193b1b3cb0e00dc0c0fa501d9010163c272010440')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  // F2: sigmaProp(size(Coll[Long](1L) ++ CONTEXT.headers.map({(h: Header) => h.timestamp})) == 1)
  // `h.timestamp` exprTpe is SAny; empty CONTEXT.headers gives an empty
  // unknown; append on plain `Coll[Long]` with unknown empty gives the
  // receiver back.
  it('F2 at tree v0: map over empty CONTEXT.headers appends into a long receiver', () => {
    const r = reduce('0817d193b1b3110102addb6502fed9010168db680772010402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })
})

describe('C2 — getOrElse on a pair collection casts the default at the call', () => {
  // D1: sigmaProp(Coll((1,2),(3,4)).getOrElse(0, 7L)._1 == 1)
  // At tree v0 the JVM always calls getOrElse (below-v3 ByIndex); its
  // bridge method casts the default to Tuple2. A `7L` default fails the
  // cast whether in range or out.
  it('D1 at tree v0 in range: a non-pair default on a pairs receiver refuses', () => {
    expect(reduce('0813d1938cb20c580202040608040001050e010402')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })

  it('D1 at tree v3 in range: the ByIndex apply reads without touching the default', () => {
    const r = reduce('0b13d1938cb20c580202040608040001050e010402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('D1 at tree v0 out of range (index 5): the same refusal', () => {
    expect(reduce('0813d1938cb20c580202040608040a01050e010402')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })
})

describe('C3 — the unzip of a lying pair-array operand stores each component', () => {
  // U1: sigmaProp(size(Coll(1).zip(Coll(SELF)) ++ G) == 2), G = ...(1L,SELF)
  // The unzip of G reads p._1 (a Long) and tries to store it into the left
  // side's int array: ClassCastException.
  it('U1 at tree v3: append on pairs with a non-pair-component patch refuses', () => {
    expect(reduce('0b2dd193b1b3dc0c1d10010201830163a7addc0c1d10010201100102d901015895010086020402a786020502a70404')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })

  // U2: sigmaProp(size(Coll(1.toByte).zip(Coll(SELF)).patch(0, G', 0)) == 2)
  // Patch on pairs with a byte left side; G' lies (1L, SELF).
  it('U2 at tree v3: patch on pairs with a non-pair-component patch refuses', () => {
    expect(reduce('0b34d193b1dc0c13dc0c1d0e010101830163a7030400addc0c1d10010201100102d901015895010086020201a786020502a704000404')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })

  // U1-control: the same append without the lie (both branches (1, SELF)).
  it('U1-control at tree v3: honest components reduce', () => {
    const r = reduce('0b2dd193b1b3dc0c1d10010201830163a7addc0c1d10010201100102d901015895010086020402a786020402a70404')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })
})

describe('IMP-1 — patch on a pairs receiver with an empty unknown operand', () => {
  // sigmaProp(size(Coll(1.toByte).zip(Coll(SELF)).patch(0, CONTEXT.headers.map{(h: Header) => (CONTEXT.preHeader.version, SELF)}, 0)) == 1)
  // The mapper range types as (Byte, Box) in sigma-state 6.0.7 (`CONTEXT.preHeader.version`
  // is Byte, `SELF` is Box), matching the receiver's pair elem (Byte, Box). The JVM
  // reduces at cost 17. Ergots' method-signature catalog has no entry for 105:1, so
  // `CONTEXT.preHeader.version` types as `SAny`; the map arm builds an empty of the
  // unknown class over the pair elem `STuple(SAny, SBox)`; the pairs-branch of `patch`
  // short-circuits on the unknown operand and returns the receiver.
  it('IMP-1 at tree v3 reduces', () => {
    const r = reduce('0b2bd193b1dc0c13dc0c1d0e010101830163a7030400addb6502fed90101688602db6901db6508fea704000402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('IMP-1 at tree v0 reduces', () => {
    const r = reduce('082bd193b1dc0c13dc0c1d0e010101830163a7030400addb6502fed90101688602db6901db6508fea704000402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })
})
