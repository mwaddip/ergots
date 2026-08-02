# `@ergots/avltree` remediation — umbrella design

**Date:** 2026-08-02
**Status:** approved, phases spec'd individually
**Target release:** `@ergots/avltree@0.4.0`

## Context

`@ergots/avltree` went from 0.2.x (verifier only) to 0.3.3 (verifier + prover +
storage codec) across several sessions. A post-hoc audit of that arc against the
Rust reference (`~/projects/ergo_avltree_rust`, branch `main`) found 20 defects
spanning correctness, performance, public API shape, duplication, documentation,
and test rigour.

None of the findings affect proof *verification* — the consensus-critical path is
unchanged and remains fixture-validated. The defects are concentrated in the
prover engine, the storage codec, and the public surface, all of which are newer
and less thoroughly gated.

This document records the cross-cutting decisions and the phase decomposition.
Each phase gets its own spec, written at the start of that phase.

## Constraints and decisions

**Breakage is acceptable.** `@ergots/avltree` is pre-1.0 with a single known
consumer, DAGsocial, which is mid-integration and resetting its persisted state
for unrelated reasons. This removes the migration burden that would otherwise
constrain the API and storage-format work. Confirmed with the user 2026-08-02.

**The storage codec realigns to the Rust reference.** `serialize.ts` currently
implements an ergots-native, self-describing node format incompatible with Rust's
`AVLTree::pack` / `unpack` (`batch_node.rs:503-562`). Phase A replaces it with a
byte-for-byte port. Rationale: the package's identity and test strategy is
byte-equality against Rust, and this is the only module exempt from that; the
realignment brings it under the fixture gate that CLAUDE.md requires for every
parse/serialize primitive, and yields interoperability with any Rust-side
consumer. The cost — the codec now needs tree config threaded in, since Rust
omits inline length prefixes — is acceptable now that breakage is free.

**Contract-first per phase, not a trailing docs phase.** Each phase opens by
updating `facts/avltree.md` for the surface it changes and closes with
`README.md` and `API.md`. Phase A additionally clears the accumulated 0.3.1–0.3.3
contract backlog, which shipped to npm three times with the boundary contract
frozen at v0.3.0.

**Test-pattern repair is local, not swept.** The suite pervasively uses
conditional assertions (`if ('proof' in result) { expect(...) }`), which silently
skip verification when a shape is wrong — this is how finding 8 stayed green.
Each phase repairs this pattern in the files it touches. A repo-wide mechanical
sweep is explicitly rejected as churn.

**Cross-repo work happens in a worktree.** The Rust fork's checkout carries
in-progress user work on branch `style/rustfmt-tests`. All Rust-side fixture
generation happens in a `git worktree` off `main` — which is also the branch
carrying `pack`/`unpack` and `restore_root` — leaving the user's checkout
untouched.

**DAGsocial is routed, not edited.** The Phase A codec change and the Phase C API
changes both require corresponding updates in DAGsocial. Those are described in
each phase's spec for the user to route to that project's own session, per the
cross-project boundary rule.

## Phase decomposition

Phases are grouped by coupling and shippability rather than by defect category.
Order is A → B → C → D; all land together as `0.4.0`.

### Phase A — storage codec realignment

Replace `serialize.ts` with a byte-for-byte port of Rust's `pack`/`unpack`. Add
tree config as a codec parameter. Drop the `0x03` label variant — verified
unnecessary, since storage never persists stubs (DAGsocial's `SqliteAvlStorage`
uses them only as transient reference-carriers, matching Rust's `unpack`, and
Rust panics on serializing one). Generate byte-equality fixtures from the Rust
fork, bringing the module under the project's fixture gate for the first time.

Findings closed: 14 (format divergence), 15 (false purity claim), 20 (dead test
helper). Also clears the 0.3.1–0.3.3 contract/docs backlog (16, 17).

Ordered first because DAGsocial is actively building `SqliteAvlStorage`, so
landing the format change early minimises its rework.

### Phase B — prover engine correctness and performance

Internal to `BatchAVLProver` and `node.ts`; no public signature changes.

- Stop clearing `labelCache` tree-wide on every cycle and short-circuit the reset
  recursion, matching Rust's `reset()` / `reset_recursive` which preserve labels
  and descend only into new nodes. Current behaviour forces a full O(n) blake2b
  re-hash after every `generateProof()`.
- Replace `modifiedNodes: AvlNode[]` + `.includes()` with a `Set`, eliminating an
  O(n·m) scan during proof packing, and deduplicate visits.
- Remove the invented delete-failure path that nulls the root. Rust's
  `delete_helper` is infallible; the branch is unreachable for the prover and
  permanently kills the tree if ever hit.
- Replace the `Math.max(0, height + delta)` clamp with correct delta handling.
- Assert `height < 256` in `digest()` rather than silently wrapping via `& 0xff`.
- Hoist per-operation sentinel key allocation out of the hot path.
- Route `PersistentBatchAVLProver.rollback()` through `restoreRoot` so a
  mid-cycle rollback clears stale directions and modified-node bookkeeping.

Findings closed: 1–7.

### Phase C — public API and type hygiene

The breaking surface pass.

- Give `generateProofForOperations` a `success: true` discriminant. Its success
  arm currently lacks one, so `if (result.success)` is falsy on success.
- Retype `VersionedAVLStorage.rollback` from `unknown` to `AvlNode`. The `unknown`
  existed because node types were private; 0.3.1 exported them and the workaround
  was left behind.
- Make `InternalNode.left/right/balance` `readonly` and delete the "mutable to
  support in-place rebalancing" comment — verified false, the engine is fully
  immutable.
- Split the overloaded `invalid-config-key-length` error code, currently covering
  three unrelated conditions.
- Export `compareBytes` from one module instead of three copies.
- Consolidate the four hand-rolled root-installation sites onto `restoreRoot`.

Findings closed: 8–13.

### Phase D — `removedNodes()` storage-GC API

Port Rust's `changed_nodes_buffer` / `changed_nodes_buffer_to_check` tracking and
expose `removedNodes()`, so `VersionedAVLStorage` implementers can prune nodes
that left the tree. Additive rather than corrective; in scope per user decision
2026-08-02. DAGsocial's SQLite backend is the motivating consumer.

Finding closed: 18.

## Out of scope

- Any compatibility path with the 0.3.x storage format.
- Changes to the verifier's proof-parsing path, which is unaffected and already
  fixture-gated.
- Repo-wide test-pattern sweep beyond files each phase touches.
- Edits to DAGsocial.

## Risks

**Phase B changes label lifecycle.** Preserving `labelCache` across cycles is
correct only because the engine is immutable — verified by exhaustive grep for
field assignment across `src/`. If any future code mutates a node in place, stale
labels become a silent correctness bug. Phase C's `readonly` change hardens this
at the type level; until then the invariant rests on the audit.

**Phase A removes self-describing lengths.** A config mismatch between write and
read is no longer detected by the format itself. Rust has the same property.
Partly mitigated by validating fixed-length values against `valueLengthOpt` on
both encode and decode.

**Fixture generation is one-shot.** As with `prover_fixtures.rs` at 0.3.0, the
Rust generator runs once and its output is committed; there is no CI determinism
gate. Consistent with `fixture-gen` being frozen.

## Verification gate

Every phase must pass before it is claimed done:

```bash
npx vitest run                                          # full suite green
npx tsc --noEmit --project packages/avltree/tsconfig.json
npx publint packages/avltree
```

Baseline at time of writing: 7366 tests across 348 files, tsc clean, publint
clean, `@ergots/avltree@0.3.3` published.
