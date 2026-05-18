# ErgoScript Interpreter — Phase 2f Coll HOFs Design Spec

**Status:** Draft
**Date:** 2026-05-16
**Package:** `@ergots/ergoscript` (phase 2f Coll HOFs — closes umbrella plan's "phase 2f = collection operations")
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec; rewritten at Task 13 of this slice to reflect realized phase structure)
**Sister specs:**
- `docs/specs/2026-05-16-ergoscript-phase-2f-medium-design.md` (most-recent slice — chain-state Context + GlobalVars/GetVar/Option/SelectField; established the Mixed-Pattern-A precedent for all 6 arms, the controlled-Context fixture-gen pattern, and the in-spec smoking-gun-fixture template that this slice reuses for `Slice` cost-on-requested-range and `Exists`/`ForAll` outer-cost-on-full-length)
- `docs/specs/2026-05-15-ergoscript-phase-2f-design.md` (phase 2f narrow — Box runtime + 7 Box-extract arms; established the SBox wire surface that Coll[Box] HOFs may iterate over)
- `docs/specs/2026-05-15-ergoscript-phase-2e-design.md` (`FuncValue` + `Apply` plumbing that all 5 lambda HOFs dispatch through; introduced `EvalContext.treeVersion` field; introduced lambda result-type handling pattern reused by Filter/Exists/ForAll Boolean assertion)
- `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` (precedent for Pattern B per-item cost charging via `And`/`Or`; the `'coll-not-boolean'` code naming pattern carried to `'coll-input-not-coll'`)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-16 (post-phase-2f-medium)

## Goal

Ship phase 2f Coll HOFs: 9 new evaluator arms covering all direct-`Expr` Coll-operation MIR variants — `SizeOf`, `Append`, `ByIndex`, `Slice`, `MapColl`, `Filter`, `Fold`, `Exists`, `ForAll`. Closes the umbrella plan's "phase 2f = Collection operations" promise (which got bookkeeping-deferred across 2d-B → 2e → 2f-narrow → 2f-medium when the "2f" label drifted to cover umbrella's "2e" Box/Context model).

By the end of this slice:

- **Coverage goes 33 → 42 of ~70 `Expr` arms** (33 from prior phases + 9 new in this slice).
- **One new `EvalContext` infrastructure method:** `addPerItemCost(base: number, perChunk: number, chunkSize: number, items: number): void` — chunked-per-item cost charging, formula `base + perChunk * ceil(items / chunkSize)`. Used by 2 of 9 arms directly (`Append`, `Slice`) and as the outer component of 5 mixed-pattern lambda HOFs.
- **Seven new `EvalError` codes** (28 → 35 total): `'coll-input-not-coll'`, `'coll-elem-tpe-mismatch'`, `'coll-by-index-out-of-range'`, `'coll-by-index-index-not-int'`, `'coll-slice-bound-not-int'`, `'lambda-not-callable'`, `'lambda-result-type-mismatch'`.
- **One new shared helper module:** `eval/_coll-helpers.ts` with `extractCollItems(v)` (9 callers) + `extractFuncValue(v)` (5 callers — pre-stubbed in Task 1, consumed from Task 6).
- **New validation layer:** Layer C3.a operator-driven tree mutation testing. New test file `test/eval-mutation.test.ts` + new helper `test/_mutation-operators.ts` defining 7 mutation operators (O1–O7). Per-arm mutation score ≥ 90% with iterative-allowlist calibration. C3.a is scoped to the 9 Coll HOFs only (no retroactive coverage of the 33 prior arms; future slices may opt into C3.a per-phase).
- **No new runtime dependencies.** No `@noble/curves` (still phase 2g sigma protocol territory). No new wire-format parsing — all 9 MIR variants ship parse + serialize in phase 2a.

The slice is implemented as 14 sequential tasks in flat `PLAN.md` ordering. Commits between each task; no `STOP α/β/γ` markers (per [[feedback-no-artificial-stops]] memory).

## Non-goals

- **MethodCall-routed Coll methods** (`.indices`, `.zip`, `.zipWith`, `.reverse`, `.flatten`, `.getOrElse`, `.exists`/`.forall` via method-call style, etc.). All live in `sigma-rust/.../eval/scoll.rs`. Deferred to the new method-call-dispatch phase that comes after sigma protocol — see "Umbrella plan rewrite" below.
- **Sigma protocol primitives.** `@noble/curves`, structural `SigmaBoolean`, `proveDlog`, `proveDhTuple`, `Atleast`/`SigmaAnd`/`SigmaOr` deferred from slice 2d-B. Umbrella-aligned phase 2g.
- **AVL+ membership-proof verification.** Phase 2h.
- **Byte-array conversions** (`ByteArrayToLong`, `LongToByteArray`, `ByteArrayToBigInt`). Phase 2i.
- **Hash predefs** (`CalcBlake2b256`, `CalcSha256`, `DecodePoint`). Phase 2i.
- **`SubstConstants`.** Phase 2i.
- **Real-context cost validation (Layer C3-cost — note this is the OTHER C3 from prior specs' overloaded use of the name).** Phase 2j.
- **Retroactive C3.a coverage** for the 33 already-shipped arms. Future slices may opt-in per-phase.
- **`Header` runtime shape beyond what `PreHeader` already covers.** Full `Header` struct lands with method-call dispatch (the new phase after sigma) or 2h.
- **`Xor` (byte-array, `Coll[Byte] × Coll[Byte] → Coll[Byte]`).** Deferred from slice 2d-B with the sigma combinators; now slated for phase 2i alongside byte-ops predefs, since the sigma deferral no longer drags it forward.
- **`npm publish` of `@ergots/ergoscript`.** Separate user decision; not bundled with this slice.

## Umbrella plan rewrite (Task 13)

The umbrella `docs/specs/2026-05-13-ergoscript-interpreter-design.md` rewrites at Task 13 to reflect realized phase structure. **Historical phase numbers in older specs stay valid** as references; new phase numbering takes effect from this slice forward.

| Umbrella phase | Original promise | Realized as |
|---|---|---|
| 2a | Wire format | ✅ shipped 2026-05-14 |
| 2b | Type system + constant evaluation | ✅ shipped (Const, ConstPlaceholder, BlockValue, ValDef, ValUse, Tuple, Collection, If) |
| 2c | Operators | ✅ shipped (BinOp, LogicalNot, BoolToSigmaProp) |
| 2d | Conditionals + blocks (lambdas) | ✅ shipped across 2d-A (numeric-poly unary) + 2d-B (Coll[Boolean] aggregators) — but lambdas themselves slipped to realized 2e |
| 2e | Box / Context model | ❌ relabeled — realized 2e shipped lambdas + treeVersion + XorOf + V3 revisit; Box/Context model deferred to realized 2f-narrow + 2f-medium |
| **2f** | **Collection operations** | **✅ shipped as THIS slice (phase 2f Coll HOFs)** |
| 2g | Sigma protocol | ⏳ next — narrow scope (umbrella-aligned: proveDlog, proveDhTuple, CAND/COR/CTHRESHOLD, `@noble/curves`) |
| **2g.5** | **NEW — Method-call dispatch** | ⏳ inserted before 2h. Unlocks the C2 corpus (`box.tokens` and other MethodCall-routed accesses) |
| 2h | AVL+ trees | ⏳ pending |
| 2i | Predefs and oddments | ⏳ pending (includes deferred `Xor` byte-array, byte-array conversions, hash predefs, `SubstConstants`) |
| 2j | Cost accounting | ⏳ pending (Layer C3-cost real-context validation) |

The "delivered as" annotations preserve readability for future contributors browsing older specs.

## Architecture

### Directory layout

```
packages/ergoscript/src/eval/
├── eval-context.ts              MODIFIED: add `addPerItemCost` method
├── eval.ts                      MODIFIED: 9 new case lines
├── _coll-helpers.ts             NEW: extractCollItems + extractFuncValue
├── coll-size.ts                 NEW
├── coll-append.ts               NEW
├── coll-by-index.ts             NEW
├── coll-slice.ts                NEW
├── coll-map.ts                  NEW
├── coll-filter.ts               NEW
├── coll-fold.ts                 NEW
├── coll-exists.ts               NEW
└── coll-forall.ts               NEW

packages/ergoscript/test/
├── _mutation-operators.ts       NEW: 7 mutation operators (O1–O7)
├── eval-mutation.test.ts        NEW: Layer C3.a runner
├── eval/coll-size.test.ts       NEW
├── eval/coll-append.test.ts     NEW
├── eval/coll-by-index.test.ts   NEW
├── eval/coll-slice.test.ts      NEW
├── eval/coll-map.test.ts        NEW
├── eval/coll-filter.test.ts     NEW
├── eval/coll-fold.test.ts       NEW
├── eval/coll-exists.test.ts     NEW
├── eval/coll-forall.test.ts     NEW
└── fixtures/eval/coll-*.json    NEW: 9 generated fixtures

fixture-gen/src/cmds/ergoscript/eval/
├── mod.rs                       MODIFIED: 9 new `pub mod` lines
├── coll_size.rs                 NEW
├── coll_append.rs               NEW
├── coll_by_index.rs             NEW
├── coll_slice.rs                NEW
├── coll_map.rs                  NEW
├── coll_filter.rs               NEW
├── coll_fold.rs                 NEW
├── coll_exists.rs               NEW
└── coll_forall.rs               NEW
fixture-gen/src/main.rs          MODIFIED: 9 new generate_and_write calls
```

Per-arm function signature unchanged from prior slices: `eval<Variant>(e, env, ctx) => SValue`. Central `evalExpr` in `eval.ts` gains 9 new `case` lines.

### Cost-charging infrastructure addition

In `eval/eval-context.ts`, `EvalContext` gains one new method:

```ts
export interface EvalContext extends EvalOpts {
  // ... existing fields (addCost, etc.) ...

  /**
   * Charges base + perChunk * ceil(items / chunkSize). Mirrors sigma-rust's
   * `add_per_item_jit_cost` cost primitive. Throws `'cost-limit-exceeded'`
   * if accumulator overflows `jitCostLimit`.
   *
   * Source: ergotree-interpreter/src/eval/cost_accum.rs
   */
  addPerItemCost(base: number, perChunk: number, chunkSize: number, items: number): void
}
```

Implementation in `makeContext()` adds to the accumulator with the chunked formula. Two of nine arms call this directly (`Append`, `Slice`); five call it as the outer component of a mixed-pattern cost (`MapColl`, `Filter`, `Fold`, `Exists`, `ForAll`); two don't call it (`SizeOf`, `ByIndex` — pure Pattern A).

### Three cost-charging patterns simultaneously

Source-read findings against sigma-rust at `integration/ergots@ed5452cf`:

| Arm | Cost pattern | Outer | Per-iter | Source cite |
|---|---|---|---|---|
| `SizeOf` | A | `Fixed(14)` before child | — | `coll_size.rs:15` |
| `ByIndex` | A | `Fixed(30)` before child + lazy default eval | — | `coll_by_index.rs:18` |
| `Append` | B-chunked | `add_per_item_jit_cost(20, 2, 100, n1+n2)` after children | — | `coll_append.rs:57` |
| `Slice` | B-chunked | `add_per_item_jit_cost(10, 2, 100, max(0, until-from))` after children | — | `coll_slice.rs:32` |
| `MapColl` | **Mixed (B-chunked + B-per-iter)** | `add_per_item_jit_cost(20, 1, 10, n)` | `addCost(5)` per item | `coll_map.rs:31, 72` |
| `Filter` | **Mixed** | `add_per_item_jit_cost(20, 1, 10, n)` | `addCost(5)` per item | `coll_filter.rs:32, 60` |
| `Fold` | **Mixed** | `add_per_item_jit_cost(3, 1, 10, n)` | `addCost(5)` per item | `coll_fold.rs:29, 48` |
| `Exists` | **Mixed (short-circuit)** | `add_per_item_jit_cost(3, 1, 10, n)` — **charges full input length regardless of short-circuit point** | `addCost(5)` per visited item | `coll_exists.rs:29, 60` |
| `ForAll` | **Mixed (short-circuit)** | `add_per_item_jit_cost(3, 1, 10, n)` — same outer-on-full-length subtlety | `addCost(5)` per visited item | `coll_forall.rs:29, 60` |

The reference memory `reference_cost_charging_order_patterns` gets updated at Task 14 to document the Mixed pattern (Pattern A and Pattern B can coexist within one arm).

### Lambda invocation skeleton (5 lambda HOFs share this)

```ts
const inputColl = extractCollItems(evalExpr(e.input, env, ctx))     // throws 'coll-input-not-coll' if not Coll
const closure   = extractFuncValue(evalExpr(e.condition, env, ctx)) // throws 'lambda-not-callable' if not Lambda

// Map/Filter/Exists/ForAll: elem check (Map: against mapper_sfunc.t_dom[0]; F/E/F: against declared e.elem_tpe)
if (!sTypeEquals(inputColl.elem, expectedElem)) {
  throw new EvalError('coll-elem-tpe-mismatch', ...)
}

ctx.addPerItemCost(base, perChunk, chunkSize, inputColl.items.length)  // outer chunked cost

for (const item of inputColl.items) {
  ctx.addCost(5)                                       // per-iter cost
  const itemEnv = env.extend(closure.argId, item)      // existing Env.extend from phase 2e
  const itemRes = evalExpr(closure.body, itemEnv, ctx) // existing dispatch
  // arm-specific aggregation logic:
  //   Map:    assert itemRes.tpe matches mapper_sfunc.t_range, collect items
  //   Filter: assert itemRes.kind === 'Boolean'; keep item if true
  //   Fold:   wrap (acc, item) as Tuple SValue, pass to closure; accumulator = itemRes
  //   Exists: assert itemRes.kind === 'Boolean'; short-circuit return true if true
  //   ForAll: assert itemRes.kind === 'Boolean'; short-circuit return false if false
}
```

`env.extend` + `evalExpr` plumbing already shipped in phase 2e for `Apply`. No new env infrastructure needed.

### New shared helpers (`_coll-helpers.ts`)

The leading-underscore matches existing project convention (`_byte-coll.ts`, `_box-synthesis.ts`, `_numeric.ts`, `_group-generator.ts`).

```ts
// extractCollItems — guards v.kind === 'Coll', returns coll runtime view
// 9 callers (all 9 arms in this slice)
// Field name `elem` matches SValue's own `Coll` variant for consistency.
export function extractCollItems(v: SValue): { items: SValue[]; elem: SType } {
  if (v.kind !== 'Coll') {
    throw new EvalError('coll-input-not-coll', `expected Coll, got ${v.kind}`)
  }
  return { items: v.items, elem: v.elem }
}

// extractFuncValue — guards v.kind === 'Lambda', returns the closure
// 5 callers (Map/Filter/Fold/Exists/ForAll)
// Pre-stubbed in Task 1; consumers arrive in Task 6
export function extractFuncValue(v: SValue): Closure {
  if (v.kind !== 'Lambda') {
    throw new EvalError('lambda-not-callable', `expected Lambda, got ${v.kind}`)
  }
  if (v.closure.argIds.length === 0) {
    // Defensive: parser invariant rejects empty-args FuncValue; this catches eval-time-only malformations
    throw new EvalError('lambda-not-callable', 'lambda has empty args list')
  }
  return v.closure
}
```

The "empty args" check is merged into `'lambda-not-callable'` rather than a separate `'lambda-args-empty'` code (per Decision #8 in the decision log).

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle. Per-arm semantics confirmed by source-read 2026-05-16.

### `SizeOf { input }`
Returns `Int(items.length)`. Edge: input must be `Coll[T]` for some `T`, else `'coll-input-not-coll'`. No element-type check.
Source: `coll_size.rs:11-22`.

### `Append { input, col_2 }`
Concatenates two `Coll[T]` of matching `elem_tpe`. Result `elem_tpe` preserved from `input`. Throws `'coll-input-not-coll'` if either input is non-Coll; throws `'coll-elem-tpe-mismatch'` if element types differ.
Source: `coll_append.rs:39-63`.

### `ByIndex { input, index, default? }`
Eval order: `input` → `index` → on OOB, eval `default` lazily. `default` is `Option<Expr>` in MIR. If absent and index OOB, throws `'coll-by-index-out-of-range'`. Index is `Int` (32-bit signed); negative indices count as OOB. Throws `'coll-by-index-index-not-int'` if `index` doesn't evaluate to Int.
Source: `coll_by_index.rs:11-50`.

### `Slice { input, from, until }`
**Intersection semantics** (Scala-compat): does *not* throw on OOB. `from < 0` clips to `0`; `until > len` clips to `len`; `from >= until` returns empty Coll. Cost scales with **requested range** `max(0, until - from)`, not with input length or clipped output length. Locked by sigma-rust regression test for issue #724. Throws `'coll-slice-bound-not-int'` if either bound doesn't evaluate to Int.
Source: `coll_slice.rs:11-43`; regression test at `coll_slice.rs:165-211`.

### `MapColl { input, mapper, mapper_sfunc, out_elem_tpe }`
`mapper` evaluates to a unary `FuncValue` with arg type `mapper_sfunc.t_dom[0]`, body type `mapper_sfunc.t_range`. Input elem_tpe must match `mapper_sfunc.t_dom[0]` (else `'coll-elem-tpe-mismatch'`). Output: `Coll[t_range]`. Each per-item lambda body result is asserted against `mapper_sfunc.t_range` before pushing to output (else `'lambda-result-type-mismatch'`). The `out_elem_tpe()` accessor derives the output type from the mapper SFunc.
Source: `coll_map.rs:14-84`.

### `Filter { input, condition, elem_tpe }`
`condition` evaluates to a `FuncValue` returning Boolean. Input runtime elem_tpe must match declared `elem_tpe` (else `'coll-elem-tpe-mismatch'`). Output: `Coll[elem_tpe]` (preserves input elem_tpe), items where body→`true`. If body returns non-Boolean SValue, throws `'lambda-result-type-mismatch'`. Cost charged for every item (no short-circuit — Filter must visit all items to compute the output).
Source: `coll_filter.rs:15-90`.

### `Fold { input, zero, fold_op }`
`fold_op` evaluates to a `FuncValue` whose arg is a 2-tuple `(Acc, Item)`. **Eval order:** `input` → `zero` → `fold_op` → outer cost charge → per-item loop. Accumulator type is `zero.tpe`. The fold_op's body destructures the 2-tuple via `SelectField(1)` / `SelectField(2)` (`SelectField` already wired in phase 2f medium — no new dependency).

Special case: `Coll[Byte]` input. Sigma-rust represents this via `CollKind::NativeColl(NativeColl::CollByte)` and wraps each byte in `Value::Byte(*byte)` before tupling. TS port: `SValue.kind: 'Coll'` items are always full SValues (no native-byte optimization), so this special case dissolves into the general path.

Source: `coll_fold.rs:12-71`; proptest example at `coll_fold.rs:100-150`.

### `Exists { input, condition, elem_tpe }`
Short-circuits: returns `Boolean(true)` as soon as one item makes body→`true`. Empty Coll → `Boolean(false)`.

**Cost subtlety:** the outer chunked cost is charged BEFORE the per-item loop runs, based on FULL input length. Only the per-iter `addCost(5)` reflects short-circuit. So Exists short-circuiting at item 1 of 1000 still incurs `addPerItemCost(3, 1, 10, 1000)` + only one `addCost(5)`. This is locked by a smoking-gun C1 fixture.

Source: `coll_exists.rs:12-79`.

### `ForAll { input, condition, elem_tpe }`
Short-circuits: returns `Boolean(false)` as soon as one item makes body→`false`. Empty Coll → `Boolean(true)`. Cost subtlety identical to Exists (outer charges full size; per-iter charges visited items only).
Source: `coll_forall.rs:12-79`.

## Error codes (7 new)

Total taxonomy after this slice: **35 EvalError codes** (28 from prior phases + 7 new). Naming follows `<arm-or-arm-family>-<failure-mode>` convention.

**Shared codes (multiple arms emit):**

| Code | Emitted by | Failure mode |
|---|---|---|
| `'coll-input-not-coll'` | All 9 arms | The Coll input expression evaluated to a non-Coll `SValue` |
| `'coll-elem-tpe-mismatch'` | `Append`, `MapColl`, `Filter`, `Exists`, `ForAll` | Element type doesn't match declared/expected: Append (input vs col_2); Map (input vs `mapper_sfunc.t_dom[0]`); Filter/Exists/ForAll (input vs declared `elem_tpe`) |
| `'lambda-not-callable'` | 5 lambda HOFs | The mapper/condition/fold_op evaluated to non-Lambda — *or* a Lambda with empty `args` list |
| `'lambda-result-type-mismatch'` | 5 lambda HOFs | Lambda body returned wrong SType: Filter/Exists/ForAll require Boolean; Map asserts against `mapper_sfunc.t_range`; Fold asserts against `zero.tpe` |

**Arm-specific codes:**

| Code | Emitted by | Failure mode |
|---|---|---|
| `'coll-by-index-out-of-range'` | `ByIndex` | Index OOB and no `default` branch (Some(default) path is lazy-evaluated, no throw) |
| `'coll-by-index-index-not-int'` | `ByIndex` | Index expression evaluated to a non-Int SValue (defensive; parser type-check should catch upstream) |
| `'coll-slice-bound-not-int'` | `Slice` | `from` or `until` evaluated to non-Int SValue (one shared code for both bounds, matching sigma-rust's single `TryExtractFrom` family) |

**Notes:**
- `'cost-limit-exceeded'` already exists. The new `addPerItemCost` helper throws the same code on overflow — no new code needed.
- **No code for Slice's OOB** — intersection semantics deliberately doesn't throw.
- **Map's lambda-result check** is explicit in the TS port (sigma-rust handles implicitly via `CollKind::from_collection`'s side-checks; TS asserts per-item against `mapper_sfunc.t_range`).
- **No new `SValueParseError` codes** — all 9 MIR variants wire-parse cleanly via phase 2a.

## Validation strategy

Three layers stack. C1 + C2 are existing patterns; **C3.a is new infrastructure** introduced in this slice.

### Layer C1 — per-arm fixture + value/cost asserts (existing)

Per-arm `.json` fixtures generated by fixture-gen (Rust) running `try_eval_out::<Value<'static>>` against sigma-rust at `integration/ergots@ed5452cf`. TS tests load each fixture, parse + eval, assert SValue and cost equality.

**Required smoking-gun fixtures** (lock non-obvious semantics):

- **`Slice` cost-on-requested-range:** same `(from, until)` range against a 5-item input vs a 1000-item input → assert identical cost. Locks the bug-7 (issue #724) fix.
- **`Exists`/`ForAll` outer-cost-on-full-length:** short-circuit at item 1 with input length 1000 → assert cost = `addPerItemCost(3, 1, 10, 1000) + 1·addCost(5)`. Locks the "outer charges full size" subtlety.
- **`ByIndex` with-and-without default + laziness:** OOB without default → throws; OOB with default → returns default and the cost reflects `default` eval only on OOB path. Locks the laziness.
- **Empty-Coll edge cases (one entry each):** `MapColl([], _) = []`, `Fold([], zero, _) = zero`, `Filter([], _) = []`, `Exists([], _) = false`, `ForAll([], _) = true`, `SizeOf([]) = 0`, `Slice([], _, _) = []`.
- **Error cases:** one entry per new EvalError code (7 codes × ~1 entry each = ~7 entries spread across arms). Cost-limit-exceeded entry per arm with tight `jitCostLimit`.
- **Mixed-pattern cost smoking-gun:** for each lambda HOF, one entry with `n_items > 10` so the outer chunked cost has > 1 chunk and is observably distinct from a `n_items < chunkSize` baseline.

### Layer C2 — corpus regression gate (existing)

`test/corpus-eval.test.ts` runs unchanged. **Expected outcome after this slice:** still `success=0 not-impl=18 other=0`. The 18 evaluable corpus trees use method calls (which don't ship until the new method-call-dispatch phase after sigma protocol), so they stay at `'not-implemented-yet'`. Some trees' failure points may shift deeper as Coll HOFs land (a tree that previously hit `'not-implemented-yet'` at `MapColl` now reaches its first method-call and fails there). The `expect(other).toBe(0)` regression gate stays green.

### Layer C3.a — operator-driven tree mutation (NEW)

**Implementation location:** `test/_mutation-operators.ts` (test-side helper; mutation is a test-time concern) + `test/eval-mutation.test.ts` (the runner). Mirrors the existing `test/parse-mutation.test.ts` location pattern.

**Operator set:**

| # | Operator | Applies to | What it does |
|---|---|---|---|
| O1 | `replaceLeafConst` | All arms | Walk the tree; for each leaf `Const`, emit a variant with the value replaced by a different value of the same SType (`Int(5) → Int(6)`, `Long(100) → Long(101)`, `Boolean(true) → Boolean(false)`, etc.) using a fixed substitution table |
| O2 | `swapBinaryChildren` | All arms | For each binary node (`BinOp`, `Tuple` with 2 items, `Append`), emit a variant with children swapped. Commutative-op variants survive — caught & accepted via expected-survival allowlist |
| O3 | `mutateCollItem` | Coll inputs | For each Coll-typed `Const` or `Collection` literal, emit a variant with one item's value replaced. Fires N times per fixture for a Coll of length N |
| O4 | `replaceLambdaBodyConst` | 5 lambda HOFs | Inside any `FuncValue`, apply O1 to constants in the body — separately from O1 because it isolates lambda-body coverage |
| O5 | `negateBooleanCond` | `Filter`, `Exists`, `ForAll` | For each `FuncValue` whose body returns Boolean, wrap the body in `LogicalNot`. Should *always* change the result for non-empty Colls |
| O6 | `mutateByIndexIndex` | `ByIndex` only | Replace the index `Const` with a different in-bounds index. Result differs unless all Coll items are identical |
| O7 | `mutateFoldZero` | `Fold` only | Replace the `zero` `Const` with a different value of the same SType. Result shifts by `Δzero` for `+`-like fold ops; differs for `max`/`min`/other |

**Kill criteria:** For each mutation variant, evaluate. Mutation is **killed** if (a) eval result differs from baseline, OR (b) a typed `EvalError` is thrown. Mutation **survives** if eval succeeds with same value as baseline.

**Mutation score:** `killed / (killed + survived)` per arm. **Threshold: ≥ 90% per arm**, applied after the iterative-allowlist calibration step.

**Expected-survival allowlist (calibration, Task 12):** First-run all 9 arms through all 7 operators. Surviving mutations are grouped by `(operator, applicable_site_pattern)` and classified:
- **Fundamentally unkillable** → add to allowlist (commutative-op symmetry, dead-branch mutations, identity transformations)
- **Real coverage gap** → add a new fixture entry that distinguishes the baseline from the mutated variant; rerun

After calibration: allowlist locked in `test/_mutation-allowlist.ts`. Deviations from the allowlist (surviving mutations not in the allowlist) count as test failures.

**Deterministic:** Operators enumerate sites in tree-traversal order. Mutation substitution values come from a fixed table (`Int(5) → Int(6)`, never random). No `Math.random()`, no time-based seeds.

**Estimated volume:** 9 arms × ~5 fixtures × ~7 operators × ~3-10 applicable sites ≈ 1000-3000 mutations total. Target runtime < 30s for the full `eval-mutation.test.ts` file. Mutations evaluate under tight `jitCostLimit` to bound runaway cost.

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. Phase 2f Coll HOFs adds no new browser-incompatible primitives — all 9 arms are pure-TS (no hashes, no curve ops, no chain-state-dependent runtime).

### Determinism gate

Two-run `cargo build -p fixture-gen --release` + `cargo run -p fixture-gen --release` per fixture-gen task (Tasks 2-10). Diff against committed fixtures must be empty. Same gate as prior slices; carries over directly.

## Task structure

Flat 14-task list. Commits between each task. No `Stop α/β/γ` markers (per [[feedback-no-artificial-stops]] memory).

| # | Task | Subject | Adds |
|---|---|---|---|
| 1 | Foundation | `EvalContext.addPerItemCost`; `_coll-helpers.ts` with `extractCollItems` + `extractFuncValue` | Infra for Tasks 2-10 |
| 2 | `SizeOf` | Pattern A; simplest no-lambda arm, warm-up | First arm of slice |
| 3 | `Append` | Pattern B-chunked; first `addPerItemCost` consumer | `'coll-elem-tpe-mismatch'` introduced |
| 4 | `ByIndex` | Pattern A + lazy default | `'coll-by-index-out-of-range'`, `'coll-by-index-index-not-int'` introduced |
| 5 | `Slice` | Pattern B-chunked + intersection semantics + smoking-gun fixture | `'coll-slice-bound-not-int'` introduced |
| 6 | `MapColl` | First lambda HOF; mixed-pattern cost | `'lambda-not-callable'`, `'lambda-result-type-mismatch'` introduced |
| 7 | `Filter` | Adds declared-`elem_tpe`-vs-runtime check pattern | Reuses MapColl's lambda invocation |
| 8 | `Fold` | Binary lambda via 2-tuple arg + `SelectField` destructure | Introduces `zero` handling |
| 9 | `Exists` | Short-circuit on `true`; smoking-gun outer-cost-on-full-length | — |
| 10 | `ForAll` | Short-circuit on `false`; mirrors Exists | — |
| 11 | C3.a infrastructure | `test/_mutation-operators.ts` (7 operators) + `test/eval-mutation.test.ts` | New validation layer |
| 12 | C3.a calibration | First-run all 9 arms; build expected-survival allowlist; lock thresholds | — |
| 13 | Docs update | `facts/ergoscript.md` + umbrella plan rewrite | — |
| 14 | Finalize | Memory updates + `SESSION_CONTEXT.md` + commit + push | — |

**Subagent-driven discipline** matches phase 2f medium: one subagent dispatch per task + two-stage review (spec compliance + code quality). ~14 × 3 ≈ 42 calls + fix-rounds. Per-task commits keep history granular and bisectable.

**Cross-task dependencies:**
- Tasks 2-5 (no-lambda arms) depend on Task 1's `addPerItemCost` (Tasks 3, 5) and `extractCollItems` (all).
- Tasks 6-10 (lambda HOFs) depend on Task 1's `extractFuncValue` + on phase 2e's `FuncValue`/`Apply` plumbing (already shipped).
- Task 8 (`Fold`) depends on phase 2f medium's `SelectField` (already shipped) for 2-tuple destructure.
- Tasks 11-12 (C3.a) depend on all 9 arms shipping (Tasks 1-10).
- Tasks 13-14 are pure docs/finalize.

Ordering is logical-dependency + progressive complexity. The 9 arms have no cross-arm runtime dependencies (each is a self-contained eval function + fixture + test).

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | **Frame slice as "closing umbrella's phase 2f Coll HOFs"** rather than the handoff's "phase 2g = three universes (sigma + method-call + Coll HOFs)" | Stay with handoff framing; pick one of 2g-α/β/medium/broad sub-slices. | The umbrella's "phase 2f = Collection operations" got bookkeeping-deferred across four prior specs (2d-B → 2e → 2f-narrow → 2f-medium) when the "2f" label drifted to cover umbrella's "2e" Box/Context model. Closing this gap with a focused slice gives three clean focused future phases (sigma 2g, method-call 2g.5, AVL+ 2h) instead of one omnibus 2g. |
| 2 | **9 arms in one slice** (all direct-`Expr` Coll operations) | Split narrow (no-lambda 4) + medium (lambda 5); narrowest (no-lambda only); broad (include MethodCall-routed Coll methods). | Cohesive — "Coll HOFs are done" after this slice. ~12-18h. Lambdas already wired in phase 2e, so all 5 lambda HOFs share infrastructure. Narrower cuts would leave the slice's identity incoherent. |
| 3 | **Layer C3.a operator-driven mutation testing lands here** | Defer Layer C3 again (still TBD); land C3.b smoking-gun only; land C3.c hybrid (operators + smoking-gun); use Stryker (code mutation tool). | User direction: "has to happen eventually. Land Layer C3 here." Operator-driven (C3.a) is the right long-term investment — reusable infrastructure for future phases. Smoking-gun (C3.b) doesn't scale; will accrete lazily as bugs surface (also user-directed). Stryker covers all 33 prior arms (not just 9), out of scope. |
| 4 | **Layer C3.a operator set: 7 operators (O1-O7) mix of generic + lambda-arm-specific + arm-specific** | Fewer (generic-only); more (per-arm exhaustive). | Generic operators (O1, O2, O3) provide baseline coverage cheaply. Lambda-arm-specific (O4, O5) isolate the recursive-lambda bug surface that motivated this slice's C3 introduction. Arm-specific (O6, O7) cover ByIndex/Fold-specific arithmetic. Reusable for future phases (sigma protocol, method-call dispatch, AVL+). |
| 5 | **C3.a calibration via iterative allowlist + ≥ 90% threshold** | Upfront 100% kill rate; no threshold (just inspect logs); per-arm threshold tuning. | First-run will surface fundamentally-unkillable mutations (commutative-op symmetry, dead branches, identity transforms). Allowlist them; treat the remaining surviving mutations as coverage gaps requiring new fixture entries. 90% is calibration-realistic; future phases may tighten. |
| 6 | **Flat 14-task list with per-task commits; no `Stop α/β/γ` markers** | 3-stop structure (matches phase 2f narrow + 2f medium); 2-stop split. | User direction 2026-05-16: *"no need to stop unless there's explicit reason to, just make sure to commit in between tasks."* No real reason to pause in this slice — no major refactor, no breaking change, no decision point requiring user input mid-slice. Saved as feedback memory for future slices. |
| 7 | **`addPerItemCost` as `EvalContext` method** (alongside existing `addCost`) | Standalone helper function; class method; separate `ChunkedCostAccumulator` interface. | Mirrors existing `addCost` location and call style. Existing `makeContext` factory propagates the implementation. Two direct call sites (`Append`, `Slice`) + five mixed-pattern uses — promotes to method status by call-site count. |
| 8 | **Merge `'lambda-args-empty'` into `'lambda-not-callable'`** | Separate codes (sigma-rust distinguishes them with `NotFound` vs `UnexpectedValue`). | Semantic family is identical: "the lambda value didn't have the expected shape." Project's taxonomy is its own (we don't 1:1 map sigma-rust's error types). Cleaner taxonomy with one fewer code. |
| 9 | **`extractFuncValue` pre-stubbed in Task 1** (consumed from Task 6 onward) | Strict YAGNI — promote to `_coll-helpers.ts` at the 3rd Stop-β caller (Task 8). | Pragmatic: both helpers ship in the same module and the 5 Stop-β consumers immediately demand it. Strict YAGNI would mean inline checks in Tasks 6-7 and a refactor at Task 8. Pre-stub costs zero runtime; saves the refactor. Acknowledged dead-through-Task-5 in module comment. |
| 10 | **Map's `mapper_sfunc.t_dom[0]` accessed via TS MIR field** | Inferred from `mapper.tpe.args[0]` (the FuncValue's declared arg type). | Source-read at Task 6 confirms the TS MIR. Both are semantically equivalent; the explicit field name matches sigma-rust's structure. Fallback to `mapper.tpe.args[0]` if the MIR doesn't carry `mapper_sfunc` (verify at Task 6 source-read). |
| 11 | **Fixture-gen builds controlled inputs (matched-elem_tpe Colls)** rather than relying on `force_any_val` for Coll types | Use `force_any_val<MapColl>` directly. | Phase 2f narrow + medium established controlled-fixture pattern. For Coll-with-typed-items, `force_any_val` may produce mismatched elem_tpe that violates Map/Filter/Exists/ForAll's declared-elem_tpe-vs-runtime check. Controlled inputs guarantee fixture predictability. |
| 12 | **Update `reference_cost_charging_order_patterns` memory at Task 14 to document the Mixed pattern** | Leave memory describing only A vs B; create a new memory for Mixed. | Mixed is just A and B coexisting within one arm (outer chunked + per-iter). Extending the existing memory is more discoverable than splitting. |

## Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Mixed cost-charging pattern on lambda HOFs** — forgetting the outer `addPerItemCost` (only charging the per-iter `addCost(5)`) is the most likely first-pass mistake | C1 cost-equality fixtures per arm. Each lambda HOF needs at minimum one entry with `n_items > 10` so the chunked component is observable |
| 2 | **`addPerItemCost` chunking formula bug** — `base + perChunk * ceil(items / chunkSize)` is easy to mis-implement (off-by-one ceil; division-by-zero when chunkSize=0; integer overflow) | Dedicated unit tests for the helper itself: items=0, items=chunkSize, items=chunkSize+1, items=10·chunkSize, items=very-large. Source: `ergotree-interpreter/src/eval/cost_accum.rs::add_per_item_jit_cost` |
| 3 | **`Slice` intersection semantics inverted** — easy to throw on OOB instead of clipping; easy to use input length instead of requested range for cost | C1 smoking-gun fixtures: `slice([1,2,3], -1, 10)` returns `[1,2,3]`; cost(`from=0, until=2`, input length 5) == cost(`from=0, until=2`, input length 1000). Source: `coll_slice.rs:165-211` regression test for issue #724 |
| 4 | **Exists/ForAll outer-cost-on-full-length forgotten** — natural assumption is "short-circuit = less total cost"; the outer chunked cost charges based on input length regardless of short-circuit point | C1 smoking-gun fixture: `Exists` short-circuit at item 1 with input length 1000 → assert cost = `addPerItemCost(3, 1, 10, 1000) + 1·addCost(5)`, not `addPerItemCost(3, 1, 10, 1) + 1·addCost(5)` |
| 5 | **`Fold` 2-tuple arg pattern misimplemented** — easy to assume binary lambda with two env slots; sigma-rust uses unary lambda with `(acc, item)` Tuple arg and body destructures via `SelectField` | Source-read at Task 8 reads `coll_fold.rs:48-63` directly. The sigma-rust proptest at `coll_fold.rs:100-150` provides a known-correct port target. C1 fixture mirrors that proptest's tree shape |
| 6 | **`Map` `mapper_sfunc` access unclear in TS MIR** — Map's input elem_tpe check goes against `self.mapper_sfunc.t_dom.first()`; need to verify TS MIR carries this through phase 2a parsing | Source-read at Task 6. If TS MIR doesn't expose `mapper_sfunc.t_dom[0]`, fall back to inferring from `mapper.tpe.args[0]` — semantically equivalent. C1 fixture covers input-elem-tpe-mismatch |
| 7 | **`CollKind::NativeColl(CollByte)` special case in Map/Fold** — sigma-rust optimizes `Coll[Byte]` with packed bytes; iteration wraps each in `Value::Byte`. TS `SValue.kind: 'Coll'` items are always full SValues, so the distinction may not apply | Source-read at Task 6/8 confirms TS handles transparently. C1 fixture with `Coll[Byte]` input verifies |
| 8 | **C3.a operator calibration: surviving-mutations rate too high at first run** — operators may produce many "structurally equivalent" mutations (commutative-op symmetry, identity transformations, dead branches) | Iterative allowlist at Task 12. Mutations grouped by `(operator, applicable_site_pattern)` and classified. Target ≥ 90% kill rate after allowlist. If first-run rate < 70%, operators need redesign — re-spec Task 11 |
| 9 | **C3.a runtime too slow** — 1000-3000 mutations × eval per mutation could hit 60s+ | Operators enumerate sites in single tree traversal. Eval reuses parsed Expr (no re-parse per mutation). Mutations evaluated under tight `jitCostLimit` to bound runaway cost. Target < 30s for the full eval-mutation test file |
| 10 | **Umbrella plan rewrite at Task 13 breaks citations in other specs** — multiple specs cite "phase 2e" / "phase 2f" / "phase 2g" by name | Don't rewrite historical phase numbers. Add "delivered as" annotations: "umbrella's 2e — delivered as 2f-narrow + 2f-medium." Phase numbers in older specs stay valid as historical references; new phase numbering takes effect from this slice forward |
| 11 | **Determinism regression in fixture-gen** — phase 2f medium caught a `force_any_val<Context>` regression; phase 2g fixture-gen modules may inherit similar randomness | Two-run cargo build + diff check per fixture-gen task. Pattern from phase 2f medium Task 1 caught a real bug; carries over to Tasks 2-10 here |
| 12 | **Subagent missing the spec's design decisions** — 14 tasks × 3 dispatches each is many opportunities for context drift | Two-stage review per task (spec compliance + code quality). Both reviewers read the relevant spec section + the PLAN's task section. Pattern proven across 2b's 18 tasks through 2f medium's 16 tasks |
| 13 | **C3.a operators don't catch real bugs** — mutation testing can be high-coverage but low-quality. Operators may catch only superficial mutations and miss real-bug-surface mutations | Hand-curated smoking-gun mutations get added when bugs surface (per user direction: *"If any bugs surface down the line those will become the hand-curated smoking-gun mutations"*). The operator-driven layer provides the floor; smoking-gun adds the ceiling lazily |

## Validation against this spec at Task 14 finalize

Task 14's spec-compliance check verifies:

1. **Coverage line in `facts/ergoscript.md`** reflects 33 → 42 of ~70 arms.
2. **EvalError taxonomy in `facts/ergoscript.md`** documents all 7 new codes with one-line semantics.
3. **`addPerItemCost` documented** in `facts/ergoscript.md`'s `EvalContext` section.
4. **Umbrella plan** has the "delivered as" annotations + the new "2g.5 method-call dispatch" entry.
5. **`SESSION_CONTEXT.md`** snapshot matches the end state (42 arms wired, 35 EvalError codes, etc.).
6. **`reference_cost_charging_order_patterns` memory** documents the Mixed pattern (Pattern A and Pattern B can coexist within one arm).
7. **`project_ergots_direction` memory** updated: phase 2f Coll HOFs shipped; next is phase 2g (sigma protocol, umbrella-aligned).
8. **`MEMORY.md` hook line** for `project_ergots_direction` reflects the update.
9. **Test counts:** prior 1734 ergoscript tests stay green; ~60-100 new per-arm C1 tests pass (9 arms × ~7-11 fixture entries each); ~1000-3000 new eval-mutation tests pass; all 305 proof tests unaffected. All run in both node + jsdom.
10. **`expect(other).toBe(0)` regression gate in `corpus-eval.test.ts`** stays green.

---

*End of design spec.*
