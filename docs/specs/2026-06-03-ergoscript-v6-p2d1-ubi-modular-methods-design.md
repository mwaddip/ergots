# ErgoScript v6 — P2d-1: `SUnsignedBigInt` modular methods (`mod`/`plusMod`/`subtractMod`/`multiplyMod`) + `BigInt.toUnsignedMod`

**Date:** 2026-06-03
**Phase:** v6 **P2d-1** (first of P2d; `modInverse` is carved out to **P2d-2**)
**Branch:** `ergoscript-v6` (local + `origin/ergoscript-v6`)
**Status:** design — pending user review → `writing-plans`

Canonical source = JVM `sigma-state` only (no sigma-rust, no Rust fixture-gen). Oracle =
`LanguageSpecificationV6.scala` `verifyCases` (JVM-executed expecteds).

---

## 1. Goal & scope

Five **mechanical** modular-arithmetic methods over the 256-bit unsigned field, all
`minVersion: 3`, all `FixedCost`:

| Method | `typeId:methodId` | signature | cost | semantics |
|---|---|---|---|---|
| `UBI.mod`           | 9:18 | `(UBI, UBI) → UBI`        | 20 | `a mod m` |
| `UBI.plusMod`       | 9:15 | `(UBI, UBI, UBI) → UBI`   | 30 | `(a + that) mod m` |
| `UBI.subtractMod`   | 9:16 | `(UBI, UBI, UBI) → UBI`   | 30 | `(a − that) mod m` |
| `UBI.multiplyMod`   | 9:17 | `(UBI, UBI, UBI) → UBI`   | 40 | `(a · that) mod m` |
| `BigInt.toUnsignedMod` | 6:15 | `(BigInt, UBI) → UBI`  | 15 | `aSigned mod m` (signed → UBI) |

**Out of scope (P2d-2):** `UBI.modInverse` (9:14, `FixedCost(150)`) — the only non-mechanical
piece (hand-written extended-Euclidean), deliberately separated for focused scrutiny.

**Carried in from P2c:** `toUnsigned` (6:14) and `toSigned` (9:19) already landed.

---

## 2. Canonical source (JVM `sigma-state`, direct read)

- **Descriptors / cost / gating:** `data/.../sigma/ast/methods.scala`
  - `SUnsignedBigIntMethods` (typeId 9): `ModInverseMethod` 14, `PlusModMethod` 15,
    `SubtractModMethod` 16, `MultiplyModMethod` 17, `ModMethod` 18, `ToSignedMethod` 19
    (`methods.scala:574-623`). FixedCosts as tabled above.
  - `SBigIntMethods` (typeId 6): `ToUnsignedMod` 15, `FixedCost(15)`, gated
    `isV3OrLaterErgoTreeVersion` via `getMethods()` (`methods.scala:551-565`).
- **Runtime arithmetic:** `core/.../sigma/data/CUnsignedBigInt.scala:47-77` and
  `CBigInt.scala:77-79`. Each method computes over `java.math.BigInteger` and wraps the result
  in `CUnsignedBigInt(...)`, whose constructor (`CUnsignedBigInt.scala:16-22`) throws on
  `value < 0` and on `bitLength > 256`.

```scala
// CUnsignedBigInt.scala
override def mod(m)         = CUnsignedBigInt(wrappedValue.mod(m))
override def plusMod(t, m)  = CUnsignedBigInt(wrappedValue.add(t).mod(m))
override def subtractMod(t, m) = CUnsignedBigInt(wrappedValue.subtract(t).mod(m))   // intermediate may be < 0
override def multiplyMod(t, m) = CUnsignedBigInt(wrappedValue.multiply(t).mod(m))
// CBigInt.scala
override def toUnsignedMod(m) = CUnsignedBigInt(this.wrappedValue.mod(m))           // receiver signed, may be < 0
```

`java.math.BigInteger.mod(m)`: requires `m > 0` (throws
`ArithmeticException("BigInteger: modulus not positive")` on `m ≤ 0`); returns the **Euclidean**
residue in `[0, m)` **regardless of dividend sign**.

---

## 3. The cost model

All five are `FixedCost`. The MethodCall dispatcher charges its existing **+4** before the
handler runs; the handler then `addCost`s the method's FixedCost (mod 20 / plusMod 30 /
subtractMod 30 / multiplyMod 40 / toUnsignedMod 15). No per-item cost.

Test-total accounting (the omission the P2c plan first made): a call over `Const` literals also
charges **per-`Const` eval = 5** per operand. E.g. `plusMod` over three constants =
`5×3 + 4 (dispatcher) + 30 (FixedCost) = 49`. Tests assert the full total.

---

## 4. Value semantics

**Range is free.** Every result is `r = x mod m ∈ [0, m)` with `m < 2²⁵⁶` (m is a UBI), so the
`CUnsignedBigInt` bound (`≥ 0`, `bitLength ≤ 256`) holds automatically. **No overflow /
out-of-range path exists** for any of the five — contrast P2b `shiftLeft`, which needed a range
throw. So none of these consult `checkUBIRange`.

**Euclidean, not remainder (the load-bearing point).** Two methods feed a *negative* dividend
into `.mod`:
- `subtractMod` when `a < that` (e.g. JVM vector `subtractMod(0, 24, 10) = 6`).
- `toUnsignedMod` whenever the *signed* receiver is negative (the runtime does plain `.mod`; the
  docstring's "non-negative" is aspirational — **the code accepts negatives**, so ergots must
  too — adversarial-path faithfulness, CLAUDE.md).

JS `%` is a remainder (sign follows the dividend), so bare `x % m` is wrong for these. The
Euclidean residue is `((x % m) + m) % m`. For `x ≥ 0` it equals `x % m`; for `x < 0` it wraps
into `[0, m)`.

**Only reachable error:** `m == 0`. UBI is always `≥ 0`, so `m ≤ 0 ⟺ m == 0`. The JVM throws
`ArithmeticException`; ergots reuses **`'arith-divide-by-zero'`** (the same code
`evalUBIArith` already uses for UBI modulo-by-zero). **Zero new EvalError codes.**

---

## 5. The central design decision — one `umod` chokepoint, `isNumeric` unwidened

All five route through a single primitive in a new `eval/_ubi-modular.ts`:

```ts
/** Euclidean modulo: residue in [0, m). Matches java.math.BigInteger.mod.
 *  Throws EvalError('arith-divide-by-zero') on m === 0n (JVM: "modulus not positive"). */
export function umod(x: bigint, m: bigint): bigint {
  if (m === 0n) throw new EvalError(`UnsignedBigInt modular op: modulus is zero`, 'arith-divide-by-zero')
  return ((x % m) + m) % m
}
```

This mirrors `_ubi-binop.ts`'s `checkUBIRange` (a helper that throws `EvalError` directly). The
per-method combination (`a + that`, `a − that`, `a · that`, `a`, `aSigned`) is trivial enough to
read inline at each handler — no separate per-op functions. Concentrating the only non-obvious
logic (Euclidean wrap + `m==0`) in one place is what makes the negative-dividend cases impossible
to get subtly wrong, and gives P2d-2's `modInverse` a sibling home next to the same helper.

**The eval-time `isNumeric` predicate stays UNWIDENED** (P2c Critical 1): these are UBI-specific
method handlers, not numeric BinOps, so nothing in `bin-op/_numeric.ts` changes and
`Negation(ubi)` etc. keep rejecting.

---

## 6. Implementation per method (`eval/method-call.ts` registry)

Five `HANDLERS.set(handlerKey(...), { minVersion: 3, handler })` entries beside the P2c bridges.
Each: `addCost(FixedCost)` → guard `obj.kind` and every `arg.kind` (`numeric-method-bad-operand`,
existing) → `umod(...)` → return `{ kind: 'UnsignedBigInt', value }`.

```ts
// UBI.plusMod (9:15) — exemplar
HANDLERS.set(handlerKey(9, 15), { minVersion: 3, handler: (obj, args, ctx) => {
  ctx.addCost(30)
  if (obj.kind !== 'UnsignedBigInt') throw new EvalError(..., 'numeric-method-bad-operand')
  const that = args[0], m = args[1]
  if (that?.kind !== 'UnsignedBigInt' || m?.kind !== 'UnsignedBigInt')
    throw new EvalError(..., 'numeric-method-bad-operand')
  return { kind: 'UnsignedBigInt', value: umod(obj.value + that.value, m.value) }
} })
```

- `mod` (9:18): cost 20, args `[m]`, `umod(obj.value, m.value)`.
- `plusMod` (9:15): cost 30, args `[that, m]`, `umod(a + that, m)`.
- `subtractMod` (9:16): cost 30, args `[that, m]`, `umod(a − that, m)`.
- `multiplyMod` (9:17): cost 40, args `[that, m]`, `umod(a · that, m)`.
- `toUnsignedMod` (6:15): cost 15, `obj.kind === 'BigInt'` (signed, may be `< 0`), arg `[m]` UBI,
  `umod(obj.value, m.value)`, return UBI.

**`mir/method-signatures.ts`:** add the 5 `(typeId, methodId) → tRange = SUnsignedBigInt` entries
(closed return type, no type-var) so `exprTpe` resolves results into downstream typed positions
(the P2a/b carry-forward pattern). `coll-map.ts` `inferSType`'s `UnsignedBigInt` arm already
exists (added P2b) — no change.

---

## 7. Error codes

| Trigger | Code | New? |
|---|---|---|
| `m == 0` (any of the five) | `'arith-divide-by-zero'` | reused |
| receiver / arg wrong `kind` (adversarial) | `'numeric-method-bad-operand'` | reused |

**Net: 0 new codes.** No range/overflow code is reachable (see §4).

---

## 8. Stub inventory & carry-forwards

- No P2a/P2c `'unsigned-bigint-op-unsupported'` stub covers these (that code now lives only in
  `_cast-ubi.ts` ×3 + the eval-context doc-catalog after P2c) — the modular methods were never
  stubbed; they were simply unimplemented method ids that fall through to the registry's
  unknown-method path. After P2d-1 they resolve.
- **Carry-forward to P2d-2:** `modInverse` (9:14) remains unimplemented; `_ubi-modular.ts` is
  authored so `modInverse` slots in beside `umod`.

---

## 9. Work list (files) — contract-first (`facts/` is Task 1)

1. **`facts/ergoscript-eval.md`** (+ meta `facts/ergoscript.md` if a count is quoted): +5 handlers,
   registry 104 → 109, the five methods (ids, costs, `minVersion: 3`, `arith-divide-by-zero`
   reuse for `m==0`, Euclidean residue). **Task 1.**
2. **`eval/_ubi-modular.ts`** — `umod` (RED: Euclidean residue incl. negative `x`; `m==0` throws).
3. **`eval/method-call.ts`** + **`mir/method-signatures.ts`** — `mod` + `plusMod` handlers + sigs.
4. **`eval/method-call.ts`** + **`mir/method-signatures.ts`** — `subtractMod` + `multiplyMod` (incl. underflow).
5. **`eval/method-call.ts`** + **`mir/method-signatures.ts`** — `toUnsignedMod` (BigInt receiver; `m==0` Failure).
6. **Gate + polish** — `tsc --noEmit` (4 pkgs) + full ergoscript suite (node + jsdom); cost-total,
   pre-V3 gate, adversarial-kind coverage.

---

## 10. Test strategy (TDD; oracle = `LanguageSpecificationV6` `verifyCases`)

**JVM-blessed vectors** (extracted, `g` = secp256k1 group order = `CryptoConstants.groupOrder`):

- `plusMod` (`:2740-2752`): `(24; 24,10)→8` · `(24; 24,24)→0` · `(g; g,g)→0`
- `subtractMod` (`:2793-2802`): `(0; 24,10)→6` *(underflow `(0−24) mod 10`)* · `(24; 24,24)→0`
- `multiplyMod` (`:2843-2849`): `(g; g,g)→0`
- `toUnsignedMod` (`:2466-2472`): `(50,10)→0` · `(50,0)→Failure ArithmeticException "BigInteger: modulus not positive"`

**`mod` (9:18) has no JVM `verifyCases`** → hand-derived from the confirmed `BigInteger.mod`
semantics (transitively validated: shares the exact `umod` + `m==0` path with the blessed
methods): `mod(24,10)→4` · `mod(24,24)→0` · `mod(0,10)→0` · `mod(7,0)→arith-divide-by-zero`.

**ergots edge cases (semantics-derived):**
- `subtractMod` deeper underflow + **`toUnsignedMod` negative receiver** (e.g. `toUnsignedMod(−7, 10)→3`) — the code-accepts-negatives faithfulness point (§4).
- `m == 0` for all five → `arith-divide-by-zero`.
- Near-`2²⁵⁶` operands (`multiplyMod` of two ~`2²⁵⁵` values mod a large `m`) — exercises the
  intermediate exceeding 256 bits before reduction (fine in JS `bigint`).
- Adversarial wrong-`kind` operand → `numeric-method-bad-operand`.
- Pre-V3 gate: each method on a `treeVersion < 3` tree is rejected (`minVersion: 3`).
- Cost totals per §3.

The `secp256k1` group-order constant **must be identical** to the one ergots' curve already uses
(cross-check in implementation) so the `g`-vectors are faithful.

---

## 11. Risks

- **Euclidean-vs-remainder (primary).** A bare `%` silently mis-handles `subtractMod` underflow +
  `toUnsignedMod` negative receiver. Mitigated by the single `umod` chokepoint and by making the
  JVM underflow vector (`subtractMod(0,24,10)=6`) and `toUnsignedMod(−7,10)=3` RED tests.
- **`groupOrder` drift.** The `g`-vectors are only faithful if the constant matches the JVM's
  `CryptoConstants.groupOrder`. Cross-checked against ergots' existing curve constant.
- **Residual (low):** `mod`'s missing JVM vector — covered by shared-helper transitivity and the
  trivial `a ≥ 0 ⟹ a mod m = a % m` identity.

---

## 12. Confidence

**~97%.** Semantics are vanilla `java.math.BigInteger` (no exotic crypto despite the
"cryptographic mod" label), confirmed by direct runtime-source read and corroborated by concrete
JVM `verifyCases` (including a negative-dividend case and the `m==0` failure). The one genuine
footgun (Euclidean wrap) is isolated to a single helper with a blessed RED test. The crypto-bar
item (`modInverse`) is deliberately not in this sub-phase.

---

## 13. Living-umbrella callback

On landing, update the umbrella ledger
(`docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`) P2 line: P2d split into **P2d-1**
(this — `mod`/`plusMod`/`subtractMod`/`multiplyMod`/`toUnsignedMod`) **DONE** and **P2d-2**
(`modInverse`) **next**. Then P3 Coll v6 · P4 Option v6 · P5 Global fns · P6 HOF lambdas · P7
per-type + `allZK/anyZK` · P8 validation.
