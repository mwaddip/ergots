# `@ergots/avltree` — AVL+ Batch Prover Design Spec

**Status:** Draft
**Date:** 2026-07-28
**Package:** `@ergots/avltree` (additive; v0.2.0 → next minor)
**Reference:** `~/projects/ergo_avltree_rust/` (our fork with unmerged upstream fixes)

## Goal

Add the AVL+ batch prover to `@ergots/avltree`, completing the package's coverage of
`ergo_avltree_rust`. Currently the package is verifier-only (`BatchAVLVerifier` +
`verifyAvlBatch` / `verifyAvlLookup` wrappers). This spec adds the prover side:
building an in-memory AVL+ tree, applying authenticated operations, and generating
serialized AD proofs that the existing verifier accepts byte-identically.

Ports all three Rust layers:

1. **`BatchAVLProver`** (`batch_avl_prover.rs`, 506 lines) — core prover
2. **`PersistentBatchAVLProver`** (`persistent_batch_avl_prover.rs`, 68 lines) — persistence wrapper
3. **`VersionedAVLStorage`** (`versioned_avl_storage.rs`, 69 lines) — storage interface

## Non-goals

- Concrete `VersionedAVLStorage` implementation (the Rust crate only ships an in-memory
  test impl; consumers provide their own)
- `random_walk()` and `check_tree()` — debug-only methods in the Rust prover; not ported
- `generate_proof_for_operations` as a separate public method — the Rust signature
  takes `&Vec<Operation>` (borrowed slice); TS exposes it as `generateProofForOperations`
  taking an `Operation[]`
- Fixture regeneration via `fixture-gen/` (frozen). Prover fixtures are generated
  manually against `~/projects/ergo_avltree_rust` and committed as static JSON/binary.

## Architecture

### Shared engine extraction

The prover and verifier share the same AVL+ tree mutation engine (`modifyHelper`,
`deleteHelper`, rotations, node labeling, `addNode`). These currently live in
`batch-verifier.ts` and its satellite modules (`modify.ts`, `delete.ts`, `rotation.ts`).

The three methods that DIFFER between prover and verifier are isolated as callbacks:

| Trait method | Verifier | Prover |
|---|---|---|
| `nextDirectionIsLeft` | Reads bit from proof bytes | Compares keys, writes bit to directions buffer |
| `keyMatchesLeaf` | Checks leaf key against proof data | Returns `self.found` (set during traversal) |
| `replayComparison` | Reads bit from proof bytes | Reads bit from own directions buffer |

The callback interface:

```ts
interface AvlTreeOpsCallbacks {
  /** Return true to go left, false to go right. */
  nextDirectionIsLeft(key: Uint8Array, r: InternalNode): boolean
  /** Return whether the key matches the leaf. */
  keyMatchesLeaf(key: Uint8Array, leaf: LeafNode): boolean
  /** Replay the next comparison: -1 (left), 0 (equal), 1 (right). */
  replayComparison(): number
}
```

The shared engine (`avl-tree-ops.ts`) holds the tree state and all mutation logic,
parameterized by these callbacks. Both `BatchAvlVerifier` and `BatchAVLProver` compose
an engine instance with their own callback implementations.

### File changes

```
packages/avltree/src/
├── avl-tree-ops.ts       ← NEW: extracted shared engine (modifyHelper, deleteHelper,
│                            rotations, addNode) — takes AvlTreeOpsCallbacks
├── batch-verifier.ts      ← REFACTORED: delegates mutation to avl-tree-ops with
│                            verifier-specific callbacks; public API unchanged
├── batch-prover.ts        ← NEW: BatchAVLProver class
├── persistent-prover.ts   ← NEW: PersistentBatchAVLProver wrapper
├── versioned-storage.ts   ← NEW: VersionedAVLStorage interface
├── modify.ts              ← REFACTORED: helpers moved into avl-tree-ops.ts
├── delete.ts              ← REFACTORED: helpers moved into avl-tree-ops.ts
├── rotation.ts            ← unchanged (pure functions, no trait dispatch)
├── node.ts                ← unchanged
├── operation.ts           ← unchanged (Operation union already shared)
├── tree-traversal.ts      ← REFACTORED: verifier-specific helpers stay; prover
│                            equivalents are inline in batch-prover.ts
├── proof-decode.ts        ← unchanged
├── errors.ts              ← unchanged (no new error codes needed)
├── types.ts               ← unchanged
├── index.ts               ← NEW exports added
└── verify.ts              ← unchanged (public wrappers)
```

`batch-verifier.ts` shrinks — mutation logic moves to `avl-tree-ops.ts`. The public
API is behavior-preserving (existing 156 tests remain green).

### Component graph

```
┌─────────────────────────────────────────────────────┐
│  Public surface (index.ts)                          │
│  + BatchAVLProver, PersistentBatchAVLProver,        │
│    VersionedAVLStorage (new)                        │
│  + verifyAvlBatch, verifyAvlBatchPartial,           │
│    verifyAvlLookup (unchanged)                      │
└──────────┬────────────────────┬─────────────────────┘
           │                    │
    ┌──────▼──────┐    ┌───────▼────────┐
    │ batch-prover │    │ batch-verifier │
    │ (new)        │    │ (refactored)   │
    └──────┬───────┘    └───────┬────────┘
           │                    │
           │   ┌────────────────┘
           │   │  AvlTreeOpsCallbacks
    ┌──────▼───▼──────┐
    │  avl-tree-ops   │  (NEW: shared engine)
    │  modifyHelper   │
    │  deleteHelper   │
    │  rotations      │
    │  addNode        │
    │  returnResult   │
    └──────┬──────────┘
           │
    ┌──────▼──────┐
    │   node.ts   │  (unchanged)
    └─────────────┘
```

## `BatchAVLProver`

### Types

```ts
export type ProverOperationResult =
  | { success: true; value: Uint8Array | null }
  | { success: false }
```

### Public surface

```ts
export class BatchAVLProver {
  /** Create a new prover with an empty tree. */
  constructor(keyLength: number, valueLengthOpt: number | null)

  /**
   * Apply one operation, mutating the tree.
   * Returns a Result-wrapping object:
   *   { success: true, value: Uint8Array | null }
   *   { success: false }
   * Precondition violations (key length mismatch, key out of ±inf bounds)
   * throw AvlVerifyError before any state change.
   * The tree is unchanged on operation failure — direction state is rolled back.
   */
  performOneOperation(operation: Operation): ProverOperationResult

  /**
   * Generate a serialized AD proof for all operations performed since the last
   * generateProof() call. Clears direction state; tree remains intact.
   * Returns the packed proof bytes.
   */
  generateProof(): Uint8Array

  /**
   * Generate a proof for an arbitrary batch of operations WITHOUT mutating
   * the current tree. Clones the prover internally, applies the operations,
   * and returns the proof bytes and resulting digest.
   */
  generateProofForOperations(
    operations: Operation[]
  ): { proof: Uint8Array; digest: Uint8Array }

  /**
   * Simple tree lookup — no proof generation, no mutation.
   * Returns the value at key, or null if absent.
   */
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null

  /** Current 33-byte digest (root label || height). Null if tree poisoned. */
  digest(): Uint8Array | null
}
```

### Internals

**Tree initialization:** On construction, an empty tree is populated with ±inf
sentinel leaves (mirroring Rust `BatchAVLProver::new` lines 65-73). The negative-inf
leaf key = `new Uint8Array(keyLength)` (all zeroes); positive-inf leaf key =
`new Uint8Array(keyLength).fill(0xff)`.

**Direction recording:** `nextDirectionIsLeft` encodes the traversal decision as a
bit in the `directions` buffer (matching Rust lines 409-446). Bits are packed LSB-first
within each byte. On `key == r.key`, sets `found = true` and records `lastRightStep`.

**Failure rollback:** On operation failure, `directions` is truncated to
`replayIndex` bits, and the partial last byte is masked (Rust lines 96-108).
Tree state is unchanged because `modifyHelper` returns before any mutation on failure.

**Proof generation (`generateProof`):** Packs the tree via post-order traversal
(`pack_tree`, Rust lines 155-193):
- Unmodified nodes → `LABEL_IN_PACKAGED_PROOF (0x02)` + 32-byte label
- Modified leaves → `LEAF_IN_PACKAGED_PROOF (0x01)` + key (if no previous leaf) +
  nextLeafKey + optional value length + value
- Modified internal nodes → recurse left, recurse right, then balance byte
- Terminates with `END_OF_TREE_IN_PACKAGED_PROOF (0x00)` + directions bytes

Modified-ness is tracked via the `modifiedNodes` array (set by `onNodeVisit`),
mirroring Rust's `modified_nodes` (separate from `visited`/`is_new` persistence flags).

**`generateProofForOperations`:** Clones the tree (deep-copy root node + all
reachable nodes), creates a temporary prover with the clone, applies operations,
calls `generateProof()` and `digest()`. The original prover is untouched.

**`unauthenticatedLookup`:** Walks the tree comparing keys, returns the leaf value
or null. No directions recorded, no proof generated, no tree mutation.

## `PersistentBatchAVLProver`

Thin wrapper pairing a `BatchAVLProver` with a `VersionedAVLStorage`.

```ts
export class PersistentBatchAVLProver {
  readonly prover: BatchAVLProver
  readonly storage: VersionedAVLStorage

  /**
   * @param prover        Inner prover
   * @param storage       Versioned storage backend
   * @param additionalData Initial key-value pairs to insert (only if storage is empty)
   */
  constructor(
    prover: BatchAVLProver,
    storage: VersionedAVLStorage,
    additionalData: [Uint8Array, Uint8Array][],
  )

  /** Delegates to prover.performOneOperation. */
  performOneOperation(operation: Operation): ProverOperationResult

  /** Delegates to prover.unauthenticatedLookup. */
  unauthenticatedLookup(key: Uint8Array): Uint8Array | null

  /** Delegates to prover.digest(). */
  digest(): Uint8Array | null

  /** Delegates to prover.base.tree.height. */
  height(): number

  /**
   * Calls storage.update() then prover.generateProof().
   * Returns the serialized proof.
   */
  generateProofAndUpdateStorage(
    additionalData: [Uint8Array, Uint8Array][]
  ): Uint8Array

  /** Rolls back the prover's tree to the given digest version. */
  rollback(version: Uint8Array): void
}
```

Constructor logic (matching Rust lines 20-31):
1. If `storage.version()` is non-null → call `rollback(version)` to restore tree state
2. If storage is empty → call `generateProofAndUpdateStorage(additionalData)` to populate
3. Assert `storage.version() === this.digest()`

## `VersionedAVLStorage`

Pure interface — no concrete implementation ships.

```ts
export interface VersionedAVLStorage {
  /**
   * Synchronize storage with the prover's state.
   * Called after operations are applied but before proof generation.
   */
  update(
    prover: BatchAVLProver,
    additionalData: [Uint8Array, Uint8Array][],
  ): void

  /**
   * Return the root node and tree height at the given version.
   * Used by PersistentBatchAVLProver constructor to restore state.
   */
  rollback(version: Uint8Array): [/* root */ unknown, /* height */ number]

  /** Current version digest, or null if storage is empty. */
  version(): Uint8Array | null

  /** Versions available for rollback. */
  rollbackVersions(): Uint8Array[]

  /** Force durable commit. No-op by default. */
  flush(): void
}
```

Note: `rollback` returns `[NodeId, number]` in Rust. `NodeId` is an internal tree
node reference. For TS, the return type of the root node is `unknown` — the concrete
storage implementation must return whatever the prover's tree expects. This is
an internal wiring concern; consumers implementing `VersionedAVLStorage` will
work with the concrete node types exported by the package.

## Error handling

No new error codes. `performOneOperation` uses a `ProverOperationResult`
discriminated union (`{ success: true, value } | { success: false }`) to
distinguish "operation failed" (Insert on existing key) from "key was absent"
(null value) — mirroring Rust's `Result<Option<ADValue>>`. Precondition violations
(key length mismatch, key out of ±inf bounds) throw `AvlVerifyError` with the
appropriate existing code.

For `PersistentBatchAVLProver`, the Rust version uses `anyhow::Result` with `?`
propagation. The TS port uses try/catch + typed errors since there's no `?` operator.

## Testing strategy

### Layer 1 — Round-trip (cross-verification)

The prover's correctness gate: prover-generated proofs must verify against the
existing verifier. For each operation variant:

1. Create a prover, apply operations → generate proof → get digest
2. Feed the proof + starting digest into `verifyAvlBatch`
3. Assert: verifier accepts, resulting digest matches, per-op results match

### Layer 2 — Fixture-driven

Generate proof bytes from `~/projects/ergo_avltree_rust`'s `BatchAVLProver` for
a known tree + operation set. Commit the proof bytes as a static fixture. TS test
asserts our prover generates byte-identical proofs.

Fixture categories mirror the existing verifier corpus:
- Per-operation-variant (8 variants × varied pre-state)
- Multi-op batches (sizes 0, 1, 2, 16)
- Edge cases (empty-tree initial insert, boundary keys, single-leaf)

### Layer 3 — Adverse (mutation)

Corrupt a prover-generated proof (single-byte flips) → assert the verifier rejects.
Same mutation pattern as the existing verifier mutation suite.

≥90% kill rate per operation variant.

### Layer 4 — Regression

The existing 156 verifier tests must stay green through the refactor. This is the
primary safety net for the shared engine extraction.

### Fixture generation

`fixture-gen/` is frozen. Prover fixtures are generated manually:

```bash
cd ~/projects/ergo_avltree_rust
# Write a small binary/test that creates a BatchAVLProver, applies operations,
# calls generate_proof(), and emits the proof bytes + digest as JSON.
cargo test prover_fixture_gen -- --nocapture
```

The emitted JSON is committed into `packages/avltree/test/fixtures/prover/`.

## Cross-cutting guarantees

- **Determinism.** All prover functions are pure given the same tree state and
  operation sequence. No PRNG (random_walk is not ported). Same tree + same ops
  → same proof bytes.
- **Synchronous.** No async surface.
- **Browser-compat.** Same rules as the verifier: no `Buffer`, no `node:*` imports,
  no WASM, ESM only. Hashing via `@noble/hashes` only.
- **Stateless public API.** The `BatchAVLProver` is stateful (holds a mutable tree),
  but it's explicitly a stateful object — callers manage its lifecycle. The functional
  wrappers (`verifyAvlBatch` etc.) remain stateless.
- **Byte-equality.** Prover-generated proofs are byte-identical to
  `~/projects/ergo_avltree_rust`'s `BatchAVLProver::generate_proof()` for the same
  tree state and operation sequence. This is the load-bearing invariant.

## Public API changes

Additive only — the existing verifier surface is unchanged.

New exports from `@ergots/avltree`:
- `BatchAVLProver` class
- `PersistentBatchAVLProver` class
- `VersionedAVLStorage` interface
- `ProverOperationResult` type

No breaking changes. Version bump: 0.2.0 → 0.3.0 (minor).

## Risks

- **Shared engine extraction.** The verifier's `batch-verifier.ts` currently has
  mutation logic interleaved with proof-verification state. Extracting the shared
  core without breaking the 156-test verifier suite is the primary risk. Mitigated
  by the regression gate (Layer 4) — existing tests are the behavior-preserving net.

- **Tree cloning.** `generateProofForOperations` needs a deep-clone of the tree.
  In Rust, `AVLTree::clone()` does this via `Rc::clone` (reference-count bump,
  not deep copy — the Rust prover actually shares nodes). In TS, our nodes are plain
  objects — a deep clone is straightforward but must preserve byte identity of labels.
  Tested by asserting clone-digest == original-digest before any operations.

- **NodeId equivalent.** The Rust prover uses `Rc::clone` for identity tracking
  (`was_modified` checks `Rc::as_ptr` equality). Our TS verifier doesn't have this
  concept — nodes are compared by value. For the prover's `modifiedNodes` tracking,
  we'll use object reference identity (`===`), which works because our tree mutation
  already creates new node objects on change (immutable update pattern).

## Source mapping

| Rust (batch_avl_prover.rs) | TS |
|---|---|
| `BatchAVLProver::new` (54-76) | `BatchAVLProver` constructor |
| `perform_one_operation` (89-110) | `performOneOperation` |
| `generate_proof` (202-227) | `generateProof` |
| `pack_tree` (155-194) | `BatchAVLProver.packTree` (private) |
| `generate_proof_for_operations` (128-141) | `generateProofForOperations` |
| `unauthenticated_lookup` (302-337) | `unauthenticatedLookup` |
| `random_walk` (273-294) | NOT PORTED |
| `check_tree` / `check_tree_helper` (339-389) | NOT PORTED |
| `walk` / `tree_walk` (229-266) | Inline (only used by random_walk and unauthenticated_lookup) |
| `next_direction_is_left` (409-446) | `BatchAVLProver` callback for `AvlTreeOpsCallbacks` |
| `key_matches_leaf` (455-462) | `BatchAVLProver` callback for `AvlTreeOpsCallbacks` |
| `replay_comparison` (474-484) | `BatchAVLProver` callback for `AvlTreeOpsCallbacks` |
| `removed_nodes` (115-122) | NOT PORTED (internal, used by persistent prover's update cycle — subsumed by `PersistentBatchAVLProver`) |

| Rust (persistent_batch_avl_prover.rs) | TS |
|---|---|
| `PersistentBatchAVLProver::new` (16-31) | `PersistentBatchAVLProver` constructor |
| `perform_one_operation` (50-52) | `performOneOperation` |
| `generate_proof_and_update_storage` (54-60) | `generateProofAndUpdateStorage` |
| `rollback` (62-67) | `rollback` |
| `digest` (34-36), `height` (38-40), `unauthenticated_lookup` (46-48) | Delegating methods |

| Rust (versioned_avl_storage.rs) | TS |
|---|---|
| `VersionedAVLStorage` trait | `VersionedAVLStorage` interface |
| `update` (19-23) | `update` |
| `rollback` (28) | `rollback` |
| `version` (35) | `version` |
| `rollback_versions` (55) | `rollbackVersions` |
| `flush` (66-68) | `flush` |

## Cross-references

- `facts/avltree.md` — interface contract (to be updated with prover surface)
- `docs/specs/2026-05-18-ergots-avltree-package-design.md` — original verifier design
- `~/projects/ergo_avltree_rust/src/batch_avl_prover.rs` — Rust reference (prover)
- `~/projects/ergo_avltree_rust/src/persistent_batch_avl_prover.rs` — Rust reference (persistent)
- `~/projects/ergo_avltree_rust/src/versioned_avl_storage.rs` — Rust reference (storage interface)
- `~/projects/ergo_avltree_rust/src/authenticated_tree_ops.rs` — Rust reference (shared engine)
- `CLAUDE.md` — TDD discipline, browser-first rules
