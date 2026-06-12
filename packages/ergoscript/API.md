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
- **Evaluator (phases 2b–2i-c, 2j, JVM-alignment, v6 P0–P6, F1–F5 batch 4).** `evaluate` / `evaluateWith` cover **68 of 68 implementable `Expr` arms** plus a **128-entry method-call handler registry** and **84 `EvalError` codes**. AVL+ membership-proof verification ships via `@ergots/avltree`. Cost validation is complete: the mainnet walk reached tip (h≈1,797,470) with zero unhandled halts. V3 (ErgoTree v6) methods are fully implemented (phases P0–P6), including first-class functions (lexical closures; `FunDef` as a `ValDef`; type-var-apply reject).
- **Sigma-protocol verifier (phases 2g-medium, 2g-combinators).** `verifySignature` covers the full `SigmaBoolean` 6-variant surface (`TrivialProp`, `ProveDlog`, `ProveDhTuple`, `Cand`, `Cor`, `Cthreshold`).

What this package is NOT:

- **NOT a substitute for sigma-rust or a JVM node** on any binding decision. Use this package for tooling (parse / address derivation / simulators / dev frontends) and for unsigned-side prep / preview of script evaluation. For consensus-grade acceptance, combine with sigma-rust.
- **NOT fully free of `'not-implemented-yet'` paths.** 3 defensive sites remain (`eval.ts:232`, `global-vars.ts:136`, `bin-op/bit.ts:58`) — see the `evaluate` coverage caveat below. 18 wire opcodes are reserved-but-parse-rejected by sigma-rust itself; 3 more route through other dispatch paths in sigma-rust and remain under separate review (`LastBlockUtxoRootHash` left this group in F5 batch 4 — its bare `0xa6` op-form now parses and evaluates).

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
  parseSigmaBoolean, serializeSigmaBoolean,
  MAX_TREE_SIZE, VERSION,
  type ErgoTree, type TreeHeader, type SType, type SValue, type Expr,
  type Network, type AddressType,
  ErgoTreeParseError, ErgoTreeSerializeError, AddressDecodeError,
  SValueParseError, SValueSerializeError,
  SigmaBooleanParseError, SigmaBooleanSerializeError,
} from '@ergots/ergoscript';
```

### `parseTree(bytes)`

```ts
function parseTree(bytes: Uint8Array): ErgoTree;
```

Parse the canonical ErgoTree wire format — header byte, optional VLQ-u32 body size, optional segregated constants section, body Expr — into an `ErgoTree` struct.

- **Precondition:** `1 ≤ bytes.length ≤ MAX_TREE_SIZE` (1 MB).
- **Returns:** An `ErgoTree` whose `serializeTree` output is byte-identical to the input. See `Round-trip invariant` below.
- **Throws:** `ErgoTreeParseError` for envelope-level malformations (`'empty'`, `'oversized'`, `'body-size-overflow'`, `'too-many-constants'`, `'header-inconsistent'`). Body-parse failures surface as `ExprParseError` from the inner parser; type / value parse failures surface as `STypeParseError`, `SValueParseError`, or `SigmaBooleanParseError`. The envelope does NOT wrap them — callers see the typed failure surface from the innermost layer that rejected the bytes. `ReaderError` from the underlying cursor (`'truncated'`, `'vlq-overflow'`, `'slice-out-of-bounds'`, and — F5 batch 5 — `'position-limit-exceeded'` when an `SBox` payload's candidate span overruns its 4096-byte lazy window: JVM `ErgoBox.MaxBoxSize`, validation rule 1014 `CheckPositionLimit`) may also surface.

```ts
const tree = parseTree(treeBytes);
console.log(tree.header.version, tree.constants.length, tree.body.tag);
```

### `serializeTree(tree)`

```ts
function serializeTree(tree: ErgoTree): Uint8Array;
```

Inverse of `parseTree`. For any well-formed tree bytes `b`, `serializeTree(parseTree(b))` equals `b` byte-for-byte.

- **Precondition:** `tree` was either returned from `parseTree` or constructed satisfying the type invariants below. The `header.rawHeader` byte MUST be derivable from `header.version`, `header.hasSize`, and `header.constantSegregation` (the projection is round-trip-checked at serialize time). `constantTypes.length === constants.length` is required.
- **Returns:** `Uint8Array` of length ≤ `MAX_TREE_SIZE`.
- **Throws:** `ErgoTreeSerializeError` with `code` `'header-inconsistent'` (rawHeader does not match the derived `(version, hasSize, segregation)` triple) or `'constants-arity-mismatch'`. Body-serialize failures surface as `ExprSerializeError` (notably `'not-supported'` for the un-encodable `ZkProofBlock` variant).

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
- **`ergoTreeFromAddress`:**
  - **Precondition:** `address` is a base58check Ergo address with valid checksum and a supported address type.
  - **Returns:** The `ErgoTree` encoded by the address. P2PK addresses are reconstructed by synthesizing canonical bytes (`0x00 0x08 0xcd <33 bytes pubkey>`) and parsing them through `parseTree`, so every returned tree satisfies the same type invariants as a directly parsed one.
  - **Throws:** `AddressDecodeError` with `.code` in `'bad-base58' | 'too-short' | 'checksum-mismatch' | 'invalid-p2pk-length' | 'p2sh-unsupported' | 'unknown-type'`. A P2S address carrying malformed tree bytes throws `ErgoTreeParseError` (or a downstream parser error) — those bubble up unwrapped.
- **Round-trip invariant:** For any tree `t` and matching network `n`, `ergoTreeFromAddress(addressFromErgoTree(t, n))` parses to a structurally equivalent `ErgoTree`. P2SH addresses are NOT round-trippable through this function (they are derived from a 24-byte hash, not a serialized tree) and decoding one throws `'p2sh-unsupported'`.

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

Wire-layer SValue and SType codecs. Exposed for downstream consumers that need to parse canonical box / register bytes outside the `ErgoTree` envelope (e.g. the mainnet-validate harness reading per-output `ErgoBox::sigma_serialize` bytes and per-input `ContextExtension` constant blobs). `ByteReader` / `ByteWriter` are from `@ergots/scorex`. Throws `SValueParseError` / `SValueSerializeError` / `STypeParseError` / `STypeSerializeError` on failure. Notably, `SValueParseError 'group-element-invalid-point'` (F5 batch 4): a `GroupElement` payload whose lead byte is non-`0x00` must curve-decode (SEC1 compressed secp256k1) or the parse throws — applies wherever GE data parses (body/segregated constants, box registers, `deserializeTo[GroupElement]`, and the `deserializeTo[Header]` hydration leg's minerPk/powOnetimePk); `0x00`-lead payloads normalize to the canonical 33-zero identity instead. Notably also (F5 batch 5): `SBox` payloads parse under a **4096-byte lazy candidate window** — the candidate span (value → registers; `txId`/`index` outside) arms `positionLimit = position + 4096` (JVM `ErgoBox.MaxBoxSize`; `ErgoBoxCandidate.scala:191-192`/`:235`; rule 1014 `CheckPositionLimit`), and a read beginning past the window surfaces scorex `ReaderError('position-limit-exceeded')` from `parseSValue` / `parseTree`. There is NO token-count parse rule — the raw-u8 count's natural ceiling (255) is the only count bound (the former >122 gate, mirroring sigma-rust's `BoundedVec` cap, is removed); serialize-side, `SValueSerializeError 'sbox-tokens-out-of-range'` is re-scoped to >255 (the u8 wire ceiling; JVM `putUByte`). Full taxonomy in `facts/ergoscript-wire.md`.

### `parseSigmaBoolean` / `serializeSigmaBoolean`

```ts
function parseSigmaBoolean(r: ByteReader): SigmaBoolean;
function serializeSigmaBoolean(sb: SigmaBoolean, w: ByteWriter): void;
```

Bare `SigmaBoolean` wire round-trip (opcode + payload — the inner proposition tree, NOT an `SSigmaProp` SValue). Exposed for wire-conformance consumers that round-trip canonical `SigmaBoolean` bytes directly. Throws `SigmaBooleanParseError` / `SigmaBooleanSerializeError` on failure. Notably, `SigmaBooleanParseError 'ec-point-invalid'` (F5 batch 4): `ProveDlog.h` and `ProveDhTuple` `g`/`h`/`u`/`v` leaf points get the same validate+normalize as the SValue GE arm — `0x00`-lead → canonical identity, non-`0x00`-lead must curve-decode or the parse throws (sibling of the pre-existing `'ec-point-length'`).

### Constants

| Name | Value | Meaning |
|---|---|---|
| `MAX_TREE_SIZE` | `1_048_576` | Max input bytes for `parseTree` (1 MB; defensive cap against adversarial input) |
| `VERSION` | `'0.3.0'` | Package version string |

---

## Round-trip invariant

For any byte sequence `b` accepted by `parseTree`:

```
serializeTree(parseTree(b)) === b   (byte-equal)
```

This holds for every ErgoTree variant the package ships. The corpus test asserts this on 255 passing fixtures plus 1 mainnet-fixture stub plus 6 fixtures flagged `known_unstable` (sigma-rust itself does not round-trip them; tracked inline in the fixture JSON).

---

## Types

### `ErgoTree`

```ts
interface ErgoTree {
  header: TreeHeader;
  constantTypes: SType[];   // parallel to `constants`; required for byte-exact re-serialize
  constants: SValue[];      // empty when header.constantSegregation === false
  body: Expr;               // root expression
}
```

### `TreeHeader`

```ts
interface TreeHeader {
  version: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // bits 0..2 of rawHeader
  hasSize: boolean;                        // bit 3: VLQ-u32 body size follows
  constantSegregation: boolean;            // bit 4: segregated constants section
  rawHeader: number;                       // original byte; derivable from the three fields above
}
```

`rawHeader` is the on-wire byte. The `version`, `hasSize`, `constantSegregation` fields are derived projections kept on the struct so callers don't need to re-decode bits. `serializeTree` writes `rawHeader` directly but validates that it matches the derived fields — a hand-constructed `ErgoTree` with inconsistent fields is rejected at serialize time with `'header-inconsistent'`.

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

All three exported error classes extend `Error` and carry a `.code: string` for programmatic dispatch.

```ts
class ErgoTreeParseError     extends Error { readonly code: string }
class ErgoTreeSerializeError extends Error { readonly code: string }
class AddressDecodeError     extends Error { readonly code: string }
```

Internal modules (`wire/`, `mir/`) emit additional typed error classes (`ExprParseError`, `ExprSerializeError`, `STypeParseError`, `STypeSerializeError`, `SValueParseError`, `SValueSerializeError`, `SigmaBooleanParseError`, `ExprTpeError`, `ReaderError`); these surface from `parseTree` / `serializeTree` unwrapped — callers see the innermost typed failure. The full wire-layer error taxonomy with every emitted code is documented in `facts/ergoscript-wire.md` § "Error taxonomy (wire-layer error classes)" (runtime/evaluator codes live in `facts/ergoscript-eval.md`).

### `ErgoTreeParseError` codes

| Code | Meaning |
|---|---|
| `'empty'` | Input bytes have length 0 |
| `'oversized'` | Input bytes exceed `MAX_TREE_SIZE` |
| `'body-size-overflow'` | Declared body size (from the `hasSize` field) exceeds remaining bytes |
| `'too-many-constants'` | Segregated-constant count exceeds 4096 |
| `'header-inconsistent'` | (reserved for future header-validation checks) |
| `'header-version-requires-size'` | Tree header with version > 0 and the size bit (0x08) clear (rule-1012 `CheckHeaderSizeBit`; all 3 ingresses: main, substConstants template, box-carried script) |

### `ErgoTreeSerializeError` codes

| Code | Meaning |
|---|---|
| `'header-inconsistent'` | `rawHeader` byte does not match the derived `(version, hasSize, segregation)` triple |
| `'constants-arity-mismatch'` | `constantTypes.length !== constants.length` |

### `AddressDecodeError` codes

| Code | Meaning |
|---|---|
| `'bad-base58'` | Input contains a non-alphabet character |
| `'too-short'` | Decoded bytes shorter than (1-byte prefix + 4-byte checksum) minimum |
| `'checksum-mismatch'` | blake2b256-derived checksum disagrees with the trailing 4 bytes |
| `'invalid-p2pk-length'` | P2PK content is not exactly 33 bytes |
| `'p2sh-unsupported'` | Address type is P2SH (not representable as a parsable ErgoTree) |
| `'unknown-type'` | Address type nibble is not P2PK (0x01), P2SH (0x02), or P2S (0x03) |

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
- **Postcondition (failure):** Throws `EvalError` with one of the 84 codes enumerated in `facts/ergoscript-eval.md`. Errors raised in the recursive evaluator bubble up unwrapped.
- **Coverage caveat:** 68 of 68 implementable `Expr` variants have implemented arms (F5 batch 4 added `LastBlockUtxoRootHash` — the bare `0xa6` op-form parses and evaluates; cost 15 vs the PropertyCall form's 20). 18 wire opcodes (ModQ family, `OpTrue`/`OpFalse`/`UnitConstant`, `Select1-5`, `CollShift`/`CollRotate`, `SomeValue`, `NoneValue`) are reserved in sigma-rust's `OpCode` enum and unconditionally parse-rejected — `ExprParseError 'opcode-reserved'` — `FunDef` (`0xd7`) was the 19th but is now parsed+evaluated as a `ValDef` from v6 P6. A further 3 (`FlatMap`, `TrivialPropFalse`, `TrivialPropTrue`) are routed through other dispatch paths in sigma-rust and their top-level direct-dispatch `'not-implemented-yet'` status remains under separate review. Trees whose body reaches a not-yet-implemented method-call handler or one of 3 defensive `EvalError 'not-implemented-yet'` sites (`eval.ts:232`, `global-vars.ts:136`, `bin-op/bit.ts:58`) still throw at runtime.

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
  extension?: ContextExtension   // context-extension key-value map (SELF input)
  inputExtensions?: ContextExtension[]  // per-input extensions, indexed by spending-transaction input position (v6 P7a)
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
- **`inputExtensions`** — per-input context extensions for `Context.getVarFromInput` (101:12, v6 P7a). Indexed by spending-transaction input position (mirrors JVM `spendingTransaction.inputs(i).extension`). May legitimately differ in length from `inputs` — the JVM's own blessed `getVarFromInput` vector has `tx.inputs.length = 0` while `ctx.inputs.length = 1`; never validate length equality. Absent field ⟹ every `getVarFromInput` lookup → `None`. Key domain is unsigned 0–255 (ContextExtension byte keys); JVM JSON ingestion normalizes signed `-1` to `255` — supply `255`, not `-1`, when constructing extensions from JVM JSON output.

### `EvalError`

```ts
class EvalError extends Error {
  readonly code: string;  // one of the 84 codes in facts/ergoscript-eval.md
}
```

All 84 `EvalError` codes and their semantics are documented in `facts/ergoscript-eval.md` § "EvalError taxonomy". Notable codes:

| Code | When thrown |
|---|---|
| `'not-implemented-yet'` | An `Expr` variant with no arm, or a defensive site in an arm |
| `'cost-limit-exceeded'` | `ctx.jitCost` exceeded `jitCostLimit` after a charge |
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

---

## V3 (ErgoTree v6) surface

The following method handlers and types are **V3-gated** (require `tree.header.version >= 3`; pre-V3 trees throw `EvalError 'tree-version-too-low'` before the handler runs). All 128 registry entries are documented in full in `facts/ergoscript-eval.md`.

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
- **Throws:** `VerifyError` with one of 8 codes — see `facts/ergoscript-sigma.md` for the full taxonomy.

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
