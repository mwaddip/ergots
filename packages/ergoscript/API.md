# API — `@mwaddip/ergots-ergoscript`

Public surface for the ErgoTree wire-format package. The wire format and serialization semantics this implements come from `ergotree-ir` (sigma-rust, branch `integration/ergots`); see [`facts/ergoscript.md`](../../facts/ergoscript.md) in the repo root for the load-bearing interface contract.

## Entry points

| Import path | Purpose |
|---|---|
| `@mwaddip/ergots-ergoscript` | Parse + serialize ErgoTree; address ↔ ErgoTree conversion |

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, or other Node built-ins. No WASM.

Phase 2a ships the wire-format surface only — parse, serialize, and address helpers. Constant evaluation, the evaluator, the sigma-protocol prover/verifier, AVL+ membership proofs, and cost accounting are scheduled for later phases (2b–2j). See `facts/ergoscript.md` § Scope for the line.

---

## Primary export

```ts
import {
  parseTree, serializeTree,
  isP2PK, p2pkPublicKey,
  addressFromErgoTree, ergoTreeFromAddress,
  base58Encode, base58Decode,
  MAX_TREE_SIZE, VERSION,
  type ErgoTree, type TreeHeader, type SType, type SValue, type Expr,
  type Network, type AddressType,
  ErgoTreeParseError, ErgoTreeSerializeError, AddressDecodeError,
} from '@mwaddip/ergots-ergoscript';
```

### `parseTree(bytes)`

```ts
function parseTree(bytes: Uint8Array): ErgoTree;
```

Parse the canonical ErgoTree wire format — header byte, optional VLQ-u32 body size, optional segregated constants section, body Expr — into an `ErgoTree` struct.

- **Precondition:** `1 ≤ bytes.length ≤ MAX_TREE_SIZE` (1 MB).
- **Returns:** An `ErgoTree` whose `serializeTree` output is byte-identical to the input. See `Round-trip invariant` below.
- **Throws:** `ErgoTreeParseError` for envelope-level malformations (`'empty'`, `'oversized'`, `'body-size-overflow'`, `'too-many-constants'`, `'header-inconsistent'`). Body-parse failures surface as `ExprParseError` from the inner parser; type / value parse failures surface as `STypeParseError`, `SValueParseError`, or `SigmaBooleanParseError`. The envelope does NOT wrap them — callers see the typed failure surface from the innermost layer that rejected the bytes. `ReaderError` from the underlying cursor (`'truncated'`, `'vlq-overflow'`, `'slice-out-of-bounds'`) may also surface.

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

### Constants

| Name | Value | Meaning |
|---|---|---|
| `MAX_TREE_SIZE` | `1_048_576` | Max input bytes for `parseTree` (1 MB; defensive cap against adversarial input) |
| `VERSION` | `'0.0.1'` | Package version string |

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

Closed discriminated union over the ErgoScript type system. Mirrors sigma-rust's `ergotree-ir/src/types/stype.rs` minus `SUnsignedBigInt` (v6-only; the reference verifier rejects it via `check_v6_type`).

### `SValue`

```ts
type SValue =
  | { kind: 'Boolean';      value: boolean }
  | { kind: 'Byte';         value: number }    // i8 range, but stored as number
  | { kind: 'Short';        value: number }    // i16 range
  | { kind: 'Int';          value: number }    // i32 range
  | { kind: 'Long';         value: bigint }    // i64 range
  | { kind: 'BigInt';       value: bigint }    // arbitrary signed bigint
  | { kind: 'GroupElement'; value: Uint8Array }    // 33-byte compressed secp256k1
  | { kind: 'SigmaProp';    value: SigmaBoolean }  // opaque raw bytes in phase 2a
  | { kind: 'Box';          value: ErgoBox }
  | { kind: 'AvlTree';      value: AvlTreeData }
  | { kind: 'Unit' }
  | { kind: 'Coll';         elem: SType; items: SValue[] }
  | { kind: 'Tuple';        items: SValue[] }
  | { kind: 'Option';       elem: SType; value: SValue | null }
  | { kind: 'Lambda';       closure: Closure };
```

Runtime-value discriminated union. Composite kinds (`Coll`, `Option`) carry their element type explicitly because the wire format does not always encode it unambiguously (empty `Coll`, `None` for `SOption`).

`SigmaProp.value.raw` is the opaque on-wire bytes of the sigma-protocol proposition tree in phase 2a. Structural decode happens only to determine length; structural access (for sigma-protocol evaluation) is deferred to phase 2g.

### `Expr`

`Expr` is a 68-variant discriminated union keyed on `tag` over MIR nodes. Each variant's payload mirrors sigma-rust's `mir/<variant>.rs` struct fields. Full per-variant shapes live in `packages/ergoscript/src/mir/types.ts`. The variants are:

`Append`, `Const`, `ConstPlaceholder`, `SubstConstants`, `ByteArrayToLong`, `ByteArrayToBigInt`, `LongToByteArray`, `Collection`, `Tuple`, `CalcBlake2b256`, `CalcSha256`, `Context`, `Global`, `GlobalVars`, `FuncValue`, `Apply`, `MethodCall`, `PropertyCall`, `BlockValue`, `ValDef`, `ValUse`, `If`, `BinOp`, `And`, `Or`, `Xor`, `Atleast`, `LogicalNot`, `Negation`, `BitInversion`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `ExtractAmount`, `ExtractRegisterAs`, `ExtractBytes`, `ExtractBytesWithNoRef`, `ExtractScriptBytes`, `ExtractCreationInfo`, `ExtractId`, `ByIndex`, `SizeOf`, `Slice`, `Fold`, `Map`, `Filter`, `Exists`, `ForAll`, `SelectField`, `BoolToSigmaProp`, `Upcast`, `Downcast`, `CreateProveDlog`, `CreateProveDhTuple`, `SigmaPropBytes`, `SigmaPropIsProven`, `ZkProofBlock`, `DecodePoint`, `SigmaAnd`, `SigmaOr`, `GetVar`, `DeserializeRegister`, `DeserializeContext`, `MultiplyGroup`, `Exponentiate`, `XorOf`, `TreeLookup`, `CreateAvlTree`.

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

Internal modules (`wire/`, `mir/`) emit additional typed error classes (`ExprParseError`, `ExprSerializeError`, `STypeParseError`, `STypeSerializeError`, `SValueParseError`, `SValueSerializeError`, `SigmaBooleanParseError`, `ExprTpeError`, `ReaderError`); these surface from `parseTree` / `serializeTree` unwrapped — callers see the innermost typed failure. The full error taxonomy with every emitted code is documented in `facts/ergoscript.md` § "Error taxonomy".

### `ErgoTreeParseError` codes

| Code | Meaning |
|---|---|
| `'empty'` | Input bytes have length 0 |
| `'oversized'` | Input bytes exceed `MAX_TREE_SIZE` |
| `'body-size-overflow'` | Declared body size (from the `hasSize` field) exceeds remaining bytes |
| `'too-many-constants'` | Segregated-constant count exceeds 4096 |
| `'header-inconsistent'` | (reserved for future header-validation checks) |

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

## Conventions

- **All byte sequences are `Uint8Array`.** Never `Buffer`. Hash digests, IDs, public keys, and serialized trees all use the same type.
- **`number` for `SByte`/`SShort`/`SInt`/heights/version/registerId.** JS `Number` is safe up to 2^53; i32-and-smaller values fit comfortably.
- **`bigint` for `SLong`, `SBigInt`, and ErgoBox values.** Anything that can exceed `Number.MAX_SAFE_INTEGER` uses `bigint`.
- **No async surface.** Every function is synchronous. Hashing is a tight loop; the async boundary would only add overhead.
- **No I/O, no globals.** Pure functions: same inputs always produce the same output.
- **Throws on input rejection.** Parse and serialize errors throw typed exceptions with `.code` for programmatic dispatch. Programmer-error invariants (out-of-range writes, contract violations) throw plain `Error`.

## See also

- `facts/ergoscript.md` (repo root) — load-bearing interface contract referenced by downstream packages
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — design rationale, phase plan, validation strategy, risks
- [sigma-rust `ergotree-ir`](https://github.com/ergoplatform/sigma-rust/tree/develop/ergotree-ir) — reference Rust implementation (this package targets branch `integration/ergots`)
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical ErgoScript language specification
