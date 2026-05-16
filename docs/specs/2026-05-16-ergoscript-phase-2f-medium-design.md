# ErgoScript Interpreter — Phase 2f Medium (Chain-state Context + GlobalVars + GetVar + Option family + SelectField) Design Spec

**Status:** Draft
**Date:** 2026-05-16
**Package:** `@mwaddip/ergots-ergoscript` (phase 2f medium — chain-state Context wiring + 6 new arms)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec)
**Sister specs:**
- `docs/specs/2026-05-15-ergoscript-phase-2f-design.md` (phase 2f narrow — Box runtime + 7 Box-extract arms; established the chain-state-field YAGNI cut deferred to this slice)
- `docs/specs/2026-05-15-ergoscript-phase-2e-design.md` (`treeVersion?` plumbing precedent; OptionGetOrElse's V3-gated lazy semantics reuses that field)
- `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` (cost-charging Pattern A vs B precedent; defensive-recheck posture template)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-16 (post-phase-2f-narrow)

## Goal

Ship phase 2f medium: 6 new evaluator arms (`GlobalVars` dispatching on 6 internal cases, `GetVar`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `SelectField`); plumb chain-state fields onto `EvalOpts`/`EvalContext` (`height`, `selfBox`, `inputs`, `outputs`, `preHeader`, `extension`); introduce minimal `PreHeader` and `ContextExtension` runtime stubs.

By the end of phase 2f medium:

- **Coverage goes 27 → 33 of ~70 `Expr` arms** (8 from 2b + 3 from 2c + 4 from 2d-A + 2 from 2d-B + 3 from 2e + 7 from 2f narrow + **6 new in 2f medium:** `GlobalVars`, `GetVar`, `OptionGet`, `OptionIsDefined`, `OptionGetOrElse`, `SelectField`).
- **Public surface gains 6 optional fields on `EvalOpts`/`EvalContext`:** `height?: number`, `selfBox?: ErgoBox`, `inputs?: ErgoBox[]`, `outputs?: ErgoBox[]`, `preHeader?: PreHeader`, `extension?: ContextExtension`. All additive; no breaking changes.
- **New runtime types in `mir/types.ts`:** `PreHeader` (7 fields mirroring sigma-rust's `ergo-chain-types/preheader.rs`; `minerPk` is the only one consumed in this slice but the full struct lands now for forward compat), `ContextExtension` (`values: Record<number, { tpe: SType; value: SValue } | undefined>`).
- **Six new `EvalError` codes** (split across stops):
  - Stop α: `'context-field-missing'`
  - Stop β: `'get-var-type-mismatch'`, `'option-empty'`, `'option-input-not-option'`
  - Stop γ: `'select-field-index-out-of-range'`, `'select-field-input-not-tuple'`
- **No new runtime dependencies.** GroupGenerator's 33-byte secp256k1 generator is a hardcoded module constant — `@noble/curves` waits for phase 2g.

The slice splits into three stops with explicit `STOP α / STOP β / STOP γ` markers in `PLAN.md` so implementation can pause at any boundary.

## Non-goals (phase 2f medium)

- **Method/property call dispatch** (`MethodCall`, `PropertyCall`). The typed-value method invocation infrastructure (`box.value`, `box.id`, Coll methods, Header methods, etc.) lives in phase 2g+. Without method calls, the mainnet C2 corpus's 18 evaluable trees stay at `'not-implemented-yet'` despite GlobalVars + GetVar landing here.
- **Collection HOFs** (`Map`, `Filter`, `Fold`, `Exists`, `ForAll`, `Slice`, `Append`, `ByIndex`, `Size`). Phase 2g.
- **Sigma protocol primitives** (`@noble/curves`, structural `SigmaBoolean`, `Atleast`/`SigmaAnd`/`SigmaOr`). Phase 2g.
- **AVL+ membership-proof verification.** Phase 2h.
- **Byte-array conversions** (`ByteArrayToLong`, `LongToByteArray`, `ByteArrayToBigInt`). Phase 2f-broad or later.
- **Hash predefs** (`CalcBlake2b256`, `CalcSha256`, `DecodePoint`). Phase 2f-broad or later. (`ExtractId` from phase 2f narrow uses blake2b internally, but a public hash predef arm hasn't shipped yet.)
- **`SubstConstants`.** Later phase.
- **Additional `EvalContext` chain-state fields** beyond the 6 consumed in this slice: `dataInputs?`, `headers?` (full Header struct), and other Context-struct fields stay deferred until consumer arms appear (phase 2g+). The umbrella's "Phase 2f introduces chain-state fields" promise resolves over this slice + future ones (per the YAGNI cut from phase 2f narrow Decision #7).
- **`Header` runtime shape** beyond what `PreHeader` already covers. The full `Header` struct (with `id`, `parentId`, `adProofsRoot`, etc.) appears when `LastBlockUtxoRootHash` or Header method calls land — phase 2g or 2h.
- **Real-context cost validation (Layer C3).** Phase 2j.
- **Eval-level mutation testing.** Phase 2a's 6221-flip parse-mutation suite remains. Same deferral reasoning as 2c/2d/2e/2f-narrow.
- **`npm publish` of `@mwaddip/ergots-ergoscript`.** Separate user decision; not bundled with 2f medium.

## Architecture

### Directory layout

```
packages/ergoscript/src/
├── mir/types.ts                MODIFIED: add PreHeader + ContextExtension interfaces
├── eval/
│   ├── eval-context.ts         MODIFIED: 6 new optional fields on EvalOpts; makeContext spreads
│   ├── eval.ts                 MODIFIED: 6 new case lines (Stop α: 1; Stop β: 4; Stop γ: 1)
│   ├── global-vars.ts          NEW (Stop α): evalGlobalVars, 6-case dispatch on e.kind
│   ├── _group-generator.ts     NEW (Stop α): GROUP_GENERATOR_BYTES constant (33-byte secp256k1 generator)
│   ├── get-var.ts              NEW (Stop β): evalGetVar
│   ├── option-get.ts           NEW (Stop β): evalOptionGet
│   ├── option-is-defined.ts    NEW (Stop β): evalOptionIsDefined
│   ├── option-get-or-else.ts   NEW (Stop β): evalOptionGetOrElse, V3-gated lazy semantics
│   └── select-field.ts         NEW (Stop γ): evalSelectField
```

Each new arm is one exported function `eval<Variant>(e, env, ctx) => SValue`. Central `evalExpr` in `eval.ts` gains six new `case` lines across the three stops. `_group-generator.ts` underscore-prefix matches the existing `_byte-coll.ts` / `_box-synthesis.ts` / `_numeric.ts` convention for internal eval helpers.

### `EvalOpts` / `EvalContext` extension (Stop α, additive)

Current (post-phase-2e):

```ts
export interface EvalOpts {
  jitCostLimit?: number
  constants?: SValue[]
  treeVersion?: number
}
```

Extended (phase 2f medium Stop α):

```ts
export interface EvalOpts {
  jitCostLimit?: number
  constants?: SValue[]
  treeVersion?: number
  // NEW in 2f medium — chain-state fields consumed by GlobalVars + GetVar:
  height?: number              // current block height (u32); GlobalVars.Height reads this
  selfBox?: ErgoBox            // the spending box; GlobalVars.SelfBox reads this
  inputs?: ErgoBox[]           // transaction inputs; GlobalVars.Inputs reads this
  outputs?: ErgoBox[]          // transaction outputs; GlobalVars.Outputs reads this
  preHeader?: PreHeader        // pre-header of current block; GlobalVars.MinerPubKey reads .minerPk
  extension?: ContextExtension // context-extension key-value map; GetVar reads .values
}
```

`makeContext()` propagates all 6 new fields from `opts`. `EvalContext extends EvalOpts` so the fields inherit automatically.

YAGNI cut: 4 more chain-state fields from sigma-rust's `Context` struct (`dataInputs`, `headers`, `extension_provider`, full `Header` runtime shape) are NOT added in this slice — they have no consumer in 2f medium and would be unused declarations. Consistent with phase 2f narrow's Decision #7 precedent.

### `PreHeader` and `ContextExtension` runtime types (Stop α)

In `mir/types.ts`, add two new interfaces alongside the existing `ErgoBox`/`AvlTreeData`/`SigmaBoolean`/`Closure` stubs:

```ts
/**
 * Stub: pre-header of current block. Mirrors sigma-rust
 * `ergo-chain-types/preheader.rs::PreHeader`. Phase 2f medium consumes
 * only `minerPk` (via `GlobalVars.MinerPubKey`). Other fields are
 * present for forward-compat with phase 2g+ method-call arms
 * (`preHeader.height`, `preHeader.timestamp`, etc.).
 */
export interface PreHeader {
  /** Block version, u8 (currently 0..7). */
  version: number
  /** 32-byte parent block id. */
  parentId: Uint8Array
  /** Timestamp in ms since epoch (u64; stored as bigint for precision). */
  timestamp: bigint
  /** Difficulty target in Bitcoin-compact form (u32). */
  nBits: number
  /** Block height (u32). */
  height: number
  /** 33-byte compressed secp256k1 public key of the miner. */
  minerPk: Uint8Array
  /** 3-byte block votes (sigma-rust `Votes`). */
  votes: Uint8Array
}

/**
 * Stub: context extension key-value map. Mirrors sigma-rust
 * `chain/context_extension.rs::ContextExtension`. Phase 2f medium
 * consumes only `values` (via `GetVar`).
 *
 * `values` maps varId (u8, 0..=255) to a constant carrying both the
 * declared SType and the runtime SValue — same shape as
 * `ErgoBox.registers` (from phase 2f narrow). A missing key means the
 * variable is absent; `GetVar` returns Option None.
 */
export interface ContextExtension {
  values: Record<number, { tpe: SType; value: SValue } | undefined>
}
```

Both are forward-declared per the same pattern as `ErgoBox` (initially stubs; fields are stable for the boundary but new method-call arms in phase 2g may add evaluator-only fields).

### Dispatch pattern (all 6 new arms)

Every new arm follows the same shape as phase 2f narrow's arms:

1. **Charge cost** via `ctx.addCost(N)` — BEFORE eval-child for all 6 arms. Pattern A confirmed by source-read on each (`eval/global_vars.rs:14-49`, `eval/get_var.rs:12`, `eval/option_*.rs`, `eval/select_field.rs:15`).
2. **Eval children if any** (`GlobalVars` is a leaf; `GetVar` is a leaf; Option family + SelectField each have one child).
3. **Type-guard** the eval result if applicable (e.g., Option family arms verify `input.kind === 'Option'`).
4. **Defensive check** for required context fields (e.g., `GlobalVars.SelfBox` throws `'context-field-missing'` if `ctx.selfBox === undefined`).
5. **Arm-specific computation** producing the result SValue.

Step 4 is new to this slice — chain-state field access on `EvalContext` may legitimately receive `undefined` (callers building a non-chain-state-bearing context like phase 2b/2c tests). The defensive `'context-field-missing'` code surfaces this cleanly rather than panicking on undefined dereferences.

### Cost-charging order: Pattern A for all 6 arms

Source-read confirmed (sigma-rust eval files; see citations under "Semantics" below):
- GlobalVars: `ctx.add_jit_cost(N)?` at the start of each case arm; no eval-child (it's a leaf).
- GetVar: `ctx.add_jit_cost(10)?` at line 12; no eval-child.
- OptionGet: `ctx.add_jit_cost(15)?` at line 16, BEFORE `self.input.eval(env, ctx)?`.
- OptionIsDefined: `ctx.add_jit_cost(10)?` at line 15, BEFORE child eval.
- OptionGetOrElse: `ctx.add_jit_cost(20)?` at line 16, BEFORE input eval (default-eval is lazy at V3+ per V3 gate).
- SelectField: `ctx.add_jit_cost(10)?` at line 15, BEFORE child eval.

All Pattern A (envelope-first). Matches the `[[reference-cost-charging-order-patterns]]` memory.

### GroupGenerator: hardcoded constant

`GlobalVars.GroupGenerator` returns the secp256k1 generator point (compressed, 33 bytes). In sigma-rust this comes from `ergo_chain_types::ec_point::generator()` which constructs an `EcPoint` from k256's `ProjectivePoint::GENERATOR`. The compressed encoding is well-known and standardized: `02 79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798`.

For TS, we hardcode this 33-byte sequence in `_group-generator.ts`. No `@noble/curves` dependency. Phase 2g (sigma protocol) will introduce `@noble/curves` for full EcPoint arithmetic; until then, the generator's compressed bytes are sufficient.

Module:

```ts
// GROUP_GENERATOR_BYTES — secp256k1 base point (G) in compressed SEC1 form.
// Sigma-rust ref: ergo-chain-types/src/ec_point.rs::generator()
//   uses k256::ProjectivePoint::GENERATOR; the 33-byte compressed form is the
//   canonical SEC1 encoding (0x02 prefix for even-y, then 32-byte x-coordinate).
export const GROUP_GENERATOR_BYTES: Uint8Array = new Uint8Array([
  0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb,
  0xac, 0x55, 0xa0, 0x62, 0x95, 0xce, 0x87, 0x0b,
  0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28,
  0xd9, 0x59, 0xf2, 0x81, 0x5b, 0x16, 0xf8, 0x17,
  0x98,
])
```

The fixture-gen oracle confirms byte-equality against sigma-rust's `EcPoint::generator().sigma_serialize_bytes()`.

### No new shared helpers (yet)

Following the YAGNI / promote-on-third-caller pattern: the existing `bytesToCollByteSValue` (from `_byte-coll.ts`) handles MinerPubKey's `Coll[Byte]` wrap. No new helpers needed in this slice. SelectField's `1-based → 0-based index` math is inline (single op).

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle. Per-arm semantics confirmed by source-read 2026-05-16:

**`GlobalVars`** (`eval/global_vars.rs:12-50`). Single MIR arm with internal dispatch on `e.kind`. The kind discriminator type matches what phase 2a's parser produces (`GlobalVarsKind` union in `mir/types.ts`).

| Case | Cost | Source field | Result |
|---|---|---|---|
| `Height` | Fixed(26) | `ctx.height` (`number`) | `{ kind: 'Int', value: ctx.height }` |
| `SelfBox` | Fixed(10) | `ctx.selfBox` (`ErgoBox`) | `{ kind: 'Box', value: ctx.selfBox }` |
| `Outputs` | Fixed(10) | `ctx.outputs` (`ErgoBox[]`) | `{ kind: 'Coll', elem: SBox, items: outputs.map(b => ({ kind: 'Box', value: b })) }` |
| `Inputs` | Fixed(10) | `ctx.inputs` (`ErgoBox[]`) | `{ kind: 'Coll', elem: SBox, items: inputs.map(b => ({ kind: 'Box', value: b })) }` |
| `MinerPubKey` | Fixed(20) | `ctx.preHeader.minerPk` (`Uint8Array(33)`) | `bytesToCollByteSValue(minerPk)` — Coll[Byte], NOT GroupElement |
| `GroupGenerator` | Fixed(10) | (none — hardcoded) | `{ kind: 'GroupElement', value: GROUP_GENERATOR_BYTES.slice() }` (defensive copy) |

Each case checks the required ctx field BEFORE the cost charge — wait no, cost charged FIRST (Pattern A), THEN field-presence check. If `ctx.selfBox === undefined`, throw `'context-field-missing'`. The cost charge happens regardless (matches sigma-rust which panics on `Option::unwrap` after the cost charge — our defensive throw is cleaner but cost-equivalent).

**`GetVar`** (`eval/get_var.rs:11-23`). Leaf arm; no children. Cost `Fixed(10)` charged first. Body:

1. Charge `Fixed(10)`.
2. Defensive check: if `ctx.extension === undefined`, throw `'context-field-missing'`.
3. Read `ctx.extension.values[e.varId]`. If undefined → return `{ kind: 'Option', elem: e.varTpe, value: null }`.
4. If defined, compare `entry.tpe` to `e.varTpe` via `sTypeEquals`. On match → `{ kind: 'Option', elem: e.varTpe, value: entry.value }`. On mismatch → throw `'get-var-type-mismatch'`.

Note: sigma-rust throws on type-mismatch (`TryExtractFromError` per line 16-19), NOT returns None. We surface as typed code `'get-var-type-mismatch'` (parallels phase 2f narrow's `'register-type-mismatch'`).

**`OptionGet`** (`eval/option_get.rs:10-28`). Unary. Cost `Fixed(15)` BEFORE eval-child. Body:

1. Charge `Fixed(15)`.
2. Eval `e.input` to an SValue.
3. If `input.kind !== 'Option'`, throw `'option-input-not-option'` (defensive; sigma-rust raises `UnexpectedExpr`).
4. If `input.value === null` (None), throw `'option-empty'` (sigma-rust raises `NotFound` per line 21).
5. Otherwise return `input.value` (the unwrapped Some payload).

**`OptionIsDefined`** (`eval/option_is_defined.rs:9-24`). Unary. Cost `Fixed(10)` BEFORE eval-child. Body:

1. Charge `Fixed(10)`.
2. Eval `e.input` to an SValue.
3. If `input.kind !== 'Option'`, throw `'option-input-not-option'`.
4. Return `{ kind: 'Boolean', value: input.value !== null }`.

**`OptionGetOrElse`** (`eval/option_get_or_else.rs:10-29`). Binary. Cost `Fixed(20)` BEFORE eval-input. **V3-gated lazy semantics on the default branch.**

Body:

1. Charge `Fixed(20)`.
2. Eval `e.input` (the Option) to an SValue.
3. If `input.kind !== 'Option'`, throw `'option-input-not-option'`.
4. If `(ctx.treeVersion ?? 0) >= 3`:
   - If `input.value !== null` → return `input.value` (default is NOT evaluated; lazy).
   - Else → eval `e.default` and return.
5. Else (V<3):
   - Always eval `e.default` first (eagerly — sigma-rust line 23 binds `default_v` upfront via `unwrap_or(default_v()?)`).
   - If `input.value !== null` → return `input.value` (default's cost is already charged but the value is discarded).
   - Else → return the (already-evaluated) default.

The TS implementation expresses this with a single `if` on `ctx.treeVersion`. The V3-gated drift mirrors phase 2e's XorOf V0/V1-vs-V2+ semantic split — closing the pattern from `[[project-treeversion-gating-deferred]]` policy memory.

**`SelectField`** (`eval/select_field.rs:9-32`). Unary tuple accessor. Cost `Fixed(10)` BEFORE eval-child. Body:

1. Charge `Fixed(10)`.
2. Eval `e.input` to an SValue.
3. If `input.kind !== 'Tuple'`, throw `'select-field-input-not-tuple'`.
4. Compute `zeroBasedIndex = e.fieldIndex - 1` (sigma-rust's `FieldIndex::zero_based_index`; `field_index` is 1-based on the wire, matching ErgoScript's `t._1` / `t._2` syntax).
5. If `zeroBasedIndex < 0` or `zeroBasedIndex >= input.items.length`, throw `'select-field-index-out-of-range'`.
6. Return `input.items[zeroBasedIndex]`.

**Wire-format invariants** (held by phase 2a's parser, trusted by eval):
- `GlobalVars` parsed produces `{ tag: 'GlobalVars', kind: 'Height' | 'SelfBox' | 'Outputs' | 'Inputs' | 'MinerPubKey' | 'GroupGenerator' }`. Confirmed by `parse-svalue.ts` / `parse.ts` arms.
- `GetVar` parsed produces `{ tag: 'GetVar', varId: number, varTpe: SType }`. `varId` is u8 range (0..=255).
- Option arms: `input.post_eval_tpe == SOption`. Sigma-rust enforces at construction.
- `SelectField` parsed produces `{ tag: 'SelectField', input: Expr, fieldIndex: number }` (1-based).

Defensive eval-time kind-checks (`'option-input-not-option'`, `'select-field-input-not-tuple'`) guard against `ConstantPlaceholder` injection — same posture as phase 2c's `LogicalNot` / phase 2d-B's `And`/`Or` defensive checks.

## Validation strategy

Same three-layer discipline as 2c/2d/2e/2f-narrow.

### Layer C1 — per-arm fixture-gen oracles

**Six new fixture-gen Rust modules** under `fixture-gen/src/cmds/ergoscript/eval/`:

- `global_vars.rs` — 6 happy paths (one per case: Height, SelfBox, Outputs, Inputs, MinerPubKey, GroupGenerator) + 1 cost-limit entry. ~7 entries.
- `get_var.rs` — happy paths: var present + matching type (varied SType: SLong, SInt, SColl[SByte]); var absent (returns None); type-mismatch (throws). Plus cost-limit. ~7 entries.
- `option_get.rs` — happy path: Some(value) → unwraps; error path: None → throws `'option-empty'`. Plus cost-limit. ~4 entries.
- `option_is_defined.rs` — happy paths: Some → true, None → false. Plus cost-limit. ~4 entries.
- `option_get_or_else.rs` — happy paths × tree-version cases:
  - V<3: Some → returns Some value (but default is also evaluated); None → returns default.
  - V3+: Some → returns Some value (default NOT evaluated, only Some cost); None → returns default.
  - **Smoking-gun case**: `OptionGetOrElse(Some(42), expensiveDefault)` at V0 vs V3 should produce the same VALUE but DIFFERENT cost (V3 cheaper because default isn't evaluated). Lock this via two entries.
  - Cost-limit. ~6 entries.
- `select_field.rs` — happy paths: 1-based access on tuple (e.g., field 1 of `(SInt, SColl[SByte])`); field 2 of same. Error paths: out-of-range index (e.g., field 3 of 2-tuple); non-Tuple input (defensive). Cost-limit. ~5 entries.

**Total new C1 fixture entries:** ~33. Plus inline TS defensive tests for cases sigma-rust rejects at construction (`'context-field-missing'`, etc.) — ~6 more.

**Fixture-gen Context construction:** per phase 2f narrow Task 2's findings, `force_any_val::<Context>()` produces a v0 `self_box` ergoTree (incompatible with our TS SBox parser). The fixture-gen for 2f medium needs a controlled-Context helper that:
- Builds the `self_box`, `inputs`, `outputs` with `v1` ergoTrees (matching the existing `simple_box` / `box_with_one_token` helpers from `extract_*.rs` modules).
- Sets explicit `height` (e.g., 12345 — non-zero).
- Builds a `PreHeader` with controlled `miner_pk` (e.g., the GroupGenerator bytes for predictability).
- Builds a `ContextExtension` with explicit `values` (e.g., `{0: Constant::from(42i64)}` for GetVar fixtures).

This helper can live in `fixture-gen/src/cmds/ergoscript/eval/common.rs` (extending the existing common module). The implementer decides at task time whether to promote.

### Layer C2 — mainnet_boxes corpus

The existing `test/corpus-eval.test.ts` runs unchanged. **Expected outcome: still `success=0 not-impl=18 other=0`** — the 18 evaluable mainnet trees use method calls (`box.value`, `box.id`, etc.) AND collection HOFs which 2f medium doesn't touch. The aggregate `not-impl=18` and `success=0` are load-bearing; `other=0` confirms no undocumented codes.

The `'not-implemented-yet'` failure point will SHIFT deeper as GlobalVars + arms land (e.g., a tree that previously hit `'not-implemented-yet'` at `GlobalVars` will now progress to its first method call before failing). Informational only — the aggregate counts don't change.

### Layer C3 — eval mutation testing (deferred)

Phase 2a's 6221-flip parse-mutation suite remains. Same deferral reasoning as 2c/2d/2e/2f-narrow.

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. Phase 2f medium adds no new browser-incompatible primitives — all field reads are pure-TS, no hashes, no curve ops (GroupGenerator is a static constant).

### Determinism gate

After fixture-gen lands the new modules, `cd fixture-gen && cargo run --release -p fixture-gen` runs twice in succession; second invocation produces zero diff. Same gate as prior slices.

## Browser compatibility

Hard rules carried verbatim from 2a/2b/2c/2d/2e/2f-narrow, no new exceptions:

- All `Uint8Array`. Never `Buffer`.
- No `node:*` outside test files.
- No `globalThis.crypto` or `node:crypto`.
- No WASM dependencies.
- ESM only, ES2022 target.
- `bigint` for `SLong` / `SBigInt` and `PreHeader.timestamp`.
- No top-level `await`.

Phase 2f medium adds no runtime dependencies. The GroupGenerator constant is a hardcoded `Uint8Array` literal.

## Dependencies

Runtime: unchanged (`@noble/hashes` 2.2.0). No new deps.

Dev: unchanged.

## Error taxonomy

Six new codes on the existing `EvalError` class. No new error class; public surface unchanged.

| Code | Stop | Throw site | Meaning |
|---|---|---|---|
| `'context-field-missing'` (**NEW**) | α | `global-vars.ts`, `get-var.ts` | A chain-state field required by the current arm case is `undefined` on `ctx`. E.g., `GlobalVars.SelfBox` thrown when `ctx.selfBox === undefined`. Defensive against incomplete context construction. Message includes the field name and the arm case. |
| `'get-var-type-mismatch'` (**NEW**) | β | `get-var.ts` | The context-extension entry at `varId` exists, but its stored `tpe` differs from `e.varTpe`. Sigma-rust throws `TryExtractFromError` (`get_var.rs:16-19`) — surfaced as a typed code. Message includes the varId, expected SType, and stored SType. |
| `'option-empty'` (**NEW**) | β | `option-get.ts` | `OptionGet` called on a None Option. Sigma-rust raises `EvalError::NotFound` per `option_get.rs:21`. Message identifies the throw site. |
| `'option-input-not-option'` (**NEW**) | β | `option-get.ts`, `option-is-defined.ts`, `option-get-or-else.ts` | The arm's input evaluated to an SValue whose `kind !== 'Option'`. Wire-format invariants make this unreachable for parser-produced trees (sigma-rust enforces `input.post_eval_tpe == SOption` at construction time); defensive against `ConstantPlaceholder` injection. Message includes the actual kind. |
| `'select-field-index-out-of-range'` (**NEW**) | γ | `select-field.ts` | `SelectField.fieldIndex - 1` is outside `[0, items.length)`. Sigma-rust raises `EvalError::NotFound` per `select_field.rs:22-25`. Message includes the offending 1-based index and tuple length. |
| `'select-field-input-not-tuple'` (**NEW**) | γ | `select-field.ts` | The arm's input evaluated to an SValue whose `kind !== 'Tuple'`. Wire-format invariants make this unreachable; defensive. Message includes the actual kind. |

Plus inherited codes that may surface:
- `'cost-limit-exceeded'` — any `ctx.addCost` call once `jitCostLimit` is set.
- `'not-implemented-yet'` — any `Expr` variant not yet wired (now 33 are wired, ~37 remain).

Total `EvalError` codes after phase 2f medium: **28** (was 22 after 2f narrow; +6 from 2f medium).

## Sequencing

Per-arm execution with two-stage review (spec compliance + code quality) per task. **6 tasks total across 3 stops** (α: 1 task, β: 4 tasks, γ: 1 task with finalize bundled), with explicit STOP markers in PLAN.md so implementation pauses cleanly at any stop boundary.

### Stop α — EvalContext chain-state + GlobalVars (~4-5h)

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 1 | Chain-state fields + `PreHeader` / `ContextExtension` runtime types + `GlobalVars` arm + `_group-generator.ts` constant | `eval/global_vars.rs:12-50`; `chain/context.rs:30-55`; `ergo-chain-types/preheader.rs` | Bundles 4 things: (a) extend `EvalOpts`/`EvalContext` with 6 fields, propagate via `makeContext`; (b) add `PreHeader` + `ContextExtension` interfaces in `mir/types.ts`; (c) create `_group-generator.ts` with the 33-byte secp256k1 generator constant; (d) implement `evalGlobalVars` with 6-case dispatch. Cost: 26 for Height, 10 for SelfBox/Outputs/Inputs/GroupGenerator, 20 for MinerPubKey. C1 fixture: ~7 entries (one per case + cost-limit) + 1 inline defensive test for `'context-field-missing'`. ~4-5 hours. Largest task in the slice — bundles foundation. |

`STOP α` — natural commit+push state. Corpus re-run; facts updated with Stop α surface; memory updated; commit + push.

### Stop β — GetVar + Option family (~3-4h)

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 2 | `GetVar` arm + fixture | `eval/get_var.rs:10-23` | Fixed(10), reads `ctx.extension.values[varId]`. Type-assertion throws on mismatch. New EvalError codes: `'get-var-type-mismatch'`. C1 fixture: ~7 entries (varied SType happy paths + absent + type-mismatch + cost-limit) + 1 inline defensive test for `'context-field-missing'` when ctx.extension undefined. ~45 min. |
| 3 | `OptionGet` arm + fixture | `eval/option_get.rs:10-28` | Fixed(15) BEFORE eval-child. Unwraps Some, throws `'option-empty'` on None. New codes: `'option-empty'`, `'option-input-not-option'`. C1 fixture: ~4 entries (Some-unwrap, None-empty, cost-limit) + 1 inline defensive test for non-Option input. ~45 min. |
| 4 | `OptionIsDefined` arm + fixture | `eval/option_is_defined.rs:9-24` | Fixed(10) BEFORE eval-child. Boolean return. Reuses `'option-input-not-option'`. C1 fixture: ~4 entries (Some/None happy paths + cost-limit) + 1 inline defensive test. ~30 min. |
| 5 | `OptionGetOrElse` arm + fixture | `eval/option_get_or_else.rs:10-29` | Fixed(20). **V3-gated lazy default eval.** Largest arm in Stop β. C1 fixture: ~6 entries spanning V0/V1/V2 (eager) and V3+ (lazy), including the smoking-gun case (Some-with-expensive-default, cost differs between V<3 and V3+). Reuses `'option-input-not-option'`. Mirrors phase 2e's XorOf V0/V1-vs-V2+ pattern. ~1.5 hours. |

`STOP β` — natural commit+push state. Corpus re-run; facts updated; memory updated; commit + push.

### Stop γ — SelectField + finalize (~2-3h)

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 6 | `SelectField` arm + fixture + finalize | `eval/select_field.rs:9-32` | Fixed(10) BEFORE eval-child. 1-based → 0-based index conversion. Throws on OOB index and non-Tuple input. New codes: `'select-field-index-out-of-range'`, `'select-field-input-not-tuple'`. C1 fixture: ~5 entries (field 1 + field 2 of varied-shape tuples + OOB error + non-Tuple defensive + cost-limit) + 1 inline defensive test for non-Tuple. **Finalize** in same task: corpus re-run (`success=0 not-impl=18 other=0`); `facts/ergoscript.md` updates (Stop γ "Ships additionally" block; coverage line "33 of ~70 arms after phase 2f medium"; modify "Does NOT ship yet" entry to scope chain-state to just "Header runtime model" + the still-deferred fields); `project_ergots_direction` memory updated to "phase 2f medium shipped"; `MEMORY.md` index updated; commit + orchestrator-confirmed push. ~2-3 hours. |

`STOP γ` — phase 2f medium complete.

**Estimated wall clock totals:** Stop α ~4-5h, Stop β ~3-4h, Stop γ ~2-3h. Total ~9-12 hours across the 3 stops. Each task single-session-able; the full slice is multi-session.

The PLAN.md (overwritten at the start of phase 2f medium, same pattern as 2b → 2c → 2d-A → 2d-B → 2e → 2f narrow → 2f medium overwrites) holds these 6 tasks in detail with explicit `STOP α / STOP β / STOP γ` markers.

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | Phase 2f medium scope: 6 arms (`GlobalVars` + `GetVar` + Option family + `SelectField`) + 6 chain-state fields. Method-call dispatch + Coll HOFs deferred to phase 2g. | Bundle method-call dispatch into 2f medium (~20+h slice); skip Option family and defer to alongside Coll HOFs. | Cleanly delineates "chain-state context access" (this slice) from "typed-value method dispatch" (next slice). Option family is required by phase 2f narrow's `ExtractRegisterAs` output (which returns `Option[T]`) — without OptionGet, that arm's output is observable but un-consumable in fixtures. |
| 2 | Three-stop split: α (foundation + GlobalVars), β (GetVar + Option family), γ (SelectField + finalize). | Two-stop (γ folded into β); per-arm stop. | User preference for stops to call it a day. 3 stops at ~3 hours each match the cadence held since slice 2d-B. The α-β-γ cuts follow natural dependency clusters. |
| 3 | YAGNI cut: only 6 chain-state fields added (height, selfBox, inputs, outputs, preHeader, extension). The other 3 fields from facts/ergoscript.md's umbrella promise (dataInputs, headers, full Header runtime) defer to phase 2g/2h. | Pre-stub all 9 fields per umbrella's "Phase 2f introduces chain-state fields" promise. | Pre-stubbing fields with no consumers conflicts with phase 2f narrow's Decision #7 precedent. The umbrella promise resolves over the multi-phase 2f arc, not in one slice. Adding fields is purely additive — no breaking change later. |
| 4 | GlobalVars implemented as ONE arm with internal 6-case dispatch (matching MIR shape). | Six separate arm functions. | Sigma-rust's MIR has a single `GlobalVars` enum; TS mirror is a single arm with `switch (e.kind)`. Matches the existing `Collection` arm's "one tag, kind-discriminator" pattern from phase 2b. |
| 5 | GroupGenerator's 33 bytes hardcoded as a module constant; no `@noble/curves` dep. | Add `@noble/curves` now (premature; phase 2g territory); compute the generator from a secp256k1 helper. | The compressed SEC1 encoding of the secp256k1 generator is a well-known fixed value. Hardcoding is correct and avoids a runtime dep. Phase 2g introduces `@noble/curves` for ACTUAL EcPoint arithmetic (multiplication, addition); the generator constant on its own doesn't need a curves library. |
| 6 | `MinerPubKey` returns `Coll[Byte]`, NOT `GroupElement`. | Return `GroupElement` (intuitively "miner pubkey is a public key, which is a group element"). | Source-read: sigma-rust serializes `miner_pk` to bytes BEFORE returning (`global_vars.rs:43`). The ErgoScript spec types `MinerPubkey` as `Coll[Byte]`. We mirror exactly. |
| 7 | OptionGetOrElse uses V3-gated lazy semantics. At V<3 eagerly eval default; at V3+ lazy. Both produce same VALUE but different cost on Some-input. | Always lazy (diverges from sigma-rust V<3 behavior); always eager (diverges from V3+). | Source-read confirms sigma-rust splits behavior on `ctx.tree_version() >= ErgoTreeVersion::V3` (`option_get_or_else.rs:20`). Mirrors phase 2e's XorOf V0/V1-vs-V2+ pattern. The fixture-gen's smoking-gun case (Some with expensive default) locks the cost-difference at version boundary. |
| 8 | GetVar type-mismatch throws `'get-var-type-mismatch'` (NOT None). | Return Option None on mismatch (more "permissive" interpretation). | Sigma-rust `get_var.rs:16-19` throws `TryExtractFromError`. Returning None would silently accept type-confusion in user code. Throw matches sigma-rust + phase 2f narrow's `'register-type-mismatch'` precedent. |
| 9 | Defensive `'context-field-missing'` for chain-state field access. | Silently panic on `undefined` dereference; return a sentinel value. | Cleanly surfaces an incomplete-context construction bug. Matches the project's overall "throw typed code rather than panic" posture. Field-undefined is a real possibility for callers building lightweight contexts (e.g., phase 2c BinOp tests that don't need chain-state). |
| 10 | `PreHeader` and `ContextExtension` interfaces stub all the wire-format fields, not just the consumed ones. | Stub only `minerPk` on PreHeader and `values` on ContextExtension. | The wire-format types are stable; subsetting them creates a future-migration risk when phase 2g+ adds method-call arms (`preHeader.timestamp`, etc.). Phase 2f narrow's `ErgoBox` precedent has the full struct, not subsets. Forward-compat with no runtime cost. |
| 11 | Fixture-gen builds a controlled Context manually (v1 boxes everywhere) rather than using `force_any_val::<Context>` directly. | Use `force_any_val<Context>` and accept v0-tree fixtures (incompatible with TS SBox parser). | Phase 2f narrow Task 2 already established this pattern. The Context-builder helper goes in `fixture-gen/src/cmds/ergoscript/eval/common.rs` (or wherever Task 1 chooses). |
| 12 | Layer C3 eval mutation testing: still deferred. | Add per-arm mutation suite. | Same reasoning as 2c/2d/2e/2f-narrow. Budget better invested at phase 2g (Coll HOFs whose recursion has uncatchable parse-time bugs). |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| GroupGenerator 33-byte constant is wrong (typo in the hardcoded literal) | C1 fixture asserts the TS-emitted GroupElement equals sigma-rust's `EcPoint::generator().sigma_serialize_bytes()`. Byte-equality is the gate; a single wrong byte breaks the test. |
| MinerPubKey treated as GroupElement (wrong type) | Decision log #6 captures the Coll[Byte] decision with source cite. C1 fixture asserts SValue kind is `'Coll'` not `'GroupElement'`. |
| OptionGetOrElse V3 gate misimplemented (eager vs lazy inverted) | Smoking-gun C1 fixture: Some-input with expensive-default produces same VALUE at all versions but DIFFERENT cost (V<3 charges default's cost; V3+ doesn't). The cost-equality assertion catches inversion. |
| `force_any_val<Context>` produces v0 boxes the TS parser rejects | Decision log #11 + per-task PLAN entry. Controlled-Context helper in fixture-gen `common.rs`. Implementer verifies at task start. |
| `'context-field-missing'` triggers for legitimate test contexts that lack chain-state | The defensive check only fires when the corresponding arm reaches a case that NEEDS the field. Phase 2c/2d tests don't reach GlobalVars; phase 2f narrow tests use `Const(SBox, …)` so don't reach GlobalVars either. Only intentional GlobalVars/GetVar fixtures need the chain-state fields populated. |
| GetVar varId range — what does sigma-rust do for varId > 255? | Sigma-rust types `var_id` as `u8`, so >255 is unrepresentable at the type level. TS uses `number`; we don't add a range check — the parser produces values 0..=255 per wire-format invariant. |
| SelectField fieldIndex 0 (invalid; sigma-rust uses 1-based) | Source-read confirms 1-based: `fieldIndex 0` after `- 1` becomes `-1`, which fails the OOB check (`< 0`). C1 fixture includes a fieldIndex=0 entry expecting `'select-field-index-out-of-range'`. |
| PreHeader struct gets fattened later when phase 2g adds method calls | The 7 fields land in this slice (decision #10). Field shapes are stable per sigma-rust source. Phase 2g may add evaluator-only fields (e.g., cached `id`) but the wire-format fields don't change. |
| Subagent missing the V3 gate on OptionGetOrElse | Two-stage review per task. Spec-compliance reviewer cross-references this spec section + the PLAN's task description. Code-quality reviewer verifies the cost-equality fixture catches the gate behavior. |
| Determinism regression in fixture-gen | Two-run cargo check per task (same gate as prior slices). |
| Test count drift (~1686 → ~1746 expected) | Each Stop's finalize task updates the test count in `SESSION_CONTEXT.md` and the commit message. PLAN.md tracks per-task expected delta. |

## Open questions

All resolve via source-read or fixture-driven TDD at implementation time; none are blockers.

1. **Controlled-Context helper location in fixture-gen.** Best fit: `fixture-gen/src/cmds/ergoscript/eval/common.rs` (existing). Alternative: `eval/_box-builders.rs` co-located. Task 1 implementer decides.

2. **`PreHeader` and `ContextExtension` field shapes in fixture-gen** for the SBox-style stub-vs-real-construction. Task 1 implementer reads `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/chain/context.rs` + `ergo-chain-types/src/preheader.rs` to confirm the exact field layout when constructing fixtures.

3. **OptionGetOrElse cost telemetry when default's cost is non-deterministic** (e.g., default contains a `Const(SBox, …)` whose cost depends on box size). The C1 fixture uses fixed-cost defaults (e.g., `Const(SInt, 42)` which has Fixed(5) Const cost) so the V<3 vs V3+ cost difference is exactly the default-cost. ~Fixed.

4. **`GlobalVars.Outputs` empty Coll** — if `ctx.outputs === []`, should `'context-field-missing'` fire (treating empty as missing) or return an empty Coll? Decision: empty Coll is valid; only `undefined` triggers the throw. Sigma-rust treats `ctx.outputs.iter()` over empty as empty collection.

5. **`GlobalVars.Inputs` empty Coll** — same as Outputs. Empty is valid.

6. **SelectField on 1-tuple?** ErgoScript doesn't have unary tuples (smallest is 2-tuple). Sigma-rust's parser rejects 1-tuples at construction. No special handling needed in the arm.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella phase plan (2a–2j)
- `docs/specs/2026-05-15-ergoscript-phase-2f-design.md` — phase 2f narrow (sister; established the Box runtime + chain-state-field YAGNI cut deferred to this slice)
- `docs/specs/2026-05-15-ergoscript-phase-2e-design.md` — `treeVersion?` plumbing precedent; OptionGetOrElse's V3-gated lazy semantics reuses that field
- `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` — Pattern A vs Pattern B cost-charging-order precedent; defensive-recheck posture template
- `facts/ergoscript.md` — boundary contract; will be extended at Stop γ finalize
- `facts/proof.md` — sister contract for the proof package
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf`) — byte-format and implementation oracle. Phase 2f medium authoritative refs:
  - `ergotree-interpreter/src/eval/global_vars.rs:12-50` — GlobalVars eval (6 cases)
  - `ergotree-interpreter/src/eval/get_var.rs:10-23` — GetVar eval
  - `ergotree-interpreter/src/eval/option_get.rs:10-28` — OptionGet eval
  - `ergotree-interpreter/src/eval/option_is_defined.rs:9-24` — OptionIsDefined eval
  - `ergotree-interpreter/src/eval/option_get_or_else.rs:10-29` — OptionGetOrElse eval (V3-gated lazy)
  - `ergotree-interpreter/src/eval/select_field.rs:9-32` — SelectField eval
  - `ergotree-ir/src/chain/context.rs:30-55` — Context struct (canonical field names)
  - `ergo-chain-types/src/preheader.rs` — PreHeader struct
  - `ergotree-ir/src/chain/context_extension.rs` — ContextExtension struct
  - `ergo-chain-types/src/ec_point.rs::generator()` — secp256k1 generator (33-byte SEC1 encoding)
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical language spec (per-arm semantics, MinerPubkey type definition)
- Memories at finalize:
  - `project_ergots_direction.md` — updated to phase 2f medium shipped; next is phase 2g (sigma protocol; `@noble/curves` dep wave; unblocks Atleast/SigmaAnd/SigmaOr)
  - `reference_cost_charging_order_patterns.md` — Pattern A continues to apply for all 6 arms; no update needed
  - `project_treeversion_gating_deferred.md` — policy memory; OptionGetOrElse adds a new "tree-version-dependent semantics" arm (V3 lazy gate) — same family as XorOf V0/V1-vs-V2+ but doesn't introduce a new error code (the V3 gate is purely behavioral, not feature-gating); no policy memory update needed
  - `reference_source_first_discipline.md` — continues to apply (6 per-arm source-reads confirmed cost values + Pattern A + V3 gate placement + MinerPubKey-as-Coll[Byte] + 1-based fieldIndex)
