/**
 * v6 P5a Task 5 — SGlobal.serialize (106:3) cost walk for COMPLEX types:
 * SAvlTree, SHeader, SBox.
 *
 * These three types have NO standalone JVM verifyCase cost oracle. Their costs
 * rest entirely on faithful transcription of the JVM serializers, mapped to the
 * SigmaByteWriter primitive costs. Each expected total below is DERIVED from the
 * JVM source read during TDD (file:line cited per arm in serialize-cost.ts) —
 * NOT from the design spec's complex-type breakdown, which contained slips:
 * the spec costed several `putUInt(...)` calls at 3, but the JVM serializers for
 * AvlTree/Box/Header use the *no-DataInfo* `putUInt(x: Long)` overload, which
 * SigmaByteWriter does NOT charge (cost 0) — the same SString-class slip the
 * P5a process already caught once. A later F2 conformance run (root cause #5)
 * caught that the *no-DataInfo* `putUByte` overload is NOT free: both overloads
 * delegate via CoreByteWriter → the scorex Writer trait → virtual dispatch back
 * into SigmaByteWriter.put(Byte):45-48 = PutByteCost 1. The no-DataInfo
 * `putUInt(x: Long)` (105-107) writes via the VLQ writer with NO put() delegation
 * and is genuinely 0. Only putUInt-only stays uncosted; every putUByte = 1.
 *
 * Cost decomposition (established framework): total = 4 (dispatcher) + 5 (Global
 * obj) + 5 (Const arg) + handler, where handler = 10 (StartWriter) + walk(T, v).
 *
 * JVM source verified for each arm:
 *   SAvlTree → core/.../data/AvlTreeData.scala:73-79 (serializer.serialize)
 *   SBox     → data/.../org/ergoplatform/ErgoBox.scala:204-212 (sigmaSerializer)
 *              + ErgoBoxCandidate.scala:138-181 (serializeBodyWithIndexedDigests)
 *   SHeader  → data/.../org/ergoplatform/ErgoHeader.scala:157-165
 *              + HeaderWithoutPow.scala:47-65 + AutolykosSolution V2:82-87
 *   Register putValue → ConstantSerializer.scala:13-16 (putType + DataSerializer)
 *                        with NO constant store (methods.scala:1979 startWriter(None,…))
 *   Primitive costs → SigmaByteWriter.scala:45-185 / 235-262.
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { parseSValue } from '../../src/wire/parse-svalue'
import { ByteWriter, ByteReader, deriveHeaderId } from '@ergots/scorex'
import type { MethodCall, SType, SValue, ErgoBox } from '../../src/mir/types'
import type { Header } from '@ergots/scorex'

/** Construct a Global.serialize MethodCall expr over a Const arg. */
function serExpr(tpe: SType, value: SValue): MethodCall {
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 3,
    args: [{ tag: 'Const', tpe, value }],
    explicitTypeArgs: {},
  }
}

/** Framework overhead added on top of the handler. */
const FRAMEWORK = 4 + 5 + 5 // dispatcher + Global obj + Const arg
const START_WRITER = 10

/** Evaluate serialize and return [resultBytes, jitCost]. */
function evalSer(tpe: SType, value: SValue): { bytes: Uint8Array; cost: number } {
  const ctx = makeContext({ treeVersion: 3 })
  const r = evalMethodCall(serExpr(tpe, value), Env.empty(), ctx)
  if (r.kind !== 'Coll' || r.elem.tag !== 'SByte') {
    throw new Error(`expected Coll[Byte] result, got ${r.kind}`)
  }
  const bytes = new Uint8Array(r.items.map((it) => (it as { value: number }).value & 0xff))
  return { bytes, cost: ctx.jitCost }
}

/** Independently serialize (T, v) via the wire serializer, for a byte cross-check. */
function wireBytes(tpe: SType, value: SValue): Uint8Array {
  const w = new ByteWriter()
  serializeSValue(tpe, value, 3, w)
  return w.toBytes()
}

describe('Global.serialize — complex types (v6 P5a Task 5)', () => {
  // ── SAvlTree ───────────────────────────────────────────────────────────────
  //
  // AvlTreeData.serializer (AvlTreeData.scala:73-79):
  //   putBytes(digest 33)      = 3 + 33 = 36
  //   putUByte(flags)          = 1   (F2 #5: both no-DataInfo putUByte overloads
  //                                   delegate CoreByteWriter:37-49 → Writer trait
  //                                   put(x.toByte) → virtual SigmaByteWriter.put(Byte)
  //                                   :45-48 = PutByteCost; AvlTreeData.scala:76)
  //   putUInt(keyLength)       = 0   (no-DataInfo putUInt(x:Long) :105-107 → VLQ
  //                                   writer, NO put() delegation — genuinely 0)
  //   putOption(valueLengthOpt) tag = 1
  //     if Some: putUInt(valueLength) = 0 (same no-DataInfo overload)
  //   walk(None) = 36 + 1 + 0 + 1 + 0 = 38
  //   walk(Some) = 36 + 1 + 0 + 1 + 0 = 38   (the value byte itself is uncosted)
  //   handler = 10 + 38 = 48 ; total = 14 + 48 = 62.
  it('serialize[AvlTree] (valueLengthOpt None) → cost 62', () => {
    const tree: SValue = {
      kind: 'AvlTree',
      value: { digest: new Uint8Array(33), treeFlags: 0, keyLength: 32, valueLengthOpt: null },
    }
    const { bytes, cost } = evalSer({ tag: 'SAvlTree' }, tree)
    expect(cost).toBe(FRAMEWORK + START_WRITER + 38)
    expect(cost).toBe(62)
    expect(bytes).toEqual(wireBytes({ tag: 'SAvlTree' }, tree))
  })

  it('serialize[AvlTree] (valueLengthOpt Some) → cost 62 (same; keyLength/valueLength uncosted)', () => {
    const tree: SValue = {
      kind: 'AvlTree',
      value: { digest: new Uint8Array(33), treeFlags: 5, keyLength: 32, valueLengthOpt: 8 },
    }
    const { bytes, cost } = evalSer({ tag: 'SAvlTree' }, tree)
    expect(cost).toBe(62)
    expect(bytes).toEqual(wireBytes({ tag: 'SAvlTree' }, tree))
  })

  // ── SBox ─────────────────────────────────────────────────────────────────────
  //
  // ErgoBox.sigmaSerializer.serialize (ErgoBox.scala:204-212):
  //   ErgoBoxCandidate.serializeBodyWithIndexedDigests (ErgoBoxCandidate.scala:138-181):
  //     putULong(value)        = 3
  //     putBytes(ergoTree)     = 3 + treeLen
  //     putUInt(creationHeight)= 0   (no-DataInfo putUInt(x:Long) — genuinely 0)
  //     putUByte(nTokens)      = 1   (F2 #5: same virtual-dispatch chain;
  //                                   ErgoBoxCandidate.scala:144)
  //     per token: putBytes(id 32) = 35 ; putULong(amount) = 3   → 38 each
  //     putUByte(nRegs)        = 1   (F2 #5; ErgoBoxCandidate.scala:166)
  //     per register: putValue(v) = ConstantSerializer (no store):
  //       putType(regTpe)   = #type-code bytes × 1
  //       DataSerializer.serialize(regData) = serializeCost(regTpe, regData)
  //   then (ErgoBox.scala:210-211):
  //     putBytes(txId 32)      = 35
  //     putUShort(index)       = 3
  //
  // Minimal box: ergoTreeBytes = [0x08,0x00] (len 2), no tokens, no regs.
  //   walk = 3 + (3+2) + 0 + 1 + 0 + 1 + 35 + 3 = 48 ; total = 14 + 10 + 48 = 72.
  function makeBox(overrides: Partial<ErgoBox> = {}): ErgoBox {
    return {
      value: 1000000n,
      ergoTreeBytes: new Uint8Array([0x08, 0x00]),
      registers: {},
      tokens: [],
      creationHeight: 0,
      txId: new Uint8Array(32),
      index: 0,
      ...overrides,
    }
  }

  it('serialize[Box] (no tokens, no registers) → cost 72', () => {
    const box: SValue = { kind: 'Box', value: makeBox() }
    const { bytes, cost } = evalSer({ tag: 'SBox' }, box)
    expect(cost).toBe(FRAMEWORK + START_WRITER + 48)
    expect(cost).toBe(72)
    expect(bytes).toEqual(wireBytes({ tag: 'SBox' }, box))
  })

  it('serialize[Box] with one Int register (R4) → cost 72 + putType(SInt=1) + walk(SInt=3)', () => {
    // SInt type-byte = single code byte (0x04) → putType cost 1.
    // SInt data walk = putInt = 3.
    // register adds 1 + 3 = 4 to the no-register walk (48) → 52 ; total = 14 + 10 + 52 = 76.
    const box: SValue = {
      kind: 'Box',
      value: makeBox({
        registers: { 4: { tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 7 } } },
      }),
    }
    const { bytes, cost } = evalSer({ tag: 'SBox' }, box)
    expect(cost).toBe(FRAMEWORK + START_WRITER + 52)
    expect(cost).toBe(76)
    expect(bytes).toEqual(wireBytes({ tag: 'SBox' }, box))
  })

  it('serialize[Box] with a Coll[Byte] register (R4) → putType(Coll[Byte]=1) + walk', () => {
    // Coll[SByte] type-byte = compact single code byte (12+2=14) → putType cost 1.
    // Coll[SByte] data walk = putUShort(len)=3 + putBytes(n)=(3+n). n=3 → 3 + 6 = 9.
    // register adds 1 + 9 = 10 → walk 48 + 10 = 58 ; total = 14 + 10 + 58 = 82.
    const reg: SValue = {
      kind: 'Coll',
      elem: { tag: 'SByte' },
      items: [
        { kind: 'Byte', value: 1 },
        { kind: 'Byte', value: 2 },
        { kind: 'Byte', value: 3 },
      ],
    }
    const box: SValue = {
      kind: 'Box',
      value: makeBox({
        registers: { 4: { tpe: { tag: 'SColl', elem: { tag: 'SByte' } }, value: reg } },
      }),
    }
    const { bytes, cost } = evalSer({ tag: 'SBox' }, box)
    expect(cost).toBe(FRAMEWORK + START_WRITER + 58)
    expect(cost).toBe(82)
    expect(bytes).toEqual(wireBytes({ tag: 'SBox' }, box))
  })

  it('serialize[Box] with one token → cost 72 + 38 (id putBytes 35 + amount putULong 3)', () => {
    const box: SValue = {
      kind: 'Box',
      value: makeBox({ tokens: [{ id: new Uint8Array(32), amount: 100n }] }),
    }
    const { bytes, cost } = evalSer({ tag: 'SBox' }, box)
    // walk 48 + 38 = 86 ; total = 14 + 10 + 86 = 110.
    expect(cost).toBe(FRAMEWORK + START_WRITER + 86)
    expect(cost).toBe(110)
    expect(bytes).toEqual(wireBytes({ tag: 'SBox' }, box))
  })

  // ── SBox with a Tuple-Expr register (opaqueBytes) — h=855,650 R8 shape ────────
  //
  // Mainnet context boxes (INPUTS(i)/SELF/…) can carry a register that is a Tuple
  // Expr on the wire (lead byte OP_TUPLE = 0x86 = 134), not a plain Constant. The
  // parser preserves the raw register Expr bytes in `entry.opaqueBytes` (and the
  // byte serializer writes them verbatim). A V3+ `Global.serialize(box)` of such a
  // box MUST cost the JVM `w.putValue(reg)` of that Tuple Expr — NOT throw.
  //
  // JVM cost of a register Tuple Expr `(SByte 102, SByte 99)` — ValueSerializer
  // .serialize hits the `case _` non-Constant path (ValueSerializer.scala:369-389):
  //   w.put(TupleCode)               = PutByteCost = 1   (SigmaByteWriter.scala:45-48,241;
  //                                                       TupleCode=134, OpCodes.scala:59)
  //   TupleSerializer.serialize (TupleSerializer.scala:18-25):
  //     w.putUByte(count=2, numItemsInfo) = 1  (F2 #5: DataInfo overload
  //                                             SigmaByteWriter.scala:56-59 → super →
  //                                             CoreByteWriter.scala:47-49 → trait
  //                                             put(x.toByte) → virtual put(Byte):45-48
  //                                             = PutByteCost 1; same chain as plain overload)
  //     per item w.putValue(item) → Constant/None path (ValueSerializer.scala:366-367
  //       → ConstantSerializer.scala:13-16 = putType + DataSerializer, NO opcode):
  //         putType(SByte) = 1  +  DataSerializer.serialize(byte) put = 1   → 2
  //   register cost = 1 + 1 + 2 + 2 = 6.
  //
  // Box walk = minimal-box 48 + register 6 = 54 ; total = 14 + 10 + 54 = 78.
  const SBYTE_TYPE_CODE = 2 // parse-stype.ts:57-58 / serialize-stype.ts:51-52
  const OP_TUPLE = 134 // parse-svalue.ts:77 — LAST_CONSTANT_CODE(112) + 22
  // Raw wire bytes of the register Tuple Expr `(SByte 102, SByte 99)`:
  //   [OP_TUPLE, count=2, SByte, 102, SByte, 99]
  const tupleRegOpaque = new Uint8Array([
    OP_TUPLE,
    2,
    SBYTE_TYPE_CODE,
    102,
    SBYTE_TYPE_CODE,
    99,
  ])
  // Matching parsed view (STuple of two SByte; what parseRegisterExprWithTag yields).
  const tupleRegTpe: SType = { tag: 'STuple', items: [{ tag: 'SByte' }, { tag: 'SByte' }] }
  const tupleRegValue: SValue = {
    kind: 'Tuple',
    items: [
      { kind: 'Byte', value: 102 },
      { kind: 'Byte', value: 99 },
    ],
  }

  it('serialize[Box] with a Tuple-Expr register (R4 = (SByte 102, SByte 99)) → cost 78 (no throw)', () => {
    const box: SValue = {
      kind: 'Box',
      value: makeBox({
        registers: {
          4: { tpe: tupleRegTpe, value: tupleRegValue, opaqueBytes: tupleRegOpaque },
        },
      }),
    }
    // The defect was a THROW here; assert it no longer throws and costs faithfully.
    const { bytes, cost } = evalSer({ tag: 'SBox' }, box)
    expect(cost).toBe(FRAMEWORK + START_WRITER + 54)
    expect(cost).toBe(78)
    // Cost path and byte path must agree on the register: the bytes are exactly the
    // verbatim opaqueBytes the serializer writes (cross-check vs serializeSValue).
    expect(bytes).toEqual(wireBytes({ tag: 'SBox' }, box))
  })

  it('serialize[Box] Tuple-Expr register — mainnet capture path (parseSValue) costs identically', () => {
    // Strongest cross-check: build the box the way mainnet does — serialize a box
    // carrying the Tuple-Expr register, then parseSValue(SBox) it back so the parser
    // CAPTURES opaqueBytes from the wire itself. The re-serialized cost must match.
    const seed: SValue = {
      kind: 'Box',
      value: makeBox({
        registers: {
          4: { tpe: tupleRegTpe, value: tupleRegValue, opaqueBytes: tupleRegOpaque },
        },
      }),
    }
    const w = new ByteWriter()
    serializeSValue({ tag: 'SBox' }, seed, 3, w)
    const parsed = parseSValue({ tag: 'SBox' }, 3, new ByteReader(w.toBytes()))
    if (parsed.kind !== 'Box') throw new Error('expected Box')
    // The parser must have captured the Tuple-Expr register as opaqueBytes.
    expect(parsed.value.registers[4]?.opaqueBytes).toEqual(tupleRegOpaque)
    const reparsedBox: SValue = { kind: 'Box', value: parsed.value }
    const { cost } = evalSer({ tag: 'SBox' }, reparsedBox)
    expect(cost).toBe(78)
  })

  // ── SHeader ──────────────────────────────────────────────────────────────────
  //
  // ErgoHeader.sigmaSerializer.serialize (ErgoHeader.scala:157-165):
  //   HeaderWithoutPowSerializer.serialize (HeaderWithoutPow.scala:47-65):
  //     put(version)             = 1
  //     putBytes(parentId 32)    = 35
  //     putBytes(ADProofsRoot 32)= 35
  //     putBytes(transactionsRoot 32) = 35
  //     putBytes(stateRoot 33)   = 36
  //     putULong(timestamp)      = 3
  //     putBytes(extensionRoot 32) = 35
  //     DifficultySerializer: putBytes(nBits 4) = 7
  //     putUInt(height)          = 0   (no-DataInfo putUInt(x:Long) — genuinely 0)
  //     putBytes(votes 3)        = 6
  //     if version > 1: putUByte(unparsedLen)=1 (F2 #5; HeaderWithoutPow.scala:61)
  //                     + putBytes(unparsed u)=(3+u)
  //   then V2 solution (version != 1, AutolykosSolution.sigmaSerializerV2:82-87):
  //     GroupElementSerializer.serialize(pk 33) = 36
  //     putBytes(nonce 8)        = 11
  //
  //   walk(v>=2, u=0) = 1+35+35+35+36+3+35+7+0+6 + (1 + 3) + 36 + 11 = 244
  //   handler = 10 + 244 = 254 ; total = 14 + 254 = 268.
  function makeHeader(version: number, unparsed: Uint8Array = new Uint8Array(0)): Header {
    return {
      version,
      id: new Uint8Array(32),
      parentId: new Uint8Array(32),
      adProofsRoot: new Uint8Array(32),
      stateRoot: new Uint8Array(33),
      transactionRoot: new Uint8Array(32),
      timestamp: 0n,
      nBits: 0,
      height: 0,
      extensionRoot: new Uint8Array(32),
      autolykosSolution: {
        minerPk: new Uint8Array(33),
        powOnetimePk: null,
        nonce: new Uint8Array(8),
        powDistance: null,
      },
      votes: new Uint8Array(3),
      unparsedBytes: unparsed,
    }
  }

  it('serialize[Header] (version 2, no unparsed, V2 solution) → cost 268', () => {
    const hv: SValue = { kind: 'Header', value: makeHeader(2) }
    const { bytes, cost } = evalSer({ tag: 'SHeader' }, hv)
    expect(cost).toBe(FRAMEWORK + START_WRITER + 244)
    expect(cost).toBe(268)
    expect(bytes).toEqual(wireBytes({ tag: 'SHeader' }, hv))
  })

  it('serialize[Header] (version 3) → cost 268 (same shape; V2 solution)', () => {
    const hv: SValue = { kind: 'Header', value: makeHeader(3) }
    const { cost } = evalSer({ tag: 'SHeader' }, hv)
    expect(cost).toBe(268)
  })

  it('serialize[Header] (version 2, 4 unparsed bytes) → cost 268 + 4 (putBytes adds n)', () => {
    const hv: SValue = { kind: 'Header', value: makeHeader(2, new Uint8Array([1, 2, 3, 4])) }
    const { bytes, cost } = evalSer({ tag: 'SHeader' }, hv)
    // walk 244 + 4 = 248 ; total = 14 + 10 + 248 = 272.
    expect(cost).toBe(FRAMEWORK + START_WRITER + 248)
    expect(cost).toBe(272)
    expect(bytes).toEqual(wireBytes({ tag: 'SHeader' }, hv))
  })

  // ── Eval-level round-trip (deserializeTo[T](serialize[T](x)) == x) ────────────
  // Strongest cross-check: both codec halves + cost paths agree, and the bytes
  // are a valid wire form parseSValue accepts back. (The full per-type round-trip
  // matrix lives in Task 6; these three pin the complex types here.)
  function roundTrip(T: SType, value: SValue): SValue {
    const bytes = evalSer(T, value).bytes
    const ctx = makeContext({ treeVersion: 3 })
    return evalMethodCall(
      {
        tag: 'MethodCall',
        obj: { tag: 'Global' },
        typeId: 106,
        methodId: 4,
        args: [
          {
            tag: 'Const',
            tpe: { tag: 'SColl', elem: { tag: 'SByte' } },
            value: {
              kind: 'Coll',
              elem: { tag: 'SByte' },
              items: Array.from(bytes, (b) => ({ kind: 'Byte', value: b }) as SValue),
            },
          },
        ],
        explicitTypeArgs: { T },
      },
      Env.empty(),
      ctx,
    )
  }

  it('round-trip[AvlTree] (None)', () => {
    const tree: SValue = {
      kind: 'AvlTree',
      value: { digest: new Uint8Array(33), treeFlags: 5, keyLength: 32, valueLengthOpt: null },
    }
    expect(roundTrip({ tag: 'SAvlTree' }, tree)).toEqual(tree)
  })

  it('round-trip[Box] (one Int register)', () => {
    const box: SValue = {
      kind: 'Box',
      value: makeBox({
        registers: { 4: { tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 7 } } },
      }),
    }
    expect(roundTrip({ tag: 'SBox' }, box)).toEqual(box)
  })

  it('round-trip[Header] (version 2)', () => {
    // Header.id is a DERIVED field (blake2b256 of the serialized bytes), not on
    // the wire — parseSValue re-derives it. Construct the input with the correct
    // derived id so the round-trip equality holds on the full value.
    const header = makeHeader(2)
    header.id = deriveHeaderId(header)
    const hv: SValue = { kind: 'Header', value: header }
    expect(roundTrip({ tag: 'SHeader' }, hv)).toEqual(hv)
  })
})
