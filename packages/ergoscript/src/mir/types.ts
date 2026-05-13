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
   * Non-mandatory registers R4..R9 (and mandatory views as needed in later
   * phases). Sparse: a missing register key yields `undefined`.
   */
  registers: Record<number, SValue | undefined>
  /** Secondary tokens (id is 32-byte token-id, amount is u64 packed as bigint). */
  tokens: { id: Uint8Array; amount: bigint }[]
  /** Block height at which the box was created (Rust `u32`). */
  creationHeight: number
  /** 32-byte transaction id that produced this box. */
  txId: Uint8Array
  /** Index of this box in the producing transaction's outputs (Rust `u16`). */
  index: number
}

/**
 * Stub: AVL+ tree authenticator. Mirrors sigma-rust
 * `ergotree-ir/src/mir/avl_tree_data.rs` `AvlTreeData`.
 *
 * `digest` is the JVM/Rust `ADDigest` = `Digest<33>` — 32 bytes of root hash
 * concatenated with 1 byte of tree height (33 bytes total).
 *
 * `treeFlags` is the serialized `AvlTreeFlags` byte: bit 0 = insert allowed,
 * bit 1 = update allowed, bit 2 = remove allowed.
 */
export interface AvlTreeData {
  /** Root hash (32 bytes) + tree-height byte = 33 bytes total. */
  digest: Uint8Array
  /** Enabled-operations bitfield (u8). */
  treeFlags: number
  /** Common key length (Rust `u32`). */
  keyLength: number
  /** If non-null, all values share this length (Rust `Option<u32>`). */
  valueLengthOpt: number | null
}

/**
 * Forward declaration — full sigma-protocol tree structure is filled in
 * phase 2g (sigma-protocol evaluation). Phase 2a treats this as opaque,
 * carrying the raw on-wire bytes so SValue can hold a SigmaProp variant.
 */
export interface SigmaBoolean {
  /** Serialized sigma-protocol tree; structure deferred to phase 2g. */
  raw: Uint8Array
}

/**
 * Forward declaration — proper user-function representation lands in phase 2d
 * (FuncValue / Apply). For now this captures the data the evaluator will need:
 * argument ids (matching the body's `ValUse.id` references), the body
 * expression, and the lexical environment captured at function definition.
 *
 * Mirrors sigma-rust `Lambda { args: Vec<FuncArg>, body: Box<Expr> }` from
 * `ergotree-ir/src/mir/value.rs`, plus an explicit `capturedEnv` (Rust uses
 * `EvalContext.env` for this implicitly).
 */
export interface Closure {
  /** Argument value ids; binds `ValUse.id` references inside `body`. */
  argIds: number[]
  /** Function body — an Expr (placeholder type until Task 9). */
  body: Expr
  /** Lexical environment captured at definition time, keyed by ValId. */
  capturedEnv: Record<number, SValue>
}

/**
 * Placeholder Expr type — Task 9 replaces this with the full ~80-variant
 * MIR discriminated union. Loose `{ tag: string }` keeps forward references
 * (notably `Closure.body`) compiling in phases 2a–2c.
 */
export type Expr = { tag: string }

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
  | { kind: 'GroupElement'; value: Uint8Array }
  | { kind: 'SigmaProp'; value: SigmaBoolean }
  | { kind: 'Box'; value: ErgoBox }
  | { kind: 'AvlTree'; value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
  | { kind: 'Tuple'; items: SValue[] }
  | { kind: 'Option'; elem: SType; value: SValue | null }
  | { kind: 'Lambda'; closure: Closure }

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
  version: number
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
 *   - `bodyByteLength` — the size prefix value at parse time when
 *     `header.hasSize`. Stored so serialization can produce byte-exact
 *     output even for trees whose body parser is not yet implemented
 *     (during the bring-up phase of the Expr dispatch in Task 9+).
 */
export interface ErgoTree {
  header: TreeHeader
  /** Parallel to `constants[]`; required for byte-exact re-serialization. */
  constantTypes: SType[]
  /** Segregated constant values; empty when `header.constantSegregation` is false. */
  constants: SValue[]
  /** Root expression. */
  body: Expr
  /**
   * Size of (constants + body) bytes as read from the `hasSize` prefix; 0
   * when `header.hasSize` is false. Used so re-serialization can match the
   * input byte-for-byte while the body parser is still partial.
   */
  bodyByteLength: number
}
