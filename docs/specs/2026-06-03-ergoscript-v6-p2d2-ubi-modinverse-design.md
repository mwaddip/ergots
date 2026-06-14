# ErgoScript v6 — P2d-2: `UnsignedBigInt.modInverse`

**Date:** 2026-06-03
**Phase:** v6 **P2d-2** (second/last of P2d; completes P2 `SUnsignedBigInt`)
**Branch:** `ergoscript-v6` (local + `origin/ergoscript-v6`)
**Status:** design — pending user review → `writing-plans`

Canonical source = JVM `sigma-state` only (no sigma-rust, no Rust fixture-gen). Oracle =
`LanguageSpecificationV6.scala` + `BasicOpsSpecification.scala` (JVM-executed expecteds).

---

## 1. Goal & scope

One method — the modular multiplicative inverse over the 256-bit unsigned field:

| Method | `typeId:methodId` | signature | cost | semantics |
|---|---|---|---|---|
| `UBI.modInverse` | 9:14 | `(UBI, UBI) → UBI` | `FixedCost(150)` | `b` with `a·b ≡ 1 (mod m)`, `b ∈ [0, m)` |

This is the piece carved out of P2d (P2d-1 shipped `mod`/`plusMod`/`subtractMod`/`multiplyMod` +
`BigInt.toUnsignedMod`) for focused scrutiny: it is the one **non-mechanical** modular method —
`java.math.BigInteger` provides `.mod` natively (the P2d-1 chokepoint), but JS `bigint` has **no
native `modInverse`**, so the inverse must be hand-computed via the extended Euclidean algorithm.
Landing it completes P2 (`SUnsignedBigInt`).

`minVersion: 3` (gated `isV3OrLaterErgoTreeVersion`), like all of P1/P2.

---

## 2. Canonical source (JVM `sigma-state`, direct read)

- **Descriptor / cost / gating:** `data/.../sigma/ast/methods.scala`
  - `SUnsignedBigIntMethods` (typeId 9), `ModInverseMethod` id **14**
    (`methods.scala:576`): `SFunc(Array(ownerType, ownerType), ownerType)` = `(UBI, UBI) → UBI`.
  - `ModInverseCostInfo = OperationCostInfo(FixedCost(JitCost(150)), …)` (`methods.scala:574`).
  - Registered in `getMethods()` (`methods.scala:614-623`); the whole `SUnsignedBigIntMethods`
    container is V3-gated upstream (same gate as the P2d-1 five).
- **Runtime:** `core/.../sigma/data/CUnsignedBigInt.scala:57-59` — a **thin wrapper** over the
  platform `BigInteger`:

```scala
override def modInverse(m: UnsignedBigInt): UnsignedBigInt = {
  CUnsignedBigInt(wrappedValue.modInverse(m.asInstanceOf[CUnsignedBigInt].wrappedValue))
}
```

No bespoke crypto, and **no explicit base-reduction** — `java.math.BigInteger.modInverse(m)` itself
defines the result over `this mod m`. The `CUnsignedBigInt(...)` constructor
(`CUnsignedBigInt.scala:16-22`) throws on `value < 0` / `bitLength > 256`; neither fires here (see §4).

**`java.math.BigInteger.modInverse(m)` contract** (the behaviour ergots must match):
- `m ≤ 0` → `ArithmeticException("BigInteger: modulus not positive")`.
- `gcd(this, m) ≠ 1` (no multiplicative inverse) → `ArithmeticException("BigInteger not invertible.")`.
- `m == 1` → `0` (the only residue in `[0, 1)` is `0`; the inverse mod 1 is trivially `0` for any value).
- otherwise → the unique `b ∈ [0, m)` with `this·b ≡ 1 (mod m)` (independent of whether `this ≥ m`).

---

## 3. The cost model

`FixedCost(150)` — Pattern A (charge-before). The MethodCall dispatcher charges its existing **+4**
before the handler runs; the handler's first statement is `ctx.addCost(150)`. No per-item cost.

**Cost-then-throw** (the convention pinned at HEAD by the P2d-1 commit
*"pin cost-then-throw on UBI.mod m==0"*): `addCost(150)` precedes the operand-kind guards and the
extended-Euclidean computation, so **every** outcome — success, `m==0`, not-invertible,
wrong-`kind` — has charged the 150 (+ dispatcher + per-`Const`) before throwing.

Test-total accounting: a call over `Const` literals also charges **per-`Const` eval = 5** per operand.
`modInverse(12, 5)` over two constants = `5×2 + 4 (dispatcher) + 150 (FixedCost) = 164`. Tests assert
full totals (P2d-1 methodology).

---

## 4. Value semantics

**No range / overflow path.** The result `b` is always `∈ [0, m)` with `m < 2²⁵⁶` (m is a UBI), so the
`CUnsignedBigInt` bound (`≥ 0`, `bitLength ≤ 256`) holds automatically — exactly as for the P2d-1
five. No `checkUBIRange` consult.

**`m == 1` falls out for free — no special-case branch.** The extended Euclidean below, fed the
`umod`-reduced base `a₀ = umod(a, 1) = 0`, resolves `gcd = 1` and returns `umod(oldS, 1) = 0`. That
matches Java's `modInverse mod 1 = 0`. We pin it with a **test**, not a code branch (faithful = less
code).

**`a == 0, m > 1` → not invertible.** `gcd(0, m) = m ≠ 1`, so the algorithm throws — matching Java
(zero has no inverse modulo `m > 1`). For `m == 1` it returns `0` (previous point).

**Two reachable errors:**
- `m == 0` — UBI is always `≥ 0`, so `m ≤ 0 ⟺ m == 0`. Surfaced **for free** by the first
  `umod(a, m)` call (which already throws `'arith-divide-by-zero'` on `m === 0n`); no separate branch.
- `gcd(a, m) ≠ 1` — the genuinely new failure mode. Distinct from divide-by-zero (e.g. `m = 4, a = 2`
  is a perfectly positive modulus with no inverse). New code `'unsigned-bigint-not-invertible'`.

---

## 5. The central design decision — extended Euclidean via the `umod` chokepoint

JS `bigint` has no `modInverse`, so `modInverse` gets a **hand-written classic iterative extended
Euclidean** primitive `umodInverse(a, m)` in `eval/_ubi-modular.ts`, beside its P2d-1 sibling `umod`:

```ts
/** Modular multiplicative inverse: the b ∈ [0, m) with a·b ≡ 1 (mod m).
 *  Hand-rolled extended Euclidean (JS bigint has no native modInverse).
 *  Matches java.math.BigInteger.modInverse: m==0 ⇒ arith-divide-by-zero (via umod);
 *  gcd(a,m) != 1 ⇒ not invertible; m==1 ⇒ 0 (falls out, no special case). Spec §4/§5. */
export function umodInverse(a: bigint, m: bigint): bigint {
  let oldR = umod(a, m)   // reduce base into [0, m); also throws arith-divide-by-zero on m === 0n
  let r = m
  let oldS = 1n, s = 0n
  while (r !== 0n) {
    const q = oldR / r                  // non-negative integer division (oldR, r ≥ 0 throughout)
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  // oldR = gcd(a, m); oldS is the Bézout coefficient of a₀
  if (oldR !== 1n) {
    throw new EvalError('UnsignedBigInt.modInverse: value not invertible (gcd != 1)', 'unsigned-bigint-not-invertible')
  }
  return umod(oldS, m)                  // normalize the Bézout coefficient into [0, m)
}
```

**Why classic iterative EEA** (not recursive, not binary/Stein's): a 256-bit input can take ~370
remainder steps (Fibonacci worst case), so recursion would put that on the stack for no reason;
Stein's binary GCD avoids division but adds real bug surface (sign/parity bookkeeping) for zero benefit
at a fixed cost of 150. Textbook iterative is the lowest-risk faithful choice.

**Reuses `umod` twice** — once to reduce the base into `[0, m)`, once to normalize the (possibly
negative or `≥ m`) Bézout coefficient `oldS` into `[0, m)`. This is what makes both the `m == 0` path
and the result-range guarantee inherited rather than re-derived, and is why `_ubi-modular.ts` was
authored in P2d-1 as `modInverse`'s home.

**Correctness — hand-traced against both blessed vectors:**
- `modInverse(12, 5)`: `a₀ = umod(12,5) = 2`; `(oldR,r)=(2,5)→(5,2)→(2,1)→(1,0)`,
  `(oldS,s)=(1,0)→(0,1)→(1,-2)→(-2,5)`; `gcd = oldR = 1`, `oldS = -2`; `umod(-2,5) = 3`. ✓ `= 3`.
- `modInverse(3, 7)`: `a₀ = 3`; `(oldR,r)=(3,7)→(7,3)→(3,1)→(1,0)`, `(oldS,s)=(1,0)→(0,1)→(1,-2)→(-2,7)`;
  `gcd = 1`, `oldS = -2`; `umod(-2,7) = 5`. ✓ `= 5`.

(Integer division `oldR / r` is always over non-negative operands — the Euclidean remainder sequence
stays `≥ 0` — so JS `bigint` truncation equals floor and `q` is correct. `oldS`/`s` are only ever
updated by multiply-subtract, never divided, so their negativity is harmless and the final `umod`
normalizes.)

**The eval-time `isNumeric` predicate stays UNWIDENED** (P2c Critical 1): this is a UBI-specific method
handler, not a numeric BinOp; nothing in `bin-op/_numeric.ts` changes.

---

## 6. Implementation (`eval/method-call.ts` registry + `mir/method-signatures.ts`)

One `HANDLERS.set(handlerKey(9, 14), { minVersion: 3, handler })` entry beside the P2d-1 modular
methods. The handler: `addCost(150)` → guard `obj.kind` and `arg.kind` (`'numeric-method-bad-operand'`,
existing) → `umodInverse(...)` → return `{ kind: 'UnsignedBigInt', value }`.

```ts
// UBI.modInverse (9:14)
HANDLERS.set(handlerKey(9, 14), { minVersion: 3, handler: (obj, args, ctx) => {
  ctx.addCost(150)
  if (obj.kind !== 'UnsignedBigInt') throw new EvalError(..., 'numeric-method-bad-operand')
  const m = args[0]
  if (m?.kind !== 'UnsignedBigInt') throw new EvalError(..., 'numeric-method-bad-operand')
  return { kind: 'UnsignedBigInt', value: umodInverse(obj.value, m.value) }
} })
```

**`mir/method-signatures.ts`:** add the `(9, 14) → tRange = SUnsignedBigInt` entry (closed return type,
no type-var), so `exprTpe` resolves `modInverse` results into downstream typed positions — the
P2a/b/d-1 carry-forward pattern. `coll-map.ts` `inferSType`'s `UnsignedBigInt` arm already exists (P2b)
— no change.

---

## 7. Error codes

| Trigger | Code | New? |
|---|---|---|
| `m == 0` | `'arith-divide-by-zero'` | reused (inherited via `umod`) |
| `gcd(a, m) ≠ 1` (not invertible) | `'unsigned-bigint-not-invertible'` | **new (+1; codes 72 → 73)** |
| receiver / arg wrong `kind` (adversarial) | `'numeric-method-bad-operand'` | reused (P1) |

The new code is **consensus-neutral** (any throw rejects the tx regardless of which code) — it is an
ergots-internal taxonomy choice. A new symbol (vs reusing `'arith-divide-by-zero'`) is chosen because
"not invertible" is a semantically distinct failure (positive modulus, no inverse) and mirrors the
`unsigned-bigint-*` naming from P2b's `'unsigned-bigint-out-of-range'`. It is added to the
`eval-context.ts` EvalError doc-catalog alongside the existing codes.

---

## 8. Stub inventory & carry-forwards

- No stub covers `modInverse` (9:14) today; it is an unimplemented method id that falls through the
  registry's unknown-method path. After P2d-2 it resolves.
- **P2 complete.** With `modInverse` landed, `SUnsignedBigInt` has its full v6 method surface (P2a type
  core · P2b methods+casts · P2c arith/ordering/equality BinOps + bridges · P2d-1 modular · P2d-2
  modInverse). No UBI carry-forwards remain. Next phase is **P3** (Coll v6).

---

## 9. Work list (files) — contract-first (`facts/` is Task 1)

1. **`facts/ergoscript-eval.md`** (+ meta `facts/ergoscript.md` if a count is quoted): +1 handler,
   registry **109 → 110**; +1 EvalError code, **72 → 73**; the `modInverse` row (id, `FixedCost(150)`,
   `minVersion: 3`, `unsigned-bigint-not-invertible` for `gcd≠1`, `arith-divide-by-zero` for `m==0`,
   extended-Euclidean note). Mark P2 (`SUnsignedBigInt`) complete. **Task 1.**
2. **`eval/_ubi-modular.ts`** — `umodInverse` beside `umod` (RED: blessed `(12,5)→3` / `(3,7)→5`,
   not-invertible `(2,4)`, `m==1→0`, `a=0,m>1→not-invertible`).
3. **`eval/method-call.ts`** + **`mir/method-signatures.ts`** + **`eval-context.ts`** — the `9:14`
   handler (cost-then-throw, kind guards), the `(9,14)→SUnsignedBigInt` signature, and the new
   `'unsigned-bigint-not-invertible'` code in the catalog.
4. **Gate + polish** — `tsc --noEmit` (4 pkgs) + full ergoscript suite (node + jsdom); cost totals,
   pre-V3 gate, adversarial-kind coverage.

---

## 10. Test strategy (TDD; oracle = `LanguageSpecificationV6` / `BasicOpsSpecification`)

**JVM-blessed vectors** (executed expecteds):
- `modInverse(12, 5) → 3` — `LanguageSpecificationV6.scala:2874-2880` `verifyCases`.
- `modInverse(3, 7) → 5` — `BasicOpsSpecification.scala:590-608` (`3·5 = 15 ≡ 1 mod 7`).
- `modInverse(248486720836984554860790790898080606, 0) → throw` — `BasicOpsSpecification.scala:610-628`
  (m==0; ergots `'arith-divide-by-zero'`).

**Semantics-derived edge cases** (no blessed vector; behaviour is the deterministic
`BigInteger.modInverse` contract, §2):
- `gcd ≠ 1` not-invertible, e.g. `modInverse(2, 4) → 'unsigned-bigint-not-invertible'`.
- `m == 1 → 0` (pins the no-branch fall-through).
- `a == 0, m > 1 → 'unsigned-bigint-not-invertible'`.
- Large ~256-bit operands (a near `2²⁵⁵`, a large prime `m`) — exercises a deep remainder sequence and a
  large normalized result; confirms no overflow in JS `bigint`.
- Adversarial wrong-`kind` operand → `'numeric-method-bad-operand'`.
- Pre-V3 gate: `modInverse` on a `treeVersion < 3` tree → `'tree-version-too-low'` via the dispatcher's
  `minVersion: 3` gate (0 handler-cost), same as the P2d-1 five.
- Cost totals per §3 (the `164` two-`Const` case).

---

## 11. Risks

- **Extended-Euclidean correctness (primary).** A sign/normalization slip yields a wrong inverse.
  Mitigated by (a) hand-tracing both blessed vectors through the exact code (§5), (b) concentrating the
  only non-obvious logic in one helper with RED tests, (c) reusing the already-tested `umod` for both
  reduction and final normalization.
- **Not-invertible has no blessed ergots-side vector.** Mitigated by the deterministic, well-known JDK
  `modInverse` contract ("BigInteger not invertible.") and the `gcd ≠ 1` math; same posture as P2d-1's
  vector-less `mod` (transitively validated via the shared chokepoint).
- **`m == 1` subtlety.** Could be a footgun if hand-special-cased wrong; instead it falls out of the
  algorithm and is pinned by a test — no branch to get wrong.

---

## 12. Confidence

**~97%.** The runtime is vanilla `java.math.BigInteger.modInverse` (despite the "cryptographic"
label, no exotic crypto). The one piece of new logic — extended Euclidean — is hand-verified against
two JVM-blessed vectors and isolated in a single helper beside its tested sibling. Cost (`150`) and
gating (`minVersion: 3`) are read directly from `methods.scala:574-576`. Meets the CLAUDE.md crypto-path
≥95% bar without escalation.

---

## 13. Living-umbrella callback

On landing, update the umbrella ledger
(`docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`) P2 line: **P2d-2 (`modInverse`) DONE →
P2 (`SUnsignedBigInt`) COMPLETE**. Then the remaining phases: P3 Coll v6 · P4 Option v6 · P5 Global
fns · P6 HOF lambdas · P7 per-type + `allZK/anyZK` · P8 validation.
