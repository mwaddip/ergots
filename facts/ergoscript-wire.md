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

## Round-trip invariant

For any byte sequence `b` accepted by `parseTree`:

```
serializeTree(parseTree(b)) === b   (byte-equal)
```

This holds for every ErgoTree variant we ship. The phase 2a corpus test asserts this on 255 passing fixtures plus 1 mainnet-fixture stub plus 6 upstream-buggy fixtures (the 6 are excluded from byte-equality; sigma-rust itself does not round-trip them — see `fixture-gen/known_unstable.json`).

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

- **`ErgoTreeParseError`**: `'empty'`, `'oversized'`, `'body-size-overflow'`, `'too-many-constants'`, `'header-inconsistent'`, `'subst-length-mismatch'`, `'subst-type-mismatch'` (the last two from `substituteConstantsBytes`; the eval arm re-wraps them as `EvalError('subst-constants-error')`).
- **`ErgoTreeSerializeError`**: `'header-inconsistent'`, `'constants-arity-mismatch'`.
- **`ExprParseError`**: `'opcode-reserved'` (19 sites — reserved in sigma-rust's `OpCode` enum but never dispatched at the wire-Expr layer or implemented in `ergotree-interpreter/src/eval/`; covers `OpTrue`, `OpFalse`, `UnitConstant`, `Select1..Select5`, `FunDef`, `SomeValue`, `NoneValue`, `ModQ`, `PlusModQ`, `MinusModQ`, `CollShiftLeft/Right/RightZeroed`, `CollRotateLeft/Right`; added phase 2i-d, renamed from `'not-implemented-yet'` to reflect permanent-state rather than forward-promise); `'not-implemented-yet'` (4 wire sites still using it — `LastBlockUtxoRootHash`, `FlatMap`, `TrivialPropFalse`, `TrivialPropTrue` — routed through other dispatch paths in sigma-rust (PropertyCall id 9, SColl method-call, SSigmaProp nesting); top-level direct-dispatch status undetermined pending separate review; ALSO emitted by the `EvalError` class for legitimately-TBD eval support — distinguished from this wire-layer use by error class); `'unknown-opcode'` (byte not in sigma-rust's opcode table at all); plus per-variant codes including `'apply-too-many-args'`, `'block-too-many-items'`, `'collection-size-out-of-range'`, `'deserialize-context-id-out-of-range'`, `'deserialize-register-id-out-of-range'`, `'extract-register-as-id-out-of-range'`, `'func-value-too-many-args'`, `'get-var-id-out-of-range'`, `'invalid-binop-opcode'`, `'invalid-constant-placeholder-id'`, `'invalid-option-tag'`, `'method-call-id-out-of-range'`, `'method-call-missing-type-arg'`, `'method-call-too-many-args'`, `'property-call-id-out-of-range'`, `'select-field-index-out-of-range'`, `'tuple-arity-out-of-range'`, `'unknown-binop-kind'`, `'val-def-rhs-tpe'`, `'val-use-unknown-id'`.
- **`ExprSerializeError`**: `'not-supported'` (the `ZkProofBlock` variant — matches sigma-rust's `NotSupported`); `'unknown-variant'` (compile-time-unreachable fallback for the exhaustive switch).
- **`STypeParseError`**: `'invalid-type-code'`, `'unsupported-type'`, `'invalid-tuple-length'`, `'invalid-stypevar-length'`, `'invalid-stypevar-utf8'`, `'invalid-sfunc-tpe-params'`.
- **`STypeSerializeError`**: `'tuple-too-short'`, `'tuple-too-long'`, `'stypevar-name-length'`, `'sfunc-tdom-too-long'`, `'sfunc-tpe-params-too-long'`, `'unreachable'`.
- **`SValueParseError`**: `'bigint-too-large'`, `'coll-length-out-of-range'`, `'not-implemented-phase-2a'` (still emitted for `SPreHeader`/`SContext`/`SGlobal`/`SAny`/`SString`/`SFunc`/`STypeVar`; `SBox` removed in phase 2f Stop α, `SAvlTree` removed in phase 2h-b, `SHeader` removed in phase 2h-c.1), `'sheader-tree-version-too-low'` (SHeader SValue constant in a tree-version < 3 ErgoTree; mirrors sigma-rust `serialization/data.rs:196`), `'unreachable'`, `'sbox-tokens-out-of-range'`, `'sbox-registers-out-of-range'`, `'sbox-creation-height-out-of-range'` (parse rejects creation_height > u32, matching sigma-rust `get_u32`; audit follow-up), `'sbox-index-out-of-range'` (parse rejects index > u16, matching `get_u16`; previously serialize-only). (`'sbox-ergo-tree-no-size'` removed in phase 2j-pre fix-1 — see changelog below.)
- **`SValueSerializeError`**: `'bigint-too-large'`, `'group-element-length'`, `'coll-length-out-of-range'`, `'coll-item-kind-mismatch'`, `'tuple-arity-mismatch'`, `'sigma-boolean-empty'`, `'type-value-mismatch'`, `'not-implemented-phase-2a'` (same deferred-kinds set as parse; `SBox` removed in phase 2f Stop α, `SAvlTree` removed in phase 2h-b, `SHeader` removed in phase 2h-c.1), `'sheader-tree-version-too-low'` (SHeader SValue with tree-version < 3 passed to `serializeSValue`; mirrors sigma-rust `serialization/data.rs:98`), `'unreachable'`, `'token-id-length'`, `'txid-length'`, `'sbox-registers-not-dense'`, `'sbox-index-out-of-range'`, `'sbox-creation-height-out-of-range'` (serialize rejects creation_height > u32; audit follow-up), `'sbox-tokens-out-of-range'`, `'savltree-digest-length'`, `'savltree-tree-flags-out-of-range'`, `'savltree-key-length-out-of-range'`, `'savltree-value-length-out-of-range'`.
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
  digest: Uint8Array              // exactly 33 bytes (32-byte root hash + 1-byte tree height)
  treeFlags: number               // u8: bit 0 insertAllowed, bit 1 updateAllowed, bit 2 removeAllowed, bits 3-7 reserved
  keyLength: number               // u32 (VLQ-encoded on the wire)
  valueLengthOpt: number | null   // null = variable; non-null = fixed value length
}
```

The wire format mirrors sigma-rust `ergotree-ir/src/mir/avl_tree_data.rs:71-90`:

1. `digest` — ADDigest `scorex_serialize` is `write_all(self.0)` for `Digest<33>` (ergo-chain-types/src/digest32.rs:149-153). On-wire: 33 RAW bytes, NO length prefix. The 33rd byte is the tree-height byte.
2. `treeFlags` — single `u8` via `put_u8`. Bits 3-7 round-trip identically (no masking).
3. `keyLength` — VLQ `u32` via `put_u32` (which is `put_u64(v as u64)` in sigma-ser/src/vlq_encode.rs:78). NOT fixed 4-byte big-endian.
4. `valueLengthOpt` — `Option<Box<u32>>` SigmaSerializable (serialization/serializable.rs:212-231):
   - `Some(v)`: `0x01` tag + VLQ-u32 inner value.
   - `None`: `0x00` tag.
   - Parser is permissive: any non-zero tag byte is treated as `Some`. Serializer canonicalizes to `0x01` for `Some`.

New `SValueSerializeError` codes added by this slice: `'savltree-digest-length'`, `'savltree-tree-flags-out-of-range'`, `'savltree-key-length-out-of-range'`, `'savltree-value-length-out-of-range'`. No new `SValueParseError` codes (the parser delegates length / VLQ-overflow checks to `ByteReader`).

## Phase 2h-c.1 wire updates (SHeader)

`parseSValue(SHeader, treeVersion, r)` and `serializeSValue(SHeader, v, treeVersion, w)` ship in phase 2h-c.1, replacing the phase-2a `'not-implemented-phase-2a'` throw. Both functions delegate to `@ergots/scorex`'s `parseHeader` / `serializeHeader`. The wire format is V3-gated — V<3 trees throw `SValueParseError('sheader-tree-version-too-low')` (parse) / `SValueSerializeError('sheader-tree-version-too-low')` (serialize), mirroring sigma-rust `data.rs:196` and `:98`.

Signature change: both `parseSValue` and `serializeSValue` gain a `treeVersion: number` parameter, threaded through every recursive call site (Coll, Tuple, Option arms). `parseTree` and `serializeTree` inject `treeVersion` from `tree.header.version`.

The internal helpers `parseExpr`, `serializeExpr`, `parseConstFromByte`, and `serializeConst` also gain `treeVersion` parameters. Their **public entry points** (`parseExpr`, `serializeExpr`) accept `treeVersion` as an optional parameter defaulted to `0` — direct callers of these from outside the envelope (test helpers, external tooling) that work with V3+ trees containing inline SHeader body constants must pass an explicit `treeVersion`. The top-level `parseTree` / `serializeTree` always pass the correct version, so production paths are unaffected.

Round-trip invariant byte-equal verified on 5 V3 SHeader-constant ErgoTree fixtures (single V1 header, single V2 header, `Coll[Header]` of 3, `Option[Header] = Some`, `Option[Header] = None`) plus 1 negative V2 fixture (rejects with `'sheader-tree-version-too-low'`). Mutation testing achieves ≥ 90% kill rate on structural bytes per fixture (87.5% on `Option[Header] = None` due to sigma-rust's `get_option` accepting any non-1 byte as None).

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
