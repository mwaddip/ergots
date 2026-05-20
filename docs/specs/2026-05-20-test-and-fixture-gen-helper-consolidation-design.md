# Phase 2h-e — Test-and-fixture-gen helper consolidation

**Status:** Draft
**Date:** 2026-05-20
**Packages:** `@ergots/ergoscript` test suite (TS) + `fixture-gen` (Rust)
**Interface contracts:** unchanged (no `packages/*/src/` surface affected; no `facts/` change)
**Brainstorm transcript:** this session, 2026-05-20
**Predecessor spec:** `docs/specs/2026-05-20-ergoscript-phase-2h-d-savltree-completion-design.md` (Phase 2h-d — SAvlTree completion, landed)
**Successor spec:** (next) Tier-3 method-handler cleanup (`SColl.flatten`, `SGroupElement.getEncoded`) or Phase 2i predefs — separate brainstorm cycle

## Goal

Consolidate the mutation-test harness (TS) and three fixture-gen helpers (Rust) that have crossed or are approaching the "promote-when-duplicated" threshold, removing maintenance friction before the next porting phase. Per the user-confirmed posture "cleanup and tech debt before we continue with the porting work" (2026-05-20).

Three refactors, in commit order:

1. **TS mutation-harness** — promote shared byte-level XOR-mutation loop + kill-criteria framework to `packages/ergoscript/test/_helpers/mutation-harness.ts`; refactor 5 consumer test files (`savltree-mutation`, `sheader-checkpow-mutation`, `savltree-update-operations`, `savltree-update-digest`, `savltree-insert-or-update`).
2. **Rust `make_resolver`** — promote shared closure-factory to a new `pub(super)` helper under `fixture-gen/src/cmds/ergoscript/eval/`; refactor 8 ergoscript `savltree_*.rs` consumers. The 1 copy in `fixture-gen/src/cmds/avltree.rs` is in a different module path and stays local to that file (cross-module promotion has higher friction than the duplication cost — see "Non-goals" R3 below).
3. **Rust `avl_tree_value_json`** — promote one copy to `pub(super)` in `savltree_insert.rs` (mirror of the existing `option_avl_tree_json` pattern at line 81); refactor 2 consumers (`savltree_update_operations.rs`, `savltree_update_digest.rs`).

Phase is **purely refactoring** — no functional change in production code, fixture-gen output, or test assertions. Determinism gate: `cargo run -p fixture-gen --release` twice in a row produces byte-identical output, asserted before each commit that touches fixture-gen.

This phase is **additive** in the negative sense — code is removed, not added. No new tests, no new fixtures, no new EvalError codes, no new method handlers, no new SValue variants, no new error classes. Expected aggregate LOC delta: −600 to −900 across the codebase.

## Non-goals

- **Adding new functional surface.** No new method handlers, eval arms, error codes, SValue variants, or fixtures. Tier-3 method-handler cleanup (`SColl.flatten`, `SGroupElement.getEncoded`) is the next phase, NOT this one.

- **Rust `build_proof_for_ops` consolidation.** Only 2 copies (`savltree_partial_success.rs:118` and `savltree_insert_or_update.rs:163`); below the 5-copy threshold. Defer until a 3rd consumer arrives.

- **Promoting `fixture-gen/src/cmds/avltree.rs::make_resolver` (R3).** The 9th copy lives at a different module path (`cmds/avltree.rs` for the standalone `@ergots/avltree` package, not `cmds/ergoscript/eval/`). Cross-module promotion requires either a new top-level `cmds/_avltree_helpers.rs` or a `pub(crate)` export, which adds Rust visibility-graph complexity for marginal benefit (1 deduplicated copy). Leave it local; if a 10th consumer arrives in `cmds/avltree.rs`'s neighborhood we revisit.

- **Cross-package shared helpers.** The TS mutation harness stays in `packages/ergoscript/test/_helpers/mutation-harness.ts`; it is NOT promoted to a workspace-level test-utils package. `@ergots/test-utils` remains a known follow-up per `facts/scorex.md` § Known limitations (`hexToBytes` / `bytesToHex` duplicated between scorex and nipopow test helpers). Bundling a workspace-test-utils package with this refactor would expand scope past the user's "before we continue with porting work" framing.

- **Helper rename or API redesign.** The promoted helpers keep their existing names and signatures (or as-close-as-possible to minimize per-consumer diffs). This is pure deduplication, not redesign. If a renamed signature would clearly read better, surface it as Q4 below rather than landing it silently.

- **OPS-02 vitest upgrade.** Separate dev-dep tracking work in `RELEASING.md` § Dev-dep advisory tracking. Not bundled here.

- **`expected_cost: 0` sentinel type-guard.** Noted in `SESSION_CONTEXT.md` as an unprotected fixture-loader convention (throw entries always set `expected_cost: 0`; a future mistake setting a positive value would produce a silent miscompare). Belongs to a fixture-loader hardening task; deferred.

- **`_mutation-operators.ts` / `_mutation-allowlist.ts` reorganization.** These existing root-level test helpers under `packages/ergoscript/test/` support `parse-mutation.test.ts` and `eval-mutation.test.ts` (Expr-tree-level mutation testing, distinct from byte-level mutation). They predate `test/_helpers/` directory convention. Moving them is cosmetic and out of scope.

## Motivation

### Refactor 1 — TS mutation-harness

Five mutation-test files (1,451 LOC aggregate) duplicate the same byte-level XOR-mutation loop:

```text
savltree-mutation.test.ts (338 LOC)           — 6 Tier-2 SAvlTree verification ops
sheader-checkpow-mutation.test.ts (166 LOC)   — SHeader.checkPow
savltree-update-operations.test.ts (255 LOC)  — has mutation inline within handler test
savltree-update-digest.test.ts (409 LOC)      — same
savltree-insert-or-update.test.ts (283 LOC)   — same
```

The shared pattern (verified at `savltree-mutation.test.ts:37-218`):

1. `findInlineByteColls(expr): Uint8Array[]` — depth-first walk of an `Expr` collecting every `Const(Coll[Byte], …)` payload.
2. `locateBytes(haystack, needle): number` — unique-substring locator over `Uint8Array`.
3. `locateProofRegion(treeBytes, tree, whichColl): { start, end, proofLen }` — picks the 1st or 2nd inline `Coll[Byte]` based on a per-handler config.
4. `evalSafely(treeBytes, optsJson): EvalOutcome` — try/catch around `parseTree` + `evaluateWith`; returns a discriminated-union outcome (`ok: true | false` with error code on the failure branch).
5. `svalueEqual(a, b): boolean` — JSON-stringify-based deep equality with BigInt safety.
6. `isKill(baseline, mutated, handlerName): boolean` — the 4-case kill rule (both threw → no kill; one threw → kill; both ok → kill iff values differ).
7. Runner: for each XOR pattern × byte in region, mutate → eval → count kill; assert per-handler and aggregate rate ≥ 0.90.

Reviewer signal (per `SESSION_CONTEXT.md` lines 80-82): "now at 5 copies across [the 5 files]. Per multiple reviewers, crosses the consolidation threshold. Promote to `test/_helpers/mutation-harness.ts` in a dedicated refactor PR." Phase 2h-d's reviewers flagged this as the load-bearing carry-forward debt item.

Friction if deferred: every new method handler with a mutation-test requirement (Tier-3 cleanup, predefs, future SHeader.* additions) copy-pastes the 100+ LOC pattern. By the time we ship phase 2i (predefs, ~5-8 more handlers), we'd be at 10-13 copies.

### Refactor 2 — Rust `make_resolver`

Nine identical copies (verified by grep, ergoscript-eval scope):

```text
savltree_insert.rs:53
savltree_get.rs:42
savltree_get_many.rs:42
savltree_contains.rs:44
savltree_remove.rs:50
savltree_update.rs:50
savltree_partial_success.rs:109
savltree_insert_or_update.rs:156
(+ cmds/avltree.rs:142 — different module path; see Non-goals R3)
```

Each is byte-identical:

```rust
fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}
```

Pre-existing tech debt since phase 2h-a (the first AVL fixture module). Per `SESSION_CONTEXT.md` line 82: "5+ copies. Pre-existing tech debt; deferred." Actually 8 within the consolidatable scope; well past the 5-copy threshold.

Friction if deferred: every new SAvlTree-method fixture-gen module adds another copy.

### Refactor 3 — Rust `avl_tree_value_json`

Two copies (verified):

```text
savltree_update_operations.rs:49
savltree_update_digest.rs:92
```

Each encodes a bare `Value::AvlTree(avl)` as `{ "kind": "AvlTree", "value": <avl_tree_data> }`, matching `hydrateSValue` at `test/_helpers/index.ts:94`. The Option-wrapped variant `option_avl_tree_json` is already promoted to `pub(super)` from `savltree_insert.rs:81` (consumers: `savltree_insert.rs`, `savltree_insert_or_update.rs`, `savltree_partial_success.rs` per the cross-module re-export at `savltree_insert.rs:81`).

Two copies is below the 5-copy threshold cited in `SESSION_CONTEXT.md`, but consolidating costs minutes while we're in the area; symmetry with the already-promoted `option_avl_tree_json` is a forcing function. The opportunistic dedup avoids the "next AVL-returning fixture-gen module adds a 5th copy" trigger preemptively.

## Architecture

### Refactor 1 — TS mutation-harness (`packages/ergoscript/test/_helpers/mutation-harness.ts`)

**New file:** `packages/ergoscript/test/_helpers/mutation-harness.ts`, ~150-200 LOC.

**Exported surface:**

```ts
// ─── Inline-Coll[Byte] location ─────────────────────────────────────────────

/** Collect every inline `Const(Coll[Byte], …)` value reachable from `expr`,
 *  in depth-first order. */
export function findInlineByteColls(expr: Expr): Uint8Array[]

/** Locate `needle` as a contiguous byte substring of `haystack`; return the
 *  starting BYTE offset. Throws if zero or multiple matches (ambiguous). */
export function locateBytes(haystack: Uint8Array, needle: Uint8Array): number

/** Locate a proof region by index into the inline-Coll[Byte] list. */
export function locateInlineCollRegion(
  treeBytes: Uint8Array,
  tree: ErgoTree,
  collIndex: number,
): { start: number; end: number; length: number }

// ─── Evaluation outcome + kill criteria ─────────────────────────────────────

export type EvalOutcome =
  | { ok: true; value: SValue }
  | { ok: false; errorCode: string | undefined; errorMessage: string }

/** Wrap `parseTree` + `evaluateWith` in try/catch; surface EvalError code. */
export function evalSafely(
  treeBytes: Uint8Array,
  optsJson: Record<string, unknown>,
): EvalOutcome

/** JSON-stringify-based SValue deep equality, BigInt-safe. */
export function svalueEqual(a: SValue, b: SValue): boolean

/** The standard 4-case kill rule (both threw → no kill; one threw → kill;
 *  both ok → kill iff values differ). */
export function isKillStandard(baseline: EvalOutcome, mutated: EvalOutcome): boolean

// ─── Runner ─────────────────────────────────────────────────────────────────

export const XOR_PATTERNS_STANDARD = [0xff, 0x01, 0x80]
export const DEFAULT_KILL_THRESHOLD = 0.9

export interface MutationRunConfig {
  treeBytes: Uint8Array
  region: { start: number; end: number }
  optsJson: Record<string, unknown>
  xorPatterns?: number[]              // default XOR_PATTERNS_STANDARD
  isKill?: (baseline: EvalOutcome, mutated: EvalOutcome) => boolean // default isKillStandard
}

export interface MutationRunResult {
  killed: number
  total: number
  rate: number
}

/** Execute the mutation loop and return the kill counts.
 *  Caller is responsible for asserting against a threshold. */
export function runMutationLoop(config: MutationRunConfig): MutationRunResult
```

**Migration of 5 consumers:**

Each file replaces its local `findInlineByteColls` / `locateBytes` / `locateProofRegion` / `EvalOutcome` / `evalSafely` / `svalueEqual` / `isKill` / runner-loop with an import + a thin per-handler wrapper that:

1. Picks the inline-Coll[Byte] index for that handler's proof region (`collIndex: 0` or `collIndex: 1`).
2. Defines any handler-specific kill criteria (most are the standard rule; `sheader-checkpow-mutation` may have a one-byte-flip tolerance worth preserving).
3. Calls `runMutationLoop` and asserts on `rate >= DEFAULT_KILL_THRESHOLD`.

Each consumer file shrinks from 166-409 LOC to roughly 80-180 LOC, retaining only the per-handler scenario list + handler-specific tolerance enumeration + assertion shape. Aggregate diff: −400 to −700 LOC across the 5 files.

**Variance to preserve:** the `savltree-update-digest.test.ts` and `savltree-update-operations.test.ts` files contain BOTH a handler-correctness test suite AND a mutation suite in one file. The refactor splits responsibility: handler-correctness stays in the existing file; mutation-loop usage moves through the shared harness. The file boundary does NOT change; only the imports and the body of the mutation `describe(…)` block do.

### Refactor 2 — Rust `make_resolver`

**New file:** `fixture-gen/src/cmds/ergoscript/eval/savltree_helpers.rs`. Single `pub(super)` function:

```rust
//! Shared helpers for the SAvlTree fixture-gen modules.
//!
//! Consolidates the `make_resolver` closure-factory previously duplicated
//! across 8 sibling modules (savltree_insert/update/get/get_many/contains/
//! remove/partial_success/insert_or_update). Promoted in Phase 2h-e per
//! `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md`.

use std::sync::Arc;

use ergo_avltree_rust::batch_node::{Node, NodeHeader};
use ergo_avltree_rust::operation::Digest32;

/// Factory for the `BatchAVLProver`'s node-resolver. Returns a closure that
/// produces `Node::LabelOnly` from any 32-byte digest input.
pub(super) fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}
```

**Migration:** the 8 ergoscript-eval consumers replace their local `fn make_resolver` definition with `use super::savltree_helpers::make_resolver;` plus a `mod savltree_helpers;` declaration in `fixture-gen/src/cmds/ergoscript/eval/mod.rs`.

**Why a dedicated file rather than a `common.rs` extension:** `common.rs` is shared across the broader ergoscript-eval fixture-gen surface (cost-tagging helpers, type-encoding helpers per `savltree_insert.rs:51`). Adding an AVL-specific resolver to `common.rs` would couple the shared-everything module to AVL specifics. A focused `savltree_helpers.rs` co-locates AVL-specific helpers (and gives `avl_tree_value_json` from Refactor 3 a natural home if we choose to use it instead of re-exporting from `savltree_insert.rs` — see Q1 below).

### Refactor 3 — Rust `avl_tree_value_json`

**No new file.** Promote one copy of `avl_tree_value_json` from `savltree_update_operations.rs:49` (the chronologically-earlier of the two copies) to `pub(super)` in `savltree_insert.rs`, placed adjacent to the existing `option_avl_tree_json` at line 81 for visual symmetry.

```rust
// In savltree_insert.rs, after option_avl_tree_json:

/// Encode an `AvlTree` Value as the TS SValue AvlTree variant:
///   `{ kind: "AvlTree", value: <avl_tree_data> }`
/// matching `hydrateSValue` at `packages/ergoscript/test/_helpers/index.ts:94`.
pub(super) fn avl_tree_value_json(value: &Value) -> anyhow::Result<JsonValue> {
    match value {
        Value::AvlTree(avl) => Ok(json!({
            "kind": "AvlTree",
            "value": avl_tree_data_to_json(avl),
        })),
        other => anyhow::bail!("expected Value::AvlTree, got {:?}", other),
    }
}
```

**Migration:** `savltree_update_operations.rs` and `savltree_update_digest.rs` remove their local `fn avl_tree_value_json` and add `use super::savltree_insert::avl_tree_value_json;` to the existing import block. The error-message prefix string (currently per-module: `"savltree_update_operations: …"` etc.) is genericized — `anyhow::bail!` is human-debug-only, so the module-name prefix has low load-bearing value.

**Alternative considered (Q1 below):** put `avl_tree_value_json` in the new `savltree_helpers.rs` from Refactor 2 instead of in `savltree_insert.rs`. Either home works; the `savltree_insert.rs` placement keeps the `pub(super)` JSON-encoder helpers (`avl_tree_data_to_json`, `savl_tree_type_json`, `option_avl_tree_json`, `avl_tree_value_json`) co-located in one module. Decision deferred to implementation; if `savltree_helpers.rs` ends up housing JSON helpers, move all four. If it stays resolver-only, keep JSON helpers in `savltree_insert.rs`.

### Cross-cutting guarantees (inherited unchanged)

- Browser-compat: no `Buffer`, no `node:*`, no `globalThis.crypto.subtle`. All Uint8Array. (Unchanged — refactor doesn't touch `packages/*/src/`.)
- Determinism: pure handlers and helpers, no clock/PRNG/I/O. fixture-gen output is byte-identical pre/post refactor.
- ESM only. No top-level await.
- No WASM, direct or transitive.
- `@noble/hashes@2.2.0` and `@noble/curves@2.2.0` runtime deps unchanged.
- No version bumps across any package (no public-API change in any of `@ergots/scorex`, `@ergots/nipopow`, `@ergots/avltree`, `@ergots/ergoscript`).

## Implementation plan (3 refactors, ~7-10 commits)

Per `[[feedback-no-artificial-stops]]`, refactors are natural commit boundaries with no mid-phase stops. Per-refactor TDD discipline degenerates to "snapshot, refactor, diff" since no new behavior is added.

### Refactor 1 — TS mutation-harness (~3-4 commits)

1. **Capture baseline kill rates.** Run the full mutation-test suite under vitest and grep-capture the `console.log [mutation] …` lines from each test into a transient `/tmp/kill-rates-pre.txt`. These will be diffed against post-refactor output to assert kill-rate parity.
2. **Create `mutation-harness.ts`** with the surface enumerated in Architecture R1. Extract from `savltree-mutation.test.ts` (the largest, most-complete consumer) as the canonical source.
3. **Migrate `savltree-mutation.test.ts`** to import + thin wrapper. Verify test count unchanged. Verify kill-rate output diff is zero (or below a sub-percent floating-point-tolerance band — vitest log lines are deterministic so should be exact-equal).
4. **Migrate the remaining 4 consumers** in one commit each (or batched 2-per-commit if all are small) — `sheader-checkpow-mutation`, `savltree-update-operations`, `savltree-update-digest`, `savltree-insert-or-update`. After each, verify aggregate vitest count unchanged and kill rates unchanged.

Expected commits: 4 (1 baseline-capture-or-prep + 1 harness-creation + 1-2 consumer-migration).

### Refactor 2 — Rust `make_resolver` (~2-3 commits)

1. **Create `fixture-gen/src/cmds/ergoscript/eval/savltree_helpers.rs`** with the `make_resolver` function and `mod savltree_helpers;` declaration in `mod.rs`. Run `cargo build --release` to confirm zero new warnings.
2. **Migrate 8 consumers** in one commit. Pre/post `cargo run -p fixture-gen --release` byte-equality assertion is the load-bearing gate (any drift = halt and investigate).
3. **Optional: visibility verification.** `cargo doc --no-deps` or grep for residual `fn make_resolver` definitions to confirm all 8 are gone.

Expected commits: 2.

### Refactor 3 — Rust `avl_tree_value_json` (~1 commit)

1. **Promote one copy of `avl_tree_value_json`** to `pub(super)` in `savltree_insert.rs` (or `savltree_helpers.rs` per Q1 resolution). Remove the two local copies; add imports in the two consumers. Run `cargo build --release` + `cargo run --release` determinism check.

Expected commits: 1.

### Final verification (~1-2 commits)

1. **Cross-package typecheck + cross-runtime jsdom + fixture-gen determinism** per the standard verification suite (see Verification commands section below). All must be clean.
2. **Test count sanity-check.** Aggregate test count is **invariant** through this phase. Pre-phase: 3481 across 4 packages. Post-phase: 3481 across 4 packages. Any other delta = regression that must be diagnosed.
3. **Mutation kill-rate parity.** Compare `kill-rates-pre.txt` (from Refactor 1 step 1) against the post-refactor equivalent. Diff is expected to be zero.
4. **Optional `SESSION_CONTEXT.md` and CLAUDE.md doc refresh** if any of the deferred items called out in those files (mutation-harness helper consolidation, fixture-gen `avl_tree_value_json` consolidation) need their status updated.

Expected commits: 1-2 (the doc refresh, if any).

**Total expected commits: 7-10 across the 3 refactors + final verification.** Sized lighter than 2h-d's 26 (this is pure refactor, no fixture-gen scenario authoring, no handler authoring, no spec/plan churn).

## Test strategy

This is a refactor — the test strategy is **invariance**, not new coverage. Each commit asserts:

1. **Test counts unchanged.** Before and after each refactor, `node_modules/.bin/vitest run packages/` reports the same total (3481). Per-file counts shift as tests reorganize but the aggregate is invariant. Per-package counts (scorex 177; nipopow 245; avltree 156; ergoscript 2903) are also invariant.

2. **Test results unchanged.** Specifically: each refactored mutation test reports the same kill rate per handler scenario as before. Pre-refactor kill rates are captured into a transient file (Refactor 1 step 1); post-refactor diff against the file must be empty.

3. **Fixture-gen determinism.** Each Rust commit runs `cargo run -p fixture-gen --release` twice and checks `git diff --exit-code packages/`. Determinism failure halts the phase and is investigated as a regression of the byte-equality testing strategy.

4. **Cross-runtime jsdom unchanged.** Same count under jsdom too (177 + 245 + 156 + 2903 = 3481).

5. **No new fixtures generated.** No new test files added. No new EvalError codes. No new method handlers. No new SValue variants. No new error classes. No `facts/*.md` content drift (Coverage table refreshes are not needed — counts are unchanged).

Per the Iron Law adapted for refactor work: no production code change is acceptable in this phase. Every commit's diff is either test-helper code (TS) or fixture-gen code (Rust), never `packages/*/src/`. CI's existing `dist/` no-WASM scan and per-package typecheck continue to guard the production surface.

## Risks & mitigations

**R1 — Mutation kill-rate drift.** If the extracted `runMutationLoop` differs subtly from any of the 5 inlined loops, post-refactor kill rates could shift by ±1-2%. Mitigation: the baseline-capture step (Refactor 1 step 1) records exact kill counts; the migration commits assert equality, not threshold satisfaction. A drift halts the phase pending investigation. **Critical risk** — kill-rate equivalence is the load-bearing invariant for this refactor.

**R2 — `isKill` per-handler variants.** Re-read of `savltree-mutation.test.ts:211-218` shows the kill rule takes a `_handler: string` parameter that is *currently unused* — "all six handlers follow the same throw OR diverge kill rule". The 5 consumer files should likewise share the standard rule. If one consumer (e.g. `sheader-checkpow-mutation`) turns out to have a non-trivial handler-specific kill criterion, surface it as a per-consumer custom `isKill` lambda passed via `MutationRunConfig`. **Pre-check:** grep `function isKill\|isKill =\|isKill(` across the 5 files at Refactor 1 step 2 start; confirm all use the standard rule (or enumerate exceptions).

**R3 — fixture-gen determinism regression.** Any reordering of helper-function placement could change Rust's symbol-table layout in debug info, but `release` builds strip debug symbols. The fixture-gen output is JSON + raw bytes generated via `serde_json::json!` and `hex::encode` — neither depends on symbol layout. Mitigation: standard `cargo run --release` twice + `git diff --exit-code packages/` per fixture-gen commit. Pre-validate on a smoke test before the main migration commit.

**R4 — Rust `use super::savltree_insert::avl_tree_value_json;` cycle risk.** `savltree_update_operations.rs` and `savltree_update_digest.rs` already import `avl_tree_data_to_json` from `savltree_insert.rs` (verified: `savltree_update_operations.rs:44`). Adding a second import from the same parent is identity-safe. No new cycle introduced.

**R5 — Q1 (`savltree_helpers.rs` placement choice) drift.** If Refactor 3 chooses `savltree_helpers.rs` as the new home for `avl_tree_value_json` rather than `savltree_insert.rs`, all four `pub(super)` JSON encoders (`avl_tree_data_to_json`, `savl_tree_type_json`, `option_avl_tree_json`, `avl_tree_value_json`) should move together for symmetry. Don't half-move. Decision deferred to implementation per Q1; document the choice in the implementing commit message.

**R6 — Mutation-test logging side effect.** The 5 consumer files emit `console.log [mutation] …` lines for offline analysis. The extracted `runMutationLoop` must preserve this logging (consumers depend on the log lines for debugging when kill rates drop). Mitigation: include logging in the extracted runner; alternatively, return a `logLine: string` field on `MutationRunResult` and let the caller emit. Choice deferred — implementer can pick whichever reads cleaner.

**R7 — `audit20260519/` untracked changes.** The audit directory is gitignored. No risk to this phase, but a reminder: do not stage anything in that directory. `git add` should use specific paths, not `git add -A`.

## Open questions deferred to implementation

- **Q1: `avl_tree_value_json` home — `savltree_insert.rs` (with siblings) or `savltree_helpers.rs` (with `make_resolver`)?** Implementation decides. If choosing the latter, move all four JSON encoders together (`avl_tree_data_to_json`, `savl_tree_type_json`, `option_avl_tree_json`, `avl_tree_value_json`) for symmetry.

- **Q2: `MutationRunConfig` shape — `MutationRunConfig` with a single proof region, or a generalized "byte ranges to mutate" list?** Single-region matches today's 5 consumers exactly. A multi-region future-proof shape would handle a future "mutate the proof bytes AND the digest bytes" test. Pick single-region for now; YAGNI on multi-region. Surface in implementation if it becomes needed.

- **Q3: Mutation kill rate output format.** Implementation may want to standardize the `console.log` line format across the 5 consumers (today's format is consistent because all 5 were authored from one template, but the line breaks differ). Cosmetic; do it or skip it based on diff size at implementation time.

- **Q4: Helper naming.** `runMutationLoop` is fine but `runByteLevelMutationLoop` is more precise (this is NOT Expr-tree-level mutation, which is `eval-mutation.test.ts`'s domain). Name choice deferred to implementation.

## Verification commands (run after each commit, must be clean)

```bash
# Per-commit verification (TS-side refactor commits)
npx tsc --noEmit -p packages/scorex/tsconfig.json                     # CLEAN
npx tsc --noEmit -p packages/nipopow/tsconfig.json                    # CLEAN
npx tsc --noEmit -p packages/avltree/tsconfig.json                    # CLEAN
npx tsc --noEmit -p packages/ergoscript/tsconfig.json                 # CLEAN
node_modules/.bin/vitest run packages/                                # 3481 pass

# Per-commit verification (Rust-side refactor commits)
cd fixture-gen && cargo build --release                               # CLEAN
cd fixture-gen && cargo run --release                                 # outputs unchanged
git diff --exit-code packages/                                        # CLEAN (no fixture drift)
# Then run cargo run AGAIN — the second run also produces no diff:
cd fixture-gen && cargo run --release && git diff --exit-code packages/   # CLEAN

# End-of-phase verification (one-time, after Refactor 3)
cd packages/scorex && npx vitest run --config vitest.browser.config.ts    # 177 pass under jsdom
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts   # 245 pass under jsdom
cd packages/avltree && npx vitest run --config vitest.browser.config.ts   # 156 pass under jsdom
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts # 2903 pass under jsdom
git status                                                            # CLEAN (modulo gitignored audit20260519/)
```

Pre-refactor kill-rate capture (Refactor 1 step 1):

```bash
node_modules/.bin/vitest run packages/ergoscript 2>&1 | \
  grep '^\[mutation\]' > /tmp/kill-rates-pre.txt
```

Post-refactor kill-rate diff (Refactor 1 step 5, before final verification):

```bash
node_modules/.bin/vitest run packages/ergoscript 2>&1 | \
  grep '^\[mutation\]' > /tmp/kill-rates-post.txt
diff /tmp/kill-rates-pre.txt /tmp/kill-rates-post.txt    # EMPTY
```

## Cross-references

- `facts/ergoscript-eval.md` — unchanged by this phase (no method-handler registry change, no `EvalError` taxonomy change)
- `facts/ergoscript.md` — unchanged
- `facts/avltree.md` — unchanged
- `facts/scorex.md` — unchanged
- `facts/nipopow.md` — unchanged
- `docs/specs/2026-05-20-ergoscript-phase-2h-d-savltree-completion-design.md` — predecessor; flagged this consolidation as deferred ("Items intentionally deferred from this phase")
- `SESSION_CONTEXT.md` — lines 79-83 enumerate the deferred items (`Mutation-harness helper consolidation`, `Rust fixture-gen avl_tree_value_json consolidation`, `Rust fixture-gen make_resolver + build_proof_for_ops consolidation`)
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `packages/ergoscript/test/_helpers/index.ts` — existing helpers module (`hexToBytes`, `hydrateSValue`, etc.); new `mutation-harness.ts` is a sibling, not an extension
- `~/projects/ergots/external/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — fixture-gen reference (unchanged)
