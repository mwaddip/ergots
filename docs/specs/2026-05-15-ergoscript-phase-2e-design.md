# ErgoScript Interpreter — Phase 2e (Narrow: Lambdas + treeVersion + XorOf + V3 gating revisit) Design Spec

**Status:** Draft
**Date:** 2026-05-15
**Package:** `@ergots/ergoscript` (phase 2e — narrow scope: lambdas + treeVersion plumbing + XorOf + deferred-revisit)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec)
**Sister specs:** `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` (slice B — established the deferred-variant tracking pattern); `docs/specs/2026-05-15-ergoscript-phase-2d-design.md` (slice A — where the V3 gating divergence originated)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-15 (post-2d-B)

## Goal

Ship phase 2e narrow: three new evaluator arms (`FuncValue`, `Apply`,
`XorOf`), plumb `treeVersion` through `EvalOpts`/`EvalContext` as a new
optional field, and revisit the V3 gating divergence captured in slice
A's deferred memory (Upcast/Downcast BigInt branches now throw a new
`'tree-version-too-low'` code at `ctx.treeVersion < V3`).

By the end of phase 2e:

- **Coverage goes 17 → 20 of ~70 `Expr` arms** (8 from 2b + 3 from 2c +
  4 from 2d-A + 2 from 2d-B + 3 from 2e: `FuncValue`, `Apply`, `XorOf`).
- **Public surface gains one optional field:** `EvalOpts.treeVersion?:
  number`. `evaluate(tree, opts)` auto-derives `ctx.treeVersion =
  opts.treeVersion ?? tree.header.version`. `evaluateWith(tree, ctx)`
  requires the caller to set it explicitly; arms reading
  `ctx.treeVersion` default to V0 when `undefined`.
- **One new `EvalError` code:** `'tree-version-too-low'` (Upcast/Downcast
  BigInt branches at `ctx.treeVersion < 3`). Plus two arm-specific codes
  introduced by Apply: `'apply-non-lambda'` and `'apply-arity-mismatch'`.
- **Two existing-arm behavior changes** (Upcast + Downcast): the
  deferred V3 gating revisit. Behavior at V0/V1/V2 changes from
  permissive (silently accepts BigInt branches) to upstream-matching
  (throws `'tree-version-too-low'`). C2 corpus is unaffected — the 18
  evaluable mainnet trees don't exercise these branches.
- **Three deferred-variant memories close out:** all three originally-
  deferred items (Upcast V3, Downcast V3, XorOf) are implemented in this
  slice. The `project_treeversion_gating_deferred` memory repurposes
  into a policy memory for future arms with tree-version-dependent
  semantics; the originally-deferred-items checklist is done.

## Non-goals (phase 2e narrow)

- **Chain-state Box/Context arms.** 7 Box-extract arms (`ExtractAmount`,
  `ExtractRegisterAs`, `ExtractBytes`, `ExtractBytesWithNoRef`,
  `ExtractScriptBytes`, `ExtractCreationInfo`, `ExtractId`) + `GlobalVars`
  + `GetVar` + Option family (`OptionGet` / `OptionIsDefined` /
  `OptionGetOrElse`) + `SelectField` + byte-array conversions + hash
  predefs (Blake2b256, Sha256, DecodePoint) + `SubstConstants` — phase
  2f or later. Not bundled per the narrow-scope decision.
- **Collection HOFs** (`Map` / `Filter` / `Fold` / `Exists` / `ForAll` /
  `Slice` / `Append` / `ByIndex` / `Size`) — phase 2f or 2g.
- **Method/property call dispatch** (`MethodCall`, `PropertyCall`) — the
  infrastructure for typed-value method invocation on Box / Header /
  PreHeader / Coll / etc. is phase 2g+.
- **`SigmaAnd` / `SigmaOr` / `Atleast`.** Three sigma-protocol
  combinators deferred from slice B; still land in phase 2g (sigma
  protocol prover/verifier work). Untouched by 2e. Tracking memory
  `project_sigma_combinators_deferred` stays in place.
- **`Xor` (byte-array).** Deferred from slice B; still land later
  (likely 2g alongside Coll HOFs or standalone byte-ops slice).
- **Sigma protocol primitives (`@noble/curves`).** Phase 2g.
- **AVL+, real-context cost validation (Layer C3), npm publish.** Later.
- **Eval-level mutation testing.** Phase 2a's 6221-flip parse-mutation
  suite remains in place. Same deferral reasoning as 2c/2d-A/2d-B.

## Architecture

### Directory layout

```
packages/ergoscript/src/eval/
├── eval.ts                  (existing — adds 3 new case lines)
├── eval-context.ts          MODIFIED: adds `treeVersion?: number` to EvalOpts/EvalContext
├── evaluate.ts              MODIFIED: auto-derive ctx.treeVersion from tree.header.version in evaluate()
├── upcast.ts                MODIFIED: V3 gating check on BigInt branches; throws 'tree-version-too-low'
├── downcast.ts              MODIFIED: V3 gating check on BigInt branches; throws 'tree-version-too-low'
├── func-value.ts            NEW: evalFuncValue
├── apply.ts                 NEW: evalApply
└── xor-of.ts                NEW: evalXorOf (V0/V1 vs V2+ branch)
```

Each new arm is one exported function `eval<Variant>(e, env, ctx) =>
SValue`. Central `evalExpr` in `eval.ts` gains three new `case` lines:
`FuncValue` → `evalFuncValue`, `Apply` → `evalApply`, `XorOf` →
`evalXorOf`. The remaining ~50 `Expr` variants still fall through to the
`'not-implemented-yet'` default.

### `EvalOpts` / `EvalContext` extension (additive)

```ts
export interface EvalOpts {
  jitCostLimit?: number
  constants?: SValue[]
  treeVersion?: number      // NEW — 0..7 per the TreeHeader.version range; default in arm reads is 0
  // Phase 2f+ adds: height?, selfBox?, inputs?, outputs?, dataInputs?, preHeader?, headers?, extension?, vars?
}

export interface EvalContext extends EvalOpts {
  jitCost: number
  addCost(amount: number): void
  addPerItemCost(base: number, perChunk: number, chunkSize: number, nItems: number): void
}
```

### `evaluate()` defaulting

```ts
export function evaluate(tree: ErgoTree, opts: EvalOpts = {}): SValue {
  const ctx = makeContext({
    ...opts,
    constants: opts.constants ?? tree.constants,
    treeVersion: opts.treeVersion ?? tree.header.version,   // NEW
  })
  return evalExpr(tree.body, Env.empty(), ctx)
}
```

`evaluateWith(tree, ctx)` remains unchanged in signature — callers who
construct their own context are responsible for setting
`ctx.treeVersion` (and any other chain-state fields as those land in
later phases). Arms reading `ctx.treeVersion` use `ctx.treeVersion ?? 0`
(V0 default; most-restrictive).

### Lambda runtime shape — already exists

`mir/types.ts:127` defines `Closure` (carries `args: { id: ValId; tpe:
SType }[]` + `body: Expr`). `SValue.kind: 'Lambda'` (line 226) carries
`{ kind: 'Lambda'; closure: Closure }`. Phase 2e doesn't add new types —
just the eval arms that produce/consume the existing shape.

### Dispatch pattern (lambdas)

`FuncValue` evaluates eagerly to a `Lambda` SValue **without** evaluating
the body — charges `Fixed(5)` cost, packages the closure. `Apply`
evaluates the func to a `Lambda`, evaluates all args eagerly (charging
their costs), then extends the env via immutable `extend(id, value)` for
each (arg-id, arg-value) pair, then evaluates the body in the extended
env. The TS pattern is cleaner than sigma-rust's mutable save/restore
(which is a borrow-checker workaround) — our `Env` is already immutable
per phase 2b.

### No shared helpers, no refactor

The V3-gating check is a ~3-line inline guard in `upcast.ts` and
`downcast.ts`. YAGNI per slice A/B precedent — promote when a third
caller appears (unlikely; the V3 gating is specific to numeric
narrowing/widening on BigInt).

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle.
Items worth being explicit about:

**`FuncValue`** (`mir/func_value.rs:54`, `eval/func_value.rs:10-18`).
Input: `Expr.tag === 'FuncValue'` with `args: { id: ValId; tpe: SType
}[]` and `body: Expr`. Result: `SValue.kind === 'Lambda'` carrying
`closure: { args, body }`. No body evaluation at this point — lazy.
Cost: `Fixed(5)` per `eval/func_value.rs:12`. Charged BEFORE returning
the Lambda (the only "work" the arm does is the cost charge + struct
allocation).

**`Apply`** (`mir/apply.rs`, `eval/apply.rs:12-56`). Input: `Expr.tag
=== 'Apply'` with `func: Expr` and `args: Expr[]`. Cost: `Fixed(30)` per
`eval/apply.rs:18`. Charged BEFORE eval-func. Sequence:

1. Charge `Fixed(30)`.
2. Eval `e.func` — must produce `SValue.kind === 'Lambda'`. Anything
   else throws `'apply-non-lambda'`.
3. **Arity check**: `closure.args.length === e.args.length` — throw
   `'apply-arity-mismatch'` if not (placed BEFORE arg-eval; pure
   structural check). Sigma-rust's `apply.rs:30` zip-truncates silently;
   our defensive check matches the Iron Law of fail-fast.
4. Eval each arg expression in `e.args` in order (each charges its own
   costs into the current `ctx`).
5. Construct the body's env by immutable-extending the current `env`
   with each `(closure.args[i].id, args[i])` pair. The TS Env's
   immutability means no save/restore step; the extended env is
   discarded after body eval, and the caller's env is unchanged.
6. Eval `closure.body` in the new env. Return the result.

Result is identical to sigma-rust's behavior modulo the mechanism (their
mutable save/restore vs our immutable extend).

**`XorOf`** (`mir/xor_of.rs`, `eval/xor_of.rs:12-36`). Input:
`Expr.tag === 'XorOf'` with `input: Expr` (must evaluate to
`Coll[Boolean]`). Cost: `addPerItemCost(20, 5, 32, n)` per
`eval/xor_of.rs:20`. Charged AFTER eval-child (Cast pattern, same as
slice B's `And` / `Or`). Eval sequence:

1. Eval `e.input`. Kind-check: throw `'coll-not-boolean'` (reused from
   slice B) on non-Coll or wrong-elem-kind.
2. Charge `addPerItemCost(20, 5, 32, n)` where `n = items.length`.
3. Branch on `ctx.treeVersion ?? 0`:
   - **V0/V1 (< V2):** Walk the items; track `hasTrue` and `hasFalse`
     flags; short-circuit when both seen. Return `Boolean = hasTrue
     && hasFalse`. JVM v4.x bug behavior.
   - **V2+ (>= V2):** Return `Boolean = items.reduce((a, b) => a !== b,
     false)` (left-fold XOR; true iff odd count of trues).

Cost is identical regardless of branch — only the reducer differs.

**Upcast / Downcast V3 gating revisit** (`eval/upcast.rs:80`,
`eval/downcast.rs:119`). Both arms gain an early-exit check on the
target kind (and source kind for Downcast, per source-read at impl):

```ts
// upcast.ts — after eval-child, before the cast
if (targetKind === 'BigInt' && (ctx.treeVersion ?? 0) < 3) {
  throw new EvalError(
    `Upcast: BigInt target requires tree version >= V3, got ${ctx.treeVersion ?? 0}`,
    'tree-version-too-low'
  )
}

// downcast.ts — after eval-child, before the narrow
if ((sourceKind === 'BigInt' || targetKind === 'BigInt')
    && (ctx.treeVersion ?? 0) < 3) {
  throw new EvalError(
    `Downcast: BigInt branch requires tree version >= V3, got ${ctx.treeVersion ?? 0}`,
    'tree-version-too-low'
  )
}
```

Source-read at Task 1 confirms whether sigma-rust's Downcast gates on
target-only or both source-and-target. The C1 fixture's value/error
assertion locks the correct behavior. The cost still charges per the
arm's existing rule (Cast pattern; AFTER eval-child). Order: eval child
(child's costs charged) → V3 gate check → cost charge → cast. The gate
throwing produces a partial cost-charged state (just the child cost);
fixtures use `expected_cost: 0` sentinel on error paths (existing slice
2d-A precedent).

## Validation strategy

Same three-layer discipline as 2c/2d-A/2d-B. Cost validation continues
the C1/C2/C3 strategy.

### Layer C1 — per-arm fixture-gen oracles

**Three new fixture-gen Rust modules** under
`fixture-gen/src/cmds/ergoscript/eval/`:

- `apply.rs` — bundles FuncValue + Apply (Lambda values aren't directly
  comparable; sigma-rust's `apply.rs` tests follow the same pattern).
  Coverage: identity lambda `((x: Int) => x)(42) → 42`; param shadowing
  `((x: Int) => { let x = 99; x })(1) → 99`; free-variable lookup
  against outer val-def; multi-arg lambdas; cost-limit at the Apply
  boundary. ~10 entries.
- `xor_of.rs` — same shape as slice B's `and.rs` / `or.rs` but with
  `tree_version` in `opts_json`. Coverage: empty Coll at V0/V1/V2/V3
  (all branches return `false` for empty); single-item; mixed cases
  that produce DIFFERENT results at V0/V1 vs V2+ (especially
  `[true, true, false]` → V0: true; V2+: false — the smoking-gun case
  from sigma-rust's xor_of.rs tests); n=32/33 chunk boundary at one
  version; cost-limit. ~15 entries.
- No fixture-gen module for `FuncValue` standalone — Lambda values
  aren't directly serializable via the existing `value_to_json` helper.
  The construction-only test (assert SValue.kind === 'Lambda' with
  correct closure structure) is an inline TS test.

**Two modified fixture-gen Rust modules** for the V3 gating revisit:

- `upcast.rs` — existing 21 entries gain an explicit `tree_version`
  field per `opts_json` (most stay at the value that `force_any_val
  <Context>` produces today; check at Task 1 to confirm). NEW entries:
  BigInt-target widening pairs × V0/V1/V2 expecting
  `'tree-version-too-low'`. ~4 new entries (Byte→BigInt at V0,
  Short→BigInt at V1, Int→BigInt at V2, Long→BigInt at V2).
- `downcast.rs` — same pattern. NEW entries: BigInt-source narrowing
  pairs × V0/V1/V2 expecting `'tree-version-too-low'`. ~4 new entries.
  Plus V3 happy paths get explicit `tree_version: 3` in opts_json.

**Inline TS tests** (no fixture file needed):

- `FuncValue` arm test in `test/eval/func-value.test.ts`: construct a
  `FuncValue` MIR node by hand, eval it, assert `SValue.kind ===
  'Lambda'` and closure structure matches input. ~1 test.
- `Apply` defensive tests in `test/eval/apply.test.ts`: non-Lambda func
  throws `'apply-non-lambda'` (e.g., `Apply(Const(42), [arg])`); arity
  mismatch throws `'apply-arity-mismatch'`. ~2 inline tests + the C1
  fixture-driven loop for value+cost.
- `XorOf` defensive tests in `test/eval/xor-of.test.ts`: non-Coll input
  throws `'coll-not-boolean'`; Coll with non-Boolean items throws
  `'coll-not-boolean'` (mirroring slice B's And/Or pattern). ~2 inline
  tests.

**Total new fixture entries:** ~25 (Apply 10 + XorOf 15) + ~8 modified
(Upcast 4 + Downcast 4) + ~5 inline TS tests = ~38 new test cases.
Brings ergoscript suite from 1566 → ~1604.

Each entry follows the unified schema established in 2b: `{ name,
tree_bytes_hex, opts_json, expected_value_json, expected_cost,
expected_error_code? }`. Same `try_eval_out::<Value<'static>>` wedge via
the `arbitrary` feature on `ergotree-interpreter`. Determinism via
`TestRunner::deterministic()` for any random-input synthesis.

### Layer C2 — mainnet_boxes corpus

The existing `test/corpus-eval.test.ts` runs unchanged. **Expected
outcome: still `success=0 not-impl=18 other=0`** — the 18 evaluable
mainnet trees use higher-phase variants (Box accessors, method calls,
Coll HOFs) that the three new arms don't unlock in isolation. The V3
gating revisit on Upcast/Downcast changes behavior only for trees that
exercise BigInt branches, which the corpus doesn't.

### Layer C3 — eval mutation testing (deferred)

Phase 2a's 6221-flip parse-mutation suite remains. Same reasoning as
2c/2d-A/2d-B — budget better invested at the chain-state phase
(Box/Context structural error surface) or HOFs (recursive structure has
uncatchable parse-time bugs).

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. Slice 2e adds no new
browser-incompatible primitives — Env extension is already immutable
and pure-JS; bigint arithmetic via existing `_numeric.ts` helpers; no
`Buffer` / `node:*` / WASM in the new code.

### Determinism gate

After fixture-gen lands the new entries, `cd fixture-gen && cargo run
--release` runs twice in succession; second invocation produces zero
diff. Same gate as prior slices.

## Browser compatibility

Hard rules carried verbatim from 2a/2b/2c/2d-A/2d-B, no new exceptions:

- All `Uint8Array`. Never `Buffer`.
- No `node:*` outside test files.
- No `globalThis.crypto` or `node:crypto`.
- No WASM dependencies, direct or transitive.
- ESM only, ES2022 target.
- `bigint` for `SLong` / `SBigInt` and intermediate arithmetic (BigInt
  branches of Upcast/Downcast already use this from 2d-A).
- No top-level `await`.

Slice 2e adds no runtime dependencies. `@noble/curves` waits until 2g.

## Dependencies

Runtime: unchanged from prior slices (`@noble/hashes` 2.2.0).

Dev: unchanged.

## Error taxonomy

Three new codes on the existing `EvalError` class. No new error class;
public surface unchanged.

| Code | Throw site | Meaning |
|---|---|---|
| `'tree-version-too-low'` (**NEW**) | `upcast.ts`, `downcast.ts` | Upcast/Downcast attempted a BigInt branch (target=BigInt for Upcast; source=BigInt or target=BigInt for Downcast, per source-read at impl) at `ctx.treeVersion < 3`. Mirrors sigma-rust's eval-time V3 gating per `eval/upcast.rs:80` / `eval/downcast.rs:119`. Message includes the arm name, the offending version, and the BigInt side (source/target) involved. |
| `'apply-non-lambda'` (**NEW**) | `apply.ts` | `Apply.func` evaluated to an `SValue` whose `kind !== 'Lambda'`. Sigma-rust raises `EvalError::UnexpectedValue` at `eval/apply.rs:50`; we surface as a typed code for cleaner programmatic dispatch. Message includes the actual kind. |
| `'apply-arity-mismatch'` (**NEW**) | `apply.ts` | `Apply.args.length !== Apply.func.closure.args.length`. Sigma-rust's `apply.rs:30` zip-iterates and silently truncates; we add an explicit defensive check (Iron Law of fail-fast). Placed BEFORE arg-eval (pure structural check). Message includes expected vs actual arg count. |
| `'cost-limit-exceeded'` (inherited) | `EvalContext.addCost` / `.addPerItemCost` | Composite charge overshot `jitCostLimit`. Inherits from 2b. |
| `'coll-not-boolean'` (inherited from 2d-B) | `xor-of.ts` | Reused for the kind-check on XorOf's input (same defensive posture as And/Or). |

Total `EvalError` codes after slice 2e: **19** (was 16 after slice
2d-B; +3 from this slice). Documented additively in
`facts/ergoscript.md`'s v0.2.0 EvalError taxonomy section. No breaking
changes to existing codes.

## Sequencing

Per-arm execution with two-stage review (spec compliance + code
quality) per task. Same pattern as 2c (10 tasks), 2d-A (6 tasks), 2d-B
(3 tasks). Slice 2e is 4 tasks.

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 1 | `treeVersion` plumbing + Upcast/Downcast V3 gating revisit | `eval/upcast.rs:80`, `eval/downcast.rs:119`, `chain/context.rs:44-71` | Add `treeVersion?: number` to `EvalOpts` / `EvalContext`. Modify `evaluate()` to auto-derive `ctx.treeVersion = opts.treeVersion ?? tree.header.version`. Modify `upcast.ts` / `downcast.ts` to throw `'tree-version-too-low'` on BigInt branches at V<3. Modify `fixture-gen/src/cmds/ergoscript/eval/upcast.rs` / `downcast.rs` to set explicit `tree_version` in each entry's `opts_json`; add 4+4 new V0/V1/V2 entries expecting the new error code. Modify `test/eval/upcast.test.ts` / `downcast.test.ts` to pass `opts.treeVersion` from the fixture into `makeContext`. Introduces 1 new EvalError code. Largest task — infrastructure + 2 modified arms + 2 modified fixture sets. ~1.5 hours. |
| 2 | `FuncValue` arm + inline test | `mir/func_value.rs`, `eval/func_value.rs` | Smallest of the three new arms. Trivial: charge `Fixed(5)`, return `{ kind: 'Lambda', closure: { args, body } }` from the existing MIR shape. No fixture file (Lambda values don't round-trip through `value_to_json`); one inline TS test constructing a `FuncValue` MIR node and asserting `SValue.kind === 'Lambda'` + closure structure. ~30 min. |
| 3 | `Apply` arm + C1 fixture + inline defensive tests | `mir/apply.rs`, `eval/apply.rs:12-56` | The lambda application core. Cost `Fixed(30)` BEFORE eval-func; eval func + check kind + arity check (BEFORE arg-eval); eval args; immutable Env extend; eval body; return. Two new EvalError codes (`'apply-non-lambda'`, `'apply-arity-mismatch'`). C1 fixture (~10 entries: identity, shadowing, free-variable, multi-arg, cost-limit) + 2 inline defensive tests. ~1 hour. |
| 4 | `XorOf` arm + C1 fixture + finalize (corpus + facts + memories + commit + orchestrator-confirmed push) | `mir/xor_of.rs`, `eval/xor_of.rs:12-36` | The treeVersion-consuming arm. Mirror of slice B's And/Or with version-branched reducer. Uses `ctx.treeVersion ?? 0` to discriminate V0/V1 (JVM v4.x bug) vs V2+ (correct XOR). C1 fixture (~15 entries spanning both branches; the `[true, true, false]` smoking-gun case appears at both V0 and V2+ asserting opposite results) + 2 inline defensive tests for `'coll-not-boolean'`. **Finalize** in same task: corpus re-run; `facts/ergoscript.md` updates (new error codes + 2e block + remove XorOf from "Does NOT ship yet"); close out `project_treeversion_gating_deferred` memory's originally-deferred items (repurpose as policy memory per § Decision log); update `project_ergots_direction`; update `MEMORY.md`; update `SESSION_CONTEXT.md`; commit + orchestrator-confirmed push. ~1 hour. |

4 tasks vs slice B's 3 vs slice A's 6. Estimated wall clock: ~3-4 hours
total. Per-arm task structure preserves the cadence that's been
working.

The PLAN.md (overwritten at the start of slice 2e, same pattern as
slice B overwriting slice A) holds these four tasks in detail. The spec
is the why; the PLAN is the how.

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | Phase 2e scope: lambdas + treeVersion plumbing + XorOf + V3 revisit. Chain-state Box/Context arms deferred to phase 2f. | Broader 2e covering all chain-state arms (10-15 hour multi-session slice); medium 2e adding GlobalVars + GetVar; 2e narrow without XorOf. | Narrow scope matches the 2-4 hour cadence we've been maintaining. Bundling chain-state in 2e would repeat slice B's misframing where five things got bundled and we split anyway. The deferred work (V3 revisit, XorOf) naturally lands with the treeVersion plumbing — pre-paying the infrastructure is wasteful if the immediate consumer isn't bundled. |
| 2 | Include `XorOf` in 2e. | Defer to phase 2f or later; restrict 2e to just the infrastructure + V3 revisit. | XorOf is the cleanest treeVersion consumer (purely additive new arm; no behavior change to existing arms). Validates the plumbing end-to-end against actual semantics drift, not just defensive gating. Coverage advance 17 → 20 vs 17 → 19 is a meaningful step. |
| 3 | V3 gating: match sigma-rust exactly with new error code `'tree-version-too-low'`. | Keep current permissive behavior, document divergence permanently; reuse `'arith-overflow'` (less informative). | Whole point of plumbing `treeVersion` is to match upstream. Staying permissive defeats the purpose. New code cleanly distinguishes "feature gated by version" from other arith errors. Minor taxonomy growth (one code) vs the value of accurate error semantics. |
| 4 | `EvalOpts` shape: add only `treeVersion?` now. Other chain-state fields land in 2f/2g as additive optional properties. | Stub full chain-state shape now per umbrella's "design once" discipline. | Per-arm types (ErgoBox, Header, PreHeader) need their TS shapes resolved when their arms land. Pre-stubbing property names without proper types is shallow. Adding optional fields incrementally doesn't introduce breaking changes — umbrella's concern was renames/reshapes, not additions. |
| 5 | `treeVersion` defaulting: `evaluate(tree, opts)` auto-derives from `tree.header.version`. `evaluateWith(tree, ctx)` requires explicit setting. Arms read `ctx.treeVersion ?? 0` (V0 default; most-restrictive). | Always require explicit; default to V3 (most permissive); reject if missing. | Matches `constants` defaulting precedent. V0 default at arm-read is the safest fallback (rejects more). Power users via `evaluateWith` retain control. |
| 6 | `'apply-arity-mismatch'` defensive check; place BEFORE arg-eval. | Follow sigma-rust's zip-truncate (silent); place AFTER arg-eval (matches sigma-rust's structural position). | Iron Law of fail-fast: arity is a pure structural property; check before doing arg-eval work. Sigma-rust's zip-truncate produces subtle bugs (under-supplied → `'val-use-unbound'` later; over-supplied → silent argument drop). Explicit check is more informative. |
| 7 | Apply env semantics: immutable extend (no save/restore). | Mirror sigma-rust's mutable save/restore. | Our `Env` is already immutable per phase 2b; the extended env is naturally discarded after body eval. Save/restore is a Rust borrow-checker workaround that doesn't apply to TS. Result is identical. |
| 8 | 4-task sequencing (Approach A). | 5 tasks (split plumbing from V3 revisit); 3 tasks (compressed; biggest task includes XorOf in Task 1). | Task 1 bundles plumbing + immediate consumer revisit — the natural validation gate. Lambdas split per-arm (matches 2c/2d-A cadence). XorOf rides with finalize (small + atomic). 4 tasks ≈ 3-4 hours total. |
| 9 | Repurpose `project_treeversion_gating_deferred` memory as a policy memory at finalize. | Delete entirely (no residual value); convert to changelog-style closed note. | Future arms with tree-version-dependent semantics benefit from a discoverable policy ("check `ctx.treeVersion`; throw `'tree-version-too-low'` for unmet preconditions"). Discipline outlives the original three deferred items. |
| 10 | Layer C3 eval mutation testing: still deferred. | Add per-arm mutation suite. | Same reasoning as 2c/2d-A/2d-B — budget better invested at phase 2f (chain-state structural error surface). |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `fixture-gen`'s `force_any_val<Context>` returns an unpredictable `tree_version` default; existing Upcast/Downcast fixtures may implicitly depend on V3 | Task 1 explicitly sets `tree_version` per entry. C1 cost-equality re-runs confirm old + new entries pass cleanly. |
| Cost-charging-order ambiguity at V3 gate (eval-child charges before throw; cast cost doesn't) | Test fixtures use `expected_cost: 0` sentinel on error paths (existing slice 2d-A precedent). TS test handler already skips cost assertions on error paths. |
| Lambda SValue not serializable via `value_to_json` | FuncValue gets inline-only tests (no JSON fixture). Apply fixtures bundle FuncValue + Apply where the eval result IS serializable (Boolean / Int / etc.). |
| Apply env semantics drift from sigma-rust's mutable save/restore | Apply C1 fixtures include a "free-variable lookup against outer val-def" entry — locks the semantics. Body-eval against the immutable-extended env must produce identical SValue + cost as sigma-rust's mutable mechanism. |
| Apply arity-mismatch decision (defensive vs follow-sigma-rust) | PLAN explicitly cites the design decision (defensive check, new code `'apply-arity-mismatch'`). Spec-compliance reviewer verifies the implementer didn't silently drop the check. |
| Wire-format invariants for FuncValue body parsing | Phase 2a's parser already handles `val_def_type_store` insertion for `FuncValue.args`. Task 2 re-verifies. |
| Determinism regression in fixture-gen | Two-run md5sum check per task (same gate as prior slices). |
| Test count drift (1566 → ~1604) | Finalize task updates the expected count in `SESSION_CONTEXT.md` and the commit message. |
| Subagent missing the spec's design decisions | Two-stage review per task (spec compliance + code quality). Both reviewers read the relevant spec section + the PLAN's task section. |
| Closing out `project_treeversion_gating_deferred` memory at finalize | Repurpose as policy memory per Decision log #9. Future-arm guidance preserved. |
| Forgetting to update `'Does NOT ship yet'` section to remove XorOf | Finalize task explicitly removes the XorOf entry. Spec-compliance reviewer verifies. The 4 remaining deferred variants (Xor byte-array, Atleast, SigmaAnd, SigmaOr) stay listed. |
| Memory `[[name]]` cross-references becoming dangling | If `project_treeversion_gating_deferred` gets renamed in the repurpose, any cross-references in OTHER memories (`project_sigma_combinators_deferred`, `project_ergots_direction`) get updated as part of the finalize task. The reviewer verifies no dangling links. |

## Open questions

All small; none are blockers; all resolve via source-read or
fixture-driven TDD at implementation time.

1. **V3 gate scope on Downcast: source-only, target-only, or both?**
   Sigma-rust's `eval/downcast.rs:119` requires source-read at Task 1 to
   confirm. C1 fixtures lock the correct behavior either way.

2. **V3 gate placement relative to cost charge.** Sigma-rust's
   eval-child charges BEFORE the gate; the gate throws BEFORE the cast
   cost is charged. Partial cost-charged state on throw is captured via
   the `expected_cost: 0` sentinel.

3. **`'apply-arity-mismatch'` check placement** — confirmed pre-arg-eval
   (Decision #6). Implementer follows this.

4. **`force_any_val<Context>` default `tree_version`** — source-read at
   Task 1 to confirm what version the existing Upcast/Downcast fixtures
   were generated against. If it defaults to V0, the existing fixtures
   for BigInt branches may have been silently generated WITHOUT
   exercising those branches (sigma-rust would have thrown). Our
   permissive TS would have succeeded — explaining the original
   divergence captured in the deferred memory.

5. **`project_treeversion_gating_deferred` rename at finalize.** Per
   Decision #9 the memory repurposes as a policy memory. The new
   filename / `name:` slug — keep current `project_treeversion_gating_deferred`
   (description updated to reflect policy nature) or rename to something
   more policy-explicit like `project_treeversion_gating_policy`?
   Lean toward keeping the current name to avoid breaking
   `MEMORY.md` index churn; description and body capture the policy
   nature.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella
  phase plan (2a–2j)
- `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` — slice
  B (sister; established deferred-variant tracking pattern)
- `docs/specs/2026-05-15-ergoscript-phase-2d-design.md` — slice A (where
  the V3 gating divergence originated)
- `docs/specs/2026-05-14-ergoscript-phase-2c-design.md` — phase 2c (the
  original `EvalOpts` / `EvalContext` design that's now being extended)
- `facts/ergoscript.md` — boundary contract, extended additively per
  phase
- `facts/nipopow.md` — sister contract for the proof package
- `CLAUDE.md` — TDD discipline, browser-first rules,
  confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`,
  HEAD `ed5452cf`) — byte-format and implementation oracle. Phase 2e
  authoritative refs:
  - `ergotree-interpreter/src/eval/func_value.rs` — FuncValue impl
    (Fixed(5), lazy body)
  - `ergotree-interpreter/src/eval/apply.rs` — Apply impl (Fixed(30),
    env save/restore)
  - `ergotree-interpreter/src/eval/xor_of.rs` — XorOf impl (V0/V1 vs
    V2+ branch at line 25)
  - `ergotree-interpreter/src/eval/upcast.rs:80` — V3 gating on BigInt
    target
  - `ergotree-interpreter/src/eval/downcast.rs:119` — V3 gating on
    BigInt source/target
  - `ergotree-ir/src/chain/context.rs:44-71` — Context struct +
    `tree_version()` accessor
  - `ergotree-ir/src/mir/{func_value,apply,xor_of}.rs` — MIR shapes
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical
  language specification (per-arm semantics, version-gating rules)
- Memories at finalize:
  - `project_treeversion_gating_deferred.md` — repurposed as a policy
    memory (Decision #9); originally-deferred-items list closed out
  - `project_sigma_combinators_deferred.md` — untouched
    (Atleast/SigmaAnd/SigmaOr still pending phase 2g)
  - `project_ergots_direction.md` — updated to phase 2e done; next is
    phase 2f (chain-state Box/Context arms)
