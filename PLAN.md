# Phase 2i-c — Deserialize family (DeserializeContext + DeserializeRegister) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto/cost-path → halt and declare; #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Spec:** `docs/specs/2026-05-21-ergoscript-phase-2i-c-deserialize-design.md` (HEAD `bf112b7`)

**Goal:** Wire eval semantics for the two `Expr` arms that consume untrusted runtime bytes as code:

1. **`DeserializeContext`** — read `ctx.extension.values[id]` as `Coll[Byte]`, decode as `Expr`, evaluate.
2. **`DeserializeRegister`** — read `ctx.selfBox.registers[reg]` as `Coll[Byte]`, decode as `Expr`, evaluate. Fall back to `default` (an inline `Expr` baked into the outer tree) if register absent; LEAVE node unchanged if both absent (eval-time defensive throw catches).

**Architecture:** substitute-pre-pass mirroring sigma-rust `eval.rs:203-250` + `mir/expr.rs:442-496`. `substituteDeserialize` is a bottom-up tree rewrite that runs in `evaluate`/`evaluateWith` BEFORE `tryTrivialReduceExpr` + `evalExpr`. The Deserialize* eval arms are defensive throws (`'deserialize-not-substituted'`).

**Tech Stack:** TypeScript (vitest, node + jsdom cross-runtime), Rust `fixture-gen` crate, sigma-rust branch `integration/ergots`. No new runtime dependencies.

**Invariants:** Coverage 65 → 67 `Expr` arms; EvalError codes 59 → **64** (+5 new); method-handler registry unchanged at 44; ~15 new oracle fixtures; ~60–80 new tests (3142 → ~3200–3220 ergoscript).

---

## Task ordering (TDD-compliant: arch skeleton → fixture → RED → integration → GREEN)

```
T1   PLAN.md committed (this document)
T2   exprTpe + 5 new EvalErrorCodes      ← additive, no behavior change
T3   Defensive-throw eval arms wired      ← Deserialize* arms throw 'deserialize-not-substituted'
T4   substituteDeserialize module         ← type-checked, exported, NOT called from evaluate yet
T5   tryTrivialReduce refactor            ← mechanical extract of tryTrivialReduceExpr
T6   DeserializeContext oracle fixtures   ← fixture-gen + JSON
T7   DC RED test                          ← FAILS with 'deserialize-not-substituted' (T8 lands integration)
T8   substitute integration in evaluate/evaluateWith  ← T7 test now GREEN ✓
T9   DeserializeContext mutation tests    ← Layer C3.a
T10  DeserializeRegister oracle fixtures
T11  DeserializeRegister oracle test      ← PASSES immediately (architecture from T4-T8 handles both arms)
T12  DeserializeRegister mutation tests
T13  facts/ergoscript-eval.md sweep
T14  README + SESSION_CONTEXT + HANDOFF_PROMPT sweep + push
```

Total: ~14 commits (excluding the spec commit `bf112b7` which is already landed).

---

## Task 1: Commit PLAN.md

**Files:**
- Create: `/home/mwaddip/projects/ergots/PLAN.md` (this file, overwrites 2i-b plan)

- [ ] **Step 1: Stage and commit**

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): overwrite PLAN.md with phase 2i-c execution plan

Per HANDOFF_PROMPT.md convention: PLAN.md is the in-flight phase's task list,
overwritten at each phase boundary. Spec at
docs/specs/2026-05-21-ergoscript-phase-2i-c-deserialize-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: 1 file changed.

---

## Task 2: exprTpe coverage + 5 new EvalErrorCode entries (1 commit)

**Files:**
- Modify: `packages/ergoscript/src/mir/expr-tpe.ts` — add `case 'DeserializeContext':` and `case 'DeserializeRegister':` returning `e.tpe`.
- Modify: `packages/ergoscript/src/eval/errors.ts` — add 5 new entries to the `EvalErrorCode` union.

**Source:** `mir/expr.rs:713-728` `SubstDeserializeError` (variant-to-code mapping); `eval/sheader.rs` and other phase-2h arms for the EvalErrorCode location.

**New codes:**

1. `'deserialize-context-key-not-found'` — DeserializeContext: `ctx.extension.values[e.id]` undefined.
2. `'deserialize-input-not-byte-array'` — both arms: entry's tpe !== SColl<SByte> or value not Coll[Byte].
3. `'deserialize-parse-failed'` — both arms: inner Expr bytes malformed (wrap underlying wire error message).
4. `'deserialize-tpe-mismatch'` — both arms: `exprTpe(parsed) !== e.tpe`.
5. `'deserialize-not-substituted'` — defensive eval-time throw on the Deserialize* arms.

- [ ] **Step 1: Locate exact insertion points**

```bash
grep -n "case 'CreateAvlTree'" packages/ergoscript/src/mir/expr-tpe.ts        # alphabetical neighborhood
grep -n "EvalErrorCode" packages/ergoscript/src/eval/errors.ts                # union location
```

- [ ] **Step 2: Add exprTpe cases**

The expr-tpe.ts file has a central switch over `e.tag`. Add (in alphabetical order):

```ts
case 'DeserializeContext':
case 'DeserializeRegister':
  return e.tpe
```

- [ ] **Step 3: Add 5 new EvalErrorCode entries**

Append the 5 codes to the `EvalErrorCode` union (or its equivalent — check current shape via `grep -n EvalErrorCode`). Keep alphabetical/topical grouping.

- [ ] **Step 4: Verify (REQUIRED — OVERRIDES rule #6)**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json     # CLEAN
cd packages/ergoscript && npx vitest run                   # all 3142 pass (no behavior change)
```

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/mir/expr-tpe.ts packages/ergoscript/src/eval/errors.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): exprTpe coverage + 5 EvalErrorCodes for phase 2i-c

Adds exprTpe cases for DeserializeContext + DeserializeRegister returning
e.tpe. Adds 5 EvalErrorCode entries (no thrower yet — defensive arm wiring
in T3, substitute pass in T4+T8):
- 'deserialize-context-key-not-found'
- 'deserialize-input-not-byte-array'
- 'deserialize-parse-failed'
- 'deserialize-tpe-mismatch'
- 'deserialize-not-substituted'

Codes mirror sigma-rust's SubstDeserializeError variants (mir/expr.rs:713-728);
'deserialize-not-substituted' covers both the inner-Expr-recursive-Deserialize
case and the DeserializeRegister-absent-no-default case (sigma-rust expr.rs:
478-481 leaves the node unchanged, defensive eval-time throw catches).

No behavior change. EvalError codes 59 -> 64.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Defensive-throw eval arms wired (1 commit)

**Files:**
- Create: `packages/ergoscript/src/eval/deserialize-context.ts`
- Create: `packages/ergoscript/src/eval/deserialize-register.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts` — add switch cases for both arms.

**Source:** `ergotree-interpreter/src/eval/deserialize_context.rs` (test-only file, NO Evaluable impl — defensive throw is the canonical mirror).

- [ ] **Step 1: Implement evalDeserializeContext**

```ts
// File: packages/ergoscript/src/eval/deserialize-context.ts

import type { DeserializeContext } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

/**
 * Defensive throw — substituteDeserialize should rewrite this node before eval.
 * Reachable only when the node lives inside an already-substituted inner Expr
 * (matches sigma-rust eval/deserialize_context.rs which contains ONLY tests —
 * no Evaluable impl; falls through to "not implemented" at eval-time).
 */
export function evalDeserializeContext(
  e: DeserializeContext,
  _env: Env,
  _ctx: EvalContext,
): never {
  throw new EvalError(
    `DeserializeContext: node reached eval — substitute pass did not rewrite ` +
      `(likely nested in an inner-Expr from substitution). id=${e.id} tpe=${e.tpe.tag}`,
    'deserialize-not-substituted',
  )
}
```

- [ ] **Step 2: Implement evalDeserializeRegister** (parallel shape)

```ts
// File: packages/ergoscript/src/eval/deserialize-register.ts

import type { DeserializeRegister } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'

/**
 * Defensive throw — substituteDeserialize should rewrite this node before
 * eval. Reachable when:
 *   (a) register absent AND e.default is null — substitute leaves the node
 *       unchanged per sigma-rust expr.rs:478-481;
 *   (b) the node lives inside an inner Expr decoded from runtime bytes
 *       (recursive Deserialize).
 *
 * sigma-rust eval/deserialize_register.rs contains ONLY tests — no Evaluable
 * impl; defensive eval-time throw is the canonical mirror.
 */
export function evalDeserializeRegister(
  e: DeserializeRegister,
  _env: Env,
  _ctx: EvalContext,
): never {
  throw new EvalError(
    `DeserializeRegister: node reached eval — substitute pass did not rewrite ` +
      `(register absent + no default, OR nested in inner-Expr). reg=${e.reg} tpe=${e.tpe.tag}`,
    'deserialize-not-substituted',
  )
}
```

- [ ] **Step 3: Wire dispatcher in eval.ts**

Add (alphabetical ordering — check the existing switch in `packages/ergoscript/src/eval/eval.ts`):

```ts
import { evalDeserializeContext } from './deserialize-context'
import { evalDeserializeRegister } from './deserialize-register'
// ...
case 'DeserializeContext': return evalDeserializeContext(e, env, ctx)
case 'DeserializeRegister': return evalDeserializeRegister(e, env, ctx)
```

- [ ] **Step 4: Verify (REQUIRED)**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json     # CLEAN
cd packages/ergoscript && npx vitest run                   # all 3142 pass
```

No new tests fail because no test currently exercises these arms (they were 'not-implemented-yet' before).

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/src/eval/deserialize-context.ts \
        packages/ergoscript/src/eval/deserialize-register.ts \
        packages/ergoscript/src/eval/eval.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): defensive-throw eval arms for Deserialize* (T3 of 2i-c)

Wires DeserializeContext + DeserializeRegister eval arms. Both throw
'deserialize-not-substituted' — substituteDeserialize (T4+T8) should
rewrite these nodes before eval. Reachable cases:
- DeserializeRegister with register absent + e.default null (sigma-rust
  expr.rs:478-481 leaves the node unchanged)
- inner-Expr nested Deserialize (try_rewrite_bu does NOT re-walk
  substituted children)

Defensive throw is the canonical mirror: sigma-rust eval/deserialize_*.rs
files contain ONLY tests; no Evaluable impl.

Eval arm coverage 65 -> 67 of ~70 (additive; integration in T8 makes
the substitute pass active).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: substituteDeserialize module (1 commit)

**Files:**
- Create: `packages/ergoscript/src/eval/_substitute-deserialize.ts`

**Source:** `ergotree-ir/src/mir/expr.rs:431-496` — `has_deserialize` + `substitute_deserialize`.

Implement two exported functions:

1. `treeHasDeserialize(tree: ErgoTree): boolean` — scans `tree.body` for any `DeserializeContext` or `DeserializeRegister` node. O(n) bottom-up traversal; early-return on first match.
2. `substituteDeserialize(body: Expr, tree: ErgoTree, ctx: EvalContext): Expr` — bottom-up rewrite returning a NEW Expr (immutable; doesn't mutate inputs).

**Source-mapping invariants (mirror sigma-rust):**

- **Order:** bottom-up (children rewritten before parent), matching `try_rewrite_bu` (`mir/expr.rs:397-408`).
- **Substituted Expr's interior is NOT re-walked.** A nested Deserialize* survives untouched.
- **Inner-Expr parse:** `parseExpr(reader, [], [], new Map(), ctx.treeVersion ?? tree.header.version)`. ConstantPlaceholder in inner bytes fails parse per `constant_placeholder.rs:14-24` (verified).
- **Type-check:** `sTypeEquals(exprTpe(parsed), e.tpe)`. Mismatch → `'deserialize-tpe-mismatch'`. Runs on BOTH register-decoded inner AND default-fallback.
- **DeserializeRegister with register absent + default null:** LEAVE node unchanged (return `body` without rewriting; eval-time defensive throw catches).
- **No reader-at-EOF assertion on inner parse:** trailing bytes silently ignored.
- **No cost charged** by `substituteDeserialize` itself.

**Failure modes:**

| Condition | Throw |
|---|---|
| `ctx.extension === undefined` (DC arm) | `EvalError('...', 'context-field-missing')` (reuse) |
| `ctx.selfBox === undefined` (DR arm with register-read needed) | `EvalError('...', 'context-field-missing')` (reuse) |
| `ctx.extension.values[id]` undefined | `EvalError('...', 'deserialize-context-key-not-found')` |
| entry.tpe !== `SColl<SByte>` or value not Coll[Byte] | `EvalError('...', 'deserialize-input-not-byte-array')` |
| inner Expr bytes malformed | `EvalError('${wire-error-message}', 'deserialize-parse-failed')` |
| `exprTpe(parsed) !== e.tpe` (or default) | `EvalError('...', 'deserialize-tpe-mismatch')` |

- [ ] **Step 1: Implement the module**

Sketch (full impl in T4 work):

```ts
// File: packages/ergoscript/src/eval/_substitute-deserialize.ts

import type { ErgoTree, Expr, SType } from '../mir/types'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { ByteReader } from '@ergots/scorex'
import { parseExpr } from '../wire/parse'
import { exprTpe } from '../mir/expr-tpe'
import { sTypeEquals } from '../mir/stype-helpers'
import { collByteToUint8Array } from './_byte-coll'

export function treeHasDeserialize(tree: ErgoTree): boolean {
  return hasDeserializeWalk(tree.body)
}

function hasDeserializeWalk(e: Expr): boolean {
  if (e.tag === 'DeserializeContext' || e.tag === 'DeserializeRegister') return true
  // Walk children of every Expr variant; early-return on match.
  // Implementation: mirror the structure of mir/expr-tpe.ts's switch.
  // ...
  return false
}

export function substituteDeserialize(
  body: Expr,
  tree: ErgoTree,
  ctx: EvalContext,
): Expr {
  return rewriteBottomUp(body, tree, ctx)
}

function rewriteBottomUp(e: Expr, tree: ErgoTree, ctx: EvalContext): Expr {
  // 1. Recurse into children first (immutable rewrite).
  // 2. If e is DeserializeContext / DeserializeRegister, attempt substitution:
  //    - decode bytes
  //    - parse inner Expr
  //    - type-check
  //    - return parsed (substituted)
  //    - OR return e unchanged (DR with register absent + default null)
  // 3. Else, return e (possibly with rewritten children).
  // ...
}

function substituteDeserializeContext(
  e: DeserializeContext,
  tree: ErgoTree,
  ctx: EvalContext,
): Expr {
  if (ctx.extension === undefined) {
    throw new EvalError('DeserializeContext: ctx.extension undefined', 'context-field-missing')
  }
  const entry = ctx.extension.values[e.id]
  if (entry === undefined) {
    throw new EvalError(`DeserializeContext: extension.values[${e.id}] not found`, 'deserialize-context-key-not-found')
  }
  // Expect entry.tpe === SColl<SByte>
  if (entry.tpe.tag !== 'SColl' || entry.tpe.elem.tag !== 'SByte') {
    throw new EvalError(`DeserializeContext: extension.values[${e.id}].tpe must be Coll[Byte], got ${entry.tpe.tag}`, 'deserialize-input-not-byte-array')
  }
  const bytes = collByteToUint8Array(entry.value, 'DeserializeContext', 'deserialize-input-not-byte-array')
  const reader = new ByteReader(bytes)
  let parsed: Expr
  try {
    parsed = parseExpr(reader, [], [], new Map(), ctx.treeVersion ?? tree.header.version)
  } catch (err) {
    throw new EvalError(`DeserializeContext: inner Expr parse failed — ${(err as Error).message}`, 'deserialize-parse-failed')
  }
  const parsedTpe = exprTpe(parsed)
  if (!sTypeEquals(parsedTpe, e.tpe)) {
    throw new EvalError(`DeserializeContext: inner Expr tpe mismatch (expected ${e.tpe.tag}, got ${parsedTpe.tag})`, 'deserialize-tpe-mismatch')
  }
  return parsed
}

function substituteDeserializeRegister(
  e: DeserializeRegister,
  tree: ErgoTree,
  ctx: EvalContext,
): Expr {
  // 1. Read register from ctx.selfBox; expect Coll[Byte].
  // 2. If register absent and default null: return e unchanged (eval-time defensive throw catches).
  // 3. If register present: parse inner Expr; tpe-check.
  // 4. If register absent and default present: tpe-check default; return default.
  // ...
}
```

The walker bodies (`hasDeserializeWalk`, `rewriteBottomUp`) need switch coverage for every Expr variant. Use the existing `mir/expr-tpe.ts` switch as a structural template — both walk every Expr variant's children.

- [ ] **Step 2: Verify (REQUIRED)**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json     # CLEAN
cd packages/ergoscript && npx vitest run                   # all 3142 still pass (module not yet imported elsewhere)
```

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/src/eval/_substitute-deserialize.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): substituteDeserialize module (T4 of 2i-c)

Implements treeHasDeserialize + substituteDeserialize per sigma-rust
mir/expr.rs:431-496. Bottom-up tree rewrite that splices inner Exprs in
place of DeserializeContext / DeserializeRegister nodes. Not yet
integrated into evaluate / evaluateWith — T8 wires the integration.

Per spec:
- Order: bottom-up; does NOT re-walk substituted children.
- Inner-Expr parser: parseExpr(r, [], [], new Map(), treeVersion).
  ConstantPlaceholder in inner bytes fails parse (verified against
  constant_placeholder.rs:14-24).
- Tpe check on both register-decoded inner AND default-fallback.
- DeserializeRegister with register absent + default null LEAVES node;
  defensive eval-time throw catches (per expr.rs:478-481).
- No cost charged; no reader-at-EOF assertion.

5 EvalError codes are reachable from this module (all added in T2).
Module is exported but not yet called from evaluate / evaluateWith;
T8 wires the integration after the T5 refactor of tryTrivialReduce.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: tryTrivialReduce refactor — extract tryTrivialReduceExpr (1 commit)

**Files:**
- Modify: `packages/ergoscript/src/eval/evaluate.ts`

**Source:** current `tryTrivialReduce(tree, ctx)` at `evaluate.ts:29-49`.

Mechanical refactor: extract the body's branch logic into `tryTrivialReduceExpr(body, ctx)`. The existing `tryTrivialReduce(tree, ctx)` becomes a one-line wrapper:

```ts
function tryTrivialReduceExpr(body: Expr, ctx: EvalContext): SValue | null {
  if (body.tag === 'Const' && body.tpe.tag === 'SSigmaProp') {
    ctx.addCost(50)
    return body.value
  }
  if (body.tag === 'ConstPlaceholder' && body.tpe.tag === 'SSigmaProp') {
    const constants = ctx.constants
    if (constants !== undefined && body.id < constants.length) {
      const resolved = constants[body.id]
      if (resolved !== undefined && resolved.kind === 'SigmaProp') {
        ctx.addCost(50)
        return resolved
      }
    }
  }
  return null
}

function tryTrivialReduce(tree: ErgoTree, ctx: EvalContext): SValue | null {
  return tryTrivialReduceExpr(tree.body, ctx)
}
```

**No behavior change.** All 3142 ergoscript tests still pass. This refactor exists solely to allow T8's substitute integration to call `tryTrivialReduceExpr(rewrittenBody, ctx)` directly without synthesizing a fake ErgoTree.

- [ ] **Step 1: Extract**

Read `evaluate.ts` carefully (per OVERRIDES rule #7); apply the extraction.

- [ ] **Step 2: Verify (REQUIRED)**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json     # CLEAN
cd packages/ergoscript && npx vitest run                   # ALL 3142 PASS — no behavior change
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts  # jsdom too
```

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/src/eval/evaluate.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): extract tryTrivialReduceExpr from tryTrivialReduce (T5 of 2i-c)

Mechanical extraction of the body-branch logic into tryTrivialReduceExpr(body, ctx).
tryTrivialReduce(tree, ctx) becomes a one-line wrapper delegating to the new
helper.

No behavior change. All 3142 ergoscript tests pass under both node and jsdom.

Existence rationale: T8's substitute-pre-pass integration needs to call
tryTrivialReduceExpr on the SUBSTITUTED body directly, not the original
tree.body. This refactor unblocks that.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: DeserializeContext oracle fixtures (1 commit)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/deserialize_context.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (`pub mod deserialize_context;`)
- Modify: `fixture-gen/src/main.rs` — append generate-and-write block
- Create: `packages/ergoscript/test/fixtures/eval/deserialize-context.json`

**Source:** `ergotree-interpreter/src/eval/deserialize_context.rs` (the test cases in this file ARE the spec for the fixtures we need).

**Fixture-gen entry point:** use `try_eval_with_deserialize::<T>` (NOT `try_eval_out`). The former runs `substitute_deserialize` before eval; the latter does not.

**8 scenarios:**

| Name | Inner expr | Outer arm tpe | Extension setup | Expected |
|---|---|---|---|---|
| `dc_bool_true` | `Const(SBoolean, true)` | SBoolean | `{ 1: <Coll[Byte] of sigma_serialize(true.into())> }` | value=`true`, cost=<from oracle> |
| `dc_height_eq_compare` | `BinOp(NEq, Height, 1i32)` | SBoolean | as above | value=oracle, cost=oracle |
| `dc_v3_unsigned_bigint` | `Const(SUnsignedBigInt, 0)` | SUnsignedBigInt | as above, V3 tree | value=0, cost=oracle |
| `dc_const_sigmaprop_inner` | `Const(SSigmaProp, ProveDlog(g))` | SSigmaProp | as above | value=sigmaprop, cost=50 (P2PK short-circuit on substituted body) |
| `dc_throw_key_not_found` | n/a | SBoolean | empty extension | throw `'deserialize-context-key-not-found'` |
| `dc_throw_wrong_input_type` | n/a | SBoolean | `{ 1: 1i32 }` (not Coll[Byte]) | throw `'deserialize-input-not-byte-array'` |
| `dc_throw_parse_failed` | n/a | SBoolean | `{ 1: <malformed Expr bytes, e.g. [0xff, 0xff]> }` | throw `'deserialize-parse-failed'` |
| `dc_throw_tpe_mismatch` | `Const(SInt, 5)` | SBoolean | `{ 1: <Coll[Byte] of sigma_serialize(5i32.into())> }` | throw `'deserialize-tpe-mismatch'` |
| `dc_throw_recursive` | `DeserializeContext{id=1, tpe=SBoolean}` | SBoolean | `{ 1: <sigma_serialize(DeserializeContext{id=1, tpe=SBoolean})> }` | throw `'deserialize-not-substituted'` OR `'cost-limit-exceeded'` (either acceptable per spec confidence note) |

`dc_const_sigmaprop_inner` is the **P2PK 50-cost short-circuit canary** — validates that `tryTrivialReduceExpr` fires on the SUBSTITUTED body. Without T5 refactor + T8 integration, this fixture would fail.

- [ ] **Step 1: Write fixture-gen module**

```rust
//! DeserializeContext arm.
//!
//! Sigma-rust ref: ergotree-interpreter/src/eval/deserialize_context.rs (tests)
//!                 ergotree-ir/src/mir/expr.rs:442-496 (substitute_deserialize)
//!                 ergotree-interpreter/src/eval.rs:203-250 (dispatch)

// Scenarios (8 — see PLAN.md task 6 table for layout).
// Each emits either { tree_bytes_hex, ctx_ext_json, expected_value, expected_cost }
// or { tree_bytes_hex, ctx_ext_json, expected_error, expected_error_code }.

// Use try_eval_with_deserialize::<T> as the oracle for value+cost.
// Use try_eval_out for dc_throw_recursive if it actually throws via cost-limit
// (sigma-rust's behavior is is_err() — code path TBD at implementation).
```

- [ ] **Step 2: Regenerate + commit**

```bash
cd fixture-gen
cargo run --release
cd ..
git diff packages/ergoscript/test/fixtures/eval/deserialize-context.json    # inspect

git add fixture-gen/src/cmds/ergoscript/eval/deserialize_context.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/deserialize-context.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): DeserializeContext oracle fixtures (8 scenarios)

8 scenarios spanning happy path (bool, BinOp, V3 UnsignedBigInt, P2PK
short-circuit canary), 4 throw paths (key-not-found, wrong-input-type,
parse-failed, tpe-mismatch), and the recursive-Deserialize test.

dc_const_sigmaprop_inner is the load-bearing P2PK 50-cost short-circuit
canary — validates that tryTrivialReduceExpr fires on the substituted
body, mirroring sigma-rust eval.rs:213.

Oracle: try_eval_with_deserialize (runs substitute pass before eval).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: DeserializeContext RED test (1 commit)

**Files:**
- Create: `packages/ergoscript/test/eval/deserialize-context.test.ts`

The test loads the fixture and asserts each entry's expected value/cost (success) OR expected throw code (failure). Mirrors the 2i-b template (e.g., `multiply-group.test.ts`).

**Current state when T7 lands:** substituteDeserialize module exists (T4) but isn't called from `evaluate` (T8 not landed). Defensive throws (T3) ARE active. So every entry's eval reaches the Deserialize* arm's `'deserialize-not-substituted'` throw. **Expected: every success-path test FAILS with `'deserialize-not-substituted'`; throw-path tests for codes other than `'deserialize-not-substituted'` also fail.**

```ts
import { describe, it, expect } from 'vitest'
import { evaluate } from '../../src/index'
import { parseTree } from '../../src/wire/parse-tree'
import { EvalError } from '../../src/eval/eval-context'
import { hexToBytes } from '../helpers'
import fixture from '../fixtures/eval/deserialize-context.json'

describe('DeserializeContext eval', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const opts = buildOptsFromFixture(entry)  // builds opts.extension from entry.ctx_ext_json
      if (entry.expected_error !== undefined) {
        expect(() => evaluate(tree, opts)).toThrow(EvalError)
        try { evaluate(tree, opts) } catch (e) {
          expect((e as EvalError).code).toBe(entry.expected_error_code)
          expect((e as Error).message).toContain(entry.expected_error)
        }
      } else {
        const result = evaluate(tree, opts)
        expect(svalueEquals(result, entry.expected_value)).toBe(true)
        // Cost check via evaluateWith if needed for jitCost inspection.
      }
    })
  }
})
```

- [ ] **Step 1: Implement** (build a small `buildOptsFromFixture` helper if not already present from earlier phases)

- [ ] **Step 2: Run — expect RED**

```bash
cd packages/ergoscript && npx vitest run test/eval/deserialize-context.test.ts
# Expected: most/all tests FAIL with 'deserialize-not-substituted' or other codes
```

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/test/eval/deserialize-context.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): RED — DeserializeContext oracle test (T7 of 2i-c)

Loads 8-scenario fixture and asserts value+cost or expected throw. Currently
fails because T8 (substitute integration in evaluate/evaluateWith) has not
landed — every entry's evaluate() hits the defensive 'deserialize-not-
substituted' throw before substitute pass runs.

T8 lands the integration; this test turns GREEN.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: substitute integration in evaluate / evaluateWith — GREEN moment (1 commit)

**Files:**
- Modify: `packages/ergoscript/src/eval/evaluate.ts`

Wire `substituteDeserialize` into `evaluate()` and `evaluateWith()`:

```ts
export function evaluate(tree: ErgoTree, opts: EvalOpts = {}): SValue {
  const ctx = makeContext({
    ...opts,
    constants: opts.constants ?? tree.constants,
    treeVersion: opts.treeVersion ?? tree.header.version,
  })
  if (treeHasDeserialize(tree)) {
    const rewrittenBody = substituteDeserialize(tree.body, tree, ctx)
    return tryTrivialReduceExpr(rewrittenBody, ctx) ?? evalExpr(rewrittenBody, Env.empty(), ctx)
  }
  return tryTrivialReduce(tree, ctx) ?? evalExpr(tree.body, Env.empty(), ctx)
}

export function evaluateWith(tree: ErgoTree, ctx: EvalContext): SValue {
  if (treeHasDeserialize(tree)) {
    const rewrittenBody = substituteDeserialize(tree.body, tree, ctx)
    return tryTrivialReduceExpr(rewrittenBody, ctx) ?? evalExpr(rewrittenBody, Env.empty(), ctx)
  }
  return tryTrivialReduce(tree, ctx) ?? evalExpr(tree.body, Env.empty(), ctx)
}
```

- [ ] **Step 1: Apply edit**

- [ ] **Step 2: Verify (REQUIRED — this is the GREEN moment)**

```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json                      # CLEAN
cd packages/ergoscript && npx vitest run test/eval/deserialize-context.test.ts  # PASS (T7 RED becomes GREEN)
cd packages/ergoscript && npx vitest run                                    # ALL 3142+~40 PASS
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts  # jsdom too
```

**If any test other than the T7 fixture passes/fails unexpectedly:** STOP and investigate. The substitute pass should be invisible to trees without Deserialize* nodes (gated by `treeHasDeserialize`).

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/src/eval/evaluate.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): substitute-pre-pass integration in evaluate (T8 of 2i-c)

Wires substituteDeserialize into evaluate() and evaluateWith(). When
treeHasDeserialize(tree) returns true, the substitute pass runs as a
bottom-up rewrite before tryTrivialReduceExpr + evalExpr. Trees without
Deserialize* nodes skip the pass (gated by treeHasDeserialize).

Mirrors sigma-rust eval.rs:203-250. Architectural divergence (deliberate,
cost-equivalent): we keep ctx.constants populated for all paths;
sigma-rust uses tree.proposition() to eagerly substitute placeholders.
tryTrivialReduceExpr already handles both Const(SSigmaProp) and
ConstPlaceholder(SSigmaProp) via ctx.constants lookup — same observable
cost+value output as sigma-rust's substitute path.

T7 DeserializeContext RED test now GREEN. P2PK 50-cost short-circuit
on substituted SigmaProp body validated via dc_const_sigmaprop_inner.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: DeserializeContext mutation tests (1 commit)

**Files:**
- Create: `packages/ergoscript/test/eval-mutation/deserialize-context.test.ts`

Use the existing mutation-test harness from phase 2h-e. Mutate:
- Outer tree bytes (e.g., the SType byte inside DeserializeContext.tpe)
- Inner Expr bytes (in extension.values[id])
- The id byte itself

Target ≥ 90% kill rate.

- [ ] **Step 1: Implement**
- [ ] **Step 2: Run; target ≥ 90% kill rate**
- [ ] **Step 3: Commit**

```bash
git commit -m "test(ergoscript): DeserializeContext mutation testing (Layer C3.a)"
```

---

## Task 10: DeserializeRegister oracle fixtures (1 commit)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/deserialize_register.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`
- Create: `packages/ergoscript/test/fixtures/eval/deserialize-register.json`

**8 scenarios** mirroring the spec's test plan:

| Name | Setup | Expected |
|---|---|---|
| `dr_r4_bool_neq` | R4 = sigma_serialize(BinOp(NEq, Height, 1i32)); arm tpe=SBoolean | success |
| `dr_r5_default_int` | R5 absent; default=Const(SInt, 1); arm tpe=SInt | value=1 |
| `dr_throw_no_register_no_default` | R5 absent; default null; arm tpe=SBoolean | throw `'deserialize-not-substituted'` (use `try_eval_out`, not `try_eval_with_deserialize`) |
| `dr_throw_register_wrong_type` | R4 = Const(SInt, 1) (not Coll[Byte]); arm tpe=SBoolean | throw `'deserialize-input-not-byte-array'` |
| `dr_throw_default_wrong_type` | R5 absent; default=Const(SBoolean, true); arm tpe=SInt | throw `'deserialize-tpe-mismatch'` |
| `dr_throw_inner_wrong_type` | R4 = sigma_serialize(Const(SInt, 1)); arm tpe=SBoolean | throw `'deserialize-tpe-mismatch'` |
| `dr_throw_parse_failed` | R4 = malformed Expr bytes (e.g. [0xff, 0xff]); arm tpe=SBoolean | throw `'deserialize-parse-failed'` |
| `dr_default_used_when_register_absent` | R5 absent; default=BinOp(NEq, Height, 0i32); arm tpe=SBoolean | value=true (or false depending on Height) |

- [ ] **Step 1: Write fixture-gen module**
- [ ] **Step 2: Regenerate + commit**

```bash
git commit -m "test(fixture-gen): DeserializeRegister oracle fixtures (8 scenarios)"
```

---

## Task 11: DeserializeRegister oracle test — PASSES immediately (1 commit)

**Files:**
- Create: `packages/ergoscript/test/eval/deserialize-register.test.ts`

By T11, the architecture (T2-T8) handles both arms identically. The DeserializeRegister test should PASS on first run — no RED step.

- [ ] **Step 1: Implement** (parallel shape to T7)
- [ ] **Step 2: Verify (REQUIRED)**

```bash
cd packages/ergoscript && npx vitest run test/eval/deserialize-register.test.ts  # PASS on first run
cd packages/ergoscript && npx vitest run                                          # ALL pass
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts        # jsdom pass
```

- [ ] **Step 3: Commit**

```bash
git commit -m "test(ergoscript): DeserializeRegister oracle test (T11 of 2i-c)"
```

---

## Task 12: DeserializeRegister mutation tests (1 commit)

**Files:**
- Create: `packages/ergoscript/test/eval-mutation/deserialize-register.test.ts`

Target ≥ 90% kill rate.

```bash
git commit -m "test(ergoscript): DeserializeRegister mutation testing (Layer C3.a)"
```

---

## Task 13: facts/ergoscript-eval.md sweep (1 commit)

**Files:**
- Modify: `facts/ergoscript-eval.md` — add Phase 2i-c changelog entry.
- Modify: `facts/ergoscript.md` (meta hub) — update Coverage summary table.

Add 2i-c changelog entry under "Scope (per-phase changelog)":

```markdown
**Phase 2i-c — Deserialize family** (additive):

- 2 new eval arms wired (coverage 65 → 67 of ~70 Expr arms): `DeserializeContext`, `DeserializeRegister`.
- Architecture: substitute-pre-pass mirroring sigma-rust eval.rs:203-250 + mir/expr.rs:442-496. `substituteDeserialize` runs as a bottom-up rewrite before `tryTrivialReduceExpr` + `evalExpr`. The Deserialize* eval arms are defensive throws (`'deserialize-not-substituted'`).
- 5 new EvalError codes (59 → 64):
  - `'deserialize-context-key-not-found'`
  - `'deserialize-input-not-byte-array'`
  - `'deserialize-parse-failed'`
  - `'deserialize-tpe-mismatch'`
  - `'deserialize-not-substituted'`
- 0 new method-handler-registry entries (44 unchanged).
- Architectural divergence from sigma-rust (deliberate, cost-equivalent): we keep `ctx.constants` populated for all paths and rely on `tryTrivialReduceExpr` handling both `Const` and `ConstPlaceholder`; sigma-rust uses `tree.proposition()` to eagerly substitute placeholders before the substitute pass. Identical cost+value output.
- New runtime dependency: none.

**Phase 2i-c COMPLETE.** Method handler registry: 44. EvalError codes: 64. Eval arm coverage: 67 of ~70. Ergoscript test count: ~3200+. Total monorepo: ~3780+.
```

Update `facts/ergoscript.md` Coverage summary table:
- "Evaluator: 65 of ~70" → "67 of ~70"
- "59 EvalError codes" → "64 EvalError codes"
- Test count: 3142 → ~3200+ (update once final count is known after T11)

- [ ] **Step 1: Apply edits**
- [ ] **Step 2: Commit**

```bash
git commit -m "docs(ergoscript): facts sweep for phase 2i-c (65->67 arms, +5 EvalError codes)"
```

---

## Task 14: README + SESSION_CONTEXT + HANDOFF_PROMPT sweep + push (1 commit + push)

**Files:**
- Modify: `README.md` — Packages table ergoscript row (eval arm coverage, recent-phase line).
- Modify: `SESSION_CONTEXT.md` — overwrite with phase 2i-c summary.
- Modify: `HANDOFF_PROMPT.md` — next-phase queue (2i-d becomes the natural next step).

- [ ] **Step 1: Apply edits**

- [ ] **Step 2: Final verification (REQUIRED — OVERRIDES rule #6)**

```bash
# TypeScript clean per-package
npx tsc --noEmit -p packages/scorex/tsconfig.json                          # CLEAN
npx tsc --noEmit -p packages/nipopow/tsconfig.json                         # CLEAN
npx tsc --noEmit -p packages/avltree/tsconfig.json                         # CLEAN
npx tsc --noEmit -p packages/ergoscript/tsconfig.json                      # CLEAN

# All tests pass under node
node_modules/.bin/vitest run packages/                                      # all pass

# All tests pass under jsdom (cross-runtime)
cd packages/scorex && npx vitest run --config vitest.browser.config.ts
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts
cd packages/avltree && npx vitest run --config vitest.browser.config.ts
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts

# Fixture determinism
cd fixture-gen && cargo run --release                                       # zero diff after re-run
git diff --exit-code packages/                                              # BYTE_IDENTICAL
git status                                                                  # CLEAN (modulo audit20260519/)
```

- [ ] **Step 3: Commit**

```bash
git add README.md SESSION_CONTEXT.md HANDOFF_PROMPT.md
git commit -m "$(cat <<'EOF'
docs: refresh README + SESSION_CONTEXT + HANDOFF_PROMPT for phase 2i-c

Phase 2i-c COMPLETE. 2 new eval arms (DeserializeContext, DeserializeRegister)
via substitute-pre-pass architecture. Eval arm coverage 65 -> 67 of ~70.
EvalError codes 59 -> 64. Method-handler registry unchanged at 44. Total
tests ~3780+. Next phase: 2i-d (long-tail parse-rejecting / deprecated arms:
OpTrue/OpFalse/UnitConstant, Select1-5, ModQ family, CollShift/CollRotate).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Push**

```bash
git push origin master
```

---

## Risk hotspots (carried from spec)

1. **Substitution pass cost-charging.** `substituteDeserialize` must NOT call `ctx.addCost`. Oracle fixtures assert cost-integer equality — any rogue charge trips immediately.
2. **Inner-Expr parsing with empty constants.** RESOLVED in spec — reject at parse per `constant_placeholder.rs:14-24`. Use `parseExpr(r, [], [], new Map(), treeVersion)`.
3. **`tree.has_deserialize()` traversal correctness.** O(n) walker with early-return on first match. Unit-test against a tree WITHOUT Deserialize nodes to assert false (no false positives on un-related tags).
4. **Tree-version threading.** Inner Expr parsed under `ctx.treeVersion ?? tree.header.version`. V<3 trees with V3-only inner-Expr arms fail at parse via `with_tree_version` semantics in our parser.
5. **Recursive Deserialize.** Inner Expr containing another Deserialize* trips either `'deserialize-not-substituted'` (defensive throw, T3) or `'cost-limit-exceeded'` (deeper recursion). Both acceptable; fixture `dc_throw_recursive` validates.
6. **Default-Expr type-check.** Sigma-rust applies the tpe-check post-`.or(default.as_deref().cloned())` (`expr.rs:486-491`). Implementation must apply check to BOTH register-decoded inner AND default-fallback. Fixture `dr_throw_default_wrong_type` validates.
7. **P2PK 50-JitCost short-circuit on substituted body.** Fixture `dc_const_sigmaprop_inner` validates cost-integer === 50.
8. **`set_deserialize` flag.** RESOLVED — marker only per `sigma_byte_reader.rs:138-144`.

## Expected outcome

- Eval-arm coverage: 65 → **67**
- EvalError codes: 59 → **64** (+5)
- Method-handler registry: **44** (unchanged)
- Ergoscript test count: 3142 → **~3200–3220** (+60–80)
- Total monorepo tests: 3720 → **~3780–3800**
- Commits: ~14 (T1=1, T2=1, T3=1, T4=1, T5=1, T6=1, T7=1, T8=1, T9=1, T10=1, T11=1, T12=1, T13=1, T14=1)
- Working tree clean modulo gitignored `audit20260519/`
- Origin pushed
