/**
 * Signed-i64 view of u64 wire carriers (F3.5; F2-timestamp model extended).
 *
 * JVM parses box value / token amounts via unbounded getULong
 * (ErgoBoxCandidate.scala:193/:212/:220) and surfaces them `as Long` —
 * SANTA spike + Box.signed_view_u64 vectors bless the SIGNED view at every
 * surface (2⁶³ → Long(-2⁶³), u64-max → Long(-1)). ErgoBox.value / token
 * amounts stay RAW unbounded-bigint internally (serialize byte-identity);
 * only the SLong VIEW applies BigInt.asIntN(64,·) — same model as the F2
 * SHeader/SPreHeader timestamp fix (method-call.ts:338).
 *
 * Covers the four view sites; site 3 (R2 token tuples via
 * extract-register-as.ts tokensToCollTupleSValue) is NOT covered by the
 * conformance vectors — these pins are its only guard.
 */
import { describe, it, expect } from 'vitest'
import { getRegisterEntry } from '../../src/eval/extract-register-as'
import type { ErgoBox, SValue } from '../../src/mir/types'

const U64_MAX = 18446744073709551615n // 2^64 - 1
const TWO_63 = 9223372036854775808n   // 2^63

function boxWith(value: bigint, tokenAmount: bigint): ErgoBox {
  return {
    value,
    ergoTreeBytes: new Uint8Array([0x00, 0x08, 0xcd, ...new Uint8Array(33)]),
    creationHeight: 0,
    tokens: [{ id: new Uint8Array(32), amount: tokenAmount }],
    registers: {},
    txId: new Uint8Array(32),
    index: 0,
  }
}

describe('signed-i64 view — getRegisterEntry R0 (site 2)', () => {
  it('u64-max box value → Long(-1)', () => {
    const entry = getRegisterEntry(boxWith(U64_MAX, 1n), 0)!
    expect(entry.value).toEqual({ kind: 'Long', value: -1n })
  })
  it('2^63 box value → Long(-2^63)', () => {
    const entry = getRegisterEntry(boxWith(TWO_63, 1n), 0)!
    expect(entry.value).toEqual({ kind: 'Long', value: -9223372036854775808n })
  })
  it('nominal box value unchanged → Long(1000000)', () => {
    const entry = getRegisterEntry(boxWith(1000000n, 1n), 0)!
    expect(entry.value).toEqual({ kind: 'Long', value: 1000000n })
  })
})

describe('signed-i64 view — getRegisterEntry R2 token amounts (site 3, unvectored)', () => {
  it('u64-max token amount → Long(-1) inside the (id, amount) tuple', () => {
    const entry = getRegisterEntry(boxWith(1000000n, U64_MAX), 2)!
    const coll = entry.value as Extract<SValue, { kind: 'Coll' }>
    const tuple = coll.items[0] as Extract<SValue, { kind: 'Tuple' }>
    expect(tuple.items[1]).toEqual({ kind: 'Long', value: -1n })
  })
  it('2^63 token amount → Long(-2^63)', () => {
    const entry = getRegisterEntry(boxWith(1000000n, TWO_63), 2)!
    const coll = entry.value as Extract<SValue, { kind: 'Coll' }>
    const tuple = coll.items[0] as Extract<SValue, { kind: 'Tuple' }>
    expect(tuple.items[1]).toEqual({ kind: 'Long', value: -9223372036854775808n })
  })
})
