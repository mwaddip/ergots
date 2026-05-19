# `@ergots/ergoscript` Phase 2h-c.1 — SHeader runtime + 17 method handlers

**Status:** Draft
**Date:** 2026-05-19
**Package:** `@ergots/ergoscript` (additive within an existing workspace; depends on `@ergots/scorex@0.1.0` workspace alias added in 2h-c.0)
**Interface contracts:** `facts/ergoscript-eval.md`, `facts/ergoscript-wire.md` (both updated alongside implementation; facts files win on any interface disagreement)
**Brainstorm transcript:** this session, 2026-05-19
**Predecessor spec:** `docs/specs/2026-05-19-ergots-scorex-package-design.md` (phase 2h-c.0 — `@ergots/scorex` extraction, landed)
**Successor spec:** `docs/specs/<date>-ergoscript-phase-2h-c-2-checkpow-design.md` (future — `SHeader.checkPow` + Autolykos v2 verifier promotion)

## Goal

Wire 17 new method-call dispatch handlers (`MethodCall` / `PropertyCall`) for chain-state Header access in `@ergots/ergoscript`'s evaluator: 15 `SHeader.*` property accessors and 2 `SContext.*` additions (`headers` and `LastBlockUtxoRootHash`). Promote the previously-deferred `SHeader` SValue wire format from `'not-implemented-phase-2a'` to a fully-functional V3-gated parse/serialize. Introduce one new `EvalError` code and two new `SValueParseError`/`SValueSerializeError` codes. The `Header` type itself is imported from `@ergots/scorex` (no duplication).

Per the captured cross-package coupling: `@ergots/ergoscript` already declares `@ergots/scorex@0.1.0` as a workspace dep (added during phase 2h-c.0). No new runtime deps in 2h-c.1.

This phase is **additive** — no existing eval arms, method handlers, error codes, or SValue variants change semantically. Phase 2h-c.1 widens the evaluator's method-handler surface from 21 to 38 entries while leaving the 52/~70 `Expr` arm coverage unchanged.

## Non-goals

- **`SHeader.checkPow` method handler** (typeId 104, methodId 16). Pattern A Fixed(700) per `eval/sheader.rs:115-124`. V3-gated via `min_version: ErgoTreeVersion::V3` on the method desc. Requires Autolykos v2 PoW verifier access, which currently lives in `@ergots/nipopow/src/autolykos-v2.ts`. **Deferred to phase 2h-c.2**, which will also decide whether to promote Autolykos v2 into `@ergots/scorex` (likely yes, since both consumers will then need it).
- **Expr-arm `LastBlockUtxoRootHash`** (legacy opcode in the sigma-rust opcode table; currently emits `ExprParseError 'not-implemented-yet'`). The SContext-method form (`SContext.LastBlockUtxoRootHash` at typeId 101, methodId 9) is the supported access path. The Expr arm stays in `'not-implemented-yet'` — sigma-rust treats both forms as valid but no real script exercises the older Expr form in our fixture corpora.
- **Re-exporting `Header` / `AutolykosSolution` from `@ergots/ergoscript`'s public `index.ts`.** Consumers wanting these types should import directly from `@ergots/scorex`. Mirrors how `AvlTreeData` is consumed (its primary export lives at `mir/avl_tree_data.rs` and is not re-exported by `index.ts` either).
- **Additional `SPreHeader.*` accessors beyond the existing `.timestamp` from 2g.6.** Out of scope; deferred to phase 2i predefs alongside `Xor` and Bit-shift `SNumericTypeMethods`.
- **`SValue.kind === 'Box'` / `'AvlTree'` equality through `sValueEquals`.** Already documented as `'not-implemented-yet'` in `eval/sValueEquals.ts`. Not affected by 2h-c.1; `SValue.Header` equality similarly throws `'not-implemented-yet'` from `sValueEquals` (matches sigma-rust's per-arm structural-equality stance).
- **Real-context cost validation (Layer C3).** Cost values are sigma-rust-accurate per arm but the C3 mainnet-corpus calibration is a separate phase 2j concern.
- **C2 mainnet-corpus uplift** beyond what naturally falls out of the 17 new handlers. Coverage stays 52/~70 `Expr` arms; the corpus uplift run (if any) is a post-phase task.

## Motivation

Phase 2h-c.0 extracted `@ergots/scorex` and unified the codec layer + block-Header types across `@ergots/nipopow` and `@ergots/ergoscript`. The proximate driver of 2h-c.0 was *this* phase — `@ergots/ergoscript`'s need for a `Header` type that is byte-identical to what `@ergots/nipopow` reads from real mainnet proofs. With scorex in place, the `Header` runtime now exists in a single source of truth; 2h-c.1 wires it into the evaluator.

The 17 handlers add:

1. **Direct chain-state access for ergoscript-evaluated trees.** Real Ergo scripts dereference `header.height`, `header.stateRoot`, `header.minerPk` to gate on chain conditions. Without these handlers, the evaluator rejects any tree whose body reaches an SHeader property access — limiting our C2 mainnet-corpus coverage to scripts that touch headers only via the deprecated Expr-arm forms (which throw `'not-implemented-yet'`).
2. **The `SContext.headers` / `SContext.lastBlockUtxoRootHash` pair.** Both are real-world script primitives. `SContext.headers` is the standard access path to past block headers via `CONTEXT.headers(0)`. `SContext.lastBlockUtxoRootHash` is the canonical state-root reference used by many DEX and oracle scripts to verify AVL-tree membership against the chain's UTXO commitment.
3. **The V3 SHeader wire-format unlock.** A small but real fraction of script bytecode embeds SHeader values as segregated constants (test-generation fixtures, parameterized scripts that bake a known anchor header into their logic). Without the wire-format parse, those trees can't even reach the evaluator. The wire-format implementation is small (one delegating call to `parseHeader` from scorex) and worth shipping in the same phase.

The phase is small in absolute terms — 17 mechanical handlers + 1 SValue variant + 1 wire-format gate + 1 EvalContext field + 2 new error codes. The handlers are isomorphic by structure (Pattern A Fixed-cost + defensive obj-kind check + project a field), but each has its own source-mapping and oracle fixture. The shape mirrors phase 2h-b (13 SAvlTree handlers + AvlTreeData promotion), which delivered in one cohesive phase.

## Architecture

### Runtime SValue.Header variant

```ts
// packages/ergoscript/src/mir/types.ts — additive

import type { Header } from '@ergots/scorex'

type SValue =
  | ...                                          // existing variants
  | { kind: 'Header'; value: Header }            // NEW phase 2h-c.1
```

The inner `Header` type is **imported from `@ergots/scorex`** — not redeclared. This avoids the divergence risk that 2h-c.0 was specifically built to eliminate. `Header` is structurally identical to the type produced by `scorex/parseHeader`, including the in-process-derived `id: Uint8Array(32)` field.

The variant slots into the SValue discriminated union via its `kind` field; the central exhaustive `evalExpr` switch and the `sValueEquals` comparer get a `case 'Header':` arm (which throws `'not-implemented-yet'` for equality, matching sigma-rust's stance — Header equality is not a script primitive).

### Wire format: V3-gated SValue framing

The current `parseSValue` arm for `SHeader` emits `SValueParseError('not-implemented-phase-2a')`. Phase 2h-c.1 replaces this with a V3-gated delegation to `@ergots/scorex`'s `parseHeader`:

```ts
// packages/ergoscript/src/wire/parse-svalue.ts — concept (full code in implementation)

case 'SHeader':
  if (treeVersion < 3) {
    throw new SValueParseError('sheader-tree-version-too-low', ...)
  }
  return { kind: 'Header', value: parseHeader(r) }
```

**Signature change (option B from brainstorm):** the recursive `parseSValue` and `serializeSValue` functions gain a `treeVersion: number` parameter that threads through every nested call (e.g., parsing a `Coll[Header]` value recursively invokes the inner `SHeader` parse with the same `treeVersion`). Sigma-rust's mirror is `r.tree_version()` on `SigmaByteRead`; we keep the concern local to ergoscript rather than amending the scorex API.

Specifically:

```ts
// Before (current — phase 2h-b):
parseSValue(tpe: SType, r: ByteReader): SValue
serializeSValue(tpe: SType, v: SValue, w: ByteWriter): void

// After (phase 2h-c.1):
parseSValue(tpe: SType, treeVersion: number, r: ByteReader): SValue
serializeSValue(tpe: SType, v: SValue, treeVersion: number, w: ByteWriter): void
```

`parseTree` already extracts `treeVersion` from the header byte (`tree.header.version`); it injects this value at the entry point of constants-section parsing. `serializeTree` mirrors symmetrically. Every nested `parseSValue` call (within `Coll`, `Tuple`, `Option`) forwards the same `treeVersion`.

The `parseSType` / `serializeSType` functions for the `SHeader` type code (`104`) are **NOT** version-gated. The type code itself can legitimately appear in V<3 trees (e.g., as a method-result type on a `MethodCall` node that reads but never constructs a Header). Only SValue *framing* of a Header literal in the constants section requires V3+. This matches sigma-rust's split (`serialization/types.rs` has no version gate on `SHEADER = 104`; gate is only at `data.rs:196`).

### Method-handler registry: 21 → 38 entries

All 17 handlers register through the existing `eval/method-call.ts` dispatcher (`HANDLERS` registry keyed by `(typeId, methodId)`). Implementation lives in two files:

- `eval/sheader-handlers.ts` (NEW) — 15 SHeader accessor handlers + a shared internal helper `assertHeaderObj(obj)` that throws `EvalError('header-obj-not-header')` on `obj.kind !== 'Header'`.
- `eval/scontext-handlers.ts` (EXTENDED — currently holds `dataInputs` from 2g.5 and `preHeader` from 2g.6) — adds `headers` and `lastBlockUtxoRootHash` entries.

Cost convention: **all 17 handlers use Pattern A** (`ctx.addCost(N)` charged BEFORE accessing the receiver and projecting the field). Matches sigma-rust's `ctx.add_jit_cost(N)?` line preceding `obj.try_extract_into::<...>()?` in every eval function.

Full registry table (entries 22-38 of the unified handler registry; see `facts/ergoscript-eval.md` for the canonical table format):

| # | Method | typeId:methodId | Cost | Pattern | Returns | sigma-rust source |
|---|---|---|---|---|---|---|
| 22 | `SHeader.id` | 104:1 | 10 | A | `Coll[Byte]` (32; derived blake2b256, NOT on wire) | `eval/sheader.rs:22-26` |
| 23 | `SHeader.version` | 104:2 | 10 | A | `Byte` (u8 cast to i8) | `:16-20` |
| 24 | `SHeader.parentId` | 104:3 | 10 | A | `Coll[Byte]` (32) | `:28-32` |
| 25 | `SHeader.adProofsRoot` | 104:4 | 10 | A | `Coll[Byte]` (32) | `:34-38` |
| 26 | `SHeader.stateRoot` | 104:5 | 10 | A | `Coll[Byte]` (33) — see note | `:40-44` |
| 27 | `SHeader.transactionsRoot` | 104:6 | 10 | A | `Coll[Byte]` (32) | `:46-50` |
| 28 | `SHeader.timestamp` | 104:7 | 10 | A | `Long` (bigint from `number` field) | `:58-62` |
| 29 | `SHeader.nBits` | 104:8 | 10 | A | `Long` (bigint from u32 field) | `:64-68` |
| 30 | `SHeader.height` | 104:9 | 10 | A | `Int` (u32 cast to i32) | `:70-74` |
| 31 | `SHeader.extensionRoot` | 104:10 | 10 | A | `Coll[Byte]` (32) | `:52-56` |
| 32 | `SHeader.minerPk` | 104:11 | 10 | A | `GroupElement` (33-byte SEC1) | `:76-80` |
| 33 | `SHeader.powOnetimePk` | 104:12 | 10 | A | `GroupElement` (33); **33 zero bytes when null** | `:82-86` |
| 34 | `SHeader.powNonce` | 104:13 | 10 | A | `Coll[Byte]` (8) | `:88-92` |
| 35 | `SHeader.powDistance` | 104:14 | 10 | A | `BigInt`; **`0n` when null** | `:94-107` |
| 36 | `SHeader.votes` | 104:15 | 10 | A | `Coll[Byte]` (3) | `:109-113` |
| 37 | `SContext.headers` | 101:2 | 15 | A | `Coll[Header]` from `ctx.headers` | `eval/scontext.rs:58-70` |
| 38 | `SContext.lastBlockUtxoRootHash` | 101:9 | 15 | A | `AvlTree` synthesized from `ctx.headers[0].stateRoot` | `:83-99` |

**Notes on specific handlers:**

- **`stateRoot` (entry 26):** sigma-rust's `types/sheader.rs:127-128` declares the return type as `SType::SAvlTree`, but the eval returns `Vec<i8>` (33-byte Coll[Byte]) — confirmed by both `eval/sheader.rs:40-44` and the test at `:267-274` which uses `eval_out::<Vec<i8>>`. Our handler matches the eval (Coll[Byte] of 33 bytes), not the type-system declaration. The `try_eval_out` oracle confirms this is the runtime behavior.
- **`powOnetimePk` (entry 33):** sigma-rust calls `header.autolykos_solution.pow_onetime_pk.unwrap_or_default()`. `EcPoint::default()` returns `ProjectivePoint::default()` (k256's identity point), which `scorex_serialize` writes as 33 zero bytes (`ergo-chain-types/src/ec_point.rs:127-137`: `if caff.is_identity() { write [0u8; 33] } else { write caff.to_encoded_point(true) }`). For V2 headers where our `AutolykosSolution.powOnetimePk === null`, the handler returns `{ kind: 'GroupElement', value: new Uint8Array(33) }`.
- **`powDistance` (entry 35):** sigma-rust calls `.unwrap_or_default()` on `Option<BigUInt>` → 0. For V2 headers where our `AutolykosSolution.powDistance === null`, the handler returns `{ kind: 'BigInt', value: 0n }`.
- **`SContext.headers` (entry 37):** returns `{ kind: 'Coll', elem: { tag: 'SHeader' }, items: ctx.headers!.map(h => ({ kind: 'Header', value: h })) }`. Throws `EvalError('context-field-missing')` if `ctx.headers === undefined`. The `Header` objects in `ctx.headers` are passed through by reference (no defensive copy at this boundary; defense lives at the EvalContext-construction site).
- **`SContext.lastBlockUtxoRootHash` (entry 38):** synthesizes `{ digest: ctx.headers![0].stateRoot, treeFlags: 0b00000111, keyLength: 32, valueLengthOpt: null }` — `treeFlags: 0b111` means all three operations (insert/update/remove) allowed; matches sigma-rust's `AvlTreeFlags::new(true, true, true)`. Throws `EvalError('context-field-missing')` if `ctx.headers` is `undefined` OR empty.

**Defensive obj-kind checks:**

- All 15 `SHeader.*` handlers: defensive `assertHeaderObj(obj)` throws `EvalError('header-obj-not-header')` when `obj.kind !== 'Header'`. Unreachable for parser-produced trees; defensive against `ConstantPlaceholder` injection paths. Single new error code.
- Both `SContext.*` handlers: reuse `EvalError('context-obj-not-context')` (existing from phase 2g.5) for `obj.kind !== 'Context'`. No new code.

### EvalContext additions

```ts
// packages/ergoscript/src/eval/eval-context.ts — additive

interface EvalOpts {
  ...                          // existing fields unchanged
  headers?: Header[]           // NEW phase 2h-c.1
}
```

`Header` is the type imported from `@ergots/scorex`. Optional field; defaults to `undefined`. Sigma-rust uses `[Header; 10]` (fixed-size 10); the TS port relaxes to `Header[]` (variable). Handlers that dereference `ctx.headers[0]` (i.e., `lastBlockUtxoRootHash`) must check non-empty before indexing. Defaults: `evaluate(tree, opts)` inherits `opts.headers`; `evaluateWith(tree, ctx)` requires explicit setting.

### Error-code deltas

| Class | Code | New / reused | Where thrown |
|---|---|---|---|
| `EvalError` | `'header-obj-not-header'` | **NEW** (45→46) | All 15 SHeader handlers; defensive receiver check `obj.kind !== 'Header'` |
| `EvalError` | `'context-field-missing'` | reused (from 2f medium) | `SContext.headers` if `ctx.headers === undefined`; `SContext.lastBlockUtxoRootHash` if `ctx.headers === undefined` or empty |
| `EvalError` | `'context-obj-not-context'` | reused (from 2g.5) | Both new SContext handlers when `obj.kind !== 'Context'` |
| `EvalError` | `'method-not-implemented'` | reused | Already covered by the method-call dispatcher; no change |
| `SValueParseError` | `'sheader-tree-version-too-low'` | **NEW** | `parseSValue` SHeader arm when `treeVersion < 3` |
| `SValueSerializeError` | `'sheader-tree-version-too-low'` | **NEW** | `serializeSValue` SHeader arm when `treeVersion < 3` |

The `'not-implemented-phase-2a'` code on `SValueParseError` and `SValueSerializeError` drops `SHeader` from its emitting set after this phase. The code stays declared; it still throws for `SPreHeader`, `SContext`, `SGlobal`, `SAny`, `SString`, `SFunc`, `STypeVar`. Mirrors how `SBox` was removed from the set in 2f Stop α and `SAvlTree` in 2h-b.

### Cross-cutting guarantees (inherited unchanged)

- **Pure TS.** No `Buffer`, no `node:*`, no `globalThis.crypto`, no WASM. ESM only.
- **Deterministic.** No I/O, no clock, no PRNG, no `globalThis` reads.
- **Synchronous.** No async surface.
- **`@noble/hashes@2.2.0` + `@noble/curves@2.2.0`** — same pin as existing phases. No new runtime deps.
- **Cross-runtime.** vitest under both `node` and `jsdom`.

## Implementation plan (single linear phase)

The work decomposes naturally into 6 commits, each independently verifiable. The phase is linear — every commit depends on the previous landing cleanly. Per `[[feedback-no-artificial-stops]]`, flat task list with per-task commits; no artificial mid-phase user gates beyond verification commands clean.

### Step 1 — `SValue.Header` variant + EvalContext field

- Add `{ kind: 'Header'; value: Header }` to the `SValue` discriminated union in `mir/types.ts`; import `Header` from `@ergots/scorex`.
- Extend `EvalOpts` / `EvalContext` with `headers?: Header[]` in `eval/eval-context.ts`.
- Add `case 'Header':` arm to `sValueEquals` (`eval/svalue-equals.ts` or wherever it lives) throwing `'not-implemented-yet'`, matching the existing `Box` / `AvlTree` arms.
- Add `case 'Header':` arms to any other site that switches exhaustively on `SValue.kind` (TypeScript's exhaustiveness check via the `_exhaust: never` pattern will flag every missed call site at compile time — fix each one in this step).
- Note: the central `evalExpr` switch in `eval/eval.ts` is over `Expr.tag`, not `SValue.kind`, so it does not need updating in this step. `SValue.Header` instances enter the eval graph only through the new `PropertyCall` handlers (steps 3 and 4).
- **Verification:** `npx tsc --noEmit -p packages/ergoscript/tsconfig.json` clean; existing tests still pass (no semantic change).

### Step 2 — Wire format V3-gated parse + serialize

- TDD red: write a fixture-based test asserting `parseSValue(SHeader, treeVersion=3, r)` returns `{ kind: 'Header', value: ... }` byte-equal to scorex's `parseHeader`. The fixture is a synthesized V3 segregated-constants section containing one SHeader literal.
- Add `treeVersion: number` parameter to `parseSValue` / `serializeSValue` signatures (and all recursive call sites within Coll/Tuple/Option arms).
- Thread `treeVersion` from `parseTree` / `serializeTree` into the constants-section parse/serialize loop.
- Implement the SHeader arm in both functions, delegating to scorex's `parseHeader` / `serializeHeader` for the bytes; gate on `treeVersion >= 3`.
- Add `'sheader-tree-version-too-low'` to both `SValueParseError` and `SValueSerializeError` code unions.
- TDD red: V<3 negative test — assert `parseSValue(SHeader, treeVersion=2, r)` throws `SValueParseError('sheader-tree-version-too-low')`.
- **Verification:** new tests pass; existing tests unchanged; `npx tsc --noEmit` clean.

### Step 3 — 15 `SHeader.*` method handlers

- Add `eval/sheader-handlers.ts` with the shared `assertHeaderObj` helper and 15 handler functions.
- Add `'header-obj-not-header'` to `EvalError` codes in `eval/errors.ts`.
- Register the 15 entries in the method-call registry in `eval/method-call.ts` (typeId 104, methodIds 1-15). **Audit step:** before-and-after `git diff` on the registry confirms the +15 entries land at the documented (typeId, methodId) keys without overlapping any existing entry.
- For each handler, generate one oracle fixture via `fixture-gen` (Rust side) and one corresponding TS test asserting the fixture round-trip + jitCost match.
- TDD per handler: red (fixture exists, handler not registered) → green (registration + projection logic) → refactor.
- **Verification:** all 15 fixture tests pass; per-handler `jitCost` integer-equal to sigma-rust oracle; SValue return byte-equal where Coll[Byte]/GroupElement, value-equal where Long/Int/BigInt; defensive `'header-obj-not-header'` tested via a parameterized "non-Header receiver" case across 3 representative handlers.

### Step 4 — 2 `SContext.*` method handlers (`headers` + `lastBlockUtxoRootHash`)

- Extend `eval/scontext-handlers.ts` (existing file from 2g.5/2g.6) with the 2 new handlers.
- Register the 2 entries in `eval/method-call.ts` (typeId 101, methodIds 2 and 9).
- Generate 2 oracle fixtures (one per handler) plus negative tests for `'context-field-missing'` (both handlers) and `'context-obj-not-context'` (both handlers).
- **Verification:** all SContext-handler tests pass; cost values match oracle; throw paths covered.

### Step 5 — Mutation testing + wire round-trip fixtures

- Synthesize 4-6 V3 ErgoTree fixtures with embedded SHeader constants (drawn from nipopow's existing mainnet headers); assert `serializeTree(parseTree(b)) === b` byte-equal.
- Add mutation tests (~25-30 single-byte flips) on the synthesized fixtures; target ≥ 90% kill rate. Each mutation throws a typed error class OR is byte-identical (tolerated padding in `unparsedBytes` forward-compat region).
- **Verification:** mutation kill-rate target met; cross-runtime under node + jsdom.

### Step 6 — Facts files + spec self-review

- Update `facts/ergoscript-eval.md`: +Phase 2h-c.1 changelog block, +17 registry entries, +`'header-obj-not-header'` taxonomy entry, +`headers?: Header[]` on EvalOpts, +`'Header'` in SValue union table, +coverage uplift in summary.
- Update `facts/ergoscript-wire.md`: +`'sheader-tree-version-too-low'` codes on both parse + serialize taxonomies, +note removing `SHeader` from `'not-implemented-phase-2a'` set, +signature-change note on `parseSValue`/`serializeSValue`.
- Update `facts/ergoscript.md`: coverage row + refreshed test count.
- **Verification:** facts files match implementation; `git diff` shows no orphaned drift between facts and source/tests.

## Test strategy

### Layer C1 — per-handler oracle fixtures (17)

For each of the 17 handlers, one fixture generated by sigma-rust's `try_eval_out` oracle on a real mainnet header (loaded from `~/projects/ergots/packages/nipopow/test/fixtures/headers/`). Each fixture stores `{ exprBytes, expectedValue (JSON), expectedJitCost (number) }`. Tests parse-then-evaluate, assert value byte-equal + jitCost equal.

Format mirrors existing `test/fixtures/eval/savltree-*/`, `test/fixtures/eval/spreheader-*/` from prior phases.

### Layer C2 — wire round-trip (4-6 fixtures)

Synthesized V3 ErgoTrees with embedded SHeader constants in the segregated-constants section. Assert `serializeTree(parseTree(b)) === b` byte-equal. Coverage:

- 2 fixtures: V3 tree with one SHeader literal (different mainnet headers — V1 source + V2 source).
- 1 fixture: V3 tree with `Coll[Header]` of 3 SHeaders (tests recursive `treeVersion` threading through Coll arm).
- 1 fixture: V3 tree with `Option[Header] = Some(h)` (tests Option arm threading).
- 1 fixture: V3 tree with `Option[Header] = None` (tests the None tag path).
- 1 negative fixture: V2 (tree-version=2) tree containing an SHeader constant → expect `SValueParseError('sheader-tree-version-too-low')`.

### Layer C3 — throw-path tests (~10)

- `'header-obj-not-header'`: parameterized across 3 representative SHeader handlers (e.g., `id`, `height`, `minerPk`) with a non-Header receiver (e.g., a Long, a Tuple).
- `'context-field-missing'`: `SContext.headers` with `ctx.headers === undefined`; `SContext.lastBlockUtxoRootHash` with `ctx.headers === undefined` and `ctx.headers === []`.
- `'context-obj-not-context'`: both new SContext handlers with non-Context receiver.
- `'sheader-tree-version-too-low'` (parse): V<3 tree with SHeader literal → typed throw.
- `'sheader-tree-version-too-low'` (serialize): hand-constructed V<3 ErgoTree with `SValue.Header` constant → typed throw on `serializeTree`.

### Layer C3.a — mutation testing (~25-30)

Single-byte flips across the C2 wire-roundtrip fixtures. Target: **≥ 90% kill rate per fixture**. Each mutation either throws a typed wire-layer error class (`ErgoTreeParseError`, `ExprParseError`, `STypeParseError`, `SValueParseError`, `ReaderError`) OR is byte-identical (tolerated padding inside `Header.unparsedBytes` forward-compat region; explicitly enumerated).

### Cross-runtime

Every test runs under both `node` and `jsdom` (existing vitest workspace config). Mirrors phase 2g.5/2g.6/2h-b convention.

### Special V2-header coverage (3 fixtures)

- `powOnetimePk` on a V2 header → assert returned `GroupElement.value` is `new Uint8Array(33)` (33 zero bytes = identity-point encoding per `EcPoint::default()` → `scorex_serialize` write-zeros path).
- `powDistance` on a V2 header → assert returned `BigInt.value === 0n`.
- `version` on the same V2 header → asserts the `Byte` (2) value is returned (smoke test confirming V1/V2 both flow through the same handler shape).

### Fixture-gen Rust-side extension

Add `fixture-gen/src/sheader_handlers.rs` (or extend an existing module) iterating over a handful of mainnet headers (loaded from `~/projects/ergots/packages/nipopow/test/fixtures/headers/`), for each header building the 17 oracle calls and emitting JSON fixtures into `packages/ergoscript/test/fixtures/eval/sheader-*/`. Determinism: same input headers → identical fixtures across runs (matches `[[reference-source-first-discipline]]` discipline — fixture-gen IS the oracle).

No new fixture-gen Cargo deps — `ergo-nipopow` (chain headers) and `ergotree-interpreter` (oracle) are already in `fixture-gen/Cargo.toml`.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **`stateRoot` quirk causes oracle divergence.** sigma-rust's eval returns `Coll[Byte]` despite the type system declaring `SAvlTree`. If a script's subsequent expression types stateRoot as SAvlTree (e.g., `header.stateRoot.digest`), the downstream method dispatch will throw on receiver kind. | We match the eval, not the type system — the fixture-gen oracle uses `eval_out::<Vec<i8>>` so our behavior matches sigma-rust's eval-time semantics. Real mainnet scripts that touch `stateRoot.*` would have failed in sigma-rust too; this is a sigma-rust internal inconsistency we mirror, not introduce. |
| **`powOnetimePk` identity-point encoding subtly wrong.** Could write the 33-byte identity as something other than 33 zero bytes (e.g., SEC1 compressed identity is `[0x00]` single byte, but the on-wire convention is fixed 33 bytes). | Source-confirmed at `ec_point.rs:127-137`: identity → `[0u8; 33]`. Direct fixture test: V2 header → `powOnetimePk` handler → assert `value === new Uint8Array(33)` byte-equal. Cross-check against oracle. |
| **`treeVersion` threading misses a recursive callsite.** Adding the parameter to every `parseSValue` / `serializeSValue` recursion is mechanical but easy to miss one (e.g., a Tuple's inner type recursion). Result: V3-gating could silently leak through a Tuple-of-SHeader literal at V<3. | Exhaustive switch in `parseSValue` / `serializeSValue` makes a missing parameter a compile-time error (TS's exhaustiveness check on the SType discriminated union catches it). C2 fixture #1 (V3 + Coll[Header]) explicitly exercises the recursion. C3 negative fixture asserts V<3 rejection. |
| **Method-call registry conflict.** Adding 17 entries at typeIds 104:1-15 and 101:2 / 101:9 — risk of collision with existing entries. | Current 21 entries: `SBox.tokens` (99:8), `SContext.dataInputs` (101:1) / `.preHeader` (101:3), `SColl.*` (12:14/26/29), `SGlobal.groupGenerator` (106:1), `SPreHeader.timestamp` (105:3), and 13 `SAvlTree.*` (100:1-7, 100:9-14). No overlap at typeId 104. SContext additions 101:2 and 101:9 don't conflict with 101:1 and 101:3. Audit step in Step 3 explicitly diffs the registry pre/post. |
| **Spec drift from facts file.** Implementation lands but facts/ergoscript-eval.md or facts/ergoscript-wire.md doesn't get updated in the same commits. | Step 6 explicitly updates all three facts files in the final commit of the phase. Spec self-review (post-write) checks facts/spec consistency. |
| **Mutation kill-rate falls below 90%.** Some mutated bytes might pass through (e.g., flips in the `unparsedBytes` region of a Header literal). | Per-fixture enumeration of tolerated mutations is documented inline in the mutation test (matches phase 2h-b precedent). Genuinely-tolerated flips count as "killed" via the byte-identical-output path. |
| **Fixture-gen non-determinism.** If the Rust-side oracle uses `force_any_val::<Header>()` or any random source, fixtures will drift across runs. | Source headers come from on-disk fixtures (`packages/nipopow/test/fixtures/headers/`), not random generation. Oracle calls are deterministic functions of headers. Determinism check: `cargo run -p fixture-gen` twice in a row → byte-identical output. CI gate. |

## Open questions deferred to implementation

- **Should `SValue.Header` carry a defensive copy of the inner `Header` on construction?** Sigma-rust uses `Box<Header>` (single owner); our struct is `{ kind: 'Header', value: Header }` (direct reference). Defensive copy would protect against mutation through external references but adds cost. Decision: **no defensive copy at the `SValue` boundary**. `Header` fields are `Uint8Array`/`number`/`bigint`/`null` — mutation through `header.parentId[0] = 99` is technically possible but no eval-path code mutates these and the cost of per-construction copy is non-trivial. Match sigma-rust's reference semantics.
- **Should the `Coll[Header]` returned by `SContext.headers` defensively copy the items array?** Same answer — no defensive copy. Sigma-rust uses `Arc<[Header]>` (shared reference). Our equivalent is `Header[]` passed through.
- **Test count target uplift.** Current: 3388 tests pre-phase. After 2h-c.1: target ~3470 (+80). If wire-roundtrip + mutation fixtures expand beyond the 30-test estimate, the count may be higher. Either way, no regression on the existing 3388. **Load-bearing acceptance criterion.**

## Verification commands (run after each step, must be clean)

```bash
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
npx vitest run packages/scorex/
npx vitest run packages/nipopow/
npx vitest run packages/avltree/
npx vitest run packages/ergoscript/
cd fixture-gen && cargo build && cargo run    # determinism check
```

All must be clean; no test count regression vs the pre-phase baseline of 3388.

## Cross-references

- `CLAUDE.md` — project conventions (TDD, browser-first rules, no-WASM, confidence-escalation)
- `facts/scorex.md` — foundational `Header` + `AutolykosSolution` types consumed by this phase
- `facts/ergoscript.md` — meta hub; +cross-cutting guarantees inherited unchanged
- `facts/ergoscript-eval.md` — primary contract surface gaining 17 handler-registry entries + 1 new EvalError code + SValue.Header variant + EvalContext.headers field
- `facts/ergoscript-wire.md` — secondary contract surface gaining 2 new error codes (parse/serialize) + V3-gating note on parseSValue/serializeSValue signature
- `docs/specs/2026-05-19-ergots-scorex-package-design.md` — predecessor (phase 2h-c.0, landed)
- `docs/specs/2026-05-19-ergoscript-phase-2h-b-avltree-integration-design.md` — most-recent eval-phase precedent (SAvlTree integration; 13 handlers in one phase + AvlTreeData runtime promotion)
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — earlier method-handler-phase precedent (5 handlers + Global arm)
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase plan; risks; validation strategy)
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/sheader.rs` — per-handler eval reference (15 + checkPow)
- `~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/eval/scontext.rs` — SContext handler reference
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/sheader.rs` — method-desc declarations (method IDs, return types)
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/types/scontext.rs` — SContext method-desc declarations
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/serialization/data.rs` — V3-gated SHeader SValue parse + serialize references (lines 98, 196)
- `~/projects/ergots/external/sigma-rust/ergo-chain-types/src/ec_point.rs` — `EcPoint::default()` → 33 zero bytes (identity-point encoding) reference (lines 127-137)
