# `@ergots/avltree` 0.5.0 — public step-by-step verifier and neighbor-reporting lookups

**Date:** 2026-09-29 (rev 4). Rev 2 applied the adversarial spec review: no
critical findings, six important ones (I1–I6) and ten minor ones (M1–M10). Rev 3
records the user's decision the same day to fix all three pre-existing defects
(P1–P3) in this release. Rev 4 applies the plan review:
- P3 gains the height-before-root reorder. Without it, P3's "the root is still
  the pre-operation state" is false for the height-check throw.
- The path-leak gate is stated against the 0.4.0 baseline.
**Source:** Notis main's prompt `~/projects/dagsocial/prompts/avltree-neighbour-lookups.md`
(written 2026-09-27, routed by the user). The user approved this design direction
in conversation on 2026-09-29.
**Base:** `master` at `3d48cd1`. `packages/avltree` and `facts/avltree.md` are
unchanged since the prompt's `aaec5d5`. The reviewer confirmed with `npm pack` and
`diff -r` that the workspace `src/` and `dist/index.d.ts` are byte-identical to
the published `0.4.0`.

## Goal

Notis (the `dagsocial` repo) moves its whole consensus state under an AVL+ root
with ordered 65-byte keys (a one-byte tag, then fields). Every set its rules read,
such as an owner's boxes or a queue in due order, is then one contiguous key range.
A browser client (a Notis leaf) validates a block from the parent's root, the
block, and the block's batch proof. It answers its state transition's reads as they
are asked, including range reads of the form "every key with this prefix". The
Notis node, which produces the proof, needs the same reads from the prover.

Two things are missing:

1. **A public step-by-step verifier.** The package verifies only whole operation
   lists (`verifyAvlBatch*`). The class that performs one operation at a time is
   internal (`src/index.ts:38-40`: "may change without notice").
2. **A lookup that reports its neighbors.** For a present key it returns the value
   and the next leaf's key. For an absent key it returns the keys of the leaves on
   either side. It is needed on the step-by-step verifier and on `BatchAVLProver`,
   both recorded (proof-contributing) and unrecorded. With it, a reader can walk a
   range and, for a digest with honest provenance, see that nothing was left out
   (corrected in the whole-branch review: a present key's nextLeafKey is not
   checked, as in both references).

## Constraints

The prompt's rule, in the user's words: *"there may not be any consumers but it
should not lose compatibility with the ecosystem it's built for."*

- **Unchanged, byte for byte:** the proof format, the digest, every operation's
  semantics, and every existing entry point. That covers `verifyAvlBatch`,
  `verifyAvlBatchPartial`, `verifyAvlLookup`, `BatchAVLProver.performOneOperation`,
  `unauthenticatedLookup`, `generateProof`, `generateProofForOperations`,
  `PersistentBatchAVLProver`, the node codec, and the error classes and codes.
- **Fixtures do not move.** The Rust-generated fixture suites stay green with no
  edit to any fixture or expectation. `git diff -- packages/avltree/test/fixtures`
  is empty at every commit. If a fixture wants to move, that is the finding: stop
  and report it to the user and to Notis main. Never fix it into the diff.
- **No new `Operation` variant.** The union mirrors `ergo_avltree_rust`'s eight
  operations, and SANTA's conformance vectors carry exactly those eight. The new
  surface is new methods, classes and types only.
- **No code change in the shared engine, apart from P1.** `modify.ts`,
  `delete.ts`, `rotation.ts`, `operation.ts`, `tree-traversal.ts` and
  `proof-decode.ts` keep their code.
  - The only exceptions in those files are comment lines in `modify.ts` and
    `delete.ts` that name the renamed internal class (D3). Their diff must
    consist of comment lines only.
  - `node.ts` changes by exactly P1's line (the key copy in `newInternal`) plus
    its JSDoc, and by its header's `@see` comment line (the path-leak fix; see
    Verification).
  - This is stricter than the prompt requires, and the design makes it possible
    (D1).
- **Contract first.** `facts/avltree.md` is updated first. `API.md`, `README.md`
  and the session documents close the work.
- **TDD per `CLAUDE.md`.** No production code without a failing test first.
- **Nothing is written to `~/projects/dagsocial`.** This session's record stays in
  this repo.

## Verified premises

The prompt lists four "weakest claims" as hypotheses to refute. Each was checked
against the source, and with throwaway probes where behavior is involved. The
author's probe covered 4,800 neighbor checks and 120 random mixed batches, at 32-
and 65-byte keys. The reviewer's probes added 4,200 checks on insert-and-remove
trees, including emptied trees and keys next to the sentinels; 14,400 operation
runs with flipped bytes; and 2,456 runs with random directions over an anchored
tree. All found zero mismatches and zero observer violations.

1. **The leaf a `Lookup` reaches for an absent key is the predecessor, with
   `leaf.key < key < leaf.nextLeafKey`, on both sides.**
   - **Verifier:** this is enforced, not just observed. `keyMatchesLeaf`
     (`tree-traversal.ts:115-123`) fails the operation with
     `'leaf-key-out-of-order'` unless `leaf.key < key < leaf.nextLeafKey` for an
     absent key, or `key == leaf.key` for a present key (corrected in the
     whole-branch review: a present key's nextLeafKey is not checked, as in both
     references).
   - **Prover:** the descent (`batch-prover.ts:188-219`) goes right on "key ≥ node
     key" and lands on the largest leaf key ≤ the lookup key. An internal node's
     key is the minimum of its right subtree. Holds on trees built by this API's
     operations. The one exception, P2, is reachable only with stub-bearing trees
     and is fixed in this release.
2. **Reporting the neighbors needs no extra proof content. Holds.**
   - A `Lookup` must resolve at a full leaf; a label stub there fails as
     `'proof-malformed'` (`modify.ts:119-124`).
   - Proof decoding rebuilds the leaf's key (read, or chained from the previous
     leaf's `nextLeafKey`) and its `nextLeafKey` (`proof-decode.ts:238-251`).
   - Both fields are inputs to the leaf's hash (label), so a tampered neighbor
     fails the digest check.
3. **`performOneOperation` × N then `generateProof()` equals
   `generateProofForOperations(ops)`. Holds from a proof-cycle boundary, over
   operations that all succeed.**
   - `generateProofForOperations` clones the current root and bails at the first
     failure (`batch-prover.ts:606-624`).
   - `generateProof()` covers every operation since the last cycle boundary, and
     the step route skips a failed operation.
4. **Nothing assumes 32-byte keys. Holds.**
   - Every literal `32`/`33` in `src/` is a label or digest length.
   - Keys always go through `keyLength`: the verifier's `config.keyLength` and the
     prover's `this.keyLength`.
   - The Rust fixtures pin key lengths 1, 8, 16 and 32; 65 adds no new code path.

**Single call site.** The engine invokes `callbacks.keyMatchesLeaf` from exactly
one site (`modify.ts:149`, in `handleLeafNode`), once per `modifyHelper` descent,
and `deleteHelper` never calls it. The reviewer searched the name, every holder of
`AvlTreeOpsCallbacks` (including ten in `delete.ts`), and the bracket and
destructuring forms.

**No dedicated neighbor-reporting lookup in either reference.**
- `ergo_avltree_rust` @`568e7c3`: the inherent public functions of
  `batch_avl_prover.rs` are `new`, `restore_root`, `perform_one_operation`,
  `removed_nodes`, `generate_proof_for_operations`, `generate_proof`, `tree_walk`,
  `random_walk`, `unauthenticated_lookup` and `check_tree`. Those of
  `batch_avl_verifier.rs` are `new` and `perform_one_operation`.
- scrypto 3.0.0 (`javap` on the coursier-cached jar) likewise has none.
- Both references do expose generic walks that can see a leaf's next key, but
  none of them is an authenticated lookup:
  - Rust `tree_walk` (`batch_avl_prover.rs:290`), whose leaf callback sees
    `pub next_node_key` (`batch_node.rs:44`);
  - the `AuthenticatedTreeOps` trait's `extract_nodes` / `extract_first_node`
    (`authenticated_tree_ops.rs:63,67`);
  - scrypto's `treeWalk`, `extractNodes` and `extractFirstNode`.

**The step-by-step verifier does have a counterpart:** it is both references' own
`BatchAVLVerifier`.
- Rust: `new(...) -> Result<BatchAVLVerifier>` and `perform_one_operation`, plus
  the trait's `digest()` (`authenticated_tree_ops.rs:133`).
- scrypto: the constructor sets `topNode` from `reconstructedTree` through
  `Try…recoverWith…getOrElse`, so a failed reconstruction becomes `None`.
  `performOneOperation(op): Try[Option[ADValue]]` and
  `digest: Option[ADDigest]`.

Exposing it brings us to parity with the references. The 2026-05-18 package spec
deferred it until "a real debug/diagnostics consumer surfaces"
(`docs/specs/2026-05-18-ergots-avltree-package-design.md:21`). Notis is that
consumer.

## Deliverables

### D1 — The leaf observer, the only engine seam

Both `buildCallbacks` implementations take an optional observer,
`onLeaf?: (leaf: LeafNode, matches: boolean) => void`:

- **Verifier** (`batch-verifier.ts:180-198`): calls `onLeaf` inside its
  `keyMatchesLeaf` callback, only when the range check returned `ok`.
- **Prover** (`batch-prover.ts:222-226`): calls it with the `found` value its
  callback already returns.

In both classes, the body of `performOneOperation(op)` moves verbatim into a
private `perform(op, onLeaf?)`. `performOneOperation(op)` becomes
`return this.perform(op)`. Each neighbor method calls
`this.perform({ tag: 'Lookup', key }, observer)`. On the prover, the key gates
stay inside `perform`, extracted into the `validateKey` of D4, so the recorded
path keeps its reference check order: −inf, +inf, length, then value and delta.

**Consequence: a neighbor lookup is a `Lookup`, by construction.** It runs the same
key gates, records or consumes the same direction bits, visits the same nodes, and
has the same failure, rollback and poisoning behavior. It returns the same value.
The observer only reads.

**Invariant.** On a successful `Lookup` the observer is invoked exactly once:
there is one call site, one descent and no delete pass, and an `ok` from
`keyMatchesLeaf` implies success for a `Lookup` (`modify.ts:198-208`, `283-293`,
`428-437`).
- The neighbor methods count the calls. On success with any count other than 1,
  they throw a plain `Error` (an engine inconsistency) rather than guess.
- This is unreachable, including from adversarial input.
- Tests 1–2 cannot catch a double call, since both arms would double-call and
  stay byte-identical. That leaves the count check, and test 3's comparison
  against the sorted key list.

**Rejected alternative:** threading the reached leaf through `ModifyOk`. That edits
about ten return sites in the consensus-critical engine for data only one
operation needs.

### D2 — Neighbor result types and the sentinel mapping

New internal module `src/neighbors.ts` holds the public types and one mapping
helper. The helper is internal.

```ts
/** What a neighbor-reporting lookup learns from the leaf it resolves at. */
export type NeighborLookup =
  | { found: true; value: Uint8Array; nextKey: Uint8Array | null }
  | { found: false; prevKey: Uint8Array | null; nextKey: Uint8Array | null }

/** A recorded (prover) or verifier neighbor lookup: the lookup, or a failure. */
export type NeighborLookupResult =
  | ({ success: true } & NeighborLookup)
  | { success: false }
```

Narrowing works as usual: `if (r.success && r.found) r.value`.

**Mapping** from the leaf `L` that the lookup resolved at, and the match flag `m`:

| Case | Result |
|---|---|
| `m = true` (present) | `{ found: true, value: copy(L.value), nextKey: next(L) }` |
| `m = false` (absent) | `{ found: false, prevKey: prev(L), nextKey: next(L) }` |

- `next(L)` is `null` when `L.nextLeafKey` is byte-equal to the +inf sentinel
  (`keyLength × 0xFF`), otherwise `copy(L.nextLeafKey)`.
- `prev(L)` is `null` when `L.key` is byte-equal to the −inf sentinel
  (`keyLength × 0x00`), otherwise `copy(L.key)`.
- Copies use `new Uint8Array(...)`, never `.slice()` (see D3 on `Buffer`).

**Why `null` and not the raw sentinel bytes.** The mapping is exact, because no
real key can equal either sentinel: both sides reject keys at or beyond them. But
raw sentinel bytes would let a reader mistake the end of the tree for a key. For
example, a prefix walk over a `0xFF`-tagged range would read the +inf sentinel
`0xFF…FF` as a key with that prefix.

**Edge cases:**
- The empty tree (the lone −inf sentinel leaf) reports
  `{ found: false, prevKey: null, nextKey: null }`.
- On trees built by this API's operations, `found: true` never involves the −inf
  leaf, because a sentinel key cannot be looked up.
  - Before P2's fix, the stale flag broke this on stub-bearing trees: a probe
    produced `{ found: true, value: [], nextKey: 10 }` for `Lookup(20)`.
  - A non-sentinel leaf installed as root by `restoreRoot` still reports
    `prevKey === key`. This breaks the invariant and is out of scope, like every
    shape `restoreRoot` accepts without checking.

**Spelling.** Identifiers use American spelling (`Neighbor`), matching the
package's identifiers (`serializeNode`, not `serialiseNode`). The prompt's
British "neighbour" is prose only.

### D3 — Public `BatchAVLVerifier` (in `verify.ts`); internal class renamed

**Rename.** The internal `BatchAvlVerifier` class (`batch-verifier.ts`) is renamed
`VerifierCore`. The file keeps its name, since it ports `batch_avl_verifier.rs`.
Otherwise the codebase would carry `BatchAVLVerifier` and `BatchAvlVerifier` side
by side. The rename is mechanical and lands as its own commit before any new code.

Its reference set is the exhaustive-rename gate (OVERRIDES rule 7). Measured by
the reviewer with `rtk proxy grep -rIl BatchAvlVerifier .` over all file types,
excluding historical `docs/`, `audit*/`, `.superpowers/` and `dist/`:
- **Code:**
  - `batch-verifier.ts`;
  - `verify.ts`;
  - `test/verifier-key-bounds.test.ts`: the import plus five constructor calls,
    at lines 90, 116, 127, 147 and 157.
- **Comments:** `modify.ts`, `delete.ts`, `errors.ts`, `index.ts`.
- **Living docs:**
  - `facts/avltree.md`: 10 lines (34, 258, 289, 308, 309, 375, 377, 388, 399, 401);
  - `API.md`: 2 lines.

ergoscript, transaction, tools and santa have no hits; dagsocial has two docs
only. The search would miss a name built from parts, or a binary file.
Historical specs keep the old name as dated records.

**Public class:**

```ts
export class BatchAVLVerifier {
  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig)
  performOneOperation(op: Operation): ProverOperationResult
  performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult
  digest(): Uint8Array | null
  getLastFailReason(): AvlVerifyFailReason | null
}
```

**Construction.**
- **Copy first, then validate the copies.**
  - `config`: copy its four fields (`keyLength`, `valueLengthOpt`,
    `maxNumOperations`, `maxDeletes`) into a fresh object, then run
    `validateConfig` on the copy. Validating before copying would leave a
    check-then-copy gap on getter-backed objects.
  - `proof`: copy it with `new Uint8Array(proof)`.
  - Then run `validateStartingDigest`.
  - Validation throws `AvlVerifyError` with the same codes as
    `verifyAvlBatchPartial`.
- **Why the copies matter.** The verifier outlives the call.
  - The core reads direction bits from `proof` lazily, one operation at a time
    (`nextDirectionIsLeft` / `replayComparison`), so a caller that reuses or
    mutates its buffer would change later verdicts.
  - A mutated `config` would desync per-operation validation from the tree
    reconstructed at construction.
- **Why `new Uint8Array` and not `.slice()`.** `Buffer#slice` returns a view on
  Node, and a `Buffer` type-checks as a `Uint8Array`. So `.slice()` would copy
  nothing for exactly the callers most likely to reuse pooled buffers. The
  reviewer confirmed this on Node v22.19.0.

**Poisoned from birth.** A proof that fails to decode or anchor does not throw.
- `digest()` returns `null`.
- `getLastFailReason()` returns `'proof-truncated'`, `'proof-malformed'`,
  `'digest-mismatch'` or `'max-nodes-exceeded'`.
- Every operation returns `{ success: false }`.

This is scrypto's shape. The in-chat proposal was instead a factory returning
`null`, mirroring Rust's `new → Err`. The factory would throw away the reason that
`getLastFailReason()` exists to report. Forgetting the anchor check is harmless
here, because every operation then fails.

**`performOneOperation(op)`:**
- Runs `validateOperationShape(op, config)` first: key length, then value length,
  then delta range. A violation throws `AvlVerifyError` with no state change and
  no poisoning, because it is a programmer error, not a verdict.
- It then delegates to the core.
  - Failure: returns `{ success: false }` and poisons the verifier. Every later
    operation fails, which is the references' rule.
  - Success: returns `{ success: true, value }`, with `value` a fresh copy.
- Keys at or beyond a sentinel stay a Tier-2 fail-and-poison
  (`'key-out-of-bounds'`), exactly as on the batch path.

**`performLookupWithNeighbors(key)`:**
- Validates the key as `validateOperationShape` validates a `Lookup` (key-length
  throw only).
- Runs a `Lookup` through the core with the D1 observer and maps it through D2.
- A verification failure returns `{ success: false }` and poisons the verifier.

**`digest()`:** a fresh 33-byte buffer, or `null` once poisoned.

**`getLastFailReason()`:**
- `null` while healthy.
- Once poisoned, the first failure's reason. Later operations on a poisoned
  verifier do not overwrite it (`batch-verifier.ts:268-273`, the `??=`).
- `AvlVerifyError` throws are not failures and set no reason.

**Unusable after an engine throw (I6).** A throw that is not an `AvlVerifyError`
can escape mid-operation: the recursion residual's `RangeError`, or D1's invariant
`Error`. The core's traversal cursors (`directionsIndex`, `replayIndex`,
`lastRightStep`) have already advanced by then, while `root` is intact. The
verifier would look healthy while later operations read misaligned bits.

So the wrapper marks itself unusable before each delegation and clears the mark
after the delegation returns. This is a flag set around the call, not a
try/catch. If a call throws, the mark stays set, and every later call to
`performOneOperation`, `performLookupWithNeighbors` or `digest()` throws a plain
`Error` saying the instance is indeterminate and must be discarded. That result is
never `{ success: false }`: a thrown engine error is not a rejection. API.md says
to discard the instance.

**Why returned buffers are copies.** A returned buffer that aliased a live leaf,
once mutated by the caller, would flow into later operations of the same verifier.
For example, `addNode` rebuilds the neighboring leaf from its live value, which
corrupts the post-state digest; the reviewer confirmed this by probe. The batch
functions escape this only because their verifier dies with the call.

**One interface, two asymmetries (I4).** `performOneOperation` returns the
prover's `ProverOperationResult`, reused on purpose. With identical signatures on
`BatchAVLProver` and `BatchAVLVerifier`, a consumer can drive its state transition
against either side through one interface; that is the Notis node/leaf split. The
two sides agree step for step only while every operation succeeds:
- **A failed operation.** The prover rolls back the operation's bits and carries
  on (`batch-prover.ts:323-334`), so the proof omits it. The verifier fails and
  poisons on the same operation (`batch-verifier.ts:306-312`). A state transition
  that issues a failing operation and continues therefore produces a proof the
  verifier can never replay. `{ success: false }` must be fatal to the block on
  both sides.
- **A sentinel key.** The prover throws `'operation-key-out-of-bounds'`; the
  verifier fails and poisons.

API.md states both, and the report to Notis main repeats them.

**Not changed:** `verifyAvlBatch`, `verifyAvlBatchPartial` and `verifyAvlLookup`
keep their implementation. They are not rebased onto the public class; the only
edit is the core's new name.

**Recursion residual.** Operations on the public verifier inherit the documented
recursion residual: on a pathologically deep proof, `modifyHelper` /
`deleteHelper` may escape as `RangeError`. That result is indeterminate, never a
rejection, and it leaves the instance unusable as above. A small
`config.maxNumOperations` caps the reconstructed node count, and so the depth.
The cap is roughly `(maxNumOperations + maxDeletes) × (2·height + 1)`
(`proof-decode.ts:154`), so it only helps when those values are small.

### D4 — Prover neighbor lookups (`batch-prover.ts`)

```ts
performLookupWithNeighbors(key: Uint8Array): NeighborLookupResult
unauthenticatedLookupWithNeighbors(key: Uint8Array): NeighborLookup
```

**Recorded** (`performLookupWithNeighbors`): `perform({ tag: 'Lookup', key },
observer)`, as in D1.
- It throws exactly what `performOneOperation` throws for that `Lookup`: the −inf,
  then +inf, `'operation-key-out-of-bounds'` gates, then the
  `'operation-key-length-mismatch'` gate, in the reference order. That includes the
  documented quirk that a short all-zero key fires the −inf gate.
- It records the same direction bits and node visits.
- It returns `{ success: false }` exactly when `performOneOperation` would, namely
  a label stub on the path of a tree installed with `restoreRoot`, with the same
  direction rollback.
- An internal node without a key throws the plain `Error` that
  `nextDirectionIsLeft` already throws (`batch-prover.ts:192-196`), unchanged.

**Unrecorded** (`unauthenticatedLookupWithNeighbors`):
- It validates the key with the same three gates, same order and same codes. The
  gates move verbatim out of `performOneOperation` into a private `validateKey`
  that `perform` and this method both call; this extraction does not change
  behavior.
- **Why it validates, unlike `unauthenticatedLookup`** (which validates nothing and
  is unchanged). Without the gates, an all-zero key would come back as "absent,
  below the first key", and an all-`0xFF` key as "absent, past the last key",
  while the recorded path throws for both. API.md documents the two unrecorded
  lookups side by side: one returns `null` where the other throws.
- It walks iteratively with the recorded path's descent rule: compare with the
  internal node's key; on equal, go right once, then left to the leaf. It uses the
  recorded path's match rule, where "found" means an internal node's key equaled
  the lookup key. On a well-formed tree this equals `leaf.key === key`.
- It writes no prover state (no directions, no visits, no proof-cycle effect) and
  reads only the root.
- A label stub, or an internal node without a key, on the walk throws a plain
  `Error`, in either descent mode. That tree breaks the invariant and is
  reachable only through `restoreRoot`. This is the same class as
  `removedNodes`' invariant throws; reporting a guessed neighbor would be worse.

### D5 — `PersistentBatchAVLProver` pass-throughs

The wrapper already mirrors `performOneOperation` and `unauthenticatedLookup`. It
mirrors both new methods the same way: one-line delegations to `this.prover`.

### D6 — Exports (`index.ts`)

Additions only; nothing is removed or renamed:

- `BatchAVLVerifier` (from `./verify.js`);
- `type NeighborLookup` and `type NeighborLookupResult` (from `./neighbors.js`);
- `type AvlVerifyFailReason` (from `./errors.js`), now reachable through
  `getLastFailReason()`.

The union is exposed unchanged, with all 11 members. Promoting it would be the
moment to prune members that are never produced; keeping them costs a consumer
nothing and keeps this release additive. Three members are never produced, and
facts documents the truth instead of the current claims:
- **`'tree-poisoned'`:** facts claims it for "called after a prior failure". It
  is assigned only through the `??=`, and every `root = null` site sets a
  non-null reason first, so it never lands.
- **`'empty-tree'`:** it appears only in its declaration. facts claims it for
  "null root".
- **`'operation-required-but-not-allowed'`:** already documented as reserved.

The other eight reasons are each produced somewhere.

**Additive gate (I5).** The bundled `dist/index.d.ts` ends in a single
`export { … }` line, and some of its JSDoc names the renamed class, so a
line-level "added lines only" diff cannot pass. The gate instead checks, against
the published 0.4.0 tarball:
- every 0.4.0 declaration is present with unchanged text, JSDoc aside;
- the new export list is a superset of the old one.

### D7 — What a neighbor report guarantees (for facts and API.md)

**Verifier.** Success means two things:
- The leaf lies in the tree the current digest commits to, authenticated through
  the label chain to the root.
- One local check passed: `keyMatchesLeaf`, on every lookup. For an absent key,
  `leaf.key < key < leaf.nextLeafKey`. For a present key, only `key == leaf.key`:
  like both references, the verifier does not check `nextLeafKey` on a match, so a
  present key's `nextKey > key` rests on the digest's provenance, as adjacency does
  (corrected in the whole-branch review: a present key's nextLeafKey is not
  checked, as in both references).

**"No key lies between the reported neighbors"** is the tree's sorted-linked-list
invariant: each leaf's `nextLeafKey` is its successor's key. The digest commits to
that list, and every valid operation preserves it, starting from the empty tree.
The verifier does not and cannot re-check the global shape. The guarantee
therefore holds for digests with honest provenance, such as consensus-agreed
state roots, which is Notis's case. facts states this explicitly.

**Range walk (API.md recipe):**
1. Look up the range's lower bound. Clamp it to `0x00…01`: the all-zero key
   throws on the prover and poisons the verifier.
2. Look up each reported `nextKey` while it is inside the range.
3. Stop at `nextKey === null` (end of tree) or at the first key past the range.

Every step is a `Lookup` in the proof. The producer's recorded walk and the
leaf's verifier walk must therefore issue the same keys in the same order, which
they do when both run the same state transition. A producer may equally build the
proof with `generateProofForOperations` over plain `Lookup`s: the bytes are the
same.

## Pre-existing defects (fixed in 0.5.0)

The design and review surfaced three defects in shipped 0.4.0 code. This work
neither introduces nor depends on them, and each fix changes no proof, digest or
codec bytes. Each changes existing behavior only on paths that are already broken.
The user decided on 2026-09-29 to fix all three with the fixes below. Each fix is
its own TDD task and commit, separate from the additive work.

**P1 — The prover retains the caller's key buffers (reachable with honest use).**
- **Mechanism.**
  - `newInternal` stores `key` by reference (`node.ts:124-131`), while `newLeaf`
    copies all three byte arguments with `new Uint8Array(...)` (`node.ts:105-113`).
  - `addNode` passes the operation's own key into that slot
    (`modify.ts:362`, `newInternal(..., newKey)`, where `newKey` is `op.key`).
  - Rotations then carry the same reference into new internal nodes.
  - The storage decoder has the same defect for Node callers: `takeBytes` uses
    `b.slice(...)` (`serialize.ts:238`), a view when `b` is a `Buffer`, and
    `deserializeInternal` stores that view as the key (`serialize.ts:213`).
- **Effect.** A caller that reuses a key buffer after an `Insert` silently rewrites
  an internal node's key.
  - The prover navigates by that key, so lookups and later operations go wrong.
    The reviewer's `probe-review-3.ts` shows `unauthenticatedLookup(20)` going from
    `[20]` to `null`, and a recorded lookup whose proof the verifier then rejects.
  - `serializeNode` persists the corrupted key.
  - Both D4 walks inherit this.
- **Exposure.** Only the step route is exposed, because `deepCloneNode` copies keys
  (`batch-prover.ts:687`). The step route, with a storage backend, is exactly what
  the Notis node uses.
- **Fix:** `newInternal` copies its key: `key === undefined ? undefined :
  new Uint8Array(key)`.
  - It is one line and the root cause: the node constructors' copy contract,
    which facts already claims, applied to the one argument that escaped it.
  - It closes the `addNode` path, the decoder path and consumer-built nodes
    together.
  - Internal keys are not in labels or proofs, and the codec writes the same
    bytes, so nothing observable changes except identity. A key-less node stays
    key-less.
  - `newInternal`'s JSDoc and facts' `newInternal` bullet state the copy.
- **Rejected alternative:** copy `op.key` at `perform`'s entry. It leaves the
  decoder path and consumer-built nodes open.

**P2 — A stale `found` after a failed or thrown prover operation (invariant
violations only).**
- **Mechanism.**
  - The prover resets `found` only inside `keyMatchesLeaf`
    (`batch-prover.ts:223-224`).
  - An operation can leave it set: one that fails after an equality step because
    a label stub sits on its found-mode path, or one that throws after an
    equality step (the key-less-internal throw at `:192`, or a `RangeError`).
  - The next operation then descends all-left and mis-answers. The author's probe
    shows `Lookup(20)` returning the −inf sentinel's empty value; the reviewer's
    `probe-review-5.ts` shows the thrown case.
- **Reference.** `ergo_avltree_rust` @`568e7c3` has the same shape: its
  `perform_one_operation` error path (`batch_avl_prover.rs:127-139`) does not
  reset `found`. Its own `bail!` at `authenticated_tree_ops.rs:428` calls reaching
  a label in a prover "a bug".
- **Fix:** set `found = false` at `perform`'s entry, after the shape gates and
  before the descent.
  - It is a no-op on every well-formed flow, where `found` is always already false
    at entry.
  - It covers failed returns and throws alike.
  - Against the reference it is a deliberate divergence, observable only on
    stub-bearing trees; facts records it as such.

**P3 — Prover state after an engine throw (invariant violations and resource
exhaustion only).**
- **Mechanism.** The direction rollback runs only on `!modifyResult.ok`. A throw
  mid-operation leaves:
  - the aborted operation's partial direction bits;
  - for a `deleteHelper` throw, the modify pass's visits already recorded.

  The next `generateProof()` would encode them.
- **Fix: a proof-cycle fail-stop**, the prover-side twin of D3's I6 mark.
  - `perform` sets a private mark after the shape gates (an `AvlVerifyError` throw
    changes no state and never sets it). It clears the mark on both normal returns,
    success and `{ success: false }`. This is a flag around the call, not a
    try/catch; an engine throw leaves the mark set.
  - While the mark is set, the four methods that read or extend the polluted
    cycle state throw a plain `Error`: `performOneOperation`,
    `performLookupWithNeighbors`, `generateProof()` and `removedNodes()`. The error
    says the proof cycle is indeterminate, and to call `restoreRoot()` or discard
    the prover.
  - `restoreRoot()` clears the mark, since it already rebases the whole cycle
    (directions, modified nodes, `oldTopNode`). `PersistentBatchAVLProver.rollback`
    routes through it, so the persistent wrapper recovers the same way.
  - Methods that read only `_root` / `_height` keep working, because the root is
    still the pre-operation state: `digest()`, `unauthenticatedLookup`,
    `unauthenticatedLookupWithNeighbors`, `generateProofForOperations` (it clones
    the root) and the getters.
  - **Atomic commit (rev 4).** `runOperation` assigned the new root before
    `applyHeightDelta`, which throws on an engine inconsistency
    (`batch-prover.ts:353-354`, `362-363` at `3d48cd1`). A throw at that check
    therefore half-committed the operation. The plan reviewer's probe showed it:
    `restoreRoot` of a 1-key tree with height 0, then `Remove`, throws, and
    afterwards `root` and `digest()` have already moved.
    The fix computes the height first, then assigns root and height together.
    It makes the previous bullet true for every engine throw.
  - The wrapper's `generateProofAndUpdateStorage` fails through its inner
    `generateProof()` and, typically, the backend's `removedNodes()`.

## Test plan

TDD per `CLAUDE.md`: each item is RED before its code exists. General rules:
- Tests are seeded and deterministic, and cover key lengths 32 and 65.
- They use no `Buffer` or `node:*` in logic that must run under jsdom.
  File-system fixture loading follows the existing corpus tests.
- Random trees include removals, so emptied trees and trees reshaped by deletes
  are covered (the reviewer's `probe-review-1.ts` shape).
- Random operation batches are drawn only from operations that succeed against
  the evolving key set:
  - `Insert` of an absent key;
  - `Update` / `Remove` of a present key;
  - `UpdateLongBy` over 8-byte values with an in-range delta;
  - `InsertOrUpdate`, `RemoveIfExists`, `UnknownModification` and `Lookup` freely.

1. **Recorded neighbor lookup produces a plain `Lookup`'s proof bytes.**
   - Setup: random trees, with lookup keys that are present, absent, the first
     and the last real key, and the keys either side of each sentinel
     (`0x00…01` and `0xFF…FE`).
   - Batches mix lookups with every modification variant.
   - Prover A uses `performLookupWithNeighbors` at the lookup positions; prover B
     uses `performOneOperation({ tag: 'Lookup' })`.
   - `generateProof()` bytes, digests and returned values are equal.
2. **A neighbor lookup consumes the proof exactly as a plain `Lookup` does.**
   - Over the same generated proofs (all operations succeeded on the prover), two
     `BatchAVLVerifier`s replay the same operations: one with neighbor lookups,
     one with plain `Lookup`s.
   - Per-operation results match, the digest matches after every operation, and
     the final digest equals the prover's. `verifyAvlBatch` agrees.
3. **The neighbors are right.** Against the sorted key list, for the recorded
   prover, the unrecorded prover and the verifier:
   - present: `nextKey` is the successor, or `null` at the end;
   - absent: `prevKey` is the predecessor, or `null` below the first key, and
     `nextKey` is the successor, or `null` past the last key;
   - the empty tree reports two `null`s.
   - The unrecorded result deep-equals the recorded one.
4. **The neighbors are authenticated.**
   - A proof whose leaf carries an altered `nextLeafKey` leaves the verifier
     poisoned from birth, with reason `'digest-mismatch'`.
   - A valid proof for a lookup of `k1`, replayed as a neighbor lookup of `k2`
     (whose predecessor is a different leaf), fails with `'leaf-key-out-of-order'`.
   - A neighbor lookup whose direction bits are truncated fails with
     `'directions-exhausted'` and poisons.
5. **A proof built step by step equals one built in one go.**
   - `performOneOperation` × N then `generateProof()`, against
     `generateProofForOperations(ops)` on the same starting tree: byte-for-byte
     equal proofs and equal digests.
   - Batches are random successful ones mixing all eight variants, starting from
     a proof-cycle boundary.
   - A second case pins the documented precondition: with operations pending,
     the two routes differ.
6. **65-byte keys.**
   - Items 1–5 run at `keyLength` 65 as well as 32.
   - The node codec round-trips a 65-byte tree's leaves and internals
     (`serializeNode` / `deserializeNode`, both value-length modes) with its
     length checks intact.
7. **Public verifier contract.**
   - Construction throws `AvlVerifyError` on a bad config or a wrong digest
     length, with the same codes as `verifyAvlBatchPartial`.
   - Poisoned from birth: `digest() === null`, the reason is set, and every
     operation fails.
   - A shape throw does not poison: a valid operation after it still succeeds.
   - A sentinel key fails and poisons with `'key-out-of-bounds'`.
   - After any failure, every later operation fails and the first reason is kept.
   - Returned values, neighbor keys and digests are copies: mutating them leaves
     later results and digests unchanged.
   - Mutating the caller's `proof` or `config` after construction changes
     nothing. The caller's proof is also passed as a jsdom-safe `Uint8Array`
     subclass whose `slice` returns `subarray`, which pins the
     `new Uint8Array` copy against `Buffer`-like callers.
   - **Unusable after an engine throw.** A deep-spine proof with a matching
     digest is built with the builders in `verifier-adversarial-recursion.test.ts`,
     and an operation descending it throws `RangeError`. Every later call then
     throws; none returns `{ success: false }`.
8. **Rust byte-equality for the public verifier.**
   - Every corpus fixture (`test/fixtures/avltree/`, 50 files) is driven step by
     step. Success fixtures reproduce the expected per-operation results and final
     digest. Adverse fixtures fail, at construction or at an operation.
   - The partial fixture (`test/fixtures/partial/`) fails at its recorded
     operation index, with the pre-failure digest as the last healthy `digest()`.
9. **Prover-side specifics.**
   - The throws from `performLookupWithNeighbors` and
     `unauthenticatedLookupWithNeighbors` equal `performOneOperation`'s, code and
     order, including the short all-zero key.
   - Unrecorded calls interleaved with recorded ones leave the next
     `generateProof()` byte-identical to a run without them.
   - A label stub on the path gives `{ success: false }` (recorded) and a thrown
     `Error` (unrecorded).
   - The unrecorded walk throws on a key-less internal node in both descent modes.
   - The `PersistentBatchAVLProver` pass-throughs return what the inner prover
     returns.
   - **P1.** Inserting from a scratch key buffer, then mutating the buffer, leaves
     the recorded and unrecorded lookups, `generateProof()` bytes and
     `serializeNode` output unchanged. A node decoded from a `Buffer`-like input
     (a `Uint8Array` subclass whose `slice` returns `subarray`) keeps its key when
     the source is mutated afterwards.
   - **P2.** On a `restoreRoot`-installed tree with a stub on a found-mode path:
     - the failing `Lookup` is followed by a `Lookup` of another key that returns
       the right value;
     - the same holds after the key-less-internal throw.
   - **P3.**
     - After an engine throw (the key-less internal node on a `restoreRoot` tree),
       `performOneOperation`, `performLookupWithNeighbors`, `generateProof()` and
       `removedNodes()` throw.
     - `digest()` and the unrecorded lookups still answer from the pre-operation
       root.
     - `restoreRoot()` clears the mark, and a following operation plus
       `generateProof()` verify.
     - An `AvlVerifyError` shape throw sets no mark.
10. **Existing suites stay green with no fixture or expectation edited.** The
    rename edits the imports and constructor calls in `verifier-key-bounds.test.ts`;
    neither is an expectation. `test:browser` (jsdom, `test/**/*.test.ts`) picks up
    every new file automatically.

## Files touched

- **New:**
  - `src/neighbors.ts`;
  - test files for items 1–9, one per concern.
- **Code:**
  - `src/batch-verifier.ts` (rename, `perform`, observer, the core's lookup-at-leaf
    method);
  - `src/verify.ts` (the core's new name, the public class);
  - `src/batch-prover.ts` (`perform`, observer, `validateKey`, the two methods, P2
    and P3);
  - `src/persistent-prover.ts`;
  - `src/index.ts`;
  - `src/node.ts` (P1: one code line plus its JSDoc).
- **Comments only:** `src/modify.ts`, `src/delete.ts` and `src/errors.ts`. The
  rename touches all three; `errors.ts` also updates the JSDoc that says
  `AvlVerifyFailReason` is not public.
- **Tests:** `test/verifier-key-bounds.test.ts` (the rename).
- **Docs:**
  - `facts/avltree.md`, first. It covers:
    - the scope list and surfaces;
    - the failure model, with the reason-reachability truth and the
      engine-throw fail-stop;
    - the guarantee (D7) and the one-interface asymmetries;
    - "Does NOT ship";
    - the source-mapping rows: `BatchAVLVerifier` maps to
      `batch_avl_verifier.rs::BatchAVLVerifier`, and the neighbor methods are
      TS-only, with no dedicated counterpart.
  - `packages/avltree/API.md`, `packages/avltree/README.md` (re-pin its "374
    tests"), the root `README.md` row, `SESSION_CONTEXT.md` and `HANDOFF.md`, at
    close.
  - `CLAUDE.md`'s common-gotchas list: `Buffer#slice` is a view, so copies of
    caller buffers use `new Uint8Array(...)`.
- **Release:** `packages/avltree/package.json` (0.5.0) and the facts version lines.

Each implementation task touches at most five files (OVERRIDES rule 2). The plan
splits the rename into code and comment commits for that reason.

## Release

- **Version.** 0.5.0, a minor bump: additive only. `RELEASING.md`'s per-package
  checklist and pre-publish dry-run apply.
- **Lockfile.** Leave `package-lock.json` untouched, as prior avltree bumps did:
  its workspace entry still reads `0.2.0`. `RELEASING.md`'s open note (next
  bullet) already describes how a fresh `npm install` could re-resolve
  ergoscript's avltree dependency. Do not run one as part of this release.
- **ergoscript.** The pin note in `RELEASING.md` (open as of 2026-09-29) stays
  ergoscript's release step. ergoscript calls only `verifyAvlBatchPartial` and
  the types, so it is unaffected.
- **Publish.** On the user's go only. Confirm the registry write, allowing for the
  CDN 404 read-lag.
- **Report to Notis main.** Then report in kitty window 1, after checking the id
  with `kitty @ ls`. Use the prompt's three-command form: the message, `sleep 2`,
  then the Enter as its own command, never chained.
  - The message names the new API in one line.
  - It carries the D3 asymmetry: `{ success: false }` must be fatal to a block on
    both sides.
  - It notes P1–P3 as fixes in the release. P1 matters most for the node: before
    0.5.0, reusing a key buffer after an `Insert` corrupted the prover's tree.
  - If blocked, or if a fixture wants to move, send the question in the same form.

## Out of scope

- A range operation, a ninth `Operation` variant, or any change to the proof
  format.
- Neighbor reporting on modifications. Only `Lookup` reports neighbors.
- Neighbor lookups on the functional batch API. The step-by-step verifier covers
  the use case.
- Changes to ergoscript, including its avltree pin.
- The `modifyHelper` / `deleteHelper` recursion residual. It is unchanged, and
  inherited by the new class, which fails stop on it.
- Pruning the failure-reason union.

## Risks

- **The observer's "exactly once" rests on the engine's single call site.** It is
  pinned by D1's count check and by test 3. Byte identity (tests 1–2) cannot see a
  double call.
- **Exposing `AvlVerifyFailReason` freezes an 11-member union as public API.**
  Adding a member later is a minor bump that can break consumers' exhaustive
  `switch`es.
- **The verifier's `performOneOperation` returns `ProverOperationResult`.** The
  name is the cost of one shared signature; API.md says why, and states D3's two
  asymmetries.
- **The neighbor guarantee is conditional on the digest's provenance (D7).**
  Consumers who verify against digests of unknown origin get
  authenticated-but-not-necessarily-adjacent neighbors. facts and API.md say this.

## Verification

- `npm test` and `npm run typecheck` from the repo root, both green;
  `npm run test:browser -w @ergots/avltree` green.
- `git diff -- packages/avltree/test/fixtures` empty.
- `git diff` of `modify.ts`, `delete.ts` and `errors.ts`: comment lines only.
  `node.ts`: exactly P1's code line plus its JSDoc, and the header `@see` line.
- The `dist/index.d.ts` additive gate (D6, as redefined).
- `npm pack --dry-run --workspace @ergots/avltree`: LICENSE present.
- **Path leaks (`RELEASING.md` / OPS-04).**
  - The published 0.4.0 `dist/index.d.ts` carries four
    `@see ~/projects/ergo_avltree_rust/…` JSDoc lines, from the headers of
    `node.ts`, `batch-prover.ts` and `verify.ts`. The plan review found them.
  - The user decided on 2026-09-29 to fix them in 0.5.0: the three header
    comments are rewritten without the home path, and the gate is a count of 0.
  - Out of scope: the shipped `src/` still carries the path in comments of
    eight files, four of them engine files this spec keeps untouched. That is a
    possible follow-up.
