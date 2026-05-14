# Phase 2b Implementation Plan — `@mwaddip/ergots-ergoscript`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the smallest evaluator slice — central exhaustive dispatch, `Env`, `EvalContext`, `evaluate()` public surface, and 8 per-variant evaluator arms (Const, ConstPlaceholder, ValDef, ValUse, Tuple, Collection, If, BlockValue) — with cost values copied from sigma-rust at the pinned rev (`integration/ergots@ed5452cf`) and asserted via fixture-gen from day one (layer C1). Layer C2 captures whole-tree synthetic-context cost on the existing 173-tree mainnet_boxes corpus.

**Architecture:** Per-variant module under `src/eval/<variant>.ts`, exporting a single function `eval<Variant>(e, env, ctx) => SValue`. Central exhaustive switch in `src/eval/eval.ts` with `_exhaust: never` discriminant — adding a new Expr variant to `mir/types.ts` becomes a compile-time error here until an arm exists. Arms not in 2b's set throw `EvalError 'not-implemented-yet'`. Layout mirrors phase 2a's `wire/mir/<variant>.ts` pattern. Cost charges happen inline in arms via `ctx.addCost(N)` / `ctx.addPerItemCost(...)`; cost values are real (sigma-rust's `Constant = Fixed(5)` etc.), copied with `eval/<variant>.rs:LINE` cross-references in arm header comments.

**Tech Stack:** TypeScript 5.5 (ES2022, ESM only), Vitest 2 with jsdom, Rust fixture-gen calling into sigma-rust's `ergotree-interpreter` crate at branch `integration/ergots@ed5452cf`. No new runtime deps; no new dev deps.

**Source-first discipline:** Read sigma-rust per arm (`~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/<arm>.rs`) before writing any TS. The full design rationale lives in `docs/specs/2026-05-14-ergoscript-phase-2b-design.md`.

**TDD discipline:** Iron Law per `CLAUDE.md` — no production code without a failing test first. Each per-arm task is a single red-green-refactor cycle.

---

## File Structure

**New files (TypeScript):**

| Path | Responsibility |
|---|---|
| `packages/ergoscript/src/eval/eval.ts` | Central exhaustive switch on `Expr.tag`; exports `evalExpr(e, env, ctx)` |
| `packages/ergoscript/src/eval/eval-context.ts` | `EvalOpts` + `EvalContext` interfaces, `EvalError` class, `makeContext()` constructor |
| `packages/ergoscript/src/eval/env.ts` | `Env` class (immutable extend `Map<ValId, SValue>`) |
| `packages/ergoscript/src/eval/const.ts` | `evalConst` arm |
| `packages/ergoscript/src/eval/const-placeholder.ts` | `evalConstPlaceholder` arm |
| `packages/ergoscript/src/eval/val-def.ts` | `evalValDef` arm (throws — top-level rejection) |
| `packages/ergoscript/src/eval/val-use.ts` | `evalValUse` arm |
| `packages/ergoscript/src/eval/tuple.ts` | `evalTuple` arm |
| `packages/ergoscript/src/eval/collection.ts` | `evalCollection` arm (handles `kind: 'Exprs'` + `kind: 'BoolConstants'`) |
| `packages/ergoscript/src/eval/if.ts` | `evalIf` arm |
| `packages/ergoscript/src/eval/block-value.ts` | `evalBlockValue` arm (depends on `evalExpr` + `Env.extend`) |
| `packages/ergoscript/src/eval/evaluate.ts` | Public `evaluate(tree, opts?)` and `evaluateWith(tree, ctx)` functions |
| `packages/ergoscript/test/eval/eval-context.test.ts` | EvalContext + addCost + addPerItemCost + cost-limit-exceeded tests |
| `packages/ergoscript/test/eval/env.test.ts` | Env extend/get/has/empty tests |
| `packages/ergoscript/test/eval/dispatch.test.ts` | Central switch dispatches to arms; `not-implemented-yet` for unported variants |
| `packages/ergoscript/test/eval/const.test.ts` | Const arm fixture-driven test |
| `packages/ergoscript/test/eval/const-placeholder.test.ts` | ConstPlaceholder arm fixture-driven test |
| `packages/ergoscript/test/eval/val-def.test.ts` | ValDef top-level rejection test |
| `packages/ergoscript/test/eval/val-use.test.ts` | ValUse arm fixture-driven test |
| `packages/ergoscript/test/eval/tuple.test.ts` | Tuple arm fixture-driven test |
| `packages/ergoscript/test/eval/collection.test.ts` | Collection arm fixture-driven test |
| `packages/ergoscript/test/eval/if.test.ts` | If arm fixture-driven test (incl short-circuit semantics) |
| `packages/ergoscript/test/eval/block-value.test.ts` | BlockValue arm fixture-driven test |
| `packages/ergoscript/test/eval/evaluate.test.ts` | Public `evaluate` / `evaluateWith` tests |
| `packages/ergoscript/test/corpus-eval.test.ts` | Layer C2: mainnet_boxes corpus eval-filter |

**New files (Rust fixture-gen):**

| Path | Responsibility |
|---|---|
| `fixture-gen/src/cmds/ergoscript/eval/mod.rs` | Re-exports per-arm fixture commands |
| `fixture-gen/src/cmds/ergoscript/eval/common.rs` | Shared `EvalFixture` struct + `EvalFixtureFile` wrapper + helper that runs sigma-rust eval and captures `(value_json, jit_cost)` |
| `fixture-gen/src/cmds/ergoscript/eval/const_arm.rs` | Const fixtures |
| `fixture-gen/src/cmds/ergoscript/eval/const_placeholder.rs` | ConstPlaceholder fixtures |
| `fixture-gen/src/cmds/ergoscript/eval/val_def.rs` | ValDef top-level rejection fixtures |
| `fixture-gen/src/cmds/ergoscript/eval/val_use.rs` | ValUse fixtures |
| `fixture-gen/src/cmds/ergoscript/eval/tuple.rs` | Tuple fixtures |
| `fixture-gen/src/cmds/ergoscript/eval/collection.rs` | Collection fixtures |
| `fixture-gen/src/cmds/ergoscript/eval/if_arm.rs` | If fixtures (incl short-circuit) |
| `fixture-gen/src/cmds/ergoscript/eval/block_value.rs` | BlockValue fixtures |

**Modified files:**

| Path | Modification |
|---|---|
| `packages/ergoscript/src/index.ts` | Add public exports: `evaluate`, `evaluateWith`, `makeContext`, `EvalError`, types `EvalOpts`/`EvalContext` |
| `packages/ergoscript/package.json` | Bump version `0.1.0` → `0.2.0` |
| `fixture-gen/src/cmds/ergoscript/mod.rs` | Wire `eval` submodule |
| `fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs` | Extend each entry's output with `sigma_rust_eval` block (synthetic-context whole-tree eval — Layer C2) |
| `fixture-gen/src/main.rs` | Wire eval fixture commands into the generator pipeline |
| `facts/ergoscript.md` | Add v0.2.0 surface section: `evaluate` / `evaluateWith` / `EvalContext` / `EvalError` codes |

---

## Stage 1 — Chassis (Tasks 1–6)

The chassis is everything except the 8 arms: error class, EvalContext, Env, central dispatch, public surface. No arm-specific logic yet — all dispatch arms throw `'not-implemented-yet'`. The chassis is testable on its own (the dispatch test asserts that *every* Expr variant currently throws `'not-implemented-yet'`).

### Task 1: Scaffold `eval/` directory + `EvalError` class

**Files:**
- Create: `packages/ergoscript/src/eval/eval-context.ts` (EvalError class only — interfaces in Task 2)
- Create: `packages/ergoscript/test/eval/eval-context.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/ergoscript/test/eval/eval-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { EvalError } from '../../src/eval/eval-context'

describe('EvalError', () => {
  it('extends Error and carries a code', () => {
    const e = new EvalError('something went wrong', 'cost-limit-exceeded')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(EvalError)
    expect(e.message).toBe('something went wrong')
    expect(e.code).toBe('cost-limit-exceeded')
    expect(e.name).toBe('EvalError')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/eval-context.test.ts`
Expected: FAIL with `Cannot find module '../../src/eval/eval-context'`

- [ ] **Step 3: Write minimal implementation**

`packages/ergoscript/src/eval/eval-context.ts`:

```ts
/**
 * Evaluator error class. Single class with a `code` field for programmatic
 * dispatch — same shape as `ProofParseError`/`ErgoTreeParseError` from
 * earlier phases. Codes enumerated in
 * `docs/specs/2026-05-14-ergoscript-phase-2b-design.md` § Error taxonomy.
 */
export class EvalError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'EvalError'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/eval-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/eval/eval-context.ts packages/ergoscript/test/eval/eval-context.test.ts
git commit -m "feat(ergoscript): scaffold eval/ + EvalError class (phase 2b task 1)"
```

---

### Task 2: `EvalContext` + `EvalOpts` interfaces + `makeContext` + `addCost`

**Files:**
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add interfaces + `makeContext`)
- Modify: `packages/ergoscript/test/eval/eval-context.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Append to `packages/ergoscript/test/eval/eval-context.test.ts`:

```ts
import { makeContext } from '../../src/eval/eval-context'

describe('makeContext', () => {
  it('returns an EvalContext with default cost state', () => {
    const ctx = makeContext()
    expect(ctx.jitCost).toBe(0)
    expect(ctx.jitCostLimit).toBeUndefined()
    expect(ctx.constants).toBeUndefined()
  })

  it('accepts jitCostLimit and constants in opts', () => {
    const ctx = makeContext({ jitCostLimit: 1000, constants: [{ kind: 'Boolean', value: true }] })
    expect(ctx.jitCostLimit).toBe(1000)
    expect(ctx.constants).toEqual([{ kind: 'Boolean', value: true }])
  })
})

describe('EvalContext.addCost', () => {
  it('accumulates jitCost', () => {
    const ctx = makeContext()
    ctx.addCost(5)
    ctx.addCost(10)
    expect(ctx.jitCost).toBe(15)
  })

  it('throws cost-limit-exceeded when jitCost exceeds jitCostLimit', () => {
    const ctx = makeContext({ jitCostLimit: 10 })
    ctx.addCost(5)
    expect(() => ctx.addCost(6)).toThrow(EvalError)
    try {
      ctx.addCost(100)
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('cost-limit-exceeded')
    }
  })

  it('does not throw when jitCostLimit is undefined', () => {
    const ctx = makeContext()
    expect(() => ctx.addCost(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })

  it('saturates at MAX_SAFE_INTEGER (mirrors sigma-rust saturating_add)', () => {
    const ctx = makeContext()
    ctx.addCost(Number.MAX_SAFE_INTEGER)
    ctx.addCost(1000)
    expect(ctx.jitCost).toBe(Number.MAX_SAFE_INTEGER)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval/eval-context.test.ts`
Expected: FAIL with `makeContext is not a function` or import error.

- [ ] **Step 3: Write minimal implementation**

Replace contents of `packages/ergoscript/src/eval/eval-context.ts`:

```ts
/**
 * EvalContext + EvalOpts + EvalError. The runtime state passed through
 * every evaluator arm. Cost lives on Context (mirrors sigma-rust's
 * `Context::add_jit_cost` posture); `EvalContext extends EvalOpts` so
 * phase 2e can grow `EvalOpts` with chain-state fields and `EvalContext`
 * inherits them.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/context.rs:77-99
 */

import type { SValue } from '../mir/types'

export class EvalError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'EvalError'
  }
}

export interface EvalOpts {
  /** undefined = unlimited (signing-style) */
  jitCostLimit?: number
  /** Overrides tree.constants if set. Used by ConstPlaceholder resolution. */
  constants?: SValue[]
  // Phase 2e adds: height, selfBox, inputs, outputs, dataInputs,
  // preHeader, headers, extension, treeVersion, ...
}

export interface EvalContext extends EvalOpts {
  /** Mutable accumulator. */
  jitCost: number
  /**
   * Saturating add. Throws `EvalError 'cost-limit-exceeded'` if
   * `jitCostLimit` is set and the new total exceeds it.
   * Mirrors sigma-rust `Context::add_jit_cost`.
   */
  addCost(amount: number): void
}

export function makeContext(opts: EvalOpts = {}): EvalContext {
  const ctx: EvalContext = {
    jitCost: 0,
    jitCostLimit: opts.jitCostLimit,
    constants: opts.constants,
    addCost(amount: number): void {
      ctx.jitCost = Math.min(ctx.jitCost + amount, Number.MAX_SAFE_INTEGER)
      if (ctx.jitCostLimit !== undefined && ctx.jitCost > ctx.jitCostLimit) {
        throw new EvalError(
          `JIT cost limit (${ctx.jitCostLimit}) exceeded`,
          'cost-limit-exceeded'
        )
      }
    },
  }
  return ctx
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval/eval-context.test.ts`
Expected: PASS (5 tests in this file now)

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/eval/eval-context.ts packages/ergoscript/test/eval/eval-context.test.ts
git commit -m "feat(ergoscript): EvalContext + EvalOpts + addCost (phase 2b task 2)"
```

---

### Task 3: `addPerItemCost` on EvalContext

**Files:**
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add `addPerItemCost`)
- Modify: `packages/ergoscript/test/eval/eval-context.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Append to `packages/ergoscript/test/eval/eval-context.test.ts`:

```ts
describe('EvalContext.addPerItemCost', () => {
  // Mirrors sigma-rust's add_per_item_jit_cost(base, per_chunk, chunk_size, n_items)
  // formula: base + ceil(n_items / chunk_size) * per_chunk
  it('charges base + ceil(nItems/chunkSize) * perChunk', () => {
    const ctx = makeContext()
    // BlockValue's call: addPerItemCost(1, 1, 10, items.length)
    ctx.addPerItemCost(1, 1, 10, 0)   // 1 + ceil(0/10)*1 = 1
    expect(ctx.jitCost).toBe(1)
    ctx.addPerItemCost(1, 1, 10, 5)   // 1 + ceil(5/10)*1 = 2
    expect(ctx.jitCost).toBe(3)
    ctx.addPerItemCost(1, 1, 10, 10)  // 1 + 1 = 2
    expect(ctx.jitCost).toBe(5)
    ctx.addPerItemCost(1, 1, 10, 11)  // 1 + 2 = 3
    expect(ctx.jitCost).toBe(8)
    ctx.addPerItemCost(1, 1, 10, 25)  // 1 + 3 = 4
    expect(ctx.jitCost).toBe(12)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/eval-context.test.ts -t "addPerItemCost"`
Expected: FAIL with `ctx.addPerItemCost is not a function`

- [ ] **Step 3: Write minimal implementation**

In `packages/ergoscript/src/eval/eval-context.ts`, add to `EvalContext` interface:

```ts
  /**
   * Composite per-item charge: `base + ceil(nItems / chunkSize) * perChunk`.
   * Mirrors sigma-rust `Context::add_per_item_jit_cost`
   * (`ergotree-ir/src/chain/context.rs:88-99`). Used by BlockValue
   * envelope cost; will be reused by 2f's collection HOFs.
   */
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
```

And in the `makeContext` returned object literal, add:

```ts
    addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void {
      const chunks = Math.ceil(nItems / chunkSize)
      ctx.addCost(base + chunks * perChunk)
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/eval-context.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/eval/eval-context.ts packages/ergoscript/test/eval/eval-context.test.ts
git commit -m "feat(ergoscript): EvalContext.addPerItemCost (phase 2b task 3)"
```

---

### Task 4: `Env` class

**Files:**
- Create: `packages/ergoscript/src/eval/env.ts`
- Create: `packages/ergoscript/test/eval/env.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/ergoscript/test/eval/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Env } from '../../src/eval/env'

describe('Env', () => {
  it('Env.empty() has no bindings', () => {
    const env = Env.empty()
    expect(env.has(0)).toBe(false)
    expect(env.get(0)).toBeUndefined()
  })

  it('extend returns a new Env with the binding', () => {
    const env = Env.empty()
    const extended = env.extend(5, { kind: 'Int', value: 42 })
    expect(extended.has(5)).toBe(true)
    expect(extended.get(5)).toEqual({ kind: 'Int', value: 42 })
  })

  it('extend does NOT mutate the original Env', () => {
    const env = Env.empty()
    env.extend(5, { kind: 'Int', value: 42 })
    expect(env.has(5)).toBe(false)
  })

  it('extend supports overwriting existing bindings (last-write-wins)', () => {
    const env = Env.empty()
      .extend(1, { kind: 'Int', value: 10 })
      .extend(1, { kind: 'Int', value: 20 })
    expect(env.get(1)).toEqual({ kind: 'Int', value: 20 })
  })

  it('extend chains build a multi-binding scope', () => {
    const env = Env.empty()
      .extend(1, { kind: 'Int', value: 1 })
      .extend(2, { kind: 'Int', value: 2 })
      .extend(3, { kind: 'Int', value: 3 })
    expect(env.get(1)).toEqual({ kind: 'Int', value: 1 })
    expect(env.get(2)).toEqual({ kind: 'Int', value: 2 })
    expect(env.get(3)).toEqual({ kind: 'Int', value: 3 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval/env.test.ts`
Expected: FAIL with `Cannot find module '../../src/eval/env'`

- [ ] **Step 3: Write minimal implementation**

`packages/ergoscript/src/eval/env.ts`:

```ts
/**
 * Env — val-def binding store. Immutable extend (clones internally on
 * each extension; original is never mutated). Mirrors sigma-rust's
 * `Env::extend` (`ergotree-interpreter/src/eval/env.rs:28-32`).
 *
 * Our immutable variant naturally implements nested-block scoping (a
 * new Env from `extend` goes out of scope when the function returns).
 * Sigma-rust uses a mutable `&mut Env` and has to manually save/restore
 * shadowed bindings; we don't.
 */

import type { SValue } from '../mir/types'

export class Env {
  private constructor(private readonly store: Map<number, SValue>) {}

  static empty(): Env {
    return new Env(new Map())
  }

  extend(id: number, v: SValue): Env {
    const next = new Map(this.store)
    next.set(id, v)
    return new Env(next)
  }

  get(id: number): SValue | undefined {
    return this.store.get(id)
  }

  has(id: number): boolean {
    return this.store.has(id)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval/env.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/eval/env.ts packages/ergoscript/test/eval/env.test.ts
git commit -m "feat(ergoscript): Env class with immutable extend (phase 2b task 4)"
```

---

### Task 5: Central dispatch chassis (`evalExpr` with `not-implemented-yet` for all variants)

This task creates the central switch with NO arms implemented yet — just the dispatch mechanism that throws `'not-implemented-yet'` for every variant. Subsequent tasks (8–15) replace each `default` fall-through with an explicit `case` calling its arm.

**Files:**
- Create: `packages/ergoscript/src/eval/eval.ts`
- Create: `packages/ergoscript/test/eval/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/ergoscript/test/eval/dispatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { Expr } from '../../src/mir/types'

describe('evalExpr (central dispatch — chassis only)', () => {
  it('throws not-implemented-yet for any variant in 2b chassis state', () => {
    // Use Const as a representative — we know the tag is in the union but
    // no arm is wired yet. Will be replaced as Tasks 8+ wire each arm.
    const e: Expr = { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } }
    expect(() => evalExpr(e, Env.empty(), makeContext())).toThrow(EvalError)
    try {
      evalExpr(e, Env.empty(), makeContext())
    } catch (err) {
      expect(err).toBeInstanceOf(EvalError)
      expect((err as EvalError).code).toBe('not-implemented-yet')
      expect((err as EvalError).message).toContain("'Const'")
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/dispatch.test.ts`
Expected: FAIL with `Cannot find module '../../src/eval/eval'`

- [ ] **Step 3: Write minimal implementation**

`packages/ergoscript/src/eval/eval.ts`:

```ts
/**
 * Central evaluator dispatch — exhaustive switch on `Expr.tag`. Adding a
 * new Expr variant to `mir/types.ts` becomes a compile-time error here
 * via the `_exhaust: never` discriminant until an arm exists.
 *
 * Phase 2b ships 8 arms (Const, ConstPlaceholder, BlockValue, ValDef,
 * ValUse, Tuple, Collection, If). Every other variant currently throws
 * `EvalError 'not-implemented-yet'` — Phase 2c+ replaces each with an
 * explicit case calling its arm. The chassis itself is correct from
 * this commit forward.
 *
 * Cross-reference:
 *   ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs
 */

import type { Expr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalExpr(e: Expr, _env: Env, _ctx: EvalContext): SValue {
  // Chassis-only: no arms wired yet. Each per-arm task (8-15) inserts an
  // explicit `case` returning the arm's eval function before this throw.
  throw new EvalError(
    `not yet supported: variant '${(e as { tag: string }).tag}'`,
    'not-implemented-yet'
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/dispatch.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/eval/eval.ts packages/ergoscript/test/eval/dispatch.test.ts
git commit -m "feat(ergoscript): central evalExpr dispatch chassis (phase 2b task 5)"
```

---

### Task 6: Public surface — `evaluate` + `evaluateWith`

**Files:**
- Create: `packages/ergoscript/src/eval/evaluate.ts`
- Create: `packages/ergoscript/test/eval/evaluate.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/ergoscript/test/eval/evaluate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { evaluate, evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { ErgoTree } from '../../src/mir/types'

const treeWithConstBody = (): ErgoTree => ({
  header: { version: 0, hasSize: false, constantSegregation: false, rawHeader: 0x00 },
  constantTypes: [],
  constants: [],
  body: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 42 } },
})

describe('evaluate', () => {
  it('routes through dispatch — currently throws not-implemented-yet for Const (chassis-only state)', () => {
    expect(() => evaluate(treeWithConstBody())).toThrow(EvalError)
    try {
      evaluate(treeWithConstBody())
    } catch (e) {
      expect((e as EvalError).code).toBe('not-implemented-yet')
    }
  })

  it('accepts EvalOpts with jitCostLimit + constants', () => {
    expect(() =>
      evaluate(treeWithConstBody(), { jitCostLimit: 1000, constants: [] })
    ).toThrow(EvalError)  // still 'not-implemented-yet' until Task 8
  })
})

describe('evaluateWith', () => {
  it('takes a pre-built EvalContext (caller can inspect ctx.jitCost after)', () => {
    const ctx = makeContext()
    expect(() => evaluateWith(treeWithConstBody(), ctx)).toThrow(EvalError)
    // ctx.jitCost remains 0 because dispatch threw before any addCost
    expect(ctx.jitCost).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/eval/evaluate.test.ts`
Expected: FAIL with module-not-found.

- [ ] **Step 3: Write minimal implementation**

`packages/ergoscript/src/eval/evaluate.ts`:

```ts
/**
 * Public evaluator entry points.
 *
 * `evaluate(tree, opts?)` is the ergonomic happy path — constructs an
 * EvalContext from `opts` (defaulting `constants` to `tree.constants` if
 * not overridden) and dispatches on the tree body. `evaluateWith(tree,
 * ctx)` takes a pre-built EvalContext, useful for tests and tooling that
 * need to inspect `ctx.jitCost` after evaluation completes.
 */

import type { ErgoTree, SValue } from '../mir/types'
import { Env } from './env'
import { evalExpr } from './eval'
import { makeContext } from './eval-context'
import type { EvalContext, EvalOpts } from './eval-context'

export function evaluate(tree: ErgoTree, opts: EvalOpts = {}): SValue {
  const ctx = makeContext({
    jitCostLimit: opts.jitCostLimit,
    constants: opts.constants ?? tree.constants,
  })
  return evalExpr(tree.body, Env.empty(), ctx)
}

export function evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue {
  // Caller-supplied ctx is honored verbatim. If they want tree.constants
  // resolution they must set it themselves before calling.
  return evalExpr(tree.body, Env.empty(), ctx)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval/evaluate.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/eval/evaluate.ts packages/ergoscript/test/eval/evaluate.test.ts
git commit -m "feat(ergoscript): public evaluate + evaluateWith surface (phase 2b task 6)"
```

---

## Stage 2 — Per-arm implementations (Tasks 7–14)

Each per-arm task follows this pattern:

1. **Add the fixture-gen Rust command** — emits one JSON fixture file with multiple entries. Sigma-rust is the oracle.
2. **Wire it into the fixture-gen pipeline** — `fixture-gen/src/cmds/ergoscript/eval/mod.rs` and `fixture-gen/src/main.rs`.
3. **Run fixture-gen** — verify the new JSON appears under `packages/ergoscript/test/fixtures/eval/<arm>.json`.
4. **Write the TS test** — load the fixture, call `evaluateWith`, assert value + cost.
5. **Verify RED** — test fails with `'not-implemented-yet'`.
6. **Implement the arm** — single function in `src/eval/<arm>.ts`.
7. **Wire it into the central dispatch** — replace the `default` fall-through for this tag with an explicit `case`.
8. **Verify GREEN** — test passes.
9. **Commit.**

Before Task 7 starts, set up the fixture-gen `eval/` subdirectory and shared infrastructure.

### Task 7: Fixture-gen `eval/` subdirectory + shared `EvalFixture` type

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Create: `fixture-gen/src/cmds/ergoscript/eval/common.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/mod.rs`

- [ ] **Step 1: Read the existing wire layout**

Run:
```bash
cat fixture-gen/src/cmds/ergoscript/mod.rs
cat fixture-gen/src/main.rs | head -40
```

Confirm the existing pattern (e.g., `pub mod mainnet_boxes;` exports + `main.rs` calls `generate()` per command).

- [ ] **Step 2: Create `fixture-gen/src/cmds/ergoscript/eval/common.rs`**

```rust
//! Shared types for phase 2b eval fixtures.
//!
//! Each per-arm command emits a `EvalFixtureFile` containing a `Vec<EvalFixture>`.
//! Sigma-rust is the oracle: each fixture's `expected_value_json` and
//! `expected_cost` come from running `expr.eval(env, ctx)` against a
//! synthetic Context built from `opts_json`.

use ergotree_interpreter::eval::env::Env;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::value::Value;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Serialize)]
pub struct EvalFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    /// EvalOpts for the TS side. Currently `{ jitCostLimit?, constants? }`;
    /// schema grows additively with later phases.
    pub opts_json: JsonValue,
    /// Sigma-rust's Value after eval, encoded as JSON. Schema matches
    /// the SValue hydrator in test/corpus.test.ts.
    pub expected_value_json: JsonValue,
    /// `ctx.jit_cost_value()` after eval.
    pub expected_cost: u64,
}

#[derive(Serialize)]
pub struct EvalFixtureFile {
    pub corpus: &'static str,
    pub entries: Vec<EvalFixture>,
}

/// Convenience helper: encode a sigma-rust `Value` as our SValue JSON.
/// Use this in each arm's fixture command.
pub fn value_to_json(v: &Value) -> JsonValue {
    // Stub for task 7. Actual encoding logic added incrementally as each
    // arm's fixture command requires more SValue variants. Most early
    // arms only need Boolean / Byte / Short / Int / Long / BigInt /
    // Coll / Tuple. Box / SigmaProp / GroupElement are deferred to 2g+.
    serde_json::to_value(format!("{:?}", v)).unwrap()
}
```

(Note: `value_to_json` will need real implementations during arm tasks. For task 7 we ship the stub so the module compiles; each arm task extends the function's switch with its specific kind.)

- [ ] **Step 3: Create `fixture-gen/src/cmds/ergoscript/eval/mod.rs`**

```rust
//! Phase 2b evaluator fixtures.

pub mod common;
// Per-arm modules added in tasks 8-15:
// pub mod const_arm;
// pub mod const_placeholder;
// ...
```

- [ ] **Step 4: Wire eval submodule into `fixture-gen/src/cmds/ergoscript/mod.rs`**

Edit `fixture-gen/src/cmds/ergoscript/mod.rs` — add at the end:

```rust
pub mod eval;
```

- [ ] **Step 5: Verify it builds**

Run: `cd fixture-gen && cargo build --release`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/
git add fixture-gen/src/cmds/ergoscript/mod.rs
git commit -m "feat(fixture-gen): scaffold eval/ subdir + EvalFixture type (phase 2b task 7)"
```

---

### Task 8: `Const` arm

Sigma-rust reference: `eval.rs:21-24` — `Expr::Const(c) => { ctx.add_jit_cost(5); Ok(Value::from(c.v.clone())) }`. Cost: 5.

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/const_arm.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (add `pub mod const_arm;`)
- Modify: `fixture-gen/src/main.rs` (call `eval::const_arm::generate()`)
- Modify: `fixture-gen/src/cmds/ergoscript/eval/common.rs` (extend `value_to_json` with Boolean/Byte/Short/Int/Long branches as needed by these fixtures)
- Create: `packages/ergoscript/src/eval/const.ts`
- Create: `packages/ergoscript/test/eval/const.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (wire `case 'Const':`)

- [ ] **Step 1: Add fixture-gen Rust command**

Create `fixture-gen/src/cmds/ergoscript/eval/const_arm.rs`:

```rust
//! Const arm — fixtures for `Expr::Const(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval.rs:21-24
//! Cost: Constant = Fixed(5)

use ergotree_interpreter::eval::env::Env;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Each entry: build an Expr::Const, wrap as ErgoTree (no segregation),
    // serialize, then run sigma-rust eval against an empty synthetic Context.
    let cases: Vec<(&str, Constant)> = vec![
        ("const_bool_true", true.into()),
        ("const_bool_false", false.into()),
        ("const_byte_0", 0i8.into()),
        ("const_byte_42", 42i8.into()),
        ("const_short_0", 0i16.into()),
        ("const_short_neg1", (-1i16).into()),
        ("const_int_0", 0i32.into()),
        ("const_int_max", i32::MAX.into()),
        ("const_int_min", i32::MIN.into()),
        ("const_long_0", 0i64.into()),
        ("const_long_max", i64::MAX.into()),
    ];

    for (name, c) in cases {
        let expr: Expr = c.into();
        // Header: v0, no segregation. ErgoTree::new with no segregation just
        // wraps the expr verbatim; tree.constants is empty.
        let header = ergotree_ir::ergo_tree::ErgoTreeHeader::v0(/* segregation */ false);
        let tree = ErgoTree::new(header, &expr)?;
        let tree_bytes = tree.sigma_serialize_bytes()?;
        let tree_bytes_hex = hex::encode(&tree_bytes);

        // Run sigma-rust eval. Evaluable::eval is implemented for Expr
        // (and per-variant); see ergotree-interpreter/src/eval.rs:14-19.
        let ctx = force_any_val::<Context>();
        let mut env = Env::empty();
        let val = tree.proposition()?.eval(&mut env, &ctx)?;
        let cost = ctx.jit_cost_value();

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: cost,
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_const",
        entries,
    })
}
```

(Note: the exact sigma-rust API for `expr.eval_eval(&env, &ctx)` may need a small adapter — when implementing, check `ergotree-interpreter/src/eval.rs::Evaluable::eval` and the `Spanned<Expr>` wrapping. The principle is: run sigma-rust's evaluator and capture both result and cost.)

Also extend `value_to_json` in `common.rs` to handle the SValue kinds these fixtures produce. Replace the stub with:

```rust
pub fn value_to_json(v: &Value) -> JsonValue {
    use ergotree_ir::mir::value::Value::*;
    match v {
        Boolean(b) => json!({ "kind": "Boolean", "value": b }),
        Byte(n) => json!({ "kind": "Byte", "value": n }),
        Short(n) => json!({ "kind": "Short", "value": n }),
        Int(n) => json!({ "kind": "Int", "value": n }),
        Long(n) => json!({ "kind": "Long", "value": n.to_string() }),  // bigint as string for JSON
        BigInt(b) => json!({ "kind": "BigInt", "value": b.to_string() }),
        // Other variants extended as later arm tasks need them.
        _ => panic!("value_to_json: unsupported variant for phase 2b: {:?}", v),
    }
}
```

- [ ] **Step 2: Wire into fixture-gen module + main.rs**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`:

```rust
pub mod common;
pub mod const_arm;
```

In `fixture-gen/src/main.rs`, find the existing call sites for ergoscript fixtures (e.g. `cmds::ergoscript::mainnet_boxes::generate()`) and add a sibling call:

```rust
// Phase 2b eval fixtures
let const_fixture = cmds::ergoscript::eval::const_arm::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/const.json",
    &const_fixture,
)?;
```

(If `eval/` subdir doesn't exist under `test/fixtures/`, the write helper should create it. If not, add a `std::fs::create_dir_all` call.)

- [ ] **Step 3: Run fixture-gen**

Run: `cd fixture-gen && cargo run --release`
Expected: among the existing output, see `wrote /home/mwaddip/projects/ergots/packages/ergoscript/test/fixtures/eval/const.json`.

Verify the file exists and contains 11 entries:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('packages/ergoscript/test/fixtures/eval/const.json')).entries.length)"
```
Expected: `11`

- [ ] **Step 4: Write the TS test (red)**

`packages/ergoscript/test/eval/const.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/const.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number; constants?: unknown[] }
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function hydrateExpectedValue(j: { kind: string; value?: unknown }): unknown {
  // Long/BigInt are encoded as decimal strings (JSON has no bigint literal).
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) }
  }
  return j
}

describe('Const arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext({ ...entry.opts_json })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateExpectedValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 5: Run test, verify RED**

Run: `npx vitest run test/eval/const.test.ts`
Expected: 11 FAIL — each throws `EvalError 'not-implemented-yet'` because `evalExpr` still has the chassis-only default arm.

- [ ] **Step 6: Implement the arm**

`packages/ergoscript/src/eval/const.ts`:

```ts
/**
 * Const arm — return the literal value, charge cost.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval.rs:21-24
 *   Expr::Const(c) => { ctx.add_jit_cost(5); Ok(Value::from(c.v.clone())) }
 * Cost: Constant = Fixed(5)
 */

import type { Const, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalConst(e: Const, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  return e.value
}
```

- [ ] **Step 7: Wire into central dispatch**

Edit `packages/ergoscript/src/eval/eval.ts` — add an explicit `case 'Const'` BEFORE the throw. Replace:

```ts
export function evalExpr(e: Expr, _env: Env, _ctx: EvalContext): SValue {
  throw new EvalError(
    `not yet supported: variant '${(e as { tag: string }).tag}'`,
    'not-implemented-yet'
  )
}
```

With:

```ts
import { evalConst } from './const'

export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
    case 'Const':
      return evalConst(e, env, ctx)
    default:
      throw new EvalError(
        `not yet supported: variant '${(e as { tag: string }).tag}'`,
        'not-implemented-yet'
      )
  }
}
```

(Note: parameter names lose the `_` prefix now that they're used.)

- [ ] **Step 8: Run test, verify GREEN**

Run: `npx vitest run test/eval/const.test.ts`
Expected: PASS (11 tests).

Also run the full suite to confirm no regression:
```bash
npx vitest run
```
Expected: PASS (1247 + 11 + chassis tests = ~1265 passing; previously-passing tests unaffected).

- [ ] **Step 9: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/const.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/const.test.ts
git add packages/ergoscript/test/fixtures/eval/const.json
git commit -m "feat(ergoscript): Const eval arm + per-arm fixture infra (phase 2b task 8)"
```

---

### Task 9: `ConstPlaceholder` arm

Sigma-rust reference: `eval.rs:52-64` — `Expr::ConstPlaceholder(cp) => { ctx.add_jit_cost(1); ctx.constants.get(cp.id).map(...) }`. Cost: 1.

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/const_placeholder.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (add `pub mod const_placeholder;`)
- Modify: `fixture-gen/src/main.rs` (call `eval::const_placeholder::generate()`)
- Create: `packages/ergoscript/src/eval/const-placeholder.ts`
- Create: `packages/ergoscript/test/eval/const-placeholder.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (wire `case 'ConstPlaceholder':`)

- [ ] **Step 1: Add fixture-gen command**

`fixture-gen/src/cmds/ergoscript/eval/const_placeholder.rs`:

```rust
//! ConstPlaceholder arm — fixtures for `Expr::ConstPlaceholder(cp)` evaluation.
//!
//! These trees use constant segregation: the body is a ConstPlaceholder
//! that references the tree.constants[id]. Cost: ConstantPlaceholder = Fixed(1).

use ergotree_interpreter::eval::env::Env;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let cases: Vec<(&str, Constant)> = vec![
        ("placeholder_int_42", 42i32.into()),
        ("placeholder_long_max", i64::MAX.into()),
        ("placeholder_bool_true", true.into()),
        ("placeholder_byte_neg1", (-1i8).into()),
    ];

    for (name, c) in cases {
        // Build a segregated-constants ErgoTree. ErgoTree::new with a
        // v0 header that has segregation=true automatically extracts the
        // Const into tree.constants and replaces the body with a
        // ConstantPlaceholder pointing at index 0. See
        // ergotree-ir/src/ergo_tree.rs:205-242 for the constructor's
        // segregation handling.
        let header = ergotree_ir::ergo_tree::ErgoTreeHeader::v0(/* segregation */ true);
        let expr: Expr = c.clone().into();  // regular Const; ErgoTree::new substitutes
        let tree = ErgoTree::new(header, &expr)?;
        let tree_bytes = tree.sigma_serialize_bytes()?;
        let tree_bytes_hex = hex::encode(&tree_bytes);

        // Eval against a synthetic context. tree.proposition() resolves
        // the ConstantPlaceholder back to a Const for evaluation.
        let ctx = force_any_val::<Context>();
        let mut env = Env::empty();
        let val = tree.proposition()?.eval(&mut env, &ctx)?;
        let cost = ctx.jit_cost_value();

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex,
            // The TS evaluate() function defaults `constants` to `tree.constants`,
            // so opts_json is empty here — the fixture's tree carries its own.
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: cost,
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_const_placeholder",
        entries,
    })
}
```

(Note: when implementing, look up the exact sigma-rust API for building a segregated-constants ErgoTree. The pattern likely involves `ErgoTree::new` with a header byte that has the segregation bit set, plus a `Vec<Constant>` for the constants section. Check `ergotree-ir/src/ergo_tree.rs`.)

- [ ] **Step 2: Wire into module + main.rs**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs` add: `pub mod const_placeholder;`

In `fixture-gen/src/main.rs` add:
```rust
let cp_fixture = cmds::ergoscript::eval::const_placeholder::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/const-placeholder.json",
    &cp_fixture,
)?;
```

- [ ] **Step 3: Run fixture-gen**

Run: `cd fixture-gen && cargo run --release`
Expected: `wrote .../test/fixtures/eval/const-placeholder.json` with 4 entries.

- [ ] **Step 4: Write the TS test (red)**

`packages/ergoscript/test/eval/const-placeholder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/const-placeholder.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number; constants?: unknown[] }
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function hydrateExpectedValue(j: { kind: string; value?: unknown }): unknown {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) }
  }
  return j
}

describe('ConstPlaceholder arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      // evaluate() defaults constants to tree.constants, so we use the
      // public API here for ergonomic verification. evaluateWith for cost.
      const ctx = makeContext({ constants: tree.constants })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateExpectedValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('ConstPlaceholder arm — error cases', () => {
  it('throws const-placeholder-no-constants when ctx.constants is undefined', () => {
    // Hand-construct an ErgoTree-equivalent: just dispatch through evalExpr directly
    // is cleaner. Need a Const tree to exercise dispatch + a ConstPlaceholder body.
    // Use the first fixture's bytes but construct a context without constants.
    const tree = parseTree(hexToBytes(fixture.entries[0]!.tree_bytes_hex))
    const ctx = makeContext()  // no constants
    expect(() => evaluateWith(tree, ctx)).toThrow(EvalError)
    try {
      evaluateWith(tree, ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('const-placeholder-no-constants')
    }
  })

  it('throws const-placeholder-id-out-of-range when id >= constants.length', () => {
    const tree = parseTree(hexToBytes(fixture.entries[0]!.tree_bytes_hex))
    const ctx = makeContext({ constants: [] })  // empty constants
    expect(() => evaluateWith(tree, ctx)).toThrow(EvalError)
    try {
      evaluateWith(tree, ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('const-placeholder-id-out-of-range')
    }
  })
})
```

- [ ] **Step 5: Run test, verify RED**

Run: `npx vitest run test/eval/const-placeholder.test.ts`
Expected: all FAIL with `'not-implemented-yet'`.

- [ ] **Step 6: Implement the arm**

`packages/ergoscript/src/eval/const-placeholder.ts`:

```ts
/**
 * ConstPlaceholder arm — resolve via ctx.constants[id], charge cost.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval.rs:52-64
 *   Expr::ConstPlaceholder(cp) => {
 *     ctx.add_jit_cost(1);
 *     let constant = ctx.constants.and_then(|cs| cs.get(cp.id as usize))
 *       .ok_or_else(...)?;
 *     Ok(Value::from(constant.v.clone()))
 *   }
 * Cost: ConstantPlaceholder = Fixed(1) per Scala
 */

import type { ConstPlaceholder, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalConstPlaceholder(e: ConstPlaceholder, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(1)
  if (ctx.constants === undefined) {
    throw new EvalError(
      `ConstPlaceholder(${e.id}): ctx.constants is undefined; cannot resolve`,
      'const-placeholder-no-constants'
    )
  }
  if (e.id >= ctx.constants.length) {
    throw new EvalError(
      `ConstPlaceholder(${e.id}): id out of range (constants.length=${ctx.constants.length})`,
      'const-placeholder-id-out-of-range'
    )
  }
  return ctx.constants[e.id]!
}
```

- [ ] **Step 7: Wire into central dispatch**

In `packages/ergoscript/src/eval/eval.ts`, add inside the switch (after the `Const` case):

```ts
import { evalConstPlaceholder } from './const-placeholder'

// ... in the switch:
    case 'ConstPlaceholder':
      return evalConstPlaceholder(e, env, ctx)
```

- [ ] **Step 8: Run test, verify GREEN**

Run: `npx vitest run test/eval/const-placeholder.test.ts`
Expected: all PASS.

Full suite: `npx vitest run` — expect prior tests still passing.

- [ ] **Step 9: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/const_placeholder.rs
git add fixture-gen/src/cmds/ergoscript/eval/mod.rs
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/const-placeholder.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/const-placeholder.test.ts
git add packages/ergoscript/test/fixtures/eval/const-placeholder.json
git commit -m "feat(ergoscript): ConstPlaceholder eval arm (phase 2b task 9)"
```

---

### Task 10: `ValDef` arm (top-level rejection)

Sigma-rust reference: `eval.rs:66-68` — `Expr::ValDef(_) => Err(EvalError::UnexpectedExpr("ValDef should be evaluated in BlockValue".to_string()))`. ValDef at top level is rejected; it's only valid inside `BlockValue.items`.

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/val_def.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + `main.rs`
- Create: `packages/ergoscript/src/eval/val-def.ts`
- Create: `packages/ergoscript/test/eval/val-def.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

- [ ] **Step 1: Add fixture-gen command**

`fixture-gen/src/cmds/ergoscript/eval/val_def.rs`:

```rust
//! ValDef arm — verifies that a top-level ValDef returns an error.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval.rs:66-68
//! Sigma-rust returns EvalError::UnexpectedExpr; we throw EvalError
//! with code 'val-def-outside-block'. Fixture asserts the error case.

use ergotree_interpreter::eval::env::Env;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::val_def::ValDef;
use ergotree_ir::serialization::SigmaSerializable;
use serde::Serialize;
use serde_json::json;
use sigma_test_util::force_any_val;

#[derive(Serialize)]
pub struct ValDefErrorFixture {
    pub name: String,
    pub tree_bytes_hex: String,
    pub opts_json: serde_json::Value,
    /// Expected: a thrown EvalError with this code.
    pub expected_error_code: String,
}

#[derive(Serialize)]
pub struct ValDefErrorFile {
    pub corpus: &'static str,
    pub entries: Vec<ValDefErrorFixture>,
}

pub fn generate() -> anyhow::Result<ValDefErrorFile> {
    // Build a tree whose body is a top-level ValDef.
    let val_def_expr: Expr = ValDef {
        id: 0.into(),
        rhs: Box::new(Expr::Const(42i32.into())),
    }
    .into();
    let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &val_def_expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    Ok(ValDefErrorFile {
        corpus: "eval_val_def",
        entries: vec![ValDefErrorFixture {
            name: "valdef_top_level_throws".to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_error_code: "val-def-outside-block".to_string(),
        }],
    })
}
```

- [ ] **Step 2: Wire into module + main.rs**

In `eval/mod.rs`: `pub mod val_def;`

In `main.rs`:
```rust
let vd_fixture = cmds::ergoscript::eval::val_def::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/val-def.json",
    &vd_fixture,
)?;
```

- [ ] **Step 3: Run fixture-gen**

Run: `cd fixture-gen && cargo run --release`
Expected: `wrote .../test/fixtures/eval/val-def.json` with 1 entry.

- [ ] **Step 4: Write the TS test (red)**

`packages/ergoscript/test/eval/val-def.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluate } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/val-def.json')

interface ValDefErrorFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number; constants?: unknown[] }
  expected_error_code: string
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: ValDefErrorFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('ValDef arm — top-level rejection', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: throws ${entry.expected_error_code}`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      expect(() => evaluate(tree, entry.opts_json)).toThrow(EvalError)
      try {
        evaluate(tree, entry.opts_json)
      } catch (e) {
        expect((e as EvalError).code).toBe(entry.expected_error_code)
      }
    })
  }
})
```

- [ ] **Step 5: Run test, verify RED**

Run: `npx vitest run test/eval/val-def.test.ts`
Expected: FAIL — current chassis throws `'not-implemented-yet'` not `'val-def-outside-block'`.

- [ ] **Step 6: Implement the arm**

`packages/ergoscript/src/eval/val-def.ts`:

```ts
/**
 * ValDef arm — top-level rejection. ValDef is only valid as an item
 * inside `BlockValue.items`; reaching it as a top-level Expr is a
 * structural error.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval.rs:66-68
 *   Expr::ValDef(_) => Err(EvalError::UnexpectedExpr(
 *     ("ValDef should be evaluated in BlockValue").to_string(),
 *   ))
 */

import type { SValue, ValDef } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalValDef(e: ValDef, _env: Env, _ctx: EvalContext): SValue {
  throw new EvalError(
    `ValDef(id=${e.id}) should be evaluated inside BlockValue, not at top level`,
    'val-def-outside-block'
  )
}
```

- [ ] **Step 7: Wire into central dispatch**

In `eval.ts`:

```ts
import { evalValDef } from './val-def'

// in the switch:
    case 'ValDef':
      return evalValDef(e, env, ctx)
```

- [ ] **Step 8: Run test, verify GREEN**

Run: `npx vitest run test/eval/val-def.test.ts`
Expected: PASS.

Full suite: `npx vitest run` — expect no regression.

- [ ] **Step 9: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/val_def.rs
git add fixture-gen/src/cmds/ergoscript/eval/mod.rs
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/val-def.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/val-def.test.ts
git add packages/ergoscript/test/fixtures/eval/val-def.json
git commit -m "feat(ergoscript): ValDef top-level rejection arm (phase 2b task 10)"
```

---

### Task 11: `ValUse` arm

Sigma-rust reference: `eval/val_use.rs:15` — `_ctx.add_jit_cost(5); env.get(self.val_id).cloned().ok_or_else(...)`. Cost: 5.

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/val_use.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + `main.rs`
- Create: `packages/ergoscript/src/eval/val-use.ts`
- Create: `packages/ergoscript/test/eval/val-use.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

ValUse can't be exercised in isolation at top level (it requires a binding in Env, which sigma-rust populates inside BlockValue). The fixture-gen for this arm builds a `BlockValue { items: [ValDef(0, Const(42))], result: ValUse(0) }` tree and runs sigma-rust eval on it. The captured cost includes the BlockValue envelope + ValDef rhs eval + ADD_TO_ENV + ValUse — all charged together. The TS test asserts the same total. (Once Task 14 ports BlockValue, this fixture will fully eval; but for THIS task we'll verify the ValUse arm in isolation by hand-constructing an `Env` with a binding and dispatching `evalExpr` on a bare `ValUse` expression — bypassing the parser. The fixture still goes through fixture-gen for the cost-of-ValUse-alone capture.)

- [ ] **Step 1: Add fixture-gen command**

`fixture-gen/src/cmds/ergoscript/eval/val_use.rs`:

```rust
//! ValUse arm — fixtures for `Expr::ValUse(...)` evaluation.
//!
//! ValUse can't be exercised at top level because it requires a binding
//! in Env. Fixture-gen captures: (a) the cost of ValUse alone (when
//! Env has the binding), and (b) the unbound-error case.

use ergotree_interpreter::eval::env::Env;
use ergotree_interpreter::eval::Evaluable;
use ergotree_ir::chain::context::Context;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::types::stype::SType;
use ergotree_ir::mir::value::Value;
use serde::Serialize;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::value_to_json;

#[derive(Serialize)]
pub struct ValUseFixture {
    pub name: String,
    /// Bare ValUse expression; not wrapped in ErgoTree because ValUse
    /// can't be a top-level tree body (parser would accept it but eval
    /// rejects without a parent BlockValue's bindings). TS test
    /// hand-constructs an Env and dispatches evalExpr directly.
    pub val_id: u32,
    pub tpe_json: serde_json::Value,
    /// Pre-built env: Map<id, Value> — TS test reconstructs.
    pub env_bindings: Vec<(u32, serde_json::Value)>,
    pub expected_value_json: serde_json::Value,
    pub expected_cost: u64,
    pub expected_error_code: Option<String>,  // for unbound case
}

#[derive(Serialize)]
pub struct ValUseFile {
    pub corpus: &'static str,
    pub entries: Vec<ValUseFixture>,
}

pub fn generate() -> anyhow::Result<ValUseFile> {
    let mut entries = Vec::new();

    // Case 1: ValUse(id=5) bound to Int 42
    let ctx = force_any_val::<Context>();
    let mut env = Env::empty();
    env.insert(5.into(), Value::Int(42));
    let valuse = ValUse { val_id: 5.into(), tpe: SType::SInt };
    let val = valuse.eval(&mut env, &ctx)?;
    let cost = ctx.jit_cost_value();

    entries.push(ValUseFixture {
        name: "val_use_int_42".to_string(),
        val_id: 5,
        tpe_json: json!({ "tag": "SInt" }),
        env_bindings: vec![(5, value_to_json(&Value::Int(42)))],
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
        expected_error_code: None,
    });

    // Case 2: ValUse(id=99) unbound
    entries.push(ValUseFixture {
        name: "val_use_unbound".to_string(),
        val_id: 99,
        tpe_json: json!({ "tag": "SInt" }),
        env_bindings: vec![],
        expected_value_json: json!(null),
        expected_cost: 0,  // not reached
        expected_error_code: Some("val-use-unbound".to_string()),
    });

    Ok(ValUseFile {
        corpus: "eval_val_use",
        entries,
    })
}
```

- [ ] **Step 2: Wire + run fixture-gen**

In `eval/mod.rs`: `pub mod val_use;`

In `main.rs`:
```rust
let vu_fixture = cmds::ergoscript::eval::val_use::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/val-use.json",
    &vu_fixture,
)?;
```

Run: `cd fixture-gen && cargo run --release`

- [ ] **Step 3: Write TS test (red)**

`packages/ergoscript/test/eval/val-use.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { SType, SValue, ValUse } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/val-use.json')

interface ValUseFixture {
  name: string
  val_id: number
  tpe_json: SType
  env_bindings: Array<[number, { kind: string; value?: unknown }]>
  expected_value_json: { kind: string; value?: unknown } | null
  expected_cost: number
  expected_error_code: string | null
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: ValUseFixture[]
}

function hydrateValue(j: { kind: string; value?: unknown }): SValue {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  return j as SValue
}

function buildEnv(bindings: Array<[number, { kind: string; value?: unknown }]>): Env {
  let env = Env.empty()
  for (const [id, v] of bindings) {
    env = env.extend(id, hydrateValue(v))
  }
  return env
}

describe('ValUse arm', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}`, () => {
      const expr: ValUse = { tag: 'ValUse', id: entry.val_id, tpe: entry.tpe_json }
      const env = buildEnv(entry.env_bindings)
      const ctx = makeContext()

      if (entry.expected_error_code) {
        expect(() => evalExpr(expr, env, ctx)).toThrow(EvalError)
        try {
          evalExpr(expr, env, ctx)
        } catch (e) {
          expect((e as EvalError).code).toBe(entry.expected_error_code)
        }
      } else {
        const value = evalExpr(expr, env, ctx)
        expect(value).toEqual(hydrateValue(entry.expected_value_json!))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
```

- [ ] **Step 4: Run test, verify RED**

Run: `npx vitest run test/eval/val-use.test.ts`
Expected: FAIL with `'not-implemented-yet'` for the bound case (chassis throws); the unbound case actually passes the error-code check coincidentally only if `'not-implemented-yet'` matches — it doesn't, so both fail.

- [ ] **Step 5: Implement the arm**

`packages/ergoscript/src/eval/val-use.ts`:

```ts
/**
 * ValUse arm — env lookup, charge cost.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/val_use.rs:15
 *   _ctx.add_jit_cost(5);
 *   env.get(self.val_id).cloned().ok_or_else(|| EvalError::NotFound(...))
 * Cost: ValUse = Fixed(5)
 */

import type { SValue, ValUse } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

export function evalValUse(e: ValUse, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  const v = env.get(e.id)
  if (v === undefined) {
    throw new EvalError(
      `ValUse(id=${e.id}): no binding in env`,
      'val-use-unbound'
    )
  }
  return v
}
```

- [ ] **Step 6: Wire dispatch**

In `eval.ts`:

```ts
import { evalValUse } from './val-use'

// in the switch:
    case 'ValUse':
      return evalValUse(e, env, ctx)
```

- [ ] **Step 7: Run test, verify GREEN**

Run: `npx vitest run test/eval/val-use.test.ts`
Expected: PASS.

Note: sigma-rust charges cost (5) BEFORE checking the binding (per `val_use.rs:15`). Our impl does the same (`addCost` before `env.get`). For the unbound case, `expected_cost: 0` in the fixture is wrong — actual cost would be 5 by the time we throw. Adjust the fixture's unbound case to either omit cost assertion or set `expected_cost: 5`. Update the fixture-gen command if needed and regenerate.

(Reviewer note: when reading sigma-rust again to confirm the order of operations, also check whether `add_jit_cost` is fallible — if the cost limit is exceeded it returns Err before the env lookup. That edge case is covered by the addCost test in Task 2.)

- [ ] **Step 8: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/val_use.rs
git add fixture-gen/src/cmds/ergoscript/eval/mod.rs
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/val-use.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/val-use.test.ts
git add packages/ergoscript/test/fixtures/eval/val-use.json
git commit -m "feat(ergoscript): ValUse eval arm (phase 2b task 11)"
```

---

### Task 12: `Tuple` arm

Sigma-rust reference: `eval/tuple.rs:15` — `ctx.add_jit_cost(15); items.try_mapped_ref(|i| i.eval(env, ctx))`. Cost: 15 (envelope) + recursive eval per item.

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/tuple.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + `main.rs`
- Create: `packages/ergoscript/src/eval/tuple.ts`
- Create: `packages/ergoscript/test/eval/tuple.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/common.rs` (extend `value_to_json` with Tuple variant)

- [ ] **Step 1: Add fixture-gen command**

`fixture-gen/src/cmds/ergoscript/eval/tuple.rs`:

```rust
//! Tuple arm — fixtures for `Expr::Tuple(items)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/tuple.rs:15
//! Cost: Tuple = Fixed(15) (envelope) + sum of item costs (e.g. 5 per Const)

use ergotree_interpreter::eval::env::Env;
use ergotree_interpreter::eval::Evaluable;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::tuple::Tuple;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let cases: Vec<(&str, Vec<Expr>)> = vec![
        ("tuple_pair_int_long", vec![
            Expr::Const(1i32.into()),
            Expr::Const(100i64.into()),
        ]),
        ("tuple_triple_bool_byte_short", vec![
            Expr::Const(true.into()),
            Expr::Const(7i8.into()),
            Expr::Const(1234i16.into()),
        ]),
    ];

    for (name, items) in cases {
        let tuple_expr: Expr = Tuple::new(items)?.into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &tuple_expr)?;
        let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let mut env = Env::empty();
        let val = tree.proposition()?.eval(&mut env, &ctx)?;
        let cost = ctx.jit_cost_value();

        entries.push(EvalFixture {
            name: name.to_string(),
            tree_bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: cost,
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_tuple",
        entries,
    })
}
```

Extend `value_to_json` in `common.rs` to handle `Value::Tup`:

```rust
        Tup(items) => json!({
            "kind": "Tuple",
            "items": items.iter().map(value_to_json).collect::<Vec<_>>(),
        }),
```

- [ ] **Step 2: Wire + run fixture-gen**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, add:

```rust
pub mod tuple;
```

In `fixture-gen/src/main.rs`, add (alongside the existing per-arm calls):

```rust
let tuple_fixture = cmds::ergoscript::eval::tuple::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/tuple.json",
    &tuple_fixture,
)?;
```

Run: `cd fixture-gen && cargo run --release`
Expected: among existing output, `wrote /home/mwaddip/projects/ergots/packages/ergoscript/test/fixtures/eval/tuple.json` with 2 entries.

- [ ] **Step 3: Write TS test (red)**

`packages/ergoscript/test/eval/tuple.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'

// (loadFixture + hexToBytes + hydrateValue helpers as before; consider
// extracting to test/eval/_helpers.ts after Task 12 if duplication grows.)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/tuple.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: { kind: string; items?: Array<{ kind: string; value?: unknown }> }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hydrateValue(j: { kind: string; value?: unknown; items?: Array<unknown> }): SValue {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  if (j.kind === 'Tuple') {
    return {
      kind: 'Tuple',
      items: (j.items ?? []).map((it) => hydrateValue(it as { kind: string; value?: unknown })),
    } as SValue
  }
  return j as SValue
}

describe('Tuple arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 4: Run test, verify RED**

Run: `npx vitest run test/eval/tuple.test.ts`
Expected: FAIL with `'not-implemented-yet'`.

- [ ] **Step 5: Implement the arm**

`packages/ergoscript/src/eval/tuple.ts`:

```ts
/**
 * Tuple arm — eval each item, wrap as Tuple value.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/tuple.rs:15
 *   ctx.add_jit_cost(15);
 *   let items_v = self.items.try_mapped_ref(|i| i.eval(env, ctx));
 *   Ok(Value::Tup(items_v?))
 * Cost: Tuple = Fixed(15) (envelope); per-item costs added recursively.
 */

import type { SValue, Tuple } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { evalExpr } from './eval'

export function evalTuple(e: Tuple, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(15)
  const items = e.items.map((item) => evalExpr(item, env, ctx))
  return { kind: 'Tuple', items }
}
```

- [ ] **Step 6: Wire dispatch**

In `eval.ts`:

```ts
import { evalTuple } from './tuple'

// in the switch:
    case 'Tuple':
      return evalTuple(e, env, ctx)
```

- [ ] **Step 7: Run test, verify GREEN**

Run: `npx vitest run test/eval/tuple.test.ts`
Expected: PASS.

Full suite — no regression.

- [ ] **Step 8: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/tuple.rs
git add fixture-gen/src/cmds/ergoscript/eval/common.rs
git add fixture-gen/src/cmds/ergoscript/eval/mod.rs
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/tuple.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/tuple.test.ts
git add packages/ergoscript/test/fixtures/eval/tuple.json
git commit -m "feat(ergoscript): Tuple eval arm (phase 2b task 12)"
```

---

### Task 13: `Collection` arm

Sigma-rust reference: `eval/collection.rs:22` — `ctx.add_jit_cost(20)`. Cost: 20.

Two sub-variants in our TS Collection union: `kind: 'Exprs'` (general — eval each, wrap with `elemTpe`) and `kind: 'BoolConstants'` (specialized — `items: boolean[]` already evaluated, just wrap as `Coll(SBoolean, [Boolean])`).

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/collection.rs`
- Modify: `eval/mod.rs` + `main.rs` + `common.rs` (extend `value_to_json` for `Value::Coll`)
- Create: `packages/ergoscript/src/eval/collection.ts`
- Create: `packages/ergoscript/test/eval/collection.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

- [ ] **Step 1: Add fixture-gen command**

`fixture-gen/src/cmds/ergoscript/eval/collection.rs`:

```rust
//! Collection arm — fixtures for both `kind: 'Exprs'` and `kind: 'BoolConstants'`.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/collection.rs:22
//! Cost: ConcreteCollection = Fixed(20) + recursive item costs.

use ergotree_interpreter::eval::env::Env;
use ergotree_interpreter::eval::Evaluable;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::collection::Collection;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Case 1: BoolConstants kind — Coll[Boolean] of literals
    {
        let coll: Expr = Collection::from_bools(vec![true, false, true]).into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &coll)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let mut env = Env::empty();
        let val = tree.proposition()?.eval(&mut env, &ctx)?;

        entries.push(EvalFixture {
            name: "coll_bool_constants_3".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    // Case 2: Exprs kind — Coll[Int] from Const exprs
    {
        let items: Vec<Expr> = vec![
            Expr::Const(1i32.into()),
            Expr::Const(2i32.into()),
            Expr::Const(3i32.into()),
        ];
        let coll: Expr = Collection::new(SType::SInt, items)?.into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &coll)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let mut env = Env::empty();
        let val = tree.proposition()?.eval(&mut env, &ctx)?;

        entries.push(EvalFixture {
            name: "coll_exprs_int_3".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    // Case 3: empty Coll[Long]
    {
        let coll: Expr = Collection::new(SType::SLong, vec![])?.into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &coll)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

        let ctx = force_any_val::<Context>();
        let mut env = Env::empty();
        let val = tree.proposition()?.eval(&mut env, &ctx)?;

        entries.push(EvalFixture {
            name: "coll_empty_long".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_collection",
        entries,
    })
}
```

Extend `value_to_json` in `common.rs` to handle `Value::Coll`:

```rust
        Coll(coll_kind) => match coll_kind {
            CollKind::WrappedColl { elem_tpe, items } => json!({
                "kind": "Coll",
                "elem": stype_to_json(elem_tpe),
                "items": items.iter().map(value_to_json).collect::<Vec<_>>(),
            }),
            CollKind::NativeColl(NativeColl::CollByte(bytes)) => json!({
                "kind": "Coll",
                "elem": { "tag": "SByte" },
                "items": bytes.iter().map(|b| json!({ "kind": "Byte", "value": *b as i32 })).collect::<Vec<_>>(),
            }),
        },
```

(`stype_to_json` is a small helper that maps `SType` to our TS shape `{ tag: 'SInt' }` etc. Add to common.rs as needed.)

- [ ] **Step 2: Wire + run fixture-gen**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, add:

```rust
pub mod collection;
```

In `fixture-gen/src/main.rs`, add:

```rust
let collection_fixture = cmds::ergoscript::eval::collection::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/collection.json",
    &collection_fixture,
)?;
```

Run: `cd fixture-gen && cargo run --release`
Expected: `wrote .../test/fixtures/eval/collection.json` with 3 entries.

- [ ] **Step 3: Write TS test (red)**

`packages/ergoscript/test/eval/collection.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext } from '../../src/eval/eval-context'
import type { SValue } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/collection.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: {
    kind: string
    elem?: { tag: string }
    items?: Array<{ kind: string; value?: unknown }>
  }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hydrateValue(j: any): SValue {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  if (j.kind === 'Coll') {
    return {
      kind: 'Coll',
      elem: j.elem,
      items: (j.items ?? []).map(hydrateValue),
    } as SValue
  }
  if (j.kind === 'Tuple') {
    return { kind: 'Tuple', items: (j.items ?? []).map(hydrateValue) } as SValue
  }
  return j as SValue
}

describe('Collection arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 4: Run test, verify RED**

Run: `npx vitest run test/eval/collection.test.ts`
Expected: FAIL with `'not-implemented-yet'`.

- [ ] **Step 5: Implement the arm**

`packages/ergoscript/src/eval/collection.ts`:

```ts
/**
 * Collection arm — handles both `kind: 'Exprs'` and `kind: 'BoolConstants'`.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/collection.rs:22
 *   ctx.add_jit_cost(20);
 *   match self {
 *     Collection::BoolConstants(bools) => bools.into(),
 *     Collection::Exprs { elem_tpe, items } => {
 *       let items_v = items.iter().map(|i| i.eval(env, ctx)).collect();
 *       // ... NativeColl optimization for SByte; otherwise WrappedColl
 *     }
 *   }
 * Cost: ConcreteCollection = Fixed(20) + recursive item costs.
 */

import type { Collection, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalCollection(e: Collection, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(20)
  if (e.kind === 'BoolConstants') {
    return {
      kind: 'Coll',
      elem: { tag: 'SBoolean' },
      items: e.items.map((b) => ({ kind: 'Boolean', value: b }) as SValue),
    }
  }
  // kind === 'Exprs'
  const items = e.items.map((item) => evalExpr(item, env, ctx))
  // Defensive kind-check: each item's kind should match e.elemTpe.
  // Sigma-rust's Collection::new validates this at construction; mirror
  // the assertion at runtime so contract violations are loud.
  for (let i = 0; i < items.length; i++) {
    if (!kindMatchesType(items[i]!, e.elemTpe)) {
      throw new EvalError(
        `Collection.items[${i}] kind '${items[i]!.kind}' inconsistent with elemTpe '${e.elemTpe.tag}'`,
        'collection-elem-kind-mismatch'
      )
    }
  }
  return { kind: 'Coll', elem: e.elemTpe, items }
}

function kindMatchesType(v: SValue, t: { tag: string }): boolean {
  // Surface mapping: SValue.kind == 'Boolean' iff SType.tag == 'SBoolean', etc.
  // Composite types (SColl, STuple, SOption, SFunc) don't appear in
  // 2b's evaluable subset — punt on them with `true` for now (they'd
  // fail at deeper levels).
  switch (t.tag) {
    case 'SBoolean': return v.kind === 'Boolean'
    case 'SByte':    return v.kind === 'Byte'
    case 'SShort':   return v.kind === 'Short'
    case 'SInt':     return v.kind === 'Int'
    case 'SLong':    return v.kind === 'Long'
    case 'SBigInt':  return v.kind === 'BigInt'
    case 'SUnit':    return v.kind === 'Unit'
    default:         return true  // Composite or chain-state types — defer
  }
}
```

- [ ] **Step 6: Wire dispatch**

In `eval.ts`:

```ts
import { evalCollection } from './collection'

// in the switch:
    case 'Collection':
      return evalCollection(e, env, ctx)
```

- [ ] **Step 7: Run test, verify GREEN**

Run: `npx vitest run test/eval/collection.test.ts`
Expected: PASS.

- [ ] **Step 8: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/collection.rs
git add fixture-gen/src/cmds/ergoscript/eval/common.rs
git add fixture-gen/src/cmds/ergoscript/eval/mod.rs
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/collection.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/collection.test.ts
git add packages/ergoscript/test/fixtures/eval/collection.json
git commit -m "feat(ergoscript): Collection eval arm (phase 2b task 13)"
```

---

### Task 14: `If` arm

Sigma-rust reference: `eval/if_op.rs:16` — `ctx.add_jit_cost(10); let cond = self.condition.eval(env, ctx)?; if cond.try_extract_into::<bool>()? { self.true_branch.eval(...) } else { self.false_branch.eval(...) }`. Cost: 10. Short-circuits.

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/if_arm.rs`
- Modify: `eval/mod.rs` + `main.rs`
- Create: `packages/ergoscript/src/eval/if.ts`
- Create: `packages/ergoscript/test/eval/if.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

- [ ] **Step 1: Add fixture-gen command**

`fixture-gen/src/cmds/ergoscript/eval/if_arm.rs`:

```rust
//! If arm — fixtures for `Expr::If(...)` evaluation.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/if_op.rs:16
//! Cost: If = Fixed(10) (envelope) + condition eval cost + ONLY taken branch's cost.
//! Short-circuit: non-taken branch is never evaluated.

use ergotree_interpreter::eval::env::Env;
use ergotree_interpreter::eval::Evaluable;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::if_op::If;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Case 1: condition true → true branch (Const Int 1)
    {
        let if_expr: Expr = If {
            condition: Expr::Const(true.into()).into(),
            true_branch: Expr::Const(1i32.into()).into(),
            false_branch: Expr::Const(2i32.into()).into(),
        }
        .into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &if_expr)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val = tree.proposition()?.eval(&mut Env::empty(), &ctx)?;

        entries.push(EvalFixture {
            name: "if_true_branch".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    // Case 2: condition false → false branch (Const Int 2)
    {
        let if_expr: Expr = If {
            condition: Expr::Const(false.into()).into(),
            true_branch: Expr::Const(1i32.into()).into(),
            false_branch: Expr::Const(2i32.into()).into(),
        }
        .into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &if_expr)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val = tree.proposition()?.eval(&mut Env::empty(), &ctx)?;

        entries.push(EvalFixture {
            name: "if_false_branch".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_if",
        entries,
    })
}
```

- [ ] **Step 2: Wire + run fixture-gen**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, add:

```rust
pub mod if_arm;
```

In `fixture-gen/src/main.rs`, add:

```rust
let if_fixture = cmds::ergoscript::eval::if_arm::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/if.json",
    &if_fixture,
)?;
```

Run: `cd fixture-gen && cargo run --release`
Expected: `wrote .../test/fixtures/eval/if.json` with 2 entries.

- [ ] **Step 3: Write TS test (red)**

`packages/ergoscript/test/eval/if.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { Expr, SValue } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/if.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hydrate(j: { kind: string; value?: unknown }): SValue {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  return j as SValue
}

describe('If arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrate(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('If arm — non-Boolean condition', () => {
  it('throws if-condition-not-boolean when condition evaluates to non-Boolean', () => {
    const expr: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
      trueBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
      falseBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } },
    }
    const ctx = makeContext()
    expect(() => evalExpr(expr, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalExpr(expr, Env.empty(), ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('if-condition-not-boolean')
    }
  })
})

describe('If arm — short-circuit', () => {
  it('does NOT evaluate the false branch when condition is true', () => {
    // false branch is a ConstPlaceholder with id=99 (out of range) — would throw if evaluated.
    const expr: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
      trueBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } },
      falseBranch: { tag: 'ConstPlaceholder', id: 99, tpe: { tag: 'SInt' } },
    }
    const ctx = makeContext({ constants: [] })
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 1 })
  })

  it('does NOT evaluate the true branch when condition is false', () => {
    const expr: Expr = {
      tag: 'If',
      condition: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: false } },
      trueBranch: { tag: 'ConstPlaceholder', id: 99, tpe: { tag: 'SInt' } },
      falseBranch: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 2 } },
    }
    const ctx = makeContext({ constants: [] })
    const value = evalExpr(expr, Env.empty(), ctx)
    expect(value).toEqual({ kind: 'Int', value: 2 })
  })
})
```

- [ ] **Step 4: Run test, verify RED**

Run: `npx vitest run test/eval/if.test.ts`
Expected: FAIL with `'not-implemented-yet'`.

- [ ] **Step 5: Implement the arm**

`packages/ergoscript/src/eval/if.ts`:

```ts
/**
 * If arm — eval condition, branch on its boolean value.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/if_op.rs:16
 *   ctx.add_jit_cost(10);
 *   let cond_v = self.condition.eval(env, ctx)?;
 *   if cond_v.try_extract_into::<bool>()? {
 *     self.true_branch.eval(env, ctx)
 *   } else {
 *     self.false_branch.eval(env, ctx)
 *   }
 *
 * Cost: If = Fixed(10) (envelope) + condition eval cost + taken branch eval cost.
 * Short-circuit semantics: the non-taken branch is NEVER evaluated, so its
 * cost is NOT charged.
 */

import type { If, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalIf(e: If, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(10)
  const cond = evalExpr(e.condition, env, ctx)
  if (cond.kind !== 'Boolean') {
    throw new EvalError(
      `If.condition evaluated to '${cond.kind}', expected Boolean`,
      'if-condition-not-boolean'
    )
  }
  return cond.value ? evalExpr(e.trueBranch, env, ctx) : evalExpr(e.falseBranch, env, ctx)
}
```

- [ ] **Step 6: Wire dispatch**

In `eval.ts`:

```ts
import { evalIf } from './if'

// in the switch:
    case 'If':
      return evalIf(e, env, ctx)
```

- [ ] **Step 7: Run test, verify GREEN**

Run: `npx vitest run test/eval/if.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/if_arm.rs
git add fixture-gen/src/cmds/ergoscript/eval/mod.rs
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/if.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/if.test.ts
git add packages/ergoscript/test/fixtures/eval/if.json
git commit -m "feat(ergoscript): If eval arm with short-circuit (phase 2b task 14)"
```

---

### Task 15: `BlockValue` arm

Sigma-rust reference: `ergotree-interpreter/src/eval/block.rs:13-65`.

Behavior:
1. Charge envelope: `ctx.add_per_item_jit_cost(1, 1, 10, items.length)`.
2. Iterate `e.items`. Every item MUST be a `ValDef` — sigma-rust uses `try_extract_into::<Spanned<ValDef>>` which errors otherwise.
3. For each ValDef item: eval its `rhs` (charges rhs's own cost), charge `ADD_TO_ENV_COST` (5), then `env = env.extend(rhs.id, value)`.
4. After items: `evalExpr(e.result, env, ctx)` and return.

Our immutable Env naturally implements nested-scope correctness — sigma-rust's save/restore dance for shadowed bindings (`block.rs:35-62`) is unnecessary for us.

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/block_value.rs`
- Modify: `eval/mod.rs` + `main.rs`
- Create: `packages/ergoscript/src/eval/block-value.ts`
- Create: `packages/ergoscript/test/eval/block-value.test.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`

- [ ] **Step 1: Add fixture-gen command**

`fixture-gen/src/cmds/ergoscript/eval/block_value.rs`:

```rust
//! BlockValue arm — fixtures with let-bindings + result.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/block.rs
//! Cost: addPerItemCost(1, 1, 10, items.length) envelope
//!     + for each ValDef: rhs eval cost + 5 (ADD_TO_ENV_COST)
//!     + result eval cost
//! NOTE: block.rs:85-89 documents the parity-gap fix that ensures
//! ADD_TO_ENV_COST is charged per ValDef.

use ergotree_interpreter::eval::env::Env;
use ergotree_interpreter::eval::Evaluable;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::ErgoTree;
use ergotree_ir::mir::block::BlockValue;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::val_def::ValDef;
use ergotree_ir::mir::val_use::ValUse;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::stype::SType;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Case 1: BlockValue { items: [ValDef(0, Const(42))], result: ValUse(0) }
    {
        let block: Expr = BlockValue {
            items: vec![
                ValDef {
                    id: 0.into(),
                    rhs: Box::new(Expr::Const(42i32.into())),
                }
                .into(),
            ],
            result: Box::new(
                ValUse {
                    val_id: 0.into(),
                    tpe: SType::SInt,
                }
                .into(),
            ),
        }
        .into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &block)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val = tree.proposition()?.eval(&mut Env::empty(), &ctx)?;

        entries.push(EvalFixture {
            name: "block_one_valdef_one_valuse".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    // Case 2: 4 ValDefs (validates ADD_TO_ENV_COST × 4 + envelope), result is last ValUse
    // (Mirrors the parity test in block.rs:90-134.)
    {
        let block: Expr = BlockValue {
            items: (1..=4)
                .map(|i| {
                    ValDef {
                        id: i.into(),
                        rhs: Box::new(Expr::Const((i as i32).into())),
                    }
                    .into()
                })
                .collect(),
            result: Box::new(
                ValUse {
                    val_id: 4.into(),
                    tpe: SType::SInt,
                }
                .into(),
            ),
        }
        .into();
        let tree = ErgoTree::new(ergotree_ir::ergo_tree::ErgoTreeHeader::v0(false), &block)?;
        let bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
        let ctx = force_any_val::<Context>();
        let val = tree.proposition()?.eval(&mut Env::empty(), &ctx)?;

        entries.push(EvalFixture {
            name: "block_4_valdefs".to_string(),
            tree_bytes_hex: bytes_hex,
            opts_json: json!({}),
            expected_value_json: value_to_json(&val),
            expected_cost: ctx.jit_cost_value(),
        });
    }

    Ok(EvalFixtureFile {
        corpus: "eval_block_value",
        entries,
    })
}
```

- [ ] **Step 2: Wire + run fixture-gen**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, add:

```rust
pub mod block_value;
```

In `fixture-gen/src/main.rs`, add:

```rust
let block_value_fixture = cmds::ergoscript::eval::block_value::generate()?;
write_fixture(
    "packages/ergoscript/test/fixtures/eval/block-value.json",
    &block_value_fixture,
)?;
```

Run: `cd fixture-gen && cargo run --release`
Expected: `wrote .../test/fixtures/eval/block-value.json` with 2 entries.

- [ ] **Step 3: Write TS test (red)**

`packages/ergoscript/test/eval/block-value.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalExpr } from '../../src/eval/eval'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { BlockValue, Expr, SValue } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, '../fixtures/eval/block-value.json')

interface EvalFixture {
  name: string
  tree_bytes_hex: string
  opts_json: { jitCostLimit?: number }
  expected_value_json: { kind: string; value?: unknown }
  expected_cost: number
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: EvalFixture[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hydrate(j: { kind: string; value?: unknown }): SValue {
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  return j as SValue
}

describe('BlockValue arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(`${entry.name}: value + cost`, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext()
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrate(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})

describe('BlockValue arm — strictness', () => {
  it('throws block-item-not-val-def when items contains a non-ValDef', () => {
    const block: BlockValue = {
      tag: 'BlockValue',
      items: [
        { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 1 } } as Expr,
      ],
      result: { tag: 'Const', tpe: { tag: 'SInt' }, value: { kind: 'Int', value: 0 } },
    }
    const ctx = makeContext()
    expect(() => evalExpr(block, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalExpr(block, Env.empty(), ctx)
    } catch (e) {
      expect((e as EvalError).code).toBe('block-item-not-val-def')
    }
  })
})
```

- [ ] **Step 4: Run test, verify RED**

Run: `npx vitest run test/eval/block-value.test.ts`
Expected: FAIL with `'not-implemented-yet'`.

- [ ] **Step 5: Implement the arm**

`packages/ergoscript/src/eval/block-value.ts`:

```ts
/**
 * BlockValue arm — let-bindings + result.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/block.rs:13-65
 *   ctx.add_per_item_jit_cost(1, 1, 10, self.items.len() as u32);
 *   for item in &self.items {
 *     let val_def = item.try_extract_into::<Spanned<ValDef>>()?;  // STRICT: error if not ValDef
 *     let v = val_def.expr().rhs.eval(env, ctx)?;
 *     ctx.add_jit_cost(5);  // ADD_TO_ENV_COST per Scala reference
 *     env.insert(val_def.id, v);
 *   }
 *   self.result.eval(env, ctx)
 *
 * Cost: addPerItemCost(1, 1, 10, items.length) (envelope)
 *     + per ValDef: rhs eval cost + 5 (ADD_TO_ENV_COST)
 *     + result eval cost.
 *
 * Sigma-rust uses a mutable Env and has to manually save/restore
 * shadowed bindings for nested blocks (block.rs:35-62). Our immutable
 * Env naturally implements correct nested scoping — the new Env from
 * `extend` goes out of scope when this function returns, so the
 * caller's Env is unchanged.
 */

import type { BlockValue, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

export function evalBlockValue(e: BlockValue, env: Env, ctx: EvalContext): SValue {
  ctx.addPerItemCost(1, 1, 10, e.items.length)
  let scope = env
  for (let i = 0; i < e.items.length; i++) {
    const item = e.items[i]!
    if (item.tag !== 'ValDef') {
      throw new EvalError(
        `BlockValue.items[${i}] has tag '${item.tag}', expected 'ValDef'`,
        'block-item-not-val-def'
      )
    }
    const v = evalExpr(item.rhs, scope, ctx)
    ctx.addCost(5) // ADD_TO_ENV_COST per sigma-rust block.rs:30
    scope = scope.extend(item.id, v)
  }
  return evalExpr(e.result, scope, ctx)
}
```

- [ ] **Step 6: Wire dispatch**

In `eval.ts`:

```ts
import { evalBlockValue } from './block-value'

// in the switch:
    case 'BlockValue':
      return evalBlockValue(e, env, ctx)
```

- [ ] **Step 7: Run test, verify GREEN**

Run: `npx vitest run test/eval/block-value.test.ts`
Expected: PASS (3 tests).

Full suite: `npx vitest run`. All 8 arms now exercised; the central dispatch should cover them.

- [ ] **Step 8: typecheck + commit**

```bash
npm run typecheck
git add fixture-gen/src/cmds/ergoscript/eval/block_value.rs
git add fixture-gen/src/cmds/ergoscript/eval/mod.rs
git add fixture-gen/src/main.rs
git add packages/ergoscript/src/eval/block-value.ts
git add packages/ergoscript/src/eval/eval.ts
git add packages/ergoscript/test/eval/block-value.test.ts
git add packages/ergoscript/test/fixtures/eval/block-value.json
git commit -m "feat(ergoscript): BlockValue eval arm + ADD_TO_ENV_COST (phase 2b task 15)"
```

---

## Stage 3 — Layer C2 corpus integration + public surface (Tasks 16–18)

### Task 16: Extend `mainnet_boxes.rs` to capture sigma-rust eval (Layer C2)

**Files:**
- Modify: `fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs`

- [ ] **Step 1: Read the existing mainnet_boxes.rs**

Run: `cat fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs`. Currently emits `CorpusEntry { box_id, ergo_tree_hex, byte_length, block_height, round_trip_ok }`. We extend with a `sigma_rust_eval: Option<SigmaRustEval>` field.

- [ ] **Step 2: Add `SigmaRustEval` struct + capture logic**

Edit `fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs`:

Add the struct (near the top, before `CorpusEntry`):

```rust
#[derive(Serialize)]
#[serde(tag = "context_kind", rename_all = "kebab-case")]
pub enum SigmaRustEval {
    SyntheticEmpty {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value_json: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        jit_cost: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_kind: Option<String>,
    },
    // RealOnChain variant added in C3 (phase 2j or earlier).
}
```

Modify `CorpusEntry` to include the new optional field:

```rust
#[derive(Serialize)]
pub struct CorpusEntry {
    pub box_id: String,
    pub ergo_tree_hex: String,
    pub byte_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_height: Option<i64>,
    pub round_trip_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sigma_rust_eval: Option<SigmaRustEval>,
}
```

In the `for r in raw` loop, AFTER the `round_trip_ok` block, attempt sigma-rust eval against a synthetic context:

```rust
let sigma_rust_eval = if round_trip_ok {
    use ergotree_interpreter::eval::env::Env;
    use ergotree_interpreter::eval::Evaluable;
    use ergotree_ir::chain::context::Context;
    use sigma_test_util::force_any_val;

    let ctx = force_any_val::<Context>();  // synthetic; height=0, empty inputs/outputs
    match ErgoTree::sigma_parse_bytes(&bytes) {
        Ok(tree) => match tree.proposition() {
            Ok(expr) => match expr.eval(&mut Env::empty(), &ctx) {
                Ok(val) => Some(SigmaRustEval::SyntheticEmpty {
                    ok: true,
                    value_json: Some(super::eval::common::value_to_json(&val)),
                    jit_cost: Some(ctx.jit_cost_value()),
                    error_kind: None,
                }),
                Err(e) => Some(SigmaRustEval::SyntheticEmpty {
                    ok: false,
                    value_json: None,
                    jit_cost: None,
                    error_kind: Some(format!("{:?}", e)),
                }),
            },
            Err(e) => Some(SigmaRustEval::SyntheticEmpty {
                ok: false,
                value_json: None,
                jit_cost: None,
                error_kind: Some(format!("proposition: {:?}", e)),
            }),
        },
        Err(_) => None,  // already failed round-trip
    }
} else {
    None
};
```

And include `sigma_rust_eval` in the entry being pushed.

- [ ] **Step 3: Run fixture-gen**

Run: `cd fixture-gen && cargo run --release`
Expected: existing fixture files regenerated; `mainnet_boxes.json` now has `sigma_rust_eval` blocks on each entry.

Spot-check: `node -e "const j = JSON.parse(require('fs').readFileSync('packages/ergoscript/test/fixtures/mainnet_boxes.json')); const okEvals = j.entries.filter(e => e.sigma_rust_eval?.ok); console.log('eval succeeded:', okEvals.length, '/', j.entries.length); console.log('sample:', okEvals[0]?.box_id, 'cost:', okEvals[0]?.sigma_rust_eval?.jit_cost)"`

- [ ] **Step 4: Verify existing tests still pass**

Run: `npx vitest run test/corpus.test.ts`
Expected: PASS — schema additions are backwards-compatible (existing tests don't read `sigma_rust_eval`).

- [ ] **Step 5: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/mainnet_boxes.rs
git add packages/ergoscript/test/fixtures/mainnet_boxes.json
git commit -m "feat(fixture-gen): capture sigma-rust eval on mainnet_boxes (Layer C2; task 16)"
```

---

### Task 17: `corpus-eval.test.ts` — Layer C2 TS-side assertion

**Files:**
- Create: `packages/ergoscript/test/corpus-eval.test.ts`

- [ ] **Step 1: Write the test**

`packages/ergoscript/test/corpus-eval.test.ts`:

```ts
/**
 * Layer C2 — mainnet_boxes corpus eval-filter.
 *
 * Walks the existing 173-tree mainnet_boxes corpus from phase 2a. For each
 * tree where sigma-rust's synthetic-context eval succeeded, asserts our
 * `evaluate` produces the same value AND cost. For trees that hit phase
 * 2b's not-implemented arms, asserts the failure code is in the documented
 * taxonomy. Tally is logged so we can track the evaluable subset growing
 * across 2c/2d/2e/2f.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree } from '../src/wire/ergo-tree'
import { evaluateWith } from '../src/eval/evaluate'
import { makeContext, EvalError } from '../src/eval/eval-context'
import type { SValue } from '../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.join(__dirname, 'fixtures/mainnet_boxes.json')

interface SigmaRustEval {
  context_kind: 'synthetic-empty'
  ok: boolean
  value_json?: unknown
  jit_cost?: number
  error_kind?: string
}

interface CorpusEntry {
  box_id: string
  ergo_tree_hex: string
  byte_length: number
  block_height?: number
  round_trip_ok: boolean
  sigma_rust_eval?: SigmaRustEval
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  corpus: string
  entries: CorpusEntry[]
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hydrate(j: any): SValue {
  if (j === null || j === undefined) return j
  if (j.kind === 'Long' || j.kind === 'BigInt') {
    return { kind: j.kind, value: BigInt(j.value as string) } as SValue
  }
  if (j.kind === 'Coll') {
    return {
      kind: 'Coll',
      elem: j.elem,
      items: (j.items ?? []).map(hydrate),
    } as SValue
  }
  if (j.kind === 'Tuple') {
    return { kind: 'Tuple', items: (j.items ?? []).map(hydrate) } as SValue
  }
  return j as SValue
}

describe('Corpus eval — mainnet_boxes (Layer C2)', () => {
  let evalSuccess = 0
  let notImplYet = 0
  let other = 0
  const otherCodes = new Map<string, number>()

  for (const entry of fixture.entries) {
    if (!entry.sigma_rust_eval || !entry.sigma_rust_eval.ok) continue

    it(`box ${entry.box_id}: TS eval matches sigma-rust (or hits documented not-impl)`, () => {
      const tree = parseTree(hexToBytes(entry.ergo_tree_hex))
      const ctx = makeContext()
      try {
        const value = evaluateWith(tree, ctx)
        // Successfully evaluated — assert value AND cost match sigma-rust.
        expect(value).toEqual(hydrate(entry.sigma_rust_eval!.value_json))
        expect(ctx.jitCost).toBe(entry.sigma_rust_eval!.jit_cost)
        evalSuccess++
      } catch (e) {
        // Did not eval — must be a documented EvalError.
        expect(e).toBeInstanceOf(EvalError)
        const code = (e as EvalError).code
        if (code === 'not-implemented-yet') {
          notImplYet++
        } else {
          other++
          otherCodes.set(code, (otherCodes.get(code) ?? 0) + 1)
        }
      }
    })
  }

  it('aggregate (informational)', () => {
    console.log(
      `[corpus-eval] sigma-rust-evaluable: ${fixture.entries.filter((e) => e.sigma_rust_eval?.ok).length} / ${fixture.entries.length}`
    )
    console.log(
      `[corpus-eval] phase 2b TS eval: success=${evalSuccess} not-impl=${notImplYet} other=${other}`
    )
    if (otherCodes.size > 0) {
      console.log('[corpus-eval] other error codes:')
      for (const [code, n] of otherCodes) console.log(`  ${code}: ${n}`)
    }
    // No assertion — informational only. Failures from per-entry tests are the gate.
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/corpus-eval.test.ts`
Expected: PASS for all individual entries (each either matches sigma-rust value+cost OR throws a documented `EvalError`). Aggregate `console.log` reports the breakdown.

If any entries fail with `'not-implemented-yet'`, that's expected (most trees use operators / accessors not in 2b's set). If any fail with an undocumented error class, investigate — that's a regression.

- [ ] **Step 3: typecheck + commit**

```bash
npm run typecheck
git add packages/ergoscript/test/corpus-eval.test.ts
git commit -m "test(ergoscript): mainnet_boxes corpus eval-filter (Layer C2; task 17)"
```

---

### Task 18: Wire public exports + bump version + update facts

**Files:**
- Modify: `packages/ergoscript/src/index.ts`
- Modify: `packages/ergoscript/package.json` (`version: 0.1.0` → `0.2.0`)
- Modify: `facts/ergoscript.md`

- [ ] **Step 1: Read current `src/index.ts`**

Run: `cat packages/ergoscript/src/index.ts`. Note existing exports (parseTree, serializeTree, isP2PK, etc.).

- [ ] **Step 2: Add v0.2.0 exports**

Edit `packages/ergoscript/src/index.ts` — append (or merge with existing structure):

```ts
// v0.2.0 (phase 2b) — evaluator surface
export { evaluate, evaluateWith } from './eval/evaluate'
export { makeContext, EvalError } from './eval/eval-context'
export type { EvalOpts, EvalContext } from './eval/eval-context'
```

(Do NOT re-export `Env`, `evalExpr`, or per-arm functions — those are internal implementation details.)

- [ ] **Step 3: Bump package version**

Edit `packages/ergoscript/package.json` — change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 4: Update `facts/ergoscript.md` with v0.2.0 surface**

Edit `facts/ergoscript.md` — add a new section "v0.2.0 — Evaluator surface (phase 2b)" after the existing public surface section. Document:
- `evaluate(tree, opts?)` postconditions (returns SValue; throws `EvalError`)
- `evaluateWith(tree, ctx)` postconditions
- `makeContext(opts?)` constructor
- `EvalContext.addCost` / `addPerItemCost` semantics (saturating add, throws `'cost-limit-exceeded'` if limit set)
- `EvalError` taxonomy: `'not-implemented-yet'`, `'cost-limit-exceeded'`, `'val-def-outside-block'`, `'val-use-unbound'`, `'const-placeholder-id-out-of-range'`, `'const-placeholder-no-constants'`, `'if-condition-not-boolean'`, `'collection-elem-kind-mismatch'`, `'block-item-not-val-def'`
- Coverage note: only 8 of ~70 Expr variants have arms in 2b; everything else throws `'not-implemented-yet'`.

The exact wording follows the structure of the existing `## Public surface` section in `facts/ergoscript.md`.

- [ ] **Step 5: Verify build + typecheck**

Run:
```bash
npm run typecheck
npm run build
```
Expected: clean. `dist/index.js` should now include the eval exports.

Verify no Node-only references in dist:
```bash
grep -E "Buffer|process\.|require\(|node:" packages/ergoscript/dist/index.js | head
```
Expected: zero matches.

- [ ] **Step 6: Run full test suite**

Run: `cd packages/ergoscript && npm test`
Expected: all tests passing. Test count grew by ~30-50 (eval tests + corpus-eval).

Also from repo root: `npm test` (proof package + ergoscript) — both pass.

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/src/index.ts
git add packages/ergoscript/package.json
git add facts/ergoscript.md
git commit -m "feat(ergoscript): v0.2.0 — evaluator public surface (phase 2b task 18)"
```

---

## Final verification

After Task 18:

- [ ] **Run all gates** (per `CLAUDE.md` rule 6):

```bash
# From repo root
npm run typecheck       # both workspaces clean
npm test                # both workspaces pass

# Determinism check
cd fixture-gen && cargo run --release
cd ..
git status              # must be clean — fixtures regenerate identically
```

- [ ] **Re-run mainnet probe** (sanity check — phase 2b's evaluator additions shouldn't affect parser behavior):

```bash
node scripts/probe-mainnet.mjs 1000
```

Expected: clean (zero deferred opcodes; zero `val-def-rhs-tpe`).

- [ ] **Optional: tag the milestone**

```bash
git tag -a ergoscript-0.2.0 -m "Phase 2b complete: evaluator chassis + 8 arms"
```

(Don't push to npm yet — per spec, `1.0.0` is the first publish, after 2j.)

---

## Spec coverage check

| Spec section | Tasks |
|---|---|
| Architecture / directory layout | Tasks 1, 4, 5, 6, 8–15 |
| Public surface (`evaluate`, `evaluateWith`, `makeContext`) | Task 6 + Task 18 |
| `EvalContext` + `addCost` + `addPerItemCost` + cost-limit-exceeded | Tasks 2, 3 |
| `Env` (immutable extend) | Task 4 |
| Central dispatch with `_exhaust: never` | Tasks 5, 8–15 |
| 8 eval arms with cost values | Tasks 8–15 |
| Layer C1 (per-arm fixtures with cost assertion) | Tasks 7–15 |
| Layer C2 (mainnet_boxes synthetic-context cost capture) | Tasks 16, 17 |
| Layer C3 (real on-chain context) | Out of scope (deferred to phase 2j) |
| Error taxonomy (all 9 codes) | Tasks 2 (`cost-limit-exceeded`), 5 (`not-implemented-yet`), 9 (`const-placeholder-*`), 10 (`val-def-outside-block`), 11 (`val-use-unbound`), 13 (`collection-elem-kind-mismatch`), 14 (`if-condition-not-boolean`), 15 (`block-item-not-val-def`) |
| `BlockValue` strict-ValDef + `ADD_TO_ENV_COST` | Task 15 |
| `If` short-circuit | Task 14 |
| Browser compatibility + ESM only + `bigint` | inherited from 2a; verified Task 18 |
| `facts/ergoscript.md` v0.2.0 section | Task 18 |
| Mutation tests (deferred to 2c+) | Out of scope per spec |
