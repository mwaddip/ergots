# API — `@ergots/avltree`

Public surface for the AVL+ authenticated dictionary verifier. The verification semantics this implements come from `ergo_avltree_rust` (pin `568e7c3`; see the rebase note in `facts/avltree.md` § Source mapping); see `facts/avltree.md` in the repo root for the load-bearing interface contract.

All exports are ESM. The package targets Node ≥ 20 and evergreen browsers; no `Buffer`, `node:crypto`, WASM, or other Node built-ins.

---

## Primary export

```ts
import {
  verifyAvlBatch,
  verifyAvlBatchPartial,
  verifyAvlLookup,
  BatchAVLVerifier,
  StrictBatchAVLVerifier,
  type VerifyAvlBatchResult,
  type VerifyAvlBatchPartialResult,
  type AvlTreeConfig,
  type Operation,
  type OperationResult,
  AvlVerifyError,
  type AvlVerifyErrorCode,
  type AvlVerifyFailReason,
  BatchAVLProver,
  type ProverOperationResult,
  type NeighborLookup,
  type NeighborLookupResult,
  PersistentBatchAVLProver,
  type VersionedAVLStorage,
  type AvlNode,
  type LeafNode,
  type InternalNode,
  type LabelNode,
  type Balance,
  newLeaf,
  newInternal,
  newLabel,
  label,
  serializeNode,
  deserializeNode,
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

**Throws:** `AvlVerifyError` (8 codes) on programmer-error input — invalid config, wrong digest length, key/value length mismatch, or an out-of-bounds operation key. These are bugs in calling code, not proof-data failures. This function's own shape-validation wrapper throws 7 of the 8 codes; the 8th, `operation-key-out-of-bounds`, is thrown only by `BatchAVLProver`'s operations and neighbor lookups — see "Error handling" below for the full code list.

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

### BatchAVLVerifier (0.5.0)

```ts
class BatchAVLVerifier {
  // Anchors the proof at startingDigest. A proof that does not anchor poisons the verifier; it does not throw.
  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig)
  // One operation, as a state transition asks for it. A { success: false } poisons the verifier.
  performOneOperation(op: Operation): ProverOperationResult
  // A Lookup that also reports the neighbors (see "Neighbor lookups").
  performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult
  // The current 33-byte digest, or null once poisoned.
  digest(): Uint8Array | null
  // The first failure's reason, or null while healthy.
  getLastFailReason(): AvlVerifyFailReason | null
}
```

The step-by-step verifier. It is the public face of `batch_avl_verifier.rs::BatchAVLVerifier` (`new`, `perform_one_operation`, plus the `AuthenticatedTreeOps` trait's `digest`). A proof that fails to decode or anchor does not make construction throw, following scrypto 3.0.0: its constructor sets `topNode` from `reconstructedTree`, which is `None` on failure. Shape errors (the config, the starting digest's length) still throw `AvlVerifyError`, as in the batch functions; scrypto folds those into the same `Try`. Rust's `new` rejects only two of them, `key_length == 0` and a wrong digest length, with the same `Err` it returns for a decode failure (`reconstruct_tree`'s `ensure!`s, `batch_avl_verifier.rs:81-82` @568e7c3); the value-length and max-operations checks are ergots-side.

- **Construction.**
  - Copies the four `config` fields, validates the copy (`validateConfig`), validates `startingDigest`, then copies `proof` with `new Uint8Array(proof)`. Never `.slice()`: `Buffer#slice` is a view.
  - Throws `AvlVerifyError` with `verifyAvlBatchPartial`'s codes for a bad config or digest length.
  - The copies matter because the verifier outlives the call. The core reads direction bits from `proof` lazily, one operation at a time.
- **Poisoned from birth.** A proof that fails to decode or anchor does not throw.
  - `digest()` is `null`.
  - `getLastFailReason()` is `'proof-truncated'`, `'proof-malformed'`, `'digest-mismatch'` or `'max-nodes-exceeded'`.
  - Every operation returns `{ success: false }`.
- **`performOneOperation(op)`.**
  - It validates the operation's shape first (`validateOperationShape`: key length, value length, delta range). A violation throws `AvlVerifyError` and changes no state.
  - It then applies the operation exactly as `verifyAvlBatchPartial` does.
  - Success returns `{ success: true, value }`, with `value` a fresh copy, or `null` when the key was absent.
  - A verification failure returns `{ success: false }` and poisons the verifier: every later operation fails (the references' rule).
  - A key at or beyond a sentinel fails and poisons with `'key-out-of-bounds'`.
- **`performLookupWithNeighbors(key)`.** A `Lookup`, with the same key validation, proof consumption and poisoning, that also reports the neighbors (see "Neighbor lookups").
- **`digest()`.** A fresh 33-byte buffer, or `null` once poisoned.
- **`getLastFailReason()`.**
  - `null` while healthy.
  - Once poisoned, the FIRST failure's reason; later operations do not overwrite it.
  - `AvlVerifyError` throws set no reason.
  - It is not covered by the fail-stop below: it keeps answering on an indeterminate instance, and a `null` there does not mean the instance is usable, because after an engine throw the instance is indeterminate regardless.
- **Fail-stop after an engine throw.** A throw that is not an `AvlVerifyError` can escape mid-operation: the recursion residual's `RangeError` (see "Tier 2 — `null` return"), or an internal invariant `Error`. It leaves the core's traversal cursors advanced with the root intact. So the verifier sets a mark around each operation's core call. After such a throw, every later `performOneOperation`, `performLookupWithNeighbors` and `digest()` throws a plain `Error` saying the instance is indeterminate and must be discarded. It never returns `{ success: false }` for this, because an engine throw is not a rejection.
- **One interface, two asymmetries.** `performOneOperation` returns the prover's `ProverOperationResult`, so one interface can drive either side: a producer's prover or a consumer's verifier. The two agree step for step only while every operation succeeds.
  1. The prover rolls a failed operation back, omits it from the proof, and carries on. The verifier fails and poisons on the same operation. A `{ success: false }` must therefore be fatal to the enclosing batch or block on both sides.
  2. A sentinel key throws `'operation-key-out-of-bounds'` on the prover, but fails and poisons on the verifier.
- **Invariant.** The same determinism as the functions: no I/O, no clock, no PRNG. Driven step by step over the 50-fixture corpus and the partial fixture, it reproduces every expected result, digest and failure index.

**Example:**

```ts
const v = new BatchAVLVerifier(parentDigest, blockProof, config)
if (v.digest() === null) reject(v.getLastFailReason()) // the proof does not anchor
const r = v.performOneOperation({ tag: 'Lookup', key })
if (!r.success) reject(v.getLastFailReason())          // fatal to the block
// ...further operations, as the state transition asks for them...
if (!bytesEqual(v.digest()!, claimedPostDigest)) reject('post-state mismatch')
```

---

### Neighbor lookups (0.5.0)

```ts
type NeighborLookup =
  | { found: true; value: Uint8Array; nextKey: Uint8Array | null }
  | { found: false; prevKey: Uint8Array | null; nextKey: Uint8Array | null }

type NeighborLookupResult =
  | ({ success: true } & NeighborLookup)
  | { success: false }
```

A neighbor-reporting lookup is a `Lookup` that also reports what the leaf it resolves at already carries.
- A present key reports its value and the next leaf's key.
- An absent key reports the keys of the leaves on either side.

It is TS-only: neither `ergo_avltree_rust` @568e7c3 nor scrypto 3.0.0 has one. Both references expose generic walks — Rust `tree_walk` (`batch_avl_prover.rs:290`), `extract_nodes` / `extract_first_node` (`authenticated_tree_ops.rs:63,67`); scrypto `treeWalk`, `extractNodes`, `extractFirstNode` — but none of them is an authenticated lookup.

- **Where.**
  - Recorded (the verifier consumes the proof, the provers record it): `performLookupWithNeighbors(key)` on `BatchAVLVerifier`, `BatchAVLProver` and `PersistentBatchAVLProver`.
  - Unrecorded: `unauthenticatedLookupWithNeighbors(key)` on the two provers.
- **A `Lookup` by construction.**
  - `BatchAVLProver` and `VerifierCore` (behind `BatchAVLVerifier`) run the recorded neighbor lookup (`performLookupWithNeighbors`) through the same private path as `performOneOperation({ tag: 'Lookup', key })`, and observe the leaf through the engine's single `keyMatchesLeaf` call (`modify.ts:149`), invoked at most once per operation and exactly once for a successful `Lookup`; `deleteHelper` never calls it. `PersistentBatchAVLProver` delegates to `BatchAVLProver`.
  - A recorded neighbor lookup therefore consumes or records exactly a `Lookup`'s direction bits and visits, with the same gates, failures and poisoning.
  - Its proof bytes are byte-identical to a plain `Lookup`'s, and `generateProofForOperations` over plain `Lookup`s yields the same bytes.
  - The shared engine's code is unchanged.
  - A successful lookup that observed any number of leaves other than one throws a plain `Error` (an engine inconsistency; unreachable), and leaves the instance fail-stopped like any engine throw: the prover's proof-cycle mark (P3), the verifier's indeterminate state.
- **Sentinels are `null`.**
  - `nextKey: null` means past the last key (the +inf sentinel); `prevKey: null` means below the first key (the −inf sentinel).
  - The mapping is exact, because no real key can equal a sentinel.
  - The empty tree reports `{ found: false, prevKey: null, nextKey: null }`.
  - Every returned buffer is a fresh copy.
- **Key validation.**
  - Recorded: exactly `performOneOperation`'s. On the prover, the −inf and +inf `'operation-key-out-of-bounds'` gates, then `'operation-key-length-mismatch'`. On the verifier, the key-length throw, and fail-and-poison for a sentinel.
  - Unrecorded: the prover's three gates.
- **The guarantee.**
  - On the verifier, success means the leaf is in the tree the current digest commits to, and one local check passed (`keyMatchesLeaf`, `tree-traversal.ts:115-123`). For an absent key, `leaf.key < key < leaf.nextLeafKey`. For a present key, only `key == leaf.key`: like both references, the verifier does not check `nextLeafKey` on a match, so a present key's `nextKey > key` rests on the digest's provenance, as adjacency does.
  - "No key lies between the reported neighbors" is the tree's sorted-linked-list invariant: each leaf's `nextLeafKey` is its successor's key. The digest commits to that list, and every valid operation preserves it, starting from the empty tree. The verifier cannot re-check the global shape.
  - Both therefore hold for digests with honest provenance, such as consensus-agreed state roots. On a digest of unknown provenance, a range walk must guard its own progress.
- **Range walk.**
  1. Look up the range's lower bound, clamped to `0x00…01`: the all-zero key throws on the prover and poisons the verifier.
  2. Reject any reported `nextKey` that is not strictly greater than the key just looked up; it can occur only on a digest without honest provenance. Look up each `nextKey` while it lies inside the range.
  3. Stop at `nextKey === null`, or at the first key past the range.

  Every step is a `Lookup` in the proof, so the producer and the verifier must issue the same keys in the same order.

**Example:**

```ts
// Every key with tag 0x07, walked on a BatchAVLVerifier. A prover's performLookupWithNeighbors walks the same way, but it reports no fail reason.
// compareBytes: your lexicographic byte comparator (the package does not export one).
const lower = new Uint8Array(65); lower[0] = 0x07        // keyLength 65; 0x07 00…00 (≥ 0x00…01)
const entries: [Uint8Array, Uint8Array][] = []
let r = v.performLookupWithNeighbors(lower)
if (!r.success) reject(v.getLastFailReason())
if (r.found) entries.push([lower, r.value])
let prev: Uint8Array = lower
let next = r.nextKey
while (next !== null) {
  if (compareBytes(next, prev) <= 0) reject('no progress: nextKey is not above the key looked up') // only without honest provenance
  if (next[0] !== 0x07) break                              // the first key past the range
  const step = v.performLookupWithNeighbors(next)
  if (!step.success) reject(v.getLastFailReason())
  if (!step.found) reject('a key reported as next is absent') // cannot happen for a digest with honest provenance
  entries.push([next, step.value])
  prev = next
  next = step.nextKey
}
// next === null: end of tree; otherwise next is the first key past the range. For a digest with honest provenance, nothing was left out.
```

---

### StrictBatchAVLVerifier (0.6.0)

```ts
class StrictBatchAVLVerifier {
  // The constructor and the first four methods are BatchAVLVerifier's, with the same behavior.
  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig)
  performOneOperation(op: Operation): ProverOperationResult
  performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult
  digest(): Uint8Array | null
  getLastFailReason(): AvlVerifyFailReason | null
  // Whether the proof is byte-for-byte the proof a prover writes for the operations performed so far.
  isFullyConsumed(): boolean
}
```

`BatchAVLVerifier` accepts any proof that lets its operations succeed, as both reference implementations do. That includes a proof with bytes appended, and a proof that carries operations the caller never asks. `StrictBatchAVLVerifier` can tell those from the proof a prover actually writes.

**Use it when the network accepts exactly one proof.** If full nodes regenerate each proof from their own execution and refuse any other bytes, a light client must refuse them too. The digest check alone cannot do that: a padded proof replays to the right digest.

**Do not use it on an Ergo path.** This is not Ergo consensus. Ergo's references accept proofs that `isFullyConsumed()` rejects, so a check built on it would reject data Ergo accepts. Use `BatchAVLVerifier` or the batch functions there.

- **Everything `BatchAVLVerifier` does, this class does the same way:** construction and its `AvlVerifyError` codes, poisoning from birth, shape validation per operation, fresh copies of returned values, the first fail reason kept, and the fail-stop after an engine throw. See `BatchAVLVerifier` above.
- **It is not a subtype of `BatchAVLVerifier`.** Both classes have private members, which TypeScript compares nominally. To take either one, type the parameter structurally, for example `Pick<StrictBatchAVLVerifier, 'performLookupWithNeighbors'>`.
- **`isFullyConsumed()`.**
  - `true` when the proof is byte-for-byte the proof `BatchAVLProver.generateProof()` writes for the operations performed so far. Ask after the last operation.
  - `false` once the verifier is poisoned: a proof that failed to decode or anchor, or an operation that failed.
  - After an engine throw it throws a plain `Error`, as `digest()` does.
  - It changes no state. Each call walks the decoded tree once, in time proportional to the proof, so ask once at the end rather than after every operation.
- **What `true` guarantees.** Start from a digest with honest provenance, such as a consensus state root. After a replay in which every operation succeeded, `isFullyConsumed()` is `true` if and only if the proof is byte-for-byte what `BatchAVLProver.generateProof()` (or `generateProofForOperations`) writes after the same operations, in the same order, from that state. Three conditions carry it:
  - the digest's provenance;
  - every operation succeeded (treat `{ success: false }` as fatal, as with `BatchAVLVerifier`);
  - the caller performed the producer's operations, in the producer's order. A recorded neighbor lookup counts as a `Lookup`.
- **What it rejects that `BatchAVLVerifier` accepts:**
  - bytes after the directions;
  - a set bit among the unused high bits of the last direction byte;
  - a node written in full that no operation visited;
  - an operation the proof carries that the caller did not perform.
- **Memory.** It keeps the tree as the proof decoded it, and the set of visited nodes, for its lifetime. Both grow with the proof.

**Example:**

```ts
const v = new StrictBatchAVLVerifier(parentDigest, blockProof, config)
if (v.digest() === null) reject(v.getLastFailReason())      // the proof does not anchor
for (const key of readsInOrder) {
  const r = v.performLookupWithNeighbors(key)
  if (!r.success) reject(v.getLastFailReason())             // fatal to the block
}
for (const op of writesInOrder) {
  if (!v.performOneOperation(op).success) reject(v.getLastFailReason())
}
if (!bytesEqual(v.digest()!, claimedPostDigest)) reject('post-state mismatch')
if (!v.isFullyConsumed()) reject('not the proof a prover writes for these operations')
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
| `UpdateLongBy` | Add `delta` to stored i64 (a sum overflowing i64 fails the operation — JVM `addExact` semantics); result = 0 → delete | Insert `delta` if positive; fail if negative |
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

Checked at the verifier's public entry points before any `VerifierCore` (internal; not exported) state is constructed (the batch functions and `BatchAVLVerifier`'s constructor), per operation on `BatchAVLVerifier`, and at the prover's operations and neighbor lookups (`BatchAVLProver.performOneOperation`, `performLookupWithNeighbors` and `unauthenticatedLookupWithNeighbors`) — `AvlVerifyError` is no longer wrapper-only; the prover throws it directly for the op-shape codes below (its neighbor lookups take only a key, so they throw only `'operation-key-out-of-bounds'` and `'operation-key-length-mismatch'`). These errors indicate bugs in calling code, not malformed proof data.

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
  | 'operation-key-out-of-bounds'
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
| `'operation-key-out-of-bounds'` | `op.key` is at or beyond the ±infinity sentinel (all-`0x00` / all-`0xFF` × `keyLength`) — thrown only by `BatchAVLProver` (`performOneOperation` and the neighbor lookups), never by the verify side — `BatchAVLVerifier` fails and poisons instead |

### Tier 2 — `null` return (verification failures)

Any failure inside the verifier — malformed proof bytes, digest mismatch, operation precondition violation, an op key at or beyond the ±infinity sentinels (all-`0x00` / all-`0xFF` × keyLength; both references reject these at op entry), DoS-bound exceeded — causes `verifyAvlBatch` / `verifyAvlLookup` to return `null`, and a `BatchAVLVerifier` operation to return `{ success: false }` and poison the verifier. No exception is thrown (one engine-level carve-out, below). The distinction allows callers to handle "bad proof from peer" (return `null`) separately from "bad arguments from my own code" (throw).

This guarantee holds on the adversarial path too. A crafted proof that places a non-`Internal` node (a `LABEL` token, or a `LEAF` under a crafted balance byte) where a delete- or insert-path double rotation must descend into a real subtree is rejected with `null`, not an escaping `TypeError`. The `ergo_avltree_rust` reference `panic!`s on these inputs; matching the JVM `BatchAVLVerifier`, which wraps replay in a `Try` and poisons the tree, is a deliberate divergence — see the `double_*_rotate` / `modify_helper` / `delete_helper` rows in `facts/avltree.md`.

One engine-level carve-out remains, narrower than before this package's `0.4.0` line: `modifyHelper` / `deleteHelper`'s per-operation descent (`modify.ts` / `delete.ts`) is independently recursive, so a pathologically deep proof spine combined with an operation that descends deep into it can still overflow the call stack and escape as a `RangeError` ("Maximum call stack size exceeded") — resource exhaustion, not a verification verdict. The digest-check-time carve-out this paragraph used to describe — `label()` recursing once per tree level while computing the constructor's starting-digest comparison — is now CLOSED: `label()`'s Internal arm labels children iteratively (an explicit heap-allocated stack, `labelSubtree`), so a deep spine decodes cleanly and, absent a matching digest, returns an ordinary `null`. Both references share whatever exposure remains on the per-operation path (the Rust reference's own `label` fix was likewise label-only; the JVM's `Try` does not catch `StackOverflowError`, and its script-eval verifier sets no node bound), so no reference-corroborated cap exists to reject such proofs earlier without risking an accept/reject divergence. Callers verifying untrusted proofs can either set `config.maxNumOperations` — reconstruction then enforces a node-count bound before any recursion — or catch `RangeError` at their own boundary. A caught `RangeError` is **indeterminate** — abort or propagate it; never map it to a rejection verdict, which would reintroduce exactly the accept/reject fork this carve-out exists to prevent. Documented by `verifier-adversarial-recursion.test.ts`; detail in `facts/avltree.md`.

Tracked by `VerifierCore.lastFailReason` and exposed through `BatchAVLVerifier.getLastFailReason()` (v0.5.0); the type is exported. `StrictBatchAVLVerifier.getLastFailReason()` (0.6.0) reports the same reasons. The batch functions still return a bare `null`.

Eight reasons are produced somewhere. Three are never produced and stay in the union for stability:
- `'tree-poisoned'`: it is assigned only through `??=`, and every `root = null` site also sets its own reason, so the `??=` never assigns and a poisoned verifier keeps its first reason.
- `'empty-tree'`: it has no assignment site.
- `'operation-required-but-not-allowed'`: reserved.

The reasons (`AvlVerifyFailReason`, returned by `BatchAVLVerifier.getLastFailReason()`):

```ts
type AvlVerifyFailReason =               // exported since v0.5.0
  | 'proof-truncated'                    // OOB read during tree decode
  | 'proof-malformed'                    // invalid token byte, stack underflow, balance byte invalid, leaf value length > 4 MiB or > remaining proof (scrypto PR #117)
  | 'digest-mismatch'                    // reconstructed root.label !== startingDigest[0..32]
  | 'directions-exhausted'               // direction/replay bit read ran past proof.length
  | 'leaf-key-out-of-order'              // key below leaf.key, or unequal to it and not below leaf.nextLeafKey (a key equal to leaf.key is not checked against nextLeafKey)
  | 'max-nodes-exceeded'                 // node count crossed the KMZ17 DoS bound
  | 'operation-precondition-failed'      // updateFn rejected (Insert on existing, Update on absent, etc.)
  | 'key-out-of-bounds'                  // op key not STRICTLY inside the ±inf sentinels (0x00×kl / 0xFF×kl) — 6g
  | 'tree-poisoned'                      // never produced: a poisoned verifier keeps its first reason
  | 'empty-tree'                         // never produced: no assignment site
  | 'operation-required-but-not-allowed' // reserved for ABI stability (currently unreachable)
```

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
  } else if (e instanceof RangeError) {
    // Deep proof + deep operation descent exhausted the stack: INDETERMINATE.
    // Abort or propagate — never record as "proof invalid". (The
    // construction-time digest-check recursion this used to also cover is
    // closed as of this package's 0.4.0 line — see "No throws on
    // verification failures" in facts/avltree.md.)
    // A BatchAVLVerifier that threw this is unusable afterwards: discard it.
  }
  throw e; // rethrow either way — neither is a verification verdict
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
  performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult
  unauthenticatedLookupWithNeighbors(key: Uint8Array): NeighborLookup
  digest(): Uint8Array
  generateProofForOperations(operations: Operation[]):
    { success: true; proof: Uint8Array; digest: Uint8Array } | { success: false }
  restoreRoot(root: AvlNode, height: number): void
}
```

In-memory AVL+ tree prover. Ports `ergo_avltree_rust/src/batch_avl_prover.rs`.

**Constructor:** `new BatchAVLProver(keyLength, valueLengthOpt)` creates an empty tree holding one −inf sentinel leaf, whose `nextLeafKey` is the +inf key. `keyLength` must be > 0. `valueLengthOpt` is `null` for variable-length values or a positive integer for fixed-length.

**`performOneOperation(op)`** — applies a single operation to the tree, recording traversal directions for proof generation. Returns:
- `{ success: true, value }` — operation succeeded. `value` is the old value at the key (`Uint8Array`) or `null` if the key was absent.
- `{ success: false }` — operation precondition failed (e.g., `Insert` on an existing key, `Update` on an absent key).

Throws `AvlVerifyError` on programmer errors (key length mismatch, out-of-bounds key, value length mismatch with fixed config, `UpdateLongBy.delta` outside signed i64 range).

Checks run in reference order — −inf, then +inf, then key length — and must not be reordered. Because byte comparison length-tiebreaks, a *short all-zero* key fires the −inf gate (`operation-key-out-of-bounds`) before the length check ever runs, while a short non-zero key falls through to the length gate (`operation-key-length-mismatch`) — the same caller mistake (a too-short key) surfaces under two different codes depending on the key's byte content.

An internal node without a key on the operation's descent throws a plain `Error`, after a key match too. The reference reads the key only while still comparing (`batch_avl_prover.rs:441-444` @568e7c3), so this is a deliberate widening, as in `removedNodes()`' descent; both are reachable only through an invariant-violating `restoreRoot` tree.

**`generateProof()`** — serializes a proof covering all operations since the last call (or since construction). Returns a `Uint8Array` in the packed proof format. Resets direction tracking after generation; subsequent operations start a fresh cycle.

**`unauthenticatedLookup(key)`** — walks the tree without recording state. Returns the value at `key`, or `null` if absent. Does not affect proof generation.

- **`performLookupWithNeighbors(key)`** (v0.5.0) — a recorded `Lookup` that also reports its neighbors (see "Neighbor lookups"). It runs through exactly `performOneOperation`'s path:
  - the same key gates and throws;
  - the same direction bits and visits;
  - `{ success: false }` exactly when `performOneOperation` would.
- **`unauthenticatedLookupWithNeighbors(key)`** (v0.5.0) — the same report, unrecorded.
  - It writes no prover state (no directions, no visits, no proof-cycle effect) and reads only the root.
  - It validates the key with `performOneOperation`'s three gates, in the same order and with the same codes. `unauthenticatedLookup` validates nothing and returns `null` instead.
  - A label stub, or an internal node without a key, on its walk throws a plain `Error`. Either is an invariant violation, reachable only via `restoreRoot`.
- **No inherited `found` (v0.5.0, P2).**
  - Each operation starts its descent with the prover's `found` flag cleared. The reference clears it only inside `key_matches_leaf` (`batch_avl_prover.rs:486-493` @568e7c3).
  - Otherwise an operation that fails or throws after an equality step leaves the flag set, and the next operation descends all-left to the wrong leaf. The triggers are a label stub or a key-less internal node on its found-mode path, or a `RangeError` after the equality step.
  - A deliberate divergence, observable only on invariant-violating trees installed with `restoreRoot`.
- **Proof-cycle fail-stop (v0.5.0, P3).**
  - A mark is set around each operation's engine run, after the shape gates; an `AvlVerifyError` never sets it. Both normal returns clear it, success and `{ success: false }`.
  - Any engine throw leaves it set, for example a key-less internal node, a `RangeError`, the delete-pass invariant throw, or `applyHeightDelta`'s engine-inconsistency throw. Such a throw leaves the aborted operation's direction bits (partial after a mid-descent throw) and, for a throw after the modify pass (the delete pass, or `applyHeightDelta`), its recorded visits too, that the next proof would encode. `performLookupWithNeighbors` also sets it when a successful run observed other than one leaf, an engine inconsistency found after the engine returned.
  - While the mark is set, `performOneOperation`, `performLookupWithNeighbors`, `generateProof()` and `removedNodes()` throw a plain `Error`: the proof cycle is indeterminate; call `restoreRoot()` or discard the prover.
  - `restoreRoot()` clears the mark.
  - The engine run assigns root and height only after computing the new height. `applyHeightDelta` can throw on an engine inconsistency, and an engine throw must never half-commit an operation.
  - Root-only reads keep working, since the root is still the pre-operation state: `digest()`, both unauthenticated lookups, `generateProofForOperations` and the getters.

**`digest()`** — returns the current 33-byte digest (32-byte root label + 1-byte height). The return type is `Uint8Array` — not `Uint8Array | null` — because a prover built through this API always has a root: the constructor's direct assignment gives TypeScript definite-assignment proof, and no reachable code path un-sets it afterward. This is a deliberate prover-side tightening, not a divergence from the reference: Rust's `digest()` returns `Option` only because prover and verifier share one `AVLTree` struct there; ergots splits them into separate classes, so the non-null prover type is the behavior-faithful shape. The **verifier's** digest stays nullable — poisoning on failure is real on that side.

Throws `RangeError` in three cases:
- the root has been forced to `null` by a type-unsafe caller (e.g. `prover.root = null as any`) — this needs a direct cast on the `root` field itself, since `restoreRoot`'s `root` parameter is typed non-nullable and cannot carry `null` without its own cast; it fails as a named invariant error rather than letting a bare `TypeError` leak out of the internal `label()` call;
- the tree height is outside `0..=255` — reachable via a `restoreRoot`-installed height, since the parameter is a plain `number` with no range check at the type level;
- the root is a `LabelNode` whose stored digest is not exactly 32 bytes — reachable via a hand-built `LabelNode` object literal or one installed through `restoreRoot`, since the `label` field is a plain `Uint8Array` with no length captured in its type.

All three are unreachable through this API's own operations alone. The height and label-length cases are additionally unreachable through *normal* use even via `restoreRoot` — the height bound needs more leaves than there are atoms on Earth, and `newLabel` enforces the digest length elsewhere in the package — but emitting a plausible-but-wrong 33-byte digest (height masked with `& 0xff`, or a short label zero-padded into the slot) would be a consensus fault, so all three cases fail loudly instead of returning a corrupted result.

**`generateProofForOperations(operations)`** — clones the tree and applies all operations on the clone; the original tree is NOT mutated. Failure model is two-tier: shape-invalid ops (±inf key, wrong key/value length, out-of-range delta) **throw** `AvlVerifyError`, propagated from `performOneOperation`; engine-level op failure (e.g. `Insert` on an existing key) returns `{ success: false }`. On success, returns `{ success: true, proof, digest }`. This is the primary entry point for producing proofs verifiable by `verifyAvlBatch`.

- **Step-by-step equivalence.** Starting from a proof-cycle boundary, over operations that all succeed, `performOneOperation` × N followed by `generateProof()` produces the same bytes and digest as `generateProofForOperations` over the same list.
  - `generateProofForOperations` clones the *current* root and bails at the first failure.
  - `generateProof()` covers everything since the last cycle boundary.
  - The step route skips a failed operation.

**`restoreRoot(root, height)`** — installs a storage-loaded root and height, then rebases the proof cycle: clears modified-node bookkeeping and accumulated directions, and sets `oldTopNode` to the restored root. Call this after loading a tree from storage — startup resume, snapshot bootstrap, or recovery rollback — before performing further operations or generating a proof; without it, `oldTopNode` is left at its stale in-memory value and `generateProof()` produces incorrect proofs. Since 0.5.0 it also clears the proof-cycle fail-stop mark.

**`removedNodes()`** — returns `AvlNode[]`: the nodes of the previous cycle's tree (leaves and internals) whose labels are no longer reachable from the current root. This is exactly the set difference {nodes reachable from the previous cycle's root} − {nodes whose label is reachable from the current root} — the rows a `VersionedAVLStorage` backend should delete.

- **Ordering:** call after the batch's operations and BEFORE `generateProof()` / `restoreRoot()` — both rebase the proof cycle, after which this returns `[]` (same observable as the reference's cleared buffers). Calling from inside `VersionedAVLStorage.update()` is correct by construction: `PersistentBatchAVLProver.generateProofAndUpdateStorage` runs `update` before `generateProof`.
- **Purity:** pure and idempotent — mid-batch calls are allowed, return the diff as of the current tree, and do not perturb later calls. The order of returned nodes is unspecified; treat the result as a set.
- **Live nodes — do not mutate:** the returned nodes are the prover's own tree objects, not copies. Derive storage keys via the exported `label()` function rather than reading a node field directly.
- **First-cycle sentinel:** the never-persisted sentinel leaf of a freshly constructed prover is reported as removed on the first mutating cycle (reference parity). Storage backends must tolerate deleting rows that were never written.
- **Throws:** a plain `Error` (not `AvlVerifyError`) on a key-less candidate or descent node — reachable only via an invariant-violating `restoreRoot` tree; see `facts/avltree.md`'s invariant-throws bullet.
- **Proof-cycle fail-stop (v0.5.0, P3):** throws a plain `Error` while the
  proof cycle is indeterminate, that is, after an operation's engine run threw
  and left the fail-stop mark set. `restoreRoot()` clears the mark. See the
  `BatchAVLProver` bullet "Proof-cycle fail-stop" above.

See `facts/avltree.md`'s `removedNodes()` divergence table for the deliberate differences from `ergo_avltree_rust`'s `removed_nodes`.

`performOneOperation`'s `value` and `unauthenticatedLookup`'s return are defensive copies — mutating them cannot affect the tree. The verifier's returned buffers (`results`, `newDigest`) follow the same rule: they alias only the verifier's internal reconstruction, which is unreachable after the call returns. `BatchAVLVerifier` and `StrictBatchAVLVerifier`, whose trees outlive each call, return fresh copies of values, neighbor keys and digests (0.5.0, 0.6.0). One uniform contract across every *method return* in the package: the buffer you get back from a call is yours. Node **fields** reached via the public `root` / `oldTopNode` are the exception, not the rule — see "Do not mutate nodes" below, which documents the opposite for those.

**Example:**

```ts
const prover = new BatchAVLProver(32, null)
prover.performOneOperation({ tag: 'Insert', key: myKey, value: myValue })
const proof = prover.generateProof()
const digest = prover.digest()

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
  performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult
  unauthenticatedLookupWithNeighbors(key: Uint8Array): NeighborLookup
  digest(): Uint8Array
  height(): number
  generateProofAndUpdateStorage(additionalData: [Uint8Array, Uint8Array][]): Uint8Array
  rollback(version: Uint8Array): void
}
```

Wraps a `BatchAVLProver` with a `VersionedAVLStorage` backend. Ports `ergo_avltree_rust/src/persistent_batch_avl_prover.rs`.

On construction, either rolls back to the stored version (if one exists) or generates an initial proof and writes the new version to storage. All tree-modifying ops are delegated to the inner `BatchAVLProver`; the storage layer is synced on each `generateProofAndUpdateStorage` call.

**`performOneOperation`, `unauthenticatedLookup`, `performLookupWithNeighbors`, `unauthenticatedLookupWithNeighbors`, `digest`** — delegated to the inner `BatchAVLProver`. `rollback` routes through `restoreRoot`, so it also clears the proof-cycle fail-stop.

**`height()`** — returns the current tree height.

**`generateProofAndUpdateStorage(additionalData)`** — commits the current state to storage, then generates and returns a proof. `additionalData` is key-value pairs to store alongside the tree state (e.g., metadata). While the fail-stop mark is set, `generateProofAndUpdateStorage` throws, but it runs `storage.update` first and the inner `generateProof()` second, so whether the exception arrives before the backend writes depends on the backend: an `update` that calls `removedNodes()` before writing throws before any write, while one that writes first, or never calls it, has already written when the exception arrives (from `removedNodes()` inside `update`, or from `generateProof()` after `update` returns). After such a throw, call `rollback(version)` to a known-good version rather than trust storage.

**`rollback(version)`** — restores the prover's tree to a previously stored version.

---

### `VersionedAVLStorage`

```ts
interface VersionedAVLStorage {
  update(prover: BatchAVLProver, additionalData: [Uint8Array, Uint8Array][]): void
  rollback(version: Uint8Array): [AvlNode, number]
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

Return type of `BatchAVLProver.performOneOperation`, (0.5.0) `BatchAVLVerifier.performOneOperation` and (0.6.0) `StrictBatchAVLVerifier.performOneOperation` — one type, so one interface can drive either side (see "One interface, two asymmetries" under `BatchAVLVerifier`). On success, `value` is the old value at the key (or `null` if absent). On failure the prover reports no reason; on a `BatchAVLVerifier`, `getLastFailReason()` says which check failed.

---

## Node types and constructors

```ts
type AvlNode = LeafNode | InternalNode | LabelNode

interface LeafNode {
  readonly kind: 'leaf'
  readonly key: Uint8Array
  readonly value: Uint8Array
  readonly nextLeafKey: Uint8Array
  labelCache: Uint8Array | null
}

interface InternalNode {
  readonly kind: 'internal'
  readonly key?: Uint8Array
  readonly left: AvlNode
  readonly right: AvlNode
  readonly balance: Balance
  labelCache: Uint8Array | null
}

interface LabelNode {
  readonly kind: 'label'
  readonly label: Uint8Array
}

type Balance = -1 | 0 | 1

function newLeaf(key: Uint8Array, value: Uint8Array, nextLeafKey: Uint8Array): LeafNode
function newInternal(left: AvlNode, right: AvlNode, balance: Balance, key?: Uint8Array): InternalNode
function newLabel(label: Uint8Array): LabelNode
function label(node: AvlNode): Uint8Array
```

Ported from `ergo_avltree_rust`'s `batch_node.rs::Node` enum plus the `LeafNode`/`InternalNode`/`LabelOnly` structs and `Node::label()`. Exported so `VersionedAVLStorage` implementers and other storage-backend consumers can walk and rebuild trees without depending on package internals.

### `AvlNode`

A discriminated union on `kind`. `LeafNode` holds a real key/value/next-leaf-key triple. `InternalNode` holds `left`/`right` children (each an `AvlNode`) and an AVL `balance`. `LabelNode` is a stub carrying only a 32-byte digest — it stands in for a subtree the holder doesn't have full data for (e.g. a proof-decoded sibling, or one of a `deserializeNode`d internal node's children; see "Storage codec" below).

`InternalNode.key` is optional: the shared prover/verifier engine (`modify.ts`/`delete.ts`) sets it on every `newInternal` call it makes, but proof decoding reconstructs verifier-only internal nodes without one. All data fields on all three node kinds are `readonly`; `labelCache` is the sole mutable field (a lazy memo). `readonly` prevents *reassignment* (`node.left = otherNode` is a compile error) — it does not make the underlying buffer immutable (`node.key[0] = 0xff` still type-checks): the aliasing hole that would otherwise open is closed by the defensive copies described above (`newLeaf` / `newInternal` / `newLabel`), not by `readonly` itself.

`LeafNode`'s fields `key`, `value`, `nextLeafKey`, and `kind` are all `readonly`; only `labelCache` is mutable.

**Do not mutate nodes.** Every node this package returns is treated as immutable: the prover and verifier build new nodes via `newLeaf` / `newInternal` / `newLabel` rather than editing existing ones, and each node memoises its own label on first use. `labelCache` is the single sanctioned in-place write — a memo of a pure function of otherwise-immutable fields. Mutating a node's byte fields in place (e.g. writing through a `key`, `value`, or child `label` array obtained from a node) invalidates the cached label on every ancestor and silently corrupts subsequent digests and proofs — `readonly` narrows this risk (it blocks reassigning `left` / `right` / `balance` / `key` outright) but does not eliminate it, since it only stops rebinding a property, not mutating the array already stored there. To change a tree, use the prover's operations; to build one from storage, use the constructors.

### `Balance`

The literal union `-1 | 0 | 1`. Rust's equivalent (`batch_node.rs`'s `pub type Balance = i8`) is an unchecked `i8` — see "Deliberate divergences from the reference" in `facts/avltree.md`'s Storage codec section for why the TS type is narrower and why both encode and decode check it (encode additionally requires an integer, since a hand-built value can be `NaN` or fractional in a way an `i8` cannot).

### `newLeaf(key, value, nextLeafKey)`

Constructs a `LeafNode`. Defensively copies all three byte arguments so caller-side mutation can't corrupt the node or invalidate an already-computed label.

### `newInternal(left, right, balance, key?)`

Constructs an `InternalNode`. `key` is optional (see `AvlNode` above) and, when given, defensively copied (0.5.0); `left`/`right` are stored by reference, not defensively copied.

**Upgrade note (P1).** Before 0.5.0, a caller that reused a key buffer after an `Insert` silently rewrote an internal node's key. Internal keys are not hashed, so digests cannot show it. Trees persisted through `serializeNode` from such a prover keep the wrong keys, and 0.5.0 does not repair them.

### `newLabel(label)`

Constructs a `LabelNode`. Defensively copies `label`. **Throws `RangeError`** if `label.length !== 32` — a `LabelNode`'s digest must always be exactly 32 bytes.

### `label(node)`

Returns the node's 32-byte blake2b-256 digest.

- `LabelNode` returns its stored digest directly (via a defensive copy).
- `LeafNode` computes `blake2b256(0x00 || key || value || nextLeafKey)`.
- `InternalNode` computes `blake2b256(0x01 || balance || label(left) || label(right))` — balance precedes the child labels.

Both computed cases **memoise the result into `labelCache`** and return a defensive copy — the cache itself is never handed out directly, so callers cannot corrupt it by mutating the returned array. A cache hit skips recomputation and still returns a fresh copy each call.

---

## Storage codec

```ts
serializeNode(node: AvlNode, config: AvlTreeConfig): Uint8Array
deserializeNode(bytes: Uint8Array, config: AvlTreeConfig): AvlNode
```

Encodes a single AVL+ node for persistence, byte-identical to
`ergo_avltree_rust`'s `AVLTree::pack` / `unpack` for well-formed input — four of
the throw conditions below (on encode: a key-length mismatch, an undersized
child label, and an invalid balance; on decode: an out-of-range balance byte)
are deliberately stricter than the reference, which performs none of them; see
`facts/avltree.md`'s "Deliberate divergences from the reference" for why.
Traversal is the caller's responsibility: a storage backend walks the tree and
stores one record per node, keyed by `label(node)`.

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
`serializeNode`; a key or fixed-length value whose length disagrees with
`config`; a child label that isn't exactly 32 bytes; an encode-side balance
that isn't an integer in `-1 | 0 | 1`; truncated input; an unknown leading
tag; a decoded balance byte outside `-1 | 0 | 1`.

The format is not self-describing — lengths come from `config`, so a
writer/reader mismatch is not generally detectable.

### Example

Both directions: writing a tree to storage, and loading it back with child
stubs relinked by label lookup.

```ts
import {
  serializeNode, deserializeNode, newInternal, label,
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
  // Build a fresh node via newInternal rather than mutating node.left /
  // node.right in place — those fields are readonly.
  const left = node.left.kind === 'label' ? load(node.left.label, read) : node.left
  const right = node.right.kind === 'label' ? load(node.right.label, read) : node.right
  return newInternal(left, right, node.balance, node.key)
}
```

Once a root is loaded this way, call `BatchAVLProver.restoreRoot(root, height)`
(above) before performing further operations or generating a proof — it
rebases the prover's proof cycle onto the loaded root.

---

## Conventions

- **All byte sequences are `Uint8Array`.** The package never creates a `Buffer`; a Node `Buffer` passed in is accepted (it is a `Uint8Array`). The constructors and operations copy the caller buffers they keep with `new Uint8Array(...)` — never `.slice()`, which is a view on a `Buffer` — so reusing such a buffer after a call is safe. `restoreRoot` is the exception: it keeps the caller's node objects, and their buffers, by reference.
- **`keyLength`, `valueLengthOpt`, heights, and counts are `number`.** JS `Number` is safe up to 2^53; all values here fit comfortably.
- **`bigint` for `UpdateLongBy.delta`.** Represents a signed 64-bit integer (i64 equivalent).
- **No async surface.** Every function is synchronous. Blake2b-256 runs in tight inner loops; an async boundary would only add overhead.
- **No I/O, no globals.** Pure functions: no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output.
- **Throws on programmer errors, returns `null` on verification failures.** `AvlVerifyError` codes are for programmatic dispatch on bugs in calling code. Malformed proofs never throw — with one narrowed carve-out: engine stack exhaustion on a pathologically deep proof, via per-operation tree descent, can still escape as `RangeError` (see "Tier 2 — `null` return"). The construction-time digest-check recursion this carve-out used to also cover is closed as of this package's `0.4.0` line.
- **Deterministic.** `newDigest` is byte-identical to what `ergo_avltree_rust`'s `BatchAVLVerifier` produces on the same inputs. Every fixture in the test corpus asserts this.

---

## See also

- `facts/avltree.md` (repo root) — load-bearing interface contract referenced by downstream packages
- `docs/specs/2026-05-18-ergots-avltree-package-design.md` — design rationale, validation strategy, error model detail
- `facts/ergoscript-eval.md` — upstream consumer: `SAvlTree.*` method handlers in `@ergots/ergoscript` phase 2h-b
- [KMZ16 paper](https://eprint.iacr.org/2016/994) — AVL+ authenticated dictionary
- [`ergo_avltree_rust`](https://github.com/ergoplatform/ergo_avltree_rust) — reference Rust implementation (pin `568e7c3`)
