/**
 * Box byte-accessor ASYMMETRIC basis (F5 batch 4, SANTA addendum).
 *
 * The JVM Box byte accessors are asymmetric:
 *   - `Box.bytes` (ExtractBytes 0xc3) serves the parse-RETAINED slice — a
 *     garbage-identity GE register encoding SURVIVES. CBox.scala:25 →
 *     ErgoBox.scala:87-92 (`_bytes` from the deserializer, captured at
 *     :214-225; canonical re-serialization only for constructed boxes).
 *   - `Box.id` (ExtractId 0xc5) = Blake2b256 over the `.bytes` basis
 *     (CBox.scala:24 → ErgoBox.scala:73) — same basis as Task 4's `boxIdOf`.
 *   - `Box.bytesWithoutRef` (ExtractBytesWithNoRef 0xc4) ALWAYS canonically
 *     re-serializes the CANDIDATE: CBox.scala:26 → ErgoBoxCandidate.scala:54
 *     `bytesWithNoRef = ErgoBoxCandidate.serializer.toBytes(this)` — there is
 *     NO retained candidate slice JVM-side, so the garbage/canonical twins
 *     CONVERGE byte-identical (and it is NOT a retained-minus-tail slice).
 *
 * Blessed pins: test/fixtures/conformance/v5/authored/Box.bytes_byte_basis.json
 * (6 entries). This file pins the same verdicts at unit level, built like
 * box-eq-id-basis.test.ts: serialize a box whose R4 is the canonical identity
 * GE, flip one payload byte → the garbage-identity twin (still parses;
 * 0x00-lead ⇒ identity, tail bytes dead), and compare accessor outputs.
 */

import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { boxIdOf } from '../../src/eval/_box-id'
import { collByteToUint8Array } from '../../src/eval/_byte-coll'
import { blake2b256 } from '../../src/crypto/hashes'
import {
  serializeBoxBytes,
  serializeBoxBytesWithoutRef,
} from '../../src/wire/ergo-box-bytes'
import type { ErgoBox, Expr, SValue } from '../../src/mir/types'

/** Box whose R4 is the CANONICAL identity GroupElement (33 zero bytes). */
function identityGeBox(): ErgoBox {
  return {
    value: 1000000n,
    // Minimal ErgoTree: header=0x00 (hasSize=false, no segregation), body = Height global (0xa3) — a minimal valid root Expr.
    ergoTreeBytes: new Uint8Array([0x00, 0xa3]),
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

// txId(32 raw) + index(VLQ, 1 byte for index=1) — the full-box tail.
const REF_TAIL_LEN = 33

type ExtractTag = 'ExtractBytes' | 'ExtractBytesWithNoRef' | 'ExtractId'

/** Run an extractor arm over a Box SValue; return the Coll[Byte] as bytes. */
function runExtract(tag: ExtractTag, boxV: SValue, ctx = makeContext()): Uint8Array {
  const expr = {
    tag,
    input: { tag: 'Const', tpe: { tag: 'SBox' }, value: boxV },
  } as Expr
  const out = evalExpr(expr, Env.empty(), ctx)
  return collByteToUint8Array(out, tag)
}

describe('box byte accessors — asymmetric retained/canonical basis (JVM)', () => {
  it('ExtractBytes on a parsed garbage-GE box returns the ORIGINAL retained bytes (garbage survives)', () => {
    const garbage = parseBox(garbageBytes)
    expect(runExtract('ExtractBytes', garbage)).toEqual(garbageBytes)
  })

  it('ExtractBytes on the canonical twin returns its retained bytes (control)', () => {
    const canonical = parseBox(canonicalBytes)
    expect(runExtract('ExtractBytes', canonical)).toEqual(canonicalBytes)
  })

  it('ExtractId on a parsed garbage-GE box hashes the retained bytes (== boxIdOf; differs from the canonical twin)', () => {
    const garbage = parseBox(garbageBytes)
    const canonical = parseBox(canonicalBytes)

    const idGarbage = runExtract('ExtractId', garbage)
    expect(idGarbage).toEqual(blake2b256(garbageBytes))
    expect(idGarbage).toEqual(boxIdOf(garbage.value))

    const idCanonical = runExtract('ExtractId', canonical)
    expect(idCanonical).toEqual(blake2b256(canonicalBytes))
    expect(idCanonical).not.toEqual(idGarbage)
  })

  it('ExtractId does not expose the memoized id array (copy on expose)', () => {
    // The Coll[Byte] SValue materializes per-item Byte SValues
    // (bytesToCollByteSValue), so it can hold no reference to boxIdOf's
    // memoized Uint8Array. Pin the property: mutate the returned SValue and
    // confirm the memo (and a re-extract) are unaffected.
    const garbage = parseBox(garbageBytes)
    const memoized = boxIdOf(garbage.value)
    const memoSnapshot = memoized.slice()

    const expr = {
      tag: 'ExtractId',
      input: { tag: 'Const', tpe: { tag: 'SBox' }, value: garbage },
    } as Expr
    const out = evalExpr(expr, Env.empty(), makeContext())
    if (out.kind !== 'Coll') throw new Error(`expected Coll, got ${out.kind}`)
    for (const item of out.items) {
      if (item.kind !== 'Byte') throw new Error(`expected Byte, got ${item.kind}`)
      item.value = 0
    }
    // Memoized array untouched; boxIdOf still returns the same instance+bytes.
    expect(memoized).toEqual(memoSnapshot)
    expect(boxIdOf(garbage.value)).toBe(memoized)
    expect(runExtract('ExtractId', garbage)).toEqual(memoSnapshot)
  })

  it('ExtractBytesWithNoRef on a parsed garbage-GE box returns the CANONICAL candidate serialization (garbage normalized away)', () => {
    const garbage = parseBox(garbageBytes)
    const canonical = parseBox(canonicalBytes)

    const noRefGarbage = runExtract('ExtractBytesWithNoRef', garbage)
    const noRefCanonical = runExtract('ExtractBytesWithNoRef', canonical)

    // The twins CONVERGE (JVM has no retained candidate slice) ...
    expect(noRefGarbage).toEqual(noRefCanonical)
    // ... on the canonical candidate serialization, which here equals the
    // canonical full bytes minus the txId+index tail ...
    expect(noRefCanonical).toEqual(canonicalBytes.slice(0, canonicalBytes.length - REF_TAIL_LEN))
    // ... and is NOT a retained-minus-tail slice of the garbage twin.
    expect(noRefGarbage).not.toEqual(garbageBytes.slice(0, garbageBytes.length - REF_TAIL_LEN))
  })

  it('constructed box (no retainedBytes): all three accessors agree with the canonical fallback', () => {
    const constructed: SValue = { kind: 'Box', value: identityGeBox() }
    const full = serializeBoxBytes(identityGeBox())
    const noRef = serializeBoxBytesWithoutRef(identityGeBox())

    expect(runExtract('ExtractBytes', constructed)).toEqual(full)
    expect(runExtract('ExtractId', constructed)).toEqual(blake2b256(full))
    expect(runExtract('ExtractBytesWithNoRef', constructed)).toEqual(noRef)
    // The two canonical layouts stay distinct: full = candidate + txId + index.
    expect(full.length).toBe(noRef.length + REF_TAIL_LEN)
  })

  it('costs unchanged: Fixed(12) per extractor + Const(5)', () => {
    const garbage = parseBox(garbageBytes)
    for (const tag of ['ExtractBytes', 'ExtractBytesWithNoRef', 'ExtractId'] as ExtractTag[]) {
      const ctx = makeContext()
      runExtract(tag, garbage, ctx)
      expect(ctx.jitCost).toBe(17)
    }
  })
})
