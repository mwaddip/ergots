# ErgoScript Interpreter — Phase 2d (Slice B: Coll[Boolean] aggregators) Design Spec

**Status:** Draft
**Date:** 2026-05-15
**Package:** `@mwaddip/ergots-ergoscript` (phase 2d, slice B — Coll[Boolean] aggregators)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec)
**Sister specs:** `docs/specs/2026-05-15-ergoscript-phase-2d-design.md` (slice A — numeric-poly unary arms), `docs/specs/2026-05-14-ergoscript-phase-2c-design.md` (operators slice 1)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-15 (post-2d-A)

## Goal

Ship the two unary `Coll[Boolean]` aggregator arms — `And` and `Or` — wired
into the central exhaustive dispatch established in phase 2b. By the end of
slice B, real ErgoScript trees that aggregate boolean collections evaluate
against the sigma-rust oracle byte-for-byte (matching value AND cost).

Concretely, two new evaluator arm modules:

- `evalAnd` — unary all-true reducer over a `Coll[Boolean]`; returns `true`
  on empty (vacuous truth).
- `evalOr` — unary any-true reducer over a `Coll[Boolean]`; returns `false`
  on empty (identity-of-Or).

Public surface unchanged from v0.2.0 — slice B is purely additive internal
arm growth plus one new `EvalError` code (`'coll-not-boolean'`). No npm
publish bundled.

This slice is **slice B** of a two-slice split of the umbrella's "phase 2d."
Slice A (Negation / BitInversion / Upcast / Downcast) shipped 2026-05-15 at
commit `9dca501`. Slice B's universe was originally framed in the handoff as
"`Coll[Boolean]` aggregators (And/Or/Xor) + Atleast"; source-read at brainstorm
revealed two corrections worth recording up front:

1. **`Xor`** (opcode 43) is byte-array XOR over two `Coll[Byte]` exprs
   returning `Coll[Byte]`, NOT a `Coll[Boolean]` aggregator. The actual
   `Coll[Boolean]` XOR aggregator is **`XorOf`** (opcode 143).
2. **`XorOf`** has tree-version-dependent semantics: V0/V1 implements the
   JVM v4.x bug (true iff Coll contains both true and false, count-
   and order-independent); V2+ uses correct left-fold XOR. Requires
   `treeVersion` on `EvalContext`, which lands in phase 2e.

Slice B therefore narrows to the two version-agnostic boolean aggregators
that land cleanly today. `XorOf`, `Xor` (byte-array), `Atleast`, `SigmaAnd`,
and `SigmaOr` are deferred — see § Deferred variants for the three-mechanism
tracking that ensures they're picked up at the right phase.

## Non-goals (slice B)

- **`XorOf`.** Third `Coll[Boolean]` aggregator. V0/V1 ≠ V2+ semantics;
  needs `treeVersion` on `EvalContext`. Phase 2e.
- **`Xor` (byte-array).** Operates on `Coll[Byte] × Coll[Byte]`, not
  booleans. Not part of the boolean-aggregator family despite the name
  confusion. Later phase (likely alongside Coll HOFs in phase 2g, or
  standalone).
- **`Atleast`, `SigmaAnd`, `SigmaOr`.** Sigma-protocol-level combinators.
  Call into sigma-rust's `Cthreshold::reduce` / `Cand::normalized` /
  `Cor::normalized` which perform structural simplification on the
  SigmaBoolean tree. Cleaner to land after `SigmaBoolean` becomes a
  discriminated union in phase 2g.
- **Lambdas (`FuncValue`/`Apply`).** Phase 2e.
- **Box / Context / chain-state arms.** Phase 2f.
- **Collection HOFs (`Map` / `Filter` / `Fold` / `Exists` / `ForAll` /
  `Slice` / `Append` / `ByIndex`).** Phase 2g.
- **Sigma protocol prover + verifier (`@noble/curves`).** Phase 2g.
- **AVL+, predefs, real-context cost validation (Layer C3).** Later
  phases.
- **Eval-level mutation testing.** Phase 2a's 6221-flip parse-mutation
  suite remains in place. Eval mutation deferred — see § Validation
  strategy.
- **`npm publish` of `@mwaddip/ergots-ergoscript@0.2.0`.** Separate user
  decision; not bundled with slice B.

## Architecture

### Directory layout

```
packages/ergoscript/src/eval/
├── eval.ts          (existing — adds 2 new case lines)
├── and.ts           NEW: evalAnd
└── or.ts            NEW: evalOr
```

Each new arm is one exported function `eval<Variant>(e, env, ctx) =>
SValue`. The central `evalExpr` in `eval/eval.ts` gains two new `case`
lines: `And` → `evalAnd`, `Or` → `evalOr`. The remaining ~53 `Expr`
variants still fall through to the `'not-implemented-yet'` default.
Adding a new `Expr` variant to `mir/types.ts` remains a compile-time error
in the central switch via `_exhaust: never`.

### Dispatch pattern

```ts
// eval/eval.ts (excerpt, additions in commentary)
export function evalExpr(e: Expr, env: Env, ctx: EvalContext): SValue {
  switch (e.tag) {
    // ... 15 arms from 2b + 2c + 2d-A ...
    case 'And':   return evalAnd(e, env, ctx)     // NEW
    case 'Or':    return evalOr(e, env, ctx)      // NEW
    // ... ~53 more arms across remaining phases
    default: { /* _exhaust: never + 'not-implemented-yet' throw */ }
  }
}
```

### No shared helpers, no refactor

The kind-check (`'coll-not-boolean'` throw) is inlined in both `and.ts` and
`or.ts` — ~5 LOC each. YAGNI promotion to a `_coll.ts` waits for the third
caller (`XorOf` / `ForAll` / `Exists` in later phases). Matches slice A's
`sTypeToNumericKind` posture: intentional duplication with a code comment
acknowledging it. The third caller, when it arrives, justifies the promotion.

### Per-arm dispatch shape

Both arms follow an identical four-step shape:

1. Evaluate the unary child (`e.input`) via `evalExpr`.
2. Type-guard: throw `'coll-not-boolean'` if the resulting value isn't a
   `Coll` with all-`Boolean` items. Single linear pass over `items`.
3. Charge cost via `ctx.addPerItemCost(base, perChunk, chunkSize, n)` —
   values copied per-arm from sigma-rust at the pinned rev.
4. Reduce the boolean array (`every` for And, `some` for Or) and return
   `{ kind: 'Boolean', value }`.

Step 3 happens **after** step 1, matching sigma-rust's order (eval input
→ cost-charge → reduce) in `eval/and.rs:17-20` and `eval/or.rs:17-20`.
The C1 fixture's cost-equality assertion is the gate.

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle.
Items worth being explicit about:

**`And`** (`mir/and.rs:17-29`, `eval/and.rs:11-22`). Input: `Expr` with
`post_eval_tpe == Coll[Boolean]`. Result: `Boolean = items.all(b => b)`.
Empty-Coll case returns `true` (vacuous truth — matches JS
`Array.prototype.every` and Rust `iter().all`). No short-circuit at the
Coll level — sigma-rust evaluates the entire input collection up-front
via `self.input.eval(env, ctx)`, then folds. (The short-circuit in 2c's
`BinOp.Logical.And` is across two `Expr` operands; that's a different
mechanism.) Cost: `add_per_item_jit_cost(base=10, perChunk=5,
chunkSize=32, n=items.length)` per `eval/and.rs:19`. Charged AFTER
eval-child.

**`Or`** (`mir/or.rs:14-26`, `eval/or.rs:11-22`). Same shape as And.
Result: `Boolean = items.any(b => b)`. Empty-Coll case returns `false`
(identity-of-Or — matches JS `some` and Rust `iter().any`). Cost:
`add_per_item_jit_cost(base=5, perChunk=5, chunkSize=64,
n=items.length)` per `eval/or.rs:19`. Charged AFTER eval-child. Note the
cost values differ between the two arms (And uses base=10/chunk=32, Or
uses base=5/chunk=64) — don't assume parity at PLAN time, the C1
fixtures lock the per-arm values.

**`'coll-not-boolean'` failure path.** The defensive kind-check runs
after the input eval succeeds. The throw fires when:

- `input.kind !== 'Coll'`, OR
- `input.kind === 'Coll'` but `input.items` contains any element whose
  `kind !== 'Boolean'`.

The check is a single linear pass; for a clean `Coll[Boolean]` input,
it's O(n) but the cost is dominated by the subsequent reduce. Wire-format
invariants (sigma-rust `mir/and.rs:24-26` / `mir/or.rs:22-24` enforce
`post_eval_tpe == Coll[Boolean]` at parse time) mean this throw should be
unreachable for parser-produced trees — it's a defense against
`ConstantPlaceholder` injection and future MIR shape changes, matching
2c's defensive-recheck posture.

**Cost-charging order: after eval-child** for both arms. Sigma-rust evals
the input first (line 17 of each file) and then charges cost based on the
resulting collection length (line 19). This is the "depends on the data"
Cast pattern from 2d-A's Upcast/Downcast, not the "envelope-only"
LogicalNot pattern from 2c. The C1 fixture's cost-equality assertion locks
this.

**Wire-format invariants** (held by phase 2a's parser, trusted by eval):
`And.input.post_eval_tpe == Coll[Boolean]`, `Or.input.post_eval_tpe ==
Coll[Boolean]`. Result type for both is `SBoolean`.

## Validation strategy

Three-layer discipline, mirroring 2b/2c/2d-A.

### Layer C1 — per-arm fixture-gen oracles

Two new fixture-gen Rust modules under
`fixture-gen/src/cmds/ergoscript/eval/`:

- `and.rs` — entries covering: empty `Coll[Boolean]` (vacuous-truth
  case, n=0); single-item `[true]` / `[false]`; all-true at varied
  lengths; all-false at varied lengths; mixed with one false (And
  short-fail); n=32 (exactly one chunk per `chunkSize=32`); n=33 (one
  full + one partial chunk, locks the chunking math at the boundary);
  one cost-limit fixture overshooting `jitCostLimit`. ≈10 entries.
- `or.rs` — same structure: empty (returns false); single-item;
  all-true / all-false at varied lengths; mixed with one true (Or
  short-success); n=64 (one chunk per `chunkSize=64`); n=65 (boundary);
  cost-limit. ≈10 entries.

Total: ~20 new C1 fixture entries. Each follows 2c's unified schema:
`{ name, tree_bytes_hex, opts_json, expected_value_json, expected_cost,
expected_error_code? }`. Same `try_eval_out::<Value<'static>>` wedge via
the `arbitrary` feature on `ergotree-interpreter`. Determinism via
`TestRunner::deterministic()` for any random-input synthesis.

The `'coll-not-boolean'` error path can't be triggered via sigma-rust
because `And::new` / `Or::new` enforce `post_eval_tpe == Coll[Boolean]`
at construction time, so `try_build` rejects malformed inputs. **Fall
back to inline TS tests with hand-built MIR nodes** (LogicalNot / 2d-A
precedent): construct an `And` node whose `.input` is e.g. `Const(SInt,
5)` directly in TS, assert the throw. ~2 inline tests per arm = 4 total
inline error tests.

TS test files (`test/eval/and.test.ts`, `test/eval/or.test.ts`) load the
fixtures, parse each tree, evaluate with the supplied opts, assert
value-equality AND cost-equality against the captured oracle, or
`EvalError.code` equality on error entries via the `captureEvalError`
helper. Uses the shared `hexToBytes` / `hydrateSValue` from
`test/_helpers/index.ts` (already in place).

### Layer C2 — mainnet_boxes corpus

The existing `test/corpus-eval.test.ts` runs unchanged. **Expected
outcome: still `success=0 not-impl=18 other=0`** — the 18 evaluable
mainnet trees use higher-phase variants (Box accessors, GlobalVars,
method calls, Coll HOFs) that `And`/`Or` in isolation don't unlock. The
`expect(other).toBe(0)` regression gate stays green.

### Layer C3 — eval mutation testing (deferred)

Phase 2a's 6221-flip parse-mutation suite remains the load-bearing
mutation defense. Same reasoning as 2c/2d-A — budget better invested at
phase 2e (Box/Context model adds substantial structural error surface)
or 2g (Coll HOFs whose recursion has uncatchable parse-time bugs).
Revisit at phase 2e/2f kickoff brainstorm.

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. Slice B adds no new
browser-incompatible primitives — JS `Array.prototype.every` /
`Array.prototype.some` plus the existing kind-check pattern.

### Determinism gate

After fixture-gen lands the new entries, `cd fixture-gen && cargo run
--release` runs twice in succession; the second invocation must produce
zero diff against the first (`git status` empty for fixtures dir). Same
gate that caught 2b's Task-16 non-determinism.

## Browser compatibility

Hard rules carried verbatim from 2a/2b/2c/2d-A, no new exceptions:

- All `Uint8Array`. Never `Buffer`.
- No `node:*` outside test files.
- No `globalThis.crypto` or `node:crypto`.
- No WASM dependencies, direct or transitive.
- ESM only, ES2022 target.
- `bigint` for `SLong`/`SBigInt` (not exercised by slice B but
  available).
- No top-level `await`.

Slice B adds no runtime dependencies. `@noble/curves` waits until phase
2g.

## Dependencies

Runtime: unchanged from 2a/2b/2c/2d-A (`@noble/hashes` 2.2.0).

Dev: unchanged.

## Error taxonomy

One new code on the existing `EvalError` class. No new error class; same
public surface as v0.2.0.

| Code | Throw site | Meaning |
|---|---|---|
| `'coll-not-boolean'` (**NEW**) | `and.ts`, `or.ts` | Input value isn't `Coll[Boolean]` — either not a `Coll`, or `Coll` items contain a non-`Boolean` kind. Wire-format invariants make this unreachable for parser-produced trees; defensive against `ConstantPlaceholder` injection and future MIR shape changes. Message includes the input's actual kind (and for Coll inputs, the offending item index + its kind). |
| `'cost-limit-exceeded'` (inherited) | `EvalContext.addPerItemCost` | Composite charge overshot the configured `jitCostLimit`. Inherits from 2b. |

Total `EvalError` codes after slice B: **16** (was 15 after 2d-A).
Documented additively in `facts/ergoscript.md`'s v0.2.0 EvalError
taxonomy section. No breaking changes to existing codes.

## Deferred variants

Five logical/threshold/SigmaProp variants from the slice B-adjacent
universe are explicitly deferred. Each is tracked in three places so it
can't slip:

| Variant | Deferred to | Trigger | Why deferred |
|---|---|---|---|
| `XorOf` | **Phase 2e** (lambdas + chain-state) | `EvalContext.treeVersion` is added | Eval semantics differ between ErgoTree V0/V1 (JVM v4.x bug: true iff Coll contains both true and false) and V2+ (correct left-fold XOR: true iff odd count of trues). Per `eval/xor_of.rs:25`. Same family as the V3 gating deferred for Upcast/Downcast in 2d-A. |
| `Xor` (byte-array) | Later phase (likely **2g** alongside Coll HOFs, or standalone) | None — implementable any time | Not a logical/threshold variant; got bundled into slice B's handoff by name confusion. Operates on `Coll[Byte] × Coll[Byte] → Coll[Byte]` per `mir/xor.rs`. Doesn't share infrastructure with And/Or. |
| `Atleast` | **Phase 2g** (sigma protocol) | Structural `SigmaBoolean` representation lands | Calls `Cthreshold::reduce(k, children)` which performs sigma-protocol-level normalization — can collapse to `Cor`, `Cand`, `Cthreshold`, or `TrivialProp` depending on inputs. Inline wire-construction with opaque-bytes posture requires shallow structural inspection of input `SigmaBoolean.raw` bytes; cleaner after `SigmaBoolean` becomes a discriminated union. |
| `SigmaAnd` | **Phase 2g** (sigma protocol) | Same as Atleast | Calls `Cand::normalized(items)` — same normalization family. `eval/sigma_and.rs:13-28`. |
| `SigmaOr` | **Phase 2g** (sigma protocol) | Same as Atleast | Calls `Cor::normalized(items)` — same normalization family. `eval/sigma_or.rs:13-28`. |

**Three tracking mechanisms** (redundant by design):

1. **`facts/ergoscript.md` "Does NOT ship yet" section** gets a
   per-variant table with the columns above. Every future phase's
   brainstorm starts by reading this file — the load-bearing boundary
   contract.
2. **This spec document** carries the table above verbatim. Future
   phase specs read sister specs by convention (the umbrella's "read
   these in order" list).
3. **Two auto-loading memories:**
   - Extend `project_treeversion_v3_gating_deferred` (existing) to
     fold in `XorOf` — same tree-version-gating family. Rename to
     `project_treeversion_gating_deferred` for accuracy.
   - New `project_sigma_combinators_deferred` covering
     `Atleast`/`SigmaAnd`/`SigmaOr` with "must implement in phase
     2g" framing.

Phase 2e's brainstorm will surface `XorOf` (the `treeVersion` plumbing
is the trigger). Phase 2g's brainstorm will surface `Atleast` /
`SigmaAnd` / `SigmaOr` (structural-SigmaBoolean is the trigger). The
memory writes are the strongest signal because they're in the
auto-loaded context of every future session.

## Sequencing

Per-arm execution with two-stage review (spec compliance + code quality)
per task. Same pattern as 2c (10 tasks) and 2d-A (6 tasks); slice B is
the smallest yet at 3.

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 1 | `And` arm + fixture | `mir/and.rs`, `eval/and.rs` | Simplest: vacuous-truth-on-empty, all-true reducer, cost `(10, 5, 32, n)`. Establishes the slice B template against the new `'coll-not-boolean'` code. Fixture: ~10 entries (empty, single-item, all-true / all-false at varied N, mixed, chunk boundary at n=32/33, cost-limit) + 2 inline TS error tests. |
| 2 | `Or` arm + fixture | `mir/or.rs`, `eval/or.rs` | Mirror of And with `some` reducer, cost `(5, 5, 64, n)`. Fixture: ~10 entries (boundary at n=64/65 instead of 32/33). 2 inline error tests. |
| 3 | Finalize (corpus re-run + facts + memories + spec close + commit-and-push) | — | Run `test/corpus-eval.test.ts`; confirm `success=0 not-impl=18 other=0` stays green. Update `facts/ergoscript.md`'s v0.2.0 EvalError taxonomy with `'coll-not-boolean'` AND the "Does NOT ship yet" table from § Deferred variants. Bump "Coverage after 2X" line from "15 of ~70" to "17 of ~70." Rename memory `project_treeversion_v3_gating_deferred` → `project_treeversion_gating_deferred` and add `XorOf`. Write new memory `project_sigma_combinators_deferred`. Update `MEMORY.md` index. Update `project_ergots_direction` to reflect phase 2d-B done. Commit-and-push to `origin/master`. |

3 tasks vs slice A's 6 vs 2c's 10. Smaller because no helper refactor
(no `_coll.ts` promotion — YAGNI), no central dispatcher work (already
done for the family in 2c's BinOp pattern; And/Or are top-level arms),
and only 2 arms total. Estimated wall clock: ~1.5-2 hours.

The PLAN.md (overwritten in slice B's start, same pattern as 2b → 2c →
2d-A → 2d-B) holds these three tasks in detail. The spec is the why;
the PLAN is the how.

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | Slice B narrows to `And` + `Or` only; defer `XorOf`, `Xor` (byte-array), `Atleast`, `SigmaAnd`, `SigmaOr`. | B-original-corrected (4 arms — add `XorOf` and `Atleast`); B-bundled (all 7); B-narrowest (1 arm). | `XorOf` is gated on `treeVersion` (phase 2e); the three SigmaProp combinators share the `Cthreshold::reduce` / `Cand::normalized` / `Cor::normalized` family and are naturally adjacent to phase 2g's structural `SigmaBoolean`. Splitting cleanly avoids piecemeal `treeVersion` plumbing and opaque-bytes wire-construction complexity now. |
| 2 | Error code: one new `'coll-not-boolean'`, reused across both arms. | Reuse `'collection-elem-kind-mismatch'` from 2b; reuse `'bin-op-not-boolean'` from 2c; two distinct codes for "not a Coll" vs "Coll items wrong kind." | Cleanest semantic match. Reusing `'bin-op-not-boolean'` would expand its meaning beyond direct Boolean operands. Reusing `'collection-elem-kind-mismatch'` would expand it from construction to extraction. Two distinct codes is over-engineered — wire-format invariants mean both legs are the same "shape mismatch" family in practice. |
| 3 | Inline kind-check duplication in both arms; no shared `_coll.ts` helper. | Promote a `extractBoolColl` helper to a new `eval/_coll.ts`; reuse some other 2b/2c helper. | ~5 LOC duplication per arm. YAGNI per slice A's `sTypeToNumericKind` precedent — promote when third caller (`XorOf` / `ForAll` / `Exists`) emerges. Code comment in both files acknowledges the duplication. |
| 4 | Three-mechanism deferral tracking: `facts/ergoscript.md` table + this spec's § Deferred variants + two auto-loading memories. | Single mechanism (memory only); single mechanism (facts only); ad-hoc. | Redundant by design — user explicitly asked for "properly deferred and not forgotten." Memory writes are the strongest signal (auto-load every session). Facts is the boundary contract every future phase reads. Spec is self-documenting. |
| 5 | 3 subagent tasks, per-arm cadence (approach A from brainstorm). | 2 tasks (combined arm task); 1 task (direct implementation, no subagent). | Subagent-driven discipline has caught real bugs at scale (2c cost-order, 2d-A cost-charging-order). Per-arm cadence keeps failures local. Slice being small doesn't justify abandoning the working discipline. |
| 6 | Layer C3 eval mutation testing: still deferred. | Add per-arm mutation suite. | Same reasoning as 2c/2d-A — budget better invested at phase 2e (Box/Context structural surface) or 2g (Coll HOFs whose recursion has uncatchable parse-time bugs). |
| 7 | Cost values source-read per arm at implementation time. | Pre-state `Fixed(N)` placeholders in PLAN; resolve at code-review. | Phase 2c lesson — every plan-stated cost value was wrong. Slice A repeated this. Source-first is load-bearing. The PLAN cites `eval/and.rs:19` / `eval/or.rs:19`; the C1 fixture-equality is the gate. |
| 8 | Defensive eval-time kind-check despite wire-format invariants. | Trust wire-format invariants and skip the check (per CLAUDE.md "validate at boundaries, trust internal code"). | 2c's `LogicalNot` / `BoolToSigmaProp` / `BinOp.Logical` arms all do defensive Boolean checks despite parse-time enforcement. Slice B matches that soft-pattern for consistency. Defends against `ConstantPlaceholder` injection (which can deliver any SValue regardless of declared SType) and future MIR shape changes. |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cost values copied incorrectly from sigma-rust | Per-arm comment cites `eval/and.rs:19` / `eval/or.rs:19`. C1 fixture cost-equality is the day-one gate (caught 2d-A's cost-order surprises). Plan-stated values stay placeholder-only — derive from source per arm. |
| Cost-charging order wrong | Both arms charge AFTER eval-child (data-dependent — depends on the resulting Coll's length). Same Cast pattern as 2d-A's Upcast/Downcast. C1 cost-equality assertion catches inversion. |
| Empty-Coll behavior wrong (vacuous-truth direction inverted) | Explicit empty-Coll fixture entry per arm (`And([]) → true`, `Or([]) → false`). The asymmetry is the most-likely-to-confuse case; lock it in writing. |
| Chunk-boundary off-by-one in cost math | `addPerItemCost` formula is `base + ceil(n / chunkSize) * perChunk`. Fixtures at exact-chunk (n=32 for And, n=64 for Or) and one-over (n=33 / n=65) lock both sides of the boundary. |
| `'coll-not-boolean'` defensive check missing a leg (input not Coll vs Coll items not Boolean) | Two inline TS error tests per arm: one for non-Coll input, one for Coll with wrong-kind items. Hand-built MIR nodes bypass `try_build` (LogicalNot / 2d-A precedent). |
| Memory rename (`project_treeversion_v3_gating_deferred` → `project_treeversion_gating_deferred`) breaks auto-load | Task 3 verifies the new file path matches the loader's expectations (kebab-case `.md` in `~/.claude/projects/-home-mwaddip-projects-ergots/memory/`); also updates the entry in `MEMORY.md`. Memory rename is a 3-step: write new + delete old + update index. |
| Adding new `Expr` variant to `mir/types.ts` without arm | Compile-time error from `_exhaust: never` in central switch — same exhaustiveness pattern that catches every prior slice. |
| Subagent dispatch misses a review finding | Two-stage review (spec compliance + code quality) per task — pattern proven across 2b's 18 tasks, 2c's 10 tasks, and 2d-A's 6 tasks. |
| Mainnet corpus regression (`expect(other).toBe(0)` trips) | Task 3 explicitly re-runs `test/corpus-eval.test.ts` before commit-and-push. Tightened assertion from 2c's commit `cc1c7a3` is the safety net. |
| Future phase forgets to pick up the deferred variants | Three independent tracking mechanisms (§ Deferred variants): `facts/ergoscript.md`, this spec, two auto-loading memories. Phase 2e brainstorm trips on the renamed memory (`XorOf`); phase 2g brainstorm trips on the new sigma-combinators memory. |

## Open questions

All small; none are blockers; all resolve via source-read or
fixture-driven TDD at implementation time.

1. **Exact base / perChunk / chunkSize constants per arm.** The spec
   cites `eval/and.rs:19` (And) and `eval/or.rs:19` (Or). Numeric
   literals are NOT pre-stated in this spec — the C1 fixture-gen output
   is the source of truth, same posture as 2c/2d-A. If source has been
   refactored between `ed5452cf` and the implementation date, the
   source values still win.

2. **`SValue.kind: 'Coll'` items shape for Boolean items.** Existing TS
   type:
   ```ts
   | { kind: 'Coll'; elem: SType; items: SValue[] }
   ```
   For a Boolean Coll, each item is `{ kind: 'Boolean', value: boolean
   }`. The arm walks `items` and extracts each `.value`. Confirm
   sigma-rust's `Vec<bool>` extraction doesn't unpack any other shape
   (e.g., a `Coll.NativeColl(CollBool)` representation our parser
   doesn't currently produce). The C1 fixture exercises real parser
   output, so any divergence shows up as a value mismatch.

3. **`'coll-not-boolean'` message text format.** Should the throw site
   include the offending item's index when the failure is "Coll with
   non-Boolean item"? Spec says yes; implementation task fills in the
   format string. Not load-bearing — `.code` is what callers dispatch
   on; `.message` is human-readable.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella
  phase plan (2a–2j)
- `docs/specs/2026-05-15-ergoscript-phase-2d-design.md` — slice A
  focused design (sister)
- `docs/specs/2026-05-14-ergoscript-phase-2c-design.md` — phase 2c
  focused design (operators slice 1)
- `facts/ergoscript.md` — boundary contract, extended additively per
  phase
- `facts/proof.md` — sister contract for the proof package
- `CLAUDE.md` — TDD discipline, browser-first rules,
  confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`,
  HEAD `ed5452cf`) — byte-format and implementation oracle. Slice B
  authoritative refs:
  - `ergotree-interpreter/src/eval/and.rs`
  - `ergotree-interpreter/src/eval/or.rs`
  - `ergotree-ir/src/mir/and.rs` (parse-time `post_eval_tpe` invariant
    on `.input`)
  - `ergotree-ir/src/mir/or.rs` (same)
  - `ergotree-ir/src/serialization/op_code.rs` (opcodes 38 / 39)
- Deferred-variant refs (for tracking, not implementation):
  - `ergotree-interpreter/src/eval/xor_of.rs` — V0/V1 vs V2+ branch
    (`treeVersion` gating)
  - `ergotree-interpreter/src/eval/atleast.rs` — `Cthreshold::reduce`
    call site
  - `ergotree-interpreter/src/eval/sigma_and.rs` — `Cand::normalized`
    call site
  - `ergotree-interpreter/src/eval/sigma_or.rs` — `Cor::normalized`
    call site
  - `ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs` —
    reduction logic (phase 2g implementation oracle)
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical
  language specification for `And` / `Or` aggregator semantics
