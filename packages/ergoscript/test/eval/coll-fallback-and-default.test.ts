/**
 * End-to-end evaluation of trees measured on sigma-state 6.0.7 under spend
 * mode with an empty `CONTEXT.headers` and a dummy self box. The tree
 * version lives in the header byte's low three bits, with `0x08` as the
 * size bit: header `0x08` is version 0, `0x0b` is version 3.
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

describe('an empty map or flatMap result of an untyped mapper is taken by every reader', () => {
  // `h.id`'s exprTpe is ergots' own SAny, since SHeader properties have no
  // signature entry. With empty CONTEXT.headers, the result is empty of
  // unknown class; `append` on a specialised byte receiver with an unknown
  // empty operand gives the receiver back.
  it('`sigmaProp(size(blake2b256(Coll[Byte]()) ++ CONTEXT.headers.flatMap((h: Header) => h.id)) == 32)` at tree v0 reduces', () => {
    const r = reduce('081ad193b1b3cb0e00dc0c0fdb6502fe01d9010168db680172010440')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('the same tree at tree v3 reduces', () => {
    const r = reduce('0b1ad193b1b3cb0e00dc0c0fdb6502fe01d9010168db680172010440')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('`sigmaProp(size(blake2b256(Coll[Byte]()) ++ OUTPUTS.flatMap(b => b.propositionBytes)) == 32)` at tree v0 reduces (concrete body elem control)', () => {
    const r = reduce('0815d193b1b3cb0e00dc0c0fa501d9010163c272010440')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  // `h.timestamp` exprTpe is SAny; empty CONTEXT.headers gives an empty
  // unknown; append on plain `Coll[Long]` with unknown empty gives the
  // receiver back.
  it('`sigmaProp(size(Coll[Long](1L) ++ CONTEXT.headers.map((h: Header) => h.timestamp)) == 1)` at tree v0 reduces', () => {
    const r = reduce('0817d193b1b3110102addb6502fed9010168db680772010402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })
})

describe('getOrElse on a pair collection casts its default at the call', () => {
  // At tree v0 the JVM always calls getOrElse (below-v3 ByIndex); its
  // bridge method casts the default to Tuple2. A `7L` default fails the
  // cast whether in range or out.
  it('`sigmaProp(Coll((1,2),(3,4)).getOrElse(0, 7L)._1 == 1)` at tree v0 is refused (bridge cast on the in-range method call)', () => {
    expect(reduce('0813d1938cb20c580202040608040001050e010402')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })

  it('the same tree at tree v3 reduces (ByIndex reads in range without touching the default)', () => {
    const r = reduce('0b13d1938cb20c580202040608040001050e010402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('`sigmaProp(Coll((1,2),(3,4)).getOrElse(5, 7L)._1 == 1)` at tree v0 is refused (out of range, same cast)', () => {
    expect(reduce('0813d1938cb20c580202040608040a01050e010402')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })
})

describe('the unzip of an operand stores each component by its side’s class', () => {
  // `G = Coll(1).zip(Coll(1)).map(p => If(false, (1, SELF), (1L, SELF)))` has
  // `tItem` (Int, Box) in ergots and stores a pair whose left is Long. The
  // JVM's unzip reads `p._1` into the left side's int array: a long value
  // fails the aastore.
  it('`sigmaProp(size(Coll(1).zip(Coll(SELF)) ++ G) == 2)` at tree v3 is refused (append on pairs with a lying pair-array operand)', () => {
    expect(reduce('0b2dd193b1b3dc0c1d10010201830163a7addc0c1d10010201100102d901015895010086020402a786020502a70404')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })

  // `G'` has (Int, Box) `tItem` in ergots and stores (1L, SELF); the
  // receiver's left side is specialised byte.
  it('`sigmaProp(size(Coll(1.toByte).zip(Coll(SELF)).patch(0, G′, 0)) == 2)` at tree v3 is refused (patch on pairs with the same lie)', () => {
    expect(reduce('0b34d193b1dc0c13dc0c1d0e010101830163a7030400addc0c1d10010201100102d901015895010086020201a786020502a704000404')).toEqual({
      verdict: 'errored',
      code: 'coll-class-cast',
    })
  })

  // The same append without the lie (both If branches `(1, SELF)`).
  it('the same append with honest `(1, SELF)` components at tree v3 reduces', () => {
    const r = reduce('0b2dd193b1b3dc0c1d10010201830163a7addc0c1d10010201100102d901015895010086020402a786020402a70404')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })
})

describe('patch on a pair collection takes an empty operand of unknown class', () => {
  // The mapper range types as (Byte, Box) in sigma-state 6.0.7
  // (`CONTEXT.preHeader.version` is Byte, `SELF` is Box), matching the
  // receiver's pair elem (Byte, Box). The JVM reduces at cost 17. ergots'
  // method-signature catalog has no entry for 105:1, so
  // `CONTEXT.preHeader.version` types as `SAny`; the map arm builds an
  // empty of the unknown class over the pair elem `STuple(SAny, SBox)`;
  // the pairs branch of `patch` short-circuits on the unknown operand and
  // returns the receiver.
  it('`sigmaProp(size(Coll(1.toByte).zip(Coll(SELF)).patch(0, CONTEXT.headers.map((h: Header) => (CONTEXT.preHeader.version, SELF)), 0)) == 1)` at tree v3 reduces', () => {
    const r = reduce('0b2bd193b1dc0c13dc0c1d0e010101830163a7030400addb6502fed90101688602db6901db6508fea704000402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })

  it('the same tree at tree v0 reduces', () => {
    const r = reduce('082bd193b1dc0c13dc0c1d0e010101830163a7030400addb6502fed90101688602db6901db6508fea704000402')
    expect(r.verdict).toBe('reduced')
    expect((r as { value: { kind: string } }).value.kind).toBe('SigmaProp')
  })
})
