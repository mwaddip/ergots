# `@ergots/ergoscript` — Wire Format Contract

This file documents the **wire-format slice** of the `@ergots/ergoscript` boundary contract. For cross-cutting guarantees (browser-compat, determinism, ESM-only, no-WASM, runtime deps) and forward pointers to other slices, see [`facts/ergoscript.md`](./ergoscript.md). For the evaluator surface (which consumes the `SValue` / `SType` / `Expr` types this layer produces) see [`facts/ergoscript-eval.md`](./ergoscript-eval.md). For sigma-protocol verification see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md).

Authoritative wire-format reference: sigma-rust's `ergotree-ir/src/ergo_tree.rs`, `ergotree-ir/src/serialization/`, and `ergotree-ir/src/mir/` (branch `integration/ergots`, HEAD `ed5452cf`). Where this file is silent, those are canonical. Where ergots and sigma-rust diverge, the JVM `sigma-state` reference is canonical (the divergences are called out in place).

## Scope

The wire-format slice provides:

1. Parse + serialize for the ErgoTree envelope: header byte, optional VLQ-u32 body size, optional segregated constants section, body Expr.
2. Parse + serialize for the full `Expr` discriminated union (69 variants — see `mir/types.ts`, including the bare `0xa6` op-form `LastBlockUtxoRootHash`), wired through a central opcode-dispatch switch.
3. Parse + serialize for `SType` (the type-system union) and `SValue` (the runtime-value union), including all primitive variants, `SColl`, `STuple`, `SOption`, `SFunc`, `STypeVar`.
4. Parse for `SigmaBoolean` (the recursive proposition tree inside `SSigmaProp` constants) as a structural 6-variant discriminated union — see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) for the runtime type and verifier; the wire parser produces all 6 variants byte-equal on round-trip.
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
- **Postcondition (failure):** Throws `ErgoTreeParseError` for envelope-level malformations (`empty`, `oversized`, `body-size-overflow`, `too-many-constants`). Body-parse failures surface as `ExprParseError` from the body parser; SType / SValue failures surface as `STypeParseError` / `SValueParseError` / `SigmaBooleanParseError`. The envelope does not wrap them — callers see the typed failure surface from the innermost layer that rejected the bytes. `ReaderError` from the underlying cursor may also surface (`truncated`, `vlq-overflow`, and `'position-limit-exceeded'` when an SBox-constant candidate overruns its 4096-byte window — see `SBox candidate-size window` below).

### `serializeTree(tree)`

- **Precondition:** `tree` was either returned from `parseTree` or constructed satisfying the type invariants below. The `header.rawHeader` byte MUST be derivable from `header.version`, `header.hasSize`, and `header.constantSegregation` (the projection is round-trip-checked at serialize time). `constantTypes.length === constants.length` is required.
- **Postcondition:** Returns `Uint8Array` of length ≤ `MAX_TREE_SIZE`. For any `tree` returned by `parseTree(b)`, `serializeTree(parseTree(b))` equals `b` byte-for-byte.
- **Postcondition (failure):** Throws `ErgoTreeSerializeError` with `code` `'header-inconsistent'` (rawHeader mismatch), `'constants-arity-mismatch'`, `'oversized'` (serialized bytes would exceed `MAX_TREE_SIZE`), or `'too-many-constants'` (`tree.constants.length` > `MAX_CONSTANTS_COUNT` = 4096). Body-serialize failures surface as `ExprSerializeError` (notably `'not-supported'` for the un-encodable `ZkProofBlock` variant).

### ErgoBox sub-structure readers (`parseErgoTreeBytes` / `parseAdditionalRegisters`)

Reader-based readers factored out of the `SBox` data parser (`parse-svalue.ts`, `case 'SBox'`) and forwarded top-level from the package index so `@ergots/transaction`'s ErgoBoxCandidate codec consumes the box-body grammar from ONE place rather than re-deriving the ergoTree-length / register-section layout. Both operate on a shared `ByteReader` and advance the cursor in place.

```ts
parseErgoTreeBytes(r: ByteReader): Uint8Array
parseAdditionalRegisters(r: ByteReader, treeVersion: number): AdditionalRegisters
type AdditionalRegisters = Record<number, { tpe: SType; value: SValue; opaqueBytes?: Uint8Array } | undefined>
```

- **`parseErgoTreeBytes(r)`** — consumes exactly one self-delimiting ergoTree from the cursor and returns its verbatim wire span (header + optional size VLQ + constants + body) as a DETACHED `Uint8Array`. Routes through `parseTreeFromReader` — the SAME deserialize as the bare `parseTree`: the tree's constants + body are structurally parsed, a `hasSize` body failing with a soft-forkable error degrades to `UnparsedErgoTree`, and the non-soft-forkable class (e.g. an SHeader constant, a truncated/empty body) REJECTS. So a box's propBytes reject exactly what a bare tree rejects — there is no box-vs-bare parse split (the pre-2026-06-17 `consumeTreeFromReader` skip-the-body path is retired). Does NOT enforce outer-trailing exhaustion (the caller continues with the next field, e.g. `creation_height`); trailing WITHIN a `hasSize` body's declared size is tolerated. Failure surface: `ErgoTreeParseError` (`'header-version-requires-size'`, `'body-size-overflow'`) + the body's wire/SValue parse errors (`ExprParseError` / `STypeParseError` / `SValueParseError` / `ReaderError`). **The `SBox` data parser and `@ergots/transaction`'s ErgoBoxCandidate codec both call this**, so the deserialize is identical across them and the bare `parseTree`.
- **`parseAdditionalRegisters(r, treeVersion)`** — reads the box additional-registers section: a raw `u8` count (NOT VLQ), `> 6` → `SValueParseError('sbox-registers-out-of-range')`, then that many register Exprs keyed R4.. (`4 + i`). Each register is restricted to `Const`/`Tuple`; the rare Tuple-Expr form (lead byte `0x86`) is preserved via `opaqueBytes` for byte-identical re-emission, and the rule-1019 `CheckV6Type` gate (`'register-v6-type'`) + per-Expr depth accounting apply identically to the SBox path. The caller owns any surrounding read-window (`positionLimit`) save/restore. **The `SBox` data parser calls this** for its registers, so register semantics are identical across SBox and the candidate codec.

### `isP2PK(tree)` / `p2pkPublicKey(tree)`

- **Precondition:** `tree` is a valid `ErgoTree`.
- **Postcondition (`isP2PK`):** Returns `true` iff the tree's body is the canonical P2PK shape — `Const(SSigmaProp, ProveDlog(EcPoint))` or a `ConstPlaceholder` resolving to the same — matching sigma-rust's `Address::P2Pk.script()` recognition (`ergotree-ir/src/chain/address.rs:206-218`).
- **Postcondition (`p2pkPublicKey`):** Returns a defensive 33-byte copy of the compressed secp256k1 public key when `isP2PK(tree)` is true, else `null`. The returned buffer is fresh — mutating it does not affect the tree's internal storage.
- **Invariant:** Trees whose body is `CreateProveDlog(GroupElement)` (a derived form) are NOT classified as P2PK — sigma-rust only recognizes the canonical `Const(SSigmaProp, _)` form. Using a non-canonical shape would break the address → tree → address round-trip against any other Ergo implementation.

### `addressFromErgoTree(tree, network)` / `ergoTreeFromAddress(address)`

- **Precondition (`addressFromErgoTree`):** `tree` is a valid `ErgoTree`; `network` is `'mainnet'` or `'testnet'`.
- **Postcondition (`addressFromErgoTree`):** Returns a base58check Ergo address. If `isP2PK(tree)`, the address is P2PK (content bytes are the 33-byte EcPoint only, NOT the serialized tree). Otherwise the address is P2S (content bytes are the full serialized ErgoTree).
- **Postcondition (`addressFromErgoTree` failure):** Throws `AddressDecodeError('unknown-network')` if `network` is any value other than `'mainnet'`/`'testnet'` (a runtime guard for untyped / `as any` callers that bypass the `Network` literal type).
- **Precondition (`ergoTreeFromAddress`):** `address` is a base58check Ergo address with valid checksum and a supported address type.
- **Postcondition (`ergoTreeFromAddress`):** Returns the `ErgoTree` encoded by the address. P2PK addresses are reconstructed by synthesizing canonical bytes (`0x00 0x08 0xcd <33 bytes pubkey>`) and parsing them — every returned tree goes through `parseTree`, so the type invariants below hold.
- **Postcondition (failure):** Throws `AddressDecodeError` with `code` `'bad-base58'`, `'too-short'`, `'too-long'` (address string longer than `MAX_ADDRESS_STRING_LENGTH`, bounding the O(n²) base58 decoder), `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, or `'unknown-type'`. A P2S address carrying malformed tree bytes throws `ErgoTreeParseError` (or a downstream parser error) — those bubble up unwrapped.
- **Round-trip invariant:** For any tree `t` and matching network `n`, `ergoTreeFromAddress(addressFromErgoTree(t, n))` parses to a structurally equivalent `ErgoTree`. P2SH addresses are NOT round-trippable through this function (they are derived from a 24-byte hash, not a serialized tree) and decoding one throws `p2sh-unsupported`.

## Internal modules (current monorepo surface)

The package's `index.ts` exposes the consumer-facing surface above. Internal modules under `wire/`, `mir/`, and `crypto/` carry additional types and error classes that downstream packages in this monorepo (and the test suite) reach into directly while the package is pre-publish:

```ts
// wire/parse.ts
parseExpr(
  r: ByteReader,
  constantTypes: SType[],
  constantValues: SValue[],
  valDefTypes: Map<number, SType>,
  treeVersion: number
): Expr

// wire/serialize.ts
serializeExpr(e: Expr, w: ByteWriter, treeVersion: number): void

// wire/parse-stype.ts / wire/serialize-stype.ts
parseSType(r: ByteReader): SType
serializeSType(t: SType, w: ByteWriter): void

// wire/parse-svalue.ts / wire/serialize-svalue.ts
parseSValue(tpe: SType, treeVersion: number, r: ByteReader): SValue
serializeSValue(tpe: SType, v: SValue, treeVersion: number, w: ByteWriter): void

// wire/ergo-tree.ts — serializer-level constant substitution (body copied
// verbatim); consumed by the SubstConstants eval arm. See "substituteConstantsBytes" below.
substituteConstantsBytes(
  scriptBytes: Uint8Array,
  positions: number[],
  newValues: SValue[],
  newValuesElem: SType,
  treeVersion: number,
): { bytes: Uint8Array; numConstants: number }

// wire/ergo-tree.ts — shared-reader body parse (self-delimiting Expr grammar)
parseTreeFromReader(r: ByteReader): ErgoTree

// wire/ergo-tree.ts — consume one self-delimiting ergoTree, return its verbatim
// span. Re-exported top-level (see "ErgoBox sub-structure readers" below);
// consumed by @ergots/transaction's ErgoBoxCandidate codec.
parseErgoTreeBytes(r: ByteReader): Uint8Array

// wire/parse-svalue.ts — box additional-registers section (u8 count + per-register
// Const/Tuple Expr, opaqueBytes for the Tuple-Expr form, rule-1019 CheckV6Type
// gate). Re-exported top-level; consumed by @ergots/transaction's candidate codec.
parseAdditionalRegisters(r: ByteReader, treeVersion: number): AdditionalRegisters

// wire/ergo-box-bytes.ts — box serialization (reusable for the wallet phase)
serializeBoxBytes(box: ErgoBox): Uint8Array
serializeBoxBytesWithoutRef(box: ErgoBox): Uint8Array

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

**`treeVersion` threading.** `parseSValue` / `serializeSValue` carry a `treeVersion: number`, threaded through every recursive call site (Coll, Tuple, Option arms) — it drives the V3-gated value codecs (SHeader, SOption, SUnsignedBigInt). The internal `parseExpr` / `serializeExpr` entry points accept `treeVersion` as a **required** parameter; the optional-defaulted-to-0 form was a threading-class landmine — compound nodes silently parsed nested constants at v0. `parseTree` / `serializeTree` inject `treeVersion` from `tree.header.version`. `SHeader` value parse/serialize delegate to `@ergots/scorex`'s `parseHeader` / `serializeHeader`.

**`parseTreeFromReader(r)`.** Mirrors sigma-rust's `ErgoTree::sigma_parse` → `parse_with` (`ergo_tree.rs:181-239`): the body Expr grammar is self-delimiting, so when `hasSize=false` the cursor lands at the body's end after `parseExpr` returns; for `hasSize` it reads the declared size into a bounded sub-reader and parses constants + body from it (the outer cursor advances the full declared size). `parseTree(bytes)` is a thin wrapper adding the empty/size-cap check + outer-envelope exhaustion check. As of 2026-06-17 this is the SINGLE tree-deserialize: the `SBox` value arm and `@ergots/transaction`'s candidate codec consume + capture a box script via `parseErgoTreeBytes`, which calls `parseTreeFromReader` directly (the old `consumeTreeFromReader` skip-the-body path is retired), so a box's propBytes get the identical deserialize to a bare `parseTree` — mirroring the JVM's single `deserializeErgoTree` (`ErgoBoxCandidate.scala:194`) and sigma-rust's `ErgoBox::sigma_parse` → `parse_with`. A v0 `hasSize=false` tree is the ~99% mainnet-box case (empirically confirmed against the bootstrap-data snapshot at heights 1, 1000, 3849), mirroring sigma-rust's `parse_box_with_indexed_digests` (`chain/ergo_box.rs:350`). A `hasSize` body failing a **soft-forkable** parse degrades to `UnparsedErgoTree` (next paragraph); a non-soft-forkable failure REJECTS. The mainnet "burn" box at h=545,684 (header `0xcd`, a clean root + trailing within the declared size) stays accepted because trailing WITHIN a `hasSize` body is tolerated — it parses to a non-SigmaProp `Parsed` root, not a skip (see Round-trip Carve-out 4). Exported within the package for cross-module use by `parse-svalue.ts`.

**ErgoTree union + structured-`parseTree` soft-fork degrade (2026-06-17).** `parseTree` / `parseTreeFromReader` return `ErgoTree = ParsedErgoTree | UnparsedErgoTree` (narrow with `isUnparsedTree`, both exported from the package). For a `hasSize` tree whose constants/body parse fails with a JVM-`ValidationException`-equivalent **soft-forkable** error, the whole tree is preserved verbatim as `UnparsedErgoTree` (header-onward bytes + the captured error); `serializeTree` re-emits those bytes byte-identically, and `evaluate` / `evaluateWith` reject it with `EvalError('unparsed-ergotree')` (a permanently-unevaluable "burn" script — `@ergots/transaction`'s `validateStateful` thus rejects the spend). Gated on `hasSize` AND the verified degrade-set `SOFT_FORKABLE_PARSE_CODES = { 'opcode-reserved', 'unknown-opcode', 'soption-tree-version-too-low' }` (`isSoftForkableParseError`) — mirroring the JVM, whose `UnparsedErgoTree` fallback (`ErgoTreeSerializer.scala:197`) catches `ValidationException` (`CheckValidOpCode` 1002; `CheckSerializableTypeCode` 1009, the Option-typeCode special-case at `ValidationRules.scala:135`) but lets a `SerializerException` escape → reject. So a non-`hasSize` tree, a malformed-data failure (truncation / `vlq-overflow` / `value-out-of-range`), an **SHeader-DATA constant** (typeCode 104 → a DIRECT `SerializerException` at `CoreDataSerializer.scala:146`, NOT rule-1009-degradable → `sheader-tree-version-too-low` REJECTS), and the type-code / method / position-limit gates all still REJECT. The broader `ValidationException` class (unknown type codes, methods) is a tracked residual (B-full); see `docs/specs/2026-06-17-ergotree-unparsed-soft-fork-preservation.md`. Conformance: SANTA `ErgoTree.unparsed_soft_fork_roundtrip` (`0b01fd` / `0b03fd0102`, `jvm:sigma-state-6.0.3`). **Box ingest shares this exact deserialize (2026-06-17 unification):** `parseErgoTreeBytes` routes through `parseTreeFromReader`, so an SHeader-constant (or any non-soft-forkable / truncated-body) tree inside a box's propBytes REJECTS identically to the bare form — closing a prior box-only over-accept. An empty/short-body `hasSize` tree (e.g. `[08 00]`, a synthetic shape no honest box carries) is the adversarial residual where ergots (narrow degrade → reject) diverges from sigma-rust (broad degrade → `Unparsed`/accept); the JVM is size-unbounded on the body, so the shape has no honest reference behavior. Conformance: SANTA `Box.softfork_header_constant_reject` (`jvm:sigma-state-6.0.3`). Spec: `docs/specs/2026-06-17-ergotree-deserialize-unification.md`.

**`substituteConstantsBytes(...)`** is the byte-surgery behind the `SubstConstants` eval arm. It mirrors JVM `ErgoTreeSerializer.substituteConstants` (`ErgoTreeSerializer.scala:320-411`): the header + constants segment are re-parsed and re-serialized, but the tree BODY is copied **verbatim** — never parsed as an `Expr`. This is the consensus-faithful behavior: a crafted template whose body is not valid Expr bytes is returned unchanged (0 constants ⇒ no substitution) where a full `parseTree` throws. ergots **leads** this fix — sigma-rust still uses the parse-based `with_constant` and shares the divergence (routed to sigma-rust); JVM is canonical. JVM-parity details encoded in the fn (`ErgoTreeSerializer.scala:286-411`):

- Out-of-range positions (negative or `>= numConstants`) are a silent no-op; duplicate positions are FIRST-wins (`getPositionsBackref:286-299`).
- Every constant (substituted or not) is re-serialized via `serializeSType`/`serializeSValue` (matching JVM's `constantSerializer`), so the constants segment is NOT a verbatim copy — only the body is.
- The size prefix is re-emitted only when `treeVersion >= 3` (`isV3OrLaterErgoTreeVersion`, the V6 soft-fork; `:369-375`); for the v≤2 range ergots evaluates it is dropped, so a `hasSize` template's output omits the size slot — exactly as JVM does. `treeVersion` is the evaluation's ErgoTree version, NOT the template header's.
- The size field does NOT bound the body read (`treeBytes = r.getBytes(r.remaining)`); the body is all remaining bytes.

New `ErgoTreeParseError` codes from this fn: `'subst-length-mismatch'`, `'subst-type-mismatch'` (the eval arm re-wraps them as `EvalError('subst-constants-error')`).

**Method-call return-type resolution.** For `MethodCall`/`PropertyCall`, `exprTpe` consults the declarative signature catalog `mir/method-signatures.ts` (keyed by `(typeId, methodId)`, transcribing the method's `SFunc` signature — v5 entries from sigma-rust, v6 from JVM `sigma-state`) and applies `resolveReturnTpe(sig, receiver, argTpes, explicitTypeArgs)` — where `receiver = exprTpe(obj)` and `argTpes = args.map(exprTpe)` (the substitution inputs). Contract:

- **Registered, closed `tRange`** → returns `tRange` verbatim (e.g. `getEncoded` (7:2) → `Coll[SByte]`, `indices` (12:14) → `Coll[SInt]`).
- **Registered, type-var `tRange`** → `tRange` with type vars bound from `receiver`/`argTpes`/`explicitTypeArgs` via the substitution engine (`mir/type-unify.ts`, ≡ JVM `MethodCall.tpe()`); an operand that cannot bind a var leaves a residual that falls back to `{ tag: 'SAny' }`. First registered generic-output method: `patch` (12:19) → `Coll[IV-of-receiver]`. The bitwise/shift methods (typeIds 2–6, methodIds 8–13) all have `tRange = tNum` bound from the receiver's numeric type.
- **Unregistered** → `{ tag: 'SAny' }` — the documented placeholder treated as a wildcard by `sTypeEqualsModuloSAny`/`hasSAny`. **Never throws** (contrast genuinely-unparsed Expr variants, which still throw `ExprTpeError('tpe-not-implemented')`).

The catalog grows by descriptor-addition and is populated via `numericV6Signatures()` for the numeric-v6 family. Current catalog entries:

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

**Re-exported wire symbols.** `parseSigmaBoolean` / `serializeSigmaBoolean` and their error classes `SigmaBooleanParseError` / `SigmaBooleanSerializeError` are re-exported top-level from the package index (`src/index.ts`, alongside `parseSValue`/`serializeSValue`) — for downstream wire-conformance consumers that round-trip a **bare** SigmaBoolean (op_code + payload, no SValue/SType framing, so `parseSValue` cannot reach it). `sigmaBooleanOpCode` / `proveDlogPublicKey` remain shape-documented but are NOT re-exported (no consumer demand); the other wire symbols above are documented-shape only. Once the package's wire surface stabilizes, these will likely move behind a `/wire` subpath export (the proof package's `/envelope` pattern); until then this file documents their current shape so downstream packages can rely on them.

## Round-trip invariant

For any byte sequence `b` accepted by `parseTree`:

```
serializeTree(parseTree(b)) === b   (byte-equal)
```

This holds for every ErgoTree variant we ship. The corpus test asserts this on 255 passing fixtures plus 1 mainnet-fixture stub plus 6 upstream-buggy fixtures (the 6 are excluded from byte-equality; sigma-rust itself does not round-trip them — see `fixture-gen/known_unstable.json`).

**Carve-out 1 — arity-0/1 generic-tuple TYPE:** trees whose serialized types include an arity-0/1 generic-tuple TYPE (`0x60` + len 0/1) PARSE but cannot re-serialize — `serializeSTuple` throws `'tuple-too-short'`, mirroring the JVM's own asymmetry (`TypeSerializer.scala:188-194` parse has no arity require; `:93-94` serialize `sys.error`s < 2). The reverse-direction precedent is the AvlTree any-length-digest note.

**Carve-out 2 — noncanonical Option tags:** any wire Option tag byte > 0x01 parses as Some (JVM scorex-util `getOption`: ANY nonzero = Some) but re-serializes to the canonical `0x01` — so `serializeTree(parseTree(b)) ≠ b` for trees carrying noncanonical tags (SOption DATA constants, `DeserializeRegister.default`, `ByIndex.default`, SAvlTree `valueLengthOpt`). The JVM has the identical asymmetry (`putOption` emits 1/0); it round-trips such trees only because `ErgoTree` RETAINS original bytes rather than re-serializing (`ErgoTree.scala:65-67,123-131`) — ergots likewise retains verbatim slices where consensus reads bytes (SBox `ergoTreeBytes`). Tooling note: `addressFromErgoTree` re-serializes, so a noncanonical on-chain tree yields a different P2S address than a JVM node derives from retained bytes — tooling-level, not consensus.

**Carve-out 3 — noncanonical identity GroupElements:** a GE payload with lead byte 0x00 and ANY bytes 1..32 (SValue GE data, ProveDlog/ProveDHTuple leaf points) parses as the identity and re-serializes CANONICAL (33 zeros) — so `serializeTree(parseTree(b)) ≠ b` for trees carrying garbage-tail identity encodings. The JVM behaves identically at the value layer (`GroupElementSerializer.parse` reads ANY 0x00-lead into the identity point object; serialize emits 33 zeros, :20-42) and round-trips such trees only via retained original bytes (the same mechanism as Carve-out 2). Invalid non-0x00-lead payloads now REJECT at parse (`'group-element-invalid-point'` / `'ec-point-invalid'`) instead of round-tripping raw — the old byte-faithful raw retention matched NEITHER reference's value semantics. See `GroupElement canonical parse` below.

**Carve-out 4 — trailing inside a `hasSize` body (2026-06-17):** a `hasSize` tree whose body parses cleanly but leaves trailing bytes within the declared size now PARSES (the inner-trailing reject was retired — it matched neither reference; the JVM stops at the parse-determined end, sigma-rust ignores the sized-buffer leftover). The parsed `ParsedErgoTree` re-serializes its actual body WITHOUT the trailing, so `serializeTree(parseTree(b)) ≠ b` for such trees. This is adversarial-only (an honest tree's declared size equals its body) and not reference-required (the JVM doesn't guarantee it either — it captures `[start, parse-end)`); on the consensus box path the verbatim span is retained on `ergoTreeBytes` (the Carve-out 2 mechanism), so boxes still round-trip. The mainnet burn box at h=545,684 is exactly this shape. Tracked in `docs/specs/2026-06-17-ergotree-deserialize-unification.md` ("Parsed vs Unparsed" residual).

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

`ErgoBox` and `AvlTreeData` shapes are stable. `Closure` remains forward-declared until the FuncValue/Apply evaluator arms land. Evaluator-only fields may still be added in later phases (see [`facts/ergoscript-eval.md`](./ergoscript-eval.md)).

```ts
interface ErgoBox {
  // ... value, ergoTree, creationHeight, tokens, txId, index ...
  registers: Record<number, { tpe: SType; value: SValue } | undefined>
}

interface AvlTreeData {
  digest: Uint8Array              // parse: exactly 33 bytes (fixed-33 read); runtime: any length (JVM accepts any)
  treeFlags: number               // u8: bit 0 insertAllowed, bit 1 updateAllowed, bit 2 removeAllowed, bits 3-7 reserved
  keyLength: number               // u32 (VLQ-encoded on the wire)
  valueLengthOpt: number | null   // null = variable; non-null = fixed value length
}
```

- `ErgoBox.registers` carries a per-register `SType` (the `{ tpe; value }` record), matching sigma-rust's `NonMandatoryRegisters` storing `Constant<'static>`. The per-register `SType` is required by the downstream `ExtractRegisterAs` evaluator arm's type-assertion (see eval slice).
- **GroupElement canonical-bytes invariant:** every GE value reaching the runtime is canonical — a curve-valid compressed point or the canonical 33-zero identity. The wire layer enforces this at parse (see `GroupElement canonical parse` below); the canonical home for the invariant is [`facts/ergoscript-eval.md`](./ergoscript-eval.md) Type invariants.

## Wire encoding by construct

The per-construct wire formats below complement the function signatures (Internal modules) and the error taxonomy (which lists each code's trigger). Where a code is named here, its enumeration lives in the taxonomy.

### `SUnsignedBigInt` value codec (type code 9)

`SUnsignedBigInt` is in the `SType` union as **type code 9** (`SEmbeddable`, `SNumericType`; JVM `SType.scala:547`). Handling is **permissive at the wire layer** — the v3 gate lives in the evaluator's `validateV6Types` pre-eval pass (see [`facts/ergoscript-eval.md`](./ergoscript-eval.md)), NOT here. This matches ergots' established pattern for `validateBinOpTypes` (parser stays permissive; consensus rejection is pre-eval).

- **`parseSType` / `serializeSType`:** embeddable type code 9 ↔ `{ tag: 'SUnsignedBigInt' }` (permissive; accepted at any tree version). The JVM gates code 9 via `embeddableV6` (selected by `isV3OrLaterErgoTreeVersion`); ergots accepts unconditionally for byte-roundtrip, and the pre-eval pass enforces the gate. `serializeSType` emits code 9 via the `embeddablePrimitiveCode` path AND the main `serializeSType` switch (so composite type-codes `Coll[UBI]`, `Option[UBI]`, tuple-containing UBI, and `SFunc`-containing UBI all work through the normal compact-form machinery).

The value codec is **distinct from `SBigInt`** (consensus-critical — different byte representations for the same numeric values):

| | `SBigInt` (existing) | `SUnsignedBigInt` |
|---|---|---|
| Encode | `toByteArray` — signed two's-complement, minimal; high-bit-set positive ⇒ leading `0x00` | `asUnsignedByteArray` — unsigned magnitude, minimal; no sign padding |
| Decode | `new BigInteger(bytes)` — signed | `fromUnsignedByteArray(bytes)` — unsigned magnitude |
| Range | `[-2^255, 2^255−1]` | `[0, 2^256−1]` |
| `0` encodes to | `[0x00]` (1 byte, VLQ len `01 00`) | `[]` (empty, VLQ len `00`) |
| `128` encodes to | `[0x00, 0x80]` (2 bytes) | `[0x80]` (1 byte) |

Length framing: VLQ `putUShort`/`getUShort` (Scorex `putUShort` is plain VLQ, so ergots' existing `writeVlqU`/`readVlqU` is correct). Source: `CoreDataSerializer.scala:39-42, 118-124`.

Confirmed edge cases (each a required test vector):

- **`0` → `[]` (empty; wire `00`).** `sigma.crypto.BigIntegers.asUnsignedByteArray(0)` strips the leading zero unconditionally (`BigIntegers.scala:110-118`). The loop `while (n > 0n) { unshift(n & 0xff); n >>= 8n }` never runs for `0n` → empty array. This is the **opposite of `SBigInt`** where `0 → [0x00]`.
- **No high-bit sign padding.** `128` → `[0x80]` (1 byte). The encoder MUST be a fresh magnitude encoder — NOT a tweak of `encodeBigIntBE` (whose `unshift(0x00)` high-bit pad must NOT carry over).
- **Length-0 on the wire decodes to `0n`** (`fromUnsignedByteArray([]) → 0`; `CoreDataSerializer.scala:118-124` does NOT reject size 0). ergots **must accept** length-0 → `0n`; rejecting is stricter than the JVM = fork. (Contrast `SBigInt`, which rejects length-0.)
- **Decode cap 32 bytes** (`> 32` ⇒ `SValueParseError('unsigned-bigint-too-large')`; `CoreDataSerializer.scala:120`).
- **Non-negative only.** The encoder guards `v < 0n` → throws (unsigned: no negatives); the decoder yields a non-negative bigint by construction.
- **Non-canonical leading-zero inputs** (e.g. `[0x00, 0x05]`) decode to `5n` and re-encode canonically as `[0x05]` — accepted but not byte-identical on a round-trip of that specific input. Do NOT assert byte-identity on non-canonical test vectors.

Helpers (paralleling `encodeBigIntBE`/`decodeBigIntBE`): `encodeUnsignedBigIntBE(v: bigint): Uint8Array` (`v < 0n` ⇒ throw; emit minimal unsigned BE magnitude bytes via `while (n > 0n)` loop, no high-bit pad; `0n` → `[]`); `decodeUnsignedBigIntBE(bytes: Uint8Array): bigint` (fold bytes as unsigned magnitude BE; `[]` → `0n`). Codes: `'unsigned-bigint-too-large'` (parse + defensive serialize), `'unsigned-bigint-negative'` (defensive serialize).

**`SFunc` type code 112 — pre-existing permissive parse.** `parseSType` accepts type code 112 (`SFunc`) unconditionally (no version gate). The JVM gates it on `isV3OrLaterErgoTreeVersion` (`TypeSerializer.scala:211`). This pre-existing over-accept is closed by the evaluator's `validateV6Types` pass (which deep-walks for `SFunc` everywhere it walks for `SUnsignedBigInt`) — the parser stays permissive for byte-roundtrip; consensus rejection is pre-eval.

### `AvlTreeData` value layout

The wire format mirrors sigma-rust `ergotree-ir/src/mir/avl_tree_data.rs:71-90`:

1. `digest` — **Parse:** ADDigest `scorex_parse` reads exactly 33 bytes (`read_exact(33)`; `ergo-chain-types/src/digest32.rs:149-153`). On-wire: 33 RAW bytes, NO length prefix. The 33rd byte is the tree-height byte. **Serialize:** the JVM `DataSerializer` writes `AvlTreeData.digest` verbatim via `putBytes` with no length requirement (`CAvlTree.scala:31-34` no-require); any runtime digest length is written as-is. An AvlTree SValue produced by `updateDigest` with a non-33-byte digest serializes fine but does NOT round-trip through parse — an intentional JVM asymmetry.
2. `treeFlags` — single `u8` via `put_u8`. Bits 3-7 round-trip identically (no masking).
3. `keyLength` — VLQ `u32` via `put_u32` (which is `put_u64(v as u64)` in `sigma-ser/src/vlq_encode.rs:78`). NOT fixed 4-byte big-endian.
4. `valueLengthOpt` — `Option<Box<u32>>` SigmaSerializable (`serialization/serializable.rs:212-231`): `Some(v)` = `0x01` tag + VLQ-u32 inner value; `None` = `0x00` tag. Parser is permissive — any non-zero tag byte is treated as `Some` (Carve-out 2). Serializer canonicalizes to `0x01` for `Some`.

Serialize codes: `'savltree-tree-flags-out-of-range'`, `'savltree-key-length-out-of-range'`, `'savltree-value-length-out-of-range'`. The parser delegates length / VLQ-overflow checks to `ByteReader` (no AvlTree-specific parse codes).

### `CreateAvlTree` operand layout

**Source: JVM `CreateAvlTreeSerializer.scala:24-37` + `trees.scala:79-91`.** The JVM serializes `CreateAvlTree` (opcode `0xb6`) as FOUR expr operands, all through the expr channel (`w.putValue(...)` ×4 / `r.getValue()` ×4):

```
[flags: Expr]            -- type SByte
[digest: Expr]           -- type SColl(SByte)
[keyLength: Expr]        -- type SInt
[valueLengthOpt: Expr]   -- type SOption(SInt)
```

The 4th operand is an expr whose *type* is Option (`valueLengthOpt: Value[SIntOption]`, `trees.scala:82`) — "no value length" is an Option-typed expr evaluating to None (the compiler emits `Const(SOption[SInt], None)`), NOT an absent operand. No presence tag anywhere in the run.

**sigma-rust forks this layout** (`ergotree-ir/src/mir/create_avl_tree.rs`): its 4th operand is `Option<Box<Expr>>` — a one-byte presence tag (`0x00` absent / `0x01` expr follows). The two shapes are mutually unparseable: JVM-emitted bytes put an expr lead byte (e.g. ConstantPlaceholder `0x73`) where sigma-rust expects the tag, and sigma-rust-emitted bytes put a tag byte where the JVM expects an expr. ergots originally ported the sigma-rust shape; the fork is now fixed to the JVM layout and routed to sigma-rust. Consequences:

- MIR `CreateAvlTree.valueLength` is `Expr` (not `Expr | null`) — always present, Option-typed (`mir/types.ts`).
- `wire/mir/create-avl-tree.ts` parse/serialize: four `parseExpr`/`serializeExpr` calls, no tag byte. Blessed-vector tree bytes round-trip byte-identically (pinned in `test/wire/avl.test.ts`).
- Eval-tier: both `CreateAvlTree` and `TreeLookup` reject unconditionally (`'unsupported-eval-node'` — the JVM has no eval override for either); see [`facts/ergoscript-eval.md`](./ergoscript-eval.md). Parse stays — the JVM parses both nodes fine.

### `ValDef` / `FunDef` (opcodes `0xd6` / `0xd7`)

`OP_FUN_DEF` (`0xd7`, 215) is **parsed**. A `FunDef` is a polymorphic `let f[T] = rhs` — a `ValDef` with a non-empty list of type parameters. The JVM treats it as a `ValDef` whose `companion` switches to `FunDef` exactly when `tpeArgs` is non-empty; ergots mirrors this on the same `ValDef` MIR node rather than introducing a new variant:

```ts
interface ValDef {
  tag: 'ValDef'
  id: number
  rhs: Expr
  tpeArgs?: STypeVar[]   // absent or empty ⇒ plain ValDef, non-empty ⇒ FunDef
}
```

The MIR `tag` stays `'ValDef'` for both shapes; the opcode is chosen from `tpeArgs.length` at serialize time (matching the JVM `companion`).

**Wire encoding.** `FunDef` shares the `ValDef` body prefix with a type-arg list inserted before `rhs`:

1. `id` — VLQ-u32 (same as `ValDef`).
2. **`FunDef` only:** `nTpeArgs` — a **raw `u8`** (NOT VLQ; a single byte read directly). The JVM reads it via **signed** `getByte()` then `safeNewArray[STypeVar](nTpeArgs)`, which throws on a negative size, so a count `>= 128` is rejected; ergots mirrors this with `ExprParseError('fun-def-tpe-args-out-of-range')` for `nTpeArgs > 127` (`ValDefSerializer.scala:38`). Then `nTpeArgs` × `SType` via `parseSType` (which already parses `STypeVar` at type code 103). **Each parsed type-arg MUST be an `STypeVar`** — a non-`STypeVar` raises `ExprParseError('fun-def-tpe-arg-not-type-var')`.
3. `rhs` — Expr via the existing `getValue` path.

A plain `ValDef` (opcode `0xd6`) carries no `nTpeArgs`/type-arg list — `id` is followed directly by `rhs`. Both shapes populate the shared scope-wide `valDefTypes` map with `rhs.tpe`, so a downstream `ValUse` resolves identically regardless of `tpeArgs`. **Serialize** chooses the opcode from `tpeArgs.length`: non-empty → `0xd7` (emit `id`, then `nTpeArgs` as a raw `u8` — rejected with `ExprSerializeError('fun-def-tpe-args-out-of-range')` for `length > 127`, mirroring the JVM `w.put(len.toByteExact)` which is Byte-exact (`ValDefSerializer.scala:20`); note this serialize cap is **127**, unlike `Tuple` whose serialize uses `putUByte` and caps at 255 — then each `STypeVar` via `serializeSType`, then `rhs`); empty → `0xd6` (the pre-existing plain-`ValDef` path, byte-identical to before). **Byte-roundtrip is load-bearing** — `serializeExpr(parseExpr(b))` is byte-equal for every `FunDef`-containing body.

`FunDef` itself is parsed/serialized at **every** tree version (the opcode and `STypeVar` type code carry no version gate, matching the JVM). An `SFunc` type code (112) *appearing inside* a `FunDef`'s `rhs` or its type-arg list stays caught by the evaluator's `validateV6Types` `SFunc`-type-code gate under `treeVersion < 3` (see [`facts/ergoscript-eval.md`](./ergoscript-eval.md)) — no new wire-layer gate.

### `STypeVar` name — length + UTF-8 decode (type code 103)

`STypeVar` encodes as `[103][u8 name length][UTF-8 name bytes]`. The JVM (`TypeSerializer.deserialize:203`) reads the length via **`getUByte()`** (unsigned, 0..=255) with **no bound** and builds `STypeVar(new String(getBytes(len)))` — so name length 0 yields `STypeVar("")` and 255 is accepted. ergots matches: parse accepts 0..=255 (truncation past the buffer is still caught by `readBytes`); serialize rejects only `> 255` UTF-8 bytes (`STypeSerializeError('stypevar-name-length')`) — what the u8 length field cannot hold. The earlier `[1, 254]` bound mirrored sigma-rust's `BoundedVec<1, 254>` and was a JVM fork in BOTH directions (over-rejecting 0 and 255); the parse code `'invalid-stypevar-length'` is retired (see Retired codes). Reachable via `FunDef` type-args and `SFunc` type params; adversarial-only.

**UTF-8 decode is JVM-faithful lossy, never rejecting.** The JVM's `new String(bytes, UTF_8)` lossy-decodes ill-formed UTF-8 to U+FFFD (it never throws), so ergots decodes the name bytes via `decodeUtf8Lossy` (`wire/_utf8.ts`) — a port of Java's `sun.nio.cs.UTF_8.Decoder` malformed-length rule — rather than strict-rejecting. The byte sequence where this matters is an ill-formed UTF-16 surrogate (`ed a0 80`): the JVM collapses the whole 3-byte unit to a **single** U+FFFD, whereas WHATWG / Rust `from_utf8_lossy` (and a naive `TextDecoder`) emit **three** — a different re-encoded name → a different `ErgoTree` template → a wire round-trip fork. `serializeSType` re-encodes the decoded name from structure (`TextEncoder`), so a non-canonical name round-trips to the JVM-canonical bytes. Pinned by the SANTA-blessed vector `STypeVar.name_utf8_roundtrip` (5 entries, `jvm:sigma-state-6.0.3`, vendored at `test/fixtures/conformance/wire/`); the per-byte JVM table is in `test/wire/utf8-lossy.test.ts`. The earlier strict-reject code `'invalid-stypevar-utf8'` is retired (see Retired codes). Adversarial-only — honest tools never emit a malformed type-var name.

### Explicit type arguments (MethodCall / PropertyCall)

**Source: JVM `PropertyCallSerializer.scala:20-49` (byte-identical to `MethodCallSerializer`'s explicit-type-arg tail).** Some methods carry explicit type arguments on the wire after the method body. The shared registry `explicitTypeArgNames(typeId, methodId): readonly string[]` (`wire/mir/explicit-type-args.ts`) drives both serializers: after writing the method body, the serializer iterates the registered type-parameter names and writes one `SType` per name via `putType(typeSubst(a))`; the parser reads the same count of `SType` values. Trees with no registered names for a `(typeId, methodId)` consume/emit no extra type bytes (backward-compatible).

Both `MethodCall` and `PropertyCall` MIR nodes carry an `explicitTypeArgs: Record<string, SType>` field (empty `{}` for nodes with no registered names; byte-roundtrip unchanged):

```ts
interface PropertyCall {
  tag: 'PropertyCall'
  obj: Expr
  typeId: number
  methodId: number
  explicitTypeArgs: Record<string, SType>  // empty ({}) when no registered type-arg names
}
```

`evalPropertyCall` forwards `e.explicitTypeArgs` to `dispatch()`, and the `exprTpe` PropertyCall arm passes them to `resolveReturnTpe` — so handlers that read from `explicitTypeArgs` (e.g. `SGlobal.some`/`SGlobal.none`, `SBox.getReg`) receive the wire-parsed type.

Registered consumers (`explicitTypeArgNames`):

| (typeId:methodId) | Method | opcode | wire type args | source |
|---|---|---|---|---|
| 106:10 | `SGlobal.none` | PropertyCall (0 args) | `['T']` | first PropertyCall consumer of the type-arg tail |
| 106:9 | `SGlobal.some` | MethodCall (1 arg) | `['T']` | |
| 106:3 | `SGlobal.serialize` | MethodCall | none (`[]` / absent) | T inferred from `args[0]` value; JVM `SerializeMethod` `methods.scala:1957` carries no `T` on the wire |
| 106:4 | `SGlobal.deserializeTo[T]` | MethodCall | `['T']` | like `some` |
| 99:7 | `SBox.getRegV5` | MethodCall | none (`Seq()`) | JVM `commonBoxMethods`, every version, `methods.scala:1329` |
| 99:19 | `SBox.getReg[T]` | MethodCall | `['T']` | JVM `v6Methods` only (`isV3OrLaterErgoTreeVersion`), `getRegMethodV6` `methods.scala:1338-1347` |
| 101:12 | `SContext.getVarFromInput[T]` | MethodCall | `['T']` | JVM `getVarFromInputMethod` `Seq(tT)`, `methods.scala:1755-1765` |
| 7:6 | `SGroupElement.expUnsigned` | MethodCall | none | monomorphic `SFunc([SGroupElement, SUnsignedBigInt], SGroupElement)` |

**`SBox` register-access dead-branch fork (99:7 vs 99:19).** The JVM declares two `SBox` register-access methods with different ids and different explicit-type-arg counts: id 7 `getRegV5` (registered every version, no type args) and id 19 `getReg` (v6 only, one `T`). An earlier ergots entry `99:7 → ['T']` was transcribed from sigma-rust's `sbox.rs GET_REG`, which diverges from the JVM here. With that wrong entry, ergots consumed one `SType` byte after a JVM-shaped `MethodCall(99, 7, args)` that carries **none** — typically a whole-tree parse reject, but adversarially worse: a crafted tree could re-align and parse successfully on BOTH sides into **different trees** (accept/accept with divergent semantics). The entry is removed; `99:7` now parses as a zero-type-arg MethodCall and — having no registered handler — eval-throws `'method-not-implemented'`, matching the JVM's eval-time `NoSuchMethodException` at every tree version. (`getVarFromInput` 101:12 and `expUnsigned` 7:6 already matched the JVM — no change.)

**Serialize defensive codes:** a name in `explicitTypeArgNames(typeId, methodId)` absent from `e.explicitTypeArgs` throws `ExprSerializeError('property-call-missing-type-arg')` (PropertyCall) or `ExprSerializeError('method-call-missing-type-arg')` (MethodCall). Both are unreachable from a well-parsed tree (the parser always populates every registered name).

### `GroupElement` canonical parse

Every wire ingress that reads a 33-byte GE payload applies **validate + normalize** (establishing the GE canonical-bytes invariant; canonical home `facts/ergoscript-eval.md` Type invariants):

- **0x00-lead** (any bytes 1..32) → NORMALIZE to the canonical 33-zero identity. Mirrors JVM `GroupElementSerializer.parse` (`core/.../GroupElementSerializer.scala:35-42`): any 0x00-lead encoding reads into the identity POINT (payload tail discarded); every JVM egress re-serializes canonically (`:20-33`). Same semantics the lenient `decodePoint` already ships on the eval `DecodePoint` arm.
- **non-0x00-lead** → must curve-decode (secp256k1 SEC1 compressed): bad prefix or x-not-on-curve throws (`'group-element-invalid-point'` at the SValue arm, `'ec-point-invalid'` at SigmaBoolean leaves). The JVM rejects at the same layer — all tree versions, dead branches included.
- **Ingress coverage:** the SValue GE data arm (body + segregated constants, box registers via `parseRegisterExprWithTag`, `deserializeTo[GroupElement]`); SigmaBoolean leaf points (ProveDlog.h, ProveDHTuple g/h/u/v — `wire/sigma-boolean.ts`); the `deserializeTo[Header]` hydration leg (minerPk + v1 powOnetimePk — the JVM parses both through `GroupElementSerializer.parse`, AutolykosSolution serializers, `ErgoHeader.scala:157-180`). The eval `DecodePoint` arm is already conformant (decodes, then re-encodes canonically).
- Curve validation reuses the existing `crypto/secp256k1.ts` `decodePoint` adapter (`@noble/curves` — already a dependency of this package; no new dependency).
- Round-trip consequence: Carve-out 3 (§Round-trip invariant). Serialize side is unchanged — canonical values serialize verbatim, and the invariant guarantees canonicality.

### `LastBlockUtxoRootHash` op-form (`0xa6`)

The bare opcode `0xa6` (= `OpCodes.scala:95`, `LastBlockUtxoRootHash = newOpCode(54)` = 112+54) parses to the dedicated payload-less `Expr` variant `LastBlockUtxoRootHash` and serializes back byte-faithful (the opcode byte is the entire encoding). JVM (canonical): registered via `CaseObjectSerialization(LastBlockUtxoRootHash, LastBlockUtxoRootHash)` (`ValueSerializer.scala:87`) — `serialize` writes nothing, `parse` returns the case object. sigma-rust has NO MIR variant and NO dispatch arm for this opcode (it errors on these bytes; the property is reachable there only as PropertyCall on SContext, method id 9) — the JVM accepts the bare op-form, so ergots parses + evaluates it.

Cost differs by wire shape: the op-form charges the op's own `FixedCost(JitCost(15))` (`values.scala:1495`) while the PropertyCall form observably totals 20 (4 dispatcher + 1 Context obj arm + 15 handler) — both blessed against `jvm:sigma-state-6.0.3`. Modules: `wire/mir/last-block-utxo-root-hash.ts` (parse), the `0xa6` arms in `wire/parse.ts` / `wire/serialize.ts`, eval arm `eval/last-block-utxo-root-hash.ts`. This is the 69th `Expr` variant; see [`facts/ergoscript-eval.md`](./ergoscript-eval.md) for eval coverage.

### `SBox` candidate-size window (4096 bytes)

**Source: JVM `ErgoBoxCandidate.scala:144,191-235` + `ErgoBox.scala:214-225` + `SigmaConstants.scala:24` + `CoreByteReader.scala:25-27,36-108,133-137` + `ValidationRules.scala:169-189`; LAZY semantics empirically pinned (blessed `jvm:sigma-state-6.0.3`).**

ergots' SBox data parse previously rejected token count > 122 (`'sbox-tokens-out-of-range'`), mirroring sigma-rust's `BoundedVec<Token, 1, 122>` data-layer cap (their own comment, `ergo_box.rs:100-104`, marks it a count-shaped approximation of the size rule; `MAX_BOX_SIZE` binds tx-level only there). The JVM data layer has **no token-count rule at all**:

- `ErgoBoxCandidate.serializer.parseBodyWithIndexedDigests` reads `nTokens = r.getUByte()` bare (`ErgoBoxCandidate.scala:200`) — the u8 read's natural ceiling 255 is the only count bound. `SigmaConstants.MaxTokens` (255) binds ONLY in SDK builders (`OutBoxBuilder.scala:34`, `JavaHelpers.scala:369`) — unreachable from parse/eval.
- The real gate is a **4096-byte candidate-size window**: `r.positionLimit = r.position + ErgoBox.MaxBoxSize` (4096, `SigmaConstants.scala:24`) at candidate start (`ErgoBoxCandidate.scala:191-192`), restored at `:235`. The window covers the candidate span value→registers; `txId`/`index` sit OUTSIDE it (`ErgoBox.scala:214-225`). Crossing throws `CheckPositionLimit` = validation rule 1014 (`ValidationRules.scala:169-189`).

**LAZY window semantics:** the JVM checks `position > positionLimit` BEFORE each logical primitive read (`CoreByteReader.scala:25-27`; per-get call sites `:36-108`) — ONE check per logical read (`getULong` = one check, then its VLQ continuation bytes read unchecked; `getBytes` = one check, then N bytes). Consequences:

1. A read whose START is ≤ the limit may END past it (straddle tolerated).
2. An overrun by the candidate's FINAL read ESCAPES entirely — e.g. 2 tokens + a trailing 4200-byte R4 register, candidate 4281 B > 4096 → the JVM ACCEPTS. A small R5 register AFTER the fat R4 errors, because R5's read begins past the limit.
3. A read beginning exactly AT the limit passes (the check is strict `>`).

**Measured boundary** (minimal candidates): 122 tokens = 4038 B; 123 tokens = 4071 B (fits → the JVM accepts — the old 122 cap was not even the right count approximation); 124 tokens = 4104 B (cannot fit → always rejects via rule 1014).

**Nested-window widening:** the JVM `positionLimit_=` is a PLAIN assignment with NO clamp (`CoreByteReader.scala:133-137`), so a nested window (a box constant inside a register of an outer box) may legitimately EXCEED the outer limit for the inner span; the save/restore discipline reinstates the outer limit afterward. The scorex facility mirrors this exactly — canonical contract in [`facts/scorex.md`](./scorex.md) (positionLimit window block).

ergots implementation:

- `@ergots/scorex`'s `ByteReader` gains the `positionLimit` facility: getter + setter (plain assignment, no clamp), default = buffer byte length; entry check at the start of each logical consuming primitive (`readU8`, `readBytes`, `readVlqBigInt`; the other read helpers inherit) → `ReaderError('position-limit-exceeded')`. `forkSubReader` does NOT inherit a parent's limit (its buffer is rebased; fresh default over its own buffer) — callers arm windows on the SHARED reader; the JVM never forks. See [`facts/scorex.md`](./scorex.md).
- The SBox data-parse arm (`parse-svalue.ts`) saves the prior limit, sets `r.position + 4096` at candidate start (before the value read), and restores INLINE after the registers loop and before the txId read — mirroring `:191`/`:235`. No try/finally: a window-overrun throw abandons the parse exactly like the JVM. Applies wherever SBox DATA parses (body/segregated constants, box registers, `deserializeTo[Box]`).
- The >122 parse count-gate is DELETED — no token-count check remains at parse (u8 is the natural ceiling). Window overruns surface as scorex `ReaderError('position-limit-exceeded')`, so SBox parse can throw `ReaderError`, not only `SValueParseError`.
- `serialize-svalue.ts` KEEPS `'sbox-tokens-out-of-range'` but relaxed to threshold > 255 (u8 ceiling): mirrors the JVM egress `putUByte(size)` (`ErgoBoxCandidate.scala:144`; scorex-util `putUByte` asserts 0..255). The JVM applies NO size window on egress — the 4096 window is a parse-only rule.

**Conformance families:** `Box.token_window_const.json` / `Global.deserializeTo_Box_token_window.json` (blessed `jvm:sigma-state-6.0.3`) — covering the 123-token accept, 124-token reject, fat-trailing escape-accept, and fat-then-reg reject shapes.

**sigma-rust divergence (BOTH directions; ergots leads, routed to sigma-rust):** sigma-rust rejects 123–255-token candidates the JVM accepts (count cap tighter than the real rule) AND accepts candidates whose non-final reads begin past 4096 that the JVM rejects (no window at the box data layer). Both directions are consensus-relevant on adversarial bytes; mainnet-honest boxes sit far inside both bounds.

## Error taxonomy (wire-layer error classes)

Every wire-layer error class carries a `code: string` matching one of a fixed set of structural reasons for programmatic dispatch. `.message` is human-readable.

**Root-exported for `instanceof` classification:** the wire parse/serialize error classes — `ErgoTreeParseError`/`ErgoTreeSerializeError`, `ExprParseError`/`ExprSerializeError`, `STypeParseError`/`STypeSerializeError`, `SValueParseError`/`SValueSerializeError`, `SigmaBooleanParseError`/`SigmaBooleanSerializeError` — are all re-exported from the `@ergots/ergoscript` package root. They escape the boundary UNWRAPPED (a caller sees the typed failure from the innermost rejecting layer, never a re-wrap), so a downstream consumer that classifies ergots failures by type can `import` and `instanceof` them. The mir-layer type-inference error `ExprTpeError` and scorex's `ReaderError` are owned by their own modules and are not part of this root-export guarantee.

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

- **`ErgoTreeParseError`**: `'empty'`, `'oversized'`, `'body-size-overflow'`, `'too-many-constants'`, `'header-inconsistent'`, `'trailing-bytes'` (undeclared bytes after the WHOLE ErgoTree — checked on the outer envelope by `parseTree` only; enforces byte-identical round-trip for a standalone tree blob. This is ERG-02's actual requirement; sigma-rust and the JVM both tolerate trailing-after-tree, ergots tightens. The earlier inner-body trailing check inside a hasSize region — which `parseTreeFromReader` once enforced — was retired 2026-06-17: it matched neither reference and split the box path from the bare path; trailing WITHIN a hasSize body's declared size is now tolerated, see Round-trip Carve-out 4), `'subst-length-mismatch'`, `'subst-type-mismatch'` (the last two from `substituteConstantsBytes`; the eval arm re-wraps them as `EvalError('subst-constants-error')`), `'header-version-requires-size'` (rule-1012 `CheckHeaderSizeBit`: a tree header with version > 0 and the size bit (0x08) clear is rejected at parse, mirroring JVM `ValidationRules.scala:138-151` enforced at `ErgoTreeSerializer.scala:219`; applies to the main tree header AND substConstants template headers; unconditional; adversarial-only — mainnet v>0 trees carry the size bit).
- **`ErgoTreeSerializeError`**: `'header-inconsistent'`, `'constants-arity-mismatch'`, `'oversized'` (serialized bytes would exceed `MAX_TREE_SIZE` — the serializer must not emit bytes `parseTree` would refuse), `'too-many-constants'` (`tree.constants.length` exceeds `MAX_CONSTANTS_COUNT` = 4096).
- **`ExprParseError`**: `'opcode-reserved'` (21 sites — reserved in sigma-rust's `OpCode` enum but never dispatched at the wire-Expr layer or implemented in `ergotree-interpreter/src/eval/`; the JVM rejects each identically via `CheckValidOpCode` (rule 1002) since `getSerializer` returns null; covers `OpTrue`, `OpFalse`, `UnitConstant`, `Select1..Select5`, `SomeValue`, `NoneValue`, `ModQ`, `PlusModQ`, `MinusModQ`, `CollShiftLeft/Right/RightZeroed`, `CollRotateLeft/Right`, plus `FlatMap`, `TrivialPropFalse`, `TrivialPropTrue`; named to reflect permanent state rather than forward-promise. The `FlatMap`/`TrivialPropFalse`/`TrivialPropTrue` trio had thrown `'not-implemented-yet'` but the JVM rejects all three via the SAME reserved-opcode path; their non-bare forms reach us elsewhere: `flatMap` as an SColl method-call, and the `TrivialProp` pair as a SigmaBoolean LEAF inside a `SigmaPropConstant` (`SigmaPropCodes`, parsed by `wire/sigma-boolean.ts` — a wholly separate path, untouched)); the wire layer no longer emits `'not-implemented-yet'` (the `LastBlockUtxoRootHash` `0xa6` op-form left the old not-impl-yet group — it now parses + evaluates, see `LastBlockUtxoRootHash op-form` above; `'not-implemented-yet'` survives only as an `EvalError` code for legitimately-TBD eval support, distinguished by error class); `'unknown-opcode'` (byte not in sigma-rust's opcode table at all); plus per-variant codes including `'apply-too-many-args'`, `'block-too-many-items'`, `'collection-size-out-of-range'`, `'deserialize-context-id-out-of-range'`, `'deserialize-register-id-out-of-range'`, `'extract-register-as-id-out-of-range'`, `'func-value-too-many-args'`, `'fun-def-tpe-arg-not-type-var'` (a declared `FunDef` type-arg did not parse to an `STypeVar`; see `ValDef / FunDef` above), `'fun-def-tpe-args-out-of-range'` (`FunDef` `nTpeArgs` count > 127, at parse or serialize; the JVM reads the count via signed `getByte` → `safeNewArray` (parse, rejects a negative size) and emits it via `put(len.toByteExact)` (serialize, caps 127); see `ValDef / FunDef` above), `'get-var-id-out-of-range'`, `'invalid-binop-opcode'`, `'invalid-constant-placeholder-id'`, `'method-call-id-out-of-range'`, `'method-call-missing-type-arg'`, `'method-call-too-many-args'`, `'property-call-id-out-of-range'`, `'select-field-index-out-of-range'`, `'tuple-arity-out-of-range'`, `'unknown-binop-kind'`, `'val-def-id-out-of-range'` (`ValDef.id` > `Int.MaxValue`/0x7fffffff; the JVM `ValDefSerializer` reads it with `getUIntExact` which rejects above the inclusive max; unconditional/not version-gated; **narrow** — `ValUse`/`FuncValue` argument ids deliberately use the JVM's wrapping `getUInt.toInt` and are NOT bound), `'val-def-rhs-tpe'`, `'val-use-unknown-id'`.
  - **`'tuple-arity-out-of-range'` scope:** parse rejects count ≥ 128 ONLY (JVM `TupleSerializer.parse` reads the count via signed `getByte()` — 0x80..0xFF go negative into `safeNewArray` → `NegativeArraySizeException`; arity 0/1 PARSES on the JVM, `mkTuple` is bare and `Tuple.tpe` lazy, and rejects at EVAL — `'tuple-invalid-arity'`); serialize rejects > 255 only (`putUByte` range — JVM serialize has no arity gate, so arity 128..255 serializes but cannot re-parse, a JVM-mirrored asymmetry).
- **`ExprSerializeError`**: `'not-supported'` (the `ZkProofBlock` variant — matches sigma-rust's `NotSupported`); `'unknown-variant'` (compile-time-unreachable fallback for the exhaustive switch); `'property-call-missing-type-arg'` (`serializePropertyCall` found a type-parameter name in `explicitTypeArgNames(typeId, methodId)` absent from `e.explicitTypeArgs`; defensive, unreachable from a well-parsed tree; mirrors `'method-call-missing-type-arg'` on the parse side); `'val-def-id-out-of-range'` (serialize-side symmetry of the parse bound: locally-constructed MIR with `ValDef.id` > `Int.MaxValue` would emit bytes the JVM rejects at `getUIntExact`).
- **`STypeParseError`**: `'invalid-type-code'`, `'unsupported-type'`, `'invalid-sfunc-tpe-params'`.
- **`STypeSerializeError`**: `'tuple-too-short'`, `'tuple-too-long'`, `'stypevar-name-length'`, `'sfunc-tdom-too-long'`, `'sfunc-tpe-params-too-long'`, `'unreachable'`.
- **`SValueParseError`**: `'bigint-too-large'`, `'bigint-empty'` (SBigInt value payload of length 0 — mirrors sigma-rust `BigInt256::from_be_slice` returning None on empty / JVM `new BigInteger(byte[0])` throw; the pre-fix code accepted len 0 as `0n`, breaking byte round-trip), `'coll-length-out-of-range'`, `'group-element-invalid-point'` (the SValue GE data-parse arm curve-validates non-0x00-lead 33-byte payloads via secp256k1 SEC1 decode (bad prefix or x-not-on-curve rejects), mirroring JVM `GroupElementSerializer.parse:35-42` → decodePoint throw; 0x00-lead payloads NORMALIZE to the canonical 33-zero identity (bytes 1..32 discarded); applies wherever GE DATA parses; all tree versions, dead branches included; adversarial-only — honest tools emit valid points. See `GroupElement canonical parse` above), `'not-implemented-phase-2a'` (still emitted for the deferred SValue kinds `SPreHeader`/`SContext`/`SGlobal`/`SAny`/`SString`/`SFunc`/`STypeVar`; `SBox`, `SAvlTree`, and `SHeader` are implemented and no longer throw it), `'sheader-tree-version-too-low'` (SHeader SValue constant in a tree-version < 3 ErgoTree; mirrors sigma-rust `serialization/data.rs:196`), `'soption-tree-version-too-low'` (SOption SValue constant in a tree-version < 3 ErgoTree; mirrors JVM `CoreDataSerializer.scala:140-143` — pre-v3 Option DATA falls through to `CheckSerializableTypeCode`/ValidationRule 1009 + `SerializerException`; recursive — Option nested anywhere in a constant's type tree rejects), `'unreachable'`, `'sbox-registers-out-of-range'`, `'sbox-register-tuple-arity'` (an SBox register encoded as a Tuple Expr declares fewer than 2 items), `'sbox-register-unsupported-expr'` (an SBox register's leading Expr tag is neither a Constant nor a Tuple — sigma-rust `register.rs:140-162` accepts only those), `'sbox-creation-height-out-of-range'` (parse rejects creation_height > 2^31-1 / Int.MaxValue, mirroring the JVM consensus reader `getUIntExact` = `getUInt().toIntExact`, `ErgoBoxCandidate.scala:195` — NOT u32; the prior `> 0xffffffff` bound mirrored the non-canonical sigma-rust `get_u32` and was a latent fork on a hand-crafted height in (2^31, 2^32)), `'sbox-index-out-of-range'` (parse rejects index > u16, matching `get_u16`; previously serialize-only), `'unsigned-bigint-too-large'` (UBI payload > 32 bytes; mirrors `CoreDataSerializer.scala:120`), `'register-v6-type'` (rule-1019 `CheckV6Type`: a box register whose declared type contains `SOption` / `SHeader` / `SUnsignedBigInt` (recursing through `STuple` items + `SColl` elemType) is rejected at register ingress in `parseRegisterExprWithTag`, mirroring JVM `ValidationRules.scala:165-205` enforced at `ErgoBoxCandidate.scala:232`; **UNCONDITIONAL — all tree versions** (the rule is in both ruleSpecsV5 and ruleSpecsV6); distinct from the body-constant `'soption-tree-version-too-low'` gate and the `validate-v6-types` body pass; adversarial-only — mainnet boxes can't carry these register types. Context-extension leg deferred: ergots has no extension wire-parser yet).
- **`SValueSerializeError`**: `'bigint-too-large'`, `'numeric-out-of-range'` (a fixed-width numeric SValue — SByte/SShort/SInt/SLong — whose value is outside its signed range i8/i16/i32/i64; the pre-fix serializer silently masked/wrapped out-of-range values so they round-tripped to a DIFFERENT value), `'group-element-length'`, `'coll-length-out-of-range'`, `'coll-item-kind-mismatch'`, `'tuple-arity-mismatch'`, `'sigma-boolean-empty'`, `'type-value-mismatch'`, `'kind-mismatch'` (defensive — the `serializeSValue` SString arm received an SValue whose `kind` is not `'String'`), `'not-implemented-phase-2a'` (same deferred-kinds set as parse), `'sheader-tree-version-too-low'` (SHeader SValue with tree-version < 3 passed to `serializeSValue`; mirrors sigma-rust `serialization/data.rs:98`), `'soption-tree-version-too-low'` (serialize-side mirror, `CoreDataSerializer.scala:78-82`), `'unreachable'`, `'token-id-length'`, `'txid-length'`, `'sbox-registers-not-dense'`, `'sbox-index-out-of-range'`, `'sbox-creation-height-out-of-range'` (serialize rejects creation_height > 2^31-1 / Int.MaxValue, mirroring the parse bound / JVM `getUIntExact`), `'sbox-tokens-out-of-range'` (serialize-ONLY, threshold > 255 — mirrors the JVM egress `putUByte(size)` (`ErgoBoxCandidate.scala:144`; scorex-util `putUByte` asserts 0..255). The parse-side count gate is removed; the JVM has NO size window on egress — the 4096-byte window is parse-only. See `SBox candidate-size window` above), `'savltree-tree-flags-out-of-range'`, `'savltree-key-length-out-of-range'`, `'savltree-value-length-out-of-range'`, `'unsigned-bigint-too-large'` (defensive encoder guard — out-of-range UBI is an internal invariant violation, unreachable from valid parse or v6 method result, but guarded), `'unsigned-bigint-negative'` (defensive guard in `encodeUnsignedBigIntBE` when caller passes a negative bigint — unsigned type admits no negatives).
- **`SigmaBooleanParseError`**: `'arity-out-of-range'`, `'unknown-opcode'`, `'cthreshold-k-out-of-range'` (Cthreshold's `k` outside `[1, items.length]`), `'sigma-conjecture-empty-items'` (Cand/Cor/Cthreshold parsed with `items.length === 0`), `'ec-point-invalid'` (ProveDlog.h and ProveDHTuple g/h/u/v leaf points get the same validate+normalize as the SValue GE arm: 0x00-lead → canonical identity, non-0x00-lead must curve-decode; the JVM parses these leaves through the same `GroupElementSerializer.parse` (`SigmaBoolean.scala:36-44,71-80` via ProveDlogSerializer/ProveDHTupleSerializer); sibling of the pre-existing `'ec-point-length'`).
- **`ExprTpeError`** (raised by `exprTpe`, the SType-of-Expr projection): `'apply-func-not-sfunc'`, `'bin-op-kind-unhandled'`, `'by-index-input-not-scoll'`, `'map-mapper-not-sfunc'` (Map's mapper static type is not `SFunc`), `'option-get-input-not-soption'`, `'option-get-or-else-input-not-soption'` (OptionGetOrElse's input static type is not `SOption`), `'select-field-input-not-stuple'`, `'select-field-out-of-range'`, `'tpe-not-implemented'`.
- **`ReaderError`** (raised by `@ergots/scorex`'s `ByteReader`; canonical enumeration lives in [`facts/scorex.md`](./scorex.md)): `'truncated'`, `'vlq-overflow'`, `'slice-out-of-bounds'`, `'array-too-large'`, `'max-tree-depth-exceeded'`, `'position-limit-exceeded'` (an SBox candidate's read begins past the 4096-byte window; see `SBox candidate-size window` above).
- **`AddressDecodeError`**: `'bad-base58'`, `'too-short'`, `'too-long'` (`ergoTreeFromAddress` rejects an address string longer than `MAX_ADDRESS_STRING_LENGTH`, bounding the O(n²) base58 decoder), `'checksum-mismatch'`, `'invalid-p2pk-length'`, `'p2sh-unsupported'`, `'unknown-type'`, `'unknown-network'` (`addressFromErgoTree` given a `network` other than `'mainnet'`/`'testnet'` — guards untyped / `as any` callers that bypass the `Network` literal type).

No other wire-layer error classes are emitted by this package. Internal panics (e.g. a bug in `@noble/hashes`) bubble up as plain `Error` — those represent contract violations *inside* the package and are bugs, not input-shape issues. For runtime/eval errors see [`facts/ergoscript-eval.md`](./ergoscript-eval.md) `EvalError` taxonomy. For verifier errors see [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) `VerifyError` taxonomy.

### Retired / non-emitted wire codes (kept for provenance)

These codes were emitted by earlier source and are now removed — kept here so the historical token resolves and the JVM-faithfulness reason survives:

- **`'invalid-option-tag'`** — retired. Any nonzero wire Option tag now parses as Some (JVM scorex-util `getOption`; sigma-rust's `get_option` `1 => Some, _ => None` was a FORK on tags ≥ 2, no longer mirrored). Its last two sites were `DeserializeRegister.default` (now JVM `DeserializeRegisterSerializer.scala:30` `r.getOption(r.getValue())`) and the `CreateAvlTree` 4th operand (now an Option-typed expr, no tag). See Carve-out 2.
- **`'invalid-tuple-length'`** — retired. The generic-tuple TYPE parse arm mirrors JVM `TypeSerializer.scala:188-194` (`getUByte` + bare `STuple(items)`, no arity require), so arity-0/1 generic-tuple TYPES parse; the TYPE serializer keeps rejecting < 2 (`'tuple-too-short'`, `TypeSerializer.scala:93-94` `sys.error`) — parse/serialize asymmetric on the JVM itself. See Carve-out 1.
- **`'savltree-digest-length'`** — retired. The serializer writes the digest verbatim at any length — the JVM `DataSerializer` has no length require; parse-side remains fixed-33 (a JVM asymmetry). An AvlTree SValue with non-33-byte digest serializes fine but does NOT round-trip through parse.
- **`'sbox-ergo-tree-no-size'`** — removed. `parseSValue(SBox)` handles v0+hasSize=false ErgoTrees via `parseErgoTreeBytes` → `parseTreeFromReader` (the body Expr grammar is self-delimiting); the rejection was an incorrect assumption — ~99% of mainnet boxes use v0 P2PK trees without a size prefix.
- **`'invalid-stypevar-length'`** — retired. The `STypeVar` name-length parse mirrored sigma-rust's `BoundedVec<1, 254>` and rejected name lengths 0 and 255; the JVM (`TypeSerializer.deserialize:203`) reads the length via unbounded `getUByte()` and accepts 0..=255, so the bound was a fork in both directions (over-rejecting 0 and 255). Parse now accepts 0..=255 (truncation still caught by `readBytes`); serialize keeps `'stypevar-name-length'` for `> 255` only. See `STypeVar name — length + UTF-8 decode` above.
- **`'invalid-stypevar-utf8'`** — retired. The `STypeVar` name-bytes parse used a strict `TextDecoder({fatal:true})` that THREW on ill-formed UTF-8; the JVM (`TypeSerializer.deserialize:203`, `new String(bytes, UTF_8)`) lossy-decodes to U+FFFD and never rejects. Parse now uses `decodeUtf8Lossy` (Java `new String` collapse counts, incl. the `ed a0 80` surrogate → 1 U+FFFD vs WHATWG/Rust 3); no parse-side reject remains, and `serializeSType`'s `'stypevar-name-length'` (`> 255` bytes) is the only remaining STypeVar-name serialize reject. See `STypeVar name — length + UTF-8 decode` above + the SANTA `STypeVar.name_utf8_roundtrip` vector.

## Coverage

100% of MIR variants parse and serialize byte-identically against the PR 862 corpora (45 legacy + 14 ecosystem + 9 sig-15 = 68 trees), plus mainnet boxes (12,712 from the wider corpus + 173 from the original C2 corpus). Corpus round-trip test: 255 passing fixtures + 1 mainnet stub + 6 `known_unstable` (sigma-rust itself does not round-trip them).

The parse-mutation suite exercises 6,221 single-byte mutations: 66% throw a typed error class, 0 throw an untyped error, 100% taxonomy coverage (every wire-layer error class above is hit at least once).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting guarantees
- [`facts/ergoscript-eval.md`](./ergoscript-eval.md) — evaluator surface (`SValue` / `SType` / `Expr` canonical definitions)
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier (`SigmaBoolean` 6-variant union, `verifySignature`, `VerifyError`)
- [`facts/scorex.md`](./scorex.md) — codec layer; defines `ByteReader`, `ByteWriter`, `ReaderError`, VLQ functions consumed throughout this file
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — design rationale, phase plan, validation strategy
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language specification for opcode semantics
