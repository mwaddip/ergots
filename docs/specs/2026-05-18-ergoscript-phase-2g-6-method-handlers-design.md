# ErgoScript Interpreter — Phase 2g.6 Design Spec (Broader Method-Call Surface)

**Status:** Draft
**Date:** 2026-05-18
**Package:** `@ergots/ergoscript` (phase 2g.6 — 5 method handlers + 1 new `Expr` arm + 2 new `SValue` variants, extending the 2g.5 dispatcher)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella; 2g.6 row added by Task A on 2026-05-18 as mandatory)
**Sister specs:**
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` (immediate predecessor — `MethodCall`/`PropertyCall` dispatcher + 3 handlers + C2 corpus unlock; the dispatcher this slice extends)
- `docs/specs/2026-05-18-task-b-corpus-survey-results.md` (the survey that data-locked 2g.6's 5-method scope; the "Phase 2g.6 prioritization (clustered + tiered)" section is the authoritative scope source)

**Interface contract:** `facts/ergoscript.md` (extended additively in Task 8 of this slice)
**Brainstorm transcript:** session 2026-05-18 (post-Task-B; scope locked by survey data; per-method semantics source-locked by reading sigma-rust handlers directly)

## Goal

Ship phase 2g.6: the 5 method handlers locked by Task B's wider-mainnet corpus survey (12,712 boxes), plus the minimum supporting infrastructure required to register and consume them. By the end of this slice:

- **One new `Expr` arm** (51 → 52 of ~70): `Global`. The wire layer already parses this MIR variant (Task B's survey counted 120 boxes with the `Global` tag); 2g.6 adds the evaluator arm so trees containing `Expr::Global` no longer fail with `'not-implemented-yet'`.
- **Two new `SValue` kind variants**: `{ kind: 'Global' }` (sentinel) and `{ kind: 'PreHeader'; value: PreHeader }` (value carrier). Both mirror sigma-rust's `Value::Global` and `Value::PreHeader` respectively. Required so `SGlobal.*` and `SPreHeader.*` handlers can type-check their `obj`.
- **Five new method handlers** registered in `eval/method-call.ts` (extending the 2g.5 `HANDLERS` map):
  - `SGlobal.groupGenerator` (typeId 106, methodId 1) — cost 10 Pattern A; returns `GroupElement` (33-byte SEC1 of secp256k1 base point).
  - `SColl.zip` (typeId 12, methodId 29) — cost `addPerItemCost(10, 1, 10, n)` Pattern B; returns `Coll[(T1, T2)]`.
  - `SColl.indices` (typeId 12, methodId 14) — cost `addPerItemCost(20, 2, 16, n)` Pattern B; returns `Coll[Int]` = `0..n-1`.
  - `SContext.preHeader` (typeId 101, methodId 3) — cost 15 Pattern A; returns `PreHeader` (from `ctx.preHeader`).
  - `SPreHeader.timestamp` (typeId 105, methodId 3) — cost 10 Pattern A; returns `Long` (preheader.timestamp as i64).
- **Zero new `EvalError` codes** (43 → 43): defensive obj-shape mismatches reuse `'method-not-implemented'` per 2g.5's option 1; `SContext.preHeader` reuses the existing `'context-obj-not-context'` (this becomes the second handler to use it, validating the per-typeId-not-per-method choice from 2g.5); missing `ctx.preHeader` reuses existing `'context-field-missing'` (used today by `GlobalVars.{Outputs|SelfBox|Inputs}` for the same shape of failure).
- **Method-handler registry growth**: 3 → 8 entries.

Public function signatures (`evaluate`, `evaluateWith`, `makeContext`, `verifySignature`, `EvalError`) stay stable. `EvalOpts` is unchanged from 2g.5 (the `preHeader?: PreHeader` field already exists from phase 2f-medium). The new SValue variants are additive to the discriminated union but **type-system-breaking** for external `switch (v.kind)` consumers — acceptable for pre-v1.0.0 (the right kind of breakage to surface, per the 2g.5 spec's posture on the `Context` variant).

The slice is implemented as 8 sequential tasks in flat `PLAN.md` ordering. Commits between each task; no `Stop α/β/γ` markers (per [[feedback-no-artificial-stops]] memory).

## Background — Task B survey-driven scope

Task B (shipped 2026-05-18) widened the analysis corpus from 173 boxes (the prior C2 corpus) to 12,712 boxes (10,000 random recent-window + 2,712 must-include from 5 singleton regression blocks + a 50-block cost-parity range at height 700k). The survey produced a method-demand tally at `docs/specs/2026-05-18-task-b-corpus-survey-tally.json`, source-segmented to distinguish random demand from must-include regression coverage.

**Tier 1 — High demand (≥ 30 distinct boxes):**
- `SGlobal.groupGenerator` — **120 distinct boxes — top demand by far. NOT in the original handoff projection.**
- `SColl.zip` — 35 distinct boxes.

**Tier 2 — Moderate demand or must-include-relevant:**
- `SColl.indices` — 8 distinct boxes (all random).
- `SPreHeader.timestamp` — 7 distinct boxes (4 from must-include regression set).
- `SContext.preHeader` — 7 distinct boxes (4 from must-include regression set).

**Tier 3 — deferred to a future slice** (in survey but below thresholds): `SColl.flatten` (2 boxes; note: sigma-rust calls this `flatMap` — cosmetic discrepancy in `_known-methods.ts`), `SGroupElement.getEncoded` (1 box).

The handoff's original 2g.6 projection (broader method-call surface: Header methods, `Coll.zipWith`/`reverse`/`getOrElse`, BinOp Bit shifts) was ~50% wrong — most projected methods showed zero demand in the wider corpus. The survey data corrects the projection. The Tier 1 + Tier 2 scope (5 methods) is what this slice lands.

**Pre-1.0.0 sequencing principle** (per [[feedback-pre-v1-coverage-not-load-bearing]] memory): coverage-impact percentages do not drive phase sequencing pre-v1.0.0. The 2g.6 vs 2i sequencing question (2i has `DecodePoint`/`SubstConstants` at ~21% of boxes each, far higher than 2g.6's ~1%) was resolved by proceeding in umbrella-spec order. The Task B data scopes which methods land in 2g.6, not whether 2g.6 lands before 2i.

## Non-goals

- **Broader method surface beyond the 5.** Header methods, `Coll.zipWith` / `.reverse` / `.getOrElse`, BinOp Bit shifts via `SNumericTypeMethods`, additional `SBox`/`SContext`/`SGlobal` methods beyond Tier 1+2 — all deferred. Demand-driven re-survey if/when new mainnet activity surfaces. Tier 3 methods (`SColl.flatten`, `SGroupElement.getEncoded`) are also deferred for now; bundle into a "long-tail method micro-slice" if/when convenient.
- **AVL+ membership-proof verification + 5 `SAvlTree.*` methods.** Phase 2h (separate spec). 5 AVL+ method-pairs surfaced by Task B's survey are queued there.
- **Predef arms** (`DecodePoint`, `SubstConstants`, `CalcBlake2b256`, `ByteArrayToLong`, `LongToByteArray`, etc.). Phase 2i (separate spec). Higher-impact than originally anticipated per Task B's survey, but pre-v1.0.0 sequencing principle keeps 2g.6 first.
- **Real-context cost validation (Layer C3-cost).** Phase 2j.
- **`npm publish` of `@ergots/ergoscript@0.3.0`.** Separate user decision; orthogonal to this slice.
- **Layer C3.a mutation testing for the 5 handlers.** The C3.a framework is Coll-HOF-oriented (operator-driven boundary mutations). Method handlers have simple shapes that don't fit the operator-grid cleanly — same posture as 2g.5. C1 + C2 coverage is the discipline for this slice.
- **Enlarging the C2 corpus.** The 18-evaluable-trees regression gate stays as-is (the 5 new handlers don't unlock additional C2 entries on their own — that would require 2h or 2i co-landing). Re-evaluate C2-corpus growth after 2g.6 + 2h or 2g.6 + 2i.
- **Carryover cleanup from 2g.5** (unreachable `'scalar-out-of-range'`, unused `assertConsumed()`, unreachable `'cor-derived-challenge-mismatch'`/`'cthreshold-derived-challenge-mismatch'`, reserved `'conjecture-not-implemented'`). Independent micro-cleanup slice if/when.

## Architecture

### Directory layout (delta from 2g.5)

```
packages/ergoscript/src/
├── eval/
│   ├── eval.ts                                MODIFIED: 1 new case line ('Global')
│   ├── method-call.ts                         MODIFIED: 5 new HANDLERS entries + 2 new helper functions
│   └── global.ts                              NEW: Global arm (cost 5 Pattern A, returns { kind: 'Global' })
└── mir/
    └── types.ts                               MODIFIED: SValue union gains { kind: 'Global' } and { kind: 'PreHeader', value: PreHeader }

packages/ergoscript/test/
├── eval/
│   ├── global.test.ts                         NEW: C1 fixture for Global arm
│   ├── sglobal-group-generator.test.ts        NEW: C1 fixture for SGlobal.groupGenerator handler
│   ├── scoll-indices.test.ts                  NEW: C1 fixture for SColl.indices handler
│   ├── scoll-zip.test.ts                      NEW: C1 fixture for SColl.zip handler
│   ├── scontext-pre-header.test.ts            NEW: C1 fixture for SContext.preHeader handler
│   └── spreheader-timestamp.test.ts           NEW: C1 fixture for SPreHeader.timestamp handler
├── fixtures/eval/
│   ├── global.json                            NEW
│   ├── sglobal-group-generator.json           NEW
│   ├── scoll-indices.json                     NEW
│   ├── scoll-zip.json                         NEW
│   ├── scontext-pre-header.json               NEW
│   └── spreheader-timestamp.json              NEW
└── corpus-eval.test.ts                        UNCHANGED: 18-tree regression gate stays as-is

fixture-gen/src/cmds/ergoscript/eval/
├── global.rs                                  NEW
├── sglobal_group_generator.rs                 NEW
├── scoll_indices.rs                           NEW
├── scoll_zip.rs                               NEW
├── scontext_pre_header.rs                     NEW
└── spreheader_timestamp.rs                    NEW
fixture-gen/src/main.rs                        MODIFIED: 6 new generate_and_write calls
```

`eval/method-call.ts` keeps the inline-handler style from 2g.5 (registry + all 8 handlers in one file). At 8 handlers / ~250 lines projected, the file is still readable; promote to `eval/method-call/handlers/<typename>-<methodname>.ts` only if count grows beyond ~12.

### Per-method spec

Cost values, obj shapes, and return values are all source-locked. Cross-references point to the sigma-rust source where the spec is grounded.

| # | Method | typeId:methodId | Cost | Cost pattern | Obj shape | Args | Returns | Source |
|---|---|---|---|---|---|---|---|---|
| 1 | `SGlobal.groupGenerator` | 106:1 | 10 | **A** (charged before obj check) | `Value::Global` | none | `GroupElement` (33-byte SEC1) | `ergotree-interpreter/src/eval/sglobal.rs:32-41` |
| 2 | `SColl.zip` | 12:29 | `addPerItemCost(10, 1, 10, n)` | **B** (charged after Coll extraction; n = obj len) | `Value::Coll(elem=T1)` | 1 × `Value::Coll(elem=T2)` | `Coll[(T1, T2)]` | `ergotree-interpreter/src/eval/scoll.rs:138-169` |
| 3 | `SColl.indices` | 12:14 | `addPerItemCost(20, 2, 16, n)` | **B** (charged after Coll extraction; n = obj len) | `Value::Coll` | none | `Coll[Int]` = `0..n-1` (i32s) | `ergotree-interpreter/src/eval/scoll.rs:171-193` |
| 4 | `SContext.preHeader` | 101:3 | 15 | **A** (charged before obj check) | `Value::Context` | none | `PreHeader` (from `ctx.pre_header`) | `ergotree-interpreter/src/eval/scontext.rs:72-81` |
| 5 | `SPreHeader.timestamp` | 105:3 | 10 | **A** (charged before obj check) | `PreHeader` (via `try_extract_into`) | none | `Long` (preheader.timestamp as i64) | `ergotree-interpreter/src/eval/spreheader.rs:20-24` |

**Key source-driven facts (cross-checked with the 2026-05-18 source-read):**

- `SGlobal.groupGenerator`'s obj is `Value::Global`, NOT `Value::Context`. `Expr::Global` is a separate MIR variant from `Expr::Context`. Both arms produce sentinel SValues; the difference is cost (Global = 5, Context = 1) and the receiver type for downstream methods.
- `SColl.zip` derives the return-type element from the RUNTIME `obj.elem` and `arg.elem` via `STuple::pair(type_1, type_2)`. The MIR's `explicitTypeArgs` map is NOT consulted — no T-arg passthrough needed.
- `SColl.zip` truncates to the shorter Coll (Rust's `Iterator::zip` semantics). The TS hand-rolled loop must match — verified via a long-zip-short fixture sub-case in Task 4.
- `SColl.indices` overflows at `n > 2^31 - 1` in sigma-rust (`i32::try_from(i)?`). In practice unreachable (no transaction can contain such a Coll), but the symmetry is worth preserving — defensive throw with `'method-not-implemented'` (reused) on overflow.
- `SContext.preHeader` reads `ctx.pre_header.clone()` unconditionally (no Option). In TS, `ctx.preHeader` is `PreHeader | undefined`; if undefined, throw `'context-field-missing'` (existing code, used by `GlobalVars.{Outputs|SelfBox|Inputs}` for the same shape of failure).
- `SPreHeader.timestamp`'s `as i64` cast on `preheader.timestamp` (Rust `u64`) is a signed reinterpretation. In TS, `PreHeader.timestamp: bigint` already stores the value as a bigint; no conversion is needed for in-range timestamps. Fixture vector near `i64::MAX` validates boundary behavior.
- The existing `eval/_group-generator.ts` already defines `GROUP_GENERATOR_BYTES` (the 33-byte SEC1-compressed secp256k1 base point). `SGlobal.groupGenerator` handler reuses this constant directly — no `@noble/curves` round-trip needed (the bytes are a well-known constant; sigma-rust derives them from `k256::ProjectivePoint::GENERATOR` and we hardcode the equivalent). The `crypto/secp256k1.ts` adapter is unchanged by this slice.

### New `Expr` arm: `Global`

**Source:** `ergotree-interpreter/src/eval/expr.rs:37-40`:
```rust
Expr::Global => {
    ctx.add_jit_cost(5)?; // Global = Fixed(5)
    Ok(Value::Global)
}
```

**Implementation:** new file `eval/global.ts`:
```ts
import type { Global as GlobalExpr, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'

export function evalGlobal(_e: GlobalExpr, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(5) // Pattern A; source: expr.rs:38 "Global = Fixed(5)"
  return { kind: 'Global' }
}
```

Wired in `eval/eval.ts` as `case 'Global':` — directly parallels the existing `case 'Context':` from 2g.5.

### New `SValue` variants

Added additively to the discriminated union in `mir/types.ts:817-833`:

```ts
| { kind: 'Global' }                        // sentinel, no associated data
| { kind: 'PreHeader'; value: PreHeader }   // value carrier; PreHeader interface already exists at mir/types.ts:156
```

**`{ kind: 'Global' }`** mirrors `{ kind: 'Context' }` (sentinel pattern from 2g.5). Consumed by all `SGlobal.*` method handlers via `obj.kind === 'Global'` checks. The other `SGlobal.*` methods (`xor`, `serialize`, `deserialize`, `some`, `none`, `fromBigEndianBytes`, `powHit`, `encodeNBits`, `decodeNBits`) are not in 2g.6 scope, but adding the variant now keeps the future surface additive — when those land (probably 2i), no SValue churn needed.

**`{ kind: 'PreHeader'; value: PreHeader }`** mirrors `{ kind: 'Box'; value: ErgoBox }` (value-carrier pattern). The `PreHeader` interface is already defined at `mir/types.ts:156-…` with a `timestamp: bigint` field — `SPreHeader.timestamp` just reads `obj.value.timestamp`. Future `SPreHeader.*` methods (`version`, `parentId`, `nBits`, `height`, `minerPk`, `votes`) deferred but will register against the same variant without further SValue changes.

**Type-system implications.** Both variants are type-system-breaking for any external `switch (v.kind)` consumer that hits the default branch (TypeScript will surface a never-type error at compile time). For internal consumers within `packages/ergoscript/src/`, Task 1 (Global) and Task 5 (PreHeader) audit for `switch (v.kind)` patterns and add the cases where exhaustive. Acceptable for pre-v1.0.0 — the change shows up at compile time, which is the right kind of breakage to surface.

### Handler implementation patterns

The 5 handlers register in `eval/method-call.ts`'s `registerHandlers()` function below the existing 3 entries (`SBox.tokens`, `SContext.dataInputs`, `SColl.indexOf`). Each follows the 2g.5 inline-handler convention: keyed by `${typeId}:${methodId}` string, handler signature `(obj, args, ctx, explicitTypeArgs) => SValue`.

Cost-charging discipline per [[reference-cost-charging-order-patterns]]:

- **Pattern A handlers** (`SGlobal.groupGenerator`, `SContext.preHeader`, `SPreHeader.timestamp`): charge BEFORE the obj-shape check. The dispatcher already charged 4 (Pattern A) before evaluating obj; the handler adds its own per-method cost on entry.
- **Pattern B handlers** (`SColl.zip`, `SColl.indices`): charge AFTER extracting `obj.items.length` (Pattern B requires `n` to be available). The dispatcher's 4 + the per-item charge is the full cost.

**Helper module additions** (within `eval/method-call.ts` for compactness — no new helper files):
- `indicesCollOf(n: number): SValue` — builds `Coll[Int]` = `[{kind:'Int',value:0}, …, {kind:'Int',value:n-1}]` with `elem: SINT`.
- `zipCollsOf(coll1: SValue & {kind:'Coll'}, coll2: SValue & {kind:'Coll'}): SValue` — builds `Coll[STuple[T1, T2]]` truncating to the shorter input.

The existing `SLONG`, `SBOX`, `STUPLE_COLLBYTE_LONG` SType module-singletons get joined by `SINT: SType = { tag: 'SInt' }` for `indices`. The `STuple` for zip is built per-call from the runtime element types.

### Error taxonomy: 0 new codes

Final taxonomy after this slice: **43 EvalError codes (unchanged from 2g.5)**.

Defensive throw mapping per handler:

| Handler | Defensive case | EvalError code (reused) |
|---|---|---|
| `SGlobal.groupGenerator` | `obj.kind !== 'Global'` | `'method-not-implemented'` (option 1 from 2g.5) |
| `SColl.zip` | `obj.kind !== 'Coll'` | `'method-not-implemented'` |
| `SColl.zip` | `args.length !== 1` or `args[0].kind !== 'Coll'` | `'method-not-implemented'` |
| `SColl.indices` | `obj.kind !== 'Coll'` | `'method-not-implemented'` |
| `SColl.indices` | `n > 0x7fffffff` (overflow) | `'method-not-implemented'` (symmetry with sigma-rust's TryFromIntError throw) |
| `SContext.preHeader` | `obj.kind !== 'Context'` | `'context-obj-not-context'` (existing — used by SContext.dataInputs from 2g.5) |
| `SContext.preHeader` | `ctx.preHeader === undefined` | `'context-field-missing'` (existing — used by GlobalVars.{Outputs/SelfBox/Inputs}) |
| `SPreHeader.timestamp` | `obj.kind !== 'PreHeader'` | `'method-not-implemented'` |

The reuse of `'context-obj-not-context'` for `SContext.preHeader` validates the 2g.5 choice to code by per-typeId rather than per-method — the code naturally fits any `SContext.*` handler.

## Implementation tasks (flat, 8 tasks, per-task commits)

Each task is a complete red→green→refactor cycle with at least one C1 fixture per new behavior. No `Stop` markers between tasks. Per-task commits land green tests + facts/PLAN updates as needed. Source-read each handler at task-start time (per [[reference-source-first-discipline]]) to catch any drift between this spec and current sigma-rust HEAD.

1. **`{ kind: 'Global' }` SValue variant + `Expr::Global` eval arm + C1 fixture.**
   - Add `{ kind: 'Global' }` to `mir/types.ts` SValue union.
   - Audit `packages/ergoscript/src/` for exhaustive `switch (v.kind)` patterns; add the case where needed (likely just internal helpers).
   - Create `eval/global.ts` (`evalGlobal`, cost 5 Pattern A, returns the sentinel).
   - Wire `case 'Global':` in `eval/eval.ts`.
   - Fixture: simplest case, `Global` Expr → `{ kind: 'Global' }` SValue, cost = 5.
   - Layer C1 pass.

2. **`SGlobal.groupGenerator` handler (typeId 106, methodId 1) + C1 fixture.**
   - Register in `HANDLERS` map within `eval/method-call.ts`.
   - Pattern A cost 10 (charged before obj check).
   - Defensive `obj.kind !== 'Global'` → throw `'method-not-implemented'`.
   - Returns `{ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES }` (constant from `eval/_group-generator.ts`).
   - Fixture: `PropertyCall(Global, groupGenerator)` → expected GroupElement, cost = 4 (dispatcher) + 5 (Global arm) + 10 (handler) = 19.
   - Cross-validate value + cost against sigma-rust `try_eval_out` oracle at fixture-gen time.
   - Layer C1 pass.

3. **`SColl.indices` handler (typeId 12, methodId 14) + C1 fixture.**
   - Register in `HANDLERS`.
   - Pattern B cost `addPerItemCost(20, 2, 16, n)` AFTER Coll-extraction.
   - Defensive `obj.kind !== 'Coll'` → throw `'method-not-implemented'`.
   - Overflow guard: `if (n > 0x7fffffff) throw 'method-not-implemented'`.
   - Returns `Coll[Int]` via new `indicesCollOf(n)` helper.
   - Fixtures: empty Coll → empty result (cost = 4 + base 20); 3-elem Coll → `[0, 1, 2]` (cost = 4 + base 20 + per-chunk based on ceil(3/16)=1 chunks); cross-validate.
   - Layer C1 pass.

4. **`SColl.zip` handler (typeId 12, methodId 29) + C1 fixture.**
   - Register in `HANDLERS`.
   - Pattern B cost `addPerItemCost(10, 1, 10, n)` AFTER obj Coll-extraction (n = obj len, NOT min(obj, arg) — verify against source at task start).
   - Defensive `obj.kind !== 'Coll'`, `args.length !== 1`, `args[0].kind !== 'Coll'` → throw `'method-not-implemented'`.
   - Returns `Coll[STuple[obj.elem, arg.elem]]` via new `zipCollsOf(obj, arg)` helper; truncates to the shorter Coll (Rust `Iterator::zip` semantics).
   - Fixtures: empty-zip-empty, equal-length, short-zip-long, long-zip-short, mixed-type-element sub-cases.
   - Layer C1 pass.

5. **`{ kind: 'PreHeader', value: PreHeader }` SValue variant + audit consumers.**
   - Add variant to `mir/types.ts` SValue union.
   - Audit `packages/ergoscript/src/` for exhaustive `switch (v.kind)` patterns; add the case where needed.
   - No handler registered yet — this task introduces the type only, so Tasks 6 and 7 can register against it.

6. **`SContext.preHeader` handler (typeId 101, methodId 3) + C1 fixture.**
   - Register in `HANDLERS`.
   - Pattern A cost 15 (charged before obj check).
   - Defensive `obj.kind !== 'Context'` → reuse `'context-obj-not-context'` (existing).
   - Defensive `ctx.preHeader === undefined` → throw `'context-field-missing'` with field name `'preHeader'`.
   - Returns `{ kind: 'PreHeader', value: ctx.preHeader! }`.
   - Fixtures: preHeader present sub-case (`PropertyCall(Context, preHeader)` → wrapped PreHeader, cost = 4 (dispatcher) + 1 (Context arm) + 15 (handler) = 20); preHeader-undefined sub-case → `'context-field-missing'` throw.
   - Layer C1 pass.

7. **`SPreHeader.timestamp` handler (typeId 105, methodId 3) + C1 fixture.**
   - Register in `HANDLERS`.
   - Pattern A cost 10 (charged before obj check).
   - Defensive `obj.kind !== 'PreHeader'` → throw `'method-not-implemented'`.
   - Returns `{ kind: 'Long', value: obj.value.timestamp }` (timestamp already `bigint` in the PreHeader interface — no conversion).
   - Fixtures: chain `Context.preHeader.timestamp` → Long (cost = 4 (outer dispatcher) + 4 (inner dispatcher) + 1 (Context arm) + 15 (preHeader handler) + 10 (timestamp handler) = 34); mismatch sub-case (PropertyCall(Context, timestamp) — wrong receiver type) → throw `'method-not-implemented'`; boundary sub-case near `i64::MAX` to validate bigint passthrough.
   - Layer C1 pass.

8. **`facts/ergoscript.md` update + wider-corpus re-survey verification + final regression sweep.**
   - Update `facts/ergoscript.md`: coverage 51 → 52 arms; method handlers 3 → 8; 2 new SValue variants; cross-reference this spec.
   - Update umbrella spec (`docs/specs/2026-05-13-ergoscript-interpreter-design.md`): annotate phase 2g.6 row as ✅ COMPLETE.
   - Update `_known-methods.ts` to mark the 5 implemented methods `implemented: true`.
   - Re-run `npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts`; verify zero ❌ for the 5 methods in the tally JSON; commit the regenerated `task-b-corpus-survey-tally.json`.
   - Run full test suite under node + jsdom; confirm zero regressions; `npm test` and `npx tsc --noEmit` clean.
   - Run `cargo test` and `cargo run -p fixture-gen` (determinism check); confirm zero fixture diffs against committed.
   - Update `PLAN.md` status.

**Estimated total: 5-8h.** Mostly Sonnet-suitable per the 2g.5 pattern. Task 4 (`SColl.zip`) and Task 6 (`SContext.preHeader`) are the most likely to surface implementer-time questions; the rest are mechanical handler additions.

## Validation strategy

### Layer C1 — per-method fixtures

Every new handler gets at least one fixture asserting both value and cost against sigma-rust's `try_eval_out` oracle. Sub-cases per the per-task lists above.

Fixture file naming convention (consistent with 2g.5):
- `packages/ergoscript/test/fixtures/eval/global.json` — Global arm
- `packages/ergoscript/test/fixtures/eval/sglobal-group-generator.json`
- `packages/ergoscript/test/fixtures/eval/scoll-indices.json`
- `packages/ergoscript/test/fixtures/eval/scoll-zip.json`
- `packages/ergoscript/test/fixtures/eval/scontext-pre-header.json`
- `packages/ergoscript/test/fixtures/eval/spreheader-timestamp.json`

Each fixture is generated by a corresponding `fixture-gen/src/cmds/ergoscript/eval/<name>.rs` Rust file using the `try_eval_out` API gated behind sigma-rust's `arbitrary` feature (per [[reference-sigma-rust-eval-api]]).

### Layer C2 — corpus regression gate

The existing `corpus-eval.test.ts` `expect(evalSuccess).toBe(18)` hard gate stays as-is. The 5 new handlers do NOT unlock additional C2 entries on their own (the C2 corpus's gaps are in 2h AVL+ and 2i predef territory, not 2g.6 method-call territory). The gate is a regression check — if any 2g.6 change accidentally breaks one of the 18 trees, the slice does not ship.

### Wider-corpus re-survey gate (verification, not regression)

Task 8 re-runs `npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts`. Expected delta in the regenerated `task-b-corpus-survey-tally.json`:
- 5 methods flip from `implemented: false` → `implemented: true`.
- `unimplementedHits` for tag `Global` drops from 120 to 0 (the Global Expr arm is now wired).
- All other counts unchanged.

This is a verification gate (catches regressions in the analyzer or `_known-methods.ts` accounting), not a test gate (the analyzer is not part of the test suite).

### Layer C3.a — operator-driven mutation testing

**Deferred for this slice**, same posture as 2g.5. Method handlers don't fit the C3.a operator-grid cleanly.

### Parse-mutation testing

No new wire arms (Global / MethodCall / PropertyCall are all already wire-parsed from phase 2a). Existing 6221-flip parse-mutation suite covers them. Zero new work.

### Cross-runtime testing

Vitest under both `node` and `jsdom` environments. All new tests must pass under both — particularly important for `eval/global.ts` and the new method-call.ts entries (no `Buffer`, no `node:*` imports per the browser-first rule).

### Fixture-gen determinism

Two-run determinism check after each task that adds fixtures: build once, generate, build again, generate, diff. Expected: zero byte differences. Same standing pattern as all prior 2f/2g phases.

## Risks (minor)

### `SColl.zip` truncation semantics

Rust's `Iterator::zip` truncates to the shorter input (stops at the first iterator that returns `None`). JS `Array.prototype` doesn't have a native `zip`; the TS hand-rolled loop must match. Verification: a `long-zip-short` fixture sub-case in Task 4 — if the TS implementation iterates over the longer Coll, the fixture fails (extra Coll items in the output).

Mitigation: in the TS handler, iterate `i` from 0 to `Math.min(obj.items.length, args[0].items.length) - 1`.

### `SColl.indices` overflow guard

Sigma-rust uses `i32::try_from(i)?` for each index, throwing `TryFromIntError` if `i > 2^31 - 1`. In practice unreachable (transactions can't contain Colls that large given the 2 MB box-size limit), but the symmetry is worth preserving. The TS defensive throw guards on `n > 0x7fffffff` before the loop. Cost charge still applies (Pattern B cost is charged on the original `n`, not on the truncated count).

### `PreHeader.timestamp` boundary

Sigma-rust does `(preheader.timestamp as i64)` — a signed reinterpretation of u64. Our `PreHeader.timestamp: bigint` already stores the value as a bigint, and `{ kind: 'Long', value: bigint }` is the canonical Long shape. For in-range timestamps (sigma-rust's `u64` values that fit in `i64`, which covers all realistic timestamps until year 292 billion), the passthrough is identity.

The boundary fixture (`timestamp = 0x7fffffffffffffff`, near `i64::MAX`) validates the passthrough. If a future sigma-rust handler introduces a different behavior at the u64/i64 boundary (e.g., wrap-around), the cross-validation oracle catches it at fixture-gen time.

### Two new SValue variants are type-system-breaking for external consumers

Both `{ kind: 'Global' }` and `{ kind: 'PreHeader' }` show up as TypeScript exhaustiveness errors for any external `switch (v.kind)` consumer (e.g., future wallet package, downstream tooling). For internal consumers within `packages/ergoscript/src/`, Tasks 1 and 5 audit for `switch (v.kind)` patterns. Acceptable for pre-v1.0.0 — the break surfaces at compile time, which is the right kind of breakage. Document in the v0.3.0 changelog when published.

### Source drift between this spec's source-reads and current sigma-rust HEAD

The cost values (10, addPerItemCost(10,1,10,n), addPerItemCost(20,2,16,n), 15, 10) were source-read at brainstorm time (2026-05-18). The `fixture-gen` cross-validation gate catches any drift — if sigma-rust changes a cost value upstream, the regenerated fixture won't match our committed expectation and the test will fail at green time. Source-read each handler at task-start time per [[reference-source-first-discipline]].

## Open items (none blocking)

- **2g.5 carryover cleanup list** — out of scope per Non-goals; tracked in [[project-ergots-direction]] for a future micro-cleanup slice.
- **`SColl.flatten` vs `flatMap` cosmetic discrepancy** in `_known-methods.ts` (carryover from Task B) — Tier 3, deferred.
- **`npm publish @ergots/ergoscript@0.3.0`** — orthogonal release decision; ship before or after 2g.6 per user preference.
- **C2 corpus growth** — currently 18 trees; growing it requires co-landing 2h or 2i since 2g.6 alone doesn't unlock new entries. Revisit after 2g.6 + 2h.

## Cross-references

### Source (sigma-rust)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs:37-40` — `Expr::Global` arm (cost 5 Pattern A)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sglobal.rs:32-41` — `GROUP_GENERATOR_EVAL_FN` (cost 10 Pattern A; obj must be `Value::Global`)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:138-169` — `ZIP_EVAL_FN` (cost `add_per_item_jit_cost(10, 1, 10, n)` Pattern B)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:171-193` — `INDICES_EVAL_FN` (cost `add_per_item_jit_cost(20, 2, 16, input_len)` Pattern B)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scontext.rs:72-81` — `PRE_HEADER_EVAL_FN` (cost 15 Pattern A; obj must be `Value::Context`)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/spreheader.rs:20-24` — `TIMESTAMP_EVAL_FN` (cost 10 Pattern A; obj extracted as `PreHeader`)
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/sglobal.rs:49` — `GROUP_GENERATOR_METHOD` registration
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scoll.rs:103` — `ZIP_METHOD` registration
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scoll.rs:123` — `INDICES_METHOD` registration
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/scontext.rs:72` — `PRE_HEADER_PROPERTY` registration
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/spreheader.rs:63` — `TIMESTAMP_PROPERTY` registration

### Local (ergots)
- `packages/ergoscript/src/eval/method-call.ts` — existing dispatcher + 3 handlers (2g.5); 2g.6 extends `HANDLERS` registry by 5 entries
- `packages/ergoscript/src/eval/context.ts` — `Context` arm pattern reference (2g.5)
- `packages/ergoscript/src/eval/_group-generator.ts` — `GROUP_GENERATOR_BYTES` constant (already shipped; 2g.6 consumes it)
- `packages/ergoscript/src/eval/eval-context.ts` — `EvalContext` shape; `preHeader?: PreHeader` field already present from 2f-medium
- `packages/ergoscript/src/mir/types.ts:156` — existing `PreHeader` interface (no changes)
- `packages/ergoscript/src/mir/types.ts:817-833` — `SValue` discriminated union (extended by 2 variants in this slice)
- `packages/ergoscript/scripts/analyze-wider-corpus.ts` — re-survey verification gate (Task 8)
- `packages/ergoscript/scripts/_known-methods.ts` — `(typeId, methodId)` lookup; update 5 entries to `implemented: true` in Task 8

### Memories
- [[feedback-no-artificial-stops]] — flat task list discipline; no Stop α/β/γ markers
- [[feedback-pre-v1-coverage-not-load-bearing]] — coverage % does not drive phase sequencing pre-v1.0.0
- [[feedback-question-framing-first]] — challenge inherited framing (Task B proved this; survey corrected ~50% of the handoff's projection)
- [[feedback-pure-typescript-no-wasm]] — all-TS is project identity
- [[reference-source-first-discipline]] — read sigma-rust BEFORE writing TS; source-read each handler at task-start time
- [[reference-cost-charging-order-patterns]] — Pattern A (charge before) vs B (charge after); per-handler source-read
- [[reference-sigma-rust-eval-api]] — `try_eval_out` API gated by `arbitrary` feature in fixture-gen
- [[project-ergots-direction]] — phase plan + carryover items

### Sister specs
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec (post-Task-A edits)
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — immediate predecessor
- `docs/specs/2026-05-18-task-b-corpus-survey-results.md` — survey deliverable (authoritative scope source)
- `docs/specs/2026-05-18-task-b-corpus-survey-tally.json` — machine-readable demand counts; regenerated in Task 8
