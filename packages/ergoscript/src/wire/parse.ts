/**
 * Expr wire-format parser — central opcode-dispatch shell.
 *
 * Task 9 lays down the structure: read one opcode byte, switch over every
 * opcode constant from sigma-rust's `op_code.rs`, and route to a handler.
 * Until the per-variant ports land (Tasks 10–26), each handler throws
 * `ExprParseError` with code `not-implemented-yet`.
 *
 * Two distinct error codes are returned from this module:
 *  - `not-implemented-yet` — the opcode is a valid sigma-rust opcode whose
 *    handler hasn't been ported yet. The error message names the variant so
 *    grep-finding the next task is easy.
 *  - `unknown-opcode` — the opcode byte is not in the sigma-rust opcode
 *    table at all (a "future" opcode, garbage, or a malformed proof).
 *
 * Bytes in the inline-constant range (0 through `LAST_CONSTANT_CODE = 112`)
 * are not opcodes — they're SType byte-codes for inline `Constant` values.
 * They are routed to the constant parser, not through this switch. Mirrors
 * sigma-rust `mir/expr.rs::parse_with_tag`:
 *
 *   if tag <= OpCode::LAST_CONSTANT_CODE.value() {
 *       Constant::parse_with_tag(r, tag)
 *   } else {
 *       match OpCode::parse(tag) { … }
 *   }
 *
 * The inline-constant case is also `not-implemented-yet` for now (Task 10
 * will port it; the bytes are handled by a dedicated branch above the
 * opcode-switch so they can be told apart from "real" instructions in error
 * messages).
 */

import type { Expr, SType, SValue } from '../mir/types'
import { ByteReader } from './reader'
import * as OP from '../mir/opcodes'
// Per-variant parsers live in `wire/mir/<variant>.ts`. The centralized error
// type lives in `./errors` (a leaf module) so variant parsers can import it
// without creating a circular import back into this dispatcher. Re-exported
// below for backward compatibility with consumers that imported it from
// `wire/parse`.
import { ExprParseError } from './errors'
import { parseConstFromByte } from './mir/const'
import { parseConstantPlaceholder } from './mir/constant-placeholder'
import { parseBlockValue } from './mir/block-value'
import { parseValDef } from './mir/val-def'
import { parseValUse } from './mir/val-use'
import { parseIf } from './mir/if'
import { parseFuncValue } from './mir/func-value'
import { parseApply } from './mir/apply'
import { parseBinOpFromByte } from './mir/bin-op'
import { parseAnd } from './mir/and'
import { parseOr } from './mir/or'
import { parseXor } from './mir/xor'
import { parseXorOf } from './mir/xor-of'
import { parseAtleast } from './mir/atleast'
import { parseBoolToSigmaProp } from './mir/bool-to-sigma-prop'
import { parseLogicalNot } from './mir/logical-not'
import { parseNegation } from './mir/negation'
import { parseBitInversion } from './mir/bit-inversion'
import { parseUpcast } from './mir/upcast'
import { parseDowncast } from './mir/downcast'
import { parseExtractAmount } from './mir/extract-amount'
import { parseExtractBytes } from './mir/extract-bytes'
import { parseExtractBytesWithNoRef } from './mir/extract-bytes-with-no-ref'
import { parseExtractCreationInfo } from './mir/extract-creation-info'
import { parseExtractId } from './mir/extract-id'
import { parseExtractRegisterAs } from './mir/extract-register-as'
import { parseExtractScriptBytes } from './mir/extract-script-bytes'
import { parseSelectField } from './mir/select-field'
import { buildGlobalVarsFromOpcode } from './mir/global-vars'
import { parseContext } from './mir/context'
import { parseGlobal } from './mir/global'
import { parseGetVar } from './mir/get-var'
import { parseTuple } from './mir/tuple'
import { parseCollection, parseCollectionOfBoolConst } from './mir/collection'
import { parseCollAppend } from './mir/coll-append'
import { parseCollByIndex } from './mir/coll-by-index'
import { parseCollExists } from './mir/coll-exists'
import { parseCollFilter } from './mir/coll-filter'
import { parseCollFold } from './mir/coll-fold'
import { parseCollForall } from './mir/coll-forall'
import { parseCollMap } from './mir/coll-map'
import { parseCollSize } from './mir/coll-size'
import { parseCollSlice } from './mir/coll-slice'
import { parseMethodCall } from './mir/method-call'
import { parsePropertyCall } from './mir/property-call'
import { parseCreateAvlTree } from './mir/create-avl-tree'
import { parseTreeLookup } from './mir/tree-lookup'
import { parseCalcBlake2b256 } from './mir/calc-blake2b256'
import { parseCalcSha256 } from './mir/calc-sha256'
import { parseByteArrayToBigInt } from './mir/byte-array-to-bigint'
import { parseByteArrayToLong } from './mir/byte-array-to-long'
import { parseDecodePoint } from './mir/decode-point'
import { parseLongToByteArray } from './mir/long-to-byte-array'
import { parseExponentiate } from './mir/exponentiate'
import { parseMultiplyGroup } from './mir/multiply-group'
import { parseCreateProveDlog } from './mir/create-prove-dlog'
import { parseCreateProveDhTuple } from './mir/create-prove-dh-tuple'
import { parseSigmaPropBytes } from './mir/sigma-prop-bytes'
import { parseSigmaPropIsProven } from './mir/sigma-prop-is-proven'
import { parseSigmaAnd } from './mir/sigma-and'
import { parseSigmaOr } from './mir/sigma-or'

export { ExprParseError } from './errors'

/**
 * Parse a single Expr node from the reader.
 *
 * `constantTypes` and `constantValues` are the parallel-indexed segregated
 * constant arrays from the surrounding ErgoTree envelope. The
 * {@link OP.OP_CONSTANT_PLACEHOLDER} handler uses `constantTypes` to recover
 * a placeholder's SType from its id; `constantValues` is currently unused
 * (it becomes relevant if/when the interpreter substitutes placeholders
 * with their values at parse time — sigma-rust gates that on a
 * `substitute_placeholders` flag).
 *
 * `valDefTypes` is a shared scope-wide map from `ValId` to `SType`,
 * populated by {@link parseValDef} (when a let-binding is parsed) and read
 * by {@link parseValUse} (which uses the recorded type because ValUse's
 * `tpe` is NOT serialized on the wire — see `wire/mir/val-use.ts`). Mirrors
 * sigma-rust's `SigmaByteReader.val_def_type_store`
 * (`serialization/sigma_byte_reader.rs:16`). The outer envelope
 * (`wire/ergo-tree.ts`) creates a fresh empty map per tree; recursive
 * descent shares the same map across the whole Expr graph.
 */
export function parseExpr(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType> = new Map()
): Expr {
  const opcode = r.readU8()
  return parseExprWithFirstByte(
    opcode,
    r,
    constantTypes,
    constantValues,
    valDefTypes
  )
}

/**
 * Parse a single Expr node when the opcode byte has already been consumed
 * by the caller. Mirrors sigma-rust's `Expr::parse_with_tag` in
 * `serialization/expr.rs:97`.
 *
 * This is exported to support the `BinOp` parser's bool-pair lookahead:
 * after reading a BinOp opcode, the parser peeks the next byte. If it's
 * `OP_COLL_OF_BOOL_CONST` it takes the fast path; otherwise the peeked byte
 * is the first byte of the left operand and must be fed back into the Expr
 * dispatch. Doing that without re-seeking the reader requires accepting a
 * pre-consumed first byte here.
 */
export function parseExprWithFirstByte(
  opcode: number,
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>
): Expr {
  // Inline-constant range: bytes in [0..LAST_CONSTANT_CODE] are SType codes
  // for embedded `Constant` values, not opcodes. Sigma-rust handles these in
  // `Constant::parse_with_tag` (`serialization/expr.rs:88-93`). We route the
  // opcode byte to `parseConstFromByte`, which re-uses it as the first byte
  // of the SType encoding before parsing the SValue payload.
  if (opcode <= OP.LAST_CONSTANT_CODE) {
    return parseConstFromByte(opcode, r)
  }

  // Opcode-based dispatch. Each `case` throws until its per-variant task
  // ports the real parser; the comments name the upcoming task per variant.
  switch (opcode) {
    case OP.OP_VAL_USE:
      return parseValUse(r, valDefTypes)
    case OP.OP_CONSTANT_PLACEHOLDER:
      return parseConstantPlaceholder(r, constantTypes)
    case OP.OP_SUBST_CONSTANTS:
      throw new ExprParseError(
        'SubstConstants opcode not implemented yet (Task 17)',
        'not-implemented-yet'
      )
    case OP.OP_LONG_TO_BYTE_ARRAY:
      return parseLongToByteArray(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_BYTE_ARRAY_TO_BIGINT:
      return parseByteArrayToBigInt(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_BYTE_ARRAY_TO_LONG:
      return parseByteArrayToLong(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_DOWNCAST:
      return parseDowncast(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_UPCAST:
      return parseUpcast(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_GROUP_GENERATOR:
      return buildGlobalVarsFromOpcode(opcode)
    case OP.OP_COLL:
      return parseCollection(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_COLL_OF_BOOL_CONST:
      return parseCollectionOfBoolConst(r)
    case OP.OP_TUPLE:
      return parseTuple(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_SELECT_FIELD:
      return parseSelectField(r, constantTypes, constantValues, valDefTypes)
    // ---- BinOp comparison opcodes (Task 13) ----
    // ~22 wire opcodes collapse onto a single `Expr.tag === 'BinOp'` with the
    // discriminator carried by `op: BinOpKind`. Dispatch is centralized in
    // `parseBinOpFromByte` which maps opcode → kind and handles the bool-pair
    // packing optimization (BinOp over two `Const(SBoolean)` operands is
    // encoded via `OP_COLL_OF_BOOL_CONST` rather than two full Const Exprs;
    // sigma-rust `serialization/bin_op.rs:20-45`).
    case OP.OP_LT:
    case OP.OP_LE:
    case OP.OP_GT:
    case OP.OP_GE:
    case OP.OP_EQ:
    case OP.OP_NEQ:
      return parseBinOpFromByte(
        opcode,
        r,
        constantTypes,
        constantValues,
        valDefTypes
      )
    case OP.OP_IF:
      return parseIf(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_AND:
      return parseAnd(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_OR:
      return parseOr(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_ATLEAST:
      return parseAtleast(r, constantTypes, constantValues, valDefTypes)
    // BinOp arithmetic opcodes (Task 13) — see comment above on shared dispatch.
    case OP.OP_MINUS:
    case OP.OP_PLUS:
    case OP.OP_MULTIPLY:
    case OP.OP_DIVISION:
    case OP.OP_MODULO:
      return parseBinOpFromByte(
        opcode,
        r,
        constantTypes,
        constantValues,
        valDefTypes
      )
    case OP.OP_XOR:
      return parseXor(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXPONENTIATE:
      return parseExponentiate(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_MULTIPLY_GROUP:
      return parseMultiplyGroup(r, constantTypes, constantValues, valDefTypes)
    // BinOp arithmetic opcodes Min/Max (Task 13) — shared dispatch.
    case OP.OP_MIN:
    case OP.OP_MAX:
      return parseBinOpFromByte(
        opcode,
        r,
        constantTypes,
        constantValues,
        valDefTypes
      )
    case OP.OP_HEIGHT:
    case OP.OP_INPUTS:
    case OP.OP_OUTPUTS:
    case OP.OP_SELF_BOX:
    case OP.OP_MINER_PUBKEY:
      // GlobalVars: six unit-variant opcodes that all collapse to a single
      // `Expr.tag === 'GlobalVars'` node with a `kind` discriminator (Task 17).
      // GROUP_GENERATOR (0x82) is dispatched separately above because it lives
      // in a different opcode region. Centralized in `buildGlobalVarsFromOpcode`.
      return buildGlobalVarsFromOpcode(opcode)
    case OP.OP_MAP:
      return parseCollMap(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXISTS:
      return parseCollExists(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_FOR_ALL:
      return parseCollForall(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_FOLD:
      return parseCollFold(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_SIZE_OF:
      return parseCollSize(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_BY_INDEX:
      return parseCollByIndex(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_APPEND:
      return parseCollAppend(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_SLICE:
      return parseCollSlice(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_FILTER:
      return parseCollFilter(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_AVL_TREE:
      return parseCreateAvlTree(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_AVL_TREE_GET:
      return parseTreeLookup(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXTRACT_AMOUNT:
      return parseExtractAmount(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXTRACT_SCRIPT_BYTES:
      return parseExtractScriptBytes(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXTRACT_BYTES:
      return parseExtractBytes(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXTRACT_BYTES_WITH_NO_REF:
      return parseExtractBytesWithNoRef(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXTRACT_ID:
      return parseExtractId(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXTRACT_REGISTER_AS:
      return parseExtractRegisterAs(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_EXTRACT_CREATION_INFO:
      return parseExtractCreationInfo(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_CALC_BLAKE2B256:
      return parseCalcBlake2b256(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_CALC_SHA256:
      return parseCalcSha256(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_PROVE_DLOG:
      return parseCreateProveDlog(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_PROVE_DIFFIE_HELLMAN_TUPLE:
      return parseCreateProveDhTuple(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_SIGMA_PROP_IS_PROVEN:
      return parseSigmaPropIsProven(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_SIGMA_PROP_BYTES:
      return parseSigmaPropBytes(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_BOOL_TO_SIGMA_PROP:
      return parseBoolToSigmaProp(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_DESERIALIZE_CONTEXT:
      throw new ExprParseError(
        'DeserializeContext opcode not implemented yet (Task 26)',
        'not-implemented-yet'
      )
    case OP.OP_DESERIALIZE_REGISTER:
      throw new ExprParseError(
        'DeserializeRegister opcode not implemented yet (Task 26)',
        'not-implemented-yet'
      )
    case OP.OP_VAL_DEF:
      return parseValDef(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_BLOCK_VALUE:
      return parseBlockValue(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_FUNC_VALUE:
      return parseFuncValue(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_APPLY:
      return parseApply(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_PROPERTY_CALL:
      return parsePropertyCall(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_METHOD_CALL:
      return parseMethodCall(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_GLOBAL:
      return parseGlobal()
    case OP.OP_GET_VAR:
      return parseGetVar(r)
    case OP.OP_OPTION_GET:
      throw new ExprParseError(
        'OptionGet opcode not implemented yet (Task 21)',
        'not-implemented-yet'
      )
    case OP.OP_OPTION_GET_OR_ELSE:
      throw new ExprParseError(
        'OptionGetOrElse opcode not implemented yet (Task 21)',
        'not-implemented-yet'
      )
    case OP.OP_OPTION_IS_DEFINED:
      throw new ExprParseError(
        'OptionIsDefined opcode not implemented yet (Task 21)',
        'not-implemented-yet'
      )
    case OP.OP_SIGMA_AND:
      return parseSigmaAnd(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_SIGMA_OR:
      return parseSigmaOr(r, constantTypes, constantValues, valDefTypes)
    // BinOp logical opcodes (Task 13) — shared dispatch.
    case OP.OP_BIN_OR:
    case OP.OP_BIN_AND:
      return parseBinOpFromByte(
        opcode,
        r,
        constantTypes,
        constantValues,
        valDefTypes
      )
    case OP.OP_DECODE_POINT:
      return parseDecodePoint(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_LOGICAL_NOT:
      return parseLogicalNot(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_NEGATION:
      return parseNegation(r, constantTypes, constantValues, valDefTypes)
    case OP.OP_BIT_INVERSION:
      return parseBitInversion(r, constantTypes, constantValues, valDefTypes)
    // BinOp bitwise + remaining logical XOR opcodes (Task 13) — shared dispatch.
    // Note: OP_BIN_XOR (0xf4) is the *logical* XOR (LogicalOp::Xor); OP_BIT_XOR
    // (0xf5) is the *bitwise* XOR (BitOp::BitXor). They occupy adjacent opcode
    // bytes but route to different BinOpKind sub-arms — the discrimination is
    // handled inside `parseBinOpFromByte` via BIN_OP_OPCODE_TO_KIND.
    case OP.OP_BIT_OR:
    case OP.OP_BIT_AND:
    case OP.OP_BIN_XOR:
    case OP.OP_BIT_XOR:
    case OP.OP_BIT_SHIFT_RIGHT:
    case OP.OP_BIT_SHIFT_LEFT:
    case OP.OP_BIT_SHIFT_RIGHT_ZEROED:
      return parseBinOpFromByte(
        opcode,
        r,
        constantTypes,
        constantValues,
        valDefTypes
      )
    case OP.OP_CONTEXT:
      return parseContext()
    case OP.OP_XOR_OF:
      return parseXorOf(r, constantTypes, constantValues, valDefTypes)
    // Named-but-unhandled opcodes — present in sigma-rust's `op_code.rs`
    // table but with no current TS handler. Distinguished from truly
    // unknown bytes (which fall to the `default` arm below) so that the
    // documented taxonomy holds: `not-implemented-yet` means "named in
    // sigma-rust but no TS handler yet"; `unknown-opcode` means "byte
    // not in sigma-rust's table". No Task number — these are rarely used
    // in production trees and don't correspond to a specific later task.
    case OP.OP_TRUE:
      throw new ExprParseError(
        'OpTrue opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_FALSE:
      throw new ExprParseError(
        'OpFalse opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_UNIT_CONSTANT:
      throw new ExprParseError(
        'UnitConstant opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_LAST_BLOCK_UTXO_ROOT_HASH:
      // Sigma-rust does NOT dispatch this opcode as a top-level Expr arm —
      // `Context.LAST_BLOCK_UTXO_ROOT_HASH_PROPERTY` is reached via a
      // PropertyCall on the SContext companion (method id 9, see
      // `types/scontext.rs:136`). We surface it as `not-implemented-yet`
      // pending the property/method-call port; encountering this byte at
      // the top level would be unusual (sigma-rust's serializer never emits
      // it as a top-level opcode either).
      throw new ExprParseError(
        'LastBlockUtxoRootHash opcode not dispatched at top level — reached via PropertyCall on SContext (method id 9) in sigma-rust',
        'not-implemented-yet'
      )
    case OP.OP_SELECT_1:
      throw new ExprParseError(
        'Select1 opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_SELECT_2:
      throw new ExprParseError(
        'Select2 opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_SELECT_3:
      throw new ExprParseError(
        'Select3 opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_SELECT_4:
      throw new ExprParseError(
        'Select4 opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_SELECT_5:
      throw new ExprParseError(
        'Select5 opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_FLAT_MAP:
      throw new ExprParseError(
        'FlatMap opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_FUN_DEF:
      throw new ExprParseError(
        'FunDef opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_SOME_VALUE:
      throw new ExprParseError(
        'SomeValue opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_NONE_VALUE:
      throw new ExprParseError(
        'NoneValue opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_TRIVIAL_PROP_FALSE:
      throw new ExprParseError(
        'TrivialPropFalse opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_TRIVIAL_PROP_TRUE:
      throw new ExprParseError(
        'TrivialPropTrue opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_MOD_Q:
      throw new ExprParseError(
        'ModQ opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_PLUS_MOD_Q:
      throw new ExprParseError(
        'PlusModQ opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_MINUS_MOD_Q:
      throw new ExprParseError(
        'MinusModQ opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_COLL_SHIFT_RIGHT:
      throw new ExprParseError(
        'CollShiftRight opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_COLL_SHIFT_LEFT:
      throw new ExprParseError(
        'CollShiftLeft opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_COLL_SHIFT_RIGHT_ZEROED:
      throw new ExprParseError(
        'CollShiftRightZeroed opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_COLL_ROTATE_LEFT:
      throw new ExprParseError(
        'CollRotateLeft opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    case OP.OP_COLL_ROTATE_RIGHT:
      throw new ExprParseError(
        'CollRotateRight opcode not implemented (deferred — rarely used in production trees)',
        'not-implemented-yet'
      )
    default:
      throw new ExprParseError(
        `Unknown opcode 0x${opcode.toString(16).padStart(2, '0')}`,
        'unknown-opcode'
      )
  }
}
