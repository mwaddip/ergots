# `@ergots/transaction` — ContextExtension order preservation (consensus fix)

> Focused spec. 2026-06-16. Caught by the phase-3 capstone testnet false-reject
> walk (`--mode lib`) halting at h=224312, tx index 15, `script-reduced-false`
> on input 1.

## Problem

ergots **normalizes** the order of a spending input's context-extension entries
(ascending by `varId`) on a parse→serialize round-trip. The consensus reference
(sigma-rust) **preserves** the received wire order. Because the context
extension is part of `bytes_to_sign` (the signing message —
`packages/transaction/src/wire/_envelope.ts:86`), any on-chain transaction whose
extension entries are in **non-ascending** `varId` order produces a *different*
signing message under ergots than the one the spender actually signed → the
signature reduces to false → ergots **rejects a chain-valid transaction.**

This is a latent consensus fork in a published package: a hand-crafted tx with a
non-ascending context extension that the chain (and sigma-rust, and the JVM)
accept, ergots rejects. It is exactly the adversarial-input class CLAUDE.md
weights equal to the honest path — an honest compiler emits ascending order, so
the whole honest corpus (224k testnet blocks before tx15) never exercised it.

### Evidence (source, both sides)

| | parse | serialize | net |
|---|---|---|---|
| **sigma-rust** `ergotree-ir/src/chain/context_extension.rs:25,44-49,53-63` | `values: IndexMap<u8, Constant>`, inserts in wire-read order | `self.values.iter()` — **no sort** | **preserves received order** |
| **ergots** `packages/transaction/src/wire/input.ts:31,36,42` | plain object `{}` (JS auto-orders integer keys ascending) | explicit `.sort((a,b)=>a-b)` | **normalizes to ascending** |

`bytes_to_sign` re-serializes (sigma-rust `wallet/tx_context.rs:195,249`; ergots
`signingMessage` → `writeEnvelope`). Re-serialization is **not** the bug — both
re-serialize. The bug is that ergots' parsed representation *loses* order, so its
re-serialization can't reproduce the received order. sigma-rust's `IndexMap`
preserves order through parsing, so its re-serialization reproduces it. **No raw
signing-message-byte preservation is needed; the order only has to survive
parsing.**

> The `input.ts` doc comment (lines 16-19) anticipated this: *"If a future
> transaction fixture round-trip reveals non-canonical on-chain ordering, the
> fallback is span-capture."* The walk found that future tx. The lighter,
> faithful fix below (order-preserving structure) supersedes the span-capture
> fallback.

### Completeness audit — context extension is the *sole* order-normalization site

All three `.sort()` calls in the wire serializers were checked:
- `input.ts:42` (context extension) — **THE BUG.** Extension `varId`s may be in
  any order on-chain (spender's choice; sigma-rust `IndexMap` preserves it).
- `box-candidate.ts:191` / `serialize-svalue.ts:112` (box registers) —
  **faithful.** Registers are positionally canonical (densely packed R4→R9, no
  gaps possible on the wire), so ascending is the only valid order.

Every other section of `writeEnvelope` is tx-order or first-seen-order
(inputs, data-inputs, the token IndexSet, outputs) — all preserved.

## The fix

Change `ContextExtension.values` from an order-losing plain object to an
order-preserving `Map`, matching sigma-rust's `IndexMap` semantics exactly.

`packages/ergoscript/src/mir/types.ts:245`
```ts
export interface ContextExtension {
  values: Map<number, { tpe: SType; value: SValue }>
}
```
(Map keys are intrinsically present-or-absent, so the `| undefined` value-union
is dropped; `.get` already returns `T | undefined`.)

- `parseContextExtension` (`input.ts:29`): `new Map()`, `values.set(varId, {tpe, value})`
  in wire-read order.
- `serializeContextExtension` (`input.ts:41`): iterate `ext.values` (insertion =
  wire order), **drop the sort**. `w.writeVlqU(ext.values.size)`.

### Ripple

**(A) The one tsc-SILENT consensus-critical site — MUST be migrated by hand:**
- `packages/ergoscript/src/eval/evaluate.ts:129` — `for (const key of Object.keys(ctx.extension.values))`.
  This is the JVM-faithful adversarial guard that rejects self-extension keys
  outside `[0,127]` (`'context-extension-key-out-of-range'` — the JVM
  `toSigmaContext` crashes on a negative signed-Byte key ≥ 0x80, so ergots
  rejects pre-reduction). **`Object.keys(aMap)` returns `[]`** → under a `Map`
  the loop iterates nothing → **the guard silently stops firing → ergots starts
  accepting extensions the JVM rejects.** `tsc` does NOT flag `Object.keys()` on
  any value, so this is invisible to the gate. Change to
  `for (const k of ctx.extension.values.keys())` (keys are already `number` —
  drop the `Number(key)` coercion, keep the `k < 0 || k > 127` reject). This is
  the highest-priority edit in the whole fix — a missed consensus regression of
  exactly the adversarial class CLAUDE.md weights equally.

**(B) Lookup-by-id sites — `[id]` → `.get(id)`, mechanical, tsc-caught:**
1. `packages/transaction/src/validate/storage-rent.ts:59` — `extension.values.get(STORAGE_EXTENSION_INDEX)`
2. `packages/ergoscript/src/eval/method-call.ts:1194` — `…?.values.get(varId.value & 0xff)` (getVarFromInput)
3. `packages/ergoscript/src/eval/_substitute-deserialize.ts:187` — `ctx.extension.values.get(e.id)`
4. `packages/ergoscript/src/eval/get-var.ts:41` — `ctx.extension.values.get(e.varId)`

**(C) Serialize + parse rewrite:** `packages/transaction/src/wire/input.ts:29-50`
(the bug site — `new Map()`/`.set()` on parse, iterate-in-order/drop-sort on serialize).

**(D) Harness src — NOT a non-goal; the shared-type change forces these to keep
`tsc` green** (harness imports `ContextExtension` from the package, `strict` +
`noUncheckedIndexedAccess`):
- `tools/mainnet-validate/harness/src/validate-tx.ts:221` — `extension.values[…]` read → `.get(…)`
- `tools/mainnet-validate/harness/src/validate-tx.ts:352-369` (`buildContextExtension`) —
  `const values = {}` + `values[varId]=…` → `new Map()`/`.set()` (preserves its
  input-array order; the CAP-A upstream-JSON-order caveat is still deferred).

**(E) Construction sites — object literal → `new Map([...])`.** Only
`parseContextExtension` in package src. The rest are test fixtures + harness
builders. **`tsc` catches MOST but not all** — these are `as any`-cast or use
local structural types, so they are tsc-SILENT and need manual migration for
runtime correctness:
- `packages/transaction/test/validate/stateful-structural.test.ts:14,33` (`{values:{}}` under `as any`)
- `packages/transaction/test/validate/stateful-adversarial.test.ts:80,84` (local `Record` return type)
- `packages/transaction/test/wire/input.test.ts:22-29` (existing roundtrip, `as any`, ascending keys — see Test strategy)

### Cross-package contract — Task 1 (contract-first)

`ContextExtension` is exported from `@ergots/ergoscript` and consumed by
`@ergots/transaction`. The order-preservation guarantee is now **load-bearing**
(it is consensus-observable via the signing message). **`facts/ergoscript-eval.md:134`
literally documents `ContextExtension: { values: Record<number, …> }`** — flip
that line to `Map<number, …>` and state, **before** touching code: `values`
preserves wire/insertion order; consumers must not assume sorted order; and the
order is consensus-observable (it is re-serialized into `bytes_to_sign`). If
`facts/ergoscript-wire.md` references the extension wire codec, note the
no-resort guarantee there too.

## Test strategy (TDD)

The fix is a **byte-roundtrip** property — no signing key needed:

1. **RED (unit, the precise regression):** a hand-crafted context extension whose
   entries are in non-ascending `varId` order (e.g. `varId 5 → SLong`, then
   `varId 1 → SByte`). Assert `serializeContextExtension(parseContextExtension(bytes))
   === bytes`. Pre-fix: fails (re-emits ascending `1,5`). Post-fix: passes.
2. **Tx-level roundtrip:** a minimal `ErgoLikeTransaction` carrying such an input;
   assert `serializeTransaction(parseTransaction(txBytes)) === txBytes` **and**
   `signingMessage` is stable under the round-trip.
3. **Order-independent lookups stay green:** GetVar / getVarFromInput /
   substituteDeserialize / storage-rent tests must remain green (the `.get`
   migration is behavior-preserving for lookups).
4. **Guard the silent-regression site (ripple A):** the
   `context-extension-key-bound.test.ts` fixtures (`{values:{128:…}}`) MUST be
   migrated to real `Map`s — otherwise the out-of-range guard test passes
   *vacuously* (`Object.keys` on a plain-object fixture still "works") while the
   production `evaluate.ts:129` regression ships undetected. After migration the
   test must still RED if the `.keys()` change is reverted. This is the
   regression net for ripple (A).
5. **Full gate:** ergoscript + transaction vitest (node + jsdom) **+ harness
   typecheck** (ripple D forces harness edits), `tsc --noEmit` per package,
   build clean.

The committed non-ascending byte fixture is the regression net — it is the
precise red the walk's tx15 surfaced, reproduced without needing tx15's
(harness-unreachable) true on-chain bytes.

## Non-goals (explicitly out of scope here)

- **Harness CAP-A *behavior* (task #10).** The harness reconstructs tx bytes via
  ergo-lib-wasm `from_json`, which *also* loses extension order (JSON → JS object
  key reorder). So even post-fix the walk would feed ergots already-sorted bytes;
  exercising tx15 end-to-end needs the harness to preserve extension order from
  the node's raw JSON (or fetch binary). Separate dev-tooling change; does not
  gate this consensus fix or its unit regression. **NB:** the harness *type-compat*
  edits (ripple D) are in scope here (the shared-type change forces them to keep
  `tsc` green); only the order-from-JSON *behavior* is deferred.
- **Raw signing-message span-capture.** Unnecessary — order-preservation through
  parsing is sufficient and faithful to sigma-rust.

## SANTA — JVM-blessed cross-impl vector

Fold a non-ascending-extension **accept** vector into the existing tx-tier ask
(`prompts/santa-transaction-tier-conformance.md`): a tx whose input context
extension is serialized in non-ascending `varId` order, chain-valid → JVM blesses
**accept**. Pins the order-preservation rule across ergots + sigma-rust + JVM, so
no impl may silently re-sort. tx15 (`363d6222…`, h=224312) is the natural seed.
