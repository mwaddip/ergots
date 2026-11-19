/**
 * The JVM's array-cast consumers (`toArray.asInstanceOf[Array[T]]`, or a call
 * whose signature needs that array of a class). Each consumer refuses a
 * collection whose array is of another class with `'coll-class-cast'`, and
 * accepts a collection over the right array in each of the four shapes the
 * data reader and the `toBytes` family produce: specialised, plain over the
 * primitive, plain over the primitive with no `cls` handed by the caller, and
 * the empty-unknown class a `map`/`flatMap` of an untyped mapper returns.
 *
 * The tuple value is built by `tupleColl(items)` (the JVM's `Coll[Any]` over
 * `Object[]`) and surfaced through context variable 1, since the data reader
 * does not yet build it.
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
const COLL_SIGMAPROP: SType = { tag: 'SColl', elem: SSIGMAPROP }
const SAVLTREE: SType = { tag: 'SAvlTree' }

/** `getVar[T](id).get` — reads variable `id` whose value is bound by the context. */
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

/**
 * A plain `Coll[Byte]` over `byte[]`, the shape `Long.toBytes` gives (producer
 * table: `byte[]` plain). The items are the integers taken mod 256 as signed
 * bytes.
 */
function plainByteColl(bytes: number[]): SValue {
  const items: SValue[] = bytes.map((b) => ({
    kind: 'Byte',
    value: (b << 24) >> 24,
  }))
  return plainColl(SBYTE, items)
}

/** A specialised `Coll[Byte]` over `byte[]`, the data reader's class for a byte collection. */
function specByteColl(bytes: number[]): SValue {
  const items: SValue[] = bytes.map((b) => ({
    kind: 'Byte',
    value: (b << 24) >> 24,
  }))
  return specColl(SBYTE, items)
}

/** A plain `Coll[Byte]` with no `cls` handed by the caller. The reader resolves
 *  its class as the data reader's (specialised for `SByte`). */
function bareByteColl(bytes: number[]): SValue {
  const items: SValue[] = bytes.map((b) => ({
    kind: 'Byte',
    value: (b << 24) >> 24,
  }))
  return { kind: 'Coll', elem: SBYTE, items }
}

/** The empty collection of the unknown class, an untyped mapper's result. */
function emptyUnknown(): SValue {
  return empty(SANY_ERGOTS)
}

function runWithVar(expr: Expr, varTpe: SType, varVal: SValue, treeVersion = 3) {
  const ctx = makeContext({
    treeVersion,
    extension: { values: new Map([[1, { tpe: varTpe, value: varVal }]]) },
  })
  return evalExpr(expr, Env.empty(), ctx)
}

// ---------------------------------------------------------------------------
// AtLeast — a `Coll[Any]` of SigmaProp items refuses; a `Coll[SigmaProp]` answers.
// JVM `SigmaDsl.atLeast` casts `props.toArray` to `Array[SigmaProp]`
// (`CSigmaDslBuilder.scala:102-108`); the cast runs inside the Pattern-B cost.
// ---------------------------------------------------------------------------

/** A hand-built `Coll[Any]` whose items are three SigmaProps (TrivialTrue). */
function tupleOfThreeSigmaProps(): SValue {
  const items: SValue[] = [1, 2, 3].map(() => ({
    kind: 'SigmaProp',
    value: { tag: 'TrivialProp', value: true },
  }))
  return tupleColl(items)
}

/** A plain `Coll[SigmaProp]` over `SigmaProp[]`, the data reader's class. */
function plainSigmaPropColl(): SValue {
  const items: SValue[] = [1, 2, 3].map(() => ({
    kind: 'SigmaProp',
    value: { tag: 'TrivialProp', value: true },
  }))
  return plainColl(SSIGMAPROP, items)
}

describe("AtLeast — the array cast (trees.scala:314-320, CSigmaDslBuilder.scala:102-108)", () => {
  it("refuses a Coll[Any] of three SigmaProps with 'coll-class-cast'", () => {
    const expr: Expr = {
      tag: 'Atleast',
      bound: intC(2),
      input: getVarGet(1, COLL_SIGMAPROP),
    }
    const err = captureEvalError(() =>
      runWithVar(expr, COLL_SIGMAPROP, tupleOfThreeSigmaProps()),
    )
    expect(err.code).toBe('coll-class-cast')
  })

  it("accepts a plain Coll[SigmaProp] (the data reader's class)", () => {
    const expr: Expr = {
      tag: 'Atleast',
      bound: intC(2),
      input: getVarGet(1, COLL_SIGMAPROP),
    }
    const v = runWithVar(expr, COLL_SIGMAPROP, plainSigmaPropColl())
    expect(v.kind).toBe('SigmaProp')
  })
})

// ---------------------------------------------------------------------------
// The byte-reading casting consumers: CalcBlake2b256, CalcSha256,
// ByteArrayToBigInt. Each refuses a `Coll[Any]` of bytes with `'coll-class-cast'`;
// each accepts the four byte-collection shapes.
// ---------------------------------------------------------------------------

/** A `Coll[Any]` of three byte items — the shape a tuple `(1:Byte, 2:Byte, 3:Byte)` takes. */
function tupleOfBytes(): SValue {
  const items: SValue[] = [1, 2, 3].map((v) => ({ kind: 'Byte' as const, value: v }))
  return tupleColl(items)
}

describe("CalcBlake2b256 — the array cast (CSigmaDslBuilder.scala:153-156)", () => {
  const expr: Expr = {
    tag: 'CalcBlake2b256',
    input: getVarGet(1, COLL_BYTE),
  }

  it("refuses a Coll[Any] of bytes with 'coll-class-cast'", () => {
    const err = captureEvalError(() => runWithVar(expr, COLL_BYTE, tupleOfBytes()))
    expect(err.code).toBe('coll-class-cast')
  })

  it("accepts a specialised Coll[Byte]", () => {
    const v = runWithVar(expr, COLL_BYTE, specByteColl([1, 2, 3]))
    expect(v.kind).toBe('Coll')
  })

  it("accepts a plain Coll[Byte] over byte[] (Long.toBytes shape)", () => {
    const v = runWithVar(expr, COLL_BYTE, plainByteColl([1, 2, 3]))
    expect(v.kind).toBe('Coll')
  })

  it("accepts a bare Coll[Byte] with no cls (the reader's class)", () => {
    const v = runWithVar(expr, COLL_BYTE, bareByteColl([1, 2, 3]))
    expect(v.kind).toBe('Coll')
  })

  it("accepts an empty-unknown-class result (an untyped mapper's empty)", () => {
    const v = runWithVar(expr, COLL_BYTE, emptyUnknown())
    expect(v.kind).toBe('Coll')
  })
})

describe("CalcSha256 — the array cast (CSigmaDslBuilder.scala:158-161)", () => {
  const expr: Expr = {
    tag: 'CalcSha256',
    input: getVarGet(1, COLL_BYTE),
  }

  it("refuses a Coll[Any] of bytes with 'coll-class-cast'", () => {
    const err = captureEvalError(() => runWithVar(expr, COLL_BYTE, tupleOfBytes()))
    expect(err.code).toBe('coll-class-cast')
  })

  it("accepts a plain Coll[Byte] over byte[]", () => {
    const v = runWithVar(expr, COLL_BYTE, plainByteColl([1, 2, 3]))
    expect(v.kind).toBe('Coll')
  })
})

describe("ByteArrayToBigInt — the array cast (CSigmaDslBuilder.scala:163)", () => {
  const expr: Expr = {
    tag: 'ByteArrayToBigInt',
    input: getVarGet(1, COLL_BYTE),
  }

  it("refuses a Coll[Any] of bytes with 'coll-class-cast'", () => {
    const err = captureEvalError(() => runWithVar(expr, COLL_BYTE, tupleOfBytes()))
    expect(err.code).toBe('coll-class-cast')
  })

  it("accepts a plain Coll[Byte] over byte[]", () => {
    const v = runWithVar(expr, COLL_BYTE, plainByteColl([1, 2, 3]))
    expect(v.kind).toBe('BigInt')
  })
})

// ---------------------------------------------------------------------------
// Xor — reads items through the interface and answers (trees.scala:1001-1012
// → CSigmaDslBuilder.scala:146-147 → CollsOverArrays.scala:261-262: zip + map).
// A `Coll[Any]` of bytes answers.
// ---------------------------------------------------------------------------

describe("Xor — reads items through the interface (CollsOverArrays.scala:261-262)", () => {
  it("answers over a Coll[Any] of bytes (per-item read, not array cast)", () => {
    const expr: Expr = {
      tag: 'Xor',
      left: getVarGet(1, COLL_BYTE),
      right: getVarGet(1, COLL_BYTE),
    }
    const v = runWithVar(expr, COLL_BYTE, tupleOfBytes())
    expect(v.kind).toBe('Coll')
  })
})

// ---------------------------------------------------------------------------
// AvlTree.contains — key and proof casts (CErgoTreeEvaluator.scala:78-91 →
// `key.toArray`; and CAvlTreeVerifier.apply casts `proof.toArray`). The key
// over a Coll[Any] refuses.
// ---------------------------------------------------------------------------

function someAvlTree(): SValue {
  // A 33-byte digest the parser produces (treeFlags=0, keyLength=32, valueLengthOpt=None).
  return {
    kind: 'AvlTree',
    value: {
      digest: new Uint8Array(33),
      treeFlags: 0,
      keyLength: 32,
      valueLengthOpt: null,
    },
  }
}

describe("AvlTree.contains — the key cast (CErgoTreeEvaluator.scala:83)", () => {
  // `tree.contains(key, proof)` — tree in variable 2, key in variable 1 (the
  // `Coll[Any]`), proof an empty `Coll[Byte]` constant (fails verifier, but
  // the key cast fires before the verifier runs).
  function keyContainsExpr(): Expr {
    return {
      tag: 'MethodCall',
      obj: { tag: 'OptionGet', input: { tag: 'GetVar', varId: 2, varTpe: SAVLTREE } },
      methodId: 9, // SAvlTree.contains
      typeId: 100,
      args: [
        getVarGet(1, COLL_BYTE),
        { tag: 'Const', tpe: COLL_BYTE, value: specByteColl([]) },
      ],
      explicitTypeArgs: {},
    }
  }

  it("refuses a Coll[Any] of bytes as the key with 'coll-class-cast'", () => {
    const ctx = makeContext({
      treeVersion: 3,
      extension: {
        values: new Map<number, { tpe: SType; value: SValue }>([
          [1, { tpe: COLL_BYTE, value: tupleOfBytes() }],
          [2, { tpe: SAVLTREE, value: someAvlTree() }],
        ]),
      },
    })
    const err = captureEvalError(() => evalExpr(keyContainsExpr(), Env.empty(), ctx))
    expect(err.code).toBe('coll-class-cast')
  })
})
