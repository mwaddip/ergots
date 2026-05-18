# ErgoScript Interpreter — Phase 2f (Narrow: Box-extract arms + SBox wire) Design Spec

**Status:** Draft
**Date:** 2026-05-15
**Package:** `@ergots/ergoscript` (phase 2f — narrow scope: 7 Box-extract arms + SBox wire parse/serialize + ErgoBox runtime extensions)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec)
**Sister specs:** `docs/specs/2026-05-15-ergoscript-phase-2e-design.md` (sister — lambdas + treeVersion + XorOf); `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` (cost-charging Pattern A vs B precedent)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-15 (post-2e)

## Goal

Ship phase 2f narrow: the 7 static Box-extract evaluator arms
(`ExtractAmount`, `ExtractScriptBytes`, `ExtractRegisterAs`,
`ExtractCreationInfo`, `ExtractBytes`, `ExtractBytesWithNoRef`,
`ExtractId`), close phase 2a's `'not-implemented-phase-2a'` gap for
SBox in the wire layer (add `parseSValue` / `serializeSValue` SBox
arms), and extend the `ErgoBox` runtime struct so register storage
carries per-register `SType` (needed by `ExtractRegisterAs`'s
type-assertion). Box canonical-bytes serializer ports in Stop γ
(reusable for the wallet phase).

By the end of phase 2f narrow:

- **Coverage goes 20 → 27 of ~70 `Expr` arms** (8 from 2b + 3 from 2c +
  4 from 2d-A + 2 from 2d-B + 3 from 2e + **7 new in 2f-narrow:**
  `ExtractAmount`, `ExtractScriptBytes`, `ExtractRegisterAs`,
  `ExtractCreationInfo`, `ExtractBytes`, `ExtractBytesWithNoRef`,
  `ExtractId`).
- **Wire-format surface extends:** `parseSValue(SBox, …)` and
  `serializeSValue(SBox, …)` ship (replacing phase 2a's
  `'not-implemented-phase-2a'` throw for SBox); `ErgoBox.registers`
  shape changes from `Record<number, SValue | undefined>` to
  `Record<number, { tpe: SType; value: SValue } | undefined>` (typed
  per-register carriage matching sigma-rust `Constant<'static>` in
  `NonMandatoryRegisters`).
- **Public surface additions:** none for `evaluate` / `evaluateWith` /
  `EvalError` / `EvalOpts` (no new chain-state fields in narrow scope
  — those land in phase 2f medium when `GlobalVars` / `GetVar` arms
  consume them).
- **Three new `EvalError` codes:** `'extract-input-not-box'` (defensive
  kind-check, all 7 arms), `'register-id-out-of-range'`
  (`ExtractRegisterAs` with id outside 0..=9), `'register-type-mismatch'`
  (`ExtractRegisterAs` with stored register `tpe ≠ e.elemTpe`; sigma-
  rust throws here, NOT `None`).
- **No new runtime dependency.** `ExtractId`'s blake2b-256 reuses the
  existing `@noble/hashes` pin from phase 2a. `@noble/curves` waits
  until phase 2g (sigma protocol).

The slice splits into three stops, each a natural commit+push state.
Per the brainstorm decision, `PLAN.md` will be sliced per-stop with
explicit `STOP α / STOP β / STOP γ` markers so implementation can pause
at any stop boundary.

## Non-goals (phase 2f narrow)

- **`GlobalVars` (HEIGHT / SelfBox / Outputs / Inputs / MinerPubKey /
  GroupGenerator).** The 6 context-accessor cases. Phase 2f medium.
  Until they land, Box values reach evaluation only via
  `Const(SBox, <literal>)` (now possible thanks to the SBox wire
  surface being added in Stop α).
- **`GetVar`.** Context-extension lookup. Phase 2f medium.
- **`Option` family (`OptionGet` / `OptionIsDefined` / `OptionGetOrElse`).**
  Phase 2f medium. Until those land, `ExtractRegisterAs`'s
  `Option[T]` return is observable in fixtures (the eval oracle
  produces `Some(v) | None`) but can't be unwrapped within a tree.
- **`SelectField`.** Tuple field access. Phase 2f medium.
- **`MethodCall` / `PropertyCall` dispatch.** Typed-value method
  invocation infrastructure (used by `box.value`, `box.id`, Coll
  methods, etc.). Phase 2g or later.
- **Byte-array conversions** (`ByteArrayToLong`, `LongToByteArray`,
  `ByteArrayToBigInt`). Phase 2f broad or later.
- **Hash predefs** (`CalcBlake2b256`, `CalcSha256`, `DecodePoint`).
  Phase 2f broad or later. (`ExtractId` internally uses blake2b-256
  via the existing `@noble/hashes` dep — but that's an arm-local call,
  not a publicly-dispatched predef.)
- **`SubstConstants`.** Inline constant substitution against a
  serialized script. Later phase.
- **`EvalContext` chain-state fields** (`height` / `selfBox` /
  `inputs` / `outputs` / `dataInputs` / `preHeader` / `headers` /
  `extension` / `vars`). All deferred to 2f-medium when their
  consumers (GlobalVars / GetVar) land. The umbrella's "Phase 2f
  introduces chain-state fields" promise resolves over the multi-phase
  2f arc, not in narrow scope.
- **Real-context cost validation (Layer C3).** Phase 2j.
- **Eval-level mutation testing.** Phase 2a's 6221-flip parse-mutation
  suite remains. Same deferral reasoning as 2c/2d-A/2d-B/2e.
- **`npm publish` of `@ergots/ergoscript`.** Separate user
  decision; not bundled with 2f narrow.

## Architecture

### Directory layout

```
packages/ergoscript/src/
├── mir/types.ts                MODIFIED: ErgoBox.registers shape extends to { tpe, value }
├── wire/
│   ├── parse-svalue.ts         MODIFIED: SBox arm added (replaces 'not-implemented-phase-2a')
│   ├── serialize-svalue.ts     MODIFIED: SBox arm added (symmetric)
│   └── ergo-box-bytes.ts       NEW (Stop γ): Box canonical-bytes serializer + bytesWithoutRef variant
└── eval/
    ├── eval.ts                 MODIFIED: 7 new case lines (Stop α adds 2, Stop β adds 2, Stop γ adds 3)
    ├── extract-amount.ts       NEW (Stop α): evalExtractAmount, Fixed(8) cost, BEFORE eval-child
    ├── extract-script-bytes.ts NEW (Stop α): evalExtractScriptBytes, Fixed(10) cost, BEFORE eval-child
    ├── extract-register-as.ts  NEW (Stop β): evalExtractRegisterAs, Fixed(50), R0..R9 dispatch
    ├── extract-creation-info.ts NEW (Stop β): evalExtractCreationInfo, Fixed(16), Tuple[Int, Coll[Byte]]
    ├── extract-bytes.ts        NEW (Stop γ): evalExtractBytes, Fixed(12), invokes ergo-box-bytes
    ├── extract-bytes-with-no-ref.ts NEW (Stop γ): evalExtractBytesWithNoRef, Fixed(12), invokes variant
    └── extract-id.ts           NEW (Stop γ): evalExtractId, Fixed(12), blake2b256(ExtractBytes output)
```

Each new arm is one exported function `eval<Variant>(e, env, ctx) =>
SValue`. The central `evalExpr` in `eval.ts` gains seven new `case`
lines across the three stops. Adding a new `Expr` variant to
`mir/types.ts` remains a compile-time error in the central switch via
`_exhaust: never`.

### `ErgoBox` struct extension (Stop α, additive)

Current (phase 2a stub, `mir/types.ts:66-84`):

```ts
export interface ErgoBox {
  value: bigint
  ergoTreeBytes: Uint8Array
  registers: Record<number, SValue | undefined>   // currently typed
  tokens: { id: Uint8Array; amount: bigint }[]
  creationHeight: number
  txId: Uint8Array
  index: number
}
```

Extended (phase 2f Stop α):

```ts
export interface ErgoBox {
  value: bigint
  ergoTreeBytes: Uint8Array
  registers: Record<number, { tpe: SType; value: SValue } | undefined>   // CHANGED
  tokens: { id: Uint8Array; amount: bigint }[]
  creationHeight: number
  txId: Uint8Array
  index: number
}
```

The reshape carries per-register `SType` alongside the `SValue`,
matching sigma-rust's `NonMandatoryRegisters` storing `Constant<'static>`
(which is `{ tpe: SType, v: Value }`). Required for
`ExtractRegisterAs`'s `tpe == e.elemTpe` assertion — without it the
type-assertion would have to be derived from the SValue's `kind`,
which fails for empty `Coll` and `None` `Option` shapes (the same
reason `ErgoTree.constantTypes` parallels `ErgoTree.constants` in
phase 2a).

`box_id` is intentionally NOT cached on the struct — see Decision log
#4. Sigma-rust caches via `calc_box_id()` for performance; the TS port
computes lazily in `ExtractId`'s arm body (Stop γ). No behavioral
divergence; just doesn't pre-pay the hash on every box parse.

### SBox wire parse/serialize (Stop α)

The phase 2a parser at `wire/parse-svalue.ts:45-50` deferred SBox with
`SValueParseError 'not-implemented-phase-2a'`. Stop α replaces the
throw with a real parser implementing sigma-rust's wire encoding from
`ergotree-ir/src/chain/ergo_box.rs:202-225` (`SigmaSerializable for
ErgoBox`). Symmetric serializer in `wire/serialize-svalue.ts`.

Read sequence (sigma-rust `ergo_box.rs:217-225` calls into
`ErgoBoxCandidate::parse_body_with_indexed_digests`, then reads
`TxId` and `u16` index):

1. `value` — VLQ u64 wrapped as `BoxValue` (use existing VLQ helper)
2. `ergo_tree_bytes` — read as size-prefixed bytes (the size is itself
   the next read; the consumed-bytes block becomes `ergoTreeBytes`).
   No recursive `parseTree` call here — the parent SValue parser
   stores the raw bytes; consumers who want the parsed tree can call
   `parseTree(ergoTreeBytes)` themselves.
3. `tokens` — VLQ count, then per-token: 32-byte token id + VLQ u64
   amount. Cap at `MAX_TOKENS_COUNT = 122` per sigma-rust constant.
4. `additional_registers` — VLQ count (range 0..=6 since only R4..R9
   are non-mandatory), then per-register: parse `SType` via existing
   `parseSType`, then parse `SValue` of that type via recursive
   `parseSValue`. Stored at keys `4..9` (slot index = 4 + position).
5. `creation_height` — VLQ u32
6. `transaction_id` — 32 raw bytes
7. `index` — `put_u16` writes BE u16 in sigma-rust per
   `ergo_box.rs:214`; check encoding (likely VLQ-encoded via sigma-ser
   `put_u16`; verify at task time). `ErgoBox.index` is `u16`.

Serialize is the symmetric write sequence. Round-trip invariant:
`serializeSValue(SBox, parseSValue(SBox, b)) === b` byte-for-byte.

Error path: new code on `SValueParseError`:
`'sbox-tokens-out-of-range'` (tokens count > 122),
`'sbox-registers-out-of-range'` (additional_registers count > 6).
Existing `'reader-truncated'` / `'vlq-overflow'` etc. surface as their
existing `ReaderError` codes.

### Box canonical-bytes serializer (Stop γ)

New module `wire/ergo-box-bytes.ts`. Exports two functions:

```ts
serializeBoxBytes(box: ErgoBox): Uint8Array            // full canonical bytes (matches sigma-rust sigma_serialize_bytes)
serializeBoxBytesWithoutRef(box: ErgoBox): Uint8Array  // omits tx_id + index (the "candidate" form)
```

Both write the same first-5-field block (value, ergoTreeBytes,
tokens, additional_registers, creation_height); `serializeBoxBytes`
then appends `transaction_id (32 bytes) + index (u16)`,
`serializeBoxBytesWithoutRef` stops after `creation_height`.

These functions consume the in-memory `ErgoBox` struct and produce
byte-for-byte the same output sigma-rust does — that's what
`ExtractId` requires (since `blake2b256(serializeBoxBytes(box))` must
equal sigma-rust's `box_id`).

The serializer is a separate file from `serialize-svalue.ts`'s SBox
arm because callers in `eval/extract-bytes.ts` consume it directly
(not through the SValue serializer's dispatch). The SBox arm in
`serialize-svalue.ts` is a thin wrapper that calls `serializeBoxBytes`
internally — same implementation either way.

### Dispatch pattern (all 7 Box-extract arms)

Every Box-extract arm follows an identical four-step shape:

1. **Charge cost** (`Fixed(N)`) via `ctx.addCost(N)` — BEFORE
   eval-child. Matches sigma-rust source for each arm (verified
   below). This is Pattern A from the cost-charging-order memory.
2. **Eval the unary child** (`e.input`) via `evalExpr`. The child
   evaluates a Box expression (typically `Const(SBox, …)` in 2f-narrow
   fixtures; `GlobalVars.SelfBox` once 2f-medium lands).
3. **Type-guard:** throw `'extract-input-not-box'` if the resulting
   value's `kind !== 'Box'`. Single-line check.
4. **Arm-specific extraction:** read or compute the result from
   `inputV.value` (the `ErgoBox` struct).

Steps 1-3 are identical across all 7 arms. A code comment notes the
duplication; no shared helper extraction yet (YAGNI per the
established slice-A/B/2e precedent — promote when the 8th caller
emerges, which would likely be Header-extract arms in phase 2g).

### No EvalContext chain-state additions (2f-narrow)

`EvalOpts` / `EvalContext` get NO new fields in 2f-narrow. The
`treeVersion?: number` field from phase 2e remains; no consumer in
2f-narrow reads it (the Box-extract arms don't have tree-version-
dependent semantics). When 2f-medium lands (GlobalVars + GetVar), it
adds `selfBox?`, `height?`, `inputs?`, `outputs?`, `dataInputs?`,
`preHeader?`, `headers?`, `extension?`, `vars?`. Splitting the chain-
state-fields addition out keeps 2f-narrow's surface change tightly
scoped to "Box runtime + 7 arms."

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative
oracle. Per-arm semantics confirmed by source-read 2026-05-15:

**`ExtractAmount`** (`eval/extract_amount.rs:9-25`). Cost `Fixed(8)`
charged BEFORE eval-child. Returns `{ kind: 'Long', value: box.value
}`. Defensive throw `'extract-input-not-box'` on `kind !== 'Box'`.

**`ExtractScriptBytes`** (`eval/extract_script_bytes.rs:9-25`). Cost
`Fixed(10)`. Returns `{ kind: 'Coll', elem: { tag: 'SByte' }, items: [
…box.ergoTreeBytes ] }` — each byte wrapped as `{ kind: 'Byte', value:
byte_as_signed_i8 }`. Wrapping is mechanical (helper
`bytesToCollByteSValue` shared with the bytes/id arms in Stop γ).

**`ExtractRegisterAs`** (`eval/extract_reg_as.rs:15-48`). Cost
`Fixed(50)`. Body:

1. Charge `Fixed(50)`, eval-child to a Box value, type-guard.
2. Validate `e.registerId` ∈ {0..=9}. Throw
   `'register-id-out-of-range'` otherwise (sigma-rust
   `register/id.rs:32-48` rejects ranges outside this).
3. Read the register:
   - **R0** (mandatory: value) → synthesize
     `{ tpe: { tag: 'SLong' }, value: { kind: 'Long', value:
     box.value } }`
   - **R1** (mandatory: script bytes) → synthesize
     `{ tpe: { tag: 'SColl', elem: { tag: 'SByte' } }, value: { kind:
     'Coll', elem: { tag: 'SByte' }, items: bytesToCollByte(box.
     ergoTreeBytes) } }`
   - **R2** (mandatory: tokens raw) → synthesize Coll of Tuple per
     token. `tpe = SColl(STuple([SColl(SByte), SLong]))`. Each
     item = `{ kind: 'Tuple', items: [collByte(token.id), { kind:
     'Long', value: token.amount }] }`. Helper
     `tokensToCollTupleSValue` lives in the arm file (R2 is the only
     caller; YAGNI promotion deferred).
   - **R3** (mandatory: creation info) → synthesize tuple. `tpe =
     STuple([SInt, SColl(SByte)])`. Value = `{ kind: 'Tuple', items:
     [{ kind: 'Int', value: box.creationHeight }, collByte(box.txId
     ++ BE_u16(box.index)) ] }`. The 34-byte byte-array is
     `txId (32) ++ index BE u16 (2)`. Matches sigma-rust
     `ergo_box.rs:187-192`.
   - **R4..R9** → read `box.registers[id]`; if `undefined`, return
     `{ kind: 'Option', elem: e.elemTpe, value: null }`.
4. Type-assertion: compare the stored register's `tpe` to
   `e.elemTpe` via existing `sTypeEquals` helper. If equal, wrap in
   `{ kind: 'Option', elem: e.elemTpe, value: registerValue }`. If
   unequal, throw `'register-type-mismatch'`. Note this is a THROW
   (matches sigma-rust `extract_reg_as.rs:41-44`), NOT `None`.
5. (R4..R9 missing → already returned None at step 3.)

Sigma-rust caches mandatory-register synthesis through
`get_register()`; TS does it inline per case for clarity. Identical
behavior. Cost is unaffected (cost charge happens before all of
this).

**`ExtractCreationInfo`** (`eval/extract_creation_info.rs:9-25`). Cost
`Fixed(16)`. Returns `{ kind: 'Tuple', items: [{ kind: 'Int', value:
box.creationHeight }, { kind: 'Coll', elem: { tag: 'SByte' }, items:
bytesToCollByte(box.txId ++ BE_u16(box.index)) }] }`. Same 34-byte
encoding as R3 above. Result `tpe = STuple([SInt, SColl(SByte)])`.

**`ExtractBytes`** (`eval/extract_bytes.rs:9-25`). Cost `Fixed(12)`.
Returns `{ kind: 'Coll', elem: { tag: 'SByte' }, items:
bytesToCollByte(serializeBoxBytes(box)) }`. Requires Stop γ's box
serializer.

**`ExtractBytesWithNoRef`** (`eval/extract_bytes_with_no_ref.rs:9-25`).
Cost `Fixed(12)`. Returns
`bytesToCollByte(serializeBoxBytesWithoutRef(box))`. Same shape, no-
ref variant.

**`ExtractId`** (`eval/extract_id.rs:10-28`). Cost `Fixed(12)`.
Returns `{ kind: 'Coll', elem: { tag: 'SByte' }, items:
bytesToCollByte(blake2b256(serializeBoxBytes(box))) }`. The hash is
the standard 32-byte blake2b-256. Uses `@noble/hashes/blake2.js`
(existing dep from phase 2a per `reference-noble-hashes-blake2`
memory).

**Cost-charging order: BEFORE eval-child for all 7 arms.** Pattern A
per the cost-charging-order memory. Confirmed by source-read on every
arm (`ctx.add_jit_cost(N)?` precedes `self.input.eval(env, ctx)?`).

**Wire-format invariants** (held by phase 2a's parser, trusted by
eval): `input.post_eval_tpe === SBox` for all 7 arms; sigma-rust's
`mir/extract_*.rs::new` enforces this at construction time.
Defensive eval-time kind-check guards against `ConstantPlaceholder`
injection (same posture as 2c/2d-B's `'bin-op-not-numeric'` /
`'coll-not-boolean'` patterns).

## Validation strategy

Same three-layer discipline as 2c/2d/2e. Cost validation continues
the C1/C2/C3 strategy.

### Layer C1 — per-arm fixture-gen oracles

**Seven new fixture-gen Rust modules** under
`fixture-gen/src/cmds/ergoscript/eval/`:

- `extract_amount.rs` — entries: SelfBox (via `Const(SBox, …)` once
  TS supports SBox wire; sigma-rust generates via `force_any_val
  <Context>` and constructs `Const(SBox, ctx.self_box)`), boxes with
  varied `value` field (0, 1, 1_000_000_000n, max u64), input kind
  mismatch (Const(SInt) — error fixture, expects
  `'extract-input-not-box'`). ~6 entries.
- `extract_script_bytes.rs` — entries: varied ergoTreeBytes lengths
  (empty 0-byte, 1-byte, real P2PK 35-byte, 1024-byte), kind
  mismatch. ~5 entries.
- `extract_register_as.rs` — entries spanning the R0..R9 dispatch:
  - **R0 / R1 / R2 / R3** happy paths with matching `elem_tpe`
    (SLong / SColl(SByte) / SColl(STuple(...)) / STuple(SInt,
    SColl(SByte))).
  - **R0 wrong type** (R0 is SLong; expect SInt) — error fixture,
    expects `'register-type-mismatch'`.
  - **R4..R9** happy paths with various stored types; one absent
    register (returns None).
  - **registerId = -1 / registerId = 10** — error fixtures, expect
    `'register-id-out-of-range'`.
  - Kind mismatch on input. ~12 entries total.
- `extract_creation_info.rs` — entries: varied
  `(creationHeight, txId, index)` tuples; kind mismatch. ~5 entries.
- `extract_bytes.rs` — entries: minimal box (smallest possible),
  realistic mainnet-shape box, box with multiple tokens + registers
  (exercises the serializer's chunking); kind mismatch. ~5 entries.
- `extract_bytes_with_no_ref.rs` — same shape, no-ref variant
  asserts; kind mismatch. ~4 entries.
- `extract_id.rs` — entries: minimal box (hash known), realistic
  box, deterministic box from a fixed seed (allows recomputation
  during debugging); kind mismatch. ~4 entries.

**Total new C1 fixture entries:** ~41. Each follows 2c's unified
schema: `{ name, tree_bytes_hex, opts_json, expected_value_json,
expected_cost, expected_error_code? }`. The
`force_any_val<Context>::self_box` provides realistic
`ErgoBox` values; trees use `Const(SBox, <box>)` so the C1 fixture
exercises both the new SBox wire parse path AND the eval arm in one
round-trip.

**Inline TS defensive tests** for cases sigma-rust can't generate
(input wire-format invariants prevent constructing trees with the
wrong input type):

- `evalExtractAmount` with hand-constructed `Const(SInt, 5)` input →
  `'extract-input-not-box'`. One inline test, mirroring 2c's
  `LogicalNot` / 2d-B's `And` precedent. Apply to all 7 arms (~7 inline
  tests, one per arm — could consolidate into a single parametrized
  test, judged at impl time).

**Total new test cases:** ~48 (41 fixture entries + 7 inline). Brings
ergoscript suite from 1609 → ~1657.

### Layer C2 — mainnet_boxes corpus

The existing `test/corpus-eval.test.ts` runs unchanged. **Expected
outcome: still `success=0 not-impl=18 other=0`** — the 18 evaluable
mainnet trees use higher-phase variants (GlobalVars `SelfBox`/`INPUTS`
access — phase 2f medium; method calls like `box.value` — phase 2g;
Coll HOFs — phase 2g). Box-extract arms alone don't unlock the
corpus.

Two corpus signals worth noting for the finalize task:

1. Once the SBox wire parser ships in Stop α, any mainnet tree that
   embeds a `Const(SBox, …)` literal becomes parseable through
   `parseSValue`. None do today (boxes always come from context in
   real-world contracts), but the parser-side guard `expect(other)
   .toBe(0)` confirms no regression.
2. The 18 evaluable trees that hit `'not-implemented-yet'` may change
   `tag` (the first untyped op the evaluator hits). Track but don't
   gate on this; the aggregate `not-impl=18` and `success=0` are
   load-bearing.

### Layer C3 — eval mutation testing (deferred)

Phase 2a's 6221-flip parse-mutation suite remains. Same reasoning as
2c/2d-A/2d-B/2e — budget better invested at HOFs (phase 2g, where
collection recursion has uncatchable parse-time bugs) or chain-state-
field plumbing in phase 2f-medium.

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. Phase 2f narrow adds no new
browser-incompatible primitives:

- SBox wire parsing reuses existing VLQ helpers
- Box canonical-bytes serializer is pure-`Uint8Array` byte-level work
- blake2b-256 is `@noble/hashes/blake2.js` (cross-runtime since
  phase 2a)

### Determinism gate

After fixture-gen lands the new modules, `cd fixture-gen && cargo run
--release` runs twice in succession; second invocation must produce
zero diff. Same gate as prior slices. The `force_any_val<Context>`
helper is gated by `TestRunner::deterministic()` per the existing
fixture-gen gotchas memory.

## Browser compatibility

Hard rules carried verbatim from 2a/2b/2c/2d-A/2d-B/2e, no new
exceptions:

- All `Uint8Array`. Never `Buffer`.
- No `node:*` outside test files.
- No `globalThis.crypto` or `node:crypto`.
- No WASM dependencies, direct or transitive.
- ESM only, ES2022 target.
- `bigint` for `SLong` / `SBigInt` and intermediate arithmetic.
- No top-level `await`.

Phase 2f narrow adds no runtime dependencies. `@noble/curves` waits
until phase 2g.

## Dependencies

Runtime: unchanged from prior slices (`@noble/hashes` 2.2.0). The
`ExtractId` arm imports `blake2b` from `@noble/hashes/blake2.js`
(same path used by the proof package per the
`reference-noble-hashes-blake2` memory).

Dev: unchanged.

## Error taxonomy

Three new codes on the existing `EvalError` class. No new error
class; public surface unchanged.

| Code | Throw site | Meaning |
|---|---|---|
| `'extract-input-not-box'` (**NEW**) | All 7 extract arms | The arm's `e.input` evaluated to an `SValue` whose `kind !== 'Box'`. Wire-format invariants (sigma-rust enforces `input.post_eval_tpe == SBox` at construction time) make this unreachable for parser-produced trees; defensive against `ConstantPlaceholder` injection and future MIR shape changes. Message includes the input's actual kind. |
| `'register-id-out-of-range'` (**NEW**) | `extract-register-as.ts` | `ExtractRegisterAs.registerId` is outside the 0..=9 range. Mirrors sigma-rust's `RegisterIdOutOfBounds` at `register/id.rs:30-46`. Message includes the offending id. |
| `'register-type-mismatch'` (**NEW**) | `extract-register-as.ts` | The stored register's `tpe` differs from `e.elemTpe`. Sigma-rust raises `EvalError::UnexpectedValue` at `extract_reg_as.rs:41-44`; we surface as a typed code for cleaner programmatic dispatch. Note: sigma-rust throws here, does NOT return None. Message includes the register id, the expected tpe, and the stored tpe. |
| `'cost-limit-exceeded'` (inherited from 2b) | `EvalContext.addCost` | Composite charge overshot `jitCostLimit`. |

Two new codes on `SValueParseError` (closing phase 2a's SBox gap):

| Code | Throw site | Meaning |
|---|---|---|
| `'sbox-tokens-out-of-range'` (**NEW**) | `parse-svalue.ts` SBox arm | Tokens count exceeds `MAX_TOKENS_COUNT = 122` per sigma-rust constant. |
| `'sbox-registers-out-of-range'` (**NEW**) | `parse-svalue.ts` SBox arm | Additional registers count exceeds 6 (only R4..R9). |

Existing `'not-implemented-phase-2a'` code on `SValueParseError`
remains — it still fires for `SAvlTree` / `SSigmaProp` / `SHeader` /
`SPreHeader` / `SContext` / `SGlobal` / `SAny` / `SString` / `SFunc`
/ `STypeVar`, which 2f narrow doesn't touch. SBox is removed from
that throw site's reach.

Total `EvalError` codes after phase 2f narrow: **22** (was 19 after
2e; +3 from 2f).

## Sequencing

Per-arm execution with two-stage review (spec compliance + code
quality) per task. Same subagent-driven discipline as 2c/2d/2e. **8
tasks total across 3 stops** (α: 3 tasks, β: 2 tasks, γ: 3 tasks),
with explicit STOP markers in PLAN.md so implementation pauses cleanly
at any stop boundary.

### Stop α — Foundation + 2 trivial arms (~4-5h)

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 1 | SBox wire parse + serialize, `ErgoBox.registers` shape extension | `ergo_box.rs:202-225`, `ergo_box.rs:62-80` | Largest task in the stop. Replaces phase 2a's `'not-implemented-phase-2a'` throw for SBox in `parse-svalue.ts` / `serialize-svalue.ts`. Adds 2 new SValueParseError codes. Reshape `ErgoBox.registers` from `Record<number, SValue>` to `Record<number, { tpe: SType; value: SValue }>` — touches `mir/types.ts` + every parser/serializer that constructs an ErgoBox value (currently none; phase 2a left this as a stub interface only — the extension is a forward-compatible breaking change in a phase-2a-internal type). Add SBox round-trip fixture to `wire/` corpus. ~2 hours. |
| 2 | `ExtractAmount` arm + fixture | `mir/extract_amount.rs`, `eval/extract_amount.rs` | Simplest of the 7. `Fixed(8)` BEFORE eval-child. Trivial field read (`box.value` → Long SValue). Adds 1 new EvalError code (`'extract-input-not-box'`) reused by all subsequent arms. Establishes the Box-extract template against the new dispatch pattern. C1 fixture (~6 entries) + 1 inline defensive test. ~1 hour. |
| 3 | `ExtractScriptBytes` arm + fixture | `mir/extract_script_bytes.rs`, `eval/extract_script_bytes.rs` | Trivial field-to-Coll[Byte] conversion. `Fixed(10)` BEFORE eval-child. Introduces the `bytesToCollByteSValue` helper (reused by ExtractCreationInfo + ExtractBytes / ExtractBytesWithNoRef / ExtractId in Stops β + γ). C1 fixture (~5 entries) + 1 inline defensive test. ~1 hour. |

`STOP α` — natural commit+push state. Corpus re-run (`success=0 not-
impl=18 other=0`); `facts/ergoscript.md` updated (1 new `EvalError`
code `'extract-input-not-box'`; 2 new `SValueParseError` codes
`'sbox-tokens-out-of-range'` and `'sbox-registers-out-of-range'`;
SBox `parseSValue` / `serializeSValue` postcondition update — SBox
no longer throws `'not-implemented-phase-2a'`; coverage line "22 of
~70 arms; 2 of 7 Box-extract arms shipped"); `project_ergots_direction`
memory updated to "phase 2f Stop α shipped"; commit + push.

### Stop β — Structural extractors (~2-3h)

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 4 | `ExtractRegisterAs` arm + fixture | `mir/extract_reg_as.rs`, `eval/extract_reg_as.rs`, `chain/ergo_box.rs:155-168` | Largest arm in the slice. `Fixed(50)` BEFORE eval-child. Dispatches R0..R9: R0..R3 synthesize from box fields (R2's token-Coll-of-Tuple is the gnarliest); R4..R9 read from `box.registers`. Type-assertion against `e.elemTpe` using existing `sTypeEquals` helper. Adds 2 new EvalError codes (`'register-id-out-of-range'`, `'register-type-mismatch'`). C1 fixture (~12 entries spanning R0..R9 + error paths) + 1 inline defensive test for input-not-box. ~1.5 hours. |
| 5 | `ExtractCreationInfo` arm + fixture | `mir/extract_creation_info.rs`, `eval/extract_creation_info.rs`, `chain/ergo_box.rs:187-192` | Returns `Tuple[Int, Coll[Byte]]`. `Fixed(16)` BEFORE eval-child. The 34-byte byte-array (`txId ++ BE_u16(index)`) reuses `bytesToCollByteSValue` from Stop α. C1 fixture (~5 entries) + 1 inline defensive test. ~45 min. |

`STOP β` — natural commit+push state. Corpus re-run; `facts/ergoscript.md`
updated (2 new `EvalError` codes `'register-id-out-of-range'` and
`'register-type-mismatch'`; coverage line "24 of ~70 arms; 4 of 7
Box-extract arms shipped"); `project_ergots_direction` memory updated
to "phase 2f Stop β shipped"; commit + push.

### Stop γ — Serializer + 3 hash extractors (~3-5h)

| # | Task | Sigma-rust ref | Notes |
|---|---|---|---|
| 6 | Box canonical-bytes serializer (`wire/ergo-box-bytes.ts`) | `ergo_box.rs:202-216`, `ergo_box.rs:195-198` | Port `sigma_serialize for ErgoBox` and the `bytes_without_ref` variant. ~100 lines TS. Round-trip invariant: `serializeBoxBytes(parseSValue(SBox, b))` equals the underlying wire bytes (modulo the outer SValue wrapping). Reusable for phase 3 wallet box construction. Standalone unit tests against fixture-gen-emitted box-bytes fixtures (separate from the eval arms). ~1.5 hours. |
| 7 | `ExtractBytes` + `ExtractBytesWithNoRef` arms + fixtures | `eval/extract_bytes.rs`, `eval/extract_bytes_with_no_ref.rs` | Both `Fixed(12)` BEFORE eval-child. Invoke `serializeBoxBytes` / `serializeBoxBytesWithoutRef` respectively; wrap result via `bytesToCollByteSValue`. C1 fixtures (~5 + ~4 entries) + 2 inline defensive tests. ~1 hour. |
| 8 | `ExtractId` arm + fixture + finalize (corpus + facts + memories + commit + push) | `eval/extract_id.rs`, `chain/ergo_box.rs:149-153` | `Fixed(12)` BEFORE eval-child. Body: `blake2b256(serializeBoxBytes(box))` → wrap as Coll[Byte]. First eval-time blake2b in the package — confirms cross-runtime hash agreement. C1 fixture (~4 entries) + 1 inline defensive test. **Finalize** in same task: corpus re-run (`success=0 not-impl=18 other=0`); `facts/ergoscript.md` updates (no new error codes — all 3 EvalError + 2 SValueParseError codes already documented across Stops α/β; coverage line bumped to "27 of ~70 arms after phase 2f narrow; 7 of 7 Box-extract arms shipped"; modify the "Does NOT ship yet" entry "Box / Context / Header chain-state model" to scope it to "Context / Header chain-state model" — Box runtime + Box-extract arms ship in 2f-narrow); `project_ergots_direction` memory updated to "phase 2f narrow shipped; next is phase 2f medium (GlobalVars + GetVar + Option + SelectField + chain-state fields)"; `MEMORY.md` index updated if any new memory; commit + orchestrator-confirmed push. ~1.5 hours. |

`STOP γ` — phase 2f narrow complete. All 7 Box-extract arms shipped.

**Estimated wall clock totals:** Stop α ~4-5h, Stop β ~2-3h, Stop γ
~3-5h. Total ~9-13 hours across the 3 stops. Single-session per stop;
multi-session for the full slice.

The PLAN.md (overwritten at the start of phase 2f, same pattern as
2b → 2c → 2d-A → 2d-B → 2e overwrites) holds these eight tasks
in detail with explicit `STOP α / STOP β / STOP γ` markers between
task groups.

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | Phase 2f scope: narrow (Box-extract arms only + SBox wire + ErgoBox shape extension). Medium (GlobalVars + GetVar + Option + SelectField) and broad (byte-array conversions + hash predefs) deferred to subsequent slices. | Bundle medium into 2f-narrow (~10-15h multi-session); skip foundation and go straight to GlobalVars in 2f. | Narrow scope matches the 2-4 hour cadence held since slice 2d-B. 6-8 hours was the original handoff estimate for 2f-narrow; with SBox wire parsing added (~1.5h) and the 3-stop split's per-stop finalize overhead, total is ~9-13h — still single-session per stop. Medium pushes solidly into multi-session for the slice as a whole. |
| 2 | Three-stop split with explicit STOP markers in PLAN.md. | Single slice (no stops, all 7 arms in one push); per-arm finalize (7 stops = too much overhead). | User asked for "stops to call it a day in between." 3 stops at α (foundation + 2 trivial), β (2 structural), γ (serializer + 3 hash) match the natural dependency tiers. Each stop ~3 hours; each ends at a clean commit+push state. Per-arm would multiply finalize overhead 7x. |
| 3 | SBox wire parsing in Stop α (replaces phase 2a's `'not-implemented-phase-2a'` throw). | Inline TS tests with hand-built ErgoBox values (Lambda pattern from 2e); defer SBox wire to 2f-medium. | Boxes ARE wire-encodable (sigma-rust `data.rs` handles SValue::Box). Lambda was inline-only because Lambda isn't serializable in sigma-rust either. Inline-only for SBox would fragment the project's fixture-driven test pattern. Adding SBox parse + serialize is ~80 lines each — same magnitude as the eval arms it enables. Closing the phase 2a gap is the right place. |
| 4 | Lazy `box_id` computation in `ExtractId` arm (not precomputed/cached on `ErgoBox` struct). | Cache `box_id` at parse-time (matches sigma-rust's `calc_box_id` invariant); compute once via the serializer at parse-time, store on struct. | Sigma-rust caches for performance (`box_id` is referenced from multiple call sites in the prover). TS port has one consumer (`ExtractId`); caching would pay the hash cost on every box parse even if `ExtractId` is never called. No correctness divergence — sigma-rust's `calc_box_id` and our `blake2b256(serializeBoxBytes(box))` produce the same bytes. Defer caching until profiling shows it matters. |
| 5 | `ExtractRegisterAs` throws on type mismatch (not None). | Return `None` on mismatch (interpretation a reader might expect from "type-assertion"). | Sigma-rust `extract_reg_as.rs:41-44` throws `EvalError::UnexpectedValue` on stored-tpe ≠ expected-tpe. Returning None would diverge from the JIT semantics. Surfaced as the typed code `'register-type-mismatch'` for programmatic dispatch. Confirmed by the sigma-rust test `eval_box_get_reg_r0_wrong_type` which asserts `try_eval_out` errors. |
| 6 | `ErgoBox.registers` shape extension: `Record<number, { tpe: SType; value: SValue }>`. | Keep `Record<number, SValue>` and derive tpe from kind at eval time. | Type-derivation from `kind` alone fails for empty `Coll` (elem type unrecoverable) and `None` `Option`. Sigma-rust stores `Constant<'static>` (tpe + v); we mirror it. Same rationale as why `ErgoTree.constants` is paired with `ErgoTree.constantTypes` in phase 2a. The reshape is in `mir/types.ts` only — no parsers currently construct ErgoBox values (phase 2a left the parsing-of-SValue-Box throwing `'not-implemented-phase-2a'`), so no downstream breakage. |
| 7 | No EvalContext chain-state field additions in 2f-narrow. Defer to 2f-medium when GlobalVars + GetVar consume them. | Pre-declare all chain-state fields per umbrella's "design once for additive growth." | Pattern from phase 2e: `treeVersion?` was added when XorOf + Upcast/Downcast V3 consumed it. Pre-stubbing field names without consumers conflicts with YAGNI. Phase 2f-medium will add them naturally. The contract change is also additive at 2f-medium time, so no breaking-surface concerns. |
| 8 | Box canonical-bytes serializer ports the full surface (not parser-slice tricks). | Parser-slice for `ExtractBytes`/`Id`; tracked field offsets for `BytesWithNoRef`. | Parser-slice doesn't work for boxes constructed in-memory (only parsed ones). The wallet phase will need the full serializer for transaction construction. No benefit to deferring; matches sigma-rust source line-for-line. |
| 9 | Cost-charging order: Pattern A (envelope BEFORE eval-child) for all 7 Box-extract arms. | Pattern B (cost AFTER eval-child, Cast pattern). | Source-read confirms — every arm calls `ctx.add_jit_cost(N)` then `self.input.eval(env, ctx)`. The cost is fixed per arm (doesn't depend on data), so envelope-first is the natural order. Matches `[[reference-cost-charging-order-patterns]]` memory's Pattern A. |
| 10 | New EvalError codes: `'extract-input-not-box'` (shared across all 7 arms), `'register-id-out-of-range'` (ExtractRegisterAs only), `'register-type-mismatch'` (ExtractRegisterAs only). | Reuse existing `'bin-op-not-numeric'`-like generic code; collapse the two ExtractRegisterAs codes into one. | Clean semantic match. Sharing `'extract-input-not-box'` across all 7 arms mirrors the slice-B `'coll-not-boolean'` sharing pattern. The two ExtractRegisterAs codes capture distinct failure modes (out-of-range vs type-mismatch) and shouldn't collapse. |
| 11 | Layer C3 eval mutation testing: still deferred. | Add per-arm mutation suite. | Same reasoning as 2c/2d/2e. Box-extract arms' structural surface is small; budget better invested at Coll HOFs (phase 2g) or chain-state-field plumbing (phase 2f-medium). |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| SBox wire-parser byte-equality drift (a single VLQ misread breaks every fixture using `Const(SBox, ...)`) | Round-trip corpus fixture: emit a Box-bearing tree from fixture-gen, parse + serialize in TS, assert byte-equality. Stop α Task 1 includes this. |
| Box canonical-bytes serializer drift from sigma-rust's `sigma_serialize_bytes` | Stop γ Task 6 ports the serializer with per-field comment cite to `ergo_box.rs:202-216`. Standalone unit tests against fixture-gen-emitted box bytes (independent of eval arms). |
| `ExtractRegisterAs` R2 token-Coll-of-Tuple synthesis is gnarly | Helper `tokensToCollTupleSValue` inlined in the arm file. C1 fixtures cover R2 happy path + R2 with empty tokens + R2 with multiple tokens. |
| `ExtractRegisterAs` R0..R3 synthesis drift from sigma-rust's `get_register` | Per-mandatory-register cite (`R0 = SLong(box.value)` etc.) in arm comments. C1 fixtures cover R0/R1/R2/R3 with matching `elem_tpe`. |
| Type mismatch semantics ambiguity (throw vs None) | Decision log #5 documents the throw decision with sigma-rust source cite. C1 fixture for `eval_box_get_reg_r0_wrong_type` exact case asserts the throw. |
| `ErgoBox.registers` shape extension breaks unobserved callers | `git grep "\\.registers\\b" packages/ergoscript/src` at Stop α Task 1 start; verify the only consumers are the phase-2a stub interface and the (yet-to-be-written) ExtractRegisterAs arm. No phase 2a or 2b-2e code constructs or reads `.registers` (the field was reserved for phase 2f). |
| Lazy id computation differs from sigma-rust caching in observable ways | Cost is per-call `Fixed(12)`. Performance is a non-goal for the verifier path. No observable divergence in produced bytes. |
| Cost-limit-exceeded mid-arm leaves partial state | Cost charge happens BEFORE eval-child (all 7 arms). If `addCost` throws, no eval work has been done. Consistent with prior slices. |
| `bytesToCollByteSValue` helper introduced in Stop α gets duplicated when Stop β/γ need it | Land the helper in a shared file `eval/_byte-coll.ts` (or inline `bytes-to-coll-byte.ts`) starting in Stop α Task 3 (ExtractScriptBytes). Reused by ExtractCreationInfo, ExtractBytes, ExtractBytesWithNoRef, ExtractId. Promote-on-third-caller threshold met. |
| Memory drift: `reference-cost-charging-order-patterns` getting stale with Pattern A continuing to dominate | The memory documents the SPLIT (Pattern A vs B). Pattern A continuing to apply for all 7 arms isn't drift — it's the memory being applied correctly. No update needed unless a Pattern-B-leaning arm appears (e.g., Coll HOFs in phase 2g). |
| Forgetting facts/ergoscript.md updates at Stop γ finalize | Stop γ finalize task explicitly: (1) updates the SValue `parseSValue` / `serializeSValue` postcondition to remove SBox from the `'not-implemented-phase-2a'` set; (2) modifies the "Does NOT ship yet" entry from "Box / Context / Header chain-state model" to "Context / Header chain-state model" (Box runtime ships in 2f-narrow); (3) bumps the coverage line to "27 of ~70 arms"; (4) documents the 3 new EvalError codes + 2 new SValueParseError codes added across α/β. Spec-compliance reviewer verifies each. |
| Subagent missing the spec's design decisions | Two-stage review per task (spec compliance + code quality). Both reviewers read the relevant spec section + the PLAN's task section. Pattern proven across 2b's 18 tasks through 2e's 4 tasks. |
| Determinism regression in fixture-gen | Two-run cargo build + diff check per task (same gate as prior slices). |
| Test count drift (1609 → ~1657 expected) | Each Stop's finalize task updates the test count in `SESSION_CONTEXT.md` and the commit message. PLAN.md tracks per-task expected delta. |

## Open questions

All resolve via source-read or fixture-driven TDD at implementation
time; none are blockers.

1. **SBox `index` encoding: VLQ-u16 or raw BE-u16?** Sigma-rust
   `ergo_box.rs:214` writes `w.put_u16(self.index)`. Source-read at
   Stop α Task 1 confirms whether `put_u16` is VLQ-encoded (sigma-ser
   convention for shorts) or BE-encoded. C1 fixture's round-trip
   gate is the authority.

2. **`bytesToCollByteSValue` byte signing.** Sigma-rust represents
   `Coll[Byte]` items as `i8` internally (Vec<i8> in tests). Per
   `mir/types.ts:771`, TS Byte is `{ kind: 'Byte'; value: number }`
   without a documented range. Confirm at Stop α Task 3 that the
   existing fixture convention is signed-i8 (range −128..=127), not
   unsigned-u8 (range 0..=255). The C1 fixtures from prior slices that
   use `Coll[Byte]` values are the authority; checking one (e.g.,
   `BinOp` Bit-arith Byte arms from 2c) will resolve the convention.

3. **ExtractRegisterAs `e.elemTpe` for absent R4..R9 register.**
   Sigma-rust returns `Value::Opt(None)` without type-checking
   `e.elemTpe` against anything (there's nothing stored to compare).
   TS mirror: return `{ kind: 'Option', elem: e.elemTpe, value: null
   }`. Confirm `elem` field of None-Option needs to match `e.elemTpe`
   (yes — consumers of `OptionGetOrElse` in 2f-medium will need it).

4. **`ErgoBox.registers` initial population.** Stop α adds the
   reshape; the phase-2a SBox parser (also Stop α) populates it
   from wire bytes. Until Stop α Task 1 ships, the field is
   unreachable from user code. Confirm at task start that no other
   code path constructs ErgoBox values; if so, Decision log #6's
   safety claim holds.

5. **Box wire format and the outer ErgoTree envelope.** A
   `Const(SBox, <literal>)` inside an ErgoTree means the segregated-
   constants section (if any) carries an SBox value. Phase 2a's
   ErgoTree envelope parser already routes SValue parsing through
   `parseSValue` based on the parallel `constantTypes` array. So no
   envelope-level changes needed — Stop α's SBox arm extension in
   `parse-svalue.ts` is sufficient. Verify at Stop α Task 1.

6. **`bytesToCollByteSValue` location.** Land in a shared file at
   first need (Stop α Task 3, ExtractScriptBytes — the second
   caller); promote-on-third-caller threshold (ExtractCreationInfo
   in Stop β = third caller) is already met by then.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella
  phase plan (2a–2j)
- `docs/specs/2026-05-15-ergoscript-phase-2e-design.md` — sister
  spec (lambdas + treeVersion + XorOf); established the
  `EvalOpts.<optional-field>` additive-extension pattern that 2f-
  medium will follow for chain-state fields
- `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` —
  established the deferred-variant tracking pattern; the
  cost-charging-order pattern A/B split; the inline-defensive-tests
  precedent
- `facts/ergoscript.md` — boundary contract, extended additively per
  phase. Updates after 2f narrow:
  - SBox parseSValue/serializeSValue surface no longer throws
    `'not-implemented-phase-2a'`
  - 3 new EvalError codes documented
  - 2 new SValueParseError codes documented
  - Coverage line updated to "27 of ~70 arms"
  - Box-extract arms removed from "Does NOT ship yet" section
- `facts/nipopow.md` — sister contract for the proof package
- `CLAUDE.md` — TDD discipline, browser-first rules,
  confidence-escalation list
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`,
  HEAD `ed5452cf`) — byte-format and implementation oracle. Phase 2f
  narrow authoritative refs:
  - `ergotree-interpreter/src/eval/extract_amount.rs` — ExtractAmount
    impl (Fixed(8), BEFORE eval-child)
  - `ergotree-interpreter/src/eval/extract_script_bytes.rs` —
    ExtractScriptBytes impl (Fixed(10))
  - `ergotree-interpreter/src/eval/extract_reg_as.rs` —
    ExtractRegisterAs impl (Fixed(50), R0..R9 dispatch, type-
    assertion throws)
  - `ergotree-interpreter/src/eval/extract_creation_info.rs` —
    ExtractCreationInfo impl (Fixed(16))
  - `ergotree-interpreter/src/eval/extract_bytes.rs` — ExtractBytes
    impl (Fixed(12))
  - `ergotree-interpreter/src/eval/extract_bytes_with_no_ref.rs` —
    ExtractBytesWithNoRef impl (Fixed(12))
  - `ergotree-interpreter/src/eval/extract_id.rs` — ExtractId impl
    (Fixed(12), blake2b256(sigma_serialize_bytes))
  - `ergotree-ir/src/chain/ergo_box.rs` — ErgoBox struct + sigma_*
    wire format + box_id calc + bytes_without_ref variant
  - `ergotree-ir/src/chain/ergo_box/register/id.rs` — RegisterId
    range validation
  - `ergotree-ir/src/mir/extract_reg_as.rs` — MIR shape with
    `register_id: i8` + `elem_tpe: Arc<SType>`
- `~/projects/sigmastate-interpreter/docs/LangSpec.md` — canonical
  language specification (per-arm semantics, register-access rules)
- Memories at finalize:
  - `project_ergots_direction.md` — updated to phase 2f narrow shipped
    (post-Stop γ); next is phase 2f medium (GlobalVars + GetVar +
    Option + SelectField + chain-state fields)
  - `reference_cost_charging_order_patterns.md` — Pattern A continues
    to apply (all 7 arms; envelope-first). No update needed.
  - `project_sigma_combinators_deferred.md` — untouched
    (Atleast/SigmaAnd/SigmaOr still pending phase 2g)
  - `project_treeversion_gating_deferred.md` — untouched (policy
    memory; no version-gated arms in 2f-narrow)
  - `reference_source_first_discipline.md` — continues to apply
    (source-read confirmed 7 cost values + Pattern A order +
    ExtractRegisterAs type-mismatch throw)
