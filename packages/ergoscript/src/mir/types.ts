/**
 * Type-system MIR nodes for ErgoScript / ErgoTree.
 *
 * `SType` is a discriminated union over the closed set of ErgoScript types.
 * Every {@link Expr} node carries one; every {@link SValue} (added in Task 6)
 * is typed by one (recoverable from `kind` for primitives, explicit for
 * composites such as `Coll` and `Option`).
 *
 * Variant set mirrors sigma-rust's `ergotree-ir/src/types/stype.rs` (less
 * `SUnsignedBigInt`, which is a v6-only type that the reference verifier
 * rejects via `check_v6_type`). See
 * `docs/specs/2026-05-13-ergoscript-interpreter-design.md` for the
 * discriminated-union rationale.
 */

import type { Header } from '@ergots/scorex'
import type { Env } from '../eval/env'

/** Type variable for generic signatures (e.g. `"T"`, `"IV"`, `"OV"`). */
export interface STypeVar {
  name: string
}

/**
 * Closed set of ErgoScript types. Primitive variants carry only `tag`;
 * composite variants (`SColl`, `STuple`, `SOption`, `SFunc`, `STypeVar`)
 * carry recursive payload.
 *
 * Acyclic by construction: no variant can transitively contain a reference
 * back to itself (the union is built from below).
 */
export type SType =
  | { tag: 'SBoolean' }
  | { tag: 'SByte' }
  | { tag: 'SShort' }
  | { tag: 'SInt' }
  | { tag: 'SLong' }
  | { tag: 'SBigInt' }
  | { tag: 'SUnsignedBigInt' }
  | { tag: 'SGroupElement' }
  | { tag: 'SSigmaProp' }
  | { tag: 'SBox' }
  | { tag: 'SAvlTree' }
  | { tag: 'SUnit' }
  | { tag: 'SAny' }
  | { tag: 'SHeader' }
  | { tag: 'SPreHeader' }
  | { tag: 'SContext' }
  | { tag: 'SGlobal' }
  | { tag: 'SString' }
  | { tag: 'SColl'; elem: SType }
  | { tag: 'STuple'; items: SType[] }
  | { tag: 'SOption'; elem: SType }
  | { tag: 'SFunc'; args: SType[]; result: SType; tpeParams: STypeVar[] }
  | { tag: 'STypeVar'; name: string }

// ---------------------------------------------------------------------------
// Composite-type stubs (filled in later phases).
//
// These are forward declarations so the `SValue` discriminated union below
// can compile in phase 2a. Full shapes — parsing, validation, additional
// fields — come in the package phases that need them.
// ---------------------------------------------------------------------------

/**
 * Stub: on-chain box. Mirrors sigma-rust `ergotree-ir/src/chain/ergo_box.rs`
 * `ErgoBox` fields. ErgoTree is held as raw bytes here (deferred parse — the
 * interpreter `parseTree` lives in a later phase).
 */
export interface ErgoBox {
  /** nanoErg value (Rust `BoxValue`, a u64 wrapper). */
  value: bigint
  /** Guarding script as raw bytes; parse with `parseTree` if needed. */
  ergoTreeBytes: Uint8Array
  /**
   * Non-mandatory registers R4..R9. Sparse: a missing register key yields
   * `undefined`. Each entry carries the per-register `SType` alongside the
   * `SValue`, matching sigma-rust's `NonMandatoryRegisters` which stores
   * `Constant<'static>` (i.e. `{ tpe: SType, v: Value }`). Required by
   * `ExtractRegisterAs`'s type-assertion: without the stored `tpe`, the type
   * cannot be reliably recovered for edge cases (empty `Coll`, `None`
   * `Option`) where the `SValue.kind` alone is ambiguous.
   *
   * `opaqueBytes` is set when the register was originally serialized as a
   * Tuple Expr (OP_TUPLE = 0x86 = 134) on the wire rather than as a plain
   * Constant. Sigma-rust's `RegisterValue` has two parsed variants:
   * `Parsed(Constant)` (vast majority) and `ParsedTupleExpr(EvaluatedTuple)`
   * (rare — the boxes use a Tuple Expr whose items are themselves Constants
   * or nested Tuples). For byte-roundtrip parity, when a register parses as
   * a Tuple Expr we (a) convert it into the equivalent STuple/Tup Constant
   * for runtime consumption, and (b) preserve the original wire bytes here
   * so the serializer can emit the Tuple-Expr form (NOT the STuple-Constant
   * form, which uses a different SType byte and value layout).
   */
  registers: Record<
    number,
    { tpe: SType; value: SValue; opaqueBytes?: Uint8Array } | undefined
  >
  /** Secondary tokens (id is 32-byte token-id, amount is u64 packed as bigint). */
  tokens: { id: Uint8Array; amount: bigint }[]
  /** Block height at which the box was created (Rust `u32`). */
  creationHeight: number
  /** 32-byte transaction id that produced this box. */
  txId: Uint8Array
  /** Index of this box in the producing transaction's outputs (Rust `u16`). */
  index: number
  /**
   * Serialized box bytes retained by byte-ingress parsers (the SBox SValue
   * data arm). JVM analog: ErgoBox._bytes — the parser hands the consumed
   * slice to the constructor (ErgoBox.scala:214-226); in-memory-constructed
   * boxes fall back to canonical re-serialization (:87-92). Box equality is
   * id-basis over these bytes (eval/_box-id.ts).
   */
  retainedBytes?: Uint8Array
}

/**
 * Runtime shape of an AVL+ tree value. Mirrors sigma-rust
 * `ergotree-ir/src/mir/avl_tree_data.rs:60-69` `AvlTreeData`.
 *
 * `digest` is the JVM/Rust `ADDigest` = `Digest<33>` — 32 bytes of root hash
 * concatenated with 1 byte of tree height (33 bytes total).
 *
 * `treeFlags` is the serialized `AvlTreeFlags` byte (`avl_tree_data.rs:16-25`):
 *   bit 0 (0x01): insertAllowed
 *   bit 1 (0x02): updateAllowed
 *   bit 2 (0x04): removeAllowed
 *   bits 3-7: reserved (must round-trip identically).
 *
 * Stable since phase 2h-b — promoted from forward-declaration when
 * `parseSValue(SAvlTree, …)` / `serializeSValue(SAvlTree, …)` shipped.
 */
export interface AvlTreeData {
  /** Root hash (32 bytes) + tree-height byte = exactly 33 bytes. */
  digest: Uint8Array
  /** Enabled-operations bitfield (u8). */
  treeFlags: number
  /** Common key length (Rust `u32`; `>= 0`, VLQ-encoded on the wire). */
  keyLength: number
  /** If non-null, all values share this length (Rust `Option<Box<u32>>`). */
  valueLengthOpt: number | null
}

/**
 * Structural sigma-protocol proposition tree (phase 2g-medium).
 *
 * Flattens sigma-rust's 3-variant `SigmaBoolean` enum
 * (`TrivialProp` / `ProofOfKnowledge` / `SigmaConjecture`) to the 6
 * concrete leaves. Wire format (opcode dispatch) lives in
 * `wire/sigma-boolean.ts`; the runtime verifier (phase 2g-medium leaf-only,
 * 2g-combinators full) walks this tree.
 *
 * Source: ergotree-ir/src/sigma_protocol/sigma_boolean.rs:168-175
 */
export type SigmaBoolean =
  | { tag: 'TrivialProp'; value: boolean }
  | { tag: 'ProveDlog'; h: Uint8Array }                                       // 33-byte SEC1 compressed (or 33 zeros = identity, Ergo convention)
  | { tag: 'ProveDhTuple'; g: Uint8Array; h: Uint8Array; u: Uint8Array; v: Uint8Array }
  | { tag: 'Cand'; items: SigmaBoolean[] }                                    // items.length >= 1
  | { tag: 'Cor'; items: SigmaBoolean[] }                                     // items.length >= 1
  | { tag: 'Cthreshold'; k: number; items: SigmaBoolean[] }                  // k in [1, items.length]

/**
 * User-function (lambda) runtime representation.
 *
 * Captures argument ids (matching the body's `ValUse.id` references), the body
 * expression, and the **lexical environment captured at function-definition
 * time** (`capturedEnv`). The body is evaluated in `capturedEnv` extended with
 * the per-call argument bindings — i.e. lexical scoping (closures), matching
 * the JVM (canonical for v6). A returned closure that references a free
 * variable still resolves it from the env in scope where the lambda was
 * *defined*, not where it is *applied* (e.g. `{ val add = (a:Int)=>(b:Int)=>a+b;
 * add(3)(1) }` evaluates to `Int 4`).
 *
 * Mirrors sigma-rust `Lambda { args: Vec<FuncArg>, body: Box<Expr> }` from
 * `ergotree-ir/src/mir/value.rs`, plus an explicit `capturedEnv` (which the
 * JVM closes over at definition; our immutable `Env` makes the capture
 * explicit and value-stable).
 */
export interface Closure {
  /** Argument value ids; binds `ValUse.id` references inside `body`. */
  argIds: number[]
  /**
   * Declared argument types, parallel to {@link argIds} (`argTpes[i]` is the
   * static type of the arg bound to `argIds[i]`). Carried so the apply-time
   * type-var reject (v6 P6) can fire: the JVM (sigma-state 6.0.3, canonical
   * for v6) rejects at eval when a lambda whose arg type is (or contains) an
   * unresolved `STypeVar` is APPLIED — resolving that arg's runtime RType
   * fails (`RuntimeException: Unknown type T`). See `assertArgTypeResolved`
   * in `eval/_lambda.ts` and SANTA `HOF_FunDef_type_var_body.json`.
   *
   * (This field was previously omitted by design; v6 P6 needs it for the
   * type-var-apply reject. It also now backs the lambda-HOF elem-type checks,
   * which previously fell back to the MIR-node FuncValue's declared arg type
   * — see `facts/ergoscript-eval.md` Phase 2h-f changelog R3(a).)
   */
  argTpes: SType[]
  /** Function body — an Expr. */
  body: Expr
  /**
   * Lexical environment captured at definition time (immutable; v6
   * JVM-faithful). The body is evaluated in this env extended with the
   * per-call arg bindings — NOT in the caller's apply-site env.
   */
  capturedEnv: Env
}

/**
 * Stub: pre-header of current block. Mirrors sigma-rust
 * `ergo-chain-types/preheader.rs::PreHeader`. Phase 2f medium consumes
 * only `minerPk` (via `GlobalVars.MinerPubKey`). Other fields are
 * present for forward-compat with phase 2g+ method-call arms.
 */
export interface PreHeader {
  /** Block version, u8 (currently 0..7). */
  version: number
  /** 32-byte parent block id. */
  parentId: Uint8Array
  /** Timestamp in ms since epoch (u64; stored as bigint for precision). */
  timestamp: bigint
  /** Difficulty target in Bitcoin-compact form (u32). */
  nBits: number
  /** Block height (u32). */
  height: number
  /** 33-byte compressed secp256k1 public key of the miner. */
  minerPk: Uint8Array
  /** 3-byte block votes (sigma-rust `Votes`). */
  votes: Uint8Array
}

/**
 * Stub: context extension key-value map. Mirrors sigma-rust
 * `chain/context_extension.rs::ContextExtension`. Phase 2f medium
 * consumes only `values` (via `GetVar`). Each entry carries both the
 * declared SType and the runtime SValue — same shape as
 * `ErgoBox.registers` (from phase 2f narrow).
 * Keys are the UNSIGNED wire byte (0-255); ingestion from signed JSON
 * renderings (the JVM sdk codec emits "-1" for wire 0xFF) must normalize
 * to unsigned.
 */
export interface ContextExtension {
  values: Record<number, { tpe: SType; value: SValue } | undefined>
}

// ---------------------------------------------------------------------------
// MIR expression discriminated union.
//
// Mirrors sigma-rust's `Expr` enum in `ergotree-ir/src/mir/expr.rs`. Each
// variant is a discriminated interface keyed by `tag`. Per-variant shapes
// follow sigma-rust's `mir/<variant>.rs` struct fields (renamed snake_case →
// camelCase, `Box<Expr>` → `Expr`, `Option<X>` → `X | null`, `Vec<X>` → `X[]`,
// `u8`/`u16`/`u32` → `number`, `u64` → `bigint`).
//
// Sub-opcodes for `BinOp` and `UnaryOp`-style nodes are captured by separate
// `*Kind` literal unions below. `Collection` and `GlobalVars` are modeled with
// `kind` sub-discriminators because each has multiple opcode bytes mapping to
// the same expression node (matching sigma-rust's nested enums).
// ---------------------------------------------------------------------------

/**
 * Arithmetic sub-opcode for {@link BinOp}. Mirrors sigma-rust
 * `mir/bin_op.rs::ArithOp`. Each kind maps to a distinct opcode byte
 * (`OP_PLUS`, `OP_MINUS`, …).
 */
export type ArithOp =
  | 'Plus'
  | 'Minus'
  | 'Multiply'
  | 'Divide'
  | 'Max'
  | 'Min'
  | 'Modulo'

/**
 * Relational sub-opcode for {@link BinOp}. Mirrors sigma-rust
 * `mir/bin_op.rs::RelationOp` (`==`, `!=`, `>=`, `>`, `<=`, `<`).
 */
export type RelationOp = 'Eq' | 'NEq' | 'Ge' | 'Gt' | 'Le' | 'Lt'

/**
 * Logical sub-opcode for {@link BinOp}. Mirrors sigma-rust
 * `mir/bin_op.rs::LogicalOp` (binary `&&`, `||`, `^`).
 */
export type LogicalOp = 'And' | 'Or' | 'Xor'

/**
 * Bitwise sub-opcode for {@link BinOp}. Mirrors sigma-rust
 * `mir/bin_op.rs::BitOp` (`|`, `&`, `^`, `<<`, `>>`, `>>>`).
 */
export type BitOp =
  | 'BitOr'
  | 'BitAnd'
  | 'BitXor'
  | 'BitShiftLeft'
  | 'BitShiftRight'
  | 'BitShiftRightZeroed'

/**
 * Tagged union over the four sub-opcode families a `BinOp` can carry.
 * Mirrors sigma-rust `mir/bin_op.rs::BinOpKind`.
 */
export type BinOpKind =
  | { kind: 'Arith'; op: ArithOp }
  | { kind: 'Relation'; op: RelationOp }
  | { kind: 'Logical'; op: LogicalOp }
  | { kind: 'Bit'; op: BitOp }

// Append: concatenation of two collections. sigma-rust mir/coll_append.rs.
export interface Append {
  tag: 'Append'
  input: Expr
  col2: Expr
}

// Const: a constant value (type + literal). sigma-rust mir/constant.rs.
// On the wire a `Const` is emitted as `(SType, SValue)` with the SType byte
// acting as the opcode (in the FIRST_DATA_TYPE..LAST_CONSTANT_CODE range).
export interface Const {
  tag: 'Const'
  tpe: SType
  value: SValue
}

// ConstPlaceholder: zero-based index into ErgoTree.constants. sigma-rust
// mir/constant/constant_placeholder.rs (opcode CONSTANT_PLACEHOLDER = 0x03).
export interface ConstPlaceholder {
  tag: 'ConstPlaceholder'
  id: number
  tpe: SType
}

// SubstConstants: substitute constants in a serialized ergo tree.
// sigma-rust mir/subst_const.rs.
export interface SubstConstants {
  tag: 'SubstConstants'
  scriptBytes: Expr
  positions: Expr
  newValues: Expr
}

// ByteArrayToLong / ByteArrayToBigInt: conversions on Coll[Byte].
// sigma-rust mir/byte_array_to_long.rs, mir/byte_array_to_bigint.rs.
export interface ByteArrayToLong {
  tag: 'ByteArrayToLong'
  input: Expr
}
export interface ByteArrayToBigInt {
  tag: 'ByteArrayToBigInt'
  input: Expr
}

// LongToByteArray: SLong → Coll[Byte]. sigma-rust mir/long_to_byte_array.rs.
export interface LongToByteArray {
  tag: 'LongToByteArray'
  input: Expr
}

/**
 * Collection literal. Mirrors sigma-rust `mir/collection.rs::Collection`,
 * an enum with two arms each carrying its own opcode:
 *  - `Exprs` → `OP_COLL` (general collection of expressions)
 *  - `BoolConstants` → `OP_COLL_OF_BOOL_CONST` (packed booleans optimization)
 * Modeled here as one `tag: 'Collection'` variant with a `kind` field so the
 * serializer can pick the right opcode at emit time.
 */
export type Collection =
  | { tag: 'Collection'; kind: 'Exprs'; elemTpe: SType; items: Expr[] }
  | { tag: 'Collection'; kind: 'BoolConstants'; items: boolean[] }

// Tuple: heterogeneous fixed-arity tuple. sigma-rust mir/tuple.rs.
export interface Tuple {
  tag: 'Tuple'
  items: Expr[]
}

// CalcBlake2b256 / CalcSha256: cryptographic hash functions.
// sigma-rust mir/calc_blake2b256.rs, mir/calc_sha256.rs.
export interface CalcBlake2b256 {
  tag: 'CalcBlake2b256'
  input: Expr
}
export interface CalcSha256 {
  tag: 'CalcSha256'
  input: Expr
}

// Context: nullary "the context" expression (opcode CONTEXT).
// sigma-rust `Expr::Context` (unit variant).
export interface Context {
  tag: 'Context'
}

// Global: nullary "the Global object" expression (opcode GLOBAL).
// sigma-rust `Expr::Global` (unit variant).
export interface Global {
  tag: 'Global'
}

/**
 * GlobalVars: predefined global variables. Mirrors sigma-rust
 * `mir/global_vars.rs::GlobalVars` (an enum with 6 variants, each backed by a
 * distinct opcode: HEIGHT, INPUTS, OUTPUTS, SELF_BOX, MINER_PUBKEY,
 * GROUP_GENERATOR). Modeled here as one variant with a `kind` field so the
 * serializer can pick the right opcode at emit time.
 */
export interface GlobalVars {
  tag: 'GlobalVars'
  kind: 'Height' | 'Inputs' | 'Outputs' | 'SelfBox' | 'MinerPubKey' | 'GroupGenerator'
}

// FuncArg: an argument descriptor for FuncValue. sigma-rust
// mir/func_value.rs::FuncArg.
export interface FuncArg {
  /** ValId (sigma-rust `u32`), bound by ValDef-style scoping. */
  id: number
  tpe: SType
}

// FuncValue: user-defined function (lambda). sigma-rust
// mir/func_value.rs::FuncValue.
export interface FuncValue {
  tag: 'FuncValue'
  args: FuncArg[]
  body: Expr
}

// Apply: function application. sigma-rust mir/apply.rs::Apply.
export interface Apply {
  tag: 'Apply'
  func: Expr
  args: Expr[]
}

/**
 * MethodCall: invoke a method on an object. sigma-rust mir/method_call.rs.
 * `method` is deferred: sigma-rust resolves via `SMethod` (a type-companion
 * + method id pair). For now we keep the on-wire identifiers raw — the full
 * method resolver is implemented alongside the per-method dispatch.
 *
 * `explicitTypeArgs` mirrors sigma-rust's `HashMap<STypeVar, SType>` used
 * for methods like `Box.getReg[T]()` where the return type is not derivable
 * from arg types alone.
 */
export interface MethodCall {
  tag: 'MethodCall'
  obj: Expr
  /** Type companion id (Rust `SMethod.obj_type_id`). */
  typeId: number
  /** Method id within the type (Rust `SMethod.method_raw.method_id`). */
  methodId: number
  args: Expr[]
  /** Explicit type arguments by STypeVar name. */
  explicitTypeArgs: Record<string, SType>
}

// PropertyCall: invoke a property (zero-arg method) on an object.
// sigma-rust mir/property_call.rs.
export interface PropertyCall {
  tag: 'PropertyCall'
  obj: Expr
  typeId: number
  methodId: number
  /**
   * Explicit type arguments by STypeVar name. Mirrors {@link MethodCall}'s
   * field. Empty (`{}`) for all pre-v6-P4 PropertyCall nodes; populated for
   * methods whose return type needs an explicit `T` on the wire (e.g.
   * `SGlobal.none[T]` 106:10, the first such PropertyCall-opcode method).
   * The parser always sets it (to `{}` when the method declares none).
   */
  explicitTypeArgs: Record<string, SType>
}

// BlockValue: a sequence of statements followed by a result expression.
// sigma-rust mir/block.rs::BlockValue.
export interface BlockValue {
  tag: 'BlockValue'
  items: Expr[]
  result: Expr
}

// ValDef: let-bound `let x = rhs`, or (with tpeArgs) the polymorphic
// `let f[T] = rhs` — which the JVM serializes as FunDef (opcode 0xd7).
// JVM values.scala:922: companion = if (tpeArgs.isEmpty) ValDef else FunDef.
// The MIR `tag` stays 'ValDef' for both shapes; the opcode is chosen from
// tpeArgs.length at serialize time. sigma-rust mir/val_def.rs.
export interface ValDef {
  tag: 'ValDef'
  id: number
  rhs: Expr
  tpeArgs?: STypeVar[] // v6 P6: present + non-empty ⇒ FunDef; absent/[] ⇒ plain ValDef
}

// ValUse: reference to a previously-defined ValDef. sigma-rust mir/val_use.rs.
export interface ValUse {
  tag: 'ValUse'
  valId: number
  tpe: SType
}

// If: ternary, non-lazy evaluation of both branches.
// sigma-rust mir/if_op.rs::If.
export interface If {
  tag: 'If'
  condition: Expr
  trueBranch: Expr
  falseBranch: Expr
}

// BinOp: binary operation (arith / relational / logical / bitwise).
// sigma-rust mir/bin_op.rs::BinOp.
export interface BinOp {
  tag: 'BinOp'
  op: BinOpKind
  left: Expr
  right: Expr
}

// And / Or / Xor / Atleast: logical / threshold connectives on Coll[Boolean]
// or Coll[SigmaProp]. sigma-rust mir/and.rs, or.rs, xor.rs, atleast.rs.
export interface And {
  tag: 'And'
  input: Expr
}
export interface Or {
  tag: 'Or'
  input: Expr
}
export interface Xor {
  tag: 'Xor'
  left: Expr
  right: Expr
}
export interface Atleast {
  tag: 'Atleast'
  bound: Expr
  input: Expr
}

// LogicalNot / Negation / BitInversion: unary operations.
// sigma-rust mir/logical_not.rs, negation.rs, bit_inversion.rs.
export interface LogicalNot {
  tag: 'LogicalNot'
  input: Expr
}
export interface Negation {
  tag: 'Negation'
  input: Expr
}
export interface BitInversion {
  tag: 'BitInversion'
  input: Expr
}

// OptionGet / OptionIsDefined / OptionGetOrElse: SOption combinators.
// sigma-rust mir/option_get.rs, option_is_defined.rs, option_get_or_else.rs.
export interface OptionGet {
  tag: 'OptionGet'
  input: Expr
}
export interface OptionIsDefined {
  tag: 'OptionIsDefined'
  input: Expr
}
export interface OptionGetOrElse {
  tag: 'OptionGetOrElse'
  input: Expr
  default: Expr
}

// ExtractAmount / ExtractRegisterAs / ExtractBytes / ExtractBytesWithNoRef /
// ExtractScriptBytes / ExtractCreationInfo / ExtractId: Box accessors.
// sigma-rust mir/extract_amount.rs, extract_reg_as.rs, extract_bytes.rs,
// extract_bytes_with_no_ref.rs, extract_script_bytes.rs,
// extract_creation_info.rs, extract_id.rs.
export interface ExtractAmount {
  tag: 'ExtractAmount'
  input: Expr
}
export interface ExtractRegisterAs {
  tag: 'ExtractRegisterAs'
  input: Expr
  /** Register id (sigma-rust `i8`; valid range 0..=9 for R0..R9 plus internal). */
  registerId: number
  /** Element type wrapped in SOption (sigma-rust stores `Arc<SType>`). */
  elemTpe: SType
}
export interface ExtractBytes {
  tag: 'ExtractBytes'
  input: Expr
}
export interface ExtractBytesWithNoRef {
  tag: 'ExtractBytesWithNoRef'
  input: Expr
}
export interface ExtractScriptBytes {
  tag: 'ExtractScriptBytes'
  input: Expr
}
export interface ExtractCreationInfo {
  tag: 'ExtractCreationInfo'
  input: Expr
}
export interface ExtractId {
  tag: 'ExtractId'
  input: Expr
}

// ByIndex: collection index access with optional default.
// sigma-rust mir/coll_by_index.rs::ByIndex.
export interface ByIndex {
  tag: 'ByIndex'
  input: Expr
  index: Expr
  /** `Coll.getOrElse` default; `null` means strict `Coll.apply`. */
  default: Expr | null
}

// SizeOf: collection size. sigma-rust mir/coll_size.rs.
export interface SizeOf {
  tag: 'SizeOf'
  input: Expr
}

// Slice: collection slice `[from, until)`. sigma-rust mir/coll_slice.rs.
export interface Slice {
  tag: 'Slice'
  input: Expr
  from: Expr
  until: Expr
}

// Fold / Map / Filter / Exists / ForAll: collection higher-order combinators.
// sigma-rust mir/coll_fold.rs, coll_map.rs, coll_filter.rs, coll_exists.rs,
// coll_forall.rs.
export interface Fold {
  tag: 'Fold'
  input: Expr
  zero: Expr
  foldOp: Expr
}
export interface Map {
  tag: 'Map'
  input: Expr
  mapper: Expr
}
export interface Filter {
  tag: 'Filter'
  input: Expr
  condition: Expr
}
export interface Exists {
  tag: 'Exists'
  input: Expr
  condition: Expr
}
export interface ForAll {
  tag: 'ForAll'
  input: Expr
  condition: Expr
}

// SelectField: tuple field access (1-based). sigma-rust mir/select_field.rs.
export interface SelectField {
  tag: 'SelectField'
  input: Expr
  /** 1-based index; sigma-rust enforces `>= 1`. */
  fieldIndex: number
}

// BoolToSigmaProp / Upcast / Downcast: type conversions.
// sigma-rust mir/bool_to_sigma.rs, upcast.rs, downcast.rs.
export interface BoolToSigmaProp {
  tag: 'BoolToSigmaProp'
  input: Expr
}
export interface Upcast {
  tag: 'Upcast'
  input: Expr
  tpe: SType
}
export interface Downcast {
  tag: 'Downcast'
  input: Expr
  tpe: SType
}

// CreateProveDlog / CreateProveDhTuple: build sigma-protocol propositions
// from GroupElements. sigma-rust mir/create_provedlog.rs,
// create_prove_dh_tuple.rs.
export interface CreateProveDlog {
  tag: 'CreateProveDlog'
  input: Expr
}
export interface CreateProveDhTuple {
  tag: 'CreateProveDhTuple'
  g: Expr
  h: Expr
  u: Expr
  v: Expr
}

// SigmaPropBytes / SigmaPropIsProven: SigmaProp accessors.
// sigma-rust mir/sigma_prop_bytes.rs, sigma_prop_is_proven.rs.
export interface SigmaPropBytes {
  tag: 'SigmaPropBytes'
  input: Expr
}
export interface SigmaPropIsProven {
  tag: 'SigmaPropIsProven'
  input: Expr
}

/**
 * ZkProofBlock: explicit Zero Knowledge scope. sigma-rust
 * mir/zk_proof.rs::ZkProofBlock. Has no canonical opcode in sigma-rust
 * (Scala's `OpCodes.Undefined`); serialization fails with `NotSupported`.
 * Modeled for AST parity but the serializer will throw, mirroring Rust.
 */
export interface ZkProofBlock {
  tag: 'ZkProofBlock'
  input: Expr
}

// DecodePoint: byte array → GroupElement. sigma-rust mir/decode_point.rs.
export interface DecodePoint {
  tag: 'DecodePoint'
  input: Expr
}

// SigmaAnd / SigmaOr: AND/OR conjunctions over SigmaProp propositions.
// sigma-rust mir/sigma_and.rs, sigma_or.rs.
export interface SigmaAnd {
  tag: 'SigmaAnd'
  items: Expr[]
}
export interface SigmaOr {
  tag: 'SigmaOr'
  items: Expr[]
}

// GetVar: extract a context variable by id. sigma-rust mir/get_var.rs.
export interface GetVar {
  tag: 'GetVar'
  varId: number
  varTpe: SType
}

// DeserializeRegister / DeserializeContext: extract serialized scripts from
// register / context-extension and inline them. sigma-rust
// mir/deserialize_register.rs, deserialize_context.rs.
export interface DeserializeRegister {
  tag: 'DeserializeRegister'
  /** Register number 0..9. */
  reg: number
  tpe: SType
  default: Expr | null
}
export interface DeserializeContext {
  tag: 'DeserializeContext'
  tpe: SType
  id: number
}

// MultiplyGroup / Exponentiate: GroupElement arithmetic.
// sigma-rust mir/multiply_group.rs, exponentiate.rs.
export interface MultiplyGroup {
  tag: 'MultiplyGroup'
  left: Expr
  right: Expr
}
export interface Exponentiate {
  tag: 'Exponentiate'
  left: Expr
  right: Expr
}

// XorOf: XOR over a Coll[Boolean]. sigma-rust mir/xor_of.rs.
export interface XorOf {
  tag: 'XorOf'
  input: Expr
}

// TreeLookup: AVL+ tree key lookup. sigma-rust mir/tree_lookup.rs.
export interface TreeLookup {
  tag: 'TreeLookup'
  tree: Expr
  key: Expr
  proof: Expr
}

// CreateAvlTree: construct an AVL tree value. JVM trees.scala:79-91.
export interface CreateAvlTree {
  tag: 'CreateAvlTree'
  flags: Expr
  digest: Expr
  keyLength: Expr
  /**
   * Value-length operand — ALWAYS present, an expr whose *type* is
   * SOption[SInt] (JVM `valueLengthOpt: Value[SIntOption]`,
   * trees.scala:82). "No value length" is an Option-typed expr evaluating
   * to None (e.g. `Const(SOption[SInt], None)`), not an absent operand.
   * sigma-rust's `Option<Box<Expr>>` (presence-tag wire shape) is a fork —
   * see wire/mir/create-avl-tree.ts.
   */
  valueLength: Expr
}

/**
 * Full ErgoTree MIR expression union. 68 variants, one per sigma-rust
 * `Expr` enum arm. Discriminated on `tag`.
 *
 * Adding a new variant requires a corresponding handler in both
 * `wire/parse.ts` (opcode → constructor) and `wire/serialize.ts`
 * (`tag` → opcode + payload). Both files use exhaustive switches over the
 * opcode byte / `tag` respectively to make additions compile-time-visible.
 */
export type Expr =
  | Append
  | Const
  | ConstPlaceholder
  | SubstConstants
  | ByteArrayToLong
  | ByteArrayToBigInt
  | LongToByteArray
  | Collection
  | Tuple
  | CalcBlake2b256
  | CalcSha256
  | Context
  | Global
  | GlobalVars
  | FuncValue
  | Apply
  | MethodCall
  | PropertyCall
  | BlockValue
  | ValDef
  | ValUse
  | If
  | BinOp
  | And
  | Or
  | Xor
  | Atleast
  | LogicalNot
  | Negation
  | BitInversion
  | OptionGet
  | OptionIsDefined
  | OptionGetOrElse
  | ExtractAmount
  | ExtractRegisterAs
  | ExtractBytes
  | ExtractBytesWithNoRef
  | ExtractScriptBytes
  | ExtractCreationInfo
  | ExtractId
  | ByIndex
  | SizeOf
  | Slice
  | Fold
  | Map
  | Filter
  | Exists
  | ForAll
  | SelectField
  | BoolToSigmaProp
  | Upcast
  | Downcast
  | CreateProveDlog
  | CreateProveDhTuple
  | SigmaPropBytes
  | SigmaPropIsProven
  | ZkProofBlock
  | DecodePoint
  | SigmaAnd
  | SigmaOr
  | GetVar
  | DeserializeRegister
  | DeserializeContext
  | MultiplyGroup
  | Exponentiate
  | XorOf
  | TreeLookup
  | CreateAvlTree

/**
 * Runtime value union. Variants mirror sigma-rust's `Value<'ctx>` enum in
 * `ergotree-ir/src/mir/value.rs`, narrowed to the set the interpreter needs:
 * - `String`, `Header`, `PreHeader`, `Context`, `Global` are SType-only
 *   (no runtime value form in v5 ErgoScript — see design spec §3).
 * - `UnsignedBigInt` is v6-only and rejected by the v5 verifier (see
 *   spec §2 on `check_v6_type`).
 *
 * No embedded `SType`: the type of a primitive is recoverable from `kind`,
 * and composite variants (`Coll`, `Option`) carry an explicit element type.
 */
export type SValue =
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Byte'; value: number }
  | { kind: 'Short'; value: number }
  | { kind: 'Int'; value: number }
  | { kind: 'Long'; value: bigint }
  | { kind: 'BigInt'; value: bigint }
  | { kind: 'UnsignedBigInt'; value: bigint }
  | { kind: 'GroupElement'; value: Uint8Array }
  | { kind: 'SigmaProp'; value: SigmaBoolean }
  | { kind: 'Box'; value: ErgoBox }
  | { kind: 'PreHeader'; value: PreHeader }
  | { kind: 'Header'; value: Header }              // phase 2h-c.1
  | { kind: 'AvlTree'; value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Context' }
  | { kind: 'Global' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
  | { kind: 'Tuple'; items: SValue[] }
  | { kind: 'Option'; elem: SType; value: SValue | null }
  | { kind: 'Lambda'; closure: Closure }
  | { kind: 'String'; value: string }                // iter-17 (h=766,915 tx 15 output 1)

// ---------------------------------------------------------------------------
// ErgoTree envelope.
//
// Mirrors sigma-rust's `ergotree-ir/src/ergo_tree/tree_header.rs::ErgoTreeHeader`
// and `ergotree-ir/src/ergo_tree.rs::ParsedErgoTree`. The wire layout:
//
//   header byte:
//     bits 2..0 — language version (0..7)
//     bit 3     — has-size: a VLQ-u32 size of (constants + body) follows the
//                 header byte (mandatory for v1+)
//     bit 4     — constant-segregation: a VLQ-u32 count + that many
//                 `(SType, SValue)` constants precede the body
//     bit 5     — reserved (context-dependent costing; must be 0)
//     bit 6     — reserved (GZIP compression; must be 0)
//     bit 7     — reserved (extended header; must be 0 in current versions)
//
//   then, in order:
//     if has-size: VLQ-u32 size of (constants + body) — bytes following the
//                  size prefix
//     if constant-segregation: VLQ-u32 constant count + each `(SType, SValue)`
//     body: Expr serialized form
//
// The size prefix (when present) covers the constants section AND the body —
// see sigma-rust `ergo_tree.rs:380-404` where `data` is filled with constants
// then root and `bytes.len()` is emitted as the size.
// ---------------------------------------------------------------------------

/**
 * Parsed ErgoTree header (one byte on the wire). `rawHeader` is the original
 * byte; the boolean / number fields are derived projections kept on the
 * struct so callers don't need to re-decode bits. Serialization writes
 * `rawHeader` directly to preserve any reserved bits the parser tolerated
 * (currently none — they're all 0).
 */
export interface TreeHeader {
  /** ErgoTree language version (bits 0..2 of `rawHeader`). 0..7. */
  version: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  /** Bit 3: a VLQ-u32 size of (constants + body) follows the header byte. */
  hasSize: boolean
  /** Bit 4: a VLQ-u32 count + that many `(SType, SValue)` constants precede the body. */
  constantSegregation: boolean
  /** Original header byte. Used for byte-exact serialization round-trip. */
  rawHeader: number
}

/**
 * Parsed ErgoTree envelope. Mirrors sigma-rust's `ParsedErgoTree`:
 *
 *   header     — the parsed header byte fields
 *   constants  — segregated constant values (empty when `header.constantSegregation === false`)
 *   body       — the root expression (an `Expr`)
 *
 * Extra fields beyond sigma-rust:
 *   - `constantTypes` — parallel to `constants[]`. Carries the per-constant
 *     `SType` recovered from the wire. Necessary because a parsed `SValue`
 *     does not unambiguously encode its `SType` for some edge cases (e.g.
 *     empty `Coll` items, `None` for `SOption`); we cannot reconstruct the
 *     original type-driven encoding from `SValue` alone. Sigma-rust avoids
 *     this because its `Constant { tpe, v }` couples them at the struct
 *     level.
 */
export interface ErgoTree {
  header: TreeHeader
  /** Parallel to `constants[]`; required for byte-exact re-serialization. */
  constantTypes: SType[]
  /** Segregated constant values; empty when `header.constantSegregation` is false. */
  constants: SValue[]
  /** Root expression. */
  body: Expr
}
