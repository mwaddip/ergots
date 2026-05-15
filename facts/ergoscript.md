# `@mwaddip/ergots-ergoscript` — Interface Contract

The boundary contract for the ErgoScript / ErgoTree wire-format package. Other packages in this monorepo (the future wallet / transaction-broadcaster) read this file to know what they may rely on. The narrative rationale lives in `docs/specs/2026-05-13-ergoscript-interpreter-design.md`; this file is *only* the interface.

**Phase 2a complete.** Pins the *wire-format surface* — parse and serialize for every ErgoTree variant defined in the sigma-rust `ergotree-ir` crate, plus address ↔ ErgoTree round-trip helpers.

**Phase 2b complete (v0.2.0).** Adds an *evaluator scaffold* — `evaluate` / `evaluateWith` with an `EvalContext` (cost accumulator + optional limit), an `Env` for val-bindings, and 8 of ~70 `Expr` arms wired (`Const`, `ConstPlaceholder`, `BlockValue`, `ValDef`, `ValUse`, `Tuple`, `Collection`, `If`). Every other `Expr` variant throws `EvalError 'not-implemented-yet'`. Phases 2c–2j extend this surface additively; the public function signatures and error class are stable from v0.2.0 onward.

**Phase 2c complete (v0.2.0, additive).** Adds 3 more `Expr` arms: `BinOp` (all 22 sub-ops — Arith ×5, Bit ×5, Relation ×6, Logical ×6), `LogicalNot`, and `BoolToSigmaProp`. Total implemented arms: 11 of ~70. New `EvalError` codes: `'arith-overflow'`, `'arith-divide-by-zero'`, `'bin-op-kind-mismatch'`, `'bin-op-not-numeric'`, `'bin-op-not-boolean'`. No public API surface changes; existing caller code is unaffected.

**Phase 2d-A complete (v0.2.0, additive).** Adds 4 more `Expr` arms — the unary numeric-polymorphism quartet: `Negation`, `BitInversion`, `Upcast`, `Downcast`. Total implemented arms: 15 of ~70. One new `EvalError` code: `'downcast-overflow'` (distinct from `'arith-overflow'` so callers can dispatch on "narrowing specifically failed"). Step-1 refactor promoted `checkRange` + `maskToKind` from `bin-op/{arith,bit}.ts` into `bin-op/_numeric.ts`; `checkRange` gained a third parameter (error code string) so arith callers keep passing `'arith-overflow'` and the new downcast caller passes `'downcast-overflow'`. No public API surface changes; existing caller code is unaffected.

The package has not been `npm publish`-ed; downstream consumers in the monorepo currently import it through the workspace alias. Anything not in this document is implementation detail and may change without notice.

Authoritative wire-format reference: sigma-rust's `ergotree-ir/src/ergo_tree.rs`, `ergotree-ir/src/serialization/`, and `ergotree-ir/src/mir/` (branch `integration/ergots`, HEAD `ed5452cf` at time of writing). Where this file is silent, those are canonical.

## Scope

**Ships in this contract (phase 2a — wire format):**

1. Parse + serialize for the ErgoTree envelope: header byte, optional VLQ-u32 body size, optional segregated constants section, body Expr.
2. Parse + serialize for the full `Expr` discriminated union (68 variants — see `mir/types.ts`), wired through a central opcode-dispatch switch.
3. Parse + serialize for `SType` (the type-system union) and `SValue` (the runtime-value union), including all primitive variants, `SColl`, `STuple`, `SOption`, `SFunc`, `STypeVar`.
4. Parse for `SigmaBoolean` (the recursive proposition tree inside `SSigmaProp` constants) — opaque-bytes representation, structural decode only used for length determination.
5. P2PK recognition + 33-byte public-key extraction.
6. Base58check address ↔ `ErgoTree` round-trip for mainnet and testnet (P2PK and P2S).
7. Stateless: no I/O, no clock, no PRNG, no `globalThis` reads. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.

**Ships additionally (phase 2b — evaluator chassis + 8 arms):**

8. Public evaluator entry points: `evaluate(tree, opts?)`, `evaluateWith(tree, ctx)`, `makeContext(opts?)`.
9. `EvalContext` carrying a saturating `jitCost` accumulator with optional `jitCostLimit` enforcement. Cost values are sigma-rust-accurate per arm from day one (not no-op placeholders).
10. Immutable `Env` for `ValDef` bindings (clone-on-extend; lexical scoping naturally correct under TS).
11. Central exhaustive `evalExpr` switch on `Expr.tag` with `_exhaust: never` discriminant; adding a new `Expr` variant becomes a compile-time error until a corresponding arm exists.
12. 8 per-variant arms wired: `Const`, `ConstPlaceholder`, `BlockValue` (with `ADD_TO_ENV_COST` per `ValDef`), `ValDef` (top-level rejection), `ValUse`, `Tuple`, `Collection` (both `Exprs` and `BoolConstants` kinds), `If` (with short-circuit semantics + cost-correct branch skipping).
13. Layer C1 per-arm fixture validation: every arm's behavior (value + cost) is asserted against sigma-rust's `try_eval_out` oracle.

**Ships additionally (phase 2c — operators slice 1):**

14. 3 more per-variant arms wired: `BinOp` (central dispatcher delegating on `e.op.kind` to 4 per-family sub-arms), `LogicalNot`, `BoolToSigmaProp`.
15. All 22 `BinOp` sub-ops implemented across 4 families:
    - **Arith** (7): `Plus`, `Minus`, `Multiply`, `Divide`, `Modulo`, `Max`, `Min`. Compute in `bigint` internally with signed-range checks per kind (Byte/Short/Int/Long/BigInt256); throws `'arith-overflow'` on bounds violation, `'arith-divide-by-zero'` for `/0` and `%0`. Cost varies per op and per `is_bigint` (matches sigma-rust `bin_op.rs:198-207`).
    - **Relation** (6): `Lt`, `Le`, `Gt`, `Ge` (numeric ordering); `Eq`, `NEq` via the recursive `sValueEquals` comparer.
    - **Logical** (3): `And`, `Or` short-circuit on Boolean operands (right-side cost NOT charged when short-circuited); `Xor` is eager.
    - **Bit** (3 of 6): `BitAnd`, `BitOr`, `BitXor` with kind-uniform bigint masking + sign-preserving re-narrowing. The 3 shift ops (`BitShiftLeft`, `BitShiftRight`, `BitShiftRightZeroed`) throw `'not-implemented-yet'` matching sigma-rust's `EvalError::Misc` posture — sigma-rust delegates shifts to `SNumericTypeMethods` (a method-call IR path) not the BinOp arm.
16. `sValueEquals` recursive structural comparer covering primitives (Boolean / Byte / Short / Int / Long / BigInt / Unit), `GroupElement` (byte-equal), `SigmaProp` (byte-equal on opaque `.raw`), `Coll`, `Tuple`, `Option`. Cross-kind comparison returns `false` (no coercion). `Box` / `AvlTree` throw `'not-implemented-yet'` (their runtime shapes aren't in scope until phase 2h+). Cost is charged inside the comparer per per-type constants mirroring sigma-rust's `data_value_comparer.rs` (`EQ_PRIM_COST`, `EQ_BIGINT_COST`, `EQ_GROUP_ELEMENT_COST`, `EQ_TUPLE_COST`, `EQ_OPTION_COST`, `COLL_MATCH_TYPE_COST` + per-item).
17. 5 new `EvalError` codes documented in the v0.2.0 taxonomy below: `'arith-overflow'`, `'arith-divide-by-zero'`, `'bin-op-kind-mismatch'`, `'bin-op-not-numeric'`, `'bin-op-not-boolean'`.

**Ships additionally (phase 2d-A — numeric-poly unary arms):**

18. 4 more per-variant arms wired: `Negation` (numeric negate; overflow throws `'arith-overflow'`), `BitInversion` (bitwise complement; no overflow), `Upcast` (widen to target numeric kind read from `e.tpe`; no overflow), `Downcast` (narrow to target numeric kind; overflow throws `'downcast-overflow'`). All four are unary, numeric-only; result kind equals input kind for `Negation`/`BitInversion`, and equals the target kind on `e.tpe` for `Upcast`/`Downcast`.
19. One new `EvalError` code documented in the v0.2.0 taxonomy below: `'downcast-overflow'`. No other taxonomy changes; non-numeric input to any of the four arms reuses `'bin-op-not-numeric'` per the `LogicalNot` / `BoolToSigmaProp` precedent from 2c.
20. Step-1 refactor: `checkRange` and `maskToKind` promoted from `bin-op/{arith,bit}.ts` to `bin-op/_numeric.ts`. `checkRange` gains a third parameter (error code string) so 2c arith callers continue passing `'arith-overflow'` while the new `Downcast` caller passes `'downcast-overflow'`. `maskToKind` moves unchanged. Internal refactor only — no behavioral change to existing 2c fixtures.

**Coverage after 2d-A:** 15 of ~70 `Expr` variants have implemented arms in v0.2.0 (8 from phase 2b + 3 from phase 2c + 4 from phase 2d-A: `Negation`, `BitInversion`, `Upcast`, `Downcast`); every other variant throws `EvalError 'not-implemented-yet'`. Public function signatures (`evaluate`, `evaluateWith`, `makeContext`, `EvalError`) are stable from v0.2.0 onward — future arms slot into central dispatch without surface changes.

**Does NOT ship yet (deferred to upcoming phases):**

- `Coll[Boolean]` aggregators (`And` / `Or` / `Xor` over `Coll[Boolean]`) and `Atleast` (k-of-n `SigmaProp` combinator) — phase 2d slice B.
- Lambda support (`FuncValue`, `Apply`) — later phase.
- Box / Context / Header chain-state model (`SELF`, `INPUTS(i).R4`, `HEIGHT`, `getVar(...)`) — later phase.
- Collection HOFs (`map`, `filter`, `fold`, `forall`, `exists`, `slice`, `append`, `byIndex`) — later phase.
- Sigma protocol prover and verifier (`reduceToCrypto`, `prove`, `verify`) — later phase; `SigmaProp` remains opaque-bytes until then.
- AVL+ membership-proof verification (`verifyMembershipProof`, `lookupInTree`) — later phase.
- BinOp `Bit` shift ops via `SNumericTypeMethods` — when method-call dispatch lands.
- `Box` / `AvlTree` equality comparison (currently `'not-implemented-yet'` from `sValueEquals`) — when the chain-state model lands.
- Real-context cost validation (Layer C3) — calibration phase after all arms are in.
- `ergoscript-compiler` (`.es` source → bytes). Out of scope until upstream PR 862 settles. Would be a sibling package, not part of this one.
- AOT interpreter. Upstream is deprecating it; we target `R5.0-JIT-verify` semantics exclusively.
- Transaction building, key derivation, mnemonic handling, BIP32. Those belong to the phase 3 wallet package.
- Network or filesystem access. The package is a pure library.

## Public surface

### Primary export: `@mwaddip/ergots-ergoscript` (via `index.ts`)

```ts
parseTree(bytes: Uint8Array): ErgoTree
serializeTree(tree: ErgoTree): Uint8Array

isP2PK(tree: ErgoTree): boolean
p2pkPublicKey(tree: ErgoTree): Uint8Array | null
addressFromErgoTree(tree: ErgoTree, network: Network): string
ergoTreeFromAddress(address: string): ErgoTree

base58Encode(bytes: Uint8Array): string
base58Decode(s: string): Uint8Array

const MAX_TREE_SIZE: 1_048_576    // 1 MB
const VERSION: '0.2.0'

type Network = 'mainnet' | 'testnet'
type AddressType = 'P2PK' | 'P2S'
type ErgoTree, TreeHeader, SType, SValue, Expr
```

#### `parseTree(bytes)`

- **Precondition:** `bytes.length >= 1` and `bytes.length <= MAX_TREE_SIZE` (1 MB). The cap mirrors sigma-rust's practical bound (largest real-world ErgoTree in the PR 862 corpus is ergoraffle at 931 bytes); 1 MB is comfortably above that ceiling while bounding memory against adversarial inputs.
- **Postcondition (success):** Returns an `ErgoTree` whose `serializeTree` is byte-identical to the input. See `Round-trip invariant` below.
- **Postcondition (failure):** Throws `ErgoTreeParseError` for envelope-level malformations (`empty`, `oversized`, `body-size-overflow`, `too-many-constants`). Body-parse failures surface as `ExprParseError` from the body parser; SType / SValue failures surface as `STypeParseError` / `SValueParseError` / `SigmaBooleanParseError`. The envelope does not wrap them — callers see the typed failure surface from the innermost layer that rejected the bytes. `ReaderError` from the underlying cursor may also surface (`truncated`, `vlq-overflow`).

#### `serializeTree(tree)`

- **Precondition:** `tree` was either returned from `parseTree` or constructed satisfying the type invariants below. The `header.rawHeader` byte MUST be derivable from `header.version`, `header.hasSize`, and `header.constantSegregation` (the projection is round-trip-checked at serialize time). `constantTypes.length === constants.length` is required.
- **Postcondition:** Returns `Uint8Array` of length ≤ `MAX_TREE_SIZE`. For any `tree` returned by `parseTree(b)`, `serializeTree(parseTree(b))` equals `b` byte-for-byte.
- **Postcondition (failure):** Throws `ErgoTreeSerializeError` with `code` `'header-inconsistent'` (rawHeader mismatch) or `'constants-arity-mismatch'`. Body-serialize failures surface as `ExprSerializeError` (notably `'not-supported'` for the un-encodable `ZkProofBlock` variant).

#### `isP2PK(tree)` / `p2pkPublicKey(tree)`

- **Precondition:** `tree` is a valid `ErgoTree`.
- **Postcondition (`isP2PK`):** Returns `true` iff the tree's body is the canonical P2PK shape — `Const(SSigmaProp, ProveDlog(EcPoint))` or a `ConstPlaceholder` resolving to the same — matching sigma-rust's `Address::P2Pk.script()` recognition (`ergotree-ir/src/chain/address.rs:206-218`).
- **Postcondition (`p2pkPublicKey`):** Returns a defensive 33-byte copy of the compressed secp256k1 public key when `isP2PK(tree)` is true, else `null`. The returned buffer is fresh — mutating it does not affect the tree's internal storage.
- **Invariant:** Trees whose body is `CreateProveDlog(GroupElement)` (a derived form) are NOT classified as P2PK — sigma-rust only recognizes the canonical `Const(SSigmaProp, _)` form. Using a non-canonical shape would break the address → tree → address round-trip against any other Ergo implementation.

#### `addressFromErgoTree(tree, network)` / `ergoTreeFromAddress(address)`

- **Precondition (`addressFromErgoTree`):** `tree` is a valid `ErgoTree`; `network` is `'mainnet'` or `'testnet'`.
- **Postcondition (`addressFromErgoTree`):** Returns a base58check Ergo address. If `isP2PK(tree)`, the address is P2PK (content bytes are the 33-byte EcPoint only, NOT the serialized tree). Otherwise the address is P2S (content bytes are the full serialized ErgoTree).
- **Precondition (`ergoTreeFromAddress`):** `address` is a base58check Ergo address with valid checksum and a supported address type.
- **Postcondition (`ergoTreeFromAddress`):** Returns the `ErgoTree` encoded by the address. P2PK addresses are reconstructed by synthesizing canonical bytes (`0x00 0x08 0xcd <33 bytes pubkey>`) and parsing them — every returned tree goes through `parseTree`, so the type invariants below hold.
- **Postcondition (failure):** Throws `AddressDecodeError` with `code` `'bad-base58'`, `'too-short'`, `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, or `'unknown-type'`. A P2S address carrying malformed tree bytes throws `ErgoTreeParseError` (or a downstream parser error) — those bubble up unwrapped.
- **Round-trip invariant:** For any tree `t` and matching network `n`, `ergoTreeFromAddress(addressFromErgoTree(t, n))` parses to a structurally equivalent `ErgoTree`. P2SH addresses are NOT round-trippable through this function (they are derived from a 24-byte hash, not a serialized tree) and decoding one throws `p2sh-unsupported`.

### Internal modules (current monorepo surface)

The package's `index.ts` exposes the consumer-facing surface above. Internal modules under `wire/`, `mir/`, and `crypto/` carry additional types and error classes that downstream packages in this monorepo (and the test suite) reach into directly while the package is pre-publish:

```ts
// wire/parse.ts
parseExpr(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes?: Map<number, SType>
): Expr

// wire/serialize.ts
serializeExpr(e: Expr, w: ByteWriter): void

// wire/parse-stype.ts / wire/serialize-stype.ts
parseSType(r: ByteReader): SType
serializeSType(t: SType, w: ByteWriter): void

// wire/parse-svalue.ts / wire/serialize-svalue.ts
parseSValue(tpe: SType, r: ByteReader): SValue
serializeSValue(tpe: SType, v: SValue, w: ByteWriter): void

// wire/sigma-boolean.ts
parseSigmaBoolean(r: ByteReader): SigmaBoolean
sigmaBooleanOpCode(sb: SigmaBoolean): number | null
proveDlogPublicKey(sb: SigmaBoolean): Uint8Array | null

// wire/reader.ts / wire/writer.ts
class ByteReader
class ByteWriter

// mir/expr-tpe.ts
exprTpe(e: Expr): SType
```

`parseExpr` accepts the parallel-indexed segregated constant arrays from the surrounding ErgoTree envelope. `constantTypes` is consulted by the `ConstantPlaceholder` handler to recover a placeholder's `SType` from its id; `constantValues` is reserved for substitution-at-parse-time semantics (sigma-rust's `substitute_placeholders` flag — not currently used). `valDefTypes` is a shared scope-wide `Map<ValId, SType>` populated by `ValDef` parsers and read by `ValUse` parsers (mirrors sigma-rust's `SigmaByteReader.val_def_type_store`); the outer envelope creates a fresh empty map per tree, and recursive descent shares it across the whole Expr graph.

Once the package publishes, these symbols will likely move behind a `/wire` subpath export (the proof package's `/envelope` pattern). Until then, this file documents their current shape so downstream packages can rely on them.

### Round-trip invariant

For any byte sequence `b` accepted by `parseTree`:

```
serializeTree(parseTree(b)) === b   (byte-equal)
```

This holds for every ErgoTree variant we ship. The phase 2a corpus test asserts this on 255 passing fixtures plus 1 mainnet-fixture stub plus 6 upstream-buggy fixtures (the 6 are excluded from byte-equality; sigma-rust itself does not round-trip them — see `fixture-gen/known_unstable.json`).

For the body-only round-trip (i.e., parsing a `parseExpr` output and reserializing through `serializeExpr` into a fresh `ByteWriter`), the same byte-equality invariant holds.

## Type invariants

These hold on every `ErgoTree` returned by the public API. Callers may rely on them without re-checking.

```ts
type Network = 'mainnet' | 'testnet'
type AddressType = 'P2PK' | 'P2S'

interface TreeHeader {
  version: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7   // bits 0..2 of rawHeader
  hasSize: boolean                          // bit 3: VLQ-u32 body size follows
  constantSegregation: boolean              // bit 4: segregated constants section
  rawHeader: number                         // original byte; derivable from the three fields above
}

interface ErgoTree {
  header: TreeHeader
  constantTypes: SType[]            // parallel to constants[]; required for byte-exact re-serialize
  constants: SValue[]               // empty when header.constantSegregation === false
  body: Expr                        // root expression
}

type SType =
  | { tag: 'SBoolean' } | { tag: 'SByte' } | { tag: 'SShort' }
  | { tag: 'SInt' } | { tag: 'SLong' } | { tag: 'SBigInt' }
  | { tag: 'SGroupElement' } | { tag: 'SSigmaProp' } | { tag: 'SBox' }
  | { tag: 'SAvlTree' } | { tag: 'SUnit' } | { tag: 'SAny' }
  | { tag: 'SHeader' } | { tag: 'SPreHeader' } | { tag: 'SContext' }
  | { tag: 'SGlobal' } | { tag: 'SString' }
  | { tag: 'SColl';  elem: SType }
  | { tag: 'STuple'; items: SType[] }
  | { tag: 'SOption'; elem: SType }
  | { tag: 'SFunc'; args: SType[]; result: SType; tpeParams: STypeVar[] }
  | { tag: 'STypeVar'; name: string }

type SValue =
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Byte' | 'Short' | 'Int'; value: number }
  | { kind: 'Long' | 'BigInt'; value: bigint }
  | { kind: 'GroupElement'; value: Uint8Array }   // 33-byte compressed secp256k1
  | { kind: 'SigmaProp'; value: SigmaBoolean }    // opaque raw bytes in phase 2a
  | { kind: 'Box'; value: ErgoBox }
  | { kind: 'AvlTree'; value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
  | { kind: 'Tuple'; items: SValue[] }
  | { kind: 'Option'; elem: SType; value: SValue | null }
  | { kind: 'Lambda'; closure: Closure }
```

`Expr` is the 68-variant discriminated union over MIR nodes, keyed on `tag`. Each variant's payload mirrors sigma-rust's `mir/<variant>.rs` struct fields. Full list and per-variant shapes live in `packages/ergoscript/src/mir/types.ts`; adding a variant requires corresponding arms in `wire/parse.ts` and `wire/serialize.ts` (both files use exhaustive switches to make additions compile-time-visible).

- `rawHeader` is the on-wire byte. The `version`, `hasSize`, `constantSegregation` fields are derived projections kept on the struct so callers don't need to re-decode bits. `serializeTree` writes `rawHeader` directly but validates that it matches the derived fields — a hand-constructed `ErgoTree` with inconsistent fields is rejected at serialize time with `'header-inconsistent'`.
- `constantTypes` is parallel to `constants[]` and carries the per-constant `SType` recovered from the wire. It's necessary because a parsed `SValue` does not unambiguously encode its `SType` for some edge cases (empty `Coll`, `None` for `SOption`); sigma-rust avoids this because its `Constant { tpe, v }` couples them at the struct level.
- `SigmaBoolean.raw` in phase 2a is the opaque on-wire bytes of the sigma-protocol proposition tree. Structural decode happens only to determine length; structural access (e.g. for sigma-protocol evaluation) is deferred to phase 2g, at which point `raw` can be re-parsed.
- `ErgoBox`, `AvlTreeData`, and `Closure` are forward-declared in phase 2a. Their shapes are stable for the wire-format surface but evaluator-only fields may be added in later phases.

## Determinism and purity

- All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- No async surface. Every function is synchronous. (Rationale: the parser hits VLQ loops and blake2b in tight inner sections; the async boundary would only add overhead.)
- No throwing on success paths. Throws indicate contract violations or input rejection — they're the typed failure surface.

## Browser-compat guarantees

Runtime support: Node ≥ 20, evergreen browsers with native ESM. Specifically:

- All Uint8Arrays. Never `Buffer`. (`Buffer.from(...)` does not exist in browsers.)
- `globalThis.crypto` is not used. Hashing comes from `@noble/hashes` only.
- `bigint` is used for `SLong`, `SBigInt`, and 64-bit-safe VLQ reads. Browsers support `bigint` natively since 2020; no polyfill ships.
- No top-level `await`.
- No WASM. No `.wasm` blobs anywhere in the package, no direct or transitive WASM dependencies. CI scans `dist/` for `.wasm` files, `WebAssembly.instantiate`, Buffer/process/node:* references, and Scala.js identifier patterns (to catch accidental `sigma-js` imports).
- Bundle is ESM-only. The package's `exports` map deliberately omits CJS entry points.

## Error taxonomy

Every error class carries a `code: string` matching one of a fixed set of structural reasons for programmatic dispatch. `.message` is human-readable.

```ts
class ErgoTreeParseError      extends Error { code: string }
class ErgoTreeSerializeError  extends Error { code: string }
class ExprParseError          extends Error { code: string }
class ExprSerializeError      extends Error { code: string }
class STypeParseError         extends Error { code: string }
class STypeSerializeError     extends Error { code: string }
class SValueParseError        extends Error { code: string }
class SValueSerializeError    extends Error { code: string }
class SigmaBooleanParseError  extends Error { code: string }
class ExprTpeError            extends Error { code: string }
class ReaderError             extends Error { code: string }
class AddressDecodeError      extends Error { code: string }
```

Per-class code enumeration (every code below is emitted by current source):

- **`ErgoTreeParseError`**: `'empty'`, `'oversized'`, `'body-size-overflow'`, `'too-many-constants'`, `'header-inconsistent'`.
- **`ErgoTreeSerializeError`**: `'header-inconsistent'`, `'constants-arity-mismatch'`.
- **`ExprParseError`**: `'not-implemented-yet'` (named in sigma-rust's opcode table but no TS handler — covers `OpTrue`, `OpFalse`, `UnitConstant`, `LastBlockUtxoRootHash`, `Select1..Select5`, `FlatMap`, `FunDef`, `SomeValue`, `NoneValue`, `TrivialPropFalse`, `TrivialPropTrue`, `ModQ`, `PlusModQ`, `MinusModQ`, `CollShiftLeft/Right/RightZeroed`, `CollRotateLeft/Right`); `'unknown-opcode'` (byte not in sigma-rust's opcode table at all); plus per-variant codes including `'apply-too-many-args'`, `'block-too-many-items'`, `'collection-size-out-of-range'`, `'deserialize-context-id-out-of-range'`, `'deserialize-register-id-out-of-range'`, `'extract-register-as-id-out-of-range'`, `'func-value-too-many-args'`, `'get-var-id-out-of-range'`, `'invalid-binop-opcode'`, `'invalid-constant-placeholder-id'`, `'invalid-option-tag'`, `'method-call-id-out-of-range'`, `'method-call-missing-type-arg'`, `'method-call-too-many-args'`, `'property-call-id-out-of-range'`, `'select-field-index-out-of-range'`, `'tuple-arity-out-of-range'`, `'unknown-binop-kind'`, `'val-def-rhs-tpe'`, `'val-use-unknown-id'`.
- **`ExprSerializeError`**: `'not-supported'` (the `ZkProofBlock` variant — matches sigma-rust's `NotSupported`); `'unknown-variant'` (compile-time-unreachable fallback for the exhaustive switch).
- **`STypeParseError`**: `'invalid-type-code'`, `'unsupported-type'`, `'invalid-tuple-length'`, `'invalid-stypevar-length'`, `'invalid-stypevar-utf8'`, `'invalid-sfunc-tpe-params'`.
- **`STypeSerializeError`**: `'tuple-too-short'`, `'tuple-too-long'`, `'stypevar-name-length'`, `'sfunc-tdom-too-long'`, `'sfunc-tpe-params-too-long'`, `'unreachable'`.
- **`SValueParseError`**: `'bigint-too-large'`, `'coll-length-out-of-range'`, `'not-implemented-phase-2a'`, `'unreachable'`.
- **`SValueSerializeError`**: `'bigint-too-large'`, `'group-element-length'`, `'coll-length-out-of-range'`, `'coll-item-kind-mismatch'`, `'tuple-arity-mismatch'`, `'sigma-boolean-empty'`, `'type-value-mismatch'`, `'not-implemented-phase-2a'`, `'unreachable'`.
- **`SigmaBooleanParseError`**: `'arity-out-of-range'`, `'unknown-opcode'`.
- **`ExprTpeError`** (raised by `exprTpe`, the SType-of-Expr projection): `'apply-func-not-sfunc'`, `'bin-op-kind-unhandled'`, `'by-index-input-not-scoll'`, `'option-get-input-not-soption'`, `'select-field-input-not-stuple'`, `'select-field-out-of-range'`, `'tpe-not-implemented'`.
- **`ReaderError`** (raised by `ByteReader`): `'truncated'`, `'vlq-overflow'`, `'slice-out-of-bounds'`.
- **`AddressDecodeError`**: `'bad-base58'`, `'too-short'`, `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, `'unknown-type'`.

No other error classes are emitted by this package. Internal panics (e.g. a bug in `@noble/hashes`) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues.

## Test plan summary

(Detail in `docs/specs/2026-05-13-ergoscript-interpreter-design.md` § Validation strategy.)

1. **Layer 1 — Parse + round-trip on every fixture**: `test/corpus.test.ts` loads the full fixture corpus (sigma-rust unit tests, ergoscript-compiler tests, real mainnet boxes, synthetic VLQ/SType edge cases) and asserts both structural parse correctness AND byte-identical round-trip. Current state: 255 passing fixtures + 1 mainnet stub + 6 fixtures flagged `known_unstable` (upstream sigma-rust itself does not round-trip them; tracked in `fixture-gen/known_unstable.json`).
2. **Layer 2 — Evaluation correctness**: per-arm unit tests under `test/eval/*.test.ts` (one file per implemented arm) cover happy paths, every `EvalError` code, and cost telemetry assertions. Layer C2 (`test/corpus-eval.test.ts`) cross-checks the TS evaluator against the sigma-rust eval oracle on every `mainnet_boxes` fixture whose body is fully covered by the implemented arms — 18 / 173 such fixtures are currently evaluable by sigma-rust under a synthetic-empty context; the rest hit `not-implemented-yet` and are skipped (informational aggregate logged). The 18 evaluable mainnet trees all still hit `'not-implemented-yet'` after phase 2d-A (they require arms beyond the current 15 — method calls, context access, collection HOFs, etc.); `other=0` confirms no undocumented codes are emitted. Phase 2d slice B + phases 2e+ will progressively unlock more fixtures as arms land.
3. **Layer 3 — Mutation tests**: `test/parse-mutation.test.ts` performs single-byte flips at varied offsets across every fixture and asserts each mutation either throws one of the typed error classes above OR is byte-identical (a flip that lands in a tolerated padding region). Current state: 6221 mutations exercised; 66% throw a typed error class, 0 throw an untyped error, 100% taxonomy coverage (every error class above is hit at least once).
4. **Cross-runtime**: vitest runs every test under both `node` and `jsdom` environments. Current state: 1466/1466 ergoscript tests + 305 proof tests = 1771 total, passing in both runtimes.

## v0.2.0 — Evaluator surface (phase 2b)

The phase 2b release adds a public evaluator entry point and the supporting context / cost / error types. Wire-format parse + serialize are unchanged from v0.1.0 (phase 2a); this section is purely additive.

### Public exports added in v0.2.0

```ts
evaluate(tree: ErgoTree, opts?: EvalOpts): SValue
evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue

makeContext(opts?: EvalOpts): EvalContext

class EvalError extends Error { code: string }

interface EvalOpts {
  jitCostLimit?: number          // undefined = unlimited (signing-style)
  constants?: SValue[]           // overrides tree.constants for ConstPlaceholder
}

interface EvalContext extends EvalOpts {
  jitCost: number                                                  // mutable accumulator
  addCost(amount: number): void
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
}
```

`Env`, `evalExpr`, and the per-arm functions (`evalConst`, `evalIf`, `evalBlockValue`, …) are intentionally NOT exported — they are internal to the evaluator and may change without notice. Callers compose evaluation via the four entry points above.

#### `evaluate(tree, opts?)`

- **Precondition:** `tree` is a valid `ErgoTree` (typically returned by `parseTree`). `opts.constants`, when provided, must be parallel to whatever set of `ConstantPlaceholder` ids the tree's body references.
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body` under a freshly constructed `EvalContext`. The context is initialised with `constants: opts.constants ?? tree.constants` (so callers who want the tree's segregated constants picked up automatically don't need to do anything extra) and `jitCostLimit: opts.jitCostLimit` (defaulting to `undefined` = unlimited).
- **Postcondition (failure):** Throws `EvalError` with one of the codes enumerated below. Errors raised from inside the recursive evaluator (e.g. an unhandled variant deep inside a `BlockValue`) bubble up unwrapped — `evaluate` does not catch and rewrap.
- **Coverage caveat:** Only 15 of ~70 `Expr` variants currently have implemented arms (`Const`, `ConstPlaceholder`, `BlockValue`, `ValDef`, `ValUse`, `Tuple`, `Collection`, `If`, `BinOp`, `LogicalNot`, `BoolToSigmaProp`, `Negation`, `BitInversion`, `Upcast`, `Downcast`). Any tree whose body — or whose evaluation reaches — any other variant throws `EvalError 'not-implemented-yet'`. Phase 2d slice B and phases 2e–2h add the remaining arms; the `evaluate` signature itself is stable.

#### `evaluateWith(tree, ctx)`

- **Precondition:** `tree` is a valid `ErgoTree`. `ctx` is a caller-constructed `EvalContext` (typically from `makeContext(opts)`); the caller is responsible for setting `ctx.constants` if `ConstantPlaceholder` resolution is desired (`evaluateWith` does NOT default it from `tree.constants`, in contrast with `evaluate`).
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body` under the supplied `ctx`. The context is mutated in place — after the call returns, callers may inspect `ctx.jitCost` to read the total cost charged. This is the entry point used by tests and tooling that need post-eval cost telemetry.
- **Postcondition (failure):** Same `EvalError` taxonomy as `evaluate`. The context's `jitCost` reflects all cost charged up to (and including) the point of the throw — partial costs are NOT rolled back.

#### `makeContext(opts?)`

- **Precondition:** `opts` is a (possibly empty) `EvalOpts`.
- **Postcondition:** Returns a fresh `EvalContext` with `jitCost: 0`, `jitCostLimit: opts.jitCostLimit`, `constants: opts.constants`, and the `addCost` / `addPerItemCost` methods bound to the returned object.
- **Determinism:** Pure constructor; no I/O, no clock, no PRNG. Same opts in, structurally equivalent context out.

#### `EvalContext.addCost(amount)`

- **Semantics:** Saturating add — `ctx.jitCost = Math.min(ctx.jitCost + amount, Number.MAX_SAFE_INTEGER)`. The clamp is a defensive guard; in practice the cost limit (if set) trips long before saturation matters.
- **Limit enforcement:** If `ctx.jitCostLimit !== undefined` and the new total exceeds it, throws `EvalError 'cost-limit-exceeded'`. The throw happens *after* the cost is added to `jitCost` — callers inspecting `jitCost` after a cost-limit failure see the over-limit total, not the pre-add value.
- **Mirror of:** sigma-rust `Context::add_jit_cost` (`ergotree-ir/src/chain/context.rs:77-86`).

#### `EvalContext.addPerItemCost(base, perChunk, chunkSize, nItems)`

- **Semantics:** Composite charge — `addCost(base + ceil(nItems / chunkSize) * perChunk)`. Used by `BlockValue` envelope (`addPerItemCost(1, 1, 10, items.length)`); will be reused by phase 2f's collection HOFs.
- **Limit enforcement:** Inherits from `addCost`; the *total* composite charge is checked against `jitCostLimit` after addition (not split into base + per-chunk sub-checks).
- **Mirror of:** sigma-rust `Context::add_per_item_jit_cost` (`ergotree-ir/src/chain/context.rs:88-99`).

### `EvalError` taxonomy (v0.2.0)

`EvalError` carries a `code: string` distinct from the wire-layer error classes. Every code below is emitted by current source under the conditions noted.

- **`'not-implemented-yet'`** — central dispatch (`eval/eval.ts`) hit an `Expr` variant with no arm yet (60+ variants in v0.2.0). The arm tasks in phases 2c-2g progressively replace these with explicit cases. Message includes the offending `tag`.
- **`'cost-limit-exceeded'`** — `EvalContext.addCost` (and therefore `addPerItemCost`) detected `ctx.jitCost > ctx.jitCostLimit` after a charge. Only raised when the caller set `jitCostLimit` (the default of `undefined` skips the check entirely). Message includes the configured limit.
- **`'val-def-outside-block'`** — the `ValDef` arm was reached at the top level (or as an arbitrary sub-expression). `ValDef` is only structurally valid as an item inside `BlockValue.items`; reaching it elsewhere is a malformed-tree error. Mirrors sigma-rust's `EvalError::UnexpectedExpr` rejection in `eval.rs:66-68`.
- **`'val-use-unbound'`** — `ValUse(id)` referenced a `valId` with no binding in the current `Env`. The cost (5) is charged BEFORE the env lookup, mirroring sigma-rust, so an unbound `ValUse` still consumes 5 jitCost. Message includes the missing `valId`.
- **`'const-placeholder-id-out-of-range'`** — `ConstPlaceholder(id)` referenced an `id >= ctx.constants.length`. Message includes both `id` and `constants.length`.
- **`'const-placeholder-no-constants'`** — `ConstPlaceholder` was reached but `ctx.constants` is `undefined`. Most commonly hit when calling `evaluateWith` without setting `ctx.constants` (the higher-level `evaluate` defaults it from `tree.constants`).
- **`'if-condition-not-boolean'`** — the `If` arm's `condition` evaluated to an `SValue` whose `kind !== 'Boolean'`. Message includes the actual `kind`. Sigma-rust raises `EvalError::TryExtractFrom` here; we surface it as a typed code for cleaner programmatic dispatch.
- **`'collection-elem-kind-mismatch'`** — inside the `Collection` arm with `kind: 'Exprs'`, an evaluated item's `kind` did not match the declared `elemTpe`. This is a fail-fast guard that sigma-rust does not perform at eval time (the upstream type checker is supposed to have caught it); we add it as a defensive check on the verifier path. Only primitive types are validated; composite types (`SColl`, `STuple`, etc.) and chain-state types (`SBox`, `SAvlTree`, …) currently always match (deferred to later phases). Message includes the offending index, the actual `kind`, and the expected `tag`.
- **`'block-item-not-val-def'`** — inside the `BlockValue` arm, `items[i].tag !== 'ValDef'`. Mirrors sigma-rust's `EvalError::UnexpectedExpr` rejection in `block.rs:13-65`. Message includes the offending index and tag.

The following codes were added in phase 2c (BinOp / LogicalNot / BoolToSigmaProp arms):

- **`'arith-overflow'`** — `BinOp.Arith` (Plus / Minus / Multiply / Divide / Modulo) computed a result outside the operand kind's signed range. Mirrors sigma-rust's checked arithmetic via `NumOps::checked_*`. Message includes the op name, the kind, and the offending bigint result.
- **`'arith-divide-by-zero'`** — `BinOp.Arith.Divide` or `Modulo` with a right operand of zero. Checked before performing the operation. Message includes the op name.
- **`'bin-op-kind-mismatch'`** — operands of a BinOp that requires both operands to share the same kind (Arith, Bit, Relation-ordering) had different kinds. `Eq` and `NEq` do NOT throw this — they return `false` on kind mismatch instead. Message includes the op name, left kind, and right kind.
- **`'bin-op-not-numeric'`** — operand kind not in `{Byte, Short, Int, Long, BigInt}` for an op requiring numeric operands (Arith, Bit, Relation-ordering). Message includes the op name and the offending kind.
- **`'bin-op-not-boolean'`** — operand kind not `Boolean` for an op requiring Boolean operands (Logical ops, `LogicalNot`, `BoolToSigmaProp`). Message includes the op name and the offending kind.

The following code was added in phase 2d-A (numeric-polymorphism unary arms — Negation, BitInversion, Upcast, Downcast):

- **`'downcast-overflow'`** — `Downcast` arm narrowed an input value outside the target kind's signed range. Mirrors sigma-rust's `ArithmeticException` from `eval/downcast.rs`; surfaced as a distinct code (separate from `'arith-overflow'`) so callers can dispatch on "downcast specifically failed" vs other arith overflows. Message includes the offending bigint value, the target kind, and the target's signed range.

Note: `Negation` reuses `'arith-overflow'` (same semantic as `BinOp.Arith` overflow — `Negate(MIN_K)` is the only case). `BitInversion` has no overflow path (`maskToKind` always lands in range). `Upcast` has no overflow path (widening preserves the value). All four phase 2d-A arms reuse `'bin-op-not-numeric'` for non-numeric input, per the `LogicalNot` / `BoolToSigmaProp` precedent.

Note: shift ops (`BinOp.Bit.BitShiftLeft / BitShiftRight / BitShiftRightZeroed`) are not implemented — they throw `'not-implemented-yet'`, matching sigma-rust's `EvalError::Misc("no interpreter eval — use SNumericTypeMethods.shiftLeft/Right")` posture. A `'bit-shift-out-of-range'` code is reserved for when shift ops land via `SNumericTypeMethods` in a later phase (not currently emitted).

No other error codes are emitted by the v0.2.0 evaluator. Internal panics (e.g. a bug in a wire-layer helper called from an arm) bubble up as their typed error class (`ExprParseError`, `SValueParseError`, etc.) — those represent contract violations and are bugs, not eval-input issues.

### Coverage and stability

- **15 / ~70 `Expr` variants** have arms in v0.2.0 (8 from phase 2b + 3 from phase 2c: `BinOp`, `LogicalNot`, `BoolToSigmaProp` + 4 from phase 2d-A: `Negation`, `BitInversion`, `Upcast`, `Downcast`). Everything else throws `'not-implemented-yet'`. Real-world ErgoTree trees from the `mainnet_boxes` corpus are filtered against this coverage by `test/corpus-eval.test.ts` — only fixtures whose body uses exclusively the supported variants are exercised against the sigma-rust eval oracle for byte-equality.
- **Public function signatures are stable** from v0.2.0 onward. Future arms slot into the central dispatch (`eval/eval.ts`) without changing `evaluate`, `evaluateWith`, `makeContext`, or `EvalError`.
- **`EvalOpts` is open for additive growth.** Phase 2e introduces chain-state fields (`height`, `selfBox`, `inputs`, `outputs`, `dataInputs`, `preHeader`, `headers`, `extension`, `treeVersion`); they will be added as optional properties so existing callers remain source-compatible.
- **No new runtime dependencies** in v0.2.0. Phase 2g (sigma protocol) introduces `@noble/curves`; that's the next dep wave.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — design rationale, phase plan, validation strategy, risks
- `facts/proof.md` — companion interface contract (and structural template for this file)
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language specification for opcode semantics
- `~/projects/ergo_avltree_rust/` (branch `main`, HEAD `879545c`) — phase 2h pre-warning; reference AVL+ implementation with three upstream PRs applied (#10, #11, #13)
