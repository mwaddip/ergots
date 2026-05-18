# ErgoScript Interpreter — Phase 2g-combinators Design Spec (Sigma combinators + conjecture verifier)

**Status:** Draft
**Date:** 2026-05-17
**Package:** `@ergots/ergoscript` (phase 2g-combinators — sigma combinators eval arms + conjecture verifier walk)
**Phase plan:** `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella spec; this slice closes the umbrella's "phase 2g = Sigma protocol" promise by extending phase 2g-medium's leaf-only verifier to the full 6-variant SigmaBoolean surface, and adds the 3 deferred sigma-combinator eval arms)
**Sister specs:**
- `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` (immediate predecessor — leaf-only verifier; structural `SigmaBoolean`; `@noble/curves` adapter; manual deterministic Schnorr signing in fixture-gen)
- `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` (defines the 3 deferred sigma combinators — `Atleast`/`SigmaAnd`/`SigmaOr` — and the three-mechanism deferral tracking)
- `docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md` (Layer C3.a operator-driven mutation testing; spec-writing conventions; flat-task-list workflow)
**Interface contract:** `facts/ergoscript.md` (extended additively per phase)
**Brainstorm transcript:** session 2026-05-17 (post-phase-2g-medium)

## Goal

Ship phase 2g-combinators: the sigma-combinator eval arms and the conjecture verifier walk. By the end of this slice:

- **Three new evaluator arms:** `Atleast`, `SigmaAnd`, `SigmaOr`. All Pattern B (per-item) cost. `Atleast` calls `cthresholdReduce(k, items)`; `SigmaAnd` calls `candNormalized(items)`; `SigmaOr` calls `corNormalized(items)`. Coverage: 44 → 47 of ~70 arms.
- **Three normalization helpers** in a new `mir/sigma-boolean-normalize.ts` module — `cthresholdReduce`, `candNormalized`, `corNormalized` — direct ports of sigma-rust's `cthreshold.rs:34-84` / `cand.rs:29-50` / `cor.rs:29-50`.
- **GF(2^192) field arithmetic + polynomial** in a new `crypto/gf2_192.ts` module. Table-optimized (matches sigma-rust's `IRRED_MULS [i64; 16]` 4-bit nibble multiplication structure). Public surface: `Gf2_192Element` (24-byte) with add/multiply/sqr/invert/equals/fromBytes/toBytes; `Gf2_192Poly` with `interpolate(points, values, valueAtZero)` / `evaluate(x)` / `toBytes()`. Irreducible polynomial: x^192 + x^7 + x^2 + x + 1.
- **Verifier extension** in `sigma/verifier.ts`. Removes the `'conjecture-not-implemented'` throw and replaces it with the recursive conjecture walk per `sig_serializer.rs:174-245`:
  - **Cand**: all children inherit parent's challenge.
  - **Cor**: read explicit challenges for first (n-1) children; last child's challenge = XOR(parent, all others).
  - **Cthreshold**: read polynomial bytes (length = (n-k)*24, no length prefix); reconstruct polynomial with coeff_0 = parent challenge; each child i (1-based) gets challenge = Q(i).
- **Sig-serializer extension** in `sigma/sig-serializer.ts` — `ProofBytesReader` extended for variable-length conjecture-specific reads.
- **Fixture-gen extension** — manual deterministic conjecture signing recipe extending phase 2g-medium's leaf-only recipe. Simulated children get deterministic challenges via `blake2b(domain || index || msg)`; real children's challenges derived per conjecture protocol. Cross-validation gate: sigma-rust's `verify_signature` returns true on every generated fixture.
- **Three new `EvalError` codes** (36 → 39): `'atleast-bound-not-int'`, `'sigma-prop-coll-elem-not-sigma-prop'`, `'sigma-prop-input-not-coll'`.
- **Three new `VerifyError` codes** (5 → 8): `'cthreshold-polynomial-bytes-mismatch'`, `'cor-derived-challenge-mismatch'`, `'cthreshold-derived-challenge-mismatch'`. The 2g-medium `'conjecture-not-implemented'` code stays declared but becomes unreachable.

Public function signatures (`evaluate`, `evaluateWith`, `makeContext`, `EvalError`, `verifySignature`, `VerifyError`) stay stable. `SigmaBoolean` shape unchanged from 2g-medium. The slice is purely additive on the public surface.

The slice is implemented as 11 sequential tasks in flat `PLAN.md` ordering. Commits between each task; no `Stop α/β/γ` markers (per [[feedback-no-artificial-stops]] memory). Tasks 2 and 3 (GF(2^192) element + polynomial) each get their own dedicated subagent session.

## Non-goals

- **Method-call dispatch** (`MethodCall` / `PropertyCall`). Phase **2g.5**. This is the actual C2 corpus unlocker.
- **Sigma-protocol prover.** Construction of proofs (Schnorr signing of conjecture trees, deterministic-nonce derivation for prover-side use) remains a wallet concern; deferred to phase 3. The fixture-gen extension is fixture-only — not a public prover surface.
- **AVL+ membership-proof verification.** Phase 2h.
- **Byte-array conversions** (`ByteArrayToLong`, `LongToByteArray`, `ByteArrayToBigInt`). Phase 2i.
- **Hash predefs** (`CalcBlake2b256`, `CalcSha256`, `DecodePoint`). Phase 2i.
- **`SubstConstants`** and `Xor` byte-array. Phase 2i.
- **Layer C3-cost real-context cost validation.** Phase 2j.
- **Carryover cleanup from 2g-medium.** `VerifyError 'scalar-out-of-range'` (declared but never thrown), unused `assertConsumed()` method, defensive i16-range nit in `buildFiatShamirLeaf` — all stay as-is. Independent micro-cleanup slice if/when.
- **GF(2^192) advanced optimizations** beyond sigma-rust's table approach (SIMD, batch multiplication, FFT-based interpolation). The table-optimized port matches sigma-rust's structure; further optimization is phase 2j territory if cost-equivalence testing surfaces a need.
- **`npm publish` of `@ergots/ergoscript@0.3.0`.** Separate user decision; the natural milestone is end-of-2g-combinators when the full SigmaBoolean verifier surface is shipped. Bundled with this slice or sequenced separately — user's call.

## Architecture

### Directory layout

```
packages/ergoscript/src/
├── mir/
│   ├── types.ts                              UNCHANGED (SigmaBoolean already 6-variant from 2g-medium)
│   └── sigma-boolean-normalize.ts            NEW: cthresholdReduce, candNormalized, corNormalized
├── crypto/
│   ├── secp256k1.ts                          UNCHANGED (2g-medium)
│   ├── hashes.ts                             UNCHANGED
│   └── gf2_192.ts                            NEW: Gf2_192Element + Gf2_192Poly with IRRED_MULS table
├── sigma/
│   ├── challenge.ts                          UNCHANGED (already has challengeXor from 2g-medium)
│   ├── fiat-shamir.ts                        UNCHANGED (leaf prop-bytes pattern reused for conjectures via recursive walk)
│   ├── sig-serializer.ts                     MODIFIED: ProofBytesReader gains readBytes(n) for polynomial bytes
│   ├── errors.ts                             MODIFIED: 3 new VerifyError codes
│   └── verifier.ts                           MODIFIED: conjecture walk replaces 'conjecture-not-implemented' throw
├── eval/
│   ├── eval.ts                               MODIFIED: 3 new case lines
│   ├── errors.ts                             MODIFIED: 3 new EvalError codes
│   ├── _sigma-helpers.ts                     NEW: expectSigmaProp + extractSigmaPropColl
│   ├── atleast.ts                            NEW: Atleast arm
│   ├── sigma-and.ts                          NEW: SigmaAnd arm
│   └── sigma-or.ts                           NEW: SigmaOr arm
└── index.ts                                  UNCHANGED (no public-surface additions; 2g-medium's verifySignature now handles the full SigmaBoolean surface)

packages/ergoscript/test/
├── mir/sigma-boolean-normalize.test.ts       NEW
├── crypto/gf2_192.test.ts                    NEW: per-op cross-validation
├── eval/atleast.test.ts                      NEW: C1 + C3.a
├── eval/sigma-and.test.ts                    NEW: C1 + C3.a
├── eval/sigma-or.test.ts                     NEW: C1 + C3.a
├── sigma/sig-serializer.test.ts              MODIFIED: conjecture byte-read tests
├── sigma/verifier.test.ts                    MODIFIED: V1 + V2 fixtures for Cand/Cor/Cthreshold
└── fixtures/                                 NEW per-arm + GF(2^192) cross-validation + verifier-conjecture fixtures

fixture-gen/src/cmds/ergoscript/
├── crypto/gf2_192_ops.rs                     NEW: per-op input/output fixtures for cross-validation
├── eval/atleast.rs                           NEW
├── eval/sigma_and.rs                         NEW
├── eval/sigma_or.rs                          NEW
├── verify/verifier_cand.rs                   NEW: positive + reject + mutation Cand fixtures
├── verify/verifier_cor.rs                    NEW: positive + reject + mutation Cor fixtures
└── verify/verifier_cthreshold.rs             NEW: positive + reject + mutation Cthreshold fixtures
fixture-gen/src/main.rs                       MODIFIED: new generate_and_write calls
fixture-gen/Cargo.toml                        MODIFIED: gf2_192 crate dependency added (path or git per sigma-rust workspace)
```

### Normalization helpers (`mir/sigma-boolean-normalize.ts`)

Three pure functions, no side effects, no `EvalContext` interaction. Direct ports of sigma-rust:

```ts
// Direct port of cthreshold.rs:34-84
export function cthresholdReduce(k: number, items: SigmaBoolean[]): SigmaBoolean

// Direct port of cand.rs:29-50 (TrivialProp filtering + absorbing/identity laws)
export function candNormalized(items: SigmaBoolean[]): SigmaBoolean

// Direct port of cor.rs:29-50
export function corNormalized(items: SigmaBoolean[]): SigmaBoolean
```

**`cthresholdReduce` collapse rules** (per `cthreshold.rs:34-84`):
- `k === 0` → `{ tag: 'TrivialProp', value: true }`
- `k > items.length` → `{ tag: 'TrivialProp', value: false }`
- Iterate items left-to-right with mutable `curr_k`, `children_left`, and `accumulated`:
  - **Mid-loop short-circuit (before processing item i):**
    - If `curr_k === 1` → append all remaining items (i through end) to `accumulated`, then return `corNormalized(accumulated)`.
    - If `curr_k === children_left` → append all remaining items, then return `candNormalized(accumulated)`.
  - **Per-item update (only if no short-circuit fired):**
    - `TrivialProp(true)` → decrement both `curr_k` and `children_left`; NOT appended to accumulated.
    - `TrivialProp(false)` → decrement only `children_left`; NOT appended.
    - Non-trivial children → appended to `accumulated`.
- After loop completes (no short-circuit fired):
  - If `curr_k === 1` → `corNormalized(accumulated)`.
  - If `curr_k === children_left` → `candNormalized(accumulated)`.
  - Otherwise → `{ tag: 'Cthreshold', k: curr_k, items: accumulated }`.

**`candNormalized` rules** (per `cand.rs:29-50`):
- Filter out `TrivialProp(true)` (identity element for AND).
- If any child is `TrivialProp(false)` → `TrivialProp(false)` (absorbing element for AND).
- If filtered list is empty → `TrivialProp(true)`.
- If single child remains → that child unwrapped.
- Otherwise → `{ tag: 'Cand', items: filtered }`.

**`corNormalized` rules** (per `cor.rs:29-50`):
- Filter out `TrivialProp(false)` (identity element for OR).
- If any child is `TrivialProp(true)` → `TrivialProp(true)` (absorbing element for OR).
- If filtered list is empty → `TrivialProp(false)`.
- If single child remains → that child unwrapped.
- Otherwise → `{ tag: 'Cor', items: filtered }`.

The functions are pure and recursive-safe (no normalization of nested Cand-of-Cand within `candNormalized` itself — that would be additional restructuring sigma-rust does NOT do at this layer).

### GF(2^192) module (`crypto/gf2_192.ts`)

Table-optimized direct port of `gf2_192/src/gf2_192.rs` + `gf2_192poly.rs`. ~700-900 LOC TS estimated (more compact than the 1,365 LOC Rust thanks to BigInt vs i64-manipulation overhead).

**Internal representation:** `[bigint, bigint, bigint]` — three 64-bit BigInts mirroring sigma-rust's `[i64; 3]`. Operations treat each BigInt as an unsigned 64-bit value (high-bit-set values are positive BigInts in TS, not sign-extended).

**Public surface:**

```ts
export class Gf2_192Element {
  constructor(words: [bigint, bigint, bigint])

  static readonly ZERO: Gf2_192Element
  static readonly ONE: Gf2_192Element

  static fromBytes(bytes: Uint8Array): Gf2_192Element  // 24-byte BE, throws on != 24
  toBytes(): Uint8Array                                 // 24-byte BE, defensive copy

  add(other: Gf2_192Element): Gf2_192Element            // XOR (trivial for GF(2^n))
  multiply(other: Gf2_192Element): Gf2_192Element       // Table-based; IRRED_MULS reduction
  sqr(): Gf2_192Element                                 // Squaring shortcut per gf2_192.rs:203
  invert(): Gf2_192Element                              // Extended Euclidean per gf2_192.rs:173
  equals(other: Gf2_192Element): boolean
  isZero(): boolean
  isOne(): boolean
}

export class Gf2_192Poly {
  // Lagrange interpolation: passes through (points[i], values[i]) and (0, valueAtZero).
  // points must be distinct u8 values, all != 0. values.length === points.length.
  // Mirrors gf2_192poly.rs:71.
  static interpolate(
    points: number[],          // u8 each, distinct, non-zero
    values: Gf2_192Element[],
    valueAtZero: Gf2_192Element
  ): Gf2_192Poly

  // Horner's method per gf2_192poly.rs:116. x is u8 (1-based child index in conjecture context).
  evaluate(x: number): Gf2_192Element

  // Serializes degree-1 through degree-N coefficients (NOT the degree-0 coefficient).
  // Output length = degree * 24 bytes. Mirrors gf2_192poly.rs:133.
  toBytes(): Uint8Array

  readonly degree: number  // n - 1 where polynomial has n coefficients
}
```

**Multiplication algorithm:**

Table-based 4-bit nibble multiplication per `gf2_192.rs:82-153`. The `IRRED_MULS [i64; 16]` precomputed table is ported as a module-level constant `IRRED_MULS_TABLE: readonly bigint[]` (16 entries, each a 64-bit BigInt). The algorithm:

1. Treat `b` as a polynomial; iterate over its 192 bits in groups of 4.
2. For each 4-bit nibble of `b`, look up the partial product contribution from `IRRED_MULS_TABLE`.
3. Accumulate into a 384-bit intermediate (6 BigInts) via XOR.
4. Reduce the upper 192 bits modulo the irreducible polynomial using the table.

The bit-manipulation patterns from sigma-rust translate directly: `i64 & 0xF` → `bigint & 0xFn`; `(i64 << 4)` → `(bigint << 4n)`; `(i64 ^ i64)` → `(bigint ^ bigint)`.

**Irreducible polynomial constants:**

```ts
// Pentanomial: x^192 + x^7 + x^2 + x + 1
// Per gf2_192.rs:31. Represented as the low 8 bits of x^192 reduced.
const IRRED_PENTANOMIAL: bigint = 0xE7n  // 11100111 = x^7 + x^6 + x^5 + x^2 + x + 1
// NOTE: Sigma-rust calls this "pentanomial" but the value 0xE7 encodes x^7 + x^6 + x^5 + x^2 + x + 1.
// The full irreducible (per the file header) is x^192 + x^7 + x^2 + x + 1; the source-read at
// Task 2 implementation must reconcile this naming if the reduction math doesn't pan out.
// (Spec defers to source; the cross-validation gate catches any mismatch.)

// Precomputed: IRRED_MULS_TABLE[i] = IRRED_PENTANOMIAL multiplied by x^i, for i in 0..16
const IRRED_MULS_TABLE: readonly bigint[]  // 16 entries, each is a 64-bit BigInt
```

**Polynomial interpolation:**

`Gf2_192Poly.interpolate(points, values, valueAtZero)` per `gf2_192poly.rs:71`. Lagrange basis polynomials over GF(2^192). The valueAtZero is the (0, valueAtZero) interpolation point and is treated specially — it becomes coefficient 0 of the resulting polynomial. The other points provide the remaining (n-1) coefficients via standard Lagrange.

In the conjecture-verifier context:
- `valueAtZero` = parent's challenge (24 bytes → Gf2_192Element).
- `points` = 1-based child indices `[1, 2, ..., n]` (where children are simulated; verifier reconstructs polynomial from proof bytes, not from interpolation).

In the prover context (fixture-gen only, not in the verifier):
- `valueAtZero` = root challenge.
- `points` = 1-based indices of simulated children.
- `values` = simulated children's random challenges.
- The resulting polynomial evaluated at real-children's indices gives their derived challenges.

For the verifier, only `evaluate(x)` is needed — the polynomial is reconstructed from proof bytes via `Gf2_192Poly.fromCoefficientsAndConstant(coefficientBytes, valueAtZero)` (a separate constructor). Both paths exist; `interpolate` is fixture-gen-only.

### Verifier conjecture walk (`sigma/verifier.ts`)

The 2g-medium `verifySignature` walks only leaf SigmaBooleans. 2g-combinators extends to the full 6-variant surface via a recursive function:

```ts
function verifyTreeWalk(
  sb: SigmaBoolean,
  challenge: Uint8Array,        // 24-byte challenge for this node
  reader: ProofBytesReader,
  message: Uint8Array,
  expectedRootChallenge: Uint8Array  // for final Fiat-Shamir comparison only
): boolean
```

**Per-variant logic:**

- **`TrivialProp(true)`**: return `challenge` byte-equals expectedRootChallenge (leaf accepts vacuously).
- **`TrivialProp(false)`**: return false (vacuous rejection).
- **`ProveDlog` / `ProveDhTuple`**: per 2g-medium's existing leaf logic. Read scalar(s) from `reader`; compute commitment; compare against Fiat-Shamir hash of (commitment, message).
- **`Cand`**: for each child, recurse with `verifyTreeWalk(child, challenge, reader, message, ...)`. All children inherit `challenge`. All must return true.
- **`Cor`**: read explicit challenges for first (n-1) children via `reader.readChallenge()`. Compute last child's challenge = XOR(parent challenge, all (n-1) read challenges). Recurse on all n children with their per-child challenge. All must return true.
- **`Cthreshold`**: read polynomial bytes (length = (n-k)*24); reconstruct polynomial as `Gf2_192Poly.fromCoefficientsAndConstant(polynomialBytes, parentChallengeAsGf2_192)`. Evaluate at points 1..=n to derive each child's challenge. Recurse on all n children with their derived per-child challenge. All must return true.

**Note on Fiat-Shamir vs proof-byte challenges:** The proof bytes contain only the ROOT challenge (24 bytes) — per-leaf challenges are derived by walking the tree per the rules above. The Fiat-Shamir comparison is between the recomputed-from-commitments root challenge and the proof-bytes root challenge. Each leaf's commitment is computed from its derived challenge + read scalar.

**`verifySignature` orchestration (replaces 2g-medium's leaf-only logic):**

```ts
export function verifySignature(sb: SigmaBoolean, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length === 0) throw new VerifyError('empty-signature', ...)
  if (sb.tag === 'TrivialProp') return sb.value

  const reader = readProofBytes(signature)
  const rootChallenge = reader.readChallenge()  // 24 bytes

  // Recursively walk; accumulates commitments + computes Fiat-Shamir hash at the end
  return verifyTreeWalk(sb, rootChallenge, reader, message, rootChallenge)
}
```

The exact Fiat-Shamir accumulation pattern (how commitments from internal-node children feed up to the root hash check) is governed by sigma-rust's `verifier.rs:60-125` — Task 9 implementer reads this directly and ports the structure.

### Sig-serializer extension (`sigma/sig-serializer.ts`)

`ProofBytesReader` gains:

```ts
class ProofBytesReader {
  // existing 2g-medium methods: readChallenge, readScalarBytes, assertConsumed
  readBytes(n: number): Uint8Array  // NEW: reads exactly n bytes; throws 'truncated-signature' on underrun
}
```

`readBytes` is used by the Cthreshold verifier path to read `(n-k)*24` polynomial bytes. Cor's per-child challenges use the existing `readChallenge`. All defensive `.slice()` copies preserved.

### Eval arms

All three arms follow Pattern B (per-item cost charged via `addPerItemCost` after eval-children).

```ts
// eval/_sigma-helpers.ts (NEW)
export function expectSigmaProp(value: SValue, callerName: string): SigmaBoolean {
  if (value.kind !== 'SigmaProp') {
    throw new EvalError('sigma-prop-coll-elem-not-sigma-prop',
      `${callerName}: expected SigmaProp, got ${value.kind}`)
  }
  return value.value
}

export function extractSigmaPropColl(value: SValue, callerName: string): SigmaBoolean[] {
  if (value.kind !== 'Coll') {
    throw new EvalError('sigma-prop-input-not-coll',
      `${callerName}: expected Coll[SigmaProp], got ${value.kind}`)
  }
  return value.items.map((item, idx) =>
    expectSigmaProp(item, `${callerName} item ${idx}`))
}

// eval/atleast.ts (NEW)
export function evalAtleast(e: Atleast, env: Env, ctx: EvalContext): SValue {
  const boundV = evalExpr(e.bound, env, ctx)
  if (boundV.kind !== 'Int') {
    throw new EvalError('atleast-bound-not-int',
      `Atleast: expected Int bound, got ${boundV.kind}`)
  }
  const inputV = evalExpr(e.input, env, ctx)
  const items = extractSigmaPropColl(inputV, 'Atleast')
  ctx.addPerItemCost(20, 3, 5, items.length)
  return { kind: 'SigmaProp', value: cthresholdReduce(boundV.value, items) }
}

// eval/sigma-and.ts (NEW)
export function evalSigmaAnd(e: SigmaAnd, env: Env, ctx: EvalContext): SValue {
  // Note: SigmaAnd MIR carries `items: Expr[]` (not a single Coll input).
  // Per sigma_and.rs:13-28, items are evaluated individually.
  const items = e.items.map(item => expectSigmaProp(evalExpr(item, env, ctx), 'SigmaAnd'))
  ctx.addPerItemCost(10, 2, 1, items.length)
  return { kind: 'SigmaProp', value: candNormalized(items) }
}

// eval/sigma-or.ts (NEW) — mirror of sigma-and.ts with corNormalized
```

**MIR shape note:** Both `SigmaAnd` and `SigmaOr` have `items: Expr[]` (per sigma-rust's `mir/sigma_and.rs` / `mir/sigma_or.rs` — an array of expressions, NOT a single `Coll[SigmaProp]` expression). `Atleast` has `bound: Expr` (Int) + `input: Expr` (Coll[SigmaProp]). The TS MIR parser at phase 2a already encodes these shapes correctly — Task 4-6 implementers should verify with `mir/types.ts` before writing tests.

### P2PK 50-JitCost short-circuit (no change)

`tryTrivialReduce` in `eval/evaluate.ts` (added in 2g-medium) already short-circuits ANY `Const(SSigmaProp, _)` body regardless of inner SigmaBoolean variant. Bare `Const(SSigmaProp, Cand(...))` or `Const(SSigmaProp, Cthreshold(...))` already gets the 50-JitCost charge correctly. No change needed in 2g-combinators.

### Fixture-gen manual deterministic conjecture signing

Extends the 2g-medium recipe (in `verifier_positive.rs`). New helpers per conjecture:

**Cand recipe:**
- For each child leaf: sign with the parent challenge (each child uses the SAME challenge bytes as the conjecture root).
- Compute commitment via `interactive_prover::first_message` with deterministic nonce `blake2b(domain || w_index || msg)`.
- Compute response `z = w + challenge * secret` (per Schnorr).
- Serialize: write each leaf's z scalar in order (no per-leaf challenges in proof bytes).

**Cor recipe:**
- Pick one "real" child (we know its secret). For the other (n-1) children: simulate.
- For each simulated child: pick a random-but-deterministic challenge `c_i = blake2b(domain || index || msg)[:24]`. Pick a random-but-deterministic z scalar. Compute commitment as `commitment = (g * z) + (-(pk * scalarFromChallenge(c_i)))` (Schnorr verify equation, run "backward").
- The real child's challenge: `c_real = root_challenge XOR (c_1 XOR c_2 XOR ... XOR c_{n-1})` (XOR of all simulated challenges).
- Sign the real child with c_real and a deterministic nonce.
- Serialize: write each simulated child's explicit challenge + z scalar; write only the real child's z scalar (no explicit challenge for the last child).

**Cthreshold recipe:**
- Pick k "real" children and (n-k) simulated.
- For each simulated child: pick deterministic challenge + commitment + z (same backward-Schnorr trick as Cor).
- Construct polynomial: interpolation points are (0, root_challenge) and (idx_i, c_i) for each simulated child (idx_i is 1-based). The polynomial degree is (n-k).
- For each real child at index idx_j: derive its challenge = polynomial.evaluate(idx_j). Sign with that challenge.
- Serialize: write polynomial bytes (degree-1 through degree-(n-k) coefficients; degree-0 is implicit from root challenge); then write each child's z scalar in order (no per-child explicit challenges).

**Cross-validation gate:** After generating each fixture, call sigma-rust's `verify_signature(sb, msg, sig)`. Panic on rejection. This is the load-bearing correctness signal — any byte-format error or algorithm mismatch surfaces before the fixture is committed.

**Determinism gate:** Two-run `cargo run -p fixture-gen --release` + diff check. Any non-determinism (from accidental OS randomness use) trips the gate.

**Dependency note:** The fixture-gen needs the `gf2_192` Rust crate (already in sigma-rust's workspace). Adding it to `fixture-gen/Cargo.toml` is part of Task 2 setup.

## Semantics

Sigma-rust at `integration/ergots@ed5452cf` is the authoritative oracle. Per-arm and verifier semantics confirmed by source-read 2026-05-17 (via Explore agent).

### `Atleast { bound, input }`

Input: `bound: Expr` with `post_eval_tpe == SInt`; `input: Expr` with `post_eval_tpe == Coll[SigmaProp]`. Cost: `addPerItemCost(20, 3, 5, n)` AFTER eval-children (Pattern B). Eval: evaluate `bound` → Int k; evaluate `input` → Coll[SigmaProp]; extract `SigmaBoolean[]`; return `{ kind: 'SigmaProp', value: cthresholdReduce(k, items) }`. The `cthresholdReduce` collapses k=0 / k>n / k=1 / k=n / mid cases per `cthreshold.rs:34-84`.
Source: `ergotree-interpreter/src/eval/atleast.rs:19-58`.

### `SigmaAnd { items: Expr[] }`

Input: `items: Expr[]` where each `item.post_eval_tpe == SSigmaProp`. Cost: `addPerItemCost(10, 2, 1, n)` after eval-children (Pattern B). Eval: evaluate each item to a SigmaProp SValue; collect inner SigmaBooleans; return `{ kind: 'SigmaProp', value: candNormalized(items) }`.
Source: `ergotree-interpreter/src/eval/sigma_and.rs:13-28`.

### `SigmaOr { items: Expr[] }`

Same shape as SigmaAnd but `corNormalized` instead of `candNormalized`.
Source: `ergotree-interpreter/src/eval/sigma_or.rs:13-28`.

### Verifier conjecture walk

See "Verifier conjecture walk" in Architecture. Critical locked details (cite at implementation time):

- **Cand inherits parent challenge.** All children get the same 24-byte challenge as the parent. No per-child challenge in proof bytes.
- **Cor XOR-derive-last.** First (n-1) children have explicit 24-byte challenges in the proof bytes. Last child's challenge = bitwise XOR(parent challenge, all explicit child challenges). The order is: read child challenges in order from the proof; XOR them all together with parent; that's the last child's challenge.
- **Cthreshold polynomial.** Read `(n-k)*24` polynomial bytes. Reconstruct polynomial with coeff_0 = parent challenge (converted to Gf2_192Element via `Gf2_192Element.fromBytes`). Each child i (1-indexed) gets challenge = polynomial.evaluate(i), converted back to 24-byte challenge via `Gf2_192Element.toBytes`.
- **No length prefix on polynomial bytes.** The (n-k) factor is derived from the tree structure (sb.items.length - sb.k). If the proof is too short, `readBytes` throws `'truncated-signature'`.

## Error codes

### New `EvalError` codes (3)

| Code | Emitted by | Failure mode |
|---|---|---|
| `'atleast-bound-not-int'` | `Atleast` arm | `bound` expression evaluated to non-Int. Wire-format invariants make this unreachable for parser-produced trees (sigma-rust's `Atleast::new` requires `bound.post_eval_tpe == SInt`); defensive against `ConstantPlaceholder` injection and future MIR shape changes. |
| `'sigma-prop-coll-elem-not-sigma-prop'` | `Atleast`, `SigmaAnd`, `SigmaOr` (via `_sigma-helpers.ts::expectSigmaProp`) | A `Coll[SigmaProp]` input or individual item expression evaluated to a non-SigmaProp SValue. Wire-format invariants enforce SSigmaProp; defensive. |
| `'sigma-prop-input-not-coll'` | `Atleast` (via `_sigma-helpers.ts::extractSigmaPropColl`) | Atleast's `input` evaluated to non-Coll SValue. (`SigmaAnd`/`SigmaOr` don't take a Coll input — their `items` is an Expr array — so this code only applies to Atleast.) |

Total `EvalError` codes after 2g-combinators: **39** (36 from 2g-medium + 3 new).

### New `VerifyError` codes (3)

| Code | Failure mode |
|---|---|
| `'cthreshold-polynomial-bytes-mismatch'` | Polynomial reconstruction failed at the `Gf2_192Poly.fromCoefficientsAndConstant` layer (bytes length didn't match expected `(n-k)*24`, or a serialized coefficient byte-length was wrong). Practically subsumed by `'truncated-signature'` for length issues; reserved for structural validation if future strictness is added. |
| `'cor-derived-challenge-mismatch'` | The XOR-derived last child's challenge in a Cor node didn't recompute to match the Fiat-Shamir-hashed parent challenge. This is the canonical Cor verification failure signal. |
| `'cthreshold-derived-challenge-mismatch'` | The polynomial-derived child challenge in a Cthreshold node didn't recompute to match the Fiat-Shamir-hashed challenge from the child's commitment. Canonical Cthreshold verification failure. |

The 2g-medium code `'conjecture-not-implemented'` becomes structurally unreachable in 2g-combinators (the conjecture walks are now implemented). It stays declared in `VerifyErrorCode` for ABI stability — callers that catch this code keep working. Documented in the spec at Task 10 as "reserved; no longer thrown."

Total `VerifyError` codes after 2g-combinators: **8** (5 from 2g-medium + 3 new; 1 of the 5 becomes unreachable but stays declared).

## Validation strategy

Five layers stack. C1 + C3.a are existing patterns; **GF(2^192) cross-validation** is new but follows the same fixture-driven shape as 2g-medium's secp256k1 adapter tests; V1 + V2 are existing patterns extended to conjecture variants.

### Layer C1 — per-arm fixture + value/cost asserts

Per-arm `.json` fixtures generated by fixture-gen running `try_eval_out::<Value<'static>>` against sigma-rust at `integration/ergots@ed5452cf`.

**Per-arm fixtures:**

- **`atleast.json`** — ~10 entries: basic (k=2 of 3 ProveDlogs); k=0 (collapses to TrivialProp(true)); k>n (collapses to TrivialProp(false)); k=1 (collapses to Cor); k=n (collapses to Cand); TrivialProp(true) children mixed; TrivialProp(false) children mixed; cost-limit; error path (non-Int bound) via inline TS test.
- **`sigma-and.json`** — ~10 entries: basic 2-item; basic 5-item; mixed with TrivialProp(true); mixed with TrivialProp(false) (absorbing → TrivialProp(false)); single-item (returns the item); empty `items` (returns TrivialProp(true) per identity); cost-limit; error path.
- **`sigma-or.json`** — mirror of sigma-and: ~10 entries with absorbing/identity swapped.

**Inline TS-only error tests** for the defensive throws (non-Int bound for Atleast; non-Coll for Atleast; non-SigmaProp items for SigmaAnd/SigmaOr).

### Layer C2 — corpus regression gate

`test/corpus-eval.test.ts` runs unchanged. Expected outcome: still `success=0 not-impl=18 other=0`. The 18 evaluable corpus trees use method calls and chain-state context fields — none of them reach sigma-combinator paths.

`expect(other).toBe(0)` gate stays green.

### Layer C3.a — eval-mutation testing for the 3 new arms

Operator set per phase 2f Coll HOFs design:
- O1: replace leaf Const with adversarial value
- O2: swap binary children
- O3: drop a Coll item
- O4: duplicate a Coll item
- O5: replace lambda body with a different expression

Per-arm target: ≥ 90% kill rate.

Allowlisted unkillable mutations:
- **Atleast**: mutating `bound` from k to k' where the reduced SigmaBoolean is structurally identical (e.g., k=1 vs k=0 with TrivialProp(true) child producing the same TrivialProp(true) collapse).
- **SigmaAnd/SigmaOr**: child swap mutations where the normalized result is identical (e.g., two TrivialProp(true) children).

### Layer GF(2^192) cross-validation — per-op fixtures

`fixture-gen/src/cmds/ergoscript/crypto/gf2_192_ops.rs` generates per-operation fixtures:

- **`gf2_192-add.json`** — ~20 entries: zero+zero, zero+x, x+zero, x+x (=zero), random pairs.
- **`gf2_192-multiply.json`** — ~30 entries: zero, one, x*one=x, x*zero=zero, x*y for various nonzero x,y, edge values near the irreducible reduction threshold (high-bit-set values forcing reduction).
- **`gf2_192-sqr.json`** — ~10 entries.
- **`gf2_192-invert.json`** — ~10 entries: invert(1)=1; invert(x); x * invert(x) = 1.
- **`gf2_192-interpolate.json`** — ~5 entries: 2-point, 3-point, 5-point interpolations.
- **`gf2_192-evaluate.json`** — ~10 entries: evaluate polynomial from interpolate at points 0..n.

TS tests load each fixture, run the operation, assert byte-equality against captured output. Catches any algorithm-mismatch with sigma-rust's gf2_192 crate.

### Layer V1 — verifier-positive for conjectures

Generated via fixture-gen with manual deterministic conjecture signing (see Architecture). Each fixture entry is `(sigmaBoolean, message, signature) → true`.

**Per-conjecture fixtures:**

- **`verifier-cand.json`** — ~7 entries: Cand(ProveDlog, ProveDlog); Cand of 3 ProveDlogs; Cand(ProveDlog, ProveDhTuple); Cand(ProveDlog, Cor(...)) (nested); Cand of 5 leaves.
- **`verifier-cor.json`** — ~7 entries: Cor(ProveDlog, ProveDlog); Cor of 3 ProveDlogs; Cor(ProveDlog, ProveDhTuple); Cor of 5 leaves; Cor(Cand(...), ProveDlog) (nested).
- **`verifier-cthreshold.json`** — ~7 entries: 2-of-3 Cthreshold; 1-of-3 (collapses to Cor in eval but at verify time we test the un-reduced shape); 3-of-3 (collapses to Cand similarly); 2-of-5; 3-of-5 Cthreshold of mixed Dlog/DhTuple leaves; nested Cthreshold(Cor(...), ProveDlog, ProveDhTuple).

Each fixture cross-validated at fixture-gen time (sigma-rust's `verify_signature` returns true; panic if not).

### Layer V1-reject — verifier-reject for malformed conjectures

- **`verifier-cand-reject.json`** — wrong scalar for one leaf; empty signature; truncated signature.
- **`verifier-cor-reject.json`** — wrong scalar for one leaf; corrupted XOR-derived last child.
- **`verifier-cthreshold-reject.json`** — wrong scalar for one leaf; corrupted polynomial bytes; truncated polynomial bytes.

### Layer V2 — verifier-mutation

Byte-flip each signature byte for one canonical fixture per conjecture. Each mutation must yield `false` or a typed `VerifyError`.

**Special-case mutations for Cthreshold:**
- **Polynomial-bytes mutation** — byte-flip each byte of the `(n-k)*24` polynomial-coefficient bytes. Each must reject (because each child's derived challenge depends on the polynomial).
- **Scalar mutation** — byte-flip each child scalar byte. Each must reject.
- **K mutation** — modifying k externally is not a signature mutation (k is in the SigmaBoolean tree, not the proof). Not tested here; structural.

**Special-case mutations for Cor:**
- **Explicit-challenge mutation** — byte-flip each byte of the first (n-1) children's explicit challenges. Each must reject (the XOR-derived last challenge no longer matches).
- **Scalar mutation** — byte-flip each child scalar byte. Each must reject.

**Special-case mutations for Cand:**
- **Scalar mutation** — byte-flip each child scalar byte. Each must reject (every leaf's Fiat-Shamir hash check fails).

Per-conjecture mutation fixture sizes vary by leaf count and conjecture type. Estimated total ~150-200 mutation entries across all three conjectures.

### Wire-format roundtrip

Existing 255-fixture roundtrip + 6221-flip parse-mutation suite continues to pass. Phase 2g-medium already structured all 6 SigmaBoolean variants for parse + serialize byte-equality.

### Cross-runtime testing

Vitest under `node` + `jsdom` unchanged. BigInt is universally supported. No new browser-incompatible primitives.

### Determinism gate

Two-run `cargo run -p fixture-gen --release` + diff check per fixture-gen task. Critical for Tasks 2, 3 (GF(2^192) fixtures), and 8 (manual conjecture signing). Pattern proven from phase 2g-medium; carries over.

## Task structure

Flat 11-task list. Commits between each task. No `Stop α/β/γ` markers (per [[feedback-no-artificial-stops]] memory). Tasks 2 and 3 each get their own dedicated subagent session per user request.

| # | Task | Subject | Adds |
|---|---|---|---|
| 1 | Normalization helpers | `mir/sigma-boolean-normalize.ts` — `cthresholdReduce` (`cthreshold.rs:34-84`), `candNormalized` (`cand.rs:29-50`), `corNormalized` (`cor.rs:29-50`). Unit tests with edge cases for each. | 3 new module-level functions |
| 2 | **GF(2^192) element** (own session) | `crypto/gf2_192.ts` Part 1: `Gf2_192Element` class with add/multiply/sqr/invert/equals/fromBytes/toBytes. Table-optimized via `IRRED_MULS_TABLE` 4-bit nibble multiplication per `gf2_192.rs:82-153`. Per-op cross-validation fixtures (~70 entries across all ops). | 1 new class, ~700 LOC TS, GF(2^192) cross-validation fixture corpus |
| 3 | **GF(2^192) polynomial** (own session) | `crypto/gf2_192.ts` Part 2: `Gf2_192Poly` class with `interpolate` (fixture-gen-only path), `fromCoefficientsAndConstant` (verifier path), `evaluate`, `toBytes`. Per-op cross-validation fixtures (~15 entries). | 1 new class, ~200 LOC TS, polynomial cross-validation fixtures |
| 4 | Atleast arm | `eval/atleast.ts` (Pattern B, `addPerItemCost(20, 3, 5, n)`) + `eval/_sigma-helpers.ts` (NEW) + C1 fixtures (~10) + C3.a coverage. | 1 new arm, 1 new helper module, 1 new EvalError code (`'atleast-bound-not-int'`), 2 shared EvalError codes from helpers |
| 5 | SigmaAnd arm | `eval/sigma-and.ts` (Pattern B, `addPerItemCost(10, 2, 1, n)`) + C1 fixtures + C3.a coverage. | 1 new arm |
| 6 | SigmaOr arm | `eval/sigma-or.ts` (Pattern B, same cost as SigmaAnd) + C1 fixtures + C3.a coverage. | 1 new arm |
| 7 | Sig-serializer extension | `sigma/sig-serializer.ts` — `ProofBytesReader.readBytes(n)` method + unit tests. | 1 new method |
| 8 | Fixture-gen conjecture signing | `fixture-gen/src/cmds/ergoscript/verify/{verifier_cand,verifier_cor,verifier_cthreshold}.rs` — manual deterministic conjecture signing recipes per Architecture. Cross-validation gate via sigma-rust's `verify_signature`. Determinism gate via two-run. | Fixture corpus for V1 positive + reject + mutation |
| 9 | Verifier conjecture walk | `sigma/verifier.ts` — extend `verifyTreeWalk` for Cand/Cor/Cthreshold variants. Remove `'conjecture-not-implemented'` throw (code stays declared, becomes unreachable). `sigma/errors.ts` — 3 new VerifyError codes. V1 positive + V1 reject + V2 mutation tests pass. | Recursive verifier walk; 3 new VerifyError codes |
| 10 | Docs update | `facts/ergoscript.md` extended (3 new EvalError codes, 3 new VerifyError codes, `'conjecture-not-implemented'` annotated as reserved, coverage 44 → 47, new module references); umbrella plan annotated for 2g-combinators done. Optional: bump v0.2.0 → v0.3.0 in the facts file (decision deferred to user; phase 2g-combinators completes the SigmaBoolean verifier surface, natural minor-version trigger if 2g-medium hasn't already triggered it). | — |
| 11 | Finalize | `SESSION_CONTEXT.md` snapshot; memory updates (`project_ergots_direction` to phase 2g-combinators done; close-out `project_sigma_combinators_deferred` (all 6 things shipped); extend `reference_sigma_verifier_internals` with conjecture-walk crypto details; extend `project_fixture_gen_cargo_gotchas` with manual conjecture-signing recipes); new `reference_gf2_192_internals` memory documenting the polynomial byte format + interpolation invariants; `MEMORY.md` index; commit + push. | — |

**Subagent discipline:** one dispatch per task + two-stage review (spec compliance + code quality). Tasks 2, 3, 8, 9 are Opus-recommended (crypto-sensitive). Other tasks can use Sonnet.

**Confidence-escalation flag (per OVERRIDES #2):** Tasks 2, 3, 9 are the load-bearing crypto-verification path. Implementer + reviewer MUST explicitly cite source lines for each correctness-sensitive equation/algorithm:

- **Task 2 specifics:**
  - `multiply` algorithm: cite `gf2_192.rs:82-153`. 4-bit nibble per-iteration; IRRED_MULS_TABLE for reduction.
  - `invert` algorithm: cite `gf2_192.rs:173-200`. Sigma-rust uses Fermat's little theorem variant (z^(2^192 - 2) = z^(-1) for nonzero z in GF(2^192)).
  - `sqr` shortcut: cite `gf2_192.rs:203-258`. Squaring in characteristic-2 fields has a closed-form bit-interleave.
  - Byte ordering: 24 bytes BE per element. Cite `gf2_192.rs:315-394` for the From/TryFrom impls.
  - IRRED_PENTANOMIAL naming: confirm at implementation time whether `0xE7` is in fact the reduction polynomial; the source-read agent flagged this naming reconciliation. The cross-validation gate catches any mismatch.
- **Task 3 specifics:**
  - `interpolate` Lagrange basis: cite `gf2_192poly.rs:71-115`. The (0, valueAtZero) point is interpolation-special-cased.
  - `evaluate` Horner's method: cite `gf2_192poly.rs:116-132`. 1-based child indices (verifier passes 1..=n).
  - `toBytes` skips degree-0 coefficient: cite `gf2_192poly.rs:133-160`. Length = degree * 24.
- **Task 9 specifics:**
  - Cand challenge inheritance: cite `sig_serializer.rs:174-186`.
  - Cor XOR derivation: cite `sig_serializer.rs:187-214`. Specifically: XOR is over parent + all-but-last children's read challenges; the last child gets the result.
  - Cthreshold polynomial reconstruction: cite `sig_serializer.rs:215-245`. Specifically: coeff_0 = parent challenge as Gf2_192Element; remaining coefficients from polynomial bytes; evaluate at 1..=n for child challenges.
  - Fiat-Shamir leaf prop-bytes (re-used from 2g-medium): cite `fiat_shamir.rs:148-157, 197`. `put_i16_be` for length prefixes (NOT VLQ).
  - Identity-point handling: 33 zero bytes ↔ point-at-infinity is Ergo convention, NOT native SEC1.

**Cross-task dependencies:**

- Task 1 is independent — pure structural normalization.
- Task 2 depends on nothing in this slice.
- Task 3 depends on Task 2 (uses `Gf2_192Element`).
- Tasks 4-6 depend on Task 1 (use normalization helpers).
- Task 7 is independent.
- Task 8 depends on Tasks 2 + 3 (uses GF(2^192) for Cthreshold fixtures).
- Task 9 depends on Tasks 2 + 3 + 7 + 8 (uses GF(2^192) for verifier; sig-serializer extension; fixture corpus).
- Tasks 10 + 11 are pure docs/finalize.

**Critical-path ordering (one possible session sequence):**

- Session A: Task 1 (~2-3h)
- Session B: Task 2 (~6-10h, dedicated)
- Session C: Task 3 (~3-5h, dedicated)
- Session D: Tasks 4, 5, 6 (~4-6h)
- Session E: Task 7 (~1-2h)
- Session F: Task 8 (~6-10h)
- Session G: Task 9 (~6-10h)
- Session H: Tasks 10, 11 (~1-2h)

Total estimate: **28-40h, multi-session**. Higher than the handoff's original 14-18h due to the table-optimized GF(2^192) port being substantial.

## Decision log

| # | Decision | Alternatives considered | Rationale |
|---|---|---|---|
| 1 | **Scope: bundled (all 6 things in one slice)** | Split (2g-combinators-light without Cthreshold polynomial + 2g-combinators-cthreshold as follow-up). | The split version has an asymmetry where `Atleast` constructs a `Cthreshold` SigmaBoolean that the verifier can't verify. Bundled is more coherent end-to-end. User explicitly chose bundled. |
| 2 | **Table-optimized GF(2^192) from the start** | Simple-bitwise GF(2^192) for faster initial port (~300-400 LOC); optimize in phase 2j if cost-equivalence testing surfaces a need. | User preference to avoid future rework. Table-optimized matches sigma-rust's structure (IRRED_MULS [i64; 16] precomputed table; 4-bit nibble multiplication). Larger initial port (~700-900 LOC) but lower future risk. |
| 3 | **`_sigma-helpers.ts` module promotion** | Inline `expectSigmaProp` + `extractSigmaPropColl` in each of the 3 eval arm files. | 3 callers across 3 files crosses the YAGNI threshold for module promotion. (Phase 2g-medium kept `expectGroupElement` inline because 4 callers in 1 file justified inline.) |
| 4 | **Discriminator field is `tag` (consistent with 2g-medium)** | Use `kind` to match `SValue.kind`. | Established by 2g-medium Decision #8. Carries forward. |
| 5 | **`'conjecture-not-implemented'` VerifyError code stays declared, becomes unreachable** | Remove the code entirely. | ABI stability for callers that catch this code. Annotated as reserved in 2g-combinators. |
| 6 | **Verifier extension goes in `verifier.ts`, not a new `verifier-conjecture.ts` module** | Split conjecture walk into its own module. | The conjecture walk is recursive on `verifyTreeWalk` and tightly coupled to the leaf logic (shared challenge state). Inline is simpler than module split. |
| 7 | **`_sigma-helpers.ts` defensive checks live ONE level deep** | Apply the same defensive check recursively (e.g., inside a recursive walk over conjecture children). | The verifier walks recursively but the EVAL arms construct shallow SigmaBoolean nodes (the items come from already-evaluated `Coll[SigmaProp]` or `Expr[]` of SigmaProp expressions). Nested SigmaBoolean structures are constructed by the normalization helpers and verified at the next eval frame (not at the current one). One-level-deep matches sigma-rust's `try_extract_into::<SigmaProp>()` shallow extraction. |
| 8 | **`Gf2_192Element` and `Gf2_192Poly` are classes (not plain types)** | Functional API with `gf2_192Multiply(a, b)`, etc. | Classes match sigma-rust's struct-method shape; methods chain better for polynomial ops; equivalent semantically. The 2g-medium adapter `secp256k1.ts` uses functional API for `decodePoint`/`encodePoint`/etc., but those are stateless conversion ops without internal complexity — the GF(2^192) types carry state and have many ops. |
| 9 | **`Gf2_192Poly.fromCoefficientsAndConstant` is a separate constructor** | Reuse `interpolate` with a degenerate setup. | The verifier doesn't have interpolation points — it has coefficient bytes from the proof and a constant (parent challenge). Two paths, two constructors. |
| 10 | **Fixture-gen `verify_signature` cross-validation is the ONLY correctness signal for conjecture proofs** | Spot-check by recomputing the verification math in Rust before writing fixtures. | The 2g-medium pattern. The cross-validation gate fails fast (panic before write) if the manual signing is wrong. Adding redundant checks doubles fixture-gen complexity without raising confidence. |
| 11 | **Tasks 2 and 3 each get their own subagent session** | Bundle Tasks 2 + 3 into one session. | User preference. Tasks 2 (element math) and 3 (polynomial math) are conceptually separate; the load-bearing crypto in Task 2 deserves focused attention. |
| 12 | **Flat 11-task list; per-task commits** | Three-stop structure; STOP markers between confidence-escalation tasks. | Per [[feedback-no-artificial-stops]]. The two-stage subagent review + the confidence-escalation flag in the spec catch issues without synchronous user-checkpoints. |
| 13 | **C3.a opt-in for the 3 new eval arms (≥ 90% kill rate)** | Skip C3.a (as 2g-medium did for its 2 structural-wrap arms). | These 3 arms have richer eval surface than 2g-medium's `CreateProveDlog`/`CreateProveDhTuple` (input validation; normalization edge cases; conjecture children type-checking). C3.a operators meaningfully exercise the surface. |
| 14 | **Carryover cleanup from 2g-medium stays carryover** | Bundle the carryover fixes into this slice. | Keep the slice focused on the load-bearing crypto work. Carryover is a separate micro-cleanup if/when. |
| 15 | **Verifier extension treats `TrivialProp(true)` at non-root as accept-children-of-trivial-walk** | Treat `TrivialProp(true)` mid-walk as immediate-success-without-recursion. | The `cthresholdReduce` / `candNormalized` / `corNormalized` normalization filters TrivialProp(true) at construction time. So a TrivialProp(true) child inside an un-normalized Cand/Cor/Cthreshold is only reachable via direct wire-bytes injection (a proof bytes constructed adversarially). The verifier MUST still handle it correctly — accept it as a leaf-style verification with `challenge == expectedRootChallenge` byte-equality. Source-read at Task 9 implementation to confirm sigma-rust's exact handling. |

## Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **GF(2^192) byte-equivalence with sigma-rust gf2_192 crate** | Per-op cross-validation fixtures (add/multiply/sqr/invert/interpolate/evaluate). Every operation byte-compared. Any TS implementation that produces different bytes fails the gate. ~70 entries in `gf2_192-multiply.json` alone. |
| 2 | **IRRED_MULS_TABLE precomputation error** | The 16-entry table is a fixed constant. Computed once at module load; values cross-validated against sigma-rust's `gf2_192.rs:35-55` at Task 2 implementation. If the table is wrong, EVERY multiplication produces wrong output — caught immediately by `gf2_192-multiply.json` cross-validation. |
| 3 | **Cor XOR direction wrong** (XOR all-but-last vs all-including-parent) | Source-read pin: `sig_serializer.rs:187-214`. The reduction starts from parent challenge and folds child challenges via XOR. Cor V1 fixtures from sigma-rust prover are the only signal; if the XOR direction is wrong, every Cor verification fails. |
| 4 | **Cthreshold polynomial 0-based vs 1-based child indices** | Source-read pin: `sig_serializer.rs:215-245`. Children evaluated at points 1..=n (1-based). Off-by-one here breaks every Cthreshold verification. V1 fixtures catch immediately. |
| 5 | **Cthreshold polynomial degree mismatch** | The polynomial degree is (n-k), NOT (n-k-1) or (n-k+1). Byte length is `degree * 24 = (n-k) * 24` for the non-constant coefficients. Source-read pin: `cthreshold.rs:115` (`bytes.len() == (n-k) * SOUNDNESS_BYTES`). If off-by-one, polynomial reconstruction fails OR succeeds with wrong polynomial. |
| 6 | **Manual conjecture signing in fixture-gen produces invalid signatures** | Cross-validation gate (sigma-rust's `verify_signature` returns true on every fixture before write). Two-run determinism gate (no OS randomness). Pattern proven in phase 2g-medium for leaf signing; extends to conjectures. |
| 7 | **Fixture-gen polynomial interpolation differs from verifier polynomial reconstruction** | Both use the same `Gf2_192Poly` type (via the Rust crate in fixture-gen, via TS port in the verifier). The cross-validation per-op fixtures catch any algorithmic divergence. |
| 8 | **Verifier returns true for malformed conjecture proof** (false-positive — the worst verifier bug) | V2 mutation fixtures byte-flip every signature byte. Each must yield false. Polynomial-bytes mutation explicitly tested for Cthreshold; explicit-challenge mutation for Cor. |
| 9 | **`cthresholdReduce` normalization edge case wrong** | Source-read pin: `cthreshold.rs:34-84`. The mid-loop short-circuits (curr_k == 1 → Cor; curr_k == children_left → Cand) are subtle. C1 fixtures cover each branch with explicit entries. |
| 10 | **`candNormalized` / `corNormalized` absorbing-element direction wrong** | Source-read pin: `cand.rs:29-50` (TrivialProp(false) absorbs); `cor.rs:29-50` (TrivialProp(true) absorbs). C1 fixtures include each absorbing case + each identity case. |
| 11 | **Atleast `bound` type-confusion** (Int vs Long vs Short) | sigma-rust's MIR enforces `bound.post_eval_tpe == SInt`. The TS arm extracts `boundV.value: number` from `kind: 'Int'`. Defensive throw on non-Int caller (`'atleast-bound-not-int'`). |
| 12 | **`@noble/curves` API drift between 2.x minors** (carryover from 2g-medium) | Pin exact `2.2.0` (no caret). Upgrade only with explicit version bump + full V1+V2 re-run. |
| 13 | **Subagent missing a polynomial-arithmetic detail** | Task 2/3/9 prompts include specific source-read findings + cite the file:line ranges. Two-stage reviewer specifically checks crypto-protocol details against sigma-rust on Tasks 2, 3, 8, 9. Confidence-escalation flag (OVERRIDES #2) makes this explicit. |
| 14 | **C2 corpus regression (`expect(other).toBe(0)` trips)** | Task 11 explicitly re-runs `test/corpus-eval.test.ts` before commit-and-push. Phase 2g-combinators does not introduce arms that the corpus reaches before its existing failure points. |
| 15 | **`gf2_192` Rust crate workspace integration** | `fixture-gen/Cargo.toml` needs to depend on the `gf2_192` crate from the local sigma-rust workspace. Path or workspace dep added at Task 2 setup. Determinism gate (two-run cargo) catches any accidental version drift. |

## Validation against this spec at Task 11 finalize

Task 11's spec-compliance check verifies:

1. **Coverage line in `facts/ergoscript.md`** reflects 44 → 47 of ~70 arms.
2. **EvalError taxonomy in `facts/ergoscript.md`** documents the 3 new codes (`'atleast-bound-not-int'`, `'sigma-prop-coll-elem-not-sigma-prop'`, `'sigma-prop-input-not-coll'`) with one-line semantics.
3. **VerifyError taxonomy in `facts/ergoscript.md`** documents the 3 new codes; `'conjecture-not-implemented'` annotated as reserved (no longer thrown).
4. **GF(2^192) module** documented in `facts/ergoscript.md` (the `Gf2_192Element` and `Gf2_192Poly` types; their public surface; the irreducible polynomial; byte-encoding).
5. **Verifier conjecture-walk** documented in `facts/ergoscript.md`'s `verifySignature` section (full SigmaBoolean surface now handled; Cand/Cor/Cthreshold semantics).
6. **Three new eval arms** (`Atleast`, `SigmaAnd`, `SigmaOr`) documented in `facts/ergoscript.md`.
7. **Normalization helpers** (`cthresholdReduce`, `candNormalized`, `corNormalized`) documented as internal modules.
8. **Umbrella plan** annotated for 2g-combinators complete + remaining phases (2g.5, 2h, 2i, 2j) intact.
9. **`SESSION_CONTEXT.md`** snapshot matches the end state (47 arms wired; 39 EvalError codes; 8 VerifyError codes; full SigmaBoolean verifier surface; new gf2_192 module).
10. **`project_ergots_direction` memory** updated: phase 2g-combinators shipped; next is 2g.5 method-call dispatch.
11. **`project_sigma_combinators_deferred` memory** closed out (all 6 things shipped).
12. **`reference_sigma_verifier_internals` memory** extended with conjecture-walk crypto details.
13. **`project_fixture_gen_cargo_gotchas` memory** extended with manual conjecture-signing recipes + gf2_192 crate dependency note.
14. **`reference_gf2_192_internals` memory** (NEW) documenting the polynomial byte format + interpolation invariants.
15. **`MEMORY.md` index** hook lines updated.
16. **Test counts:** prior 2017 ergoscript tests stay green; new C1 (~30 entries) + GF(2^192) (~70 entries) + V1 (~21 entries) + V1-reject (~9 entries) + V2 (~150-200 entries) + normalization helper unit tests pass; all 305 proof tests unaffected. All run in both `node` + `jsdom`.
17. **`expect(other).toBe(0)` regression gate in `corpus-eval.test.ts`** stays green.
18. **No new browser-incompatible primitives.** Bundle-scan check (no `Buffer`, no `node:*`, no WASM) passes.

---

## Implementation corrections

During Tasks 2-6 implementation, source-reading sigma-rust revealed several spec errors. The implementation followed source; this spec is amended for accuracy:

1. **`IRRED_PENTANOMIAL = 0x87`** (not `0xE7` as initially specified). Sigma-rust at `gf2_192.rs:31` defines `(1i64 << 7) | (1i64 << 2) | (1i64 << 1) | 1i64 = 0x87`. The `0xE7` value would silently break every multiplication that triggers reduction.
2. **`Gf2_192Element` byte serialization is LE-per-word**, not BE. Sigma-rust at `gf2_192.rs:315-324` writes `bytes[i + 8*j] = (word[j] >> (i << 3)) & 0xFF` (little-endian within each 8-byte word, low word first).
3. **`SigmaAnd`/`SigmaOr` cost is Pattern A** (before eval-children), not Pattern B. Sigma-rust at `sigma_and.rs:19` and `sigma_or.rs:19` charges `add_per_item_jit_cost` immediately, before `try_mapped_ref` evaluates the children. `Atleast` IS Pattern B (per `atleast.rs:34` — after eval-children).
4. **A 4th `EvalError` code (`'atleast-bound-out-of-range'`) was added** beyond the spec's 3. Sigma-rust at `atleast.rs:48-53` rejects `bound > input.len()` as a runtime error before `Cthreshold::reduce` is called. The TS arm mirrors this with an explicit pre-check.
5. **`Gf2_192Poly.interpolate` uses Newton-form incremental construction**, not direct Lagrange basis evaluation. Both compute the same polynomial but Newton-form matches sigma-rust's `gf2_192poly.rs:71-115`. The TS port preserves this for byte-equivalence stability.

These corrections do not affect the spec's overall scope, public surface, or task structure — they are implementation-detail clarifications discovered via source-first discipline.

---

*End of design spec.*
