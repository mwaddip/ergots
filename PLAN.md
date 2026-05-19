# Phase 2h-c.2 — `SHeader.checkPow` + Autolykos v2 Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto → halt and declare; #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Goal:** Wire `SHeader.checkPow` (typeId 104, methodId 16) into `@ergots/ergoscript`'s evaluator with V3-gating + Pattern A Fixed(700) cost, after promoting the Autolykos v2 PoW verifier (`autolykos-v2.ts`) and its nBits dependency from `@ergots/nipopow` into `@ergots/scorex`.

**Architecture:** File-level migration moves Autolykos v2 + nBits + their tests into scorex with full nipopow-API mirror (no narrowing). Scorex gains one new typed error class `AutolykosV1NotSupportedError` replacing the current plain Error throw. Ergoscript's method-call dispatcher gains optional `minVersion?: number` field on registry entries — V<3 reject incurs receiver + envelope cost but NOT the 700 handler cost (sigma-rust-parity). New `EvalError 'autolykos-v1-not-supported'` code (46 → 47). Method registry grows 38 → 39.

**Tech Stack:** TypeScript (workspace ESM), vitest (node + jsdom), Rust fixture-gen against pinned sigma-rust `integration/ergots` branch, `@noble/hashes@2.2.0` (already a dep; no new runtime deps).

**Spec:** `docs/specs/2026-05-20-ergoscript-phase-2h-c-2-checkpow-design.md`. **Spec wins on any interface disagreement.**

---

## File structure

**Created:**

- `packages/scorex/src/autolykos-v2.ts` (moved from `packages/nipopow/src/autolykos-v2.ts`; throw replaced with typed class)
- `packages/scorex/src/nbits.ts` (moved from `packages/nipopow/src/nbits.ts`; content unchanged)
- `packages/scorex/test/autolykos-v2.test.ts` (moved from `packages/nipopow/test/autolykos-v2.test.ts`)
- `packages/scorex/test/nbits.test.ts` (moved from `packages/nipopow/test/nbits.test.ts`)
- `packages/ergoscript/test/eval/sheader-checkpow.test.ts` (NEW: oracle fixture test + parallel-pair cost-correctness tests + throw-path tests)
- `packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts` (NEW: mutation tests, ≥90% kill rate)
- `packages/ergoscript/test/fixtures/eval/sheader-checkpow.json` (NEW: emitted by fixture-gen, committed to repo)
- `fixture-gen/src/ergoscript/sheader_checkpow.rs` (NEW: Rust module emitting the C1 oracle fixture)

**Modified:**

- `packages/scorex/src/errors.ts` — add `AutolykosV1NotSupportedError` class
- `packages/scorex/src/index.ts` — export Autolykos v2 + nBits surface + the new error class
- `packages/scorex/src/autolykos-v2.ts` (post-move) — switch V1 throw from `Error` to `AutolykosV1NotSupportedError`; flip `@ergots/scorex` imports to relative paths
- `packages/nipopow/src/verifier.ts` — flip `verifyAutolykosV2` import to `@ergots/scorex`
- `packages/ergoscript/src/eval/method-call.ts` — wrap registry value type with `{ handler, minVersion? }`; update all 38 existing entries; dispatcher consults `minVersion` before invoking handler
- `packages/ergoscript/src/eval/sheader.ts` — append `evalSHeaderCheckPow` handler export
- `packages/ergoscript/src/eval/errors.ts` — add `'autolykos-v1-not-supported'` to the EvalError code union
- `fixture-gen/src/main.rs` — call into the new `sheader_checkpow` module to emit the fixture
- `fixture-gen/src/ergoscript/mod.rs` — register the new module
- `facts/scorex.md` — flip Autolykos v2 from "Does NOT ship" to "Ships in v0.2.0"; add error class to Failure model; add 3 Source Mapping rows
- `facts/ergoscript-eval.md` — +Phase 2h-c.2 changelog; +1 registry entry (39 total); +`'autolykos-v1-not-supported'` taxonomy entry (47 total); dispatcher `minVersion` documentation
- `facts/ergoscript.md` — registry count 38→39; error count 46→47; test count refresh
- `facts/nipopow.md` — remove Autolykos v2 from internal modules section; cross-ref scorex.md

**Deleted (via git mv):**

- `packages/nipopow/src/autolykos-v2.ts`
- `packages/nipopow/src/nbits.ts`
- `packages/nipopow/test/autolykos-v2.test.ts`
- `packages/nipopow/test/nbits.test.ts`

---

## Phase 1 — Promote Autolykos v2 + nBits to `@ergots/scorex`

### Task 1: `git mv` autolykos-v2.ts and nbits.ts into scorex; update internal imports

**Files:**
- Move: `packages/nipopow/src/autolykos-v2.ts` → `packages/scorex/src/autolykos-v2.ts`
- Move: `packages/nipopow/src/nbits.ts` → `packages/scorex/src/nbits.ts`
- Modify: `packages/scorex/src/autolykos-v2.ts` (just-moved file — flip imports)

- [ ] **Step 1: git mv the files (preserves git rename detection)**

```bash
git mv packages/nipopow/src/autolykos-v2.ts packages/scorex/src/autolykos-v2.ts
git mv packages/nipopow/src/nbits.ts packages/scorex/src/nbits.ts
```

- [ ] **Step 2: Update internal imports in autolykos-v2.ts to avoid circular self-import**

Open `packages/scorex/src/autolykos-v2.ts`. The current top imports look like:

```ts
import { blake2b256 } from './crypto/blake2b256';
import { decodeCompactBits } from './nbits';
import { serializeHeaderWithoutPow } from '@ergots/scorex';
import type { Header } from '@ergots/scorex';
```

Change the two `@ergots/scorex` imports to relative paths (inside scorex now):

```ts
import { blake2b256 } from './crypto/blake2b256';
import { decodeCompactBits } from './nbits';
import { serializeHeaderWithoutPow } from './header';
import type { Header } from './header';
```

The `./crypto/blake2b256` and `./nbits` paths already resolve in scorex (no edits needed).

- [ ] **Step 3: Run typecheck — must be clean for scorex; nipopow will fail (expected — verifier.ts still imports the deleted files, fixed in Task 5)**

Run: `npx tsc --noEmit -p packages/scorex/tsconfig.json`
Expected: PASS (clean).

Run: `npx tsc --noEmit -p packages/nipopow/tsconfig.json`
Expected: FAIL with "Cannot find module './autolykos-v2'" or similar in `packages/nipopow/src/verifier.ts`. **This is expected and resolved in Task 5.**

- [ ] **Step 4: Commit**

```bash
git add packages/scorex/src/autolykos-v2.ts packages/scorex/src/nbits.ts
git commit -m "$(cat <<'EOF'
refactor(scorex): move autolykos-v2.ts + nbits.ts from nipopow

Mechanical move of the Autolykos v2 PoW verifier and decodeCompactBits
helper from @ergots/nipopow into @ergots/scorex (phase 2h-c.2). Internal
imports flipped from @ergots/scorex to relative paths to avoid circular
self-import inside scorex.

Existing internal paths (./crypto/blake2b256, ./nbits) already resolve.
nipopow consumer (verifier.ts) is updated in a follow-up commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add `AutolykosV1NotSupportedError` class in scorex; switch the V1 throw

**Files:**
- Modify: `packages/scorex/src/errors.ts`
- Modify: `packages/scorex/src/autolykos-v2.ts`

- [ ] **Step 1: Append the new class to errors.ts**

Open `packages/scorex/src/errors.ts`. Below the existing `ReaderError` export, append:

```ts
/**
 * Thrown by verifyAutolykosV2 when called on a v1 (Autolykos v1) header.
 *
 * Autolykos v1 verification is not implemented — sigma-rust itself returns
 * Err(AutolykosPowSchemeError::Unsupported) for v1 headers
 * (autolykos_pow_scheme.rs:322-324). Real Ergo nodes (incl. ergo-node-rust)
 * skip v1 PoW verification structurally; this throw exists for callers that
 * mistakenly hand a v1 Header to verifyAutolykosV2 directly.
 */
export class AutolykosV1NotSupportedError extends Error {
  readonly code = 'autolykos-v1-not-supported' as const;
  constructor(message?: string) {
    super(message ?? 'Autolykos v1 PoW verification is not implemented');
    this.name = 'AutolykosV1NotSupportedError';
  }
}
```

- [ ] **Step 2: Update verifyAutolykosV2 to throw the typed class**

Open `packages/scorex/src/autolykos-v2.ts`. Find the v1 throw block (around line 252-254):

```ts
  if (header.version === 1) {
    throw new Error('verifyAutolykosV2: Autolykos v1 is not supported');
  }
```

Replace with:

```ts
  if (header.version === 1) {
    throw new AutolykosV1NotSupportedError(
      'verifyAutolykosV2: Autolykos v1 is not supported',
    );
  }
```

Add the import near the top of the file (just below the existing relative imports added in Task 1):

```ts
import { AutolykosV1NotSupportedError } from './errors';
```

- [ ] **Step 3: Run scorex typecheck — must be clean**

Run: `npx tsc --noEmit -p packages/scorex/tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/scorex/src/errors.ts packages/scorex/src/autolykos-v2.ts
git commit -m "$(cat <<'EOF'
feat(scorex): add AutolykosV1NotSupportedError typed class

verifyAutolykosV2 now throws a typed error class on v1 headers instead
of a plain Error. Callers can dispatch via instanceof — used in the
forthcoming SHeader.checkPow ergoscript handler to convert to typed
EvalError without fragile message-substring matching.

Existing nipopow callers catching plain Error are byte-unaffected
(the typed class extends Error).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Export Autolykos v2 + nBits + the error class from scorex's index.ts

**Files:**
- Modify: `packages/scorex/src/index.ts`

- [ ] **Step 1: Append exports**

Open `packages/scorex/src/index.ts`. After the existing `Header` exports block (line 32), append:

```ts
export {
  calcBigN,
  autolykosMessage,
  buildAutolykosSeed,
  genIndexes,
  hashElement,
  verifyAutolykosV2,
} from './autolykos-v2.ts';
export { decodeCompactBits } from './nbits.ts';
export { AutolykosV1NotSupportedError } from './errors.ts';
```

(Note the `.ts` extensions — this is the existing index.ts convention; see lines 3-32 for prior examples.)

- [ ] **Step 2: Run scorex typecheck — must be clean**

Run: `npx tsc --noEmit -p packages/scorex/tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/scorex/src/index.ts
git commit -m "$(cat <<'EOF'
feat(scorex): export Autolykos v2 + nBits + AutolykosV1NotSupportedError

Public surface for v0.2.0 mirrors the previous @ergots/nipopow
exports of the Autolykos v2 verifier. Callers that previously
imported these from @ergots/nipopow now import from @ergots/scorex.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `git mv` autolykos-v2.test.ts and nbits.test.ts into scorex/test/

**Files:**
- Move: `packages/nipopow/test/autolykos-v2.test.ts` → `packages/scorex/test/autolykos-v2.test.ts`
- Move: `packages/nipopow/test/nbits.test.ts` → `packages/scorex/test/nbits.test.ts`

- [ ] **Step 1: git mv the test files**

```bash
git mv packages/nipopow/test/autolykos-v2.test.ts packages/scorex/test/autolykos-v2.test.ts
git mv packages/nipopow/test/nbits.test.ts packages/scorex/test/nbits.test.ts
```

- [ ] **Step 2: Inspect imports in the moved test files**

The moved tests likely import like:

```ts
import { verifyAutolykosV2 } from '../src/autolykos-v2';
import { decodeCompactBits } from '../src/nbits';
```

These relative paths still resolve inside scorex's test/ → src/ structure. **No path edits needed.**

If a test file imports from `@ergots/scorex` (for `Header`), that also still works as a same-package import.

If a test file imports test helpers from `./helpers` or similar, confirm a `packages/scorex/test/helpers.ts` exists (it does — see orientation `ls` output). If the moved test needs a function not present in scorex's helpers, copy it across in this task.

- [ ] **Step 3: Run scorex tests — must pass**

Run: `npx vitest run packages/scorex/`
Expected: existing scorex tests pass + new (moved) autolykos-v2 and nbits tests pass.

If a test fails with "AutolykosV1NotSupportedError" related issues (the typed error class is new from Task 2), inspect the test — does it assert `throw new Error(...)` or `instanceof Error`? Update the assertion to match the new typed class behavior. **The class extends Error, so `instanceof Error` continues to pass; only message-substring assertions on the old plain Error message would need updating.**

- [ ] **Step 4: Commit**

```bash
git add packages/scorex/test/autolykos-v2.test.ts packages/scorex/test/nbits.test.ts
git commit -m "$(cat <<'EOF'
test(scorex): move autolykos-v2 + nbits tests from nipopow

Move the existing test files alongside their source. Relative imports
(../src/autolykos-v2 and ../src/nbits) still resolve inside scorex.
No test logic changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Flip nipopow's verifier.ts to import from `@ergots/scorex`

**Files:**
- Modify: `packages/nipopow/src/verifier.ts` (and any other internal consumer)

- [ ] **Step 1: Find the nipopow consumers**

Run: `grep -rn "from '\./autolykos-v2\|from '\./nbits\|from '\.\./autolykos-v2\|from '\.\./nbits" packages/nipopow/src/`
Expected: one or more matches inside `packages/nipopow/src/verifier.ts` (and possibly other internal files).

- [ ] **Step 2: Update import paths to `@ergots/scorex`**

For each match, update the import path from a relative path to `@ergots/scorex`. For example, if `verifier.ts` has:

```ts
import { verifyAutolykosV2 } from './autolykos-v2';
import { decodeCompactBits } from './nbits';
```

Replace with:

```ts
import { verifyAutolykosV2, decodeCompactBits } from '@ergots/scorex';
```

- [ ] **Step 3: Run nipopow typecheck — must be clean**

Run: `npx tsc --noEmit -p packages/nipopow/tsconfig.json`
Expected: PASS (the import-path failure from Task 1 Step 3 is now resolved).

- [ ] **Step 4: Run nipopow tests — must pass**

Run: `npx vitest run packages/nipopow/`
Expected: existing nipopow tests pass.

- [ ] **Step 5: Verify no orphan files remain in nipopow**

Run: `ls packages/nipopow/src/autolykos-v2.ts packages/nipopow/src/nbits.ts packages/nipopow/test/autolykos-v2.test.ts packages/nipopow/test/nbits.test.ts 2>&1 | head -5`
Expected: all four files report "No such file or directory" (git mv from Tasks 1 and 4 already removed them).

- [ ] **Step 6: Commit**

```bash
git add packages/nipopow/src/verifier.ts
git commit -m "$(cat <<'EOF'
refactor(nipopow): consume Autolykos v2 + nBits from @ergots/scorex

After the phase 2h-c.2 promotion, verifyAutolykosV2 and decodeCompactBits
live in @ergots/scorex. This commit flips nipopow's verifier.ts import
to the scorex public surface.

No behavior change. Co-package workspace dep already present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Phase 1 verification — all packages green

- [ ] **Step 1: Run all typechecks**

Run: `npx tsc --noEmit -p packages/scorex/tsconfig.json && npx tsc --noEmit -p packages/nipopow/tsconfig.json && npx tsc --noEmit -p packages/avltree/tsconfig.json && npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: all four PASS.

- [ ] **Step 2: Run all tests under node**

Run: `npx vitest run packages/`
Expected: 3435 tests pass (baseline preserved; migration is zero-delta).

- [ ] **Step 3: Run cross-runtime (jsdom) for the affected packages**

Run: `cd packages/scorex && npx vitest run --config vitest.browser.config.ts && cd ../nipopow && npx vitest run --config vitest.browser.config.ts && cd ../..`
Expected: PASS for both.

- [ ] **Step 4: Verify git status is clean (modulo gitignored)**

Run: `git status`
Expected: working tree clean.

**No commit on this task — verification only.**

---

## Phase 2 — Dispatcher upgrade for `minVersion` gating

### Task 7: Refactor `HANDLERS` registry value to `{ handler, minVersion? }`; add dispatcher check

**Files:**
- Modify: `packages/ergoscript/src/eval/method-call.ts`

- [ ] **Step 1: Re-read method-call.ts to find all `HANDLERS.set(` callsites**

Run: `grep -n "HANDLERS.set\|HANDLERS = new\|HANDLERS:" packages/ergoscript/src/eval/method-call.ts`
Expected: ~38 `HANDLERS.set` lines (current registry size from 2h-c.1) plus the type declaration.

- [ ] **Step 2: Update the registry type to wrap handler in an entry object**

Locate the `HANDLERS` declaration (search for `HANDLERS = new Map` or `const HANDLERS:`). Currently it looks something like:

```ts
type HandlerFn = (obj: SValue, args: SValue[], ctx: EvalContext, explicitTypeArgs?: SType[]) => SValue
const HANDLERS = new Map<string, HandlerFn>()
```

Replace with:

```ts
type HandlerFn = (obj: SValue, args: SValue[], ctx: EvalContext, explicitTypeArgs?: SType[]) => SValue

interface HandlerEntry {
  handler: HandlerFn
  minVersion?: number  // optional ErgoTreeVersion gate; undefined = always callable
}

const HANDLERS = new Map<string, HandlerEntry>()
```

- [ ] **Step 3: Update all 38 existing HANDLERS.set callsites to wrap the function in `{ handler: ... }`**

For each line of the form:

```ts
HANDLERS.set(handlerKey(X, Y), (obj, args, ctx) => { ... })
```

Wrap with:

```ts
HANDLERS.set(handlerKey(X, Y), { handler: (obj, args, ctx) => { ... } })
```

Same for the forwarding entries like:

```ts
HANDLERS.set(handlerKey(100, 1), (obj, args, ctx) => evalSAvlTreeDigest(obj, ...))
```

becomes:

```ts
HANDLERS.set(handlerKey(100, 1), { handler: (obj, args, ctx) => evalSAvlTreeDigest(obj, ...) })
```

**Mechanical edit; do not change handler bodies.** Re-read the file after editing in batches of ~10 entries to catch any malformed wrapping (per OVERRIDES rule #8).

- [ ] **Step 4: Update the dispatcher to consult `entry.minVersion` before invoking the handler**

Locate the dispatcher invocation point (search for `entry(` or `handler(` near a registry lookup). The current dispatch path looks something like:

```ts
const entry = HANDLERS.get(key)
if (entry === undefined) {
  throw new EvalError('method-not-implemented', `unknown method ${typeId}:${methodId}`)
}
return entry(obj, args, ctx, explicitTypeArgs)
```

Replace with:

```ts
const entry = HANDLERS.get(key)
if (entry === undefined) {
  throw new EvalError('method-not-implemented', `unknown method ${typeId}:${methodId}`)
}
if (entry.minVersion !== undefined && (ctx.treeVersion ?? 0) < entry.minVersion) {
  throw new EvalError(
    'tree-version-too-low',
    `method ${typeId}:${methodId} requires tree version >= ${entry.minVersion}, got ${ctx.treeVersion ?? 0}`,
  )
}
return entry.handler(obj, args, ctx, explicitTypeArgs)
```

The `ctx.treeVersion ?? 0` default-to-V0 mirrors the existing convention in `eval/upcast.ts` and `eval/downcast.ts` (see `facts/ergoscript-eval.md` Phase 2e changelog).

- [ ] **Step 5: Run ergoscript typecheck — must be clean**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: PASS. If a HANDLERS.set callsite was wrapped incorrectly, this catches it.

- [ ] **Step 6: Run ergoscript tests — all existing tests must still pass (no regression)**

Run: `npx vitest run packages/ergoscript/`
Expected: 2857 tests pass (baseline preserved).

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): wrap HANDLERS registry value with optional minVersion

Method-call dispatcher gains minVersion?: number field on registry
entries. When set, the dispatcher throws EvalError('tree-version-too-low')
if ctx.treeVersion < entry.minVersion, BEFORE invoking the handler
(so handler-cost is not charged on V<N reject — sigma-rust-parity).

All 38 existing entries wrapped mechanically; no minVersion-gated
entries yet (added by the SHeader.checkPow handler in a follow-up commit).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Fixture-gen Rust-side oracle module

### Task 8: Write the Rust fixture-gen module for `SHeader.checkPow`

**Files:**
- Create: `fixture-gen/src/ergoscript/sheader_checkpow.rs`
- Modify: `fixture-gen/src/ergoscript/mod.rs` (register the new submodule)
- Modify: `fixture-gen/src/main.rs` — call into the new module to emit the fixture

- [ ] **Step 1: Re-read the existing 2h-c.1 sheader-handlers fixture-gen module as a template**

Run: `cat fixture-gen/src/ergoscript/sheader_handlers.rs | head -100`

The existing module shows the pattern: load a mainnet header, construct an Expr via `PropertyCall(...)`, run sigma-rust's `try_eval_out` oracle, emit JSON. The new `sheader_checkpow.rs` follows the same shape but the target Expr is `MethodCall(headers[0], SHeader.checkPow)`.

- [ ] **Step 2: Create the fixture-gen module**

Create `fixture-gen/src/ergoscript/sheader_checkpow.rs`:

```rust
//! SHeader.checkPow oracle fixture for ergots phase 2h-c.2.
//!
//! Emits one fixture: a V3 ErgoTree calling
//!   MethodCall(ByIndex(PropertyCall(Context, SContext.headers), 0), SHeader.checkPow)
//! against a real mainnet V2 header. Also emits a V1 header hex (consumed
//! by the TS test's V1-header throw path).
//!
//! Imports follow the pattern established in `sheader_handlers.rs`. The
//! checkPow SMethod descriptor lives in ergotree-ir/src/types/sheader.rs —
//! grep that file for `CHECK_POW` symbol name and adopt it.

// (Import block: mirror sheader_handlers.rs imports, plus whatever's needed
//  for MethodCall construction. Re-read sheader_handlers.rs for exact symbol
//  names and add what's missing.)

pub fn generate() -> anyhow::Result<serde_json::Value> {
    // 1. Load V2 + V1 mainnet headers. Reuse the helper from
    //    sheader_handlers.rs if present (e.g., load_mainnet_header_v2()).
    //    For V1: load a header with version == 1 from
    //    packages/nipopow/test/fixtures/headers/ (grep that dir for a
    //    fixture file whose deserialized version field is 1).
    let v2_header = load_v2_header()?;
    let v1_header = load_v1_header()?;

    // 2. Build the Expr matching sheader_handlers.rs's PropertyCall pattern,
    //    but with the outermost node = MethodCall(SHeader.CHECK_POW, args=[]).
    //    The receiver is identical to the 15 SHeader accessor fixtures:
    //      ByIndex(PropertyCall(Context, SContext::HEADERS), Const(SInt, 0))
    let expr = build_checkpow_expr()?;

    // 3. Serialize Expr to bytes (sigma-rust's serializer, same as
    //    sheader_handlers.rs).
    let expr_bytes = serialize_expr(&expr)?;

    // 4. Build sigma-rust Context with headers[0] = v2_header.
    let ctx = build_context_with_header(&v2_header)?;

    // 5. Run try_eval_out::<bool>(&expr, &ctx).
    let (value, jit_cost) = try_eval_out::<bool>(&expr, &ctx)?;

    // 6. Emit JSON with both header hex strings.
    Ok(serde_json::json!({
        "name": "sheader-checkpow",
        "exprBytes": hex::encode(expr_bytes),
        "expectedValue": value,           // true for a real mainnet V2 header
        "expectedJitCost": jit_cost,
        "headerHexBytes": hex::encode(serialize_header(&v2_header)?),
        "headerVersion": v2_header.version,
        "headerHeight": v2_header.height,
        "v1HeaderHexBytes": hex::encode(serialize_header(&v1_header)?),
        "v1HeaderVersion": v1_header.version,
        "v1HeaderHeight": v1_header.height,
    }))
}
```

**Symbol-name lookup:** if `SHeader.CHECK_POW` or `load_v2_header` / `load_v1_header` helper names differ in the actual `sheader_handlers.rs`, adopt the existing names there. Per OVERRIDES rule #2, if the sigma-rust API symbol for `SHeader.checkPow` is unclear after grepping `ergotree-ir/src/types/sheader.rs`, halt and escalate.

- [ ] **Step 3: Register the submodule**

Open `fixture-gen/src/ergoscript/mod.rs`. Add:

```rust
pub mod sheader_checkpow;
```

- [ ] **Step 4: Wire into main.rs**

Open `fixture-gen/src/main.rs`. Find the existing line:

```rust
write_ergoscript_json("eval/sheader-handlers.json", &sheader_handlers_fixture)?;
```

Below it, add:

```rust
// Phase 2h-c.2 — SHeader.checkPow oracle fixture
let sheader_checkpow_fixture = crate::ergoscript::sheader_checkpow::generate()?;
write_ergoscript_json("eval/sheader-checkpow.json", &sheader_checkpow_fixture)?;
```

- [ ] **Step 5: Build fixture-gen**

Run: `cd fixture-gen && cargo build --release`
Expected: PASS once Step 2's `todo!()` is replaced with the real implementation.

- [ ] **Step 6: Run fixture-gen — emit the fixture**

Run: `cd fixture-gen && cargo run --release`
Expected: a new file at `packages/ergoscript/test/fixtures/eval/sheader-checkpow.json` containing the oracle output.

Inspect the emitted file:

```bash
head -20 packages/ergoscript/test/fixtures/eval/sheader-checkpow.json
```

Expected fields: `name`, `exprBytes`, `expectedValue: true`, `expectedJitCost: <integer>`, `headerHexBytes`, `headerVersion: 2`, `headerHeight: <int>`.

- [ ] **Step 7: Determinism check**

Run: `cd fixture-gen && cargo run --release && cd ..`
Run: `git diff packages/ergoscript/test/fixtures/eval/sheader-checkpow.json`
Expected: no diff (deterministic regeneration).

- [ ] **Step 8: Commit**

```bash
git add fixture-gen/src/ergoscript/sheader_checkpow.rs fixture-gen/src/ergoscript/mod.rs fixture-gen/src/main.rs packages/ergoscript/test/fixtures/eval/sheader-checkpow.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SHeader.checkPow oracle fixture

Generates one fixture asserting MethodCall(headers[0], SHeader.checkPow)
on a real V2 mainnet header returns true with sigma-rust's recorded
jit_cost. Phase 2h-c.2 — pinned at sigma-rust integration/ergots.

Determinism: cargo run twice produces byte-identical output.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — `SHeader.checkPow` handler implementation

### Task 9: TDD red — write the failing oracle-fixture test

**Files:**
- Create: `packages/ergoscript/test/eval/sheader-checkpow.test.ts`

- [ ] **Step 1: Re-read the existing 2h-c.1 sheader-handlers test for the AST + evaluator patterns**

Run: `cat packages/ergoscript/test/eval/sheader-handlers.test.ts | head -80`

The new test mirrors that file's structure: load fixture, hex-decode, construct an ErgoTree wrapper around `parseExpr`'s output, call `evaluateWith` with the appropriate context.

- [ ] **Step 2: Write the failing test**

Create `packages/ergoscript/test/eval/sheader-checkpow.test.ts`:

```ts
/**
 * SHeader.checkPow oracle fixture test — phase 2h-c.2.
 *
 * Loads the fixture emitted by fixture-gen/src/ergoscript/sheader_checkpow.rs
 * and asserts that the TS evaluator produces the same value + jit_cost as
 * sigma-rust's try_eval_out oracle.
 */
import { describe, it, expect } from 'vitest'
import fixture from '../fixtures/eval/sheader-checkpow.json'
import { parseExpr } from '../../src/wire/parse'
import { ByteReader } from '@ergots/scorex'
import { evaluateWith, makeContext } from '../../src/eval/evaluate'
import { EvalError } from '../../src/eval/eval-context'
import { parseHeader } from '@ergots/scorex'

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return out
}

describe('SHeader.checkPow oracle', () => {
  it('returns true on a real V2 mainnet header with sigma-rust-equal jitCost', () => {
    const exprBytes = hexToBytes(fixture.exprBytes)
    const headerBytes = hexToBytes(fixture.headerHexBytes)
    const header = parseHeader(new ByteReader(headerBytes))

    const expr = parseExpr(new ByteReader(exprBytes), [], [])
    const ctx = makeContext({
      treeVersion: 3,
      headers: [header],
    })

    // Build a synthetic ErgoTree wrapper for evaluateWith. Match the shape
    // used in packages/ergoscript/test/eval/sheader-handlers.test.ts.
    const tree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body: expr,
    }

    const result = evaluateWith(tree as any, ctx)

    expect(result).toEqual({ kind: 'Boolean', value: fixture.expectedValue })
    expect(ctx.jitCost).toBe(fixture.expectedJitCost)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/ergoscript/test/eval/sheader-checkpow.test.ts`
Expected: FAIL with `EvalError('method-not-implemented', 'unknown method 104:16')` — the handler isn't registered yet.

- [ ] **Step 4: Commit the failing test**

```bash
git add packages/ergoscript/test/eval/sheader-checkpow.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): RED — SHeader.checkPow oracle test (no handler yet)

Asserts the not-yet-registered handler will return true with the
oracle's jit_cost. Fails with 'method-not-implemented' until Task 10
registers the handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: TDD green — implement `evalSHeaderCheckPow`, register the handler, add new EvalError code

**Files:**
- Modify: `packages/ergoscript/src/eval/sheader.ts` — append the new handler function
- Modify: `packages/ergoscript/src/eval/errors.ts` — add `'autolykos-v1-not-supported'` to the EvalError code union
- Modify: `packages/ergoscript/src/eval/method-call.ts` — register the handler at 104:16 with `minVersion: 3`

- [ ] **Step 1: Add the new EvalError code**

Open `packages/ergoscript/src/eval/errors.ts`. Find the code union (the line with `'tree-version-too-low'` per orientation — line 83 in the current file).

Add `'autolykos-v1-not-supported'` to the union, in alphabetical position:

```ts
  | 'apply-arity-mismatch'
  | 'apply-non-lambda'
  | 'arith-divide-by-zero'
  | 'arith-overflow'
  | 'atleast-bound-not-int'
  | 'atleast-bound-out-of-range'
  | 'autolykos-v1-not-supported'    // NEW phase 2h-c.2
  | 'avl-tree-obj-not-avl-tree'
  // ... rest unchanged
```

Also update the doc comment block above the union to describe the new code, mirroring the existing entries:

```ts
//   'autolykos-v1-not-supported'  — SHeader.checkPow handler caught a v1 header.
//                                   Mirrors sigma-rust's AutolykosPowSchemeError::Unsupported.
//                                   Wire-format invariants make this unreachable in practice
//                                   (script-touched headers are typically V2+ for ~5 years
//                                   post-mainnet-417792); defensive against unusual ctx.headers
//                                   constructions.
```

- [ ] **Step 2: Add `evalSHeaderCheckPow` to sheader.ts**

Open `packages/ergoscript/src/eval/sheader.ts`. At the end of the existing handler exports (after `evalSHeaderVotes`), append:

```ts
import { verifyAutolykosV2, AutolykosV1NotSupportedError } from '@ergots/scorex'

/**
 * SHeader.checkPow (typeId 104, methodId 16).
 *
 * Pattern A Fixed(700) — `ctx.addCost(700)` BEFORE the obj-kind check and
 * verifier invocation. Sigma-rust source: ergotree-interpreter/src/eval/sheader.rs:115-124.
 *
 * V3-gated at the dispatcher level (registration in method-call.ts with
 * minVersion: 3). The dispatcher's minVersion check fires BEFORE this
 * handler is invoked, so V<3 reject incurs zero handler cost (sigma-rust
 * parity — sigma-rust gates this at MethodDesc.min_version).
 *
 * Returns SValue.Boolean from verifyAutolykosV2.
 *
 * Error codes:
 *   'header-obj-not-header'        — defensive receiver check (reused from 2h-c.1)
 *   'autolykos-v1-not-supported'   — verifyAutolykosV2 threw AutolykosV1NotSupportedError on a V1 header
 */
export function evalSHeaderCheckPow(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext,
): SValue {
  // 1. Pattern A cost charge (mirrors sigma-rust eval/sheader.rs:116)
  ctx.addCost(700)

  // 2. Defensive receiver kind check (reuses 'header-obj-not-header' from 2h-c.1)
  assertHeaderObj(obj)

  // 3. Run verifier; catch typed v1 error and re-throw as EvalError
  try {
    const result = verifyAutolykosV2(obj.value)
    return { kind: 'Boolean', value: result }
  } catch (e) {
    if (e instanceof AutolykosV1NotSupportedError) {
      throw new EvalError(
        'autolykos-v1-not-supported',
        'SHeader.checkPow: Autolykos v1 PoW verification is not implemented (mirrors sigma-rust)',
      )
    }
    throw e  // re-throw unexpected errors unwrapped
  }
}
```

**Note:** `assertHeaderObj` already exists in this file (used by the 15 2h-c.1 handlers). Re-read the file top to confirm its signature.

- [ ] **Step 3: Register the handler in method-call.ts with minVersion: 3**

Open `packages/ergoscript/src/eval/method-call.ts`. Locate the existing SHeader handler imports (around line 65-80) and the SHeader registrations (around line 382).

Add `evalSHeaderCheckPow` to the import:

```ts
import {
  evalSHeaderId,
  // ... existing 15 imports
  evalSHeaderVotes,
  evalSHeaderCheckPow,  // NEW phase 2h-c.2
} from './sheader'
```

After the last SHeader registration (`evalSHeaderVotes` at 104:15), append:

```ts
HANDLERS.set(handlerKey(104, 16), {
  handler: (obj, args, ctx) => evalSHeaderCheckPow(obj, args, ctx),
  minVersion: 3,  // V3 gate — sigma-rust MethodDesc.min_version: ErgoTreeVersion::V3
})
```

- [ ] **Step 4: Run the oracle fixture test**

Run: `npx vitest run packages/ergoscript/test/eval/sheader-checkpow.test.ts`
Expected: PASS — `evaluateWith` returns `{ kind: 'Boolean', value: true }` and `ctx.jitCost === fixture.expectedJitCost`.

If the cost mismatch is off by a few units, re-check the oracle output and the handler implementation order (cost-700 charge must be BEFORE the kind check, per Pattern A).

- [ ] **Step 5: Run the full ergoscript test suite — no regression**

Run: `npx vitest run packages/ergoscript/`
Expected: 2858 tests pass (2857 baseline + 1 new oracle test).

- [ ] **Step 6: Run ergoscript typecheck — must be clean**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ergoscript/src/eval/sheader.ts packages/ergoscript/src/eval/errors.ts packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): SHeader.checkPow method handler (104:16)

Pattern A Fixed(700) cost. V3-gated at dispatcher via the new
minVersion: 3 field on the registry entry. Returns SValue.Boolean
from verifyAutolykosV2.

New EvalError code 'autolykos-v1-not-supported' (46→47) raised when
verifyAutolykosV2 throws AutolykosV1NotSupportedError on a v1 header.
Mirrors sigma-rust AutolykosPowSchemeError::Unsupported.

Registry: 38 → 39 entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Throw-path and edge-case tests

### Task 11: Parallel-pair cost-correctness tests for V<3 reject (parameterized treeVersion=0,1,2)

**Files:**
- Modify: `packages/ergoscript/test/eval/sheader-checkpow.test.ts` — append parallel-pair tests

- [ ] **Step 1: Append the parallel-pair tests**

Open `packages/ergoscript/test/eval/sheader-checkpow.test.ts`. Below the existing `describe('SHeader.checkPow oracle', ...)` block, append:

```ts
describe('SHeader.checkPow V<3 reject (parallel-pair cost correctness)', () => {
  const exprBytes = hexToBytes(fixture.exprBytes)
  const headerBytes = hexToBytes(fixture.headerHexBytes)
  const header = parseHeader(new ByteReader(headerBytes))

  function buildTree(treeVersion: 0 | 1 | 2 | 3): any {
    return {
      header: { version: treeVersion, hasSize: false, constantSegregation: false, rawHeader: treeVersion },
      constantTypes: [],
      constants: [],
      body: parseExpr(new ByteReader(exprBytes), [], []),
    }
  }

  function evaluateCapture(treeVersion: 0 | 1 | 2 | 3): { cost: number; threw: Error | null } {
    const tree = buildTree(treeVersion)
    const ctx = makeContext({ treeVersion, headers: [header] })
    try {
      evaluateWith(tree, ctx)
      return { cost: ctx.jitCost, threw: null }
    } catch (e) {
      return { cost: ctx.jitCost, threw: e as Error }
    }
  }

  // Baseline: V3 success.
  const v3Run = evaluateCapture(3)

  for (const v of [0, 1, 2] as const) {
    it(`treeVersion=${v}: throws 'tree-version-too-low' and skips the 700 handler cost`, () => {
      const rejectRun = evaluateCapture(v)

      expect(rejectRun.threw).toBeInstanceOf(EvalError)
      expect((rejectRun.threw as EvalError).code).toBe('tree-version-too-low')

      // The load-bearing assertion: V<3 reject cost is EXACTLY 700 less than V3 success cost.
      // Receiver-eval cost and envelope cost are charged in both; handler cost (700) is the diff.
      expect(v3Run.cost - rejectRun.cost).toBe(700)
    })
  }

  it('baseline V3 success establishes the parallel-pair pivot', () => {
    expect(v3Run.threw).toBeNull()
    expect(v3Run.cost).toBe(fixture.expectedJitCost)
  })
})
```

- [ ] **Step 2: Run the test — must pass**

Run: `npx vitest run packages/ergoscript/test/eval/sheader-checkpow.test.ts`
Expected: PASS. All 3 parameterized V<3 tests assert `v3Run.cost - rejectRun.cost === 700`.

If the delta is off, the dispatcher's `minVersion` check is incorrectly positioned (e.g., charging handler cost before the gate). Re-read the method-call.ts dispatcher (Task 7 Step 4) and confirm the `minVersion` check happens BEFORE `entry.handler(...)` is invoked.

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/test/eval/sheader-checkpow.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): parallel-pair V<3 reject tests for SHeader.checkPow

Parameterized over treeVersion=0,1,2. Asserts each throws
EvalError('tree-version-too-low') AND v3Cost - rejectCost === 700
(the 700 handler-cost is NOT charged on V<3 reject — dispatcher-level
gating is sigma-rust-parity).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: V3 / V1-header throw test (`'autolykos-v1-not-supported'`)

**Files:**
- Modify: `packages/ergoscript/test/eval/sheader-checkpow.test.ts` — append the V1-header test

The V1 header hex bytes come from the fixture-gen-emitted `v1HeaderHexBytes` field added in Task 8 Step 2. No separate V1 fixture file is needed.

- [ ] **Step 1: Append the V1-header test**

Append to `packages/ergoscript/test/eval/sheader-checkpow.test.ts`:

```ts
describe('SHeader.checkPow V1 header rejection', () => {
  it("V3 tree with V1 header receiver throws 'autolykos-v1-not-supported'", () => {
    // V1 mainnet header — fixture-gen emits its hex bytes as v1HeaderHexBytes
    // alongside the V2 oracle data (see fixture-gen/src/ergoscript/sheader_checkpow.rs).
    const v1Header = parseHeader(new ByteReader(hexToBytes(fixture.v1HeaderHexBytes)))
    expect(v1Header.version).toBe(1)

    const exprBytes = hexToBytes(fixture.exprBytes)
    const tree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body: parseExpr(new ByteReader(exprBytes), [], []),
    }
    const ctx = makeContext({ treeVersion: 3, headers: [v1Header] })

    try {
      evaluateWith(tree as any, ctx)
      throw new Error('expected EvalError throw but evaluate succeeded')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('autolykos-v1-not-supported')
    }
  })
})
```

- [ ] **Step 2: Run the test — must pass**

Run: `npx vitest run packages/ergoscript/test/eval/sheader-checkpow.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/test/eval/sheader-checkpow.test.ts

git commit -m "$(cat <<'EOF'
test(ergoscript): SHeader.checkPow V1-header throw path

V3 tree with a V1 header receiver throws
EvalError('autolykos-v1-not-supported'). Mirrors sigma-rust's
AutolykosPowSchemeError::Unsupported. V1 header hex bytes come from
the fixture-gen-emitted v1HeaderHexBytes field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Non-Header receiver + mutated-nonce + valid-header edge tests

**Files:**
- Modify: `packages/ergoscript/test/eval/sheader-checkpow.test.ts` — append the remaining 3 tests

- [ ] **Step 1: Append edge tests**

Append to `packages/ergoscript/test/eval/sheader-checkpow.test.ts`:

```ts
describe('SHeader.checkPow edge cases', () => {
  const headerBytes = hexToBytes(fixture.headerHexBytes)
  const header = parseHeader(new ByteReader(headerBytes))

  it("non-Header receiver throws 'header-obj-not-header'", () => {
    // Direct AST construction bypasses the wire parser (which would catch
    // this earlier). The receiver is a LongConst(42); the MethodCall targets
    // SHeader.checkPow (104:16). The dispatcher's V3 gate passes (treeVersion=3);
    // the cost-700 charge runs; then assertHeaderObj throws because
    // obj.kind === 'Long' !== 'Header'.
    //
    // Re-read packages/ergoscript/test/eval/sheader-handlers.test.ts for the
    // exact PropertyCall AST shape used by the 15 2h-c.1 accessor tests, and
    // confirm MethodCall has the same nodes plus an `args` array.
    const tree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body: {
        tag: 'MethodCall',
        typeId: 104,
        methodId: 16,
        obj: {
          tag: 'Const',
          tpe: { tag: 'SLong' },
          sValue: { kind: 'Long', value: 42n },
        },
        args: [],
      },
    }
    const ctx = makeContext({ treeVersion: 3, headers: [header] })

    try {
      evaluateWith(tree as any, ctx)
      throw new Error('expected EvalError throw but evaluate succeeded')
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError)
      expect((e as EvalError).code).toBe('header-obj-not-header')
    }
  })

  it('V2 header with mutated nonce returns Boolean(false), no throw', () => {
    // Mutate the nonce to a value that overwhelmingly fails the PoW target.
    const mutatedHeader = {
      ...header,
      autolykosSolution: {
        ...header.autolykosSolution,
        nonce: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
      },
    }

    const exprBytes = hexToBytes(fixture.exprBytes)
    const tree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body: parseExpr(new ByteReader(exprBytes), [], []),
    }
    const ctx = makeContext({ treeVersion: 3, headers: [mutatedHeader] })

    const result = evaluateWith(tree as any, ctx)
    expect(result).toEqual({ kind: 'Boolean', value: false })
    // Cost should match the valid-header case — handler runs to completion.
    expect(ctx.jitCost).toBe(fixture.expectedJitCost)
  })

  it('valid V2 header at chain tip returns Boolean(true) — fixture redundancy check', () => {
    // Mirror of the oracle test, here for organizational coherence with the
    // throw-path siblings.
    const exprBytes = hexToBytes(fixture.exprBytes)
    const tree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body: parseExpr(new ByteReader(exprBytes), [], []),
    }
    const ctx = makeContext({ treeVersion: 3, headers: [header] })

    const result = evaluateWith(tree as any, ctx)
    expect(result).toEqual({ kind: 'Boolean', value: true })
    expect(ctx.jitCost).toBe(fixture.expectedJitCost)
  })
})
```

**Note on AST shape:** the `MethodCall` Expr literal in the non-Header test is the same node shape used by the 15 2h-c.1 SHeader accessor tests via `PropertyCall` — re-read `packages/ergoscript/test/eval/sheader-handlers.test.ts` and confirm the `tag: 'MethodCall'` shape matches the project's MIR type definitions. If the discriminant uses different field names (e.g., `obj` vs `receiver`), adapt the literal to match.

- [ ] **Step 2: Run the test — must pass**

Run: `npx vitest run packages/ergoscript/test/eval/sheader-checkpow.test.ts`
Expected: PASS (all 3 new tests).

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/test/eval/sheader-checkpow.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SHeader.checkPow edge cases

- Non-Header receiver → 'header-obj-not-header'
- V2 header with mutated nonce → Boolean(false), no throw
- Valid V2 header → Boolean(true) (organizational mirror of oracle)

All edge cases cover the cost-charging post-Pattern-A code path
(handler cost IS charged on these branches; only V<3 reject skips it).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Mutation testing + facts files + final verification

### Task 14: Mutation tests on the C1 oracle fixture

**Files:**
- Create: `packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts`

- [ ] **Step 1: Re-read the existing mutation-testing pattern**

Run: `ls packages/ergoscript/test/eval/ | grep -i mutation`
Expected: any existing mutation-testing files. Re-read one for the pattern (single-byte flips at each offset; assert throw or byte-identical).

- [ ] **Step 2: Write the mutation test**

Create `packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts`:

```ts
/**
 * Mutation testing for SHeader.checkPow oracle fixture — phase 2h-c.2.
 *
 * Target: ≥ 90% kill rate per fixture. Each single-byte flip either:
 *   - Flips the Boolean result (killed by assertion)
 *   - Causes a wire-layer throw (killed by typed-error catch)
 *   - Flips the V3 gate (killed by 'tree-version-too-low')
 *   - Leaves bytes identical (tolerated)
 */
import { describe, it, expect } from 'vitest'
import fixture from '../fixtures/eval/sheader-checkpow.json'
import { parseExpr } from '../../src/wire/parse'
import { ByteReader } from '@ergots/scorex'
import { evaluateWith, makeContext } from '../../src/eval/evaluate'
import { parseHeader } from '@ergots/scorex'

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
  }
  return out
}

const originalBytes = hexToBytes(fixture.exprBytes)
const headerBytes = hexToBytes(fixture.headerHexBytes)
const header = parseHeader(new ByteReader(headerBytes))

const NUM_MUTATIONS = Math.min(originalBytes.length, 40)
const offsets: number[] = []
for (let i = 0; i < NUM_MUTATIONS; i++) {
  offsets.push(Math.floor((i / NUM_MUTATIONS) * originalBytes.length))
}

let killed = 0
let tolerated = 0
let totalRun = 0

function evaluateMutated(mutated: Uint8Array): { result: any; threw: Error | null } {
  let result: any = null
  let threw: Error | null = null
  try {
    const tree = {
      header: { version: 3, hasSize: false, constantSegregation: false, rawHeader: 0x03 },
      constantTypes: [],
      constants: [],
      body: parseExpr(new ByteReader(mutated), [], []),
    }
    const ctx = makeContext({ treeVersion: 3, headers: [header] })
    result = evaluateWith(tree as any, ctx)
  } catch (e) {
    threw = e as Error
  }
  return { result, threw }
}

describe('SHeader.checkPow mutation', () => {
  offsets.forEach((offset) => {
    it(`mutation at offset ${offset}: killed or tolerated`, () => {
      const mutated = new Uint8Array(originalBytes)
      mutated[offset] = (mutated[offset] + 1) & 0xff

      const { result, threw } = evaluateMutated(mutated)
      totalRun++

      const isKilled =
        threw !== null ||
        (result?.kind === 'Boolean' && result.value === false)

      if (isKilled) {
        killed++
      } else {
        tolerated++
      }

      // Each mutation is one of: killed (typed throw OR flipped Boolean), or
      // tolerated (byte-identical / padding region). The original-bytes case
      // returns true; tolerated mutations must also return true (no silent change).
      expect(isKilled || result?.value === true).toBe(true)
    })
  })

  it(`aggregate kill rate ≥ 90%`, () => {
    // This test must run AFTER all the offsets above. Vitest runs tests within
    // a `describe` block sequentially by default — verify in your vitest config
    // that this assumption holds. If parallelism is enabled, restructure into a
    // single `it` block that loops internally.
    console.log(`Mutation kill rate: ${killed}/${totalRun} = ${((killed / totalRun) * 100).toFixed(1)}%`)
    expect(killed / totalRun).toBeGreaterThanOrEqual(0.9)
  })
})
```

- [ ] **Step 3: Run the mutation test**

Run: `npx vitest run packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts`
Expected: PASS with ≥ 90% kill rate logged.

If kill rate is below 90%, inspect the tolerated mutations — are they all in legitimate padding regions (e.g., the `unparsedBytes` forward-compat region of the Header)? Per the 2h-c.1 precedent on `option-none` (87.5% accepted with documentation), small documented exceptions are acceptable. If unexpected mutations are tolerated, investigate the gap.

- [ ] **Step 4: Commit**

```bash
git add packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SHeader.checkPow mutation testing

Single-byte flips on the C1 oracle fixture bytes. Target ≥ 90% kill
rate per fixture. Mutations either flip the Boolean result, cause a
typed wire-layer throw, flip the V3 gate, or leave bytes identical
(tolerated padding).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Update `facts/scorex.md` for the new Autolykos v2 surface + AutolykosV1NotSupportedError

**Files:**
- Modify: `facts/scorex.md`

- [ ] **Step 1: Re-read the current facts/scorex.md sections**

Run: `grep -n "Autolykos\|Does NOT ship\|Failure model\|Source mapping\|Public surface\|Ships in this contract" facts/scorex.md`

- [ ] **Step 2: Bump "Ships in this contract" header to v0.2.0 and add new bullets**

Change `**Ships in this contract (v0.1.0):**` → `**Ships in this contract (v0.2.0):**`. After the existing bullets 1-9, append:

```markdown
10. Autolykos v2 PoW verifier: `verifyAutolykosV2(header): boolean` + helpers (`calcBigN`, `autolykosMessage`, `buildAutolykosSeed`, `genIndexes`, `hashElement`).
11. `decodeCompactBits(nBits): bigint` — Bitcoin-compact-bits target unpacking, used by the Autolykos v2 verifier.
12. `AutolykosV1NotSupportedError` typed error class — thrown by `verifyAutolykosV2` on v1 headers (matches sigma-rust `AutolykosPowSchemeError::Unsupported`).
```

- [ ] **Step 3: Remove Autolykos v2 from "Does NOT ship"**

In the "Does NOT ship" section, remove the existing bullet starting with `**Autolykos v2 PoW verifier.**` (the promotion landed in 2h-c.2).

- [ ] **Step 4: Update the "Public surface" code block**

Change `**Public surface (v0.1.0)**` → `**Public surface (v0.2.0)**`. In the public-surface `// ─── ` code block, before the closing exports, append:

```ts
// ─── Autolykos v2 PoW verifier ───────────────────────────────────────────────

export function calcBigN(version: number, height: number): number
export function autolykosMessage(header: Header): Uint8Array  // 32 bytes
export function buildAutolykosSeed(msg: Uint8Array, nonce: Uint8Array, height: number, bigN: number): Uint8Array  // 32 bytes
export function genIndexes(seed: Uint8Array, bigN: number): number[]  // 32 indices
export function hashElement(index: number, height: number): Uint8Array  // 31 bytes
export function verifyAutolykosV2(header: Header): boolean
  // throws AutolykosV1NotSupportedError on header.version === 1

// ─── nBits decode ────────────────────────────────────────────────────────────

export function decodeCompactBits(nBits: number): bigint
```

And in the error-classes section (alongside `ReaderError`):

```ts
export class AutolykosV1NotSupportedError extends Error {
  readonly code: 'autolykos-v1-not-supported'
}
```

- [ ] **Step 5: Update the "Failure model" section**

Append a new sub-section:

```markdown
**`AutolykosV1NotSupportedError` — thrown by `verifyAutolykosV2` on V1 headers**

A typed error class wrapping the case where `verifyAutolykosV2` is called with `header.version === 1`. Mirrors sigma-rust's `AutolykosPowSchemeError::Unsupported` (`autolykos_pow_scheme.rs:322-324`). The `code` is the string literal `'autolykos-v1-not-supported'`.

Real Ergo nodes (incl. ergo-node-rust) skip v1 PoW verification structurally; this throw exists for callers that mistakenly hand a v1 header to `verifyAutolykosV2` directly. `@ergots/ergoscript`'s `SHeader.checkPow` eval arm catches this class and re-throws as `EvalError('autolykos-v1-not-supported')`.
```

- [ ] **Step 6: Update the Source Mapping table**

Append rows:

```markdown
| `ergo-chain-types/src/autolykos_pow_scheme.rs::pow_hit` (lines 176-197) | `verifyAutolykosV2` + helpers (`autolykos-v2.ts`) | V2 path only; V1 sigma-rust returns pow_distance but our port throws AutolykosV1NotSupportedError |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::decode_compact_bits` | `decodeCompactBits` (`nbits.ts`) | Bitcoin-compact-bits target unpacking; bit-exact mirror |
| `ergo-chain-types/src/autolykos_pow_scheme.rs::AutolykosPowSchemeError::Unsupported` (line 322) | `AutolykosV1NotSupportedError` (`errors.ts`) | V1 verification not implemented; sigma-rust returns Err on the same condition |
```

- [ ] **Step 7: Update the Test corpus section**

Append:

```markdown
- `autolykos-v2.test.ts` — `verifyAutolykosV2` against mainnet V2 headers; V1 throw path; helpers' unit tests.
- `nbits.test.ts` — `decodeCompactBits` round-trip + boundary values.
```

- [ ] **Step 8: Commit**

```bash
git add facts/scorex.md
git commit -m "$(cat <<'EOF'
docs(facts): scorex gains Autolykos v2 + nBits + AutolykosV1NotSupportedError

v0.2.0 surface update. Promotes the v2 PoW verifier and decodeCompactBits
from @ergots/nipopow (phase 2h-c.2). Adds AutolykosV1NotSupportedError
to the failure model and three Source Mapping rows pointing at
sigma-rust's autolykos_pow_scheme.rs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Update `facts/ergoscript-eval.md` and `facts/ergoscript.md` for the new handler + EvalError code + dispatcher upgrade

**Files:**
- Modify: `facts/ergoscript-eval.md`
- Modify: `facts/ergoscript.md`

- [ ] **Step 1: Update facts/ergoscript-eval.md — Phase 2h-c.2 changelog block**

Append a new changelog block AFTER the existing Phase 2h-c.1 block:

```markdown
**Phase 2h-c.2 — `SHeader.checkPow` + dispatcher minVersion upgrade** (additive):

- 1 new method handler wired (38 → 39 registry entries): **`SHeader.checkPow` (104:16)** — Pattern A Fixed(700) — V3-gated at the dispatcher (registered with `minVersion: 3`). Source: `eval/sheader.rs:115-124`.
- Dispatcher upgrade: `HANDLERS` registry value type expanded from `HandlerFn` to `{ handler: HandlerFn, minVersion?: number }`. The dispatcher consults `entry.minVersion` and throws `EvalError('tree-version-too-low')` BEFORE invoking the handler — V<N reject incurs 0 handler-cost (sigma-rust-parity with `MethodDesc.min_version` gating).
- 1 new `EvalError` code: `'autolykos-v1-not-supported'` (46 → 47 codes). Raised when `verifyAutolykosV2` (now in `@ergots/scorex`) throws `AutolykosV1NotSupportedError` on a V1 header.
- `verifyAutolykosV2` runtime import moves from `@ergots/nipopow` to `@ergots/scorex` (phase 2h-c.2's other half — see `facts/scorex.md`).
```

- [ ] **Step 2: Add the new method to the registry table**

In the "Method-handler registry (38 entries)" table, append after entry #38:

```markdown
| 39 | `SHeader.checkPow` | 104:16 | 700 | A | `Boolean` — V3-gated via `minVersion: 3` on registry; v1 header throws `'autolykos-v1-not-supported'` | `eval/sheader.rs:115-124` |
```

Update the header from "Method-handler registry (38 entries)" to "Method-handler registry (39 entries)".

- [ ] **Step 3: Add the new EvalError code to the taxonomy section**

In the EvalError taxonomy block, add a new sub-section after the Phase 2h-c.1 codes:

```markdown
### Phase 2h-c.2 codes (SHeader.checkPow)

- **`'autolykos-v1-not-supported'`** — `SHeader.checkPow` handler caught an `AutolykosV1NotSupportedError` from `verifyAutolykosV2`. Mirrors sigma-rust's `AutolykosPowSchemeError::Unsupported` (`autolykos_pow_scheme.rs:322-324`). Real Ergo nodes (incl. ergo-node-rust) skip v1 PoW verification structurally; this code is the surface for the unusual case where `ctx.headers` includes a V1 header AND the script invokes `checkPow` on it.
```

Update the count "46 codes" → "47 codes" everywhere it appears in the file.

- [ ] **Step 4: Document the dispatcher minVersion upgrade**

Add a new sub-heading near the existing method-call dispatcher documentation:

```markdown
### Dispatcher minVersion gating (phase 2h-c.2)

The method-call dispatcher consults an optional `minVersion?: number` field on each registry entry. When set, the dispatcher throws `EvalError('tree-version-too-low')` if `(ctx.treeVersion ?? 0) < entry.minVersion`, BEFORE invoking the handler. This is sigma-rust-parity with `MethodDesc.min_version`-level gating: V<N reject incurs receiver-eval cost + envelope cost (4) but NOT the handler's own cost (e.g., 700 for `checkPow`).

Currently only `SHeader.checkPow` (104:16) uses `minVersion: 3`. Future V3+ method handlers (e.g., `SContext.getVarFromInput` at 101:12) should prefer this dispatcher path over the in-arm 2e pattern (Upcast/Downcast).
```

- [ ] **Step 5: Update facts/ergoscript.md (meta) — registry + error counts**

Open `facts/ergoscript.md`. Find and update:
- "38-entry method-handler registry" → "39-entry method-handler registry"
- "46 `EvalError` codes" → "47 `EvalError` codes"
- "2857 ergoscript + 156 avltree + 307 nipopow + 115 scorex = 3435 tests" → updated total reflecting the new tests added in this phase
- Coverage summary: register the +1 entry change in the appropriate row

Run: `grep -n "3435\|2857\|38-entry\|46\|method-handler registry" facts/ergoscript.md`
Use the matches to find each callsite and update.

- [ ] **Step 6: Commit**

```bash
git add facts/ergoscript-eval.md facts/ergoscript.md
git commit -m "$(cat <<'EOF'
docs(facts): ergoscript-eval + ergoscript-meta refresh for 2h-c.2

- +1 method-handler registry entry (38→39): SHeader.checkPow (104:16) with minVersion: 3.
- +1 EvalError code (46→47): 'autolykos-v1-not-supported'.
- New "Dispatcher minVersion gating" section documenting the upgrade and the
  cost-parity guarantee on V<N reject.
- Meta count refresh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Update `facts/nipopow.md` — remove Autolykos v2 from internal-modules section

**Files:**
- Modify: `facts/nipopow.md`

- [ ] **Step 1: Find autolykos-v2 references in facts/nipopow.md**

Run: `grep -n "autolykos-v2\|Autolykos v2\|verifyAutolykosV2" facts/nipopow.md`

- [ ] **Step 2: Update language to reflect new consumer posture**

If a line references `autolykos-v2.ts` as a nipopow-internal artifact, change it to reference `@ergots/scorex` instead. Also confirm the existing "consumes ByteReader, ByteWriter, ... from `@ergots/scorex`" line is augmented with `verifyAutolykosV2` and `decodeCompactBits`.

If no such lines exist (the current facts/nipopow.md may already abstract this away), this task is a no-op.

- [ ] **Step 3: Commit (if any changes were made)**

If changes were made:

```bash
git add facts/nipopow.md
git commit -m "$(cat <<'EOF'
docs(facts): nipopow consumes Autolykos v2 from @ergots/scorex

Phase 2h-c.2 moved verifyAutolykosV2 and decodeCompactBits to scorex.
Update facts/nipopow.md to reflect the new import posture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If grep showed no changes were needed, skip this commit and proceed.

---

### Task 18: Final verification — full test suite under both runtimes, typechecks, fixture-gen determinism, git status

- [ ] **Step 1: All typechecks clean**

Run: `npx tsc --noEmit -p packages/scorex/tsconfig.json && npx tsc --noEmit -p packages/nipopow/tsconfig.json && npx tsc --noEmit -p packages/avltree/tsconfig.json && npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: all four PASS.

- [ ] **Step 2: All tests pass under node**

Run: `npx vitest run packages/`
Expected: ~3445-3450 tests pass (baseline 3435 + 10-15 from this phase). The exact count depends on how many edge-case tests landed.

- [ ] **Step 3: Cross-runtime (jsdom) for the affected packages**

Run: `cd packages/scorex && npx vitest run --config vitest.browser.config.ts && cd ../nipopow && npx vitest run --config vitest.browser.config.ts && cd ../ergoscript && npx vitest run --config vitest.browser.config.ts && cd ../..`
Expected: PASS for all three.

- [ ] **Step 4: Fixture-gen determinism**

Run: `cd fixture-gen && cargo run --release && cd ..`
Run: `git status fixture-gen/ packages/ergoscript/test/fixtures/eval/sheader-checkpow.json`
Expected: no diff (deterministic regeneration).

- [ ] **Step 5: Git status clean**

Run: `git status`
Expected: working tree clean (modulo gitignored `audit20260519/`).

- [ ] **Step 6: Test count regression check**

Run: `npx vitest run packages/ 2>&1 | tail -10 | grep -E "Tests|passed"`
Expected: total test count is at least 3435 + 10 = 3445; no regression from baseline.

**No commit on this task — verification only.**

If any verification fails, halt and investigate the root cause per OVERRIDES rule #5 (no band-aids). Do not advance to a follow-up plan or update SESSION_CONTEXT.md until all verifications are clean.

---

## Self-review checklist (run after Task 18)

This is a checklist against the spec. Confirm each is implemented:

- [x] Autolykos v2 + nBits files moved from nipopow to scorex (Tasks 1, 4)
- [x] `AutolykosV1NotSupportedError` typed class added in scorex (Task 2)
- [x] Scorex index.ts re-exports the new surface (Task 3)
- [x] Nipopow consumer (verifier.ts) flipped to scorex import (Task 5)
- [x] Old nipopow source files deleted (Tasks 1, 4 — via git mv)
- [x] Dispatcher's `HANDLERS` registry wrapped with `{ handler, minVersion? }` (Task 7)
- [x] Dispatcher consults `minVersion` BEFORE invoking handler (Task 7 Step 4)
- [x] All 38 existing handler entries wrapped without behavior change (Task 7 Step 3)
- [x] Fixture-gen Rust module emits the C1 oracle fixture (Task 8)
- [x] Fixture-gen determinism preserved (Task 8 Step 7, Task 18 Step 4)
- [x] `evalSHeaderCheckPow` handler implemented in sheader.ts (Task 10 Step 2)
- [x] Handler registered at 104:16 with `minVersion: 3` (Task 10 Step 3)
- [x] New EvalError code `'autolykos-v1-not-supported'` added to the union (Task 10 Step 1)
- [x] C1 oracle fixture test passes (Task 9, Task 10 Step 4)
- [x] Parallel-pair V<3 reject tests assert `v3Cost - rejectCost === 700` (Task 11)
- [x] V1-header throw test asserts `'autolykos-v1-not-supported'` (Task 12)
- [x] Non-Header receiver throw test asserts `'header-obj-not-header'` (Task 13)
- [x] Mutated-nonce edge case asserts `Boolean(false)` no-throw (Task 13)
- [x] Mutation testing ≥ 90% kill rate (Task 14)
- [x] facts/scorex.md reflects v0.2.0 surface + new error class (Task 15)
- [x] facts/ergoscript-eval.md gains Phase 2h-c.2 changelog + registry entry + new code (Task 16)
- [x] facts/ergoscript.md count refreshes (Task 16 Step 5)
- [x] facts/nipopow.md reflects new consumer posture (Task 17, if applicable)
- [x] All typechecks clean (Tasks 6, 10 Step 6, 18 Step 1)
- [x] All tests pass under node + jsdom (Tasks 6, 18 Steps 2, 3)
- [x] No test count regression (Task 18 Step 6)
- [x] Working tree clean (Task 18 Step 5)

---

## Execution handoff

**Plan complete and saved to `PLAN.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task. Two-stage review per phase (spec compliance + code quality). Caught 5 carry-forward items in the 2h-c.1 phase per the SESSION_CONTEXT precedent. **REQUIRED SUB-SKILL:** `superpowers:subagent-driven-development`.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`. Batch execution with checkpoints for review.

Which approach?
