# ErgoScript Interpreter — Phase 2g.5 Design Spec (Method-call dispatch + C2 corpus unlocker)

**Status:** Draft
**Date:** 2026-05-17
**Package:** `@ergots/ergoscript` (phase 2g.5 — `MethodCall`/`PropertyCall` dispatcher + 3 corpus-unlocker method handlers + 3 supporting arms; the actual C2 corpus unlocker)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella; this slice is the out-of-order corpus-unlocker insertion noted in the post-2g-combinators phase plan)
**Sister specs:**
- `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` (immediate predecessor — full SigmaBoolean verifier surface; conjecture walk; GF(2^192))
- `docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md` (Layer C3.a operator-driven mutation testing; flat-task-list workflow; spec conventions)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec)

**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-17 (post-phase-2g-combinators; data-driven measurement of the C2 corpus method-call demand surfaced a much smaller actual scope than the handoff's initial projection)

## Goal

Ship phase 2g.5: the `MethodCall`/`PropertyCall` dispatcher infrastructure plus the minimum method handlers + supporting arms required to fully unlock the C2 corpus (the 18 sigma-rust-evaluable mainnet trees that have remained at `success=0` since phase 2f). By the end of this slice:

- **Four new evaluator arms** (47 → 51 of ~70):
  - `Context` — returns the `Value::Context` sentinel (cost 1, source: `expr.rs:38`). Required for `SContext.dataInputs`'s obj.
  - `SigmaPropBytes` — serializes a SigmaProp to its byte form (cost via `addPerItemCost(35, 6, 1, 1)` Pattern A; source: `sigma_prop_bytes.rs:15`).
  - `MethodCall` — dispatcher (cost 4 Pattern A; source: `method_call.rs:17`).
  - `PropertyCall` — dispatcher (cost 4 Pattern A; source: `property_call.rs:16`). Shares the registry with `MethodCall` (semantically just an empty-args variant).
- **One new `SValue` kind variant:** `{ kind: 'Context' }`. Mirrors sigma-rust's `Value::Context`. Required for handlers that need to type-check their `obj` (currently only `SContext.dataInputs`).
- **One new `EvalOpts` field:** `dataInputs?: ErgoBox[]`. Additive extension to the public eval context; required by `SContext.dataInputs`.
- **Per-method handler registry + 3 registered handlers** in a new `eval/method-call.ts`:
  - `SBox.tokens` (typeId=99, methodId=8): cost 15, returns `Coll[(Coll[Byte], Long)]` (source: `sbox.rs:72`).
  - `SContext.dataInputs` (typeId=101, methodId=1): cost 15, validates `obj.kind === 'Context'`, returns `ctx.dataInputs ?? []` as `Coll[Box]` (source: `scontext.rs:17`).
  - `SColl.indexOf` (typeId=12, methodId=26): cost `addPerItemCost(20, 10, 2, n)` Pattern B, returns Int index of target (or `-1`; `from < 0` clamped to 0) (source: `scoll.rs:21`).
- **Three new `EvalError` codes** (40 → 43):
  - `'method-not-implemented'` — dispatcher hit a `(typeId, methodId)` pair not in the registry; also reused for defensive shape mismatches inside registered handlers (e.g., `SBox.tokens` got a non-Box obj). See Error taxonomy decision in the Architecture section for the rationale.
  - `'context-obj-not-context'` — `SContext.dataInputs` got an obj whose kind is not `'Context'`.
  - `'sigma-prop-bytes-input-not-sigma-prop'` — `SigmaPropBytes` got an input whose kind is not `'SigmaProp'`.
- **Corpus-test-local context provisioning** in `corpus-eval.test.ts` — synthetic stubs for `selfBox`, `inputs`, `outputs`, `dataInputs` (and any others surfaced by the unlock). `makeContext` itself stays strict; this is purely a test-local concern matching sigma-rust's `force_any_val` synthetic-empty defaults.
- **Layer C2 corpus goes green:** `success === 18` (or close, if mid-implementation surfaces additional gaps; in that case investigate-and-fix-or-document, do not silently regress the `expect(other).toBe(0)` gate).

Public function signatures (`evaluate`, `evaluateWith`, `verifySignature`, `EvalError`, `VerifyError`) stay stable. `makeContext` gains the optional `dataInputs?: ErgoBox[]` field — additive, no breaking change. `SValue` gains the `Context` variant — also additive but exhaustive-switch callers will see a new case (acceptable for v0.3.0-pending).

The slice is implemented as 8 sequential tasks in flat `PLAN.md` ordering. Commits between each task; no `Stop α/β/γ` markers (per [[feedback-no-artificial-stops]] memory).

## Background — measured corpus demand

Brainstorm-driven measurement at 2026-05-17 (temp test file walked the 18 evaluable trees + ran them through `evaluateWith`):

### AST tag tally across the 18 entries (descending, top-level Expr tags only)

```
PropertyCall   58       <- needs new arm + registry
GlobalVars    142       <- already implemented; fails on missing context-state
Context        15       <- needs new arm + new SValue variant
MethodCall      6       <- needs new arm + registry
SigmaPropBytes  2       <- needs new arm
```

All other tags reaching the corpus are already implemented (47 arms shipped through 2g-combinators).

### Method-dispatch pairs actually present

```
PropertyCall (typeId=99,  methodId=8)   x43   <- SBox.tokens
PropertyCall (typeId=101, methodId=1)   x15   <- SContext.dataInputs
MethodCall   (typeId=12,  methodId=26)  x 6   <- SColl.indexOf
```

**Three pairs. No Header methods. No `Coll.zip`/`reverse`/`flatten`/`getOrElse`/`indices`. No `SNumericTypeMethods` Bit shifts.** The handoff's broader scope projection was speculative; the measured demand is much smaller. The optional broader surface — Header methods, additional Coll utilities, Bit shifts — is deferred to a hypothetical phase **2g.6** if/when real mainnet contracts surface demand.

### First-error breakdown per entry (with current empty synthetic context)

```
17 entries: 'context-field-missing'    GlobalVars.{Outputs|SelfBox|Inputs} (ctx is empty)
 1 entry:   'not-implemented-yet'      SigmaPropBytes
```

Context-field-missing is masking the deeper failures — the new MIR arms (Context / MethodCall / PropertyCall) wouldn't even be reached without context provisioning. Once `outputs: []` etc. are stubbed in the corpus test, the next walls become `Context` (15 entries) and method dispatch (mostly `SBox.tokens` and `SContext.dataInputs`). The slice fixes all of these in order.

## Non-goals

- **Broader method-call surface** — Coll utilities (`.indices`, `.zip`, `.zipWith`, `.reverse`, `.flatten`, `.getOrElse`), Header methods, `SNumericTypeMethods` Bit shifts, additional `SBox`/`SContext`/`SGlobal` methods beyond the three above. Optional **phase 2g.6** if/when mainnet demand surfaces. The registry shipped in 2g.5 is the load-bearing primitive; adding methods is a per-method micro-task once it exists.
- **`MethodCall` explicit-type-args specialization beyond pass-through.** The three handlers in this slice don't use `explicitTypeArgs` at all (no T-parameterized methods). The dispatcher passes the `explicitTypeArgs` map to handlers as a fourth argument so future T-parameterized handlers (e.g., `SBox.getReg[T]`) can opt in, but no slice-level work uses it.
- **AVL+ membership-proof verification.** Phase 2h.
- **`LastBlockUtxoRootHash`.** Phase 2h (depends on AVL+).
- **Byte-array conversions** (`ByteArrayToLong`, `LongToByteArray`, `ByteArrayToBigInt`). Phase 2i.
- **Hash predefs** (`CalcBlake2b256`, `CalcSha256`, `DecodePoint`). Phase 2i.
- **`SubstConstants`**, `Xor` byte-array. Phase 2i.
- **Real-context cost validation (Layer C3-cost).** Phase 2j.
- **`npm publish` of `@ergots/ergoscript@0.3.0`.** Separate user decision; 2g-combinators is the natural minor-version milestone (full SigmaBoolean verifier surface). Sequential with this slice or before — user's call.
- **Behavioral change to `makeContext` defaults** — keeping the public API strict (callers must explicitly declare what they provide). Synthetic-empty context provisioning is corpus-test-local, not a public-API change. This avoids masking real "forgot to provide context" bugs in callers.
- **Layer C3.a mutation testing for the 3 method handlers.** The existing C3.a framework is Coll-HOF-oriented (operator-driven boundary mutations). The 3 handlers (`SBox.tokens`, `SContext.dataInputs`, `SColl.indexOf`) have simple shapes that don't fit the C3.a operator-grid cleanly — C3.a expansion to method-call handlers is a future cleanup if/when. C1 + C2 coverage is the discipline for this slice.
- **Carryover cleanup from 2g-medium / 2g-combinators.** Unreachable `'scalar-out-of-range'`, unused `assertConsumed()`, unreachable `'cor-derived-challenge-mismatch'`/`'cthreshold-derived-challenge-mismatch'`, reserved `'conjecture-not-implemented'` — all stay as-is. Independent micro-cleanup slice if/when.

## Architecture

### Directory layout

```
packages/ergoscript/src/
├── eval/
│   ├── eval.ts                                MODIFIED: 4 new case lines (Context, SigmaPropBytes, MethodCall, PropertyCall)
│   ├── errors.ts                              MODIFIED: 2 new EvalError codes
│   ├── eval-context.ts                        MODIFIED: EvalOpts gains optional dataInputs?: ErgoBox[]
│   ├── context.ts                             NEW: Context arm (cost 1, returns { kind: 'Context' })
│   ├── sigma-prop-bytes.ts                    NEW: SigmaPropBytes arm
│   └── method-call.ts                         NEW: MethodCall + PropertyCall dispatcher + registry + 3 inline handlers
├── mir/
│   └── types.ts                               MODIFIED: SValue union gains { kind: 'Context' }
└── index.ts                                   MODIFIED: re-export SValue's new variant if exported by name (audit)

packages/ergoscript/test/
├── eval/
│   ├── context.test.ts                        NEW: C1 fixture for Context arm
│   ├── sigma-prop-bytes.test.ts               NEW: C1 fixture for SigmaPropBytes arm
│   └── method-call.test.ts                    NEW: C1 fixtures for SBox.tokens / SContext.dataInputs / SColl.indexOf + unknown-pair dispatch test
├── corpus-eval.test.ts                        MODIFIED: synthetic-context stubs; assert success === 18
└── fixtures/
    └── eval/
        ├── context.json                       NEW
        ├── sigma-prop-bytes.json              NEW
        └── method-call.json                   NEW (3 handler sub-cases + unknown-pair reject case)

fixture-gen/src/cmds/ergoscript/eval/
├── context.rs                                 NEW
├── sigma_prop_bytes.rs                        NEW
└── method_call.rs                             NEW
fixture-gen/src/main.rs                        MODIFIED: 3 new generate_and_write calls
```

### `Context` Expr arm + `SValue.kind: 'Context'` variant

**MIR:** `Context` is already in the `Expr` union (`mir/types.ts:328`) and already wire-parsed/serialized. This slice adds only the eval arm and the SValue variant.

**SValue variant:**
```ts
// mir/types.ts SValue union, additive:
| { kind: 'Context' }
```

Mirrors sigma-rust `Value::Context` — a sentinel with no associated data. The PropertyCall handlers that need to type-check obj (currently only `SContext.dataInputs`) pattern-match on `obj.kind === 'Context'`.

**Eval arm:** `eval/context.ts`
```ts
import type { Context as ContextExpr, SValue } from '../mir/types'
import type { EvalContext } from './eval-context'

export function evalContext(_e: ContextExpr, _env: Env, ctx: EvalContext): SValue {
  ctx.addCost(1)  // Pattern A; source: expr.rs:38 `Expr::Context => add_jit_cost(1)`
  return { kind: 'Context' }
}
```

Simple. Single new test fixture confirms cost=1 + the returned SValue.

### `SigmaPropBytes` Expr arm

**Source:** `eval/sigma_prop_bytes.rs:9-24`. Implementation:

```ts
import { buildSigmaPropBytes } from '../sigma/...'  // see note below
// or inline using the existing 2g-medium prop-bytes builder

export function evalSigmaPropBytes(e: SigmaPropBytes, env: Env, ctx: EvalContext): SValue {
  ctx.addPerItemCost(35, 6, 1, 1)  // Pattern A per sigma_prop_bytes.rs:15
  const inputV = evalExpr(e.input, env, ctx)
  if (inputV.kind !== 'SigmaProp') {
    throw new EvalError(
      `SigmaPropBytes expects a SigmaProp input; got ${inputV.kind}`,
      'sigma-prop-bytes-input-not-sigma-prop'
    )
  }
  return bytesToCollByteSValue(propBytesOf(inputV.value))
}
```

**Note on `propBytesOf`:** 2g-medium's `buildFiatShamirLeaf` already produces `prop_bytes` for verifier use (matches sigma-rust's `SigmaProp::prop_bytes` for leaves). The 2g-medium `prop_bytes` builder is leaf-only (TrivialProp / ProveDlog / ProveDhTuple). For 2g-combinators it was extended to the full SigmaBoolean surface (Cand/Cor/Cthreshold). The same surface is what `SigmaPropBytes` needs. Reuse: either lift the existing prop-bytes builder into a small public-internal helper module (e.g., `sigma/prop-bytes.ts`), or expose it from `sigma/fiat-shamir.ts`. Implementer-time decision based on what reads naturally; the contract is "serialize a SigmaBoolean to its byte form per `sigma_protocol/sigma_boolean/prop_bytes` in sigma-rust."

**New EvalError code:** `'sigma-prop-bytes-input-not-sigma-prop'` — defensive throw if upstream type inference is wrong (the `input` Expr evaluates to something other than `kind: 'SigmaProp'`). Source-driven runtime check matching `sigma_prop_bytes.rs:18-23`.

### `MethodCall` + `PropertyCall` dispatcher (`eval/method-call.ts`)

The load-bearing module. Both `MethodCall` and `PropertyCall` MIR arms route through this single file. Semantically `PropertyCall` is a zero-arg `MethodCall`.

**Module structure:**

```ts
// eval/method-call.ts

import type { Expr, MethodCall, PropertyCall, SType, SValue, ErgoBox } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { evalExpr } from './eval'

// ---------- Handler registry ----------

type MethodHandler = (
  obj: SValue,
  args: SValue[],
  ctx: EvalContext,
  explicitTypeArgs: Record<string, SType>
) => SValue

// Keyed by `${typeId}:${methodId}`. Inline handlers (3 of them) registered below.
const HANDLERS = new Map<string, MethodHandler>()

function key(typeId: number, methodId: number): string {
  return `${typeId}:${methodId}`
}

// ---------- Dispatcher (called by MethodCall and PropertyCall MIR arm cases) ----------

export function evalMethodCall(e: MethodCall, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(4)  // Pattern A; source: method_call.rs:17
  const obj = evalExpr(e.obj, env, ctx)
  const args = e.args.map(a => evalExpr(a, env, ctx))
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
  const handler = HANDLERS.get(key(typeId, methodId))
  if (!handler) {
    throw new EvalError(
      `method not implemented: typeId=${typeId}, methodId=${methodId}`,
      'method-not-implemented'
    )
  }
  return handler(obj, args, ctx, explicitTypeArgs)
}

// ---------- Inline handlers ----------

// SBox.tokens (PropertyCall, typeId=99, methodId=8)
// Source: sbox.rs:72-79
HANDLERS.set(key(99, 8), (obj, _args, ctx, _) => {
  ctx.addCost(15)
  if (obj.kind !== 'Box') {
    throw new EvalError(
      `SBox.tokens expects a Box obj; got ${obj.kind}`,
      'method-not-implemented'  // reuse per error taxonomy (option 1, see below)
    )
  }
  return tokensCollOf(obj.value)
})

// SContext.dataInputs (PropertyCall, typeId=101, methodId=1)
// Source: scontext.rs:17-31
HANDLERS.set(key(101, 1), (obj, _args, ctx, _) => {
  ctx.addCost(15)
  if (obj.kind !== 'Context') {
    throw new EvalError(
      `SContext.dataInputs expects a Context obj; got ${obj.kind}`,
      'context-obj-not-context'
    )
  }
  return dataInputsCollOf(ctx.dataInputs ?? [])
})

// SColl.indexOf (MethodCall, typeId=12, methodId=26)
// Source: scoll.rs:21-50
HANDLERS.set(key(12, 26), (obj, args, ctx, _) => {
  if (obj.kind !== 'Coll') {
    throw new EvalError(
      `SColl.indexOf expects a Coll obj; got ${obj.kind}`,
      'method-not-implemented'  // reuse per error taxonomy (option 1)
    )
  }
  const n = obj.items.length
  ctx.addPerItemCost(20, 10, 2, n)  // Pattern B; per scoll.rs:31
  if (args.length !== 2) {
    throw new EvalError(
      `SColl.indexOf expects 2 args; got ${args.length}`,
      'method-not-implemented'  // defensive; the wire should guarantee this
    )
  }
  const [target, fromArg] = args
  if (fromArg.kind !== 'Int') {
    throw new EvalError(
      `SColl.indexOf expects 'from' to be Int; got ${fromArg.kind}`,
      'method-not-implemented'
    )
  }
  const from = Math.max(0, fromArg.value)
  for (let i = from; i < n; i++) {
    if (sValueEquals(obj.items[i], target)) return { kind: 'Int', value: i }
  }
  return { kind: 'Int', value: -1 }
})
```

**Helper functions** (in the same file, or factored into `_method-call-helpers.ts` if file grows):
- `tokensCollOf(box: ErgoBox): SValue` — converts `box.tokens: { id, amount }[]` to `Coll[(Coll[Byte], Long)]`.
- `dataInputsCollOf(boxes: ErgoBox[]): SValue` — converts `ErgoBox[]` to `Coll[Box]`.

**Dispatcher cost discipline (Pattern A):** charge before evaluating children. Matches sigma-rust `method_call.rs:17` and `property_call.rs:16`. Per-handler cost is then charged inside each handler (some Pattern A like `SBox.tokens` and `SContext.dataInputs`, some Pattern B like `SColl.indexOf`).

**Error taxonomy decision (implementer-time):** the inline handler stubs above use `'method-not-implemented'` as a fallback for shape-mismatch defensive throws (e.g., obj.kind !== 'Box'). These are theoretically unreachable in well-typed corpora but ship as defensive guards. Decision options at implementation time:
1. Reuse `'method-not-implemented'` for all defensive shape mismatches (simpler taxonomy; minor semantic stretch).
2. Add per-handler defensive codes (e.g., `'sbox-tokens-obj-not-box'`, `'scoll-index-of-obj-not-coll'`) — more precise, 5+ new codes total.

Recommend **option 1** to keep the error taxonomy compact for an additive surface that's intended to grow incrementally; revisit if a defensive throw becomes user-facing-relevant. **Final taxonomy after the slice: 3 new codes** (`'method-not-implemented'`, `'context-obj-not-context'`, `'sigma-prop-bytes-input-not-sigma-prop'`) per the Goal section.

### Corpus context provisioning (`corpus-eval.test.ts` changes)

Current:
```ts
const ctx = makeContext({ constants: tree.constants })
```

New (test-local, no public API change):
```ts
const STUB_BOX: ErgoBox = synthesizeStubBox()  // shared synthetic empty Box
const ctx = makeContext({
  constants: tree.constants,
  selfBox: STUB_BOX,
  inputs: [STUB_BOX],
  outputs: [STUB_BOX],
  dataInputs: [],
  height: 0,
})
```

**`synthesizeStubBox`**: a single shared helper (test-local) producing an `ErgoBox` with all required fields zeroed/empty (zero `value`, empty `propositionBytes`, empty `tokens`, zero-byte `txId`, etc.). The exact field set must match sigma-rust's `force_any_val` synthetic defaults closely enough that the 18 trees can complete eval; verify by running the corpus test after Task 7 and iterating if any tree fails on a stub-field that needs richer data.

**Why test-local:** keeps the public `makeContext` strict. Synthetic-empty context is a property of the corpus test, not the public eval surface — callers using `evaluate` in production should declare all required fields explicitly.

### `dataInputs?: ErgoBox[]` on `EvalOpts`

```ts
// eval-context.ts (additive)
export interface EvalOpts {
  // ... existing fields ...
  /** Transaction dataInputs (read-only). Mirrors sigma-rust `Context::data_inputs`. */
  dataInputs?: ErgoBox[]
}
```

`makeContext` is updated to thread the value through (single line addition). Default behavior when the field is absent: handler returns empty Coll (matches sigma-rust's `ctx.data_inputs.clone().map_or(Arc::new([]), ...)` at `scontext.rs:26`).

### Error codes added (final)

3 new `EvalError` codes (40 → 43):
- `'method-not-implemented'` — dispatcher lookup miss for a `(typeId, methodId)` pair; also reused for defensive shape mismatches inside registered handlers (see Error taxonomy decision above).
- `'context-obj-not-context'` — `SContext.dataInputs` got an obj whose kind is not `'Context'`.
- `'sigma-prop-bytes-input-not-sigma-prop'` — `SigmaPropBytes` got an input whose kind is not `'SigmaProp'`.

## Implementation tasks (flat, 8 tasks, per-task commits)

Each task is a complete red→green→refactor cycle with at least one fixture (Layer C1) per new behavior. No `Stop` markers between tasks. Per-task commits land green tests + facts/PLAN updates as needed.

1. **`SValue.kind: 'Context'` variant + `Context` Expr eval arm + fixture.**
   - Add the variant to `mir/types.ts` SValue union.
   - Create `eval/context.ts` (`evalContext`, cost 1, returns the sentinel).
   - Wire `case 'Context':` in `eval/eval.ts`.
   - Fixture: simplest case, `Context` Expr → `{ kind: 'Context' }` SValue, cost = 1.
   - Layer C1 pass.

2. **`SigmaPropBytes` Expr eval arm + fixture.**
   - Decide on `propBytesOf` location (`sigma/prop-bytes.ts` extraction from `sigma/fiat-shamir.ts`, or direct call into the existing module). Source-read the 2g-combinators leaf+conjecture builder for the right entry point.
   - Create `eval/sigma-prop-bytes.ts`.
   - Wire `case 'SigmaPropBytes':` in `eval/eval.ts`.
   - Add `'sigma-prop-bytes-input-not-sigma-prop'` to `eval/errors.ts`.
   - Fixture: TrivialProp(true) → 2 bytes (`0x08 0x01`); ProveDlog → 34 bytes; conjecture trees (Cand/Cor) cross-validated against sigma-rust at fixture-gen time.
   - Layer C1 pass.

3. **`MethodCall` + `PropertyCall` dispatcher skeleton.**
   - Create `eval/method-call.ts` with the handler registry shape but ZERO registered handlers initially.
   - Wire `case 'MethodCall':` and `case 'PropertyCall':` in `eval/eval.ts`.
   - Add `'method-not-implemented'` to `eval/errors.ts`.
   - Test: dispatcher charges 4 cost (Pattern A) then evals obj+args then throws `'method-not-implemented'` for any registered miss. Use a hand-crafted fixture with `(typeId=255, methodId=255)`.
   - Layer C1 pass — covers dispatcher cost + miss throw behavior.

4. **`SBox.tokens` handler + fixture.**
   - Register the handler in `eval/method-call.ts`.
   - Implement `tokensCollOf(box: ErgoBox): SValue` (Coll of Tuples).
   - Fixture: a synthetic ErgoBox with 0, 1, and 2 tokens → corresponding Coll outputs; cost = 4 (dispatcher) + 15 (handler) = 19.
   - Layer C1 pass.

5. **`SContext.dataInputs` handler + fixture.**
   - Add `dataInputs?: ErgoBox[]` to `EvalOpts` in `eval-context.ts`.
   - Register the handler in `eval/method-call.ts`.
   - Add `'context-obj-not-context'` to `eval/errors.ts`.
   - Implement `dataInputsCollOf(boxes: ErgoBox[]): SValue`.
   - Fixture: `Context.dataInputs` with `ctx.dataInputs = []` → empty Coll[Box]; with two dataInputs → 2-element Coll[Box]; cost = 4 + 1 (Context arm) + 4 (PropertyCall) + 15 (handler) = 24 (or whatever sigma-rust's `try_eval_out` emits — verify byte-by-byte at fixture-gen time).
   - Layer C1 pass.

6. **`SColl.indexOf` handler + fixture.**
   - Register the handler in `eval/method-call.ts`.
   - Reuse `sValueEquals` (from 2c) for element comparison.
   - Fixtures: `Coll[Long](1, 2, 3).indexOf(2, 0) → 1`; `indexOf(2, 1) → 1`; `indexOf(2, 2) → -1` (not found from index 2); `indexOf(2, -5) → 1` (clamped to 0); `indexOf(99, 0) → -1` (not found).
   - Cost (Pattern B): `addPerItemCost(20, 10, 2, n)` after extracting Coll.
   - Layer C1 pass.

7. **Corpus context provisioning + assert success === 18.**
   - Update `corpus-eval.test.ts` with synthetic-context stubs.
   - Synthesize the stub Box (single shared helper).
   - Run the corpus test; expect 18/18 success. If any tree fails, investigate (probably a stub-field shape mismatch; iterate the stub).
   - Add an explicit assertion: `expect(evalSuccess).toBe(18)`.

8. **`facts/ergoscript.md` update + final regression sweep.**
   - Update coverage (47 → 51 arms), new SValue variant, 3 new EvalError codes, new `EvalOpts.dataInputs` field, 3 new public-internal handlers (method-call registry).
   - Update umbrella spec annotation (phase 2g.5 → COMPLETE).
   - Run full test suite under node + jsdom; confirm zero regressions.
   - Run `cargo test` and `cargo run` (fixture-gen determinism check); confirm zero fixture diffs.
   - Update PLAN.md status.

**Estimated total: 7-10h.** Mostly Sonnet-suitable; the dispatcher infrastructure (Task 3) may benefit from Opus depending on how the registry shape evolves during implementation.

## Validation strategy

### Layer C1 — per-arm fixtures

Every new arm gets at least one fixture asserting both value and cost against sigma-rust's `try_eval_out` oracle (where applicable). Cross-validated at fixture-gen time per the standing pattern.

- **Context arm:** trivial fixture; value = `{ kind: 'Context' }`, cost = 1.
- **SigmaPropBytes:** TrivialProp + ProveDlog leaf + Cand/Cor conjecture sub-cases; cross-validated against `sigma_prop_bytes.rs` eval.
- **MethodCall/PropertyCall dispatcher:** dispatcher cost test (4 per dispatch) + unknown-pair throw test.
- **SBox.tokens:** 0/1/2 token sub-cases.
- **SContext.dataInputs:** empty + 2-element sub-cases.
- **SColl.indexOf:** 5 sub-cases listed in Task 6.

### Layer C2 — corpus eval

The C2 corpus eval (`corpus-eval.test.ts`) is the integration signal for this slice. After Task 7, `success === 18` MUST hold. The `expect(other).toBe(0)` regression gate continues to apply — any new failure mode caught during corpus unlock is investigated and either fixed or documented as a deliberate non-goal.

### Layer C3.a — operator-driven mutation testing

**Deferred for this slice.** The C3.a framework is Coll-HOF-oriented; method handlers have simpler shapes that don't fit cleanly. Re-evaluate in a future micro-cleanup or when method count grows enough to justify expanding C3.a to method-call operators.

### Parse-mutation testing

No new wire-format additions in this slice (`MethodCall` / `PropertyCall` / `Context` / `SigmaPropBytes` MIR are already wire-parsed/serialized from phase 2a). The existing 6221-flip parse-mutation suite covers them; no work needed.

### Cross-runtime

Vitest under both `node` and `jsdom` environments. New tests must pass under both — particularly important for `eval/method-call.ts` (no `Buffer`, no `node:*` imports per the browser-first rule).

### Fixture-gen determinism

Two-run determinism check after each task that adds fixtures: build once, generate, build again, generate, diff. Expected: zero byte differences.

## Risks & open questions

### `propBytesOf` reuse path (Task 2)

The 2g-combinators verifier extension introduced a `prop_bytes` builder that handles the full SigmaBoolean surface (leaves + conjectures). It's currently a private detail of `sigma/fiat-shamir.ts` / `sigma/verifier.ts`. Task 2 needs to either:
- (a) Lift it into a small `sigma/prop-bytes.ts` module exporting `propBytesOf(sb: SigmaBoolean): Uint8Array`.
- (b) Add an internal-exported function from `sigma/fiat-shamir.ts` (single new entry point).
- (c) Inline a thin re-implementation in `eval/sigma-prop-bytes.ts`.

Recommend **(a)** — it's the cleanest separation and `propBytesOf` is a generally-useful primitive. Implementer-time decision based on what the existing fiat-shamir module looks like after 2g-combinators.

### Synthetic Box stub field set (Task 7)

`force_any_val` in sigma-rust uses `proptest::Arbitrary` to synthesize a random `Context`. The corpus eval succeeds in sigma-rust with such a context because no tree assumes specific field values — they exercise *structural* paths (e.g., `OUTPUTS(0).value > 0`) that work against any well-formed Box. Our stub needs to be well-formed (all required fields populated with valid types and lengths) but values can be zero/empty.

**Risk:** if a corpus tree depends on a Box field shape we haven't anticipated (e.g., `OUTPUTS(0).R4` returning a specific SType), the stub may need richer data. Iterate the stub during Task 7 if needed; expect to make 1-2 fixes during implementation.

### Method handler defensive throw taxonomy

Three options (recommend option 1 above):
1. Reuse `'method-not-implemented'` for all defensive shape mismatches inside handlers.
2. Per-handler dedicated codes (`'sbox-tokens-obj-not-box'`, etc.) — adds 3-5 codes.
3. Single new code (`'method-handler-obj-shape-mismatch'`) — splits the difference.

Recommend **(1)** for taxonomy compactness; revisit if any defensive throw becomes externally-meaningful. The Goal section assumes (1).

### Future-method extensibility

The registry shape (`Map<string, MethodHandler>` keyed by typeId:methodId) is intentionally flat. Phase 2g.6 (if it happens) adds handlers by registering new entries. For 10+ methods, consider promoting to a subdirectory (`eval/method-call/handlers/sbox-tokens.ts` etc.) — but premature for 3 handlers.

### `Context` SValue variant breaking-change posture

Adding a new variant to a discriminated union is **type-system-breaking** for any caller using exhaustive `switch (v.kind)` patterns. For our internal use it's controlled; for external SValue consumers (e.g., wallet package, future tooling), the change shows up as a TypeScript exhaustiveness error at compile time. Acceptable for v0.3.0-pending — it's the right kind of breakage to surface.

### Order-of-tasks: SigmaPropBytes before dispatcher?

Task 2 (SigmaPropBytes) doesn't strictly depend on Task 1 (Context arm). It's ordered second for narrative-progression reasons (simpler arm → less-simple arm → dispatcher → handlers → corpus). Implementer can swap 1 ↔ 2 if it reads more naturally; no semantic dependency.

### Phase 2g.5 vs 2g.5-A/B split

Considered at brainstorm-time. Concluded: 8 tasks, 7-10h, fits as one slice. The infrastructure-vs-methods seam is real but for only 3 methods doesn't justify two design docs + two PLANs. If method count grows during implementation (unanticipated demand), can pause and split mid-slice.

## Cross-references

- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/method_call.rs` — dispatcher reference (cost 4, eval obj/args, call handler)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/property_call.rs` — same but empty args
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sbox.rs:72-79` — `SBox.tokens` handler reference
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scontext.rs:17-31` — `SContext.dataInputs` handler reference
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:21-50` — `SColl.indexOf` handler reference
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sigma_prop_bytes.rs` — `SigmaPropBytes` reference
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/expr.rs:38` — `Context` arm reference
- `~/projects/ergots/packages/ergoscript/src/wire/mir/method-call.ts` — wire-layer registry pattern (`EXPLICIT_TYPE_ARG_NAMES`) — the eval-layer registry mirrors this convention.
- `facts/ergoscript.md` — interface contract; extended additively after Task 8.
- Memory `feedback-no-artificial-stops` — flat task list discipline.
- Memory `reference-source-first-discipline` — source-read before writing TS (proven to catch implementer-time spec errors throughout 2g-combinators; apply again per handler in 2g.5).
- Memory `reference-cost-charging-order-patterns` — Pattern A vs Pattern B per arm; source-verified per the table in the Implementation tasks section.
