# Phase 2g.5 Implementation Plan — `@ergots/ergoscript`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship phase 2g.5: the `MethodCall`/`PropertyCall` dispatcher infrastructure plus the minimum method handlers + supporting arms required to fully unlock the C2 corpus. Net additions: 4 new Expr arms (47 → 51 of ~70: `Context`, `SigmaPropBytes`, `MethodCall`, `PropertyCall`); 1 new `SValue` variant (`{ kind: 'Context' }`); 3 method handlers registered in a new per-method registry (`SBox.tokens`, `SContext.dataInputs`, `SColl.indexOf`); 3 new `EvalError` codes (40 → 43); 1 new optional `EvalOpts` field (`dataInputs?: ErgoBox[]`); C2 corpus goes from `success=0/18` to `success=18/18`.

**Architecture:** 8 tasks in flat ordering with commits between each (no `Stop α/β/γ` markers — per `[[feedback-no-artificial-stops]]` memory). Task 1 = `SValue.Context` variant + `Context` Expr arm (foundation; Task 5 depends). Task 2 = `SigmaPropBytes` arm (independent; unblocks the 1 corpus entry that hits it). Task 3 = dispatcher skeleton + handler-registry module (no registered handlers yet; throws `'method-not-implemented'`). Tasks 4–6 = the 3 registered handlers, one per task. Task 7 = corpus-eval test context provisioning + assert `success === 18`. Task 8 = `facts/ergoscript.md` update + full regression sweep. Per OVERRIDES #2: no confidence-escalation territory in this slice — method-call dispatch is straightforward source-port; SigmaPropBytes reuses the 2g-combinators prop-bytes builder.

**Tech Stack:** TypeScript 5.5 (ES2022, ESM only), Vitest 2 with jsdom, Rust fixture-gen calling into sigma-rust's `ergotree-interpreter` at `integration/ergots@ed5452cf`. No new TypeScript runtime deps. No new Rust deps beyond the existing fixture-gen workspace (`gf2_192` already added in 2g-combinators).

**Source-first discipline:** Read sigma-rust per task before writing any TS. Authoritative sources:

- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs:38` — `Context` arm (`add_jit_cost(1)`, returns `Value::Context`).
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sigma_prop_bytes.rs:9-24` — `SigmaPropBytes` arm (`add_per_item_jit_cost(35, 6, 1, 1)` Pattern A; returns `sigma_prop.prop_bytes()`).
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/method_call.rs:11-23` — `MethodCall` dispatcher (`add_jit_cost(4)` Pattern A; eval obj; eval args; call handler).
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/property_call.rs:10-20` — `PropertyCall` dispatcher (same shape with empty args).
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sbox.rs:72-79` — `TOKENS_EVAL_FN` (`add_jit_cost(15)`; returns box's `tokens_raw()`).
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scontext.rs:17-31` — `DATA_INPUTS_EVAL_FN` (`add_jit_cost(15)`; validates `obj == Value::Context`; returns `ctx.data_inputs.clone().map_or(Arc::new([]), ...)`).
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:21-50` — `INDEX_OF_EVAL_FN` (`add_per_item_jit_cost(20, 10, 2, n)` Pattern B after Coll extraction; clamps `from < 0` to 0; returns `-1` if not found).

Design spec: `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md`.

**TDD discipline:** Iron Law per `CLAUDE.md` — no production code without a failing test first. Each task follows red → green → fixture-driven assert → commit.

**Subagent dispatch suggestion:** Sonnet is sufficient for all 8 tasks (no novel crypto; reuse-heavy). Opus only if Task 3 (dispatcher) takes longer than expected and the registry shape needs revisiting.

---

## File Structure

**New files (TypeScript source):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/src/eval/context.ts` | `evalContext` arm (cost 1, returns `{ kind: 'Context' }`) | 1 |
| `packages/ergoscript/src/eval/sigma-prop-bytes.ts` | `evalSigmaPropBytes` arm | 2 |
| `packages/ergoscript/src/eval/method-call.ts` | Dispatcher (`evalMethodCall` + `evalPropertyCall`) + handler registry + 3 inline handlers | 3, 4, 5, 6 |
| `packages/ergoscript/src/sigma/prop-bytes.ts` (optional) | Extracted `propBytesOf` helper if Task 2 chooses to factor it from `sigma/fiat-shamir.ts` | 2 |

**Modified files (TypeScript source):**

| Path | Change | Task |
|---|---|---|
| `packages/ergoscript/src/mir/types.ts` | Add `{ kind: 'Context' }` to `SValue` union | 1 |
| `packages/ergoscript/src/eval/eval.ts` | Add 4 new case lines: `Context`, `SigmaPropBytes`, `MethodCall`, `PropertyCall` | 1, 2, 3 |
| `packages/ergoscript/src/eval/errors.ts` | Add 3 new EvalError codes: `'method-not-implemented'`, `'context-obj-not-context'`, `'sigma-prop-bytes-input-not-sigma-prop'` | 2, 3, 5 |
| `packages/ergoscript/src/eval/eval-context.ts` | Add `dataInputs?: ErgoBox[]` field to `EvalOpts`; thread through `makeContext` | 5 |

**New files (TypeScript tests):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/test/eval/context.test.ts` | C1 fixture: `Context` Expr → `{ kind: 'Context' }`, cost = 1 | 1 |
| `packages/ergoscript/test/eval/sigma-prop-bytes.test.ts` | C1 fixture: TrivialProp(true/false), ProveDlog, Cand/Cor conjecture inputs | 2 |
| `packages/ergoscript/test/eval/method-call.test.ts` | C1 fixtures for 3 handlers + dispatcher cost test + unknown-pair reject | 3, 4, 5, 6 |

**Modified files (TypeScript tests):**

| Path | Change | Task |
|---|---|---|
| `packages/ergoscript/test/corpus-eval.test.ts` | Provide synthetic-context stubs; assert `evalSuccess === 18` | 7 |

**New fixture-gen files:**

| Path | Responsibility | Task |
|---|---|---|
| `fixture-gen/src/cmds/ergoscript/eval/context.rs` | `Context` arm fixture (cost 1) | 1 |
| `fixture-gen/src/cmds/ergoscript/eval/sigma_prop_bytes.rs` | `SigmaPropBytes` fixtures across SigmaBoolean surface | 2 |
| `fixture-gen/src/cmds/ergoscript/eval/method_call.rs` | 3 handler fixtures + unknown-pair structural fixture (TS-only, since sigma-rust would build-fail on unknown method) | 3, 4, 5, 6 |

**Modified fixture-gen files:**

| Path | Change | Task |
|---|---|---|
| `fixture-gen/src/cmds/ergoscript/eval/mod.rs` | Add 3 new `pub mod` lines | 1, 2, 3 |
| `fixture-gen/src/main.rs` | Add new `generate_and_write` calls | 1, 2, 3 |

**Fixture corpora (committed to TS test/fixtures/eval/):**

| Path | Owner | Task |
|---|---|---|
| `packages/ergoscript/test/fixtures/eval/context.json` | `Context` arm C1 | 1 |
| `packages/ergoscript/test/fixtures/eval/sigma-prop-bytes.json` | `SigmaPropBytes` C1 across SigmaBoolean surface | 2 |
| `packages/ergoscript/test/fixtures/eval/method-call.json` | 3 handler sub-cases + dispatcher edge cases | 3, 4, 5, 6 |

---

## Task 1: `SValue.Context` variant + `Context` Expr eval arm

**Files:**
- Modify: `packages/ergoscript/src/mir/types.ts` (SValue union, ~line 818)
- Create: `packages/ergoscript/src/eval/context.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add `case 'Context':`)
- Create: `packages/ergoscript/test/eval/context.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/context.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/context.json` (via fixture-gen)

**Sigma-rust source-read (REQUIRED before writing any TS):**

```bash
sed -n '36,42p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs
```

Expected: `Expr::Context => { ctx.add_jit_cost(1)?; Ok(Value::Context) }` at line 38.

- [ ] **Step 1: Add `Context` variant to `SValue` union.** Edit `packages/ergoscript/src/mir/types.ts`, find the `SValue` union (around line 818, search for `kind: 'Boolean'`), and add a new line:

```ts
  | { kind: 'Context' }
```

Insert after `{ kind: 'Unit' }` so unit-shaped variants stay grouped.

- [ ] **Step 2: Write the failing test** in `packages/ergoscript/test/eval/context.test.ts`:

```ts
/**
 * Layer C1 — `Context` Expr arm.
 *
 * Trivial arm: cost 1 (Pattern A); returns `{ kind: 'Context' }` SValue sentinel.
 * Source: ergotree-interpreter/src/eval/expr.rs:38.
 */

import { describe, expect, it } from 'vitest'
import { evalContext } from '../../src/eval/context'
import { Env } from '../../src/eval/env'
import { makeContext } from '../../src/eval/eval-context'
import type { Context as ContextExpr } from '../../src/mir/types'

describe('evalContext (Layer C1)', () => {
  it('returns { kind: "Context" } and charges cost 1', () => {
    const ctx = makeContext({})
    const e: ContextExpr = { tag: 'Context' }
    const result = evalContext(e, Env.empty(), ctx)
    expect(result).toEqual({ kind: 'Context' })
    expect(ctx.jitCost).toBe(1)
  })
})
```

- [ ] **Step 3: Run the test — confirm it fails.**

```bash
cd packages/ergoscript && npx vitest run test/eval/context.test.ts
```

Expected: FAIL with `Cannot find module '../../src/eval/context'`.

- [ ] **Step 4: Implement `evalContext`** in `packages/ergoscript/src/eval/context.ts`:

```ts
/**
 * `Context` evaluator arm — returns the `Value::Context` sentinel.
 *
 * Trivial: cost 1 (Pattern A) per `expr.rs:38`. The sentinel is consumed
 * by handlers that need to type-check their obj (currently `SContext.dataInputs`).
 *
 * Source: ergotree-interpreter/src/eval/expr.rs:38
 */

import type { Context as ContextExpr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalContext(_e: ContextExpr, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(1)
  return { kind: 'Context' }
}
```

- [ ] **Step 5: Wire the case in `eval/eval.ts`.** Find the alphabetically-appropriate spot (between `case 'ConstPlaceholder':` and `case 'Downcast':`) and add:

```ts
    case 'Context':
      return evalContext(e, env, ctx)
```

Also add the import at the top of `eval.ts` (alphabetical order):

```ts
import { evalContext } from './context'
```

- [ ] **Step 6: Run the test — confirm it passes.**

```bash
cd packages/ergoscript && npx vitest run test/eval/context.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 7: Add the Rust fixture-gen command** in `fixture-gen/src/cmds/ergoscript/eval/context.rs`:

```rust
//! `Context` Expr arm fixture — cost 1, returns Value::Context (synthesized as null in JSON).

use ergotree_ir::mir::expr::Expr;
use ergotree_ir::serialization::SigmaSerializable;
use serde_json::json;

use crate::cmds::ergoscript::eval::eval_with_synthetic_empty;

pub fn generate() -> serde_json::Value {
    let expr: Expr = Expr::Context;
    let tree_bytes = expr.sigma_serialize_bytes().unwrap();
    let tree_hex = hex::encode(&tree_bytes);
    let (value_json, jit_cost) = eval_with_synthetic_empty(&expr).expect("Context should eval");
    json!({
        "name": "context-trivial",
        "tree_hex": tree_hex,
        "expected_value": value_json,
        "expected_cost": jit_cost,
    })
}
```

(If `eval_with_synthetic_empty` doesn't already exist as a shared helper, factor it from a prior eval command; same pattern as existing eval fixture generators.)

- [ ] **Step 8: Wire the new fixture into mod + main.** In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, add:

```rust
pub mod context;
```

In `fixture-gen/src/main.rs`, find the eval-fixture generation block and add:

```rust
generate_and_write(
    "packages/ergoscript/test/fixtures/eval/context.json",
    json!({ "entries": [crate::cmds::ergoscript::eval::context::generate()] }),
)?;
```

- [ ] **Step 9: Run fixture-gen.** Two-run determinism check:

```bash
cd fixture-gen && cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/context.json
cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/context.json
```

Expected: file generated first run; zero diff on second run.

- [ ] **Step 10: Extend `context.test.ts` with the fixture-driven assertion.** Append to the existing describe block:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/eval/context.json'), 'utf8')
) as { entries: Array<{ name: string; tree_hex: string; expected_value: unknown; expected_cost: number }> }

describe('evalContext fixture entries', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_hex))
      const ctx = makeContext({ constants: tree.constants })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 11: Run the full ergoscript test suite — confirm zero regressions.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: existing test count + new tests; zero failures.

- [ ] **Step 12: Commit.**

```bash
git add packages/ergoscript/src/mir/types.ts \
        packages/ergoscript/src/eval/context.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/context.test.ts \
        packages/ergoscript/test/fixtures/eval/context.json \
        fixture-gen/src/cmds/ergoscript/eval/context.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): Context Expr arm + SValue.Context variant (phase 2g.5 task 1)

Trivial arm: cost 1 Pattern A; returns { kind: 'Context' } SValue sentinel.
Required for SContext.dataInputs handler (Task 5) which type-checks obj.kind === 'Context'.

Source: ergotree-interpreter/src/eval/expr.rs:38.

Coverage: 47 → 48 of ~70 arms.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `SigmaPropBytes` Expr eval arm

**Files:**
- Create: `packages/ergoscript/src/eval/sigma-prop-bytes.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add `case 'SigmaPropBytes':`)
- Modify: `packages/ergoscript/src/eval/errors.ts` (add `'sigma-prop-bytes-input-not-sigma-prop'`)
- Create: `packages/ergoscript/test/eval/sigma-prop-bytes.test.ts`
- Create: `fixture-gen/src/cmds/ergoscript/eval/sigma_prop_bytes.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Optional: `packages/ergoscript/src/sigma/prop-bytes.ts` (factor `propBytesOf` from `sigma/fiat-shamir.ts` if convenient)

**Sigma-rust source-read:**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sigma_prop_bytes.rs
```

Key: `add_per_item_jit_cost(35, 6, 1, 1)` BEFORE eval-children (Pattern A); extract SigmaProp from input; call `sigma_prop.prop_bytes()`.

**Decide on `propBytesOf` reuse path:** Read `packages/ergoscript/src/sigma/fiat-shamir.ts` and check if there's an exported function that serializes a SigmaBoolean to its prop-bytes form (added in 2g-medium / 2g-combinators). If not exported, either:
(a) Add an export from `sigma/fiat-shamir.ts` for the existing internal builder.
(b) Factor it into a new `sigma/prop-bytes.ts` module.

Pick whichever reads naturally from the existing fiat-shamir module. Both options are functionally equivalent.

- [ ] **Step 1: Read source + decide propBytesOf path.** Note the decision in commit message.

- [ ] **Step 2: Add error code** in `packages/ergoscript/src/eval/errors.ts`. Find the `EvalErrorCode` union and add:

```ts
  | 'sigma-prop-bytes-input-not-sigma-prop'
```

- [ ] **Step 3: Write the failing test** in `packages/ergoscript/test/eval/sigma-prop-bytes.test.ts`:

```ts
/**
 * Layer C1 — `SigmaPropBytes` Expr arm.
 *
 * Pattern A cost: addPerItemCost(35, 6, 1, 1) BEFORE eval-children.
 * Returns Coll[Byte] = SigmaBoolean.prop_bytes() serialization.
 * Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs:9-24.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evalSigmaPropBytes } from '../../src/eval/sigma-prop-bytes'
import { Env } from '../../src/eval/env'
import { hexToBytes, hydrateSValue } from '../_helpers'
import type { SigmaPropBytes } from '../../src/mir/types'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/eval/sigma-prop-bytes.json'), 'utf8')
) as { entries: Array<{ name: string; tree_hex: string; expected_value: unknown; expected_cost: number }> }

describe('evalSigmaPropBytes — defensive throws', () => {
  it("throws 'sigma-prop-bytes-input-not-sigma-prop' when input evaluates to non-SigmaProp", () => {
    // Build a SigmaPropBytes Expr whose input is a Const(SBoolean, true) — not a SigmaProp.
    const e: SigmaPropBytes = {
      tag: 'SigmaPropBytes',
      input: { tag: 'Const', tpe: { tag: 'SBoolean' }, value: { kind: 'Boolean', value: true } },
    }
    const ctx = makeContext({})
    expect(() => evalSigmaPropBytes(e, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalSigmaPropBytes(e, Env.empty(), ctx)
    } catch (err) {
      expect((err as EvalError).code).toBe('sigma-prop-bytes-input-not-sigma-prop')
    }
  })
})

describe('evalSigmaPropBytes fixture entries', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_hex))
      const ctx = makeContext({ constants: tree.constants })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

- [ ] **Step 4: Run the test — confirm it fails.**

```bash
cd packages/ergoscript && npx vitest run test/eval/sigma-prop-bytes.test.ts
```

Expected: FAIL with module-not-found AND fixture-not-found.

- [ ] **Step 5: Implement `evalSigmaPropBytes`** in `packages/ergoscript/src/eval/sigma-prop-bytes.ts`:

```ts
/**
 * `SigmaPropBytes` evaluator arm — serializes a SigmaProp to its byte form.
 *
 * Pattern A cost: addPerItemCost(35, 6, 1, 1) BEFORE eval-children.
 * Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs:15-23.
 *
 * The `prop_bytes` serialization is the same as the Fiat-Shamir leaf prop-bytes
 * (added in 2g-medium / 2g-combinators) — reuses `propBytesOf` from `sigma/...`.
 *
 * Error codes:
 *   'sigma-prop-bytes-input-not-sigma-prop' — input evaluates to non-SigmaProp
 *   'cost-limit-exceeded' — cost exceeds jitCostLimit
 */

import type { SigmaPropBytes, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'
import { propBytesOf } from '../sigma/prop-bytes'  // or '../sigma/fiat-shamir' per decision
import { bytesToCollByteSValue } from './_byte-coll'

export function evalSigmaPropBytes(e: SigmaPropBytes, env: Env, ctx: EvalContext): SValue {
  // Pattern A cost charge BEFORE eval-children. Source: sigma_prop_bytes.rs:15.
  ctx.addPerItemCost(35, 6, 1, 1)

  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'SigmaProp') {
    throw new EvalError(
      `SigmaPropBytes expects a SigmaProp input; got '${inputV.kind}'`,
      'sigma-prop-bytes-input-not-sigma-prop'
    )
  }
  return bytesToCollByteSValue(propBytesOf(inputV.value))
}
```

- [ ] **Step 6: Wire the case in `eval/eval.ts`.** Add import and case (alphabetical order):

```ts
import { evalSigmaPropBytes } from './sigma-prop-bytes'
```

```ts
    case 'SigmaPropBytes':
      return evalSigmaPropBytes(e, env, ctx)
```

- [ ] **Step 7: Run the defensive-throw test — confirm it passes (fixture test still fails on missing JSON).**

```bash
cd packages/ergoscript && npx vitest run test/eval/sigma-prop-bytes.test.ts -t "defensive throws"
```

Expected: PASS for the 1 throw test.

- [ ] **Step 8: Write the fixture-gen** in `fixture-gen/src/cmds/ergoscript/eval/sigma_prop_bytes.rs`:

```rust
//! `SigmaPropBytes` C1 fixtures — covers SigmaBoolean surface:
//! TrivialProp(true), TrivialProp(false), ProveDlog, Cand(2 leaves), Cor(2 leaves).

use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::sigma_prop_bytes::SigmaPropBytes;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::sigma_protocol::sigma_boolean::{SigmaBoolean, SigmaProofOfKnowledgeTree, ProveDlog};
use ergotree_ir::sigma_protocol::sigma_boolean::cand::Cand;
use ergotree_ir::sigma_protocol::sigma_boolean::cor::Cor;
use serde_json::json;

use crate::cmds::ergoscript::eval::eval_with_synthetic_empty;

fn entry(name: &str, sp: SigmaBoolean) -> serde_json::Value {
    let c: Constant = sp.into();
    let input_expr: Expr = c.into();
    let expr: Expr = SigmaPropBytes { input: Box::new(input_expr) }.into();
    let tree_bytes = expr.sigma_serialize_bytes().unwrap();
    let (value_json, jit_cost) = eval_with_synthetic_empty(&expr).expect("SigmaPropBytes eval");
    json!({
        "name": name,
        "tree_hex": hex::encode(&tree_bytes),
        "expected_value": value_json,
        "expected_cost": jit_cost,
    })
}

pub fn generate() -> Vec<serde_json::Value> {
    // Deterministic test points; values themselves don't matter — we cross-validate prop_bytes byte-for-byte.
    let dlog1 = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(
        ProveDlog::from_bytes(&[1u8; 33]).unwrap(),
    ));
    let dlog2 = SigmaBoolean::ProofOfKnowledge(SigmaProofOfKnowledgeTree::ProveDlog(
        ProveDlog::from_bytes(&[2u8; 33]).unwrap(),
    ));

    vec![
        entry("trivial-true", SigmaBoolean::TrivialProp(true)),
        entry("trivial-false", SigmaBoolean::TrivialProp(false)),
        entry("prove-dlog", dlog1.clone()),
        entry(
            "cand-2-leaves",
            SigmaBoolean::SigmaConjecture(Cand::normalized(vec![dlog1.clone(), dlog2.clone()]).into()),
        ),
        entry(
            "cor-2-leaves",
            SigmaBoolean::SigmaConjecture(Cor::normalized(vec![dlog1, dlog2]).into()),
        ),
    ]
}
```

(Imports may need adjusting for exact sigma-rust paths; verify against the existing fixture-gen modules.)

- [ ] **Step 9: Wire mod + main.** Add `pub mod sigma_prop_bytes;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs`. Add to `main.rs`:

```rust
generate_and_write(
    "packages/ergoscript/test/fixtures/eval/sigma-prop-bytes.json",
    json!({ "entries": crate::cmds::ergoscript::eval::sigma_prop_bytes::generate() }),
)?;
```

- [ ] **Step 10: Run fixture-gen with two-run determinism check.**

```bash
cd fixture-gen && cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/sigma-prop-bytes.json
cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/sigma-prop-bytes.json
```

Expected: file generated first run; zero diff on second run.

- [ ] **Step 11: Run the full test file.**

```bash
cd packages/ergoscript && npx vitest run test/eval/sigma-prop-bytes.test.ts
```

Expected: PASS (1 defensive test + 5 fixture entries = 6 tests).

- [ ] **Step 12: Run the full ergoscript test suite.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: zero regressions; existing test count + 6 new tests.

- [ ] **Step 13: Commit.**

```bash
git add packages/ergoscript/src/eval/sigma-prop-bytes.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/src/eval/errors.ts \
        packages/ergoscript/test/eval/sigma-prop-bytes.test.ts \
        packages/ergoscript/test/fixtures/eval/sigma-prop-bytes.json \
        fixture-gen/src/cmds/ergoscript/eval/sigma_prop_bytes.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs

# If propBytesOf was factored into a new module, also stage it:
#   packages/ergoscript/src/sigma/prop-bytes.ts
#   packages/ergoscript/src/sigma/fiat-shamir.ts  (if extracted from here)

git commit -m "$(cat <<'EOF'
feat(ergoscript): SigmaPropBytes Expr arm (phase 2g.5 task 2)

Pattern A cost: addPerItemCost(35, 6, 1, 1) before eval-children.
Reuses 2g-medium/2g-combinators prop_bytes builder for SigmaBoolean serialization.

New EvalError code (40 → 41): 'sigma-prop-bytes-input-not-sigma-prop'.

Source: ergotree-interpreter/src/eval/sigma_prop_bytes.rs:9-24.

Fixtures: TrivialProp(true/false), ProveDlog, Cand(2-leaf), Cor(2-leaf).

Coverage: 48 → 49 of ~70 arms.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `MethodCall` + `PropertyCall` dispatcher skeleton

**Files:**
- Create: `packages/ergoscript/src/eval/method-call.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` (add 2 cases)
- Modify: `packages/ergoscript/src/eval/errors.ts` (add `'method-not-implemented'`)
- Create: `packages/ergoscript/test/eval/method-call.test.ts` (dispatcher cost + unknown-pair tests only)

This task ships the dispatcher infrastructure + handler-registry abstraction with ZERO registered handlers. Tasks 4–6 register the 3 handlers one at a time.

**Sigma-rust source-read:**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/method_call.rs
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/property_call.rs
```

Key:
- `method_call.rs:17`: `add_jit_cost(4)` BEFORE eval-children (Pattern A).
- `property_call.rs:16`: same.
- Both dispatch via `smethod_eval_fn(&self.method)` after eval obj + args.

- [ ] **Step 1: Add error code** in `packages/ergoscript/src/eval/errors.ts`:

```ts
  | 'method-not-implemented'
```

- [ ] **Step 2: Write failing tests** in `packages/ergoscript/test/eval/method-call.test.ts`:

```ts
/**
 * Layer C1 — `MethodCall` + `PropertyCall` dispatcher.
 *
 * This task ships the dispatcher + registry with ZERO registered handlers.
 * Tests cover the dispatcher's cost-charging and unknown-pair throw.
 *
 * Source: ergotree-interpreter/src/eval/{method_call,property_call}.rs
 */

import { describe, expect, it } from 'vitest'

import { evalMethodCall, evalPropertyCall } from '../../src/eval/method-call'
import { Env } from '../../src/eval/env'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import type { MethodCall, PropertyCall } from '../../src/mir/types'

describe('MethodCall dispatcher — skeleton (no handlers registered)', () => {
  it("charges cost 4 and throws 'method-not-implemented' on unknown pair", () => {
    // PropertyCall with obj = Context, but typeId=255/methodId=255 is unregistered.
    const e: PropertyCall = {
      tag: 'PropertyCall',
      typeId: 255,
      methodId: 255,
      obj: { tag: 'Context' },
    }
    const ctx = makeContext({})
    expect(() => evalPropertyCall(e, Env.empty(), ctx)).toThrow(EvalError)
    try {
      evalPropertyCall(e, Env.empty(), ctx)
    } catch (err) {
      expect((err as EvalError).code).toBe('method-not-implemented')
      expect((err as EvalError).message).toContain('typeId=255')
      expect((err as EvalError).message).toContain('methodId=255')
    }
    // Cost charging: 4 (dispatcher) + 1 (Context arm) = 5; charged in BOTH throws above (× 2).
    // We assert ≥ 4 once, allowing for the obj evaluation to have completed.
    expect(ctx.jitCost).toBeGreaterThanOrEqual(4)
  })

  it("MethodCall variant also throws on unknown pair", () => {
    const e: MethodCall = {
      tag: 'MethodCall',
      typeId: 255,
      methodId: 255,
      obj: { tag: 'Context' },
      args: [],
      explicitTypeArgs: {},
    }
    const ctx = makeContext({})
    expect(() => evalMethodCall(e, Env.empty(), ctx)).toThrow(EvalError)
  })
})
```

The unknown-pair `(typeId=255, methodId=255)` is guaranteed to not collide with any future-registered handler (Tasks 4-6 register at 99:8, 101:1, 12:26).

- [ ] **Step 3: Run the test — confirm it fails.**

```bash
cd packages/ergoscript && npx vitest run test/eval/method-call.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 4: Implement the dispatcher** in `packages/ergoscript/src/eval/method-call.ts`:

```ts
/**
 * `MethodCall` + `PropertyCall` dispatcher — routes to per-method handlers
 * via a (typeId, methodId) registry.
 *
 * Pattern A: cost 4 charged BEFORE eval-children. Source: method_call.rs:17,
 * property_call.rs:16.
 *
 * The registry is module-internal. Tasks 4-6 register handlers below the
 * dispatcher definition (in this same file) — keeping co-location simple
 * while the registry has only 3 entries. Promote to a subdirectory when
 * count grows.
 *
 * Error codes:
 *   'method-not-implemented'    — dispatcher hit a (typeId, methodId) not in the registry;
 *                                  also reused for defensive shape mismatches in registered handlers.
 *   'context-obj-not-context'   — SContext.dataInputs got a non-Context obj (Task 5).
 *   'cost-limit-exceeded'       — cost exceeds jitCostLimit.
 */

import type { MethodCall, PropertyCall, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

type MethodHandler = (
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>
) => SValue

function handlerKey(typeId: number, methodId: number): string {
  return `${typeId}:${methodId}`
}

const HANDLERS = new Map<string, MethodHandler>()

export function evalMethodCall(e: MethodCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4)  // Pattern A; source: method_call.rs:17
  const obj = evalExpr(e.obj, env, ctx)
  const args = e.args.map((a) => evalExpr(a, env, ctx))
  return dispatch(e.typeId, e.methodId, obj, args, ctx, e.explicitTypeArgs)
}

export function evalPropertyCall(e: PropertyCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4)  // Pattern A; source: property_call.rs:16
  const obj = evalExpr(e.obj, env, ctx)
  return dispatch(e.typeId, e.methodId, obj, [], ctx, {})
}

function dispatch(
  typeId: number,
  methodId: number,
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>
): SValue {
  const handler = HANDLERS.get(handlerKey(typeId, methodId))
  if (!handler) {
    throw new EvalError(
      `method not implemented: typeId=${typeId}, methodId=${methodId}`,
      'method-not-implemented'
    )
  }
  return handler(obj, args, ctx, explicitTypeArgs)
}

// ---------- Handler registration ----------

function registerHandlers(): void {
  // Tasks 4-6 add registrations here.
}

registerHandlers()
```

- [ ] **Step 5: Wire the cases in `eval/eval.ts`.** Add imports and 2 cases:

```ts
import { evalMethodCall, evalPropertyCall } from './method-call'
```

```ts
    case 'MethodCall':
      return evalMethodCall(e, env, ctx)
    case 'PropertyCall':
      return evalPropertyCall(e, env, ctx)
```

- [ ] **Step 6: Run the test — confirm it passes.**

```bash
cd packages/ergoscript && npx vitest run test/eval/method-call.test.ts
```

Expected: PASS (2 tests).

- [ ] **Step 7: Run the full ergoscript test suite.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: zero regressions; existing test count + 2 new tests.

- [ ] **Step 8: Commit.**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/src/eval/errors.ts \
        packages/ergoscript/test/eval/method-call.test.ts

git commit -m "$(cat <<'EOF'
feat(ergoscript): MethodCall/PropertyCall dispatcher skeleton (phase 2g.5 task 3)

Module-internal registry: Map<'typeId:methodId', MethodHandler>. Both
MethodCall and PropertyCall MIR arms route through this dispatcher.
Pattern A cost (addCost(4)) charged before eval-children, per method_call.rs:17
and property_call.rs:16. Throws 'method-not-implemented' for any (typeId, methodId)
not registered. Tasks 4-6 register the 3 handlers.

New EvalError code (41 → 42): 'method-not-implemented'.

Coverage: 49 → 51 of ~70 arms (both MethodCall and PropertyCall now case-handled).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `SBox.tokens` handler (PropertyCall typeId=99, methodId=8)

**Files:**
- Modify: `packages/ergoscript/src/eval/method-call.ts` (register handler + add `tokensCollOf` helper)
- Modify: `packages/ergoscript/test/eval/method-call.test.ts` (add fixture-driven tests)
- Modify: `packages/ergoscript/test/fixtures/eval/method-call.json` (via fixture-gen — created in this task)
- Create: `fixture-gen/src/cmds/ergoscript/eval/method_call.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`

**Sigma-rust source-read:**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sbox.rs
grep -n "TOKENS_METHOD_ID\|TOKENS_METHOD_DESC" ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sbox.rs
```

Key: `TOKENS_EVAL_FN` at `sbox.rs:72-79`. `add_jit_cost(15)` then `obj.try_extract_into::<Ref<ErgoBox>>().tokens_raw()`. Method ID 8.

`box.tokens_raw()` returns `Vec<(Vec<i8>, i64)>` per sigma-rust — equivalent to `Coll[(Coll[Byte], Long)]`.

- [ ] **Step 1: Add the handler registration** in `packages/ergoscript/src/eval/method-call.ts`. Update the `registerHandlers` function:

```ts
function registerHandlers(): void {
  // SBox.tokens (PropertyCall, typeId=99, methodId=8)
  // Source: eval/sbox.rs:72-79 — TOKENS_EVAL_FN
  HANDLERS.set(handlerKey(99, 8), (obj, _args, ctx, _) => {
    ctx.addCost(15)
    if (obj.kind !== 'Box') {
      throw new EvalError(
        `SBox.tokens expects a Box obj; got '${obj.kind}'`,
        'method-not-implemented'  // reuse per error taxonomy (option 1, spec section 'Error taxonomy decision')
      )
    }
    return tokensCollOf(obj.value)
  })
}
```

Update the top-of-file import to add `ErgoBox`:

```ts
import type { ErgoBox, MethodCall, PropertyCall, SType, SValue } from '../mir/types'
```

Add `bytesToCollByteSValue` import:

```ts
import { bytesToCollByteSValue } from './_byte-coll'
```

Add `tokensCollOf` helper below `registerHandlers`:

```ts
// SBox.tokens helper: convert ErgoBox.tokens to Coll[(Coll[Byte], Long)].
// tokens are { id: Uint8Array, amount: bigint }[]; output is a Coll of Tuples.
function tokensCollOf(box: ErgoBox): SValue {
  const sColl: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
  const sLong: SType = { tag: 'SLong' }
  const itemTpe: SType = { tag: 'STuple', items: [sColl, sLong] }
  return {
    kind: 'Coll',
    elem: itemTpe,
    items: box.tokens.map((t) => ({
      kind: 'Tuple',
      items: [
        bytesToCollByteSValue(t.id),
        { kind: 'Long', value: t.amount },
      ],
    })),
  }
}
```

- [ ] **Step 2: Write the failing test** — append to `packages/ergoscript/test/eval/method-call.test.ts`:

```ts
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, synthesizeStubBox } from '../_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface MethodCallFixtureEntry {
  name: string
  tree_hex: string
  ctx?: { self_box_tokens?: Array<{ id: string; amount: string }>; data_inputs_count?: number }
  expected_value: unknown
  expected_cost: number
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../fixtures/eval/method-call.json'), 'utf8')
) as { entries: MethodCallFixtureEntry[] }

describe('method-call fixture entries', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_hex))
      const stubBox = synthesizeStubBox({
        tokens: (entry.ctx?.self_box_tokens ?? []).map((t) => ({
          id: hexToBytes(t.id),
          amount: BigInt(t.amount),
        })),
      })
      const ctx = makeContext({
        constants: tree.constants,
        selfBox: stubBox,
        inputs: [stubBox],
        outputs: [stubBox],
        dataInputs: [],
      })
      const value = evaluateWith(tree, ctx)
      expect(value).toEqual(hydrateSValue(entry.expected_value))
      expect(ctx.jitCost).toBe(entry.expected_cost)
    })
  }
})
```

Note: this test depends on a `synthesizeStubBox` helper that may not exist yet. **Add the helper to `packages/ergoscript/test/_helpers/index.ts`** in this step:

```ts
import type { ErgoBox } from '../../src/mir/types'

export function synthesizeStubBox(opts?: {
  tokens?: { id: Uint8Array; amount: bigint }[]
}): ErgoBox {
  return {
    value: 1_000_000n,
    propositionBytes: new Uint8Array(),
    tokens: opts?.tokens ?? [],
    additionalRegisters: {},
    txId: new Uint8Array(32),
    index: 0,
    creationHeight: 0,
  }
}
```

(Verify the field shape against `mir/types.ts:66-83`'s `ErgoBox` interface — adjust if any required field is missing.)

- [ ] **Step 3: Run tests — confirm fixture test fails on missing file.**

```bash
cd packages/ergoscript && npx vitest run test/eval/method-call.test.ts
```

Expected: existing 2 dispatcher tests pass; fixture-load fails on missing JSON.

- [ ] **Step 4: Write fixture-gen** in `fixture-gen/src/cmds/ergoscript/eval/method_call.rs`. Initial version covers SBox.tokens only; Tasks 5-6 append:

```rust
//! Method-call dispatcher fixtures: 3 handlers + edge cases.

use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::global_vars::GlobalVars;
use ergotree_ir::mir::property_call::PropertyCall;
use ergotree_ir::serialization::SigmaSerializable;
use ergotree_ir::types::sbox;
use serde_json::json;

use crate::cmds::ergoscript::eval::eval_with_synthetic_or_provided;

pub fn generate() -> Vec<serde_json::Value> {
    vec![
        // SBox.tokens: SELF.tokens with 0, 1, 2-token boxes.
        sbox_tokens_entry("sbox-tokens-empty", 0),
        sbox_tokens_entry("sbox-tokens-1-token", 1),
        sbox_tokens_entry("sbox-tokens-2-tokens", 2),
        // ... Task 5 and Task 6 append here.
    ]
}

fn sbox_tokens_entry(name: &str, token_count: usize) -> serde_json::Value {
    let pc: Expr = PropertyCall::new(
        GlobalVars::SelfBox.into(),
        sbox::TOKENS_METHOD.clone(),
    )
    .unwrap()
    .into();
    let tree_bytes = pc.sigma_serialize_bytes().unwrap();
    // Synthesize a Context whose self_box has `token_count` deterministic tokens.
    // The ctx hint in the JSON tells the TS test how many tokens to inject.
    let tokens_hint: Vec<serde_json::Value> = (0..token_count)
        .map(|i| {
            json!({
                "id": hex::encode(&[i as u8; 32]),
                "amount": format!("{}", 100 + i as i64),
            })
        })
        .collect();
    let (value_json, jit_cost) = eval_with_synthetic_or_provided(&pc, &tokens_hint)
        .expect("SBox.tokens eval");
    json!({
        "name": name,
        "tree_hex": hex::encode(&tree_bytes),
        "ctx": { "self_box_tokens": tokens_hint },
        "expected_value": value_json,
        "expected_cost": jit_cost,
    })
}
```

(`eval_with_synthetic_or_provided` is a shared helper to be added if not present — provides a Context with optional self_box_tokens override; same shape as existing helpers.)

- [ ] **Step 5: Wire mod + main, generate.**

Add `pub mod method_call;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs`. Add to `main.rs`:

```rust
generate_and_write(
    "packages/ergoscript/test/fixtures/eval/method-call.json",
    json!({ "entries": crate::cmds::ergoscript::eval::method_call::generate() }),
)?;
```

Run fixture-gen twice for determinism check:

```bash
cd fixture-gen && cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/method-call.json
cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/method-call.json
```

Expected: file generated; zero diff on second run.

- [ ] **Step 6: Run test file — confirm all entries pass.**

```bash
cd packages/ergoscript && npx vitest run test/eval/method-call.test.ts
```

Expected: 2 dispatcher tests + 3 SBox.tokens fixture entries = 5 tests pass.

- [ ] **Step 7: Run full suite.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: zero regressions.

- [ ] **Step 8: Commit.**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/test/eval/method-call.test.ts \
        packages/ergoscript/test/_helpers/index.ts \
        packages/ergoscript/test/fixtures/eval/method-call.json \
        fixture-gen/src/cmds/ergoscript/eval/method_call.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): SBox.tokens method handler (phase 2g.5 task 4)

PropertyCall typeId=99 methodId=8. Cost 15 Pattern A (handler-local).
Returns Coll[(Coll[Byte], Long)] from box.tokens.

Helper: tokensCollOf converts ErgoBox.tokens to the canonical Coll-of-Tuples
SValue shape.

Helper: synthesizeStubBox added to test/_helpers for fixture-driven tests.

Source: eval/sbox.rs:72-79.

Fixtures: 0/1/2-token boxes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `SContext.dataInputs` handler (PropertyCall typeId=101, methodId=1)

**Files:**
- Modify: `packages/ergoscript/src/eval/eval-context.ts` (add `dataInputs?: ErgoBox[]` to `EvalOpts`; thread through `makeContext`)
- Modify: `packages/ergoscript/src/eval/method-call.ts` (register handler + add `dataInputsCollOf` helper)
- Modify: `packages/ergoscript/src/eval/errors.ts` (add `'context-obj-not-context'`)
- Modify: `packages/ergoscript/test/eval/method-call.test.ts` (no change; new fixture entries flow through existing fixture loop)
- Modify: `fixture-gen/src/cmds/ergoscript/eval/method_call.rs` (append SContext.dataInputs entries)
- Regenerate: `packages/ergoscript/test/fixtures/eval/method-call.json`

**Sigma-rust source-read:**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scontext.rs | head -50
grep -n "DATA_INPUTS_PROPERTY_METHOD_ID\|DATA_INPUTS_PROPERTY_METHOD_DESC" ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scontext.rs
```

Key: `DATA_INPUTS_EVAL_FN` at `scontext.rs:17-31`. `add_jit_cost(15)`; validates `obj == Value::Context`; returns `ctx.data_inputs.clone().map_or(Arc::new([]), ...)`. Method ID 1.

- [ ] **Step 1: Add `'context-obj-not-context'` error code** to `packages/ergoscript/src/eval/errors.ts`.

- [ ] **Step 2: Extend `EvalOpts` + `makeContext`** in `packages/ergoscript/src/eval/eval-context.ts`. Add to `EvalOpts`:

```ts
  /** Transaction dataInputs (read-only). Mirrors sigma-rust `Context::data_inputs`. */
  dataInputs?: ErgoBox[]
```

In `makeContext`, thread the field through. Find the `const ctx: EvalContext = { ... }` block and add `dataInputs: opts.dataInputs,` after `outputs: opts.outputs,`.

- [ ] **Step 3: Register the handler** in `packages/ergoscript/src/eval/method-call.ts`'s `registerHandlers`:

```ts
  // SContext.dataInputs (PropertyCall, typeId=101, methodId=1)
  // Source: eval/scontext.rs:17-31 — DATA_INPUTS_EVAL_FN
  HANDLERS.set(handlerKey(101, 1), (obj, _args, ctx, _) => {
    ctx.addCost(15)
    if (obj.kind !== 'Context') {
      throw new EvalError(
        `SContext.dataInputs expects a Context obj; got '${obj.kind}'`,
        'context-obj-not-context'
      )
    }
    return dataInputsCollOf(ctx.dataInputs ?? [])
  })
```

Add the helper below `tokensCollOf` (uses the `ErgoBox` import already added in Task 4):

```ts
function dataInputsCollOf(boxes: ErgoBox[]): SValue {
  const sBox: SType = { tag: 'SBox' }
  return {
    kind: 'Coll',
    elem: sBox,
    items: boxes.map((b) => ({ kind: 'Box', value: b })),
  }
}
```

- [ ] **Step 4: Append SContext.dataInputs fixtures** to `fixture-gen/src/cmds/ergoscript/eval/method_call.rs`'s `generate()` function:

```rust
        scontext_data_inputs_entry("scontext-data-inputs-empty", 0),
        scontext_data_inputs_entry("scontext-data-inputs-2-boxes", 2),
```

And add the helper:

```rust
fn scontext_data_inputs_entry(name: &str, data_inputs_count: usize) -> serde_json::Value {
    use ergotree_ir::mir::expr::Expr;
    use ergotree_ir::types::scontext;
    let pc: Expr = PropertyCall::new(
        Expr::Context,
        scontext::DATA_INPUTS_PROPERTY.clone(),
    )
    .unwrap()
    .into();
    let tree_bytes = pc.sigma_serialize_bytes().unwrap();
    let (value_json, jit_cost) = eval_with_synthetic_data_inputs(&pc, data_inputs_count)
        .expect("SContext.dataInputs eval");
    json!({
        "name": name,
        "tree_hex": hex::encode(&tree_bytes),
        "ctx": { "data_inputs_count": data_inputs_count },
        "expected_value": value_json,
        "expected_cost": jit_cost,
    })
}
```

(Add `eval_with_synthetic_data_inputs` helper to the shared eval module if not present — Context with `data_inputs_count` deterministic boxes.)

- [ ] **Step 5: Update test fixture-load loop** in `packages/ergoscript/test/eval/method-call.test.ts` to thread `data_inputs_count` into `makeContext`. Modify the inline `ctx` construction in the existing fixture-driven describe block:

```ts
      const dataInputsCount = entry.ctx?.data_inputs_count ?? 0
      const dataInputs = Array.from({ length: dataInputsCount }, () => synthesizeStubBox({}))
      const ctx = makeContext({
        constants: tree.constants,
        selfBox: stubBox,
        inputs: [stubBox],
        outputs: [stubBox],
        dataInputs,
      })
```

- [ ] **Step 6: Regenerate fixture; run determinism check.**

```bash
cd fixture-gen && cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/method-call.json
cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/method-call.json
```

Expected: file updated; zero diff on second run.

- [ ] **Step 7: Run tests — confirm SContext.dataInputs entries pass.**

```bash
cd packages/ergoscript && npx vitest run test/eval/method-call.test.ts
```

Expected: 2 dispatcher + 3 SBox.tokens + 2 SContext.dataInputs = 7 tests pass.

- [ ] **Step 8: Run full suite.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: zero regressions.

- [ ] **Step 9: Commit.**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/src/eval/eval-context.ts \
        packages/ergoscript/src/eval/errors.ts \
        packages/ergoscript/test/eval/method-call.test.ts \
        packages/ergoscript/test/fixtures/eval/method-call.json \
        fixture-gen/src/cmds/ergoscript/eval/method_call.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): SContext.dataInputs method handler (phase 2g.5 task 5)

PropertyCall typeId=101 methodId=1. Cost 15 Pattern A (handler-local).
Validates obj.kind === 'Context', returns Coll[Box] from ctx.dataInputs ?? [].

New: EvalOpts.dataInputs?: ErgoBox[] field (additive).
New EvalError code (42 → 43): 'context-obj-not-context'.

Source: eval/scontext.rs:17-31.

Fixtures: 0-box + 2-box dataInputs entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `SColl.indexOf` handler (MethodCall typeId=12, methodId=26)

**Files:**
- Modify: `packages/ergoscript/src/eval/method-call.ts` (register handler)
- Modify: `fixture-gen/src/cmds/ergoscript/eval/method_call.rs` (append SColl.indexOf entries)
- Regenerate: `packages/ergoscript/test/fixtures/eval/method-call.json`

**Sigma-rust source-read:**

```bash
sed -n '1,50p' ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs
grep -n "INDEX_OF_METHOD" ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scoll.rs | head -5
```

Key: `INDEX_OF_EVAL_FN` at `scoll.rs:21-50`. **Pattern B cost** — `add_per_item_jit_cost(20, 10, 2, n)` AFTER extracting Coll, BEFORE the linear search. `from < 0` clamped to `0`. Returns Int (`-1` if not found). MethodCall (not PropertyCall) — has args.

- [ ] **Step 1: Register the handler** in `packages/ergoscript/src/eval/method-call.ts`'s `registerHandlers`. Add `sValueEquals` import at the top of the file:

```ts
import { sValueEquals } from './bin-op/relation'
```

Add the registration:

```ts
  // SColl.indexOf (MethodCall, typeId=12, methodId=26)
  // Source: eval/scoll.rs:21-50 — INDEX_OF_EVAL_FN
  HANDLERS.set(handlerKey(12, 26), (obj, args, ctx, _) => {
    if (obj.kind !== 'Coll') {
      throw new EvalError(
        `SColl.indexOf expects a Coll obj; got '${obj.kind}'`,
        'method-not-implemented'  // reuse per error taxonomy (option 1)
      )
    }
    const n = obj.items.length
    ctx.addPerItemCost(20, 10, 2, n)  // Pattern B; source: scoll.rs:31
    if (args.length !== 2) {
      throw new EvalError(
        `SColl.indexOf expects 2 args; got ${args.length}`,
        'method-not-implemented'
      )
    }
    const [target, fromArg] = args
    if (fromArg.kind !== 'Int') {
      throw new EvalError(
        `SColl.indexOf expects 'from' to be Int; got '${fromArg.kind}'`,
        'method-not-implemented'
      )
    }
    const from = Math.max(0, fromArg.value)
    for (let i = from; i < n; i++) {
      if (sValueEquals(obj.items[i], target, ctx)) return { kind: 'Int', value: i }
    }
    return { kind: 'Int', value: -1 }
  })
```

- [ ] **Step 2: Append SColl.indexOf fixtures** to `fixture-gen/src/cmds/ergoscript/eval/method_call.rs`'s `generate()`:

```rust
        scoll_index_of_entry("scoll-index-of-found", &[1i64, 2, 3], 2, 0, 1),
        scoll_index_of_entry("scoll-index-of-found-from-1", &[1i64, 2, 3], 2, 1, 1),
        scoll_index_of_entry("scoll-index-of-not-found-after-from", &[1i64, 2, 3], 2, 2, -1),
        scoll_index_of_entry("scoll-index-of-clamped-from-neg", &[1i64, 2, 3], 2, -5, 1),
        scoll_index_of_entry("scoll-index-of-not-found", &[1i64, 2, 3], 99, 0, -1),
```

Helper:

```rust
fn scoll_index_of_entry(
    name: &str,
    coll_values: &[i64],
    target: i64,
    from: i32,
    _expected_result: i32,
) -> serde_json::Value {
    use ergotree_ir::mir::collection::Collection;
    use ergotree_ir::mir::constant::Constant;
    use ergotree_ir::mir::expr::Expr;
    use ergotree_ir::mir::method_call::MethodCall;
    use ergotree_ir::types::scoll;
    use ergotree_ir::types::stype::SType;
    use std::collections::HashMap;

    let coll: Expr = Collection::from_iter(
        coll_values.iter().map(|&v| Constant::from(v).into()),
        SType::SLong,
    )
    .unwrap()
    .into();
    let target_const: Expr = Constant::from(target).into();
    let from_const: Expr = Constant::from(from).into();
    let mc: Expr = MethodCall::new(
        coll,
        scoll::INDEX_OF_METHOD.clone(),  // or .with_concrete_types for the Coll element type
        vec![target_const, from_const],
    )
    .unwrap()
    .into();
    let tree_bytes = mc.sigma_serialize_bytes().unwrap();
    let (value_json, jit_cost) = eval_with_synthetic_empty(&mc).expect("indexOf eval");
    json!({
        "name": name,
        "tree_hex": hex::encode(&tree_bytes),
        "ctx": {},
        "expected_value": value_json,
        "expected_cost": jit_cost,
    })
}
```

(Note: `MethodCall::new` may need `with_concrete_types` to fill the T type variable for SColl — verify against sigma-rust's existing test patterns in `scoll.rs` or any prior `MethodCall::new` usage in fixture-gen.)

- [ ] **Step 3: Regenerate fixture; determinism check.**

```bash
cd fixture-gen && cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/method-call.json
cargo run && git diff --exit-code ../packages/ergoscript/test/fixtures/eval/method-call.json
```

Expected: file updated; zero diff on second run.

- [ ] **Step 4: Run tests.**

```bash
cd packages/ergoscript && npx vitest run test/eval/method-call.test.ts
```

Expected: 2 dispatcher + 3 SBox.tokens + 2 SContext.dataInputs + 5 SColl.indexOf = 12 tests pass.

- [ ] **Step 5: Run full suite.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: zero regressions.

- [ ] **Step 6: Commit.**

```bash
git add packages/ergoscript/src/eval/method-call.ts \
        packages/ergoscript/test/fixtures/eval/method-call.json \
        fixture-gen/src/cmds/ergoscript/eval/method_call.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): SColl.indexOf method handler (phase 2g.5 task 6)

MethodCall typeId=12 methodId=26. Cost addPerItemCost(20, 10, 2, n)
Pattern B (after Coll extraction). Returns Int index or -1.
'from < 0' clamped to 0. Uses sValueEquals for element comparison.

Source: eval/scoll.rs:21-50.

Fixtures: found at 0, found-from-1, not-found-after-from, clamped-from-neg, not-found.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Corpus context provisioning + assert `success === 18`

**Files:**
- Modify: `packages/ergoscript/test/corpus-eval.test.ts`
- Optional: extend `synthesizeStubBox` in `packages/ergoscript/test/_helpers/index.ts` if a corpus entry surfaces a stub-field that needs richer data.

This task wires the synthetic context into the corpus eval and asserts the unlock.

- [ ] **Step 1: Update `corpus-eval.test.ts`.** Replace the `ctx` construction:

```ts
const ctx = makeContext({ constants: tree.constants })
```

with:

```ts
const stubBox = synthesizeStubBox({})
const ctx = makeContext({
  constants: tree.constants,
  selfBox: stubBox,
  inputs: [stubBox],
  outputs: [stubBox],
  dataInputs: [],
  height: 0,
})
```

Add the `synthesizeStubBox` import:

```ts
import { hexToBytes, hydrateSValue, synthesizeStubBox } from './_helpers'
```

- [ ] **Step 2: Add the explicit unlock assertion** in the `aggregate (informational)` block. Replace:

```ts
expect(other).toBe(0)
```

with:

```ts
expect(other).toBe(0)
expect(evalSuccess).toBe(18)
```

This makes the assertion hard — if any of the 18 entries fails to fully evaluate, the test fails loudly. The `console.log` lines stay so future regressions surface the breakdown.

- [ ] **Step 3: Run the corpus-eval test.**

```bash
cd packages/ergoscript && npx vitest run test/corpus-eval.test.ts
```

Expected: PASS with `[corpus-eval] TS eval: success=18 not-impl=0 other=0`.

**If some entries fail:** they hit a stub-field shape that `synthesizeStubBox` doesn't cover. Inspect the error message, extend the stub's fields (or the `makeContext` call) to provide what's missing, regenerate fixtures if needed, retry. Common possibilities:
- `additionalRegisters` needs at least empty R4-R9 keys for some `getReg` calls (but `getReg` isn't in 2g.5's scope — if it surfaces, that's a separate gap; investigate).
- `propositionBytes` needs to be non-empty for `box.propositionBytes` reads (`ExtractScriptBytes`).
- `value: 1_000_000n` may need to be larger for `box.value` comparisons that expect ERG-scale values.

Iterate the stub until 18/18 lands.

- [ ] **Step 4: Run the full test suite.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: zero regressions; corpus eval now shows 18/18.

- [ ] **Step 5: Commit.**

```bash
git add packages/ergoscript/test/corpus-eval.test.ts \
        packages/ergoscript/test/_helpers/index.ts

git commit -m "$(cat <<'EOF'
test(ergoscript): C2 corpus unlock — synthetic context + assert success=18/18 (phase 2g.5 task 7)

Corpus-eval test now constructs makeContext with stub selfBox/inputs/
outputs (and dataInputs: []). All 18 sigma-rust-evaluable mainnet trees
now succeed in TS eval — value AND cost equality against sigma-rust's
try_eval_out oracle. Hard assertion expect(evalSuccess).toBe(18) ensures
future regressions surface immediately.

Net unlock: 0/18 → 18/18 across phases 2b through 2g.5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `facts/ergoscript.md` update + final regression sweep

**Files:**
- Modify: `facts/ergoscript.md` (additive section per phase)
- Modify: `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella; mark phase 2g.5 complete)
- Modify: `packages/ergoscript/SESSION_CONTEXT.md` (overwrite with 2g.5 final state; gitignored — local convention only)

- [ ] **Step 1: Update `facts/ergoscript.md`.** Read the current state of the file. Append/update the relevant sections:
  - Coverage: 47 → 51 arms.
  - New `SValue` variant: `{ kind: 'Context' }`.
  - New `EvalOpts` field: `dataInputs?: ErgoBox[]`.
  - 3 new `EvalError` codes (40 → 43): `'method-not-implemented'`, `'context-obj-not-context'`, `'sigma-prop-bytes-input-not-sigma-prop'`.
  - New module: `eval/method-call.ts` — dispatcher + handler registry; the 3 registered handlers (SBox.tokens, SContext.dataInputs, SColl.indexOf).
  - C2 corpus status: `success=18/18` (previously 0/18 since 2f).
  - Phase 2g.5 → COMPLETE.

Mirror the structural pattern of prior phase blocks (2g-medium, 2g-combinators).

- [ ] **Step 2: Update the umbrella spec** `docs/specs/2026-05-13-ergoscript-interpreter-design.md`. Find the phase 2g.5 reference (around line 62) and update its status to "complete" with a backlink to this slice's design spec.

- [ ] **Step 3: Update local `SESSION_CONTEXT.md`** at `packages/ergoscript/SESSION_CONTEXT.md`. Overwrite with the final state of phase 2g.5 (mirror prior session-context structure). This file is gitignored.

- [ ] **Step 4: Run the full test suite under node AND jsdom.**

```bash
cd packages/ergoscript && npx vitest run
```

Expected: every existing test passes; new tests pass; corpus success=18/18; total test count = 2894 (2g-combinators baseline) + new tests added across Tasks 1-7.

- [ ] **Step 5: Run typecheck.**

```bash
cd packages/ergoscript && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 6: Run fixture-gen determinism final check.**

```bash
cd fixture-gen && cargo run && cd .. && git status
```

Expected: working tree clean (no fixture changes from a no-op regen).

- [ ] **Step 7: Run full ergoscript-package fixture build via the existing fixture-gen pipeline.**

```bash
cd packages/ergoscript && npm test
```

Expected: every test passes.

- [ ] **Step 8: Commit.**

```bash
git add facts/ergoscript.md \
        docs/specs/2026-05-13-ergoscript-interpreter-design.md

git commit -m "$(cat <<'EOF'
docs(ergoscript): phase 2g.5 facts + umbrella spec update

facts/ergoscript.md: coverage 47 → 51 arms; SValue.Context variant; EvalOpts.dataInputs
field; 3 new EvalError codes; method-call dispatcher module; C2 corpus 18/18.

Umbrella spec: phase 2g.5 marked complete with backlink to design spec.

Phase 2g.5 done.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (for the implementer or review subagent)

After each task, verify:
- [ ] All new code matches the spec.
- [ ] All tests pass under both node and jsdom.
- [ ] `tsc --noEmit` clean.
- [ ] Fixture-gen determinism (two-run zero-diff).
- [ ] Commit message follows the project's conventional format and cites sigma-rust source lines.
- [ ] No `Buffer`, no `node:*` in `packages/*/src/` (browser-first rule).

After Task 8, verify against `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md`:
- [ ] All Goal-section bullets are addressed.
- [ ] All 3 new EvalError codes exist and are used.
- [ ] All 3 method handlers are registered and tested.
- [ ] C2 corpus success === 18.
- [ ] facts/ergoscript.md reflects the slice's additions.

---

## Branch + commit hygiene

- One commit per task (8 commits total).
- Commit messages: `feat(ergoscript): ...` for source changes; `test(ergoscript): ...` for test-only; `docs(ergoscript): ...` for docs/facts.
- Each commit message body cites the sigma-rust source line for the behavior being implemented.
- No `--no-verify`, no `--no-gpg-sign`. If a pre-commit hook fails, fix the underlying issue and create a NEW commit.
- Push only after the user requests it.
