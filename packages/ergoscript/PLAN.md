# Phase 2g-combinators Implementation Plan — `@mwaddip/ergots-ergoscript`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship phase 2g-combinators: 3 deferred sigma-combinator eval arms (`Atleast` / `SigmaAnd` / `SigmaOr`) + 3 normalization helpers (`cthresholdReduce` / `candNormalized` / `corNormalized`) + table-optimized GF(2^192) field + polynomial module + conjecture verifier walk (Cand inherit / Cor XOR-derive-last / Cthreshold polynomial). Coverage 44 → 47 of ~70 arms; 3 new `EvalError` codes; 3 new `VerifyError` codes; 1 new internal helpers module (`eval/_sigma-helpers.ts`); 1 new normalization module (`mir/sigma-boolean-normalize.ts`); 1 new crypto module (`crypto/gf2_192.ts`).

**Architecture:** 11 tasks in flat ordering with commits between each (no `Stop α/β/γ` markers — per `[[feedback-no-artificial-stops]]` memory). Task 1 = pure structural normalization (foundation; eval arms depend). Tasks 2-3 = GF(2^192) field + polynomial (each its own subagent session per user request; verifier depends). Tasks 4-6 = the 3 eval arms (Atleast first due to `_sigma-helpers.ts` introduction; then SigmaAnd / SigmaOr). Task 7 = sig-serializer `readBytes` extension. Task 8 = fixture-gen conjecture signing (Cand + Cor + Cthreshold recipes with cross-validation gate). Task 9 = verifier conjecture walk + V1 + V2. Tasks 10-11 = docs + finalize. Per OVERRIDES #2, Tasks 2/3/9 are confidence-escalation territory — implementer + reviewer cite specific sigma-rust source lines for each correctness-sensitive equation/algorithm.

**Tech Stack:** TypeScript 5.5 (ES2022, ESM only), Vitest 2 with jsdom, Rust fixture-gen calling into sigma-rust's `ergotree-interpreter` + `gf2_192` crates at `integration/ergots@ed5452cf`. **New `fixture-gen/Cargo.toml` dep:** `gf2_192` (path or workspace dep from local sigma-rust). No new TypeScript runtime deps — `@noble/curves@2.2.0` from 2g-medium covers secp256k1; `@noble/hashes@2.2.0` covers blake2b; GF(2^192) is hand-rolled in pure TS via BigInt.

**Source-first discipline:** Read sigma-rust per task before writing any TS. Authoritative sources for 2g-combinators:

- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs:34-84` — `Cthreshold::reduce` collapse rules
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cand.rs:29-50` — `Cand::normalized` TrivialProp filtering + absorbing/identity laws
- `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cor.rs:29-50` — `Cor::normalized` symmetric to Cand
- `~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192.rs` — 1043 LOC; `Gf2_192` element type; `IRRED_PENTANOMIAL = 0xE7`; `IRRED_MULS [i64; 16]` table at lines 35-55; `multiply` at 82-153; `invert` at 173-200; `sqr` at 203-258; byte serialization at 315-394
- `~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192poly.rs` — 260 LOC; `Gf2_192Poly`; `interpolate` at 71-115; `evaluate` at 116-132 (Horner); `to_bytes` at 133-160 (length = `degree * 24`, skips degree-0 coefficient)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/atleast.rs:19-58` — Atleast eval arm; cost `(20, 3, 5, n)`; calls `Cthreshold::reduce`
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sigma_and.rs:13-28` — SigmaAnd eval arm; cost `(10, 2, 1, n)`; calls `Cand::normalized`
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/sigma_or.rs:13-28` — SigmaOr eval arm; cost `(10, 2, 1, n)`; calls `Cor::normalized`
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:174-186` — Cand verifier walk (inherit parent challenge)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:187-214` — Cor verifier walk (XOR-derive-last)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:215-245` — Cthreshold verifier walk (polynomial evaluation at 1..=n)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:69-77` — Cand byte format (no per-child challenges)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:79-90` — Cor byte format ((n-1) explicit challenges + last child no-challenge)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs:91-108` — Cthreshold byte format ((n-k)*24 polynomial bytes inline, no length prefix)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/verifier.rs:60-125` — verify pipeline; `compute_commitments` aggregation
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/prover.rs:568-604` — simulated polynomial construction (`step4_simulated_threshold_conj`)
- `~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/prover.rs:845-900` — real polynomial via Lagrange (`step9_real_threshold`)

Full design rationale: `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md`.

**TDD discipline:** Iron Law per `CLAUDE.md` — no production code without a failing test first. Each task follows red → green → cost-assert → corpus-check → commit. Per-task cadence with two-stage review (spec compliance + code quality).

**Confidence-escalation flag (per OVERRIDES #2):** Tasks 2/3/9 are the load-bearing crypto-verification path. Implementer + reviewer MUST explicitly cite source lines for each of these equations/algorithms:

- **Task 2 (GF(2^192) element):**
  - `multiply` algorithm: cite `gf2_192.rs:82-153`. 4-bit nibble per-iteration; `IRRED_MULS_TABLE` for reduction.
  - `invert` algorithm: cite `gf2_192.rs:173-200`. Fermat's variant (z^(2^192 - 2) for nonzero z).
  - `sqr` shortcut: cite `gf2_192.rs:203-258`. Bit-interleave in characteristic-2.
  - Byte ordering: 24 bytes BE per element. Cite `gf2_192.rs:315-394`.
  - `IRRED_PENTANOMIAL = 0xE7` value: reconcile naming with the actual irreducible polynomial x^192 + x^7 + x^2 + x + 1 at implementation time. The cross-validation gate catches any mismatch.
- **Task 3 (GF(2^192) polynomial):**
  - `interpolate` Lagrange basis: cite `gf2_192poly.rs:71-115`. The (0, valueAtZero) point is interpolation-special-cased.
  - `evaluate` Horner's method: cite `gf2_192poly.rs:116-132`. 1-based child indices in conjecture context.
  - `toBytes` skips degree-0 coefficient: cite `gf2_192poly.rs:133-160`. Length = `degree * 24`.
- **Task 9 (verifier conjecture walk):**
  - Cand challenge inheritance: cite `sig_serializer.rs:174-186`.
  - Cor XOR derivation: cite `sig_serializer.rs:187-214`. Last child's challenge = XOR(parent, all explicit children's challenges read from proof).
  - Cthreshold polynomial reconstruction: cite `sig_serializer.rs:215-245`. coeff_0 = parent challenge as `Gf2_192Element`; remaining `(n-k)` coefficients from polynomial bytes; evaluate at points 1..=n for child challenges (1-based).
  - Fiat-Shamir leaf prop-bytes (reused from 2g-medium): cite `fiat_shamir.rs:148-157, 197`. `put_i16_be` for length prefixes (NOT VLQ).
  - Identity-point handling: 33 zero bytes ↔ point-at-infinity is Ergo convention.

---

## File Structure

**New files (TypeScript source):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/src/mir/sigma-boolean-normalize.ts` | `cthresholdReduce` + `candNormalized` + `corNormalized` pure functions | 1 |
| `packages/ergoscript/src/crypto/gf2_192.ts` | `Gf2_192Element` class + `Gf2_192Poly` class; `IRRED_MULS_TABLE` precomputed | 2, 3 |
| `packages/ergoscript/src/eval/_sigma-helpers.ts` | `expectSigmaProp` + `extractSigmaPropColl` helpers | 4 |
| `packages/ergoscript/src/eval/atleast.ts` | `evalAtleast` arm | 4 |
| `packages/ergoscript/src/eval/sigma-and.ts` | `evalSigmaAnd` arm | 5 |
| `packages/ergoscript/src/eval/sigma-or.ts` | `evalSigmaOr` arm | 6 |

**Modified files (TypeScript source):**

| Path | Change | Task |
|---|---|---|
| `packages/ergoscript/src/eval/eval.ts` | Add 3 new case lines: `Atleast`, `SigmaAnd`, `SigmaOr` | 4, 5, 6 |
| `packages/ergoscript/src/eval/errors.ts` | Add 3 new EvalError codes | 4 |
| `packages/ergoscript/src/sigma/sig-serializer.ts` | Add `readBytes(n)` method to `ProofBytesReader` | 7 |
| `packages/ergoscript/src/sigma/errors.ts` | Add 3 new VerifyError codes; annotate `'conjecture-not-implemented'` as reserved | 9 |
| `packages/ergoscript/src/sigma/verifier.ts` | Replace `'conjecture-not-implemented'` throw with recursive conjecture walk | 9 |

**New files (TypeScript tests):**

| Path | Responsibility | Task |
|---|---|---|
| `packages/ergoscript/test/mir/sigma-boolean-normalize.test.ts` | Unit tests for 3 normalization functions; edge cases | 1 |
| `packages/ergoscript/test/crypto/gf2_192-element.test.ts` | Per-op cross-validation: add/multiply/sqr/invert/equals/serialize | 2 |
| `packages/ergoscript/test/crypto/gf2_192-poly.test.ts` | Per-op cross-validation: interpolate/evaluate/toBytes; round-trip | 3 |
| `packages/ergoscript/test/eval/atleast.test.ts` | C1 fixture-driven + inline error tests | 4 |
| `packages/ergoscript/test/eval/sigma-and.test.ts` | C1 fixture-driven + inline error tests | 5 |
| `packages/ergoscript/test/eval/sigma-or.test.ts` | C1 fixture-driven + inline error tests | 6 |
| `packages/ergoscript/test/sigma/sig-serializer.test.ts` (modify) | Add `readBytes` unit tests | 7 |
| `packages/ergoscript/test/sigma/verifier-conjecture.test.ts` | V1 positive + reject + V2 mutation for Cand/Cor/Cthreshold | 9 |
| `packages/ergoscript/test/eval-mutation/sigma-combinators.test.ts` | C3.a operator-driven mutation for Atleast/SigmaAnd/SigmaOr | 4, 5, 6 (split per arm) |

**New files (Rust fixture-gen):**

| Path | Responsibility | Task |
|---|---|---|
| `fixture-gen/src/cmds/ergoscript/crypto/mod.rs` | Module export | 2 |
| `fixture-gen/src/cmds/ergoscript/crypto/gf2_192_element_ops.rs` | Element cross-validation fixtures | 2 |
| `fixture-gen/src/cmds/ergoscript/crypto/gf2_192_poly_ops.rs` | Polynomial cross-validation fixtures | 3 |
| `fixture-gen/src/cmds/ergoscript/eval/atleast.rs` | Atleast C1 fixtures | 4 |
| `fixture-gen/src/cmds/ergoscript/eval/sigma_and.rs` | SigmaAnd C1 fixtures | 5 |
| `fixture-gen/src/cmds/ergoscript/eval/sigma_or.rs` | SigmaOr C1 fixtures | 6 |
| `fixture-gen/src/cmds/ergoscript/verify/verifier_cand.rs` | Cand V1 positive + reject + V2 mutation | 8, 9 |
| `fixture-gen/src/cmds/ergoscript/verify/verifier_cor.rs` | Cor V1 positive + reject + V2 mutation | 8, 9 |
| `fixture-gen/src/cmds/ergoscript/verify/verifier_cthreshold.rs` | Cthreshold V1 positive + reject + V2 mutation | 8, 9 |

**Modified files (Rust fixture-gen):**

| Path | Change | Task |
|---|---|---|
| `fixture-gen/Cargo.toml` | Add `gf2_192` workspace dep | 2 |
| `fixture-gen/src/main.rs` | Add new `generate_and_write` calls for each new fixture module | 2, 3, 4, 5, 6, 8 |
| `fixture-gen/src/cmds/ergoscript/mod.rs` | Add `pub mod crypto;` line | 2 |
| `fixture-gen/src/cmds/ergoscript/eval/mod.rs` | Add 3 new `pub mod` lines | 4, 5, 6 |
| `fixture-gen/src/cmds/ergoscript/verify/mod.rs` | Add 3 new `pub mod` lines | 8 |

**Fixture corpora (committed to TS test/fixtures/):**

| Path | Owner | Task |
|---|---|---|
| `packages/ergoscript/test/fixtures/crypto/gf2_192-element-ops.json` | Element add/multiply/sqr/invert/equals/serialize entries | 2 |
| `packages/ergoscript/test/fixtures/crypto/gf2_192-poly-ops.json` | Polynomial interpolate/evaluate/toBytes entries | 3 |
| `packages/ergoscript/test/fixtures/eval/atleast.json` | C1 entries | 4 |
| `packages/ergoscript/test/fixtures/eval/sigma-and.json` | C1 entries | 5 |
| `packages/ergoscript/test/fixtures/eval/sigma-or.json` | C1 entries | 6 |
| `packages/ergoscript/test/fixtures/verify/verifier-cand.json` | Cand V1 positive | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cand-reject.json` | Cand V1 reject | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cand-mutation.json` | Cand V2 mutation | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cor.json` | Cor V1 positive | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cor-reject.json` | Cor V1 reject | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cor-mutation.json` | Cor V2 mutation | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cthreshold.json` | Cthreshold V1 positive | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cthreshold-reject.json` | Cthreshold V1 reject | 8 |
| `packages/ergoscript/test/fixtures/verify/verifier-cthreshold-mutation.json` | Cthreshold V2 mutation | 8 |

---

## Task 1: Normalization helpers — `cthresholdReduce` + `candNormalized` + `corNormalized`

**Files:**
- Create: `packages/ergoscript/src/mir/sigma-boolean-normalize.ts`
- Test: `packages/ergoscript/test/mir/sigma-boolean-normalize.test.ts`

**Sigma-rust source-read (REQUIRED before writing any TS):**

```bash
# Read these files fully; cite line ranges in commit message
cat ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cthreshold.rs
cat ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cand.rs
cat ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/sigma_protocol/sigma_boolean/cor.rs
```

- [ ] **Step 1:** Read the three source files; note the exact normalization rules. Key rules to lock:
  - `Cthreshold::reduce(k, children)`: edge cases k=0 (→ TrivialProp(true)), k>n (→ TrivialProp(false)); mid-loop short-circuit at `curr_k == 1` appends remaining children then `Cor::normalized`; mid-loop short-circuit at `curr_k == children_left` appends remaining then `Cand::normalized`; TrivialProp(true) children decrement both `curr_k` and `children_left`; TrivialProp(false) decrement only `children_left`; non-trivial appended; end-of-loop same 3-way classification.
  - `Cand::normalized(items)`: filter TrivialProp(true) (identity); if any TrivialProp(false) → TrivialProp(false) (absorbing); empty after filter → TrivialProp(true); single → unwrap; else → `Cand`.
  - `Cor::normalized(items)`: filter TrivialProp(false) (identity); if any TrivialProp(true) → TrivialProp(true) (absorbing); empty after filter → TrivialProp(false); single → unwrap; else → `Cor`.

- [ ] **Step 2: Write the failing tests** in `packages/ergoscript/test/mir/sigma-boolean-normalize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  cthresholdReduce,
  candNormalized,
  corNormalized,
} from '../../src/mir/sigma-boolean-normalize'
import type { SigmaBoolean } from '../../src/mir/types'

const T: SigmaBoolean = { tag: 'TrivialProp', value: true }
const F: SigmaBoolean = { tag: 'TrivialProp', value: false }
const D = (n: number): SigmaBoolean => ({
  tag: 'ProveDlog',
  h: new Uint8Array(33).fill(n),
})

describe('candNormalized', () => {
  it('filters TrivialProp(true) (identity)', () => {
    expect(candNormalized([D(1), T, D(2)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2)],
    })
  })
  it('returns TrivialProp(false) on any TrivialProp(false) (absorbing)', () => {
    expect(candNormalized([D(1), F, D(2)])).toEqual(F)
  })
  it('returns TrivialProp(true) on empty after filter', () => {
    expect(candNormalized([T, T])).toEqual(T)
  })
  it('unwraps single child', () => {
    expect(candNormalized([D(1), T])).toEqual(D(1))
  })
  it('returns Cand for 2+ non-trivial', () => {
    expect(candNormalized([D(1), D(2)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2)],
    })
  })
})

describe('corNormalized', () => {
  it('filters TrivialProp(false) (identity)', () => {
    expect(corNormalized([D(1), F, D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
  it('returns TrivialProp(true) on any TrivialProp(true) (absorbing)', () => {
    expect(corNormalized([D(1), T, D(2)])).toEqual(T)
  })
  it('returns TrivialProp(false) on empty after filter', () => {
    expect(corNormalized([F, F])).toEqual(F)
  })
  it('unwraps single child', () => {
    expect(corNormalized([D(1), F])).toEqual(D(1))
  })
  it('returns Cor for 2+ non-trivial', () => {
    expect(corNormalized([D(1), D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
})

describe('cthresholdReduce', () => {
  it('k=0 → TrivialProp(true)', () => {
    expect(cthresholdReduce(0, [D(1), D(2), D(3)])).toEqual(T)
  })
  it('k>n → TrivialProp(false)', () => {
    expect(cthresholdReduce(4, [D(1), D(2), D(3)])).toEqual(F)
  })
  it('k=1 with no trivials → Cor', () => {
    expect(cthresholdReduce(1, [D(1), D(2), D(3)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2), D(3)],
    })
  })
  it('k=n with no trivials → Cand', () => {
    expect(cthresholdReduce(3, [D(1), D(2), D(3)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2), D(3)],
    })
  })
  it('k=2 of 3 → Cthreshold(k=2, items)', () => {
    expect(cthresholdReduce(2, [D(1), D(2), D(3)])).toEqual({
      tag: 'Cthreshold',
      k: 2,
      items: [D(1), D(2), D(3)],
    })
  })
  it('TrivialProp(true) child decrements both k and n', () => {
    // [T, D(1), D(2)] with k=2 → after T: curr_k=1, children_left=2; immediately Cor[D(1), D(2)]
    expect(cthresholdReduce(2, [T, D(1), D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
  it('TrivialProp(false) child decrements only n', () => {
    // [F, D(1), D(2)] with k=2 → after F: curr_k=2, children_left=2; immediately Cand[D(1), D(2)]
    expect(cthresholdReduce(2, [F, D(1), D(2)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2)],
    })
  })
  it('mid-loop curr_k==1 collapse appends remaining', () => {
    // k=3 of 4 with [T, T, D(1), D(2)]: after first T curr_k=2,n=3; after second T curr_k=1,n=2 → Cor with [D(1), D(2)] appended
    expect(cthresholdReduce(3, [T, T, D(1), D(2)])).toEqual({
      tag: 'Cor',
      items: [D(1), D(2)],
    })
  })
  it('mid-loop curr_k==children_left collapse appends remaining', () => {
    // k=3 of 4 with [F, D(1), D(2), D(3)]: after F curr_k=3,n=3 → Cand with [D(1), D(2), D(3)] appended
    expect(cthresholdReduce(3, [F, D(1), D(2), D(3)])).toEqual({
      tag: 'Cand',
      items: [D(1), D(2), D(3)],
    })
  })
})
```

- [ ] **Step 3: Run tests, verify they fail.**

Run: `cd packages/ergoscript && npx vitest run test/mir/sigma-boolean-normalize.test.ts`
Expected: All tests fail with module-not-found.

- [ ] **Step 4: Implement** `packages/ergoscript/src/mir/sigma-boolean-normalize.ts`:

```ts
import type { SigmaBoolean } from './types'

// Direct port of cand.rs:29-50
// Filters TrivialProp(true) (identity element for AND).
// If any TrivialProp(false) → TrivialProp(false) (absorbing).
// Empty after filter → TrivialProp(true).
// Single child → that child unwrapped.
// Else → Cand{items}.
export function candNormalized(items: SigmaBoolean[]): SigmaBoolean {
  for (const item of items) {
    if (item.tag === 'TrivialProp' && item.value === false) {
      return { tag: 'TrivialProp', value: false }
    }
  }
  const filtered = items.filter(
    (item) => !(item.tag === 'TrivialProp' && item.value === true),
  )
  if (filtered.length === 0) return { tag: 'TrivialProp', value: true }
  if (filtered.length === 1) return filtered[0]!
  return { tag: 'Cand', items: filtered }
}

// Direct port of cor.rs:29-50 (mirrors candNormalized with absorbing/identity swapped)
export function corNormalized(items: SigmaBoolean[]): SigmaBoolean {
  for (const item of items) {
    if (item.tag === 'TrivialProp' && item.value === true) {
      return { tag: 'TrivialProp', value: true }
    }
  }
  const filtered = items.filter(
    (item) => !(item.tag === 'TrivialProp' && item.value === false),
  )
  if (filtered.length === 0) return { tag: 'TrivialProp', value: false }
  if (filtered.length === 1) return filtered[0]!
  return { tag: 'Cor', items: filtered }
}

// Direct port of cthreshold.rs:34-84
export function cthresholdReduce(
  k: number,
  items: SigmaBoolean[],
): SigmaBoolean {
  if (k === 0) return { tag: 'TrivialProp', value: true }
  if (k > items.length) return { tag: 'TrivialProp', value: false }

  let currK = k
  let childrenLeft = items.length
  const accumulated: SigmaBoolean[] = []

  for (let i = 0; i < items.length; i++) {
    // Mid-loop short-circuit BEFORE processing item i
    if (currK === 1) {
      accumulated.push(...items.slice(i))
      return corNormalized(accumulated)
    }
    if (currK === childrenLeft) {
      accumulated.push(...items.slice(i))
      return candNormalized(accumulated)
    }

    const item = items[i]!
    if (item.tag === 'TrivialProp' && item.value === true) {
      currK -= 1
      childrenLeft -= 1
    } else if (item.tag === 'TrivialProp' && item.value === false) {
      childrenLeft -= 1
    } else {
      accumulated.push(item)
    }
  }

  if (currK === 1) return corNormalized(accumulated)
  if (currK === childrenLeft) return candNormalized(accumulated)
  return { tag: 'Cthreshold', k: currK, items: accumulated }
}
```

- [ ] **Step 5: Run tests, verify pass.**

Run: `cd packages/ergoscript && npx vitest run test/mir/sigma-boolean-normalize.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Run full ergoscript suite to check no regressions.**

Run: `cd packages/ergoscript && npm test`
Expected: Prior 2017 tests + new normalize tests all pass.

- [ ] **Step 7: Typecheck.**

Run: `cd packages/ergoscript && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit.**

```bash
git add packages/ergoscript/src/mir/sigma-boolean-normalize.ts packages/ergoscript/test/mir/sigma-boolean-normalize.test.ts
git commit -m "$(cat <<'EOF'
feat(ergoscript): add SigmaBoolean normalization helpers (phase 2g-combinators task 1)

cthresholdReduce / candNormalized / corNormalized pure functions.
Direct port of sigma-rust's cthreshold.rs:34-84, cand.rs:29-50,
cor.rs:29-50. Foundation for the 3 sigma-combinator eval arms
(Atleast/SigmaAnd/SigmaOr) shipping in Tasks 4-6.

No public-surface change; module is internal-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: GF(2^192) element — `Gf2_192Element` class (dedicated session)

**Files:**
- Create: `packages/ergoscript/src/crypto/gf2_192.ts` (Part 1: element class only; polynomial added in Task 3)
- Test: `packages/ergoscript/test/crypto/gf2_192-element.test.ts`
- Fixture-gen: `fixture-gen/src/cmds/ergoscript/crypto/gf2_192_element_ops.rs` and `mod.rs`
- Fixture file: `packages/ergoscript/test/fixtures/crypto/gf2_192-element-ops.json`
- Modify: `fixture-gen/Cargo.toml`, `fixture-gen/src/cmds/ergoscript/mod.rs`, `fixture-gen/src/main.rs`

**Sigma-rust source-read (REQUIRED before writing any TS):**

```bash
cat ~/projects/sigma-rust/sigma-rust/gf2_192/src/lib.rs
cat ~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192.rs
```

Locked details to extract:
- `IRRED_PENTANOMIAL: i64 = 0xE7` at line 31 — verify this is the low-bit representation of `x^7 + x^2 + x + 1` (the reduction part of x^192 + x^7 + x^2 + x + 1).
- `IRRED_MULS [i64; 16]` precomputed table at lines 35-55 — port verbatim.
- Internal repr: `word: [i64; 3]` — three 64-bit words, low-to-high.
- `multiply` algorithm at lines 82-153 — 4-bit nibble iteration with table lookup for reduction.
- `invert` at lines 173-200 — Fermat's z^(2^192 - 2) via square-and-multiply chain.
- `sqr` at lines 203-258 — bit-interleave shortcut.
- Byte conversion (`From<[u8; 24]>` etc.) at lines 315-394 — byte order is BE.

- [ ] **Step 1: Add `gf2_192` workspace dep to fixture-gen `Cargo.toml`.**

Modify `fixture-gen/Cargo.toml`:

```toml
[dependencies]
# ... existing deps
gf2_192 = { path = "../../sigma-rust/sigma-rust/gf2_192" }
```

(Path may need adjustment based on absolute path resolution; alternative is git dep at the pinned revision.)

- [ ] **Step 2: Add `crypto` module to fixture-gen.**

Modify `fixture-gen/src/cmds/ergoscript/mod.rs`:

```rust
pub mod crypto;
pub mod eval;
pub mod verify;
pub mod wire;
```

Create `fixture-gen/src/cmds/ergoscript/crypto/mod.rs`:

```rust
pub mod gf2_192_element_ops;
// pub mod gf2_192_poly_ops; // added in Task 3
```

- [ ] **Step 3: Write fixture-gen for element ops.**

Create `fixture-gen/src/cmds/ergoscript/crypto/gf2_192_element_ops.rs`. Should generate ~70 entries covering:
- `add` (~10): zero+zero, zero+x, x+zero, x+x=zero, random pairs.
- `multiply` (~25): zero*x, one*x, x*one, random pairs, edge values forcing reduction (high bits set), known orthogonal vectors.
- `sqr` (~10): zero, one, random.
- `invert` (~10): invert(1)=1, invert(random); cross-check via `x * invert(x) == 1`.
- `equals` (~10): trivially equal, trivially not-equal, byte-wise comparison.
- `serialize` (~10): from_bytes/to_bytes round-trip.

Entry shape:

```rust
#[derive(serde::Serialize)]
struct ElementOpFixture {
    name: String,
    op: String,  // "add", "multiply", "sqr", "invert", "equals", "from_bytes", "to_bytes"
    inputs: Vec<String>,  // hex-encoded 24-byte values
    expected: String,     // hex-encoded output (24 bytes for element ops; "true"/"false" for equals)
}

pub fn generate_fixtures() -> Vec<ElementOpFixture> {
    use gf2_192::Gf2_192;
    let mut entries = Vec::new();

    // Pattern: hard-code seeded "random" by index for determinism
    let r1 = Gf2_192::from([0x12u8; 24]);
    let r2 = Gf2_192::from([0x34u8; 24]);
    // ... etc

    // add: zero + zero
    let zero = Gf2_192::new();
    entries.push(ElementOpFixture {
        name: "add-zero-zero".into(),
        op: "add".into(),
        inputs: vec![hex::encode(zero.to_bytes()), hex::encode(zero.to_bytes())],
        expected: hex::encode(zero.to_bytes()),  // 0 ⊕ 0 = 0
    });

    // ... fill in all entries

    entries
}
```

Note on `Gf2_192` Rust API: `add` is `^` (XOR) since GF(2^n) addition is XOR. `multiply` is the `multiply()` function. Helper for "convert to 24 BE bytes": `Gf2_192::to_i8_slice(&mut [i8; 24], 0)` per `gf2_192.rs:264-269` or manual; use whichever the crate exposes. The fixture-gen needs to emit BE-hex consistent with what TS will deserialize.

- [ ] **Step 4: Wire fixture-gen into main.rs.**

Modify `fixture-gen/src/main.rs` to add:

```rust
generate_and_write(
    "ergoscript/crypto/gf2_192-element-ops",
    cmds::ergoscript::crypto::gf2_192_element_ops::generate_fixtures(),
)?;
```

- [ ] **Step 5: Run fixture-gen, commit fixtures.**

```bash
cd fixture-gen && cargo run --release
cd ..
git add packages/ergoscript/test/fixtures/crypto/gf2_192-element-ops.json fixture-gen/
# (commit deferred to Step 14 with TS code)
```

Run determinism check:

```bash
cd fixture-gen && cargo run --release  # second run; expect no diff
git status -- packages/ergoscript/test/fixtures/  # expect clean
```

- [ ] **Step 6: Write the failing TS tests.**

`packages/ergoscript/test/crypto/gf2_192-element.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Gf2_192Element } from '../../src/crypto/gf2_192'

const fixturePath = resolve(__dirname, '../fixtures/crypto/gf2_192-element-ops.json')
const fixtures: ElementOpFixture[] = JSON.parse(readFileSync(fixturePath, 'utf8'))

interface ElementOpFixture {
  name: string
  op: 'add' | 'multiply' | 'sqr' | 'invert' | 'equals' | 'from_bytes' | 'to_bytes'
  inputs: string[]
  expected: string
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map(b => parseInt(b, 16)))
}
function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
}

describe('Gf2_192Element operations (cross-validated against sigma-rust)', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      switch (f.op) {
        case 'add': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          const b = Gf2_192Element.fromBytes(hexToBytes(f.inputs[1]!))
          expect(bytesToHex(a.add(b).toBytes())).toBe(f.expected)
          break
        }
        case 'multiply': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          const b = Gf2_192Element.fromBytes(hexToBytes(f.inputs[1]!))
          expect(bytesToHex(a.multiply(b).toBytes())).toBe(f.expected)
          break
        }
        case 'sqr': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          expect(bytesToHex(a.sqr().toBytes())).toBe(f.expected)
          break
        }
        case 'invert': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          expect(bytesToHex(a.invert().toBytes())).toBe(f.expected)
          break
        }
        case 'equals': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          const b = Gf2_192Element.fromBytes(hexToBytes(f.inputs[1]!))
          expect(a.equals(b)).toBe(f.expected === 'true')
          break
        }
        case 'from_bytes':
        case 'to_bytes': {
          const a = Gf2_192Element.fromBytes(hexToBytes(f.inputs[0]!))
          expect(bytesToHex(a.toBytes())).toBe(f.expected)
          break
        }
      }
    })
  }
})

describe('Gf2_192Element static constants', () => {
  it('ZERO is 24 zero bytes', () => {
    expect(bytesToHex(Gf2_192Element.ZERO.toBytes())).toBe('00'.repeat(24))
    expect(Gf2_192Element.ZERO.isZero()).toBe(true)
  })
  it('ONE is one-in-low-bit (BE)', () => {
    expect(Gf2_192Element.ONE.isOne()).toBe(true)
    // ONE * x == x (multiplicative identity)
    const x = Gf2_192Element.fromBytes(hexToBytes('12'.repeat(24)))
    expect(bytesToHex(Gf2_192Element.ONE.multiply(x).toBytes())).toBe('12'.repeat(24))
  })
})

describe('Gf2_192Element round-trip', () => {
  it('fromBytes(toBytes(x)) === x', () => {
    const x = hexToBytes('deadbeef'.repeat(6))
    expect(bytesToHex(Gf2_192Element.fromBytes(x).toBytes())).toBe(bytesToHex(x))
  })
  it('throws on wrong-length input', () => {
    expect(() => Gf2_192Element.fromBytes(new Uint8Array(23))).toThrow(/length/i)
    expect(() => Gf2_192Element.fromBytes(new Uint8Array(25))).toThrow(/length/i)
  })
})
```

- [ ] **Step 7: Run tests, verify they fail.**

Run: `cd packages/ergoscript && npx vitest run test/crypto/gf2_192-element.test.ts`
Expected: All tests fail with module-not-found.

- [ ] **Step 8: Implement `Gf2_192Element` in `packages/ergoscript/src/crypto/gf2_192.ts`.**

Implementation skeleton — internal repr `[bigint, bigint, bigint]` (low-to-high). The full multiplication algorithm is intricate; implement it carefully following `gf2_192.rs:82-153`. Cite the exact sigma-rust algorithm in code comments.

```ts
// Direct port of sigma-rust's gf2_192 crate.
// Irreducible polynomial: x^192 + x^7 + x^2 + x + 1.
// Source: ~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192.rs

const MASK_64: bigint = (1n << 64n) - 1n

// 0xE7 = 11100111 in binary = x^7 + x^6 + x^5 + x^2 + x + 1 (low bits of x^192 after reduction)
// Per gf2_192.rs:31
const IRRED_PENTANOMIAL: bigint = 0xE7n

// Precomputed table: IRRED_MULS_TABLE[i] = IRRED_PENTANOMIAL * x^i (in GF(2)).
// Used for 4-bit nibble multiplication reduction.
// Implementer: open ~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192.rs at
// lines 35-55. Each of the 16 i64 values in `IRRED_MULS` is transcribed VERBATIM
// here as a BigInt literal (suffix with `n`). Cast i64 → unsigned-equivalent via
// `& MASK_64` if any high-bit-set value appears. Cross-validation fixtures
// (~70 multiply entries) catch any transcription error on the first test run.
const IRRED_MULS_TABLE: readonly bigint[] = [
  // 16 entries to be transcribed from gf2_192.rs:35-55
] as const

export class Gf2_192Element {
  // Internal repr: three 64-bit BigInts, low-to-high (word[0] is bits 0-63).
  private constructor(private readonly words: [bigint, bigint, bigint]) {}

  static readonly ZERO = new Gf2_192Element([0n, 0n, 0n])
  static readonly ONE = new Gf2_192Element([1n, 0n, 0n])

  static fromBytes(bytes: Uint8Array): Gf2_192Element {
    if (bytes.length !== 24) {
      throw new Error(`Gf2_192Element.fromBytes: expected 24 bytes, got ${bytes.length}`)
    }
    // BE byte order. Reconstruct three 64-bit words.
    // Bytes[0..8] is word[2] (high); bytes[8..16] is word[1]; bytes[16..24] is word[0] (low).
    // Confirm byte order at implementation by cross-validating with one fixture entry.
    const w2 = bytesToBigIntBE(bytes.subarray(0, 8))
    const w1 = bytesToBigIntBE(bytes.subarray(8, 16))
    const w0 = bytesToBigIntBE(bytes.subarray(16, 24))
    return new Gf2_192Element([w0, w1, w2])
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(24)
    bigIntToBytesBE(this.words[2], out, 0, 8)
    bigIntToBytesBE(this.words[1], out, 8, 8)
    bigIntToBytesBE(this.words[0], out, 16, 8)
    return out  // defensive: new array, caller may mutate
  }

  add(other: Gf2_192Element): Gf2_192Element {
    // GF(2^n) addition is XOR
    return new Gf2_192Element([
      this.words[0] ^ other.words[0],
      this.words[1] ^ other.words[1],
      this.words[2] ^ other.words[2],
    ])
  }

  multiply(other: Gf2_192Element): Gf2_192Element {
    // 4-bit nibble multiplication with table-based reduction.
    // Implementer: port gf2_192.rs:82-153 line-for-line. Algorithm:
    //   1. Treat 'other' (b) as polynomial; iterate over its 192 bits in groups of 4 (48 nibbles).
    //   2. For each nibble, look up IRRED_MULS_TABLE[nibble] for partial reduction contribution.
    //   3. Accumulate into 384-bit intermediate (6 BigInts: lo[3] + hi[3]) via XOR.
    //   4. Reduce upper 192 bits using IRRED_MULS_TABLE entries for each set bit.
    // Mask intermediate values with `& MASK_64` after any operation that can produce ≥ 2^64.
    // Cite the line range in implementation comments. Cross-validation fixtures
    // (~25 multiply entries) catch byte-level mismatches against sigma-rust.
    throw new Error('Gf2_192Element.multiply: implementation pending — port gf2_192.rs:82-153')
  }

  sqr(): Gf2_192Element {
    // Bit-interleave squaring per gf2_192.rs:203-258.
    // Implementer: in characteristic-2 fields, x^2 is computed by inserting a zero
    // bit between every input bit (e.g., bit i in x becomes bit 2i in x^2), THEN
    // reducing the upper 192 bits using IRRED_MULS_TABLE. Port the bit-interleave
    // step (sigma-rust uses standard de-Bruijn-style precomputation or per-byte
    // expansion table) then call the same reduction subroutine used by multiply().
    // Cross-validation fixtures (~10 sqr entries) catch any error.
    throw new Error('Gf2_192Element.sqr: implementation pending — port gf2_192.rs:203-258')
  }

  invert(): Gf2_192Element {
    // Fermat-style invert via z^(2^192 - 2) per gf2_192.rs:173-200.
    // Implementer: in GF(2^192), the nonzero elements form a multiplicative group of
    // order (2^192 - 1). So z^(-1) = z^(2^192 - 2). Sigma-rust uses an explicit
    // square-and-multiply chain (NOT a generic pow function) — port that chain
    // verbatim. Throws or returns Gf2_192Element.ZERO for invert(ZERO) — match
    // sigma-rust's exact behavior at line 174-176 (likely an assert/panic; in TS
    // we throw an Error). Cross-validation fixtures (~10 invert entries) + the
    // round-trip property `x * invert(x) == 1` catch errors.
    if (this.isZero()) {
      throw new Error('Gf2_192Element.invert: cannot invert zero')
    }
    throw new Error('Gf2_192Element.invert: implementation pending — port gf2_192.rs:173-200')
  }

  equals(other: Gf2_192Element): boolean {
    return (
      this.words[0] === other.words[0] &&
      this.words[1] === other.words[1] &&
      this.words[2] === other.words[2]
    )
  }

  isZero(): boolean {
    return this.words[0] === 0n && this.words[1] === 0n && this.words[2] === 0n
  }

  isOne(): boolean {
    return this.words[0] === 1n && this.words[1] === 0n && this.words[2] === 0n
  }
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

function bigIntToBytesBE(v: bigint, out: Uint8Array, offset: number, len: number): void {
  for (let i = len - 1; i >= 0; i--) {
    out[offset + i] = Number(v & 0xFFn)
    v >>= 8n
  }
}
```

The implementer MUST transcribe the `IRRED_MULS_TABLE` values and fully implement `multiply` / `sqr` / `invert` referencing the sigma-rust source. The cross-validation fixtures are the correctness gate.

- [ ] **Step 9: Run tests, iterate until all pass.**

Run: `cd packages/ergoscript && npx vitest run test/crypto/gf2_192-element.test.ts`

Iterate on `multiply` / `sqr` / `invert` implementations. Common failure points:
- BigInt vs i64 sign behavior: BigInts in TS are arbitrary precision; sigma-rust uses i64. Mask high bits explicitly via `& MASK_64` after any operation that could produce values ≥ 2^64.
- Endianness: sigma-rust stores `word: [i64; 3]` with word[0] being low-bits. Confirm via the fixture round-trip tests first (`from_bytes`/`to_bytes`) before debugging multiply.
- Off-by-one in nibble iteration (192 bits = 48 nibbles).

- [ ] **Step 10: Run full ergoscript suite.**

Run: `cd packages/ergoscript && npm test`
Expected: Prior 2017 + new GF(2^192) element tests all pass.

- [ ] **Step 11: Typecheck.**

Run: `cd packages/ergoscript && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 12: Bundle scan (browser-clean).**

Run: `cd packages/ergoscript && grep -rn 'Buffer\|process\.\|require\|node:' src/crypto/gf2_192.ts`
Expected: No matches. Confirms no Node-specific imports leaked into the crypto module.

- [ ] **Step 13: Final determinism re-run.**

Run: `cd fixture-gen && cargo run --release`
Expected: No diff in `packages/ergoscript/test/fixtures/`.

- [ ] **Step 14: Commit.**

```bash
git add packages/ergoscript/src/crypto/gf2_192.ts \
        packages/ergoscript/test/crypto/gf2_192-element.test.ts \
        packages/ergoscript/test/fixtures/crypto/gf2_192-element-ops.json \
        fixture-gen/Cargo.toml \
        fixture-gen/src/cmds/ergoscript/crypto/mod.rs \
        fixture-gen/src/cmds/ergoscript/crypto/gf2_192_element_ops.rs \
        fixture-gen/src/cmds/ergoscript/mod.rs \
        fixture-gen/src/main.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): add Gf2_192Element with table-optimized multiply (phase 2g-combinators task 2)

Pure-TypeScript port of sigma-rust's gf2_192 crate element type.
Internal repr [bigint, bigint, bigint] (low-to-high 64-bit words);
4-bit nibble multiplication with IRRED_MULS_TABLE reduction per
gf2_192.rs:82-153; Fermat-style invert per gf2_192.rs:173-200;
bit-interleave sqr per gf2_192.rs:203-258. 24-byte BE serialization.

Cross-validation fixtures (~70 entries across add/multiply/sqr/invert/
equals/serialize) byte-compared against sigma-rust's gf2_192 crate
output at fixture-gen time. Determinism gate via two-run cargo.

Browser-clean (no Buffer/node:* imports). Foundation for Task 3's
polynomial layer and Task 9's Cthreshold verifier walk.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: GF(2^192) polynomial — `Gf2_192Poly` class (dedicated session)

**Files:**
- Modify: `packages/ergoscript/src/crypto/gf2_192.ts` (add `Gf2_192Poly` class)
- Test: `packages/ergoscript/test/crypto/gf2_192-poly.test.ts`
- Fixture-gen: `fixture-gen/src/cmds/ergoscript/crypto/gf2_192_poly_ops.rs`
- Fixture file: `packages/ergoscript/test/fixtures/crypto/gf2_192-poly-ops.json`
- Modify: `fixture-gen/src/cmds/ergoscript/crypto/mod.rs`, `fixture-gen/src/main.rs`

**Sigma-rust source-read (REQUIRED before writing any TS):**

```bash
cat ~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192poly.rs
```

Locked details:
- Internal repr: `coeffs: Vec<Gf2_192>` where `coeffs[0]` is the degree-0 (constant) coefficient and `coeffs[degree]` is the highest. The polynomial is `sum(coeffs[i] * x^i)` over GF(2^192).
- `interpolate(points: &[u8], values: &[Gf2_192], value_at_zero: Gf2_192)` at lines 71-115. Standard Lagrange basis. The (0, value_at_zero) point is interpolation-special-cased — it becomes coeff[0] of the result.
- `evaluate(x: u8) -> Gf2_192` at lines 116-132. Horner's method.
- `to_bytes() -> Vec<u8>` at lines 133-160. Length = `degree * 24`. **Skips degree-0 coefficient** — caller serializes it separately (in our case, it's the parent challenge in the conjecture verifier).

- [ ] **Step 1: Add `gf2_192_poly_ops` module to fixture-gen.**

Modify `fixture-gen/src/cmds/ergoscript/crypto/mod.rs`:

```rust
pub mod gf2_192_element_ops;
pub mod gf2_192_poly_ops;
```

- [ ] **Step 2: Write fixture-gen for polynomial ops.**

Create `fixture-gen/src/cmds/ergoscript/crypto/gf2_192_poly_ops.rs`. ~25 entries:

- `interpolate` (~8): 2-point (one non-zero point + value_at_zero), 3-point, 5-point, 8-point. Vary value_at_zero (zero, nonzero).
- `evaluate` (~10): For each interpolated polynomial, evaluate at points 0, 1, ..., n+1 and capture results. Confirms polynomial passes through expected points AND extrapolates correctly.
- `to_bytes` (~5): Capture serialized byte sequence for polynomials of varying degree (degree 1, 2, 4, 7).
- `fromCoefficientsAndConstant` round-trip (~2): Serialize a polynomial, deserialize, evaluate at same points, assert byte-equal results.

```rust
#[derive(serde::Serialize)]
struct PolyOpFixture {
    name: String,
    op: String,  // "interpolate", "evaluate", "to_bytes", "from_coeffs_and_const"
    // For interpolate: u8 array of points (excluding 0), 24-byte hex values, 24-byte value_at_zero
    // For evaluate: polynomial bytes + value_at_zero + point (u8), expected 24-byte hex
    // For to_bytes: polynomial spec (points + values + value_at_zero), expected bytes hex
    inputs: PolyInputs,
    expected: String,
}

#[derive(serde::Serialize)]
struct PolyInputs {
    points: Option<Vec<u8>>,
    values_hex: Option<Vec<String>>,
    value_at_zero_hex: Option<String>,
    poly_bytes_hex: Option<String>,
    eval_point: Option<u8>,
}

pub fn generate_fixtures() -> Vec<PolyOpFixture> {
    use gf2_192::gf2_192poly::Gf2_192Poly;
    use gf2_192::Gf2_192;
    // ...
}
```

- [ ] **Step 3: Wire into main.rs and run fixture-gen.**

Modify `fixture-gen/src/main.rs`:

```rust
generate_and_write(
    "ergoscript/crypto/gf2_192-poly-ops",
    cmds::ergoscript::crypto::gf2_192_poly_ops::generate_fixtures(),
)?;
```

Run:

```bash
cd fixture-gen && cargo run --release
cd fixture-gen && cargo run --release  # determinism check
git status -- packages/ergoscript/test/fixtures/  # expect clean after second run
```

- [ ] **Step 4: Write the failing tests.**

`packages/ergoscript/test/crypto/gf2_192-poly.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Gf2_192Element, Gf2_192Poly } from '../../src/crypto/gf2_192'

const fixturePath = resolve(__dirname, '../fixtures/crypto/gf2_192-poly-ops.json')
const fixtures: PolyOpFixture[] = JSON.parse(readFileSync(fixturePath, 'utf8'))

interface PolyOpFixture {
  name: string
  op: 'interpolate' | 'evaluate' | 'to_bytes' | 'from_coeffs_and_const'
  inputs: {
    points?: number[]
    values_hex?: string[]
    value_at_zero_hex?: string
    poly_bytes_hex?: string
    eval_point?: number
  }
  expected: string
}

function hexToBytes(hex: string): Uint8Array { /* ... */ }
function bytesToHex(b: Uint8Array): string { /* ... */ }

describe('Gf2_192Poly operations (cross-validated against sigma-rust)', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      switch (f.op) {
        case 'interpolate': {
          const values = f.inputs.values_hex!.map(h =>
            Gf2_192Element.fromBytes(hexToBytes(h)),
          )
          const valueAtZero = Gf2_192Element.fromBytes(hexToBytes(f.inputs.value_at_zero_hex!))
          const poly = Gf2_192Poly.interpolate(f.inputs.points!, values, valueAtZero)
          expect(bytesToHex(poly.toBytes())).toBe(f.expected)
          break
        }
        case 'evaluate': {
          const poly = Gf2_192Poly.fromCoefficientsAndConstant(
            hexToBytes(f.inputs.poly_bytes_hex!),
            Gf2_192Element.fromBytes(hexToBytes(f.inputs.value_at_zero_hex!)),
          )
          const result = poly.evaluate(f.inputs.eval_point!)
          expect(bytesToHex(result.toBytes())).toBe(f.expected)
          break
        }
        case 'to_bytes': {
          const values = f.inputs.values_hex!.map(h =>
            Gf2_192Element.fromBytes(hexToBytes(h)),
          )
          const valueAtZero = Gf2_192Element.fromBytes(hexToBytes(f.inputs.value_at_zero_hex!))
          const poly = Gf2_192Poly.interpolate(f.inputs.points!, values, valueAtZero)
          expect(bytesToHex(poly.toBytes())).toBe(f.expected)
          break
        }
        case 'from_coeffs_and_const': {
          // Round-trip: bytes → poly → evaluate → bytes
          const poly = Gf2_192Poly.fromCoefficientsAndConstant(
            hexToBytes(f.inputs.poly_bytes_hex!),
            Gf2_192Element.fromBytes(hexToBytes(f.inputs.value_at_zero_hex!)),
          )
          const evaluated = poly.evaluate(f.inputs.eval_point!)
          expect(bytesToHex(evaluated.toBytes())).toBe(f.expected)
          break
        }
      }
    })
  }
})

describe('Gf2_192Poly invariants', () => {
  it('interpolate creates polynomial passing through specified points', () => {
    const valueAtZero = Gf2_192Element.fromBytes(new Uint8Array(24).fill(0x42))
    const points = [1, 2, 3]
    const values = points.map(p => Gf2_192Element.fromBytes(new Uint8Array(24).fill(p)))
    const poly = Gf2_192Poly.interpolate(points, values, valueAtZero)

    expect(poly.evaluate(0).equals(valueAtZero)).toBe(true)
    for (let i = 0; i < points.length; i++) {
      expect(poly.evaluate(points[i]!).equals(values[i]!)).toBe(true)
    }
  })

  it('degree property equals (number of points)', () => {
    const valueAtZero = Gf2_192Element.ZERO
    const points = [1, 2, 3, 5]
    const values = points.map(p => Gf2_192Element.fromBytes(new Uint8Array(24).fill(p)))
    const poly = Gf2_192Poly.interpolate(points, values, valueAtZero)
    expect(poly.degree).toBe(4)  // 4 points + the (0, valueAtZero) gives degree-4 polynomial
    expect(poly.toBytes().length).toBe(4 * 24)
  })
})
```

- [ ] **Step 5: Run tests, verify failure.**

Run: `cd packages/ergoscript && npx vitest run test/crypto/gf2_192-poly.test.ts`
Expected: All tests fail (Gf2_192Poly doesn't exist yet).

- [ ] **Step 6: Implement `Gf2_192Poly` in `packages/ergoscript/src/crypto/gf2_192.ts`.**

Append to the existing file:

```ts
// Polynomial over GF(2^192).
// Internal repr: coeffs[0] is degree-0 (constant); coeffs[degree] is highest.
// Per gf2_192poly.rs:60.
export class Gf2_192Poly {
  private constructor(private readonly coeffs: Gf2_192Element[]) {}

  get degree(): number {
    return this.coeffs.length - 1
  }

  // Lagrange interpolation through (0, valueAtZero) and each (points[i], values[i]).
  // points must be distinct u8 values, all != 0.
  // Per gf2_192poly.rs:71-115.
  static interpolate(
    points: number[],
    values: Gf2_192Element[],
    valueAtZero: Gf2_192Element,
  ): Gf2_192Poly {
    if (points.length !== values.length) {
      throw new Error('Gf2_192Poly.interpolate: points and values length mismatch')
    }
    for (const p of points) {
      if (p === 0) throw new Error('Gf2_192Poly.interpolate: points must be != 0')
      if (p < 0 || p > 255 || !Number.isInteger(p)) {
        throw new Error('Gf2_192Poly.interpolate: points must be u8')
      }
    }
    // Check distinctness
    const seen = new Set<number>()
    for (const p of points) {
      if (seen.has(p)) throw new Error('Gf2_192Poly.interpolate: duplicate points')
      seen.add(p)
    }
    // Implementer: port gf2_192poly.rs:71-115 line-for-line. The (0, valueAtZero)
    // point is interpolation-special-cased — sigma-rust prepends it to the points
    // array internally and computes Lagrange basis over the combined (n+1)-point set.
    // The Lagrange basis L_i(x) = prod_{j != i} (x - p_j) / (p_i - p_j). In GF(2^192):
    //   - (x - p_j) and (p_i - p_j) reduce to XOR (since subtraction is addition is XOR).
    //   - Division uses Gf2_192Element.invert.
    //   - p_i and p_j are u8 values; convert via Gf2_192Element.fromBytes(zeroPad24(p)) or
    //     by setting the low word to BigInt(p) directly.
    // Result polynomial coefficients fill coeffs[0..=n]. Cross-validation fixtures
    // (~8 interpolate entries) catch errors.
    throw new Error('Gf2_192Poly.interpolate: implementation pending — port gf2_192poly.rs:71-115')
  }

  // Reconstruct polynomial from serialized non-constant coefficients + the constant.
  // Used by the verifier: constant = parent challenge as Gf2_192Element; coefficients
  // are read from the proof bytes (length = degree * 24).
  static fromCoefficientsAndConstant(
    coefficientBytes: Uint8Array,
    constant: Gf2_192Element,
  ): Gf2_192Poly {
    if (coefficientBytes.length % 24 !== 0) {
      throw new Error('Gf2_192Poly.fromCoefficientsAndConstant: bytes length must be multiple of 24')
    }
    const degree = coefficientBytes.length / 24
    const coeffs: Gf2_192Element[] = [constant]
    for (let i = 0; i < degree; i++) {
      coeffs.push(Gf2_192Element.fromBytes(coefficientBytes.subarray(i * 24, (i + 1) * 24)))
    }
    return new Gf2_192Poly(coeffs)
  }

  // Horner's method.
  // Per gf2_192poly.rs:116-132.
  evaluate(x: number): Gf2_192Element {
    if (x < 0 || x > 255 || !Number.isInteger(x)) {
      throw new Error('Gf2_192Poly.evaluate: x must be u8')
    }
    if (x === 0) return this.coeffs[0]!  // by definition
    // Implementer: port gf2_192poly.rs:116-132. Horner's method:
    //   result = coeffs[degree]
    //   for i from (degree - 1) down to 0:
    //     result = result.multiply(xAsElement).add(coeffs[i])
    //
    // Where xAsElement is the GF(2^192) embedding of the u8 x (low word = BigInt(x),
    // other words = 0n). This works because GF(2^8) ⊂ GF(2^192) via the same
    // pentanomial reduction.
    //
    // sigma-rust optimizes via `Gf2_192::mul_by_i8` (a specialized variant that
    // doesn't allocate a full Gf2_192Element). Implementer may match that
    // optimization or use the slower generic multiply — cross-validation fixtures
    // confirm output byte-equality either way.
    throw new Error('Gf2_192Poly.evaluate: implementation pending — port gf2_192poly.rs:116-132')
  }

  // Serializes coeffs[1..=degree], NOT coeffs[0]. Length = degree * 24.
  // Per gf2_192poly.rs:133-160.
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.degree * 24)
    for (let i = 0; i < this.degree; i++) {
      const elemBytes = this.coeffs[i + 1]!.toBytes()
      out.set(elemBytes, i * 24)
    }
    return out
  }
}
```

The implementer fills in `interpolate` (full Lagrange in GF(2^192)) and `evaluate` (Horner's). Implementation references gf2_192poly.rs explicitly.

- [ ] **Step 7: Run tests, iterate.**

Common failure points:
- Lagrange basis denominator inversion: in GF(2^192), division by `(points[i] - points[j])` requires `invert(points[i] - points[j])`. Since `-` is `+` is XOR in GF(2), the denominator is XOR of two u8 values cast into Gf2_192Element.
- Horner's method evaluates from highest-degree down; off-by-one risk.
- Empty `points[]` case: polynomial is just `constant`; degree 0; toBytes is empty.

- [ ] **Step 8: Run full ergoscript suite, typecheck, bundle scan.**

Run:
```bash
cd packages/ergoscript && npm test
cd packages/ergoscript && npx tsc --noEmit
grep -n 'Buffer\|process\.\|node:' packages/ergoscript/src/crypto/gf2_192.ts
```

Expected: all pass; no Node imports.

- [ ] **Step 9: Determinism re-run.**

Run: `cd fixture-gen && cargo run --release`
Expected: No diff in fixtures.

- [ ] **Step 10: Commit.**

```bash
git add packages/ergoscript/src/crypto/gf2_192.ts \
        packages/ergoscript/test/crypto/gf2_192-poly.test.ts \
        packages/ergoscript/test/fixtures/crypto/gf2_192-poly-ops.json \
        fixture-gen/src/cmds/ergoscript/crypto/gf2_192_poly_ops.rs \
        fixture-gen/src/cmds/ergoscript/crypto/mod.rs \
        fixture-gen/src/main.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): add Gf2_192Poly with Lagrange interpolation (phase 2g-combinators task 3)

Polynomial layer over Gf2_192Element. interpolate() per
gf2_192poly.rs:71-115 (Lagrange basis with (0, value_at_zero)
special-cased); evaluate() per gf2_192poly.rs:116-132 (Horner's
method); toBytes() per gf2_192poly.rs:133-160 (degree * 24 bytes,
skips constant coefficient). fromCoefficientsAndConstant() is the
verifier-path constructor used by the Cthreshold conjecture walk in
Task 9.

Cross-validation fixtures (~25 entries) byte-compared against
sigma-rust's gf2_192poly. Determinism gate via two-run cargo.

Browser-clean. Closes the GF(2^192) layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Atleast arm + `_sigma-helpers.ts`

**Files:**
- Create: `packages/ergoscript/src/eval/_sigma-helpers.ts`
- Create: `packages/ergoscript/src/eval/atleast.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`
- Modify: `packages/ergoscript/src/eval/errors.ts`
- Test: `packages/ergoscript/test/eval/atleast.test.ts`
- Test: `packages/ergoscript/test/eval-mutation/sigma-combinators.test.ts` (C3.a — created here, extended in Tasks 5-6)
- Fixture-gen: `fixture-gen/src/cmds/ergoscript/eval/atleast.rs`
- Fixture: `packages/ergoscript/test/fixtures/eval/atleast.json`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, `fixture-gen/src/main.rs`

**Sigma-rust source-read:**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/eval/atleast.rs
cat ~/projects/sigma-rust/sigma-rust/ergotree-ir/src/mir/atleast.rs
```

Lock cost: `add_per_item_jit_cost(20, 3, 5, n)` per `atleast.rs:34` (Pattern B). MIR shape: `{ bound: Expr<SInt>, input: Expr<Coll<SSigmaProp>> }`.

- [ ] **Step 1: Add 3 new EvalError codes.**

Modify `packages/ergoscript/src/eval/errors.ts` to add `'atleast-bound-not-int'`, `'sigma-prop-coll-elem-not-sigma-prop'`, `'sigma-prop-input-not-coll'` to the `EvalErrorCode` union.

- [ ] **Step 2: Create `_sigma-helpers.ts` with failing test.**

`packages/ergoscript/test/eval/_sigma-helpers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { expectSigmaProp, extractSigmaPropColl } from '../../src/eval/_sigma-helpers'
import { EvalError } from '../../src/eval/errors'

describe('expectSigmaProp', () => {
  it('returns inner SigmaBoolean on success', () => {
    const sb = { tag: 'TrivialProp' as const, value: true }
    expect(expectSigmaProp({ kind: 'SigmaProp', value: sb }, 'test')).toEqual(sb)
  })
  it('throws sigma-prop-coll-elem-not-sigma-prop on non-SigmaProp', () => {
    expect(() => expectSigmaProp({ kind: 'Int', value: 42 }, 'test')).toThrow(
      expect.objectContaining({ code: 'sigma-prop-coll-elem-not-sigma-prop' }),
    )
  })
})

describe('extractSigmaPropColl', () => {
  it('returns SigmaBoolean[] on Coll[SigmaProp] input', () => {
    const sb1 = { tag: 'TrivialProp' as const, value: true }
    const sb2 = { tag: 'TrivialProp' as const, value: false }
    const value = {
      kind: 'Coll' as const,
      elem: { tag: 'SSigmaProp' as const },
      items: [
        { kind: 'SigmaProp' as const, value: sb1 },
        { kind: 'SigmaProp' as const, value: sb2 },
      ],
    }
    expect(extractSigmaPropColl(value, 'test')).toEqual([sb1, sb2])
  })
  it('throws sigma-prop-input-not-coll on non-Coll', () => {
    expect(() =>
      extractSigmaPropColl({ kind: 'Int', value: 42 }, 'test'),
    ).toThrow(expect.objectContaining({ code: 'sigma-prop-input-not-coll' }))
  })
  it('throws sigma-prop-coll-elem-not-sigma-prop on non-SigmaProp item', () => {
    const value = {
      kind: 'Coll' as const,
      elem: { tag: 'SAny' as const },
      items: [{ kind: 'Int' as const, value: 42 }],
    }
    expect(() => extractSigmaPropColl(value, 'test')).toThrow(
      expect.objectContaining({ code: 'sigma-prop-coll-elem-not-sigma-prop' }),
    )
  })
})
```

- [ ] **Step 3: Implement `_sigma-helpers.ts`.**

```ts
import { EvalError } from './errors'
import type { SValue } from '../mir/types'
import type { SigmaBoolean } from '../mir/types'

export function expectSigmaProp(value: SValue, callerName: string): SigmaBoolean {
  if (value.kind !== 'SigmaProp') {
    throw new EvalError(
      'sigma-prop-coll-elem-not-sigma-prop',
      `${callerName}: expected SigmaProp, got ${value.kind}`,
    )
  }
  return value.value
}

export function extractSigmaPropColl(value: SValue, callerName: string): SigmaBoolean[] {
  if (value.kind !== 'Coll') {
    throw new EvalError(
      'sigma-prop-input-not-coll',
      `${callerName}: expected Coll[SigmaProp], got ${value.kind}`,
    )
  }
  return value.items.map((item, idx) =>
    expectSigmaProp(item, `${callerName} item ${idx}`),
  )
}
```

- [ ] **Step 4: Run helper tests, verify pass.**

Run: `cd packages/ergoscript && npx vitest run test/eval/_sigma-helpers.test.ts`
Expected: All pass.

- [ ] **Step 5: Write Atleast fixture-gen.**

Create `fixture-gen/src/cmds/ergoscript/eval/atleast.rs`. ~10 entries:

- Basic 2-of-3 ProveDlogs.
- k=0 → TrivialProp(true).
- k=4 of 3 (out of range, but allowed at construction?) — verify per atleast.rs whether this is rejected at parse or runtime.
- k=1 of 3 → Cor (collapse).
- k=3 of 3 → Cand (collapse).
- TrivialProp(true) child mixed.
- TrivialProp(false) child mixed.
- Cost-limit overshoot.
- Error: non-Int bound (inline TS only).
- Error: non-Coll input (inline TS only).

Each entry follows the established `EvalFixture` schema (name, tree_bytes_hex, opts_json, expected_value_json, expected_cost, expected_error_code).

Add `pub mod atleast;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs`. Add `generate_and_write` call to `main.rs`.

- [ ] **Step 6: Run fixture-gen, determinism check.**

```bash
cd fixture-gen && cargo run --release
cd fixture-gen && cargo run --release  # determinism
git status -- packages/ergoscript/test/fixtures/eval/atleast.json  # expect clean after second run
```

- [ ] **Step 7: Write Atleast TS failing test.**

`packages/ergoscript/test/eval/atleast.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { parseTree, evaluate } from '../../src'
import { captureEvalError } from '../_helpers'
import { hydrateSValue, hexToBytes } from '../_helpers'

const fixturePath = resolve(__dirname, '../fixtures/eval/atleast.json')
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'))

describe('Atleast eval arm', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const tree = parseTree(hexToBytes(f.tree_bytes_hex))
      const opts = f.opts_json ?? {}
      if (f.expected_error_code) {
        const err = captureEvalError(() => evaluate(tree, opts))
        expect(err.code).toBe(f.expected_error_code)
      } else {
        const result = evaluate(tree, opts)
        expect(result.value).toEqual(hydrateSValue(f.expected_value_json))
        expect(result.cost).toBe(f.expected_cost)
      }
    })
  }

  // Inline error tests: non-Int bound and non-Coll input are not constructible via
  // sigma-rust's MIR builders, so test via direct MIR injection.
  it('throws atleast-bound-not-int on non-Int bound', () => {
    // Hand-build an Atleast Expr with bound = Const(SLong, 2n)
    // ... [defer to implementation]
  })
})
```

- [ ] **Step 8: Run, verify failure.**

Run: `cd packages/ergoscript && npx vitest run test/eval/atleast.test.ts`
Expected: Fail with "Atleast not implemented" or similar.

- [ ] **Step 9: Implement Atleast arm.**

`packages/ergoscript/src/eval/atleast.ts`:

```ts
import type { Atleast } from '../mir/types'
import type { SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './context'
import { evalExpr } from './eval'
import { cthresholdReduce } from '../mir/sigma-boolean-normalize'
import { extractSigmaPropColl } from './_sigma-helpers'
import { EvalError } from './errors'

export function evalAtleast(e: Atleast, env: Env, ctx: EvalContext): SValue {
  const boundV = evalExpr(e.bound, env, ctx)
  if (boundV.kind !== 'Int') {
    throw new EvalError(
      'atleast-bound-not-int',
      `Atleast: expected Int bound, got ${boundV.kind}`,
    )
  }
  const inputV = evalExpr(e.input, env, ctx)
  const items = extractSigmaPropColl(inputV, 'Atleast')
  // Pattern B: per-item cost AFTER eval-children
  ctx.addPerItemCost(20, 3, 5, items.length)
  return { kind: 'SigmaProp', value: cthresholdReduce(boundV.value, items) }
}
```

- [ ] **Step 10: Wire into central dispatch.**

Modify `packages/ergoscript/src/eval/eval.ts` to add:

```ts
case 'Atleast': return evalAtleast(e, env, ctx)
```

(Import at top: `import { evalAtleast } from './atleast'`.)

- [ ] **Step 11: Run Atleast tests, verify pass.**

Run: `cd packages/ergoscript && npx vitest run test/eval/atleast.test.ts`
Expected: All fixture entries pass.

- [ ] **Step 12: Add C3.a mutation tests for Atleast.**

`packages/ergoscript/test/eval-mutation/sigma-combinators.test.ts` — new file. Apply C3.a operators from the 2f Coll HOFs design (constant replacement, child swap, etc.) to Atleast's fixtures. Target ≥ 90% kill rate. The pattern is established; see `packages/ergoscript/test/eval-mutation/coll-hofs.test.ts` for reference (if exists) or `_mutation-operators.ts`.

If an established mutation framework is in place, this is ~30 lines of configuration. If not, defer the test creation to a follow-up — but log the gap.

- [ ] **Step 13: Run full suite + typecheck + bundle scan.**

```bash
cd packages/ergoscript && npm test
cd packages/ergoscript && npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 14: Commit.**

```bash
git add packages/ergoscript/src/eval/_sigma-helpers.ts \
        packages/ergoscript/src/eval/atleast.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/src/eval/errors.ts \
        packages/ergoscript/test/eval/_sigma-helpers.test.ts \
        packages/ergoscript/test/eval/atleast.test.ts \
        packages/ergoscript/test/eval-mutation/sigma-combinators.test.ts \
        packages/ergoscript/test/fixtures/eval/atleast.json \
        fixture-gen/src/cmds/ergoscript/eval/atleast.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs

git commit -m "$(cat <<'EOF'
feat(ergoscript): add Atleast eval arm + _sigma-helpers module (phase 2g-combinators task 4)

evalAtleast: Pattern B addPerItemCost(20, 3, 5, n); calls
cthresholdReduce(k, items). Source: atleast.rs:19-58.

_sigma-helpers.ts adds expectSigmaProp + extractSigmaPropColl;
promoted ahead of YAGNI threshold per phase 2g-combinators design
decision #3 (3 callers across 3 files in Tasks 4-6).

Three new EvalError codes: 'atleast-bound-not-int',
'sigma-prop-coll-elem-not-sigma-prop', 'sigma-prop-input-not-coll'.
Coverage 44 -> 45.

C3.a mutation testing engaged for Atleast (>=90% kill rate target);
extended in Tasks 5-6 for SigmaAnd/SigmaOr.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: SigmaAnd arm

**Files:**
- Create: `packages/ergoscript/src/eval/sigma-and.ts`
- Modify: `packages/ergoscript/src/eval/eval.ts`
- Test: `packages/ergoscript/test/eval/sigma-and.test.ts`
- Test extension: `packages/ergoscript/test/eval-mutation/sigma-combinators.test.ts`
- Fixture-gen: `fixture-gen/src/cmds/ergoscript/eval/sigma_and.rs`
- Fixture: `packages/ergoscript/test/fixtures/eval/sigma-and.json`

**Sigma-rust source-read:** `eval/sigma_and.rs:13-28` — cost `addPerItemCost(10, 2, 1, n)`; MIR has `items: Expr[]`.

- [ ] **Step 1: Source-read sigma-rust's `sigma_and.rs` and `mir/sigma_and.rs`. Confirm `items: SigmaPropItems` is an Expr array, not a single Coll expression.**

- [ ] **Step 2: Write fixture-gen for SigmaAnd.**

`fixture-gen/src/cmds/ergoscript/eval/sigma_and.rs`. ~10 entries:

- 2-leaf basic (Cand([ProveDlog, ProveDlog])).
- 3-leaf basic.
- With TrivialProp(true) child (identity → filtered).
- With TrivialProp(false) child (absorbing → TrivialProp(false)).
- Single child (after filter → unwrap).
- Empty after filter (only TrivialProp(true) children) → TrivialProp(true).
- 5-leaf.
- Mixed Dlog/DhTuple.
- Cost-limit.
- Error: non-SigmaProp item (inline TS only).

Add `pub mod sigma_and;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + main.rs call.

- [ ] **Step 3: Run fixture-gen, determinism check.**

- [ ] **Step 4: Write failing TS tests** at `packages/ergoscript/test/eval/sigma-and.test.ts` (mirror of atleast.test.ts shape).

- [ ] **Step 5: Implement `evalSigmaAnd`.**

`packages/ergoscript/src/eval/sigma-and.ts`:

```ts
import type { SigmaAnd } from '../mir/types'
import type { SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './context'
import { evalExpr } from './eval'
import { candNormalized } from '../mir/sigma-boolean-normalize'
import { expectSigmaProp } from './_sigma-helpers'

export function evalSigmaAnd(e: SigmaAnd, env: Env, ctx: EvalContext): SValue {
  const items = e.items.map((item) => expectSigmaProp(evalExpr(item, env, ctx), 'SigmaAnd'))
  ctx.addPerItemCost(10, 2, 1, items.length)
  return { kind: 'SigmaProp', value: candNormalized(items) }
}
```

- [ ] **Step 6: Wire into eval.ts.**

Add `case 'SigmaAnd': return evalSigmaAnd(e, env, ctx)`.

- [ ] **Step 7: Run tests; iterate; extend C3.a mutation tests for SigmaAnd in `sigma-combinators.test.ts`.**

- [ ] **Step 8: Full suite + typecheck + commit.**

```bash
git add packages/ergoscript/src/eval/sigma-and.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/sigma-and.test.ts \
        packages/ergoscript/test/eval-mutation/sigma-combinators.test.ts \
        packages/ergoscript/test/fixtures/eval/sigma-and.json \
        fixture-gen/src/cmds/ergoscript/eval/sigma_and.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs

git commit -m "feat(ergoscript): add SigmaAnd eval arm (phase 2g-combinators task 5)

evalSigmaAnd: Pattern B addPerItemCost(10, 2, 1, n); calls
candNormalized(items). Source: sigma_and.rs:13-28. MIR carries
items: Expr[] (not a single Coll expression).

Coverage 45 -> 46. C3.a mutation testing extended.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: SigmaOr arm

**Files:** mirror of Task 5 but `sigma-or.ts` / `sigma_or.rs` / `sigma-or.json`.

**Sigma-rust source-read:** `eval/sigma_or.rs:13-28` — same cost as SigmaAnd; calls `Cor::normalized`. MIR has `items: Expr[]` (same shape as SigmaAnd).

- [ ] **Step 1: Source-read sigma-rust's `sigma_or.rs` and `mir/sigma_or.rs`. Confirm `items: SigmaPropItems` is an Expr array.**

- [ ] **Step 2: Write fixture-gen for SigmaOr.**

`fixture-gen/src/cmds/ergoscript/eval/sigma_or.rs`. ~10 entries with absorbing/identity SWAPPED relative to SigmaAnd:

- 2-leaf basic (Cor([ProveDlog, ProveDlog])).
- 3-leaf basic.
- With TrivialProp(true) child → TrivialProp(true) (absorbing for OR).
- With TrivialProp(false) child (identity → filtered).
- Single child (after filter → unwrap).
- Empty after filter (only TrivialProp(false) children) → TrivialProp(false).
- 5-leaf.
- Mixed Dlog/DhTuple.
- Cost-limit.
- Error: non-SigmaProp item (inline TS only).

Add `pub mod sigma_or;` to `fixture-gen/src/cmds/ergoscript/eval/mod.rs` + `generate_and_write` call in `main.rs`.

- [ ] **Step 3: Run fixture-gen, determinism check.**

```bash
cd fixture-gen && cargo run --release
cd fixture-gen && cargo run --release  # determinism
git status -- packages/ergoscript/test/fixtures/eval/sigma-or.json  # expect clean after second run
```

- [ ] **Step 4: Write the failing TS tests** at `packages/ergoscript/test/eval/sigma-or.test.ts`. Same fixture-driven structure as `sigma-and.test.ts` from Task 5; load `sigma-or.json`; assert value + cost + error-code per entry.

- [ ] **Step 5: Run, verify failure.**

Run: `cd packages/ergoscript && npx vitest run test/eval/sigma-or.test.ts`
Expected: Fail with "SigmaOr not implemented" or similar.

- [ ] **Step 6: Implement `evalSigmaOr`.**

`packages/ergoscript/src/eval/sigma-or.ts`:

```ts
import type { SigmaOr } from '../mir/types'
import type { SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './context'
import { evalExpr } from './eval'
import { corNormalized } from '../mir/sigma-boolean-normalize'
import { expectSigmaProp } from './_sigma-helpers'

export function evalSigmaOr(e: SigmaOr, env: Env, ctx: EvalContext): SValue {
  const items = e.items.map((item) => expectSigmaProp(evalExpr(item, env, ctx), 'SigmaOr'))
  ctx.addPerItemCost(10, 2, 1, items.length)
  return { kind: 'SigmaProp', value: corNormalized(items) }
}
```

- [ ] **Step 7: Wire into central dispatch.**

Modify `packages/ergoscript/src/eval/eval.ts` to add:

```ts
case 'SigmaOr': return evalSigmaOr(e, env, ctx)
```

(Import at top: `import { evalSigmaOr } from './sigma-or'`.)

- [ ] **Step 8: Run SigmaOr tests, verify pass; extend C3.a mutation tests for SigmaOr in `sigma-combinators.test.ts`.**

- [ ] **Step 9: Run full suite, typecheck.**

```bash
cd packages/ergoscript && npm test
cd packages/ergoscript && npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 10: Commit.**

```bash
git add packages/ergoscript/src/eval/sigma-or.ts \
        packages/ergoscript/src/eval/eval.ts \
        packages/ergoscript/test/eval/sigma-or.test.ts \
        packages/ergoscript/test/eval-mutation/sigma-combinators.test.ts \
        packages/ergoscript/test/fixtures/eval/sigma-or.json \
        fixture-gen/src/cmds/ergoscript/eval/sigma_or.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs \
        fixture-gen/src/main.rs

git commit -m "feat(ergoscript): add SigmaOr eval arm (phase 2g-combinators task 6)

evalSigmaOr: Pattern B addPerItemCost(10, 2, 1, n); calls
corNormalized(items). Source: sigma_or.rs:13-28.

Coverage 46 -> 47. C3.a mutation testing extended. Closes the
3-arm eval-arm trio for sigma combinators.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Sig-serializer `readBytes` extension

**Files:**
- Modify: `packages/ergoscript/src/sigma/sig-serializer.ts`
- Test: `packages/ergoscript/test/sigma/sig-serializer.test.ts`

**Sigma-rust source-read:** Confirm `r.read_exact(&mut buf)` semantics at `sig_serializer.rs:223` — reads exactly `buf.len()` bytes or returns an error.

- [ ] **Step 1: Read sigma-rust's `r.read_exact` usage. The verifier reads `(n-k)*24` bytes for Cthreshold polynomials in one call. Confirm error mode: truncation → error → maps to our `'truncated-signature'`.**

- [ ] **Step 2: Write the failing test.**

Add to `packages/ergoscript/test/sigma/sig-serializer.test.ts`:

```ts
describe('ProofBytesReader.readBytes', () => {
  it('returns the next n bytes', () => {
    const r = readProofBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    expect(Array.from(r.readBytes(3))).toEqual([1, 2, 3])
    expect(Array.from(r.readBytes(2))).toEqual([4, 5])
  })
  it('throws truncated-signature on underrun', () => {
    const r = readProofBytes(new Uint8Array([1, 2, 3]))
    expect(() => r.readBytes(5)).toThrow(
      expect.objectContaining({ code: 'truncated-signature' }),
    )
  })
  it('returns defensive copies', () => {
    const buf = new Uint8Array([1, 2, 3, 4])
    const r = readProofBytes(buf)
    const result = r.readBytes(2)
    result[0] = 99
    expect(buf[0]).toBe(1)  // original unchanged
  })
})
```

- [ ] **Step 3: Run test, verify failure.**

- [ ] **Step 4: Implement.**

Add to `packages/ergoscript/src/sigma/sig-serializer.ts`:

```ts
class ProofBytesReader {
  // ... existing methods (readChallenge, readScalarBytes, assertConsumed)

  readBytes(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) {
      throw new VerifyError(
        'truncated-signature',
        `ProofBytesReader.readBytes: needed ${n} bytes, have ${this.bytes.length - this.pos}`,
      )
    }
    // Defensive copy
    const out = this.bytes.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}
```

- [ ] **Step 5: Run, full suite, typecheck.**

- [ ] **Step 6: Commit.**

```bash
git add packages/ergoscript/src/sigma/sig-serializer.ts \
        packages/ergoscript/test/sigma/sig-serializer.test.ts

git commit -m "feat(ergoscript): add ProofBytesReader.readBytes (phase 2g-combinators task 7)

Reads n bytes with defensive .slice() copy; throws 'truncated-signature'
on underrun. Used by Task 9's Cthreshold verifier walk to read the
(n-k)*24 polynomial bytes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Fixture-gen conjecture signing (Cand + Cor + Cthreshold)

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/verify/verifier_cand.rs`
- Create: `fixture-gen/src/cmds/ergoscript/verify/verifier_cor.rs`
- Create: `fixture-gen/src/cmds/ergoscript/verify/verifier_cthreshold.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/verify/mod.rs`
- Modify: `fixture-gen/src/main.rs`
- Output fixtures: `packages/ergoscript/test/fixtures/verify/verifier-cand*.json` and -cor / -cthreshold variants

**Sigma-rust source-reads:**

```bash
# Existing 2g-medium manual signing recipe
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/dlog_protocol.rs
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/dht_protocol.rs
# Polynomial construction for prover side
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/prover.rs | sed -n '560,610p'  # simulated path
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/prover.rs | sed -n '840,910p'  # real path
```

Lock conjecture-signing recipes per design spec § Fixture-gen manual deterministic conjecture signing. Reuse the 2g-medium pattern (in `verifier_positive.rs`) for the leaf signing primitive; build conjecture orchestration on top.

- [ ] **Step 1: Implement Cand fixture-gen.**

`fixture-gen/src/cmds/ergoscript/verify/verifier_cand.rs`. Recipe:
1. For each fixture: pick conjecture tree shape (Cand[ProveDlog, ProveDlog], or nested).
2. Derive root challenge deterministically: `blake2b256(domain || fixture-name || msg)[:24]`.
3. For each leaf: sign with the SAME root challenge using manual deterministic Schnorr/DhTuple primitive from 2g-medium.
4. Concatenate signature bytes: root challenge (24) || leaf1's z scalar (32) || leaf2's z scalar (32) || ... (no per-leaf challenges in proof).
5. Cross-validate: call sigma-rust's `verify_signature(sb, msg, sig)`. Panic if false.

~7 positive entries + ~3 reject (wrong scalar, empty sig, truncated sig) + ~30 mutation (byte-flip each signature byte) per the V2 strategy.

- [ ] **Step 2: Implement Cor fixture-gen.**

Recipe:
1. For each fixture: pick conjecture tree shape (Cor[ProveDlog, ProveDlog, ProveDlog]) and pick which leaf is "real" (we know its secret).
2. Derive root challenge deterministically.
3. For each simulated child (n-1 children): pick deterministic challenge `blake2b256(domain || child-index || msg)[:24]`. Pick deterministic z scalar. Compute commitment as `commitment = (g * z) + (-(pk * scalarFromChallenge(child-challenge)))` — backward Schnorr.
4. Real child's challenge = XOR(root, all simulated children's challenges).
5. Sign real child with its challenge using deterministic nonce.
6. Concatenate signature bytes: root challenge (24) || sim1 challenge (24) || sim1 z (32) || sim2 challenge (24) || sim2 z (32) || ... || real child z (32) [no challenge for real child since it's last in array order].
7. Cross-validate via sigma-rust.

**Critical:** the "last child" in the proof byte order may NOT be the "real" child. Sigma-rust's prover algorithm determines child-position deterministically; the verifier reads in tree-order and XOR-derives the last. The fixture-gen must put the real child LAST in the tree to match this protocol.

Cross-check by inspecting `prover.rs:570-604` (simulated path placement).

~7 positive + ~3 reject + ~30 mutation per V2.

- [ ] **Step 3: Implement Cthreshold fixture-gen.**

Recipe:
1. For each fixture: pick (k, n) and conjecture tree. Pick which k children are "real".
2. Derive root challenge deterministically.
3. For each simulated child ((n-k) of them): pick deterministic challenge + z + compute commitment (backward Schnorr).
4. Build polynomial via Lagrange: interpolate through (0, root_challenge_as_Gf2_192) and (sim_idx_i, sim_challenge_i_as_Gf2_192) for each simulated child. Use sigma-rust's `Gf2_192Poly::interpolate`.
5. For each real child at index j (1-based): derive its challenge = polynomial.evaluate(j). Sign real child with that challenge.
6. Concatenate signature bytes: root challenge (24) || polynomial bytes (`(n-k)*24`) || child1 z (32) || child2 z (32) || ... || childN z (32) (no per-child challenges).
7. Cross-validate via sigma-rust.

~7 positive (varying k and n: 2-of-3, 1-of-3 collapsed during eval but verify-stage tree may still be Cthreshold, 3-of-5, 2-of-5 mixed Dlog/DhTuple) + ~3 reject (corrupted polynomial bytes, truncated, wrong scalar) + ~50 mutation (byte-flip each signature byte INCLUDING polynomial bytes).

- [ ] **Step 4: Wire into mod.rs + main.rs.**

`fixture-gen/src/cmds/ergoscript/verify/mod.rs`:

```rust
pub mod verifier_positive;     // existing from 2g-medium
pub mod verifier_reject;        // existing
pub mod verifier_mutation;      // existing
pub mod verifier_cand;          // NEW
pub mod verifier_cor;           // NEW
pub mod verifier_cthreshold;    // NEW
```

`fixture-gen/src/main.rs` — add `generate_and_write` calls for the 9 new fixture files (3 conjectures × 3 categories: positive/reject/mutation).

- [ ] **Step 5: Run fixture-gen, determinism gate.**

```bash
cd fixture-gen && cargo run --release
cd fixture-gen && cargo run --release  # determinism check
git status -- packages/ergoscript/test/fixtures/verify/  # expect clean
```

The cross-validation gate (sigma-rust's `verify_signature` returns true on every positive fixture) is built INTO the fixture-gen — if it panics, fixtures don't get written. The two-run gate catches non-determinism.

- [ ] **Step 6: Commit (fixture-only commit; TS verifier code in Task 9).**

```bash
git add fixture-gen/src/cmds/ergoscript/verify/verifier_cand.rs \
        fixture-gen/src/cmds/ergoscript/verify/verifier_cor.rs \
        fixture-gen/src/cmds/ergoscript/verify/verifier_cthreshold.rs \
        fixture-gen/src/cmds/ergoscript/verify/mod.rs \
        fixture-gen/src/main.rs \
        packages/ergoscript/test/fixtures/verify/

git commit -m "$(cat <<'EOF'
test(ergoscript): add fixture-gen for Cand/Cor/Cthreshold signatures (phase 2g-combinators task 8)

Manual deterministic conjecture signing recipes extending 2g-medium's
leaf-only pattern. Cand inherits root challenge; Cor XORs simulated
children's challenges to derive real-child challenge; Cthreshold
constructs Lagrange polynomial through (0, root) and simulated
children's (index, challenge) points, evaluates at real-children's
1-based indices.

Cross-validation gate at fixture-gen time (sigma-rust's verify_signature
returns true on every positive fixture; panic on rejection). Determinism
gate via two-run cargo. V1 positive (~21) + V1 reject (~9) + V2
mutation (~110) entries across 3 conjectures.

TS verifier implementation in Task 9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Verifier conjecture walk + V1 + V2

**Files:**
- Modify: `packages/ergoscript/src/sigma/verifier.ts`
- Modify: `packages/ergoscript/src/sigma/errors.ts`
- Create: `packages/ergoscript/test/sigma/verifier-conjecture.test.ts`

**Sigma-rust source-read (REQUIRED before writing any TS):**

```bash
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/verifier.rs
cat ~/projects/sigma-rust/sigma-rust/ergotree-interpreter/src/sigma_protocol/sig_serializer.rs
```

Locked details to extract from the source (Task 9 implementer cites in code comments):
- Per-conjecture challenge derivation in `sig_serializer.rs:174-245`.
- Commitment aggregation in `verifier.rs:60-125`. The recursive `compute_commitments` walk feeds leaf commitments up to the root for the Fiat-Shamir hash check.
- The `unchecked_tree` data structure may need a TS analog OR can be inlined as recursive walk state. Decide at implementation time.

- [ ] **Step 1: Add 3 new VerifyError codes.**

Modify `packages/ergoscript/src/sigma/errors.ts` to add `'cthreshold-polynomial-bytes-mismatch'`, `'cor-derived-challenge-mismatch'`, `'cthreshold-derived-challenge-mismatch'` to `VerifyErrorCode`. Add code comment annotating `'conjecture-not-implemented'` as reserved (no longer thrown by 2g-combinators).

- [ ] **Step 2: Write the failing tests.**

`packages/ergoscript/test/sigma/verifier-conjecture.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { verifySignature, VerifyError } from '../../src'
import { hexToBytes, parseSigmaBoolean } from '../_helpers'

// Helper to load a fixture file
function loadFixtures(name: string) {
  return JSON.parse(
    readFileSync(resolve(__dirname, `../fixtures/verify/${name}.json`), 'utf8'),
  )
}

// Cand positive
describe('verifySignature: Cand positive', () => {
  const fixtures = loadFixtures('verifier-cand')
  for (const f of fixtures) {
    it(f.name, () => {
      const sb = parseSigmaBoolean(hexToBytes(f.sb_bytes_hex))
      const result = verifySignature(sb, hexToBytes(f.message_hex), hexToBytes(f.signature_hex))
      expect(result).toBe(true)
    })
  }
})

// Cand reject
describe('verifySignature: Cand reject', () => {
  const fixtures = loadFixtures('verifier-cand-reject')
  for (const f of fixtures) {
    it(f.name, () => {
      const sb = parseSigmaBoolean(hexToBytes(f.sb_bytes_hex))
      if (f.expected_error_code) {
        expect(() =>
          verifySignature(sb, hexToBytes(f.message_hex), hexToBytes(f.signature_hex)),
        ).toThrow(expect.objectContaining({ code: f.expected_error_code }))
      } else {
        expect(
          verifySignature(sb, hexToBytes(f.message_hex), hexToBytes(f.signature_hex)),
        ).toBe(false)
      }
    })
  }
})

// Cand mutation
describe('verifySignature: Cand mutation', () => {
  const fixtures = loadFixtures('verifier-cand-mutation')
  for (const f of fixtures) {
    it(f.name, () => {
      const sb = parseSigmaBoolean(hexToBytes(f.sb_bytes_hex))
      // Each mutation must yield false or a typed VerifyError
      let result: boolean | string
      try {
        result = verifySignature(sb, hexToBytes(f.message_hex), hexToBytes(f.signature_hex))
      } catch (e) {
        result = (e as VerifyError).code
      }
      // Must be false or a defined VerifyError code (never true)
      if (typeof result === 'boolean') {
        expect(result).toBe(false)
      } else {
        expect(typeof result).toBe('string')
      }
    })
  }
})

// Symmetric Cor and Cthreshold blocks (copy structure)
// ... [Cor positive/reject/mutation]
// ... [Cthreshold positive/reject/mutation]
```

- [ ] **Step 3: Run tests, verify failure.**

Run: `cd packages/ergoscript && npx vitest run test/sigma/verifier-conjecture.test.ts`
Expected: All tests fail (conjecture-not-implemented thrown).

- [ ] **Step 4: Refactor `verifier.ts` to recursive structure.**

Replace the 2g-medium `verifySignature` body's conjecture-rejection guard with a recursive walk. High-level shape:

```ts
import { Gf2_192Element, Gf2_192Poly } from '../crypto/gf2_192'
import { challengeXor } from './challenge'

export function verifySignature(
  sb: SigmaBoolean,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length === 0) {
    throw new VerifyError('empty-signature', 'signature is empty')
  }
  if (sb.tag === 'TrivialProp') return sb.value

  const reader = readProofBytes(signature)
  const rootChallenge = reader.readChallenge()  // 24 bytes

  // Recursively walk; compute per-leaf commitments
  const commitments = computeCommitments(sb, rootChallenge, reader, message)

  // Fiat-Shamir: recompute root challenge from tree + commitments + message
  const recomputed = fiatShamirHashOverTree(sb, commitments, message)
  return bytesEqual(recomputed, rootChallenge)
}

// Recursive walk:
// - Reads per-leaf scalars from reader.
// - Derives per-child challenges according to Cand/Cor/Cthreshold rules.
// - Computes per-leaf commitments via Schnorr/DhTuple math.
// - Returns the aggregated commitment structure mirroring sigma-rust's UncheckedTree shape.
function computeCommitments(
  sb: SigmaBoolean,
  challenge: Uint8Array,
  reader: ProofBytesReader,
  message: Uint8Array,
): CommitmentTree {
  switch (sb.tag) {
    case 'TrivialProp':
      // TrivialProp at non-root is an unusual case; sigma-rust likely treats it as a leaf-style accept.
      // Confirm at implementation.
      return { tag: 'TrivialProp', value: sb.value }
    case 'ProveDlog': {
      const z = reader.readScalarBytes()  // 32 bytes
      const commitment = commitmentProveDlog(sb.h, challenge, z)
      return { tag: 'ProveDlogCommitment', h: sb.h, challenge, commitment }
    }
    case 'ProveDhTuple': {
      const z = reader.readScalarBytes()
      const { a, b } = commitmentProveDhTuple(sb.g, sb.h, sb.u, sb.v, challenge, z)
      return { tag: 'ProveDhTupleCommitment', /* fields */, commitment_a: a, commitment_b: b }
    }
    case 'Cand': {
      // All children inherit parent challenge
      const childrenCommitments = sb.items.map((child) =>
        computeCommitments(child, challenge, reader, message),
      )
      return { tag: 'CandCommitment', items: childrenCommitments }
    }
    case 'Cor': {
      // First (n-1) children have explicit challenges in the proof
      const childChallenges: Uint8Array[] = []
      for (let i = 0; i < sb.items.length - 1; i++) {
        childChallenges.push(reader.readChallenge())
      }
      // Last child's challenge = XOR(parent, all read challenges)
      const xored = childChallenges.reduce(
        (acc, c) => challengeXor(acc, c),
        challenge.slice(),
      )
      childChallenges.push(xored)
      const childrenCommitments = sb.items.map((child, idx) =>
        computeCommitments(child, childChallenges[idx]!, reader, message),
      )
      return { tag: 'CorCommitment', items: childrenCommitments, challenges: childChallenges }
    }
    case 'Cthreshold': {
      // Read (n-k)*24 polynomial bytes
      const n = sb.items.length
      const k = sb.k
      const polyBytes = reader.readBytes((n - k) * 24)
      // Reconstruct polynomial: constant = parent challenge as Gf2_192Element
      const constant = Gf2_192Element.fromBytes(challenge)
      const poly = Gf2_192Poly.fromCoefficientsAndConstant(polyBytes, constant)
      // Derive each child's challenge as poly.evaluate(i+1)
      const childrenCommitments = sb.items.map((child, idx) => {
        const childChallenge = poly.evaluate(idx + 1).toBytes()
        return computeCommitments(child, childChallenge, reader, message)
      })
      return { tag: 'CthresholdCommitment', items: childrenCommitments, poly }
    }
  }
}
```

The exact Fiat-Shamir tree-serialization-and-hash logic for conjectures (the `fiatShamirHashOverTree` function) is governed by `sigma-rust/.../fiat_shamir.rs`. Implementer reads the source and ports the byte layout for internal nodes:

- Internal-node prefix byte is `0`; leaf prefix byte is `1` (already established in 2g-medium).
- Internal nodes serialize: `prefix(1=0) | child_count(i16 BE) | recurse(child1) | recurse(child2) | ...`. (Confirm at `fiat_shamir.rs:180-200`.)

The hash is `blake2b256(tree_bytes || message)`, taking the first 24 bytes.

- [ ] **Step 5: Run V1 positive tests; iterate until all pass.**

Iterate on:
- Cand challenge inheritance.
- Cor XOR direction (parent then fold children, NOT all-including-parent in one pass).
- Cthreshold polynomial reconstruction order (constant + remaining coefficients in order from the proof bytes).
- Cthreshold polynomial evaluation at 1-based indices.
- Fiat-Shamir tree serialization order.

The V1 fixtures are sigma-rust-signed and cross-validated; any verifier algorithm bug surfaces as one or more fixtures returning false.

- [ ] **Step 6: Run V1 reject tests.**

Each entry must return false or throw the expected VerifyError code.

- [ ] **Step 7: Run V2 mutation tests.**

Every byte-flip must yield false or a typed error (never true). Polynomial-bytes mutations for Cthreshold must reject.

- [ ] **Step 8: Run full suite.**

```bash
cd packages/ergoscript && npm test
cd packages/ergoscript && npx tsc --noEmit
```

Expected: prior 2017 + new normalization + GF(2^192) + Atleast/SigmaAnd/SigmaOr + verifier-conjecture tests all pass.

- [ ] **Step 9: Bundle scan.**

```bash
grep -rn 'Buffer\|process\.\|node:' packages/ergoscript/src/
```

Expected: no Node-specific imports in `src/`.

- [ ] **Step 10: Corpus regression check.**

```bash
cd packages/ergoscript && npx vitest run test/corpus-eval.test.ts
```

Expected: `success=0 not-impl=18 other=0` (unchanged).

- [ ] **Step 11: Commit.**

```bash
git add packages/ergoscript/src/sigma/verifier.ts \
        packages/ergoscript/src/sigma/errors.ts \
        packages/ergoscript/test/sigma/verifier-conjecture.test.ts

git commit -m "$(cat <<'EOF'
feat(ergoscript): verifier extension for Cand/Cor/Cthreshold conjectures (phase 2g-combinators task 9)

verifySignature now handles the full SigmaBoolean surface. Recursive
walk per sig_serializer.rs:174-245:
- Cand: all children inherit parent's challenge.
- Cor: read explicit challenges for first (n-1) children; last derived
  via XOR(parent, all read children).
- Cthreshold: read (n-k)*24 polynomial bytes; reconstruct polynomial
  with constant = parent challenge as Gf2_192Element; derive each
  child's challenge via polynomial.evaluate(1-based-index).

Fiat-Shamir tree hash extended for internal nodes per fiat_shamir.rs.
Leaf prefix=1 (existing); internal prefix=0; child-count is i16-BE
(NOT VLQ — gotcha carryover from 2g-medium).

Three new VerifyError codes: 'cthreshold-polynomial-bytes-mismatch',
'cor-derived-challenge-mismatch', 'cthreshold-derived-challenge-mismatch'.
'conjecture-not-implemented' code stays declared but is now unreachable.

Closes umbrella phase 2g. Coverage 47 of ~70 arms.

V1 positive (~21) + V1 reject (~9) + V2 mutation (~110) fixtures
from Task 8 all pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Docs update

**Files:**
- Modify: `facts/ergoscript.md`
- Modify: `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (umbrella)

- [ ] **Step 1: Update `facts/ergoscript.md`.**

Make additive edits:

- Add a new "Ships additionally (phase 2g-combinators)" section after the 2g-medium block.
  - 3 new eval arms documented (Atleast, SigmaAnd, SigmaOr) with cost values and source citations.
  - 3 new normalization helpers documented as internal modules.
  - GF(2^192) module added (Gf2_192Element + Gf2_192Poly types + public surface + byte format).
  - Verifier extension documented: `verifySignature` now handles full SigmaBoolean surface; per-conjecture rules.
  - 3 new EvalError codes added to the v0.2.0 taxonomy.
  - 3 new VerifyError codes added; `'conjecture-not-implemented'` annotated as reserved.
- Update "Coverage" line: 44 → 47 of ~70 arms.
- Update "Does NOT ship yet" — remove Atleast, SigmaAnd, SigmaOr, conjecture verifier extension. Keep method-call dispatch (2g.5), AVL+ (2h), predefs (2i), cost validation (2j).
- Update dependencies section to note no new TS runtime deps (still `@noble/curves@2.2.0` + `@noble/hashes@2.2.0`); `gf2_192` is hand-rolled in pure TS.

- [ ] **Step 2: Update umbrella plan.**

Modify `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — annotate the phase 2g entry to indicate both 2g-medium AND 2g-combinators have shipped:

> | **2g — Sigma protocol** | ... | ✅ shipped as **2g-medium** (2026-05-16) + **2g-combinators** (2026-05-17). Full SigmaBoolean verifier surface (leaf + Cand/Cor/Cthreshold); 3 new eval arms (Atleast/SigmaAnd/SigmaOr); GF(2^192) module. |

- [ ] **Step 3: Optional version bump.**

The slice introduces 3 new eval arms + completes the verifier surface. Natural milestone for v0.2.0 → v0.3.0 in `facts/ergoscript.md`'s VERSION constant. Decision: leave to user direction (the npm publish discussion at end of slice).

- [ ] **Step 4: Commit.**

```bash
git add facts/ergoscript.md docs/specs/2026-05-13-ergoscript-interpreter-design.md

git commit -m "$(cat <<'EOF'
docs(ergoscript): phase 2g-combinators facts + umbrella update

facts/ergoscript.md additively documents the 3 new eval arms (Atleast/
SigmaAnd/SigmaOr), 3 new EvalError codes, 3 new VerifyError codes,
GF(2^192) module (Gf2_192Element + Gf2_192Poly), and the verifier
extension that closes the umbrella phase 2g promise. Coverage line
updated to 47 of ~70 arms.

Umbrella plan annotated for 2g-combinators complete; phase 2g now
fully shipped (across 2g-medium + 2g-combinators sub-slices).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Finalize (memories, SESSION_CONTEXT, push)

**Files:**
- Create/modify: `packages/ergoscript/SESSION_CONTEXT.md`
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_sigma_combinators_deferred.md` (closeout — all 6 things shipped)
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/reference_sigma_verifier_internals.md` (extend with conjecture-walk details)
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_fixture_gen_cargo_gotchas.md` (extend with manual conjecture-signing recipes + gf2_192 dep note)
- Create: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/reference_gf2_192_internals.md` (NEW: polynomial byte format + interpolation invariants + IRRED_PENTANOMIAL value)
- Modify: `~/.claude/projects/-home-mwaddip-projects-ergots/memory/MEMORY.md`

- [ ] **Step 1: Write SESSION_CONTEXT.md snapshot.**

Match the 2g-medium SESSION_CONTEXT.md shape. Include: phase completed, coverage 47, new EvalError codes, new VerifyError codes, new modules (`mir/sigma-boolean-normalize.ts`, `crypto/gf2_192.ts`, `eval/_sigma-helpers.ts`, 3 new arm files), key design decisions, fixture counts.

- [ ] **Step 2: Update auto-loaded memories.**

- `project_ergots_direction.md` — phase 2g-combinators done; coverage 47; next is 2g.5 method-call dispatch.
- `project_sigma_combinators_deferred.md` — CLOSEOUT. Note all 6 deferred items shipped. Move to historical/archive or mark as closed.
- `reference_sigma_verifier_internals.md` — extend with: Cand inherits parent challenge; Cor XOR direction (parent ⊕ each read child = last child's challenge); Cthreshold polynomial reconstruction (constant = parent; (n-k) coefficients from proof bytes in order; evaluate at 1-based child indices); Fiat-Shamir internal-node prefix byte 0 vs leaf prefix byte 1.
- `project_fixture_gen_cargo_gotchas.md` — extend with: gf2_192 crate added as path dep; manual conjecture-signing recipes (Cand/Cor/Cthreshold) + cross-validation gate (sigma-rust's verify_signature panic on false).
- NEW `reference_gf2_192_internals.md` — IRRED_PENTANOMIAL = 0xE7 = x^7+x^6+x^5+x^2+x+1 (low bits of x^192 after reduction); irreducible = x^192 + x^7 + x^2 + x + 1; 24-byte BE serialization; polynomial degree = `coeffs.length - 1`; `toBytes` length = `degree * 24` (skips constant); `Gf2_192Poly.fromCoefficientsAndConstant` is verifier-path; `interpolate` is fixture-gen-path; 1-based child indices for conjecture polynomial evaluation; identity 0n vs ONE 1n in low word.

- [ ] **Step 3: Update MEMORY.md index.**

Add hook lines for `reference_gf2_192_internals` (new); update lines for `project_ergots_direction`, `project_sigma_combinators_deferred`, `reference_sigma_verifier_internals`, `project_fixture_gen_cargo_gotchas`.

- [ ] **Step 4: Full final verification.**

```bash
cd packages/ergoscript
npm test           # full suite passes
npx tsc --noEmit   # clean
grep -rn 'Buffer\|process\.\|node:' src/  # browser-clean

cd ../..
cd fixture-gen && cargo run --release  # determinism third pass
git status -- packages/ergoscript/test/fixtures/  # clean
```

- [ ] **Step 5: Final commit + push.**

```bash
git add packages/ergoscript/SESSION_CONTEXT.md

git commit -m "$(cat <<'EOF'
chore(ergoscript): phase 2g-combinators session context + memory updates

SESSION_CONTEXT.md snapshot at end of phase 2g-combinators. Coverage
47 of ~70 arms; 39 EvalError codes; 8 VerifyError codes (1 reserved);
new modules (mir/sigma-boolean-normalize, crypto/gf2_192,
eval/_sigma-helpers, 3 new arm files); manual conjecture-signing
fixture-gen recipes documented in memory.

Auto-loaded memories updated:
- project_ergots_direction (phase 2g-combinators done; next 2g.5)
- project_sigma_combinators_deferred (CLOSEOUT — all 6 shipped)
- reference_sigma_verifier_internals (extended)
- project_fixture_gen_cargo_gotchas (extended)
- reference_gf2_192_internals (NEW)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push origin master
```

---

## End-of-slice verification checklist

After Task 11 commits, run this checklist before signing off:

- [ ] `npm test` (ergoscript): all tests pass in both `node` and `jsdom`.
- [ ] `npx tsc --noEmit` (ergoscript): zero errors.
- [ ] Bundle scan: `grep -rn 'Buffer\|process\.\|node:' packages/ergoscript/src/` returns no matches.
- [ ] `cargo run --release` (fixture-gen) twice: zero diff in `packages/ergoscript/test/fixtures/`.
- [ ] Corpus regression: `npx vitest run test/corpus-eval.test.ts` shows `success=0 not-impl=18 other=0` (unchanged from 2g-medium).
- [ ] V1 positive fixtures (~21 across 3 conjectures) all return `true`.
- [ ] V1 reject fixtures (~9) all return `false` or throw expected `VerifyError`.
- [ ] V2 mutation fixtures (~110) all return `false` or throw a typed `VerifyError` (never `true`).
- [ ] GF(2^192) cross-validation fixtures (~95) all byte-equal sigma-rust output.
- [ ] C1 fixtures (~30 across 3 eval arms) all value+cost match.
- [ ] C3.a mutation kill rate ≥ 90% per arm (Atleast/SigmaAnd/SigmaOr).
- [ ] `facts/ergoscript.md` coverage line reads 47 of ~70 arms.
- [ ] `git status` clean (modulo gitignored `SESSION_CONTEXT.md` and `HANDOFF_PROMPT.md`).
- [ ] `master` pushed to origin.

---

*End of implementation plan. Source-first discipline; per-task commits; no artificial stops.*
