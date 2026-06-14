/**
 * Rule-1019 `CheckV6Type` at box-register ingress (F5 batch 3, W7).
 *
 * JVM `ValidationRules.scala:165-205` (`CheckV6Type`) rejects, at box-register
 * deserialize, any register whose declared type *contains* (recursing through
 * `STuple` items and `SCollection` elemType) a leaf that is an `SOption` (any),
 * `SHeader`, or `SUnsignedBigInt`. Enforced at `ErgoBoxCandidate.scala:232`
 * inside the per-register loop, UNCONDITIONALLY — the rule sits in BOTH
 * `ruleSpecsV5` and `ruleSpecsV6` (a v0 box with an Option-typed register
 * rejects just as a v6 one does).
 *
 * Type set (verified against source):
 *   - any `SOption`            (`tpe.isOption = tpe.isInstanceOf[SOption[_]]`, package.scala:115)
 *   - `SHeader`                (typeCode 104, SType.scala:910)
 *   - `SUnsignedBigInt`        (typeCode 9,   SType.scala:547)
 * Recursion (JVM `step`): STuple → items.foreach(step); SCollection →
 * step(elemType) (matched AFTER STuple, since STuple <: SCollection); leaf →
 * v6TypeCheck.
 *
 * ergots gates this at `parseRegisterExprWithTag` (parse-svalue.ts) right after
 * the register TYPE is parsed and BEFORE the value parse — so the throw happens
 * in `parseTree` / `parseSValue(SBox)` at deserialize, not at eval. Throws
 * `SValueParseError` code `'register-v6-type'`.
 *
 * JVM-blessed witness W7 (full tree carrying a `Const(SBox)` whose R4 register
 * is `Option[Int]`-typed): JVM rejects at box deserialize; ergots used to parse.
 */

import { describe, it, expect } from 'vitest'
import { parseSValue, SValueParseError } from '../../src/wire/parse-svalue'
import { parseTree } from '../../src/wire/ergo-tree'
import { ByteReader } from '@ergots/scorex'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16)
  return out
}

// Minimal v0+hasSize=false P2PK ErgoTree (36 bytes): header 0x00 | SSigmaProp
// (0x08) | ProveDlog (0xcd) | 33-byte point (test data, not a real curve point).
const P2PK_TREE = [0x00, 0x08, 0xcd, 0x02, ...Array.from({ length: 32 }, () => 0xaa)]
const TXID = Array.from({ length: 32 }, () => 0xbb)

/**
 * Build a single-register SBox on the wire. `regBytes` is the full register
 * wire form: SType byte(s) followed by the SValue bytes.
 *
 * SBox layout (chain/ergo_box.rs:201-223): value VLQ u64 | ergo_tree |
 * creation_height VLQ u32 | tokens_count u8 | regs u8 | per-register | txId(32)
 * | index VLQ u16.
 */
function sboxWithRegister(regBytes: number[]): Uint8Array {
  return new Uint8Array([
    0x80, 0x01, // value VLQ u64 = 128
    ...P2PK_TREE,
    0x00, // creation_height VLQ u32 = 0
    0x00, // tokens_count
    0x01, // additional_regs = 1 (R4)
    ...regBytes,
    ...TXID,
    0x00, // index VLQ u16 = 0
  ])
}

// SType byte codes (parse-stype.ts container math: containerId*12 + primId).
// primIds: SBoolean=1 SByte=2 SShort=3 SInt=4 SLong=5 SBigInt=6 GE=7 SigmaProp=8 UBI=9
const T_OPTION_INT = 0x28 // OPTION_CONSTR_ID(3)*12 + SInt(4) = 40
const T_COLL_OPTION_INT = [0x0c, 0x28] // COLL_CONSTR_ID(1)*12 + 0, then Option[Int]
// (Int, Option[Int]): TUPLE_PAIR1_CONSTR_ID(5)*12 + SInt(4) = 64 (0x40), then Option[Int] (0x28).
const T_PAIR_INT_OPTION_INT = [0x40, 0x28]
const T_SHEADER = 0x68 // 104
const T_UBI = 0x09 // 9
const T_COLL_BYTE = 0x0e // COLL_CONSTR_ID(1)*12 + SByte(2) = 14
const T_LONG = 0x05
const T_INT = 0x04

describe('rule-1019 CheckV6Type — box register type contains v6-only type', () => {
  // --- W7: full tree, Const(SBox) segregated constant, R4 = Option[Int] ---
  it('W7: parseTree rejects a v3 tree whose SBox-constant R4 is Option[Int]', () => {
    const W7 =
      '1b330163c0843d0b0208d300000128010a000000000000000000000000000000000000000000000000000000000000000000c17300'
    let thrown: unknown
    try {
      parseTree(hexToBytes(W7))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SValueParseError)
    expect((thrown as SValueParseError).code).toBe('register-v6-type')
  })

  // --- Type-set coverage (parse the SBox directly) ---
  function expectRegisterReject(regBytes: number[], treeVersion = 3): void {
    let thrown: unknown
    try {
      parseSValue({ tag: 'SBox' }, treeVersion, new ByteReader(sboxWithRegister(regBytes)))
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SValueParseError)
    expect((thrown as SValueParseError).code).toBe('register-v6-type')
  }

  it('rejects an Option[Int]-typed register', () => {
    // Some(Int 5): tag 0x01, ZigZag VLQ 0x0a. Value bytes are never reached (gate
    // fires after the type parse) but kept valid for completeness.
    expectRegisterReject([T_OPTION_INT, 0x01, 0x0a])
  })

  it('rejects a Coll[Option[Int]]-typed register (recursion via SColl)', () => {
    // Coll length 0 so no inner Option DATA is decoded — the gate must fire on
    // the TYPE alone, not on a present value.
    expectRegisterReject([...T_COLL_OPTION_INT, 0x00])
  })

  it('rejects a (Int, Option[Int])-typed register (recursion via STuple)', () => {
    expectRegisterReject([...T_PAIR_INT_OPTION_INT, 0x00, 0x01, 0x0a])
  })

  it('rejects an SHeader-typed register', () => {
    expectRegisterReject([T_SHEADER])
  })

  it('rejects an SUnsignedBigInt-typed register', () => {
    expectRegisterReject([T_UBI, 0x01, 0x05])
  })

  // --- Negative controls: plain types must NOT reject ---
  function expectRegisterAccepts(regBytes: number[]): void {
    const v = parseSValue({ tag: 'SBox' }, 3, new ByteReader(sboxWithRegister(regBytes)))
    expect(v.kind).toBe('Box')
  }

  it('accepts a Coll[Byte]-typed register (negative control)', () => {
    expectRegisterAccepts([T_COLL_BYTE, 0x02, 0xde, 0xad]) // len 2, bytes de ad
  })

  it('accepts a Long-typed register (negative control)', () => {
    expectRegisterAccepts([T_LONG, 0x02]) // ZigZag VLQ Long = 1
  })

  it('accepts an Int-typed register (negative control)', () => {
    expectRegisterAccepts([T_INT, 0x0a]) // ZigZag VLQ Int = 5
  })

  // --- All-versions: the gate is UNCONDITIONAL (rule in ruleSpecsV5 + V6) ---
  it('rejects an Option[Int] register at tree-version 0 (unconditional)', () => {
    expectRegisterReject([T_OPTION_INT, 0x01, 0x0a], 0)
  })

  it('rejects an Option[Int] register at tree-version 2 (unconditional)', () => {
    expectRegisterReject([T_OPTION_INT, 0x01, 0x0a], 2)
  })

  it('rejects an SUnsignedBigInt register at tree-version 0 (unconditional)', () => {
    expectRegisterReject([T_UBI, 0x01, 0x05], 0)
  })
})
