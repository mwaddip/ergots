/**
 * Opcode byte constants for the ErgoTree MIR wire format.
 *
 * All values are copied verbatim from sigma-rust's
 * `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/serialization/op_code.rs`.
 *
 * The original `op_code.rs` derives opcode values as
 * `OpCode(LAST_CONSTANT_CODE + shift)` where `LAST_CONSTANT_CODE = 112` and
 * `shift` is the named offset. Values here are precomputed (`112 + shift`)
 * for grep-ability and so that the byte values appear directly at the call
 * site, with no indirection.
 *
 * Bytes in the range `[FIRST_DATA_TYPE..LAST_CONSTANT_CODE]` (1..=112) are
 * "inline constant" type-codes — handled by the constant-parser, NOT by the
 * opcode dispatch. See sigma-rust `mir/expr.rs::parse_with_tag`:
 *
 *   if tag <= OpCode::LAST_CONSTANT_CODE.value() {
 *       Constant::parse_with_tag(r, tag)
 *   } else {
 *       match OpCode::parse(tag) { … }
 *   }
 *
 * Byte `0x00` (`OP_CONSTANT`) is also handled by the constant-parser branch.
 * It is included here only for documentation of the wire layout boundary.
 */

// ---------------------------------------------------------------------------
// Constant range markers (sigma-rust `op_code.rs::FIRST_DATA_TYPE` etc.).
//
// Bytes in [FIRST_DATA_TYPE..LAST_CONSTANT_CODE] are SType byte-codes for
// inline `Constant` values; the opcode-dispatch switch only handles bytes
// strictly greater than LAST_CONSTANT_CODE.
// ---------------------------------------------------------------------------

/** First byte value that is a (real) SType code for inline constants. */
export const FIRST_DATA_TYPE = 1

/** Last byte value that is an SType code. (= sigma-rust LAST_DATA_TYPE.) */
export const LAST_DATA_TYPE = 111

/**
 * Last byte value belonging to the "inline constant" range. sigma-rust:
 * `LAST_CONSTANT_CODE = LAST_DATA_TYPE + 1 = 112` — reserved as the marker
 * for functional constants (we don't synthesize this byte but tolerate it
 * in the inline-constant branch for parity).
 */
export const LAST_CONSTANT_CODE = 112

/** Opcode byte for inline constant: handled by the constant-parser, not the
 * opcode dispatch. */
export const OP_CONSTANT = 0x00

// ---------------------------------------------------------------------------
// Real instruction opcodes. Bytes are `LAST_CONSTANT_CODE + shift` from
// sigma-rust `op_code.rs::new_op_code(shift)`. Comments preserve the named
// constants for cross-referencing.
// ---------------------------------------------------------------------------

// shift 2:  VAL_USE
export const OP_VAL_USE = 0x72 // 114

// shift 3:  CONSTANT_PLACEHOLDER
export const OP_CONSTANT_PLACEHOLDER = 0x73 // 115

// shift 4:  SUBST_CONSTANTS  (5..9 reserved)
export const OP_SUBST_CONSTANTS = 0x74 // 116

// shift 10: LONG_TO_BYTE_ARRAY
export const OP_LONG_TO_BYTE_ARRAY = 0x7a // 122

// shift 11: BYTE_ARRAY_TO_BIGINT
export const OP_BYTE_ARRAY_TO_BIGINT = 0x7b // 123

// shift 12: BYTE_ARRAY_TO_LONG
export const OP_BYTE_ARRAY_TO_LONG = 0x7c // 124

// shift 13: DOWNCAST
export const OP_DOWNCAST = 0x7d // 125

// shift 14: UPCAST
export const OP_UPCAST = 0x7e // 126

// shift 15: TRUE  (parsed as inline boolean Const)
export const OP_TRUE = 0x7f // 127

// shift 16: FALSE (parsed as inline boolean Const)
export const OP_FALSE = 0x80 // 128

// shift 17: UNIT_CONSTANT
export const OP_UNIT_CONSTANT = 0x81 // 129

// shift 18: GROUP_GENERATOR  (a GlobalVars variant)
export const OP_GROUP_GENERATOR = 0x82 // 130

// shift 19: COLL  (Collection::Exprs)  (20 reserved)
export const OP_COLL = 0x83 // 131

// shift 21: COLL_OF_BOOL_CONST  (Collection::BoolConstants)
export const OP_COLL_OF_BOOL_CONST = 0x85 // 133

// shift 22: TUPLE
export const OP_TUPLE = 0x86 // 134

// shifts 23..27: SELECT_1 .. SELECT_5  (specialized tuple-field accessors,
// not emitted by sigma-rust's serializer in modern paths but reserved)
export const OP_SELECT_1 = 0x87 // 135
export const OP_SELECT_2 = 0x88 // 136
export const OP_SELECT_3 = 0x89 // 137
export const OP_SELECT_4 = 0x8a // 138
export const OP_SELECT_5 = 0x8b // 139

// shift 28: SELECT_FIELD
export const OP_SELECT_FIELD = 0x8c // 140

// Relation ops (shifts 31..36)
export const OP_LT = 0x8f // 143
export const OP_LE = 0x90 // 144
export const OP_GT = 0x91 // 145
export const OP_GE = 0x92 // 146
export const OP_EQ = 0x93 // 147
export const OP_NEQ = 0x94 // 148

// shift 37: IF
export const OP_IF = 0x95 // 149

// shift 38: AND
export const OP_AND = 0x96 // 150

// shift 39: OR
export const OP_OR = 0x97 // 151

// shift 40: ATLEAST
export const OP_ATLEAST = 0x98 // 152

// Arithmetic codes (shifts 41..50)
export const OP_MINUS = 0x99 // 153
export const OP_PLUS = 0x9a // 154
export const OP_XOR = 0x9b // 155
export const OP_MULTIPLY = 0x9c // 156
export const OP_DIVISION = 0x9d // 157
export const OP_MODULO = 0x9e // 158
export const OP_EXPONENTIATE = 0x9f // 159
export const OP_MULTIPLY_GROUP = 0xa0 // 160
export const OP_MIN = 0xa1 // 161
export const OP_MAX = 0xa2 // 162

// Environment / context (shifts 51..55, 56..59 reserved, 60)
export const OP_HEIGHT = 0xa3 // 163
export const OP_INPUTS = 0xa4 // 164
export const OP_OUTPUTS = 0xa5 // 165
export const OP_LAST_BLOCK_UTXO_ROOT_HASH = 0xa6 // 166
export const OP_SELF_BOX = 0xa7 // 167
export const OP_MINER_PUBKEY = 0xac // 172

// Collection and tree ops (shifts 61..72; 73..80 reserved)
export const OP_MAP = 0xad // 173
export const OP_EXISTS = 0xae // 174
export const OP_FOR_ALL = 0xaf // 175
export const OP_FOLD = 0xb0 // 176
export const OP_SIZE_OF = 0xb1 // 177
export const OP_BY_INDEX = 0xb2 // 178
export const OP_APPEND = 0xb3 // 179
export const OP_SLICE = 0xb4 // 180
export const OP_FILTER = 0xb5 // 181
export const OP_AVL_TREE = 0xb6 // 182
export const OP_AVL_TREE_GET = 0xb7 // 183  (sigma-rust: AVT_TREE_GET typo preserved as AVL_TREE_GET here for readability — wire byte is the same)
export const OP_FLAT_MAP = 0xb8 // 184

// Type casts (shifts 81..87; 88..90 reserved)
export const OP_EXTRACT_AMOUNT = 0xc1 // 193
export const OP_EXTRACT_SCRIPT_BYTES = 0xc2 // 194
export const OP_EXTRACT_BYTES = 0xc3 // 195
export const OP_EXTRACT_BYTES_WITH_NO_REF = 0xc4 // 196
export const OP_EXTRACT_ID = 0xc5 // 197
export const OP_EXTRACT_REGISTER_AS = 0xc6 // 198
export const OP_EXTRACT_CREATION_INFO = 0xc7 // 199

// Cryptographic operations (shifts 91..99)
export const OP_CALC_BLAKE2B256 = 0xcb // 203
export const OP_CALC_SHA256 = 0xcc // 204
export const OP_PROVE_DLOG = 0xcd // 205
export const OP_PROVE_DIFFIE_HELLMAN_TUPLE = 0xce // 206
export const OP_SIGMA_PROP_IS_PROVEN = 0xcf // 207
export const OP_SIGMA_PROP_BYTES = 0xd0 // 208
export const OP_BOOL_TO_SIGMA_PROP = 0xd1 // 209
export const OP_TRIVIAL_PROP_FALSE = 0xd2 // 210
export const OP_TRIVIAL_PROP_TRUE = 0xd3 // 211

// Deserialization, blocks, calls (shifts 100..109)
export const OP_DESERIALIZE_CONTEXT = 0xd4 // 212
export const OP_DESERIALIZE_REGISTER = 0xd5 // 213
export const OP_VAL_DEF = 0xd6 // 214
export const OP_FUN_DEF = 0xd7 // 215  (FUN_DEF; v6 P6: a polymorphic ValDef carrying tpeArgs)
export const OP_BLOCK_VALUE = 0xd8 // 216
export const OP_FUNC_VALUE = 0xd9 // 217
export const OP_APPLY = 0xda // 218
export const OP_PROPERTY_CALL = 0xdb // 219
export const OP_METHOD_CALL = 0xdc // 220
export const OP_GLOBAL = 0xdd // 221

// Option (shifts 110..118; 113..114 reserved)
export const OP_SOME_VALUE = 0xde // 222
export const OP_NONE_VALUE = 0xdf // 223
export const OP_GET_VAR = 0xe3 // 227
export const OP_OPTION_GET = 0xe4 // 228
export const OP_OPTION_GET_OR_ELSE = 0xe5 // 229
export const OP_OPTION_IS_DEFINED = 0xe6 // 230

// Modular arithmetic (shifts 119..121)
export const OP_MOD_Q = 0xe7 // 231
export const OP_PLUS_MOD_Q = 0xe8 // 232
export const OP_MINUS_MOD_Q = 0xe9 // 233

// Sigma conjunctions, binary boolean ops (shifts 122..125)
export const OP_SIGMA_AND = 0xea // 234
export const OP_SIGMA_OR = 0xeb // 235
export const OP_BIN_OR = 0xec // 236
export const OP_BIN_AND = 0xed // 237

// shift 126: DECODE_POINT
export const OP_DECODE_POINT = 0xee // 238

// shifts 127..131: LogicalNot, Negation, BitInversion, BitOr, BitAnd
export const OP_LOGICAL_NOT = 0xef // 239
export const OP_NEGATION = 0xf0 // 240
export const OP_BIT_INVERSION = 0xf1 // 241
export const OP_BIT_OR = 0xf2 // 242
export const OP_BIT_AND = 0xf3 // 243

// shift 132: BIN_XOR
export const OP_BIN_XOR = 0xf4 // 244

// shifts 133..136: BitXor, BitShiftRight, BitShiftLeft, BitShiftRightZeroed
export const OP_BIT_XOR = 0xf5 // 245
export const OP_BIT_SHIFT_RIGHT = 0xf6 // 246
export const OP_BIT_SHIFT_LEFT = 0xf7 // 247
export const OP_BIT_SHIFT_RIGHT_ZEROED = 0xf8 // 248

// shifts 137..141: COLL_SHIFT_RIGHT, COLL_SHIFT_LEFT, COLL_SHIFT_RIGHT_ZEROED,
// COLL_ROTATE_LEFT, COLL_ROTATE_RIGHT (reserved; no current Expr variant)
export const OP_COLL_SHIFT_RIGHT = 0xf9 // 249
export const OP_COLL_SHIFT_LEFT = 0xfa // 250
export const OP_COLL_SHIFT_RIGHT_ZEROED = 0xfb // 251
export const OP_COLL_ROTATE_LEFT = 0xfc // 252
export const OP_COLL_ROTATE_RIGHT = 0xfd // 253

// shift 142: CONTEXT
export const OP_CONTEXT = 0xfe // 254

// shift 143: XOR_OF (= 255, max u8)
export const OP_XOR_OF = 0xff // 255
