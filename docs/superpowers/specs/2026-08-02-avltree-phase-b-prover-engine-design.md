# Phase B — prover engine correctness and performance

**Date:** 2026-08-02
**Status:** draft, pending approval
**Umbrella:** `2026-08-02-avltree-remediation-umbrella-design.md`
**Findings closed:** 1–7 from the 2026-08-02 audit, plus two discovered during
Phase A.

## Goal

Correct the `BatchAVLProver` engine's deviations from the Rust reference and
remove two algorithmic-complexity defects, without changing any public
signature. Add the randomised prover↔verifier coverage the package has never
had.

## Constraints

No public signature changes — those are Phase C. Every deliverable here is
internal to `batch-prover.ts`, `persistent-prover.ts`, and `node.ts`.

The provenance of this code matters to how it is reviewed. The 0.3.0 prover port
was written under a constraint where the happy path was the deliverable and the
adversarial layer was knowingly deferred (see memory
`project-avltree-deepseek-provenance`). Its 192 inherited tests are
happy-path-biased and must not be read as coverage. Review effort belongs on
unreachable-but-lethal branches, silent wraps and clamps, and vacuous
assertions — the defects below are exactly that shape, and Phase A found two
more of the same class after four review rounds had passed.

## Error taxonomy for the new throws

B3, B4 and B6 all introduce throws where the code previously degraded silently.
None of `AvlVerifyErrorCode`'s seven existing codes fits: every one describes a
shape-validation failure on the *verifier's* public entry points ("the caller
passed a bad config or a wrong-length key"), whereas these three describe
impossible internal states in the prover.

Adding codes to that union is a public-surface change, and the union is already
scheduled for rework in Phase C (finding 10 — `invalid-config-key-length`
currently covers three unrelated conditions). Introducing new codes here and
reshaping them there would churn the surface twice.

**Decision:** use `RangeError` for B3 and B6, and a plain `Error` for B4. This
follows the precedent Phase A set in `serialize.ts`, which throws `RangeError`
for exactly this class — a structurally impossible value reaching a byte write.
B6 is literally the same defect as the codec's child-label check, so it should
throw the same way. B3 is a genuine range violation. B4 is an invariant
violation with no range dimension, so a bare `Error` naming the invariant is
more honest than forcing it into `RangeError`.

No change to `AvlVerifyErrorCode` in this phase. If Phase C's error-taxonomy
rework concludes these belong in the typed union after all, moving them is a
one-line change per site at that point.

## Deliverables

### B1 — stop destroying the label cache

`clearVisitedFlags` (`batch-prover.ts:548-557`) recursively nulls `labelCache` on
every node, triggered by `needsCycleReset` after each `generateProof()`.

Rust's `Node::reset()` (`batch_node.rs`) clears `is_new` and `visited` and
**preserves `label`**; `reset_recursive` descends only into nodes that were new.
Our port clears the label instead, and unconditionally.

The cost is a full O(n) blake2b re-hash of the entire tree on the next `digest()`
after every proof — defeating the memoisation it sits beside.

It is also unnecessary. The engine is fully immutable: an exhaustive grep of
`packages/avltree/src/` finds exactly two writes to any node field — the memo in
`node.ts:204` and this clear. Every mutation path (`modify.ts`, `delete.ts`,
`rotation.ts`) constructs new nodes via `newLeaf`/`newInternal`/`newLabel`, which
start with `labelCache: null`. An unmodified node's cached label is therefore
valid for the node's entire lifetime.

**Fix:** delete `clearVisitedFlags` and its call site. `needsCycleReset` then has
no consumer — it exists solely to trigger this clear, since our equivalents of
Rust's two real reset targets are already handled (`visited` ≡ membership in
`modifiedNodes`, cleared in `generateProof`; `is_new` has no analogue in an
immutable model, per the Phase A analysis of Rust commit `b1c4374`). Delete it
too, along with the assignment in `restoreRoot`.

**Risk:** this is correct *only* while the engine stays immutable. If future code
mutates a node in place, stale labels become a silent consensus bug. Phase C's
`readonly` change on `InternalNode` hardens this at the type level; until then it
rests on the grep above. Note the invariant in the code comment so the coupling
is visible.

### B2 — modified-node tracking is O(n·m)

`wasModified` (`:477-479`) does `this.modifiedNodes.includes(node)` — a linear
scan — and `packTree` calls it once per node, so proof generation is quadratic in
tree size. `onNodeVisit` (`:222-224`) also pushes without dedup, and nodes are
revisited on descent and during rotations, so the array carries duplicates that
make each scan longer than the node count.

Rust uses a per-node `visited` boolean: O(1).

**Fix:** `modifiedNodes: Set<AvlNode>`. Reference identity is the correct
equality here — our nodes are plain objects and `Set` uses SameValueZero.
`onNodeVisit` becomes `.add()` (dedup free), `wasModified` becomes `.has()`.

### B3 — height handling hides errors

Two defects in one area:

`digest()` (`:338`) writes `this.height & 0xff`. Rust asserts `height < 256`
(`authenticated_tree_ops.rs`) with a comment explaining the bound is unreachable
in practice — a tree of height 256 needs more leaves than there are atoms on
Earth. We convert an impossible-state assertion into a silently wrong digest.

`performOneOperation` (`:313`, `:319`) clamps with `Math.max(0, this.height +
delta)`. Rust does guarded `height += 1` / `height -= 1`. The clamp masks a wrong
`heightDelta` rather than surfacing it.

**Fix:** throw `RangeError` from `digest()` when `height` is outside
`0..=255`. Replace the clamps with direct application of the delta, and throw if
the result goes negative — a negative height means the engine returned a wrong
delta, which is a bug to surface, not to round up.

### B4 — remove the invented delete-failure path

`performOneOperation` (`:305-311`) treats `deleteHelper` as fallible and, on
failure, sets `this.root = null` and `this.height = 0`.

Rust's `delete_helper` returns `(NodeId, bool)` — it is infallible, and
`return_result_of_one_operation` has no such branch. For the prover the path is
unreachable anyway (`getFailedReason()` always returns `null`). If it were ever
reached it would permanently poison the tree: `digest()` returns `null` forever
after. It also skips the direction rollback the modify-phase failure performs,
leaving `directions` corrupt.

**Fix:** replace the branch with a thrown `Error` stating the invariant
that was violated.

The type cannot be narrowed instead: `deleteHelper` returns `ModifyResult`, whose
`ok: false` arm is real and reachable — but only for the *verifier*, which shares
this engine and legitimately fails when a proof runs out of bytes. The failure is
unreachable for the prover specifically, because its `getFailedReason()` always
returns `null`. Narrowing the shared return type would break the verifier, so the
prover must handle the arm; it should do so by declaring the impossible state
loudly rather than by silently destroying the tree.

**Consequence to note, not to act on:** with `this.root = null` gone, `root` is
non-null for the object's entire lifetime — the constructor always installs a
sentinel leaf. The `root === null` guards in `digest()` (`:334`) and
`unauthenticatedLookup()` (`:351`) become dead, and `digest()`'s `| null` return
becomes unreachable. Tightening the field and return types is a public signature
change and belongs to Phase C; leave the guards in place here and record the
observation in that phase's spec.

### B5 — route rollback through `restoreRoot`

`PersistentBatchAVLProver.rollback()` (`persistent-prover.ts:70-79`) sets
`root`, `height` and `oldTopNode` by hand but leaves `directions`,
`directionsBitLength` and `modifiedNodes` from the aborted cycle. A mid-cycle
rollback followed by `generateProof()` therefore emits stale direction bits.

`restoreRoot` was added in 0.3.3 precisely to make this atomic and was never
wired in — my omission at the time.

**Fix:** call `this.prover.restoreRoot(root, height)`.

### B6 — `digest()` writes an unchecked-length label

`digest()` (`:335-337`) does `out.set(label(this.root), 0)` into a 32-byte slot.
This is the same shape as the codec defect Phase A fixed: a `LabelNode` root
whose stored digest is not 32 bytes zero-pads into a silently wrong digest, and
the `LabelNode` type does not enforce the length even though `newLabel` does.

A root that is a bare `LabelNode` is unusual but reachable — `restoreRoot` accepts
any `AvlNode`, so a storage backend can install one.

**Fix:** validate the label is exactly 32 bytes before writing; throw otherwise.

### B7 — hoist per-operation sentinel allocation

`performOneOperation` (`:244-246`) constructs `negInfKey` and `posInfKey` — plus a
`fill(0xff)` — on every call, to compare against. They depend only on
`keyLength`.

**Fix:** compute once in the constructor, store as private readonly fields, and
reuse. The constructor already builds the same two values for the sentinel leaf.

### B8 — randomised prover↔verifier property test

The package has **zero** generated-input coverage of the prover: 32 hand-picked
`performOneOperation` calls across four test files, every sequence fixed. The
Rust reference's own randomised `test_modifications` fails intermittently
(~1 in 5), which means it explores a space we cannot currently observe at all. If
one of the behaviours we mirrored carries a rare rebalancing bug, our suite stays
green regardless.

**Fix:** a seeded property test that, per iteration:

1. generates a random operation sequence (Insert / Update / Remove / Lookup)
   over a small key space, so collisions and absent-key paths occur often;
2. maintains a plain `Map` as the model of expected state;
3. applies the sequence to a `BatchAVLProver`, capturing the starting digest;
4. calls `generateProof()`;
5. feeds the proof, starting digest and the same operations to `verifyAvlBatch`;
6. asserts the verifier accepts, its resulting digest equals the prover's, and
   the per-operation old values match the model.

This closes the loop without a Rust oracle: prover and verifier share the
mutation engine but disagree on everything else, so agreement across a random
walk is strong evidence.

The PRNG must be seeded and the seed printed on failure — an unreproducible
property failure is nearly worthless. Use a fixed seed list in CI rather than
time-derived randomness, so the suite stays deterministic; the value is in
covering a wide fixed space, not in being different every run.

## Test plan

Each of B1–B7 gets tests that fail without its fix. Specifically worth stating,
because they are the ones a naive test would miss:

- **B1:** assert the label cache *survives* a `generateProof()` — capture a
  reference to an unmodified deep node, call `generateProof()`, assert its
  `labelCache` is still populated. Also assert digests stay correct across
  several proof cycles, so preservation cannot be confused with staleness.
- **B2:** correctness is unchanged, so assert the property directly — after a
  batch with repeated visits, `modifiedNodes` contains no duplicates. A timing
  assertion would be flaky; do not write one.
- **B3:** a height above 255 must throw rather than wrap. Construct it by
  setting `height` directly rather than building a real tree of that depth.
- **B4:** the path is unreachable through the public API, so do **not** write a
  test that drives it — it would assert nothing. Instead record in the test file
  why it is unreachable (`getFailedReason()` returns `null` for the prover, so
  `deleteHelper` cannot return `ok: false`), and let the removal be covered by
  the existing delete tests continuing to pass. A test that cannot fail is worse
  than no test: it reads as coverage.
- **B6:** a `LabelNode` root with a 16-byte digest, installed via `restoreRoot`,
  must make `digest()` throw rather than return a padded value.

Assertions are unconditional — never inside `if (shape) { expect(...) }`. That
pattern is how finding 8 shipped green.

## Files touched

| File | Change |
|---|---|
| `facts/avltree.md` | **Task 1** — contract first: the `digest()` throw conditions and the immutability invariant B1 depends on |
| `packages/avltree/src/batch-prover.ts` | B1–B4, B6, B7 |
| `packages/avltree/src/persistent-prover.ts` | B5 |
| `packages/avltree/test/prover.test.ts` | B3, B6 tests |
| `packages/avltree/test/prover-property.test.ts` | new — B8 |
| `packages/avltree/README.md`, `API.md` | closing task, if the `digest()` contract changed visibly |

## Out of scope

- Public signature changes, `readonly` on `InternalNode`, the error-code split,
  `compareBytes` deduplication — all Phase C.
- `removedNodes()` — Phase D.
- Rust source-citation staleness — Phase E.
- Any change to the codec Phase A delivered.

## Risks

**B1 is the load-bearing change.** Preserving labels is correct only under
immutability. The grep evidence is in this spec; the invariant belongs in a code
comment; Phase C makes it structural. If B1 and Phase C both land, the risk
closes. If Phase C slips, the risk stands.

**B8 may surface a real bug.** That is its purpose. If the property test fails on
first run, the finding is not "the test is wrong" — capture the seed and the
operation sequence, and treat it as a defect until proven otherwise. It may also
turn out to reproduce the Rust reference's `test_modifications` flakiness, which
would be a useful result for that project.

**B3 changes failure mode from silent to loud.** A consumer relying, however
accidentally, on the clamp or the wrap will now see a throw. Given the package is
pre-1.0 with one known consumer that is resetting state, this is acceptable and
is the point.

## Verification

```bash
npx vitest run
npx tsc --noEmit --project packages/avltree/tsconfig.json
npx publint packages/avltree
```

Baseline entering Phase B: 7392 passed + 1 skipped, tsc clean, publint clean.
