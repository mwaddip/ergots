# Phase 2h-f — Tier-3 method-handler cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto → halt and declare; #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Goal:** Add 2 deferred Tier-3 method handlers — `SGroupElement.getEncoded` (typeId 7, methodId 2; Pattern A Fixed(250)) and `SColl.flatMap` (typeId 12, methodId 15; Pattern B `addPerItemCost(60, 10, 8, n)`). Method-handler registry grows 42 → 44. Zero new `EvalError` codes. Zero new `Expr` arms. `HandlerFn` signature gains optional 5th `extra?: { mc, env }` argument for flatMap's MIR-node + env-extend needs.

**Architecture:** `getEncoded` registered inline in `eval/method-call.ts` (~10 LOC, mirrors SGlobal.groupGenerator). `flatMap` extracted to new module `eval/scoll-flat-map.ts` (~200 LOC; mirrors `coll-map.ts` shape with concat semantics + SAny-tolerant outElem with first-iter refinement + ValUse-source elem-check skip). Both V0+, no dispatcher `minVersion` gating. Test count target: 3481 + ~30-50.

**Tech Stack:** TypeScript (workspace ESM), vitest (node + jsdom), Rust fixture-gen against pinned sigma-rust `integration/ergots` branch. No new runtime deps. No version bumps.

**Spec:** `docs/specs/2026-05-20-ergoscript-phase-2h-f-tier-3-method-handlers-design.md`. **Spec wins on any interface disagreement.**

---

## File structure

**Created:**

- `fixture-gen/src/cmds/ergoscript/eval/sgroup_elem_get_encoded.rs` (~80-120 LOC; 2-3 happy + 0 throw scenarios — getEncoded throw is unreachable via parser, see Task 4)
- `fixture-gen/src/cmds/ergoscript/eval/scoll_flat_map.rs` (~200-300 LOC; ~5-7 scenarios per Task 6)
- `packages/ergoscript/src/eval/scoll-flat-map.ts` (~200 LOC; new module per spec § Architecture R2)
- `packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts` (~80-150 LOC)
- `packages/ergoscript/test/eval/scoll-flat-map.test.ts` (~200-300 LOC; oracle + 7 edge cases + 1 mutation block)

**Modified:**

- `packages/ergoscript/src/eval/method-call.ts` — extend `HandlerFn` type with optional 5th arg; thread `{ mc, env }` from `evalMethodCall`; register both new handlers.
- `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — add `pub mod sgroup_elem_get_encoded;` and `pub mod scoll_flat_map;`.
- `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — register new modules in the dispatch table (whichever mechanism the fixture-gen CLI uses; verify at Task 2 by reading `mod.rs`).
- `facts/ergoscript-eval.md` — registry table grows 42 → 44; new "Phase 2h-f" changelog section; R3 divergence note on `SColl.flatMap` row.
- `facts/ergoscript.md` — coverage summary line: registry 42 → 44.
- `README.md` — packages table: registry-count refresh.
- `SESSION_CONTEXT.md` — local-only state tracking (gitignored, not committed).
- `HANDOFF_PROMPT.md` — refresh for next session.

**Deleted:** none.

**NOT modified (explicit non-scope):**

- `packages/ergoscript/src/eval/coll-map.ts` — its `inferSType` private helper stays put (Q3 resolved: not needed for flatMap; future cross-arm `Closure.argTpes` extension is a separate phase, not bundled here).
- Public APIs of `@ergots/scorex`, `@ergots/nipopow`, `@ergots/avltree`. No version bumps anywhere in the workspace.
- `RELEASING.md`. No publish posture change.
- `audit20260519/`. Stays gitignored.

---

## Phase 1 — `SGroupElement.getEncoded`

### Task 1: Fixture-gen reachability pre-flight (getEncoded — sanity check)

**Files:** none modified; this is a read-only investigation step.

**Purpose:** Confirm `MethodCall::with_concrete_types(GET_ENCODED_METHOD, ...)` accepts the `SGroupElement → Coll[Byte]` shape and `try_eval_out` returns a valid `Vec<u8>`. Should pass trivially — getEncoded has no lambda or restriction quirks. If it surprises, halt and investigate before authoring the fixture.

- [ ] **Step 1:** Read `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/sgroup_elem.rs:69-109` (the existing `eval_get_encoded` test). Confirm the pattern works as expected.
- [ ] **Step 2:** Sanity-check that `fixture-gen/src/cmds/ergoscript/eval/create_prove_dlog.rs` already produces typed `GroupElement` fixtures (we'll borrow the EcPoint construction).

No commit for this task; it's a pre-implementation read.

### Task 2: Fixture-gen `sgroup_elem_get_encoded.rs` (3 oracle scenarios)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/sgroup_elem_get_encoded.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`

- [ ] **Step 1: Read existing exemplar.** Reference: `fixture-gen/src/cmds/ergoscript/eval/sigma_prop_bytes.rs` (similar Pattern A "obj → Coll[Byte]" handler). Borrow construction style.

- [ ] **Step 2: Create `sgroup_elem_get_encoded.rs`** with three scenarios:
  - `get_encoded_arbitrary` — arbitrary `EcPoint` via `force_any_val::<EcPoint>()`. Construct `MethodCall(Constant(SGroupElement, ec_point), GET_ENCODED_METHOD, vec![])`. Capture `(tree_bytes_hex, expected_value_json, expected_cost)`.
  - `get_encoded_group_generator` — `EcPoint::GENERATOR` (or whatever sigma-rust calls it). The expected output is `GROUP_GENERATOR_BYTES` from `eval/_group-generator.ts`.
  - `get_encoded_identity` — `EcPoint::identity()` if sigma-rust permits a Const of identity-point. If it doesn't, skip this scenario and document why in a Rust comment.

- [ ] **Step 3: Register module in `mod.rs`.** Add `pub mod sgroup_elem_get_encoded;` (alphabetical position).

- [ ] **Step 4: Run `cargo run -p fixture-gen --release` twice.** Verify byte-identical output (`git diff --exit-code packages/`).

- [ ] **Step 5: Commit.**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/sgroup_elem_get_encoded.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        packages/ergoscript/test/fixtures/eval/sgroup-element-get-encoded.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SGroupElement.getEncoded oracle fixtures

Phase 2h-f Task 2. 2-3 scenarios covering arbitrary EcPoint,
group generator, and (if constructible) identity point. Pattern A
Fixed(250) cost charged via try_eval_out oracle for byte-equality
TS-side validation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: RED — getEncoded oracle test (no handler yet)

**Files:**
- Create: `packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts`

- [ ] **Step 1: Read existing test exemplar.** Reference: `packages/ergoscript/test/eval/sglobal-group-generator.test.ts`. Same fixture-driven oracle pattern.

- [ ] **Step 2: Create the test file.** Load `sgroup-element-get-encoded.json`; iterate entries; assert via `parseTree + evaluateWith` that the returned `SValue` matches `expected_value_json` and `ctx.jitCost === expected_cost`. Use `rehydrateEvalOpts` + `hydrateSValue` helpers from `_helpers/index.ts`.

- [ ] **Step 3: Run vitest — expect RED.**
```bash
node_modules/.bin/vitest run packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts
```
Expected: failure with `'method-not-implemented'` for every oracle entry (no handler registered yet for `(7, 2)`).

- [ ] **Step 4: Commit RED.**

```bash
git add packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): RED — SGroupElement.getEncoded oracle test (no handler yet)

Phase 2h-f Task 3. Adds oracle-driven test loading
sgroup-element-get-encoded.json fixtures. Expected to fail with
'method-not-implemented' until Task 4 lands the handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4: GREEN — register `SGroupElement.getEncoded` handler

**Files:**
- Modify: `packages/ergoscript/src/eval/method-call.ts`

- [ ] **Step 1: Add the registry entry.** Inline, mirroring `SGlobal.groupGenerator` (entry at line ~254). Position the new entry near other 2h-f additions OR near SGlobal entries (alphabetical-by-typeId is fine).

```ts
// SGroupElement.getEncoded (MethodCall, typeId=7, methodId=2) — phase 2h-f
// Source: ergotree-interpreter/src/eval/sgroup_elem.rs:15-26 — GET_ENCODED_EVAL_FN
// Pattern A Fixed(250). Returns 33-byte SEC1-compressed point as Coll[Byte].
HANDLERS.set(handlerKey(7, 2), { handler: (obj, _args, ctx, _explicitTypeArgs) => {
  ctx.addCost(250) // sigma-rust line 16
  if (obj.kind !== 'GroupElement') {
    throw new EvalError(
      `SGroupElement.getEncoded expects a GroupElement obj; got '${obj.kind}'`,
      'method-not-implemented' // reuse per error taxonomy option 1
    )
  }
  return bytesToCollByteSValue(obj.value)
} })
```

- [ ] **Step 2: Run typecheck + targeted test — expect GREEN.**
```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json     # CLEAN
node_modules/.bin/vitest run packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts  # PASS
```

- [ ] **Step 3: Commit GREEN.**

```bash
git add packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): SGroupElement.getEncoded method handler (7:2)

Phase 2h-f Task 4. Registers SGroupElement.getEncoded as Pattern A
Fixed(250). Returns 33-byte SEC1-compressed point as Coll[Byte] via
existing bytesToCollByteSValue helper. Registry grows 42 → 43.

Source: ergotree-interpreter/src/eval/sgroup_elem.rs:15-26 — GET_ENCODED_EVAL_FN

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5: Edge cases for getEncoded (cost-on-throw + non-GroupElement)

**Files:**
- Modify: `packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts`

The throw path is unreachable from parser-produced trees (the parser's type-check rejects a `MethodCall(non-GroupElement, GET_ENCODED, ...)` at parse time). Test it via TS-direct handler call.

- [ ] **Step 1: Add throw-path test.** Construct a minimal `MethodCall` Expr manually OR invoke the handler from `HANDLERS` registry directly. Assert:
  - `EvalError` thrown with `code === 'method-not-implemented'`
  - `ctx.jitCost === 250` (Pattern A: cost charged BEFORE obj-kind check)
  - Test name: `SGroupElement.getEncoded charges cost-on-throw (Pattern A)`

- [ ] **Step 2: Run vitest — expect PASS.**

- [ ] **Step 3: Commit.**

```bash
git add packages/ergoscript/test/eval/sgroup-element-get-encoded.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SGroupElement.getEncoded cost-on-throw + edge cases

Phase 2h-f Task 5. Adds cost-on-throw assertion (Pattern A charges
250 BEFORE obj-kind check). Throw path is unreachable via parser
(rejected by type-checker); tested via direct handler invocation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — `SColl.flatMap`

### Task 6: Fixture-gen reachability pre-flight (flatMap — R7 critical check)

**Files:** none modified; this is read-only.

**Purpose:** Verify whether sigma-rust's `MethodCall::with_concrete_types(FLATMAP_METHOD, ...)` accepts a malformed lambda body (MethodCall with non-zero args), i.e., the `xs.flatMap(x => x.indexOf(5, 0))` body-restriction throw shape. If sigma-rust rejects at construction, the test-strategy for the body-restriction scenario shifts from oracle-fixture to TS-direct handler call. Per Spec § R7.

- [ ] **Step 1: Read sigma-rust `MethodCall::with_concrete_types`** at `external/sigma-rust/ergotree-ir/src/types/smethod.rs` (find by grep). Note any type-check on body shape.

- [ ] **Step 2: Read sigma-rust `MethodCall::new`** at `external/sigma-rust/ergotree-ir/src/mir/method_call.rs`. Check for body-arity restrictions.

- [ ] **Step 3: Decision branch.**
  - If sigma-rust ACCEPTS the malformed shape at construction → body-restriction throw IS reachable via oracle fixture. Task 7 includes the scenario.
  - If sigma-rust REJECTS at construction → body-restriction throw must be tested via TS-direct handler call. Task 7 omits the scenario; Task 11 (TS edge-case tests) adds a direct-invocation test.

- [ ] **Step 4: Record finding** in a comment block at the top of `fixture-gen/src/cmds/ergoscript/eval/scoll_flat_map.rs` (to be created in Task 7). Format:

```rust
// PHASE 2H-F TASK 6 PRE-FLIGHT FINDING:
// sigma-rust [accepts/rejects] malformed-body MethodCall at construction.
// Source: <file>:<line>
// Decision: body-restriction throw scenario lives in [this Rust file / TS-direct test in Task 11].
```

No commit for this task; finding feeds into Task 7.

### Task 7: Fixture-gen `scoll_flat_map.rs` (oracle + edge scenarios)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/scoll_flat_map.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`

**Scenarios** (per Spec § Test strategy; final list depends on Task 6 outcome):

1. **`flatmap_happy_indices`** — `Coll[Coll[Long]] flatMap (xs => xs.indices)`. Lambda body is `PropertyCall` → exprTpe=SAny on TS side; sigma-rust gives concrete `Coll[Int]`. Result: `Coll[Int]` of indices concatenated. Mirrors `scoll.rs:494-539` test. **Critical coverage** for R3(b) SAny-tolerance path.

2. **`flatmap_happy_concrete_body`** — `Coll[Long] flatMap (x => Coll(x, x+1))`. Body is `Collection` Expr → exprTpe=`SColl(SLong)` (concrete). Confirms concrete-tpe path.

3. **`flatmap_empty_input_sany_body`** — `Coll[Coll[Long]]() flatMap (xs => xs.indices)`. Empty input + property-call body. Expected output: empty `Coll` with `elem.tag === 'SAny'`. (May need fixture-loader adjustment to allow loading expected_value_json with `elem: 'SAny'`; check `hydrateSValue` shape.)

4. **`flatmap_empty_input_concrete_body`** — `Coll[Long]() flatMap (x => Coll(x))`. Empty input + concrete body. Expected output: empty `Coll[Long]`. Confirms concrete-tpe path with empty input.

5. **`flatmap_lambda_body_returns_non_coll`** — `Coll[Long] flatMap (x => x + 1)` (body returns SLong, not SColl). Throws `'lambda-result-type-mismatch'`. **Reachability check:** sigma-rust may reject at construction; if so, move to TS-direct test in Task 11.

6. **`flatmap_body_restriction_throw`** — `xs.flatMap(x => x.indexOf(5, 0))` (body is MethodCall with non-empty args). Throws `'lambda-not-callable'`. **Per Task 6 finding:** include here OR defer to TS-direct test.

7. **`flatmap_elem_type_mismatch`** — `Coll[SInt] flatMap (x: SLong => Coll(x))` (input elem != lambda arg type, inline FuncValue lambda). Throws `'coll-elem-tpe-mismatch'`. Inline FuncValue → MIR-side check fires.

8. **`flatmap_arity_gt_1`** — `xs.flatMap((x, y) => Coll(x))` (lambda takes 2 args). **Reachability check:** sigma-rust likely rejects at FuncValue construction; if so, move to TS-direct test.

9. (Optional) **`flatmap_valuse_source_lambda`** — `val f = (x: Coll[Long]) => x.indices; xs.flatMap(f)`. Lambda reaches handler via ValUse. Tests R3(a) elem-check skip path (no `'coll-elem-tpe-mismatch'` even when types would mismatch, because static check is skipped). Plus tests R3(b) SAny refinement still works for ValUse-source lambdas (closure.body is still accessible).

- [ ] **Step 1: Read existing exemplar.** Reference: `fixture-gen/src/cmds/ergoscript/eval/coll_map.rs` (closest analog: lambda HOF method call). Borrow construction style.

- [ ] **Step 2: Implement scenarios 1-9 in `scoll_flat_map.rs`.** For each scenario, note construction-time vs eval-time failure in a Rust comment (so the implementer knows which require sigma-rust to accept the malformed shape).

- [ ] **Step 3: Register module in `mod.rs`.** Add `pub mod scoll_flat_map;` (alphabetical).

- [ ] **Step 4: Run `cargo run -p fixture-gen --release` twice.** Verify byte-identical output.

- [ ] **Step 5: Commit.**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/scoll_flat_map.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        packages/ergoscript/test/fixtures/eval/scoll-flat-map.json
git commit -m "$(cat <<'EOF'
test(fixture-gen): SColl.flatMap oracle + edge-case fixtures

Phase 2h-f Task 7. 5-9 scenarios covering: happy path with PropertyCall
body (canonical sigma-rust shape); happy path with concrete-tpe body;
empty input cases (both body types); error paths reachable via try_eval_out
(non-Coll body return, elem-type-mismatch, optionally body-restriction +
arity>1 if sigma-rust accepts at construction).

Source: ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval
Spec: docs/specs/2026-05-20-ergoscript-phase-2h-f-tier-3-method-handlers-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8: Extend `HandlerFn` signature with optional 5th `extra` arg

**Files:**
- Modify: `packages/ergoscript/src/eval/method-call.ts`

Pre-requisite for Task 9 (flatMap handler needs `mc + env` access). Standalone commit so the signature change is bisect-clean.

- [ ] **Step 1: Update `HandlerFn` type.**

```ts
// At ~method-call.ts:98-103
type HandlerFn = (
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>,
  // Phase 2h-f: optional 5th arg for handlers that need the originating
  // MethodCall MIR node (for static type access not on the runtime Closure
  // SValue, e.g. SColl.flatMap's elem-type check) + the caller's Env
  // (for env-extend during per-item body eval). Existing handlers (41 of 42
  // as of registry-43) ignore this arg via TS structural typing.
  extra?: { mc: MethodCall; env: Env }
) => SValue
```

- [ ] **Step 2: Update `dispatch` to thread `extra` through.**

```ts
// At ~method-call.ts:129-151
function dispatch(
  typeId: number,
  methodId: number,
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>,
  extra?: { mc: MethodCall; env: Env }
): SValue {
  // ... (entry lookup + minVersion check unchanged) ...
  return entry.handler(obj, args, ctx, explicitTypeArgs, extra)
}
```

- [ ] **Step 3: Update `evalMethodCall` to construct + pass `extra`.**

```ts
// At ~method-call.ts:116-121
export function evalMethodCall(e: MethodCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4) // Pattern A; source: method_call.rs:17
  const obj = evalExpr(e.obj, env, ctx)
  const args = e.args.map((a) => evalExpr(a, env, ctx))
  return dispatch(e.typeId, e.methodId, obj, args, ctx, e.explicitTypeArgs, { mc: e, env })
}
```

`evalPropertyCall` does NOT pass `extra` (PropertyCall handlers don't need MIR-node access).

- [ ] **Step 4: Run typecheck — expect clean.**
```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json     # CLEAN
node_modules/.bin/vitest run packages/ergoscript        # ALL PASS (3481 unchanged)
```

- [ ] **Step 5: Commit.**

```bash
git add packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): extend HandlerFn signature with optional `extra` arg

Phase 2h-f Task 8. Adds an optional 5th argument to HandlerFn for handlers
that need MIR-node + Env access (forthcoming SColl.flatMap is the first
consumer). Existing 41 handlers ignore the arg via TS structural typing
(zero behavioral change; test count 3481 unchanged).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 9: RED — flatMap oracle test (no handler yet)

**Files:**
- Create: `packages/ergoscript/test/eval/scoll-flat-map.test.ts`

- [ ] **Step 1: Read existing test exemplar.** Reference: `packages/ergoscript/test/eval/coll-map.test.ts` (closest analog).

- [ ] **Step 2: Create the test file.** Load `scoll-flat-map.json`; iterate the happy-path entries; assert via `parseTree + evaluateWith` that returned `SValue` matches expected. Use `rehydrateEvalOpts` + `hydrateSValue` helpers from `_helpers/index.ts`.

- [ ] **Step 3: Run vitest — expect RED.**
```bash
node_modules/.bin/vitest run packages/ergoscript/test/eval/scoll-flat-map.test.ts
```
Expected: failure with `'method-not-implemented'` for every oracle entry.

- [ ] **Step 4: Commit RED.**

```bash
git add packages/ergoscript/test/eval/scoll-flat-map.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): RED — SColl.flatMap oracle test (no handler yet)

Phase 2h-f Task 9. Loads scoll-flat-map.json fixtures and asserts
expected values via parseTree + evaluateWith. Expected to fail with
'method-not-implemented' until Task 10 lands the handler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 10: GREEN — extracted module `eval/scoll-flat-map.ts` + registry entry

**Files:**
- Create: `packages/ergoscript/src/eval/scoll-flat-map.ts`
- Modify: `packages/ergoscript/src/eval/method-call.ts`

- [ ] **Step 1: Create `eval/scoll-flat-map.ts`** per Spec § Architecture Handler 2 code block. Key points (re-read spec carefully):
  - Imports: `MethodCall`, `SType`, `SValue` from `mir/types`; `EvalContext`, `EvalError` from `eval-context`; `evalExpr` from `eval`; `Env` from `env`; `extractCollItems`, `extractFuncValue` from `_coll-helpers`; `exprTpe` from `mir/expr-tpe`; `sTypeEquals` from `mir/stype-helpers`.
  - Cost constants: `FLATMAP_OUTER_BASE = 60`, `FLATMAP_OUTER_PER_CHUNK = 10`, `FLATMAP_OUTER_CHUNK_SIZE = 8`.
  - Handler signature: `(obj, args, ctx, _explicitTypeArgs, mc, env)` — matches HandlerFn 5-arg shape.
  - **CRITICAL: body restriction uses `closure.body.tag`** (runtime body), NOT `mc.args[0].body`. The runtime closure body works for both inline-FuncValue and ValUse-source lambdas.
  - **CRITICAL: elem-type check uses `mc.args[0]`** (MIR-node FuncValue) — divergence from sigma-rust documented in spec R3(a). Skip when `mc.args[0].tag !== 'FuncValue'`.
  - **CRITICAL: outElem 3-branch initialization** — SColl → `bodyTpe.elem`; SAny → SAny pre-loop + first-iter refinement; other → throw `'lambda-result-type-mismatch'`.
  - **CRITICAL: first-iter refinement** — `if (outElem.tag === 'SAny') outElem = itemRes.elem` (adopt from runtime Coll's `elem` field).
  - Empty input: outElem stays SAny; returns `{ kind: 'Coll', elem: { tag: 'SAny' }, items: [] }`.

- [ ] **Step 2: Register in `method-call.ts`.** Add at the appropriate position (alphabetical-by-typeId / methodId among SColl entries):

```ts
// SColl.flatMap (MethodCall, typeId=12, methodId=15) — phase 2h-f
// Source: ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval
// Pattern B addPerItemCost(60, 10, 8, n). Lambda HOF with body-restriction
// quirk + SAny-tolerant outElem (R3 divergences from sigma-rust). Handler
// body lives in ./scoll-flat-map.ts; this wrapper extracts mc + env from
// `extra` and forwards. V0+.
HANDLERS.set(handlerKey(12, 15), { handler: (obj, args, ctx, _explicitTypeArgs, extra) => {
  if (extra === undefined) {
    // Defensive — should never happen for MethodCall dispatch (only
    // PropertyCall passes extra=undefined, and SColl.flatMap is not a
    // PropertyCall). Surface as a programming-error throw rather than a
    // silent miscompute.
    throw new EvalError(
      `SColl.flatMap requires extra={mc, env}; got undefined (programming error)`,
      'method-not-implemented'
    )
  }
  return evalSCollFlatMap(obj, args, ctx, _explicitTypeArgs, extra.mc, extra.env)
} })
```

Import `evalSCollFlatMap` from `./scoll-flat-map`.

- [ ] **Step 3: Run typecheck + targeted test — expect GREEN.**
```bash
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
node_modules/.bin/vitest run packages/ergoscript/test/eval/scoll-flat-map.test.ts
```

- [ ] **Step 4: Commit.**

```bash
git add packages/ergoscript/src/eval/scoll-flat-map.ts \
        packages/ergoscript/src/eval/method-call.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): SColl.flatMap method handler (12:15)

Phase 2h-f Task 10. Pattern B addPerItemCost(60, 10, 8, n). Lambda HOF
with concat semantics + body-restriction (MethodCall body must have 0
args, per sigma-rust scoll.rs:78-84) + SAny-tolerant outElem with
first-iter refinement (R3(b) divergence from sigma-rust SMethod
resolver). Elem-type check uses MIR-node FuncValue (skipped for
ValUse-source lambdas — R3(a) divergence). Registry grows 43 → 44.

Source: ergotree-interpreter/src/eval/scoll.rs:52-136 — flatmap_eval

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 11: Edge cases + throw-path tests for flatMap

**Files:**
- Modify: `packages/ergoscript/test/eval/scoll-flat-map.test.ts`

Per Spec § Test strategy. Cover all 7+ scenarios beyond the happy path.

- [ ] **Step 1: Add throw-path tests.** Per Task 7 reachability findings:
  - For scenarios that fixture-gen CAN construct: assert via `parseTree + evaluateWith` that the `EvalError.code` matches.
  - For scenarios fixture-gen CANNOT construct (body-restriction + arity>1, if rejected at construction): invoke `evalSCollFlatMap` directly with a synthesized `MethodCall` MIR node + handcrafted `Closure` SValue. Cost-on-throw assertion: NO cost charged (Pattern B; guards fire before cost).

- [ ] **Step 2: Add ValUse-source lambda happy-path test.** Confirms R3(a) elem-check skip works: a deliberately-type-mismatched lambda (e.g., `val f = (x: Long) => Coll(x); xs.flatMap(f)` where `xs: Coll[Int]`) should succeed without `'coll-elem-tpe-mismatch'` because the static check is skipped for ValUse-source lambdas. Document the divergence in the test comment.

- [ ] **Step 3: Add cost-on-throw breakdown tests.**
  - Non-Coll obj → no cost charged.
  - Lambda arity / body-restriction / elem-type-mismatch → no cost charged (all fire BEFORE `addPerItemCost`).
  - Lambda-result-type-mismatch (per-iter, mid-loop) → cost charged for outer + iters completed.

- [ ] **Step 4: Run vitest — expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add packages/ergoscript/test/eval/scoll-flat-map.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SColl.flatMap edge cases + throw-path coverage

Phase 2h-f Task 11. Adds edge-case scenarios: body-restriction throw,
arity>1 lambda, elem-type-mismatch, lambda-result-type-mismatch (per-iter),
ValUse-source lambda happy path (R3(a) divergence), cost-on-throw
breakdown distinguishing Pattern B from Pattern A.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 12: Mutation testing for flatMap

**Files:**
- Modify: `packages/ergoscript/test/eval/scoll-flat-map.test.ts`

Per Spec § Test strategy step 3 + R6 (mutation region narrowed to receiver Coll's inline-`Coll[Byte]` payload, via `locateInlineCollRegion`).

- [ ] **Step 1: Add mutation describe block** at the bottom of `scoll-flat-map.test.ts`. Use the shared `runMutationLoop` from `test/_helpers/mutation-harness.ts` (phase 2h-e infrastructure). Iterate happy-path scenarios; for each, narrow region to `locateInlineCollRegion(treeBytes, tree, collIndex: 0)`. Assert per-scenario and aggregate kill rate ≥ 0.9.

- [ ] **Step 2: Run vitest.** Capture the `[mutation]` log lines for inspection. If any scenario falls below 0.9, halt and investigate per R6 mitigation (do NOT just lower the threshold).

- [ ] **Step 3: Commit.**

```bash
git add packages/ergoscript/test/eval/scoll-flat-map.test.ts
git commit -m "$(cat <<'EOF'
test(ergoscript): SColl.flatMap mutation testing (≥90% kill rate)

Phase 2h-f Task 12. Byte-level XOR mutation on receiver Coll's inline
Coll[Byte] payload (narrowed via locateInlineCollRegion per R6). Uses
shared runMutationLoop from phase 2h-e _helpers/mutation-harness.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Final verification + doc refresh

### Task 13: End-of-phase verification

**Files:** none modified (verification only).

- [ ] **Step 1: Cross-package typecheck.**
```bash
npx tsc --noEmit -p packages/scorex/tsconfig.json          # CLEAN
npx tsc --noEmit -p packages/nipopow/tsconfig.json         # CLEAN
npx tsc --noEmit -p packages/avltree/tsconfig.json         # CLEAN
npx tsc --noEmit -p packages/ergoscript/tsconfig.json      # CLEAN
```

- [ ] **Step 2: Full node-mode test suite.**
```bash
node_modules/.bin/vitest run packages/
```
Expected: `3481 + N` (N = new tests from getEncoded + flatMap fixtures + edge cases + mutation; aim N ≈ 30-50).

- [ ] **Step 3: Cross-runtime jsdom for all 4 packages.**
```bash
cd packages/scorex && npx vitest run --config vitest.browser.config.ts && cd ../..
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts && cd ../..
cd packages/avltree && npx vitest run --config vitest.browser.config.ts && cd ../..
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts && cd ../..
```

- [ ] **Step 4: Fixture-gen determinism (final).**
```bash
cd fixture-gen && cargo build --release           # CLEAN
cd fixture-gen && cargo run --release             # writes fixtures
git diff --exit-code packages/                    # CLEAN (only the new files appear from earlier commits)
cd fixture-gen && cargo run --release             # second run for determinism
git diff --exit-code packages/                    # CLEAN
```

- [ ] **Step 5: Working tree status.** `git status` — clean modulo gitignored `audit20260519/`.

### Task 14: Docs refresh — facts/* + README

**Files:**
- Modify: `facts/ergoscript-eval.md`
- Modify: `facts/ergoscript.md`
- Modify: `README.md`

Per Spec § End-of-phase invariants.

- [ ] **Step 1: `facts/ergoscript-eval.md`** — registry table grows 42 → 44:
  - Add entry 43: `SGroupElement.getEncoded | 7:2 | 250 | A | Coll[Byte] (33 SEC1) | eval/sgroup_elem.rs:15-26`
  - Add entry 44: `SColl.flatMap | 12:15 | addPerItemCost(60,10,8,n) | B | Coll[OV] | eval/scoll.rs:52-136`
  - Add Phase 2h-f changelog section (mirror 2h-d/2h-e style).
  - Add R3(a)+(b) divergence notes — one-line each — on the `SColl.flatMap` row OR as a sub-bullet under the changelog.
  - Update coverage summary table: registry count 42 → 44.

- [ ] **Step 2: `facts/ergoscript.md`** — coverage summary line: registry 42 → 44; test totals updated to reflect new count.

- [ ] **Step 3: `README.md`** — packages table: ergoscript row's registry count + test count updated.

- [ ] **Step 4: Run typecheck (defensive — `tsc --noEmit` should be unaffected).**

- [ ] **Step 5: Commit.**

```bash
git add facts/ergoscript-eval.md facts/ergoscript.md README.md
git commit -m "$(cat <<'EOF'
docs: refresh facts + README for phase 2h-f (registry 42 → 44)

Phase 2h-f Task 14. Adds SGroupElement.getEncoded (7:2) and SColl.flatMap
(12:15) to the registry table. Documents R3 divergences from sigma-rust:
(a) elem-type check skipped for ValUse-source lambdas (Closure lacks
argTpes); (b) outElem may be SAny for empty-input flatMap when body is
PropertyCall/MethodCall (SMethod resolver not yet online → exprTpe SAny).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 15: SESSION_CONTEXT.md + HANDOFF_PROMPT.md refresh

**Files:**
- Modify: `SESSION_CONTEXT.md` (gitignored, not committed)
- Modify: `HANDOFF_PROMPT.md`

- [ ] **Step 1: Update `SESSION_CONTEXT.md`** — close out the Tier-3 cleanup deferred-item; add a 2h-f summary section per the pattern from 2h-d/2h-e.

- [ ] **Step 2: Update `HANDOFF_PROMPT.md`** for the next session: post-2h-f state (registry 44, EvalError codes 48, test count 3481+N, commits N ahead of origin/master).

- [ ] **Step 3: Commit HANDOFF_PROMPT only** (SESSION_CONTEXT is gitignored).

```bash
git add HANDOFF_PROMPT.md
git commit -m "$(cat <<'EOF'
docs: refresh HANDOFF_PROMPT for post-2h-f handoff

Phase 2h-f Task 15. Updates HANDOFF_PROMPT.md for the next session:
registry 42 → 44, new SColl.flatMap + SGroupElement.getEncoded handlers,
new HandlerFn `extra` arg, R3 divergences documented in facts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## End-of-phase invariants (must all hold after Task 15)

- ✅ Method handler registry: 42 → **44** entries (`facts/ergoscript-eval.md`).
- ✅ `EvalError` codes: 48 (unchanged).
- ✅ `Expr` arm coverage: 52 / ~70 (unchanged).
- ✅ `SValue` kind variants: unchanged.
- ✅ Test count under node: 3481 + N (N ≈ 30-50).
- ✅ Cross-runtime jsdom: clean across all 4 packages.
- ✅ Fixture-gen determinism: byte-identical output on second `cargo run`.
- ✅ Typecheck: clean per-package across all 4 packages.
- ✅ Working tree: clean modulo gitignored `audit20260519/`.
- ✅ Public APIs: `@ergots/scorex`, `@ergots/nipopow`, `@ergots/avltree` unchanged. `@ergots/ergoscript` gains 2 handlers (additive).
- ✅ No new runtime deps; no version bumps; no `RELEASING.md` change.
- ✅ `HandlerFn` signature extended with optional `extra` arg; 41 existing handlers unchanged (TS structural typing).
- ✅ Commit count: 12-14 (10-12 task commits + 2 spec/plan + optional doc).
- ✅ R3 divergences documented in `facts/ergoscript-eval.md` `SColl.flatMap` registry-table entry.

## Risks reminder (from spec)

- **R1 — `HandlerFn` signature extension.** Bisect-clean: Task 8 is its own commit; the 41 existing handlers ignore `extra` via TS structural typing.
- **R3(a) — Elem-check skip for ValUse-source lambdas.** Document in `facts/ergoscript-eval.md`. Task 11 adds a test scenario asserting the divergence behavior.
- **R3(b) — SAny tolerance for PropertyCall body.** Critical correctness fix from Round 2 review. Tasks 7 + 9 + 10 + 11 all touch this path. Refinement happens at first iter; empty input returns `Coll[SAny]`.
- **R6 — Mutation region narrowed upfront** to receiver Coll's inline-`Coll[Byte]` payload via `locateInlineCollRegion(treeBytes, tree, collIndex: 0)`.
- **R7 — Fixture-gen reachability pre-flight at Task 6** decides whether body-restriction + arity>1 + non-Coll-return throw scenarios live in oracle fixtures or TS-direct tests.

## Cross-references

- `docs/specs/2026-05-20-ergoscript-phase-2h-f-tier-3-method-handlers-design.md` — the spec this plan implements. **Spec wins on any interface disagreement.**
- `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md` — predecessor phase 2h-e; provides `runMutationLoop` infrastructure for Task 12.
- `SESSION_CONTEXT.md` — local-only state tracking (gitignored).
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list, "Never use --no-verify".
- `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md` — auto-loaded memories; includes `[[feedback-review-by-default]]` (new this session), `[[feedback-subagent-explicit-rules]]`, `[[feedback-correctness-over-effort]]`, `[[feedback-no-artificial-stops]]`, `[[reference-source-first-discipline]]`, `[[reference-cost-charging-order-patterns]]`.
