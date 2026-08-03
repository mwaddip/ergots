# Phase D — `removedNodes()` storage-GC API

**Date:** 2026-08-03 (rev 2, 2026-08-04 — spec-review findings F1–F8 applied;
review at `.superpowers/sdd/2026-08-03-avltree-phase-d-removed-nodes/`)
**Parent:** `2026-08-02-avltree-remediation-umbrella-design.md` (finding 18;
"Phase D — `removedNodes()` storage-GC API")
**Branch:** `avltree-0.4.0` (continues from C; base `c4f6344`)
**Status:** approved design, spec-reviewed (APPROVE-WITH-FIXES, applied),
pre-implementation

## Goal

Give `VersionedAVLStorage` implementers a way to learn which persisted nodes
left the tree during the current proof cycle, so they can prune them instead of
accumulating orphans forever. DAGsocial's `SqliteAvlStorage` is the motivating
consumer. Additive, not corrective: no existing behavior changes, no breaking
surface.

The reference (`ergo_avltree_rust`, canonical `main` `568e7c3`) exposes
`BatchAVLProver::removed_nodes()`. ergo-node-rust's redb storage builds its
per-block delete list from it; the comment above the persist step in
`validation/src/utxo.rs` (step 7, "Must precede generate_proof()", verified
2026-08-03) records what happens with the call ordered after
`generate_proof()`: zero deletions ever, 235 GB of orphaned nodes by height
~1.66M.

## The framing decision: output contract, not mechanism port

The umbrella phrased D as "port Rust's `changed_nodes_buffer` /
`changed_nodes_buffer_to_check` tracking". Source-reading the reference showed
that mechanism is welded to Rust's mutate-in-place node model, and that our
engine's immutability (verified and locked in Phase C) supports a derivation
with identical-or-safer output and no engine changes. User decision 2026-08-03:
**the contract is the output — storage implementers get the correct
removed-node set — not the buffer mechanism.** Grounds:

- Rust collects candidates during `on_node_visit`, gated on per-node
  `visited` / `is_new` flags (`authenticated_tree_ops.rs`, `on_node_visit`).
  Our nodes have no such flags; `is_new` ("created this cycle") has no cheap
  equivalent in an immutable engine. A faithful port would need the shared
  engine (modify.ts / delete.ts / rotation.ts) to report node *creations*
  through new callbacks, where one missed creation site means storage deletes
  a live node — silent database corruption.
- Immutability hands us what Rust's flags approximate: `oldTopNode` still
  roots the *pristine* pre-cycle tree, and `modifiedNodes` already records
  exactly which of its nodes the cycle touched.
- This is storage GC, local to a consumer's database. Nothing
  consensus-visible depends on it, so the consensus-faithfulness rule
  (match accept/reject exactly) does not bind; the divergences that result
  are documented below and are each strictly safer.

## Deliverables

### D1 — `BatchAVLProver.removedNodes(): AvlNode[]`

Public, additive. Returns the old-tree nodes (leaves and internals) whose
labels are absent from the current tree — the rows a storage backend should
delete.

**Semantics (the contract):** the returned set equals the exact set difference

    { nodes reachable from the previous cycle's root }
  − { nodes whose label is reachable from the current root }

**Algorithm:** pre-order walk from `oldTopNode`.

- Node not in `modifiedNodes` → prune the whole subtree. An unvisited node's
  subtree is untouched this cycle and therefore shared with the current tree
  by structural sharing; nothing under it can have been removed.
- Node in `modifiedNodes` → candidate. If `containsLabel` (D2) reports its
  label absent from the current tree, collect it. Recurse into children
  either way.

**Ordering contract:** call after the batch's operations and **before**
`generateProof()` / `restoreRoot()`. Both rebase the cycle (`oldTopNode ←
root`, `modifiedNodes ← ∅`), after which the walk prunes at the root and
returns `[]` — the same observable behavior as Rust's cleared buffers, and the
same ordering requirement whose violation produced the ergo-node-rust orphan
incident. `PersistentBatchAVLProver.generateProofAndUpdateStorage` already
runs `storage.update(prover, …)` before `generateProof()` (the canonical
order), so implementers who call `removedNodes()` inside `update()` are
correct by construction. No `PersistentBatchAVLProver` wrapper method — the
reference has none; storage receives the prover.

Calling mid-batch is allowed and pure: it returns the diff as of the current
tree and does not perturb later calls. (In the reference, a mid-cycle call
permanently changes the final answer — it moves currently-absent `to_check`
entries into the definite buffer, where they are never re-checked, so a later
same-cycle reinsert that would have saved them no longer does. Spec-review
F4.)

**Result properties:** idempotent and pure (Rust's `removed_nodes()`
self-appends resolved `to_check` entries on repeat calls; ours re-derives).
Order of returned nodes unspecified — consumers treat it as a set. Returned
nodes are live tree objects, `readonly` by type, **not** defensively copied:
C7's copy rule protects live *value buffers* handed out of leaves; here the
node itself is the datum and nodes are immutable. JSDoc says "do not mutate";
the trust model for type-unsafe callers is the parked whole-branch item, not
D's problem.

**No `collectChangedNodes` constructor flag.** Rust gates collection because
its buffers cost memory during every cycle whether consumed or not; the walk
costs nothing until called, so there is nothing to opt out of. Consequence:
where Rust with `collect_changed_nodes = false` returns `[]`,
we always return real data (superset behavior, documented). This also keeps
`generateProofForOperations`' internal clone prover untouched (Rust passes
`false` there; we have no flag to pass).

### D2 — `containsLabel` (private helper)

Port of the reference's `contains` / `contains_recursive` (`batch_node.rs`;
construct-name citation per this spec's citation policy): given a candidate
node, descend the *current* tree by the candidate's key — standard prover
descent: on key-equal, one step right, then left to the leaf — comparing the
32-byte label at every node on the path; label match → `true`.

- `LabelNode` stub on the path → fail-safe `true`. Inside an unresolved
  subtree we cannot prove absence, and deleting a node still referenced from
  it leaves dangling parent→child references on disk. The reference documents
  exactly this hazard; port the comment.
- Mismatched leaf → `false`.
- Internal candidate with `key === undefined` → throw the same invariant
  `Error` style as `buildCallbacks`' `nextDirectionIsLeft` (engine guarantees
  keys on internal nodes; undefined means the tree is inconsistent).
- `LabelNode` *candidate* (kind `'label'` in `modifiedNodes` — reachable only
  through a failed op against a stub-bearing `restoreRoot` tree, whose
  delete-phase entry visits precede the kind guards) → the same invariant
  `Error`: a stub carries no `key`, so the descent cannot start, and the
  reference panics on the identical input (`contains` unwraps the candidate's
  key, `None` for a `LabelOnly` header). Throwing rather than skipping keeps
  both key-less shapes on one code path. (Spec-review F2.)

Both D1 and D2 live in `batch-prover.ts` beside `unauthenticatedLookup`, which
uses the same walk idiom. `tree-traversal.ts` is verifier-side state and stays
untouched.

**Labels:** obtained via `label()` — memoized on the node. Old-tree labels are
typically cached from the previous cycle's `digest()`; current-tree labels
computed here are exactly the hashing `update()` / `digest()` needs moments
later, so no duplicated work in the persistent flow.

**Cost:** O(visited) node touches for the walk plus O(log n) per visited node
for `containsLabel`, once per batch, at call time only.

### D3 — the invariant the walk rests on

> Every old node that left the tree is in `modifiedNodes`, and so are all of
> its old-tree ancestors.

This holds because the engine visits the full path of every *successful*
mutating operation — post-order on the modify unwind; pre-order at entry on
the delete pass and both fixup spines, matching the reference's visit
placement (the walk consumes membership only, so visit *order* is irrelevant
to D) — including delete's double descent and the predecessor-leaf
`nextLeafKey` fixup, which is precisely the bookkeeping Phase B's 6b
repaired. Two corollaries the design leans on:

- **Failure paths cannot contaminate the result.** Every failure reachable on
  a well-formed tree exits before its first visit: modify-phase precondition
  failures (Insert on an existing key and kin) fail in the leaf arms ahead of
  any visit, and ancestor visits fire only after child success. The
  delete-phase and rotate-guard failure exits *do* sit after visits, but they
  are reachable only through an invariant-violating `restoreRoot` tree; even
  then the tree is unchanged on failure, so every contaminated candidate is
  still live and `containsLabel` excludes it — except a visited stub, which
  D2's label-candidate throw covers. (Spec-review F1.)
- **This-cycle nodes are excluded structurally**: they are unreachable from
  `oldTopNode`, so the walk never considers them. No `is_new` equivalent is
  needed.

The prover consumes `onNodeVisit`'s node argument only; the `operation` and
`isRotate` parameters stay unread on the prover side (the verifier already
ignores them). 6b's visit-site repairs remain load-bearing through
`modifiedNodes`; the `isRotate` *flag* stays decorative — noted here so nobody
"cleans up" the parameter while D depends on the calls.

The property oracle in the test plan is the net under this invariant: any
visit-discipline hole surfaces as a set-diff mismatch.

### D4 — contract and docs (phase convention)

- `facts/avltree.md` opens the phase (contract-first): `removedNodes()`
  surface row, the set-difference semantics, ordering/idempotence/`[]`
  states, divergence entries (below), Source Mapping rows for
  `removed_nodes` → derived walk and `contains_recursive` → `containsLabel`.
- `README.md` + `API.md` close the phase with the new surface and a
  storage-GC usage sketch.
- One comment correction folded into the implementation pass (spec-review
  F7): `delete.ts`'s `deleteInner` visit-placement comment justifies itself
  by "order-sensitive `removedNodes()` bookkeeping a later phase hangs off
  these call sites" — written for the buffer port the umbrella originally
  envisioned. The derived walk consumes a `Set`; rewrite the rationale to
  reference-placement fidelity only.

**Divergences from the reference, all documented in facts/ as deliberate:**

| # | Divergence | Why safer / acceptable |
|---|---|---|
| 1 | Derived walk instead of collect-at-visit buffers | Output equals the true set difference; no engine callbacks; no silent-miss corruption class |
| 2 | Remove-then-reinsert an identical leaf in one cycle: Rust's "definite" buffer deletes a label still live in the final tree; we keep it | Matches the set-diff. Rust's answer corrupted storage when consumed naively: ergo-node-rust survives this edge only via `update_internal`'s written-labels overlap guard (`state/src/storage.rs`, added after its "v0.4.x at-tip state corruption"; verified 2026-08-04). The set-diff answer needs no guard |
| 3 | Idempotent and mid-cycle-safe; Rust's repeat calls self-append, and a mid-cycle call permanently poisons the final answer (absent-at-midpoint `to_check` entries move to the definite buffer, never re-checked) | Pure derivation, snapshot semantics |
| 4 | No `collectChangedNodes` flag; Rust with `false` returns `[]` | Nothing to opt out of; superset behavior |
| 5 | Lookup-heavy cycles pay walk+contains cost where Rust skips Lookup visits at collection | Cost-only divergence; output identical (`[]` for lookup-only cycles) |

**Reference-parity notes (not divergences):** the never-persisted first-cycle
sentinel leaf is reported as removed by **both** implementations (Rust's
constructor clears `is_new` on it via `tree.reset()`); storage must tolerate
deleting absent rows.

**DAGsocial routing note (user routes; we do not edit that repo):** additive.
`SqliteAvlStorage.update` may add `DELETE … WHERE label IN (…)` from
`removedNodes()` labels (via the exported `label()`); must tolerate absent
rows; must not mutate returned nodes; ordering is correct by construction
through `PersistentBatchAVLProver`. Because the returned set never contains a
label live in the final tree (divergence row 2), writes and deletes are
disjoint and a plain write-then-delete needs no overlap guard — the guard
ergo-node-rust had to add is exactly what the set-diff semantics make
unnecessary. Write-side node enumeration stays probe-by-label (out of scope
below).

## Test plan

Fixture-first TDD, in the phase's task order:

1. **Rust vectors** (fork worktree off canonical `main`, Phase A/B pattern —
   the frozen repo-root `fixture-gen/` is not involved): a Rust-side test
   emits `removed_nodes()` label sets for scripted sequences — insert-only,
   insert+remove, rotation-heavy, update ops, multi-cycle with
   `generate_proof` between, rollback via `restore_root`, lookup-only
   (empty). Sequences avoid divergence row 2 (remove-reinsert) so vectors
   assert clean label-set equality. **Emitter call discipline (spec-review
   F5):** per cycle, capture the `removed_nodes()` label set exactly once,
   before `generate_proof()` / `restore_root()` — `generate_proof` clears
   the buffers as its first statements and repeat calls self-append, so a
   misordered or double-probing emitter silently yields empty or duplicated
   vectors. Committed under `packages/avltree/test/fixtures/`.
2. **Conformance tests:** TS replays each sequence, asserts
   `removedNodes()` label set equals the vector's.
3. **Property oracle:** randomized op sequences (seeded); assert
   `removedNodes()` set-equals the brute-force difference of full old/new
   label walks. This is the direct check of the D3 invariant and of
   this-cycle-node exclusion. The oracle captures the pre-cycle root
   reference itself, before applying ops — never by reading
   `prover.oldTopNode`, so an `oldTopNode`-management bug cannot fool both
   sides (spec-review F8a). Sequences include interleaved failing ops
   (Insert on an existing key and kin) to pin the D3 failure-path corollary
   (spec-review F1).
4. **Unit REDs:** idempotence (two calls, same set); mid-batch call purity
   (call between ops, assert the final call unaffected); `[]` before any op,
   after `generateProof()`, after `restoreRoot()`; the remove-reinsert edge
   pinned as a documented-divergence test (label stays); `containsLabel`
   stub fail-safe (stub on the search path → `true`) — access route (drive
   through `removedNodes()` on a crafted `restoreRoot` tree vs a
   module-level test import) is decided in the plan, not mid-implementation
   (spec-review F8b); key-less internal candidate and `LabelNode` candidate
   invariant throws; lookup-only cycle `[]`.
5. **Suite hygiene:** new tests use unconditional assertions (no
   `if ('x' in r)` skips), per the umbrella's test-pattern rule.

## Files touched

- `packages/avltree/src/batch-prover.ts` — `removedNodes()`, `containsLabel`.
- `packages/avltree/src/delete.ts` — comment-only (spec-review F7, see D4).
- `facts/avltree.md`, `packages/avltree/README.md`,
  `packages/avltree/API.md` — contract + docs.
- `packages/avltree/test/` — new spec files + fixtures.
- Rust fork worktree — vector-emitting test (fork owned by the sigma-rust
  session; coordinate if it needs to land as a commit there rather than stay
  local to the worktree).

## Out of scope

- Write-side new-node enumeration for storage backends (probe-by-label works
  today; revisit only on a real consumer need).
- Any engine change: no new callbacks, no `AvlTreeOpsCallbacks` growth, no
  visit-site edits, no node-model flags. (The D4/F7 item edits a *comment*,
  not a visit site.)
- Proof generation and verification paths — byte-identical before/after;
  the 21 existing fixtures stand as the regression net.
- New error codes (`AvlVerifyErrorCode` unchanged; the D2 throws are
  invariant `Error`s, matching package precedent for impossible states).
- The public mutable `root`/`oldTopNode` trust model — parked whole-branch
  item, unchanged by D.
- The stale `modify.ts` dispatch comment ("Remove/RemoveIfExists … never
  reach this function" — false: Remove's first pass routes through
  `handleLeafMatch`, which is where D3 gets its first-pass visits) — parked
  to Phase E's comment/citation audit (spec-review F6); `modify.ts` is one
  of E's nine fenced files.

## Risks

- **The D3 invariant is engine behavior, not a type guarantee.** A future
  visit-site regression would silently shrink the removed set (orphans, not
  corruption — the safe direction; wrongful deletion would additionally
  require a `containsLabel` false negative, which a visit regression cannot
  cause). Mitigation: the property oracle, which fails loudly on any
  mismatch, both directions.
- **`containsLabel` must mirror prover descent exactly** (found → right →
  left-to-leaf). A routing mistake reports live nodes absent → wrongful
  deletes. Mitigation: it is a port of a small, read function
  (`contains_recursive`); vectors + oracle cover it; divergence-row-2 test
  pins the subtle case.
- **Consumer misordering** (calling after `generateProof()`) yields `[]`,
  which looks like "nothing to prune" — the ergo-node-rust failure mode.
  Mitigation: JSDoc + facts/ state the ordering contract prominently, and
  `PersistentBatchAVLProver` users get the correct order for free.

## Verification

Repo-root `npx vitest run` (bare superset run) + `npm test`; avltree package
suite green in node AND jsdom (`cd packages/avltree && npm run test:browser`);
`npm run typecheck` + package tsc clean; publint clean; all pre-existing
fixtures byte-identical; new vectors committed and reproducible from the
worktree harness.

New Rust citations in code comments pin canonical `568e7c3` with
per-construct verified ranges (bounds checked against the construct's true
start and end — Phase E discipline from day one); this spec cites by construct
name deliberately.
