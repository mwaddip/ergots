# `@ergots/ergoscript` — Wire Format Contract

This file documents the **wire-format slice** of the `@ergots/ergoscript` boundary contract (phase 2a). For cross-cutting guarantees (browser-compat, determinism, ESM-only, no-WASM, runtime deps) and forward pointers to other slices, see [`facts/ergoscript.md`](./ergoscript.md). For the evaluator surface (which consumes the `SValue` / `SType` / `Expr` types this layer produces) see [`facts/ergoscript-eval.md`](./ergoscript-eval.md). For sigma-protocol verification see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md).

Authoritative wire-format reference: sigma-rust's `ergotree-ir/src/ergo_tree.rs`, `ergotree-ir/src/serialization/`, and `ergotree-ir/src/mir/` (branch `integration/ergots`, HEAD `ed5452cf`). Where this file is silent, those are canonical.

## Scope

Ships in this contract (phase 2a — wire format):

1. Parse + serialize for the ErgoTree envelope: header byte, optional VLQ-u32 body size, optional segregated constants section, body Expr.
2. Parse + serialize for the full `Expr` discriminated union (68 variants — see `mir/types.ts`), wired through a central opcode-dispatch switch.
3. Parse + serialize for `SType` (the type-system union) and `SValue` (the runtime-value union), including all primitive variants, `SColl`, `STuple`, `SOption`, `SFunc`, `STypeVar`.
4. Parse for `SigmaBoolean` (the recursive proposition tree inside `SSigmaProp` constants). Phase 2g-medium replaced the opaque-bytes representation with a structural 6-variant discriminated union — see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) for the runtime type and verifier; the wire parser produces all 6 variants byte-equal on round-trip.
5. P2PK recognition + 33-byte public-key extraction.
6. Base58check address ↔ `ErgoTree` round-trip for mainnet and testnet (P2PK and P2S).
7. Stateless: no I/O, no clock, no PRNG, no `globalThis` reads. (Cross-cutting browser/determinism guarantees: see the meta file.)

## Public surface

### Primary exports

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
type Network = 'mainnet' | 'testnet'
type AddressType = 'P2PK' | 'P2S'
type ErgoTree, TreeHeader
```

### `parseTree(bytes)`

- **Precondition:** `bytes.length >= 1` and `bytes.length <= MAX_TREE_SIZE` (1 MB). The cap mirrors sigma-rust's practical bound (largest real-world ErgoTree in the PR 862 corpus is ergoraffle at 931 bytes); 1 MB is comfortably above that ceiling while bounding memory against adversarial inputs.
- **Postcondition (success):** Returns an `ErgoTree` whose `serializeTree` is byte-identical to the input. See `Round-trip invariant` below.
- **Postcondition (failure):** Throws `ErgoTreeParseError` for envelope-level malformations (`empty`, `oversized`, `body-size-overflow`, `too-many-constants`). Body-parse failures surface as `ExprParseError` from the body parser; SType / SValue failures surface as `STypeParseError` / `SValueParseError` / `SigmaBooleanParseError`. The envelope does not wrap them — callers see the typed failure surface from the innermost layer that rejected the bytes. `ReaderError` from the underlying cursor may also surface (`truncated`, `vlq-overflow`).

### `serializeTree(tree)`

- **Precondition:** `tree` was either returned from `parseTree` or constructed satisfying the type invariants below. The `header.rawHeader` byte MUST be derivable from `header.version`, `header.hasSize`, and `header.constantSegregation` (the projection is round-trip-checked at serialize time). `constantTypes.length === constants.length` is required.
- **Postcondition:** Returns `Uint8Array` of length ≤ `MAX_TREE_SIZE`. For any `tree` returned by `parseTree(b)`, `serializeTree(parseTree(b))` equals `b` byte-for-byte.
- **Postcondition (failure):** Throws `ErgoTreeSerializeError` with `code` `'header-inconsistent'` (rawHeader mismatch) or `'constants-arity-mismatch'`. Body-serialize failures surface as `ExprSerializeError` (notably `'not-supported'` for the un-encodable `ZkProofBlock` variant).

### `isP2PK(tree)` / `p2pkPublicKey(tree)`

- **Precondition:** `tree` is a valid `ErgoTree`.
- **Postcondition (`isP2PK`):** Returns `true` iff the tree's body is the canonical P2PK shape — `Const(SSigmaProp, ProveDlog(EcPoint))` or a `ConstPlaceholder` resolving to the same — matching sigma-rust's `Address::P2Pk.script()` recognition (`ergotree-ir/src/chain/address.rs:206-218`).
- **Postcondition (`p2pkPublicKey`):** Returns a defensive 33-byte copy of the compressed secp256k1 public key when `isP2PK(tree)` is true, else `null`. The returned buffer is fresh — mutating it does not affect the tree's internal storage.
- **Invariant:** Trees whose body is `CreateProveDlog(GroupElement)` (a derived form) are NOT classified as P2PK — sigma-rust only recognizes the canonical `Const(SSigmaProp, _)` form. Using a non-canonical shape would break the address → tree → address round-trip against any other Ergo implementation.

### `addressFromErgoTree(tree, network)` / `ergoTreeFromAddress(address)`

- **Precondition (`addressFromErgoTree`):** `tree` is a valid `ErgoTree`; `network` is `'mainnet'` or `'testnet'`.
- **Postcondition (`addressFromErgoTree`):** Returns a base58check Ergo address. If `isP2PK(tree)`, the address is P2PK (content bytes are the 33-byte EcPoint only, NOT the serialized tree). Otherwise the address is P2S (content bytes are the full serialized ErgoTree).
- **Precondition (`ergoTreeFromAddress`):** `address` is a base58check Ergo address with valid checksum and a supported address type.
- **Postcondition (`ergoTreeFromAddress`):** Returns the `ErgoTree` encoded by the address. P2PK addresses are reconstructed by synthesizing canonical bytes (`0x00 0x08 0xcd <33 bytes pubkey>`) and parsing them — every returned tree goes through `parseTree`, so the type invariants below hold.
- **Postcondition (failure):** Throws `AddressDecodeError` with `code` `'bad-base58'`, `'too-short'`, `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, or `'unknown-type'`. A P2S address carrying malformed tree bytes throws `ErgoTreeParseError` (or a downstream parser error) — those bubble up unwrapped.
- **Round-trip invariant:** For any tree `t` and matching network `n`, `ergoTreeFromAddress(addressFromErgoTree(t, n))` parses to a structurally equivalent `ErgoTree`. P2SH addresses are NOT round-trippable through this function (they are derived from a 24-byte hash, not a serialized tree) and decoding one throws `p2sh-unsupported`.

## Internal modules (current monorepo surface)

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
parseSValue(tpe: SType, treeVersion: number, r: ByteReader): SValue
serializeSValue(tpe: SType, v: SValue, treeVersion: number, w: ByteWriter): void

// wire/ergo-tree.ts — serializer-level constant substitution (body copied
// verbatim); consumed by the SubstConstants eval arm. See the A2-b subsection.
substituteConstantsBytes(
  scriptBytes: Uint8Array,
  positions: number[],
  newValues: SValue[],
  newValuesElem: SType,
  treeVersion: number,
): { bytes: Uint8Array; numConstants: number }

// wire/sigma-boolean.ts
parseSigmaBoolean(r: ByteReader): SigmaBoolean
serializeSigmaBoolean(sb: SigmaBoolean, w: ByteWriter): void
sigmaBooleanOpCode(sb: SigmaBoolean): number | null
proveDlogPublicKey(sb: SigmaBoolean): Uint8Array | null

// wire/reader.ts / wire/writer.ts
class ByteReader
class ByteWriter

// mir/expr-tpe.ts
exprTpe(e: Expr): SType

// mir/method-signatures.ts (consulted by exprTpe for MethodCall/PropertyCall)
interface MethodSignature { tDom: readonly SType[]; tRange: SType; tpeParams?: readonly STypeVar[] }
methodSignature(typeId: number, methodId: number): MethodSignature | undefined
resolveReturnTpe(sig: MethodSignature, receiver: SType, argTpes: readonly SType[], explicitTypeArgs: Record<string, SType>): SType
```

`parseExpr` accepts the parallel-indexed segregated constant arrays from the surrounding ErgoTree envelope. `constantTypes` is consulted by the `ConstantPlaceholder` handler to recover a placeholder's `SType` from its id; `constantValues` is reserved for substitution-at-parse-time semantics (sigma-rust's `substitute_placeholders` flag — not currently used). `valDefTypes` is a shared scope-wide `Map<ValId, SType>` populated by `ValDef` parsers and read by `ValUse` parsers (mirrors sigma-rust's `SigmaByteReader.val_def_type_store`); the outer envelope creates a fresh empty map per tree, and recursive descent shares it across the whole Expr graph.

**Method-call return-type resolution (phases A3 + v6 P0 + v6 P1).** For `MethodCall`/`PropertyCall`, `exprTpe` consults the declarative signature catalog `mir/method-signatures.ts` (keyed by `(typeId, methodId)`, transcribing the method's `SFunc` signature — v5 entries from sigma-rust, v6 from JVM `sigma-state`) and applies `resolveReturnTpe(sig, receiver, argTpes, explicitTypeArgs)` — where `receiver = exprTpe(obj)` and `argTpes = args.map(exprTpe)` (the substitution inputs). Contract:

- **Registered, closed `tRange`** → returns `tRange` verbatim (e.g. `getEncoded` (7:2) → `Coll[SByte]`, `indices` (12:14) → `Coll[SInt]`).
- **Registered, type-var `tRange`** → `tRange` with type vars bound from `receiver`/`argTpes`/`explicitTypeArgs` via the substitution engine (`mir/type-unify.ts`, ≡ JVM `MethodCall.tpe()`); an operand that cannot bind a var leaves a residual that falls back to `{ tag: 'SAny' }`. First registered generic-output method: `patch` (12:19) → `Coll[IV-of-receiver]` (v6 P0). Second-wave generic-output consumers: the v6 P1 bitwise/shift methods (typeIds 2–6, methodIds 8–13) all have `tRange = tNum` bound from the receiver's numeric type.
- **Unregistered** → `{ tag: 'SAny' }` — the documented placeholder treated as a wildcard by `sTypeEqualsModuloSAny`/`hasSAny`. **Never throws** (contrast genuinely-unparsed Expr variants, which still throw `ExprTpeError('tpe-not-implemented')`).

The catalog grows by descriptor-addition and is populated via `numericV6Signatures()` for v6 P1. Current catalog entries (v6 P7a era):

| (typeId:methodId) | Method | `tRange` kind | `tRange` |
|---|---|---|---|
| 7:2 | `SGroupElement.getEncoded` | closed | `Coll[SByte]` |
| 7:6 | `SGroupElement.expUnsigned` | closed | `SGroupElement` |
| 12:14 | `SColl.indices` | closed | `Coll[SInt]` |
| 12:19 | `SColl.patch` | generic | `Coll[IV]` (IV binds from receiver elem) |
| 2:6, 3:6, 4:6, 5:6, 6:6 | `Byte/Short/Int/Long/BigInt.toBytes` | closed | `Coll[SByte]` |
| 2:7, 3:7, 4:7, 5:7, 6:7 | `Byte/Short/Int/Long/BigInt.toBits` | closed | `Coll[SBoolean]` |
| 2:8–13, 3:8–13, 4:8–13, 5:8–13, 6:8–13 | `bitwiseInverse`/`Or`/`And`/`Xor`/`shiftLeft`/`shiftRight` | generic | `tNum` (TNum binds from receiver numeric type) |
| 99:19 | `SBox.getReg[T]` | generic | `SOption[T]` (T binds from `explicitTypeArgs['T']`) |
| 101:12 | `SContext.getVarFromInput[T]` | generic | `SOption[T]` (T binds from `explicitTypeArgs['T']`) |

The catalog shares the `(typeId, methodId)` namespace with the eval handler registry (`eval/method-call.ts`) — see the dual-table sync invariant in [`facts/ergoscript-eval.md`](./ergoscript-eval.md). Specs: `docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md`, `docs/specs/2026-06-02-ergoscript-v6-p0-typevar-substitution-engine-design.md`.

**Now re-exported (resolving the early-build "export or keep internal" deferral, 2026-06-03):**
`parseSigmaBoolean` / `serializeSigmaBoolean` and their error classes `SigmaBooleanParseError` /
`SigmaBooleanSerializeError` are re-exported top-level from the package index (`src/index.ts`,
alongside `parseSValue`/`serializeSValue`) — for downstream wire-conformance consumers (e.g. SANTA's
dasher) that round-trip a **bare** SigmaBoolean (op_code + payload, no SValue/SType framing, so
`parseSValue` cannot reach it). `sigmaBooleanOpCode` / `proveDlogPublicKey` remain shape-documented
but are NOT re-exported (no consumer demand); the other wire symbols above are documented-shape only.

Once the package's wire surface stabilizes, all of these will likely move behind a `/wire` subpath
export (the proof package's `/envelope` pattern); until then this file documents their current shape so
downstream packages can rely on them.

## Round-trip invariant

For any byte sequence `b` accepted by `parseTree`:

```
serializeTree(parseTree(b)) === b   (byte-equal)
```

This holds for every ErgoTree variant we ship. The phase 2a corpus test asserts this on 255 passing fixtures plus 1 mainnet-fixture stub plus 6 upstream-buggy fixtures (the 6 are excluded from byte-equality; sigma-rust itself does not round-trip them — see `fixture-gen/known_unstable.json`).

**A parse→serialize exception class (F5 batch 1, 2026-06-08):** trees whose serialized types
include an arity-0/1 generic-tuple TYPE (`0x60` + len 0/1) PARSE but cannot re-serialize —
`serializeSTuple` throws `'tuple-too-short'`, mirroring the JVM's own asymmetry
(`TypeSerializer.scala:188-194` parse has no arity require; `:93-94` serialize `sys.error`s < 2).
The reverse-direction precedent is the AvlTree any-length-digest note.

**Carve-out 2 (F5 batch 1, 2026-06-08) — noncanonical Option tags:** any wire Option tag byte
> 0x01 parses as Some (JVM scorex-util `getOption`: ANY nonzero = Some) but re-serializes to
the canonical `0x01` — so `serializeTree(parseTree(b)) ≠ b` for trees carrying noncanonical
tags (SOption DATA constants, `DeserializeRegister.default`, `ByIndex.default`, SAvlTree
`valueLengthOpt`). The JVM has the identical asymmetry (`putOption` emits 1/0); it round-trips
such trees only because `ErgoTree` RETAINS original bytes rather than re-serializing
(`ErgoTree.scala:65-67,123-131`) — ergots likewise retains verbatim slices where consensus
reads bytes (SBox `ergoTreeBytes`). Tooling note: `addressFromErgoTree` re-serializes, so a
noncanonical on-chain tree yields a different P2S address than a JVM node derives from
retained bytes — tooling-level, not consensus.

For the body-only round-trip (i.e., parsing a `parseExpr` output and reserializing through `serializeExpr` into a fresh `ByteWriter`), the same byte-equality invariant holds.

## Type invariants (wire-side shapes)

These hold on every `ErgoTree` returned by the public API. Callers may rely on them without re-checking. The discriminated-union types `SValue`, `Expr`, and `SigmaBoolean` are shared across slices — see [`facts/ergoscript-eval.md`](./ergoscript-eval.md) for the canonical `SValue` / `SType` / `Expr` definitions and [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) for `SigmaBoolean`.

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
```

- `rawHeader` is the on-wire byte. The `version`, `hasSize`, `constantSegregation` fields are derived projections kept on the struct so callers don't need to re-decode bits. `serializeTree` writes `rawHeader` directly but validates that it matches the derived fields — a hand-constructed `ErgoTree` with inconsistent fields is rejected at serialize time with `'header-inconsistent'`.
- `constantTypes` is parallel to `constants[]` and carries the per-constant `SType` recovered from the wire. It's necessary because a parsed `SValue` does not unambiguously encode its `SType` for some edge cases (empty `Coll`, `None` for `SOption`); sigma-rust avoids this because its `Constant { tpe, v }` couples them at the struct level.
- `ErgoBox` and `AvlTreeData` shapes are stable: `ErgoBox` was promoted in phase 2f Stop α and `AvlTreeData` in phase 2h-b. `Closure` remains forward-declared until the FuncValue/Apply evaluator arms land. Evaluator-only fields may still be added in later phases (see [`facts/ergoscript-eval.md`](./ergoscript-eval.md)).

## Error taxonomy (wire-layer error classes)

Every wire-layer error class carries a `code: string` matching one of a fixed set of structural reasons for programmatic dispatch. `.message` is human-readable.

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

- **`ErgoTreeParseError`**: `'empty'`, `'oversized'`, `'body-size-overflow'`, `'too-many-constants'`, `'header-inconsistent'`, `'subst-length-mismatch'`, `'subst-type-mismatch'` (the last two from `substituteConstantsBytes`; the eval arm re-wraps them as `EvalError('subst-constants-error')`), `'header-version-requires-size'` (F5 batch 3 — rule-1012 `CheckHeaderSizeBit`: a tree header with version > 0 and the size bit (0x08) clear is rejected at parse, mirroring JVM `ValidationRules.scala:138-151` enforced at `ErgoTreeSerializer.scala:219`; applies to the main tree header AND substConstants template headers; unconditional; adversarial-only — mainnet v>0 trees carry the size bit).
- **`ErgoTreeSerializeError`**: `'header-inconsistent'`, `'constants-arity-mismatch'`.
- **`ExprParseError`**: `'opcode-reserved'` (18 sites — reserved in sigma-rust's `OpCode` enum but never dispatched at the wire-Expr layer or implemented in `ergotree-interpreter/src/eval/`; covers `OpTrue`, `OpFalse`, `UnitConstant`, `Select1..Select5`, `SomeValue`, `NoneValue`, `ModQ`, `PlusModQ`, `MinusModQ`, `CollShiftLeft/Right/RightZeroed`, `CollRotateLeft/Right`; added phase 2i-d, renamed from `'not-implemented-yet'` to reflect permanent-state rather than forward-promise; **was 19 — `FunDef` (`0xd7`) removed in v6 P6, now parsed as a `ValDef` carrying `tpeArgs`, see the P6 wire section below**); `'not-implemented-yet'` (4 wire sites still using it — `LastBlockUtxoRootHash`, `FlatMap`, `TrivialPropFalse`, `TrivialPropTrue` — routed through other dispatch paths in sigma-rust (PropertyCall id 9, SColl method-call, SSigmaProp nesting); top-level direct-dispatch status undetermined pending separate review; ALSO emitted by the `EvalError` class for legitimately-TBD eval support — distinguished from this wire-layer use by error class); `'unknown-opcode'` (byte not in sigma-rust's opcode table at all); plus per-variant codes including `'apply-too-many-args'`, `'block-too-many-items'`, `'collection-size-out-of-range'`, `'deserialize-context-id-out-of-range'`, `'deserialize-register-id-out-of-range'`, `'extract-register-as-id-out-of-range'`, `'func-value-too-many-args'`, `'fun-def-tpe-arg-not-type-var'` (v6 P6 — a declared `FunDef` type-arg did not parse to an `STypeVar`; see the P6 wire section below), `'get-var-id-out-of-range'`, `'invalid-binop-opcode'`, `'invalid-constant-placeholder-id'`, `'method-call-id-out-of-range'`, `'method-call-missing-type-arg'`, `'method-call-too-many-args'`, `'property-call-id-out-of-range'`, `'select-field-index-out-of-range'`, `'tuple-arity-out-of-range'`, `'unknown-binop-kind'`, `'val-def-rhs-tpe'`, `'val-use-unknown-id'`. (**`'invalid-option-tag'` RETIRED in F5 batch 1, 2026-06-07**: its sole remaining site,
`DeserializeRegister.default`, now follows JVM `DeserializeRegisterSerializer.scala:30`
`r.getOption(r.getValue())` — ANY nonzero tag → Some(parse Expr). **`'tuple-arity-out-of-range'`
re-scoped same date**: parse rejects count ≥ 128 ONLY (JVM `TupleSerializer.parse` reads the
count via signed `getByte()` — 0x80..0xFF go negative into `safeNewArray` →
`NegativeArraySizeException`; arity 0/1 PARSES on the JVM, `mkTuple` is bare and `Tuple.tpe`
lazy, and rejects at EVAL — `'tuple-invalid-arity'`); serialize rejects > 255 only
(`putUByte` range — JVM serialize has no arity gate, so arity 128..255 serializes but cannot
re-parse, a JVM-mirrored asymmetry).)
- **`ExprSerializeError`**: `'not-supported'` (the `ZkProofBlock` variant — matches sigma-rust's `NotSupported`); `'unknown-variant'` (compile-time-unreachable fallback for the exhaustive switch); `'property-call-missing-type-arg'` (v6 P4 — `serializePropertyCall` found a type-parameter name in `explicitTypeArgNames(typeId, methodId)` absent from `e.explicitTypeArgs`; defensive, unreachable from a well-parsed tree; mirrors the pre-existing `'method-call-missing-type-arg'` on the `ExprParseError` side).
- **`STypeParseError`**: `'invalid-type-code'`, `'unsupported-type'`, `'invalid-stypevar-length'`, `'invalid-stypevar-utf8'`, `'invalid-sfunc-tpe-params'`. (**`'invalid-tuple-length'` RETIRED in F5 batch 1, 2026-06-07**: the generic-tuple TYPE parse
arm now mirrors JVM `TypeSerializer.scala:188-194` — `getUByte` + bare `STuple(items)`, no
arity require, so arity-0/1 generic-tuple TYPES parse; the TYPE serializer keeps rejecting
< 2 (`'tuple-too-short'`, mirroring `TypeSerializer.scala:93-94` `sys.error`) — parse/serialize
asymmetric on the JVM itself.)
- **`STypeSerializeError`**: `'tuple-too-short'`, `'tuple-too-long'`, `'stypevar-name-length'`, `'sfunc-tdom-too-long'`, `'sfunc-tpe-params-too-long'`, `'unreachable'`.
- **`SValueParseError`**: `'bigint-too-large'`, `'coll-length-out-of-range'`, `'not-implemented-phase-2a'` (still emitted for `SPreHeader`/`SContext`/`SGlobal`/`SAny`/`SString`/`SFunc`/`STypeVar`; `SBox` removed in phase 2f Stop α, `SAvlTree` removed in phase 2h-b, `SHeader` removed in phase 2h-c.1), `'sheader-tree-version-too-low'` (SHeader SValue constant in a tree-version < 3 ErgoTree; mirrors sigma-rust `serialization/data.rs:196`), `'soption-tree-version-too-low'` (SOption SValue constant in a tree-version < 3 ErgoTree;
mirrors JVM `CoreDataSerializer.scala:140-143` — pre-v3 Option DATA falls through to
`CheckSerializableTypeCode`/ValidationRule 1009 + `SerializerException`; recursive — Option
nested anywhere in a constant's type tree rejects; shipped F5 batch 1 2026-06-07), `'unreachable'`, `'sbox-tokens-out-of-range'`, `'sbox-registers-out-of-range'`, `'sbox-creation-height-out-of-range'` (parse rejects creation_height > u32, matching sigma-rust `get_u32`; audit follow-up), `'sbox-index-out-of-range'` (parse rejects index > u16, matching `get_u16`; previously serialize-only), `'unsigned-bigint-too-large'` (UBI payload > 32 bytes; mirrors `CoreDataSerializer.scala:120`; shipped v6 P2a T3), `'register-v6-type'` (F5 batch 3 — rule-1019 `CheckV6Type`: a box register whose declared type contains `SOption` / `SHeader` / `SUnsignedBigInt` (recursing through `STuple` items + `SColl` elemType) is rejected at register ingress in `parseRegisterExprWithTag`, mirroring JVM `ValidationRules.scala:165-205` enforced at `ErgoBoxCandidate.scala:232`; **UNCONDITIONAL — all tree versions** (the rule is in both ruleSpecsV5 and ruleSpecsV6); distinct from the body-constant `'soption-tree-version-too-low'` gate and the `validate-v6-types` body pass; adversarial-only — mainnet boxes can't carry these register types. Context-extension leg deferred: ergots has no extension wire-parser yet). (`'sbox-ergo-tree-no-size'` removed in phase 2j-pre fix-1 — see changelog below.)
- **`SValueSerializeError`**: `'bigint-too-large'`, `'group-element-length'`, `'coll-length-out-of-range'`, `'coll-item-kind-mismatch'`, `'tuple-arity-mismatch'`, `'sigma-boolean-empty'`, `'type-value-mismatch'`, `'not-implemented-phase-2a'` (same deferred-kinds set as parse; `SBox` removed in phase 2f Stop α, `SAvlTree` removed in phase 2h-b, `SHeader` removed in phase 2h-c.1), `'sheader-tree-version-too-low'` (SHeader SValue with tree-version < 3 passed to `serializeSValue`; mirrors sigma-rust `serialization/data.rs:98`), `'soption-tree-version-too-low'` (serialize-side mirror, `CoreDataSerializer.scala:78-82`;
shipped F5 batch 1 2026-06-07), `'unreachable'`, `'token-id-length'`, `'txid-length'`, `'sbox-registers-not-dense'`, `'sbox-index-out-of-range'`, `'sbox-creation-height-out-of-range'` (serialize rejects creation_height > u32; audit follow-up), `'sbox-tokens-out-of-range'`, `'savltree-tree-flags-out-of-range'`, `'savltree-key-length-out-of-range'`, `'savltree-value-length-out-of-range'`, `'unsigned-bigint-too-large'` (defensive encoder guard — out-of-range UBI is an internal invariant violation, unreachable from valid parse or v6 method result, but guarded; shipped v6 P2a T3), `'unsigned-bigint-negative'` (defensive guard in `encodeUnsignedBigIntBE` when caller passes a negative bigint — unsigned type admits no negatives; shipped v6 P2a T3). (**`'savltree-digest-length'` RETIRED in F4 epilogue Task 3, 2026-06-07**: the serializer now writes the digest verbatim at any length — the JVM `DataSerializer` has no length require; parse-side remains fixed-33 — a JVM asymmetry. An AvlTree SValue with non-33-byte digest serializes fine but does NOT round-trip through parse.)
- **`SigmaBooleanParseError`**: `'arity-out-of-range'`, `'unknown-opcode'`, `'cthreshold-k-out-of-range'` (Cthreshold's `k` outside `[1, items.length]`; added phase 2g-medium), `'sigma-conjecture-empty-items'` (Cand/Cor/Cthreshold parsed with `items.length === 0`; added phase 2g-medium).
- **`ExprTpeError`** (raised by `exprTpe`, the SType-of-Expr projection): `'apply-func-not-sfunc'`, `'bin-op-kind-unhandled'`, `'by-index-input-not-scoll'`, `'option-get-input-not-soption'`, `'select-field-input-not-stuple'`, `'select-field-out-of-range'`, `'tpe-not-implemented'`.
- **`ReaderError`** (raised by `ByteReader`): `'truncated'`, `'vlq-overflow'`, `'slice-out-of-bounds'`.
- **`AddressDecodeError`**: `'bad-base58'`, `'too-short'`, `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, `'unknown-type'`.

No other wire-layer error classes are emitted by this package. Internal panics (e.g. a bug in `@noble/hashes`) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues. For runtime/eval errors see [`facts/ergoscript-eval.md`](./ergoscript-eval.md) `EvalError` taxonomy. For verifier errors see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) `VerifyError` taxonomy.

## Stop α / β / γ wire updates (phase 2f narrow — SBox)

The SBox wire-format surface closes in phase 2f Stop α. Stop β added two register-extract arms; Stop γ added three Box bytes/id arms. Wire-format-relevant additions:

- **SBox wire surface (phase 2f Stop α):** `parseSValue(SBox, …)` and `serializeSValue(SBox, …)` ship, replacing phase 2a's `'not-implemented-phase-2a'` throw for SBox specifically. Round-trip invariant byte-equal on all fixture entries. The other deferred SValue kinds (`SAvlTree`, `SHeader`, `SPreHeader`, `SContext`, `SGlobal`, `SAny`, `SString`, `SFunc`, `STypeVar`) still throw `'not-implemented-phase-2a'`.
- **`ErgoBox.registers` shape (phase 2f Stop α):** extends from `Record<number, SValue | undefined>` to `Record<number, { tpe: SType; value: SValue } | undefined>`. Per-register `SType` carriage matches sigma-rust's `NonMandatoryRegisters` storing `Constant<'static>` and is required by the downstream `ExtractRegisterAs` evaluator arm's type-assertion (see eval slice).
- **`wire/ergo-box-bytes.ts` (phase 2f Stop γ):** exports `serializeBoxBytes` and `serializeBoxBytesWithoutRef` (reusable for the wallet phase). Internal refactor: the `SBox` arm in `serialize-svalue.ts` delegates to a shared `writeBoxBodyWithoutRef` helper (no public-surface change).
- **First eval-time `blake2b` call in the package (phase 2f Stop γ):** uses the existing `@noble/hashes/blake2.js` dep from phase 2a. No new runtime dependency.

## Phase 2h-b wire updates (SAvlTree)

`parseSValue(SAvlTree, …)` and `serializeSValue(SAvlTree, …)` ship in phase 2h-b, replacing the phase-2a `'not-implemented-phase-2a'` throw. Round-trip invariant byte-equal on every fixture entry under `test/fixtures/eval/savltree-*.json` (47 entries across 13 files — 7 Tier-1 accessor fixtures + 6 Tier-2 verification-op fixtures). Other deferred SValue kinds (`SHeader`, `SPreHeader`, `SContext`, `SGlobal`, `SAny`, `SString`, `SFunc`, `STypeVar`) still throw `'not-implemented-phase-2a'`.

`AvlTreeData` is promoted from forward-declaration to stable runtime shape (`mir/types.ts`):

```ts
interface AvlTreeData {
  digest: Uint8Array              // parse: exactly 33 bytes (fixed-33 read); runtime: any length (JVM accepts any; F4 epilogue)
  treeFlags: number               // u8: bit 0 insertAllowed, bit 1 updateAllowed, bit 2 removeAllowed, bits 3-7 reserved
  keyLength: number               // u32 (VLQ-encoded on the wire)
  valueLengthOpt: number | null   // null = variable; non-null = fixed value length
}
```

The wire format mirrors sigma-rust `ergotree-ir/src/mir/avl_tree_data.rs:71-90`:

1. `digest` — **Parse:** ADDigest `scorex_parse` reads exactly 33 bytes (`read_exact(33)`; ergo-chain-types/src/digest32.rs:149-153). On-wire: 33 RAW bytes, NO length prefix. The 33rd byte is the tree-height byte. **Serialize:** the JVM `DataSerializer` writes `AvlTreeData.digest` verbatim via `putBytes` with no length requirement (F4 epilogue, 2026-06-07 — `CAvlTree.scala:31-34` no-require); any runtime digest length is written as-is. An AvlTree SValue produced by `updateDigest` with a non-33-byte digest serializes fine but does NOT round-trip through parse — an intentional JVM asymmetry.
2. `treeFlags` — single `u8` via `put_u8`. Bits 3-7 round-trip identically (no masking).
3. `keyLength` — VLQ `u32` via `put_u32` (which is `put_u64(v as u64)` in sigma-ser/src/vlq_encode.rs:78). NOT fixed 4-byte big-endian.
4. `valueLengthOpt` — `Option<Box<u32>>` SigmaSerializable (serialization/serializable.rs:212-231):
   - `Some(v)`: `0x01` tag + VLQ-u32 inner value.
   - `None`: `0x00` tag.
   - Parser is permissive: any non-zero tag byte is treated as `Some`. Serializer canonicalizes to `0x01` for `Some`.

New `SValueSerializeError` codes added by this slice: `'savltree-tree-flags-out-of-range'`, `'savltree-key-length-out-of-range'`, `'savltree-value-length-out-of-range'`. (`'savltree-digest-length'` was added here and then **retired in F4 epilogue Task 3, 2026-06-07** — the serializer now writes digest verbatim at any length, mirroring the JVM; see the `'SValueSerializeError'` taxonomy entry above.) No new `SValueParseError` codes (the parser delegates length / VLQ-overflow checks to `ByteReader`).

## Phase 2h-c.1 wire updates (SHeader)

`parseSValue(SHeader, treeVersion, r)` and `serializeSValue(SHeader, v, treeVersion, w)` ship in phase 2h-c.1, replacing the phase-2a `'not-implemented-phase-2a'` throw. Both functions delegate to `@ergots/scorex`'s `parseHeader` / `serializeHeader`. The wire format is V3-gated — V<3 trees throw `SValueParseError('sheader-tree-version-too-low')` (parse) / `SValueSerializeError('sheader-tree-version-too-low')` (serialize), mirroring sigma-rust `data.rs:196` and `:98`.

Signature change: both `parseSValue` and `serializeSValue` gain a `treeVersion: number` parameter, threaded through every recursive call site (Coll, Tuple, Option arms). `parseTree` and `serializeTree` inject `treeVersion` from `tree.header.version`.

The internal helpers `parseExpr`, `serializeExpr`, `parseConstFromByte`, and `serializeConst` also gain `treeVersion` parameters. Their **public entry points** (`parseExpr`, `serializeExpr`) accept `treeVersion` as a **required** parameter (the optional-defaulted-to-0 form was a threading-class landmine — compound nodes silently parsed nested constants at v0); callers state the version explicitly. The top-level `parseTree` / `serializeTree` always pass the correct version from the header (F5 batch 1, 2026-06-08).

Round-trip invariant byte-equal verified on 5 V3 SHeader-constant ErgoTree fixtures (single V1 header, single V2 header, `Coll[Header]` of 3, `Option[Header] = Some`, `Option[Header] = None`) plus 1 negative V2 fixture (rejects with `'sheader-tree-version-too-low'`). Mutation testing achieves ≥ 90% kill rate on structural bytes per fixture (all fixtures including `Option[Header] = None` — previously 87.5% under sigma-rust `get_option`; now all tag-byte mutations kill under JVM getOption semantics, F5 batch 1).

SOption[T] DATA: 1-byte tag — `0` = None; ANY nonzero = Some, payload follows (JVM scorex-util
`VLQReader.getOption`; SANTA-blessed `SOption.nonzero_data_tag`). NB sigma-rust `get_option`
(`1 => Some, _ => None`) is a FORK on tags ≥ 2 — no longer mirrored (F5 batch 1, 2026-06-07).
V3-gated: tree-version < 3 throws `'soption-tree-version-too-low'` (parse + serialize).

## Phase v6 P2a wire additions (`SUnsignedBigInt` type code + value codec)

`SUnsignedBigInt` is added to the `SType` union as **type code 9** (`SEmbeddable`, `SNumericType`; JVM `SType.scala:547`). Handling is permissive at the wire layer — the v3 gate lives in the evaluator's `validateV6Types` pre-eval pass (see `facts/ergoscript-eval.md`), NOT here. This matches ergots' established pattern for `validateBinOpTypes` (parser stays permissive; consensus rejection is pre-eval).

### `SUnsignedBigInt` in `parseSType` / `serializeSType`

- **Embeddable type code 9 → `{ tag: 'SUnsignedBigInt' }`** (permissive; accepted at any tree version). The JVM gates code 9 via `embeddableV6` (selected by `isV3OrLaterErgoTreeVersion`); ergots accepts unconditionally for byte-roundtrip, and the pre-eval pass enforces the gate.
- `serializeSType({ tag: 'SUnsignedBigInt' })` → emits code 9 via the `embeddablePrimitiveCode` path AND the main `serializeSType` switch (so composite type-codes `Coll[UBI]`, `Option[UBI]`, tuple-containing UBI, and `SFunc`-containing UBI all work through the normal compact-form machinery).

### `SUnsignedBigInt` in `parseSValue` / `serializeSValue` (permissive — no version check)

The codec is **distinct from `SBigInt`** (consensus-critical — different byte representations for the same numeric values):

| | `SBigInt` (existing) | `SUnsignedBigInt` (P2a) |
|---|---|---|
| Encode | `toByteArray` — signed two's-complement, minimal; high-bit-set positive ⇒ leading `0x00` | `asUnsignedByteArray` — unsigned magnitude, minimal; no sign padding |
| Decode | `new BigInteger(bytes)` — signed | `fromUnsignedByteArray(bytes)` — unsigned magnitude |
| Range | `[-2^255, 2^255−1]` | `[0, 2^256−1]` |
| `0` encodes to | `[0x00]` (1 byte, VLQ len `01 00`) | `[]` (empty, VLQ len `00`) |
| `128` encodes to | `[0x00, 0x80]` (2 bytes) | `[0x80]` (1 byte) |

Length framing: VLQ `putUShort`/`getUShort` (Scorex `putUShort` is plain VLQ, so ergots' existing `writeVlqU`/`readVlqU` is correct). Source: `CoreDataSerializer.scala:39-42, 118-124`.

**Confirmed edge cases (each a required test vector):**

- **`0` → `[]` (empty; wire `00`).** `sigma.crypto.BigIntegers.asUnsignedByteArray(0)` strips the leading zero unconditionally (`BigIntegers.scala:110-118`). The loop `while (n > 0n) { unshift(n & 0xff); n >>= 8n }` never runs for `0n` → empty array. This is the **opposite of `SBigInt`** where `0 → [0x00]`.
- **No high-bit sign padding.** `128` → `[0x80]` (1 byte). The encoder MUST be a fresh magnitude encoder — NOT a tweak of `encodeBigIntBE` (whose `unshift(0x00)` high-bit pad must NOT carry over).
- **Length-0 on the wire decodes to `0n`** (`fromUnsignedByteArray([]) → 0`; `CoreDataSerializer.scala:118-124` does NOT reject size 0). ergots **must accept** length-0 → `0n`; rejecting is stricter than the JVM = fork. (Contrast `SBigInt`, which rejects length-0 — audit ERG-03.)
- **Decode cap 32 bytes** (`> 32` ⇒ `SValueParseError('unsigned-bigint-too-large')`; `CoreDataSerializer.scala:120`).
- **Non-negative only.** The encoder guards `v < 0n` → throws (unsigned: no negatives); the decoder yields a non-negative bigint by construction.
- **Non-canonical leading-zero inputs** (e.g. `[0x00, 0x05]`) decode to `5n` and re-encode canonically as `[0x05]` — accepted but not byte-identical on a round-trip of that specific input. Do NOT assert byte-identity on non-canonical test vectors.

New helpers (paralleling `encodeBigIntBE`/`decodeBigIntBE`):

- `encodeUnsignedBigIntBE(v: bigint): Uint8Array` — `v < 0n` ⇒ throw; emit minimal unsigned BE magnitude bytes via `while (n > 0n)` loop (no high-bit pad); `0n` → `[]`.
- `decodeUnsignedBigIntBE(bytes: Uint8Array): bigint` — fold bytes as unsigned magnitude BE; `[]` → `0n`.

New `SValueParseError` codes (shipped v6 P2a T3): `'unsigned-bigint-too-large'` (`> 32` byte payload; mirrors `CoreDataSerializer.scala:120`).

New `SValueSerializeError` codes (shipped v6 P2a T3): `'unsigned-bigint-too-large'` (defensive encoder guard on out-of-range UBI — unreachable from a valid parse or a v6 method result, but guarded nonetheless); `'unsigned-bigint-negative'` (defensive guard in `encodeUnsignedBigIntBE` when a negative bigint is passed — unsigned type admits no negatives).

### `SFunc` type code 112 — pre-existing permissive parse (note)

`parseSType` accepts type code 112 (`SFunc`) unconditionally (no version gate). The JVM gates it on `isV3OrLaterErgoTreeVersion` (`TypeSerializer.scala:211`). This pre-existing over-accept is closed by the evaluator's `validateV6Types` pass (which deep-walks for `SFunc` everywhere it walks for `SUnsignedBigInt`) — the parser stays permissive for byte-roundtrip; consensus rejection is pre-eval.

## Phase 2j-pre fix-1 wire updates (`sbox-ergo-tree-no-size` removed)

`parseSValue(SBox)` at `parse-svalue.ts` now handles v0+hasSize=false ErgoTrees by delegating to a shared-reader body parse via the newly-extracted `parseTreeFromReader(r: ByteReader): ErgoTree` helper in `ergo-tree.ts`. The helper mirrors sigma-rust's `ErgoTree::sigma_parse` at `ergo_tree.rs:410-453`: the body Expr grammar is self-delimiting, so when `hasSize=false` the cursor lands at the body's end after `parseExpr` returns. `parseTree(bytes)` becomes a thin wrapper that adds the empty/size-cap check + outer-envelope exhaustion check.

Mirrors sigma-rust's `parse_box_with_indexed_digests` at `chain/ergo_box.rs:350` which calls `ErgoTree::sigma_parse(r)` directly on the shared reader.

The previously-thrown `SValueParseError('sbox-ergo-tree-no-size')` code is removed from the taxonomy enumeration above. ~99% of mainnet boxes use v0 P2PK trees without a size prefix (empirically confirmed by 2j-pre Layer-3 smoke against the bootstrap-data snapshot at heights 1, 1000, 3849); the rejection was an incorrect assumption from 2j-pre T9.

No public-API signature change. `parseTreeFromReader` is internal (exported within the package for cross-module use by `parse-svalue.ts` only).

## A2-b serializer-level substConstants (2026-06-01)

`substituteConstantsBytes(scriptBytes, positions, newValues, newValuesElem, treeVersion)` ships as the byte-surgery behind the `SubstConstants` eval arm, replacing that arm's prior `parseTree`/`serializeTree` round-trip. It mirrors JVM `ErgoTreeSerializer.substituteConstants` (`sigma-state-6.0.3`, `ErgoTreeSerializer.scala:320-411`): the header + constants segment are re-parsed and re-serialized, but the tree BODY is copied **verbatim** — never parsed as an `Expr`.

This is the consensus-faithful behavior: a crafted template whose body is not valid Expr bytes (SANTA substConstants `#1` = seg-off `[00 00 08 D3]`) is returned unchanged (0 constants ⇒ no substitution) where a full `parseTree` throws. The old round-trip path threw; JVM does not. ergots **leads** this fix — sigma-rust still uses the parse-based `with_constant` and shares the divergence (routed for sigma-rust via `~/projects/santa/prompts/ergots-v5-divergences.md` §A2). JVM is canonical.

JVM-parity details encoded in the fn (all from `ErgoTreeSerializer.scala:286-411`):
- Out-of-range positions (negative or `>= numConstants`) are a silent no-op; duplicate positions are FIRST-wins (`getPositionsBackref:286-299`).
- Every constant (substituted or not) is re-serialized via `serializeSType`/`serializeSValue` (matching JVM's `constantSerializer`), so the constants segment is NOT a verbatim copy — only the body is.
- The size prefix is re-emitted only when `treeVersion >= 3` (`isV3OrLaterErgoTreeVersion`, the V6 soft-fork; `:369-375`); for the v≤2 range ergots evaluates it is dropped, so a `hasSize` template's output omits the size slot — exactly as JVM does. `treeVersion` is the evaluation's ErgoTree version, NOT the template header's.
- The size field does NOT bound the body read (`treeBytes = r.getBytes(r.remaining)`); the body is all remaining bytes.

New `ErgoTreeParseError` codes: `'subst-length-mismatch'`, `'subst-type-mismatch'`. Validated by the SANTA conformance vector (`test/conformance/cost-v5.test.ts`, `substConstants_equivalence.json`, 7 entries incl. `#1`) + wire-fn unit tests (`test/wire/subst-constants-bytes.test.ts`), with the eval-side byte-equality canary (`test/eval/subst-constants.test.ts`) and 255 corpus fixtures as the byte-identity regression net for valid templates.

## Phase v6 P4 wire additions (PropertyCall explicit-type-args)

`SGlobal.none` (106:10) is the first method invoked via the **PropertyCall opcode** (0 args) that carries an explicit type argument `T` on the wire. This required extending the `PropertyCall` MIR node and its serializer/deserializer to match what the JVM's `PropertyCallSerializer` already does for methods with `hasExplicitTypeArgs`.

### `PropertyCall` MIR node — `explicitTypeArgs` field

The `PropertyCall` MIR node (`mir/types.ts`) gains the field:

```ts
interface PropertyCall {
  tag: 'PropertyCall'
  obj: Expr
  typeId: number
  methodId: number
  explicitTypeArgs: Record<string, SType>  // NEW (v6 P4); empty ({}) for all pre-P4 PropertyCall nodes
}
```

This mirrors the `MethodCall` node's existing `explicitTypeArgs` field. Pre-P4 `PropertyCall` nodes that carry no explicit type args parse with `explicitTypeArgs: {}` (the empty record); byte-roundtrip is unchanged.

### Wire encoding (PropertyCall explicit-type-arg tail)

**Source: JVM `PropertyCallSerializer.scala:20-49`.**

After writing `typeId, methodId, obj` (the pre-existing PropertyCall body), the serializer iterates `method.explicitTypeArgs` (the list of type-parameter names for this method, looked up from a registry) and writes one `SType` per name via `putType(typeSubst(a))`. The parser reads the same count of `SType` values after `obj`. This is byte-identical to `MethodCallSerializer`'s explicit-type-arg tail (`:23-33`) — the same registry drives both.

ergots implementation:

1. **Shared registry** — `EXPLICIT_TYPE_ARG_NAMES` (previously a private const in `wire/mir/method-call.ts`) is extracted to `wire/mir/explicit-type-args.ts`, exporting `explicitTypeArgNames(typeId, methodId): readonly string[]`. Both `parseMethodCall`/`serializeMethodCall` and `parsePropertyCall`/`serializePropertyCall` import from this shared module.
2. **`parsePropertyCall`** — after reading `obj`, calls `explicitTypeArgNames(typeId, methodId)` and reads one `parseSType(r)` per name, building `explicitTypeArgs`. Trees with no registered names for a given `(typeId, methodId)` parse `explicitTypeArgs: {}` (no bytes consumed) — backward-compatible.
3. **`serializePropertyCall`** — after writing `obj`, iterates `explicitTypeArgNames(typeId, methodId)` and writes `serializeSType(explicitTypeArgs[name], w)` for each. A missing name in `explicitTypeArgs` throws `ExprSerializeError('property-call-missing-type-arg')` (defensive — mirrors `'method-call-missing-type-arg'`).
4. **`evalPropertyCall`** (`eval/method-call.ts`) — forwards `e.explicitTypeArgs` to `dispatch()` instead of `{}`. Handlers that read from `explicitTypeArgs` (e.g. `SGlobal.some`/`SGlobal.none`) now receive the wire-parsed type.
5. **`exprTpe` PropertyCall arm** (`mir/expr-tpe.ts`) — passes `e.explicitTypeArgs` to `resolveReturnTpe` (previously `{}` — the MethodCall arm already passed `e.explicitTypeArgs`).

### Consumers

- **`SGlobal.none` (106:10)** — PropertyCall opcode, 0 args, carries `T` (e.g. `SByte`) on the wire. First consumer of the new PropertyCall explicit-type-arg path. `explicitTypeArgNames(106, 10)` returns `['T']`.
- **`SGlobal.some` (106:9)** — MethodCall opcode, 1 arg, carries `T` on the wire via the existing MethodCall path (no PropertyCall involvement). `explicitTypeArgNames(106, 9)` returns `['T']`.

### New wire serialize error

- **`ExprSerializeError('property-call-missing-type-arg')`** — thrown when `serializePropertyCall` finds a name in `explicitTypeArgNames(typeId, methodId)` that is absent from `e.explicitTypeArgs`. Defensive; unreachable from a well-parsed tree (the parser always populates every registered name). Mirrors `'method-call-missing-type-arg'` (pre-existing in `ExprParseError`).

## Phase v6 P5a wire notes (serialize / deserializeTo)

**`SGlobal.serialize` (106:3)** carries **no wire type argument**. The JVM `SerializeMethod` (`methods.scala:1957`) does not include `T` on the wire — T is fully inferred from the runtime value of `args[0]` inside the handler. The existing MethodCall opcode path applies without change: the `EXPLICIT_TYPE_ARG_NAMES` entry for `(106, 3)` is absent (or `[]`), so `parseMethodCall`/`serializeMethodCall` consume/emit no extra type bytes. Wire format is identical to other non-generic MethodCall methods (opcode 0xdc, typeId 106, methodId 3, obj=Global, args=[value]).

**`SGlobal.deserializeTo[T]` (106:4)** carries **an explicit type arg `T` on the wire**, exactly like `SGlobal.some` (106:9). The `EXPLICIT_TYPE_ARG_NAMES` registry in `wire/mir/explicit-type-args.ts` must be extended with `(106, 4) → ['T']`. `parseMethodCall` then reads one `parseSType(r)` after the arg list (building `explicitTypeArgs: { T: parsedType }`); `serializeMethodCall` writes one `serializeSType(explicitTypeArgs['T'], w)`. A missing `T` in `serializeMethodCall` throws `ExprSerializeError('method-call-missing-type-arg')` (the existing defensive code). **No new wire error codes.**

Both methods go through the existing `MethodCall` opcode (0xdc) — no PropertyCall involvement.

## Phase v6 P6 wire additions (`FunDef` opcode `0xd7`)

`OP_FUN_DEF` (`0xd7`, 215) is now **parsed** (it was previously parse-rejected via `'opcode-reserved'`, see the error-taxonomy section above). A `FunDef` is a polymorphic `let f[T] = rhs` — a `ValDef` with a non-empty list of type parameters. The JVM treats it as a `ValDef` whose `companion` switches to `FunDef` exactly when `tpeArgs` is non-empty; ergots mirrors this on the same `ValDef` MIR node rather than introducing a new variant.

### `ValDef` MIR node — `tpeArgs` field

The `ValDef` MIR node (`mir/types.ts`) gains the field:

```ts
interface ValDef {
  tag: 'ValDef'
  id: number
  rhs: Expr
  tpeArgs?: STypeVar[]   // NEW (v6 P6); absent or empty ⇒ plain ValDef, non-empty ⇒ FunDef
}
```

The MIR `tag` stays `'ValDef'` for both shapes. The opcode is chosen from `tpeArgs.length` at serialize time — matching the JVM `companion`.

### Wire encoding (FunDef body)

`FunDef` shares the `ValDef` body prefix, with a type-arg list inserted before `rhs`:

1. `id` — VLQ-u32 (same as `ValDef`).
2. **`FunDef` only:** `nTpeArgs` — a **raw `u8`** (NOT VLQ; a single byte read directly), then `nTpeArgs` × `SType` via the existing `parseSType` (`parse-stype.ts`, which already parses `STypeVar` at type code 103). **Each parsed type-arg MUST be an `STypeVar`** — a non-`STypeVar` raises `ExprParseError('fun-def-tpe-arg-not-type-var')`.
3. `rhs` — Expr via the existing `getValue` path.

A plain `ValDef` (opcode `0xd6`) carries no `nTpeArgs`/type-arg list — `id` is followed directly by `rhs`. Both shapes populate the shared scope-wide `valDefTypes` map with `rhs.tpe`, so a downstream `ValUse` resolves identically regardless of `tpeArgs`.

### Serialize — opcode selection

`serializeExpr` on a `ValDef` node chooses the opcode from `tpeArgs.length`:

- **`tpeArgs` non-empty** → opcode `0xd7` (`FunDef`): emit `id`, then `nTpeArgs` as a raw `u8`, then each `STypeVar` via the existing `serializeSType` (`serialize-stype.ts`), then `rhs`.
- **`tpeArgs` empty** → opcode `0xd6` (`ValDef`): the pre-existing plain-`ValDef` path, unchanged. Pre-P6 `ValDef` nodes (parsed with `tpeArgs: []`) serialize byte-identically to before.

**Byte-roundtrip is load-bearing** — `serializeExpr(parseExpr(b))` is byte-equal for every `FunDef`-containing body.

The version-gating story is unchanged by this section: `FunDef` itself is parsed/serialized at **every** tree version (the opcode and `STypeVar` type code carry no version gate, matching the JVM). An `SFunc` type code (112) *appearing inside* a `FunDef`'s `rhs` or its type-arg list stays caught by the evaluator's `validateV6Types` `SFunc`-type-code gate under `treeVersion < 3` (see [`facts/ergoscript-eval.md`](./ergoscript-eval.md)) — no new wire-layer gate.

### New wire parse error

- **`ExprParseError('fun-def-tpe-arg-not-type-var')`** — a declared `FunDef` type-arg parsed to an `SType` other than `STypeVar`. Adversarial-only (a well-formed `FunDef` always carries `STypeVar` args, per the JVM serializer); guarded so a hand-crafted tree with a non-type-var type-arg rejects rather than silently mis-typing.

## Phase v6 P7a wire correction — `SBox` explicit-type-args (99:7 removed, 99:19 added)

**Source: JVM `methods.scala:1329-1347`, verified 2026-06-05.**

`methods.scala` declares two `SBox` register-access methods with different ids and different explicit-type-arg counts:

| id | name | registered | explicit type args | wire shape |
|---|---|---|---|---|
| **7** | `"getRegV5"` | `commonBoxMethods` (every version) | **none** (`Seq()`) | `MethodCall(99, 7, args)` — zero type-arg bytes |
| **19** | `"getReg"` | `v6Methods` only (`isV3OrLaterErgoTreeVersion`) | `Seq(tT)` — one `T` | `MethodCall(99, 19, args)` — one `SType` byte (or bytes) |

The previous `wire/mir/explicit-type-args.ts` entry `99:7 → ['T']` was transcribed from sigma-rust's `sbox.rs GET_REG`, which diverges from the JVM here. **This entry is REMOVED in phase v6 P7a.**

**Why this matters (dead-branch fork):** a JVM-shaped `MethodCall(99, 7, args)` carries **no** type-arg bytes. With the now-removed `99:7 → ['T']` entry, ergots consumed one `SType` byte after the method body — typically producing a whole-tree parse reject, but adversarially worse: a crafted tree could re-align and parse successfully on BOTH sides into **different trees** (accept/accept with divergent semantics). A pre-v3 or v6 tree with `MethodCall(99, 7)` in a dead branch is *deserialize-accepted* by the JVM (id 7 is registered at every version; the branch never evals) but was *rejected* by ergots → fork. After the fix, `99:7` parses as a zero-type-arg MethodCall and — having no registered handler — eval-throws `'method-not-implemented'`, matching the JVM's eval-time `NoSuchMethodException` at every tree version on every platform.

**Fix applied to `wire/mir/explicit-type-args.ts`:**

- **Remove** `7: ['T']` from the `SBox` (typeId 99) block.
- **Add** `19: ['T']` to the `SBox` (typeId 99) block (`getReg[T]`, JVM `getRegMethodV6`, `methods.scala:1338-1347`).
- Update the module-header provenance comment: the sigma-rust cross-refs for the old id 7 entry are the trap; the canonical source is the JVM `methods.scala`.

**Fixture and test sweep (known hit):** `test/wire/method-call.test.ts` ("round-trips SELF.getReg[Int](4)") previously hard-coded the sigma-rust shape (typeId 99, methodId 7, + one SType byte) — rewritten in phase v6 P7a Task 2 as the `99:19` round-trip, with an added `99:7` zero-type-args parse case (deserializes to `MethodCall(99, 7, ...)`, eval-throws `'method-not-implemented'`).

**`getVarFromInput` (101:12) — no wire change:** the existing `101:12 → ['T']` entry in the explicit-type-args registry matches the JVM (`getVarFromInputMethod` declares `Seq(tT)`, `methods.scala:1755-1765`). No action required for that entry.

**`expUnsigned` (7:6) — no wire change:** monomorphic (`SFunc([SGroupElement, SUnsignedBigInt], SGroupElement)`), zero explicit type args; `explicitTypeArgNames(7, 6)` is absent (or `[]`) — no type bytes on the wire.

## F4-epilogue wire correction — `CreateAvlTree` operand layout (sigma-rust presence-tag → JVM 4-expr)

**Source: JVM `CreateAvlTreeSerializer.scala:24-37` + `trees.scala:79-91`, verified 2026-06-07.**

The JVM serializes `CreateAvlTree` (opcode `0xb6`) as FOUR expr operands, all through the expr channel (`w.putValue(...)` ×4 / `r.getValue()` ×4):

```
[flags: Expr]            -- type SByte
[digest: Expr]           -- type SColl(SByte)
[keyLength: Expr]        -- type SInt
[valueLengthOpt: Expr]   -- type SOption(SInt)
```

The 4th operand is an expr whose *type* is Option (`valueLengthOpt: Value[SIntOption]`, trees.scala:82) — "no value length" is an Option-typed expr evaluating to None (the compiler emits `Const(SOption[SInt], None)`), NOT an absent operand. No presence tag anywhere in the run.

**sigma-rust forks this layout** (eni `ergotree-ir/src/mir/create_avl_tree.rs`): its 4th operand is `Option<Box<Expr>>` — a one-byte presence tag (`0x00` absent / `0x01` expr follows). The two shapes are mutually unparseable: JVM-emitted bytes put an expr lead byte (e.g. ConstantPlaceholder `0x73`) where sigma-rust expects the tag, and sigma-rust-emitted bytes put a tag byte where the JVM expects an expr. ergots originally ported the sigma-rust shape; the JVM-blessed vector `AvlTree.unsupported_eval_nodes_v6.json#create_avl_tree-errored#1` exposed the fork as a parse crash (`'invalid-option-tag'`, "got 115"). **Fixed to the JVM layout in the F4 epilogue (2026-06-07)**; the fork is routed to sigma-rust via SANTA.

Consequences:

- MIR `CreateAvlTree.valueLength` is now `Expr` (was `Expr | null`) — always present, Option-typed (`mir/types.ts`).
- `wire/mir/create-avl-tree.ts` parse/serialize: four `parseExpr`/`serializeExpr` calls, no tag byte. The blessed vector's tree bytes round-trip byte-identically (pinned in `test/wire/avl.test.ts`).
- `'invalid-option-tag'` lost its CreateAvlTree throw site here, and its final `DeserializeRegister.default` site in F5 batch 1 (2026-06-07) — the code is now fully RETIRED (any nonzero default tag parses as Some per JVM `getOption`; see the ExprParseError retirement note above).
- Eval-tier: both `CreateAvlTree` and `TreeLookup` now reject unconditionally (`'unsupported-eval-node'` — the JVM has no eval override for either); see [`facts/ergoscript-eval.md`](./ergoscript-eval.md). Parse stays — the JVM parses both nodes fine.

## Coverage

100% of MIR variants parse and serialize byte-identically against the PR 862 corpora (45 legacy + 14 ecosystem + 9 sig-15 = 68 trees), plus mainnet boxes (12,712 from Task B's wider corpus + 173 from the original C2 corpus). Phase 2a corpus test: 255 passing fixtures + 1 mainnet stub + 6 `known_unstable` (sigma-rust itself does not round-trip them).

The phase 2a parse-mutation suite exercises 6,221 single-byte mutations: 66% throw a typed error class, 0 throw an untyped error, 100% taxonomy coverage (every wire-layer error class above is hit at least once).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-eval.md`](./ergoscript-eval.md) — evaluator surface (`SValue` / `SType` / `Expr` canonical definitions)
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier (`SigmaBoolean` 6-variant union, `verifySignature`, `VerifyError`)
- [`facts/scorex.md`](./scorex.md) — codec layer; defines `ByteReader`, `ByteWriter`, `ReaderError`, VLQ functions consumed throughout this file
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — design rationale, phase plan, validation strategy
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language specification for opcode semantics
