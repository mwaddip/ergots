/**
 * SType wire-format parser. Byte-for-byte compatible with sigma-rust's
 * `ergotree-ir/src/serialization/types.rs::sigma_parse` (and equivalently
 * sigmastate-interpreter's `core/.../TypeSerializer.scala::deserialize`).
 *
 * Encoding model (`MaxPrimTypeCode = 11`, so `PrimRange = 12`):
 * - Primitives (codes 1..8 embeddable; SUnsignedBigInt=9 is v6-only and
 *   modelled as embeddable — the version gate lives in validateV6Types).
 * - Container short-forms for c < 96 (TUPLE_TYPECODE): split into
 *   `containerId = (c / 12) * 12` and `primId = c % 12`. `containerId`
 *   selects Coll / Nested-Coll / Option / Option-Coll / Pair1 / Pair2 /
 *   PairSymmetric; `primId == 0` means "recursively parse next SType",
 *   `primId > 0` means "embedded primitive type at that primId".
 * - Non-embeddable primitives + Tuple + STypeVar + SFunc occupy bytes
 *   ≥ TUPLE_TYPECODE (96).
 */

import type { SType, STypeVar } from '../mir/types'
import { ByteReader } from '@ergots/scorex'

const PRIM_RANGE = 12 // MaxPrimTypeCode (11) + 1

const COLL_CONSTR_ID = 1
const NESTED_COLL_CONSTR_ID = 2
const OPTION_CONSTR_ID = 3
const OPTION_COLL_CONSTR_ID = 4
const TUPLE_PAIR1_CONSTR_ID = 5
const TUPLE_PAIR2_CONSTR_ID = 6
const TUPLE_PAIR_SYMMETRIC_CONSTR_ID = 7

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

/**
 * Map an embeddable primitive type id (1..9) to its corresponding
 * `SType`. Returns `null` for id 0 (i.e. "no embedded primitive"); throws
 * for any other out-of-range value. SUnsignedBigInt (id 9) is accepted
 * permissively — the version gate lives in validateV6Types (eval-time).
 */
function embeddablePrimitive(primId: number): SType | null {
  switch (primId) {
    case 0:
      return null
    case 1:
      return { tag: 'SBoolean' }
    case 2:
      return { tag: 'SByte' }
    case 3:
      return { tag: 'SShort' }
    case 4:
      return { tag: 'SInt' }
    case 5:
      return { tag: 'SLong' }
    case 6:
      return { tag: 'SBigInt' }
    case 7:
      return { tag: 'SGroupElement' }
    case 8:
      return { tag: 'SSigmaProp' }
    case 9:
      // SUnsignedBigInt — permissive at parse; the v3 gate is validateV6Types
      // (eval-time, authoritative ctx.treeVersion). See P2a spec §4.
      return { tag: 'SUnsignedBigInt' }
    default:
      throw new STypeParseError(
        `invalid embeddable primId ${primId}`,
        'invalid-type-code'
      )
  }
}

export class STypeParseError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'STypeParseError'
  }
}

/**
 * Parse an SType from `r`. Throws {@link STypeParseError} on any malformed
 * or unsupported encoding. Mirrors sigma-rust's `SType::sigma_parse` /
 * `SType::parse_with_tag` (`ergotree-ir/src/serialization/types.rs:177-281`).
 */
export function parseSType(r: ByteReader): SType {
  const c = r.readU8()
  return parseSTypeWithFirstByte(c, r)
}

/**
 * Parse an SType when the first byte (`c`) has already been consumed from a
 * surrounding stream — for example, by the {@link parseExpr} dispatch byte
 * for inline `Const` nodes (where the SType's first byte doubles as the
 * "opcode" the dispatcher reads). Returns the same result as `parseSType`
 * given the same logical input bytes.
 *
 * Mirrors sigma-rust's `SType::parse_with_tag` (`serialization/types.rs`),
 * which is the lookahead-friendly counterpart to `SType::sigma_parse`. Used
 * by `Constant::parse_with_tag` to consume the rest of the type+value pair
 * after the Expr-dispatch has peeked at the type code.
 */
export function parseSTypeWithFirstByte(c: number, r: ByteReader): SType {
  if (c === 0) {
    throw new STypeParseError(`invalid type code 0`, 'invalid-type-code')
  }
  if (c < TUPLE_TYPECODE) {
    return parseContainerOrPrimitive(r, c)
  }
  return parseHighTypeCode(r, c)
}

function parseContainerOrPrimitive(r: ByteReader, c: number): SType {
  const containerId = Math.floor(c / PRIM_RANGE)
  const primId = c % PRIM_RANGE
  switch (containerId) {
    case 0: {
      // c is itself a primitive code (1..11). embeddable() handles 1..9
      // (9 = SUnsignedBigInt, v6); 10..11 are unused → fall through error.
      const t = embeddablePrimitive(primId)
      if (t === null) {
        throw new STypeParseError(
          `invalid type code ${c}`,
          'invalid-type-code'
        )
      }
      return t
    }
    case COLL_CONSTR_ID: {
      // SColl[T]: if primId>0, T is embedded primitive; else recursive
      return { tag: 'SColl', elem: readArgType(r, primId) }
    }
    case NESTED_COLL_CONSTR_ID: {
      // SColl[SColl[T]]: T embedded or recursive (per sigma-rust's match in
      // `parse_with_tag` for `Some(TypeCode::NESTED_COLL)`).
      return {
        tag: 'SColl',
        elem: { tag: 'SColl', elem: readArgType(r, primId) }
      }
    }
    case OPTION_CONSTR_ID: {
      return { tag: 'SOption', elem: readArgType(r, primId) }
    }
    case OPTION_COLL_CONSTR_ID: {
      return {
        tag: 'SOption',
        elem: { tag: 'SColl', elem: readArgType(r, primId) }
      }
    }
    case TUPLE_PAIR1_CONSTR_ID: {
      // Pair1: t1 embedded primitive (or non-embeddable if primId=0), then
      // serialize(t2). See sigma-rust `Some(TypeCode::TUPLE_PAIR1)` arm.
      const t1 = readArgType(r, primId)
      const t2 = parseSType(r)
      return { tag: 'STuple', items: [t1, t2] }
    }
    case TUPLE_PAIR2_CONSTR_ID: {
      // Pair2: if primId==0, this is a TRIPLE (t1,t2,t3); else (t1,t2) where
      // t2 is the embedded primitive and t1 is read NEXT in the stream.
      if (primId === 0) {
        const t1 = parseSType(r)
        const t2 = parseSType(r)
        const t3 = parseSType(r)
        return { tag: 'STuple', items: [t1, t2, t3] }
      }
      const t2 = embeddablePrimitive(primId)
      // primId > 0 ⇒ embeddablePrimitive returns a concrete SType
      const t1 = parseSType(r)
      return { tag: 'STuple', items: [t1, t2 as SType] }
    }
    case TUPLE_PAIR_SYMMETRIC_CONSTR_ID: {
      // PairSymmetric: if primId==0, this is a QUADRUPLE (t1..t4); else
      // (t,t) where t is the embedded primitive.
      if (primId === 0) {
        const t1 = parseSType(r)
        const t2 = parseSType(r)
        const t3 = parseSType(r)
        const t4 = parseSType(r)
        return { tag: 'STuple', items: [t1, t2, t3, t4] }
      }
      const t = embeddablePrimitive(primId) as SType
      return { tag: 'STuple', items: [t, t] }
    }
    default:
      // Unreachable: containerId ∈ {0..7} given c < 96 and PRIM_RANGE=12.
      throw new STypeParseError(
        `invalid container id ${containerId} (byte ${c})`,
        'invalid-type-code'
      )
  }
}

/**
 * For container-with-primId encoding: `primId == 0` means the next SType
 * is encoded recursively in the stream; `primId > 0` means the type is
 * the embedded primitive at that id.
 */
function readArgType(r: ByteReader, primId: number): SType {
  if (primId === 0) {
    return parseSType(r)
  }
  return embeddablePrimitive(primId) as SType
}

function parseHighTypeCode(r: ByteReader, c: number): SType {
  switch (c) {
    case TUPLE_TYPECODE: {
      // Tuple with explicit length (5+ items): u8 length, then each item.
      const len = r.readU8()
      const items: SType[] = []
      for (let i = 0; i < len; i++) {
        items.push(parseSType(r))
      }
      // STuple invariant 2..=255: enforced on serialize, and a too-short
      // tuple here would be a malformed input — but reproducing sigma-rust's
      // permissive behavior (it goes through `STuple::try_from` and rejects
      // there) we likewise reject here.
      if (items.length < 2 || items.length > 255) {
        throw new STypeParseError(
          `STuple length ${items.length} out of [2, 255]`,
          'invalid-tuple-length'
        )
      }
      return { tag: 'STuple', items }
    }
    case TYPE_CODE_SANY:
      return { tag: 'SAny' }
    case TYPE_CODE_SUNIT:
      return { tag: 'SUnit' }
    case TYPE_CODE_SBOX:
      return { tag: 'SBox' }
    case TYPE_CODE_SAVL_TREE:
      return { tag: 'SAvlTree' }
    case TYPE_CODE_SCONTEXT:
      return { tag: 'SContext' }
    case TYPE_CODE_SSTRING:
      return { tag: 'SString' }
    case TYPE_CODE_STYPE_VAR: {
      // STypeVar: u8 name length + UTF-8 bytes (BoundedVec 1..254 in
      // sigma-rust). See `types/stype_param.rs::sigma_parse`.
      const nameLen = r.readU8()
      if (nameLen < 1 || nameLen > 254) {
        throw new STypeParseError(
          `STypeVar name length ${nameLen} out of [1, 254]`,
          'invalid-stypevar-length'
        )
      }
      const bytes = r.readBytes(nameLen)
      // TextDecoder is available in Node 20+ and all browsers; we set
      // fatal:true so invalid UTF-8 surfaces as a parse error rather than
      // a replacement-character payload.
      let name: string
      try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new STypeParseError(
          `STypeVar name is not valid UTF-8`,
          'invalid-stypevar-utf8'
        )
      }
      return { tag: 'STypeVar', name }
    }
    case TYPE_CODE_SHEADER:
      return { tag: 'SHeader' }
    case TYPE_CODE_SPRE_HEADER:
      return { tag: 'SPreHeader' }
    case TYPE_CODE_SGLOBAL:
      return { tag: 'SGlobal' }
    case TYPE_CODE_SFUNC: {
      // SFunc (v6/ErgoTree v3+): u8 t_dom_len + t_dom items + t_range +
      // u8 tpe_params_len + tpe_params (each must parse to STypeVar).
      // See sigma-rust `Some(TypeCode::SFUNC)` arm at lines 252-275.
      const tDomLen = r.readU8()
      const args: SType[] = []
      for (let i = 0; i < tDomLen; i++) {
        args.push(parseSType(r))
      }
      const result = parseSType(r)
      const tpeParamsLen = r.readU8()
      const tpeParams: STypeVar[] = []
      for (let i = 0; i < tpeParamsLen; i++) {
        const tpe = parseSType(r)
        if (tpe.tag !== 'STypeVar') {
          throw new STypeParseError(
            `SFunc tpe_params must be STypeVar, got ${tpe.tag}`,
            'invalid-sfunc-tpe-params'
          )
        }
        tpeParams.push({ name: tpe.name })
      }
      return { tag: 'SFunc', args, result, tpeParams }
    }
    default:
      throw new STypeParseError(
        `invalid type code ${c}`,
        'invalid-type-code'
      )
  }
}
