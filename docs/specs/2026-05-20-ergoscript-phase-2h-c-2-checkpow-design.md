# `@ergots/ergoscript` Phase 2h-c.2 — `SHeader.checkPow` + Autolykos v2 promotion

**Status:** Draft
**Date:** 2026-05-20
**Package:** `@ergots/ergoscript` (additive within an existing workspace; promotes Autolykos v2 codec into `@ergots/scorex`)
**Interface contracts:** `facts/scorex.md`, `facts/ergoscript-eval.md` (both updated alongside implementation; facts files win on any interface disagreement)
**Brainstorm transcript:** this session, 2026-05-20
**Predecessor spec:** `docs/specs/2026-05-19-ergoscript-phase-2h-c-1-sheader-design.md` (phase 2h-c.1 — SHeader runtime + 17 method handlers, landed)
**Successor spec:** (deferred) `@ergots/autolykos-v1` — when/if a from-genesis-archival use case surfaces

## Goal

Wire one new method-call dispatch handler (`SHeader.checkPow` at typeId 104, methodId 16) in `@ergots/ergoscript`'s evaluator. The handler is V3-gated and Pattern A Fixed(700). Promote the existing `@ergots/nipopow/src/autolykos-v2.ts` + `@ergots/nipopow/src/nbits.ts` into `@ergots/scorex` so both consumers (nipopow's verifier and ergoscript's new handler) reach the verifier through a single source. Upgrade the method-call dispatcher with an optional `minVersion` field on registry entries so V3 gating is enforced at dispatch (sigma-rust-parity on cost). Add one new typed scorex error class (`AutolykosV1NotSupportedError`) and one new `EvalError` code (`'autolykos-v1-not-supported'`).

Per the captured cross-package coupling: `@ergots/ergoscript` and `@ergots/nipopow` already declare `@ergots/scorex@0.1.0` as a workspace dep. No new runtime deps in 2h-c.2.

This phase is **additive** — no existing eval arms, method handlers, error codes, SValue variants, or wire-format behaviors change semantically. Phase 2h-c.2 widens the evaluator's method-handler registry from 38 to 39 entries while leaving the 52/~70 `Expr` arm coverage unchanged.

## Non-goals

- **Autolykos v1 verification.** Sigma-rust itself does not verify Autolykos v1 (`autolykos_pow_scheme.rs:322` — "Checking proof-of-work for AutolykosV1 is not supported"; `header.rs:103-110` — `check_pow` returns `Err(Unsupported)` for v1). Our `checkPow` handler mirrors this exactly by throwing `'autolykos-v1-not-supported'` on v1 headers. Adding v1 support would require porting from the JVM Ergo (Scala) reference and designing a non-Rust oracle strategy; queued as a separate later spec (`@ergots/autolykos-v1`) if/when a concrete from-genesis archival consumer surfaces. **Out of scope.**

- **In-arm V3 gating (the 2e Upcast/Downcast pattern).** We use dispatcher-level gating in 2h-c.2 (registry entry gains optional `minVersion`). Rationale: sigma-rust gates `checkPow` at the `MethodDesc` level (BEFORE the eval function runs), so V3 reject incurs 0 cost. In-arm gating would charge the full 700 jit cost before throwing, diverging from sigma-rust on cost-parity. The 2e in-arm pattern (Upcast/Downcast at cost 10-15) is left untouched; its smaller cost makes the divergence invisible. Future V3-gated method handlers should prefer the new dispatcher-level path.

- **Re-exporting Autolykos symbols from `@ergots/ergoscript`'s public `index.ts`.** Consumers wanting the verifier should import directly from `@ergots/scorex`. Mirrors how `Header` / `AutolykosSolution` / `AvlTreeData` are consumed across packages.

- **Other V3-gated method handlers** (e.g., `SContext.getVarFromInput` at typeId 101, methodId 12). Not in 2h-c.2's surface; the new dispatcher infrastructure is available for any future handler that needs it but no new registrations beyond `checkPow` ship here.

- **Real-context cost validation (Layer C3).** Per-arm costs are sigma-rust-accurate but the C3 mainnet-corpus calibration is a separate phase 2j concern.

- **`AutolykosV1NotSupportedError` propagation through nipopow's existing verifier surface.** The change to `verifyAutolykosV2` (throw typed class instead of plain Error) is byte-identical to existing callers that don't `instanceof`-check; nipopow's `verifier.ts` gates v1 headers structurally (`version < V2_ACTIVATION_HEIGHT_MAINNET`) and never reaches the throw path. No behavior change for nipopow.

## Motivation

Phase 2h-c.1 wired 17 method handlers for chain-state Header access, including the 15 `SHeader.*` property accessors. The one remaining `SHeader` method — `checkPow` at methodId 16 — was intentionally deferred because it requires the Autolykos v2 PoW verifier, which until 2h-c.0 lived only in `@ergots/nipopow`. With scorex now in place as the shared codec layer between nipopow and ergoscript, and with the `Header` runtime type unified across both packages, the moment is right to promote the Autolykos verifier alongside.

The promotion serves three goals:

1. **Single source of truth for Autolykos v2.** Today `verifyAutolykosV2` lives in nipopow; ergoscript would need to either duplicate it (divergence risk) or reach into nipopow's source through a path import (boundary violation). Promotion to scorex puts both consumers on the same code path with the same oracle-validated fixtures.

2. **`SHeader.checkPow` completes the SHeader method surface.** Real-world Ergo scripts that gate on header validity use `header.checkPow` (typically as `CONTEXT.headers(0).checkPow` to verify the previous block's PoW). Without this handler, any V3+ tree exercising checkPow rejects at the evaluator. The C2 mainnet-corpus uplift potential from this single handler is modest but real (a small fraction of complex DEX and oracle scripts include checkPow gating).

3. **Dispatcher-level V3 gating infrastructure.** The new `minVersion?: number` field on `HANDLERS` registry entries is a one-time investment that benefits every future V3+ method handler (and any V4+ handlers when those land). Centralizes the cost-parity-correct gate at the dispatch boundary.

The phase is **small in absolute terms** — one new method handler + a mechanical file move + a small dispatcher upgrade + one new typed error class + one new `EvalError` code. Most of the implementation work is the migration (move files, flip imports, regenerate test paths). The handler itself is a ~30-line function (Pattern A cost + kind check + try/catch around `verifyAutolykosV2` + return Boolean).

## Architecture

### Migration: Autolykos v2 + nBits → `@ergots/scorex`

**File moves (mechanical, byte-identical content):**

```
packages/nipopow/src/autolykos-v2.ts       →   packages/scorex/src/autolykos-v2.ts
packages/nipopow/src/nbits.ts              →   packages/scorex/src/nbits.ts
packages/nipopow/test/autolykos-v2.*.ts    →   packages/scorex/test/autolykos-v2.*.ts
packages/nipopow/test/nbits.*.ts           →   packages/scorex/test/nbits.*.ts
```

Internal imports inside the moved files are unaffected: `autolykos-v2.ts` imports `blake2b256` from `./crypto/blake2b256` (still resolves — scorex has the same internal path) and `decodeCompactBits` from `./nbits` (still resolves — moved together). The existing `import type { Header } from '@ergots/scorex'` and `import { serializeHeaderWithoutPow } from '@ergots/scorex'` become same-package imports inside scorex; switch to relative paths (`from './header'`) at move time to avoid a circular self-import.

**Scorex public surface — mirror nipopow today (Q1 decision):**

```ts
// packages/scorex/src/index.ts — additive
export {
  calcBigN,
  autolykosMessage,
  buildAutolykosSeed,
  genIndexes,
  hashElement,
  verifyAutolykosV2,
} from './autolykos-v2';
export { decodeCompactBits } from './nbits';
export { AutolykosV1NotSupportedError } from './autolykos-v2';  // see Error model below
```

All 6 functions from `autolykos-v2.ts` plus `decodeCompactBits` from `nbits.ts` are public. No narrowing in this phase. The `verifyAutolykosV2` signature is unchanged: `(header: Header) => boolean`.

**Scorex directory layout — flat (Q2 decision):**

```
packages/scorex/src/
├─ autolykos-solution.ts
├─ autolykos-v2.ts          ← new (moved from nipopow)
├─ crypto/
├─ digests.ts
├─ errors.ts
├─ header.ts
├─ index.ts
├─ nbits.ts                 ← new (moved from nipopow)
├─ reader.ts
├─ vlq.ts
└─ writer.ts
```

PoW lives alongside `header.ts` / `autolykos-solution.ts` since it's conceptually adjacent to the block-Header types. Nesting under `pow/` is premature for 2 files.

**Scorex typed error class — `AutolykosV1NotSupportedError`:**

```ts
// packages/scorex/src/errors.ts — additive
export class AutolykosV1NotSupportedError extends Error {
  readonly code = 'autolykos-v1-not-supported' as const;
  constructor(message?: string) {
    super(message ?? 'Autolykos v1 PoW verification is not implemented');
    this.name = 'AutolykosV1NotSupportedError';
  }
}
```

Replaces the current `throw new Error('verifyAutolykosV2: Autolykos v1 is not supported')` in `verifyAutolykosV2`. The ergoscript handler does `instanceof AutolykosV1NotSupportedError` instead of message-substring matching. Byte-identical to existing callers that catch via generic `catch(e)`; only callers that need to dispatch on it benefit.

**Nipopow consumer update (one file):**

`packages/nipopow/src/verifier.ts` flips its import from `./autolykos-v2` to `@ergots/scorex`. No behavior change. The local files are deleted from `packages/nipopow/src/`.

**Ergoscript new import:**

`packages/ergoscript/src/eval/sheader-handlers.ts` (existing file from 2h-c.1) gains:

```ts
import { verifyAutolykosV2, AutolykosV1NotSupportedError } from '@ergots/scorex';
```

First runtime-behavior cross-package import from ergoscript into scorex (prior scorex imports were types and codec functions only). Pattern parallels ergoscript's existing import of `verifyAvlBatch` from `@ergots/avltree` (phase 2h-b).

**Cross-package coupling after 2h-c.2:**

```
@ergots/scorex@0.2.0     → @noble/hashes@2.2.0
@ergots/nipopow@0.2.1    → @ergots/scorex@0.2.0 (workspace), @noble/hashes@2.2.0
@ergots/avltree@0.2.0    → @noble/hashes@2.2.0
@ergots/ergoscript@0.3.0 → @ergots/scorex@0.2.0 (workspace), @ergots/avltree@0.2.0 (workspace), @noble/hashes@2.2.0, @noble/curves@2.2.0
```

**Version bumps (deferred per "before publishing we finish the library", documented in RELEASING.md for when the publish freeze lifts):**

- `@ergots/scorex@0.1.0 → 0.2.0` — additive public surface (Autolykos v2 + nbits + new error class).
- `@ergots/nipopow@0.2.0 → 0.2.1` — consumer-only change; no public-API delta on nipopow's own surface.
- `@ergots/ergoscript@0.2.x → 0.3.0` — additive (new method handler + new EvalError code + dispatcher upgrade).

### `SHeader.checkPow` method handler

**Registry entry — #39 (38 → 39):**

```ts
// packages/ergoscript/src/eval/method-call.ts — additive registration

HANDLERS.set('104:16', {
  handler: evalSHeaderCheckPow,
  minVersion: 3,  // V3 gate — checked by dispatcher, not handler
});
```

**Dispatcher upgrade — `minVersion?: number` field on registry entries:**

```ts
// packages/ergoscript/src/eval/method-call.ts — existing dispatcher path

interface HandlerEntry {
  handler: (obj: SValue, args: SValue[], ctx: EvalContext) => SValue;
  minVersion?: number;  // NEW — optional, defaults to 0 (always callable)
}

// Inside the dispatcher (before invoking entry.handler):
if (entry.minVersion !== undefined && ctx.treeVersion < entry.minVersion) {
  throw new EvalError(
    'tree-version-too-low',
    `method requires tree version >= ${entry.minVersion}, got ${ctx.treeVersion}`,
  );
}
```

**Cost-charging semantics of the dispatcher upgrade:**

MethodCall evaluation order (inherited from phase 2g.5, unchanged by this phase):

1. `MethodCall` arm's Pattern A envelope cost (4 jit cost) — charged BEFORE recursion.
2. Receiver expression evaluated — its accumulated cost is added.
3. Args expressions evaluated — their accumulated cost is added.
4. Handler lookup in registry.
5. **NEW (this phase)** `minVersion` check on the registry entry — throws `'tree-version-too-low'` if gate fails.
6. Handler invoked if gate passes — handler charges its own Pattern A cost (700 for `checkPow`) before its body runs.

**V3 reject result:** Total `ctx.jitCost` includes envelope (4) + receiver-eval cost + args-eval cost, but NOT the 700 handler cost. The exact integer depends on the receiver expression; the load-bearing invariant is `successCost - rejectCost === 700` (parallel-pair test in Phase 5). Sigma-rust-byte-equal: its `MethodDesc.min_version` check runs after the eval-function-arg evaluation but before the eval function itself.

**V3 success result:** Total cost = envelope (4) + receiver-eval + args-eval + handler (700). For the canonical realistic call `MethodCall(ByIndex(PropertyCall(Context, SContext.headers), 0), SHeader.checkPow)`: envelope (4) + Context arm cost (1) + headers PropertyCall (4 + 15) + ByIndex (30) + checkPow envelope (4) + checkPow handler (700) ≈ **758**. The exact integer comes from the Phase 3 fixture-gen oracle output; this spec does not pre-commit to it.

**Handler order of operations (post-dispatch, after minVersion gate passes):**

```ts
// packages/ergoscript/src/eval/sheader-handlers.ts — new export

import { verifyAutolykosV2, AutolykosV1NotSupportedError } from '@ergots/scorex';
import { EvalError } from './errors';
import type { SValue, EvalContext } from './eval-context';

export function evalSHeaderCheckPow(
  obj: SValue,
  _args: SValue[],
  ctx: EvalContext,
): SValue {
  // 1. Pattern A cost charge — mirrors sigma-rust eval/sheader.rs:116
  ctx.addCost(700);

  // 2. Defensive receiver kind check (reuses code from 2h-c.1)
  if (obj.kind !== 'Header') {
    throw new EvalError(
      'header-obj-not-header',
      `SHeader.checkPow expected obj to be Header, got ${obj.kind}`,
    );
  }

  // 3. Run verifier; catch typed v1 error and re-throw as EvalError
  try {
    const result = verifyAutolykosV2(obj.value);
    return { kind: 'Boolean', value: result };
  } catch (e) {
    if (e instanceof AutolykosV1NotSupportedError) {
      throw new EvalError(
        'autolykos-v1-not-supported',
        'Autolykos v1 PoW verification is not implemented (mirrors sigma-rust)',
      );
    }
    throw e;  // re-throw unexpected errors unwrapped
  }
}
```

**Error-code deltas (4 codes touched):**

| Code | Class | New / reused | Where thrown |
|---|---|---|---|
| `'tree-version-too-low'` | `EvalError` | reused (from 2e) | Dispatcher when `entry.minVersion > ctx.treeVersion` |
| `'header-obj-not-header'` | `EvalError` | reused (from 2h-c.1) | Handler's obj-kind check `obj.kind !== 'Header'` |
| `'autolykos-v1-not-supported'` | `EvalError` | **NEW** (46→47) | Handler's catch path when `verifyAutolykosV2` throws `AutolykosV1NotSupportedError` |
| `'autolykos-v1-not-supported'` | scorex `AutolykosV1NotSupportedError` | **NEW** class | `verifyAutolykosV2` when `header.version === 1` |

The new scorex error class and the new EvalError code share a string literal by intent — they document the same condition at different layers (scorex throws the typed class; ergoscript catches and re-throws the typed EvalError). The two layers stay decoupled: scorex defines what it throws; ergoscript decides what to surface to script-level callers.

### Cross-cutting guarantees (inherited unchanged)

- **Pure TS.** No `Buffer`, no `node:*`, no `globalThis.crypto`, no WASM. ESM only.
- **Deterministic.** No I/O, no clock, no PRNG, no `globalThis` reads.
- **Synchronous.** No async surface.
- **`@noble/hashes@2.2.0` + `@noble/curves@2.2.0`** — same pin as existing phases. No new runtime deps.
- **Cross-runtime.** vitest under both `node` and `jsdom`.
- **Browser-compat.** Both `verifyAutolykosV2` and `decodeCompactBits` are already browser-clean in their current nipopow location (no `Buffer`, no `node:*`); move to scorex preserves this.

## Implementation plan (6 phases, ~12-15 commits)

The work decomposes into 6 phases, each independently verifiable. Per `[[feedback-no-artificial-stops]]`: flat task list with per-task commits; no artificial mid-phase user gates beyond verification commands clean.

### Phase 1 — Promote Autolykos v2 + nBits into `@ergots/scorex`

- Move `packages/nipopow/src/autolykos-v2.ts` → `packages/scorex/src/autolykos-v2.ts`.
- Move `packages/nipopow/src/nbits.ts` → `packages/scorex/src/nbits.ts`.
- Update `autolykos-v2.ts` internal imports: `import { Header, serializeHeaderWithoutPow } from '@ergots/scorex'` → `from './header'` (avoid circular self-import).
- Add `AutolykosV1NotSupportedError` class in `packages/scorex/src/errors.ts`.
- Update `verifyAutolykosV2` to throw `AutolykosV1NotSupportedError` instead of plain Error on `header.version === 1`.
- Re-export from `packages/scorex/src/index.ts`: the 6 autolykos-v2 functions + `decodeCompactBits` + `AutolykosV1NotSupportedError`.
- Move tests: `packages/nipopow/test/autolykos-v2.*.ts` → `packages/scorex/test/`. Same for nbits tests.
- Update test internal paths: `../src/autolykos-v2` continues to resolve inside scorex; no path edits beyond rename.
- Update `packages/nipopow/src/verifier.ts` to import `verifyAutolykosV2` from `@ergots/scorex`.
- Delete the old files in `packages/nipopow/src/`.
- **Verification:** `npx tsc --noEmit` clean for all 4 packages; `npx vitest run` clean across all packages; existing tests pass unchanged.

### Phase 2 — Dispatcher upgrade for `minVersion` gating

- Add optional `minVersion?: number` to the handler registry entry type in `packages/ergoscript/src/eval/method-call.ts`.
- Update the dispatcher to check `entry.minVersion !== undefined && ctx.treeVersion < entry.minVersion` and throw `EvalError('tree-version-too-low')` before invoking the handler.
- TDD red: write a temporary scaffold test that registers a mock handler at an unused `(typeId, methodId)` slot with `minVersion: 99` and a body that would charge a sentinel cost (e.g., 999) AND set a `mockCalled = true` flag. Assert: V0..V7 trees calling the method throw `'tree-version-too-low'`; `mockCalled === false` (handler never invoked); `ctx.jitCost` does NOT include the sentinel 999.
- TDD green: implement the dispatcher check; scaffold test passes.
- **Scaffold cleanup:** the mock handler and its test are removed at end of Phase 4 (when the real `checkPow` handler exercises the same code path). The dispatcher upgrade itself stays.
- **No production handlers registered with `minVersion` yet.** The infrastructure is in place but unused until Phase 4.
- **Verification:** all existing 38 handlers pass their existing tests (no regression); the scaffold test passes.

### Phase 3 — Fixture-gen Rust-side oracle module

- Add `fixture-gen/src/sheader_checkpow.rs` (or extend an existing module). Iterates over a single chosen V2 mainnet header (loaded from `packages/nipopow/test/fixtures/headers/`).
- For the chosen header, build the Expr `MethodCall(ByIndex(PropertyCall(Context, SContext.headers), Const(SInt, 0)), SHeader.checkPow)` and emit a JSON fixture at `packages/ergoscript/test/fixtures/eval/sheader-checkpow-*.json` containing `{ exprBytes, expectedValue: true, expectedJitCost: <oracle> }`.
- The `expectedJitCost` is whatever sigma-rust's `try_eval_out` reports; the spec does not pre-commit to an exact integer because total cost includes receiver-expression evaluation cost (≈50 for `Context.headers(0)` per existing 2h-c.1 oracle data) plus the checkPow envelope (4) plus the handler (700). Implementers extract the integer from the oracle output.
- Determinism check: `cargo run -p fixture-gen --release` twice → byte-identical output.
- **Verification:** determinism clean; fixture file exists at the expected path; ready for Phase 4 to consume.

### Phase 4 — `SHeader.checkPow` handler implementation

- TDD red: write a test asserting `evaluateWith` on the Phase 3 fixture returns `{ kind: 'Boolean', value: true }` and `ctx.jitCost === <oracle integer>`. Fails until the handler is registered.
- Implement `evalSHeaderCheckPow` in `packages/ergoscript/src/eval/sheader-handlers.ts` per the order-of-operations above.
- Add `'autolykos-v1-not-supported'` to the EvalError codes union in `packages/ergoscript/src/eval/errors.ts`.
- Register the handler at `'104:16'` with `minVersion: 3` (uses the Phase 2 infrastructure).
- TDD green: handler tests pass.
- Remove the Phase 2 scaffold mock handler + its test.
- **Verification:** C1 oracle fixture round-trips byte-equal; cost-integer-equal to oracle; existing tests unchanged.

### Phase 5 — Throw-path and edge-case tests

The cost-correctness story is load-bearing for the dispatcher upgrade. Run each test as a **parallel pair** where applicable: build the same Expr graph, run once at V3 (success), run once at V<3 (reject), assert the cost delta isolates the 700 handler cost.

- **V<3 tree, parallel pair test:** parameterized over treeVersion=0,1,2. Build the C1 Expr graph; run `evaluateWith` once with `ctx.treeVersion = 3` (records success cost), once with `ctx.treeVersion = N` (asserts `EvalError('tree-version-too-low')`). Assert: `successCost - rejectCost === 700` (the V<3 path skipped exactly the handler cost; receiver eval and envelope are charged in both runs).
- **V3 tree, V1 header:** assert `EvalError('autolykos-v1-not-supported')`. Construct via direct `evaluateWith(tree, ctx)` with hand-built `ctx.headers = [v1Header]`. Assert `ctx.jitCost === <oracle integer>` (full cost charged — handler ran, threw inside the verifier).
- **V3 tree, non-Header receiver:** synthesize a V3 Expr where checkPow's receiver is a Long (constructed via direct AST manipulation; wire parser would catch this earlier). Assert `EvalError('header-obj-not-header')`. Assert `ctx.jitCost === <oracle integer minus handler-cost-not-charged-because-throw-happens-after-cost>` — actually since cost-700 is charged BEFORE the obj-kind check, full cost IS charged here. Update assertion: `ctx.jitCost === <oracle integer>`.
- **V3 tree, mutated-nonce V2 header:** assert returns `{ kind: 'Boolean', value: false }` (no throw; PoW just doesn't pass). Cost equals oracle integer.
- **V3 tree, valid V2 header (C1 fixture path):** assert `{ kind: 'Boolean', value: true }` AND `ctx.jitCost === <oracle integer>`. (Redundant with Phase 4 but lives in this file for organizational coherence with the throw-path siblings.)
- **Verification:** all tests pass; the parallel-pair cost-delta assertion holds on every parameterized V<3 case.

### Phase 6 — Mutation testing + facts files + spec self-review

- Mutation tests on the C1 oracle fixture bytes: single-byte flips at varied offsets. Target ≥ 90% kill rate. Mutations that flip the Boolean result count as killed; mutations that produce an upstream wire-layer throw (e.g., flipping the SHeader type code to an unknown variant) also count as killed.
- Update `facts/scorex.md`: flip Autolykos v2 from "Does NOT ship" to "Ships in v0.2.0"; add Source Mapping rows for `autolykos-v2.ts`, `nbits.ts`, and `AutolykosV1NotSupportedError`; add new error class to "Failure model" section.
- Update `facts/ergoscript-eval.md`: +Phase 2h-c.2 changelog block; +1 registry entry (39 total); +`'autolykos-v1-not-supported'` taxonomy entry (47 total); +dispatcher `minVersion` documentation.
- Update `facts/ergoscript.md`: registry count 38→39; error count 46→47; test count.
- Update `facts/nipopow.md`: remove "Autolykos v2 PoW verification (verifyAutolykosV2)" from internal-modules section; cross-ref scorex.md.
- Update `README.md`: scorex packages row test count; ergoscript packages row test count; "Total tests across packages" line.
- Spec self-review (this document): scan for placeholders, contradictions, scope ambiguity.
- **Verification:** facts files match implementation; `git diff` shows no orphaned drift between facts/spec/source/tests.

## Test strategy

### Layer C1 — per-handler oracle fixture (1)

One fixture generated by sigma-rust's `try_eval_out` oracle on a real mainnet v2 header (loaded from `packages/nipopow/test/fixtures/headers/`). Stores `{ exprBytes, expectedValue: true, expectedJitCost: 704 }`. Test parses-then-evaluates, asserts value byte-equal + jitCost equal.

Why only one fixture: the handler is a thin pass-through to `verifyAutolykosV2`, which already has its own corpus (the moved nipopow test files cover `verifyAutolykosV2` against ~20 real mainnet v2 headers). The C1 fixture exists to validate the **dispatch path** (method-call envelope cost + handler invocation + result wrapping into `SValue.Boolean`), not to re-validate the verifier internals.

### Layer C2 — throw-path tests (~5-6)

The exact `ctx.jitCost` integers come from the Phase 3 oracle (which captures receiver-eval + envelope + handler costs against sigma-rust's `try_eval_out`). The table below uses `<oracle>` for the success-path total and `<oracle - 700>` for the V<3 reject (handler cost skipped). The load-bearing delta is `successCost - V<3rejectCost === 700`.

| Test case | Asserts |
|---|---|
| V0 tree, checkPow call (parallel-pair) | `EvalError('tree-version-too-low')`; cost === `<oracle - 700>` (envelope + receiver-eval, NOT handler) |
| V1 tree, checkPow call (parallel-pair) | same as V0 |
| V2 tree, checkPow call (parallel-pair) | same as V0 |
| V3 tree, V1 header | `EvalError('autolykos-v1-not-supported')`; cost === `<oracle>` (full cost charged — handler ran, threw inside verifier) |
| V3 tree, non-Header receiver (Long, AST-synthesized) | `EvalError('header-obj-not-header')`; cost === `<oracle>` (handler's 700 charged BEFORE the obj-kind check) |
| V3 tree, mutated-nonce V2 header | returns `{ kind: 'Boolean', value: false }`; cost === `<oracle>` (no throw; PoW just doesn't pass) |
| V3 tree, valid V2 header at chain tip | returns `{ kind: 'Boolean', value: true }`; cost === `<oracle>` |

### Layer C3 — mutation testing (~5-8)

Single-byte flips across the C1 oracle fixture bytes. Target: ≥ 90% kill rate. Each mutation either:

- Flips the Boolean result → killed by C1's assertEqual.
- Causes an upstream wire-layer throw (e.g., flipping the SHeader type code → STypeParseError) → killed by typed-error catch.
- Causes the V3 gate to flip (e.g., flipping the tree-header version byte from 3 to 2) → killed by `'tree-version-too-low'`.
- Leaves the wire byte-identical (mutation lands in a no-op padding position) → tolerated; explicitly enumerated.

### Migration tests (Phase 1 verification)

The moved nipopow tests (`autolykos-v2.*.ts`, `nbits.*.ts`) must pass in their new scorex location without modification beyond path renames. Net test-count delta from migration: zero.

### Cross-runtime

All tests run under both `node` and `jsdom` (existing vitest workspace config). Mirrors phase 2h-c.1 convention.

### Fixture-gen Rust-side determinism

`cargo run -p fixture-gen --release` produces byte-identical output on consecutive runs. Existing CI gate continues to enforce this.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Dispatcher cost integer drift.** Sigma-rust's method-call envelope cost (4) is what we charge today via the `MethodCall` arm in 2g.5. If sigma-rust ever changes the envelope cost or we have a subtle off-by-one (e.g., we charge 4 but sigma-rust charges 5), the expected total cost drifts. | The Phase 3 oracle fixture pins the exact integer for `checkPow`. The Phase 5 parallel-pair test (V3 success vs V<3 reject on identical Expr graphs) isolates the 700 handler cost and is independent of envelope/receiver-eval drift. If a future sigma-rust upstream change moves the envelope cost, the Phase 3 fixture re-generation catches it before any handler test sees it. |
| **`AutolykosV1NotSupportedError` is a new public scorex symbol.** Adding it to scorex's public surface requires updating `facts/scorex.md` error-taxonomy section and bumping scorex's minor version. | Mirrors the existing `ReaderError` precedent in scorex 0.1.0. Add a new section to `facts/scorex.md` "Failure model" alongside the existing `ReaderError` documentation; add the class to "Public surface (v0.2.0)" header table; add Source Mapping row pointing at sigma-rust `AutolykosPowSchemeError::Unsupported`. |
| **Cost-not-charged-on-V3-reject assertion is load-bearing.** If the dispatcher's order is wrong (e.g., checks minVersion AFTER invoking the handler), the V<3 path would incorrectly charge the 700 handler cost. | Phase 5's parallel-pair test asserts `successCost - rejectCost === 700` on identical Expr graphs. Failing this delta is a regression flag, independent of any envelope/receiver-eval cost drift. |
| **Message-substring fragility avoided by typed error class.** An earlier design considered catching the v1 plain Error via message-substring match. That would break if scorex ever changes the error message. | We adopt the typed-class approach (`AutolykosV1NotSupportedError`) explicitly in this spec. ergoscript handler uses `instanceof`, not string matching. Future scorex message changes don't affect ergoscript. |
| **First runtime-behavior cross-package import in ergoscript.** Prior ergoscript imports from scorex were types + codec functions. This is the first call to a verifier function. | Pattern matches `@ergots/avltree` integration from 2h-b — runtime cross-package call. Low-risk pattern. nipopow has been calling `verifyAutolykosV2` since v0.1.0 and the function is fixture-validated. |
| **fixture-gen Cargo deps may need extension.** The new sheader-checkPow fixture-gen module needs sigma-rust's `ergotree-interpreter::eval::test_util::try_eval_out` (already used by the 2h-c.1 sheader fixture-gen). | Reuse the 2h-c.1 module as the template; checkPow is one more method-call form against the same `Header` oracle. No new sigma-rust crate dependencies needed. |
| **`autolykos-v1-not-supported` becomes vestigial if v1 ever lands.** When/if the v1 phase ships, this code's only emission point goes away. | Document as "reserved for ABI stability" in the eval-slice changelog at v1-landing time. Existing precedent: `'conjecture-not-implemented'` from 2g-medium (now structurally unreachable; kept declared). The string is cheap to retain. |
| **Working-tree pollution from move-and-delete operations.** Mixing git mv with content edits in the same commit can produce confusing diffs (git tracks rename via similarity-percentage). | Phase 1 commits in a specific order: first commit the file content moves with their existing content (git tracks as renames); subsequent commits in the same phase update internal imports and add the new error class. This keeps git's rename detection clean. |

## Open questions deferred to implementation

- **Should `decodeCompactBits` be exported from scorex's `index.ts`, or kept as an internal utility?** Q1's decision was "mirror nipopow today" — but in nipopow today, `decodeCompactBits` is exported only because `autolykos-v2.ts` and `verifier.ts` both consume it across files. In scorex, both consumers would be inside scorex's source tree, so it could stay internal. **Decision deferred to Phase 1 implementation:** if any downstream consumer outside scorex needs `decodeCompactBits` directly (e.g., a future wallet package), export it; otherwise keep internal. **Default for Phase 1: export it** (mirror today) and re-evaluate at v0.3.0 if surplus.

- **Should `asUnsignedByteArray` (currently private in `autolykos-v2.ts`) be promoted to a shared utility?** It's a generic helper that future consumers might want. **Decision: stays private** for now; promote when a second consumer emerges.

- **Test count target uplift.** Current: 3435 tests pre-phase. After 2h-c.2: target ~3445-3450 (+10-15 net). Migration is zero-delta; new fixtures and throw-path tests add ~10-15. Either way, no regression on the existing 3435. **Load-bearing acceptance criterion.**

## Verification commands (run after each phase, must be clean)

```bash
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
npx vitest run packages/scorex/
npx vitest run packages/nipopow/
npx vitest run packages/avltree/
npx vitest run packages/ergoscript/
cd fixture-gen && cargo build --release && cargo run --release    # determinism check
git status                                                         # working tree clean
```

All must be clean; no test count regression vs the pre-phase baseline of 3435.

## Cross-references

- `CLAUDE.md` — project conventions (TDD, browser-first rules, no-WASM, confidence-escalation)
- `facts/scorex.md` — gains Autolykos v2 + nBits public surface + `AutolykosV1NotSupportedError` error class
- `facts/ergoscript.md` — meta hub; registry count + test count refreshes
- `facts/ergoscript-eval.md` — primary contract surface gaining 1 handler-registry entry + 1 new EvalError code + dispatcher `minVersion` documentation
- `facts/nipopow.md` — remove Autolykos v2 from "internal modules" section; cross-ref scorex.md
- `docs/specs/2026-05-19-ergoscript-phase-2h-c-1-sheader-design.md` — predecessor (phase 2h-c.1, landed)
- `docs/specs/2026-05-19-ergots-scorex-package-design.md` — phase 2h-c.0 scorex extraction design (the foundation this phase builds on)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase plan; risks; validation strategy)
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/sheader.rs:115-124` — sigma-rust `checkPow` eval function (Pattern A, cost 700)
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/header.rs:101-111` — sigma-rust `Header::check_pow` (v1 returns Err)
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/autolykos_pow_scheme.rs:176-197` — sigma-rust `pow_hit` (v1 branch returns `pow_distance`, v2 branch runs full verification)
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/autolykos_pow_scheme.rs:322-324` — sigma-rust `AutolykosPowSchemeError::Unsupported` ("Checking proof-of-work for AutolykosV1 is not supported")
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/sheader.rs` — `MethodDesc` for `checkPow` with `min_version: ErgoTreeVersion::V3`
