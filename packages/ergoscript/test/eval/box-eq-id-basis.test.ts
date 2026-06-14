/**
 * Box equality = id equality (F5 batch 4 member E, ledger verdict 3).
 *
 * JVM `ErgoBox.equals` is `Arrays.equals(id, x.id)` (ErgoBox.scala:94-97)
 * where `id = Blake2b256(bytes)` (:73) and `bytes` is the RETAINED parse
 * slice (`_bytes`, captured by the serializer's parse at :214-226) or the
 * canonical re-serialization for in-memory-constructed boxes (:87-92).
 *
 * That makes box equality BYTE basis, not value basis: after the F5 batch 4
 * GE canonical-bytes invariant (Tasks D), a garbage identity encoding
 * (0x00-lead, nonzero tail) NORMALIZES to the canonical 33-zero identity at
 * the SValue layer — so a value-basis field walk can no longer see the byte
 * difference, but the JVM ids still differ (different retained bytes).
 *
 * Empirical pin (SANTA Ask 16): box twins EQ → false; extracted-register
 * GE EQ → true. Blessed vectors are vendored in a later task; this file
 * pins the same verdicts at unit level.
 *
 * Test construction: serialize a box whose R4 holds the canonical identity
 * (33 zeros), locate the 33-zero register payload in the output bytes, and
 * flip payload byte[1] to 0xAA → the GARBAGE-identity twin (still parses:
 * 0x00-lead ⇒ identity, tail bytes dead).
 */

import { describe, it, expect } from 'vitest'
import { sValueEquals } from '../../src/eval/bin-op/relation'
import { makeContext } from '../../src/eval/eval-context'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { boxIdOf } from '../../src/eval/_box-id'
import type { ErgoBox, SValue } from '../../src/mir/types'

/** Box whose R4 is the CANONICAL identity GroupElement (33 zero bytes). */
function identityGeBox(): ErgoBox {
  return {
    value: 1000000n,
    // Minimal ErgoTree: header=0x08 (hasSize=true), bodySize VLQ=0x00.
    ergoTreeBytes: new Uint8Array([0x08, 0x00]),
    registers: {
      4: {
        tpe: { tag: 'SGroupElement' },
        value: { kind: 'GroupElement', value: new Uint8Array(33) },
      },
    },
    tokens: [],
    creationHeight: 100,
    // Non-zero filler so the GE payload is the ONLY 33-zero run in the bytes.
    txId: new Uint8Array(32).fill(0x11),
    index: 1,
  }
}

function serializeBox(box: ErgoBox): Uint8Array {
  const w = new ByteWriter()
  serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, 0, w)
  return w.toBytes()
}

function parseBox(bytes: Uint8Array): Extract<SValue, { kind: 'Box' }> {
  const r = new ByteReader(bytes)
  const v = parseSValue({ tag: 'SBox' }, 0, r)
  if (v.kind !== 'Box') throw new Error(`expected Box, got ${v.kind}`)
  return v
}

/** Index of the first run of 33 consecutive zero bytes (the R4 GE payload). */
function find33ZeroRun(bytes: Uint8Array): number {
  outer: for (let i = 0; i + 33 <= bytes.length; i++) {
    for (let j = 0; j < 33; j++) {
      if (bytes[i + j] !== 0) continue outer
    }
    return i
  }
  throw new Error('no 33-zero run found')
}

const canonicalBytes = serializeBox(identityGeBox())
const gePayloadAt = find33ZeroRun(canonicalBytes)
const garbageBytes = canonicalBytes.slice()
garbageBytes[gePayloadAt + 1] = 0xaa // still 0x00-lead ⇒ parses to identity

describe('box equality — JVM id/byte basis', () => {
  it('(a) garbage-vs-canonical identity GE register twins are UNEQUAL (ids differ)', () => {
    const canonical = parseBox(canonicalBytes)
    const garbage = parseBox(garbageBytes)

    // Sanity: GE normalization (F5 batch 4 D) made the register VALUES
    // identical — the SValue layer cannot see the byte difference.
    const regC = canonical.value.registers[4]!.value
    const regG = garbage.value.registers[4]!.value
    if (regC.kind !== 'GroupElement' || regG.kind !== 'GroupElement') {
      throw new Error('expected GroupElement registers')
    }
    expect(regG.value).toEqual(new Uint8Array(33))
    expect(regG.value).toEqual(regC.value)

    // The boxes still compare UNEQUAL: id basis over retained bytes.
    const ctx = makeContext({})
    expect(sValueEquals(canonical, garbage, ctx)).toBe(false)
  })

  it('(a-interlock) the extracted register GEs compare EQUAL (value basis, 172)', () => {
    const canonical = parseBox(canonicalBytes)
    const garbage = parseBox(garbageBytes)
    const ctx = makeContext({})
    expect(
      sValueEquals(
        canonical.value.registers[4]!.value,
        garbage.value.registers[4]!.value,
        ctx
      )
    ).toBe(true)
    expect(ctx.jitCost).toBe(172) // EQ_GroupElement
  })

  it('(b) same bytes parsed twice (distinct objects) compare EQUAL', () => {
    const a = parseBox(canonicalBytes)
    const b = parseBox(canonicalBytes)
    expect(a.value).not.toBe(b.value)
    expect(sValueEquals(a, b, makeContext({}))).toBe(true)
  })

  it('(c) constructed box (no retained bytes) equals the parse of its own canonical serialization', () => {
    // JVM constructed-box fallback: bytes = canonical re-serialization
    // (ErgoBox.scala:87-92) — cross-basis consistency.
    const constructed: SValue = { kind: 'Box', value: identityGeBox() }
    const parsed = parseBox(serializeBox(identityGeBox()))
    expect(sValueEquals(constructed, parsed, makeContext({}))).toBe(true)
    expect(sValueEquals(parsed, constructed, makeContext({}))).toBe(true)
  })

  it('(d) EQ cost unchanged: flat EQ_BOX_COST=6 for equal AND unequal pairs', () => {
    const equalCtx = makeContext({})
    sValueEquals(parseBox(canonicalBytes), parseBox(canonicalBytes), equalCtx)
    expect(equalCtx.jitCost).toBe(6)

    const unequalCtx = makeContext({})
    sValueEquals(parseBox(canonicalBytes), parseBox(garbageBytes), unequalCtx)
    expect(unequalCtx.jitCost).toBe(6)
  })

  it('(e) Coll[Box] elementwise compare honors the id basis', () => {
    const collOf = (b: SValue): SValue => ({
      kind: 'Coll',
      elem: { tag: 'SBox' },
      items: [b],
    })
    const ctx = makeContext({})
    expect(
      sValueEquals(collOf(parseBox(garbageBytes)), collOf(parseBox(canonicalBytes)), ctx)
    ).toBe(false)
    // COLL_MATCH_TYPE(1) + EQ_COLL_BOX_PER_ITEM(15 + ceil(1/1)*5) = 21,
    // unchanged by the basis switch (COA bulk path, no per-element EQ_Box).
    expect(ctx.jitCost).toBe(21)

    const ctxEq = makeContext({})
    expect(
      sValueEquals(collOf(parseBox(canonicalBytes)), collOf(parseBox(canonicalBytes)), ctxEq)
    ).toBe(true)
  })

  it('(f) boxIdOf memoizes per object (WeakMap hit returns the same instance)', () => {
    const box = identityGeBox()
    const id1 = boxIdOf(box)
    const id2 = boxIdOf(box)
    expect(id1).toBe(id2)
    expect(id1.length).toBe(32)

    // Parsed boxes derive the id from the RETAINED bytes: the garbage twin's
    // id differs from the canonical twin's even though all SValue fields match.
    const idCanonical = boxIdOf(parseBox(canonicalBytes).value)
    const idGarbage = boxIdOf(parseBox(garbageBytes).value)
    expect(idCanonical).not.toEqual(idGarbage)
    // Constructed-box fallback agrees with the canonical parse's retained bytes.
    expect(boxIdOf(box)).toEqual(idCanonical)
  })
})
