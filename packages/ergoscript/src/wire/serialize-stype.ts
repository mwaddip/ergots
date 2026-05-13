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
import { ByteWriter } from './writer'

const PRIM_RANGE = 12 // MaxPrimTypeCode (11) + 1

const COLL_TYPECODE = PRIM_RANGE * 1 // 12
const NESTED_COLL_TYPECODE = PRIM_RANGE * 2 // 24
const OPTION_TYPECODE = PRIM_RANGE * 3 // 36
const OPTION_COLL_TYPECODE = PRIM_RANGE * 4 // 48
const TUPLE_PAIR1_TYPECODE = PRIM_RANGE * 5 // 60
const TUPLE_PAIR2_TYPECODE = PRIM_RANGE * 6 // 72
const TUPLE_PAIR_SYMMETRIC_TYPECODE = PRIM_RANGE * 7 // 84
const TUPLE_TYPECODE = PRIM_RANGE * 8 // 96

const TYPE_CODE_SANY = 97
const TYPE_CODE_SUNIT = 98
const TYPE_CODE_SBOX = 99
const TYPE_CODE_SAVL_TREE = 100
const TYPE_CODE_SCONTEXT = 101
const TYPE_CODE_SSTRING = 102
const TYPE_CODE_STYPE_VAR = 103
const TYPE_CODE_SHEADER = 104
const TYPE_CODE_SPRE_HEADER = 105
const TYPE_CODE_SGLOBAL = 106
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
    case 'SGroupElement':
      return 7
    case 'SSigmaProp':
      return 8
    default:
      return null
  }
}

/**
 * If `t` is a non-embeddable primitive (one of `SAny`, `SUnit`, …,
 * `SHeader`, `SPreHeader`, `SGlobal`, `SString`), return its type code.
 * Otherwise return `null`.
 */
function nonEmbeddablePrimitiveCode(t: SType): number | null {
  switch (t.tag) {
    case 'SAny':
      return TYPE_CODE_SANY
    case 'SUnit':
      return TYPE_CODE_SUNIT
    case 'SBox':
      return TYPE_CODE_SBOX
    case 'SAvlTree':
      return TYPE_CODE_SAVL_TREE
    case 'SContext':
      return TYPE_CODE_SCONTEXT
    case 'SString':
      return TYPE_CODE_SSTRING
    case 'SHeader':
      return TYPE_CODE_SHEADER
    case 'SPreHeader':
      return TYPE_CODE_SPRE_HEADER
    case 'SGlobal':
      return TYPE_CODE_SGLOBAL
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
 */
export function serializeSType(t: SType, w: ByteWriter): void {
  // 1. Embeddable primitives: single-byte type code.
  const embCode = embeddablePrimitiveCode(t)
  if (embCode !== null) {
    w.writeU8(embCode)
    return
  }

  // 2. Non-embeddable primitives: single-byte type code.
  const neCode = nonEmbeddablePrimitiveCode(t)
  if (neCode !== null) {
    w.writeU8(neCode)
    return
  }

  // 3. Composites.
  switch (t.tag) {
    case 'SColl':
      serializeColl(t.elem, w)
      return
    case 'SOption':
      serializeOption(t.elem, w)
      return
    case 'STuple':
      serializeTuple(t.items, w)
      return
    case 'STypeVar':
      serializeTypeVar(t.name, w)
      return
    case 'SFunc':
      serializeFunc(t.args, t.result, t.tpeParams, w)
      return
    default: {
      // Compile-time exhaustiveness: every variant must be matched above.
      const _exhaust: never = t
      throw new STypeSerializeError(
        `unreachable: unmatched SType ${JSON.stringify(_exhaust)}`,
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
function serializeColl(elem: SType, w: ByteWriter): void {
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
function serializeOption(elem: SType, w: ByteWriter): void {
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
function serializeTuple(items: readonly SType[], w: ByteWriter): void {
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
 * STypeVar encoding (sigma-rust `types/stype_param.rs::sigma_serialize`):
 *   `STYPE_VAR` byte + u8 name length + UTF-8 name bytes.
 *
 * BoundedVec invariant 1..=254 from sigma-rust is enforced here on the
 * UTF-8 byte length (NOT the JS string length — multi-byte chars matter).
 */
function serializeTypeVar(name: string, w: ByteWriter): void {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length < 1 || bytes.length > 254) {
    throw new STypeSerializeError(
      `STypeVar name UTF-8 byte length ${bytes.length} out of [1, 254]`,
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
function serializeFunc(
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
    serializeTypeVar(tp.name, w)
  }
}
