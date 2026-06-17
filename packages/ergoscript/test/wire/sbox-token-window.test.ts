/**
 * SBox 4096-byte lazy candidate window (F5 batch 5).
 *
 * The JVM data layer has NO token-count rule: `parseBodyWithIndexedDigests`
 * reads `nTokens = r.getUByte()` bare (ErgoBoxCandidate.scala:200) — the u8
 * read's natural ceiling 255 is the only count bound. The real gate is a
 * 4096-byte candidate-size window: `r.positionLimit = r.position +
 * ErgoBox.MaxBoxSize` (4096, SigmaConstants.scala:24) at candidate start
 * (ErgoBoxCandidate.scala:191-192), restored at :235 AFTER registers and
 * BEFORE ErgoBox's txId/index reads (ErgoBox.scala:214-225). Crossing throws
 * CheckPositionLimit = validation rule 1014 (ValidationRules.scala:169-189),
 * surfaced here as scorex `ReaderError('position-limit-exceeded')`.
 *
 * LAZY window semantics (SANTA-pinned, Ask 18, blessed santa@4e27b84): ONE
 * `position > positionLimit` check at the START of each logical primitive
 * read (CoreByteReader.scala:25-27; per-get call sites :36-108). So:
 *   1. a read whose START is <= the limit may END past it (straddle),
 *   2. an overrun by the candidate's FINAL read ESCAPES entirely,
 *   3. a read beginning exactly AT the limit passes (strict `>`).
 *
 * Contract: facts/ergoscript-wire.md "F5 batch 5 wire updates" section +
 * facts/scorex.md "Position-limit read window" block.
 *
 * These pins hand-roll box BYTES (the sbox-field-bounds.test.ts convention)
 * so the exact byte offsets relative to the window limit are controlled.
 */

import { describe, it, expect } from 'vitest'
import { parseSValue, SValueParseError } from '../../src/wire/parse-svalue'
import { serializeBoxBytesWithoutRef } from '../../src/wire/ergo-box-bytes'
import { boxIdOf } from '../../src/eval/_box-id'
import { blake2b256 } from '../../src/crypto/hashes'
import { ByteReader, ReaderError } from '@ergots/scorex'
import type { ErgoBox, SValue } from '../../src/mir/types'

// ---------------------------------------------------------------------------
// Byte builders
// ---------------------------------------------------------------------------

// Minimal parse-valid ErgoTree: header=0x00 (hasSize=false, no segregation),
// body = Height global (0xa3) — a minimal valid root Expr (2 bytes total).
const MINIMAL_TREE = [0x00, 0xa3]

/** Unsigned VLQ encoding (LSB-first 7-bit groups). */
function vlq(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    let b = v % 128
    v = Math.floor(v / 128)
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return out
}

/** One token entry: 32-byte id (fill byte) + amount VLQ (default 1). */
function token(idFill: number, amountVlq: number[] = [0x01]): number[] {
  return [...(Array(32).fill(idFill & 0xff) as number[]), ...amountVlq]
}

/** Coll[Byte] register: SType 0x0e + VLQ length + N raw payload bytes. */
function collByteRegister(n: number, fill = 0xee): number[] {
  return [0x0e, ...vlq(n), ...(Array(n).fill(fill) as number[])]
}

interface BoxParts {
  value?: number[] // VLQ u64, default [0x01]
  tree?: number[] // default MINIMAL_TREE
  height?: number[] // VLQ u32, default [0x01]
  tokens?: number[][] // pre-encoded token entries
  registers?: number[][] // pre-encoded register Exprs (R4..)
  txId?: number[] // 32 raw bytes
  index?: number[] // VLQ u16, default [0x00]
}

/**
 * Assemble full SBox wire bytes. Candidate span = value..registers; txId and
 * index sit OUTSIDE the window (ErgoBox.scala:214-225). Returns the bytes
 * plus the candidate's byte length (= offset where txId starts), so tests
 * can assert window math explicitly.
 */
function buildBox(parts: BoxParts): { bytes: Uint8Array; candidateLength: number } {
  const {
    value = [0x01],
    tree = MINIMAL_TREE,
    height = [0x01],
    tokens = [],
    registers = [],
    txId = Array(32).fill(0xbb) as number[],
    index = [0x00],
  } = parts
  const candidate = [
    ...value,
    ...tree,
    ...height,
    tokens.length,
    ...tokens.flat(),
    registers.length,
    ...registers.flat(),
  ]
  return {
    bytes: new Uint8Array([...candidate, ...txId, ...index]),
    candidateLength: candidate.length,
  }
}

function parseBox(bytes: Uint8Array): { v: SValue; r: ByteReader } {
  const r = new ByteReader(bytes)
  const v = parseSValue({ tag: 'SBox' }, 0, r)
  return { v, r }
}

/** Narrow a parsed SValue to its ErgoBox payload. */
function asBox(v: SValue): ErgoBox {
  if (v.kind !== 'Box') throw new Error(`expected Box, got ${v.kind}`)
  return v.value
}

/** Assert fn throws ReaderError with code 'position-limit-exceeded'. */
function expectPositionLimit(fn: () => unknown): ReaderError {
  let caught: unknown
  try {
    fn()
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(ReaderError)
  expect((caught as ReaderError).code).toBe('position-limit-exceeded')
  return caught as ReaderError
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

describe('SBox 4096-byte candidate window (parse)', () => {
  // (a) The old >122 count gate is GONE: 123 tokens fit the window and parse.
  // Candidate = value(1) + tree(2) + height(1) + tokenCount(1) + 123*33(4059)
  // + regCount(1) = 4065 <= 4096. (SANTA measured boundary: 123 tokens fits;
  // the old 122 cap was not even the right count approximation.)
  it('parses a 123-token minimal box (count gate removed; candidate 4065 <= 4096)', () => {
    const tokens = Array.from({ length: 123 }, (_, i) => token(i))
    const { bytes, candidateLength } = buildBox({ tokens })
    expect(candidateLength).toBe(4065)

    // Must not throw — specifically not SValueParseError
    // 'sbox-tokens-out-of-range' (the pre-F5-batch-5 count gate).
    expect(() => parseBox(bytes)).not.toThrow(SValueParseError)
    const { v, r } = parseBox(bytes)
    const box = asBox(v)
    expect(box.tokens.length).toBe(123)
    expect(box.tokens[122]!.amount).toBe(1n)
    expect(r.isExhausted).toBe(true)
  })

  // (h) Serialize-side tie-in: the parsed 123-token box re-serializes
  // (egress gate relaxed to the u8 ceiling 255 — ErgoBoxCandidate.scala:144
  // putUByte) and derives its id. T4's blessed vectors depend on both.
  it('re-serializes and id-derives the parsed 123-token box (serialize gate relaxed)', () => {
    const tokens = Array.from({ length: 123 }, (_, i) => token(i))
    const { bytes, candidateLength } = buildBox({ tokens })
    const box = asBox(parseBox(bytes).v)

    // bytesWithoutRef re-serializes the candidate body — byte-identical to
    // the input's candidate span.
    const body = serializeBoxBytesWithoutRef(box)
    expect(body).toEqual(bytes.subarray(0, candidateLength))

    // boxIdOf hashes the retained full bytes (JVM ErgoBox.id basis).
    expect(boxIdOf(box)).toEqual(blake2b256(bytes))
  })

  // (b) 124 tokens cannot fit: candidate = 5 + 124*33 + 1 = 4098 > 4096.
  // Walk: token #123's id read begins at 4064 <= 4096 (ends 4096), its amount
  // read begins exactly AT 4096 (strict `>` passes), then the regCount read
  // begins at 4097 > 4096 -> rule-1014 reject.
  it("rejects a 124-token minimal box with 'position-limit-exceeded' (candidate 4098 > 4096)", () => {
    const tokens = Array.from({ length: 124 }, (_, i) => token(i))
    const { bytes, candidateLength } = buildBox({ tokens })
    expect(candidateLength).toBe(4098)

    expectPositionLimit(() => parseBox(bytes))
  })

  // (i) Sized-tree skip straddling the window (T3 review rider): the box's
  // ErgoTree field is a SIZED tree — header 0x08 (v0 + hasSize), VLQ size
  // 4200 — whose body the lenient consumer SKIPS via one readBytes(4200) on
  // the shared (windowed) reader. Walk: the skip BEGINS at 4 <= 4096 (entry
  // check passes) and ENDS at 4204 — a straddle, tolerated like any logical
  // read — then the creationHeight read begins at 4204 > 4096 -> rule-1014
  // reject. Pins the sized-body readBytes inside `parseErgoTreeBytes` to
  // the candidate window (a refactor that consumed the sized body off-window
  // — e.g. via a forked sub-reader — would accept this box).
  it("rejects a sized-tree skip crossing the window with 'position-limit-exceeded' (reject at the creationHeight read)", () => {
    const sizedTree = [0x08, ...vlq(4200), ...(Array(4200).fill(0x77) as number[])]
    const { bytes, candidateLength } = buildBox({ tree: sizedTree })
    // candidate = value(1) + tree(1 + 2 + 4200) + height(1) + tokenCount(1)
    // + regCount(1) = 4207 > 4096
    expect(candidateLength).toBe(4207)

    expectPositionLimit(() => parseBox(bytes))
  })

  // (c) Fat-trailing ACCEPT — the lazy pin (SANTA destobox-fat-trailing-accept):
  // 2 tokens + a LAST register that is a fat Coll[Byte] (4200-byte payload).
  // Layout: head 5 + 2*33 = 71 -> regCount at 71; R4 type 0x0e at 72, VLQ
  // len at 73-74, payload readBytes(4200) BEGINS at 75 <= 4096 and ENDS at
  // 4275 — the candidate's FINAL read straddles the limit and ESCAPES
  // entirely (one entry check, then the byte run is unchecked). Candidate
  // 4275 > 4096 yet the box ACCEPTS. An eager/per-byte window would reject.
  it('accepts a >4096 candidate whose overrun is the FINAL read (fat trailing register escapes)', () => {
    const { bytes, candidateLength } = buildBox({
      tokens: [token(0xaa), token(0xab)],
      registers: [collByteRegister(4200)],
    })
    expect(candidateLength).toBe(4275)

    const { v, r } = parseBox(bytes)
    const box = asBox(v)
    const r4 = box.registers[4]!
    if (r4.value.kind !== 'Coll') throw new Error(`expected Coll, got ${r4.value.kind}`)
    expect(r4.value.items.length).toBe(4200)
    expect(r.isExhausted).toBe(true)
  })

  // (d) fat-then-reg: same fat R4 as the fat-trailing pin but with a small R5
  // AFTER it — R5's lead-byte read begins at 4275 > 4096 -> reject. (SANTA
  // fat-then-reg twin: the JVM errors at R5's read.)
  it("rejects fat R4 followed by R5 with 'position-limit-exceeded' (non-final read past limit)", () => {
    const fatR4 = collByteRegister(4200)
    const smallR5 = [0x01, 0x01] // SBoolean const: type 0x01 + value byte
    const { bytes } = buildBox({
      tokens: [token(0xaa), token(0xab)],
      registers: [fatR4, smallR5],
    })

    expectPositionLimit(() => parseBox(bytes))
  })

  // (e) txId/index sit OUTSIDE the window: candidate ends at 4090 (within 10
  // bytes of the limit), txId spans [4090, 4122) and index reads at 4122 —
  // TOTAL 4123 > 4096 — yet the box parses because the restore precedes the
  // txId read (ErgoBoxCandidate.scala:235 before ErgoBox.scala:214-225).
  // Without the restore, the index read at 4122 > 4096 would reject.
  it('parses a box whose txId/index push the TOTAL past 4096 (restore precedes those reads)', () => {
    // candidate = 5(head) + 1(regCount) + 1(type) + 2(len VLQ) + 4081 = 4090
    const { bytes, candidateLength } = buildBox({
      registers: [collByteRegister(4081)],
      index: [0x2a], // 42
    })
    expect(candidateLength).toBe(4090)
    expect(bytes.length).toBe(4123)

    const { v, r } = parseBox(bytes)
    const box = asBox(v)
    expect(box.index).toBe(42)
    expect(r.isExhausted).toBe(true)
  })

  // (g) Straddling final VLQ — the T2-C1 delegation pin at the integration
  // tier: the LAST register is an SAvlTree whose valueLengthOpt VLQ BEGINS
  // exactly AT the limit (strict `>` passes) and continues past it (the
  // continuation byte is read unchecked — one window check per LOGICAL read;
  // a per-byte readU8 loop would reject). Layout: R4 = Coll[Byte](4050) pads
  // so R5 (SAvlTree 0x64) starts at 4059: digest 33B at 4060..4093, flags at
  // 4093, keyLength VLQ at 4094, option tag at 4095, valueLengthOpt VLQ at
  // 4096 == limit, bytes [0xac, 0x02] = 300 ending at 4098.
  it('accepts an SAvlTree register whose final VLQ begins AT the limit and straddles past it', () => {
    const avlR5 = [
      0x64, // SAvlTree type code
      ...(Array(33).fill(0xdd) as number[]), // digest (32-byte hash + height byte)
      0x01, // treeFlags: insert-allowed
      0x20, // keyLength VLQ = 32
      0x01, // valueLengthOpt tag = Some
      0xac, 0x02, // VLQ 300 — begins at 4096 == limit, continuation byte past it
    ]
    const { bytes, candidateLength } = buildBox({
      registers: [collByteRegister(4050), avlR5],
    })
    expect(candidateLength).toBe(4098)

    const { v, r } = parseBox(bytes)
    const box = asBox(v)
    const r5 = box.registers[5]!
    if (r5.value.kind !== 'AvlTree') throw new Error(`expected AvlTree, got ${r5.value.kind}`)
    expect(r5.value.value.keyLength).toBe(32)
    expect(r5.value.value.valueLengthOpt).toBe(300)
    expect(r.isExhausted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (f) Nested box-in-register windows
// ---------------------------------------------------------------------------
//
// A register may carry an SBox-typed Const (SBox type code 0x63 <=
// LAST_CONSTANT_CODE; SBox is NOT in the rule-1019 reject set — that set is
// {SOption, SHeader, SUnsignedBigInt}). The inner box's data parse arms its
// OWN 4096-byte window on the shared reader; the no-clamp setter means the
// inner limit (innerStart + 4096) always EXCEEDS the outer limit
// (CoreByteReader.scala:133-137), and the inner restore reinstates the OUTER
// limit before the inner box's txId/index reads.
//
// NOTE on the "inner candidate crosses the outer limit AND is accepted"
// shape: it is UNCONSTRUCTIBLE — on the JVM as well as here, by structure,
// not by implementation choice. The inner box's txId read (checked, 32
// bytes) begins immediately after the inner candidate ends and runs under
// the RESTORED OUTER limit (DataSerializer SBox case ->
// ErgoBox.sigmaSerializer.parse: candidate parse restores at
// ErgoBoxCandidate.scala:235, THEN txId/index at ErgoBox.scala:214-225). The
// cursor is monotonic, so "inner candidate crossed the outer limit" forces
// "inner txId read begins past the outer limit" -> rule 1014. Acceptance
// requires the inner candidate to end >= 32 bytes INSIDE the outer limit —
// in which case no inner-candidate read ever begins past the outer limit.
// Consequently the no-clamp widening is verdict-invisible for box-in-register
// nesting: it changes WHERE the reject fires (later, at the inner txId,
// after the widened window let the inner candidate's reads proceed past the
// outer limit), never WHETHER. The two pins below fix both facets.
describe('SBox nested box-in-register windows', () => {
  /** Inner box bytes (full SBox wire: candidate + txId + index). */
  function innerBoxBytes(parts: BoxParts): number[] {
    const { bytes } = buildBox(parts)
    return Array.from(bytes)
  }

  // (f1) Inner candidate crossing the outer limit: REJECTED at the inner
  // txId read — at position 4105, NOT at the first inner read past the outer
  // limit (4103). The error position proves both halves of the JVM mechanism:
  //   - the inner window WIDENED past the outer limit (no clamp): the inner
  //     token-amount read beginning at 4103 > 4096 PASSED under the inner
  //     limit 4136 (a clamped reader would have rejected right there), and
  //   - the inner restore reinstates the OUTER limit (not the buffer end,
  //     not the inner limit — either of those would ACCEPT this box): the
  //     inner txId read at 4105 > 4096 is what fires.
  // Layout: outer head 5 + 1 token (33) -> regCount at 38, R4 lead 0x63 at
  // 39, inner box at 40. Inner: head 5 + 123*33 = 4059 tokens ending 4104 +
  // regCount at 4104 -> inner candidate [40, 4105) crossing outer limit
  // 4096, inside inner limit 40 + 4096 = 4136.
  it("rejects an inner candidate crossing the outer limit at the inner txId read ('position-limit-exceeded' at 4105)", () => {
    const inner = innerBoxBytes({
      tokens: Array.from({ length: 123 }, (_, i) => token(i)),
    })
    const { bytes } = buildBox({
      tokens: [token(0xcc)],
      registers: [[0x63, ...inner]],
    })

    const err = expectPositionLimit(() => parseBox(bytes))
    expect(err.message).toContain('position limit 4096')
    expect(err.message).toContain('position 4105')
  })

  // (f2) The constructible ACCEPT neighbor: the inner box IS accepted with
  // bytes consumed past the outer limit — when the crossing happens on the
  // inner box's TAIL reads (txId/index, post-restore, under the OUTER
  // window's own strict-> / straddle semantics) rather than inside the inner
  // candidate. Inner candidate ends exactly at outerLimit - 32 = 4064; inner
  // txId spans [4064, 4096); inner index VLQ begins exactly AT 4096 (strict
  // `>` passes) and its continuation byte at 4097 is read unchecked ->
  // index = 300, ACCEPT. Also proves the inner arm/restore cycle leaves the
  // outer window intact for the outer txId/index that follow.
  it('accepts an inner box whose index VLQ begins AT the outer limit and straddles past it', () => {
    // inner candidate = 5(head) + 1(regCount) + 3(Coll[Byte] type+len) +
    // 4015(payload) = 4024; inner box at 40 -> candidate ends 40 + 4024 = 4064
    const inner = innerBoxBytes({
      registers: [collByteRegister(4015)],
      txId: Array(32).fill(0x99) as number[],
      index: [0xac, 0x02], // VLQ 300, begins exactly at outer limit 4096
    })
    const { bytes, candidateLength } = buildBox({
      tokens: [token(0xcc)],
      registers: [[0x63, ...inner]],
      index: [0x07],
    })
    // outer candidate = 39(pre-register) + 1(lead) + inner(4024 + 32 + 2) = 4098
    expect(candidateLength).toBe(4098)

    const { v, r } = parseBox(bytes)
    const outer = asBox(v)
    const r4 = outer.registers[4]!
    if (r4.value.kind !== 'Box') throw new Error(`expected Box, got ${r4.value.kind}`)
    expect(r4.value.value.index).toBe(300)
    expect(outer.index).toBe(7)
    expect(r.isExhausted).toBe(true)
  })
})
