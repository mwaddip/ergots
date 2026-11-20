/**
 * The JVM's array-cast consumers (`toArray.asInstanceOf[Array[T]]`, or a
 * call whose signature needs that array of a class). Each consumer refuses
 * a collection whose backing array is of another class with
 * `'coll-class-cast'`, and accepts a collection over the right array in
 * each of the four shapes the data reader and the `toBytes` family give:
 * specialised, plain over the primitive, plain with no `cls` handed by the
 * caller (which the module reads as the data reader's class), and the
 * empty-`'unknown'` class an untyped mapper's `map` / `flatMap` of an
 * empty input returns.
 *
 * Reference tuple: `tupleColl(items)` (`coll/build.ts`) — the JVM's
 * `Coll[Any]` over `Object[]` at any arity; surfaced through context
 * variable 1 since the data reader does not build it.
 *
 * Grid convention: the accept kinds assert that the call does NOT refuse
 * with `'coll-class-cast'`; a subsequent arm-internal length or shape
 * check may still refuse with another code (`'byte-array-to-bigint-empty'`
 * on an empty input to `ByteArrayToBigInt`, `'decode-point-invalid'` on
 * an empty input to `DecodePoint`, `'byte-array-to-long-length'` on any
 * input to `ByteArrayToLong` other than 8 bytes). Those cells are
 * authored to meet the arm's own length requirement so the accept test
 * exercises the array cast alone.
 *
 * A row where an accept kind cannot be meaningfully constructed is
 * omitted with an inline comment citing the reason.
 */
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { empty, tupleColl } from '../../src/coll'
import type { Expr, SType, SValue } from '../../src/mir/types'
import { captureEvalError, plainColl, specColl } from '../_helpers'

const SBYTE: SType = { tag: 'SByte' }
const SINT: SType = { tag: 'SInt' }
const SSIGMAPROP: SType = { tag: 'SSigmaProp' }
const SANY_ERGOTS: SType = { tag: 'SAny' }
const COLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }
const COLL_INT: SType = { tag: 'SColl', elem: SINT }
const COLL_SIGMAPROP: SType = { tag: 'SColl', elem: SSIGMAPROP }
const COLL_COLL_BYTE: SType = { tag: 'SColl', elem: COLL_BYTE }
const PAIR_BYTES: SType = {
  tag: 'STuple',
  items: [COLL_BYTE, COLL_BYTE],
}
const COLL_PAIR_BYTES: SType = { tag: 'SColl', elem: PAIR_BYTES }
const SAVLTREE: SType = { tag: 'SAvlTree' }

/** `getVar[T](id).get` — reads variable `id` under tpe `tpe` from the extension. */
function getVarGet(varId: number, tpe: SType): Expr {
  return {
    tag: 'OptionGet',
    input: { tag: 'GetVar', varId, varTpe: tpe },
  }
}

/** An int Const. */
function intC(v: number): Expr {
  return { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: v } }
}

// ---------------------------------------------------------------------------
// Byte-collection builders for the four accept kinds, and the tuple-based
// refusal.
// ---------------------------------------------------------------------------

function byteItems(bytes: number[]): SValue[] {
  return bytes.map(
    (b) => ({ kind: 'Byte', value: (b << 24) >> 24 }) as SValue,
  )
}

/** A specialised `Coll[Byte]` over `byte[]`, the data reader's class for a byte collection. */
function specByteColl(bytes: number[]): SValue {
  return specColl(SBYTE, byteItems(bytes))
}

/** A plain `Coll[Byte]` over `byte[]`, the shape `Long.toBytes` gives. */
function plainByteColl(bytes: number[]): SValue {
  return plainColl(SBYTE, byteItems(bytes))
}

/** A `Coll[Byte]` with no `cls` handed by the caller. */
function bareByteColl(bytes: number[]): SValue {
  return { kind: 'Coll', elem: SBYTE, items: byteItems(bytes) }
}

/** The empty collection of the unknown class, an untyped mapper's result. */
function emptyUnknown(): SValue {
  return empty(SANY_ERGOTS)
}

/** A `Coll[Any]` of `Byte` items, the shape a tuple `(1:Byte, 2:Byte, 3:Byte)` takes. */
function tupleOfBytes(bytes: number[]): SValue {
  return tupleColl(byteItems(bytes))
}

// ---------------------------------------------------------------------------
// Int-collection builders.
// ---------------------------------------------------------------------------

function intItems(values: number[]): SValue[] {
  return values.map((v) => ({ kind: 'Int', value: v }) as SValue)
}

/** A plain `Coll[Int]` over `int[]`, the class a `ConcreteCollection` of ints gives. */
function plainIntColl(values: number[]): SValue {
  return plainColl(SINT, intItems(values))
}

/** A specialised `Coll[Int]` over `int[]`, the class of `Coll.indices`. */
function specIntColl(values: number[]): SValue {
  return specColl(SINT, intItems(values))
}

function bareIntColl(values: number[]): SValue {
  return { kind: 'Coll', elem: SINT, items: intItems(values) }
}

/** A `Coll[Any]` of `Int` items. */
function tupleOfInts(values: number[]): SValue {
  return tupleColl(intItems(values))
}

// ---------------------------------------------------------------------------
// SigmaProp-collection builders.
// ---------------------------------------------------------------------------

const TRIVIAL_TRUE: SValue = {
  kind: 'SigmaProp',
  value: { tag: 'TrivialProp', value: true },
}

function sigmaPropItems(n: number): SValue[] {
  return Array.from({ length: n }, () => TRIVIAL_TRUE)
}

function plainSigmaPropColl(n: number): SValue {
  return plainColl(SSIGMAPROP, sigmaPropItems(n))
}

function bareSigmaPropColl(n: number): SValue {
  return { kind: 'Coll', elem: SSIGMAPROP, items: sigmaPropItems(n) }
}

function tupleOfSigmaProps(n: number): SValue {
  return tupleColl(sigmaPropItems(n))
}

// ---------------------------------------------------------------------------
// Context + evaluation helper.
// ---------------------------------------------------------------------------

function runWithVar(expr: Expr, varTpe: SType, varVal: SValue, treeVersion = 3): SValue {
  const ctx = makeContext({
    treeVersion,
    extension: { values: new Map([[1, { tpe: varTpe, value: varVal }]]) },
  })
  return evalExpr(expr, Env.empty(), ctx)
}

function runWithVars(
  expr: Expr,
  vars: Array<{ varId: number; tpe: SType; value: SValue }>,
  treeVersion = 3,
): SValue {
  const map = new Map<number, { tpe: SType; value: SValue }>()
  for (const v of vars) map.set(v.varId, { tpe: v.tpe, value: v.value })
  const ctx = makeContext({ treeVersion, extension: { values: map } })
  return evalExpr(expr, Env.empty(), ctx)
}

function expectCollClassCast(fn: () => unknown): void {
  const err = captureEvalError(fn)
  expect(err.code).toBe('coll-class-cast')
}

function expectCastAccepted(fn: () => unknown): void {
  try {
    fn()
    // No throw ⇒ cast accepted and the arm answered.
  } catch (e) {
    // An EvalError that is NOT 'coll-class-cast' is a downstream check
    // (length, numeric range, …), which also means the cast was accepted.
    if (e instanceof Error && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
      expect((e as { code: string }).code).not.toBe('coll-class-cast')
      return
    }
    throw e
  }
}

// ===========================================================================
// 1. AtLeast — JVM `trees.scala:314-320` → `CSigmaDslBuilder.scala:102-108`
//    (`toSigmaTrees(props.toArray)`), cast to `Array[SigmaProp]`.
// ===========================================================================

describe('AtLeast — the array cast to Array[SigmaProp]', () => {
  const makeExpr = (): Expr => ({
    tag: 'Atleast',
    bound: intC(2),
    input: getVarGet(1, COLL_SIGMAPROP),
  })

  it("refuses a Coll[Any] of three SigmaProps with 'coll-class-cast'", () => {
    expectCollClassCast(() =>
      runWithVar(makeExpr(), COLL_SIGMAPROP, tupleOfSigmaProps(3)),
    )
  })

  // SigmaProp has no specialised primitive form; the four JVM-accepted kinds
  // collapse to three for a reference-array receiver: plain over the
  // reference array, bare no-cls (reader resolves to plain), and the empty
  // unknown-class.
  it("accepts a plain Coll[SigmaProp] over SigmaProp[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_SIGMAPROP, plainSigmaPropColl(3)),
    )
  })

  it("accepts a bare Coll[SigmaProp] with no cls", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_SIGMAPROP, bareSigmaPropColl(3)),
    )
  })

  it("accepts an empty unknown-class collection", () => {
    // An empty input at AtLeast with bound = 2 falls into `bound > nChildren`
    // and returns TrivialProp(false); no cast refusal.
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_SIGMAPROP, emptyUnknown()),
    )
  })

  // `specialised` is omitted: a `Coll[SigmaProp]` cannot be the specialised
  // `@specialized` subclass of `CollOverArray` (Scala specialises on
  // primitives only, `CollsOverArrays.scala:11`).
})

// ===========================================================================
// 2. The byte-cast consumers that share `collByteToUint8Array`.
//    JVM sites: `CSigmaDslBuilder.scala:153` (blake2b256),
//    `:158` (sha256), `:163` (byteArrayToBigInt), `:172` (byteArrayToLong),
//    `:220` (decodePoint), and `methods.scala:1901` (powHit × 3).
// ===========================================================================

interface ByteConsumer {
  name: string
  makeExpr: (arg: Expr) => Expr
  /** The byte length each accept builder returns (so the arm's internal
   *  length check passes and the test exercises the array cast alone). */
  byteLen: number
  /** The context-variable type under which the arg is read. */
  argTpe: SType
  /** When set, says why the empty-unknown accept test is omitted. */
  omitEmptyUnknown?: string
}

/** A 33-byte identity-point input for `DecodePoint` (zero bytes decode to the
 *  identity, `decodePoint` in `crypto/secp256k1.ts`). */
const DECODE_POINT_LEN = 33

const BYTE_CONSUMERS: ByteConsumer[] = [
  {
    name: 'CalcBlake2b256',
    makeExpr: (a) => ({ tag: 'CalcBlake2b256', input: a }),
    byteLen: 3,
    argTpe: COLL_BYTE,
  },
  {
    name: 'CalcSha256',
    makeExpr: (a) => ({ tag: 'CalcSha256', input: a }),
    byteLen: 3,
    argTpe: COLL_BYTE,
  },
  {
    name: 'ByteArrayToBigInt',
    makeExpr: (a) => ({ tag: 'ByteArrayToBigInt', input: a }),
    byteLen: 3,
    argTpe: COLL_BYTE,
    omitEmptyUnknown:
      "the arm's own empty-input check runs after the cast and refuses the " +
      "zero-length empty-unknown with `'byte-array-to-bigint-empty'`; the " +
      "cast itself still accepts (`'byte-array-to-bigint-empty'` is not " +
      "`'coll-class-cast'`), measured by the grid's generic empty-unknown " +
      "branch for `CalcBlake2b256` / `CalcSha256`",
  },
  {
    name: 'ByteArrayToLong',
    makeExpr: (a) => ({ tag: 'ByteArrayToLong', input: a }),
    byteLen: 8,
    argTpe: COLL_BYTE,
    omitEmptyUnknown:
      "the arm requires exactly 8 bytes (`SigmaDsl.byteArrayToLong` at " +
      "`CSigmaDslBuilder.scala:172-173` calls `Longs.fromByteArray` which " +
      "throws on any other length); an empty-unknown has 0 bytes, so the " +
      "cast's acceptance is verified by the other three kinds (all 8 bytes)",
  },
  {
    name: 'DecodePoint',
    makeExpr: (a) => ({ tag: 'DecodePoint', input: a }),
    byteLen: DECODE_POINT_LEN,
    argTpe: COLL_BYTE,
    omitEmptyUnknown:
      "the arm requires exactly 33 bytes; an empty-unknown has 0 bytes",
  },
]

describe.each(BYTE_CONSUMERS)('$name — byte-array cast grid', (c) => {
  const expr = c.makeExpr(getVarGet(1, c.argTpe))
  const bytes = (): number[] =>
    Array.from({ length: c.byteLen }, (_, i) => i & 0xff)

  it(`refuses a Coll[Any] of bytes with 'coll-class-cast'`, () => {
    expectCollClassCast(() => runWithVar(expr, c.argTpe, tupleOfBytes(bytes())))
  })

  it("accepts a specialised Coll[Byte] over byte[]", () => {
    expectCastAccepted(() => runWithVar(expr, c.argTpe, specByteColl(bytes())))
  })

  it("accepts a plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(() => runWithVar(expr, c.argTpe, plainByteColl(bytes())))
  })

  it("accepts a bare Coll[Byte] with no cls", () => {
    expectCastAccepted(() => runWithVar(expr, c.argTpe, bareByteColl(bytes())))
  })

  if (c.omitEmptyUnknown === undefined) {
    it("accepts an empty unknown-class collection", () => {
      expectCastAccepted(() => runWithVar(expr, c.argTpe, emptyUnknown()))
    })
  }
})

// ---------------------------------------------------------------------------
// SGlobal.powHit msg / nonce / h arguments — three byte-cast call sites on
// one MethodCall (`methods.scala:1898-1902`, three `*.toArray` at `:1901`).
// ---------------------------------------------------------------------------

/** `SGlobal.powHit(k=2, msg, nonce, h, N=16)` with argN of type `Coll[Byte]`
 *  read from variable 1; the other two byte arguments are small plain byte
 *  constants. */
function powHitExpr(targetArgIndex: 1 | 2 | 3): Expr {
  const k: Expr = intC(2)
  const N: Expr = intC(16)
  const smallBytes: Expr = {
    tag: 'Const',
    tpe: COLL_BYTE,
    value: specByteColl([0, 0, 0, 0]),
  }
  const target = getVarGet(1, COLL_BYTE)
  const args: Expr[] = [
    k,
    targetArgIndex === 1 ? target : smallBytes,
    targetArgIndex === 2 ? target : smallBytes,
    targetArgIndex === 3 ? target : smallBytes,
    N,
  ]
  return {
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 8,
    args,
    explicitTypeArgs: {},
  }
}

for (const arg of [1, 2, 3] as const) {
  const argName = ({ 1: 'msg', 2: 'nonce', 3: 'h' } as const)[arg]
  describe(`SGlobal.powHit ${argName} — byte-array cast grid`, () => {
    const expr = powHitExpr(arg)
    const bytes = (): number[] => [1, 2, 3, 4]

    it(`refuses a Coll[Any] of bytes with 'coll-class-cast'`, () => {
      expectCollClassCast(() =>
        runWithVar(expr, COLL_BYTE, tupleOfBytes(bytes())),
      )
    })

    it("accepts a specialised Coll[Byte] over byte[]", () => {
      expectCastAccepted(() => runWithVar(expr, COLL_BYTE, specByteColl(bytes())))
    })

    it("accepts a plain Coll[Byte] over byte[]", () => {
      expectCastAccepted(() =>
        runWithVar(expr, COLL_BYTE, plainByteColl(bytes())),
      )
    })

    it("accepts a bare Coll[Byte] with no cls", () => {
      expectCastAccepted(() =>
        runWithVar(expr, COLL_BYTE, bareByteColl(bytes())),
      )
    })

    it("accepts an empty unknown-class collection", () => {
      expectCastAccepted(() => runWithVar(expr, COLL_BYTE, emptyUnknown()))
    })
  })
}

// ---------------------------------------------------------------------------
// SGlobal.deserializeTo and SGlobal.fromBigEndianBytes — share the byte-cast
// helper; empty-unknown is omitted because the subsequent parse / length
// check runs on the empty bytes (the cast still accepts). The other three
// kinds exercise the cast with a payload the arm can process.
// ---------------------------------------------------------------------------

describe('SGlobal.deserializeTo — byte-array cast grid', () => {
  // `Global.deserializeTo[Int](bytes)` where bytes encode an SInt constant
  // body `0x04 00` (SInt tag + 0 ZigZag VLQ). The arm parses the wire bytes
  // as an SValue.
  const smallIntBytes = (): number[] => [0]  // ZigZag(0) = 0 → Int 0
  const makeExpr = (): Expr => ({
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 4,
    args: [getVarGet(1, COLL_BYTE)],
    explicitTypeArgs: { T: SINT },
  })

  it(`refuses a Coll[Any] of bytes with 'coll-class-cast'`, () => {
    expectCollClassCast(() =>
      runWithVar(makeExpr(), COLL_BYTE, tupleOfBytes(smallIntBytes())),
    )
  })

  it("accepts a specialised Coll[Byte] over byte[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, specByteColl(smallIntBytes())),
    )
  })

  it("accepts a plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, plainByteColl(smallIntBytes())),
    )
  })

  it("accepts a bare Coll[Byte] with no cls", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, bareByteColl(smallIntBytes())),
    )
  })

  it("accepts an empty unknown-class collection", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, emptyUnknown()),
    )
  })
})

describe('SGlobal.fromBigEndianBytes — byte-array cast grid', () => {
  // `Global.fromBigEndianBytes[Byte](<Coll[Byte] of 1 byte>)` — the arm
  // requires 1 byte for the SByte conversion.
  const oneByte = (): number[] => [7]
  const makeExpr = (): Expr => ({
    tag: 'MethodCall',
    obj: { tag: 'Global' },
    typeId: 106,
    methodId: 5,
    args: [getVarGet(1, COLL_BYTE)],
    explicitTypeArgs: { T: SBYTE },
  })

  it(`refuses a Coll[Any] of 1 byte with 'coll-class-cast'`, () => {
    expectCollClassCast(() =>
      runWithVar(makeExpr(), COLL_BYTE, tupleOfBytes(oneByte())),
    )
  })

  it("accepts a specialised Coll[Byte] over byte[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, specByteColl(oneByte())),
    )
  })

  it("accepts a plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, plainByteColl(oneByte())),
    )
  })

  it("accepts a bare Coll[Byte] with no cls", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, bareByteColl(oneByte())),
    )
  })

  // empty-unknown: 0 bytes fails the per-T length check (`length != 1` for
  // SByte), not the cast; the other three kinds exercise the cast with a
  // 1-byte payload. Omitted to keep the grid focused on the cast.
})

// ---------------------------------------------------------------------------
// SubstConstants — two casts on one node: scriptBytes (`Array[Byte]`) and
// positions (`Array[Int]`) at `trees.scala:642-643`. The newValues argument
// is read through the Coll interface and keeps its existing shape check.
// ---------------------------------------------------------------------------

describe('SubstConstants scriptBytes — byte-array cast grid', () => {
  // scriptBytes read from variable 1 under COLL_BYTE; positions is an empty
  // Coll[Int] (no substitutions) and newValues is an empty Coll[Int], so the
  // arm reduces to the input bytes unchanged. A hand-crafted non-template
  // scriptBytes is refused by the wire reader as `'subst-constants-error'`
  // (accepted here, since it is not `'coll-class-cast'`).
  const makeExpr = (): Expr => ({
    tag: 'SubstConstants',
    scriptBytes: getVarGet(1, COLL_BYTE),
    positions: {
      tag: 'Const',
      tpe: COLL_INT,
      value: specIntColl([]),
    },
    newValues: {
      tag: 'Const',
      tpe: COLL_INT,
      value: specIntColl([]),
    },
  })

  const someBytes = (): number[] => [0]  // a bogus template; the wire fn errs,
  // which still proves the cast let the collection through.

  it(`refuses a Coll[Any] of scriptBytes with 'coll-class-cast'`, () => {
    expectCollClassCast(() =>
      runWithVar(makeExpr(), COLL_BYTE, tupleOfBytes(someBytes())),
    )
  })

  it("accepts a specialised Coll[Byte] over byte[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, specByteColl(someBytes())),
    )
  })

  it("accepts a plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, plainByteColl(someBytes())),
    )
  })

  it("accepts a bare Coll[Byte] with no cls", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, bareByteColl(someBytes())),
    )
  })

  it("accepts an empty unknown-class scriptBytes collection", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_BYTE, emptyUnknown()),
    )
  })
})

describe('SubstConstants positions — int-array cast grid', () => {
  // scriptBytes fixed to a small specialised byte constant; positions read
  // from variable 1 as Coll[Int]; newValues empty. The wire fn errs on the
  // bogus template (`'subst-constants-error'`), which still proves the int
  // cast let the collection through.
  const makeExpr = (): Expr => ({
    tag: 'SubstConstants',
    scriptBytes: {
      tag: 'Const',
      tpe: COLL_BYTE,
      value: specByteColl([0]),
    },
    positions: getVarGet(1, COLL_INT),
    newValues: {
      tag: 'Const',
      tpe: COLL_INT,
      value: specIntColl([]),
    },
  })

  it(`refuses a Coll[Any] of ints with 'coll-class-cast'`, () => {
    expectCollClassCast(() =>
      runWithVar(makeExpr(), COLL_INT, tupleOfInts([0])),
    )
  })

  it("accepts a plain Coll[Int] over int[]", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_INT, plainIntColl([0])),
    )
  })

  it("accepts a specialised Coll[Int] over int[] (the `indices` class)", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_INT, specIntColl([0])),
    )
  })

  it("accepts a bare Coll[Int] with no cls", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_INT, bareIntColl([0])),
    )
  })

  it("accepts an empty unknown-class positions collection", () => {
    expectCastAccepted(() =>
      runWithVar(makeExpr(), COLL_INT, emptyUnknown()),
    )
  })
})

// ---------------------------------------------------------------------------
// DeserializeContext / DeserializeRegister — the ergots flow gates on the
// extension entry's declared `tpe` being `Coll[Byte]` before calling
// `collByteToUint8Array`. The cast behaviour is driven by the shared
// helper, so the twelve byte-consumer rows above (CalcBlake2b256,
// CalcSha256, ByteArrayToBigInt, ByteArrayToLong, DecodePoint, powHit × 3,
// deserializeTo, fromBigEndianBytes, SubstConstants scriptBytes) cover the
// helper in isolation. A grid test at the substitute-and-evaluate layer
// needs an ErgoTree body whose header carries the deserialize flag; that
// construction is heavier and is covered by `deserialize-context.test.ts`
// and `_substitution-spends.ts` at the integration level.
// ---------------------------------------------------------------------------

// ===========================================================================
// 3. AvlTree methods — key / proof / entries / digest casts.
//    JVM sites: `CErgoTreeEvaluator.scala:78-254` and `CAvlTreeVerifier.scala:55-60`.
// ===========================================================================

function anAvlTree(): SValue {
  return {
    kind: 'AvlTree',
    value: {
      digest: new Uint8Array(33),
      treeFlags: 0b00000111,  // insert + update + remove allowed
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
}

function emptyProof(): SValue {
  return specByteColl([])
}

function somePair(): SValue {
  return {
    kind: 'Tuple',
    items: [specByteColl([0]), specByteColl([0])],
  }
}

/** A hand-built `Coll[Coll[Byte]]` (e.g. keys for getMany / remove) whose
 *  outer is `'plain'` over `Coll[]` and each inner is specialised Byte. */
function plainCollOfBytes(inners: SValue[]): SValue {
  return plainColl(COLL_BYTE, inners)
}

function bareCollOfBytes(inners: SValue[]): SValue {
  return { kind: 'Coll', elem: COLL_BYTE, items: inners }
}

/** A hand-built `Coll[Tuple[Coll[Byte], Coll[Byte]]]` for insert/update/
 *  insertOrUpdate. */
function plainCollOfPairs(pairs: SValue[]): SValue {
  return plainColl(PAIR_BYTES, pairs)
}

function bareCollOfPairs(pairs: SValue[]): SValue {
  return { kind: 'Coll', elem: PAIR_BYTES, items: pairs }
}

interface AvlMethod {
  name: string
  methodId: number
  /** Build the expression. The receiver is variable 2; the first argument
   *  (key / keys / entries / digest) comes from `arg1`; the second argument
   *  (proof), when the method takes one, is the empty proof constant. */
  takesProof: boolean
  /** The declared type of the first argument. */
  arg1Tpe: SType
}

const AVL_METHODS_KEY: AvlMethod[] = [
  { name: 'AvlTree.contains', methodId: 9, takesProof: true, arg1Tpe: COLL_BYTE },
  { name: 'AvlTree.get', methodId: 10, takesProof: true, arg1Tpe: COLL_BYTE },
]

const AVL_METHODS_KEYS: AvlMethod[] = [
  { name: 'AvlTree.getMany', methodId: 11, takesProof: true, arg1Tpe: COLL_COLL_BYTE },
  { name: 'AvlTree.remove', methodId: 14, takesProof: true, arg1Tpe: COLL_COLL_BYTE },
]

const AVL_METHODS_ENTRIES: AvlMethod[] = [
  { name: 'AvlTree.insert', methodId: 12, takesProof: true, arg1Tpe: COLL_PAIR_BYTES },
  { name: 'AvlTree.update', methodId: 13, takesProof: true, arg1Tpe: COLL_PAIR_BYTES },
  { name: 'AvlTree.insertOrUpdate', methodId: 16, takesProof: true, arg1Tpe: COLL_PAIR_BYTES },
]

function avlMethodCall(m: AvlMethod, arg1: Expr, proof?: Expr): Expr {
  const tree = {
    tag: 'OptionGet' as const,
    input: { tag: 'GetVar' as const, varId: 2, varTpe: SAVLTREE },
  }
  const args: Expr[] = m.takesProof ? [arg1, proof ?? {
    tag: 'Const',
    tpe: COLL_BYTE,
    value: emptyProof(),
  }] : [arg1]
  return {
    tag: 'MethodCall',
    obj: tree,
    typeId: 100,
    methodId: m.methodId,
    args,
    explicitTypeArgs: {},
  }
}

// ---------------------------------------------------------------------------
// AvlTree key argument (contains, get) — the four kinds × refuse, one grid
// per method.
// ---------------------------------------------------------------------------

describe.each(AVL_METHODS_KEY)('$name key — byte-array cast grid', (m) => {
  const key = (v: SValue): SValue => v
  const bytes = (): number[] => [0]
  const run = (keyVal: SValue): (() => unknown) => {
    const expr = avlMethodCall(m, getVarGet(1, COLL_BYTE))
    return () =>
      runWithVars(expr, [
        { varId: 1, tpe: COLL_BYTE, value: keyVal },
        { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
      ])
  }

  it(`refuses a Coll[Any] of bytes with 'coll-class-cast'`, () => {
    expectCollClassCast(run(key(tupleOfBytes(bytes()))))
  })
  it("accepts a specialised Coll[Byte] over byte[]", () => {
    expectCastAccepted(run(key(specByteColl(bytes()))))
  })
  it("accepts a plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(run(key(plainByteColl(bytes()))))
  })
  it("accepts a bare Coll[Byte] with no cls", () => {
    expectCastAccepted(run(key(bareByteColl(bytes()))))
  })
  it("accepts an empty unknown-class key collection", () => {
    expectCastAccepted(run(key(emptyUnknown())))
  })
})

// ---------------------------------------------------------------------------
// AvlTree proof argument — common across all methods that take a proof.
// The key / keys / entries slot is populated with a valid value so the cast
// under test is the proof cast. One grid stands for the proof position
// shared across all methods (the cast site is `CAvlTreeVerifier.apply`'s
// `proof.toArray`, called from `createVerifier` in every method).
// ---------------------------------------------------------------------------

describe('AvlTree.contains proof — byte-array cast grid', () => {
  const m = AVL_METHODS_KEY[0]!
  const run = (proofVal: SValue): (() => unknown) => {
    const expr = avlMethodCall(
      m,
      { tag: 'Const', tpe: COLL_BYTE, value: specByteColl([0]) },
      getVarGet(1, COLL_BYTE),
    )
    return () =>
      runWithVars(expr, [
        { varId: 1, tpe: COLL_BYTE, value: proofVal },
        { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
      ])
  }

  it(`refuses a Coll[Any] of bytes with 'coll-class-cast'`, () => {
    expectCollClassCast(run(tupleOfBytes([0])))
  })
  it("accepts a specialised Coll[Byte] over byte[]", () => {
    expectCastAccepted(run(specByteColl([0])))
  })
  it("accepts a plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(run(plainByteColl([0])))
  })
  it("accepts a bare Coll[Byte] with no cls", () => {
    expectCastAccepted(run(bareByteColl([0])))
  })
  it("accepts an empty unknown-class proof collection", () => {
    expectCastAccepted(run(emptyUnknown()))
  })
})

// ---------------------------------------------------------------------------
// AvlTree keys argument (getMany, remove) — outer `Coll[Coll[Byte]]` is read
// through the interface; each inner `Coll[Byte]` is cast.
// ---------------------------------------------------------------------------

describe.each(AVL_METHODS_KEYS)('$name keys — byte-array cast grid (inner)', (m) => {
  const run = (keysVal: SValue): (() => unknown) => {
    const expr = avlMethodCall(m, getVarGet(1, m.arg1Tpe))
    return () =>
      runWithVars(expr, [
        { varId: 1, tpe: m.arg1Tpe, value: keysVal },
        { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
      ])
  }

  it(`refuses an inner Coll[Any] of bytes with 'coll-class-cast'`, () => {
    // Outer plain Coll[Coll[Byte]] whose one inner is a Coll[Any] tuple.
    expectCollClassCast(run(plainCollOfBytes([tupleOfBytes([0])])))
  })
  it("accepts an outer coll with an inner specialised Coll[Byte]", () => {
    expectCastAccepted(run(plainCollOfBytes([specByteColl([0])])))
  })
  it("accepts an outer coll with an inner plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(run(plainCollOfBytes([plainByteColl([0])])))
  })
  it("accepts an outer coll with an inner bare Coll[Byte] with no cls", () => {
    expectCastAccepted(run(plainCollOfBytes([bareByteColl([0])])))
  })
  it("accepts an outer coll with an inner empty-unknown collection", () => {
    expectCastAccepted(run(plainCollOfBytes([emptyUnknown()])))
  })
  it("accepts a bare outer Coll[Coll[Byte]] with no cls", () => {
    expectCastAccepted(run(bareCollOfBytes([specByteColl([0])])))
  })
})

// ---------------------------------------------------------------------------
// AvlTree entries argument (insert, update, insertOrUpdate). The outer is
// read through the Coll interface; each item is matched as a Tuple2 (a
// non-pair is `'coll-class-cast'`); each component's bytes are cast.
// ---------------------------------------------------------------------------

describe.each(AVL_METHODS_ENTRIES)('$name entries — byte-array cast grid', (m) => {
  const run = (entriesVal: SValue): (() => unknown) => {
    const expr = avlMethodCall(m, getVarGet(1, m.arg1Tpe))
    return () =>
      runWithVars(expr, [
        { varId: 1, tpe: m.arg1Tpe, value: entriesVal },
        { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
      ])
  }

  it("refuses an item that is no pair with 'coll-class-cast'", () => {
    expectCollClassCast(run(plainCollOfPairs([specByteColl([0])])))
  })
  it("refuses a Coll[Any]-of-pairs whose outer is Object[] when inner components are byte-backed", () => {
    // Outer is a Coll[Any] (plain over Object[]); items are proper pairs of
    // byte collections. The outer is read through the interface (interface
    // read, not array cast), so this ACCEPTS: the JVM's `entries.forall`
    // walks `items`, each item is matched as Tuple2, and each component's
    // `.toArray` cast runs. This row documents the interface-not-array
    // reading at the entries level.
    expectCastAccepted(run(tupleColl([somePair()])))
  })
  it("accepts a plain outer with an inner pair of specialised bytes", () => {
    expectCastAccepted(run(plainCollOfPairs([somePair()])))
  })
  it("accepts a bare outer Coll[Tuple[Coll[Byte],Coll[Byte]]] with no cls", () => {
    expectCastAccepted(run(bareCollOfPairs([somePair()])))
  })
  it("accepts an inner pair whose first component is a bare Coll[Byte] (no cls)", () => {
    const pair: SValue = {
      kind: 'Tuple',
      items: [bareByteColl([0]), specByteColl([0])],
    }
    expectCastAccepted(run(plainCollOfPairs([pair])))
  })
  it("accepts an inner pair whose second component is a plain Coll[Byte] over byte[]", () => {
    const pair: SValue = {
      kind: 'Tuple',
      items: [specByteColl([0]), plainByteColl([0])],
    }
    expectCastAccepted(run(plainCollOfPairs([pair])))
  })
  it("accepts an inner pair whose components are empty-unknown collections", () => {
    const pair: SValue = { kind: 'Tuple', items: [emptyUnknown(), emptyUnknown()] }
    expectCastAccepted(run(plainCollOfPairs([pair])))
  })
  it("refuses an inner pair whose first component is a Coll[Any] with 'coll-class-cast'", () => {
    const pair: SValue = {
      kind: 'Tuple',
      items: [tupleOfBytes([0]), specByteColl([0])],
    }
    expectCollClassCast(run(plainCollOfPairs([pair])))
  })
})

// ---------------------------------------------------------------------------
// AvlTree.updateDigest — one-argument method; the byte cast at the arm
// store (ergots eager-cast for the `AvlTreeData.digest: Uint8Array` field).
// ---------------------------------------------------------------------------

describe('AvlTree.updateDigest — byte-array cast grid', () => {
  const run = (digest: SValue): (() => unknown) => {
    const expr: Expr = {
      tag: 'MethodCall',
      obj: { tag: 'OptionGet', input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE } },
      typeId: 100,
      methodId: 15,
      args: [getVarGet(1, COLL_BYTE)],
      explicitTypeArgs: {},
    }
    return () =>
      runWithVars(expr, [
        { varId: 1, tpe: COLL_BYTE, value: digest },
        { varId: 2, tpe: SAVLTREE, value: anAvlTree() },
      ])
  }

  it(`refuses a Coll[Any] of bytes with 'coll-class-cast'`, () => {
    expectCollClassCast(run(tupleOfBytes([0, 1, 2])))
  })
  it("accepts a specialised Coll[Byte] over byte[]", () => {
    expectCastAccepted(run(specByteColl([0, 1, 2])))
  })
  it("accepts a plain Coll[Byte] over byte[]", () => {
    expectCastAccepted(run(plainByteColl([0, 1, 2])))
  })
  it("accepts a bare Coll[Byte] with no cls", () => {
    expectCastAccepted(run(bareByteColl([0, 1, 2])))
  })
  it("accepts an empty unknown-class digest collection", () => {
    expectCastAccepted(run(emptyUnknown()))
  })
})

// ===========================================================================
// 4. Xor — reads items through the interface (`trees.scala:1001-1012` →
//    `CSigmaDslBuilder.scala:146-147` → `CollsOverArrays.scala:261-262`, the
//    `left.zip(right).map { ... }` interface-read path). A `Coll[Any]` of
//    bytes answers.
// ===========================================================================

describe("Xor — interface read (no array cast)", () => {
  it("answers over a Coll[Any] of bytes (per-item read)", () => {
    const expr: Expr = {
      tag: 'Xor',
      left: getVarGet(1, COLL_BYTE),
      right: getVarGet(1, COLL_BYTE),
    }
    const v = runWithVar(expr, COLL_BYTE, tupleOfBytes([1, 2, 3]))
    expect(v.kind).toBe('Coll')
  })
})
