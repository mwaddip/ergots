# `@ergots/ergoscript` Phase 2h-d — SAvlTree completion (`updateOperations`, `updateDigest`, `insertOrUpdate`, plus carry-forward fixtures)

**Status:** Draft
**Date:** 2026-05-20
**Package:** `@ergots/ergoscript` (additive within an existing workspace; no new package, no new runtime deps)
**Interface contracts:** `facts/ergoscript-eval.md`, `facts/ergoscript.md` (both updated alongside implementation; facts files win on any interface disagreement)
**Brainstorm transcript:** this session, 2026-05-20
**Predecessor spec:** `docs/specs/2026-05-20-ergoscript-phase-2h-c-2-checkpow-design.md` (phase 2h-c.2 — SHeader.checkPow + Autolykos v2 promotion, landed)
**Successor spec:** (next) `2h-e` / `2i` — Coll/Group Tier-3 cleanup (`SColl.flatten`, `SGroupElement.getEncoded`), separate brainstorm cycle after 2h-d ships

## Goal

Wire three new method-call dispatch handlers in `@ergots/ergoscript`'s evaluator, closing the `SAvlTree.*` method surface against sigma-rust:

- **`SAvlTree.updateOperations`** (typeId 100, methodId 8) — Pattern A Fixed(45), V0+. Pure projection over `AvlTreeData.treeFlags`.
- **`SAvlTree.updateDigest`** (100:15) — Pattern A Fixed(40), V0+. Pure projection over `AvlTreeData.digest` with 33-byte length validation.
- **`SAvlTree.insertOrUpdate`** (100:16) — zero per-handler cost, **V3-gated at dispatcher** via the existing `minVersion?: number` field. Verifier op delegating to `@ergots/avltree`'s `verifyAvlBatchPartial` with `Operation::InsertOrUpdate` per entry.

In the same phase, close two fixture-coverage gaps carried forward from 2h-b: the V3+ per-op-fail-graceful branch in `SAvlTree.insert` and the unconditional per-op-fail-graceful branch in `SAvlTree.update`. The branches are already implemented in `packages/ergoscript/src/eval/savltree.ts` (lines 446-461 and 507-510 respectively) but no committed fixture exercises them.

Add one new `EvalError` code (`'avl-tree-bad-digest-length'`) for `updateDigest`'s 33-byte length-check failure path. Add two `_avltree-adapter.ts` helpers (`withUpdatedFlags`, `buildInsertOrUpdateOps`). No new TS source files. No new runtime deps.

This phase is **additive** — no existing eval arms, method handlers, error codes, SValue variants, or wire-format behaviors change semantically. Registry grows 39 → 42. Error taxonomy grows 47 → 48. `Expr` arm coverage stays at 52/~70.

## Non-goals

- **Adding new `Expr` arms.** Phase 2h-d is method-handler-only. The remaining ~18 unimplemented `Expr` variants (predefs, `Xor`, etc.) are deferred to phase 2i and later.

- **`SColl.flatten` and `SGroupElement.getEncoded`** — these Tier-3 cleanup items from phase 2g.6 belong to the **next** phase (2h-e or 2i, separate brainstorm). Per `[[feedback-focused-specs]]`, the SAvlTree work is one focused spec and the Coll/Group cleanup is another. They are not bundled here.

- **`SAvlTree` cost-model changes.** The 13 handlers shipped in 2h-b retain their existing cost shapes. The 3 new handlers (45 / 40 / 0 cost) follow sigma-rust exactly.

- **`@ergots/avltree` public-API changes.** All three new handlers consume the existing surface (`verifyAvlBatch`, `verifyAvlBatchPartial`, and the `Operation.InsertOrUpdate` variant which already ships in v0.2.0). No version bump to avltree.

- **In-arm V3 gating for `insertOrUpdate`.** We use dispatcher-level gating via `minVersion: 3` on the registry entry. Mirrors 2h-c.2's `SHeader.checkPow` precedent exactly. Rationale: sigma-rust's `MethodDesc.min_version: V3` lives at the dispatcher level (BEFORE the eval fn runs), so V<3 reject incurs 0 handler-cost. In-arm gating would charge the (zero) handler cost before throwing — for this handler the cost difference is nil because the handler is itself zero-cost, but consistency with checkPow matters.

- **Re-exporting helpers from `_avltree-adapter.ts` publicly.** The new helpers (`withUpdatedFlags`, `buildInsertOrUpdateOps`) are internal to `packages/ergoscript/src/eval/`. Underscore-prefix is the established convention.

- **Real-context cost validation (Layer C3).** Per-arm costs are sigma-rust-accurate but C3 mainnet-corpus calibration remains a phase 2j concern.

- **Autolykos v1 verification.** Deferred indefinitely per the user-confirmed close-out in 2h-c.2's handoff. Out of scope.

## Motivation

Phase 2h-b shipped 13 of the 16 `SAvlTree.*` method handlers. The three remaining — `updateOperations`, `updateDigest`, `insertOrUpdate` — were deferred at the time because: (1) `updateOperations` and `updateDigest` are mutator-style projection setters that need a thin extra adapter helper; (2) `insertOrUpdate` is V3-gated and we didn't yet have the dispatcher-level gating infrastructure; that infrastructure landed in 2h-c.2 alongside `SHeader.checkPow`. With the dispatcher gate in place and the existing adapter pattern proven, the moment is right to close out the SAvlTree surface.

The carry-forward fixtures matter because the V3+ per-op-fail-graceful branch is the most subtle in the SAvlTree surface: sigma-rust's `BatchAVLVerifier` poisons its internal `root` to `None` on per-op failure, so the post-failure `bv.digest()` call returns `None`, and the handler returns `Option None` — NOT a `Some(AvlTree)` with the partial digest. The TS implementation already mirrors this exactly (returning `noneAvlTree()` from the V3+ branch rather than wrapping `partial.newDigest`), but without a fixture hitting that branch the implementation is asserting itself. Per `[[feedback-correctness-over-effort]]`, we pay this off now rather than carry it further.

The phase is **small in absolute terms** — three ~30-50 line handlers, two ~15-line adapter helpers, one new error code, five new fixture files (three new-handler + two carry-forward), and one expected facts-file refresh.

## Architecture

### Three new method handlers

All three live in `packages/ergoscript/src/eval/savltree.ts`, appended after the existing 13 handlers from 2h-b.

#### Handler #40 — `SAvlTree.updateOperations` (100:8)

```ts
export function evalSAvlTreeUpdateOperations(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  ctx.addCost(45)
  expectAvlTree('SAvlTree.updateOperations', obj)
  expectOneArg('SAvlTree.updateOperations', args)
  if (args[0]!.kind !== 'Byte') {
    throw new EvalError('SAvlTree.updateOperations: arg not Byte', 'method-not-implemented')
  }
  const newFlags = args[0]!.value & 0xff  // i8 → u8
  return { kind: 'AvlTree', value: withUpdatedFlags(obj.value, newFlags) }
}
```

**Source:** `eval/savltree.rs:77-88` (`UPDATE_OPERATIONS_EVAL_FN`).

**Cost pattern:** Pattern A Fixed(45) — `addCost(45)` before any kind-check or arg consumption. Matches sigma-rust's `ctx.add_jit_cost(45)?` at line 78 BEFORE the `try_extract_into` calls.

**SType:** `(SAvlTree, SByte) → SAvlTree`. The result is a fresh `AvlTreeData` with `treeFlags` replaced.

**Error model:**
- `'avl-tree-obj-not-avl-tree'` (existing) — defensive receiver check.
- `'method-not-implemented'` (existing) — defensive arg-shape mismatch per 2g.5 Decision #1's compact-taxonomy convention. Wire-format invariants make this unreachable for parser-produced trees.

No new EvalError code introduced by this handler.

#### Handler #41 — `SAvlTree.updateDigest` (100:15)

```ts
export function evalSAvlTreeUpdateDigest(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  ctx.addCost(40)
  expectAvlTree('SAvlTree.updateDigest', obj)
  expectOneArg('SAvlTree.updateDigest', args)
  const newDigest = extractBytes(args[0]!)  // existing helper from 2h-b
  if (newDigest.length !== 33) {
    throw new EvalError(
      `SAvlTree.updateDigest: digest must be 33 bytes, got ${newDigest.length}`,
      'avl-tree-bad-digest-length'
    )
  }
  return { kind: 'AvlTree', value: withUpdatedDigest(obj.value, newDigest) }
}
```

**Source:** `eval/savltree.rs:90-102` (`UPDATE_DIGEST_EVAL_FN`).

**Cost pattern:** Pattern A Fixed(40) — `addCost(40)` before any kind-check or arg consumption. Matches sigma-rust's `ctx.add_jit_cost(40)?` at line 91.

**SType:** `(SAvlTree, Coll[Byte]) → SAvlTree`. The result is a fresh `AvlTreeData` with `digest` replaced.

**Error model — new code:** `'avl-tree-bad-digest-length'` is thrown when the arg's byte-length ≠ 33. Sigma-rust surfaces the same condition via `ADDigest::try_from(bytes_vec)` failing inside `map_eval_err`. The condition is reachable from script-controlled data (any `Coll[Byte]` can be passed), and it is semantically distinct from `'avl-tree-proof-failed'` (no proof involved) and `'method-not-implemented'` (the method IS implemented). Adding a dedicated code follows the precedent set by 2h-c.2's `'autolykos-v1-not-supported'`.

`withUpdatedDigest` (existing helper from 2h-b at `_avltree-adapter.ts:68-75`) does NOT validate length — it just copies fields and substitutes `digest`. The handler's explicit pre-check is the SOLE 33-byte length gate, ensuring the throw is typed `'avl-tree-bad-digest-length'`.

#### Handler #42 — `SAvlTree.insertOrUpdate` (100:16) *V3-gated at dispatcher*

```ts
export function evalSAvlTreeInsertOrUpdate(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.insertOrUpdate', obj)
  expectTwoArgs('SAvlTree.insertOrUpdate', args)
  // Pre-check: BOTH insert_allowed AND update_allowed must be set
  // (asymmetric vs insert which checks only insert_allowed and update which
  // checks only update_allowed). Source: savltree.rs:444.
  if (
    (obj.value.treeFlags & INSERT_ALLOWED_BIT) === 0 ||
    (obj.value.treeFlags & UPDATE_ALLOWED_BIT) === 0
  ) {
    return noneAvlTree()
  }
  const ops = buildInsertOrUpdateOps(args[0]!)
  const proof = extractBytes(args[1]!)
  const config = avlTreeDataToConfig(obj.value)

  const partial = verifyAvlBatchPartial(obj.value.digest, proof, config, ops)
  if (partial === null) {
    // Construct fail — sigma-rust map_eval_err at line 479.
    throw new EvalError(
      'SAvlTree.insertOrUpdate: verifier construct failed',
      'avl-tree-proof-failed'
    )
  }
  if (partial.opsCompleted < ops.length) {
    // Per-op fail — always graceful break (sigma-rust line 487-488 has no
    // V<3 throw path because the method is V3-gated at dispatcher level).
    // bv.digest() returns None post-poison → Option None.
    return noneAvlTree()
  }
  // Full success — apply the new digest immutably.
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}
```

**Source:** `eval/savltree.rs:441-498` (`INSERT_OR_UPDATE_EVAL_FN`); type descriptor at `types/savltree.rs:377-403` with `min_version: ErgoTreeVersion::V3`.

**Cost pattern:** zero per-handler cost. Like the existing `insert`/`update`/`remove`, the cost is owned by the lower-level verifier (`verifyAvlBatchPartial` does the per-op blake2b work).

**SType:** `(SAvlTree, Coll[(Coll[Byte], Coll[Byte])], Coll[Byte]) → Option[SAvlTree]`.

**V-gating:** registered with `minVersion: 3`. The dispatcher throws `'tree-version-too-low'` BEFORE invoking the handler when `(ctx.treeVersion ?? 0) < 3`. Receiver-eval + envelope cost (4 from the MethodCall arm) are still charged; the handler's zero cost is not. Matches sigma-rust exactly.

**Error model:**
- `'tree-version-too-low'` (existing, dispatcher-raised) — V<3 dispatcher reject.
- `'avl-tree-obj-not-avl-tree'` (existing) — defensive receiver check.
- `'avl-tree-proof-failed'` (existing) — verifier construct failure (proof decode / digest mismatch / shape).
- No new EvalError code from this handler.

### Dispatcher registration

`packages/ergoscript/src/eval/method-call.ts` gains three new entries in the `HANDLERS` registry:

```ts
HANDLERS.set('100:8', { handler: evalSAvlTreeUpdateOperations })
HANDLERS.set('100:15', { handler: evalSAvlTreeUpdateDigest })
HANDLERS.set('100:16', { handler: evalSAvlTreeInsertOrUpdate, minVersion: 3 })
```

The `minVersion` field landed in 2h-c.2 — no infrastructure change here, just a new use.

### `_avltree-adapter.ts` extensions

Two small helpers added:

```ts
/**
 * Returns a new AvlTreeData with treeFlags replaced. The caller pre-narrows
 * the i8 input to u8 via `& 0xff` so this helper just stores the byte.
 * Source: sigma-rust's `avl_tree_data.tree_flags = AvlTreeFlags::parse(new_byte)`
 * at savltree.rs:86. We store the byte directly — flag-bit semantics are
 * already encoded by the existing INSERT_ALLOWED_BIT / UPDATE_ALLOWED_BIT /
 * REMOVE_ALLOWED_BIT constants.
 */
export function withUpdatedFlags(data: AvlTreeData, flags: number): AvlTreeData {
  return { ...data, treeFlags: flags & 0xff }
}

/**
 * Builds InsertOrUpdate Operation array from a Coll[(Coll[Byte], Coll[Byte])]
 * SValue. Mirrors buildInsertOps from 2h-b exactly except for the operation
 * tag. Source: savltree.rs:480-489.
 *
 * `extractEntries` returns `{ key, value }[]` (object destructuring per
 * the existing `_avltree-adapter.ts:194-219` shape).
 */
export function buildInsertOrUpdateOps(entries: SValue): Operation[] {
  const pairs = extractEntries(entries)
  return pairs.map(({ key, value }) => ({ tag: 'InsertOrUpdate', key, value }))
}
```

`extractEntries` is the existing helper from 2h-b that decodes a `Coll[(Coll[Byte], Coll[Byte])]` SValue into a `[Uint8Array, Uint8Array][]` array.

### Error taxonomy delta

One new `EvalError` code:

- **`'avl-tree-bad-digest-length'`** — thrown by `SAvlTree.updateDigest` when the digest arg's byte-length ≠ 33. Mirrors sigma-rust's `ADDigest::try_from(bytes_vec)` length-check failure.

Total: 47 → 48 codes.

### Cross-cutting guarantees (inherited unchanged)

- Browser-compat: no `Buffer`, no `node:*`, no `globalThis.crypto.subtle`. All Uint8Array.
- Determinism: pure handlers, no clock/PRNG/I/O.
- ESM only. No top-level await.
- No WASM, direct or transitive.
- `@noble/hashes@2.2.0` is the only ergoscript runtime dep (via `@ergots/scorex`); `@noble/curves@2.2.0` for sigma verification. No new deps.

## Carry-forward fixture coverage

The carry-forward fixtures close two specific branches in existing handlers, each previously implemented per sigma-rust but lacking a committed test.

### Branch 1 — `SAvlTree.insert` V3+ per-op-fail-graceful

**Source TS:** `packages/ergoscript/src/eval/savltree.ts:446-461`. Reached when `treeVersion >= 3` AND `partial.opsCompleted < ops.length`. Returns `noneAvlTree()`.

**Fixture name:** `savltree-insert-partial.json` (sits alongside the existing `savltree-insert.json`).

**Scenario:** V3 tree, INSERT_ALLOWED set, batch of 3 insert ops where the second op is an insert-on-existing-key. Verifier consumes op 1 successfully, op 2 fails, op 3 never reached. `opsCompleted === 1`. Expected SValue: `Option None`. Expected cost: oracle-authoritative (recorded as `expectedJitCost`).

### Branch 2 — `SAvlTree.update` per-op-fail-graceful (V-independent)

**Source TS:** `packages/ergoscript/src/eval/savltree.ts:507-510`. Reached when `partial.opsCompleted < ops.length` (no V-gate; update unconditionally graceful-breaks per sigma-rust line 422-431).

**Fixture name:** `savltree-update-partial.json`.

**Scenario:** Any tree version (V0 chosen for simplicity, demonstrating V-independence), UPDATE_ALLOWED set, batch of 3 update ops where the second targets an absent key. `opsCompleted === 1`. Expected SValue: `Option None`. Expected cost: oracle-authoritative.

### Optional hardening fixture — `SAvlTree.insert` V<3 per-op-fail-throw

**Source TS:** `packages/ergoscript/src/eval/savltree.ts:448-454`. Reached when `treeVersion < 3` AND `partial.opsCompleted < ops.length`. Throws `'avl-tree-proof-failed'`.

We commit one fixture (`savltree-insert-partial-v2-throw.json`) covering this negative branch IF the existing `savltree-insert.json` doesn't already include a V<3 per-op-fail case. Verified at Phase 4 start; skipped if redundant.

## Implementation plan (6 phases, ~12-15 commits)

Per `[[feedback-no-artificial-stops]]`, phases are natural commit boundaries with no mid-phase stops. Each phase is a flat task list with per-task commits.

### Phase 1 — `SAvlTree.updateOperations` (100:8)

1. Add `withUpdatedFlags` helper to `_avltree-adapter.ts` + import in `savltree.ts`.
2. Write fixture-gen Rust module `fixture-gen/src/ergoscript/savltree_update_operations.rs` emitting `savltree-update-operations.json` with one oracle scenario (V0 tree, flags byte = 0b101, expect AvlTree with `treeFlags === 5`).
3. Register the new module in `fixture-gen/src/ergoscript/mod.rs`. `cargo run -p fixture-gen --release` emits the JSON.
4. RED test in `test/eval/savltree-update-operations.test.ts` — loads fixture, expects handler to not exist yet → fails.
5. GREEN: implement `evalSAvlTreeUpdateOperations` in `savltree.ts`; register at `100:8` in `method-call.ts`. Test passes.
6. Edge cases + mutation testing (≥ 90% kill rate target). Single commit per cluster.

Expected commits: 4-5.

### Phase 2 — `SAvlTree.updateDigest` (100:15)

1. Add `'avl-tree-bad-digest-length'` to `EvalError` code union in `errors.ts`.
2. Write fixture-gen Rust module for `savltree-update-digest.json`. Scenarios: happy path (V0 tree, fresh 33-byte digest) + bad-length-throw (32-byte input expected to throw via the `expectedThrow` JSON field).
3. RED test + GREEN implementation.
4. Edge cases + mutation testing.

Expected commits: 4-5.

### Phase 3 — `SAvlTree.insertOrUpdate` (100:16, V3-gated)

1. Add `buildInsertOrUpdateOps` helper to `_avltree-adapter.ts`.
2. Write fixture-gen Rust module `savltree_insert_or_update.rs` emitting `savltree-insert-or-update.json` with 6 scenarios:
   - Happy: V3 tree, both flags set, batch of 3 InsertOrUpdate ops (mix of insert + update behaviors).
   - `insertAllowed=false` → Option None pre-check.
   - `updateAllowed=false` → Option None pre-check.
   - Per-op-fail-graceful: V3 tree, per-op fail mid-batch → Option None.
   - Malformed-proof → throw `'avl-tree-proof-failed'`.
   - V2-dispatcher-reject → throw `'tree-version-too-low'`.
3. RED test + GREEN implementation. Register at `100:16` with `minVersion: 3` in `method-call.ts`.
4. Mutation testing.

Expected commits: 5-6 (one for adapter, one per scenario cluster, one for mutation).

### Phase 4 — Carry-forward fixture: `SAvlTree.insert` V3+ per-op-fail-graceful

1. Verify whether the existing `savltree-insert.json` already covers any per-op-fail scenarios — adjust scope accordingly.
2. Write fixture-gen Rust module `fixture-gen/src/ergoscript/savltree_partial_success.rs` (single module emitting both Phase 4 and Phase 5 fixtures).
3. Add new scenarios to `savltree-insert-partial.json`: V3 tree, 3-op batch with op 2 designed to fail (insert-on-existing). Optional `savltree-insert-partial-v2-throw.json` if the V<3 branch isn't already covered.
4. Append tests to `test/eval/savltree-insert.test.ts` exercising the new fixtures.

Expected commits: 2.

### Phase 5 — Carry-forward fixture: `SAvlTree.update` per-op-fail-graceful

1. Add `savltree-update-partial.json` scenario (V0 tree, 3-op batch with op 2 targeting an absent key).
2. Append tests to `test/eval/savltree-update.test.ts`.

Expected commits: 1.

### Phase 6 — Facts files + final verification

1. Update `facts/ergoscript-eval.md`: phase 2h-d changelog block, +3 registry rows (40, 41, 42), +1 EvalError taxonomy entry, count refresh (39→42, 47→48), Coverage summary table refresh.
2. Update `facts/ergoscript.md`: registry count 39→42, EvalError count 47→48, test count refresh.
3. Final cross-package typecheck + cross-runtime jsdom + fixture-gen determinism.
4. Spec self-review checklist run.

Expected commits: 2-3.

**Total expected commits: 18-22 across 6 phases.** Sized similar to 2h-c.2 (23 commits / 6 phases) and 2h-c.1 (16 commits / 5 phases).

## Test strategy

Three test layers per the project's established discipline.

### Layer C1 — per-handler oracle fixtures

Every new handler gets at least one `try_eval_out`-oracle-validated fixture asserting value + cost equality with sigma-rust. The fixtures are committed under `packages/ergoscript/test/fixtures/eval/`. Each test file (`savltree-update-operations.test.ts` etc.) loads its fixture and:

- Parses the binary expression bytes via `parseTree`.
- Invokes `evaluate(tree, { ...avlContext, treeVersion })`.
- Asserts the returned `SValue` equals the JSON `expectedSValue` (structural recursive equality on AvlTreeData fields including byte-equality on `digest`).
- Asserts `ctx.jitCost === expectedJitCost`.

For `insertOrUpdate`, the 6-scenario fixture array follows the 2h-b multi-scenario pattern: each scenario carries its own `expectedSValue` / `expectedJitCost` / optional `expectedThrow` with code.

### Layer C2 — throw-path tests

For each handler with a typed-throw failure mode, a dedicated test asserts the throw happens with the correct code:

- `updateDigest` bad-length: 32-byte and 34-byte inputs both throw `'avl-tree-bad-digest-length'`.
- `insertOrUpdate` malformed proof: throws `'avl-tree-proof-failed'`.
- `insertOrUpdate` V2-dispatcher-reject: throws `'tree-version-too-low'` from the dispatcher BEFORE the handler runs (verified by the handler not being called — observable via cost: dispatcher reject incurs receiver-eval + envelope cost only).

### Layer C3 — mutation testing

Per-handler mutation tests target ≥ 90% kill rate. The mutation surface is the binary expression bytes; each single-byte flip either:

- Throws a typed error class (`EvalError`, `ExprParseError`, `ReaderError`), OR
- Returns a different `SValue` (kill via value-mismatch), OR
- Is byte-tolerated (explicit tolerance enumeration in the test).

Mutation tests run for `updateOperations`, `updateDigest`, `insertOrUpdate` (three new). Carry-forward fixtures inherit existing mutation coverage from their parent test files (`savltree-insert.test.ts`, `savltree-update.test.ts`); no new mutation work for carry-forward.

### Cross-runtime

Every new test runs under both `node` and `jsdom` via the two existing vitest configs.

### Fixture-gen determinism

`cargo run -p fixture-gen --release` twice in a row produces byte-identical fixture output. Verified at Phase 6 (final verification). Determinism failure halts the phase and is investigated as a regression of the byte-equality testing strategy.

## Risks & mitigations

**R1 — `insertOrUpdate` Operation tag not present in `@ergots/avltree`.** The `Operation` discriminated union in avltree v0.2.0 explicitly includes the `InsertOrUpdate` variant per `facts/avltree.md` line 96. Verified pre-spec. Mitigation: pre-check at Phase 3 task 1; if absent (unlikely), promote variant addition to avltree v0.2.1 with simultaneous ergoscript dep bump. Not expected to fire.

**R2 — `withUpdatedDigest` does NOT validate 33-byte length** (verified at `_avltree-adapter.ts:68-75` — pure field-substitution). The handler's pre-check is the sole length gate. We deliberately do NOT add length validation to the helper because (a) `withUpdatedDigest` is shared by other handlers (`insert`, `update`, `remove`, and now `insertOrUpdate`) which all source the digest from `verifyAvlBatchPartial`'s output where the 33-byte invariant holds by construction, and (b) the typed-throw surface should live in the handler that exposes the script-controlled input path.

**R3 — `expectOneArg` / `expectTwoArgs` helpers don't exist.** Confirm via grep on `savltree.ts`. If absent, factor from `expectAvlTree` patterns or inline the arg-count check. Cosmetic.

**R4 — Fixture-gen needs an InsertOrUpdate prover path.** `BatchAVLProver` in `ergo_avltree_rust` supports all 8 operation variants; the Rust side already exercises `Operation::InsertOrUpdate` per its test suite. Pre-checked by `grep InsertOrUpdate fixture-gen/src/`.

**R5 — Dispatcher cost-parity for V<3 reject.** Phase 3 fixture for `V2-dispatcher-reject` must verify the cost equals receiver-eval + envelope cost ONLY (i.e., does NOT include the would-be handler cost, which is zero here anyway). The receiver-eval cost is whatever the AvlTree const arm charges; envelope cost is 4 (MethodCall arm). Matches 2h-c.2 `SHeader.checkPow` parallel-pair test pattern.

**R6 — Carry-forward fixture overlap with existing `savltree-insert.json`.** Phase 4 task 1 verifies. If existing fixture already covers a V<3 per-op-fail-throw case, we skip the optional hardening fixture; we still add the V3+ per-op-fail-graceful case (that's the actual carry-forward).

**R7 — `treeVersion` default for handlers.** Handlers running via `evaluateWith(tree, ctx)` see whatever `ctx.treeVersion` the caller set (defaulting to V0 on undefined per `[[project-treeversion-gating-deferred]]`). For dispatcher-level minVersion checks, the dispatcher reads `ctx.treeVersion ?? 0` — same default as in-arm checks. Verified consistent with 2h-c.2's `SHeader.checkPow` dispatcher behavior.

## Open questions deferred to implementation

- **Q1: Should `withUpdatedDigest` get tighter typed-throw semantics?** Today it likely throws a generic `RangeError` on a length-violation; for symmetry with `withUpdatedFlags` we could leave it as-is (the handler's pre-check is the typed-throw surface). Defer the helper-internals tightening unless implementation discovers a caller depending on it. (Probability of impact: low.)

- **Q2: Should `expectedSValue.AvlTree` JSON serialization use Hex strings or arrays for `digest`?** Existing fixtures use base64 / hex; confirm by grepping `savltree-digest.json`. Match prevailing convention; do not introduce a new encoding.

- **Q3: Mutation testing kill-rate for `insertOrUpdate` 6-scenario fixture.** The ≥ 90% kill rate target may be harder to hit with 6 scenarios than with 1-scenario fixtures. Implementation may need to either (a) accept a lower target for this specific fixture with explicit tolerance enumeration, or (b) split mutation tests per-scenario. Defer the call to Phase 3 mutation task.

## Verification commands (run after each phase, must be clean)

```bash
# Per-phase verification
npx tsc --noEmit -p packages/ergoscript/tsconfig.json    # CLEAN
npx vitest run packages/ergoscript                       # PASS
# (no scorex / nipopow / avltree changes expected; verify clean if any touched)

# Phase 3 (insertOrUpdate) and final-phase verification adds cross-runtime
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts   # PASS under jsdom

# Final verification (Phase 6)
cd fixture-gen && cargo build --release                  # CLEAN
cd fixture-gen && cargo run --release                    # determinism: byte-identical on second run
git status                                               # clean modulo audit20260519/
```

## Cross-references

- `facts/ergoscript-eval.md` — registry (39 → 42), `EvalError` taxonomy (47 → 48), phase 2h-d changelog
- `facts/ergoscript.md` — coverage summary refresh (test counts, registry count, error count)
- `facts/avltree.md` — unchanged (this phase consumes existing avltree v0.2.0 surface)
- `docs/specs/2026-05-20-ergoscript-phase-2h-c-2-checkpow-design.md` — predecessor; introduces dispatcher-level `minVersion` gating used here
- `docs/specs/2026-05-19-ergoscript-phase-2h-c-1-sheader-design.md` — SHeader runtime + 17 handlers; established the `_avltree-adapter.ts` extension pattern
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/savltree.rs` (lines 77-102 for updateOperations / updateDigest; 441-498 for insertOrUpdate) — byte-format and semantic oracle
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/savltree.rs` (lines 195-212 / 359-374 / 376-403) — method descriptors with `min_version` settings
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
