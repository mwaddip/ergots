# `@ergots/avltree` — Interface Contract

The boundary contract for the AVL+ batch authenticated-tree verifier package. This package is independently useful to any consumer wanting AVL+ proof verification without parsing or evaluating a full ErgoTree — wallets, DEX simulators, and light clients verifying state transitions. It is also a runtime dependency of `@ergots/ergoscript`, which calls into this package from its eleven `SAvlTree.*` method handlers. The narrative rationale and validation strategy live in `docs/specs/2026-05-18-ergots-avltree-package-design.md`; this file is *only* the interface.

Authoritative algorithmic reference: `~/projects/ergo_avltree_rust/` HEAD `2941396` (branch `main`, including upstream PRs #10/#11/#13). Where this file is silent on implementation detail, the Rust source is canonical.

## Scope

**Ships in this contract (v0.4.0):**

1. `verifyAvlBatch` — verify an authenticated batch of AVL+ operations against a serialized AD proof and return the resulting digest plus per-operation old values. All-or-nothing: any per-op failure collapses to `null`. Thin wrapper over `verifyAvlBatchPartial`.
2. `verifyAvlBatchPartial` — partial-success variant. On per-op failure, returns `{ newDigest, results, opsCompleted }` reflecting state AFTER the last successful op. Backs `@ergots/ergoscript`'s V3+ `SAvlTree.insert/update` semantics (break-on-failure with state-after-last-success).
3. `verifyAvlLookup` — thin convenience wrapper over `verifyAvlBatch` for single-key reads.
4. All 8 `Operation` variants: `Lookup`, `UnknownModification`, `Insert`, `Update`, `InsertOrUpdate`, `UpdateLongBy`, `Remove`, `RemoveIfExists`.
5. `AvlTreeConfig` — verifier-input shape (key length, optional fixed value length, optional DoS bounds).
6. `AvlVerifyError` — programmer-error rejection class with 7 typed codes.
7. `BatchAVLProver` — in-memory AVL+ tree prover. Builds a tree from authenticated operations, records traversal directions, and generates serialized AD proofs suitable for verification by `verifyAvlBatch`.
8. `PersistentBatchAVLProver` — wraps a `BatchAVLProver` with versioned storage, enabling rollback across proof-generation cycles.
9. `VersionedAVLStorage` — interface for persistent AVL+ tree storage. No concrete implementation ships; consumers provide their own.
10. Node types and constructors — `AvlNode`, `LeafNode`, `InternalNode`, `LabelNode`, `Balance`, `newLeaf`, `newInternal`, `newLabel`, `label`. Exported so `VersionedAVLStorage` implementers can walk and rebuild trees without depending on package internals.
11. `serializeNode` / `deserializeNode` — per-node storage codec, byte-identical to `ergo_avltree_rust`'s `AVLTree::pack` / `AVLTree::unpack`. Consumer-owned traversal: the codec handles one node, the storage backend walks the tree.
12. `BatchAVLProver.restoreRoot(root, height)` — installs a storage-loaded root and rebases the proof cycle (clears directions and modified-node bookkeeping, resets `oldTopNode`). Required after startup resume, snapshot bootstrap, or recovery rollback.
13. Browser-runnable: no Node built-ins, no `Buffer`, no `node:crypto`. ESM only.

**Does NOT ship:**

- Direct exposure of the internal stateful `BatchAvlVerifier` class on v0.4.0. The class is designed with clean inspectable state; promoting it to public surface later is a one-line export change.
- `AvlTreeData` wire-format MIR type. That stays in `@ergots/ergoscript`'s `mir/types.ts`; this package owns only the verifier-input shape `AvlTreeConfig`.
- Cost accounting. Cost is an ergoscript concern, charged by the `SAvlTree.*` handlers.

## Public surface (v0.4.0)

### Primary export: `@ergots/avltree`

```ts
verifyAvlBatch(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchResult | null

verifyAvlBatchPartial(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): VerifyAvlBatchPartialResult | null

verifyAvlLookup(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  key: Uint8Array,
): { value: Uint8Array | null } | null
```

#### `verifyAvlBatch(startingDigest, proof, config, operations)`

- **Precondition (throws `AvlVerifyError`):** `config.keyLength > 0`; `config.valueLengthOpt >= 0` or `null`; `config.maxNumOperations >= 0` if set; `config.maxDeletes <= config.maxNumOperations` if both set; `startingDigest.length === 33`; for every op, `op.key.length === config.keyLength`; for every op with a `value` field, `op.value.length === config.valueLengthOpt` when `valueLengthOpt` is not null.
- **Postcondition (success):** Returns `{ newDigest: Uint8Array, results: (Uint8Array | null)[] }` where `newDigest` is exactly 33 bytes (32-byte blake2b-256 root label + 1-byte tree height), `results[i]` is the old value at `op.key` before operation `i` (or `null` when the key was absent before the operation), and `newDigest` is byte-identical to what `ergo_avltree_rust`'s `BatchAVLVerifier` would produce on the same inputs.
- **Postcondition (failure):** Returns `null` on any verification failure: malformed proof, digest mismatch, precondition violation by an operation, or structural inconsistency. All-or-nothing — any per-op failure collapses the whole batch to `null` even if earlier ops succeeded.
- **Invariant:** Stateless. No I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output. Implemented as a thin wrapper over `verifyAvlBatchPartial`: returns the partial result on full success, `null` on construct failure OR when `opsCompleted < operations.length`.

#### `verifyAvlBatchPartial(startingDigest, proof, config, operations)`

- **Precondition (throws `AvlVerifyError`):** Same shape validation as `verifyAvlBatch`.
- **Postcondition (success):** Returns `{ newDigest: Uint8Array, results: (Uint8Array | null)[], opsCompleted: number }` where `newDigest` reflects the AVL+ state after the **last successful operation** (`opsCompleted === operations.length` on full success; less on partial), `results.length === opsCompleted`, and each `results[i]` is the old value at `op[i].key` before that op (or `null` when absent). On full success, `newDigest` is byte-identical to what `verifyAvlBatch` returns.
- **Postcondition (partial success):** When op `i` (0-indexed) fails, iteration stops immediately. Returns `{ newDigest, results, opsCompleted: i }` where `newDigest` is the digest snapshot taken BEFORE op `i` (i.e., state after op `i-1`, or `startingDigest` when `i === 0`).
- **Postcondition (failure):** Returns `null` only when the verifier itself fails to anchor (proof decode failure or digest mismatch during construction). In that case there is no partial state to report.
- **Why a pre-op snapshot:** sigma-rust's `BatchAVLVerifier` (and the TS port) poisons `root = null` on op failure; `digest()` then returns `null`. Snapshotting `digest()` before each op is the only way to recover the pre-failure state.
- **Invariant:** Stateless, deterministic; same inputs → same output.

#### `verifyAvlLookup(startingDigest, proof, config, key)`

- **Precondition (throws):** Same shape validation as `verifyAvlBatch` for a single `Lookup` operation.
- **Postcondition (success):** Returns `{ value: Uint8Array }` if the key was present in the tree, `{ value: null }` if absent.
- **Postcondition (failure):** Returns `null` when the proof itself failed verification.
- **Note:** The outer `null` (proof failed) is distinct from `{ value: null }` (proof passed; key absent). Callers must check for both.

#### Type definitions

```ts
export interface AvlTreeConfig {
  /** Bytes per key. Must be > 0. */
  keyLength: number
  /** Bytes per value; null = variable length per leaf. */
  valueLengthOpt: number | null
  /** Optional DoS guard — max operations across this batch. */
  maxNumOperations?: number
  /** Max deletions across this batch. Defaults to maxNumOperations when both set. */
  maxDeletes?: number
}

export type Operation =
  | { tag: 'Lookup'; key: Uint8Array }
  | { tag: 'UnknownModification'; key: Uint8Array }
  | { tag: 'Insert'; key: Uint8Array; value: Uint8Array }
  | { tag: 'Update'; key: Uint8Array; value: Uint8Array }
  | { tag: 'InsertOrUpdate'; key: Uint8Array; value: Uint8Array }
  | { tag: 'UpdateLongBy'; key: Uint8Array; delta: bigint }
  | { tag: 'Remove'; key: Uint8Array }
  | { tag: 'RemoveIfExists'; key: Uint8Array }

export interface VerifyAvlBatchResult {
  readonly newDigest: Uint8Array        // 33 bytes
  readonly results: (Uint8Array | null)[]
}

export interface VerifyAvlBatchPartialResult {
  readonly newDigest: Uint8Array        // 33 bytes (state after last successful op)
  readonly results: (Uint8Array | null)[]  // length === opsCompleted
  readonly opsCompleted: number         // count of successful ops; === operations.length on full success
}

// Documentation-only type aliases (all are Uint8Array at runtime).
export type ADKey    = Uint8Array
export type ADValue  = Uint8Array

/** Per-operation result. Returned in VerifyAvlBatchResult.results. */
export type OperationResult = Uint8Array | null  // null = key was absent before op
```

## Prover surface (v0.4.0)

```ts
class BatchAVLProver {
  constructor(keyLength: number, valueLengthOpt: number | null)
  performOneOperation(op: Operation): ProverOperationResult
  generateProof(): Uint8Array
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null
  digest(): Uint8Array | null
  generateProofForOperations(operations: Operation[]): { proof: Uint8Array; digest: Uint8Array } | { success: false }
  restoreRoot(root: AvlNode, height: number): void
}

class PersistentBatchAVLProver {
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

interface VersionedAVLStorage {
  update(prover: BatchAVLProver, additionalData: [Uint8Array, Uint8Array][]): void
  rollback(version: Uint8Array): [root: unknown, height: number]
  version(): Uint8Array | null
  rollbackVersions(): Uint8Array[]
  flush(): void
}

type ProverOperationResult =
  | { success: true; value: Uint8Array | null }
  | { success: false }
```

#### `BatchAVLProver`

- **`new BatchAVLProver(keyLength, valueLengthOpt)`** — constructs an empty AVL+ tree seeded with -inf/+inf sentinel leaves. `keyLength` must be > 0; `valueLengthOpt` is `null` for variable-length values or a positive integer for fixed-length.
- **`performOneOperation(op)`** — applies a single operation (Insert, Update, Remove, etc.) to the in-memory tree, recording traversal directions for proof generation. Returns `{ success: true, value }` on success (`value` is the old value or `null` if the key was absent) or `{ success: false }` on precondition failure.
- **`generateProof()`** — serializes the proof covering all operations since the last call to `generateProof()` (or since construction). Uses the same packed proof format as `ergo_avltree_rust`'s `BatchAVLProver`. Resets direction-tracking state after generation.
- **`unauthenticatedLookup(key)`** — walks the tree without modifying it. Returns the value at `key`, or `null` if absent. Does not record directions or touch modified-nodes tracking.
- **`digest()`** — returns the current 33-byte digest (32-byte root label + 1-byte height), or `null` if the tree is poisoned (`root === null`).
- **`generateProofForOperations(operations)`** — clones the current tree, applies the given operations on the clone, and returns `{ proof, digest }`. Returns `{ success: false }` if any operation fails. The original tree is NOT mutated. This is the primary entry point for producing proofs that will be verified by `verifyAvlBatch`.
- **`restoreRoot(root, height)`** — installs a storage-loaded root and rebases the proof cycle: clears modified-node bookkeeping and accumulated directions, sets `oldTopNode` to the restored root, and suppresses the next cycle reset. Required after startup resume, snapshot bootstrap, or recovery rollback. Ports `restore_root` from the reference.

#### `PersistentBatchAVLProver`

Wraps a `BatchAVLProver` with a `VersionedAVLStorage` implementation. On construction, it either rolls back to the stored version (if one exists) or generates an initial proof and writes the new version to storage. All tree-modifying operations are delegated to the inner `BatchAVLProver`; the storage layer is updated on each `generateProofAndUpdateStorage` call.

#### `VersionedAVLStorage`

Interface for persistent tree storage. Consumers implement this for their storage backend (in-memory, redb, SQLite, etc.). The `update` method is called after operations are applied but before proof generation; `rollback` restores the tree to a prior version. No concrete implementation ships with the package.

## Failure model overview

The package enforces a strict two-tier failure model:

**Tier 1 — `AvlVerifyError` thrown (7 codes; programmer errors only)**

Checked at the public entry point before any `BatchAvlVerifier` state is constructed. These indicate bugs in calling code, not in the proof data.

```ts
export class AvlVerifyError extends Error {
  readonly code: AvlVerifyErrorCode
}

export type AvlVerifyErrorCode =
  | 'invalid-config-key-length'          // config.keyLength <= 0
  | 'invalid-config-value-length'        // config.valueLengthOpt < 0 when set
  | 'invalid-config-max-ops'             // maxNumOperations < 0, or maxDeletes > maxNumOperations
  | 'invalid-starting-digest-length'     // startingDigest.length !== 33
  | 'operation-key-length-mismatch'      // op.key.length !== config.keyLength
  | 'operation-value-length-mismatch'    // op.value.length !== config.valueLengthOpt when fixed
  | 'operation-delta-out-of-range'       // UpdateLongBy.delta outside signed i64 range (verify.ts:295-298)
```

**Tier 2 — `AvlVerifyFailReason` internal taxonomy (10 reasons; not public on v0.4.0)**

Tracked by `BatchAvlVerifier.lastFailReason`. Not exposed in the public API on v0.4.0; promoted to a `getLastFailReason()` accessor when the internal class is exposed (the design spec explains why it stays internal).

```ts
type AvlVerifyFailReason =               // (internal; not exported)
  | 'proof-truncated'                    // OOB read during tree decode
  | 'proof-malformed'                    // invalid token byte, stack underflow, balance byte invalid, leaf value length > 4 MiB or > remaining proof (scrypto PR #117)
  | 'digest-mismatch'                    // reconstructed root.label !== startingDigest[0..32]
  | 'directions-exhausted'               // direction/replay bit read ran past proof.length
  | 'leaf-key-out-of-order'              // key not in [leaf.key, leaf.nextLeafKey)
  | 'max-nodes-exceeded'                 // node count crossed the KMZ17 DoS bound
  | 'operation-precondition-failed'      // updateFn rejected (Insert on existing, Update on absent, etc.)
  | 'tree-poisoned'                      // performOneOperation called after a prior failure
  | 'empty-tree'                         // performOneOperation called on tree with null root
  | 'operation-required-but-not-allowed' // reserved for ABI stability (currently unreachable)
```

**Invariants on the boundary:**

1. Shape validation is sole and comprehensive at the public entry point. After construction, `BatchAvlVerifier` trusts shapes and operates on bytes.
2. No throws from inside `BatchAvlVerifier` to the consumer. Verification failures set `root = null` (tree poisoned) and `performOneOperation` returns `{ failed: true }` on this and every subsequent call.
3. Internal panics from `@noble/hashes` bubble as plain `Error` — those are contract violations inside a dependency, not consumer-input issues.

## Cross-cutting guarantees

- **Determinism.** All functions are pure: no I/O, no clock, no PRNG, no `globalThis` reads. Same inputs always produce the same output. Byte-equality with `ergo_avltree_rust` is the load-bearing invariant; every fixture in the corpus asserts it.
- **Synchronous.** No async surface. Verification hits blake2b-256 in tight inner loops; an async boundary would only add overhead without enabling concurrency.
- **No throws on verification failures.** `verifyAvlBatch` / `verifyAvlLookup` return `null` on verification failure. Throws indicate programmer errors only.
- **Browser-compat.** Runtime support: Node >= 20, evergreen browsers with native ESM. Never `Buffer`. Never `globalThis.crypto`. No `process`, `fs`, `path`, `os`, or `node:*` imports in `packages/avltree/src/`. Hashing via `@noble/hashes@2.2.0` only.
- **ESM-only.** Bundle deliberately omits CJS entry points.
- **No top-level await** in published code.
- **No WASM** direct or transitive. The all-TS approach is this project's identity.
- **`bigint` for `UpdateLongBy.delta`.** Represents a signed 64-bit integer (i64 equivalent). Browsers support `bigint` natively since 2020; no polyfill ships.

## Test corpus

Three test layers plus cross-runtime, mirroring the proof and ergoscript packages:

1. **Per-component fixture tests** (`verify-batch.test.ts`, `verify-lookup.test.ts`, `operations.test.ts`, `proof-decode.test.ts`): per-Operation-variant coverage with byte-equality on `newDigest` and per-op `results[]`.
2. **Bulk corpus** (`corpus.test.ts`): 50 fixtures across 8 Operation variants; asserts byte-equality between TS verifier output and `ergo_avltree_rust` verifier output on every fixture. Corpus categories: per-Operation-variant fixtures (8 variants × varied pre-state: empty, single-leaf, balanced-10, balanced-100, balanced-1000, all-left-spine, all-right-spine), multi-op batches (sizes 0, 1, 2, 16, 256, stress-mixed-100), edge cases (all-deletes, boundary keys, single-leaf), config-variance (keyLength 1/8/32, fixed vs variable valueLengthOpt, maxNumOperations bounds), and adverse cases (truncated proof, swapped digest, mismatched config — all must return `null`).
3. **Mutation testing** (`mutation.test.ts`): single-byte flips at varied offsets. Target: **≥90% kill rate per Operation variant per fixture**. Each mutation either causes a `null` return (verification failure) or returns byte-identical result (tolerated padding — explicitly enumerated).
4. **Cross-runtime**: Vitest configured for both `node` and `jsdom`. Every test runs in both.

## Coverage

All 8 `Operation` variants are implemented and covered by fixtures:

| Variant | Leaf-match behavior | Leaf-gap behavior |
|---|---|---|
| `Lookup` | return old value; no structural change | return null; no structural change |
| `UnknownModification` | return old value; no structural change | return null; no structural change |
| `Insert` | fail (`key-already-exists`) | split leaf; heightDelta = +1 |
| `Update` | replace value; no height change | fail (`key-not-found`) |
| `InsertOrUpdate` | replace value (match path) | split leaf (gap path) |
| `UpdateLongBy` | add delta to i64; result=0 → delete | insert with delta (positive) or fail (negative) |
| `Remove` | signal `needsDelete`; delete pass | fail (`key-not-found`) |
| `RemoveIfExists` | signal `needsDelete`; delete pass | no-op (absent key; no change) |

Prover support: `BatchAVLProver` and `PersistentBatchAVLProver` are now ported to TS (v0.3.0). The verifier and prover share the same mutation engine (`modify.ts` / `delete.ts`) through the `AvlTreeOpsCallbacks` interface. The Rust `fixture-gen/` crate remains the authoritative fixture source for byte-equality validation.

## Source mapping to `ergo_avltree_rust`

Pinned at `~/projects/ergo_avltree_rust/` HEAD `2941396`, branch `main`, including upstream PRs #10/#11/#13.

| Rust function (file:lines) | TS function(s) (file) | Note |
|---|---|---|
| `batch_avl_verifier.rs::BatchAVLVerifier::new` (37-55) | `BatchAvlVerifier` constructor (`batch-verifier.ts`) | 1:1 port; proof-decode delegated to `parseProofPackedTree` |
| `batch_avl_verifier.rs::reconstruct_tree` (58-143) | `parseProofPackedTree` (`proof-decode.ts`) | 1:1 port; bounds-checks added (TS OOB returns undefined, not panic); token constants from `batch_node.rs:14-16`; max-nodes DoS formula from lines 63-87 |
| `batch_avl_verifier.rs::perform_one_operation` (157-172) | `BatchAvlVerifier.performOneOperation` (`batch-verifier.ts`) | 1:1 port plus orchestration from `authenticated_tree_ops.rs::return_result_of_one_operation` (221-248); needsDelete two-phase dispatch; height bookkeeping |
| `batch_avl_verifier.rs::next_direction_is_left` (192-203) | `nextDirectionIsLeft` (`tree-traversal.ts`) | 1:1 port; LSB-first bit indexing (`1 << (i & 7)`) confirmed |
| `batch_avl_verifier.rs::key_matches_leaf` (213-227) | `keyMatchesLeaf` (`tree-traversal.ts`) | 1:1 port; returns discriminated-union result instead of throwing on out-of-order |
| `batch_avl_verifier.rs::replay_comparison` (239-251) | `replayComparison` (`tree-traversal.ts`) | 1:1 port; three-way return (-1/0/1); advances `state.replayIndex` |
| `authenticated_tree_ops.rs::double_left_rotate` (135-164) | `doubleLeftRotate` (`rotation.ts`) | 1:1 port; fresh `newInternal` allocations instead of Rc<RefCell> in-place update (labelCache invariant) |
| `authenticated_tree_ops.rs::double_right_rotate` (171-200) | `doubleRightRotate` (`rotation.ts`) | 1:1 port (mirror); same allocation policy |
| `authenticated_tree_ops.rs::modify_helper` (262-385) | `modifyHelper` + `handleLeafNode` + `handleLeafMatch` + `handleLeafGap` + `handleInternalNode` + `addNode` + `rebalanceLeftDescent` + `rebalanceRightDescent` + `rotateLeftDescent` + `rotateRightDescent` (`modify.ts`) | Decomposed into 10 helpers; `needsDelete` signal added per two-phase dispatch design; handles Lookup/UnknownModification/Insert/Update/InsertOrUpdate/UpdateLongBy (Remove/RemoveIfExists live in delete.ts) |
| `authenticated_tree_ops.rs::add_node` (205-219) | `addNode` (`modify.ts`) | 1:1 port; splits the leaf-gap into (modifiedOriginal, newLeaf) under a new InternalNode with balance=0 |
| `authenticated_tree_ops.rs::delete_helper` (446-637) | `deleteHelper` + `deleteInner` + `tryEasyDeleteRightLeaf` + `tryEasyDeleteLeftLeaf` + `hardDeleteLeftDescent` + `hardDeleteRightDescent` + `rebalanceShrinkLeft` + `rebalanceShrinkRight` (`delete.ts`) | Decomposed into 8 helpers; `saved_node` out-param emulated via `SavedNodeRef` wrapper (`{ node: LeafNode \| null }`); second-pass deletion using `replayComparison` |
| `authenticated_tree_ops.rs::change_next_leaf_key_of_max_node` (400-416) | `changeNextLeafKeyOfMaxNode` (`delete.ts`) | 1:1 port; traverses rightmost path to update `nextLeafKey` of the max node |
| `authenticated_tree_ops.rs::change_key_and_value_of_min_node` (417-432) | `changeKeyAndValueOfMinNode` (`delete.ts`) | 1:1 port; traverses leftmost path to promote in-order successor |
| `authenticated_tree_ops.rs::digest` (112-128) | `BatchAvlVerifier.digest()` (`batch-verifier.ts`) | 1:1 port; returns 32-byte root label `||` 1-byte height; height clamped to u8 via `& 0xff` |
| `batch_node.rs::Node::label` (83-112, across LeafNode/InternalNode/LabelOnly branches) | `label` (`node.ts`) | Dispatch on `node.kind`; CRITICAL byte layout: LeafNode = `0x00 \|\| key \|\| value \|\| nextLeafKey`; InternalNode = `0x01 \|\| balance \|\| leftLabel \|\| rightLabel` (balance precedes child labels per batch_node.rs:100-109); LabelNode returns stored label directly |
| `batch_node.rs::LeafNode::new` (268-275) | `newLeaf` (`node.ts`) | 1:1 port; defensive copies on all byte args |
| `batch_node.rs::InternalNode::new` (212-219) | `newInternal` (`node.ts`) | 1:1 port; no defensive copy on children (object references; GC handles lifecycle) |
| `batch_node.rs::Node::new_label` (166) | `newLabel` (`node.ts`) | 1:1 port; defensive copy; RangeError if label !== 32 bytes |
| `operation.rs::Operation` enum (13-22) | `Operation` discriminated union (`operation.ts`) | Rust `KeyValue { key, value }` and `KeyDelta { key, delta }` structs flattened inline on variants — TS-idiomatic; intentional structural divergence |
| `operation.rs::Operation::update_fn` (64-106) | `updateFn` (`operation.ts`) | 1:1 port; WARNING: `Lookup` branch exists as a defensive stub but must never be called — `modifyHelper` short-circuits before `updateFn` for Lookup |
| `operation.rs::ADKey / ADValue / ADDigest` type aliases (7-9) | `ADKey / ADValue` type aliases (`types.ts`); no `ADDigest` alias — the 33-byte digest flows as the plain `Uint8Array` returned as `newDigest` | Documentation-only aliases on `Uint8Array`; the digest is exactly 33 bytes |
| (TS-only) | `verifyAvlBatch` + `verifyAvlLookup` (`verify.ts`) | Public functional wrappers — Rust has no equivalent; consumers call `BatchAVLVerifier` directly; these wrappers add shape validation (7 `AvlVerifyError` codes) and a clean null-on-failure return. `verifyAvlBatch` is a thin wrapper over `verifyAvlBatchPartial` (v0.2.0). |
| (TS-only) | `verifyAvlBatchPartial` (`verify.ts`) | v0.2.0 partial-success variant. Wraps the per-op `BatchAvlVerifier.performOneOperation` loop with mid-loop break + pre-op `digest()` snapshot to surface the AFTER-last-successful-op digest. The snapshot is necessary because sigma-rust poisons `root = null` on per-op failure (line 168 of `batch_avl_verifier.rs`), after which `digest()` returns `None`. Backs `@ergots/ergoscript`'s V3+ `SAvlTree.insert/update` handlers, which honor sigma-rust's break-on-failure-with-state-after-last-success semantics. |
| (TS-only) | `AvlVerifyError` class + `AvlVerifyErrorCode` type (`errors.ts`) | Programmer-error throws (7 codes); Rust uses `anyhow::Result` throughout with no separate error class |
| (TS-only) | `AvlVerifyFailReason` type (`errors.ts`) | Internal verification-failure taxonomy (10 reasons); tracked on `BatchAvlVerifier.lastFailReason`; not exported on v0.4.0 |

## Node types and constructors (v0.4.0)

```ts
export type AvlNode = LeafNode | InternalNode | LabelNode

export interface LeafNode {
  readonly kind: 'leaf'
  readonly key: ADKey
  readonly value: ADValue
  readonly nextLeafKey: ADKey
  labelCache: Uint8Array | null
}

export interface InternalNode {
  readonly kind: 'internal'
  readonly key?: Uint8Array
  left: AvlNode
  right: AvlNode
  balance: Balance
  labelCache: Uint8Array | null
}

export interface LabelNode {
  readonly kind: 'label'
  readonly label: Uint8Array
}

export type Balance = -1 | 0 | 1

function newLeaf(key: ADKey, value: ADValue, nextLeafKey: ADKey): LeafNode
function newInternal(left: AvlNode, right: AvlNode, balance: Balance, key?: Uint8Array): InternalNode
function newLabel(label: Uint8Array): LabelNode
function label(node: AvlNode): Uint8Array
```

Ported from `ergo_avltree_rust`'s `batch_node.rs::Node` enum plus the
`LeafNode`/`InternalNode`/`LabelOnly` structs and `Node::label()`.

- **`AvlNode`** is a discriminated union on `kind`. `LeafNode` holds a real
  key/value/next-leaf-key triple. `InternalNode` holds `left`/`right` children
  (each an `AvlNode`) and an AVL `balance`. `LabelNode` is a stub carrying only
  a 32-byte digest — it stands in for a subtree the holder doesn't have full
  data for (e.g. a proof-decoded sibling, or one of a `deserializeNode`d
  internal node's children; see "Storage codec" below).
- **`InternalNode.key`** is optional: the shared prover/verifier engine
  (`modify.ts`/`delete.ts`) sets it on every `newInternal` call it makes, but
  `proof-decode.ts` reconstructs verifier-only internal nodes without one.
  `left`, `right`, `balance`, and `labelCache` are currently typed as mutable
  (not `readonly`); `key`, like `kind`, is `readonly`.
- **`LeafNode`** fields `key`, `value`, `nextLeafKey`, and `kind` are all
  `readonly`; only `labelCache` is mutable.
- **`Balance`** is the literal union `-1 | 0 | 1`. Rust's equivalent
  (`batch_node.rs`'s `pub type Balance = i8`) is an unchecked `i8`; see
  "Deliberate divergences from the reference" in the Storage codec section for
  why the TS type is narrower.
- **`newLeaf(key, value, nextLeafKey)`** — constructs a `LeafNode`. Defensively
  copies all three byte arguments so caller-side mutation can't corrupt the
  node or invalidate an already-computed label.
- **`newInternal(left, right, balance, key?)`** — constructs an `InternalNode`.
  `key` is optional (see above); `left`/`right` are stored by reference, not
  defensively copied.
- **`newLabel(label)`** — constructs a `LabelNode`. Defensively copies `label`.
  **Throws `RangeError`** if `label.length !== 32`.
- **`label(node)`** — returns the node's 32-byte blake2b-256 digest.
  `LabelNode` returns its stored digest directly. `LeafNode`/`InternalNode`
  compute `blake2b256(0x00 || key || value || nextLeafKey)` or
  `blake2b256(0x01 || balance || label(left) || label(right))` respectively
  (balance precedes the child labels), **memoise the result into
  `labelCache`**, and return a defensive copy — the cache itself is never
  handed out directly, so callers cannot corrupt it. A cache hit skips
  recomputation and still returns a fresh copy.

## Storage codec (v0.4.0)

```ts
serializeNode(node: AvlNode, config: AvlTreeConfig): Uint8Array
deserializeNode(bytes: Uint8Array, config: AvlTreeConfig): AvlNode
```

Byte-identical to `ergo_avltree_rust`'s `AVLTree::pack` (`batch_node.rs:595-618`)
and `AVLTree::unpack` (`batch_node.rs:622-654`) for well-formed input — two
checks are intentionally stricter than the reference; see "Deliberate
divergences from the reference" below. Only `config.keyLength` and
`config.valueLengthOpt` are read; `maxNumOperations` and `maxDeletes` are
ignored.

**Format.** Big-endian.

```
internal: 0x00 || balance(i8, 1B) || key(keyLength) || leftLabel(32) || rightLabel(32)
leaf:     0x01 || key(keyLength) || [valueLen(u32) iff valueLengthOpt === null] || value || nextLeafKey(keyLength)
```

- **Precondition (throws `RangeError`):** on encode — `node.kind !== 'label'`
  (label stubs are not storable, matching Rust, which panics); for an internal
  node, `node.key !== undefined`; every key-position field is exactly
  `config.keyLength` bytes; when `valueLengthOpt` is non-null, the leaf value is
  exactly that many bytes. On decode — input is long enough for every field, the
  leading tag is `0x00` or `0x01`, and the balance byte decodes to `-1 | 0 | 1`.
  The key-length checks on encode and the balance-range check on decode are
  both stricter than the reference — see "Deliberate divergences from the
  reference" immediately below.
- **Deliberate divergences from the reference.** Two decode/encode checks are
  stricter than `ergo_avltree_rust`, which performs neither. Rust's `Balance`
  is a bare `i8`, so `unpack` accepts any byte; our `Balance` is the union
  `-1 | 0 | 1`, and admitting an out-of-range value would be a type lie that
  silently corrupts every ancestor label. Rust's `pack` likewise writes the key
  without checking its length, producing a record whose every subsequent field
  mis-parses on read; we reject at write time instead. Neither check alters the
  bytes produced for valid input, so the format itself remains byte-identical.
- **Postcondition:** `deserializeNode(serializeNode(n, c), c)` reproduces `n`,
  except that an internal node's children come back as `LabelNode` stubs
  carrying the encoded digests — the parent record stores child *labels*, not
  child subtrees. This mirrors Rust's `unpack`, which builds internals via
  `Node::new_label_persisted(...)` — the `_persisted` family additionally marks
  the node `is_new = false` so a later in-place `update()` takes Rust's
  copy-on-write branch instead of mutating a node shared with `oldTopNode`; the
  TS port has no `is_new` concept since its engine is fully immutable. Storage
  backends relink real children by label lookup.
- **Invariant:** no I/O, no clock, no PRNG. Encoding an internal node memoises
  child labels into `labelCache` as a side effect, matching Rust's
  `borrow_mut().label()`.
- **Not self-describing.** Key and value lengths come from `config`, so a
  writer/reader config mismatch is not generally detectable. Rust has the same
  property. The fixed-value-length check catches the common case. Records
  written by the retired 0.3.x format are NOT reliably rejected: its leaf tag was
  also `0x01`, so its u16 key-length prefix is silently consumed as key bytes.

## Cross-references

- `docs/specs/2026-05-18-ergots-avltree-package-design.md` — design rationale, architecture, validation strategy, error model detail
- `facts/ergoscript-eval.md` — upstream consumer; `SAvlTree.*` method handlers call into this package
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/ergo_avltree_rust/src/` — Rust reference implementation at HEAD `2941396` (verifier + prover)
- KMZ16 paper: <https://eprint.iacr.org/2016/994> — AVL+ authenticated dictionary; KMZ17 Appendix B documents the `keyMatchesLeaf` range semantics
