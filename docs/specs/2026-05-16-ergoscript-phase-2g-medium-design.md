# ErgoScript Interpreter — Phase 2g-medium Design Spec (Sigma Protocol, leaf-only)

**Status:** Draft
**Date:** 2026-05-16
**Package:** `@mwaddip/ergots-ergoscript` (phase 2g-medium — sigma protocol; leaf-only verifier)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec; rewritten at Task 13 of phase 2f Coll HOFs; this slice closes the umbrella's "phase 2g = Sigma protocol" promise at a narrower scope — leaf-only verifier; the 3 deferred sigma combinators slide to a follow-up `2g-combinators` slice)
**Sister specs:**
- `docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md` (most-recent prior slice — 9 Coll HOFs; established Layer C3.a operator-driven mutation testing; flat-task-list workflow with per-task commits; Mixed cost pattern documented; spec-writing conventions reused below)
- `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` (defines the 3 deferred sigma combinators — `Atleast`/`SigmaAnd`/`SigmaOr` — and the three-mechanism deferral tracking pattern carried forward here)
- `docs/specs/2026-05-16-ergoscript-phase-2f-medium-design.md` (chain-state Context + V3-gated lazy semantics template; `EvalOpts` additive-growth precedent)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-16 (post-phase-2f-Coll-HOFs)

## Goal

Ship phase 2g-medium: the sigma-protocol primitives for the `@mwaddip/ergots-ergoscript` package, at a leaf-only verifier scope. By the end of this slice:

- **Structural `SigmaBoolean`** — the existing opaque `{ raw: Uint8Array }` shape (phase 2a) reshapes to a 6-variant discriminated union: `TrivialProp`, `ProveDlog`, `ProveDhTuple`, `Cand`, `Cor`, `Cthreshold`. All 6 variants parse + serialize via the wire codec; the eval arms that *construct* `Cand`/`Cor`/`Cthreshold` from `Coll[SigmaProp]` inputs (`SigmaAnd`/`SigmaOr`/`Atleast`) remain deferred.
- **`@noble/curves` 2.2.0 runtime dep** (secp256k1 specifically). The version-locked pair with `@noble/hashes@2.2.0` was pre-flagged in the umbrella plan.
- **Two new evaluator arms:** `CreateProveDlog` (Pattern A, `Fixed(10)` cost) and `CreateProveDhTuple` (Pattern A, `Fixed(20)` cost). Both are pure structural wraps — no curve operations on the eval path; the cryptographic work lives entirely on the verify path.
- **One new public function:** `verifySignature(sigmaBoolean, message, signature) → boolean`. Handles `TrivialProp` + `ProveDlog` + `ProveDhTuple` SigmaBooleans. Throws `VerifyError 'conjecture-not-implemented'` on `Cand`/`Cor`/`Cthreshold` inputs (deferred to `2g-combinators`).
- **One new error class:** `VerifyError extends Error { code: string }` with ~5 codes for the leaf-only verifier surface.
- **One new EvalError code:** `'sigma-prop-input-not-group-element'` — defensive kind-check shared by both eval arms.
- **P2PK short-circuit:** the `Const` arm gains a 50-JitCost charge (sigma-rust's `EVAL_SIGMA_PROP_CONSTANT`) when the constant value is a `SSigmaProp`. Without this, P2PK trees undercharge by 10× vs sigma-rust.
- **Coverage:** 42 → 44 of ~70 `Expr` arms.

Public function signatures (`evaluate`, `evaluateWith`, `makeContext`, `EvalError`) stay stable. `SigmaBoolean` shape changes (this is the only breaking-shape change in the slice); the *containing* `SValue.kind: 'SigmaProp'` discriminator is unchanged, and the wire round-trip stays byte-identical.

The slice is implemented as 8 sequential tasks in flat `PLAN.md` ordering. Commits between each task; no `Stop α/β/γ` markers (per [[feedback-no-artificial-stops]] memory).

## Non-goals

- **`Atleast`** — k-of-n SigmaProp threshold combinator. Calls into sigma-rust's `Cthreshold::reduce` reduction logic; can collapse to `Cor`/`Cand`/`Cthreshold`/`TrivialProp` depending on inputs. Deferred to `2g-combinators`.
- **`SigmaAnd`** — `Coll[SigmaProp] → SigmaProp` conjunction. Calls `Cand::normalized`. Deferred to `2g-combinators`.
- **`SigmaOr`** — `Coll[SigmaProp] → SigmaProp` disjunction. Calls `Cor::normalized`. Deferred to `2g-combinators`.
- **Conjecture verifier extension.** The verifier in 2g-medium throws `'conjecture-not-implemented'` on `Cand`/`Cor`/`Cthreshold` SigmaBooleans. The `2g-combinators` slice extends the verifier to handle these:
  - `Cand`/`Cor`: XOR-based challenge derivation + tree walk (relatively simple).
  - `Cthreshold`: GF(2^192) polynomial Lagrange interpolation — confidence-escalation territory per OVERRIDES #2; deferred together with the construction arm (`Atleast`) for unified testing.
- **Sigma-protocol prover.** Construction of proofs (Schnorr signing, deterministic-nonce derivation) is a wallet concern; deferred to phase 3.
- **`reduceToCrypto` as a standalone public function.** `evaluate(tree, opts)` already plays this role — a tree whose body evaluates to a SigmaProp returns the structural SigmaBoolean inside. The combined `verify(tree, opts, proof, msg)` is also not exposed; callers compose `verifySignature(evaluate(tree, opts).value, msg, sig)`. Both can be added later without breaking change if real consumers ask.
- **Method-call dispatch** (`MethodCall` / `PropertyCall`). Phase **2g.5** (inserted between 2g-combinators and 2h). This is the actual C2 corpus unlocker.
- **AVL+ membership-proof verification.** Phase 2h.
- **Byte-array conversions** (`ByteArrayToLong`, `LongToByteArray`, `ByteArrayToBigInt`). Phase 2i.
- **Hash predefs** (`CalcBlake2b256`, `CalcSha256`, `DecodePoint`). Phase 2i.
- **`SubstConstants`** and `Xor` byte-array. Phase 2i.
- **Layer C3-cost real-context cost validation.** Phase 2j.
- **Retroactive Layer C3.a coverage** for prior arms. Future slices may opt-in per phase; 2g-medium specifically does NOT opt in (the two new arms are pure structural wraps with minimal mutation-test surface; verifier-mutation is a separate fixture-driven concern).
- **`npm publish` of `@mwaddip/ergots-ergoscript@0.3.0`.** Separate user decision; not bundled with this slice. The slice does introduce a new runtime dep (`@noble/curves`), so the publish call may be naturally scheduled at the end of 2g-medium or after 2g-combinators.

## Architecture

### Directory layout

```
packages/ergoscript/src/
├── mir/types.ts                            MODIFIED: SigmaBoolean opaque → 6-variant union
├── wire/sigma-boolean.ts                   REWRITTEN: structural parser + serializer
├── wire/parse-svalue.ts                    MODIFIED: SSigmaProp case stores structural value
├── wire/serialize-svalue.ts                MODIFIED: SSigmaProp case walks structural tree
├── crypto/
│   ├── p2pk.ts                             MODIFIED: isP2PK / p2pkPublicKey walk structural
│   └── secp256k1.ts                        NEW: @noble/curves 2.2.0 adapter
├── sigma/                                  NEW directory
│   ├── challenge.ts                        NEW: 24-byte challenge ops + scalar conversion
│   ├── fiat-shamir.ts                      NEW: serialize SigmaBoolean + commitments
│   ├── sig-serializer.ts                   NEW: parse sigma-proof bytes guided by tree
│   ├── verifier.ts                         NEW: verifySignature orchestration
│   └── errors.ts                           NEW: VerifyError class + codes
├── eval/
│   ├── const.ts                            MODIFIED: 50-JitCost P2PK short-circuit
│   ├── create-prove-dlog.ts                NEW: CreateProveDlog arm
│   ├── create-prove-dh-tuple.ts            NEW: CreateProveDhTuple arm
│   └── eval.ts                             MODIFIED: 2 new case lines
└── index.ts                                MODIFIED: re-export verifySignature + VerifyError + SigmaBoolean type

packages/ergoscript/test/
├── _helpers/index.ts                       MODIFIED: hydrateSigmaBoolean helper for structural shape
├── wire/sigma-boolean.test.ts              MODIFIED: assertions updated for structural shape
├── eval/create-prove-dlog.test.ts          NEW
├── eval/create-prove-dh-tuple.test.ts      NEW
├── sigma/verifier.test.ts                  NEW
├── sigma/challenge.test.ts                 NEW: unit tests for primitives
├── sigma/fiat-shamir.test.ts               NEW
├── sigma/sig-serializer.test.ts            NEW
├── crypto/secp256k1.test.ts                NEW: adapter unit tests
└── fixtures/                               NEW per-variant + per-arm + verifier fixtures

fixture-gen/src/cmds/ergoscript/
├── eval/create_prove_dlog.rs               NEW
├── eval/create_prove_dh_tuple.rs           NEW
├── wire/sigma_boolean_variants.rs          NEW: per-variant wire roundtrip fixtures
├── verify/verifier_positive.rs             NEW: invokes sigma-rust prover for valid proofs
├── verify/verifier_reject.rs               NEW: conjecture + malformed cases
└── verify/verifier_mutation.rs             NEW: byte-flip variants
fixture-gen/src/main.rs                     MODIFIED: new generate_and_write calls
fixture-gen/Cargo.toml                      MODIFIED: enable sigma-rust prover feature if not already
```

### Structural `SigmaBoolean` type

Lives in `packages/ergoscript/src/mir/types.ts`. Replaces the existing opaque `{ raw: Uint8Array }` shape from phase 2a:

```ts
export type SigmaBoolean =
  | { tag: 'TrivialProp'; value: boolean }
  | { tag: 'ProveDlog'; h: Uint8Array }                                 // 33-byte SEC1 compressed
  | { tag: 'ProveDhTuple'; g: Uint8Array; h: Uint8Array; u: Uint8Array; v: Uint8Array }
  | { tag: 'Cand'; items: SigmaBoolean[] }
  | { tag: 'Cor'; items: SigmaBoolean[] }
  | { tag: 'Cthreshold'; k: number; items: SigmaBoolean[] }
```

Discriminator field is `tag` (matches `Expr.tag` / `SType.tag` convention).

The 33-byte SEC1 representation for each `EcPoint`-equivalent field uses the existing `GroupElement` byte format (parsed via the existing SValue codec for `SGroupElement`). The **Ergo identity convention is 33 zero bytes** (sigma-rust `ec_point.rs:130-135`); this differs from native SEC1 and is handled by the curves adapter (see below).

Invariants (held by `parseSigmaBoolean`; trusted by all callers):
- `ProveDlog.h.length === 33`; `ProveDhTuple.{g,h,u,v}.length === 33`.
- `Cand.items.length >= 1`; `Cor.items.length >= 1`; `Cthreshold.items.length >= 1` (matches sigma-rust `BoundedVec<T, 1, 255>` lower bound).
- `Cthreshold.k` is in `[1, items.length]`.

### `@noble/curves` adapter (`crypto/secp256k1.ts`)

Thin wrapper over `@noble/curves@2.2.0`'s secp256k1 module, exposing only the operations the leaf-only verifier actually uses:

```ts
export function decodePoint(bytes: Uint8Array): Point        // 33-byte SEC1 → Point; 33 zeros → identity (Ergo)
export function encodePoint(p: Point): Uint8Array            // Point → 33-byte SEC1; identity → 33 zeros
export function pointAdd(a: Point, b: Point): Point
export function pointNegate(p: Point): Point
export function pointMul(p: Point, k: bigint): Point         // scalar multiplication
export const basePoint: Point                                // secp256k1 generator
export const groupOrder: bigint                              // n constant
export function scalarFromBytes(bytes: Uint8Array): bigint   // 32 BE bytes → scalar mod n
export function scalarFromChallenge(c: Uint8Array): bigint   // 24 bytes → left-pad with 8 zeros → mod n
```

`decodePoint` and `encodePoint` implement the **Ergo identity convention** (33 zero bytes ↔ point-at-infinity). Native SEC1 doesn't encode identity; the convention is Ergo-specific (sigma-rust `ec_point.rs:130-152`).

`scalarFromChallenge` is the load-bearing detail: 24-byte challenges are **left-padded with 8 zero bytes** to make 32 bytes, then reduced mod n (sigma-rust `wscalar.rs:69-76`). Getting this wrong causes silent verify failures.

Hash function stays on `@noble/hashes/blake2.js` (existing dep). No new hash dep.

### Verifier call graph (`sigma/verifier.ts`)

`verifySignature(sb: SigmaBoolean, message: Uint8Array, signature: Uint8Array): boolean`:

1. **TrivialProp short-circuit:** if `sb.tag === 'TrivialProp'`, return `sb.value` (sig is ignored; sigma-rust `verifier.rs:91-94`).
2. **Empty signature:** if `signature.length === 0`, return false (sigma-rust `sig_serializer.rs:118-128` `EmptyProof` → maps to false).
3. **Conjecture-rejection guard:** walk `sb` once; if any node is `Cand`/`Cor`/`Cthreshold`, throw `VerifyError 'conjecture-not-implemented'`. This is the leaf-only verifier's scope guard.
4. **Parse top-level challenge:** read first 24 bytes of `signature` as the root challenge (`sig_serializer.rs:143`).
5. **Per-leaf read:** for each leaf in `sb` (in tree-traversal order — leaf-only means at most a single leaf in 2g-medium), read 32-byte scalar `z`. ProveDlog: one z. ProveDhTuple: one z covering both points.
6. **Compute commitments:**
   - ProveDlog: `a = (basePoint * z) + negate(decodePoint(h) * scalarFromChallenge(challenge))` per `dlog_protocol.rs:173-184`. Note: sigma-rust's `Mul<&EcPoint>` impl is *point addition* (`ec_point.rs:74-79`); the spec equation is multiplicative-notation for an additive group operation.
   - ProveDhTuple: `a = (decodePoint(g) * z) + negate(decodePoint(u) * scalarFromChallenge(challenge))`; `b = (decodePoint(h) * z) + negate(decodePoint(v) * scalarFromChallenge(challenge))` per `dht_protocol.rs:132-157`.
7. **Fiat-Shamir tree serialization:** build the byte input for the hash by walking `sb` + the commitments computed in step 6. Critical replication detail: `prop_bytes` for a leaf wraps the `SigmaProp` in an `ErgoTree` with `version=0, hasSize=false, constantSegregation=true` *before* serializing (sigma-rust `fiat_shamir.rs:148-157`, `sigma_boolean.rs:303-312`). The leaf prefix byte is `1`; internal-node prefix is `0`; child counts use `put_i16_be_bytes` (2-byte big-endian, NOT the wire-format VLQ encoding) per `fiat_shamir.rs:197`.
8. **Hash:** `blake2b-256(tree_bytes || message)`, take the **first 24 bytes** (`fiat_shamir.rs:70-76`).
9. **Compare:** return `recomputed_challenge === top_level_challenge_from_step_4` (byte-equality on 24 bytes).

### Eval arms

Both arms are pure structural wraps. Cost charged BEFORE eval-child (Pattern A).

```ts
// eval/create-prove-dlog.ts
export function evalCreateProveDlog(e: CreateProveDlog, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(10)
  const input = evalExpr(e.input, env, ctx)
  if (input.kind !== 'GroupElement') {
    throw new EvalError('sigma-prop-input-not-group-element',
      `CreateProveDlog: expected GroupElement, got ${input.kind}`)
  }
  return { kind: 'SigmaProp', value: { tag: 'ProveDlog', h: input.value } }
}

// eval/create-prove-dh-tuple.ts
export function evalCreateProveDhTuple(e: CreateProveDhTuple, env: Env, ctx: EvalContext): SValue {
  ctx.addCost(20)
  const g = expectGroupElement(evalExpr(e.g, env, ctx), 'g')
  const h = expectGroupElement(evalExpr(e.h, env, ctx), 'h')
  const u = expectGroupElement(evalExpr(e.u, env, ctx), 'u')
  const v = expectGroupElement(evalExpr(e.v, env, ctx), 'v')
  return { kind: 'SigmaProp', value: { tag: 'ProveDhTuple', g, h, u, v } }
}
```

`expectGroupElement` is a small local helper inside `create-prove-dh-tuple.ts` (4 callers; tight YAGNI promotion threshold — inline acceptable).

### P2PK short-circuit (50 JitCost)

Sigma-rust's `eval.rs:138-158, 268-278` short-circuits a bare `SSigmaProp` constant via `EVAL_SIGMA_PROP_CONSTANT` = 50. Without this, segregated P2PK trees would charge 5 JitCost (the standard `ConstPlaceholder` cost) instead of 50 — a 10× undercharge.

Implementation: in `eval/const.ts`, when the `Const` arm encounters a value with `kind: 'SigmaProp'`, charge an additional 45 JitCost (so total = 5 [base] + 45 = 50). Symmetric for `ConstPlaceholder` resolving to a SigmaProp.

Smoking-gun fixture locks the 50-JitCost charge.

### Wire-format migration

Phase 2a's `wire/sigma-boolean.ts` produced an opaque shape that captured raw bytes by walking the wire just enough to compute length. Phase 2g-medium replaces this with a full recursive parser/serializer.

Parser dispatch (opcode bytes per sigma-rust `op_code.rs:39, 125-126` and `serialization/sigmaboolean.rs`):
- `0x88` / `0x89` (TrivialPropFalse / TrivialPropTrue, opcodes for boolean trivial proofs) → `{ tag: 'TrivialProp', value: false|true }`. (Confirm exact opcodes at fixture-gen task; the wire-mutation suite captures the existing assertions.)
- **205 (PROVE_DLOG)** → read 33-byte EcPoint → `{ tag: 'ProveDlog', h }`.
- **206 (PROVE_DHTUPLE)** → read 4 × 33-byte EcPoints → `{ tag: 'ProveDhTuple', g, h, u, v }`.
- **CAND opcode** → `put_u16`-VLQ child count → recursive `parseSigmaBoolean` × count → `{ tag: 'Cand', items }`.
- **COR opcode** → same as Cand.
- **CTHRESHOLD opcode** → `put_u8` k → `put_u16`-VLQ child count → recursive items → `{ tag: 'Cthreshold', k, items }`. (Sigma-rust `cthreshold.rs:108-111` writes k as `put_u16` of a u8, but the on-wire representation may be a single byte; verify at implementation.)

Serializer mirrors the parser exactly. Round-trip invariant: `serializeSigmaBoolean(parseSigmaBoolean(b)) === b` (byte-equal).

`isP2PK` / `p2pkPublicKey` refactor: instead of pattern-matching opaque bytes, walk the structural tree — `isP2PK` returns `true` iff `tree.body` is a `Const(SSigmaProp, { tag: 'ProveDlog', h })` (or a `ConstPlaceholder` resolving to same); `p2pkPublicKey` returns a defensive 33-byte copy of `h`. Public signatures unchanged.

Existing phase 2a tests (255-fixture roundtrip + 6221-flip parse-mutation suite) must continue to pass post-refactor. The new internal representation must not regress any error-class coverage.

### `SValue.kind: 'SigmaProp'` shape

Was: `{ kind: 'SigmaProp'; value: { raw: Uint8Array } }`. Now: `{ kind: 'SigmaProp'; value: SigmaBoolean }` (with `SigmaBoolean` being the 6-variant union above). The container discriminator `kind: 'SigmaProp'` is unchanged — only the inner shape.

### `EvalOpts` / `EvalContext`

No new fields. The verifier is a separate public function and does not participate in eval cost accounting.

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle. Per-arm and verifier semantics confirmed by source-read 2026-05-16.

### `CreateProveDlog { input }`

Input: `Expr` with `post_eval_tpe == SGroupElement`. Cost: `Fixed(10)` BEFORE eval-child (Pattern A). Eval: evaluate input → `Value::GroupElement(h)` → wrap as `SigmaProp{ProveDlog, h}`. No curve operation. Throws `'sigma-prop-input-not-group-element'` if eval-child returns non-GroupElement (defensive; sigma-rust `OneArgOpTryBuild` rejects at construction).
Source: `ergotree-interpreter/src/eval/create_provedlog.rs:10-29`.

### `CreateProveDhTuple { g, h, u, v }`

Inputs: 4 × `Expr` with `post_eval_tpe == SGroupElement`. Cost: `Fixed(20)` BEFORE eval-children (Pattern A). Eval: evaluate all four → wrap as `SigmaProp{ProveDhTuple, g, h, u, v}`. No curve operation. Same error path as ProveDlog for any non-GroupElement input.
Source: `ergotree-interpreter/src/eval/create_prove_dh_tuple.rs:12-25`.

### P2PK short-circuit in `Const`

When `Const.value` (or `ConstPlaceholder`-resolved value) is a `SigmaProp`, charge 50 JitCost total (not the standard 5). Mirrors sigma-rust's `EVAL_SIGMA_PROP_CONSTANT = 50` at `eval.rs:138-158`.
Source: `ergotree-interpreter/src/eval.rs:138-158, 268-278`.

### `verifySignature(sb, message, signature)`

See "Verifier call graph" in Architecture. Returns boolean for verify outcome; throws `VerifyError` for malformed inputs or out-of-scope conjectures.

**Key sigma-protocol details locked in writing:**

- 24-byte challenge ≠ 32-byte scalar. Challenge-to-scalar is left-pad-with-8-zero-bytes then reduce mod n.
- `SOUNDNESS_BITS = 192` is hard-coded; not modernizable.
- Verifier is **not** tree-version-gated (no `treeVersion` reads).
- `prop_bytes` for Fiat-Shamir wraps SigmaProp in `ErgoTree v0 + constant-segregation=true` — byte-equivalence with sigma-rust is the only correctness signal.
- Identity-point handling: 33 zero bytes ↔ point-at-infinity is **Ergo convention**, not native SEC1. The curves adapter handles the conversion; no caller needs to know.

## Error codes

### New `EvalError` code (1)

| Code | Emitted by | Failure mode |
|---|---|---|
| `'sigma-prop-input-not-group-element'` | `CreateProveDlog`, `CreateProveDhTuple` | An input expression evaluated to an `SValue` whose `kind !== 'GroupElement'`. Wire-format invariants make this unreachable for parser-produced trees (sigma-rust's `OneArgOpTryBuild` / `new` reject at construction); defensive against `ConstantPlaceholder` injection and future MIR shape changes. Message includes the arm name and the input's actual kind. |

Total `EvalError` codes after 2g-medium: **36** (35 from prior phases + 1 new).

### New `VerifyError` class (NEW; ~5 codes)

| Code | Failure mode |
|---|---|
| `'conjecture-not-implemented'` | `verifySignature` reached a `Cand`/`Cor`/`Cthreshold` node. Deferred to `2g-combinators`. |
| `'empty-signature'` | The signature byte sequence is empty. Returns `false` rather than throwing in sigma-rust (`sig_serializer.rs:118-128`); the TS port surfaces this as a typed throw for callers that want to distinguish "empty proof" from "bad proof". (Decision-log #5.) |
| `'truncated-signature'` | The signature ran out of bytes before the tree walk completed (e.g., challenge present but scalar bytes missing). Mirrors sigma-rust's `SigParsingError::ScalarRead*` family. |
| `'point-not-on-curve'` | SEC1 decode of a SigmaBoolean leaf's `h`/`g`/`u`/`v` rejected the bytes (point not on the curve, malformed encoding tag, etc.). |
| `'scalar-out-of-range'` | A z scalar read from the signature is ≥ `groupOrder n`. Sigma-rust silently accepts via `Scalar::reduce_bytes` (`wscalar.rs:60-67`); the TS port surfaces as a typed throw for telemetry on malformed proofs. (Decision-log #6.) |

### New `SigmaBooleanParseError` codes (2)

The existing codes (`'arity-out-of-range'`, `'unknown-opcode'`) from phase 2a stay. Add:

| Code | Failure mode |
|---|---|
| `'cthreshold-k-out-of-range'` | Cthreshold's `k` field is outside `[1, items.length]`. |
| `'sigma-conjecture-empty-items'` | Cand/Cor/Cthreshold parsed with `items.length === 0` (sigma-rust enforces `>= 1` via `BoundedVec<T, 1, 255>`). |

## Validation strategy

Four layers stack. C1 + C2 are existing patterns; **V1 + V2 are new verifier-specific layers** introduced in this slice.

### Layer C1 — per-arm fixture + value/cost asserts (existing)

Per-arm `.json` fixtures generated by fixture-gen (Rust) running `try_eval_out::<Value<'static>>` against sigma-rust at `integration/ergots@ed5452cf`. TS tests load each fixture, parse + eval, assert SValue + cost equality.

**Required smoking-gun fixtures:**

- **`create-prove-dlog.json`:** valid GroupElement input (compressed pubkey + identity-bytes); cost = 10; error entry for non-GroupElement input; cost-limit entry.
- **`create-prove-dh-tuple.json`:** valid 4-tuple inputs; cost = 20; error entries for each of the 4 input positions being non-GroupElement; cost-limit.
- **`p2pk-short-circuit.json`:** bare `Const(SSigmaProp, ProveDlog(pk))` evaluates with total cost = 50 (not 5). Locks the `EVAL_SIGMA_PROP_CONSTANT` charge.

### Layer C2 — corpus regression gate (existing)

`test/corpus-eval.test.ts` runs unchanged. Expected outcome: still `success=0 not-impl=18 other=0`. The 18 evaluable corpus trees use method calls (`box.tokens`, etc.), not sigma-protocol primitives. 2g-medium does NOT unlock the corpus — that's 2g.5 method-call dispatch territory.

A subset of corpus trees may have ConstPlaceholder SigmaProp constants that were previously opaque. Now they parse as structural — no behavior change in eval (still hits a method-call or context-field arm before reaching anything sigma-protocol-related). `expect(other).toBe(0)` gate stays green.

### Layer V1 — verifier positive + reject + malformed (NEW)

Real `(sigmaBoolean, message, signature)` triples generated via fixture-gen invoking sigma-rust's prover. Sigma-rust uses deterministic-nonce signing (Blake2b-256-based per `dlog_protocol.rs:113-149`), so fixtures are deterministic.

**Fixtures:**
- `verifier-prove-dlog.json` — ≥ 5 valid Schnorr proofs across different keys / messages. Include edge cases: pubkey near group order, message of various lengths (0, 1, 32, 100 bytes).
- `verifier-prove-dh-tuple.json` — ≥ 5 valid DH-tuple proofs.
- `verifier-trivial-prop.json` — TrivialProp(true) returns `true` (ignores sig); TrivialProp(false) returns `false`.
- `verifier-conjecture-rejection.json` — Cand/Cor/Cthreshold SigmaBooleans → throw `'conjecture-not-implemented'`.
- `verifier-malformed.json` — empty sig (throws `'empty-signature'`), truncated sig (throws `'truncated-signature'`), z scalar ≥ n (throws `'scalar-out-of-range'`), invalid SEC1 point bytes (throws `'point-not-on-curve'`).

### Layer V2 — verifier mutation (NEW)

Single canonical leaf-proof fixture from V1 (e.g., a ProveDlog with a 32-byte message). Byte-flip each of the 56 signature bytes (24-byte challenge + 32-byte z). Assert each mutation yields `false` or a typed `VerifyError`. Don't replicate across all V1 fixtures — diminishing returns.

### Wire-format roundtrip (existing Layer 1 pattern, extended)

Per-variant wire fixtures for all 6 SigmaBoolean variants:
- `sigma-boolean-prove-dlog.json` / `sigma-boolean-prove-dh-tuple.json`
- `sigma-boolean-trivial-prop.json` (true and false in one fixture file with multiple entries)
- `sigma-boolean-cand.json`, `sigma-boolean-cor.json`, `sigma-boolean-cthreshold.json` — varied child shapes (leaves only, nested conjectures, k edge values for Cthreshold)

Each asserts `serializeSigmaBoolean(parseSigmaBoolean(b)) === b` (byte-equal). Phase 2a's 6221-flip parse-mutation suite continues to run; confirms the structural-refactor doesn't drop error-class coverage.

### Layer C3.a — eval mutation testing

**SKIPPED for 2g-medium.** The two new eval arms are pure structural wraps; C3.a operators (constant replacement, child swap, etc.) don't add meaningful coverage over Layer C1. The 9 Coll HOFs in `eval-mutation.test.ts` continue to be exercised — no regression.

C3.a re-engages at `2g-combinators` where the deferred eval arms (`Atleast`/`SigmaAnd`/`SigmaOr`) have richer eval surface (recursive children, threshold k arithmetic).

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. `@noble/curves` 2.2.0 is browser-clean (same discipline as `@noble/hashes`). No new browser-incompatible primitives.

### Determinism gate

Two-run `cargo build -p fixture-gen --release` + `cargo run -p fixture-gen --release` per fixture-gen task (Tasks 1, 3-6). Diff against committed fixtures must be empty. Pattern from phase 2f Coll HOFs; carries over.

Specifically for the verifier-positive V1 fixtures: confirm at fixture-gen task time that sigma-rust's prover defaults to deterministic-nonce mode (`dlog_protocol.rs:113-149` indicates yes — uses Blake2b-256). If a non-deterministic prover entry point is accidentally invoked, the second `cargo run` will produce a diff, and the gate trips.

## Task structure

Flat 8-task list. Commits between each task. No `Stop α/β/γ` markers (per [[feedback-no-artificial-stops]] memory).

| # | Task | Subject | Adds |
|---|---|---|---|
| 1 | Foundation | Structural SigmaBoolean wire refactor: `mir/types.ts` shape change; `wire/sigma-boolean.ts` rewritten (parser + serializer); `wire/parse-svalue.ts` + `wire/serialize-svalue.ts` SSigmaProp rewire; `crypto/p2pk.ts` (or wherever `isP2PK`/`p2pkPublicKey` live) refactor; per-variant wire fixtures for all 6 SigmaBoolean variants. Existing 255-fixture roundtrip + 6221-flip mutation suite must stay green. | 2 new SigmaBooleanParseError codes (`'cthreshold-k-out-of-range'`, `'sigma-conjecture-empty-items'`); structural SigmaBoolean type |
| 2 | Curves adapter | `crypto/secp256k1.ts` thin wrapper over `@noble/curves@2.2.0`; add dep (version-locked pair with `@noble/hashes@2.2.0`); unit tests for adapter functions, especially the Ergo identity convention (33 zero bytes ↔ point-at-infinity) and the two scalar-conversion paths. | 9 adapter functions; new runtime dep |
| 3 | `CreateProveDlog` arm + P2PK short-circuit | Eval arm (Pattern A, `Fixed(10)`) + 50-JitCost P2PK short-circuit in the `Const` arm + Layer C1 fixture + smoking-gun fixture for the short-circuit cost. | 1 new EvalError code (`'sigma-prop-input-not-group-element'`); 2 new eval modifications (`eval/const.ts`, `eval/eval.ts`) |
| 4 | `CreateProveDhTuple` arm | Eval arm (Pattern A, `Fixed(20)`) + Layer C1 fixture covering valid 4-tuples and per-position non-GroupElement error paths. | 1 new arm |
| 5 | Verifier infrastructure | `sigma/challenge.ts` (24-byte ops, scalar conversion) + `sigma/fiat-shamir.ts` (SigmaBoolean+commitments → blake2b, byte-equivalent to sigma-rust) + `sigma/sig-serializer.ts` (parse proof bytes guided by tree) + `sigma/errors.ts` (`VerifyError` class + codes); per-module unit tests. | 4 new internal modules; `VerifyError` class with ~5 codes |
| 6 | `verifySignature` impl + verifier fixtures | `sigma/verifier.ts` orchestration + public re-export from `index.ts`. Layer V1 fixtures (positive + conjecture-reject + malformed) generated via fixture-gen invoking sigma-rust's prover; Layer V2 byte-flip mutation fixtures. | Public `verifySignature` function; verifier fixture corpus |
| 7 | Docs update | `facts/ergoscript.md` extended (new public function, new error class, SigmaBoolean shape change, new EvalError + VerifyError codes); umbrella plan annotated for 2g-medium done + 2g-combinators flagged. Optional: bump v0.2.0 → v0.3.0 in the facts file (decision deferred to user; the slice introduces a new runtime dep which is the natural minor-version trigger). | — |
| 8 | Finalize | `SESSION_CONTEXT.md` snapshot; memory updates (`project_ergots_direction` to phase 2g-medium done; extend `project_sigma_combinators_deferred` to reflect that 2g-combinators is the next slice with verifier extension scope); new `reference_sigma_verifier_internals` memory if useful; `MEMORY.md` index; commit + push. | — |

**Subagent discipline:** one dispatch per task + two-stage review (spec compliance + code quality). Pattern proven across 2b's 18 tasks through 2f Coll HOFs's 14 tasks; carries forward here. ~8 × 3 ≈ 24 calls + fix-rounds.

**Confidence-escalation flag (per OVERRIDES #2):** Task 6 is the crypto-sensitive part. Implementer + reviewer must specifically verify:

- 24-byte challenge → 32-byte scalar: **left-pad with 8 zero bytes** then reduce mod n (`wscalar.rs:69-76`). Get this wrong and verify silently fails.
- Fiat-Shamir `prop_bytes`: wrap SigmaProp in `ErgoTree v0 + constant-segregation=true` before serializing (`fiat_shamir.rs:148-157`). Byte-equivalence with sigma-rust is the only correctness signal.
- Schnorr commitment equation: `a = (basePoint * z) + negate(decodePoint(h) * scalarFromChallenge(challenge))` for ProveDlog (`dlog_protocol.rs:173-184`). Note: sigma-rust's `Mul<&EcPoint>` impl is *point addition* (`ec_point.rs:74-79`).
- DhTuple two-commitment equation (`dht_protocol.rs:132-157`).
- Identity-point handling: 33 zero bytes ↔ point-at-infinity is Ergo convention, NOT native SEC1.
- `put_u16` is VLQ in wire serialization but `put_i16_be_bytes` (big-endian) in Fiat-Shamir — same conceptual field, different encodings (`fiat_shamir.rs:197`).

**Cross-task dependencies:**

- Tasks 3, 4, 5, 6 all depend on Task 1's structural SigmaBoolean type.
- Task 6 depends on Task 2's curves adapter + Task 5's infrastructure modules.
- Tasks 3 and 4 are independent of Tasks 5 and 6; could be parallelized in principle, but flat task ordering avoids subagent-coordination overhead.
- Tasks 7 and 8 are pure docs/finalize.

**Time estimate:** ~10-14h across 8 tasks. Within the 10-12h budget for leaf-only 2g-medium, with margin for the verifier-impl correctness sweep.

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | **Scope: 2g-medium (sigma protocol; leaf-only verifier)** | 2g-narrow (verify-only, no eval arms); 2g-full (umbrella-aligned, includes the 3 combinators + Cthreshold polynomial). | 2g-narrow leaves the package without `proveDlog`/`proveDhTuple` evaluation, so trees can't reach a verifiable SigmaBoolean from a constant pubkey. 2g-full adds Cthreshold GF(2^192) Lagrange interpolation — confidence-escalation territory (OVERRIDES #2) that deserves its own focused slice with `Atleast`/`SigmaAnd`/`SigmaOr`. 2g-medium ships "leaf sigma proofs verify" as a coherent milestone matching real-world P2PK usage. |
| 2 | **Verifier scope: leaf-only (TrivialProp + ProveDlog + ProveDhTuple)** | Full verifier (all 6 SigmaBoolean variants including Cand/Cor/Cthreshold). | The structural `SigmaBoolean` type must include all 6 variants (wire parsing requires it), but the runtime verifier walks only the 3 leaf-style. Cthreshold polynomial arithmetic naturally belongs with the eval arms that *construct* conjectures (`Atleast`/`SigmaAnd`/`SigmaOr`) — same testing fixtures, same crypto-spec-compliance gates, shipped together in 2g-combinators. Real-world P2PK is leaf-only; this unlocks the most common case. Trade-off: a `Const(SSigmaProp, Cand(...))` from a hardcoded multi-sig constant throws `'conjecture-not-implemented'` in 2g-medium. C2 corpus doesn't care (corpus uplift waits for 2g.5 method-call dispatch). |
| 3 | **No standalone `reduceToCrypto(tree, opts)` public function** | Expose `reduceToCrypto(tree, opts) → SigmaBoolean` alongside `verifySignature`. | `evaluate(tree, opts)` already plays this role — a tree whose body evaluates to a SigmaProp returns the structural SigmaBoolean inside. Caller does `evaluate(tree, opts).value` to get a `SigmaBoolean` ready for `verifySignature`. Adding a second public function with semantically-equivalent behavior is YAGNI; can be added later without breaking change if real consumers ask. |
| 4 | **No combined `verify(tree, opts, proof, msg)` public function** | Ship a 4-argument convenience entry point alongside `verifySignature`. | Three lines of caller composition. YAGNI per the project's discipline. The convenience function's main benefit (cost telemetry from `evaluate`) is already available via `evaluateWith` if needed. |
| 5 | **Empty signature throws `'empty-signature'` instead of silently returning false** | Mirror sigma-rust's `Ok(false)` posture for empty proofs (`sig_serializer.rs:118-128`). | The TS port's typed-throw discipline (per the Iron Law of fail-fast) lets callers distinguish "empty proof" from "bad proof". A boolean false silently swallows the information. Acknowledged divergence from sigma-rust; documented in the error taxonomy. |
| 6 | **`'scalar-out-of-range'` is a typed throw, not silent reduce-mod-n** | Mirror sigma-rust's `Scalar::reduce_bytes` posture (silently accept any 32 bytes). | Same reasoning as Decision #5 — surfacing as a typed throw gives callers telemetry on malformed proofs. The 32-byte read still goes through `scalarFromBytes` which does the mod-n reduction internally; the throw fires only when the raw bytes encode a value ≥ n. Defensive against truncation-style attacks where a proof artificially exceeds n to test verifier robustness. |
| 7 | **50-JitCost P2PK short-circuit lands in 2g-medium** (not deferred) | Defer to a Layer C3-cost slice (phase 2j). | Cost values are sigma-rust-accurate from day one (project discipline). Without the short-circuit, P2PK trees undercharge by 10× and the eval-arm fixtures for `CreateProveDlog`/`CreateProveDhTuple` would mismatch sigma-rust on standalone-Const trees. Smoking-gun fixture (`p2pk-short-circuit.json`) locks the 50-JitCost charge. |
| 8 | **Discriminator field is `tag` (not `kind`)** | Use `kind` to match `SValue.kind`. | `Expr.tag` and `SType.tag` use `tag`; `SValue.kind` is the outlier (chosen historically because `SValue` carries values, and `kind` reads better at value sites). `SigmaBoolean` is a type-like discriminated union, not a value sum — `tag` is the better fit and matches the 6 sigma-protocol variants' Rust naming. |
| 9 | **`@noble/curves` adapter exposes ~9 functions, no broader surface** | Expose the full `@noble/curves/secp256k1` re-export as the adapter. | YAGNI — the leaf-only verifier uses exactly these 9 operations. A broader re-export tempts downstream consumers to depend on curve internals that may not survive future `@noble/curves` upgrades. Thin adapter localizes the dependency surface. |
| 10 | **`expectGroupElement` is a small local helper inside `create-prove-dh-tuple.ts`** | Promote to `eval/_sigma-helpers.ts` (analogous to `_coll-helpers.ts` from phase 2f Coll HOFs). | 4 callers in 2g-medium. YAGNI promotion threshold (per 2d-B's precedent — promote on third independent module's third caller). If 2g-combinators adds more arms with the same check (likely — `Atleast`/`SigmaAnd`/`SigmaOr` may want `expectSigmaProp`), promote then with a `_sigma-helpers.ts` module. |
| 11 | **Flat 8-task list; per-task commits; no `Stop α/β/γ` markers** | Three-stop structure (matches phase 2f narrow + medium); two-stop split between wire-refactor + arms vs verifier. | Per [[feedback-no-artificial-stops]] memory. No real reason to pause mid-slice — no major refactor, no breaking change requiring user input. The verifier impl (Task 6) is confidence-sensitive but doesn't need a synchronous user-checkpoint; the two-stage review pattern catches issues. |
| 12 | **C3.a SKIPPED for 2g-medium** | Opt-in C3.a for the 2 new eval arms. | The arms are pure structural wraps (just type-check input + wrap). C3.a operators (O1 replaceLeafConst, O2 swapBinaryChildren, etc.) don't produce meaningful coverage gain over Layer C1 fixture-equality. C3.a re-engages at 2g-combinators where Atleast/SigmaAnd/SigmaOr have richer eval surface. Phase 2f Coll HOFs's `eval-mutation.test.ts` continues to run unchanged. |
| 13 | **Wire-format refactor (Task 1) lands before eval arms (Tasks 3-4) and verifier (Tasks 5-6)** | Lump everything in parallel; ship arms in their own slice. | Hard dependency: Tasks 3-6 all consume the structural `SigmaBoolean` type. Wire-format refactor must land first or downstream tasks build on a stale type. Same TDD discipline as prior slices (foundation first). |
| 14 | **Fixture-gen uses sigma-rust's deterministic-nonce prover** (no PRNG seeding logic needed) | Build a deterministic-prover wrapper that seeds explicitly. | Source-read confirmed sigma-rust's Schnorr signer uses Blake2b-256 for nonce derivation (`dlog_protocol.rs:113-149`) — deterministic by default. The determinism gate (two-run cargo + diff) catches any accidental drift to a non-deterministic entry point. |

## Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Challenge-to-scalar conversion wrong direction** — 24-byte challenge gets right-padded instead of left-padded, or reduced before padding instead of after | Source-read pin: `wscalar.rs:69-76` cites `Vec<u8>` byte slice with `[0u8; 8]` prepended. C1 + V1 fixtures use real sigma-rust-signed proofs; recompute path mismatch surfaces as a verify=false failure. Implementer + reviewer cite the line at Task 5 implementation. |
| 2 | **Fiat-Shamir tree serialization byte-disagreement with sigma-rust** | The most likely-to-fail correctness check. V1 positive fixtures from sigma-rust's prover are the only signal — if recomputed challenge doesn't byte-equal the captured challenge, the bug is in `fiat-shamir.ts`. Per-byte trace logging available during Task 6 debug if needed (test-only flag, not shipped). |
| 3 | **`prop_bytes` wrap detail missed** — implementer serializes just the SigmaBoolean raw bytes instead of wrapping in ErgoTree v0 + constant-segregation=true | Decision-log #14 + per-leaf cite to `fiat_shamir.rs:148-157`. C1 smoking-gun fixture isolates a single-leaf ProveDlog verify; if `prop_bytes` is wrong, this fixture fails before more complex cases. |
| 4 | **Identity-point conversion mismatch** — adapter `decodePoint(33-zeros)` returns curve identity correctly; `encodePoint(identity)` returns wrong bytes | Adapter unit tests (Task 2) include both directions: `encodePoint(decodePoint(zeros)) === zeros` and the reverse. Defense-in-depth: source-read notes sigma-rust's `exponentiate(identity, k)` silently returns identity — verify path may "succeed" with malformed proof. Explicitly check `h ≠ identity` on `ProveDlog`/`ProveDhTuple` decode as a defense (decision deferred to Task 5 implementation — not blocking). |
| 5 | **Point-on-curve check missed** — adapter accepts off-curve SEC1 bytes silently, then verification produces spurious results | `@noble/curves`'s `Point.fromBytes` rejects off-curve by default. Adapter unit tests (Task 2) include an off-curve byte sequence and assert the typed throw. |
| 6 | **VLQ vs big-endian confusion in child counts** — `Cand`/`Cor` use `put_u16`-VLQ on the wire but `put_i16_be_bytes` (2-byte BE) in Fiat-Shamir | Decision-log warning. Source cites: `cand.rs:67-69` (VLQ wire), `fiat_shamir.rs:197` (BE hash input). Per-byte trace in Task 6 debug. Two-stage reviewer at Task 6 specifically asks the implementer to cite which encoding each call uses. |
| 7 | **Determinism regression in fixture-gen** — sigma-rust's prover accidentally invoked in non-deterministic mode | Two-run `cargo run -p fixture-gen --release` + diff check per fixture-gen task. Pattern from phase 2f medium Task 1 caught a real regression; carries over. |
| 8 | **P2PK short-circuit lands cost 50 instead of 5 + 45 = 50 in the wrong order, breaking other Const fixtures** | C1 smoking-gun fixture (`p2pk-short-circuit.json`) locks the 50 charge for a bare SSigmaProp Const. Existing phase 2b Const fixtures use Boolean/Long/Int Consts — unaffected. Reviewer verifies the Const-arm conditional gates on `value.kind === 'SigmaProp'`. |
| 9 | **Wire-format refactor breaks existing phase 2a roundtrip fixtures** | Task 1 explicitly runs the 255-fixture roundtrip + 6221-flip mutation suite as the acceptance gate. Any regression blocks Task 1. The internal representation changes but the bytes don't; if bytes mismatch, the refactor has a serialization bug. |
| 10 | **`isP2PK` / `p2pkPublicKey` semantics drift** during refactor | The public functions retain their signatures + invariants from `facts/ergoscript.md`. Existing tests for these helpers (under `test/crypto/p2pk.test.ts` or equivalent) must pass post-refactor without fixture changes. Reviewer reads `facts/ergoscript.md`'s `isP2PK`/`p2pkPublicKey` postconditions at Task 1 review time. |
| 11 | **Verifier returns true for malformed proof** — false-positive verification (the worst possible bug for a verifier) | V2 mutation fixtures byte-flip every signature byte; each must yield false or a typed throw. If any mutation yields true, the verifier has a vulnerability. V1 fixtures with negative cases (wrong signature for known SigmaBoolean) catch additional malformed-but-valid-looking inputs. |
| 12 | **`@noble/curves` API drift between 2.x minors** | Pin exact `2.2.0` (no caret); upgrade only with explicit version bump + full V1+V2 re-run. Same posture as `@noble/hashes` 2.2.0 from phase 2a. Version-locked pair documented in `crypto/secp256k1.ts` header comment. |
| 13 | **Subagent missing a sigma-protocol-specific detail** — the surface is unfamiliar relative to prior slices' arithmetic/logical work | Subagent prompts include the relevant source-read findings + cite the specific `sigma_protocol/` files for the task. Two-stage reviewer specifically checks crypto-protocol details against sigma-rust on the verifier-implementation tasks (Task 5, Task 6). Confidence-escalation flag in the spec (OVERRIDES #2) makes this explicit. |
| 14 | **C2 corpus regression (`expect(other).toBe(0)` trips)** | Task 8 explicitly re-runs `test/corpus-eval.test.ts` before commit-and-push. Phase 2g-medium does not introduce arms that the corpus reaches before its existing failure points — the corpus aggregate is structurally stable. |

## Validation against this spec at Task 8 finalize

Task 8's spec-compliance check verifies:

1. **Coverage line in `facts/ergoscript.md`** reflects 42 → 44 of ~70 arms.
2. **EvalError taxonomy in `facts/ergoscript.md`** documents the new code (`'sigma-prop-input-not-group-element'`) with one-line semantics.
3. **VerifyError class** documented in `facts/ergoscript.md` with all ~5 codes.
4. **SigmaBoolean shape change** documented in `facts/ergoscript.md` (the 6-variant union; replacing the opaque-bytes shape from phase 2a).
5. **New public function** (`verifySignature`) documented in `facts/ergoscript.md` with precondition / postcondition / invariants.
6. **`@noble/curves@2.2.0` documented** in `facts/ergoscript.md`'s dependency section.
7. **P2PK short-circuit** (50 JitCost on `Const(SSigmaProp, _)`) documented in `facts/ergoscript.md`'s `Const` arm section.
8. **Umbrella plan** annotated for 2g-medium complete + `2g-combinators` flagged with scope (Atleast/SigmaAnd/SigmaOr + conjecture verifier extension).
9. **`SESSION_CONTEXT.md`** snapshot matches the end state (44 arms wired; 36 EvalError codes; new VerifyError class; structural SigmaBoolean; `@noble/curves@2.2.0` dep added).
10. **`project_ergots_direction` memory** updated: phase 2g-medium shipped; next is 2g-combinators (verifier extension + 3 deferred sigma combinators), then 2g.5 method-call dispatch.
11. **`project_sigma_combinators_deferred` memory** updated to reflect scope split: 2g-combinators now bundles eval arms + Cthreshold polynomial verifier.
12. **`MEMORY.md` index** hook lines updated.
13. **Test counts:** prior 1894 ergoscript tests stay green; new per-arm C1 tests pass; new V1 + V2 verifier tests pass; new wire-format per-variant fixtures pass; all 305 proof tests unaffected. All run in both `node` + `jsdom`.
14. **`expect(other).toBe(0)` regression gate in `corpus-eval.test.ts`** stays green.
15. **No new browser-incompatible primitives.** Bundle-scan check (no `Buffer`, no `node:*`, no WASM) passes.

---

*End of design spec.*
