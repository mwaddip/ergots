# Phase 2h-d — SAvlTree completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto → halt and declare; #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Goal:** Wire three new SAvlTree method handlers (`updateOperations` at 100:8 Pattern A Fixed(45) V0+; `updateDigest` at 100:15 Pattern A Fixed(40) V0+; `insertOrUpdate` at 100:16 zero per-handler cost V3-gated at dispatcher) and close two carry-forward fixture-coverage gaps from 2h-b (V3+ per-op-fail-graceful for `insert` and unconditional per-op-fail-graceful for `update`). Method registry 39 → 42; EvalError taxonomy 47 → 48 (new code `'avl-tree-bad-digest-length'`).

**Architecture:** Three new handlers added to `packages/ergoscript/src/eval/savltree.ts`; two new helpers in `_avltree-adapter.ts` (`withUpdatedFlags`, `buildInsertOrUpdateOps`); dispatcher reuses the `minVersion?: number` field from 2h-c.2 (no infra change). Four new fixture-gen Rust modules (3 new-handler + 1 carry-forward). Two carry-forward fixtures appended to existing `savltree-insert.test.ts` / `savltree-update.test.ts`. No new TS source files, no new runtime deps, no avltree version bump.

**Tech Stack:** TypeScript (workspace ESM), vitest (node + jsdom), Rust fixture-gen against pinned sigma-rust `integration/ergots` branch, `@noble/hashes@2.2.0` (existing). No new dependencies.

**Spec:** `docs/specs/2026-05-20-ergoscript-phase-2h-d-savltree-completion-design.md`. **Spec wins on any interface disagreement.**

---

## File structure

**Created:**

- `fixture-gen/src/cmds/ergoscript/eval/savltree_update_operations.rs`
- `fixture-gen/src/cmds/ergoscript/eval/savltree_update_digest.rs`
- `fixture-gen/src/cmds/ergoscript/eval/savltree_insert_or_update.rs`
- `fixture-gen/src/cmds/ergoscript/eval/savltree_partial_success.rs` (emits both Phase 4 and Phase 5 carry-forward fixtures)
- `packages/ergoscript/test/fixtures/eval/savltree-update-operations.json`
- `packages/ergoscript/test/fixtures/eval/savltree-update-digest.json`
- `packages/ergoscript/test/fixtures/eval/savltree-insert-or-update.json`
- `packages/ergoscript/test/fixtures/eval/savltree-insert-partial.json`
- `packages/ergoscript/test/fixtures/eval/savltree-update-partial.json`
- `packages/ergoscript/test/eval/savltree-update-operations.test.ts`
- `packages/ergoscript/test/eval/savltree-update-digest.test.ts`
- `packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`

**Modified:**

- `packages/ergoscript/src/eval/_avltree-adapter.ts` — append `withUpdatedFlags` and `buildInsertOrUpdateOps` helpers.
- `packages/ergoscript/src/eval/savltree.ts` — append `evalSAvlTreeUpdateOperations`, `evalSAvlTreeUpdateDigest`, `evalSAvlTreeInsertOrUpdate` handler exports.
- `packages/ergoscript/src/eval/method-call.ts` — register the three new entries; `insertOrUpdate` carries `minVersion: 3`.
- `packages/ergoscript/src/eval/eval-context.ts` — extend the `EvalError` code-string union literal with `'avl-tree-bad-digest-length'`.
- `packages/ergoscript/test/eval/savltree-insert.test.ts` — append V3+ per-op-fail-graceful test.
- `packages/ergoscript/test/eval/savltree-update.test.ts` — append per-op-fail-graceful test.
- `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — register the four new modules.
- `fixture-gen/src/main.rs` — call into each new generator and write the JSON.
- `facts/ergoscript-eval.md` — Phase 2h-d changelog block, +3 registry rows (40, 41, 42), +1 taxonomy entry, count refresh.
- `facts/ergoscript.md` — registry count 39→42, EvalError count 47→48, test count refresh.

**Deleted:** none.

---

## Phase 1 — `SAvlTree.updateOperations` (100:8)

### Task 1: Add `withUpdatedFlags` helper + fixture-gen module + emit fixture

**Files:**
- Modify: `packages/ergoscript/src/eval/_avltree-adapter.ts` (append helper)
- Create: `fixture-gen/src/cmds/ergoscript/eval/savltree_update_operations.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (register module)
- Modify: `fixture-gen/src/main.rs` (call generator + write JSON)

- [ ] **Step 1: Append helper to `_avltree-adapter.ts`**

After the existing `withUpdatedDigest` (around line 75) add:

```ts
/**
 * Immutable: produce a new `AvlTreeData` with `treeFlags` replaced; `digest`,
 * `keyLength`, `valueLengthOpt` carry forward unchanged.
 *
 * Used by `SAvlTree.updateOperations` (100:8) — caller pre-narrows the input
 * i8 SValue to u8 via `& 0xff`. Source: sigma-rust's
 * `avl_tree_data.tree_flags = AvlTreeFlags::parse(new_byte)` at
 * `eval/savltree.rs:86`. We store the byte directly; flag-bit semantics are
 * encoded by the existing `INSERT_ALLOWED_BIT` / `UPDATE_ALLOWED_BIT` /
 * `REMOVE_ALLOWED_BIT` constants in `savltree.ts`.
 */
export function withUpdatedFlags(tree: AvlTreeData, flags: number): AvlTreeData {
  return {
    digest: tree.digest,
    treeFlags: flags & 0xff,
    keyLength: tree.keyLength,
    valueLengthOpt: tree.valueLengthOpt,
  }
}
```

- [ ] **Step 2: Create `savltree_update_operations.rs`**

Pattern follows `fixture-gen/src/cmds/ergoscript/eval/savltree_enabled_operations.rs` (Tier-1 accessor template). Build an `AvlTreeData` with a known starting flag byte, construct a `MethodCall` Expr invoking `updateOperations` with a new Byte arg, call `try_eval_out_with_version` to capture the SValue + cost oracle:

```rust
use anyhow::Result;
use ergotree_ir::ergo_tree::ErgoTreeVersion;
use ergotree_ir::mir::avl_tree_data::{AvlTreeData, AvlTreeFlags};
use ergotree_ir::mir::constant::Constant;
use ergotree_ir::mir::expr::Expr;
use ergotree_ir::mir::method_call::MethodCall;
use ergotree_ir::types::savltree;
use ergotree_ir::types::stype::SType;
use ergotree_ir::chain::digest32::ADDigest;

use crate::cmds::ergoscript::eval::common::{build_tree_bytes, oracle_method_call, MethodCallFixture};

pub fn generate() -> Result<MethodCallFixture> {
    // Starting tree: flags = 0b111 (insert+update+remove enabled).
    let starting_digest = ADDigest::zero();
    let avl = AvlTreeData {
        digest: starting_digest,
        tree_flags: AvlTreeFlags::new(true, true, true),
        key_length: 32,
        value_length_opt: None,
    };

    // New flags byte: 0b101 (insert + remove, NO update).
    let new_flags: i8 = 0b101;

    let method_call = Expr::MethodCall(MethodCall::new(
        Expr::Const(Constant::from(avl.clone())),
        savltree::UPDATE_OPERATIONS_METHOD.clone(),
        vec![Expr::Const(Constant::from(new_flags))],
        Default::default(),
    )?);

    let tree_bytes = build_tree_bytes(&method_call, ErgoTreeVersion::V0)?;
    let oracle = oracle_method_call(&method_call, ErgoTreeVersion::V0)?;

    Ok(MethodCallFixture {
        name: "savltree-update-operations".to_string(),
        tree_bytes,
        expected_svalue: oracle.value_json,
        expected_jit_cost: oracle.cost,
        expected_throw: None,
    })
}
```

(Field names and helper signatures will mirror existing `savltree_enabled_operations.rs` — read that file at fixture-gen time and align exactly. The above is illustrative.)

- [ ] **Step 3: Register module in `mod.rs`**

Add `pub mod savltree_update_operations;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs` (alphabetical with the other `savltree_*` modules — after `savltree_remove`).

- [ ] **Step 4: Wire the generator in `main.rs`**

Add lines following the existing `savltree_enabled_operations` pattern (around `main.rs:282`):

```rust
let savltree_update_operations_fixture =
    cmds::ergoscript::eval::savltree_update_operations::generate()?;
write_ergoscript_json(
    "eval/savltree-update-operations.json",
    &savltree_update_operations_fixture,
)?;
```

- [ ] **Step 5: Run cargo to emit the fixture**

Run: `cd fixture-gen && cargo run --release`
Expected: builds clean, emits `packages/ergoscript/test/fixtures/eval/savltree-update-operations.json`.

- [ ] **Step 6: Run cargo a second time to verify determinism**

Run: `cd fixture-gen && cargo run --release && git diff packages/ergoscript/test/fixtures/eval/savltree-update-operations.json`
Expected: empty diff. If non-empty, halt — this is a determinism regression.

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/src/eval/_avltree-adapter.ts \
        fixture-gen/src/cmds/ergoscript/eval/savltree_update_operations.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/savltree-update-operations.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SAvlTree.updateOperations oracle fixture

Adds withUpdatedFlags helper to _avltree-adapter.ts (immutable projection
mutating only treeFlags) and the Rust-side fixture-gen module emitting
savltree-update-operations.json with a single oracle scenario (starting
flags 0b111, new flags 0b101, expect AvlTreeData with treeFlags === 5).
Pattern A cost 45 captured from try_eval_out_with_version.

Determinism verified via repeat cargo run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: RED test for `SAvlTree.updateOperations`

**Files:**
- Create: `packages/ergoscript/test/eval/savltree-update-operations.test.ts`

- [ ] **Step 1: Write the failing test**

Pattern mirrors `packages/ergoscript/test/eval/savltree-contains.test.ts` exactly (Tier-1 / Tier-2 accessor template). Imports come from `'../_helpers'`, `'../../src/wire/ergo-tree'`, `'../../src/eval/eval-context'`, `'../../src/eval/evaluate'`. Fixture JSON shape is `{ corpus, entries: [{ name, tree_bytes_hex, opts_json, expected_value_json, expected_cost }] }`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface UpdateOperationsEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}
interface UpdateOperationsFixture {
  corpus: string
  entries: UpdateOperationsEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update-operations.json')
const fixture: UpdateOperationsFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.updateOperations (100:8) — fixture-driven', () => {
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update-operations.test.ts`
Expected: FAIL with `EvalError: 'method-not-implemented'` (dispatcher rejects 100:8 because no handler registered yet).

- [ ] **Step 3: Commit (RED)**

```bash
git add packages/ergoscript/test/eval/savltree-update-operations.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): RED — SAvlTree.updateOperations oracle test (no handler yet)

Loads savltree-update-operations.json and asserts evaluate() value + cost
match. Fails with 'method-not-implemented' until Task 3 wires the
handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: GREEN — implement `evalSAvlTreeUpdateOperations` + register

**Files:**
- Modify: `packages/ergoscript/src/eval/savltree.ts` (append handler)
- Modify: `packages/ergoscript/src/eval/method-call.ts` (register at 100:8)

- [ ] **Step 1: Add `expectOneArg` helper to `savltree.ts`**

After the existing `expectTwoArgs` (around line 256) add:

```ts
/**
 * Defensive 1-arg arity check; updateOperations (Byte) and updateDigest
 * (Coll[Byte]) both take exactly 1 arg. Reuses `'method-not-implemented'`
 * per the compact-taxonomy decision.
 */
function expectOneArg(handlerName: string, args: SValue[]): void {
  if (args.length !== 1) {
    throw new EvalError(
      `${handlerName} expects 1 arg; got ${args.length}`,
      'method-not-implemented'
    )
  }
}
```

- [ ] **Step 2: Add `withUpdatedFlags` import in `savltree.ts`**

Modify the import block (lines 43-53) — add `withUpdatedFlags` to the existing import:

```ts
import {
  avlTreeDataToConfig,
  buildInsertOps,
  buildLookupOps,
  buildRemoveOps,
  buildSingleLookupOp,
  buildUpdateOps,
  extractByteArrayList,
  extractBytes,
  withUpdatedDigest,
  withUpdatedFlags,  // NEW
} from './_avltree-adapter'
```

- [ ] **Step 3: Append the handler to `savltree.ts`** (after `evalSAvlTreeRemove`)

```ts
/**
 * `SAvlTree.updateOperations` (100:8) — replaces treeFlags byte.
 * Source: savltree.rs:77-88 — UPDATE_OPERATIONS_EVAL_FN.
 *
 * Pattern A Fixed(45) — addCost(45) BEFORE shape check (matches sigma-rust's
 * `ctx.add_jit_cost(45)?` at line 78). Pure projection over AvlTreeData;
 * no @ergots/avltree call.
 *
 * SType: (SAvlTree, SByte) → SAvlTree.
 *
 * Defensive checks reuse 'avl-tree-obj-not-avl-tree' (existing) and
 * 'method-not-implemented' (existing per compact-taxonomy).
 */
export function evalSAvlTreeUpdateOperations(
  ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  ctx.addCost(45)
  expectAvlTree('SAvlTree.updateOperations', obj)
  expectOneArg('SAvlTree.updateOperations', args)
  if (args[0]!.kind !== 'Byte') {
    throw new EvalError(
      `SAvlTree.updateOperations expects Byte arg; got '${args[0]!.kind}'`,
      'method-not-implemented'
    )
  }
  const newFlags = args[0]!.value & 0xff  // i8 → u8
  return { kind: 'AvlTree', value: withUpdatedFlags(obj.value, newFlags) }
}
```

- [ ] **Step 4: Register in `method-call.ts`**

Locate the `HANDLERS` registry definition. Add the new entry alongside existing `SAvlTree.*` entries:

```ts
HANDLERS.set('100:8', { handler: evalSAvlTreeUpdateOperations })
```

(Also add `evalSAvlTreeUpdateOperations` to the import at the top of `method-call.ts`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update-operations.test.ts`
Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

- [ ] **Step 7: Commit (GREEN)**

```bash
git add packages/ergoscript/src/eval/savltree.ts \
        packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): SAvlTree.updateOperations method handler (100:8)

Pattern A Fixed(45); V0+. Pure projection over AvlTreeData.treeFlags
via the new withUpdatedFlags helper. Registers in HANDLERS at 100:8.

Adds expectOneArg local helper (mirrors expectTwoArgs) for arity
defense.

Registry: 39 -> 40.

Source: eval/savltree.rs:77-88 (UPDATE_OPERATIONS_EVAL_FN).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Edge cases + mutation tests for `updateOperations`

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-update-operations.test.ts`

- [ ] **Step 1: Append edge-case tests**

```ts
import { EvalError } from '../../src/eval/eval-context'

// (Append after the oracle test)

describe('SAvlTree.updateOperations — edge cases', () => {
  it('throws avl-tree-obj-not-avl-tree on non-AvlTree receiver', () => {
    // Construct a hand-crafted SValue.Long receiver via the dispatcher path;
    // assert the typed throw. Pattern mirrors savltree-enabled-operations.test.ts
    // hand-crafted negative case.
    // ... (mirror existing receiver-defense pattern)
  })

  it('throws method-not-implemented when arg is not Byte', () => {
    // Hand-craft an SAvlTree obj + non-Byte arg via the dispatcher.
    // ... (mirror existing arg-shape-defense pattern)
  })

  it('throws cost-limit-exceeded if jitCostLimit < 45', () => {
    // Verify Pattern A cost charges before shape check.
    // ... (mirror existing cost-limit pattern)
  })
})
```

(Each edge case should mirror the analogous test in `savltree-enabled-operations.test.ts` — read that file and replicate the pattern exactly.)

- [ ] **Step 2: Run tests**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update-operations.test.ts`
Expected: PASS (all cases).

- [ ] **Step 3: Append mutation tests targeting ≥ 90% kill rate**

Mutation surface: the `treeBytes` from the fixture. Each single-byte flip should either throw a typed error class or return a different `SValue`. Tolerance enumeration (mutations expected to be byte-identical to the original tree, e.g., flips inside header padding bytes) is committed in the test file.

Pattern mirrors existing mutation test in `savltree-enabled-operations.test.ts` — read and replicate.

- [ ] **Step 4: Run mutation tests**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update-operations.test.ts`
Expected: PASS, kill rate ≥ 90%.

- [ ] **Step 5: Run cross-runtime under jsdom**

Run: `cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts savltree-update-operations`
Expected: PASS under jsdom.

- [ ] **Step 6: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-update-operations.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SAvlTree.updateOperations edge cases + mutation testing

Negative-path tests: non-AvlTree receiver (avl-tree-obj-not-avl-tree),
non-Byte arg (method-not-implemented), cost-limit-exceeded with
jitCostLimit < 45. Mutation testing across treeBytes at >= 90% kill
rate per the 2h-b posture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — `SAvlTree.updateDigest` (100:15)

### Task 5: Add `'avl-tree-bad-digest-length'` EvalError code

**Files:**
- Modify: `packages/ergoscript/src/eval/eval-context.ts`

- [ ] **Step 1: Locate the `EvalError` code union literal**

Run: `grep -n "type EvalErrorCode\|EvalErrorCode =\|'avl-tree-proof-failed'" packages/ergoscript/src/eval/eval-context.ts`
Expected: One match showing the union literal definition.

- [ ] **Step 2: Add the new code**

Extend the union literal with `'avl-tree-bad-digest-length'`. Position alphabetically alongside the existing `'avl-tree-*'` codes:

```ts
export type EvalErrorCode =
  // ... existing codes ...
  | 'avl-tree-bad-digest-length'  // NEW — SAvlTree.updateDigest length-check
  | 'avl-tree-obj-not-avl-tree'
  | 'avl-tree-proof-failed'
  // ... rest of union ...
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

- [ ] **Step 4: Commit**

```bash
git add packages/ergoscript/src/eval/eval-context.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): add 'avl-tree-bad-digest-length' EvalError code

Adds the typed error code that SAvlTree.updateDigest (forthcoming
handler) will throw when its Coll[Byte] arg is not exactly 33 bytes.
Mirrors sigma-rust's ADDigest::try_from length-check failure
(eval/savltree.rs:98).

Taxonomy: 47 -> 48 codes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Fixture-gen for `updateDigest` (happy + bad-length-throw)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/savltree_update_digest.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`

- [ ] **Step 1: Create `savltree_update_digest.rs`**

Emits a multi-scenario fixture array (mirrors the pattern from `savltree_insert.rs` which has multiple scenarios). Two scenarios:

1. **Happy:** Starting tree with digest A; arg = fresh 33-byte digest B. Expect `AvlTree` with `digest === B`.
2. **Bad-length-throw:** Starting tree; arg = 32-byte Coll[Byte]. **Cannot run through sigma-rust's eval oracle** because sigma-rust would throw before producing a Value. Instead emit `expectedThrow: { code: 'avl-tree-bad-digest-length', message: '...' }` and `expectedSValue: null`. The TS test asserts the throw.

Module skeleton:

```rust
use anyhow::Result;
use ergotree_ir::ergo_tree::ErgoTreeVersion;
// ... (mirror savltree_update.rs imports)

pub fn generate() -> Result<Vec<MethodCallFixture>> {
    Ok(vec![
        generate_happy()?,
        generate_bad_length()?,
    ])
}

fn generate_happy() -> Result<MethodCallFixture> {
    // Construct AvlTree with digest A (33 bytes); call updateDigest with
    // digest B (33 bytes). Capture oracle.
}

fn generate_bad_length() -> Result<MethodCallFixture> {
    // Construct AvlTree; build MethodCall with a 32-byte Coll[Byte] arg.
    // DO NOT call try_eval_out_with_version (sigma-rust would throw mid-eval
    // and we can't capture a Value). Instead serialize the tree bytes
    // directly and emit the fixture with expectedThrow + expectedSValue:null.
    // The cost is set to receiver-eval + envelope cost only (sigma-rust
    // never reaches addCost(40) because the bad-length check is BEFORE
    // the handler's cost charge — WAIT, no: our handler charges cost
    // BEFORE the length check (Pattern A). So expectedJitCost INCLUDES the
    // 40-unit handler cost. Match sigma-rust exactly by NOT capturing the
    // oracle for this scenario; instead set expectedJitCost from a
    // hand-computed value documented in a comment.
}
```

(The bad-length-throw scenario requires special handling: sigma-rust's `try_eval_out_with_version` returns Err for this case, not a Value+cost. We capture the structural data — tree bytes + expected throw code — and let the TS test assert the throw. The expected cost is post-Pattern-A-charge but pre-length-check-throw, i.e., includes the 40-unit charge.)

- [ ] **Step 2: Register module in `mod.rs`**

Add `pub mod savltree_update_digest;`.

- [ ] **Step 3: Wire in `main.rs`**

Multi-fixture generators write multiple JSON files OR write a single JSON array. Mirror `savltree_insert.rs`'s pattern — likely single JSON file with an array of scenarios. Adapt `write_ergoscript_json` accordingly:

```rust
let savltree_update_digest_fixtures =
    cmds::ergoscript::eval::savltree_update_digest::generate()?;
write_ergoscript_json(
    "eval/savltree-update-digest.json",
    &savltree_update_digest_fixtures,
)?;
```

- [ ] **Step 4: Run cargo to emit + verify determinism**

```bash
cd fixture-gen && cargo run --release
cd fixture-gen && cargo run --release && git diff packages/ergoscript/test/fixtures/eval/savltree-update-digest.json
```
Expected: empty diff on second run.

- [ ] **Step 5: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/savltree_update_digest.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/savltree-update-digest.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SAvlTree.updateDigest oracle + bad-length-throw fixtures

Two scenarios: happy (33-byte new digest, expect AvlTree with replaced
digest) and bad-length-throw (32-byte arg, expect EvalError
'avl-tree-bad-digest-length'). The bad-length scenario captures
expectedThrow + null expectedSValue since sigma-rust's
try_eval_out_with_version doesn't produce a Value for thrown paths.

Pattern A Fixed(40) cost.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: RED + GREEN for `updateDigest`

**Files:**
- Create: `packages/ergoscript/test/eval/savltree-update-digest.test.ts`
- Modify: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`

- [ ] **Step 1: Write the failing test**

Same scaffold pattern as Task 2 (mirror `savltree-contains.test.ts`), but with optional `expected_throw` field per entry to support the bad-length-throw scenario:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface UpdateDigestEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json?: unknown
  expected_cost: number
  expected_throw?: { code: string; message?: string }
}
interface UpdateDigestFixture {
  corpus: string
  entries: UpdateDigestEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update-digest.json')
const fixture: UpdateDigestFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.updateDigest (100:15) — fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      if (entry.expected_throw) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_throw.code)
        expect(ctx.jitCost).toBe(entry.expected_cost)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
```

- [ ] **Step 2: Verify test fails**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update-digest.test.ts`
Expected: FAIL with `'method-not-implemented'` (handler not registered).

- [ ] **Step 3: Implement handler in `savltree.ts`**

After `evalSAvlTreeUpdateOperations`:

```ts
/**
 * `SAvlTree.updateDigest` (100:15) — replaces the 33-byte digest.
 * Source: savltree.rs:90-102 — UPDATE_DIGEST_EVAL_FN.
 *
 * Pattern A Fixed(40) — addCost(40) BEFORE shape check (matches sigma-rust's
 * `ctx.add_jit_cost(40)?` at line 91). Pure projection over AvlTreeData;
 * no @ergots/avltree call.
 *
 * SType: (SAvlTree, SColl(SByte)) → SAvlTree.
 *
 * Defensive 33-byte length check — sigma-rust surfaces the same condition
 * via `ADDigest::try_from(bytes_vec)` failing inside `map_eval_err`. Reachable
 * from script-controlled data (any Coll[Byte] can be passed); thrown
 * specifically as 'avl-tree-bad-digest-length' (NEW code; not reused).
 *
 * `withUpdatedDigest` (existing helper, _avltree-adapter.ts:68-75) does NOT
 * validate length — it's pure field-substitution. The handler's pre-check
 * is the sole length gate.
 */
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

- [ ] **Step 4: Register in `method-call.ts`**

```ts
HANDLERS.set('100:15', { handler: evalSAvlTreeUpdateDigest })
```

Add `evalSAvlTreeUpdateDigest` to the import.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update-digest.test.ts`
Expected: PASS (both happy + bad-length-throw).

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-update-digest.test.ts \
        packages/ergoscript/src/eval/savltree.ts \
        packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): SAvlTree.updateDigest method handler (100:15)

Pattern A Fixed(40); V0+. Validates 33-byte length explicitly (throws
'avl-tree-bad-digest-length' on mismatch). Projects new digest into
fresh AvlTreeData via existing withUpdatedDigest helper.

Registry: 40 -> 41.

Source: eval/savltree.rs:90-102 (UPDATE_DIGEST_EVAL_FN). Two-scenario
fixture (happy + bad-length-throw) committed in previous task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Edge cases + mutation tests for `updateDigest`

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-update-digest.test.ts`

- [ ] **Step 1: Append edge-case tests**

Cases: non-AvlTree receiver, non-Coll arg, 0-byte arg, 34-byte arg (over by one), cost-limit-exceeded with `jitCostLimit < 40`.

(Mirror existing patterns in `savltree-update-operations.test.ts` from Task 4.)

- [ ] **Step 2: Append mutation tests at ≥ 90% kill rate**

- [ ] **Step 3: Verify all tests pass**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update-digest.test.ts`
Expected: PASS.

- [ ] **Step 4: Run cross-runtime under jsdom**

Run: `cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts savltree-update-digest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-update-digest.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SAvlTree.updateDigest edge cases + mutation testing

Negative-path tests: non-AvlTree receiver, non-Coll arg, 0-byte arg,
34-byte arg (boundary), cost-limit-exceeded. Mutation testing across
both fixture scenarios at >= 90% kill rate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — `SAvlTree.insertOrUpdate` (100:16) — V3-gated at dispatcher

### Task 9: Add `buildInsertOrUpdateOps` helper

**Files:**
- Modify: `packages/ergoscript/src/eval/_avltree-adapter.ts`

- [ ] **Step 1: Append helper**

After `buildUpdateOps` (around line 119):

```ts
/**
 * Same shape as `buildInsertOps` but emits `InsertOrUpdate` ops. Used by
 * `SAvlTree.insertOrUpdate` (100:16; V3-gated). Source: savltree.rs:480-489.
 *
 * `extractEntries` returns `{ key, value }[]` per the existing
 * shape-extractor signature.
 */
export function buildInsertOrUpdateOps(entries: SValue): Operation[] {
  const pairs = extractEntries(entries)
  return pairs.map(({ key, value }) => ({ tag: 'InsertOrUpdate', key, value }))
}
```

- [ ] **Step 2: Verify `Operation.InsertOrUpdate` variant exists in `@ergots/avltree`**

Run: `grep -n "'InsertOrUpdate'" packages/avltree/src/`
Expected: At least one match in the `Operation` type definition. Per `facts/avltree.md:96`, the variant ships in avltree v0.2.0; this grep is a defensive verification.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN (helper signatures align with existing `Operation` type).

- [ ] **Step 4: Commit**

```bash
git add packages/ergoscript/src/eval/_avltree-adapter.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): buildInsertOrUpdateOps adapter helper

Mirrors buildInsertOps from 2h-b, swapping the Operation tag from
'Insert' to 'InsertOrUpdate'. Consumed by the forthcoming
SAvlTree.insertOrUpdate (100:16) handler.

The Operation.InsertOrUpdate variant ships in @ergots/avltree v0.2.0
(facts/avltree.md:96); no avltree version bump required.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Fixture-gen for `insertOrUpdate` (6 scenarios)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/savltree_insert_or_update.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`

- [ ] **Step 1: Create `savltree_insert_or_update.rs`**

Six scenarios per the spec:

1. **happy-v3:** V3 tree, both flags set, batch of 3 InsertOrUpdate ops (mix: 2 inserts on absent keys, 1 update on existing key). Expect `Some(AvlTree(new_digest))`.
2. **insert-allowed-false:** V3 tree with `insertAllowed=false, updateAllowed=true`. Expect `Option None` (pre-check fail).
3. **update-allowed-false:** V3 tree with `insertAllowed=true, updateAllowed=false`. Expect `Option None`.
4. **per-op-fail-graceful:** V3 tree, both flags set, batch where op 2 violates an invariant (e.g., bad value length for fixed-valueLengthOpt tree). Verifier breaks; `bv.digest()` returns None → `Option None`.
5. **malformed-proof:** V3 tree, both flags set, proof bytes corrupted. Expect `'avl-tree-proof-failed'` throw.
6. **v2-dispatcher-reject:** V2 tree, both flags set, otherwise valid. Expect `'tree-version-too-low'` throw (raised by dispatcher BEFORE handler).

Pattern mirrors `savltree_insert.rs` for scenarios 1-5 and `sheader_checkpow.rs` (the V<3 dispatcher-reject parallel-pair from 2h-c.2) for scenario 6.

- [ ] **Step 2: Register module + wire in main.rs**

Same pattern as Task 6 — register in `mod.rs` and add the generator call + JSON write in `main.rs`.

- [ ] **Step 3: Run cargo + verify determinism**

```bash
cd fixture-gen && cargo run --release
cd fixture-gen && cargo run --release && git diff packages/ergoscript/test/fixtures/eval/savltree-insert-or-update.json
```
Expected: empty diff on second run.

- [ ] **Step 4: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/savltree_insert_or_update.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/savltree-insert-or-update.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SAvlTree.insertOrUpdate 6-scenario fixture

Scenarios: happy-v3 (both flags set, batch InsertOrUpdate),
insert-allowed-false pre-check, update-allowed-false pre-check,
per-op-fail-graceful (V3+ break path), malformed-proof
('avl-tree-proof-failed' throw), v2-dispatcher-reject
('tree-version-too-low' throw from dispatcher).

Captures the V3-gating cost-parity invariant: the V2-dispatcher-reject
scenario's expectedJitCost equals receiver-eval + envelope cost only,
NOT the handler's zero per-handler cost (parallel-pair pattern from
2h-c.2 SHeader.checkPow).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: RED + GREEN for `insertOrUpdate`

**Files:**
- Create: `packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`
- Modify: `packages/ergoscript/src/eval/savltree.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`

- [ ] **Step 1: Write failing test (mirrors Task 7 pattern with 6-scenario loop)**

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface InsertOrUpdateEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json?: unknown
  expected_cost: number
  expected_throw?: { code: string; message?: string }
}
interface InsertOrUpdateFixture {
  corpus: string
  entries: InsertOrUpdateEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-insert-or-update.json')
const fixture: InsertOrUpdateFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.insertOrUpdate (100:16) — V3-gated, fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      if (entry.expected_throw) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_throw.code)
        expect(ctx.jitCost).toBe(entry.expected_cost)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
```

- [ ] **Step 2: Verify all 6 scenarios fail**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`
Expected: All FAIL with `'method-not-implemented'` (handler not registered) — including the v2-dispatcher-reject which currently throws `'method-not-implemented'` instead of `'tree-version-too-low'` because the registry has no entry to gate.

- [ ] **Step 3: Add imports + implement handler in `savltree.ts`**

Add `buildInsertOrUpdateOps` to the `_avltree-adapter` import. Append the handler after `evalSAvlTreeRemove`:

```ts
/**
 * `SAvlTree.insertOrUpdate` (100:16) — V3-gated InsertOrUpdate batch.
 * Source: savltree.rs:441-498 — INSERT_OR_UPDATE_EVAL_FN. Descriptor at
 * types/savltree.rs:377-403 with min_version: ErgoTreeVersion::V3.
 *
 * V-gating: dispatcher-level via `minVersion: 3` on the HANDLERS entry. The
 * dispatcher throws 'tree-version-too-low' BEFORE invoking this handler when
 * (ctx.treeVersion ?? 0) < 3. Mirrors sigma-rust's MethodDesc.min_version
 * gate. Receiver-eval + envelope cost (4) are still charged; the handler's
 * zero per-handler cost is not.
 *
 * Pre-check: BOTH insert_allowed AND update_allowed must be set
 * (line 444). Asymmetric vs insert (insert_allowed only) and update
 * (update_allowed only). Either flag unset → Option None.
 *
 * Verifier path: verifyAvlBatchPartial with InsertOrUpdate ops:
 *   - partial === null (construct fail) → throw 'avl-tree-proof-failed'
 *   - partial.opsCompleted < ops.length → graceful break (always; no V<3
 *     throw path because dispatcher already rejected V<3) → Option None
 *   - Full success → Some(AvlTree(new_digest))
 */
export function evalSAvlTreeInsertOrUpdate(
  _ctx: EvalContext,
  obj: SValue,
  args: SValue[]
): SValue {
  expectAvlTree('SAvlTree.insertOrUpdate', obj)
  expectTwoArgs('SAvlTree.insertOrUpdate', args)
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
    throw new EvalError(
      'SAvlTree.insertOrUpdate: verifier construct failed',
      'avl-tree-proof-failed'
    )
  }
  if (partial.opsCompleted < ops.length) {
    // V<3 already rejected at dispatcher; V3+ break path: bv.digest()
    // returns None post-poison → Option None (matches savltree.rs:495-497).
    return noneAvlTree()
  }
  return someAvlTree(withUpdatedDigest(obj.value, partial.newDigest))
}
```

- [ ] **Step 4: Register in `method-call.ts` with `minVersion: 3`**

```ts
HANDLERS.set('100:16', { handler: evalSAvlTreeInsertOrUpdate, minVersion: 3 })
```

(Add `evalSAvlTreeInsertOrUpdate` to the import.)

- [ ] **Step 5: Verify all 6 scenarios pass**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`
Expected: PASS (all 6).

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-insert-or-update.test.ts \
        packages/ergoscript/src/eval/savltree.ts \
        packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): SAvlTree.insertOrUpdate method handler (100:16) V3-gated

Zero per-handler cost (verifier owns the per-op blake2b work).
V3-gated via dispatcher-level `minVersion: 3` on the HANDLERS entry —
V<3 throws 'tree-version-too-low' BEFORE the handler runs, matching
sigma-rust's MethodDesc.min_version semantics (cost-parity: only
receiver-eval + envelope cost charged on V<3 reject).

Pre-check: BOTH insert_allowed AND update_allowed must be set
(asymmetric vs insert/update which check one each); either unset
returns Option None per savltree.rs:444.

Verifier delegates to @ergots/avltree's verifyAvlBatchPartial with
Operation.InsertOrUpdate per entry. Per-op-fail always graceful breaks
to Option None (sigma-rust poisons bv.digest() to None post-fail).

Registry: 41 -> 42.

Source: eval/savltree.rs:441-498 (INSERT_OR_UPDATE_EVAL_FN).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: V<3 dispatcher-reject parallel-pair cost test

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`

The 6-scenario fixture from Task 10 already includes a `v2-dispatcher-reject` scenario asserting the `'tree-version-too-low'` throw. This task adds the **parallel-pair cost-correctness test** that asserts the cost delta between V3+ success and V2 dispatcher-reject equals zero per-handler cost (matching the 2h-c.2 SHeader.checkPow precedent).

- [ ] **Step 1: Append parallel-pair cost test**

```ts
describe('SAvlTree.insertOrUpdate — V3 dispatcher-gating cost parity', () => {
  it('V2 reject incurs receiver-eval + envelope cost only, not the handler cost', () => {
    // Find the v3 happy scenario (full handler cost charged).
    const v3Happy = fixture.entries.find(e => e.name === 'happy-v3')!
    // Find the v2 reject scenario (dispatcher throws before handler).
    const v2Reject = fixture.entries.find(e => e.name === 'v2-dispatcher-reject')!

    // Capture the V3 success cost.
    const v3Tree = parseTree(hexToBytes(v3Happy.tree_bytes_hex))
    const v3Ctx = makeContext(rehydrateEvalOpts(v3Happy.opts_json))
    evaluateWith(v3Tree, v3Ctx)

    // Capture the V2 reject cost: evaluateWith throws but the EvalContext
    // accumulates cost up to the throw (cost-before-throw semantics from
    // 2h-c.2 dispatcher).
    const v2Tree = parseTree(hexToBytes(v2Reject.tree_bytes_hex))
    const v2Ctx = makeContext(rehydrateEvalOpts(v2Reject.opts_json))
    const err = captureEvalError(() => evaluateWith(v2Tree, v2Ctx))
    expect(err.code).toBe('tree-version-too-low')

    // Per-handler cost for insertOrUpdate is 0 (verifier owns the work).
    // The cost delta between V3 success and V2 reject should be exactly the
    // sum of all per-op verifier costs in the happy scenario (zero from the
    // handler itself).
    expect(v3Ctx.jitCost).toBe(v3Happy.expected_cost)
    expect(v2Ctx.jitCost).toBe(v2Reject.expected_cost)

    // Sanity: the V2 reject cost equals exactly the receiver-eval + envelope
    // cost (no per-op verifier costs were paid because the handler never ran).
    expect(v2Ctx.jitCost).toBeLessThan(v3Ctx.jitCost)
  })
})
```

- [ ] **Step 2: Run test**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-insert-or-update.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): parallel-pair V<3 dispatcher-reject cost test

Asserts the dispatcher minVersion: 3 gate on SAvlTree.insertOrUpdate
incurs receiver-eval + envelope cost only on V<3 reject (handler's
zero per-handler cost is not charged because the handler never runs).
Matches the 2h-c.2 SHeader.checkPow parallel-pair pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Mutation tests for `insertOrUpdate`

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`

- [ ] **Step 1: Append mutation tests per scenario**

For each of the 6 scenarios, append a mutation block over the `treeBytes`. Target ≥ 90% kill rate per scenario.

Per the spec's Q3 deferred question: if hitting 90% across 6 scenarios is too aggressive, fall back to per-scenario mutation with explicit tolerance enumeration. Decide at implementation time after seeing the first scenario's kill rate.

- [ ] **Step 2: Run mutation tests**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`
Expected: PASS, ≥ 90% kill rate per scenario.

- [ ] **Step 3: Run cross-runtime under jsdom**

Run: `cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts savltree-insert-or-update`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-insert-or-update.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SAvlTree.insertOrUpdate mutation testing

Per-scenario mutation testing across all 6 fixture scenarios at >= 90%
kill rate. Tolerance enumeration committed in-test for byte-tolerated
flips.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Carry-forward fixture: `SAvlTree.insert` V3+ per-op-fail-graceful

### Task 14: Audit existing `savltree-insert.json` + write `savltree_partial_success.rs`

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/savltree_partial_success.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`
- Modify: `fixture-gen/src/main.rs`

- [ ] **Step 1: Audit `savltree-insert.json`**

Run: `cat packages/ergoscript/test/fixtures/eval/savltree-insert.json | jq '.[].name'`
(or grep if jq isn't available)

Document which scenarios exist. Specifically check whether:
- A V<3 per-op-fail-throw case is already covered (`'avl-tree-proof-failed'` throw at savltree.ts:448-453).
- A V3+ per-op-fail-graceful case exists (the carry-forward target).

If V<3 per-op-fail-throw is NOT covered, add it as an optional scenario in the fixture-gen module. If it IS covered, skip the optional hardening scenario.

- [ ] **Step 2: Create `savltree_partial_success.rs`**

Emits both Phase 4 (insert) and Phase 5 (update) carry-forward fixtures from a single Rust module (shared scaffolding for building the populated tree + proof). Two-output module:

```rust
pub fn generate_insert_partial() -> Result<MethodCallFixture> {
    // V3 tree, INSERT_ALLOWED set. Build a tree with 3 pre-existing keys.
    // Batch of 3 insert ops where op 2 is an insert-on-existing-key.
    // Op 1 succeeds; op 2 fails; bv.digest() returns None post-poison.
    // Expected SValue: Option None. Expected cost: oracle-captured.
}

pub fn generate_update_partial() -> Result<MethodCallFixture> {
    // V0 tree, UPDATE_ALLOWED set. Build a tree with 3 pre-existing keys.
    // Batch of 3 update ops where op 2 targets an ABSENT key.
    // Op 1 succeeds; op 2 fails; bv.digest() returns None.
    // Expected SValue: Option None. Expected cost: oracle-captured.
}

pub fn generate_insert_v2_throw() -> Result<MethodCallFixture> {
    // Optional. V0 tree, INSERT_ALLOWED set. Same per-op-fail scenario
    // as insert_partial but on V0 — expect 'avl-tree-proof-failed' throw.
    // Only emit if audit (Step 1) finds no existing coverage.
}
```

- [ ] **Step 3: Wire in `mod.rs` and `main.rs`**

Same registration pattern. Each output gets its own JSON file:
- `savltree-insert-partial.json` (Phase 4)
- `savltree-update-partial.json` (Phase 5 — emitted in same module run)
- `savltree-insert-partial-v2-throw.json` (optional)

```rust
let savltree_insert_partial =
    cmds::ergoscript::eval::savltree_partial_success::generate_insert_partial()?;
write_ergoscript_json(
    "eval/savltree-insert-partial.json",
    &savltree_insert_partial,
)?;
let savltree_update_partial =
    cmds::ergoscript::eval::savltree_partial_success::generate_update_partial()?;
write_ergoscript_json(
    "eval/savltree-update-partial.json",
    &savltree_update_partial,
)?;
// (Optional V<3 throw fixture, only if audit found gap)
```

- [ ] **Step 4: Run cargo + verify determinism**

```bash
cd fixture-gen && cargo run --release
cd fixture-gen && cargo run --release && git diff packages/ergoscript/test/fixtures/eval/
```
Expected: empty diff on second run.

- [ ] **Step 5: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/savltree_partial_success.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/eval/savltree-insert-partial.json \
        packages/ergoscript/test/fixtures/eval/savltree-update-partial.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SAvlTree.insert/update per-op-fail-graceful fixtures

Two carry-forward fixtures closing untested branches from 2h-b:

* savltree-insert-partial.json: V3 tree, batch where op 2 fails
  (insert-on-existing). Exercises savltree.ts:446-460 (V3+ break path
  returning Option None).

* savltree-update-partial.json: V0 tree, batch where op 2 fails
  (update-on-absent). Exercises savltree.ts:507-510 (unconditional
  graceful break — no V<3 throw path for update).

Both fixtures emitted by shared Rust module
savltree_partial_success.rs.

[+ optional V<3 throw fixture if audit found gap]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Append carry-forward test to `savltree-insert.test.ts`

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-insert.test.ts`

- [ ] **Step 1: Append the new test block**

The fixture's shape matches the standard `{ corpus, entries: [...] }` layout. Read and adapt:

```ts
// At top of file alongside existing imports:
const insertPartialPath = join(__dirname, '../fixtures/eval/savltree-insert-partial.json')
const insertPartialFixture: { corpus: string; entries: SAvlTreeInsertEntry[] } =
  JSON.parse(readFileSync(insertPartialPath, 'utf-8'))

// (Where SAvlTreeInsertEntry is the existing entry interface in the file —
// reuse if defined, otherwise mirror the standard shape.)

describe('SAvlTree.insert — V3+ per-op-fail-graceful (carry-forward from 2h-b)', () => {
  for (const entry of insertPartialFixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      if (entry.expected_throw) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_throw.code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
```

The fixture's entries cover at least the V3+ per-op-fail-graceful scenario; if Task 14 also emitted the optional V<3 throw scenario, the same loop handles it via the `expected_throw` branch.

- [ ] **Step 2: Verify test passes**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-insert.test.ts`
Expected: PASS (including new carry-forward case).

- [ ] **Step 3: Run cross-runtime under jsdom**

Run: `cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts savltree-insert`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-insert.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SAvlTree.insert V3+ per-op-fail-graceful carry-forward

Closes the 2h-b carry-forward by exercising the V3+ break-to-None branch
at savltree.ts:446-460. The branch was implemented in 2h-b but lacked a
committed fixture.

Sigma-rust semantics: bv.digest() poisoned to None after per-op fail
(savltree.rs:495-497); handler returns Option None, NOT a partial-state
Some(AvlTree).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Carry-forward fixture: `SAvlTree.update` per-op-fail-graceful

### Task 16: Append carry-forward test to `savltree-update.test.ts`

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-update.test.ts`

(The fixture `savltree-update-partial.json` was already emitted in Task 14 alongside the insert one.)

- [ ] **Step 1: Append the new test block**

```ts
// At top of file alongside existing imports:
const updatePartialPath = join(__dirname, '../fixtures/eval/savltree-update-partial.json')
const updatePartialFixture: { corpus: string; entries: SAvlTreeUpdateEntry[] } =
  JSON.parse(readFileSync(updatePartialPath, 'utf-8'))

describe('SAvlTree.update — per-op-fail-graceful (carry-forward from 2h-b)', () => {
  for (const entry of updatePartialFixture.entries) {
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

- [ ] **Step 2: Verify test passes**

Run: `npx vitest run packages/ergoscript/test/eval/savltree-update.test.ts`
Expected: PASS.

- [ ] **Step 3: Run cross-runtime under jsdom**

Run: `cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts savltree-update`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-update.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SAvlTree.update per-op-fail-graceful carry-forward

Closes the 2h-b carry-forward by exercising the unconditional break-to-
None branch at savltree.ts:507-510. The branch was implemented in 2h-b
but lacked a committed fixture.

Unlike insert, update has no V<3/V3+ split — sigma-rust unconditionally
graceful-breaks on per-op failure (savltree.rs:421-431). Verified via
source-read.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Facts files refresh + final verification

### Task 17: Update `facts/ergoscript-eval.md` and `facts/ergoscript.md`

**Files:**
- Modify: `facts/ergoscript-eval.md`
- Modify: `facts/ergoscript.md`

- [ ] **Step 1: `facts/ergoscript-eval.md` changelog block**

Append a new changelog block under the existing "Phase 2h-c.2" block:

```markdown
**Phase 2h-d — `SAvlTree.*` completion** (additive):

- 3 new method handlers wired (39 → 42 registry entries):
  - `SAvlTree.updateOperations` (100:8) — Pattern A Fixed(45), V0+. Pure projection over `AvlTreeData.treeFlags`. Source: `eval/savltree.rs:77-88`.
  - `SAvlTree.updateDigest` (100:15) — Pattern A Fixed(40), V0+. Validates 33-byte length. Source: `eval/savltree.rs:90-102`.
  - `SAvlTree.insertOrUpdate` (100:16) — zero per-handler cost, V3-gated at dispatcher (`minVersion: 3`). Source: `eval/savltree.rs:441-498`; descriptor at `types/savltree.rs:377-403` with `min_version: ErgoTreeVersion::V3`.
- 1 new `EvalError` code: `'avl-tree-bad-digest-length'` (47 → 48 total). Thrown by `SAvlTree.updateDigest` on length ≠ 33. Mirrors sigma-rust's `ADDigest::try_from` length-check failure.
- 2 new `_avltree-adapter.ts` helpers: `withUpdatedFlags`, `buildInsertOrUpdateOps`.
- 2 carry-forward fixtures closed: V3+ per-op-fail-graceful for `insert` (savltree.ts:446-460); unconditional per-op-fail-graceful for `update` (savltree.ts:507-510).

**Phase 2h-d COMPLETE.** Method handler registry: 42 entries. EvalError codes: 48. Test count: 2867 + N (final figure from verification).
```

Update the registry table (lines ~380-413 of the file) to add 3 new rows (40, 41, 42) at the bottom.

Update the EvalError taxonomy block (lines ~340-360) to add the `'avl-tree-bad-digest-length'` entry.

Update the "Coverage and stability" section's count (line ~441) and the post-2h-d test-count note.

- [ ] **Step 2: `facts/ergoscript.md` count refresh**

Update the Coverage summary table (lines ~74-82):
- "39 method-handler registry entries" → "42 method-handler registry entries"
- "47 `EvalError` codes" → "48 `EvalError` codes"
- Test count refresh: 2867 ergoscript → (post-2h-d count from verification)

- [ ] **Step 3: Run typecheck (sanity — facts are markdown but verify nothing else regressed)**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

- [ ] **Step 4: Commit**

```bash
git add facts/ergoscript-eval.md facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs(facts): refresh ergoscript-eval + ergoscript for phase 2h-d

Adds the Phase 2h-d changelog block, 3 new registry table rows
(updateOperations, updateDigest, insertOrUpdate), 1 new EvalError
code entry ('avl-tree-bad-digest-length'), and count refresh.

Registry: 39 -> 42. EvalError codes: 47 -> 48. Coverage of Expr arms
unchanged at 52/~70 (method-handler-only phase).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: Final verification sweep

**Files:** none (verification-only)

- [ ] **Step 1: Typecheck across all 4 packages**

```bash
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
```
Expected: ALL CLEAN.

- [ ] **Step 2: Full test suite under node**

Run: `npx vitest run packages/`
Expected: PASS, test count = 3445 + N (where N is the new tests added across phases 1-5).

- [ ] **Step 3: Cross-runtime under jsdom**

```bash
cd packages/scorex && npx vitest run --config vitest.browser.config.ts
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts
cd packages/avltree && npx vitest run --config vitest.browser.config.ts
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts
```
Expected: ALL PASS.

- [ ] **Step 4: Fixture-gen determinism (final check)**

```bash
cd fixture-gen && cargo build --release
cd fixture-gen && cargo run --release
git status packages/ergoscript/test/fixtures/eval/
```
Expected: clean (no unstaged fixture diffs).

- [ ] **Step 5: Git status sanity**

Run: `git status`
Expected: working tree clean modulo `audit20260519/` (gitignored).

- [ ] **Step 6: Confirm commit count and SHA range**

Run: `git log --oneline 18e1430..HEAD | wc -l`
Expected: 17 commits (Tasks 1-17 each commit; Task 18 is verification-only). Optionally append one final commit if verification surfaces any stale comment / cosmetic issue.

- [ ] **Step 7: If user authorizes, push**

```bash
# Only after explicit user confirmation
git push origin master
```

Do NOT push autonomously. Per CLAUDE.md / OVERRIDES, pushing to origin is an action that affects shared state and requires explicit user confirmation each time.

---

## Verification commands (run after each phase)

```bash
# Always-clean check
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
npx vitest run packages/ergoscript

# Determinism check after any fixture-gen change
cd fixture-gen && cargo run --release
git diff packages/ergoscript/test/fixtures/eval/

# Cross-runtime check (Phase 3 and Phase 6)
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts

# Full verification (Phase 6 task 18)
npx tsc --noEmit -p packages/{scorex,nipopow,avltree,ergoscript}/tsconfig.json
npx vitest run packages/
```

If any command fails, halt that phase and investigate — per OVERRIDES rule #6.

---

## Notes for implementers

- **Source-first discipline** (validated again in 2h-c.2): when a TS handler's behavior is unclear, read the sigma-rust source directly. Pinned at `~/projects/ergots/external/sigma-rust/` branch `integration/ergots`. Notes drift; source is authoritative.

- **Compact-taxonomy convention** (from 2g.5 Decision #1): defensive shape mismatches reuse `'method-not-implemented'` rather than introducing new codes. The new `'avl-tree-bad-digest-length'` is an exception because the condition is script-reachable AND semantically distinct from existing codes (precedent: 2h-c.2's `'autolykos-v1-not-supported'`).

- **Dispatcher-level V3 gating** (from 2h-c.2): the `minVersion?: number` field on `HANDLERS` entries is the load-bearing mechanism. The dispatcher reads `(ctx.treeVersion ?? 0)` and throws `'tree-version-too-low'` BEFORE invoking the handler. Receiver-eval + envelope cost (4) is charged; the handler's own cost is not (cost-parity with sigma-rust).

- **Per-phase subagent dispatches** (from 2h-c.2): if executing via `subagent-driven-development`, expect ~3-4 subagent dispatches per phase (implementer + spec-reviewer + code-quality-reviewer + optionally a final whole-phase reviewer). OVERRIDES rules preamble is load-bearing — pass verbatim to every implementer prompt.

- **Final verification catches latent regressions**: in 2h-c.2 three regressions surfaced only at Task 18 (not per-task reviews). Task 18's typecheck + vitest + determinism sweep is the safety net, not redundant work.
