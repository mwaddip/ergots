# Phase 2f Coll HOFs Implementation Plan — `@mwaddip/ergots-ergoscript`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship phase 2f Coll HOFs: 9 new evaluator arms covering all direct-`Expr` Coll-operation MIR variants (`SizeOf`, `Append`, `ByIndex`, `Slice`, `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll`). Closes the umbrella plan's "phase 2f = collection operations" promise. Coverage 33 → 42 of ~70 arms; 7 new `EvalError` codes (28 → 35); new `EvalContext.addPerItemCost` infrastructure; new Layer C3.a operator-driven mutation testing infrastructure. Layer C3.a is scoped to the 9 Coll HOFs only.

**Architecture:** 14 tasks in flat ordering with commits between each (no `STOP α/β/γ` markers — per `[[feedback-no-artificial-stops]]` memory). Tasks 1-10 wire arms (Task 1 = foundation infra; Tasks 2-10 = one arm each). Tasks 11-12 build and calibrate the new C3.a mutation-testing layer. Tasks 13-14 update docs/memory/SESSION_CONTEXT and push. All arms charge cost per source-read findings; the lambda HOFs use the new **Mixed pattern** (outer chunked + per-iter) which extends the existing `[[reference-cost-charging-order-patterns]]` memory's Pattern A vs B split.

**Tech Stack:** TypeScript 5.5 (ES2022, ESM only), Vitest 2 with jsdom, Rust fixture-gen calling into sigma-rust's `ergotree-interpreter` crate at `integration/ergots@ed5452cf` via the `arbitrary` feature + `try_eval_out::<Value<'static>>` wedge. No new runtime deps. No `@noble/curves` (still phase 2g sigma protocol). All 9 MIR variants wire-parse cleanly via phase 2a — no new wire-format work.

**Source-first discipline:** Read sigma-rust per task before writing any TS. Authoritative sources for slice 2f Coll HOFs:

- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_size.rs` — SizeOf (Pattern A: `Fixed(14)`)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_append.rs` — Append (Pattern B-chunked: `PerItem(20, 2, 100, n1+n2)`)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_by_index.rs` — ByIndex (Pattern A: `Fixed(30)` + lazy default)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_slice.rs` — Slice (Pattern B-chunked + intersection semantics; bug-7 / issue #724 regression at line 168)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_map.rs` — MapColl (Mixed: outer `PerItem(20, 1, 10, n)` + per-iter `Fixed(5)`)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_filter.rs` — Filter (Mixed: same as Map)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_fold.rs` — Fold (Mixed: outer `PerItem(3, 1, 10, n)` + per-iter `Fixed(5)`); proptest example at line 100-150
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_exists.rs` — Exists (Mixed: outer charges full length regardless of short-circuit)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_forall.rs` — ForAll (Mixed: same short-circuit subtlety as Exists)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/cost_accum.rs::add_per_item_jit_cost` — chunked cost primitive (formula: `base + perChunk * ceil(items / chunkSize)`)

Full design rationale: `docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md`.

**TDD discipline:** Iron Law per `CLAUDE.md` — no production code without a failing test first. Each task follows red → green → cost-assert → corpus-check → commit. Per-arm cadence with two-stage review (spec compliance + code quality) per task.

---

## File Structure

**New files (TypeScript source):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/src/eval/_coll-helpers.ts` | `extractCollItems` + `extractFuncValue` shared guards | 1 |
| `packages/ergoscript/src/eval/coll-size.ts` | `evalSizeOf` arm | 2 |
| `packages/ergoscript/src/eval/coll-append.ts` | `evalAppend` arm | 3 |
| `packages/ergoscript/src/eval/coll-by-index.ts` | `evalByIndex` arm | 4 |
| `packages/ergoscript/src/eval/coll-slice.ts` | `evalSlice` arm | 5 |
| `packages/ergoscript/src/eval/coll-map.ts` | `evalMapColl` arm | 6 |
| `packages/ergoscript/src/eval/coll-filter.ts` | `evalFilter` arm | 7 |
| `packages/ergoscript/src/eval/coll-fold.ts` | `evalFold` arm | 8 |
| `packages/ergoscript/src/eval/coll-exists.ts` | `evalExists` arm | 9 |
| `packages/ergoscript/src/eval/coll-forall.ts` | `evalForAll` arm | 10 |

**New files (TypeScript tests):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/test/eval/coll-size.test.ts` | Per-arm fixture-driven C1 tests | 2 |
| `packages/ergoscript/test/eval/coll-append.test.ts` | Same | 3 |
| `packages/ergoscript/test/eval/coll-by-index.test.ts` | Same | 4 |
| `packages/ergoscript/test/eval/coll-slice.test.ts` | Same | 5 |
| `packages/ergoscript/test/eval/coll-map.test.ts` | Same | 6 |
| `packages/ergoscript/test/eval/coll-filter.test.ts` | Same | 7 |
| `packages/ergoscript/test/eval/coll-fold.test.ts` | Same | 8 |
| `packages/ergoscript/test/eval/coll-exists.test.ts` | Same | 9 |
| `packages/ergoscript/test/eval/coll-forall.test.ts` | Same | 10 |
| `packages/ergoscript/test/_mutation-operators.ts` | C3.a operators O1–O7 + helper apparatus | 11 |
| `packages/ergoscript/test/eval-mutation.test.ts` | C3.a runner: iterate fixtures × operators, kill-criteria assertions | 11 |
| `packages/ergoscript/test/_mutation-allowlist.ts` | Expected-survival allowlist (populated by Task 12) | 12 |

**New files (Rust fixture-gen):**

| Path | Responsibility | Task |
|---|---|---|
| `fixture-gen/src/cmds/ergoscript/eval/coll_size.rs` | SizeOf entries | 2 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_append.rs` | Append entries | 3 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_by_index.rs` | ByIndex entries (incl OOB-with-default laziness) | 4 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_slice.rs` | Slice entries (incl cost-on-requested-range smoking-gun) | 5 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_map.rs` | MapColl entries (incl mixed-pattern smoking-gun) | 6 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_filter.rs` | Filter entries | 7 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_fold.rs` | Fold entries | 8 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_exists.rs` | Exists entries (incl outer-cost-on-full-length smoking-gun) | 9 |
| `fixture-gen/src/cmds/ergoscript/eval/coll_forall.rs` | ForAll entries (symmetric to Exists) | 10 |

**Generated fixture files** (`packages/ergoscript/test/fixtures/eval/*.json`): 9 new — generated automatically by fixture-gen, committed by the corresponding task.

**Modified files (TypeScript source):**

| Path | Modification | Task |
|---|---|---|
| `packages/ergoscript/src/eval/eval-context.ts` | Add `addPerItemCost(base, perChunk, chunkSize, items)` method | 1 |
| `packages/ergoscript/src/eval/eval.ts` | Add 9 new `case` lines (one per arm) | 2-10 |

**Modified files (Rust fixture-gen):**

| Path | Modification | Task |
|---|---|---|
| `fixture-gen/src/cmds/ergoscript/eval/mod.rs` | Re-export 9 new per-arm modules | 2-10 |
| `fixture-gen/src/main.rs` | Wire 9 new `generate_and_write` calls | 2-10 |

**Modified files (docs / memory) — Task 13-14 only:**

| Path | Modification | Task |
|---|---|---|
| `facts/ergoscript.md` | Coverage 33 → 42; 7 new EvalError codes; `addPerItemCost` documented in `EvalContext`; "Does NOT ship yet" entry updated | 13 |
| `docs/specs/2026-05-13-ergoscript-interpreter-design.md` | Add "delivered as" annotations to umbrella's 2e/2f rows; insert new "2g.5 method-call dispatch" row before 2h | 13 |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` | Updated: phase 2f Coll HOFs shipped; next is phase 2g (sigma protocol, umbrella-aligned) | 14 |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/reference_cost_charging_order_patterns.md` | Document the Mixed pattern (Pattern A and Pattern B can coexist within one arm; lambda HOFs are the canonical example) | 14 |
| `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md` | Update the hook line for `project_ergots_direction` | 14 |
| `packages/ergoscript/SESSION_CONTEXT.md` | Fresh snapshot for phase 2f Coll HOFs done state (gitignored, local-only) | 14 |

**Unchanged (deliberately):**
- `packages/ergoscript/src/index.ts` — public surface re-exports unchanged.
- `packages/ergoscript/src/eval/evaluate.ts` / `evaluate-with.ts` — no signature changes (the new `addPerItemCost` is an internal `EvalContext` addition; `EvalOpts` unchanged).
- `packages/ergoscript/src/mir/types.ts` — `SizeOf`, `Append`, `ByIndex`, `Slice`, `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll` already declared as MIR variants since phase 2a.
- `packages/ergoscript/test/_helpers/index.ts` — existing helpers (`hexToBytes`, `hydrateSValue`, `captureEvalError`, `rehydrateEvalOpts`, `hydrateErgoBox`) cover every new test file.
- `packages/ergoscript/src/wire/parse.ts` / `serialize.ts` — wire-format support already shipped in phase 2a.

---

## Conventions and workflow

These apply to every task. Don't repeat them per-task.

**Per-task arc:**
1. Read sigma-rust source for the arm (cited path in each task).
2. Write the fixture-gen Rust module (`fixture-gen/src/cmds/ergoscript/eval/coll_*.rs`).
3. Wire fixture-gen: add `pub mod coll_*;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs` and `generate_and_write` call to `fixture-gen/src/main.rs`.
4. Run `cargo run --release -p fixture-gen` from repo root. Verify the new fixture file appears at `packages/ergoscript/test/fixtures/eval/coll-*.json`.
5. Verify determinism: regenerate (re-run cargo run), then `git diff packages/ergoscript/test/fixtures/` — must be empty.
6. Write the failing TS test (red).
7. Run `npx vitest run packages/ergoscript/test/eval/coll-*.test.ts`; verify FAIL with the expected reason (typically "module not found" or "function not defined").
8. Write the minimal TS arm implementation (green).
9. Wire the arm into central dispatch (`eval/eval.ts`) by adding the appropriate `case` line.
10. Run the per-arm test; verify PASS.
11. Run the full ergoscript suite: `npx vitest run packages/ergoscript/`; verify all previous tests still pass.
12. Run `npx tsc --noEmit -p packages/ergoscript`; verify zero errors.
13. Two-stage review (spec compliance + code quality) — orchestrator's job. Pattern: dispatch two parallel review subagents after each task's green-+-typecheck-passes state.
14. Commit (one commit per task; orchestrator may request a fix commit after review).

**Fixture-gen execution:** Always `cargo run --release -p fixture-gen` from `/home/mwaddip/projects/ergots`. Determinism check per task: regenerate, then `git diff packages/ergoscript/test/fixtures/` — must be empty.

**Controlled-Context builder for fixture-gen:** Phase 2f narrow + medium established that `force_any_val::<Context>()` is non-deterministic in `pre_header` fields. For Coll HOF fixtures, most tests don't depend on chain-state context (the Coll values are constructed inline), so a default `Context` from prior tasks' controlled-builder helper is enough. If a fixture needs a specific `Context` (e.g., to exercise `INPUTS.fold(...)`), use the controlled-Context builder from `fixture-gen/src/cmds/ergoscript/eval/common.rs` (added in phase 2f medium Task 1).

**Cost values:** Read from sigma-rust per arm. Confirmed values for slice 2f Coll HOFs:

| Arm | Outer cost | Per-iter cost | Sigma-rust source |
|---|---|---|---|
| SizeOf | `Fixed(14)` (Pattern A; before child) | — | `eval/coll_size.rs:15` |
| Append | `PerItem(20, 2, 100, n1+n2)` (Pattern B-chunked; after children) | — | `eval/coll_append.rs:57` |
| ByIndex | `Fixed(30)` (Pattern A; before child) + lazy default eval | — | `eval/coll_by_index.rs:18` |
| Slice | `PerItem(10, 2, 100, max(0, until-from))` (Pattern B-chunked) | — | `eval/coll_slice.rs:32` |
| MapColl | `PerItem(20, 1, 10, n_input)` (after children, before loop) | `Fixed(5)` per item | `eval/coll_map.rs:31, 72` |
| Filter | `PerItem(20, 1, 10, n_input)` (after children, before loop) | `Fixed(5)` per item | `eval/coll_filter.rs:32, 60` |
| Fold | `PerItem(3, 1, 10, n_input)` (after eval-input, before loop) | `Fixed(5)` per item | `eval/coll_fold.rs:29, 48` |
| Exists | `PerItem(3, 1, 10, n_input)` (charges full length regardless of short-circuit) | `Fixed(5)` per visited item | `eval/coll_exists.rs:29, 60` |
| ForAll | `PerItem(3, 1, 10, n_input)` (same short-circuit subtlety as Exists) | `Fixed(5)` per visited item | `eval/coll_forall.rs:29, 60` |

**`addPerItemCost` formula:** `cost = base + perChunk * ceil(items / chunkSize)`. Throws `'cost-limit-exceeded'` on overflow. **Edge case for `items = 0`:** `ceil(0 / chunkSize) = 0`, so cost = `base + 0 = base`. Verify in Task 1 unit tests.

**Browser compatibility checks:** Every new TS module follows the existing hard rules (no `Buffer`, no `node:*` outside test files, no `globalThis.crypto`, no WASM, ESM only, no top-level await).

**Two-stage review (per task):** Orchestrator dispatches two parallel review subagents after each task's green-+-typecheck-passes state:
- **Spec-compliance reviewer** — reads `docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md`, this PLAN's task section, and the diff. Verifies behavior matches the design.
- **Code-quality reviewer** — reads the diff. Verifies test style, idioms, no `any` leaks, comments cite sigma-rust source lines.

**Commit message style:** HEREDOC format per CLAUDE.md. Per-task subject pattern (mirrors phase 2f medium): `feat(ergoscript): <arm-name> eval arm (phase 2f coll-hofs task N)`. Trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` mandatory.

**No STOP markers in this slice.** Per [[feedback-no-artificial-stops]] memory. Commits between every task are the granular checkpoints; resumable at any task boundary.

---

## Task 1: Foundation — `addPerItemCost` + `_coll-helpers.ts`

**Files:**
- Modify: `packages/ergoscript/src/eval/eval-context.ts` — add `addPerItemCost` method
- Create: `packages/ergoscript/src/eval/_coll-helpers.ts` — `extractCollItems` + `extractFuncValue`
- Create: `packages/ergoscript/test/eval/_addPerItemCost.test.ts` — unit tests for the cost helper
- Create: `packages/ergoscript/test/eval/_coll-helpers.test.ts` — unit tests for the guards

**Sigma-rust sources:**
- `ergotree-interpreter/src/eval/cost_accum.rs::add_per_item_jit_cost` — formula
- `ergotree-interpreter/src/eval/coll_map.rs` (etc.) — usage examples

**Key behavior:**

`addPerItemCost(base: number, perChunk: number, chunkSize: number, items: number): void` computes `base + perChunk * ceil(items / chunkSize)` and adds it to the accumulator. Throws `'cost-limit-exceeded'` if the new total exceeds `jitCostLimit`.

`extractCollItems(v: SValue): { items: SValue[]; elem: SType }` guards `v.kind === 'Coll'`; throws `'coll-input-not-coll'` otherwise.

`extractFuncValue(v: SValue): Closure` guards `v.kind === 'Lambda'` AND `closure.argIds.length > 0`; throws `'lambda-not-callable'` for either failure (merged code per Decision #8). Pre-stubbed in this task; consumed from Task 6.

- [ ] **Step 1: Read sigma-rust `add_per_item_jit_cost` to confirm formula**

```bash
grep -n "fn add_per_item_jit_cost" ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/cost_accum.rs
```

Confirm: `cost = base + per_chunk * ceil(items / chunk_size)`. Verify the integer division uses ceiling (the Rust impl typically computes `(items + chunk_size - 1) / chunk_size`).

- [ ] **Step 2: Read the existing `EvalContext` interface**

```bash
cat /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/eval-context.ts
```

Confirm the existing `addCost` method signature and accumulator field shape. Note: `addCost` typically reads/writes `ctx.jitCostAccumulator` and checks against `ctx.jitCostLimit`.

- [ ] **Step 3: Write the failing test for `addPerItemCost`**

Create `packages/ergoscript/test/eval/_addPerItemCost.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { makeContext } from '../../src/eval/eval-context'
import { EvalError } from '../../src/eval/errors'

describe('addPerItemCost', () => {
  it('cost = base when items = 0', () => {
    const ctx = makeContext({ jitCostLimit: 1000 })
    const before = ctx.jitCostAccumulator
    ctx.addPerItemCost(20, 2, 100, 0)
    expect(ctx.jitCostAccumulator - before).toBe(20)
  })

  it('cost = base + perChunk when items = chunkSize', () => {
    const ctx = makeContext({ jitCostLimit: 1000 })
    const before = ctx.jitCostAccumulator
    ctx.addPerItemCost(20, 2, 100, 100)
    expect(ctx.jitCostAccumulator - before).toBe(22)  // 20 + 2 * ceil(100/100) = 20 + 2 * 1 = 22
  })

  it('cost = base + 2*perChunk when items = chunkSize + 1', () => {
    const ctx = makeContext({ jitCostLimit: 1000 })
    const before = ctx.jitCostAccumulator
    ctx.addPerItemCost(20, 2, 100, 101)
    expect(ctx.jitCostAccumulator - before).toBe(24)  // 20 + 2 * ceil(101/100) = 20 + 2 * 2 = 24
  })

  it('cost = base + N*perChunk when items = N * chunkSize', () => {
    const ctx = makeContext({ jitCostLimit: 10000 })
    const before = ctx.jitCostAccumulator
    ctx.addPerItemCost(20, 2, 100, 1000)
    expect(ctx.jitCostAccumulator - before).toBe(40)  // 20 + 2 * ceil(1000/100) = 20 + 2 * 10 = 40
  })

  it('throws cost-limit-exceeded when overflow', () => {
    const ctx = makeContext({ jitCostLimit: 30 })
    expect(() => ctx.addPerItemCost(20, 2, 100, 1000)).toThrow(EvalError)
    try {
      const ctx2 = makeContext({ jitCostLimit: 30 })
      ctx2.addPerItemCost(20, 2, 100, 1000)
    } catch (e: any) {
      expect(e.code).toBe('cost-limit-exceeded')
    }
  })
})
```

- [ ] **Step 4: Run test, verify it fails**

```bash
cd /home/mwaddip/projects/ergots
npx vitest run packages/ergoscript/test/eval/_addPerItemCost.test.ts
```

Expected: FAIL with `addPerItemCost is not a function` or similar.

- [ ] **Step 5: Add `addPerItemCost` to `EvalContext`**

Modify `packages/ergoscript/src/eval/eval-context.ts`. Find the existing `addCost` method on `EvalContext`. Add `addPerItemCost` alongside:

```ts
/**
 * Chunked-per-item cost charging. Formula:
 *   cost = base + perChunk * ceil(items / chunkSize)
 *
 * Throws `'cost-limit-exceeded'` if the accumulator + cost would exceed
 * `jitCostLimit`. Mirrors sigma-rust's
 * `ergotree-interpreter/src/eval/cost_accum.rs::add_per_item_jit_cost`.
 *
 * Used by Append, Slice (Pattern B-chunked) and as the outer component
 * of MapColl/Filter/Fold/Exists/ForAll (Mixed pattern).
 */
addPerItemCost(base: number, perChunk: number, chunkSize: number, items: number): void
```

Implement in `makeContext()` factory:

```ts
addPerItemCost(base: number, perChunk: number, chunkSize: number, items: number): void {
  const chunks = items === 0 ? 0 : Math.ceil(items / chunkSize)
  const cost = base + perChunk * chunks
  this.addCost(cost)  // delegates to existing addCost which handles limit check
}
```

(Adjust the `this.addCost` invocation to match the existing factory's `addCost` style — it may be a closure-captured method rather than a `this.` reference. Read the file to confirm.)

- [ ] **Step 6: Run `_addPerItemCost.test.ts`, verify PASS**

```bash
npx vitest run packages/ergoscript/test/eval/_addPerItemCost.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 7: Write the failing tests for `_coll-helpers.ts`**

Create `packages/ergoscript/test/eval/_coll-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractCollItems, extractFuncValue } from '../../src/eval/_coll-helpers'
import { EvalError } from '../../src/eval/errors'
import type { SValue } from '../../src/mir/types'

describe('extractCollItems', () => {
  it('returns items + elem on a Coll SValue', () => {
    const v: SValue = { kind: 'Coll', elem: { tag: 'SInt' }, items: [{ kind: 'Int', value: 1 }] }
    expect(extractCollItems(v)).toEqual({ items: v.items, elem: v.elem })
  })

  it('throws coll-input-not-coll on non-Coll', () => {
    const v: SValue = { kind: 'Int', value: 42 }
    expect(() => extractCollItems(v)).toThrow(EvalError)
    try {
      extractCollItems(v)
    } catch (e: any) {
      expect(e.code).toBe('coll-input-not-coll')
    }
  })
})

describe('extractFuncValue', () => {
  it('returns closure on a Lambda SValue with non-empty args', () => {
    const closure = { argIds: [1], body: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } } as any }
    const v: SValue = { kind: 'Lambda', closure }
    expect(extractFuncValue(v)).toBe(closure)
  })

  it('throws lambda-not-callable on non-Lambda', () => {
    const v: SValue = { kind: 'Int', value: 42 }
    expect(() => extractFuncValue(v)).toThrow(EvalError)
    try {
      extractFuncValue(v)
    } catch (e: any) {
      expect(e.code).toBe('lambda-not-callable')
    }
  })

  it('throws lambda-not-callable on Lambda with empty args', () => {
    const v: SValue = { kind: 'Lambda', closure: { argIds: [], body: null as any } }
    expect(() => extractFuncValue(v)).toThrow(EvalError)
    try {
      extractFuncValue(v)
    } catch (e: any) {
      expect(e.code).toBe('lambda-not-callable')
    }
  })
})
```

- [ ] **Step 8: Run tests, verify FAIL**

```bash
npx vitest run packages/ergoscript/test/eval/_coll-helpers.test.ts
```

Expected: FAIL with "module not found" or "extractCollItems is not a function."

- [ ] **Step 9: Create `_coll-helpers.ts`**

Create `packages/ergoscript/src/eval/_coll-helpers.ts`:

```ts
import { EvalError } from './errors'
import type { SValue, Closure } from '../mir/types'
import type { SType } from '../mir/types'  // adjust import path per actual types.ts layout

/**
 * Guard a Coll SValue; return its items + elem type.
 * Throws `'coll-input-not-coll'` if the input is not a Coll.
 * 9 callers across phase 2f coll-hofs slice.
 */
export function extractCollItems(v: SValue): { items: SValue[]; elem: SType } {
  if (v.kind !== 'Coll') {
    throw new EvalError('coll-input-not-coll', `expected Coll, got ${v.kind}`)
  }
  return { items: v.items, elem: v.elem }
}

/**
 * Guard a Lambda SValue; return its Closure.
 * Throws `'lambda-not-callable'` if:
 *  - the input is not a Lambda, OR
 *  - the Lambda's closure has empty args (defensive — parser invariant rejects)
 * 5 callers across phase 2f coll-hofs slice (lambda HOFs).
 */
export function extractFuncValue(v: SValue): Closure {
  if (v.kind !== 'Lambda') {
    throw new EvalError('lambda-not-callable', `expected Lambda, got ${v.kind}`)
  }
  if (v.closure.argIds.length === 0) {
    throw new EvalError('lambda-not-callable', 'lambda has empty args list')
  }
  return v.closure
}
```

(Verify `SValue` shape — `kind: 'Coll', elem: SType, items: SValue[]` and `kind: 'Lambda', closure: Closure` — in `packages/ergoscript/src/mir/types.ts`. Adjust field names if the existing type uses different names. The `Closure` shape (`argIds`, `body`) should match phase 2e's introduction.)

- [ ] **Step 10: Add new error codes to `EvalError` taxonomy**

Modify `packages/ergoscript/src/eval/errors.ts`. Find the `EvalErrorCode` discriminated union. Add 7 new codes:

```ts
| 'coll-input-not-coll'
| 'coll-elem-tpe-mismatch'
| 'coll-by-index-out-of-range'
| 'coll-by-index-index-not-int'
| 'coll-slice-bound-not-int'
| 'lambda-not-callable'
| 'lambda-result-type-mismatch'
```

- [ ] **Step 11: Run `_coll-helpers.test.ts`, verify PASS**

```bash
npx vitest run packages/ergoscript/test/eval/_coll-helpers.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 12: Run full ergoscript suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all prior tests pass; zero TS errors.

- [ ] **Step 13: Commit**

```bash
git add packages/ergoscript/src/eval/eval-context.ts \
       packages/ergoscript/src/eval/_coll-helpers.ts \
       packages/ergoscript/src/eval/errors.ts \
       packages/ergoscript/test/eval/_addPerItemCost.test.ts \
       packages/ergoscript/test/eval/_coll-helpers.test.ts

git commit -m "$(cat <<'EOF'
feat(ergoscript): addPerItemCost helper + _coll-helpers (phase 2f coll-hofs task 1)

Adds EvalContext.addPerItemCost(base, perChunk, chunkSize, items) implementing
sigma-rust's chunked-per-item cost formula: base + perChunk * ceil(items / chunkSize).
Used by Append, Slice directly; outer component of mixed-pattern lambda HOFs.

New _coll-helpers.ts module: extractCollItems (9 callers in this slice) +
extractFuncValue (5 lambda HOF callers; pre-stubbed for Task 6+).

Adds 7 new EvalError codes (coll-input-not-coll, coll-elem-tpe-mismatch,
coll-by-index-out-of-range, coll-by-index-index-not-int, coll-slice-bound-not-int,
lambda-not-callable, lambda-result-type-mismatch). Taxonomy: 28 → 35.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `SizeOf` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_size.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — `pub mod coll_size;`
- Modify: `fixture-gen/src/main.rs` — wire `generate_and_write` call
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-size.json`
- Create: `packages/ergoscript/src/eval/coll-size.ts`
- Create: `packages/ergoscript/test/eval/coll-size.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` — add `case 'SizeOf':`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_size.rs:11-22` — `Fixed(14)` cost, then `coll.len() as i32`

**Key behavior:**

`SizeOf { input: Expr }` MIR shape. Eval:
1. `ctx.addCost(14)` — Pattern A, BEFORE child eval
2. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))` — throws `'coll-input-not-coll'` if not Coll
3. Return `{ kind: 'Int', value: inputColl.items.length }`

Edge cases: empty Coll → `Int(0)`. Cost-limit-exceeded: if `addCost(14)` would overflow.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_size.rs
```

Confirm: cost charged at line 15 (`Fixed(14)`); `input.eval` at line 16; `coll.len() as i32` returned.

- [ ] **Step 2: Write fixture-gen module**

Create `fixture-gen/src/cmds/ergoscript/eval/coll_size.rs`. Pattern follows phase 2f medium's per-arm files. Entries:

1. **Happy path: `Coll[Int]` of length 5** — input `[10, 20, 30, 40, 50]`, expected `Int(5)`.
2. **Empty `Coll[Int]`** — input `[]`, expected `Int(0)`.
3. **`Coll[Long]` of length 3** — input `[1L, 2L, 3L]`, expected `Int(3)`.
4. **`Coll[Coll[Byte]]` of length 2** — nested, expected `Int(2)`.
5. **Cost-limit-exceeded** — small `jitCostLimit` (e.g., 10), expected error.
6. **Coll-input-not-coll** — pass a non-Coll input (e.g., `Const(SInt, 42)`), expected error (sigma-rust throws `UnexpectedValue`; we map to `'coll-input-not-coll'`).

Skeleton:

```rust
use sigma_test_util::force_any_val;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::coll_size::SizeOf;
use ergotree_ir::types::stype::SType;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::collection::Collection;
use ergotree_ir::chain::context::Context;
use crate::cmds::ergoscript::eval::common::{
    EvalEntry, ergoscript_eval_fixture, json_value_from_svalue,
    // ... other helpers from prior tasks
};

pub fn collect_entries() -> Vec<EvalEntry> {
    let mut entries: Vec<EvalEntry> = Vec::new();

    // 1. Happy path: Coll[Int] of length 5
    {
        let coll: Expr = Collection::new(
            SType::SInt,
            vec![10i32.into(), 20i32.into(), 30i32.into(), 40i32.into(), 50i32.into()],
        ).unwrap().into();
        let expr: Expr = SizeOf::new(coll).unwrap().into();
        entries.push(ergoscript_eval_fixture("coll-size-int-5", expr, None));
    }

    // 2. Empty Coll[Int]
    {
        let coll: Expr = Collection::new(SType::SInt, Vec::<Expr>::new()).unwrap().into();
        let expr: Expr = SizeOf::new(coll).unwrap().into();
        entries.push(ergoscript_eval_fixture("coll-size-int-empty", expr, None));
    }

    // ... etc (3-6)

    entries
}
```

(Read `fixture-gen/src/cmds/ergoscript/eval/common.rs` to confirm the exact helper signatures — `ergoscript_eval_fixture` may take different args; phase 2f medium added a controlled-Context overload.)

- [ ] **Step 3: Wire fixture-gen module**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, add (alphabetical order):

```rust
pub mod coll_size;
```

In `fixture-gen/src/main.rs`, add the `generate_and_write` call (follow the pattern from phase 2f medium):

```rust
generate_and_write(
    "packages/ergoscript/test/fixtures/eval/coll-size.json",
    coll_size::collect_entries(),
);
```

- [ ] **Step 4: Run fixture-gen + verify fixture appears**

```bash
cd /home/mwaddip/projects/ergots
cargo run --release -p fixture-gen
ls -la packages/ergoscript/test/fixtures/eval/coll-size.json
```

Expected: file exists with ~6 entries.

- [ ] **Step 5: Verify determinism**

```bash
cd /home/mwaddip/projects/ergots
cargo run --release -p fixture-gen
git diff packages/ergoscript/test/fixtures/eval/coll-size.json
```

Expected: empty diff. If non-empty, investigate the entry that varies (likely a `force_any_val` source that needs replacement with controlled input).

- [ ] **Step 6: Write the failing TS test**

Create `packages/ergoscript/test/eval/coll-size.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExpr } from '../../src/wire/parse'
import { ByteReader } from '../../src/wire/reader'
import { evaluateWith, makeContext } from '../../src/eval/evaluate-with'
import { hexToBytes, hydrateSValue, captureEvalError, rehydrateEvalOpts } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'eval', 'coll-size.json')

interface FixtureEntry {
  name: string
  expr_hex: string
  expected_value?: any
  expected_error?: string
  expected_cost: number
  opts?: any
}

const fixture: { entries: FixtureEntry[] } = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'))

describe('coll-size eval', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const bytes = hexToBytes(entry.expr_hex)
      const expr = parseExpr(new ByteReader(bytes))
      const opts = rehydrateEvalOpts(entry.opts)

      if (entry.expected_error) {
        const err = captureEvalError(() => evaluateWith(expr, makeContext(opts)))
        expect(err.code).toBe(entry.expected_error)
      } else {
        const ctx = makeContext(opts)
        const result = evaluateWith(expr, ctx)
        const expected = hydrateSValue(entry.expected_value)
        expect(result).toEqual(expected)
        expect(ctx.jitCostAccumulator).toBe(entry.expected_cost)
      }
    })
  }
})
```

- [ ] **Step 7: Run the test, verify FAIL**

```bash
npx vitest run packages/ergoscript/test/eval/coll-size.test.ts
```

Expected: FAIL with "module not found" or "case 'SizeOf' not handled."

- [ ] **Step 8: Write the SizeOf arm**

Create `packages/ergoscript/src/eval/coll-size.ts`:

```ts
import type { SizeOf, SValue } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'

/**
 * SizeOf: returns Int(items.length). Pattern A — cost charged BEFORE eval-child.
 * Sigma-rust: ergotree-interpreter/src/eval/coll_size.rs:11-22 (Fixed(14)).
 */
export function evalSizeOf(e: SizeOf, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(14)
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  return { kind: 'Int', value: inputColl.items.length }
}
```

- [ ] **Step 9: Wire into central dispatch**

In `packages/ergoscript/src/eval/eval.ts`, find the central `switch (e.tag)` in `evalExpr`. Add (in alphabetical order, near other Coll arms):

```ts
case 'SizeOf':
  return evalSizeOf(e, env, ctx)
```

And add the import at the top:

```ts
import { evalSizeOf } from './coll-size'
```

- [ ] **Step 10: Run the per-arm test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/eval/coll-size.test.ts
```

Expected: all entries PASS.

- [ ] **Step 11: Run the full ergoscript suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all tests pass; zero TS errors.

- [ ] **Step 12: Commit**

```bash
git add packages/ergoscript/src/eval/coll-size.ts \
       packages/ergoscript/src/eval/eval.ts \
       packages/ergoscript/test/eval/coll-size.test.ts \
       packages/ergoscript/test/fixtures/eval/coll-size.json \
       fixture-gen/src/cmds/ergoscript/eval/coll_size.rs \
       fixture-gen/src/cmds/ergoscript/eval/mod.rs \
       fixture-gen/src/main.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): SizeOf eval arm (phase 2f coll-hofs task 2)

Pattern A: Fixed(14) before child eval. Returns Int(items.length).
First Coll HOF arm; warm-up for the slice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `Append` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_append.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — `pub mod coll_append;`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-append.json`
- Create: `packages/ergoscript/src/eval/coll-append.ts`
- Create: `packages/ergoscript/test/eval/coll-append.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` — `case 'Append':`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_append.rs:39-63` — Pattern B-chunked: `add_per_item_jit_cost(20, 2, 100, n1+n2)` AFTER eval-children

**Key behavior:**

`Append { input: Expr, col_2: Expr }` MIR. Eval:
1. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))` — eval first
2. `const col2Coll = extractCollItems(evalExpr(e.col_2, env, ctx))` — eval second
3. **elem_tpe check:** if `!sTypeEquals(inputColl.elem, col2Coll.elem)` → throw `'coll-elem-tpe-mismatch'`
4. `ctx.addPerItemCost(20, 2, 100, inputColl.items.length + col2Coll.items.length)` — Pattern B-chunked, AFTER children
5. Return `{ kind: 'Coll', elem: inputColl.elem, items: [...inputColl.items, ...col2Coll.items] }`

Fixture entries:
1. Append two `Coll[Int]` (lengths 4 + 4 = 8, expected `[1,2,3,4,5,6,7,8]`).
2. Append empty to non-empty.
3. Append non-empty to empty.
4. Append two empty Colls.
5. `Coll[Byte]` append.
6. **Cost-equality**: `Append([1..100], [])` vs `Append([], [1..100])` → same cost (both have `n1+n2=100`).
7. Elem-tpe-mismatch: `Coll[Int]` + `Coll[Long]` → expected `'coll-elem-tpe-mismatch'`.
8. Non-Coll input → expected `'coll-input-not-coll'`.
9. Cost-limit-exceeded with small `jitCostLimit`.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_append.rs
```

Confirm Pattern B-chunked: `add_per_item_jit_cost(20, 2, 100, ...)` at line 57, AFTER both `input.eval` and `col_2.eval`.

- [ ] **Step 2: Write fixture-gen module**

Create `fixture-gen/src/cmds/ergoscript/eval/coll_append.rs` mirroring Task 2's pattern. Each entry builds an `Append` Expr via `Append::new(input_expr, col2_expr)`.

- [ ] **Step 3: Wire fixture-gen module**

`pub mod coll_append;` + `generate_and_write` call.

- [ ] **Step 4: Run fixture-gen + verify**

```bash
cargo run --release -p fixture-gen
ls -la packages/ergoscript/test/fixtures/eval/coll-append.json
```

- [ ] **Step 5: Verify determinism**

```bash
cargo run --release -p fixture-gen
git diff packages/ergoscript/test/fixtures/eval/coll-append.json
```

Expected: empty.

- [ ] **Step 6: Write the failing TS test**

Create `packages/ergoscript/test/eval/coll-append.test.ts` mirroring Task 2's test pattern. (Same fixture loader, same loop structure; just point at `coll-append.json`.)

- [ ] **Step 7: Run test, verify FAIL**

```bash
npx vitest run packages/ergoscript/test/eval/coll-append.test.ts
```

Expected: FAIL.

- [ ] **Step 8: Write the Append arm**

Create `packages/ergoscript/src/eval/coll-append.ts`:

```ts
import type { Append, SValue } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'
import { sTypeEquals } from '../mir/stype'
import { EvalError } from './errors'

/**
 * Append: concatenates two Coll[T] with matching elem_tpe.
 * Pattern B-chunked: cost = addPerItemCost(20, 2, 100, n1 + n2) AFTER eval-children.
 * Sigma-rust: ergotree-interpreter/src/eval/coll_append.rs:39-63.
 */
export function evalAppend(e: Append, env: Env, ctx: EvalContext): SValue {
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  const col2Coll = extractCollItems(evalExpr(e.col2, env, ctx))
  if (!sTypeEquals(inputColl.elem, col2Coll.elem)) {
    throw new EvalError('coll-elem-tpe-mismatch',
      `Append: elem types differ: ${JSON.stringify(inputColl.elem)} vs ${JSON.stringify(col2Coll.elem)}`)
  }
  ctx.addPerItemCost(20, 2, 100, inputColl.items.length + col2Coll.items.length)
  return {
    kind: 'Coll',
    elem: inputColl.elem,
    items: [...inputColl.items, ...col2Coll.items],
  }
}
```

(Confirm `Append` MIR shape: field name may be `col_2` or `col2` per `packages/ergoscript/src/mir/types.ts`. Check `sTypeEquals` import path — may live in `mir/stype.ts` or `mir/stype-equals.ts`. Use whichever exists; if neither, add a structural-equality helper.)

- [ ] **Step 9: Wire into central dispatch**

In `eval.ts`:

```ts
import { evalAppend } from './coll-append'

// inside switch:
case 'Append':
  return evalAppend(e, env, ctx)
```

- [ ] **Step 10: Run per-arm test, verify PASS**

```bash
npx vitest run packages/ergoscript/test/eval/coll-append.test.ts
```

- [ ] **Step 11: Run full suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

- [ ] **Step 12: Commit**

```bash
git add packages/ergoscript/src/eval/coll-append.ts \
       packages/ergoscript/src/eval/eval.ts \
       packages/ergoscript/test/eval/coll-append.test.ts \
       packages/ergoscript/test/fixtures/eval/coll-append.json \
       fixture-gen/src/cmds/ergoscript/eval/coll_append.rs \
       fixture-gen/src/cmds/ergoscript/eval/mod.rs \
       fixture-gen/src/main.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): Append eval arm (phase 2f coll-hofs task 3)

Pattern B-chunked: addPerItemCost(20, 2, 100, n1+n2) AFTER eval-children.
Concatenates two Coll[T] with matching elem_tpe. Throws coll-elem-tpe-mismatch
on type mismatch. First addPerItemCost consumer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ByIndex` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_by_index.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-by-index.json`
- Create: `packages/ergoscript/src/eval/coll-by-index.ts`
- Create: `packages/ergoscript/test/eval/coll-by-index.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_by_index.rs:11-50` — Pattern A: `Fixed(30)` BEFORE child eval + lazy default

**Key behavior:**

`ByIndex { input: Expr, index: Expr, default?: Expr }` MIR. Eval:
1. `ctx.addCost(30)` — Pattern A
2. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))`
3. `const indexVal = evalExpr(e.index, env, ctx)`; assert `indexVal.kind === 'Int'`, else throw `'coll-by-index-index-not-int'`
4. If `indexVal.value >= 0 && indexVal.value < inputColl.items.length` → return `inputColl.items[indexVal.value]`
5. Else (OOB, including negative):
   - If `e.default` present → eval `e.default` and return it (**lazy** — only evaluated on OOB)
   - If `e.default` absent → throw `'coll-by-index-out-of-range'`

Fixture entries:
1. Happy path: `[10, 20, 30][1]` → `Int(20)`.
2. OOB no default: `[1, 2][5]` → `'coll-by-index-out-of-range'`.
3. OOB with default: `[1, 2][5] orElse 99` → `Int(99)`.
4. Negative index no default: `[1, 2][-1]` → `'coll-by-index-out-of-range'`.
5. Negative index with default: `[1, 2][-1] orElse 99` → `Int(99)`.
6. **Default laziness smoking-gun**: `[1, 2, 3][1] orElse (some-expensive-default)` → returns `Int(2)` and `default` is NOT evaluated. Assert cost reflects only `Fixed(30) + index_eval + input_eval`, NOT default_eval.
7. Index-not-int (defensive): construct a malformed tree where `index` is `Boolean` → expected `'coll-by-index-index-not-int'`. (Note: parser-produced trees should reject this; only synthetic test trees can trigger it.)
8. Non-Coll input → `'coll-input-not-coll'`.
9. Cost-limit-exceeded.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_by_index.rs
```

Confirm: `add_jit_cost(30)` at line 18 (BEFORE children); `default_v` is `|| default.eval(env, ctx)` (closure for laziness); `coll.get(index)` for in-bounds returns `Some(item)`.

- [ ] **Step 2: Write fixture-gen module**

The default-laziness smoking-gun (entry 6) requires a `default` expression with non-trivial cost. Use a costly construction like `Map([1,2,3,4,5], x => x + 1)` (Map cost > zero) as the default. The fixture-gen captures the cost; the TS test asserts that cost when index IS in-bounds is **less than** cost when index IS out-of-bounds (proving lazy default).

- [ ] **Step 3: Wire fixture-gen module**
- [ ] **Step 4: Run fixture-gen + verify**
- [ ] **Step 5: Verify determinism**
- [ ] **Step 6: Write the failing TS test**
- [ ] **Step 7: Run test, verify FAIL**

- [ ] **Step 8: Write the ByIndex arm**

Create `packages/ergoscript/src/eval/coll-by-index.ts`:

```ts
import type { ByIndex, SValue } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'
import { EvalError } from './errors'

/**
 * ByIndex: returns items[index] or evaluates `default` lazily on OOB.
 * Pattern A: Fixed(30) BEFORE child eval. Default eval is lazy (only on OOB).
 * Sigma-rust: ergotree-interpreter/src/eval/coll_by_index.rs:11-50.
 */
export function evalByIndex(e: ByIndex, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(30)
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  const indexVal = evalExpr(e.index, env, ctx)
  if (indexVal.kind !== 'Int') {
    throw new EvalError('coll-by-index-index-not-int',
      `ByIndex: expected Int index, got ${indexVal.kind}`)
  }
  const idx = indexVal.value
  if (idx >= 0 && idx < inputColl.items.length) {
    return inputColl.items[idx]!
  }
  // OOB path — eval default lazily, or throw
  if (e.default !== undefined) {
    return evalExpr(e.default, env, ctx)
  }
  throw new EvalError('coll-by-index-out-of-range',
    `ByIndex: index ${idx} out of range for Coll of length ${inputColl.items.length}`)
}
```

(Verify `ByIndex` MIR shape: `default` may be `default?: Expr` or `default: Expr | null`. Use the actual field.)

- [ ] **Step 9: Wire into central dispatch**
- [ ] **Step 10: Run per-arm test, verify PASS**
- [ ] **Step 11: Run full suite + typecheck**

- [ ] **Step 12: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ergoscript): ByIndex eval arm with lazy default + 2 new error codes (phase 2f coll-hofs task 4)

Pattern A: Fixed(30) BEFORE child eval. Returns items[index] or evaluates
`default` lazily on OOB (Some-Int-Some-Default semantics matching sigma-rust).

New EvalError codes:
- 'coll-by-index-out-of-range' — OOB without default
- 'coll-by-index-index-not-int' — index expr non-Int (defensive)

C1 smoking-gun: in-bounds case cost < OOB-with-default case cost (proves lazy).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `Slice` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_slice.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-slice.json`
- Create: `packages/ergoscript/src/eval/coll-slice.ts`
- Create: `packages/ergoscript/test/eval/coll-slice.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_slice.rs:11-43` — eval logic
- `ergotree-interpreter/src/eval/coll_slice.rs:165-211` — bug-7 (issue #724) regression test (cost-on-requested-range)

**Key behavior:**

`Slice { input: Expr, from: Expr, until: Expr }` MIR. Eval:
1. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))` — eval input
2. `const fromVal = evalExpr(e.from, env, ctx)` — eval from
3. `const untilVal = evalExpr(e.until, env, ctx)` — eval until
4. Both `fromVal.kind === 'Int'` and `untilVal.kind === 'Int'` (else `'coll-slice-bound-not-int'`)
5. `const requestedRange = Math.max(0, untilVal.value - fromVal.value)`
6. `ctx.addPerItemCost(10, 2, 100, requestedRange)` — Pattern B-chunked, AFTER children, **cost scales with requested range, not input length or clipped output**
7. **Intersection semantics:** clip `from` to `[0, inputColl.items.length]`; clip `until` to `[0, inputColl.items.length]`. Return `inputColl.items.slice(clippedFrom, clippedUntil)`. If `from >= until`, return empty.
8. Result `elem` preserved from `inputColl.elem`.

Fixture entries (smoking-gun included):
1. Happy path: `[1,2,3,4][1..3]` → `[2,3]`.
2. `from < 0`: `[1,2,3,4][-1..3]` → `[1,2,3]` (clipped).
3. `until > len`: `[1,2,3,4][2..10]` → `[3,4]` (clipped).
4. `from >= until`: `[1,2,3,4][3..1]` → `[]`.
5. Empty input: `[][1..3]` → `[]`.
6. **Cost-on-requested-range smoking-gun**: `[0..4][0..2]` vs `[0..999][0..2]` → same cost. Both have `requestedRange = 2`, so `addPerItemCost(10, 2, 100, 2)` is the same for both.
7. **Cost-larger-range**: `[0..4][0..200]` → cost reflects `requestedRange = 200`, not clipped length 5.
8. Bound-not-int: `from` is `Boolean` → `'coll-slice-bound-not-int'`.
9. Non-Coll input → `'coll-input-not-coll'`.
10. Cost-limit-exceeded.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_slice.rs
```

Confirm: `add_per_item_jit_cost(10, 2, 100, n_items)` at line 32, where `n_items = 0i32.max(until - from) as u32` — explicitly NOT input length.

- [ ] **Step 2: Write fixture-gen module**

Smoking-gun entry 6 must use the SAME `(from, until)` against different input sizes. Verify cost is identical in fixture-gen output.

- [ ] **Step 3-7: Follow standard task arc (fixture-gen wire → cargo run → determinism → red test)**

- [ ] **Step 8: Write the Slice arm**

Create `packages/ergoscript/src/eval/coll-slice.ts`:

```ts
import type { Slice, SValue } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems } from './_coll-helpers'
import { EvalError } from './errors'

/**
 * Slice: Scala-compat intersection semantics — does NOT throw on OOB.
 * Pattern B-chunked: cost scales with REQUESTED range (max(0, until-from)),
 * NOT input length or clipped output. Locked by sigma-rust regression
 * test for issue #724 at coll_slice.rs:165-211.
 */
export function evalSlice(e: Slice, env: Env, ctx: EvalContext): SValue {
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  const fromVal = evalExpr(e.from, env, ctx)
  const untilVal = evalExpr(e.until, env, ctx)
  if (fromVal.kind !== 'Int') {
    throw new EvalError('coll-slice-bound-not-int',
      `Slice: expected Int 'from', got ${fromVal.kind}`)
  }
  if (untilVal.kind !== 'Int') {
    throw new EvalError('coll-slice-bound-not-int',
      `Slice: expected Int 'until', got ${untilVal.kind}`)
  }
  const requestedRange = Math.max(0, untilVal.value - fromVal.value)
  ctx.addPerItemCost(10, 2, 100, requestedRange)
  // Intersection: clip to [0, len]
  const len = inputColl.items.length
  const clippedFrom = Math.max(0, Math.min(fromVal.value, len))
  const clippedUntil = Math.max(0, Math.min(untilVal.value, len))
  const items = clippedFrom < clippedUntil
    ? inputColl.items.slice(clippedFrom, clippedUntil)
    : []
  return { kind: 'Coll', elem: inputColl.elem, items }
}
```

- [ ] **Step 9-12: Wire dispatch, run tests, commit**

Commit message:
```
feat(ergoscript): Slice eval arm with intersection semantics (phase 2f coll-hofs task 5)

Pattern B-chunked: cost scales with REQUESTED range (max(0, until-from)),
not input length or clipped output. Scala-compat intersection semantics
(does NOT throw on OOB; clips bounds). Locked by sigma-rust issue #724
regression test.

New EvalError code: 'coll-slice-bound-not-int' (shared by both bounds).

C1 smoking-gun: same (from, until) against 5-item vs 1000-item input
produces identical cost — locks the bug-7 fix.
```

---

## Task 6: `MapColl` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_map.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-map.json`
- Create: `packages/ergoscript/src/eval/coll-map.ts`
- Create: `packages/ergoscript/test/eval/coll-map.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_map.rs:14-84` — Mixed pattern (outer `add_per_item_jit_cost(20, 1, 10, n)` at line 72 + per-iter `add_jit_cost(5)` at line 31)

**Key behavior:**

`MapColl { input: Expr, mapper: Expr, mapper_sfunc?: SFunc, out_elem_tpe?: SType }` MIR. (Verify exact field names from `packages/ergoscript/src/mir/types.ts`. Sigma-rust's `Map` struct carries `mapper_sfunc: SFunc` for type info; TS port may have inferred `mapper.tpe` instead.)

Eval order (Mixed pattern):
1. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))`
2. `const closure = extractFuncValue(evalExpr(e.mapper, env, ctx))`
3. **elem_tpe check:** if `!sTypeEquals(inputColl.elem, mapperInputTpe)` → `'coll-elem-tpe-mismatch'`. `mapperInputTpe` derived from `e.mapper_sfunc?.t_dom[0]` or `closure.tpe.args[0]`.
4. `ctx.addPerItemCost(20, 1, 10, inputColl.items.length)` — outer chunked, BEFORE the loop
5. `outItems: SValue[] = []`. For each `item` in `inputColl.items`:
   - `ctx.addCost(5)` — per-iter cost
   - `const itemEnv = env.extend(closure.argIds[0], item)`
   - `const itemRes = evalExpr(closure.body, itemEnv, ctx)`
   - **Result type check:** if `!sTypeEquals(svalueToSType(itemRes), expectedOutElemTpe)` → `'lambda-result-type-mismatch'`
   - `outItems.push(itemRes)`
6. Return `{ kind: 'Coll', elem: outElemTpe, items: outItems }`

`expectedOutElemTpe` = `e.out_elem_tpe` (if MIR carries it) or `e.mapper_sfunc?.t_range` or derived from `closure.tpe.result`.

Fixture entries:
1. Happy path: `[1,2,3,4].map(x => x + 1)` → `[2,3,4,5]` (cost reflects mixed pattern: outer + 4 per-iter).
2. Empty input: `[].map(x => x + 1)` → `[]` (cost = outer `addPerItemCost(20, 1, 10, 0)` only; no per-iter).
3. **Mixed-pattern smoking-gun**: `[0..11].map(x => x)` (12 items, > chunkSize 10) → outer cost = `20 + 1 * ceil(12/10) = 20 + 2 = 22`; per-iter cost = `12 * 5 = 60`; total addCost from this arm = 82 plus child evals.
4. Elem-tpe-mismatch: `Coll[Int]` mapped with a lambda whose declared arg is `Long` → `'coll-elem-tpe-mismatch'`.
5. Lambda-not-callable: mapper is `Const(SInt, 42)` instead of `FuncValue` → `'lambda-not-callable'`.
6. Lambda-result-type-mismatch (synthetic): mapper declares `t_range = SInt` but body returns Boolean → `'lambda-result-type-mismatch'`. (May require synthetic tree construction to bypass parser invariants.)
7. Non-Coll input → `'coll-input-not-coll'`.
8. Cost-limit-exceeded.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_map.rs
```

Confirm:
- Outer cost at line 72 (after children, before loop): `add_per_item_jit_cost(20, 1, 10, normalized_input_vals.len() as u32)`
- Per-iter cost at line 31 (inside the lambda closure): `add_jit_cost(5)`
- Input elem_tpe check at line 58 against `mapper_input_tpe` (derived from `mapper_sfunc.t_dom.first()`)
- Output via `CollKind::from_collection(self.out_elem_tpe(), values)` at line 78 — implicitly enforces result type uniformity

- [ ] **Step 2: Verify TS MIR shape**

```bash
grep -nA 8 "interface MapColl\b\|tag: 'MapColl'" /home/mwaddip/projects/ergots/packages/ergoscript/src/mir/types.ts
```

Confirm field names: `input`, `mapper`, and whether `mapper_sfunc` / `out_elem_tpe` / `mapperSfunc` / `outElemTpe` are present.

- [ ] **Step 3-7: Standard task arc (write fixture-gen → cargo run → determinism → red test)**

- [ ] **Step 8: Write the MapColl arm**

Create `packages/ergoscript/src/eval/coll-map.ts`:

```ts
import type { MapColl, SValue, SType } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { sTypeEquals, svalueToSType } from '../mir/stype'
import { EvalError } from './errors'

/**
 * MapColl: maps each item via a unary FuncValue. Mixed pattern:
 *   - Outer: addPerItemCost(20, 1, 10, n_input) AFTER eval-children, BEFORE loop
 *   - Per-iter: addCost(5) inside the loop
 * Asserts (a) input elem_tpe matches mapper's t_dom[0]; (b) each per-item result
 * matches mapper's t_range.
 * Sigma-rust: ergotree-interpreter/src/eval/coll_map.rs:14-84.
 */
export function evalMapColl(e: MapColl, env: Env, ctx: EvalContext): SValue {
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  const closure = extractFuncValue(evalExpr(e.mapper, env, ctx))

  // Input elem_tpe must match mapper's declared input type
  const mapperInputTpe = e.mapperSfunc?.tDom[0] ?? closure.argTpes[0]  // adjust per actual MIR
  if (!sTypeEquals(inputColl.elem, mapperInputTpe)) {
    throw new EvalError('coll-elem-tpe-mismatch',
      `MapColl: input elem ${JSON.stringify(inputColl.elem)} != mapper t_dom ${JSON.stringify(mapperInputTpe)}`)
  }

  const outElemTpe = e.outElemTpe ?? e.mapperSfunc?.tRange ?? closure.bodyTpe

  ctx.addPerItemCost(20, 1, 10, inputColl.items.length)

  const outItems: SValue[] = []
  for (const item of inputColl.items) {
    ctx.addCost(5)
    const itemEnv = env.extend(closure.argIds[0]!, item)
    const itemRes = evalExpr(closure.body, itemEnv, ctx)
    if (!sTypeEquals(svalueToSType(itemRes), outElemTpe)) {
      throw new EvalError('lambda-result-type-mismatch',
        `MapColl: mapper body returned ${JSON.stringify(svalueToSType(itemRes))}, expected ${JSON.stringify(outElemTpe)}`)
    }
    outItems.push(itemRes)
  }
  return { kind: 'Coll', elem: outElemTpe, items: outItems }
}
```

(Adjust field names per actual MIR. The `env.extend(argId, value)` pattern should match phase 2e's `FuncValue`/`Apply` plumbing.)

- [ ] **Step 9-12: Wire dispatch, run tests, commit**

Commit message:
```
feat(ergoscript): MapColl eval arm with mixed-pattern cost (phase 2f coll-hofs task 6)

Mixed pattern: outer addPerItemCost(20, 1, 10, n) + per-iter addCost(5).
First lambda HOF. Asserts (a) input elem_tpe matches mapper's t_dom[0];
(b) each per-item result matches mapper's t_range.

New EvalError codes:
- 'lambda-not-callable' (mapper is not a Lambda OR has empty args)
- 'lambda-result-type-mismatch' (mapper body returns wrong type)

Reuses phase 2e's FuncValue/Apply env-extend plumbing.
```

---

## Task 7: `Filter` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_filter.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-filter.json`
- Create: `packages/ergoscript/src/eval/coll-filter.ts`
- Create: `packages/ergoscript/test/eval/coll-filter.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_filter.rs:15-90` — Mixed pattern (outer `add_per_item_jit_cost(20, 1, 10, n)` + per-iter `add_jit_cost(5)`)

**Key behavior:**

`Filter { input: Expr, condition: Expr, elem_tpe: SType }` MIR. Eval:
1. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))`
2. `const closure = extractFuncValue(evalExpr(e.condition, env, ctx))`
3. **Declared-elem_tpe check:** if `!sTypeEquals(inputColl.elem, e.elemTpe)` → `'coll-elem-tpe-mismatch'`. (This is different from Map: Filter checks against a DECLARED `elem_tpe` field, not the lambda's t_dom.)
4. `ctx.addPerItemCost(20, 1, 10, inputColl.items.length)` — outer
5. For each item: `ctx.addCost(5)`, eval body, assert body result is `Boolean`, keep if true. No short-circuit.
6. Return `{ kind: 'Coll', elem: e.elemTpe, items: kept }`.

Fixture entries:
1. Happy path: `[1,2,3,4,5].filter(x => x > 2)` → `[3,4,5]`.
2. All-pass: `[1,2,3].filter(_ => true)` → `[1,2,3]`.
3. All-fail: `[1,2,3].filter(_ => false)` → `[]`.
4. Empty input: `[].filter(_ => true)` → `[]`.
5. Mixed-pattern smoking-gun (n=12).
6. Elem-tpe-mismatch.
7. Lambda-result-type-mismatch: body returns Int → `'lambda-result-type-mismatch'`.
8. Non-Boolean condition lambda → same error.
9. Non-Coll input.
10. Cost-limit-exceeded.

- [ ] **Step 1: Read sigma-rust source**
- [ ] **Step 2-7: Standard task arc**
- [ ] **Step 8: Write the Filter arm**

Create `packages/ergoscript/src/eval/coll-filter.ts`:

```ts
import type { Filter, SValue } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { sTypeEquals } from '../mir/stype'
import { EvalError } from './errors'

/**
 * Filter: keeps items where condition→true. Mixed pattern (same as Map).
 * Checks input elem_tpe against DECLARED e.elem_tpe (not lambda's t_dom).
 * Body must return Boolean; non-Boolean → 'lambda-result-type-mismatch'.
 * Sigma-rust: ergotree-interpreter/src/eval/coll_filter.rs:15-90.
 */
export function evalFilter(e: Filter, env: Env, ctx: EvalContext): SValue {
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  const closure = extractFuncValue(evalExpr(e.condition, env, ctx))
  if (!sTypeEquals(inputColl.elem, e.elemTpe)) {
    throw new EvalError('coll-elem-tpe-mismatch',
      `Filter: input elem ${JSON.stringify(inputColl.elem)} != declared ${JSON.stringify(e.elemTpe)}`)
  }
  ctx.addPerItemCost(20, 1, 10, inputColl.items.length)

  const kept: SValue[] = []
  for (const item of inputColl.items) {
    ctx.addCost(5)
    const itemEnv = env.extend(closure.argIds[0]!, item)
    const itemRes = evalExpr(closure.body, itemEnv, ctx)
    if (itemRes.kind !== 'Boolean') {
      throw new EvalError('lambda-result-type-mismatch',
        `Filter: condition returned ${itemRes.kind}, expected Boolean`)
    }
    if (itemRes.value) kept.push(item)
  }
  return { kind: 'Coll', elem: e.elemTpe, items: kept }
}
```

- [ ] **Step 9-12: Wire, test, commit**

Commit:
```
feat(ergoscript): Filter eval arm with declared-elem_tpe check (phase 2f coll-hofs task 7)

Mixed pattern. Checks input elem_tpe against the MIR's declared `e.elem_tpe`
field (not the lambda's t_dom — that's Map's pattern). Body must return Boolean
or 'lambda-result-type-mismatch' fires. No short-circuit; visits every item.
```

---

## Task 8: `Fold` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_fold.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-fold.json`
- Create: `packages/ergoscript/src/eval/coll-fold.ts`
- Create: `packages/ergoscript/test/eval/coll-fold.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_fold.rs:12-71` — Mixed pattern (outer `add_per_item_jit_cost(3, 1, 10, n)` at line 48 + per-iter `add_jit_cost(5)` at line 29). Note: outer cost values differ from Map/Filter (3, 1, 10 vs 20, 1, 10).
- Proptest example at `coll_fold.rs:100-150` — known-correct fold tree shape

**Key behavior:**

`Fold { input: Expr, zero: Expr, fold_op: Expr }` MIR. Eval:
1. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))`
2. `let acc = evalExpr(e.zero, env, ctx)` — accumulator starts as zero
3. `const closure = extractFuncValue(evalExpr(e.foldOp, env, ctx))`
4. `ctx.addPerItemCost(3, 1, 10, inputColl.items.length)` — outer, AFTER eval-input/eval-zero/eval-fold_op
5. For each `item`:
   - `ctx.addCost(5)` — per-iter
   - Construct 2-tuple `Tuple([acc, item])` as the lambda arg
   - `const itemEnv = env.extend(closure.argIds[0], { kind: 'Tuple', items: [acc, item] })`
   - `acc = evalExpr(closure.body, itemEnv, ctx)`
6. **Result type check:** if `!sTypeEquals(svalueToSType(acc), svalueToSType(zeroOriginal))` → `'lambda-result-type-mismatch'`. (Or rely on the per-iter consistency: if acc type drifts, the next iteration's tuple would have wrong type — but per-iter check is more defensive.)
7. Return `acc`.

Fixture entries:
1. Happy path: `[1,2,3,4].fold(0)((acc, item) => acc + item)` → `Int(10)`. Lambda body is `BinOp(Plus, SelectField(1, valUse_tup), SelectField(2, valUse_tup))`.
2. Multiplication: `[1,2,3].fold(1)((acc, item) => acc * item)` → `Int(6)`.
3. Empty input: `[].fold(42)(_ => ???)` → `Int(42)` (zero is returned; closure never called).
4. `Coll[Byte]` fold (exercises sigma-rust's `CollByte` special case — should be transparent in TS).
5. Mixed-pattern smoking-gun (n=12, observe outer cost difference vs n=5).
6. Lambda-not-callable.
7. Lambda-result-type-mismatch (synthetic).
8. Non-Coll input.
9. Cost-limit-exceeded.

The lambda body for the happy path uses `SelectField` (already wired in phase 2f medium). Fixture-gen mirrors the proptest's tree-construction pattern.

- [ ] **Step 1: Read sigma-rust source**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/coll_fold.rs
```

Pay attention to lines 48 (outer cost) and 50-63 (the per-item closure call with `Value::Tup([acc, item])`).

- [ ] **Step 2-7: Standard task arc**

For fixture-gen, mirror the proptest at line 100-150 — it constructs a fold tree with `SelectField` destructure. The TS test loads + evaluates.

- [ ] **Step 8: Write the Fold arm**

Create `packages/ergoscript/src/eval/coll-fold.ts`:

```ts
import type { Fold, SValue } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { sTypeEquals, svalueToSType } from '../mir/stype'
import { EvalError } from './errors'

/**
 * Fold: left-fold with 2-tuple lambda arg. Mixed pattern:
 *   - Outer: addPerItemCost(3, 1, 10, n) AFTER eval-input/eval-zero/eval-foldOp
 *   - Per-iter: addCost(5) inside the lambda closure call
 * Lambda is unary with arg type (Acc, Item); body destructures via SelectField.
 * Sigma-rust: ergotree-interpreter/src/eval/coll_fold.rs:12-71.
 * Proptest tree shape: coll_fold.rs:100-150.
 */
export function evalFold(e: Fold, env: Env, ctx: EvalContext): SValue {
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  let acc = evalExpr(e.zero, env, ctx)
  const closure = extractFuncValue(evalExpr(e.foldOp, env, ctx))

  const accTpe = svalueToSType(acc)
  ctx.addPerItemCost(3, 1, 10, inputColl.items.length)

  for (const item of inputColl.items) {
    ctx.addCost(5)
    const tupArg: SValue = { kind: 'Tuple', items: [acc, item] }
    const itemEnv = env.extend(closure.argIds[0]!, tupArg)
    const nextAcc = evalExpr(closure.body, itemEnv, ctx)
    if (!sTypeEquals(svalueToSType(nextAcc), accTpe)) {
      throw new EvalError('lambda-result-type-mismatch',
        `Fold: foldOp returned ${JSON.stringify(svalueToSType(nextAcc))}, expected ${JSON.stringify(accTpe)}`)
    }
    acc = nextAcc
  }
  return acc
}
```

- [ ] **Step 9-12: Wire, test, commit**

Commit:
```
feat(ergoscript): Fold eval arm with 2-tuple lambda arg (phase 2f coll-hofs task 8)

Mixed pattern (outer addPerItemCost(3, 1, 10, n) + per-iter addCost(5)).
Lambda is UNARY with arg type (Acc, Item); body destructures via SelectField.
Empty Coll → returns zero (closure never called).

C1 fixture mirrors sigma-rust's proptest tree shape (coll_fold.rs:100-150).
```

---

## Task 9: `Exists` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_exists.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-exists.json`
- Create: `packages/ergoscript/src/eval/coll-exists.ts`
- Create: `packages/ergoscript/test/eval/coll-exists.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_exists.rs:12-79` — Mixed pattern with short-circuit. Outer at line 60 (`add_per_item_jit_cost(3, 1, 10, n)` charged BEFORE the loop, based on FULL input length). Per-iter at line 29 (`add_jit_cost(5)` charged only for VISITED items).

**Key behavior:**

`Exists { input: Expr, condition: Expr, elem_tpe: SType }` MIR. Eval:
1. `const inputColl = extractCollItems(evalExpr(e.input, env, ctx))`
2. `const closure = extractFuncValue(evalExpr(e.condition, env, ctx))`
3. Declared-elem_tpe check (same pattern as Filter).
4. `ctx.addPerItemCost(3, 1, 10, inputColl.items.length)` — **outer charges FULL input length** (sigma-rust line 60, BEFORE the for-loop)
5. For each `item`:
   - `ctx.addCost(5)` — per-iter charged ONLY for visited items
   - Eval body
   - Assert Boolean result; non-Boolean → `'lambda-result-type-mismatch'`
   - If `true` → return `{ kind: 'Boolean', value: true }` (short-circuit)
6. After loop: return `{ kind: 'Boolean', value: false }`.

Fixture entries (smoking-gun included):
1. Happy path: `[1,2,3].exists(x => x > 2)` → `Boolean(true)` (matches at item 3; visits all 3).
2. **Outer-cost-on-full-length smoking-gun**: `[true, false, false, ...×1000].exists(x => x)` — short-circuits at item 1. Expected cost: outer = `addPerItemCost(3, 1, 10, 1000) = 3 + 1 * ceil(1000/10) = 3 + 100 = 103`; per-iter = `1 * 5 = 5`; **total from this arm = 108** (plus child eval costs). Assert `ctx.jitCostAccumulator` reflects this — NOT `addPerItemCost(3, 1, 10, 1) = 4`.
3. No-match: `[1,2,3].exists(x => x > 10)` → `Boolean(false)`, all items visited.
4. Empty input: `[].exists(_ => true)` → `Boolean(false)` (loop doesn't run; per-iter = 0; outer = `addPerItemCost(3, 1, 10, 0) = 3`).
5. Elem-tpe-mismatch.
6. Lambda-not-callable.
7. Lambda-result-type-mismatch (body returns Int).
8. Non-Coll input.
9. Cost-limit-exceeded.

- [ ] **Step 1: Read sigma-rust source**

Pay attention to line 60 — `ctx.add_per_item_jit_cost(3, 1, 10, normalized_input_vals.len() as u32)?;` is BEFORE the `for item in normalized_input_vals { ... }` loop. The per-iter cost at line 29 fires only when `condition_call(item)` is invoked.

- [ ] **Step 2: Write fixture-gen module**

Entry 2 (smoking-gun) constructs a Coll of 1000 items where the first one returns `true`. Verify the captured cost in the JSON matches the formula above.

- [ ] **Step 3-7: Standard task arc**

- [ ] **Step 8: Write the Exists arm**

Create `packages/ergoscript/src/eval/coll-exists.ts`:

```ts
import type { Exists, SValue } from '../mir/types'
import type { Env, EvalContext } from './eval-context'
import { evalExpr } from './eval'
import { extractCollItems, extractFuncValue } from './_coll-helpers'
import { sTypeEquals } from '../mir/stype'
import { EvalError } from './errors'

/**
 * Exists: short-circuit on first true. Mixed pattern with subtlety:
 *   - Outer: addPerItemCost(3, 1, 10, FULL_input_length) — charged BEFORE the loop
 *     so the outer cost is the SAME regardless of where short-circuit fires.
 *   - Per-iter: addCost(5) per VISITED item (reflects short-circuit).
 * Sigma-rust: ergotree-interpreter/src/eval/coll_exists.rs:12-79.
 */
export function evalExists(e: Exists, env: Env, ctx: EvalContext): SValue {
  const inputColl = extractCollItems(evalExpr(e.input, env, ctx))
  const closure = extractFuncValue(evalExpr(e.condition, env, ctx))
  if (!sTypeEquals(inputColl.elem, e.elemTpe)) {
    throw new EvalError('coll-elem-tpe-mismatch',
      `Exists: input elem ${JSON.stringify(inputColl.elem)} != declared ${JSON.stringify(e.elemTpe)}`)
  }
  ctx.addPerItemCost(3, 1, 10, inputColl.items.length)

  for (const item of inputColl.items) {
    ctx.addCost(5)
    const itemEnv = env.extend(closure.argIds[0]!, item)
    const itemRes = evalExpr(closure.body, itemEnv, ctx)
    if (itemRes.kind !== 'Boolean') {
      throw new EvalError('lambda-result-type-mismatch',
        `Exists: condition returned ${itemRes.kind}, expected Boolean`)
    }
    if (itemRes.value) {
      return { kind: 'Boolean', value: true }
    }
  }
  return { kind: 'Boolean', value: false }
}
```

- [ ] **Step 9-12: Wire, test, commit**

Commit:
```
feat(ergoscript): Exists eval arm with outer-cost-on-full-length subtlety (phase 2f coll-hofs task 9)

Mixed pattern + short-circuit on first true. Outer addPerItemCost(3, 1, 10, n)
charges FULL input length regardless of short-circuit point (charged BEFORE
the loop in sigma-rust). Per-iter addCost(5) reflects only visited items.

C1 smoking-gun: 1000-item input with match at item 1 produces cost
108 (outer 103 + per-iter 5), NOT 9 (outer 4 + per-iter 5).
```

---

## Task 10: `ForAll` arm

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/coll_forall.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Create (generated): `packages/ergoscript/test/fixtures/eval/coll-forall.json`
- Create: `packages/ergoscript/src/eval/coll-forall.ts`
- Create: `packages/ergoscript/test/eval/coll-forall.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

**Sigma-rust source:**
- `ergotree-interpreter/src/eval/coll_forall.rs:12-79` — symmetric to Exists; short-circuits on first false; same outer-cost-on-full-length subtlety

**Key behavior:**

`ForAll { input, condition, elem_tpe }`. Identical to Exists except:
- Short-circuits on `false` (returns `Boolean(false)`)
- Empty Coll → `Boolean(true)`
- Default return after loop → `Boolean(true)`

- [ ] **Step 1: Read sigma-rust source**
- [ ] **Step 2-7: Standard task arc**

- [ ] **Step 8: Write the ForAll arm**

Create `packages/ergoscript/src/eval/coll-forall.ts` mirroring `coll-exists.ts` with:
- `if (!itemRes.value) return { kind: 'Boolean', value: false }` (short-circuit on false)
- After loop: `return { kind: 'Boolean', value: true }`

- [ ] **Step 9-12: Wire, test, commit**

Commit:
```
feat(ergoscript): ForAll eval arm (phase 2f coll-hofs task 10)

Mixed pattern + short-circuit on first false. Mirrors Exists's cost structure
exactly (outer addPerItemCost(3, 1, 10, n) charges full length; per-iter
reflects only visited items). Closes the 9-arm coverage for Coll HOFs.

Coverage: 33 → 42 of ~70 arms.
```

---

## Task 11: Layer C3.a infrastructure — operators + runner

**Files:**
- Create: `packages/ergoscript/test/_mutation-operators.ts`
- Create: `packages/ergoscript/test/eval-mutation.test.ts`

**Key behavior:**

7 mutation operators (O1–O7) per the design spec. Each operator takes a parsed `Expr` and returns an array of mutated `Expr` variants. The runner iterates fixtures × operators, evaluates each variant, classifies the outcome as **killed** or **survived**.

**Operator interface:**

```ts
export interface MutationOperator {
  name: string  // 'replaceLeafConst', 'swapBinaryChildren', etc.
  /**
   * Apply this operator to the given Expr. Returns 0 or more mutated variants.
   * Each variant differs from the input by exactly one mutation site.
   * Sites are enumerated in tree-traversal order for determinism.
   */
  apply(expr: Expr): Expr[]
}
```

**Operator implementations:**

```ts
import type { Expr, SValue, SType } from '../src/mir/types'

// O1: replaceLeafConst
// Walks the tree; for each Const, emits a variant where Const.value is replaced
// by a different value of the same SType per the substitution table.
const SUBSTITUTION_TABLE: Record<string, (v: any) => any> = {
  'SBoolean': (v) => !v,
  'SByte':    (v) => v === 0 ? 1 : 0,
  'SShort':   (v) => v + 1,
  'SInt':     (v) => v + 1,
  'SLong':    (v) => v + 1n,
  'SBigInt':  (v) => v + 1n,
  // SColl, SOption, STuple, etc. — leave for O3
}

export const O1_replaceLeafConst: MutationOperator = {
  name: 'replaceLeafConst',
  apply(expr) {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag === 'Const' && node.tpe.tag in SUBSTITUTION_TABLE) {
        const newValue = { ...node.value, value: SUBSTITUTION_TABLE[node.tpe.tag](node.value.value) }
        const mutated = replaceAtPath(expr, path, { ...node, value: newValue })
        variants.push(mutated)
      }
    })
    return variants
  }
}

// O2: swapBinaryChildren — for BinOp / Tuple-of-2 / Append
export const O2_swapBinaryChildren: MutationOperator = {
  name: 'swapBinaryChildren',
  apply(expr) {
    const variants: Expr[] = []
    visitExpr(expr, (node, path) => {
      if (node.tag === 'BinOp') {
        const swapped = { ...node, left: node.right, right: node.left }
        variants.push(replaceAtPath(expr, path, swapped))
      } else if (node.tag === 'Tuple' && node.items.length === 2) {
        const swapped = { ...node, items: [node.items[1], node.items[0]] }
        variants.push(replaceAtPath(expr, path, swapped))
      } else if (node.tag === 'Append') {
        const swapped = { ...node, input: node.col2, col2: node.input }
        variants.push(replaceAtPath(expr, path, swapped))
      }
    })
    return variants
  }
}

// O3: mutateCollItem
// For each Collection-literal node, emit N variants (one per item, with that item mutated via O1).
export const O3_mutateCollItem: MutationOperator = { /* ... */ }

// O4: replaceLambdaBodyConst — applies O1 inside FuncValue bodies
export const O4_replaceLambdaBodyConst: MutationOperator = { /* ... */ }

// O5: negateBooleanCond — wraps Boolean-returning FuncValue body in LogicalNot
export const O5_negateBooleanCond: MutationOperator = { /* ... */ }

// O6: mutateByIndexIndex
export const O6_mutateByIndexIndex: MutationOperator = { /* ... */ }

// O7: mutateFoldZero
export const O7_mutateFoldZero: MutationOperator = { /* ... */ }

export const ALL_OPERATORS: MutationOperator[] = [
  O1_replaceLeafConst, O2_swapBinaryChildren, O3_mutateCollItem,
  O4_replaceLambdaBodyConst, O5_negateBooleanCond,
  O6_mutateByIndexIndex, O7_mutateFoldZero,
]

// Helpers
function visitExpr(expr: Expr, callback: (node: Expr, path: number[]) => void): void { /* tree-traversal in deterministic order */ }
function replaceAtPath(expr: Expr, path: number[], newNode: Expr): Expr { /* immutable deep-replace */ }
```

**Runner:**

```ts
// test/eval-mutation.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExpr } from '../src/wire/parse'
import { ByteReader } from '../src/wire/reader'
import { evaluateWith, makeContext } from '../src/eval/evaluate-with'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from './_helpers'
import { ALL_OPERATORS } from './_mutation-operators'
import { EXPECTED_SURVIVALS } from './_mutation-allowlist'  // populated by Task 12

const ARMS = [
  'coll-size', 'coll-append', 'coll-by-index', 'coll-slice',
  'coll-map', 'coll-filter', 'coll-fold', 'coll-exists', 'coll-forall',
]

const THRESHOLD = 0.90  // 90% kill rate

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'eval')

describe('eval mutation testing (Layer C3.a)', () => {
  for (const arm of ARMS) {
    describe(arm, () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${arm}.json`), 'utf-8'))
      // Filter to only entries that should evaluate cleanly (no expected_error)
      const evalEntries = fixture.entries.filter((e: any) => !e.expected_error)

      let totalMutations = 0
      let killed = 0
      let survivedUnexpectedly = 0

      for (const entry of evalEntries) {
        const bytes = hexToBytes(entry.expr_hex)
        const expr = parseExpr(new ByteReader(bytes))
        const opts = rehydrateEvalOpts(entry.opts)
        const baselineResult = evaluateWith(expr, makeContext(opts))

        for (const op of ALL_OPERATORS) {
          const variants = op.apply(expr)
          for (let i = 0; i < variants.length; i++) {
            totalMutations++
            const variantId = `${entry.name}#${op.name}#${i}`
            try {
              const variantResult = evaluateWith(variants[i]!, makeContext(opts))
              // Compare: deep-equal?
              if (deepEquals(variantResult, baselineResult)) {
                // Survived
                if (!EXPECTED_SURVIVALS.has(variantId)) {
                  survivedUnexpectedly++
                  console.warn(`Unexpected survival: ${variantId}`)
                }
              } else {
                killed++
              }
            } catch (e) {
              // Typed throw → killed
              killed++
            }
          }
        }
      }

      it(`${arm}: mutation score >= ${THRESHOLD * 100}%`, () => {
        const survived = totalMutations - killed
        const score = killed / totalMutations
        expect(score).toBeGreaterThanOrEqual(THRESHOLD)
        expect(survivedUnexpectedly).toBe(0)
      })
    })
  }
})

function deepEquals(a: any, b: any): boolean { /* deep equality on SValue */ }
```

- [ ] **Step 1: Write the operator-helper utilities (visitExpr, replaceAtPath)**

Create stubs at top of `test/_mutation-operators.ts`. These need to recursively walk every `Expr` variant. Use the existing MIR types to enumerate children. The function `visitExpr(expr, cb)` calls `cb(node, path)` for every reachable Expr node, where `path` is a stable numeric path (e.g., `[0, 1, 2]` meaning "child 0 → child 1 → child 2").

- [ ] **Step 2: Implement O1 through O7**

One operator at a time. Test each by hand (write a tiny stub fixture and verify the operator emits the expected variants). The 7 operators are described in the design spec at `docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md` § Validation strategy / Layer C3.a.

- [ ] **Step 3: Create the empty allowlist module**

```ts
// test/_mutation-allowlist.ts
// Populated by Task 12 (calibration).
export const EXPECTED_SURVIVALS = new Set<string>()
```

- [ ] **Step 4: Write the runner**

The `eval-mutation.test.ts` per the skeleton above. First version: NO threshold assertion yet (only log counts) — the threshold assertion lands after Task 12 calibration.

```ts
it.skip(`${arm}: mutation score >= ${THRESHOLD * 100}%`, () => { /* ... */ })
```

(Use `it.skip` until Task 12 calibrates.)

- [ ] **Step 5: Run the runner with skip-assertions to confirm it executes without errors**

```bash
npx vitest run packages/ergoscript/test/eval-mutation.test.ts
```

Expected: passes (skipped assertions); console logs counts per arm.

- [ ] **Step 6: Verify runtime budget**

Check the test file completes in < 30s. If slower, investigate the operator that emits the most variants and consider tightening site selection (e.g., O3 should fire once per Coll, not N² times).

- [ ] **Step 7: Run full ergoscript suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all tests pass; zero TS errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ergoscript/test/_mutation-operators.ts \
       packages/ergoscript/test/_mutation-allowlist.ts \
       packages/ergoscript/test/eval-mutation.test.ts

git commit -m "$(cat <<'EOF'
test(ergoscript): Layer C3.a operator-driven mutation infrastructure (phase 2f coll-hofs task 11)

7 mutation operators (O1-O7) covering: leaf-Const replacement, binary-child
swap, Coll-item mutation, lambda-body Const, Boolean-cond negation, ByIndex-
index, Fold-zero. Runner iterates 9 Coll-HOF fixtures × operators, classifies
each variant as killed (differs from baseline or throws typed EvalError) or
survived. Empty allowlist; threshold assertion skipped until Task 12 calibrates.

Estimated volume: 1000-3000 mutations across the 9 arms. Target runtime < 30s.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Layer C3.a calibration

**Files:**
- Modify: `packages/ergoscript/test/_mutation-allowlist.ts` — populate with calibration findings
- Modify: `packages/ergoscript/test/eval-mutation.test.ts` — enable the threshold assertion

**Key behavior:**

Run the eval-mutation test from Task 11; collect every surviving mutation; classify each by `(operator, applicable_site_pattern)`. For each classification:
- **Fundamentally unkillable** (operator + site shape would never change result): add to allowlist
- **Real coverage gap** (mutation should have been caught but a C1 fixture doesn't exercise the relevant code path): add a new fixture entry to the corresponding arm's fixture-gen module + regenerate

After calibration, the kill rate ≥ 90% per arm with the allowlist applied.

- [ ] **Step 1: Run eval-mutation.test.ts with verbose output**

Capture every surviving mutation:

```bash
npx vitest run packages/ergoscript/test/eval-mutation.test.ts --reporter=verbose 2>&1 | tee /tmp/mutation-survivors.log
```

- [ ] **Step 2: Classify survivors**

For each surviving mutation, manually determine: fundamentally unkillable, or real coverage gap?

**Likely fundamentally-unkillable patterns:**
- O2 (swapBinaryChildren) on commutative `BinOp.Plus`, `BinOp.Mul`, `BinOp.Eq`, `BinOp.And`, `BinOp.Or` — output is invariant under swap.
- O3 (mutateCollItem) on a Coll item that's never accessed (e.g., `SizeOf` of a Coll mutates one item; result depends only on length).
- O1 (replaceLeafConst) on dead-branch consts (e.g., the unused branch of an `If`).
- O7 (mutateFoldZero) when the lambda body ignores the accumulator (degenerate fold).

**Likely coverage gaps to fix with new fixtures:**
- O5 (negateBooleanCond) survives on `Exists`/`ForAll` only when the Coll is empty (no items visited). Already covered by existing fixtures? If yes, add allowlist. If no, add new fixture.
- O6 (mutateByIndexIndex) survives when all Coll items have identical values. Add a fixture with distinct values.

- [ ] **Step 3: Populate the allowlist**

In `test/_mutation-allowlist.ts`:

```ts
export const EXPECTED_SURVIVALS = new Set<string>([
  // O2 survivals on commutative BinOps
  'coll-fold-sum-int#swapBinaryChildren#0',  // (acc + item) swap → (item + acc), commutative
  'coll-map-add-one#swapBinaryChildren#0',   // (x + 1) swap → (1 + x), commutative
  // ... add all classified survivors
])
```

(One line per allowed survival; the variant-ID format `${entry.name}#${op.name}#${site_index}` matches the runner's log output.)

- [ ] **Step 4: Add any new C1 fixture entries for real coverage gaps**

If Step 2 identified missing fixtures, add them to the appropriate `fixture-gen/src/cmds/ergoscript/eval/coll_*.rs` modules, regenerate, commit.

- [ ] **Step 5: Re-run eval-mutation.test.ts; verify zero unexpected survivals**

```bash
npx vitest run packages/ergoscript/test/eval-mutation.test.ts
```

- [ ] **Step 6: Enable threshold assertion**

In `test/eval-mutation.test.ts`, change `it.skip(...)` to `it(...)`. Verify kill rate ≥ 90% per arm.

```bash
npx vitest run packages/ergoscript/test/eval-mutation.test.ts
```

Expected: all arms pass with `score >= 0.90`.

- [ ] **Step 7: Run full suite + typecheck**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

- [ ] **Step 8: Commit**

```bash
git add packages/ergoscript/test/_mutation-allowlist.ts \
       packages/ergoscript/test/eval-mutation.test.ts

# If new fixture entries were added in Step 4:
git add fixture-gen/src/cmds/ergoscript/eval/coll_*.rs \
       packages/ergoscript/test/fixtures/eval/coll-*.json

git commit -m "$(cat <<'EOF'
test(ergoscript): Layer C3.a calibration — allowlist + threshold enforcement (phase 2f coll-hofs task 12)

Calibration of 7 mutation operators against 9 Coll HOF arms. Surviving mutations
classified as fundamentally-unkillable (commutative-op swaps, dead-branch consts,
length-invariant mutations) and allowlisted. New C1 fixture entries added for
coverage gaps surfaced during calibration. Threshold enforced: kill rate >= 90%
per arm.

Calibration metrics (from the eval-mutation.test.ts run that turned green):
- Total mutations: <fill from vitest output: sum across all arms>
- Killed: <fill from vitest output>
- Survived (allowlisted): <fill from vitest output>
- Per-arm kill rate: <fill: one line per arm, e.g., "coll-map: 94.2%">

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Docs update — `facts/ergoscript.md` + umbrella plan

**Files:**
- Modify: `facts/ergoscript.md`
- Modify: `docs/specs/2026-05-13-ergoscript-interpreter-design.md`

- [ ] **Step 1: Read current `facts/ergoscript.md`**

```bash
head -100 /home/mwaddip/projects/ergots/facts/ergoscript.md
grep -n "33 of ~70\|coverage" /home/mwaddip/projects/ergots/facts/ergoscript.md
```

Identify the "Ships additionally" blocks and the coverage line.

- [ ] **Step 2: Add the "Ships additionally (phase 2f Coll HOFs)" block**

Bump coverage line: `33 → 42 of ~70`. Document 9 new arms (`SizeOf`, `Append`, `ByIndex`, `Slice`, `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll`) with their cost-charging patterns.

Document the 7 new EvalError codes with one-line semantics each:
- `'coll-input-not-coll'` — Coll input expression evaluated to non-Coll
- `'coll-elem-tpe-mismatch'` — Coll element type mismatch (declared vs runtime)
- `'coll-by-index-out-of-range'` — ByIndex OOB without default
- `'coll-by-index-index-not-int'` — ByIndex's index expression non-Int
- `'coll-slice-bound-not-int'` — Slice's from/until non-Int
- `'lambda-not-callable'` — non-Lambda or empty-args Lambda
- `'lambda-result-type-mismatch'` — lambda body returned wrong SType

Document new `EvalContext.addPerItemCost(base, perChunk, chunkSize, items)` method in the EvalContext section.

Update "Does NOT ship yet" entries:
- Remove "Coll HOFs" from the deferred list
- Add MethodCall-routed Coll methods (`.indices`, `.zip`, etc.) as deferred to phase 2g.5 (method-call dispatch)

- [ ] **Step 3: Read current umbrella plan**

```bash
head -80 /home/mwaddip/projects/ergots/docs/specs/2026-05-13-ergoscript-interpreter-design.md
```

Identify the phase-table section (probably lines 45-70).

- [ ] **Step 4: Update umbrella plan**

Add "delivered as" annotations:

Replace the phase 2e row with:
```markdown
| **2e — Box / Context model** | ❌ relabeled — **delivered as realized phase 2f-narrow + 2f-medium**. Box runtime + chain-state Context + GlobalVars/GetVar/Option/SelectField shipped under "2f" labels. Lambdas (originally 2d) slipped to realized 2e. |
```

Replace the phase 2f row with:
```markdown
| **2f — Collection operations** | ✅ shipped 2026-05-16 as phase 2f Coll HOFs. 9 arms: SizeOf, Append, ByIndex, Slice, MapColl, Filter, Fold, Exists, ForAll. Introduces `addPerItemCost` infrastructure + Layer C3.a mutation testing. |
```

Insert new row after 2g (between 2g and 2h):
```markdown
| **2g.5 — Method-call dispatch** (NEW) | `MethodCall` + `PropertyCall` Expr variants; typed-value method invocation infrastructure. Unlocks the C2 mainnet corpus (box.tokens, .indices on Coll, Header methods, etc.). Includes the MethodCall-routed Coll methods (.zip, .reverse, .flatten, .getOrElse, etc.) that don't ship as direct Expr variants in phase 2f. |
```

- [ ] **Step 5: Run full ergoscript suite + typecheck (sanity)**

```bash
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript
```

Expected: all green (no source changes in this task).

- [ ] **Step 6: Commit**

```bash
git add facts/ergoscript.md docs/specs/2026-05-13-ergoscript-interpreter-design.md

git commit -m "$(cat <<'EOF'
docs(ergoscript): bump facts to phase 2f Coll HOFs + rewrite umbrella plan (phase 2f coll-hofs task 13)

facts/ergoscript.md:
- Coverage 33 → 42 of ~70 arms
- 9 new arms documented with cost-charging patterns (Pattern A / B-chunked / Mixed)
- 7 new EvalError codes with one-line semantics
- EvalContext.addPerItemCost method documented
- "Does NOT ship yet" entries updated: Coll HOFs removed; MethodCall-routed Coll
  methods deferred to phase 2g.5 (method-call dispatch)

Umbrella plan: "delivered as" annotations for realized 2e/2f drift; new
phase 2g.5 (method-call dispatch) row inserted before 2h (AVL+). Historical
phase numbers in older specs preserved as references.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Finalize — memory + SESSION_CONTEXT + push

**Files:**
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/reference_cost_charging_order_patterns.md`
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md`
- Create / Modify: `packages/ergoscript/SESSION_CONTEXT.md` (gitignored; local-only)

- [ ] **Step 1: Update `project_ergots_direction` memory**

Update body: phase 2f Coll HOFs shipped (42 of ~70 arms); next is **phase 2g — sigma protocol** (umbrella-aligned: `@noble/curves`, structural `SigmaBoolean`, `proveDlog`, `proveDhTuple`, `CAND`/`COR`/`CTHRESHOLD` composition, the 3 deferred sigma combinators `Atleast`/`SigmaAnd`/`SigmaOr` from slice 2d-B).

Bump description line to match.

- [ ] **Step 2: Update `reference_cost_charging_order_patterns` memory**

Extend body to document the **Mixed pattern** (Pattern A and Pattern B can coexist within one arm; lambda HOFs are the canonical examples — outer chunked cost + per-iter fixed cost).

Add to the existing Pattern A / Pattern B explanation:

```markdown
**Mixed pattern (introduced phase 2f Coll HOFs):** Some arms charge both an outer
chunked cost (Pattern B) AFTER eval-children AND a per-iter fixed cost (Pattern A
within the per-item loop). The 5 lambda HOFs (MapColl, Filter, Fold, Exists, ForAll)
are canonical examples. Outer charges full input length regardless of short-circuit
(Exists/ForAll subtlety); per-iter reflects only visited items.
```

- [ ] **Step 3: Update `MEMORY.md` hook line**

Find the line for `project_ergots_direction` and update the hook to reflect the new state (42 of ~70 arms; next is phase 2g sigma protocol).

```markdown
- [Ergots project direction](project_ergots_direction.md) — phase 2f Coll HOFs shipped (42 of ~70 arms); next is phase 2g (sigma protocol, umbrella-aligned)
```

Find the line for `reference_cost_charging_order_patterns` and update to mention the Mixed pattern.

- [ ] **Step 4: Write fresh `SESSION_CONTEXT.md`**

Overwrite `packages/ergoscript/SESSION_CONTEXT.md` with a snapshot covering:
- Last phase completed: 2f Coll HOFs
- Repo state: HEAD at the to-be-pushed final commit; gitignored files
- Coverage: 42 of ~70 arms
- Test counts: prior 1734 + ~60-100 new arm tests + 1000-3000 mutation tests = ~2800-2900 ergoscript tests; 305 proof tests; total ~3100-3200 in node + jsdom
- New error codes total: 35
- New infrastructure: `addPerItemCost` method; `_coll-helpers.ts` (extractCollItems + extractFuncValue); `_mutation-operators.ts` (7 operators); `eval-mutation.test.ts` runner; `_mutation-allowlist.ts`
- Next steps: brainstorm phase 2g — sigma protocol (umbrella-aligned). The deferred `Atleast`/`SigmaAnd`/`SigmaOr` from slice 2d-B come with it. `@noble/curves` becomes a runtime dep.

Use phase 2f medium's `SESSION_CONTEXT.md` as the template (read it first to mirror the structure).

- [ ] **Step 5: Run final verification**

```bash
cd /home/mwaddip/projects/ergots
npx vitest run packages/ergoscript/
npx tsc --noEmit -p packages/ergoscript

# Determinism final check across all 9 new fixtures
cargo run --release -p fixture-gen
git diff packages/ergoscript/test/fixtures/eval/coll-*.json
```

Expected:
- All tests pass (both `node` and `jsdom`)
- Zero TS errors
- Empty diff after fixture regenerate

- [ ] **Step 6: Commit final state**

```bash
git status --short  # should show no unstaged changes
git log --oneline -15  # confirm 14-task history (Tasks 1-14 commits + spec commit)
```

If memory files need committing (they shouldn't — they live outside the repo at `~/.claude/projects/.../memory/`), confirm git status. They should NOT appear in `git status`.

If there are residual changes (e.g., `facts/ergoscript.md` had an additional edit after Task 13's commit), commit them now:

```bash
git commit -m "$(cat <<'EOF'
chore(ergoscript): finalize phase 2f Coll HOFs (task 14)

Memory + SESSION_CONTEXT updates. Final test + typecheck + determinism sweep.
Slice closes the umbrella plan's "phase 2f = collection operations" promise.

Coverage 33 → 42 of ~70 arms. 35 EvalError codes total. New infra:
- EvalContext.addPerItemCost (chunked-per-item cost)
- _coll-helpers.ts (extractCollItems, extractFuncValue)
- Layer C3.a operator-driven mutation testing (7 operators, ≥90% kill rate)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Push to origin**

```bash
git push origin master
```

Verify push succeeds.

- [ ] **Step 8: Confirm completion**

Report to the user:
- Phase 2f Coll HOFs shipped
- 14 tasks committed
- Pushed at HEAD `<sha>`
- Coverage 42 of ~70 arms
- Total tests: ~3100-3200 in node + jsdom
- Next phase: brainstorm phase 2g sigma protocol (the umbrella-aligned one with `@noble/curves`)

---

*End of phase 2f Coll HOFs PLAN.md.*
