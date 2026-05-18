# API — `@ergots/avltree`

Public surface for the AVL+ authenticated dictionary verifier. The verification semantics this implements come from `ergo_avltree_rust` (HEAD `879545c`); see `facts/avltree.md` in the repo root for the load-bearing interface contract.

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, WASM, or other Node built-ins.

---

## Primary export

```ts
import {
  verifyAvlBatch,
  verifyAvlLookup,
  type VerifyAvlBatchResult,
  type AvlTreeConfig,
  type Operation,
  type OperationResult,
  AvlVerifyError,
  type AvlVerifyErrorCode,
} from '@ergots/avltree';
```

---

## Functions

### `verifyAvlBatch(startingDigest, proof, config, operations)`

```ts
function verifyAvlBatch(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchResult | null
```

Verify an authenticated batch of AVL+ operations against a serialized AD proof.

Reconstructs the tree from `proof`, replays each operation in `operations` order, checks all leaf hashes, confirms the reconstructed root matches `startingDigest`, applies each operation, and returns the resulting digest plus the old value at each key before the operation ran.

**Parameters:**

- `startingDigest` — 33-byte AD digest representing the tree state before this batch. Format: 32-byte blake2b-256 root label followed by 1-byte tree height.
- `proof` — serialized AD proof bytes as produced by `ergo_avltree_rust`'s `BatchAVLProver`.
- `config` — verifier configuration matching the on-chain tree parameters. See `AvlTreeConfig` below.
- `operations` — ordered list of operations to replay. May be empty (returns a result with `results: []` and `newDigest === startingDigest` if the proof is valid).

**Returns:** `VerifyAvlBatchResult | null`. Returns `null` on any verification failure: malformed proof, digest mismatch, or operation precondition violation. Returns a `VerifyAvlBatchResult` on success.

**Throws:** `AvlVerifyError` (6 codes) on programmer-error input — invalid config, wrong digest length, key/value length mismatch. These are bugs in calling code, not proof-data failures.

**Example:**

```ts
const config: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null };
const result = verifyAvlBatch(startingDigest, proof, config, [
  { tag: 'Insert', key: myKey, value: myValue },
  { tag: 'Lookup', key: otherKey },
]);
if (result === null) {
  // proof invalid or operation precondition failed
} else {
  console.log('new digest:', result.newDigest);  // 33 bytes
  console.log('old at Insert key:', result.results[0]); // null (was absent)
  console.log('old at Lookup key:', result.results[1]); // Uint8Array or null
}
```

---

### `verifyAvlLookup(startingDigest, proof, config, key)`

```ts
function verifyAvlLookup(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  key: Uint8Array,
): { value: Uint8Array | null } | null
```

Convenience wrapper over `verifyAvlBatch` for single-key reads. Equivalent to calling `verifyAvlBatch` with `operations = [{ tag: 'Lookup', key }]` and extracting `results[0]`.

**Parameters:** Same as `verifyAvlBatch`, except `key` replaces the `operations` array.

**Returns:**
- `{ value: Uint8Array }` — proof valid and key is present; `value` is the stored bytes.
- `{ value: null }` — proof valid and key is absent.
- `null` (outer) — proof verification failed.

The outer `null` (proof failed) is distinct from `{ value: null }` (proof passed; key absent). Callers must check for both.

**Throws:** `AvlVerifyError` with the same codes as `verifyAvlBatch`.

**Example:**

```ts
const result = verifyAvlLookup(startingDigest, proof, config, tokenKey);
if (result === null) {
  console.error('proof failed');
} else if (result.value === null) {
  console.log('key not in tree');
} else {
  console.log('token data:', result.value);
}
```

---

## Types

### `AvlTreeConfig`

```ts
export interface AvlTreeConfig {
  /** Bytes per key. Must be > 0. */
  keyLength: number;
  /** Bytes per value; null = variable length per leaf. */
  valueLengthOpt: number | null;
  /** Optional DoS guard — max operations across this batch. */
  maxNumOperations?: number;
  /** Max deletions across this batch. Defaults to maxNumOperations when both set. */
  maxDeletes?: number;
}
```

`keyLength` must match the tree's actual key length; the verifier checks every key against it before constructing any state.

`valueLengthOpt` constrains value byte lengths when the tree uses fixed-size values. Pass `null` for variable-length values (e.g. most Ergo use cases with arbitrary token data).

`maxNumOperations` and `maxDeletes` are optional DoS guards. When set, `maxDeletes` must not exceed `maxNumOperations`.

---

### `Operation`

```ts
export type Operation =
  | { tag: 'Lookup';              key: Uint8Array }
  | { tag: 'UnknownModification'; key: Uint8Array }
  | { tag: 'Insert';              key: Uint8Array; value: Uint8Array }
  | { tag: 'Update';              key: Uint8Array; value: Uint8Array }
  | { tag: 'InsertOrUpdate';      key: Uint8Array; value: Uint8Array }
  | { tag: 'UpdateLongBy';        key: Uint8Array; delta: bigint }
  | { tag: 'Remove';              key: Uint8Array }
  | { tag: 'RemoveIfExists';      key: Uint8Array }
```

All 8 variants use `key: Uint8Array` of length `config.keyLength`. For `Insert`, `Update`, and `InsertOrUpdate`, `value.length` must equal `config.valueLengthOpt` when that field is not `null`.

**Variant semantics:**

| Variant | Key present (leaf-match) | Key absent (leaf-gap) |
|---|---|---|
| `Lookup` | Return old value; no change | Return `null`; no change |
| `UnknownModification` | Return old value; no change | Return `null`; no change |
| `Insert` | Fail (key already exists) | Split leaf; tree grows by 1 |
| `Update` | Replace value; height unchanged | Fail (key not found) |
| `InsertOrUpdate` | Replace value (match path) | Split leaf (gap path) |
| `UpdateLongBy` | Add `delta` to stored i64; result = 0 → delete | Insert `delta` if positive; fail if negative |
| `Remove` | Delete leaf; tree shrinks by 1 | Fail (key not found) |
| `RemoveIfExists` | Delete leaf; tree shrinks by 1 | No-op (absent key; no change) |

`UpdateLongBy.delta` is a `bigint` representing a signed 64-bit integer. Browsers support `bigint` natively since 2020; no polyfill ships with this package.

---

### `VerifyAvlBatchResult`

```ts
export interface VerifyAvlBatchResult {
  readonly newDigest: Uint8Array;          // 33 bytes: 32-byte root label + 1-byte height
  readonly results: (Uint8Array | null)[]; // one entry per operation
}
```

`newDigest` is the 33-byte AD digest after all operations have been applied. It is byte-identical to what `ergo_avltree_rust`'s `BatchAVLVerifier` would produce on the same inputs.

`results[i]` is the value stored at `operations[i].key` **before** operation `i` ran. `null` means the key was absent before the operation. For non-read operations (Insert, Remove, etc.), this is the old value that was overwritten or deleted.

---

### `OperationResult`

```ts
export type OperationResult = Uint8Array | null;
```

Documentation-only alias for `Uint8Array | null`. Used as the element type of `VerifyAvlBatchResult.results`. `null` means the key was absent before the corresponding operation.

---

## Error handling

The package enforces a two-tier failure model.

### Tier 1 — `AvlVerifyError` thrown (programmer errors)

Shape validation runs at the public entry point before any verifier state is constructed. These errors indicate bugs in calling code, not malformed proof data.

```ts
export class AvlVerifyError extends Error {
  readonly code: AvlVerifyErrorCode;
}

export type AvlVerifyErrorCode =
  | 'invalid-config-key-length'
  | 'invalid-config-value-length'
  | 'invalid-config-max-ops'
  | 'invalid-starting-digest-length'
  | 'operation-key-length-mismatch'
  | 'operation-value-length-mismatch'
```

### `AvlVerifyErrorCode` meanings

| Code | When thrown |
|---|---|
| `'invalid-config-key-length'` | `config.keyLength <= 0` |
| `'invalid-config-value-length'` | `config.valueLengthOpt` is set but `< 0` |
| `'invalid-config-max-ops'` | `maxNumOperations < 0`, or `maxDeletes > maxNumOperations` when both set |
| `'invalid-starting-digest-length'` | `startingDigest.length !== 33` |
| `'operation-key-length-mismatch'` | `op.key.length !== config.keyLength` for some operation `op` |
| `'operation-value-length-mismatch'` | `op.value.length !== config.valueLengthOpt` for some operation `op` with a `value` field, when `valueLengthOpt` is not `null` |

### Tier 2 — `null` return (verification failures)

Any failure inside the verifier — malformed proof bytes, digest mismatch, operation precondition violation, DoS-bound exceeded — causes `verifyAvlBatch` / `verifyAvlLookup` to return `null`. No exception is thrown. The distinction allows callers to handle "bad proof from peer" (return `null`) separately from "bad arguments from my own code" (throw).

Internal failure reasons (malformed token, digest mismatch, leaf out-of-order, etc.) are tracked by the internal `BatchAvlVerifier` class but are not exposed in the public v0.1.0 surface. This avoids locking the internal taxonomy prematurely; diagnostic reasons may be exposed via a `getLastFailReason()` accessor in a later release.

```ts
// Pattern: handle both tiers explicitly.
try {
  const result = verifyAvlBatch(digest, proof, config, ops);
  if (result === null) {
    // Verification failed — bad proof, digest mismatch, or operation error.
  } else {
    // Success.
  }
} catch (e) {
  if (e instanceof AvlVerifyError) {
    // Programmer error: fix config or operation shape.
    console.error(e.code, e.message);
  }
  throw e; // unexpected
}
```

---

## Conventions

- **All byte sequences are `Uint8Array`.** Never `Buffer`. Keys, values, digests, and proof bytes all use the same type.
- **`keyLength`, `valueLengthOpt`, heights, and counts are `number`.** JS `Number` is safe up to 2^53; all values here fit comfortably.
- **`bigint` for `UpdateLongBy.delta`.** Represents a signed 64-bit integer (i64 equivalent).
- **No async surface.** Every function is synchronous. Blake2b-256 runs in tight inner loops; an async boundary would only add overhead.
- **No I/O, no globals.** Pure functions: no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- **Throws on programmer errors, returns `null` on verification failures.** `AvlVerifyError` codes are for programmatic dispatch on bugs in calling code. Malformed proofs never throw.
- **Deterministic.** `newDigest` is byte-identical to what `ergo_avltree_rust`'s `BatchAVLVerifier` produces on the same inputs. Every fixture in the test corpus asserts this.

---

## See also

- `facts/avltree.md` (repo root) — load-bearing interface contract referenced by downstream packages
- `docs/specs/2026-05-18-ergots-avltree-package-design.md` — design rationale, validation strategy, error model detail
- `facts/ergoscript-eval.md` — upstream consumer: `SAvlTree.*` method handlers in `@ergots/ergoscript` phase 2h-b
- [KMZ16 paper](https://eprint.iacr.org/2016/994) — AVL+ authenticated dictionary
- [`ergo_avltree_rust`](https://github.com/ergoplatform/ergo_avltree_rust) — reference Rust implementation (HEAD `879545c`)
