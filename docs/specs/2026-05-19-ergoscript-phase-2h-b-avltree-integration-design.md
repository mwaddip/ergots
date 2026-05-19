# `@ergots/ergoscript` Phase 2h-b — `@ergots/avltree` Integration

**Status:** Draft
**Date:** 2026-05-19
**Phase:** 2h-b in the `@ergots/ergoscript` umbrella plan (see `docs/specs/2026-05-13-ergoscript-interpreter-design.md`)
**Package:** `@ergots/ergoscript` (extends eval slice; touches `mir/types.ts`, adds `eval/savltree.ts` + `eval/_avltree-adapter.ts`); `@ergots/avltree` v0.1.0 → v0.2.0 (adds `verifyAvlBatchPartial`)
**Interface contracts:** `facts/ergoscript-eval.md` (registry 8 → 21; EvalError 43 → 45; `AvlTreeData` runtime shape stabilized); `facts/avltree.md` (adds `verifyAvlBatchPartial` row)
**Sister specs:** `2026-05-18-ergots-avltree-package-design.md` (Phase 2h-a — preceded this slice), `2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` (most recent method-handler addition)
**Brainstorm transcript:** this session, 2026-05-19

## Goal

Wire **13 `SAvlTree.*` method handlers** in `@ergots/ergoscript`'s `MethodCall`/`PropertyCall` dispatcher (registry grows 8 → 21) so the evaluator can execute ErgoTree method calls on AVL+ trees byte-for-byte equivalently to sigma-rust. The verification subset (`contains`, `get`, `getMany`, `insert`, `update`, `remove`) calls into `@ergots/avltree`'s verifier kernel; the accessor subset (`digest`, `enabledOperations`, `keyLength`, `valueLengthOpt`, `isInsertAllowed`, `isUpdateAllowed`, `isRemoveAllowed`) projects fields off the `AvlTreeData` runtime value.

To support sigma-rust's V3+ "break gracefully on per-entry operation failure" semantics in `insert` and `update`, `@ergots/avltree` adds one targeted function `verifyAvlBatchPartial` (v0.1.0 → v0.2.0). The existing `verifyAvlBatch` becomes a thin wrapper.

`@ergots/ergoscript` test count expected: ~2658 → ~2720 (depending on per-handler fixture count, target 55-65 new fixtures). `@ergots/avltree` test count: ~140 → ~150 (new `verifyAvlBatchPartial` tests).

## Non-goals

- **`LastBlockUtxoRootHash` (SContext methodId 9).** Deferred to a separate Header-model phase. Sigma-rust extracts it from `ctx.headers[0].state_root`; the TS evaluator has no `Headers[]` chain-state field yet. Adding a Header runtime model + wire-format alignment with `@ergots/nipopow`'s `Header` type is its own slice with independent design considerations. Bundling it into 2h-b was the prior brainstorm's framing error (caught at scoping in this session). The fact that `LastBlockUtxoRootHash` returns `SAvlTree` is a coincidence of return type; structurally it's a chain-state read.
- **The 3 deferred SAvlTree methods.** `updateOperations` (methodId 8), `updateDigest` (methodId 15), `insertOrUpdate` (methodId 16). `updateOperations` and `updateDigest` are pure data-mutations (trivial to add later when corpus demand surfaces). `insertOrUpdate` is V3-gated and entangles treeVersion semantics with the verification ops — best deferred to a future targeted slice.
- **Header runtime model.** `SHeader` arms remain stubbed via `'not-implemented-yet'`. Phase 2h-c (next session, scoping TBD) is the natural home.
- **Cost validation against real mainnet boxes.** Test fixtures byte-equal sigma-rust's `try_eval_out` cost output (Layer 1 + corpus continuation). Real-context cost calibration is phase 2j.
- **Exposing `@ergots/avltree`'s internal `BatchAvlVerifier` class publicly.** The 2h-b need is satisfied by one new function (`verifyAvlBatchPartial`). The class stays internal, consistent with the option-3 deferral in `facts/avltree.md`. If a future consumer needs full driver-style control, we re-evaluate then.
- **Predefs phase 2i.** `DecodePoint`, `SubstConstants`, `CalcBlake2b256`, byte-array conversions, hash predefs — independent scope.

## Architecture

Two packages touched. Versions bump feature-aligned.

### `@ergots/avltree` v0.2.0 — surface addition

One new function in `packages/avltree/src/verify.ts`:

```ts
export function verifyAvlBatchPartial(
  startingDigest: Uint8Array,
  proof: Uint8Array,
  config: AvlTreeConfig,
  operations: Operation[],
): {
  newDigest: Uint8Array               // 33 bytes
  results: (Uint8Array | null)[]      // length === opsCompleted
  opsCompleted: number                // count of operations applied before any failure
} | null
```

Semantics:

1. Construct `BatchAvlVerifier` once. If construction fails (proof decode, digest mismatch) → return `null`. This is "the proof itself didn't anchor"; no partial state to report.
2. Iterate `operations`. For each, call `verifier.performOneOperation(op)`:
   - **Success:** push the result; increment counter.
   - **Failure:** stop iterating. Read `verifier.digest()` (the verifier's current digest after the last successful op). Return `{ newDigest, results, opsCompleted }` with `opsCompleted` equal to the index of the failing op.
3. All operations succeed → return `{ newDigest: verifier.digest(), results, opsCompleted: operations.length }`.

`verifyAvlBatch` (the existing v0.1.0 export) becomes a thin wrapper:

```ts
export function verifyAvlBatch(...): VerifyAvlBatchResult | null {
  const partial = verifyAvlBatchPartial(...)
  if (partial === null) return null
  if (partial.opsCompleted < operations.length) return null
  return { newDigest: partial.newDigest, results: partial.results }
}
```

The existing 140 `@ergots/avltree` tests pass unchanged (byte-equivalent on the all-pass path; `null` on any failure including partial). The 10 new tests are targeted at `verifyAvlBatchPartial`'s partial-success path.

### `@ergots/ergoscript` — file layout

```
packages/ergoscript/src/
├── eval/
│   ├── savltree.ts                NEW — 13 handlers (7 accessors + 6 verification ops)
│   ├── _avltree-adapter.ts        NEW — bridges AvlTreeData → AvlTreeConfig +
│   │                                   constructs Operation[] from method args +
│   │                                   immutable AvlTreeData carry-forward on success
│   └── method-call.ts             UPDATED — HANDLERS registry 8 → 21
├── mir/
│   └── types.ts                   UPDATED — AvlTreeData runtime shape promoted from
│                                            phase-2a forward-declaration to stable struct
├── wire/
│   ├── parse-svalue.ts            UPDATED — SAvlTree case added; removed from
│   │                                       'not-implemented-phase-2a' throw set
│   └── serialize-svalue.ts        UPDATED — symmetric SAvlTree case + remove
└── errors.ts                      UPDATED — 2 new EvalError codes (43 → 45)
```

Test files:

```
packages/ergoscript/test/eval/
├── savltree-accessors.test.ts          NEW — 7 accessor handlers
├── savltree-contains.test.ts           NEW — contains
├── savltree-get.test.ts                NEW — get (Option semantics)
├── savltree-getmany.test.ts            NEW — getMany
├── savltree-insert.test.ts             NEW — insert (treeFlags + V<3 + V3+ partial)
├── savltree-update.test.ts             NEW — update (same pattern as insert)
├── savltree-remove.test.ts             NEW — remove (no V3+ break)
└── savltree-mutation.test.ts           NEW — Layer C3.a single-byte proof-mutation
```

Test fixtures live under `packages/ergoscript/test/fixtures/savltree/<handler-name>/<scenario>.json`.

### Runtime `AvlTreeData` shape

Promoted from phase-2a forward-declaration to stable struct (mirrors sigma-rust `ergotree-ir/src/mir/avl_tree_data.rs:60-69`):

```ts
export interface AvlTreeData {
  digest: Uint8Array              // 33 bytes (32-byte root + 1-byte height)
  treeFlags: number               // u8: bit 0 insertAllowed, bit 1 updateAllowed, bit 2 removeAllowed
  keyLength: number               // u32; matches AvlTreeConfig.keyLength
  valueLengthOpt: number | null   // matches AvlTreeConfig.valueLengthOpt
}
```

Consumed by `SValue.kind: 'AvlTree'`'s `value` field.

### Wire-format slice (also part of 2h-b)

Test fixtures generated via sigma-rust's `try_eval_out` need ErgoTrees that contain `Const(SAvlTree, AvlTreeData)` inline. Currently `SValueParseError` / `SValueSerializeError` throw `'not-implemented-phase-2a'` for `SAvlTree`. Following the phase 2f Stop α pattern (SBox wire-format + eval handlers landed together), 2h-b adds SAvlTree wire-format support in the same arc as the eval handlers.

Wire format per sigma-rust `ergotree-ir/src/mir/avl_tree_data.rs:71-91`:

1. `digest` — `ergo_chain_types::ADDigest::scorex_serialize` (length-prefixed bytes; for a 33-byte digest the prefix is the byte `0x21`, then 33 content bytes)
2. `treeFlags` — single `u8`
3. `keyLength` — `u32` (4 little-endian bytes per Scorex `put_u32` — to be confirmed against source on first commit)
4. `valueLengthOpt` — `Option<Box<u32>>` SigmaSerializable; `0x00` (None) or `0x01 || u32` (Some)

Wire-format changes:

- `wire/parse-svalue.ts` — add `SAvlTree` case; remove from `'not-implemented-phase-2a'` throw set
- `wire/serialize-svalue.ts` — symmetric add + remove
- `facts/ergoscript-wire.md` — `'not-implemented-phase-2a'` set narrows (removes `SAvlTree`)

`AvlTreeData` is the inner shape of `SValue.kind: 'AvlTree'`.

### Adapter responsibilities

`eval/_avltree-adapter.ts` exposes pure helpers consumed by `eval/savltree.ts`:

- `avlTreeDataToConfig(d: AvlTreeData): AvlTreeConfig` — pure projection
- `buildSingleLookupOp(key: Uint8Array): Operation[]` — for `contains`/`get`
- `buildLookupOps(keys: Uint8Array[]): Operation[]` — for `getMany`
- `buildInsertOps(entries: SValue): Operation[]` — extracts `Coll[Tuple[Coll[Byte], Coll[Byte]]]` shape into Insert ops
- `buildUpdateOps(entries: SValue): Operation[]` — same shape, emits Update ops
- `buildRemoveOps(keys: Uint8Array[]): Operation[]` — emits Remove ops
- `withUpdatedDigest(tree: AvlTreeData, newDigest: Uint8Array): AvlTreeData` — immutable update; carries `treeFlags`, `keyLength`, `valueLengthOpt` forward unchanged
- `extractBytes(v: SValue): Uint8Array` — defensive `Coll[Byte]` → bytes (throws `'method-not-implemented'` on shape mismatch per compact-taxonomy decision)
- `extractEntries(v: SValue): { key: Uint8Array; value: Uint8Array }[]` — defensive `Coll[Tuple]` → entries

These helpers are pure; no eval-context interaction. The handlers in `eval/savltree.ts` retain all `ctx.addCost` and control-flow logic.

## Per-handler semantics

`typeId` for SAvlTree: **100** (per sigma-rust `SType::type_code` in `ergotree-ir/src/types/stype.rs`).

Sigma-rust source for all 13 handlers: `ergotree-interpreter/src/eval/savltree.rs`. Per-handler line ranges baked into source comments + Source Mapping table in `facts/ergoscript-eval.md`.

### Tier 1 — Pure accessors (7 handlers, no `@ergots/avltree` call)

Each Pattern A — `ctx.addCost(N)` BEFORE returning the value. Sigma-rust per-method costs are source-read at implementation; not guessed in design.

| # | Method | typeId:methodId | Returns | Body (informal) |
|---|---|---|---|---|
| 1 | `SAvlTree.digest` | 100:1 | `Coll[Byte]` | New `Coll[SByte]` from `obj.value.digest` (33 bytes) |
| 2 | `SAvlTree.enabledOperations` | 100:2 | `Byte` | `{kind:'Byte', value: obj.value.treeFlags}` |
| 3 | `SAvlTree.keyLength` | 100:3 | `Int` | `{kind:'Int', value: obj.value.keyLength}` |
| 4 | `SAvlTree.valueLengthOpt` | 100:4 | `Option[Int]` | `{kind:'Option', elem:SInt, value: valueLengthOpt===null ? null : {kind:'Int', value:valueLengthOpt}}` |
| 5 | `SAvlTree.isInsertAllowed` | 100:5 | `Boolean` | `{kind:'Boolean', value: (obj.value.treeFlags & 1) !== 0}` |
| 6 | `SAvlTree.isUpdateAllowed` | 100:6 | `Boolean` | `{kind:'Boolean', value: (obj.value.treeFlags & 2) !== 0}` |
| 7 | `SAvlTree.isRemoveAllowed` | 100:7 | `Boolean` | `{kind:'Boolean', value: (obj.value.treeFlags & 4) !== 0}` |

All 7 share a defensive guard `if (obj.kind !== 'AvlTree') throw 'avl-tree-obj-not-avl-tree'`.

### Tier 2 — Verification ops (6 handlers, call into `@ergots/avltree`)

All take `args[1]: Coll[Byte]` as the proof bytes. None charge ergoscript cost beyond the dispatcher's flat 4 in the `MethodCall` arm. Sigma-rust does not add per-handler cost in these handlers (verified in survey).

| # | Method | typeId:methodId | Args | Returns | Failure model |
|---|---|---|---|---|---|
| 8 | `SAvlTree.contains` | 100:9 | `key: Coll[Byte]`, `proof: Coll[Byte]` | `Boolean` | Any verifier failure (construct OR op) → `false`. No throw. No Option. |
| 9 | `SAvlTree.get` | 100:10 | `key: Coll[Byte]`, `proof: Coll[Byte]` | `Option[Coll[Byte]]` | Verifier construct fail OR op fail → throw `'avl-tree-proof-failed'`. Proof valid + key absent → `Option None`. Proof valid + key present → `Some(value)`. |
| 10 | `SAvlTree.getMany` | 100:11 | `keys: Coll[Coll[Byte]]`, `proof: Coll[Byte]` | `Coll[Option[Coll[Byte]]]` | Verifier construct fail OR any per-key op fail → throw. Proof valid → per-key Option (`None` on absent, `Some(value)` on present). |
| 11 | `SAvlTree.insert` | 100:12 | `entries: Coll[(Coll[Byte], Coll[Byte])]`, `proof: Coll[Byte]` | `Option[AvlTree]` | `!treeFlags.insertAllowed` → `Option None` (no avltree call). Verifier construct fail → throw. V<3 + per-op fail → throw. V3+ + per-op fail → call `verifyAvlBatchPartial`; use `partial.newDigest` + `withUpdatedDigest` → `Some(AvlTree)`. All ops succeed → `Some(AvlTree)` with new digest. |
| 12 | `SAvlTree.update` | 100:13 | `entries: Coll[(Coll[Byte], Coll[Byte])]`, `proof: Coll[Byte]` | `Option[AvlTree]` | Same pattern as `insert`, with `updateAllowed` and Update op variant. |
| 13 | `SAvlTree.remove` | 100:14 | `keys: Coll[Coll[Byte]]`, `proof: Coll[Byte]` | `Option[AvlTree]` | `!treeFlags.removeAllowed` → `Option None`. Verifier construct fail OR per-op fail → throw (no V3+ partial-success path in `remove` per source survey). All ops succeed → `Some(AvlTree)` with new digest. |

**Asymmetries flagged for confidence escalation at implementation (OVERRIDES #2):**

- `contains` vs `get` failure semantics diverge (`false` vs throw) even though both internally call `Lookup` — must mirror sigma-rust exactly. Source-read both arms before touching either.
- V3+ break-on-failure applies to `insert`/`update` but NOT to `remove`. Source-read `savltree.rs:316-336` (remove) vs `savltree.rs:251-276` (insert) vs `savltree.rs:420-438` (update) to confirm exact failure-path divergence.
- `getMany` "any-key-failure → throw whole call" semantic is surprising vs the per-key Option return shape. Survey confirmed; double-check on the source read.

## Error model

### New `EvalError` codes (43 → 45)

```ts
// New in 2h-b:
| 'avl-tree-obj-not-avl-tree'    // defensive receiver kind check on all 13 handlers
| 'avl-tree-proof-failed'        // any sigma-rust-style throw on proof failure
                                 //   (verifier construct, per-op, V<3 insert/update, remove)
```

### Reused existing codes

- `'method-not-implemented'` — defensive shape mismatches on `args` (wrong kind, wrong arity, malformed Coll content). Continues the compact-taxonomy decision from 2g.5 (Decision #1).

### Not raised by this phase

- No new `EvalError` for `treeFlags`-disallowed `insert`/`update`/`remove`. Disallowed → return `Option None`. Matches sigma-rust.
- No new `EvalError` for `contains` failure. Returns `false`. Matches sigma-rust.

## Cost charging

**Dispatcher charge unchanged.** `MethodCall` arm continues to charge Pattern A `ctx.addCost(4)` before delegating to the handler. `PropertyCall` arm same.

**Tier 1 (7 accessors):** Pattern A, `ctx.addCost(N)` BEFORE returning. Each `N` is source-read from `eval/savltree.rs` at implementation time, NOT guessed in the design. Most likely values (based on adjacent type-method patterns): Fixed 10-15 each.

**Tier 2 (6 verification ops):** Zero per-handler cost. Sigma-rust's eval handlers do NOT call `ctx.add_cost` in any of the 6 — verified in survey. Byte-equality on `ctx.jitCost` requires we match this exactly. Verification time is implicit; not modelled as ergoscript cost.

Cross-check: corpus fixtures will catch any cost mismatch at byte level via `try_eval_out`'s cost output.

## `EvalOpts` / `EvalContext` changes

**None.** `AvlTreeData` is the inner value of `SValue.kind: 'AvlTree'`. The handlers consume `obj.value: AvlTreeData` (typed at handler entry) and `args[]` (the per-method arguments). No external chain-state read. No new optional fields needed. `EvalOpts` stays as it was after phase 2g.6.

## Validation strategy

Three test layers + cross-runtime, mirroring the established eval-slice pattern.

### Layer 1 — Per-handler fixture tests

For each handler, fixtures load `(tree-with-AvlTreeData, proof, args) → (expectedValue, expectedJitCost)` and assert byte-equality on value + cost. Generated by sigma-rust's `try_eval_out`.

**Target fixture matrix:**

| Tier / Handler | Scenarios | Approx count |
|---|---|---|
| Tier 1 — 7 accessors | varied `treeFlags` (8 values) + varied `keyLength` ∈ {1, 8, 32} + varied `valueLengthOpt` (null + fixed) + (digest content for `SAvlTree.digest`) | ~3-4 per handler × 7 = ~25 |
| Tier 2 — `contains` | key present / key absent / proof mutated → `false` | 4-5 |
| Tier 2 — `get` | key present / key absent / proof mutated → throw | 4-5 |
| Tier 2 — `getMany` | all-present / mixed / all-absent / proof mutated → throw | 4-5 |
| Tier 2 — `insert` | success-1-entry / success-N-entries / V<3 fail → throw / V3+ partial-success / `!insertAllowed` → None / proof mutated → throw | 6-7 |
| Tier 2 — `update` | success-1-entry / success-N-entries / V<3 fail → throw / V3+ partial-success / `!updateAllowed` → None / proof mutated → throw | 6-7 |
| Tier 2 — `remove` | success-1-key / success-N-keys / op-fail → throw / `!removeAllowed` → None / proof mutated → throw | 5-6 |

**Target: ~55-65 fixtures.** Tunable upward based on mutation kill rate during implementation.

### Layer 2 — Corpus continuation

`test/corpus-eval.test.ts` is extended (not rewritten) — fixture count grows; the success/not-impl/other accounting per fixture stays the same. Mainnet boxes that previously rejected on AVL+ method calls (counted as `not-impl`) start reclassifying to `success` after 2h-b lands. No regression: prior `success=18` must hold or grow.

### Layer 3 — Mutation testing

`test/eval/savltree-mutation.test.ts` does single-byte mutation across proof bytes for each Tier-2 handler's fixtures. **Target ≥90% kill rate per handler per fixture.** Mirrors Layer C3.a discipline from 2f Coll HOFs.

Per-handler expected behavior on mutation:
- `contains`: returns `false` (not `true`, not throw)
- `get`/`getMany`: throws `'avl-tree-proof-failed'`
- `insert`/`update`/`remove`: throws (V<3 path); V3+ partial-success path also reachable if mutation lands inside the directions-bit string mid-operation, in which case `verifyAvlBatchPartial` returns reduced `opsCompleted`

Tier-1 accessors have no proof bytes → no mutation testing layer.

### Cross-runtime

Every test runs under `node` and `jsdom` per existing vitest config. No infrastructure change.

### Fixture-gen plumbing (Rust side)

New file `fixture-gen/src/cmds/ergoscript_savltree.rs`. Each scenario:

1. Construct `AvlTreeData` (parameterized treeFlags, keyLength, valueLengthOpt)
2. For verification ops: use `BatchAVLProver` to build a real AD proof
3. Synthesize a `Const(SAvlTree, AvlTreeData)` and the `MethodCall(obj, methodId, args)` MIR — wrap in an `ErgoTree` body
4. Call `try_eval_out(tree, ctx)` to capture expected `(value, jitCost)`
5. Emit JSON to `packages/ergoscript/test/fixtures/savltree/<handler>/<scenario>.json`

Reuses fixture-gen infrastructure from prior phases. Per `[[project-fixture-gen-cargo-gotchas]]`:

- `TestRunner::deterministic()` for any prop-style fixture
- Pinned `~/projects/ergo_avltree_rust/` HEAD `879545c` (via `[patch.crates-io]` already in place from phase 2h-a)
- Path-resolved sigma-rust at `<ergots>/external/sigma-rust/` worktree on branch `integration/ergots`

Determinism check: `cargo run --release` from `fixture-gen/` regenerates committed fixtures byte-identical. CI guard already exists.

## Cross-package coupling

2h-b couples `@ergots/ergoscript` to `@ergots/avltree@0.2.0`. The workspace-alias resolution (no `npm publish` yet) means the coupling is transparent to local development; both packages stay in lockstep.

**Sequencing within 2h-b:**

1. **`@ergots/avltree` v0.2.0** ships first (verifyAvlBatchPartial added; 10 new tests; facts updated). Independent of ergoscript changes.
2. **fixture-gen extension** ships next (Rust side; doesn't depend on either TS package since it links to `ergo_avltree_rust` + sigma-rust directly).
3. **`@ergots/ergoscript`** consumes both: AvlTreeData type promotion → accessor handlers → adapter helpers → verification op handlers.

## Source-mapping discipline

Per `[[feedback-rust-port-style]]`, two complementary mechanisms ensure cross-fidelity.

### Per-function source comments

Each TS handler gets a one-line JSDoc citing its sigma-rust counterpart:

```ts
/** Ports SAvlTree.get handler (eval/savltree.rs:121-155). */
function evalSAvlTreeGet(...) { ... }
```

### Source Mapping table in `facts/ergoscript-eval.md`

The method-handler registry table grows from 8 to 21 entries. Each new row has the same shape as the existing entries:

| # | Method | typeId:methodId | Cost | Pattern | Returns | Sigma-rust source |
|---|---|---|---|---|---|---|

Same row added to the 13 new handlers.

## Coverage and stability

**Method-handler registry: 8 → 21 entries** in 2h-b.

**`Expr` arm coverage unchanged.** 52 of ~70 arms remain wired. (No new arms in 2h-b; the slice extends the method-call surface, not the Expr surface.)

**`EvalError` codes: 43 → 45.**

**Public function signatures stable.** `evaluate`, `evaluateWith`, `makeContext`, `EvalError` unchanged. The method-handler registry change is fully internal.

**Test corpus growth.**
- `@ergots/avltree`: 140 → ~150 tests (verifyAvlBatchPartial coverage).
- `@ergots/ergoscript`: 2658 → ~2720 tests (per-handler fixtures + mutation testing).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| V3+ partial-success digest semantics misread — sigma-rust's `insert`/`update` break-on-failure path is subtle | OVERRIDES #2 escalation when implementing `insert`/`update`. Source-read `savltree.rs:251-276` (insert) and `savltree.rs:420-438` (update). Layered fixtures: V<3-fail, V3+-all-pass, V3+-partial-success — each is its own RED-GREEN cycle. |
| `getMany` per-key semantics inverted — proof-fail-throws vs per-key-None-on-absence confused | Per-handler fixture matrix: `all-present` / `mixed` / `all-absent` / `proof-mutated`. Mutation test specifically for "absent key returns per-key None"; inversion → test fails at byte level. |
| Sigma-rust per-accessor cost values unknown until source-read | 7 accessors each get a separate RED-GREEN cycle. Each handler's fixture's `expectedJitCost` is sourced from `try_eval_out` — wrong cost → test fails before we claim done. |
| `treeFlags` byte layout swapped (e.g., bit 0 vs bit 2 for insertAllowed) | Source-read `ergotree-ir/src/chain/ergo_box/avl_tree_data.rs::AvlTreeFlags`. Per-accessor fixtures: `isInsertAllowed` true/false across all 8 `treeFlags` values catches any bit-mask inversion. |
| `verifyAvlBatchPartial` divergence between `opsCompleted` semantics and sigma-rust's break index | Targeted `@ergots/avltree` test: 5-op batch where op 3 fails (key-already-exists); assert `opsCompleted === 2`; assert `newDigest` matches digest-after-ops-1-2 (computed via Rust `BatchAVLVerifier` oracle in fixture-gen). Mutation test on the proof bytes verifies failure-path correctness. |
| Cross-package version coupling — ergoscript-2h-b requires avltree-v0.2.0 | Workspace alias makes coupling explicit. `@ergots/ergoscript`'s `package.json` peer/workspace dep specifies `@ergots/avltree@^0.2.0` immediately. PLAN.md sequences avltree-v0.2.0 work before ergoscript handler work; verification gates between phases. |
| AVL+ `Option[Int]` runtime shape for `valueLengthOpt` accessor not matching sigma-rust's `Value::Opt(Some(Value::Int(...)))` exactly | Fixture with `valueLengthOpt: null` AND `valueLengthOpt: 32` both exercised; `try_eval_out` captures exact SValue shape for byte-equality. |
| Unused fixtures bloat the test corpus (premature scope) | Target 55-65 fixtures total. If mutation kill rate hits ≥90% with fewer, accept fewer. Re-tune up only if real coverage gap surfaces. |
| Test failures cascade across handlers because of a single adapter bug | Each handler's RED-GREEN cycle is its own commit. A broken adapter affecting multiple handlers surfaces at the first handler; fix-then-retry rather than batched debug. |

## Open items (deferred to PLAN.md)

- Sigma-rust per-accessor cost values for the 7 Tier-1 handlers (source-read at implementation, not design).
- Exact fixture count per handler — target 55-65 total; tunable based on mutation kill rate.
- Tier 3 method-handler cleanup from 2g.6 (`SColl.flatten`, `SGroupElement.getEncoded`) — out of scope; carries forward.
- Whether to bump `@ergots/ergoscript` to v0.3.0 in the same arc as 2h-b or hold separately — see Task #4 in the brainstorm task list (publish-posture queue).
- Confirm whether `ADDigest::scorex_serialize` for a 33-byte digest emits exactly `[0x21, ...33 bytes]` (length prefix + content) or a different layout. Source-read at first wire-format commit.
- Confirm whether `Scorex::put_u32` (used for `keyLength`) is little-endian fixed-4-bytes or VLQ. The existing TS port has both `putUInt` (VLQ) and fixed-width writers; pick the one matching sigma-rust's `put_u32` definition.

## Cross-references

### Source

- `<ergots>/external/sigma-rust/ergotree-interpreter/src/eval/savltree.rs` — all 13 eval handlers + cost values
- `<ergots>/external/sigma-rust/ergotree-ir/src/mir/avl_tree_data.rs:60-69` — `AvlTreeData` field layout
- `<ergots>/external/sigma-rust/ergotree-ir/src/chain/ergo_box/avl_tree_data.rs::AvlTreeFlags` — bit layout
- `<ergots>/external/sigma-rust/ergotree-ir/src/types/savltree.rs` — method registry (methodId 1-16; 13 in 2h-b scope)
- `<ergots>/external/sigma-rust/ergotree-ir/src/types/scontext.rs:136-149` — `LastBlockUtxoRootHash` definition (DEFERRED to Header phase)
- `~/projects/ergo_avltree_rust/` HEAD `879545c` — AVL+ algorithmic reference (via `[patch.crates-io]`)

### Sister specs

- `docs/specs/2026-05-18-ergots-avltree-package-design.md` — phase 2h-a; predecessor that built the verifier kernel this phase consumes
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (defines 2h-a + 2h-b)
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — method-call dispatcher (HANDLERS registry that 2h-b extends)
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — most recent prior method-handler addition
- `docs/specs/2026-05-18-facts-ergoscript-split-design.md` — establishes per-slice facts file pattern (this phase updates `facts/ergoscript-eval.md` + `facts/avltree.md`)
- `facts/ergoscript-eval.md` — method-handler registry; this phase grows it 8 → 21
- `facts/avltree.md` — verifier surface; this phase adds `verifyAvlBatchPartial`

### Memories

- `[[project-fixture-gen-cargo-gotchas]]` — fixture-gen patterns + `TestRunner::deterministic()` requirement
- `[[reference-source-first-discipline]]` — read sigma-rust BEFORE writing TS handlers
- `[[reference-sigma-rust-eval-api]]` — `try_eval_out` is gated by the `arbitrary` feature; pattern for fixture-gen oracle invocation
- `[[feedback-rust-port-style]]` — TS-idiomatic decomposition + per-function source comments + canonical Source Mapping table
- `[[feedback-focused-specs]]` — 1 spec per deliverable (this slice = 1 spec)
- `[[feedback-subagent-explicit-rules]]` — OVERRIDES preamble in every implementer dispatch
- `[[feedback-no-artificial-stops]]` — flat task lists with per-task commits
- `[[feedback-correctness-over-effort]]` — fix issues now; don't defer
- `[[feedback-pre-v1-coverage-not-load-bearing]]` — pre-1.0 coverage % doesn't drive prioritization
- `[[reference-cost-charging-order-patterns]]` — Pattern A (before), Pattern B (after), Mixed (A+B); per-handler source-read tells you which
- `[[feedback-pure-typescript-no-wasm]]` — all-TS is project identity

### Project conventions

- `CLAUDE.md` § Read-first files — `facts/avltree.md` and `facts/ergoscript-eval.md` both updated by this phase
- `CLAUDE.md` § Browser-first hard rules — full set carried verbatim (no `Buffer`, no `node:*` in src, no WASM)
- `CLAUDE.md` § TDD is the working discipline — every handler is its own RED-GREEN cycle
- `OVERRIDES.md` § 2 Confidence escalation — V3+ partial-success, `getMany` per-key semantics, `treeFlags` bit layout all escalation-eligible
- `OVERRIDES.md` § 6 Forced verification — `npx tsc --noEmit` + `npm test` after every commit
