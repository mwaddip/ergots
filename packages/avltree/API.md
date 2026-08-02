# API — `@ergots/avltree`

Public surface for the AVL+ authenticated dictionary verifier. The verification semantics this implements come from `ergo_avltree_rust` (HEAD `191052c`); see `facts/avltree.md` in the repo root for the load-bearing interface contract.

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, WASM, or other Node built-ins.

---

## Primary export

```ts
import {
  verifyAvlBatch,
  verifyAvlBatchPartial,
  verifyAvlLookup,
  type VerifyAvlBatchResult,
  type VerifyAvlBatchPartialResult,
  type AvlTreeConfig,
  type Operation,
  type OperationResult,
  AvlVerifyError,
  type AvlVerifyErrorCode,
  BatchAVLProver,
  type ProverOperationResult,
  PersistentBatchAVLProver,
  type VersionedAVLStorage,
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

### `verifyAvlBatchPartial(startingDigest, proof, config, operations)`

```ts
function verifyAvlBatchPartial(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchPartialResult | null
```

Same as `verifyAvlBatch` but returns a partial-success result on per-op failure: `newDigest` is the digest AFTER the last successful operation (or `startingDigest` when op 0 fails), `results.length === opsCompleted`, and `opsCompleted` is the count of successful operations before the failing one.

Returns `null` only when the verifier itself fails to anchor (proof decode failure or digest mismatch in the constructor) — there is no partial state to report in that case.

Throws `AvlVerifyError` for programmer-error inputs (same shape validation as `verifyAvlBatch`).

**Why partial?** Backs `@ergots/ergoscript`'s V3+ `SAvlTree.insert/update` semantics, which honor sigma-rust's "break gracefully on per-op failure with state-after-last-success" behaviour. For all-or-nothing use, `verifyAvlBatch` is the thin wrapper that collapses any partial result to `null`.

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

### `VerifyAvlBatchPartialResult`

```ts
export interface VerifyAvlBatchPartialResult {
  readonly newDigest: Uint8Array;          // 33 bytes — state AFTER last successful op
  readonly results: (Uint8Array | null)[]; // length === opsCompleted
  readonly opsCompleted: number;           // count of successful ops; === operations.length on full success
}
```

Returned by `verifyAvlBatchPartial`. On full success, `opsCompleted === operations.length` and `newDigest` matches what `verifyAvlBatch` returns. On per-op failure, `newDigest` is the snapshot taken BEFORE the failing op (i.e., state after the last successful op).

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
  | 'operation-delta-out-of-range'
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
| `'operation-delta-out-of-range'` | `UpdateLongBy.delta` outside signed i64 range (audit AVL-03) |

### Tier 2 — `null` return (verification failures)

Any failure inside the verifier — malformed proof bytes, digest mismatch, operation precondition violation, DoS-bound exceeded — causes `verifyAvlBatch` / `verifyAvlLookup` to return `null`. No exception is thrown. The distinction allows callers to handle "bad proof from peer" (return `null`) separately from "bad arguments from my own code" (throw).

Internal failure reasons (malformed token, digest mismatch, leaf out-of-order, etc.) are tracked by the internal `BatchAvlVerifier` class but are not exposed in the public v0.4.0 surface. This avoids locking the internal taxonomy prematurely; diagnostic reasons may be exposed via a `getLastFailReason()` accessor in a later release.

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

## Prover

The package ships a pure-TS AVL+ tree prover that builds in-memory trees, applies authenticated operations, and generates serialized AD proofs. Prover and verifier share the same mutation engine (`modifyHelper` / `deleteHelper`) through the `AvlTreeOpsCallbacks` interface, so a proof generated by `BatchAVLProver` is byte-identical to what `ergo_avltree_rust`'s prover emits and can be verified by `verifyAvlBatch`.

Prover use cases: generating fixture proofs, building test vectors, or constructing Merkle proofs offline without a running node. The prover is NOT needed for chain validation — `verifyAvlBatch` is stateless and accepts proof bytes from any source.

---

### `BatchAVLProver`

```ts
class BatchAVLProver {
  constructor(keyLength: number, valueLengthOpt: number | null)
  performOneOperation(op: Operation): ProverOperationResult
  generateProof(): Uint8Array
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null
  digest(): Uint8Array | null
  generateProofForOperations(operations: Operation[]):
    { proof: Uint8Array; digest: Uint8Array } | { success: false }
  restoreRoot(root: AvlNode, height: number): void
}
```

In-memory AVL+ tree prover. Ports `ergo_avltree_rust/src/batch_avl_prover.rs`.

**Constructor:** `new BatchAVLProver(keyLength, valueLengthOpt)` creates an empty tree seeded with -inf / +inf sentinel leaves. `keyLength` must be > 0. `valueLengthOpt` is `null` for variable-length values or a positive integer for fixed-length.

**`performOneOperation(op)`** — applies a single operation to the tree, recording traversal directions for proof generation. Returns:
- `{ success: true, value }` — operation succeeded. `value` is the old value at the key (`Uint8Array`) or `null` if the key was absent.
- `{ success: false }` — operation precondition failed (e.g., `Insert` on an existing key, `Update` on an absent key).

Throws `AvlVerifyError` on programmer errors (key length mismatch, out-of-bounds key, value length mismatch with fixed config).

**`generateProof()`** — serializes a proof covering all operations since the last call (or since construction). Returns a `Uint8Array` in the packed proof format. Resets direction tracking after generation; subsequent operations start a fresh cycle.

**`unauthenticatedLookup(key)`** — walks the tree without recording state. Returns the value at `key`, or `null` if absent. Does not affect proof generation.

**`digest()`** — returns the current 33-byte digest (32-byte root label + 1-byte height), or `null` if the tree is poisoned.

**`generateProofForOperations(operations)`** — clones the tree, applies all operations on the clone, and returns `{ proof, digest }`. Returns `{ success: false }` if any operation fails. The original tree is untouched. This is the primary entry point for producing proofs verifiable by `verifyAvlBatch`.

**`restoreRoot(root, height)`** — installs a storage-loaded root and height, then rebases the proof cycle: clears modified-node bookkeeping and accumulated directions, sets `oldTopNode` to the restored root, and suppresses the next cycle reset. Call this after loading a tree from storage — startup resume, snapshot bootstrap, or recovery rollback — before performing further operations or generating a proof; without it, `oldTopNode` is left at its stale in-memory value and `generateProof()` produces incorrect proofs.

**Example:**

```ts
const prover = new BatchAVLProver(32, null)
prover.performOneOperation({ tag: 'Insert', key: myKey, value: myValue })
const proof = prover.generateProof()
const digest = prover.digest()!

// Verify externally:
const result = verifyAvlBatch(initialDigest, proof, config, [
  { tag: 'Insert', key: myKey, value: myValue },
])
// result.newDigest equals digest
// result.results[0] is null (key was absent before Insert)
```

---

### `PersistentBatchAVLProver`

```ts
class PersistentBatchAVLProver {
  readonly prover: BatchAVLProver
  readonly storage: VersionedAVLStorage

  constructor(
    prover: BatchAVLProver,
    storage: VersionedAVLStorage,
    additionalData: [Uint8Array, Uint8Array][],
  )
  performOneOperation(operation: Operation): ProverOperationResult
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null
  digest(): Uint8Array | null
  height(): number
  generateProofAndUpdateStorage(additionalData: [Uint8Array, Uint8Array][]): Uint8Array
  rollback(version: Uint8Array): void
}
```

Wraps a `BatchAVLProver` with a `VersionedAVLStorage` backend. Ports `ergo_avltree_rust/src/persistent_batch_avl_prover.rs`.

On construction, either rolls back to the stored version (if one exists) or generates an initial proof and writes the new version to storage. All tree-modifying ops are delegated to the inner `BatchAVLProver`; the storage layer is synced on each `generateProofAndUpdateStorage` call.

**`performOneOperation`, `unauthenticatedLookup`, `digest`** — delegated to the inner `BatchAVLProver`.

**`height()`** — returns the current tree height.

**`generateProofAndUpdateStorage(additionalData)`** — commits the current state to storage, then generates and returns a proof. `additionalData` is key-value pairs to store alongside the tree state (e.g., metadata).

**`rollback(version)`** — restores the prover's tree to a previously stored version.

---

### `VersionedAVLStorage`

```ts
interface VersionedAVLStorage {
  update(prover: BatchAVLProver, additionalData: [Uint8Array, Uint8Array][]): void
  rollback(version: Uint8Array): [root: unknown, height: number]
  version(): Uint8Array | null
  rollbackVersions(): Uint8Array[]
  flush(): void
}
```

Interface for persistent tree storage. Ports `ergo_avltree_rust/src/versioned_avl_storage.rs`. No concrete implementation ships — consumers provide their own (in-memory for tests, redb / SQLite / IndexedDB for production).

- **`update(prover, additionalData)`** — persist the prover's current state and associated metadata.
- **`rollback(version)`** — retrieve root node and height for the given version.
- **`version()`** — current version digest, or `null` if empty.
- **`rollbackVersions()`** — list available versions for rollback.
- **`flush()`** — force durable commit (no-op by default).

---

### `ProverOperationResult`

```ts
type ProverOperationResult =
  | { success: true; value: Uint8Array | null }
  | { success: false }
```

Return type of `BatchAVLProver.performOneOperation`. On success, `value` is the old value at the key (or `null` if absent). On failure, the caller should inspect the prover state to determine what precondition was violated.

---

## Storage codec

```ts
serializeNode(node: AvlNode, config: AvlTreeConfig): Uint8Array
deserializeNode(bytes: Uint8Array, config: AvlTreeConfig): AvlNode
```

Encodes a single AVL+ node for persistence, byte-identical to
`ergo_avltree_rust`'s `AVLTree::pack` / `unpack` for well-formed input — two of
the throw conditions below (a key/value-length mismatch on encode, an
out-of-range balance byte on decode) are deliberately stricter than the
reference, which performs neither; see `facts/avltree.md`'s "Deliberate
divergences from the reference" for why. Traversal is the caller's
responsibility: a storage backend walks the tree and stores one record per
node, keyed by `label(node)`.

```
internal: 0x00 || balance(i8) || key(keyLength) || leftLabel(32) || rightLabel(32)
leaf:     0x01 || key(keyLength) || [valueLen(u32 BE) iff valueLengthOpt is null]
               || value || nextLeafKey(keyLength)
```

Only `keyLength` and `valueLengthOpt` are read from `config`.

`deserializeNode` returns internal nodes whose children are `LabelNode` stubs
carrying the encoded digests — the record stores child labels, not child
subtrees. Backends relink real children by looking those labels up.

Throws `RangeError` on: a `LabelNode` or a keyless `InternalNode` passed to
`serializeNode`; a key or fixed-length value disagreeing with `config`; truncated
input; an unknown leading tag; a balance byte outside `-1 | 0 | 1`.

The format is not self-describing — lengths come from `config`, so a
writer/reader mismatch is not generally detectable.

### Example

Both directions: writing a tree to storage, and loading it back with child
stubs relinked by label lookup.

```ts
import {
  serializeNode, deserializeNode, label,
  type AvlNode, type AvlTreeConfig,
} from '@ergots/avltree'

const config: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }

export function persist(node: AvlNode, write: (k: Uint8Array, v: Uint8Array) => void) {
  write(label(node), serializeNode(node, config))
  if (node.kind === 'internal') {
    persist(node.left, write)
    persist(node.right, write)
  }
}

export function load(key: Uint8Array, read: (k: Uint8Array) => Uint8Array): AvlNode {
  const node = deserializeNode(read(key), config)
  if (node.kind !== 'internal') return node
  const { left, right } = node
  if (left.kind === 'label') node.left = load(left.label, read)
  if (right.kind === 'label') node.right = load(right.label, read)
  return node
}
```

Once a root is loaded this way, call `BatchAVLProver.restoreRoot(root, height)`
(above) before performing further operations or generating a proof — it
rebases the prover's proof cycle onto the loaded root.

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
- [`ergo_avltree_rust`](https://github.com/ergoplatform/ergo_avltree_rust) — reference Rust implementation (HEAD `191052c`)
