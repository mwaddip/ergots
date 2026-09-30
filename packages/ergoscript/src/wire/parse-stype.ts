/**
 * SType wire-format parser: the JVM's `TypeSerializer.deserialize` (sigma-state 6.0.6,
 * core/shared/src/main/scala/sigma/serialization/TypeSerializer.scala:130-243), under the tree version in
 * force at the read.
 *
 * Encoding model (`MaxPrimTypeCode = 11`, so `PrimRange = 12`):
 * - Primitives: codes 1..8, and SUnsignedBigInt (9) from tree v3.
 * - Container short-forms for c < 96 (TUPLE_TYPECODE): split into
 *   `containerId = (c / 12) * 12` and `primId = c % 12`. `containerId`
 *   selects Coll / Nested-Coll / Option / Option-Coll / Pair1 / Pair2 /
 *   PairSymmetric; `primId == 0` means "recursively parse next SType",
 *   `primId > 0` means "embedded primitive type at that primId".
 * - Non-embeddable primitives + Tuple + STypeVar + SFunc occupy bytes
 *   ≥ TUPLE_TYPECODE (96).
 *
 * The version decides two checks, by `isV3OrLaterErgoTreeVersion` (tree version 3 or later,
 * `VersionContext.scala:29`), each a `ValidationException` that a size-flagged tree degrades on (spec
 * docs/specs/2026-09-30-jvm-node-construction-design.md §4a; facts/ergoscript-wire.md, "Type reads"):
 * - rule 1017 `CheckPrimitiveTypeCodeV6` (1007 before 6.0 activation, the same check), for a primitive id
 *   outside the embeddable table, which holds ids 1-8 below v3 and 1-9 from v3 (`:16-25, 257-267`):
 *   `'type-code-primitive-unknown'`;
 * - rule 1018 `CheckTypeCodeV6` (1008 before activation), for a code the match does not take: 107-111,
 *   113-255, and SFunc's 112 below v3 (`:187-233`): `'type-code-unknown'`.
 * The version is the caller's: a tree's header version for its own constants and body, the enclosing
 * tree's for a nested box's registers, the spent tree's for a decoded script or a SubstConstants template,
 * and 3 at the top level (the ergo node's since 6.0).
 */

import type { SType, STypeVar } from '../mir/types'
import { SANY_JVM } from '../mir/types'
import { ByteReader } from '@ergots/scorex'
import { decodeUtf8Lossy } from './_utf8'

const PRIM_RANGE = 12 // MaxPrimTypeCode (11) + 1

const COLL_CONSTR_ID = 1
const NESTED_COLL_CONSTR_ID = 2
const OPTION_CONSTR_ID = 3
const OPTION_COLL_CONSTR_ID = 4
const TUPLE_PAIR1_CONSTR_ID = 5
const TUPLE_PAIR2_CONSTR_ID = 6

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
 * The JVM's `getEmbeddableType(id)` (TypeSerializer.scala:16-25): rule 1017 `CheckPrimitiveTypeCodeV6`
 * checks `id <= 0 || id >= embeddableIdToType.length` (core/.../sigma/validation/ValidationRules.scala:80-98),
 * against a table of 9 entries below tree v3 and 10 from v3, where id 9 is UnsignedBigInt
 * (TypeSerializer.scala:257-267). Called with an id of 1..11, the primitive code itself or a container's
 * embedded id, before any later byte of the same type is read.
 */
function embeddablePrimitive(primId: number, treeVersion: number): SType {
  switch (primId) {
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
      if (treeVersion >= 3) return { tag: 'SUnsignedBigInt' }
      break
  }
  throw new STypeParseError(
    `primitive type id ${primId} is not in the embeddable table at tree version ${treeVersion} (rule 1017)`,
    'type-code-primitive-unknown'
  )
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
 * Parse an SType from `r`, as the JVM reads it under `treeVersion` (required: the version in force at the
 * read site, see the module header). Throws {@link STypeParseError} on an encoding the JVM rejects or
 * soft-fails.
 */
export function parseSType(r: ByteReader, treeVersion: number): SType {
  const c = r.readU8()
  return parseSTypeWithFirstByte(c, r, treeVersion)
}

/**
 * Parse an SType when the first byte (`c`) has already been consumed from a
 * surrounding stream — for example, by the {@link parseExpr} dispatch byte
 * for inline `Const` nodes (where the SType's first byte doubles as the
 * "opcode" the dispatcher reads). Returns the same result as `parseSType`
 * given the same logical input bytes and version.
 */
export function parseSTypeWithFirstByte(c: number, r: ByteReader, treeVersion: number): SType {
  if (c === 0) {
    // TypeSerializer.deserialize (:133-135): InvalidTypePrefix, hard. Its message evaluates
    // r.getBytes(r.remaining), a checked read, so past the window the window error (rule 1014) wins.
    r.readBytes(0)
    throw new STypeParseError(`type prefix 0 (InvalidTypePrefix)`, 'type-prefix-invalid')
  }
  if (c < TUPLE_TYPECODE) {
    return parseContainerOrPrimitive(r, c, treeVersion)
  }
  return parseHighTypeCode(r, c, treeVersion)
}

function parseContainerOrPrimitive(r: ByteReader, c: number, treeVersion: number): SType {
  const containerId = Math.floor(c / PRIM_RANGE)
  const primId = c % PRIM_RANGE
  switch (containerId) {
    case 0:
      // A primitive code, 1..11 (TypeSerializer.scala:140-141).
      return embeddablePrimitive(c, treeVersion)
    case COLL_CONSTR_ID:
      return { tag: 'SColl', elem: readArgType(r, primId, treeVersion) }
    case NESTED_COLL_CONSTR_ID:
      return {
        tag: 'SColl',
        elem: { tag: 'SColl', elem: readArgType(r, primId, treeVersion) }
      }
    case OPTION_CONSTR_ID:
      return { tag: 'SOption', elem: readArgType(r, primId, treeVersion) }
    case OPTION_COLL_CONSTR_ID:
      return {
        tag: 'SOption',
        elem: { tag: 'SColl', elem: readArgType(r, primId, treeVersion) }
      }
    case TUPLE_PAIR1_CONSTR_ID: {
      // Pair1 (:154-162): (t1, t2), t1 the embedded primitive, checked before t2 is read, or, for
      // primId 0, read first.
      const t1 = readArgType(r, primId, treeVersion)
      const t2 = parseSType(r, treeVersion)
      return { tag: 'STuple', items: [t1, t2] }
    }
    case TUPLE_PAIR2_CONSTR_ID: {
      // Pair2 (:163-173): if primId==0, this is a TRIPLE (t1,t2,t3); else (t1,t2) where t2 is the
      // embedded primitive, checked before t1 is read next in the stream.
      if (primId === 0) {
        const t1 = parseSType(r, treeVersion)
        const t2 = parseSType(r, treeVersion)
        const t3 = parseSType(r, treeVersion)
        return { tag: 'STuple', items: [t1, t2, t3] }
      }
      const t2 = embeddablePrimitive(primId, treeVersion)
      const t1 = parseSType(r, treeVersion)
      return { tag: 'STuple', items: [t1, t2] }
    }
    default: {
      // PairSymmetric, containerId 7 (c < 96; :174-183): if primId==0, this is a QUADRUPLE (t1..t4);
      // else (t,t) where t is the embedded primitive.
      if (primId === 0) {
        const t1 = parseSType(r, treeVersion)
        const t2 = parseSType(r, treeVersion)
        const t3 = parseSType(r, treeVersion)
        const t4 = parseSType(r, treeVersion)
        return { tag: 'STuple', items: [t1, t2, t3, t4] }
      }
      const t = embeddablePrimitive(primId, treeVersion)
      return { tag: 'STuple', items: [t, t] }
    }
  }
}

/**
 * For container-with-primId encoding (`getArgType`, TypeSerializer.scala:239-243): `primId == 0` means the
 * next SType is encoded recursively in the stream; `primId > 0` means the type is the embedded primitive at
 * that id.
 */
function readArgType(r: ByteReader, primId: number, treeVersion: number): SType {
  if (primId === 0) {
    return parseSType(r, treeVersion)
  }
  return embeddablePrimitive(primId, treeVersion)
}

function parseHighTypeCode(r: ByteReader, c: number, treeVersion: number): SType {
  switch (c) {
    case TUPLE_TYPECODE: {
      // Tuple with explicit length (the 5+-item wire form; 2..4 normally use
      // the pair/triple/quadruple codes). JVM TypeSerializer.scala:188-194:
      // getUByte + bare STuple(items) — NO arity require, so arity-0/1
      // generic-tuple TYPES parse (the TYPE serializer rejects < 2,
      // TypeSerializer.scala:93-94 sys.error; our serialize-stype
      // 'tuple-too-short' mirrors it — an asymmetry the JVM itself has).
      // The old [2,255] reject was sigma-rust STuple::try_from semantics —
      // a JVM over-reject fork on 0/1.
      const len = r.readU8()
      const items: SType[] = []
      for (let i = 0; i < len; i++) {
        items.push(parseSType(r, treeVersion))
      }
      return { tag: 'STuple', items }
    }
    case TYPE_CODE_SANY:
      // The JVM's SAny object (TypeSerializer.scala:196): rule 1001 tells it by identity from
      // ergots' own SAny, a fresh object its method typing makes (mir/types.ts).
      return SANY_JVM
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
      // STypeVar: u8 name length + UTF-8 bytes. JVM TypeSerializer.deserialize:203
      // reads `nameLength = r.getUByte()` (unsigned 0..255) with NO bound, then
      // `STypeVar(new String(getBytes(nameLength)))` — so nameLen 0 yields STypeVar("")
      // and 255 is accepted. The old [1,254] reject mirrored sigma-rust's BoundedVec
      // and was a JVM fork in both directions (over-rejecting 0 and 255). Truncation
      // (fewer than nameLen bytes remaining) is still caught by readBytes.
      const nameLen = r.readU8()
      const bytes = r.readBytes(nameLen)
      // JVM-faithful lossy decode: TypeSerializer.deserialize reads the name as
      // `new String(bytes, UTF_8)` (TypeSerializer.scala:204), which NEVER throws —
      // ill-formed bytes lossy-decode to U+FFFD with Java's malformed-length counts
      // (NOT WHATWG/Rust `from_utf8_lossy`, which over-counts the surrogate case;
      // see `decodeUtf8Lossy` + the SANTA STypeVar.name_utf8_roundtrip vector).
      const name = decodeUtf8Lossy(bytes)
      return { tag: 'STypeVar', name }
    }
    case TYPE_CODE_SHEADER:
      return { tag: 'SHeader' }
    case TYPE_CODE_SPRE_HEADER:
      return { tag: 'SPreHeader' }
    case TYPE_CODE_SGLOBAL:
      return { tag: 'SGlobal' }
    case TYPE_CODE_SFUNC: {
      // SFunc, from tree v3 only (TypeSerializer.scala:211-224); below v3 code 112 is no type and falls
      // to rule 1018 below. u8 t_dom_len + t_dom items + t_range + u8 tpe_params_len + tpe_params, each
      // of which must be an STypeVar (the `require`, :221: an IllegalArgumentException, hard).
      if (treeVersion < 3) break
      const tDomLen = r.readU8()
      const args: SType[] = []
      for (let i = 0; i < tDomLen; i++) {
        args.push(parseSType(r, treeVersion))
      }
      const result = parseSType(r, treeVersion)
      const tpeParamsLen = r.readU8()
      const tpeParams: STypeVar[] = []
      for (let i = 0; i < tpeParamsLen; i++) {
        const tpe = parseSType(r, treeVersion)
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
  }
  // Rule 1018 CheckTypeCodeV6 (TypeSerializer.scala:225-233; core/.../sigma/validation/
  // ValidationRules.scala:100-118): every code that reaches here is above SGlobal's 106, so the rule
  // always fails, and the JVM's `NoType` after it is never returned.
  throw new STypeParseError(
    `type code ${c} is no type at tree version ${treeVersion} (rule 1018)`,
    'type-code-unknown'
  )
}
