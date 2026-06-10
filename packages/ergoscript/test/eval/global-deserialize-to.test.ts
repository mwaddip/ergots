/**
 * v6 P5a — SGlobal.deserializeTo (MethodCall, 106:4) eval handler.
 *
 * JVM source: sigma/ast/methods.scala:1906-1955 — PerItemCost(100,32,32)
 * on input bytes.length, V3-gated (isV3OrLaterErgoTreeVersion).
 *
 * Cost decomposition (consensus-load-bearing, asserted exactly):
 *   4 (MethodCall dispatcher) + 5 (Global sentinel) + 5 (Const arg) +
 *   addPerItemCost(100, 32, 32, inputLen) (handler)
 *
 * For inputLen in [1..32]:  1 chunk → handler = 100 + 32 = 132 → total = 146.
 * For inputLen = 33:        2 chunks → handler = 100 + 64 = 164 → total = 178.
 *
 * Faithfulness pins (each a fork if wrong):
 * - Trailing bytes are IGNORED — no reader exhaustion check.
 * - Cost is charged BEFORE parsing (even on parse failure).
 * - Types nested > MaxTreeDepth(110) reject with global-deserialize-failed.
 */

import { describe, expect, it } from 'vitest'
import { blake2b } from '@noble/hashes/blake2.js'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { hexToBytes } from '../_helpers'
import type { MethodCall, SType, SValue } from '../../src/mir/types'

const SBYTE: SType = { tag: 'SByte' }
const COLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }

function collByteConst(bytes: number[]): MethodCall['args'][number] {
  const items: SValue[] = bytes.map((b) => ({ kind: 'Byte', value: b }))
  return { tag: 'Const', tpe: COLL_BYTE, value: { kind: 'Coll', elem: SBYTE, items } }
}

function deserExpr(T: SType, bytes: number[]): MethodCall {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 4,
    args: [collByteConst(bytes)],
    explicitTypeArgs: { T },
  }
}

describe('Global.deserializeTo (106:4) — v6 P5a', () => {
  // -------- value + cost (1..32 bytes = 1 chunk) --------

  it('deserializeTo[Int]([10]) → Int 5, cost 146', () => {
    // ZigZag-VLQ: 10 (raw byte) → zigzag_decode(10) = 5
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr({ tag: 'SInt' }, [10]), Env.empty(), ctx)
    expect(r).toEqual({ kind: 'Int', value: 5 })
    expect(ctx.jitCost).toBe(146)
  })

  it('deserializeTo[Byte]([7]) → Byte 7, cost 146', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(SBYTE, [7]), Env.empty(), ctx)
    expect(r).toEqual({ kind: 'Byte', value: 7 })
    expect(ctx.jitCost).toBe(146)
  })

  it('deserializeTo[Coll[Byte]]([3,1,2,3]) → Coll[Byte](1,2,3), cost 146', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(COLL_BYTE, [3, 1, 2, 3]), Env.empty(), ctx)
    expect(r).toEqual({
      kind: 'Coll',
      elem: SBYTE,
      items: [
        { kind: 'Byte', value: 1 },
        { kind: 'Byte', value: 2 },
        { kind: 'Byte', value: 3 },
      ],
    })
    expect(ctx.jitCost).toBe(146)
  })

  // -------- cost boundary: 33 bytes = 2 chunks --------

  it('deserializeTo[Coll[Byte]] of 33-byte input → cost 178', () => {
    // 32-element coll: length VLQ = 0x20 = 32, then 32 data bytes → 33 total input bytes.
    const bytes = [0x20, ...Array(32).fill(0)]
    const ctx = makeContext({ treeVersion: 3 })
    evalMethodCall(deserExpr(COLL_BYTE, bytes), Env.empty(), ctx)
    expect(ctx.jitCost).toBe(178)
  })

  // -------- FAITHFULNESS PIN: trailing bytes IGNORED --------

  it('deserializeTo[Byte]([7, 99, 99]) → Byte 7 (trailing bytes ignored)', () => {
    // JVM does NOT check reader exhaustion — trailing bytes are silently discarded.
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(SBYTE, [7, 99, 99]), Env.empty(), ctx)
    expect(r).toEqual({ kind: 'Byte', value: 7 })
  })

  // -------- error: malformed bytes --------

  it('malformed bytes for Int (empty) → EvalError(global-deserialize-failed)', () => {
    const ctx = makeContext({ treeVersion: 3 })
    try {
      evalMethodCall(deserExpr({ tag: 'SInt' }, []), Env.empty(), ctx)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('global-deserialize-failed')
      // Pins the cost-before-parse faithfulness pin: PerItemCost(100,32,32,0)=132
      // is charged even though the parse fails. Total = 4 (disp) + 5 (Global) +
      // 5 (Const) + 132. A regression moving addPerItemCost after parse would fail here.
      expect(ctx.jitCost).toBe(146)
    }
  })

  // -------- V3 gate --------

  it('V3 gate — treeVersion 2 throws tree-version-too-low', () => {
    const ctx = makeContext({ treeVersion: 2 })
    expect(() => evalMethodCall(deserExpr(SBYTE, [7]), Env.empty(), ctx)).toThrowError(EvalError)
  })

  // -------- MaxTreeDepth(110) bound — DATA-DRIVEN (consensus) --------
  // The JVM increments its reader level once per ACTUAL recursive deserialize
  // call (CoreDataSerializer), descending only into elements that are PRESENT,
  // and throws when level > 110 (CoreByteReader.level_=). So the bound is
  // data-driven, NOT type-structural: a deeply-nested TYPE with empty/shallow
  // DATA is ACCEPTED. parseSValue enforces this via maxDepth=110 (1 level/call).

  it('deeply-nested TYPE with empty data is ACCEPTED (data-driven, not type depth)', () => {
    // 111 SColl wraps around SByte, but bytes [0] = empty outer Coll (len 0):
    // the parse recurses 0 times (depth 1) → empty Coll. A type-structural gate
    // would wrongly reject this depth-112 type; the data-driven bound accepts it.
    let T: SType = { tag: 'SByte' }
    for (let i = 0; i < 111; i++) T = { tag: 'SColl', elem: T }
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(T, [0]), Env.empty(), ctx)
    expect(r).toMatchObject({ kind: 'Coll', items: [] })
  })

  it('data that recurses past depth 110 throws global-deserialize-failed', () => {
    // 111 SColl wraps; each level carries 1 element (length byte 0x01), forcing
    // the parse to recurse to depth 111 (> 110) → throw. ~110 length bytes drive it.
    let T: SType = { tag: 'SByte' }
    for (let i = 0; i < 111; i++) T = { tag: 'SColl', elem: T }
    const deepData = new Array(115).fill(1)
    const ctx = makeContext({ treeVersion: 3 })
    expect(() => evalMethodCall(deserExpr(T, deepData), Env.empty(), ctx)).toThrowError(EvalError)
    try {
      evalMethodCall(deserExpr(T, deepData), Env.empty(), makeContext({ treeVersion: 3 }))
    } catch (e) {
      expect((e as EvalError).code).toBe('global-deserialize-failed')
    }
  })

  it('data recursing to exactly depth 110 is allowed (boundary)', () => {
    // 110 SColl wraps; the outer 109 each carry 1 element, the innermost
    // Coll[Byte] (NativeColl) is empty → deepest recursion = depth 110 (= the
    // limit, not exceeding it) → accepted.
    let T: SType = { tag: 'SByte' }
    for (let i = 0; i < 110; i++) T = { tag: 'SColl', elem: T }
    const data = new Array(109).fill(1).concat([0]) // 109 len-1 markers + innermost len 0
    const ctx = makeContext({ treeVersion: 3 })
    const r = evalMethodCall(deserExpr(T, data), Env.empty(), ctx)
    expect(r).toMatchObject({ kind: 'Coll' })
  })
})

// ---------------------------------------------------------------------------
// F5 batch 4 (member D part 2) — GE canonical-bytes invariant on the
// deserializeTo[Header] hydration leg (minerPk + v1 powOnetimePk).
//
// JVM verdict: DataSerializer.deserialize SHeader (DataSerializer.scala:39-44)
// → ErgoHeader.sigmaSerializer.parse, whose AutolykosSolution serializers route
// BOTH pk legs through GroupElementSerializer.parse (sigmaSerializerV1.parse
// ErgoHeader.scala:72-79: pk + w; sigmaSerializerV2.parse :89-93: pk). So
// 0x00-lead → identity POINT (re-serializes as 33 zeros); invalid
// non-0x00-lead → throw, surfaced as the deserialize failure.
//
// id basis: the JVM retains the CONSUMED INPUT SLICE as `_bytes`
// (ErgoHeader.scala:167-180 capture) and derives id = Blake2b256(_bytes)
// (:132-140) — id derivation precedes any GE normalization, so a garbage-pk
// header keeps its garbage-based id while the VALUE normalizes.
//
// Header material: the SANTA-blessed vectors in
// test/fixtures/conformance/v6/spec/Global.deserializeTo_header.json
// (jvm:sigma-state-6.0.3). Empirical pins from SANTA Ask 16 (vendored in a
// later task): garbage-pk accepts with getEncoded → 33 zeros; invalid-pk →
// eval-errored; header id-basis EQ false.
// ---------------------------------------------------------------------------

// V2 header (Autolykos v2: trailing 41 bytes = minerPk(33) + nonce(8)).
const V2_HEADER_HEX =
  '02ac2101807f0000ca01ff0119db227f202201007f62000177a080005d440896d05d3f80dcff7f5e7f59007294c180808d0158d1ff6ba10000f901c7f0ef87dcfff17fffacb6ff7f7f1180d2ff7f1e24ffffe1ff937f807f0797b9ff6ebdae007e5c8c00b8403d3701557181c8df800001b6d5009e2201c6ff807d71808c00019780f087adb3fcdbc0b3441480887f80007f4b01cf7f013ff1ffff564a0000b9a54f00770e807f41ff88c00240000080c0250000000003bedaee069ff4829500b3c07c4d5fe6b3ea3d3bf76c5c28c1d4dcdb1bed0ade0c0000000000003105'
// V1 header (Autolykos v1: minerPk(33) + powOnetimePk(33) + nonce(8) + d).
const V1_HEADER_HEX =
  '010000000000000000000000000000000000000000000000000000000000000000766ab7a313cd2fb66d135b0be6662aa02dfa8e5b17342c05a04396268df0bfbb93fb06aa44413ff57ac878fda9377207d5db0e78833556b331b4d9727b3153ba18b7a08878f2a7ee4389c5a1cece1e2724abe8b8adc8916240dd1bcac069177303f1f6cee9ba2d0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8060117650100000003be7ad70c74f691345cbedba19f4844e7fc514e1188a7929f5ae261d5bb00bb6602da9385ac99014ddcffe88d2ac5f28ce817cd615f270a0a5eae58acfb9fd9f6a0000000030151dc631b7207d4420062aeb54e82b0cfb160ff6ace90ab7754f942c4c3266b'

// x = 2^256 - 1 > field prime p → not a curve point.
const INVALID_PK = hexToBytes('02' + 'ff'.repeat(32))
// 0x00-lead with garbage tail → JVM identity POINT (tail discarded).
const GARBAGE_PK = hexToBytes('00' + 'aa'.repeat(32))
const CANONICAL_IDENTITY = hexToBytes('00'.repeat(33))

const SHEADER: SType = { tag: 'SHeader' }

/** Replace `field.length` bytes at `offset` with `field`. Returns a fresh array. */
function splice(bytes: Uint8Array, offset: number, field: Uint8Array): Uint8Array {
  const out = bytes.slice()
  out.set(field, offset)
  return out
}

/** Byte offset of the V2 minerPk: Autolykos v2 appendage is the trailing 41 bytes. */
function v2MinerPkOffset(bytes: Uint8Array): number {
  const offset = bytes.length - 41
  expect(bytes[offset]).toBe(0x03) // sanity: blessed minerPk is 03-lead ("bedaee…")
  return offset
}

/** Byte offset of the V1 powOnetimePk, located by its unique 4-byte prefix. */
function v1PowOnetimePkOffset(bytes: Uint8Array): number {
  const prefix = [0x02, 0xda, 0x93, 0x85] // blessed powOnetimePk lead ("da9385…")
  for (let i = 0; i + 33 <= bytes.length; i++) {
    if (prefix.every((b, j) => bytes[i + j] === b)) return i
  }
  throw new Error('v1 powOnetimePk prefix not found')
}

function evalDeserializeHeader(bytes: Uint8Array) {
  const ctx = makeContext({ treeVersion: 3 })
  return evalMethodCall(deserExpr(SHEADER, Array.from(bytes)), Env.empty(), ctx)
}

describe('deserializeTo[Header] — GE canonical-bytes invariant (F5 batch 4)', () => {
  it('minerPk spliced to an invalid curve point → EvalError(global-deserialize-failed)', () => {
    const headerBytes = hexToBytes(V2_HEADER_HEX)
    const spliced = splice(headerBytes, v2MinerPkOffset(headerBytes), INVALID_PK)
    try {
      evalDeserializeHeader(spliced)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('global-deserialize-failed')
      // Pin that the reject came from the GE curve check (wrapped
      // SValueParseError('group-element-invalid-point')), not another parse path.
      expect((e as EvalError).message).toContain('minerPk is not a valid curve point')
    }
  })

  it('minerPk spliced to a 0x00-lead garbage payload → accepts, normalized to 33 zeros', () => {
    const headerBytes = hexToBytes(V2_HEADER_HEX)
    const spliced = splice(headerBytes, v2MinerPkOffset(headerBytes), GARBAGE_PK)
    const r = evalDeserializeHeader(spliced)
    expect(r.kind).toBe('Header')
    if (r.kind !== 'Header') throw new Error('unreachable')
    expect(r.value.autolykosSolution.minerPk).toEqual(CANONICAL_IDENTITY)
  })

  it('v1 powOnetimePk spliced to an invalid curve point → EvalError(global-deserialize-failed)', () => {
    const headerBytes = hexToBytes(V1_HEADER_HEX)
    const spliced = splice(headerBytes, v1PowOnetimePkOffset(headerBytes), INVALID_PK)
    try {
      evalDeserializeHeader(spliced)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('global-deserialize-failed')
      expect((e as EvalError).message).toContain('powOnetimePk is not a valid curve point')
    }
  })

  it('v1 powOnetimePk spliced to a 0x00-lead garbage payload → accepts, normalized to 33 zeros', () => {
    const headerBytes = hexToBytes(V1_HEADER_HEX)
    const spliced = splice(headerBytes, v1PowOnetimePkOffset(headerBytes), GARBAGE_PK)
    const r = evalDeserializeHeader(spliced)
    expect(r.kind).toBe('Header')
    if (r.kind !== 'Header') throw new Error('unreachable')
    expect(r.value.autolykosSolution.powOnetimePk).toEqual(CANONICAL_IDENTITY)
  })

  it('id-basis pin: parsed Header id === blake2b-256 of the consumed header slice', () => {
    // JVM basis: id = Blake2b256(_bytes), _bytes = the consumed input slice
    // (ErgoHeader.scala:132-140, capture :167-180). The SHeader arm pins this
    // basis explicitly over r.slice(start, end) — scorex parseHeader's own
    // derivation (header.ts:112 → deriveHeaderId :183-185) hashes a
    // RE-serialization, which coincides only for canonical encodings.
    for (const hex of [V2_HEADER_HEX, V1_HEADER_HEX]) {
      const headerBytes = hexToBytes(hex)
      const r = evalDeserializeHeader(headerBytes)
      expect(r.kind).toBe('Header')
      if (r.kind !== 'Header') throw new Error('unreachable')
      expect(r.value.id).toEqual(blake2b(headerBytes, { dkLen: 32 }))
    }
  })

  it('id derivation precedes normalization: garbage-pk header keeps its garbage-based id', () => {
    // The JVM hashes the retained INPUT bytes, so splicing the pk CHANGES the
    // id even though the normalized VALUE erases the garbage (SANTA Ask 16:
    // header id-basis EQ false). A re-serialization-based id would wrongly
    // hash the normalized pk back to the canonical-identity form.
    const headerBytes = hexToBytes(V2_HEADER_HEX)
    const spliced = splice(headerBytes, v2MinerPkOffset(headerBytes), GARBAGE_PK)
    const r = evalDeserializeHeader(spliced)
    expect(r.kind).toBe('Header')
    if (r.kind !== 'Header') throw new Error('unreachable')
    expect(r.value.id).toEqual(blake2b(spliced, { dkLen: 32 }))
    expect(r.value.id).not.toEqual(blake2b(headerBytes, { dkLen: 32 }))
  })
})
