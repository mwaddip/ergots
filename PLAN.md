# Phase 2g.6 — Broader Method-Call Surface: Implementation Plan

**Status: ✅ COMPLETE 2026-05-18** (5 method handlers + Global Expr arm + 2 SValue variants shipped; wider-corpus re-survey confirms 5 methods now `implemented: true`; full test suite green under node + jsdom (2658 tests); fixture-gen determinism preserved — `force_any_val` replaced with `TestRunner::deterministic()` in scontext_pre_header + spreheader_timestamp fixtures.)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 5 method handlers locked by Task B's wider-mainnet corpus survey (`SGlobal.groupGenerator`, `SColl.zip`, `SColl.indices`, `SContext.preHeader`, `SPreHeader.timestamp`), extending the 2g.5 `HANDLERS` registry in `eval/method-call.ts`, plus 1 new `Expr` arm (`Global`) and 2 new `SValue` variants (`{ kind: 'Global' }` sentinel, `{ kind: 'PreHeader'; value: PreHeader }` value carrier).

**Architecture:** Extends 2g.5's `(typeId, methodId)` → handler registry by 5 entries. Adds `eval/global.ts` for the new `Expr::Global` evaluator arm (wire-parsed since phase 2a; 120 boxes use it per survey). Adds 2 SValue discriminated-union variants to `mir/types.ts`. No new files in `src/` beyond `eval/global.ts`; all 5 handlers live inline in `eval/method-call.ts` (handler #3-8 of the existing 3 → 8 growth). Cost values, return shapes, and obj-shape checks are all source-locked from sigma-rust HEAD per the design spec.

**Tech Stack:** TypeScript 5.x (vitest 2 under both node + jsdom); Rust 1.x (fixture-gen using sigma-rust's `try_eval_out` oracle gated behind the `arbitrary` feature); `@noble/hashes@2.2.0` (already pinned); existing `GROUP_GENERATOR_BYTES` constant from `eval/_group-generator.ts` (no `@noble/curves` round-trip needed for groupGenerator).

**Reference oracles:**
- Design spec: `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` (the authoritative source for this plan)
- Immediate predecessor: `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` (dispatcher pattern this slice extends)
- Survey data: `docs/specs/2026-05-18-task-b-corpus-survey-results.md` (the data locking the 5-method scope)
- Sigma-rust eval handlers (source of all cost values + return shapes):
  - `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs:37-40` — `Expr::Global` arm
  - `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sglobal.rs:32-41` — `GROUP_GENERATOR_EVAL_FN`
  - `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:138-169` — `ZIP_EVAL_FN`
  - `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:171-193` — `INDICES_EVAL_FN`
  - `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scontext.rs:72-81` — `PRE_HEADER_EVAL_FN`
  - `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/spreheader.rs:20-24` — `TIMESTAMP_EVAL_FN`
- Existing 2g.5 reference: `packages/ergoscript/src/eval/method-call.ts` (the registry that this slice extends)
- Existing fixture-gen pattern: `fixture-gen/src/cmds/ergoscript/eval/context.rs` (the smallest reference for an `Expr` arm fixture-gen file)

**Out of scope (per design spec § Non-goals):** broader method surface beyond the 5 (Header methods, Coll utilities `.zipWith`/`.reverse`/`.getOrElse`, BinOp Bit shifts); AVL+ membership-proof verification (phase 2h); predef arms `DecodePoint`/`SubstConstants`/`CalcBlake2b256` (phase 2i); cost validation (phase 2j); enlarging the C2 corpus; npm publish of `@mwaddip/ergots-ergoscript@0.3.0` (orthogonal decision); Layer C3.a operator-driven mutation testing for these handlers (same posture as 2g.5); 2g.5 carryover cleanup list.

---

## File structure

**Created in this phase:**

```
ergots/
├── packages/ergoscript/
│   ├── src/eval/
│   │   └── global.ts                                NEW: Global Expr arm (Task 1)
│   └── test/
│       ├── eval/
│       │   ├── global.test.ts                       NEW (Task 1)
│       │   ├── sglobal-group-generator.test.ts      NEW (Task 2)
│       │   ├── scoll-indices.test.ts                NEW (Task 3)
│       │   ├── scoll-zip.test.ts                    NEW (Task 4)
│       │   ├── scontext-pre-header.test.ts          NEW (Task 6)
│       │   └── spreheader-timestamp.test.ts         NEW (Task 7)
│       └── fixtures/eval/
│           ├── global.json                          NEW (Task 1)
│           ├── sglobal-group-generator.json         NEW (Task 2)
│           ├── scoll-indices.json                   NEW (Task 3)
│           ├── scoll-zip.json                       NEW (Task 4)
│           ├── scontext-pre-header.json             NEW (Task 6)
│           └── spreheader-timestamp.json            NEW (Task 7)
└── fixture-gen/src/cmds/ergoscript/eval/
    ├── global.rs                                    NEW (Task 1)
    ├── sglobal_group_generator.rs                   NEW (Task 2)
    ├── scoll_indices.rs                             NEW (Task 3)
    ├── scoll_zip.rs                                 NEW (Task 4)
    ├── scontext_pre_header.rs                       NEW (Task 6)
    └── spreheader_timestamp.rs                      NEW (Task 7)
```

**Modified in this phase:**

```
ergots/
├── packages/ergoscript/
│   ├── src/
│   │   ├── mir/types.ts                             MODIFIED (Tasks 1, 5): +2 SValue variants
│   │   └── eval/
│   │       ├── eval.ts                              MODIFIED (Task 1): +1 case ('Global')
│   │       └── method-call.ts                       MODIFIED (Tasks 2,3,4,6,7): +5 HANDLERS entries + helpers
│   ├── test/
│   │   └── _helpers/index.ts                        MODIFIED (Tasks 1, 5): hydrateSValue cases for new variants
│   └── scripts/
│       └── _known-methods.ts                        MODIFIED (Task 8): mark 5 methods implemented
├── fixture-gen/
│   └── src/cmds/ergoscript/eval/mod.rs              MODIFIED (each Task): wire new modules
├── facts/ergoscript.md                              MODIFIED (Task 8): coverage update
├── docs/specs/
│   ├── 2026-05-13-ergoscript-interpreter-design.md  MODIFIED (Task 8): 2g.6 row ✅ COMPLETE
│   └── 2026-05-18-task-b-corpus-survey-tally.json   REGENERATED (Task 8): re-survey verification
└── PLAN.md                                          MODIFIED (Task 8): mark phase complete
```

---

## Task 1: `{ kind: 'Global' }` SValue variant + `Expr::Global` eval arm + C1 fixture

**Files:**
- Source-read: `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs:37-40` (cost 5 Pattern A; returns `Value::Global`)
- Source-read: `packages/ergoscript/src/eval/context.ts` (the 2g.5 sibling pattern)
- Modify: `packages/ergoscript/src/mir/types.ts` (add SValue variant around line 829, after `{ kind: 'Context' }`)
- Modify: `packages/ergoscript/test/_helpers/index.ts` (add `case 'Global':` in `hydrateSValue`)
- Create: `packages/ergoscript/src/eval/global.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add `case 'Global':` after `case 'GlobalVars':` at line 151)
- Create: `packages/ergoscript/test/eval/global.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/global.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (export new module + wire into `main.rs`)
- Create: `packages/ergoscript/test/fixtures/eval/global.json` (generated by `cargo run`)

- [ ] **Step 1: Source-read sigma-rust to confirm cost still 5**

```bash
sed -n '37,40p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs
```

Expected output:
```
            Expr::Global => {
                ctx.add_jit_cost(5)?; // Global = Fixed(5)
                Ok(Value::Global)
            }
```

If the cost has drifted upstream, STOP — escalate per OVERRIDES rule #2 (confidence drop on cost-charging order) before proceeding.

- [ ] **Step 2: Add `{ kind: 'Global' }` to SValue union**

Edit `packages/ergoscript/src/mir/types.ts`. Find the SValue union (~line 817-833):

```ts
export type SValue =
  | { kind: 'Boolean'; value: boolean }
  // ... existing variants ...
  | { kind: 'Unit' }
  | { kind: 'Context' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
  // ...
```

Insert the new variant right after `{ kind: 'Context' }`:

```ts
  | { kind: 'Context' }
  | { kind: 'Global' }
  | { kind: 'Coll'; elem: SType; items: SValue[] }
```

- [ ] **Step 3: Run TypeScript check to surface exhaustiveness errors**

Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: errors in any file with exhaustive `switch (v.kind)` patterns that don't handle `'Global'`. Likely candidates: `test/_helpers/index.ts` (hydrateSValue), some eval module asserting full SValue exhaustion. Capture the file list from the error output.

- [ ] **Step 4: Add `case 'Global':` arms to all exhaustive switches**

For each file flagged in Step 3, add the case. The most common pattern (in `hydrateSValue`):

```ts
    case 'Global':
      return { kind: 'Global' }
```

- [ ] **Step 5: Re-run TypeScript check, confirm clean**

Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 6: Write the failing test (inline unit) for `evalGlobal`**

Create `packages/ergoscript/test/eval/global.test.ts`:

```ts
/**
 * Layer C1 — `Global` Expr arm.
 *
 * Trivial arm: cost 5 (Pattern A); returns `{ kind: 'Global' }` SValue
 * sentinel. Mirrors the 2g.5 Context arm pattern (different cost, different
 * sentinel kind). Source: ergotree-interpreter/src/eval/expr.rs:37-40.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalGlobal } from '../../src/eval/global'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { Global as GlobalExpr } from '../../src/mir/types'

describe('evalGlobal (Layer C1)', () => {
  it('returns { kind: "Global" } and charges cost 5', () => {
    const ctx = makeContext({})
    const e: GlobalExpr = { tag: 'Global' }
    const result = evalGlobal(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Global' })
    expect(ctx.jitCost).toBe(5)
  })
})

interface GlobalEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface GlobalFixture {
  corpus: string
  entries: GlobalEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/global.json')
const fixture: GlobalFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('Global arm — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 7: Run test to verify RED**

Run: `cd packages/ergoscript && npx vitest run test/eval/global.test.ts`

Expected: RED with `Cannot find module '../../src/eval/global'` (or similar — the module doesn't exist yet). The fixture-driven block will also fail because `fixtures/eval/global.json` doesn't exist; that's expected too.

- [ ] **Step 8: Create `src/eval/global.ts` (minimal implementation to GREEN the inline test)**

Create `packages/ergoscript/src/eval/global.ts`:

```ts
/**
 * `Global` evaluator arm — returns the `Value::Global` sentinel.
 *
 * Trivial: cost 5 (Pattern A) per `expr.rs:38`. The sentinel is consumed
 * by `SGlobal.*` method handlers (Task 2: groupGenerator; future: xor,
 * serialize, deserialize, some, none, fromBigEndianBytes, etc.).
 *
 * Source: ergotree-interpreter/src/eval/expr.rs:37-40
 */

import type { Global as GlobalExpr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalGlobal(_e: GlobalExpr, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5)
  return { kind: 'Global' }
}
```

- [ ] **Step 9: Wire `case 'Global':` in `eval/eval.ts`**

Edit `packages/ergoscript/src/eval/eval.ts`. Add the import (alphabetical-ish, after `evalGetVar`):

```ts
import { evalGlobal } from './global'
```

Add the case after `case 'GlobalVars':` at line 151:

```ts
    case 'GlobalVars':
      return evalGlobalVars(e, env, ctx)
    case 'Global':
      return evalGlobal(e, env, ctx)
```

- [ ] **Step 10: Run inline test to confirm GREEN**

Run: `cd packages/ergoscript && npx vitest run test/eval/global.test.ts -t "returns"`

Expected: the inline `evalGlobal (Layer C1)` test passes. The fixture-driven block still fails (no fixture on disk yet).

- [ ] **Step 11: Create fixture-gen Rust file for the Global arm**

Create `fixture-gen/src/cmds/ergoscript/eval/global.rs` (mirror `context.rs`):

```rust
//! Global arm — fixtures for `Expr::Global` evaluation.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/expr.rs:37-40`
//!   Expr::Global => {
//!       ctx.add_jit_cost(5)?;   // Global = Fixed(5)
//!       Ok(Value::Global)
//!   }
//!
//! Trivial arm: cost 5 (Pattern A). No child expressions. Returns
//! `Value::Global`, the opaque runtime handle consumed by `SGlobal.*`
//! method-call handlers (Task 2: groupGenerator).
//!
//! Single fixture entry: tree = ErgoTree wrapping bare `Expr::Global`.
//! Expected value: `{ "kind": "Global" }`. Expected cost: 5.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let expr: Expr = Expr::Global;
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    entries.push(EvalFixture {
        name: "global_sentinel".to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_global",
        entries,
    })
}
```

- [ ] **Step 12: Wire the new module + generator call**

Edit `fixture-gen/src/cmds/ergoscript/eval/mod.rs` to declare `pub mod global;` next to `pub mod context;`.

Edit `fixture-gen/src/main.rs` to add the generator call. Search for the existing `context.rs` generator wiring and add a parallel call for `global` immediately below it. Pattern (look at the existing pattern in `main.rs` to confirm exact form):

```rust
generate_and_write("eval/global.json", cmds::ergoscript::eval::global::generate)?;
```

- [ ] **Step 13: Build + generate the fixture**

Run: `cd fixture-gen && cargo build && cargo run`

Expected: build clean; fixture file written to `packages/ergoscript/test/fixtures/eval/global.json`.

- [ ] **Step 14: Confirm fixture-driven test passes**

Run: `cd packages/ergoscript && npx vitest run test/eval/global.test.ts`

Expected: both the inline and fixture-driven `describe` blocks pass.

- [ ] **Step 15: Two-run determinism check**

Run: `cd fixture-gen && cargo run && git -C .. diff --stat packages/ergoscript/test/fixtures/eval/global.json`

Expected: no diff. Generator is deterministic.

- [ ] **Step 16: Type-check across the workspace**

Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 17: Commit**

```bash
git add packages/ergoscript/src/mir/types.ts \
        packages/ergoscript/src/eval/global.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/_helpers/index.ts \
        packages/ergoscript/test/eval/global.test.ts \
        packages/ergoscript/test/fixtures/eval/global.json \
        fixture-gen/src/cmds/ergoscript/eval/global.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): phase 2g.6 Task 1 — Global Expr arm + { kind: 'Global' } SValue

Adds Expr::Global eval arm (cost 5 Pattern A, returns sentinel) and the
parallel SValue variant. Already wire-parsed since phase 2a; this task wires
the evaluator (was hitting 'not-implemented-yet' for the 120 boxes that use it
per Task B's survey). Mirrors 2g.5's Context arm pattern at a different cost.

Sets up the receiver type for Task 2 (SGlobal.groupGenerator handler).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `SGlobal.groupGenerator` handler (typeId 106, methodId 1) + C1 fixture

**Files:**
- Source-read: `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sglobal.rs:32-41`
- Read for reference: `packages/ergoscript/src/eval/_group-generator.ts` (existing `GROUP_GENERATOR_BYTES` constant)
- Modify: `packages/ergoscript/src/eval/method-call.ts` (add `HANDLERS.set(handlerKey(106, 1), …)` to `registerHandlers()`)
- Create: `packages/ergoscript/test/eval/sglobal-group-generator.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/sglobal_group_generator.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + `fixture-gen/src/main.rs` (wire new module)
- Create: `packages/ergoscript/test/fixtures/eval/sglobal-group-generator.json` (generated)

- [ ] **Step 1: Source-read sigma-rust to confirm cost still 10 + obj is `Value::Global`**

```bash
sed -n '32,41p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sglobal.rs
```

Expected: `add_jit_cost(10)` BEFORE the obj check; obj must be `Value::Global`; returns `Value::from(generator())`. If cost drifts, escalate per OVERRIDES rule #2.

- [ ] **Step 2: Write the failing inline unit test**

Create `packages/ergoscript/test/eval/sglobal-group-generator.test.ts`:

```ts
/**
 * Layer C1 — SGlobal.groupGenerator handler (typeId 106, methodId 1).
 *
 * Pattern A cost 10 (charged before obj check). Returns the 33-byte SEC1
 * compressed secp256k1 generator point. Reuses GROUP_GENERATOR_BYTES from
 * eval/_group-generator.ts (no @noble/curves round-trip needed).
 *
 * Source: ergotree-interpreter/src/eval/sglobal.rs:32-41
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { GROUP_GENERATOR_BYTES } from '../../src/eval/_group-generator'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { PropertyCall as PropertyCallExpr } from '../../src/mir/types'

describe('SGlobal.groupGenerator handler (Layer C1)', () => {
  it('returns the generator point and charges cost 4 (dispatcher) + 5 (Global arm) + 10 (handler) = 19', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 106,
      methodId: 1,
      explicitTypeArgs: {},
      tpe: { tag: 'SGroupElement' },
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES })
    expect(ctx.jitCost).toBe(19)
  })

  it('rejects when obj is not Global', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 106,
      methodId: 1,
      explicitTypeArgs: {},
      tpe: { tag: 'SGroupElement' },
    }
    expect(() => evalPropertyCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface GroupGenEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface GroupGenFixture {
  corpus: string
  entries: GroupGenEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sglobal-group-generator.json')
const fixture: GroupGenFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SGlobal.groupGenerator — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

Note: the exact field set of `PropertyCallExpr` (whether `tpe` is required, etc.) should be confirmed by reading `mir/types.ts` for the interface. Adjust the literal accordingly if the type requires different fields.

- [ ] **Step 3: Run test to verify RED**

Run: `cd packages/ergoscript && npx vitest run test/eval/sglobal-group-generator.test.ts`

Expected: RED on the first `it()` (no handler registered for `106:1` → throws `'method-not-implemented'`). The fixture-driven block also fails (file doesn't exist).

- [ ] **Step 4: Register the `SGlobal.groupGenerator` handler in `method-call.ts`**

Edit `packages/ergoscript/src/eval/method-call.ts`. Add an import for `GROUP_GENERATOR_BYTES` at the top:

```ts
import { GROUP_GENERATOR_BYTES } from './_group-generator'
```

Inside `registerHandlers()`, after the existing `SColl.indexOf` registration, add:

```ts
  // SGlobal.groupGenerator (PropertyCall, typeId=106, methodId=1)
  // Source: ergotree-interpreter/src/eval/sglobal.rs:32-41 — GROUP_GENERATOR_EVAL_FN
  // Pattern A cost 10 (charged before obj check). Returns 33-byte SEC1 of secp256k1 base point.
  HANDLERS.set(handlerKey(106, 1), (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'Global') {
      throw new EvalError(
        `SGlobal.groupGenerator expects a Global obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    return { kind: 'GroupElement', value: GROUP_GENERATOR_BYTES }
  })
```

- [ ] **Step 5: Run inline tests to confirm GREEN**

Run: `cd packages/ergoscript && npx vitest run test/eval/sglobal-group-generator.test.ts -t "returns the generator point"`

Run: `cd packages/ergoscript && npx vitest run test/eval/sglobal-group-generator.test.ts -t "rejects when obj is not Global"`

Both expected: PASS.

- [ ] **Step 6: Create fixture-gen Rust file**

Create `fixture-gen/src/cmds/ergoscript/eval/sglobal_group_generator.rs`:

```rust
//! SGlobal.groupGenerator handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/sglobal.rs:32-41`
//! Method registration: `ergotree-ir/src/types/sglobal.rs::GROUP_GENERATOR_METHOD`
//!
//! Pattern A cost 10. Returns the 33-byte SEC1 compressed secp256k1 base
//! point. Tree shape: PropertyCall(Global, groupGenerator).

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::sglobal::GROUP_GENERATOR_METHOD;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let expr: Expr = PropertyCall::new(Expr::Global, GROUP_GENERATOR_METHOD.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    entries.push(EvalFixture {
        name: "global_group_generator".to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_sglobal_group_generator",
        entries,
    })
}
```

- [ ] **Step 7: Wire the new module + generator call**

Edit `fixture-gen/src/cmds/ergoscript/eval/mod.rs` to add `pub mod sglobal_group_generator;`.

Edit `fixture-gen/src/main.rs` to add the generator call (parallel to Task 1's):

```rust
generate_and_write("eval/sglobal-group-generator.json", cmds::ergoscript::eval::sglobal_group_generator::generate)?;
```

- [ ] **Step 8: Build + generate the fixture**

Run: `cd fixture-gen && cargo build && cargo run`

Expected: clean build; fixture file written.

- [ ] **Step 9: Confirm fixture-driven test passes**

Run: `cd packages/ergoscript && npx vitest run test/eval/sglobal-group-generator.test.ts`

Expected: all blocks PASS. If the fixture cost doesn't match 19, the source-read in Step 1 was stale — re-source-read and adjust the handler.

- [ ] **Step 10: Two-run determinism check + type-check**

Run: `cd fixture-gen && cargo run && git -C .. diff --stat packages/ergoscript/test/fixtures/eval/sglobal-group-generator.json && cd ../packages/ergoscript && npx tsc --noEmit`

Expected: no fixture diff; zero TS errors.

- [ ] **Step 11: Commit**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/test/eval/sglobal-group-generator.test.ts \
        packages/ergoscript/test/fixtures/eval/sglobal-group-generator.json \
        fixture-gen/src/cmds/ergoscript/eval/sglobal_group_generator.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): phase 2g.6 Task 2 — SGlobal.groupGenerator handler

Registers PropertyCall(Global, groupGenerator) (typeId 106, methodId 1) in
the eval/method-call.ts HANDLERS map. Pattern A cost 10 (chained total 19:
4 dispatcher + 5 Global arm + 10 handler). Reuses GROUP_GENERATOR_BYTES
constant from eval/_group-generator.ts (no @noble/curves round-trip needed).

Unlocks 120 mainnet boxes per Task B's survey (top-demand 2g.6 method).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `SColl.indices` handler (typeId 12, methodId 14) + C1 fixture

**Files:**
- Source-read: `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:171-193`
- Modify: `packages/ergoscript/src/eval/method-call.ts` (add handler + `indicesCollOf` helper + `SINT` SType singleton)
- Create: `packages/ergoscript/test/eval/scoll-indices.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/scoll_indices.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/scoll-indices.json` (generated)

- [ ] **Step 1: Source-read sigma-rust**

```bash
sed -n '171,193p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs
```

Expected: `add_per_item_jit_cost(20, 2, 16, input_len)` AFTER Coll extraction; returns Coll[Int] = `0..n-1`; throws on `i32::try_from` overflow. If formula drifts, escalate.

- [ ] **Step 2: Write the failing inline unit test**

Create `packages/ergoscript/test/eval/scoll-indices.test.ts`:

```ts
/**
 * Layer C1 — SColl.indices handler (typeId 12, methodId 14).
 *
 * Pattern B cost addPerItemCost(20, 2, 16, n) (charged after Coll
 * extraction). Returns Coll[Int] = 0..n-1.
 *
 * Source: ergotree-interpreter/src/eval/scoll.rs:171-193
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { MethodCall as MethodCallExpr, SValue } from '../../src/mir/types'

const SLONG = { tag: 'SLong' } as const
const SINT = { tag: 'SInt' } as const

function collOf(items: SValue[], elem: { tag: 'SLong' }): SValue {
  return { kind: 'Coll', elem, items }
}

function constExpr(value: SValue, tpe: { tag: string }): any {
  return { tag: 'Const', tpe, value }
}

describe('SColl.indices handler (Layer C1)', () => {
  it('empty Coll → empty Coll[Int]', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(collOf([], SLONG), { tag: 'SColl', elem: SLONG }),
      args: [],
      typeId: 12,
      methodId: 14,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: SINT },
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Coll', elem: SINT, items: [] })
    // Dispatcher 4 + Const arm 1 + handler base 20 + ceil(0/16)*2 = 0 = 25
    expect(ctx.jitCost).toBe(25)
  })

  it('3-elem Coll → Coll[Int](0, 1, 2)', () => {
    const ctx = makeContext({})
    const items: SValue[] = [
      { kind: 'Long', value: 10n },
      { kind: 'Long', value: 20n },
      { kind: 'Long', value: 30n },
    ]
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(collOf(items, SLONG), { tag: 'SColl', elem: SLONG }),
      args: [],
      typeId: 12,
      methodId: 14,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: SINT },
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({
      kind: 'Coll',
      elem: SINT,
      items: [
        { kind: 'Int', value: 0 },
        { kind: 'Int', value: 1 },
        { kind: 'Int', value: 2 },
      ],
    })
    // Dispatcher 4 + Const arm 1 + handler base 20 + ceil(3/16)*2 = 2 = 27
    expect(ctx.jitCost).toBe(27)
  })

  it('rejects when obj is not Coll', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr({ kind: 'Long', value: 5n }, SLONG),
      args: [],
      typeId: 12,
      methodId: 14,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: SINT },
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface IndicesEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface IndicesFixture {
  corpus: string
  entries: IndicesEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scoll-indices.json')
const fixture: IndicesFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SColl.indices — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

NOTE: the inline-test cost arithmetic (25, 27) assumes `Const`-wrapping each input adds cost 1. If the actual `Const` arm cost differs, adjust. The truth-of-record is the fixture-driven test (cross-validated by sigma-rust's oracle).

- [ ] **Step 3: Run test to verify RED**

Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-indices.test.ts`

Expected: RED on the first `it()` (no handler for `12:14`).

- [ ] **Step 4: Register the `SColl.indices` handler in `method-call.ts`**

Edit `packages/ergoscript/src/eval/method-call.ts`. Add a module-level SInt singleton near the top (after existing `SLONG`, `STUPLE_COLLBYTE_LONG`, `SBOX`):

```ts
const SINT: SType = { tag: 'SInt' }
```

Add this helper function below the existing handlers:

```ts
/** Build a Coll[Int] of 0..n-1. */
function indicesCollOf(n: number): SValue {
  const items: SValue[] = []
  for (let i = 0; i < n; i++) items.push({ kind: 'Int', value: i })
  return { kind: 'Coll', elem: SINT, items }
}
```

Inside `registerHandlers()`, add:

```ts
  // SColl.indices (MethodCall, typeId=12, methodId=14)
  // Source: ergotree-interpreter/src/eval/scoll.rs:171-193 — INDICES_EVAL_FN
  // Pattern B cost: addPerItemCost(20, 2, 16, n) AFTER Coll extraction.
  HANDLERS.set(handlerKey(12, 14), (obj, _args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.indices expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented' // reuse per error taxonomy option 1
      )
    }
    const n = obj.items.length
    if (n > 0x7fffffff) {
      throw new EvalError(
        `SColl.indices: length ${n} exceeds i32 range`,
        'method-not-implemented' // symmetry with sigma-rust's TryFromIntError throw
      )
    }
    ctx.addPerItemCost(20, 2, 16, n) // Pattern B; source: scoll.rs:179
    return indicesCollOf(n)
  })
```

- [ ] **Step 5: Run inline tests to confirm GREEN**

Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-indices.test.ts -t "empty Coll"`
Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-indices.test.ts -t "3-elem Coll"`
Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-indices.test.ts -t "rejects when obj is not Coll"`

All expected: PASS. If cost numbers don't match, the comment-line cost arithmetic guesses are off (see Step 2 NOTE) — fix inline-test expectations to match actual `ctx.jitCost`, document the actual breakdown in the comment.

- [ ] **Step 6: Create fixture-gen Rust file**

Create `fixture-gen/src/cmds/ergoscript/eval/scoll_indices.rs`:

```rust
//! SColl.indices handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scoll.rs:171-193`
//! Method registration: `ergotree-ir/src/types/scoll.rs::INDICES_METHOD`
//!
//! Pattern B cost addPerItemCost(20, 2, 16, n). Returns Coll[Int] = 0..n-1.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scoll::INDICES_METHOD;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

fn entry(name: &str, items: Vec<i64>) -> anyhow::Result<EvalFixture> {
    let coll_const: Constant = items.into();
    let expr: Expr = MethodCall::new(coll_const.into(), INDICES_METHOD.clone(), vec![])
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();
    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let entries = vec![
        entry("empty", vec![])?,
        entry("three_elements", vec![10, 20, 30])?,
        entry("seventeen_elements_two_chunks", (0..17).collect())?,
    ];
    Ok(EvalFixtureFile {
        corpus: "eval_scoll_indices",
        entries,
    })
}
```

- [ ] **Step 7: Wire + generate + verify**

Wire `pub mod scoll_indices;` in `mod.rs` and `generate_and_write("eval/scoll-indices.json", ...)` in `main.rs`.

Run: `cd fixture-gen && cargo build && cargo run`
Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-indices.test.ts`
Run: `cd fixture-gen && cargo run && git -C .. diff --stat packages/ergoscript/test/fixtures/eval/scoll-indices.json`
Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: clean build; all tests pass; no fixture diff; zero TS errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/test/eval/scoll-indices.test.ts \
        packages/ergoscript/test/fixtures/eval/scoll-indices.json \
        fixture-gen/src/cmds/ergoscript/eval/scoll_indices.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): phase 2g.6 Task 3 — SColl.indices handler

Registers MethodCall(Coll, indices) (typeId 12, methodId 14) in the
eval/method-call.ts HANDLERS map. Pattern B cost addPerItemCost(20, 2, 16, n)
charged after Coll extraction. Returns Coll[Int] = 0..n-1. Includes overflow
guard at n > 2^31 - 1 (symmetry with sigma-rust's TryFromIntError throw).

Unlocks 8 mainnet boxes per Task B's survey.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `SColl.zip` handler (typeId 12, methodId 29) + C1 fixture

**Files:**
- Source-read: `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:138-169`
- Modify: `packages/ergoscript/src/eval/method-call.ts` (add handler + `zipCollsOf` helper)
- Create: `packages/ergoscript/test/eval/scoll-zip.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/scoll_zip.rs`
- Wire in `mod.rs` + `main.rs`
- Generate fixture

- [ ] **Step 1: Source-read sigma-rust**

```bash
sed -n '138,169p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs
```

Confirm:
- `add_per_item_jit_cost(10, 1, 10, n)` where `n = coll_1.len()` (FIRST Coll, NOT min)
- Truncates via Rust's `Iterator::zip` (stops at shorter)
- Returns `Coll[STuple[type_1, type_2]]` where types come from runtime obj+arg elem_tpe

- [ ] **Step 2: Write the failing inline unit test**

Create `packages/ergoscript/test/eval/scoll-zip.test.ts`:

```ts
/**
 * Layer C1 — SColl.zip handler (typeId 12, methodId 29).
 *
 * Pattern B cost addPerItemCost(10, 1, 10, n) where n = obj len.
 * Truncates to the shorter Coll (Rust Iterator::zip semantics).
 * Returns Coll[STuple[T1, T2]].
 *
 * Source: ergotree-interpreter/src/eval/scoll.rs:138-169
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalMethodCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { MethodCall as MethodCallExpr, SValue, SType } from '../../src/mir/types'

const SLONG: SType = { tag: 'SLong' }
const SBYTE: SType = { tag: 'SByte' }

function collOf(items: SValue[], elem: SType): SValue {
  return { kind: 'Coll', elem, items }
}

function constExpr(value: SValue, tpe: SType): any {
  return { tag: 'Const', tpe, value }
}

describe('SColl.zip handler (Layer C1)', () => {
  it('empty zip empty → empty Coll[(Long, Long)]', () => {
    const ctx = makeContext({})
    const obj = collOf([], SLONG)
    const arg = collOf([], SLONG)
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: { tag: 'STuple', items: [SLONG, SLONG] } },
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({
      kind: 'Coll',
      elem: { tag: 'STuple', items: [SLONG, SLONG] },
      items: [],
    })
  })

  it('equal-length zip → tuples of corresponding elements', () => {
    const ctx = makeContext({})
    const obj = collOf(
      [
        { kind: 'Long', value: 1n },
        { kind: 'Long', value: 2n },
        { kind: 'Long', value: 3n },
      ],
      SLONG
    )
    const arg = collOf(
      [
        { kind: 'Long', value: 10n },
        { kind: 'Long', value: 20n },
        { kind: 'Long', value: 30n },
      ],
      SLONG
    )
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: { tag: 'STuple', items: [SLONG, SLONG] } },
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect(result).toEqual({
      kind: 'Coll',
      elem: { tag: 'STuple', items: [SLONG, SLONG] },
      items: [
        { kind: 'Tuple', items: [{ kind: 'Long', value: 1n }, { kind: 'Long', value: 10n }] },
        { kind: 'Tuple', items: [{ kind: 'Long', value: 2n }, { kind: 'Long', value: 20n }] },
        { kind: 'Tuple', items: [{ kind: 'Long', value: 3n }, { kind: 'Long', value: 30n }] },
      ],
    })
  })

  it('short obj zip long arg → truncates to obj length', () => {
    const ctx = makeContext({})
    const obj = collOf([{ kind: 'Long', value: 1n }], SLONG)
    const arg = collOf(
      [
        { kind: 'Long', value: 10n },
        { kind: 'Long', value: 20n },
      ],
      SLONG
    )
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: { tag: 'STuple', items: [SLONG, SLONG] } },
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect((result as any).items).toHaveLength(1)
  })

  it('long obj zip short arg → truncates to arg length', () => {
    const ctx = makeContext({})
    const obj = collOf(
      [
        { kind: 'Long', value: 1n },
        { kind: 'Long', value: 2n },
      ],
      SLONG
    )
    const arg = collOf([{ kind: 'Long', value: 10n }], SLONG)
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: { tag: 'STuple', items: [SLONG, SLONG] } },
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect((result as any).items).toHaveLength(1)
  })

  it('mixed-type zip → tuples of (Long, Byte)', () => {
    const ctx = makeContext({})
    const obj = collOf(
      [{ kind: 'Long', value: 100n }, { kind: 'Long', value: 200n }],
      SLONG
    )
    const arg = collOf(
      [{ kind: 'Byte', value: 1 }, { kind: 'Byte', value: 2 }],
      SBYTE
    )
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(obj, { tag: 'SColl', elem: SLONG }),
      args: [constExpr(arg, { tag: 'SColl', elem: SBYTE })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: { tag: 'STuple', items: [SLONG, SBYTE] } },
    }
    const result = evalMethodCall(e, Env.empty(), ctx)
    expect((result as any).elem).toEqual({ tag: 'STuple', items: [SLONG, SBYTE] })
    expect((result as any).items).toHaveLength(2)
  })

  it('rejects when obj is not Coll', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr({ kind: 'Long', value: 5n }, SLONG),
      args: [constExpr(collOf([], SLONG), { tag: 'SColl', elem: SLONG })],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: { tag: 'STuple', items: [SLONG, SLONG] } },
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })

  it('rejects when arg is not Coll', () => {
    const ctx = makeContext({})
    const e: MethodCallExpr = {
      tag: 'MethodCall',
      obj: constExpr(collOf([], SLONG), { tag: 'SColl', elem: SLONG }),
      args: [constExpr({ kind: 'Long', value: 5n }, SLONG)],
      typeId: 12,
      methodId: 29,
      explicitTypeArgs: {},
      tpe: { tag: 'SColl', elem: { tag: 'STuple', items: [SLONG, SLONG] } },
    }
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface ZipEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface ZipFixture {
  corpus: string
  entries: ZipEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scoll-zip.json')
const fixture: ZipFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SColl.zip — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 3: Run test to verify RED**

Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-zip.test.ts`

Expected: RED on first `it()` (no handler for `12:29`).

- [ ] **Step 4: Register the `SColl.zip` handler in `method-call.ts`**

Inside `registerHandlers()`, add:

```ts
  // SColl.zip (MethodCall, typeId=12, methodId=29)
  // Source: ergotree-interpreter/src/eval/scoll.rs:138-169 — ZIP_EVAL_FN
  // Pattern B cost: addPerItemCost(10, 1, 10, n) where n = obj len (NOT min).
  // Truncates to the shorter Coll (Rust Iterator::zip semantics).
  HANDLERS.set(handlerKey(12, 29), (obj, args, ctx, _explicitTypeArgs) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.zip expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented'
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(10, 1, 10, n) // Pattern B; source: scoll.rs:147
    if (args.length !== 1) {
      throw new EvalError(
        `SColl.zip expects 1 arg; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const arg = args[0]!
    if (arg.kind !== 'Coll') {
      throw new EvalError(
        `SColl.zip expects arg to be a Coll; got '${arg.kind}'`,
        'method-not-implemented'
      )
    }
    return zipCollsOf(obj, arg)
  })
```

Add the helper function below the existing helpers:

```ts
/** Zip two Colls into Coll[STuple[T1, T2]], truncating to the shorter input. */
function zipCollsOf(
  coll1: SValue & { kind: 'Coll' },
  coll2: SValue & { kind: 'Coll' }
): SValue {
  const len = Math.min(coll1.items.length, coll2.items.length)
  const items: SValue[] = []
  for (let i = 0; i < len; i++) {
    items.push({ kind: 'Tuple', items: [coll1.items[i]!, coll2.items[i]!] })
  }
  return {
    kind: 'Coll',
    elem: { tag: 'STuple', items: [coll1.elem, coll2.elem] },
    items,
  }
}
```

- [ ] **Step 5: Run inline tests to confirm GREEN**

Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-zip.test.ts -t "Layer C1"`

Expected: all 7 inline-test cases pass.

- [ ] **Step 6: Create fixture-gen Rust file**

Create `fixture-gen/src/cmds/ergoscript/eval/scoll_zip.rs`:

```rust
//! SColl.zip handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scoll.rs:138-169`
//! Method registration: `ergotree-ir/src/types/scoll.rs::ZIP_METHOD`
//!
//! Pattern B cost addPerItemCost(10, 1, 10, n) where n = obj len.
//! Truncates to shorter Coll.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scoll::ZIP_METHOD;
use ergotree_ir::types::stype::SType;
use ergotree_ir::types::stype_param::STypeVar;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{value_to_json, EvalFixture, EvalFixtureFile};

fn entry_longs(name: &str, obj: Vec<i64>, arg: Vec<i64>) -> anyhow::Result<EvalFixture> {
    let obj_const: Constant = obj.into();
    let arg_const: Constant = arg.into();
    let type_args = [
        (STypeVar::iv(), SType::SLong),
    ].into_iter().collect();
    let expr: Expr = MethodCall::new(
        obj_const.into(),
        ZIP_METHOD.clone().with_concrete_types(&type_args),
        vec![arg_const.into()],
    )
    .unwrap()
    .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);
    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();
    Ok(EvalFixture {
        name: name.to_string(),
        tree_bytes_hex,
        opts_json: json!({}),
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    })
}

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let entries = vec![
        entry_longs("empty_zip_empty", vec![], vec![])?,
        entry_longs("equal_length", vec![1, 2, 3], vec![10, 20, 30])?,
        entry_longs("short_obj_long_arg", vec![1], vec![10, 20, 30])?,
        entry_longs("long_obj_short_arg", vec![1, 2, 3], vec![10])?,
    ];
    Ok(EvalFixtureFile {
        corpus: "eval_scoll_zip",
        entries,
    })
}
```

NOTE: the `with_concrete_types` arguments may need adjustment based on how sigma-rust's `ZIP_METHOD` is parameterized — read `types/scoll.rs:103` to confirm the type-var name and whether you need `IV` + `OV` or just one. Adjust the type-args HashMap accordingly. If sigma-rust's API has changed, the existing fixture-gen examples in `scoll_*.rs` files (e.g., `scoll_map.rs`) are reference patterns for `with_concrete_types` usage.

- [ ] **Step 7: Wire + generate + verify**

Wire `pub mod scoll_zip;` in `mod.rs` and `generate_and_write("eval/scoll-zip.json", ...)` in `main.rs`.

Run: `cd fixture-gen && cargo build && cargo run`
Run: `cd packages/ergoscript && npx vitest run test/eval/scoll-zip.test.ts`
Run: `cd fixture-gen && cargo run && git -C .. diff --stat packages/ergoscript/test/fixtures/eval/scoll-zip.json`
Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: clean build; all tests pass; no fixture diff; zero TS errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/test/eval/scoll-zip.test.ts \
        packages/ergoscript/test/fixtures/eval/scoll-zip.json \
        fixture-gen/src/cmds/ergoscript/eval/scoll_zip.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): phase 2g.6 Task 4 — SColl.zip handler

Registers MethodCall(Coll, zip) (typeId 12, methodId 29) in the
eval/method-call.ts HANDLERS map. Pattern B cost addPerItemCost(10, 1, 10, n)
where n = obj length (not min). Returns Coll[STuple[T1, T2]] truncating to
the shorter Coll (Rust Iterator::zip semantics). Type-arg passthrough not
needed (return-type element built from runtime elem_tpe).

Unlocks 35 mainnet boxes per Task B's survey.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `{ kind: 'PreHeader', value: PreHeader }` SValue variant + audit consumers

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts` (add variant to SValue union, ~line 832)
- Modify: `packages/ergoscript/test/_helpers/index.ts` (add `case 'PreHeader':` in `hydrateSValue`)
- Possibly modify other internal files that pattern-match exhaustively on SValue

**No new tests in this task** — the variant is introduced as a type only. Task 6 and Task 7 register handlers that produce/consume it.

- [ ] **Step 1: Add `{ kind: 'PreHeader', value: PreHeader }` to SValue union**

Edit `packages/ergoscript/src/mir/types.ts`. Find the SValue union and insert the new variant right after `{ kind: 'Box'; value: ErgoBox }`:

```ts
  | { kind: 'Box'; value: ErgoBox }
  | { kind: 'PreHeader'; value: PreHeader }
  | { kind: 'AvlTree'; value: AvlTreeData }
```

The `PreHeader` interface is already defined at line 156 in the same file; no new imports needed.

- [ ] **Step 2: Run TypeScript check to surface exhaustiveness errors**

Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: errors in files with exhaustive `switch (v.kind)` patterns. Capture the file list.

- [ ] **Step 3: Add `case 'PreHeader':` arms to all exhaustive switches**

For `test/_helpers/index.ts` `hydrateSValue`:

```ts
    case 'PreHeader': {
      const v = json.value
      return {
        kind: 'PreHeader',
        value: {
          version: v.version,
          parentId: hexToBytes(v.parentId),
          timestamp: BigInt(v.timestamp),
          nBits: v.nBits,
          height: v.height,
          minerPk: hexToBytes(v.minerPk),
          votes: hexToBytes(v.votes),
        },
      }
    }
```

Adjust the PreHeader field set per the actual interface (re-read `mir/types.ts:156-…` for the canonical field list). For any other file flagged in Step 2, add a `case 'PreHeader':` arm that does the natural thing for that file's purpose (often just returning a fallback or throwing).

- [ ] **Step 4: Re-run TypeScript check, confirm clean**

Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 5: Run full test suite to ensure no regressions**

Run: `cd packages/ergoscript && npx vitest run`

Expected: all existing tests pass (the variant is unused so far; no behavior changes).

- [ ] **Step 6: Commit**

```bash
git add packages/ergoscript/src/mir/types.ts \
        packages/ergoscript/test/_helpers/index.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): phase 2g.6 Task 5 — { kind: 'PreHeader' } SValue variant

Additive variant to SValue discriminated union; PreHeader interface already
exists at mir/types.ts:156 (no new type definition). Audit + add cases in
exhaustive switches across src/ and test/_helpers (hydrateSValue parses
PreHeader value from JSON fixture format).

No behavior change yet; Tasks 6 (SContext.preHeader producer) and 7
(SPreHeader.timestamp consumer) use this variant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `SContext.preHeader` handler (typeId 101, methodId 3) + C1 fixture

**Files:**
- Source-read: `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scontext.rs:72-81`
- Modify: `packages/ergoscript/src/eval/method-call.ts` (add handler entry)
- Create: `packages/ergoscript/test/eval/scontext-pre-header.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/scontext_pre_header.rs`
- Wire + generate fixture

- [ ] **Step 1: Source-read sigma-rust**

```bash
sed -n '72,81p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scontext.rs
```

Confirm: `add_jit_cost(15)` BEFORE obj check; obj must be `Value::Context`; returns `ctx.pre_header.clone()` wrapped.

- [ ] **Step 2: Write the failing inline unit test**

Create `packages/ergoscript/test/eval/scontext-pre-header.test.ts`:

```ts
/**
 * Layer C1 — SContext.preHeader handler (typeId 101, methodId 3).
 *
 * Pattern A cost 15 (charged before obj check). Returns
 * { kind: 'PreHeader', value: ctx.preHeader }.
 *
 * Source: ergotree-interpreter/src/eval/scontext.rs:72-81
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticPreHeader(): PreHeader {
  return {
    version: 3,
    parentId: new Uint8Array(32),
    timestamp: 1700000000000n,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
  }
}

describe('SContext.preHeader handler (Layer C1)', () => {
  it('returns wrapped PreHeader and charges 4 + 1 + 15 = 20', () => {
    const preHeader = syntheticPreHeader()
    const ctx = makeContext({ preHeader })
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SPreHeader' },
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'PreHeader', value: preHeader })
    expect(ctx.jitCost).toBe(20)
  })

  it('throws context-field-missing when ctx.preHeader is undefined', () => {
    const ctx = makeContext({}) // no preHeader
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SPreHeader' },
    }
    expect(() => evalPropertyCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })

  it('throws context-obj-not-context when obj is not Context', () => {
    const ctx = makeContext({ preHeader: syntheticPreHeader() })
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Global' },
      typeId: 101,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SPreHeader' },
    }
    expect(() => evalPropertyCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface PreHeaderEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface PreHeaderFixture {
  corpus: string
  entries: PreHeaderEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/scontext-pre-header.json')
const fixture: PreHeaderFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SContext.preHeader — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

NOTE: confirm the PreHeader interface field set (`version`, `parentId`, etc.) by reading `mir/types.ts:156-…`. Adjust `syntheticPreHeader` if the field list is different.

- [ ] **Step 3: Run test to verify RED**

Run: `cd packages/ergoscript && npx vitest run test/eval/scontext-pre-header.test.ts`

Expected: RED on first `it()` (no handler for `101:3`).

- [ ] **Step 4: Register the `SContext.preHeader` handler in `method-call.ts`**

Inside `registerHandlers()`, add:

```ts
  // SContext.preHeader (PropertyCall, typeId=101, methodId=3)
  // Source: ergotree-interpreter/src/eval/scontext.rs:72-81 — PRE_HEADER_EVAL_FN
  // Pattern A cost 15 (charged before obj check).
  HANDLERS.set(handlerKey(101, 3), (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(15)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.preHeader expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context' // reuses existing code (used by SContext.dataInputs)
      )
    }
    if (ctx.preHeader === undefined) {
      throw new EvalError(
        `SContext.preHeader: ctx.preHeader is undefined`,
        'context-field-missing'
      )
    }
    return { kind: 'PreHeader', value: ctx.preHeader }
  })
```

- [ ] **Step 5: Run inline tests to confirm GREEN**

Run: `cd packages/ergoscript && npx vitest run test/eval/scontext-pre-header.test.ts -t "Layer C1"`

Expected: all 3 inline-test cases pass.

- [ ] **Step 6: Create fixture-gen Rust file**

Create `fixture-gen/src/cmds/ergoscript/eval/scontext_pre_header.rs`:

```rust
//! SContext.preHeader handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/scontext.rs:72-81`
//! Method registration: `ergotree-ir/src/types/scontext.rs::PRE_HEADER_PROPERTY`
//!
//! Pattern A cost 15. Returns wrapped PreHeader from ctx.pre_header.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scontext::PRE_HEADER_PROPERTY;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{preheader_to_json, value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    let expr: Expr = PropertyCall::new(Expr::Context, PRE_HEADER_PROPERTY.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    // The opts_json must thread ctx.pre_header through to the TS test so the
    // TS evaluator's makeContext({preHeader}) call gets the same value sigma-rust
    // evaluated against. Serialise the PreHeader to canonical JSON.
    let opts_json = json!({
        "preHeader": preheader_to_json(&ctx.pre_header),
    });

    entries.push(EvalFixture {
        name: "context_pre_header".to_string(),
        tree_bytes_hex,
        opts_json,
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_scontext_pre_header",
        entries,
    })
}
```

NOTE: `preheader_to_json` helper may not exist yet in `common.rs`. If not, add it (mirroring the existing `value_to_json` pattern). It should produce a JSON object with fields `{ version, parentId (hex), timestamp (string), nBits, height, minerPk (hex), votes (hex) }` that matches what `hydrateSValue` (Task 5 Step 3) parses on the TS side.

- [ ] **Step 7: Wire + generate + verify**

Wire `pub mod scontext_pre_header;` in `mod.rs` and `generate_and_write("eval/scontext-pre-header.json", ...)` in `main.rs`.

Run: `cd fixture-gen && cargo build && cargo run`
Run: `cd packages/ergoscript && npx vitest run test/eval/scontext-pre-header.test.ts`

Expected: clean build; all tests pass. If the PreHeader JSON serialisation doesn't match, iterate on `preheader_to_json` and `hydrateSValue` until they agree.

- [ ] **Step 8: Two-run determinism + type-check**

Run: `cd fixture-gen && cargo run && git -C .. diff --stat packages/ergoscript/test/fixtures/eval/scontext-pre-header.json && cd ../packages/ergoscript && npx tsc --noEmit`

Expected: no fixture diff; zero TS errors.

- [ ] **Step 9: Commit**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/test/eval/scontext-pre-header.test.ts \
        packages/ergoscript/test/fixtures/eval/scontext-pre-header.json \
        fixture-gen/src/cmds/ergoscript/eval/scontext_pre_header.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
# If preheader_to_json was added:
git add fixture-gen/src/cmds/ergoscript/eval/common.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): phase 2g.6 Task 6 — SContext.preHeader handler

Registers PropertyCall(Context, preHeader) (typeId 101, methodId 3) in the
eval/method-call.ts HANDLERS map. Pattern A cost 15 (chained total 20:
4 dispatcher + 1 Context arm + 15 handler). Returns wrapped PreHeader from
ctx.preHeader. Reuses 'context-obj-not-context' code (second consumer,
validating 2g.5's per-typeId code choice); reuses 'context-field-missing'
for undefined ctx.preHeader (same shape as GlobalVars.{Outputs/...}).

Unlocks 7 mainnet boxes per Task B's survey (4 must-include + 3 random).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `SPreHeader.timestamp` handler (typeId 105, methodId 3) + C1 fixture

**Files:**
- Source-read: `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/spreheader.rs:20-24`
- Modify: `packages/ergoscript/src/eval/method-call.ts` (add handler entry)
- Create: `packages/ergoscript/test/eval/spreheader-timestamp.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/spreheader_timestamp.rs`
- Wire + generate fixture

- [ ] **Step 1: Source-read sigma-rust**

```bash
sed -n '20,24p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/spreheader.rs
```

Confirm: `add_jit_cost(10)` BEFORE obj extraction; obj extracted via `try_extract_into::<PreHeader>()`; returns `(preheader.timestamp as i64).into()`.

- [ ] **Step 2: Write the failing inline unit test**

Create `packages/ergoscript/test/eval/spreheader-timestamp.test.ts`:

```ts
/**
 * Layer C1 — SPreHeader.timestamp handler (typeId 105, methodId 3).
 *
 * Pattern A cost 10 (charged before obj check). Returns
 * { kind: 'Long', value: preHeader.timestamp }.
 *
 * Source: ergotree-interpreter/src/eval/spreheader.rs:20-24
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { PropertyCall as PropertyCallExpr, PreHeader } from '../../src/mir/types'

function syntheticPreHeader(timestamp: bigint): PreHeader {
  return {
    version: 3,
    parentId: new Uint8Array(32),
    timestamp,
    nBits: 0x18000000,
    height: 1000000,
    minerPk: new Uint8Array(33),
    votes: new Uint8Array(3),
  }
}

describe('SPreHeader.timestamp handler (Layer C1)', () => {
  it('returns timestamp as Long; chain Context.preHeader.timestamp charges 34', () => {
    const preHeader = syntheticPreHeader(1700000000000n)
    const ctx = makeContext({ preHeader })
    // Outer PropertyCall: SPreHeader.timestamp on the inner result
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SPreHeader' },
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: innerPreHeader,
      typeId: 105,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SLong' },
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Long', value: 1700000000000n })
    // 4 (outer disp) + 4 (inner disp) + 1 (Context arm) + 15 (preHeader handler) + 10 (timestamp handler) = 34
    expect(ctx.jitCost).toBe(34)
  })

  it('boundary: timestamp near i64::MAX passes through unchanged', () => {
    const max = 9223372036854775807n // i64::MAX
    const preHeader = syntheticPreHeader(max)
    const ctx = makeContext({ preHeader })
    const innerPreHeader: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' },
      typeId: 101,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SPreHeader' },
    }
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: innerPreHeader,
      typeId: 105,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SLong' },
    }
    const result = evalPropertyCall(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Long', value: max })
  })

  it('rejects when obj is not PreHeader', () => {
    const ctx = makeContext({})
    const e: PropertyCallExpr = {
      tag: 'PropertyCall',
      obj: { tag: 'Context' }, // returns { kind: 'Context' }, not PreHeader
      typeId: 105,
      methodId: 3,
      explicitTypeArgs: {},
      tpe: { tag: 'SLong' },
    }
    expect(() => evalPropertyCall(e, Env.empty(), ctx)).toThrowError(EvalError)
  })
})

interface TimestampEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface TimestampFixture {
  corpus: string
  entries: TimestampEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/spreheader-timestamp.json')
const fixture: TimestampFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SPreHeader.timestamp — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value_json))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 3: Run test to verify RED**

Run: `cd packages/ergoscript && npx vitest run test/eval/spreheader-timestamp.test.ts`

Expected: RED on first `it()` (no handler for `105:3`).

- [ ] **Step 4: Register the `SPreHeader.timestamp` handler in `method-call.ts`**

Inside `registerHandlers()`, add:

```ts
  // SPreHeader.timestamp (PropertyCall, typeId=105, methodId=3)
  // Source: ergotree-interpreter/src/eval/spreheader.rs:20-24 — TIMESTAMP_EVAL_FN
  // Pattern A cost 10 (charged before obj check). Returns Long.
  HANDLERS.set(handlerKey(105, 3), (obj, _args, ctx, _explicitTypeArgs) => {
    ctx.addCost(10)
    if (obj.kind !== 'PreHeader') {
      throw new EvalError(
        `SPreHeader.timestamp expects a PreHeader obj; got '${obj.kind}'`,
        'method-not-implemented'
      )
    }
    return { kind: 'Long', value: obj.value.timestamp }
  })
```

- [ ] **Step 5: Run inline tests to confirm GREEN**

Run: `cd packages/ergoscript && npx vitest run test/eval/spreheader-timestamp.test.ts -t "Layer C1"`

Expected: all 3 inline-test cases pass.

- [ ] **Step 6: Create fixture-gen Rust file**

Create `fixture-gen/src/cmds/ergoscript/eval/spreheader_timestamp.rs`:

```rust
//! SPreHeader.timestamp handler — fixtures.
//!
//! Sigma-rust ref: `ergotree-interpreter/src/eval/spreheader.rs:20-24`
//! Method registration: `ergotree-ir/src/types/spreheader.rs::TIMESTAMP_PROPERTY`
//!
//! Pattern A cost 10. Returns Long.

use ergotree_interpreter::eval::test_util::try_eval_out;
use ergotree_ir::chain::context::Context;
use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::scontext::PRE_HEADER_PROPERTY;
use ergotree_ir::types::spreheader::TIMESTAMP_PROPERTY;
use serde_json::json;
use sigma_test_util::force_any_val;

use super::common::{preheader_to_json, value_to_json, EvalFixture, EvalFixtureFile};

pub fn generate() -> anyhow::Result<EvalFixtureFile> {
    let mut entries = Vec::new();

    // Tree: PropertyCall(PropertyCall(Context, preHeader), timestamp)
    let pre_header_expr: Expr = PropertyCall::new(Expr::Context, PRE_HEADER_PROPERTY.clone())
        .unwrap()
        .into();
    let expr: Expr = PropertyCall::new(pre_header_expr, TIMESTAMP_PROPERTY.clone())
        .unwrap()
        .into();
    let tree = ErgoTree::new(ErgoTreeHeader::v0(false), &expr)?;
    let tree_bytes_hex = hex::encode(tree.sigma_serialize_bytes()?);

    let ctx = force_any_val::<Context>();
    let val: ergotree_ir::mir::value::Value<'static> = try_eval_out(&tree.proposition()?, &ctx)?;
    let cost = ctx.jit_cost_value();

    let opts_json = json!({
        "preHeader": preheader_to_json(&ctx.pre_header),
    });

    entries.push(EvalFixture {
        name: "context_pre_header_timestamp".to_string(),
        tree_bytes_hex,
        opts_json,
        expected_value_json: value_to_json(&val),
        expected_cost: cost,
    });

    Ok(EvalFixtureFile {
        corpus: "eval_spreheader_timestamp",
        entries,
    })
}
```

- [ ] **Step 7: Wire + generate + verify**

Wire `pub mod spreheader_timestamp;` in `mod.rs` and `generate_and_write("eval/spreheader-timestamp.json", ...)` in `main.rs`.

Run: `cd fixture-gen && cargo build && cargo run`
Run: `cd packages/ergoscript && npx vitest run test/eval/spreheader-timestamp.test.ts`
Run: `cd fixture-gen && cargo run && git -C .. diff --stat packages/ergoscript/test/fixtures/eval/spreheader-timestamp.json`
Run: `cd packages/ergoscript && npx tsc --noEmit`

Expected: clean build; all tests pass; no fixture diff; zero TS errors.

- [ ] **Step 8: Commit**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/test/eval/spreheader-timestamp.test.ts \
        packages/ergoscript/test/fixtures/eval/spreheader-timestamp.json \
        fixture-gen/src/cmds/ergoscript/eval/spreheader_timestamp.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs
git commit -m "$(cat <<'EOF'
feat(ergoscript): phase 2g.6 Task 7 — SPreHeader.timestamp handler

Registers PropertyCall(PreHeader, timestamp) (typeId 105, methodId 3) in the
eval/method-call.ts HANDLERS map. Pattern A cost 10 (chained total 34:
4 outer disp + 4 inner disp + 1 Context arm + 15 preHeader handler + 10
timestamp handler). Returns Long; PreHeader.timestamp already bigint so no
i64-cast needed (boundary fixture validates i64::MAX passthrough).

Unlocks 7 mainnet boxes per Task B's survey (4 must-include + 3 random).
Completes the 5-method handler scope; Task 8 is verification + docs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `facts/ergoscript.md` update + wider-corpus re-survey + final regression sweep

**Files:**
- Modify: `facts/ergoscript.md` (coverage 51 → 52 arms; method handlers 3 → 8; 2 new SValue variants; cross-reference 2g.6 spec)
- Modify: `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (annotate 2g.6 row ✅ COMPLETE)
- Modify: `packages/ergoscript/scripts/_known-methods.ts` (mark 5 methods `implemented: true`)
- Regenerate: `docs/specs/2026-05-18-task-b-corpus-survey-tally.json` (verification — re-run the analyzer)
- Modify: `PLAN.md` (mark phase complete)

No new test or fixture files. This is verification + documentation.

- [ ] **Step 1: Update `facts/ergoscript.md`**

Read the file and locate the coverage statement (likely a section like "Internal Expr arms: 51 of ~70"). Update to:
- "Internal Expr arms: 52 of ~70" (was 51; +1 Global)
- "Method-call handler registry: 8 entries" (was 3; +5)
- "EvalError codes: 43" (unchanged from 2g.5)
- SValue variants: add `Global` and `PreHeader` to the enumerated list
- Add `EvalOpts.preHeader?: PreHeader` to the public surface notes (already there from 2f-medium — confirm wording)
- Cross-reference `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` in the changelog/history section

- [ ] **Step 2: Update umbrella spec**

Edit `docs/specs/2026-05-13-ergoscript-interpreter-design.md`. Find the "Phase 2g.6" row in the phase plan table and update its "Done criterion" cell to start with `✅ shipped 2026-05-XX` (use today's date). Mirror the wording style of the existing 2g.5 / 2g-combinators rows.

- [ ] **Step 3: Update `_known-methods.ts` — mark the 5 methods implemented**

Edit `packages/ergoscript/scripts/_known-methods.ts`. Find the 5 entries:
- `(106, 1)` SGlobal.groupGenerator
- `(12, 29)` SColl.zip
- `(12, 14)` SColl.indices
- `(101, 3)` SContext.preHeader
- `(105, 3)` SPreHeader.timestamp

Change each from `implemented: false` to `implemented: true`. If there's a `phaseTag` or similar field, set it to `'2g.6'`.

- [ ] **Step 4: Re-run the corpus analyzer**

Run: `cd /home/mwaddip/projects/ergots && npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts`

Expected: the script regenerates `docs/specs/2026-05-18-task-b-corpus-survey-results.md` and `docs/specs/2026-05-18-task-b-corpus-survey-tally.json`. In the regenerated tally JSON:
- The 5 methods flip from `implemented: false` → `implemented: true`.
- `unimplementedHits` for tag `Global` drops from 120 to 0 (since the Global arm is now wired).
- All other counts unchanged from the 2026-05-18 baseline.

Diff the regenerated files against committed:

```bash
git -C /home/mwaddip/projects/ergots diff docs/specs/2026-05-18-task-b-corpus-survey-tally.json | head -100
```

Expected diff: only the 5 `implemented` flags + the Global `unimplementedHits` line. If unexpected changes appear, investigate — may indicate a regression in the walker or `_known-methods` accounting.

- [ ] **Step 5: Run the full test suite**

Run: `cd /home/mwaddip/projects/ergots && npm test`

Expected: all tests pass under both node + jsdom. Test count should be ergoscript 2627 + 5×N (where N is the number of new fixture/inline tests added per task) + proof 305. Confirm the exact count matches what was added in Tasks 1-7.

- [ ] **Step 6: Run TypeScript check**

Run: `cd /home/mwaddip/projects/ergots/packages/ergoscript && npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 7: Run Rust tests + determinism check**

Run: `cd /home/mwaddip/projects/ergots/fixture-gen && cargo test && cargo run`

Then:

```bash
git -C /home/mwaddip/projects/ergots diff --stat packages/ergoscript/test/fixtures/
```

Expected: cargo test passes; cargo run produces zero fixture diffs (full determinism across all 6 new + all existing fixtures).

- [ ] **Step 8: Update PLAN.md to mark phase complete**

Edit `PLAN.md` at repo root. Add a status line at the top below the title:

```markdown
**Status: ✅ COMPLETE 2026-05-XX** (5 method handlers + Global arm + 2 SValue variants shipped; wider-corpus re-survey confirms 5 methods now `implemented: true`; full test suite green under node + jsdom; fixture-gen determinism preserved.)
```

- [ ] **Step 9: Commit the verification sweep**

```bash
git add facts/ergoscript.md \
        docs/specs/2026-05-13-ergoscript-interpreter-design.md \
        docs/specs/2026-05-18-task-b-corpus-survey-results.md \
        docs/specs/2026-05-18-task-b-corpus-survey-tally.json \
        packages/ergoscript/scripts/_known-methods.ts \
        PLAN.md
git commit -m "$(cat <<'EOF'
docs(ergoscript): phase 2g.6 complete — facts + umbrella + corpus re-survey

Coverage: 51 → 52 Expr arms; method handlers 3 → 8; 2 new SValue variants
(Global sentinel, PreHeader value carrier). Zero new EvalError codes (43).

Wider-corpus re-survey confirms the 5 methods (groupGenerator, zip, indices,
preHeader, timestamp) now show implemented: true in the tally JSON, and the
Global tag's unimplementedHits count drops from 120 to 0.

Full test suite green under node + jsdom; fixture-gen determinism preserved
across all 6 new + all existing fixtures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Update SESSION_CONTEXT.md + memory**

Update `packages/ergoscript/SESSION_CONTEXT.md` (gitignored) to reflect "Phase 2g.6 complete; coverage 52/~70 arms; method handlers 8; next: phase 2h (AVL+) or 2i (predefs) per user".

Update memory file at `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` to reflect the new state.

Update MEMORY.md hook line for `project_ergots_direction` to note 2g.6 shipped.

(No commit — these are local-only artifacts.)

---

## Self-review (run before declaring the plan ready)

After implementing all 8 tasks, re-check:

1. **Spec coverage:** The design spec's 5 methods + 1 Expr arm + 2 SValue variants + 0 new error codes are all delivered (Tasks 1-7), plus verification sweep (Task 8). ✓
2. **Type consistency:** `evalGlobal` (Task 1 / `eval/global.ts`), `evalMethodCall` / `evalPropertyCall` (Tasks 2-7 / `eval/method-call.ts`), `handlerKey` (existing), `HANDLERS` (existing), `MethodCall` / `PropertyCall` MIR interfaces (existing from phase 2a) — all consistent across tasks.
3. **No placeholders:** Every step has actual code or actual commands. Where the implementer needs to confirm an interface field set (e.g., `PreHeader.timestamp` field names), the spec explicitly says so with a re-read instruction.
4. **Cost-arithmetic cross-check:** Task 2 (groupGenerator) expects 19. Task 6 (preHeader) expects 20. Task 7 (timestamp) expects 34. The fixture-driven oracle confirms each — if any inline-test expectation is off, the fix is to align the inline test with the oracle, not the other way around.
5. **Source-read discipline:** Every task starts with a `sed -n` to confirm sigma-rust HEAD hasn't drifted from this plan's recorded cost values. Drift triggers OVERRIDES rule #2 escalation.
6. **TDD discipline:** Every task follows red (failing test) → green (minimal implementation) → commit. Per-task commits land green tests + per-task scope. No batched commits.
