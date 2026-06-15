/**
 * SType wire-format serializer. Byte-for-byte compatible with sigma-rust's
 * `ergotree-ir/src/serialization/types.rs::sigma_serialize` (and equivalently
 * sigmastate-interpreter's `core/.../TypeSerializer.scala::serialize`).
 *
 * Mirror of {@link parseSType}. See that file's header for the encoding
 * model. This module only ever writes — it never reads back its own output;
 * round-trip correctness is enforced by the test suite.
 */

import type { SType, STypeVar } from '../mir/types'
import { ByteWriter } from '@ergots/scorex'

const PRIM_RANGE = 12 // MaxPrimTypeCode (11) + 1

const COLL_TYPECODE = PRIM_RANGE * 1 // 12
const NESTED_COLL_TYPECODE = PRIM_RANGE * 2 // 24
const OPTION_TYPECODE = PRIM_RANGE * 3 // 36
const OPTION_COLL_TYPECODE = PRIM_RANGE * 4 // 48
const TUPLE_PAIR1_TYPECODE = PRIM_RANGE * 5 // 60
const TUPLE_PAIR2_TYPECODE = PRIM_RANGE * 6 // 72
const TUPLE_PAIR_SYMMETRIC_TYPECODE = PRIM_RANGE * 7 // 84
const TUPLE_TYPECODE = PRIM_RANGE * 8 // 96

const TYPE_CODE_STYPE_VAR = 103
const TYPE_CODE_SFUNC = 112

export class STypeSerializeError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'STypeSerializeError'
  }
}

/**
 * If `t` is an embeddable primitive (codes 1..8), return its type code.
 * Otherwise return `null`. Matches sigma-rust's
 * `TypeCode::from_primitive_type` for the embeddable subset (lines 129-156
 * of `serialization/types.rs`), restricted to types we support.
 *
 * Used by composite serializers (`serializeSColl`, `serializeSOption`,
 * `serializePair`) to detect compact-form encodings like `[12 + primId]`.
 */
function embeddablePrimitiveCode(t: SType): number | null {
  switch (t.tag) {
    case 'SBoolean':
      return 1
    case 'SByte':
      return 2
    case 'SShort':
      return 3
    case 'SInt':
      return 4
    case 'SLong':
      return 5
    case 'SBigInt':
      return 6
    case 'SUnsignedBigInt':
      return 9
    case 'SGroupElement':
      return 7
    case 'SSigmaProp':
      return 8
    default:
      return null
  }
}

/**
 * Serialize `t` into `w`. Throws {@link STypeSerializeError} on any
 * argument-bounds violation (e.g. STuple of <2 or >255 items, SFunc with
 * t_dom > 255, STypeVar name length outside [1, 254]). Byte output is
 * byte-identical to sigma-rust's `SType::sigma_serialize` for every well-
 * formed input.
 *
 * Implemented as a single exhaustive switch on `t.tag` covering all 22
 * variants. Primitive variants emit their type code directly; composite
 * variants delegate to dedicated helpers (`serializeSColl`, etc.) that
 * handle compact-form short-circuits.
 */
export function serializeSType(t: SType, w: ByteWriter): void {
  switch (t.tag) {
    // --- Embeddable primitives (codes 1..8) ---
    case 'SBoolean':
      w.writeU8(1)
      return
    case 'SByte':
      w.writeU8(2)
      return
    case 'SShort':
      w.writeU8(3)
      return
    case 'SInt':
      w.writeU8(4)
      return
    case 'SLong':
      w.writeU8(5)
      return
    case 'SBigInt':
      w.writeU8(6)
      return
    case 'SUnsignedBigInt':
      w.writeU8(9)
      return
    case 'SGroupElement':
      w.writeU8(7)
      return
    case 'SSigmaProp':
      w.writeU8(8)
      return

    // --- Non-embeddable primitives (codes 97..106) ---
    case 'SAny':
      w.writeU8(97)
      return
    case 'SUnit':
      w.writeU8(98)
      return
    case 'SBox':
      w.writeU8(99)
      return
    case 'SAvlTree':
      w.writeU8(100)
      return
    case 'SContext':
      w.writeU8(101)
      return
    case 'SString':
      w.writeU8(102)
      return
    case 'SHeader':
      w.writeU8(104)
      return
    case 'SPreHeader':
      w.writeU8(105)
      return
    case 'SGlobal':
      w.writeU8(106)
      return

    // --- Composites ---
    case 'SColl':
      serializeSColl(t.elem, w)
      return
    case 'SOption':
      serializeSOption(t.elem, w)
      return
    case 'STuple':
      serializeSTuple(t.items, w)
      return
    case 'STypeVar':
      serializeSTypeVar(t.name, w)
      return
    case 'SFunc':
      serializeSFunc(t.args, t.result, t.tpeParams, w)
      return

    default: {
      // Compile-time exhaustiveness: every variant must be matched above.
      const _exhaust: never = t
      throw new STypeSerializeError(
        `Unreachable SType variant: ${JSON.stringify(_exhaust)}`,
        'unreachable'
      )
    }
  }
}

/**
 * SColl encoding (sigma-rust lines 342-378):
 *   - elem = embeddable primitive p → single byte `COLL + p`
 *   - elem = SColl[embeddable primitive p] → single byte `NESTED_COLL + p`
 *   - else → `COLL` byte, then `serialize(elem)`
 */
function serializeSColl(elem: SType, w: ByteWriter): void {
  const elemPrim = embeddablePrimitiveCode(elem)
  if (elemPrim !== null) {
    w.writeU8(COLL_TYPECODE + elemPrim)
    return
  }
  if (elem.tag === 'SColl') {
    const innerPrim = embeddablePrimitiveCode(elem.elem)
    if (innerPrim !== null) {
      w.writeU8(NESTED_COLL_TYPECODE + innerPrim)
      return
    }
  }
  w.writeU8(COLL_TYPECODE)
  serializeSType(elem, w)
}

/**
 * SOption encoding (sigma-rust lines 304-340):
 *   - elem = embeddable primitive p → single byte `OPTION + p`
 *   - elem = SColl[embeddable primitive p] → single byte `OPTION_COLL + p`
 *   - else → `OPTION` byte, then `serialize(elem)`
 */
function serializeSOption(elem: SType, w: ByteWriter): void {
  const elemPrim = embeddablePrimitiveCode(elem)
  if (elemPrim !== null) {
    w.writeU8(OPTION_TYPECODE + elemPrim)
    return
  }
  if (elem.tag === 'SColl') {
    const innerPrim = embeddablePrimitiveCode(elem.elem)
    if (innerPrim !== null) {
      w.writeU8(OPTION_COLL_TYPECODE + innerPrim)
      return
    }
  }
  w.writeU8(OPTION_TYPECODE)
  serializeSType(elem, w)
}

/**
 * STuple encoding (sigma-rust lines 379-447). Note arity-specific layout:
 *   - 2 items, both same embeddable primitive p → `PAIR_SYMMETRIC + p`
 *   - 2 items, first is embeddable primitive p (and t1 ≠ t2)
 *           → `PAIR1 + p`, then `serialize(t2)`
 *   - 2 items, only second is embeddable primitive p
 *           → `PAIR2 + p`, then `serialize(t1)`
 *   - 2 items, both non-embeddable → `PAIR1` byte, `serialize(t1)`, `serialize(t2)`
 *   - 3 items → `PAIR2` byte (a.k.a. TripleTypeCode), serialize each
 *   - 4 items → `PAIR_SYMMETRIC` byte (a.k.a. QuadrupleTypeCode), serialize each
 *   - 5..=255 items → `TUPLE` byte, u8 length, serialize each
 */
function serializeSTuple(items: readonly SType[], w: ByteWriter): void {
  if (items.length < 2) {
    throw new STypeSerializeError(
      `STuple must have ≥ 2 items, got ${items.length}`,
      'tuple-too-short'
    )
  }
  if (items.length > 255) {
    throw new STypeSerializeError(
      `STuple must have ≤ 255 items, got ${items.length}`,
      'tuple-too-long'
    )
  }

  if (items.length === 2) {
    serializePair(items[0]!, items[1]!, w)
    return
  }
  if (items.length === 3) {
    w.writeU8(TUPLE_PAIR2_TYPECODE)
    serializeSType(items[0]!, w)
    serializeSType(items[1]!, w)
    serializeSType(items[2]!, w)
    return
  }
  if (items.length === 4) {
    w.writeU8(TUPLE_PAIR_SYMMETRIC_TYPECODE)
    serializeSType(items[0]!, w)
    serializeSType(items[1]!, w)
    serializeSType(items[2]!, w)
    serializeSType(items[3]!, w)
    return
  }
  // 5..=255
  w.writeU8(TUPLE_TYPECODE)
  w.writeU8(items.length)
  for (const item of items) {
    serializeSType(item, w)
  }
}

function serializePair(t1: SType, t2: SType, w: ByteWriter): void {
  const t1Prim = embeddablePrimitiveCode(t1)
  const t2Prim = embeddablePrimitiveCode(t2)

  if (t1Prim !== null) {
    // First item is embeddable primitive.
    if (t2Prim !== null && t1Prim === t2Prim) {
      // Symmetric pair of identical primitives.
      w.writeU8(TUPLE_PAIR_SYMMETRIC_TYPECODE + t1Prim)
      return
    }
    // Asymmetric pair where first is primitive.
    w.writeU8(TUPLE_PAIR1_TYPECODE + t1Prim)
    serializeSType(t2, w)
    return
  }
  if (t2Prim !== null) {
    // Only second item is primitive. t1 is read after t2 in this encoding.
    w.writeU8(TUPLE_PAIR2_TYPECODE + t2Prim)
    serializeSType(t1, w)
    return
  }
  // Both non-primitive: emit PAIR1 + serialize(t1) + serialize(t2).
  w.writeU8(TUPLE_PAIR1_TYPECODE)
  serializeSType(t1, w)
  serializeSType(t2, w)
}

/**
 * STypeVar encoding (JVM TypeSerializer.serialize:122-127):
 *   `STYPE_VAR` byte + u8 name length + UTF-8 name bytes.
 *
 * The JVM emits the length via `putUByte(bytes.length)` — no lower bound; the u8 field
 * caps at 255 — so we reject only > 255 UTF-8 bytes (what the u8 length cannot hold).
 * The old [1,254] reject mirrored sigma-rust's BoundedVec and was a JVM fork in both
 * directions (the matching parse over-rejected nameLen 0 and 255). The bound is on the
 * UTF-8 byte length (NOT the JS string length — multi-byte chars matter).
 */
function serializeSTypeVar(name: string, w: ByteWriter): void {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length > 255) {
    throw new STypeSerializeError(
      `STypeVar name UTF-8 byte length ${bytes.length} exceeds 255 (u8 length field)`,
      'stypevar-name-length'
    )
  }
  w.writeU8(TYPE_CODE_STYPE_VAR)
  w.writeU8(bytes.length)
  w.writeBytes(bytes)
}

/**
 * SFunc encoding (sigma-rust lines 453-469, v3+ only):
 *   `SFUNC` byte + u8 t_dom_len + each t_dom + serialize(t_range)
 *   + u8 tpe_params_len + each tpe_param (each emitted as `STypeVar`).
 *
 * Per sigma-rust both lengths are bounded ≤ 255 (u8 fields).
 */
function serializeSFunc(
  args: readonly SType[],
  result: SType,
  tpeParams: readonly STypeVar[],
  w: ByteWriter
): void {
  if (args.length > 255) {
    throw new STypeSerializeError(
      `SFunc t_dom must have ≤ 255 items, got ${args.length}`,
      'sfunc-tdom-too-long'
    )
  }
  if (tpeParams.length > 255) {
    throw new STypeSerializeError(
      `SFunc tpe_params must have ≤ 255 items, got ${tpeParams.length}`,
      'sfunc-tpe-params-too-long'
    )
  }
  w.writeU8(TYPE_CODE_SFUNC)
  w.writeU8(args.length)
  for (const arg of args) {
    serializeSType(arg, w)
  }
  serializeSType(result, w)
  w.writeU8(tpeParams.length)
  for (const tp of tpeParams) {
    serializeSTypeVar(tp.name, w)
  }
}
