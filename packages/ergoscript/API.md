# API — `@ergots/ergoscript`

Public surface for the ErgoTree wire-format package. The wire format and serialization semantics this implements come from `ergotree-ir` (sigma-rust, branch `integration/ergots`); see [`facts/ergoscript.md`](../../facts/ergoscript.md) in the repo root for the load-bearing interface contract.

## Entry points

| Import path | Purpose |
|---|---|
| `@ergots/ergoscript` | Parse + serialize ErgoTree; address ↔ ErgoTree conversion |

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, or other Node built-ins. No WASM.

## Scope

This package ships (as of v0.3.0, published to npm as `@ergots/ergoscript@0.2.0`):

- **Wire format (phase 2a).** Full `parseTree` / `serializeTree` round-trip; byte-identical against sigma-rust on ~63 MIR variants.
- **Evaluator (phases 2b–2i-c, 2j, JVM-alignment, v6 P0–P6, F1–F5 batch 4).** `evaluate` / `evaluateWith` cover **68 of 68 implementable `Expr` arms** plus a **134-entry method-call handler registry** and **86 `EvalError` codes**. AVL+ membership-proof verification ships via `@ergots/avltree`. Cost validation is complete: the mainnet walk reached tip (h≈1,797,470) with zero unhandled halts. V3 (ErgoTree v6) methods are fully implemented (phases P0–P6), including first-class functions (lexical closures; `FunDef` as a `ValDef`; type-var-apply reject).
- **Sigma-protocol verifier (phases 2g-medium, 2g-combinators).** `verifySignature` covers the full `SigmaBoolean` 6-variant surface (`TrivialProp`, `ProveDlog`, `ProveDhTuple`, `Cand`, `Cor`, `Cthreshold`).
- **Sigma-verification cost.** `estimateCryptoCost(sb: SigmaBoolean): number` returns the ahead-of-time sigma-protocol verification cost (JitCost units) of a reduced proposition — the cost-companion of `verifySignature`, consumed by `@ergots/transaction`'s block-cost model. Constants are JVM-faithful (`Interpreter.estimateCryptoVerifyCost`): ProveDlog 3980, ProveDhTuple 7140, Cand/Cor `15 + Σ`, Cthreshold `(10+10·nCoefs)+(3+3·nCoefs)·n + 15 + Σ` (the `+15` that the vendored sigma-rust `crypto_cost.rs` omits). See `facts/ergoscript-sigma.md`.

What this package is NOT:

- **NOT a substitute for sigma-rust or a JVM node** on any binding decision. Use this package for tooling (parse / address derivation / simulators / dev frontends) and for unsigned-side prep / preview of script evaluation. For consensus-grade acceptance, combine with sigma-rust.
- **NOT fully free of `'not-implemented-yet'` paths.** 3 defensive `EvalError` sites remain (`eval.ts:232`, `global-vars.ts:136`, `bin-op/bit.ts:58`) — see the `evaluate` coverage caveat below. The wire layer no longer emits `'not-implemented-yet'`: 21 wire opcodes are reserved-but-parse-rejected (`ExprParseError 'opcode-reserved'`, mirroring the JVM `CheckValidOpCode` reject), including `FlatMap`/`TrivialPropFalse`/`TrivialPropTrue` (`LastBlockUtxoRootHash` left this group in F5 batch 4 — its bare `0xa6` op-form now parses and evaluates).

A `evaluate(tree)` success means: the tree parses, the implemented arms hit by execution all returned the documented SValue, and `jitCost` stayed within `jitCostLimit` (if set). It does NOT mean "the script would be accepted by an Ergo full node."

---

## Primary export

```ts
import {
  parseTree, serializeTree,
  isP2PK, p2pkPublicKey,
  addressFromErgoTree, ergoTreeFromAddress,
  base58Encode, base58Decode,
  parseSValue, serializeSValue,
  parseSType, serializeSType,
  parseErgoTreeBytes, parseAdditionalRegisters,
  boxTreeOf, reencodeTreeBytes, seedBoxTree, boxBytesOf, boxIdOf,
  violatesCheckV6Type, sValueStructuralEq,
  parseSigmaBoolean, serializeSigmaBoolean,
  isUnparsedTree,
  MAX_TREE_SIZE, MAX_PROPOSITION_SIZE, VERSION,
  type ErgoTree, type ParsedErgoTree, type UnparsedErgoTree, type TreeHeader,
  type ParseTreeOptions, type SType, type SValue, type Expr, type ErgoBox,
  type AdditionalRegisters,
  type Network, type AddressType,
  ErgoTreeParseError, ErgoTreeSerializeError, AddressDecodeError,
  ExprParseError, ExprSerializeError, ExprTpeError,
  STypeParseError, STypeSerializeError,
  SValueParseError, SValueSerializeError,
  SigmaBooleanParseError, SigmaBooleanSerializeError,
} from '@ergots/ergoscript';
```

### `parseTree(bytes, opts?)`

```ts
function parseTree(bytes: Uint8Array, opts?: ParseTreeOptions): ErgoTree;
interface ParseTreeOptions {
  checkType?: boolean;   // rule 1001: the root must type as SigmaProp; default false (lenient)
}
```

Parse the ErgoTree wire format — header byte, optional VLQ-u32 body size, optional segregated constants section, body Expr — into an `ErgoTree`. It mirrors the JVM's `deserializeErgoTree`: the tree is read under a 4096-byte window (`MAX_PROPOSITION_SIZE`), and a size-flagged tree's declared size is used only if the tree degrades.

- **Precondition:** `1 ≤ bytes.length ≤ MAX_TREE_SIZE` (1 MB).
- **Options:** `checkType` applies rule 1001 (the JVM's `CheckDeserializedScriptIsSigmaProp`). It is off by default, as in the JVM's lenient parse, which reads arbitrary-root trees; `{ checkType: true }` is the JVM's `ErgoTree.fromBytes`. Box ingest and address decoding set it.
- **Returns:** A `ParsedErgoTree`, or, for a size-flagged tree whose constants, body or root check fails soft-forkably (the JVM's `ValidationException`, for example a reserved or unknown opcode, an Option in a pre-v3 tree, a read past the window, or rule 1001 with `checkType`), an `UnparsedErgoTree` holding the tree's declared span as received. Narrow with `isUnparsedTree`. For a canonically encoded tree, `serializeTree` gives the input back (see "Round-trip invariant" below). A tree whose declared size differs from its body parses its whole body and re-serializes with its true size. Bytes after the parse end are tolerated only within a size-flagged tree's declared span.
- **Throws:** `ErgoTreeParseError` for the envelope (`'empty'`, `'oversized'`, `'trailing-bytes'`) and the tree parse (`'header-version-requires-size'`, `'body-size-overflow'`, `'too-many-constants'`, `'soft-fork-without-size-bit'`, `'nested-tree-truncated'`). Two of those wrap an earlier error, kept as `cause`: a soft-forkable failure in a tree without the size flag throws `'soft-fork-without-size-bit'` (it once surfaced as, for example, `ExprParseError('opcode-reserved')`), and a nested tree (a Box constant's tree) that runs out of input while reading its constants or body, or whose degrade span runs past the end, throws `'nested-tree-truncated'`. A nested tree reads its header and size before that, so a run-out there counts as a run-out of the enclosing tree, not of the nested one. Every other failure surfaces unwrapped from the layer that rejected the bytes: `ExprParseError`, `STypeParseError`, `SValueParseError`, `SigmaBooleanParseError`, `ExprTpeError` (a root type the JVM cannot build, with `checkType` only), or scorex's `ReaderError` (`'truncated'`, `'vlq-overflow'`, `'max-tree-depth-exceeded'`). A read past the 4096-byte window, or past a Box constant's candidate window (rule 1014, `'position-limit-exceeded'`), degrades a sized tree and is wrapped for an unsized one, so it never surfaces on its own. Full taxonomy: `facts/ergoscript-wire.md`.

```ts
const tree = parseTree(treeBytes);
if (!isUnparsedTree(tree)) console.log(tree.header.version, tree.constants.length, tree.body.tag);
const boxRules = parseTree(treeBytes, { checkType: true }); // as the JVM parses a box's tree
```

### `serializeTree(tree)`

```ts
function serializeTree(tree: ErgoTree): Uint8Array;
```

Inverse of `parseTree`, written as the JVM's `serializeErgoTree` writes a tree: an `UnparsedErgoTree` as its bytes, a parsed tree from its structure, with the header byte as stored and, for a size-flagged tree, the size of the constants and body actually written. For a canonically encoded `b`, `serializeTree(parseTree(b))` equals `b` byte-for-byte (see "Round-trip invariant" below).

- **Precondition:** `tree` was either returned from `parseTree` or constructed satisfying the type invariants below. Bits 0–4 of `header.rawHeader` (version, size flag, segregation flag) MUST match `header.version`, `header.hasSize` and `header.constantSegregation` (checked at serialize time); bits 5–7 are free and written as stored. `constantTypes.length === constants.length` is required.
- **Returns:** `Uint8Array` of length ≤ `MAX_TREE_SIZE`.
- **Throws:** `ErgoTreeSerializeError` with `code` `'header-inconsistent'` (bits 0–4 of rawHeader do not match the derived `(version, hasSize, segregation)` triple), `'constants-arity-mismatch'`, `'oversized'` (the result would exceed `MAX_TREE_SIZE`) or `'too-many-constants'` (more than 100000 constants, the parse bound). Body-serialize failures surface unwrapped as `ExprSerializeError` (notably `'not-supported'` for the un-encodable `ZkProofBlock` variant), `STypeSerializeError`, `SValueSerializeError` or `SigmaBooleanSerializeError`. Some trees parse but cannot be written, in ergots as in the JVM, so `serializeTree` throws for them: an arity-0/1 tuple type (`'tuple-too-short'`), a FuncValue argument id or ValUse id of 2^31 or more (`'func-value-arg-id-out-of-range'`, `'val-use-id-out-of-range'`), an AvlTree constant's `keyLength` or `valueLengthOpt` of 2^31 or more (`'savltree-key-length-out-of-range'`, `'savltree-value-length-out-of-range'`), and an `STypeVar` name whose re-encoding exceeds 255 bytes (`'stypevar-name-length'`).

### `isP2PK(tree)` / `p2pkPublicKey(tree)`

```ts
function isP2PK(tree: ErgoTree): boolean;
function p2pkPublicKey(tree: ErgoTree): Uint8Array | null;
```

Recognize a canonical P2PK guarding script and extract its public key.

- **`isP2PK`:** Returns `true` iff the tree's body is `Const(SSigmaProp, ProveDlog(EcPoint))` — or a `ConstPlaceholder` resolving to the same — matching sigma-rust's `Address::P2Pk.script()` recognition (`ergotree-ir/src/chain/address.rs:206-218`).
- **`p2pkPublicKey`:** Returns a fresh defensive copy of the 33-byte compressed secp256k1 public key when `isP2PK(tree)` is true, else `null`. The returned buffer is mutation-safe.
- **Invariant:** Trees whose body is `CreateProveDlog(GroupElement)` (a derived form) are NOT classified as P2PK — sigma-rust only recognizes the canonical `Const(SSigmaProp, _)` form. Using a non-canonical shape would break the address → tree → address round-trip against any other Ergo implementation.

### `addressFromErgoTree(tree, network)` / `ergoTreeFromAddress(address)`

```ts
function addressFromErgoTree(tree: ErgoTree, network: Network): string;
function ergoTreeFromAddress(address: string): ErgoTree;
```

Convert between an `ErgoTree` and a base58check Ergo address.

- **`addressFromErgoTree`:**
  - **Precondition:** `tree` is a valid `ErgoTree`; `network` is `'mainnet'` or `'testnet'`.
  - **Returns:** Base58check Ergo address. If `isP2PK(tree)`, the address is P2PK (content bytes are the 33-byte EcPoint only, NOT the serialized tree); otherwise the address is P2S (content bytes are the full serialized ErgoTree).
  - **Throws:** `AddressDecodeError('unknown-network')` for a `network` other than `'mainnet'` / `'testnet'`.
- **`ergoTreeFromAddress`:**
  - **Precondition:** `address` is a base58check Ergo address with valid checksum and a supported address type.
  - **Returns:** The `ErgoTree` encoded by the address. P2PK addresses are reconstructed by synthesizing canonical bytes (`0x00 0x08 0xcd <33 bytes pubkey>`) and parsing them through `parseTree`, so every returned tree satisfies the same type invariants as a directly parsed one. A P2S address's tree is parsed under the box rules, `parseTree(bytes, { checkType: true })`, as the JVM's address decoder parses it: a root that is not SigmaProp rejects a tree without the size flag (`'soft-fork-without-size-bit'`) and degrades a sized one, so a P2S address can decode to an `UnparsedErgoTree`.
  - **Throws:** `AddressDecodeError` with `.code` in `'bad-base58' | 'too-short' | 'too-long' | 'checksum-mismatch' | 'invalid-p2pk-length' | 'p2sh-unsupported' | 'unknown-type'`. A P2S address carrying malformed tree bytes throws what `parseTree` throws, unwrapped.
- **Round-trip invariant:** For any tree `t` that passes rule 1001 and whose re-parse stays inside the 4096-byte window, and matching network `n`, `ergoTreeFromAddress(addressFromErgoTree(t, n))` parses to a structurally equivalent `ErgoTree`. P2SH addresses are NOT round-trippable through this function (they are derived from a 24-byte hash, not a serialized tree) and decoding one throws `'p2sh-unsupported'`.

### `base58Encode(bytes)` / `base58Decode(s)`

```ts
function base58Encode(bytes: Uint8Array): string;
function base58Decode(s: string): Uint8Array;
```

Base58 (Bitcoin alphabet) codec. Exposed primarily for testing and tooling; address users should prefer `addressFromErgoTree` / `ergoTreeFromAddress` which include the prefix byte and checksum.

- **`base58Encode`:** Leading zero bytes map to leading `'1'` characters (the standard Bitcoin convention). Empty input yields the empty string.
- **`base58Decode`:** Throws `AddressDecodeError` with `code: 'bad-base58'` on any non-alphabet character. Empty input yields an empty `Uint8Array`.

### `parseSValue` / `serializeSValue` / `parseSType` / `serializeSType`

```ts
function parseSValue(tpe: SType, treeVersion: number, r: ByteReader): SValue;
function serializeSValue(tpe: SType, v: SValue, treeVersion: number, w: ByteWriter): void;
function parseSType(r: ByteReader): SType;
function serializeSType(tpe: SType, w: ByteWriter): void;
```

Wire-layer SValue and SType codecs. Exposed for downstream consumers that need to parse canonical box / register bytes outside the `ErgoTree` envelope (e.g. the mainnet-validate harness reading per-output `ErgoBox::sigma_serialize` bytes and per-input `ContextExtension` constant blobs). `ByteReader` / `ByteWriter` are from `@ergots/scorex`. Throws `SValueParseError` / `SValueSerializeError` / `STypeParseError` / `STypeSerializeError` on failure. Notably, `SValueParseError 'group-element-invalid-point'` (F5 batch 4): a `GroupElement` payload whose lead byte is non-`0x00` must curve-decode (SEC1 compressed secp256k1) or the parse throws — applies wherever GE data parses (body/segregated constants, box registers, `deserializeTo[GroupElement]`, and the `deserializeTo[Header]` hydration leg's minerPk/powOnetimePk); `0x00`-lead payloads normalize to the canonical 33-zero identity instead. Notably also (F5 batch 5): `SBox` payloads parse under a **4096-byte lazy candidate window** — the candidate span (value → registers; `txId`/`index` outside) arms `positionLimit = position + 4096` (JVM `ErgoBox.MaxBoxSize`; `ErgoBoxCandidate.scala:191-192`/`:235`; rule 1014 `CheckPositionLimit`), and a read beginning past the window surfaces as scorex `ReaderError('position-limit-exceeded')` from `parseSValue`; inside a tree (a Box constant) that is rule 1014, which degrades a sized tree and is wrapped as `'soft-fork-without-size-bit'` by an unsized one. An `SBox`'s tree is parsed under the box rules and its registers in the JVM's order (see `parseErgoTreeBytes` / `parseAdditionalRegisters` below), so their errors surface too, unwrapped: `ErgoTreeParseError`, `ExprParseError`, `ExprTpeError` and scorex `ReaderError` among them. A register whose data is malformed rejects with its data's error (for example `ReaderError('truncated')`), before rule 1019 (`'register-v6-type'`) runs on the complete value. There is NO token-count parse rule — the raw-u8 count's natural ceiling (255) is the only count bound (the former >122 gate, mirroring sigma-rust's `BoundedVec` cap, is removed); serialize-side, `SValueSerializeError 'sbox-tokens-out-of-range'` is re-scoped to >255 (the u8 wire ceiling; JVM `putUByte`). Full taxonomy in `facts/ergoscript-wire.md`.

### `parseErgoTreeBytes` / `parseAdditionalRegisters`

```ts
function parseErgoTreeBytes(r: ByteReader): Uint8Array;
function parseAdditionalRegisters(r: ByteReader, treeVersion: number): AdditionalRegisters;
type AdditionalRegisters = Record<number, { tpe: SType; value: SValue; opaqueBytes?: Uint8Array } | undefined>;
```

Reader-based ErgoBox sub-structure readers, factored out of the `SBox` data parser and consumed by `@ergots/transaction`'s ErgoBoxCandidate codec so the box-body grammar lives in one place. Both advance the shared `ByteReader` in place.

- **`parseErgoTreeBytes`** parses one ergoTree on the reader it arrives on, under the box rules: the parse of `parseTree(…, { checkType: true })`, as the JVM's box parser parses a box's tree, so rule 1001 applies here where the bare `parseTree` is lenient. It returns the tree's span as received, a detached copy, declared size included: a box's R1 and `propositionBytes`. It leaves the cursor where the JVM continues reading the box: the parse end for a tree that parses, whatever its declared size says, and the end of the declared span for a tree that degrades. It seeds the box-tree cache with the tree it parsed, so `boxTreeOf` and `reencodeTreeBytes` on the returned bytes reuse this parse. It throws what the tree parse throws, including `ExprTpeError`; an unsized tree whose root is not SigmaProp rejects with `ErgoTreeParseError('soft-fork-without-size-bit')`.
- **`parseAdditionalRegisters`** reads the additional-registers section in the JVM's order: a raw `u8` count, then for each register R4.. its value read whole (a `Const` or `Tuple` Expr; the Tuple-Expr form keeps its bytes in `opaqueBytes`), then rule 1019 `CheckV6Type` on the complete value (`'register-v6-type'`). A seventh register rejects (`'sbox-registers-out-of-range'`) only when the loop reaches it, after R4–R9 were read, and a register Tuple's arity is read as a signed byte, so 128 or more rejects before any item (`'sbox-register-tuple-arity'`).

Full shape and failure surface in `facts/ergoscript-wire.md` § "ErgoBox sub-structure readers".

### `boxTreeOf` / `reencodeTreeBytes` / `seedBoxTree` / `boxBytesOf` / `boxIdOf`

```ts
function boxTreeOf(ergoTreeBytes: Uint8Array): ErgoTree;
function reencodeTreeBytes(ergoTreeBytes: Uint8Array): Uint8Array;
function seedBoxTree(ergoTreeBytes: Uint8Array, tree: ErgoTree): void;
function boxBytesOf(box: ErgoBox): Uint8Array;
function boxIdOf(box: ErgoBox): Uint8Array;
```

The JVM keeps a box's tree bytes as received for R1 and `propositionBytes`, and writes the tree re-encoded from its parsed structure wherever it re-serializes the box. `ErgoBox` carries only the bytes (`ergoTreeBytes`), so the parsed tree lives in a cache beside them, keyed by the `Uint8Array` instance.

- **`boxTreeOf(ergoTreeBytes)`** returns the box's tree under the box rules: the tree box ingest (`parseErgoTreeBytes`) parsed for these bytes, or, for bytes that did not come through box ingest, one standalone parse with `checkType: true`. On such a miss, a size-flagged tree whose own reads run out of input (a nested tree's header and size reads count as its own) is an `UnparsedErgoTree` over the bytes; a nested tree that runs out of input while reading its constants or body, or whose degrade span runs past the end, throws `ErgoTreeParseError('box-context-required')`, since the result depends on the bytes after this tree in its box; bytes after the parse end throw `'trailing-bytes'`; any other failure propagates. The result is shared by every caller and must not be mutated.
- **`reencodeTreeBytes(ergoTreeBytes)`** is `serializeTree(boxTreeOf(ergoTreeBytes))`, cached: the bytes the JVM writes for the tree when it re-serializes the box. A parsed tree is written with its true size, an unparsed one as received. It throws what `boxTreeOf` and `serializeTree` throw; a failure is not cached. The result must not be mutated.
- **`seedBoxTree(ergoTreeBytes, tree)`** attaches a tree you parsed yourself to those bytes, as a JVM box built from an `ErgoTree` object carries its tree.
- **`boxBytesOf(box)` / `boxIdOf(box)`** are the JVM's `ErgoBox.bytes` and `ErgoBox.id`: for a box that came off the wire, the bytes the parser retained, as received; otherwise the box re-serialized, with its tree re-encoded. The id is `blake2b256` of those bytes, memoized per box.

Every box serialization in this package (`serializeSValue` of an `SBox`, and a constructed box's bytes and id) writes `reencodeTreeBytes(box.ergoTreeBytes)`; `ergoTreeBytes`, R1, `propositionBytes` and a parsed box's bytes and id stay as received. Keep the bytes a box was parsed with: a copy (for example from `slice()`) misses the cache, and although a miss re-parses most spans to the same tree, it throws for an empty span and for one whose nested tree read past its end. To copy, seed the copy: `seedBoxTree(copy, boxTreeOf(original))`. Never mutate `ergoTreeBytes` after first use. See `facts/ergoscript-wire.md` § "Box trees".

### `violatesCheckV6Type` / `sValueStructuralEq`

```ts
function violatesCheckV6Type(tpe: SType): boolean;
function sValueStructuralEq(a: SValue, b: SValue): boolean;
```

Two JVM rules that `@ergots/transaction` applies from this package rather than re-deriving them. `violatesCheckV6Type` is rule-1019 `CheckV6Type`: true iff the type contains `SOption`, `SHeader` or `SUnsignedBigInt`, through tuple items and collection element types. It is the predicate behind `parseAdditionalRegisters`' `'register-v6-type'` and `@ergots/transaction`'s `'extension-v6-type'`. `sValueStructuralEq` is the JVM's uncosted data equality, the one the evaluator's `Eq`/`NEq` use without cost: a Box compares by its id over its retained bytes, a GroupElement by its point. It does not compare types. `@ergots/transaction` uses it for storage-rent register equality. See `facts/ergoscript-wire.md` § "Shared rules for `@ergots/transaction`".

### `parseSigmaBoolean` / `serializeSigmaBoolean`

```ts
function parseSigmaBoolean(r: ByteReader): SigmaBoolean;
function serializeSigmaBoolean(sb: SigmaBoolean, w: ByteWriter): void;
```

Bare `SigmaBoolean` wire round-trip (opcode + payload — the inner proposition tree, NOT an `SSigmaProp` SValue). Exposed for wire-conformance consumers that round-trip canonical `SigmaBoolean` bytes directly. Throws `SigmaBooleanParseError` / `SigmaBooleanSerializeError` on failure. Notably, `SigmaBooleanParseError 'ec-point-invalid'` (F5 batch 4): `ProveDlog.h` and `ProveDhTuple` `g`/`h`/`u`/`v` leaf points get the same validate+normalize as the SValue GE arm — `0x00`-lead → canonical identity, non-`0x00`-lead must curve-decode or the parse throws (the serializer checks the 33-byte length, `SigmaBooleanSerializeError('ec-point-length')`). A CTHRESHOLD's `k` and child count are checked where the JVM checks them: each above 0xFFFF as it is read, and `k` against the count, and the count against 255, after the children.

### Constants

| Name | Value | Meaning |
|---|---|---|
| `MAX_TREE_SIZE` | `1_048_576` | Max input bytes for `parseTree` (1 MB; defensive cap against adversarial input) |
| `MAX_PROPOSITION_SIZE` | `4096` | The tree's read window (JVM `SigmaConstants.MaxPropositionBytes`): a read that begins past `start + 4096` degrades a size-flagged tree and rejects an unsized one |
| `VERSION` | `'0.3.0'` | Package version string |

---

## Round-trip invariant

For any canonically encoded byte sequence `b` accepted by `parseTree`:

```
serializeTree(parseTree(b)) === b   (byte-equal)
```

This holds for every ErgoTree variant the package ships. The corpus test asserts this on 255 passing fixtures plus 1 mainnet-fixture stub plus 6 fixtures flagged `known_unstable` (sigma-rust itself does not round-trip them; tracked inline in the fixture JSON).

The exceptions, all adversarial-only, are in `facts/ergoscript-wire.md` § "Round-trip invariant":
- **Non-canonical encodings** re-serialize canonically, as the JVM's writer does: an Option tag above `0x01`, an identity GroupElement with a non-zero tail, and a declared size that differs from the body. One does not: an AvlTree value's flags byte is written as received, where the JVM keeps only bits 0–2 (`facts/transaction.md` Known residual 3). The declared size does not bound the parse: a tree declaring more ("over") or fewer ("under") bytes than its body parses the whole body and re-serializes with its true size, so `09 03 08 d3` and `09 01 08 d3` both give `09 02 08 d3`. `parseTree` tolerates bytes after the parse end that lie within a size-flagged tree's declared span; a byte beyond it throws `'trailing-bytes'`.
- **Trees that parse but cannot be written** throw from `serializeTree`, as the JVM's writer does (see `serializeTree` above).

A box keeps its tree's bytes as received on `ErgoBox.ergoTreeBytes`, and every box re-serialization writes the tree re-encoded (see `boxTreeOf` / `reencodeTreeBytes` above).

---

## Types

### `ErgoTree`

```ts
type ErgoTree = ParsedErgoTree | UnparsedErgoTree;   // narrow with isUnparsedTree(tree)

interface ParsedErgoTree {
  header: TreeHeader;
  constantTypes: SType[];   // parallel to `constants`; required for byte-exact re-serialize
  constants: SValue[];      // empty when header.constantSegregation === false
  body: Expr;               // root expression
}

interface UnparsedErgoTree {  // a size-flagged tree that failed soft-forkably: kept, not parsed
  header: TreeHeader;
  unparsedBytes: Uint8Array;  // the tree's declared span as received; serializeTree writes it back
  error: Error;               // the failure that degraded it (diagnostic only)
}
```

An `UnparsedErgoTree` cannot be evaluated: `evaluate` / `evaluateWith` throw `EvalError('unparsed-ergotree')`, so a box locked by one cannot be spent.

### `TreeHeader`

```ts
interface TreeHeader {
  version: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // bits 0..2 of rawHeader
  hasSize: boolean;                        // bit 3: VLQ-u32 body size follows
  constantSegregation: boolean;            // bit 4: segregated constants section
  rawHeader: number;                       // original byte; bits 0–4 match the fields above, bits 5–7 are free
}
```

`rawHeader` is the on-wire byte. The `version`, `hasSize`, `constantSegregation` fields are derived projections kept on the struct so callers don't need to re-decode bits. `serializeTree` writes `rawHeader` as stored, bits 5–7 included (the JVM writes the header byte as stored and never inspects them), but validates that its bits 0–4 match the derived fields — a hand-constructed `ErgoTree` with inconsistent fields is rejected at serialize time with `'header-inconsistent'`.

### `SType`

```ts
type SType =
  | { tag: 'SBoolean' } | { tag: 'SByte' } | { tag: 'SShort' }
  | { tag: 'SInt' }     | { tag: 'SLong' } | { tag: 'SBigInt' }
  | { tag: 'SUnsignedBigInt' }                     // v6 P2a — type code 9; permissive parse, pre-eval gate
  | { tag: 'SGroupElement' } | { tag: 'SSigmaProp' } | { tag: 'SBox' }
  | { tag: 'SAvlTree' } | { tag: 'SUnit' } | { tag: 'SAny' }
  | { tag: 'SHeader' }  | { tag: 'SPreHeader' } | { tag: 'SContext' }
  | { tag: 'SGlobal' }  | { tag: 'SString' }
  | { tag: 'SColl';     elem: SType }
  | { tag: 'STuple';    items: SType[] }
  | { tag: 'SOption';   elem: SType }
  | { tag: 'SFunc';     args: SType[]; result: SType; tpeParams: STypeVar[] }
  | { tag: 'STypeVar';  name: string };
```

Closed discriminated union over the ErgoScript type system. Mirrors sigma-rust's `ergotree-ir/src/types/stype.rs`. `SUnsignedBigInt` (v6 P2a, type code 9) is a first-class variant: the wire parser accepts it permissively (no version check), but the pre-eval `validateV6Types` pass rejects any tree containing it when `ctx.treeVersion < 3`, matching the JVM's gate at type deserialization.

### `SValue`

```ts
type SValue =
  | { kind: 'Boolean';      value: boolean }
  | { kind: 'Byte';         value: number }    // i8 range, but stored as number
  | { kind: 'Short';        value: number }    // i16 range
  | { kind: 'Int';          value: number }    // i32 range
  | { kind: 'Long';         value: bigint }    // i64 range
  | { kind: 'BigInt';       value: bigint }    // signed-256 range ([-2^255, 2^255-1])
  | { kind: 'UnsignedBigInt'; value: bigint }  // v6 P2a — unsigned-256 range [0, 2^256-1]; distinct codec from BigInt
  | { kind: 'GroupElement'; value: Uint8Array }    // 33-byte compressed secp256k1
  | { kind: 'SigmaProp';    value: SigmaBoolean }  // structural 6-variant union
  | { kind: 'Box';          value: ErgoBox }
  | { kind: 'AvlTree';      value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll';         elem: SType; items: SValue[] }
  | { kind: 'Tuple';        items: SValue[] }
  | { kind: 'Option';       elem: SType; value: SValue | null }
  | { kind: 'Lambda';       closure: Closure }
  | { kind: 'Context' }                        // phase 2g.5 — Context Expr arm sentinel
  | { kind: 'Global' }                         // phase 2g.6 — Global Expr arm sentinel
  | { kind: 'PreHeader'; value: PreHeader }    // phase 2g.6 — chain-state PreHeader value carrier
  | { kind: 'Header'; value: Header };         // phase 2h-c.1 — chain-state Header value carrier
```

Runtime-value discriminated union. Composite kinds (`Coll`, `Option`) carry their element type explicitly because the wire format does not always encode it unambiguously (empty `Coll`, `None` for `SOption`). `Context`/`Global`/`PreHeader`/`Header` are evaluator-internal sentinels never produced at the top level by honest trees; they appear as intermediate values when evaluating context-access methods.

`SigmaProp.value` is a structural `SigmaBoolean` (6-variant discriminated union — see `facts/ergoscript-sigma.md`). Wire parse + serialize is byte-identical against sigma-rust; structural access is consumed by `verifySignature` and by the `SigmaPropBytes` evaluator arm.

### `Expr`

`Expr` is a 69-variant discriminated union keyed on `tag` over MIR nodes. Each variant's payload mirrors sigma-rust's `mir/<variant>.rs` struct fields (plus `LastBlockUtxoRootHash`, a JVM-only case object — sigma-rust has no MIR variant for the bare `0xa6` op-form; added F5 batch 4). Full per-variant shapes live in `packages/ergoscript/src/mir/types.ts`. The variants are:

`Append`, `Const`, `ConstPlaceholder`, `SubstConstants`, `ByteArrayToLong`, `ByteArrayToBigInt`, `LongToByteArray`, `Collection`, `Tuple`, `CalcBlake2b256`, `CalcSha256`, `Context`, `Global`, `GlobalVars`, `LastBlockUtxoRootHash`, `FuncValue`, `Apply`, `MethodCall`, `PropertyCall`, `BlockValue`, `ValDef`, `ValUse`, `If`, `BinOp`, `And`, `Or`, `Xor`, `Atleast`, `LogicalNot`, `Negation`, `BitInversion`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `ExtractAmount`, `ExtractRegisterAs`, `ExtractBytes`, `ExtractBytesWithNoRef`, `ExtractScriptBytes`, `ExtractCreationInfo`, `ExtractId`, `ByIndex`, `SizeOf`, `Slice`, `Fold`, `Map`, `Filter`, `Exists`, `ForAll`, `SelectField`, `BoolToSigmaProp`, `Upcast`, `Downcast`, `CreateProveDlog`, `CreateProveDhTuple`, `SigmaPropBytes`, `SigmaPropIsProven`, `ZkProofBlock`, `DecodePoint`, `SigmaAnd`, `SigmaOr`, `GetVar`, `DeserializeRegister`, `DeserializeContext`, `MultiplyGroup`, `Exponentiate`, `XorOf`, `TreeLookup`, `CreateAvlTree`.

### `Network` / `AddressType`

```ts
type Network = 'mainnet' | 'testnet';
type AddressType = 'P2PK' | 'P2S';
```

P2SH addresses can be decoded for prefix inspection but are NOT representable as a parsable `ErgoTree` (they're derived from a 24-byte hash) and are rejected with `'p2sh-unsupported'`.

---

## Error classes

Every exported error class extends `Error` and carries a `.code: string` for programmatic dispatch.

```ts
class ErgoTreeParseError        extends Error { readonly code: string; cause?: unknown }  // cause: the standard Error.cause
class ErgoTreeSerializeError    extends Error { readonly code: string }
class ExprParseError            extends Error { readonly code: string }
class ExprSerializeError        extends Error { readonly code: string }
class STypeParseError           extends Error { readonly code: string }
class STypeSerializeError       extends Error { readonly code: string }
class SValueParseError          extends Error { readonly code: string }
class SValueSerializeError      extends Error { readonly code: string }
class SigmaBooleanParseError    extends Error { readonly code: string }
class SigmaBooleanSerializeError extends Error { readonly code: string }
class AddressDecodeError        extends Error { readonly code: string }
class ExprTpeError              extends Error { readonly code: string }
```

These surface from `parseTree` / `serializeTree` (and the `parseSType` / `serializeSType` / `parseSValue` / `serializeSValue` / `parseSigmaBoolean` / `serializeSigmaBoolean` codecs) UNWRAPPED — callers see the innermost typed failure and can classify it by `instanceof`. The tree parse wraps two failures in an `ErgoTreeParseError` whose `cause` is the original error: a soft-forkable failure in a tree without the size flag (`'soft-fork-without-size-bit'`) and a nested tree that runs out of input while reading its constants or body, or whose degrade span runs past the end (`'nested-tree-truncated'`). The mir-layer type-inference error `ExprTpeError` is root-exported since 2026-09-28: rule 1001 lets it escape a box-rules parse (`parseErgoTreeBytes`, `parseTree(bytes, { checkType: true })`) as a hard reject. One typed error that can escape is NOT root-exported: scorex's `ReaderError` (imported from `@ergots/scorex`). The full wire-layer error taxonomy with every emitted code is documented in `facts/ergoscript-wire.md` § "Error taxonomy (wire-layer error classes)" (runtime/evaluator codes live in `facts/ergoscript-eval.md`).

### `ErgoTreeParseError` codes

| Code | Meaning |
|---|---|
| `'empty'` | Input bytes have length 0 |
| `'oversized'` | Input bytes exceed `MAX_TREE_SIZE` |
| `'trailing-bytes'` | Bytes after the parse end: after an unsized tree, or beyond a size-flagged tree's declared span (bytes within the span are tolerated). `boxTreeOf` rejects any |
| `'body-size-overflow'` | A size-flagged tree degrades, and its declared span (`bodyPos − start + declared`, as an Int) is negative or runs past the end of the input (for a nested tree, past the end is `'nested-tree-truncated'`). A declared size is otherwise ignored |
| `'too-many-constants'` | Segregated-constant count above 100000 (the JVM's `safeNewArray` bound); a count that wraps negative as an Int reads no constants |
| `'header-version-requires-size'` | Tree header with version > 0 and the size bit (0x08) clear (rule-1012 `CheckHeaderSizeBit`; all 3 ingresses: main, substConstants template, box-carried script) |
| `'soft-fork-without-size-bit'` | A tree without the size flag failed soft-forkably (for example a reserved opcode, or with `checkType` a root that is not SigmaProp); `cause` is the original error. The JVM's `SerializerException` for this case |
| `'nested-tree-truncated'` | A nested tree (a Box constant's tree) ran out of input while reading its constants or body, or its degrade span ran past the end; `cause` is the original error. A run-out in the nested tree's header or size read is not marked |
| `'box-context-required'` | `boxTreeOf` / `reencodeTreeBytes` on bytes that did not come through box ingest, whose nested tree ran out of input while reading its constants or body, or whose nested degrade span ran past the end: the result depends on the bytes after this tree in its box. Seed the tree, or parse the box |

`'root-not-sigma-prop'` (rule 1001) never escapes on its own: it degrades a sized tree (as `UnparsedErgoTree.error`) and is the `cause` of `'soft-fork-without-size-bit'` for an unsized one.

### `ErgoTreeSerializeError` codes

| Code | Meaning |
|---|---|
| `'header-inconsistent'` | Bits 0–4 of `rawHeader` do not match the derived `(version, hasSize, segregation)` triple (bits 5–7 are written as stored, as the JVM writes them) |
| `'constants-arity-mismatch'` | `constantTypes.length !== constants.length` |
| `'oversized'` | The serialized tree would exceed `MAX_TREE_SIZE` |
| `'too-many-constants'` | More than 100000 constants, the parse bound |

### `AddressDecodeError` codes

| Code | Meaning |
|---|---|
| `'bad-base58'` | Input contains a non-alphabet character |
| `'too-short'` | Decoded bytes shorter than (1-byte prefix + 4-byte checksum) minimum |
| `'too-long'` | The address string is longer than the longest address a `MAX_TREE_SIZE` tree can make (a bound for the base58 decoder) |
| `'checksum-mismatch'` | blake2b256-derived checksum disagrees with the trailing 4 bytes |
| `'invalid-p2pk-length'` | P2PK content is not exactly 33 bytes |
| `'p2sh-unsupported'` | Address type is P2SH (not representable as a parsable ErgoTree) |
| `'unknown-type'` | Address type nibble is not P2PK (0x01), P2SH (0x02), or P2S (0x03) |
| `'unknown-network'` | `addressFromErgoTree` was given a `network` other than `'mainnet'` / `'testnet'` |

---

## Evaluator

```ts
import {
  evaluate, evaluateWith, makeContext,
  EvalError,
  type EvalOpts, type EvalContext,
} from '@ergots/ergoscript';
```

### `evaluate(tree, opts?)`

```ts
function evaluate(tree: ErgoTree, opts?: EvalOpts): SValue;
```

Evaluate an `ErgoTree` under a freshly constructed `EvalContext`. `opts.constants`, when provided, overrides the tree's segregated constants for `ConstantPlaceholder` resolution. `opts.treeVersion` auto-derives from `tree.header.version`.

- **Precondition:** `tree` is a valid `ErgoTree` (typically returned by `parseTree`).
- **Postcondition (success):** Returns the `SValue` produced by evaluating `tree.body`. `jitCost` is available on the internally constructed `EvalContext` only via `evaluateWith`; use that overload to inspect cost after the call.
- **Postcondition (failure):** Throws `EvalError` with one of the 86 codes enumerated in `facts/ergoscript-eval.md`. An `UnparsedErgoTree` throws `'unparsed-ergotree'` before any work. Errors raised in the recursive evaluator bubble up unwrapped.
- **Coverage caveat:** 68 of 68 implementable `Expr` variants have implemented arms (F5 batch 4 added `LastBlockUtxoRootHash` — the bare `0xa6` op-form parses and evaluates; cost 15 vs the PropertyCall form's 20). 21 wire opcodes (ModQ family, `OpTrue`/`OpFalse`/`UnitConstant`, `Select1-5`, `CollShift`/`CollRotate`, `SomeValue`, `NoneValue`, `FlatMap`, `TrivialPropFalse`, `TrivialPropTrue`) are reserved in sigma-rust's `OpCode` enum and unconditionally parse-rejected — `ExprParseError 'opcode-reserved'`, mirroring the JVM `CheckValidOpCode` reject (no registered serializer) for most of them. JVM 6.0.6 does parse `OpTrue`, `OpFalse` and the ModQ family (and `TaggedVariable` `0x71`); ergots rejecting them is a known residual (`facts/ergoscript-wire.md`, `'opcode-reserved'` entry). `FunDef` (`0xd7`) was once in this group but is now parsed+evaluated as a `ValDef` from v6 P6. The bare `FlatMap`/`TrivialProp` opcodes joined the reserved set; their non-bare forms reach us elsewhere (`flatMap` as a method-call; the `TrivialProp` pair as a SigmaBoolean leaf inside a SigmaProp constant). Trees whose body reaches a not-yet-implemented method-call handler or one of 3 defensive `EvalError 'not-implemented-yet'` sites (`eval.ts:232`, `global-vars.ts:136`, `bin-op/bit.ts:58`) still throw at runtime.

### `evaluateWith(tree, ctx)`

```ts
function evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue;
```

Same evaluation pipeline as `evaluate` using a caller-supplied `EvalContext`. The context is mutated in-place — inspect `ctx.jitCost` after the call to read total cost charged. Partial costs are NOT rolled back on failure; `ctx.jitCost` reflects cost up to and including the point of any throw.

### `makeContext(opts?)`

```ts
function makeContext(opts?: EvalOpts): EvalContext;
```

Construct a fresh `EvalContext` from `EvalOpts`. Pure constructor — same opts in, structurally equivalent context out.

### `EvalOpts` / `EvalContext`

```ts
interface EvalOpts {
  jitCostLimit?: number          // undefined = unlimited
  constants?: SValue[]           // overrides tree.constants for ConstPlaceholder
  treeVersion?: number           // 0..7; auto-derived from tree.header.version in evaluate()
  // Chain-state fields:
  height?: number                // current block height
  selfBox?: ErgoBox              // spending box
  inputs?: ErgoBox[]             // transaction inputs
  outputs?: ErgoBox[]            // transaction outputs
  preHeader?: PreHeader          // pre-header of current block
  extension?: ContextExtensionInput   // SELF context-extension; a ContextExtension (values: Map) OR a plain-object/Record (normalized to a Map by makeContext)
  inputExtensions?: ContextExtensionInput[]  // per-input extensions (v6 P7a), indexed by spending-transaction input position; same Map-or-Record input
  dataInputs?: ErgoBox[]         // transaction data-inputs
  headers?: Header[]             // block headers (up to 10; sigma-rust [Header; 10]); Header type from @ergots/scorex
  lastBlockUtxoRootHash?: AvlTreeData  // SContext.lastBlockUtxoRootHash (101:9) source — JVM ErgoLikeContext.lastBlockUtxoRoot; absent ⇒ 101:9 throws 'context-field-missing'
}

interface EvalContext extends EvalOpts {
  jitCost: number                // mutable accumulator; read after evaluateWith()
  addCost(amount: number): void
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
}
```

- `addCost` — saturating add; throws `EvalError 'cost-limit-exceeded'` if `jitCostLimit` is set and exceeded.
- `addPerItemCost` — composite charge: `addCost(base + ceil(nItems / chunkSize) * perChunk)`.
- **`extension` / `inputExtensions` input shape** — both accept either a `ContextExtension` (`values` a `Map`) or the plain-object/`Record` form `{ values: { <varId>: { tpe, value } } }` that node-API JSON ingestion produces (the `ContextExtensionInput` type); `makeContext` normalizes a `Record` to a `Map`. Eval reads vars by key, so a `Record`'s lost key-order is irrelevant here; on-chain wire order matters only for the `@ergots/transaction` signing-message codec, which passes a `Map`.
- **`inputExtensions`** — per-input context extensions for `Context.getVarFromInput` (101:12, v6 P7a). Indexed by spending-transaction input position (mirrors JVM `spendingTransaction.inputs(i).extension`). May legitimately differ in length from `inputs` — the JVM's own blessed `getVarFromInput` vector has `tx.inputs.length = 0` while `ctx.inputs.length = 1`; never validate length equality. Absent field ⟹ every `getVarFromInput` lookup → `None`. Key domain is unsigned 0–255 (ContextExtension byte keys); JVM JSON ingestion normalizes signed `-1` to `255` — supply `255`, not `-1`, when constructing extensions from JVM JSON output.

### `EvalError`

```ts
class EvalError extends Error {
  readonly code: string;  // one of the 86 codes in facts/ergoscript-eval.md
}
```

All 86 `EvalError` codes and their semantics are documented in `facts/ergoscript-eval.md` § "EvalError taxonomy". Notable codes:

| Code | When thrown |
|---|---|
| `'not-implemented-yet'` | An `Expr` variant with no arm, or a defensive site in an arm |
| `'cost-limit-exceeded'` | `ctx.jitCost` exceeded `jitCostLimit` after a charge |
| `'unparsed-ergotree'` | The tree is an `UnparsedErgoTree` (a size-flagged tree that degraded, for example a box tree whose root failed rule 1001). Thrown before any work; nothing charged |
| `'arith-overflow'` | `BinOp.Arith` result outside signed range |
| `'arith-divide-by-zero'` | `BinOp.Arith` divide or modulo by zero |
| `'method-not-implemented'` | `MethodCall`/`PropertyCall` hit an unregistered `(typeId, methodId)` |
| `'tree-version-too-low'` | A V3-gated method or type encountered in a `treeVersion < 3` tree |
| `'v6-type-in-pre-v3-tree'` | `SUnsignedBigInt` or serialized `SFunc` annotation in a pre-V3 tree |
| `'avl-tree-proof-failed'` | AvlTree proof verification failed where the JVM throws: `get`/`getMany` (≥1 key) on any failure, `insert` at treeVersion<3 with ≥1 op. `contains`→false, `update`/`remove`/`insertOrUpdate`→None instead (F4 JVM-canonical surface) |
| `'pow-hit-invalid-params'` | `Global.powHit` parameter guards: `k < 2`, `k > 32`, or `N < 16` |
| `'apply-unresolved-type-var'` | Applying a lambda whose arg type is an unresolved `STypeVar` (v6 P6; adversarial-only; mirrors JVM `stypeToRType(STypeVar)` failure) |
| `'unsupported-eval-node'` | Evaluating `TreeLookup` or `CreateAvlTree` — the JVM has no eval override for either node (both still parse); unconditional, nothing charged (F4 epilogue) |
| `'unsupported-value-type'` | A value flowing through a checkType seam (Tuple item, ConcreteCollection item, BlockValue, ValUse, ConstantPlaceholder) has a declared non-pair `STuple` (arity≠2) or non-unary `SFunc` (arity≠1) type — JVM `SType.isValueOfType` sys.error (F5 batch 3; adversarial-only) |
| `'select-field-non-pair'` | `SelectField` input is a Tuple of arity≠2 — JVM `SelectField.eval` matches only `Tuple2` (F5 batch 3; adversarial-only) |
| `'atleast-too-many-children'` | `Atleast` input collection holds >255 SigmaProps — JVM `CSigmaDslBuilder.atLeast` cap (`MaxChildrenCountForAtLeastOp = 255`); thrown after the per-item charge, before the degenerate-bound reductions (F5 batch 4; adversarial-only) |
| `'context-extension-key-out-of-range'` | SELF context-extension key outside `[0,127]` — the JVM keys the extension by signed `Byte`, so a wire key ≥0x80 is negative and crashes `toSigmaContext` before reduction (v6 batch-6; adversarial-only; per-input extensions unaffected) |

---

## V3 (ErgoTree v6) surface

The following method handlers and types are **V3-gated** (require `tree.header.version >= 3`; pre-V3 trees throw `EvalError 'tree-version-too-low'` before the handler runs). All 134 registry entries are documented in full in `facts/ergoscript-eval.md`.

### Numeric methods (v6 P1) — 40 handlers

`Byte/Short/Int/Long/BigInt` gain 8 methods each (typeIds 2–6, methodIds 6–13), all `FixedCost(5)`:

| Method | Returns | Notes |
|---|---|---|
| `X.toBytes` | `Coll[Byte]` | BE two's-complement; 1/2/4/8 bytes for Byte/Short/Int/Long; minimal-width signed BE for BigInt |
| `X.toBits` | `Coll[Boolean]` | MSB-first bit expansion; 8/16/32/64/256 bits |
| `X.bitwiseInverse` | `X` | Bitwise NOT; signed-narrowed back to receiver kind |
| `X.bitwiseOr / .bitwiseAnd / .bitwiseXor` | `X` | Signed bitwise ops |
| `X.shiftLeft / .shiftRight` | `X` | Arithmetic shifts; `bits` outside `[0, width)` → `'numeric-shift-out-of-range'` |

### `SUnsignedBigInt` type and methods (v6 P2)

New `SType { tag: 'SUnsignedBigInt' }` and `SValue { kind: 'UnsignedBigInt'; value: bigint }` (unsigned magnitude, range `[0, 2^256-1]`). Methods (typeId 9):

- **8 bitwise/shift methods** (methodIds 6–13, `FixedCost(5)`): same names as P1 but unsigned-codec variants for `toBytes`/`toBits`; unsigned-overflow guard on `shiftLeft` → `'unsigned-bigint-out-of-range'`.
- **Modular arithmetic** (methodIds 14–18): `modInverse` (9:14, cost 150), `plusMod` (9:15, cost 30), `subtractMod` (9:16, cost 30), `multiplyMod` (9:17, cost 40), `mod` (9:18, cost 20), plus `BigInt.toUnsignedMod` (6:15, cost 15). Euclidean semantics.
- **Bridge methods**: `BigInt.toUnsigned` (6:14, cost 5) — throws `'unsigned-bigint-out-of-range'` if receiver `< 0`; `UnsignedBigInt.toSigned` (9:19, cost 10) — throws `'bigint-result-out-of-range'` if `value >= 2^255`.
- **BinOps** (v6 P2c): UBI operands supported in Arith (`Plus`/`Minus`/`Multiply`/`Divide`/`Modulo`/`Min`/`Max`), ordering (`Lt`/`Le`/`Gt`/`Ge`), and equality (`Eq`/`NEq`). UBI arith costs use the non-BigInt tier (lower than signed BigInt). Mixed UBI/signed operands in a V3 tree → `'bin-op-kind-mismatch'`.

### Coll v6 methods (v6 P3) — 4 handlers, typeId 12

| Method | typeId:methodId | Cost | Returns |
|---|---|---|---|
| `Coll.reverse` | 12:30 | `addPerItemCost(20, 2, 100, n)` | `Coll[T]` (generic via P0 engine) |
| `Coll.startsWith` | 12:31 | `addPerItemCost(10, 1, 10, n)` | `Boolean` |
| `Coll.endsWith` | 12:32 | `addPerItemCost(10, 1, 10, n)` | `Boolean` |
| `Coll.get` | 12:33 | `FixedCost(30)` | `Option[T]` (None on OOB/negative; never throws) |

### Global methods (v6 P4–P5c) — 8 handlers, typeId 106

| Method | typeId:methodId | Cost | Returns | Notes |
|---|---|---|---|---|
| `Global.some` | 106:9 | 5 | `Option[T]` | 1-arg MethodCall; `T` from explicit wire type arg |
| `Global.none` | 106:10 | 5 | `Option[T]` | 0-arg PropertyCall; `T` from explicit wire type arg |
| `Global.serialize` | 106:3 | DynamicCost | `Coll[Byte]` | T derived from runtime value kind; → `'global-serialize-failed'` for non-serializable kinds |
| `Global.deserializeTo[T]` | 106:4 | `perItemCost(100, 32, 32, n)` | `T` | Bytes→SValue; MaxTreeDepth(110) enforced; → `'global-deserialize-failed'` |
| `Global.fromBigEndianBytes[T]` | 106:5 | 10 | `T` (numeric) | Exact-length (Byte=1/Short=2/Int=4/Long=8) or max-32 (BigInt/UBI); → `'global-from-bigendian-bytes-failed'` |
| `Global.encodeNbits` | 106:6 | 25 | `Long` | `SBigInt` → Bitcoin-compact nBits encoding |
| `Global.decodeNbits` | 106:7 | 50 | `BigInt` | Bitcoin-compact `Long` → signed `BigInt`; → `'global-decode-nbits-failed'` on signed-256 overflow |
| `Global.powHit` | 106:8 | PowHitCostKind | `UnsignedBigInt` | Autolykos-2 PoW hit computation; → `'pow-hit-invalid-params'` for invalid k/N |

### Per-type v6 methods (v6 P7a) — 3 handlers

| Method | typeId:methodId | Cost | Returns | Notes |
|---|---|---|---|---|
| `Box.getReg[T]` | 99:19 | `FixedCost(50)` | `Option[T]` | Dynamic-index register read. Index out of `[0,9]` → `None`; absent register → `None`; defined + wrong type → throws `'register-type-mismatch'`. Carries explicit type arg `T` on wire. `minVersion: 3`. |
| `Context.getVarFromInput[T]` | 101:12 | `FixedCost(10)` | `Option[T]` | Read a context-extension variable from a specified input. OOB input idx, missing var, or type mismatch → `None` (never throws). Reads `inputExtensions[inputIdx]`. `minVersion: 3`. |
| `GroupElement.expUnsigned` | 7:6 | `FixedCost(900)` | `GroupElement` | Scalar exponentiation with an `UnsignedBigInt` scalar. `g^0 = g^order = identity` (33 zero bytes); `g^1 = g`. Monomorphic — no explicit type args. `minVersion: 3`. |

### First-class functions (v6 P6)

`FunDef` (`0xd7`) is now parsed, serialized, and evaluated as a `ValDef` carrying a non-empty `tpeArgs: STypeVar[]` (a polymorphic `let f[T] = rhs`). Eval is unchanged from a plain `ValDef`; `tpeArgs` are ignored at runtime (the JVM `BlockValue.eval` also ignores them). All-version (not V3-gated).

**Lexical closures.** `Lambda` SValues now carry `capturedEnv` (the definition-site environment). `Apply` and all 7 lambda HOF arms (`MapColl`, `Fold`, `Filter`, `Exists`, `ForAll`, `SColl.flatMap`, `SOption.map`) evaluate the body in `capturedEnv` extended with per-call arg bindings — not the caller's env. This enables currying: `{ val add = (a:Int)=>(b:Int)=>a+b; add(3)(1) }` → `Int 4`.

**Type-var-apply reject.** Applying a lambda whose arg type is or contains an unresolved `STypeVar` throws `EvalError('apply-unresolved-type-var')` (mirrors JVM `stypeToRType(STypeVar)` → `RuntimeException`). A lambda that is bound but never applied evaluates fine; the reject fires only at apply-time. This is an adversarial-only guard (honest trees monomorphize at the call site).

**Functions in composites.** Functions stored in `Coll`/`Tuple` SValues and accessed via `ByIndex`/`SelectField` already worked; P6 validates them against the JVM-blessed `higher_order_lambdas` conformance vector (value `Coll[Int][2,3]`, cost 408).

---

## Sigma-protocol verifier

```ts
import {
  verifySignature,
  VerifyError,
  type VerifyErrorCode,
  type SigmaBoolean,
} from '@ergots/ergoscript';
```

### `verifySignature(sigmaBoolean, message, proof)`

```ts
function verifySignature(
  sigmaBoolean: SigmaBoolean,
  message: Uint8Array,
  proof: Uint8Array,
): boolean;
```

Verify a Schnorr/DH-tuple sigma-protocol proof against `message` and the proposition described by `sigmaBoolean`. Returns `true` on success, `false` on a valid rejection (invalid signature). Throws `VerifyError` on malformed proof bytes or unsupported proof structure.

- **Covers:** `TrivialProp` (true/false direct), `ProveDlog` (Schnorr), `ProveDhTuple`, and compound `Cand`/`Cor`/`Cthreshold` conjecture walk via Fiat-Shamir challenge distribution.
- **Throws:** `VerifyError` with one of its 9 declared codes, 4 of which the verifier throws today (`'empty-signature'`, `'truncated-signature'`, `'cthreshold-polynomial-bytes-mismatch'`, `'invalid-sigma-tree'`) — see `facts/ergoscript-sigma.md` for the full taxonomy. A leaf point that fails decompression in a hand-built `SigmaBoolean` throws `@noble/curves`' plain `Error`.

---

## Conventions

- **All byte sequences are `Uint8Array`.** Never `Buffer`. Hash digests, IDs, public keys, and serialized trees all use the same type.
- **`number` for `SByte`/`SShort`/`SInt`/heights/version/registerId.** JS `Number` is safe up to 2^53; i32-and-smaller values fit comfortably.
- **`bigint` for `SLong`, `SBigInt`, `SUnsignedBigInt`, and ErgoBox values.** Anything that can exceed `Number.MAX_SAFE_INTEGER` uses `bigint`. `SUnsignedBigInt` values are stored as non-negative bigints (unsigned magnitude).
- **No async surface.** Every function is synchronous. Hashing is a tight loop; the async boundary would only add overhead.
- **No I/O, no globals.** Pure functions: same inputs always produce the same output.
- **Throws on input rejection.** Parse and serialize errors throw typed exceptions with `.code` for programmatic dispatch. Programmer-error invariants (out-of-range writes, contract violations) throw plain `Error`.

## See also

- `facts/ergoscript.md` (repo root) — load-bearing interface contract referenced by downstream packages
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — design rationale, phase plan, validation strategy, risks
- [sigma-rust `ergotree-ir`](https://github.com/ergoplatform/sigma-rust/tree/develop/ergotree-ir) — reference Rust implementation (this package targets branch `integration/ergots`)
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical ErgoScript language specification
