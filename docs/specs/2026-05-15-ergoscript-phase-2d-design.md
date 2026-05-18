# ErgoScript Interpreter — Phase 2d (Slice A: numeric-poly unary arms) Design Spec

**Status:** Draft
**Date:** 2026-05-15
**Package:** `@ergots/ergoscript` (phase 2d, slice A — numeric-poly unary arms)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec)
**Sister specs:** `docs/specs/2026-05-14-ergoscript-phase-2b-design.md` (evaluator chassis + 8 arms), `docs/specs/2026-05-14-ergoscript-phase-2c-design.md` (operators slice 1)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-15 (post-2c)

## Goal

Ship the four unary numeric-polymorphism arms — `Negation`, `BitInversion`,
`Upcast`, `Downcast` — wired into the central exhaustive dispatch
established in phase 2b. By the end of slice A, real ErgoScript trees
that combine type coercions with arithmetic (e.g. a Long literal
downcast to Int before a comparison) evaluate against the sigma-rust
oracle byte-for-byte.

Concretely, four new evaluator arm modules plus a small refactor that
promotes two kind-aware numeric helpers from `bin-op/{arith,bit}.ts`
into the shared `_numeric.ts` introduced in phase 2c:

- `evalNegation` — unary numeric negate (`-x`), throws on `MIN_K`.
- `evalBitInversion` — unary bitwise complement (`~x`), no overflow
  path; masking back to the kind's signed range mirrors `bin-op/bit.ts`.
- `evalUpcast` — widen to a target numeric kind carried on the MIR node;
  no overflow.
- `evalDowncast` — narrow to a target numeric kind; throws
  `'downcast-overflow'` when the input value lies outside the target's
  signed range.

Public surface unchanged from v0.2.0 — slice A is purely additive
internal arm growth plus one new `EvalError` code
(`'downcast-overflow'`). No npm publish.

This slice is **slice A** of a two-slice split of the umbrella's
"phase 2d." Slice B (`Coll[Boolean]` aggregators `And`/`Or`/`Xor` over
`Coll[Boolean]` + `Atleast`) gets its own brainstorm and spec; deferring
it isolates the SigmaProp wire-construction question that `Atleast`
raises from the structurally-uniform numeric-poly work.

## Non-goals (slice A)

- **`Coll[Boolean]` aggregators.** Standalone `And`/`Or`/`Xor` arms over
  `Coll[Boolean]` (distinct from 2c's binary `BinOp.Logical` arms) —
  slice B.
- **`Atleast`.** k-of-n `SigmaProp` combinator. Carries
  wire-construction concerns for the opaque-bytes SigmaProp encoding
  (the threshold combinator has variable-length sub-propositions) —
  slice B.
- **Lambdas (`FuncValue`/`Apply`).** Phase 2e.
- **Box / Context / chain-state arms.** Phase 2f.
- **Collection HOFs (Map / Filter / Fold / Exists / ForAll / Slice /
  Append / ByIndex).** Phase 2g.
- **Sigma protocol prover + verifier (`@noble/curves`).** Phase 2h.
- **AVL+, predefs, real-context cost validation (Layer C3).** Later
  phases.
- **Eval-level mutation testing.** Phase 2a's 6221-flip parse-mutation
  suite remains in place. Eval mutation deferred — see Validation
  strategy.
- **`npm publish` of `@ergots/ergoscript@0.2.0`.** Separate user
  decision; not bundled with slice A.

## Architecture

### Directory layout

```
packages/ergoscript/src/eval/
├── eval.ts                  (existing — adds 4 new case lines)
├── negation.ts              NEW: evalNegation
├── bit-inversion.ts         NEW: evalBitInversion
├── upcast.ts                NEW: evalUpcast
├── downcast.ts              NEW: evalDowncast
└── bin-op/
    ├── _numeric.ts          MODIFIED: gains promoted checkRange + maskToKind
    ├── arith.ts             MODIFIED: re-imports checkRange from _numeric.ts
    └── bit.ts               MODIFIED: re-imports maskToKind from _numeric.ts
```

Each new arm is one exported function `eval<Variant>(e, env, ctx) =>
SValue`. The central `evalExpr` in `eval/eval.ts` gains four new `case`
lines: `Negation` → `evalNegation`, `BitInversion` → `evalBitInversion`,
`Upcast` → `evalUpcast`, `Downcast` → `evalDowncast`. The 56+ remaining
`Expr` variants still fall through to the `'not-implemented-yet'`
default. Adding a new `Expr` variant to `mir/types.ts` remains a
compile-time error in the central switch via `_exhaust: never`.

### Dispatch pattern

```ts
// eval/eval.ts (excerpt, additions in commentary)
export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
    // ... 11 arms from 2b + 2c ...
    case 'Negation':           return evalNegation(e, env, ctx)         // NEW
    case 'BitInversion':       return evalBitInversion(e, env, ctx)     // NEW
    case 'Upcast':             return evalUpcast(e, env, ctx)           // NEW
    case 'Downcast':           return evalDowncast(e, env, ctx)         // NEW
    // ... ~56 more arms across remaining phases
    default: { /* _exhaust: never + 'not-implemented-yet' throw */ }
  }
}
```

### Shared helpers — refactor

Two functions move into `_numeric.ts` so the new top-level arms don't
reach across into sub-arm modules:

- **`checkRange(value: bigint, kind: NumericKind, errorCode: string): void`**
  — moved from `bin-op/arith.ts`. Throws an `EvalError` with the
  supplied code if `value` lies outside the kind's signed range. 2c
  callers in `bin-op/arith.ts` pass `'arith-overflow'`; the new
  `downcast.ts` passes `'downcast-overflow'`.
- **`maskToKind(value: bigint, kind: NumericKind): bigint`** — moved
  from `bin-op/bit.ts`. Masks a bigint to the kind's signed range
  (sign-preserving two's-complement narrow). 2c callers in
  `bin-op/bit.ts` (BitAnd/Or/Xor) keep their behavior unchanged; the
  new `bit-inversion.ts` re-uses the helper.

Refactor correctness gate: every 2c fixture (1473 ergoscript tests)
must continue to pass byte-for-byte after the move. This is asserted
before any new arm work begins (PLAN Step 1).

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle
for every per-arm behaviour. The items below are the ones worth pinning
in the spec because they're load-bearing or easy to get wrong; for any
behaviour not noted here, sigma-rust source wins.

**Common skeleton.** All four arms follow the same five-step shape:
1. Charge envelope cost (order — before vs after child eval — is
   source-read per arm; see Open Questions).
2. Evaluate the unary child input.
3. Type-guard: throw `'bin-op-not-numeric'` if input kind isn't in
   `{Byte, Short, Int, Long, BigInt}` (precedent set by 2c's
   `LogicalNot` reusing `'bin-op-not-boolean'`).
4. Compute via `_numeric.ts` helpers (`valueToBigInt` → op → optional
   range/mask → `bigIntToValue`).
5. Return the resulting `SValue` with the appropriate kind (same as
   input for Negation/BitInversion; target kind from `e.tpe` for
   Upcast/Downcast).

**Negation.** Negate via bigint arithmetic, then `checkRange(negated,
child.kind, 'arith-overflow')`. The overflow case is `-MIN_K` for each
of `Byte/Short/Int/Long/BigInt` — the most-negative value's absolute
value exceeds the signed range. Mirrors sigma-rust's `checked_neg` (per
kind in the rust source, single bigint path in TS).

**BitInversion.** `~valueToBigInt(child)` in JS produces `-(n+1)`,
which is the unmasked two's-complement inverse. For fixed-width kinds
this lands outside the kind's signed range; `maskToKind` brings it
back. Result is `MAX_K` if input was `MIN_K`, `MIN_K` if input was
`MAX_K`, `-1` if input was `0`, etc. No overflow path: `~` is a
self-inverse on the bit pattern; the masked result is always
representable.

**Upcast.** Read target kind from `e.tpe.tag` (e.g. `'SInt'` → `'Int'`).
Compute `bigIntToValue(valueToBigInt(child), targetKind)`. No range
check needed — widening only loses no information when target is at
least as wide as source. Sigma-rust may or may not permit same-kind
Upcast as a no-op; **source-read at implementation to confirm**.

**Downcast.** Read target kind from `e.tpe.tag`. Compute
`valueToBigInt(child)`, then `checkRange(value, targetKind,
'downcast-overflow')` against the **target** kind (not the source). On
success, `bigIntToValue(value, targetKind)`. The error code is the
single new addition to v0.2.0's `EvalError` taxonomy.

**Wire-format note.** Phase 2a parser already round-trips all four MIR
variants on the corpus. `Upcast` and `Downcast` carry their target
SType explicitly on the wire (it's not derivable from the child's
`exprTpe`). `Negation` and `BitInversion` derive their result type from
the child's `exprTpe`. The parser is the boundary; eval-time arms trust
the wire-format invariants (per CLAUDE.md "validate at boundaries,
trust internal code").

## Validation strategy

Three-layer discipline, mirroring 2b/2c. Cost validation continues the
layered C1/C2/C3 strategy.

### Layer C1 — per-arm fixture-gen oracles

Four new fixture-gen Rust modules under `fixture-gen/src/cmds/ergoscript/eval/`:

- `negation.rs` — 5 happy entries (one per numeric kind) × 2 boundary
  values, 5 overflow entries (`-MIN_K` per kind), 1 non-numeric error
  entry, 1 cost-limit error entry. ≈ 12 entries.
- `bit_inversion.rs` — 5 kinds × 3 boundary values (`0`, `MAX_K`,
  `MIN_K`) + 1 non-numeric error. ≈ 16 entries.
- `upcast.rs` — all valid widening pairs (Byte → Short/Int/Long/BigInt;
  Short → Int/Long/BigInt; Int → Long/BigInt; Long → BigInt) × 2
  boundary values + 1 non-numeric. ≈ 21 entries.
- `downcast.rs` — narrowing pairs × happy + overflow each, + 1
  non-numeric. ≈ 18 entries.

Total: ~67 new C1 fixture entries. Each follows 2c's unified schema:
`{ name, tree_bytes_hex, opts_json, expected_value_json, expected_cost,
expected_error_code }`. Same `try_eval_out::<Value<'static>>` wedge via
the `arbitrary` feature on `ergotree-interpreter`. Determinism guarded
via `TestRunner::deterministic()` for any random-input synthesis.

TS test file per arm (`test/eval/negation.test.ts`, etc.) loads the
fixture, parses the tree, evaluates with the same opts, asserts
value-equality AND cost-equality against the captured oracle, or
`EvalError.code` equality on error entries via the `captureEvalError`
helper introduced in the 2c follow-up cleanup.

### Layer C2 — mainnet_boxes corpus growth

The existing `test/corpus-eval.test.ts` runs unchanged. With slice A's
arms wired, the evaluable subset may grow by some small number of
trees (those using only the now-15-supported variants). Expected
outcome: still `success=0 not-impl=18 other=0` — most mainnet trees
need higher-phase arms (Box accessors, GlobalVars, method calls) that
aren't in slice A's scope. The `expect(other).toBe(0)` regression gate
remains in place.

### Layer C3 — eval-level mutation testing (deferred)

The umbrella spec parks this at "phase 2c+ when there are enough arms".
Concrete decision for slice A: **skip eval mutation**, same reasoning as
phase 2c — eval-level mutations on already-parseable trees mostly
degrade to "value diff or typed throw" smoke tests with low
signal-to-noise; budget better invested at phase 2e (Box/Context model)
or 2f (collection HOFs whose structural recursion has bugs parse-time
mutation can't catch).

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. Slice A adds no new
browser-incompatible primitives — all `bigint` arithmetic + existing
mask/range helpers.

### Determinism gate

After the per-arm fixture-gen tasks land, `cd fixture-gen && cargo run
--release` runs twice in succession; the second invocation must
produce zero diff against the first (`git status` empty for fixtures
dir). Same gate that caught 2b's Task-16 non-determinism.

## Browser compatibility

Hard rules carried verbatim from 2a/2b/2c, no new exceptions:

- All `Uint8Array`. Never `Buffer`.
- No `node:*` outside test files.
- No `globalThis.crypto` or `node:crypto`.
- No WASM dependencies, direct or transitive.
- ESM only, ES2022 target.
- `bigint` for `SLong`/`SBigInt` and intermediate arithmetic.
- No top-level `await`.

Slice A adds no runtime dependencies. `@noble/curves` waits until phase
2h.

## Dependencies

Runtime: unchanged from 2a/2b/2c (`@noble/hashes` 2.2.0).

Dev: unchanged.

## Error taxonomy

One new code on the existing `EvalError` class. No new error class
shipped; same public surface as v0.2.0.

| Code | Throw site | Meaning |
|---|---|---|
| `'arith-overflow'` (reused) | `negation.ts` | `Negate(MIN_K)` — most-negative value's absolute value exceeds the signed range. Same code as 2c's BinOp.Arith overflow path. |
| `'downcast-overflow'` (**NEW**) | `downcast.ts` | Input value lies outside the target kind's signed range. Sigma-rust raises `ArithmeticException`; we surface as a distinct code so callers can dispatch on "downcast specifically failed" vs "addition specifically overflowed." |
| `'bin-op-not-numeric'` (reused) | all four arms | Input kind isn't in `{Byte, Short, Int, Long, BigInt}`. Precedent: 2c's `LogicalNot` reused `'bin-op-not-boolean'` for the same unary-arm posture. |
| `'cost-limit-exceeded'` (inherited) | `EvalContext.addCost` | Any arm's `addCost` overshoots the configured `jitCostLimit`. |

The new code is documented additively in `facts/ergoscript.md`'s v0.2.0
EvalError taxonomy section — no breaking changes to existing codes.

## Sequencing

Six subagent-driven tasks (same pattern as 2b/2c — fresh subagent per
task, two-stage review: spec compliance + code quality). Simplest-first
ordering so each task builds on prior infrastructure.

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 1 | Refactor: promote `checkRange` + `maskToKind` to `_numeric.ts` | — | Move two functions from `bin-op/{arith,bit}.ts`. `checkRange` gains a third parameter (error code string). 2c fixtures must still pass byte-for-byte. Single commit, narrow diff. |
| 2 | `BitInversion` arm + fixture | `eval/bit_inversion.rs` | Simplest: no overflow, same kind out, uses `maskToKind` from refactored `_numeric.ts`. Establishes the per-arm template for the slice. |
| 3 | `Negation` arm + fixture | `eval/negation.rs` | Introduces overflow via refactored `checkRange(_, _, 'arith-overflow')`. Same kind out. 5-kind `MIN_K` overflow fixtures. |
| 4 | `Upcast` arm + fixture | `eval/upcast.rs` | Introduces target-kind extraction from `e.tpe`. No overflow. Different kind out. Source-read resolves "same-kind Upcast permitted?" question. |
| 5 | `Downcast` arm + fixture | `eval/downcast.rs` | Combines target-kind + overflow. `'downcast-overflow'` error code lands here. |
| 6 | Layer C2 corpus re-run + `facts/ergoscript.md` update + final review + commit-and-push | — | Run `corpus-eval.test.ts`; confirm `other === 0` stays green. Update `facts/ergoscript.md` v0.2.0 EvalError taxonomy with `'downcast-overflow'`. Bump "Coverage after 2X" line from "11 of ~70" to "15 of ~70." Update `MEMORY.md`'s `project_ergots_direction` with phase 2d-A state. Push to origin/master. |

6 tasks vs phase 2c's 10 — smaller because there's no central
dispatcher and the per-arm work is more uniform. Estimated wall clock:
~3 hours.

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | Split "phase 2d" into slices A + B; A = numeric-poly four arms. | Single 8-arm slice combining numeric-poly + Coll[Boolean] aggregators + `Atleast`. | Numeric-poly is structurally uniform and shares `_numeric.ts`. `Atleast` raises a SigmaProp wire-construction question worth its own brainstorm. Smaller slice = cleaner PLAN.md. |
| 2 | Overflow error codes: one new `'downcast-overflow'`; reuse `'arith-overflow'` for Negation. | Two new codes (`'downcast-overflow'` + `'negate-overflow'`); zero new codes (fold into `'arith-overflow'`); rename existing code. | Downcast carries a target SType the caller may want to dispatch on — cleanly distinguishable case. Negation overflow has no programmatic discriminating power vs other arith overflow. |
| 3 | Non-numeric input: reuse `'bin-op-not-numeric'`. | Introduce `'operand-not-numeric'`; rename existing code (breaking). | Phase 2c's `LogicalNot` (also unary) set the precedent of reusing `'bin-op-not-boolean'`. Renaming v0.2.0 surface would be breaking. |
| 4 | Promote `checkRange` from `bin-op/arith.ts` to `_numeric.ts`; gain third parameter (error code). | Keep in `arith.ts` with cross-module import; duplicate in `downcast.ts`. | Top-level arms shouldn't reach into sub-arm modules. `_numeric.ts` is the home for kind-aware numeric helpers. Refactor cost ≈ 10 LOC moved. |
| 5 | Promote `maskToKind` alongside `checkRange` in same Step-1 refactor. | Defer to `BitInversion` task; inline in `bit-inversion.ts`. | Same reasoning as `checkRange`. Folding into one refactor task keeps the slice diff coherent. |
| 6 | Cost-charging order source-read per arm at implementation time. | Pre-state `Fixed(N)` placeholders in PLAN; resolve at code-review. | Phase 2c lesson — every plan-stated cost value was wrong. Source-first is load-bearing. |
| 7 | Four separate `.ts` files (one per arm). | Cluster into two files; one combined file. | Matches 2c's per-arm precedent (`logical-not.ts`, `bool-to-sigma-prop.ts`). |
| 8 | Layer C3 eval mutation testing: still deferred. | Add per-arm mutation suite. | Same reasoning as 2c — budget better invested at phase 2e/2f where structural recursion has uncatchable bugs at parse time. |
| 9 | Inline per-arm cost constants with source-line citations; no `unaryNumericCost()` helper. | Shared cost-lookup helper in `_numeric.ts`. | Matches 2c's per-arm pattern. Helper obscures source-line citations. |
| 10 | 6 tasks: refactor → BitInversion → Negation → Upcast → Downcast → finalize. | 5 tasks (fold finalize into arm 4); 8 tasks (split refactor or add review gates). | Simplest-first builds complexity incrementally. Finalize as its own task isolates corpus re-run + facts/MEMORY updates + push. |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Refactor breaks 2c byte-equality on existing fixtures | PLAN Step 1 explicitly asserts "2c fixtures pass byte-for-byte after the move" as the gate. Two-stage review on the refactor task checks the assertion. |
| Cost values copied incorrectly from sigma-rust | Per-arm comment cites `eval/<file>.rs:LINE`. C1 fixture-gen captures and asserts per-arm cost from day one — same gate that caught 2c's relation-ordering bug. |
| Cost-charging order wrong for one or more arms | Source-read mandated at each arm's implementation. C1 fixture's cost-equality assertion locks whichever order is correct. |
| `maskToKind` correctness across 5 kinds (especially BigInt's 256-bit width) | Per-kind boundary fixtures (`0`, `MAX_K`, `MIN_K`) for BitInversion catch off-by-one mask errors. BigInt entries explicitly exercise the 256-bit path. |
| Same-kind Upcast/Downcast semantics unclear from MIR shape alone | PLAN Step 4 (Upcast) and Step 5 (Downcast) flag "source-read same-kind behaviour" as an explicit sub-step. Sigma-rust may treat it as a no-op or reject; the C1 fixture captures whichever it does. |
| Adding new Expr variant to `mir/types.ts` without an eval arm | Compile-time error from `_exhaust: never` in central switch — same exhaustiveness pattern as 2a's `wire/parse.ts`. |
| Subagent dispatch misses a review finding | Two-stage review (spec compliance + code quality) per task — pattern proven across 2b's 18 tasks and 2c's 10 tasks. |

## Open questions

1. **Cost-charging order per arm.** Unary arms could plausibly charge
   envelope before OR after eval-child. Sigma-rust's `LogicalNot` and
   `If` charge before; `BinOp` charges after-left-before-right. Resolves
   at implementation via source-read; C1 fixture cost-equality is the
   gate.

2. **Same-kind `Upcast` / `Downcast`** (e.g. `Upcast(Int → Int)`).
   Sigma-rust may permit this as a no-op or reject at `try_build`.
   Resolves at implementation via source-read; C1 fixture captures the
   actual behaviour.

3. **Cost values per arm.** Likely `Fixed(N)` literals per arm in
   sigma-rust source. The 2c lesson is that plan-stated placeholders
   were wrong on every arm — values are NOT pre-stated in this spec.

None are blockers. All resolve via source-read at the relevant
implementation task. The umbrella's TDD discipline catches anything
that drifts from the source.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella
  phase plan (2a–2j)
- `docs/specs/2026-05-14-ergoscript-phase-2c-design.md` — phase 2c
  focused design (operators slice 1)
- `docs/specs/2026-05-14-ergoscript-phase-2b-design.md` — phase 2b
  focused design (evaluator chassis + 8 arms)
- `facts/ergoscript.md` — boundary contract, extended additively per
  phase
- `facts/nipopow.md` — sister contract for the proof package
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`,
  HEAD `ed5452cf`) — byte-format and implementation oracle. Slice A
  authoritative refs:
  - `ergotree-interpreter/src/eval/negation.rs`
  - `ergotree-interpreter/src/eval/bit_inversion.rs`
  - `ergotree-interpreter/src/eval/upcast.rs`
  - `ergotree-interpreter/src/eval/downcast.rs`
  - `ergotree-interpreter/src/eval/costs.rs` (per-arm cost values)
  - `ergotree-ir/src/mir/{negation,bit_inversion,upcast,downcast}.rs`
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical
  language specification (per-arm semantics, range rules)
