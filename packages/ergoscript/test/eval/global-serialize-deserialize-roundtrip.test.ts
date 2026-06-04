/**
 * v6 P5a Task 6 — serialize/deserializeTo round-trip tests.
 *
 * Property: deserializeTo[T](serialize[T](x)) == x
 *
 * Two separate EvalContext calls: one for serialize (produces Coll[Byte]),
 * one for deserializeTo (consumes that Coll[Byte] as a fresh Const arg).
 * This cross-checks both codec halves, sValueType derivation, and the
 * serializeSValue / parseSValue pair.
 *
 * Domain: Byte, Short, Int, Long, BigInt, UnsignedBigInt, Coll[Byte],
 * Coll[Int], Option[Int] (None + Some), Tuple, GroupElement, AvlTree,
 * Header (V2 ONLY — V1 has a sigma-rust-vs-JVM fork on d=0 encoding,
 * tracked as a residual in the design spec), Box (no regs, with Int reg).
 *
 * Also covers:
 * - Adversarial: serialize of a non-serializable value → EvalError('global-serialize-failed')
 * - Wire-confirm: 106:3 (serialize) carries NO explicit type arg on the wire;
 *   106:4 (deserializeTo) DOES carry its T.
 *
 * JVM source: sigma/ast/methods.scala:1957 (serialize), :1906 (deserializeTo)
 * Spec: docs/specs/2026-06-04-ergoscript-v6-p5a-serialize-deserializeto-design.md
 */

import { describe, expect, it } from 'vitest'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseExpr } from '../../src/wire/parse'
import { serializeExpr } from '../../src/wire/serialize'
import { ByteReader, ByteWriter, deriveHeaderId } from '@ergots/scorex'
import type { MethodCall, SType, SValue, ErgoBox } from '../../src/mir/types'
import type { Header } from '@ergots/scorex'

// ── Helpers ──────────────────────────────────────────────────────────────────

const SBYTE: SType = { tag: 'SByte' }
const COLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }
const SINT: SType = { tag: 'SInt' }

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

/**
 * Evaluate serialize[T](value) and return the raw bytes as Uint8Array.
 * Uses a fresh context (treeVersion 3).
 */
function serializeValue(tpe: SType, value: SValue): Uint8Array {
  const ctx = makeContext({ treeVersion: 3 })
  const r = evalMethodCall(serExpr(tpe, value), Env.empty(), ctx)
  if (r.kind !== 'Coll' || r.elem.tag !== 'SByte') {
    throw new Error(`serialize did not return Coll[Byte]: ${JSON.stringify(r)}`)
  }
  return new Uint8Array(r.items.map((it) => (it as { value: number }).value & 0xff))
}

/**
 * Evaluate deserializeTo[T](bytes) and return the SValue.
 * Uses a fresh context (treeVersion 3).
 */
function deserializeValue(T: SType, bytes: Uint8Array): SValue {
  const byteSValues: SValue[] = Array.from(bytes, (b) => ({ kind: 'Byte', value: b }))
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
          tpe: COLL_BYTE,
          value: { kind: 'Coll', elem: SBYTE, items: byteSValues },
        },
      ],
      explicitTypeArgs: { T },
    },
    Env.empty(),
    ctx,
  )
}

/**
 * The core round-trip: serialize then deserialize, assert deep equality.
 * T is the SType passed to deserializeTo (must match the serialized type).
 */
function roundTrip(T: SType, value: SValue): SValue {
  const bytes = serializeValue(T, value)
  return deserializeValue(T, bytes)
}

/** Minimal ErgoBox builder. */
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

/** V2 header builder (V1 is excluded — sigma-rust vs JVM d=0 fork, see residual). */
function makeV2Header(unparsed: Uint8Array = new Uint8Array(0)): Header {
  return {
    version: 2,
    id: new Uint8Array(32),
    parentId: new Uint8Array(32),
    adProofsRoot: new Uint8Array(32),
    stateRoot: new Uint8Array(33),
    transactionRoot: new Uint8Array(32),
    timestamp: 0,
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

// ── Round-trip matrix ─────────────────────────────────────────────────────────

describe('serialize/deserializeTo round-trip (v6 P5a)', () => {
  // ── Scalars ────────────────────────────────────────────────────────────────

  it('round-trip Byte(0)', () => {
    const v: SValue = { kind: 'Byte', value: 0 }
    expect(roundTrip({ tag: 'SByte' }, v)).toEqual(v)
  })

  it('round-trip Byte(-128)', () => {
    const v: SValue = { kind: 'Byte', value: -128 }
    expect(roundTrip({ tag: 'SByte' }, v)).toEqual(v)
  })

  it('round-trip Byte(127)', () => {
    const v: SValue = { kind: 'Byte', value: 127 }
    expect(roundTrip({ tag: 'SByte' }, v)).toEqual(v)
  })

  it('round-trip Short(0)', () => {
    const v: SValue = { kind: 'Short', value: 0 }
    expect(roundTrip({ tag: 'SShort' }, v)).toEqual(v)
  })

  it('round-trip Short(-32768)', () => {
    const v: SValue = { kind: 'Short', value: -32768 }
    expect(roundTrip({ tag: 'SShort' }, v)).toEqual(v)
  })

  it('round-trip Int(0)', () => {
    const v: SValue = { kind: 'Int', value: 0 }
    expect(roundTrip(SINT, v)).toEqual(v)
  })

  it('round-trip Int(12345)', () => {
    const v: SValue = { kind: 'Int', value: 12345 }
    expect(roundTrip(SINT, v)).toEqual(v)
  })

  it('round-trip Int(-2147483648)', () => {
    const v: SValue = { kind: 'Int', value: -2147483648 }
    expect(roundTrip(SINT, v)).toEqual(v)
  })

  it('round-trip Long(0)', () => {
    const v: SValue = { kind: 'Long', value: 0n }
    expect(roundTrip({ tag: 'SLong' }, v)).toEqual(v)
  })

  it('round-trip Long(9007199254740993n)', () => {
    // above Number.MAX_SAFE_INTEGER — exercises bigint path
    const v: SValue = { kind: 'Long', value: 9007199254740993n }
    expect(roundTrip({ tag: 'SLong' }, v)).toEqual(v)
  })

  it('round-trip BigInt(0)', () => {
    const v: SValue = { kind: 'BigInt', value: 0n }
    expect(roundTrip({ tag: 'SBigInt' }, v)).toEqual(v)
  })

  it('round-trip BigInt(12345678901234567890n)', () => {
    const v: SValue = { kind: 'BigInt', value: 12345678901234567890n }
    expect(roundTrip({ tag: 'SBigInt' }, v)).toEqual(v)
  })

  it('round-trip UnsignedBigInt(0)', () => {
    const v: SValue = { kind: 'UnsignedBigInt', value: 0n }
    expect(roundTrip({ tag: 'SUnsignedBigInt' }, v)).toEqual(v)
  })

  it('round-trip UnsignedBigInt(255)', () => {
    const v: SValue = { kind: 'UnsignedBigInt', value: 255n }
    expect(roundTrip({ tag: 'SUnsignedBigInt' }, v)).toEqual(v)
  })

  // ── Coll[Byte] ─────────────────────────────────────────────────────────────

  it('round-trip Coll[Byte] empty', () => {
    const v: SValue = { kind: 'Coll', elem: SBYTE, items: [] }
    expect(roundTrip(COLL_BYTE, v)).toEqual(v)
  })

  it('round-trip Coll[Byte]([1,2,3])', () => {
    const v: SValue = {
      kind: 'Coll',
      elem: SBYTE,
      items: [
        { kind: 'Byte', value: 1 },
        { kind: 'Byte', value: 2 },
        { kind: 'Byte', value: 3 },
      ],
    }
    expect(roundTrip(COLL_BYTE, v)).toEqual(v)
  })

  // ── Coll[Int] ──────────────────────────────────────────────────────────────

  it('round-trip Coll[Int] empty', () => {
    const T: SType = { tag: 'SColl', elem: SINT }
    const v: SValue = { kind: 'Coll', elem: SINT, items: [] }
    expect(roundTrip(T, v)).toEqual(v)
  })

  it('round-trip Coll[Int]([1, -1, 32768])', () => {
    const T: SType = { tag: 'SColl', elem: SINT }
    const v: SValue = {
      kind: 'Coll',
      elem: SINT,
      items: [
        { kind: 'Int', value: 1 },
        { kind: 'Int', value: -1 },
        { kind: 'Int', value: 32768 },
      ],
    }
    expect(roundTrip(T, v)).toEqual(v)
  })

  // ── Option[Int] ────────────────────────────────────────────────────────────

  it('round-trip Option[Int](None)', () => {
    const T: SType = { tag: 'SOption', elem: SINT }
    const v: SValue = { kind: 'Option', elem: SINT, value: null }
    expect(roundTrip(T, v)).toEqual(v)
  })

  it('round-trip Option[Int](Some(5))', () => {
    const T: SType = { tag: 'SOption', elem: SINT }
    const v: SValue = {
      kind: 'Option',
      elem: SINT,
      value: { kind: 'Int', value: 5 },
    }
    expect(roundTrip(T, v)).toEqual(v)
  })

  // ── Tuple ──────────────────────────────────────────────────────────────────

  it('round-trip Tuple(Int, Long)', () => {
    const T: SType = { tag: 'STuple', items: [SINT, { tag: 'SLong' }] }
    const v: SValue = {
      kind: 'Tuple',
      items: [
        { kind: 'Int', value: 42 },
        { kind: 'Long', value: 9999n },
      ],
    }
    expect(roundTrip(T, v)).toEqual(v)
  })

  it('round-trip Tuple(Byte, Byte)', () => {
    const T: SType = { tag: 'STuple', items: [SBYTE, SBYTE] }
    const v: SValue = {
      kind: 'Tuple',
      items: [
        { kind: 'Byte', value: 7 },
        { kind: 'Byte', value: -1 },
      ],
    }
    expect(roundTrip(T, v)).toEqual(v)
  })

  // ── GroupElement ───────────────────────────────────────────────────────────

  it('round-trip GroupElement (33 zero bytes with 0x02 prefix)', () => {
    // Note: a real compressed point requires valid curve math. We use a
    // "structurally valid" 33-byte encoding (0x02 prefix). parseSValue reads
    // it as-is; the round-trip only checks byte-level fidelity.
    const ge = new Uint8Array(33)
    ge[0] = 0x02
    const T: SType = { tag: 'SGroupElement' }
    const v: SValue = { kind: 'GroupElement', value: ge }
    const result = roundTrip(T, v)
    // Both are GroupElement; compare bytes
    expect(result.kind).toBe('GroupElement')
    const resultGe = (result as Extract<SValue, { kind: 'GroupElement' }>).value
    expect(resultGe).toEqual(ge)
  })

  // ── AvlTree ────────────────────────────────────────────────────────────────

  it('round-trip AvlTree (valueLengthOpt None)', () => {
    const T: SType = { tag: 'SAvlTree' }
    const v: SValue = {
      kind: 'AvlTree',
      value: {
        digest: new Uint8Array(33),
        treeFlags: 5,
        keyLength: 32,
        valueLengthOpt: null,
      },
    }
    expect(roundTrip(T, v)).toEqual(v)
  })

  it('round-trip AvlTree (valueLengthOpt Some)', () => {
    const T: SType = { tag: 'SAvlTree' }
    const v: SValue = {
      kind: 'AvlTree',
      value: {
        digest: new Uint8Array(33),
        treeFlags: 3,
        keyLength: 32,
        valueLengthOpt: 16,
      },
    }
    expect(roundTrip(T, v)).toEqual(v)
  })

  // ── Header (V2 only) ───────────────────────────────────────────────────────
  //
  // V1 headers are EXCLUDED from the round-trip matrix because of a
  // sigma-rust-vs-JVM byte-shape fork on the d=0 Autolykos powDistance
  // encoding: scorex (following sigma-rust) emits [1, 0x00], the JVM emits
  // []. See the residual note in the P5a design spec §Open items. Real V1
  // mainnet headers have d≠0 so the fork is adversarial-only; the serialize
  // COST is JVM-faithful regardless.

  it('round-trip Header V2 (derived id)', () => {
    const T: SType = { tag: 'SHeader' }
    // parseSValue re-derives id from the serialized bytes, so we must
    // set id = deriveHeaderId(header) to get equality on the full SValue.
    const header = makeV2Header()
    header.id = deriveHeaderId(header)
    const v: SValue = { kind: 'Header', value: header }
    expect(roundTrip(T, v)).toEqual(v)
  })

  it('round-trip Header V2 with unparsed bytes (4 bytes)', () => {
    const T: SType = { tag: 'SHeader' }
    const header = makeV2Header(new Uint8Array([1, 2, 3, 4]))
    header.id = deriveHeaderId(header)
    const v: SValue = { kind: 'Header', value: header }
    expect(roundTrip(T, v)).toEqual(v)
  })

  // ── Box ────────────────────────────────────────────────────────────────────

  it('round-trip Box (no tokens, no registers)', () => {
    const T: SType = { tag: 'SBox' }
    const v: SValue = { kind: 'Box', value: makeBox() }
    expect(roundTrip(T, v)).toEqual(v)
  })

  it('round-trip Box with Int register (R4)', () => {
    const T: SType = { tag: 'SBox' }
    const v: SValue = {
      kind: 'Box',
      value: makeBox({
        registers: { 4: { tpe: SINT, value: { kind: 'Int', value: 42 } } },
      }),
    }
    expect(roundTrip(T, v)).toEqual(v)
  })

  it('round-trip Box with Coll[Byte] register (R4)', () => {
    const T: SType = { tag: 'SBox' }
    const v: SValue = {
      kind: 'Box',
      value: makeBox({
        registers: {
          4: {
            tpe: COLL_BYTE,
            value: {
              kind: 'Coll',
              elem: SBYTE,
              items: [
                { kind: 'Byte', value: 10 },
                { kind: 'Byte', value: 20 },
              ],
            },
          },
        },
      }),
    }
    expect(roundTrip(T, v)).toEqual(v)
  })
})

// ── Adversarial tests ─────────────────────────────────────────────────────────

describe('Global.serialize adversarial — non-serializable values', () => {
  /**
   * Serialize of a Lambda or Global SValue must throw EvalError('global-serialize-failed').
   * The JVM DataSerializer has no case for SAny/SFunc/SContext/SGlobal — it throws
   * SerializerException. ergots returns SAny for these from sValueType, which makes
   * serializeSValue throw, which we wrap as 'global-serialize-failed'.
   */

  it('serialize of a Lambda SValue → EvalError(global-serialize-failed)', () => {
    // Lambda SValue — sValueType returns SAny → serializeSValue throws
    const lambdaValue: SValue = {
      kind: 'Lambda',
      closure: {} as never,
    }
    const ctx = makeContext({ treeVersion: 3 })
    try {
      evalMethodCall(serExpr({ tag: 'SAny' }, lambdaValue), Env.empty(), ctx)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('global-serialize-failed')
    }
  })

  it('serialize of a Global SValue → EvalError(global-serialize-failed)', () => {
    // Global SValue — sValueType returns SAny → serializeSValue throws
    const globalValue: SValue = { kind: 'Global' }
    const ctx = makeContext({ treeVersion: 3 })
    try {
      evalMethodCall(serExpr({ tag: 'SAny' }, globalValue), Env.empty(), ctx)
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('global-serialize-failed')
    }
  })
})

// ── Wire-confirm tests ─────────────────────────────────────────────────────────

describe('serialize / deserializeTo — wire type-arg presence', () => {
  /**
   * serialize (106:3): NO explicit type arg on the wire.
   *   The JVM SMethod for serialize does NOT declare explicit_type_args, so
   *   MethodCallSerializer does NOT write any SType bytes after the args.
   *   Confirm: 106:3 is ABSENT from the explicit-type-args registry, and the
   *   wire round-trip for a 106:3 MethodCall carries NO trailing type bytes.
   *
   * deserializeTo (106:4): DOES carry its T.
   *   The JVM SMethod declares explicit_type_args = [T], so one SType byte
   *   follows the args. 106:4 IS in the registry.
   */

  it('serialize (106:3) round-trips on wire with NO explicit type arg', () => {
    // Build a 106:3 MethodCall expr (serialize[Byte](Const(SByte, 0))).
    const mc: MethodCall = {
      tag: 'MethodCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 3,
      args: [{ tag: 'Const', tpe: { tag: 'SByte' }, value: { kind: 'Byte', value: 0 } }],
      explicitTypeArgs: {},
    }
    // Serialize to wire bytes via serializeExpr.
    const w = new ByteWriter()
    serializeExpr(mc, w, 3)
    const wireBytes = w.toBytes()

    // Parse back: the parser reads exactly the MethodCall body and NO trailing SType bytes.
    const reader = new ByteReader(wireBytes)
    const parsed = parseExpr(reader, [], [], new Map(), 3)
    // All bytes consumed — no trailing type arg bytes leaked.
    expect(reader.remaining).toBe(0)
    // Parsed node: MethodCall with EMPTY explicitTypeArgs (none written/read).
    expect(parsed.tag).toBe('MethodCall')
    const parsedMc = parsed as MethodCall
    expect(parsedMc.typeId).toBe(106)
    expect(parsedMc.methodId).toBe(3)
    expect(parsedMc.explicitTypeArgs).toEqual({})
  })

  it('deserializeTo (106:4) round-trips on wire WITH explicit T type arg', () => {
    // Build a 106:4 MethodCall expr (deserializeTo[Int](bytes)).
    const mc: MethodCall = {
      tag: 'MethodCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 4,
      args: [
        {
          tag: 'Const',
          tpe: COLL_BYTE,
          value: { kind: 'Coll', elem: SBYTE, items: [] },
        },
      ],
      explicitTypeArgs: { T: SINT },
    }
    // Serialize to wire bytes.
    const w = new ByteWriter()
    serializeExpr(mc, w, 3)
    const wireBytes = w.toBytes()

    // Parse back: parser reads typeId, methodId, obj, args, THEN reads the T SType.
    const reader = new ByteReader(wireBytes)
    const parsed = parseExpr(reader, [], [], new Map(), 3)
    expect(reader.remaining).toBe(0)
    expect(parsed.tag).toBe('MethodCall')
    const parsedMc = parsed as MethodCall
    expect(parsedMc.typeId).toBe(106)
    expect(parsedMc.methodId).toBe(4)
    // T must be SInt (the type we wrote).
    expect(parsedMc.explicitTypeArgs).toEqual({ T: SINT })
  })
})
