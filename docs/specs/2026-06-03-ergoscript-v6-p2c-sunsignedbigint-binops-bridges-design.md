# ErgoScript v6 — P2c: `SUnsignedBigInt` arithmetic + ordering + equality BinOps + `toUnsigned`/`toSigned` bridges

**Date:** 2026-06-03
**Status:** draft (brainstorm + 2 adversarial spec reviews complete → SHIP; pending user sign-off)
**Branch:** `ergoscript-v6`
**Umbrella:** `2026-06-02-ergoscript-v6-umbrella-design.md` — this is **P2c**, the third of the corrected
P2 decomposition (P2a type core → P2b methods+casts → **P2c arith+ordering+equality BinOps + the
`toUnsigned`/`toSigned` bridges** → P2d modular-crypto). It replaces the two
`'unsigned-bigint-op-unsupported'` stubs P2a left in `relation.ts` and makes UBI a usable operand for the
plain numeric BinOps, version-gated to ErgoTree version ≥ 3.

**Adversarial review (2026-06-03) → REVISE, addressed in this revision:**
- **(Critical 1)** `validateBinOpTypes.isNumericTpe` excludes `SUnsignedBigInt`, so the ordering
  `OnlyNumeric` gate would reject a valid `LT/LE/GT/GE(ubi, ubi)` V3 tree **pre-eval** — a
  reject-where-JVM-accepts **fork** (`SUnsignedBigInt extends SNumericType`; the JVM's `OnlyNumeric`
  passes and `SameType` holds). **Closed** by adding the UBI case (§6.B / §9), verified safe for the
  mismatch + equality cases (`validate-bin-op-types.ts:36-47, 85, 93-97`).
- **(Important 1)** the `Coll[UBI]` equality mechanism is the **COA bulk-compare** (one `EQ_COA_BigInt`
  `PerItemCost`), **NOT** per-element recursion — rationale corrected; the directive (mirror the `SBigInt`
  arms) is unchanged and verified faithful: `descriptors` maps both `BigIntRType` and `UnsignedBigIntRType`
  to `(EQ_BigInt, EQ_COA_BigInt)` (`DataValueComparer.scala:141-142`; `isCoaCollElem(SBigInt)=true`,
  `relation.ts:309-318`).
- **(Important 2)** the left→cost→right charging order is an inherited, v5-walk-validated, boundary-only
  divergence from the JVM's left→right→cost — not introduced here (§11).
- The review **CONFIRMED** the headline non-BigInt cost tier (15/15/5), the `[0,2²⁵⁶)` bound, Min/Max via
  the ordering, the mismatched-operand rejects, `isNumeric` unwidened, and the bridge ids/costs/semantics
  against source.

**Second adversarial pass (2026-06-03) → SHIP.** An independent reviewer verified every fix above is
source-correct (each `CONFIRMED-CORRECT` at file:line) and re-attacked the whole revised spec — no new
consensus issues. It explicitly re-traced the §5 version-gate (UBI unreachable in `<V3` trees, incl.
register/context-var reads and deserialized `Deserialize*` sub-trees via the `rewrittenBody` walk —
`validate-v6-types.ts`) and confirmed it sound. One inherited cost-provenance note folded into §11.

## 1. Goal & scope

Make `SUnsignedBigInt` operable through the **plain (non-modular) numeric BinOps** and the **two trivial
signed↔unsigned bridge methods**, matching the JVM byte-for-byte on value **and** cost.

**In scope (four groups):**

- **A — arithmetic BinOps** (`arith.ts`): `Plus`, `Minus`, `Multiply`, `Divide`, `Modulo`, **`Min`,
  `Max`**. (Min/Max are arith-family `ArithOp`s; the JVM registers them for UBI and evals them via the
  ordering — §2.)
- **B — ordering BinOps** (`relation.ts`): `LT`, `LE`, `GT`, `GE`.
- **C — equality BinOps** (`relation.ts`): `EQ`, `NEQ` — the two `'unsigned-bigint-op-unsupported'`
  stubs P2a left (`sValueEquals` scalar case + `primitiveValueEqual` Coll-element case).
- **D — bridge methods** (method registry): `BigInt.toUnsigned` (typeId 6, id 14) and
  `UnsignedBigInt.toSigned` (typeId 9, id 19).

**Explicitly out of P2c (deferred to P2d):** the modular-crypto batch on `SUnsignedBigInt`
(`modInverse` id 14, `plusMod` id 15, `subtractMod` id 16, `multiplyMod` id 17, `mod` id 18) and
`BigInt.toUnsignedMod` (id 15) — all `FixedCost` (150/30/30/40/20/15), `methods.scala:574-605, 551-557`.

**Permanently out (never implemented in the JVM):** `Negation(ubi)` —
`UnsignedBigIntIsIntegral.negate = ???` (`UnsignedBigIntegerOps.scala:48`; `trees.scala:885-889` charges
`FixedCost(30)` then throws `NotImplementedError`). It must stay **rejecting** in ergots (a reject-outcome
match; intermediate cost-on-failure is moot since a throwing op fails the whole eval either way).

## 2. Canonical source (JVM `sigma-state`, direct read)

All references are `~/projects/sigmastate-interpreter/`. v6 canonical source is the JVM **only** (no
sigma-rust dependency, no Rust fixture-gen). **Cost facts below were read directly this session** (the
exploration subagent's first-pass cost table was wrong — see §3 — so each was re-verified at the charge
site).

| Fact | Source |
|---|---|
| `SUnsignedBigInt -> OperationImpl(UnsignedBigIntIsExactIntegral, UnsignedBigIntIsExactOrdering, SUnsignedBigInt)` — UBI is a full arith/ordering operand type | `trees.scala:868` |
| `ArithOp` charges `node.addCost(costKind, impl.argTpe)` — cost keyed on the **operation's argTpe** (= `SUnsignedBigInt` for UBI) | `trees.scala:733-737` |
| **every** arith `costKind` is `TypeBasedCost { case SBigInt => X; case _ => Y }` — `SUnsignedBigInt` is a distinct case object ⇒ it takes `case _` (the **non-BigInt** tier) | Plus `:752-757`, Minus `:767-772`, Multiply `:782-787`, Division `:797-802`, Modulo `:814-819`, Min `:829-834`, Max `:844-849` |
| `Plus/Minus` eval `impl.i.plus/minus`; `Multiply` `impl.i.times`; `Division` `impl.i.quot`; `Modulo` `impl.i.divisionRemainder`; **`Min`/`Max` eval `impl.o.min/max`** (the **ordering**, not integral) | `trees.scala:747,762,777,792,809,824,839` |
| ordering `LT/LE/GT/GE` charge `addCost(costKind, left.tpe)`, and every `costKind` is `case SBigInt => 20; case _ => 20` ⇒ **20 for all incl. UBI** | `trees.scala:1095-1194` |
| `EQ`/`NEQ` are `DynamicCost`, eval `DataValueComparer.equalDataValues(l, r)` (NEQ negates) | `trees.scala:1204-1216, 1224-1236` |
| `equalDataValues` dispatches on the **left** value; `case ubi: UnsignedBigInt => E.addFixedCost(EQ_BigInt) { okEqual = ubi == r }`; `EQ_BigInt = FixedCost(JitCost(5))` — **identical to signed BigInt (case 5)** | `DataValueComparer.scala:343-351`, `:48-50` |
| `Coll[UBI]` equality: `descriptors` maps `UnsignedBigIntRType → (EQ_BigInt, EQ_COA_BigInt)` — **same pair as `BigIntRType`** ⇒ a COA bulk-compare (single `EQ_COA_BigInt` `PerItemCost`), NOT per-element recursion | `DataValueComparer.scala:141-142` |
| `UnsignedBigIntIsExactIntegral`: `plus/minus/times` → `CUnsignedBigInt.add/subtract/multiply` → `toUnsignedBigIntValueExact`; `quot` → `divide`; `divisionRemainder` → `mod` | `UnsignedBigIntegerOps.scala:23-54, 65-150` (subagent; re-read at TDD red) |
| `CUnsignedBigInt` constructor rejects `< 0` and `bitLength > 256` ⇒ result bound `[0, 2²⁵⁶)`; `toUnsignedBigIntValueExact` = `x ≥ 0 && bitLength ≤ 256` | `CUnsignedBigInt.scala:14-22`, `Extensions.scala:234-240` (P2b-verified constructor; subagent for the `*Exact` helper) |
| `BigInt.toUnsigned` (id 14, `FixedCost(JitCost(5))`, `SFunc(SBigInt, SUnsignedBigInt)`): "throws on negative big integer"; V3+ gated | `methods.scala:543-549, 559-565` |
| `UnsignedBigInt.toSigned` (id 19, `FixedCost(JitCost(10))`, `SFunc(SUnsignedBigInt, SBigInt)`): "possible exception if leftmost bit is set" ⇒ rejects `≥ 2²⁵⁵` (`toSignedBigIntValueExact`, `bitLength ≤ 255`) | `methods.scala:607-611`, `Extensions.scala:219-223` (subagent) |
| `negate(UBI) = ???` | `UnsignedBigIntegerOps.scala:48`, `trees.scala:885-889` |

## 3. The cost model (the load-bearing correction)

**UBI arith/ordering does NOT cost the same as signed BigInt.** The inherited assumption (and the
exploration subagent's first table) was "UBI = BigInt tier." It is wrong: the cost match is
`case SBigInt => X; case _ => Y` and `SUnsignedBigInt ≠ SBigInt`, so UBI falls into `case _` — the
**non-BigInt tier**. The JVM simply never added a UBI case to these matches; faithfulness means
replicating that quirk exactly. (Independently re-confirmed by the adversarial review.)

| UBI op | JVM cost | signed BigInt | ergots reuse |
|---|---|---|---|
| `Plus`, `Minus` | **15** | 20 | `arithCost(op, /*isBigInt*/ false)` |
| `Multiply`, `Divide`, `Modulo` | **15** | 25 | `arithCost(op, false)` |
| `Min`, `Max` | **5** | 10 | `arithCost(op, false)` |
| `LT`, `LE`, `GT`, `GE` | 20 | 20 | `RELATION_ORDERING_COST` (= 20) |
| `EQ`, `NEQ` (scalar) | 5 | 5 | `EQ_BIGINT_COST` (= 5) |
| `Coll[UBI]` `EQ`/`NEQ` | `EQ_COA_BigInt` | same | `EQ_COLL_BIGINT_PER_ITEM` (= {15,7,5}) |
| `toUnsigned` (method) | 5 fixed | — | dispatcher Pattern-A `4` + handler `addCost(5)` … §6.D |
| `toSigned` (method) | 10 fixed | — | … `4` + `addCost(10)` |

So UBI arithmetic reuses ergots' **existing** `arithCost(op, false)` — the non-BigInt branch — even
though the values are 256-bit. Ordering reuses `RELATION_ORDERING_COST`; equality reuses
`EQ_BIGINT_COST` / `EQ_COLL_BIGINT_PER_ITEM`. No new cost constants are introduced.

## 4. Value semantics (per group)

`x`, `y` are the operand UBI magnitudes (`bigint`, already `≥ 0`).

- **A — arithmetic:**
  - `Plus = x + y`, `Minus = x − y`, `Multiply = x * y` → **bound-check `[0, 2²⁵⁶)`**: throw
    `'unsigned-bigint-out-of-range'` if `result < 0n` (`Minus` underflow) or `result > UBI_MAX`
    (`Plus`/`Multiply` overflow). Mirrors `CUnsignedBigInt.{add,subtract,multiply}` →
    `toUnsignedBigIntValueExact` (`UBI_MAX = 2²⁵⁶−1`, i.e. `bitLength ≤ 256`).
  - `Divide = x / y`, `Modulo = x % y` → throw `'arith-divide-by-zero'` (existing) when `y === 0n`.
    ergots pre-checks `y===0n`; the JVM throws during compute (`BigInteger.divide`/`mod`) **after** the op
    cost is already charged — accept/reject-equivalent (a throwing op fails the eval; intermediate cost
    moot). Otherwise both stay in range (non-negative operands; `Divide` can't overflow — no signed
    `MIN/-1` analog). **No negative-divisor special case** — unlike signed `BigInt` Modulo
    (`arith.ts:189-200`), UBI operands are non-negative so `x % y` already equals `BigInteger.mod`
    (`divisionRemainder = mod`, `UnsignedBigIntegerOps.scala:87`), no `rem < 0 ? rem + y` correction.
  - `Min = x ≤ y ? x : y`, `Max = x ≥ y ? x : y` → no overflow (subset of inputs).
- **B — ordering:** plain `bigint` compare (`<`, `<=`, `>`, `>=`). Width-independent, no range check.
- **C — equality:** plain `bigint` value compare; **UBI mirrors BigInt exactly** (the JVM maps both to
  `(EQ_BigInt, EQ_COA_BigInt)` — `DataValueComparer.scala:141-142`). Scalar `EQ`/`NEQ` charge
  `EQ_BIGINT_COST`; `Coll[UnsignedBigInt]` equality takes the **COA bulk-compare** path identical to
  `Coll[BigInt]` — a single `EQ_COLL_BIGINT_PER_ITEM` `PerItemCost` charge, then a non-recursive element
  loop (no per-element cost) — see §6.C.
- **D — bridges:**
  - `BigInt.toUnsigned`: receiver is a signed `BigInt` (`bitLength ≤ 255`, always fits unsigned-256), so
    **only the negative check applies** → throw `'unsigned-bigint-out-of-range'` if `value < 0n`, else
    `{ kind: 'UnsignedBigInt', value }`.
  - `UnsignedBigInt.toSigned`: throw `'bigint-result-out-of-range'` (the existing signed-256 code) if
    `value ≥ 2²⁵⁵` (leftmost-bit set), else `{ kind: 'BigInt', value }`.

## 5. The central design decision — local branches, `isNumeric` unwidened

P2b's **Critical 1** rule holds: **do not widen the shared `isNumeric` predicate** (consumed by 7 arms;
widening flips `Negation`/`BitInversion`/the unsupported ops from reject→accept — a fork). UBI is routed
**locally**, before the `isNumeric` guard in each arm. Consequences:

- `Negation(ubi)` and every not-yet-supported UBI op keep rejecting **automatically** (they never enter a
  UBI branch; the `isNumeric`-false path rejects them).
- The v5-walk-validated **signed path is byte-untouched** — UBI branches sit above it and `return` before
  it; the shared `valueToBigInt`/`bigIntToValue`/`checkRange`/`NumericKind` tables are not modified (they
  have no UBI arm and `checkRange` uses *signed* bounds — wrong for UBI).
- **Mismatched operands** (`Plus(ubi, Int)`, `LT(ubi, Long)` in a hand-crafted V3 tree) → reject, matching
  the JVM (a mismatched operand hits a `ClassCastException` in `impl.i/o` → reject; reject-outcome match,
  cost-on-failure moot). Two layers: **arith** has no JVM `check2` (and ergots' `validateBinOpTypes`
  covers only Relation — `validate-bin-op-types.ts:17-20`), so the `arith.ts` UBI branch is the guard — it
  requires `rv.kind === 'UnsignedBigInt'`, else `'bin-op-kind-mismatch'` (same posture as the signed
  mismatch reject, `arith.ts:118-124`). **Ordering/equality** mismatch is caught **pre-eval** by
  `validateBinOpTypes` (§6.B/§6.C); the `relation.ts` branch `rv.kind` guards are defense-in-depth.
- **Version gate (no per-arm V3 guard).** UBI can only exist in a V3+ tree — P2a's `validateV6Types`
  rejects type code 9 / `SFunc` annotations across the body + constants + deserialized sub-trees (the
  rewritten body), pre-eval. So no UBI value can reach a P2c arm in a `<V3` tree (incl. via
  register/context-var reads, which carry a UBI type annotation in the body that `validateV6Types`
  catches). Same posture as P2b's casts.

**Rejected alternative:** widen `isNumeric` + add UBI arms to `valueToBigInt`/`bigIntToValue` + make
`checkRange` unsigned-aware + add explicit `Negation`/`BitInversion` re-rejections. Strictly more surface
and more fork-risk for no gain. P2b settled this for casts; the same logic applies.

**Factoring (author's call — user deferred):** the arith/ordering value-math has real logic (the
`[0, 2²⁵⁶)` bound, the both-operands-UBI guard, the per-op compute), so it goes in a **dedicated helper**
`eval/bin-op/_ubi-binop.ts` (testable in isolation, cohesive with the existing UBI modules
`_numeric-v6.ts`/`_cast-ubi.ts`). Equality is trivial (one cost + one `===`) → **inline** in
`relation.ts`. The bridges are **method handlers** near the numeric-v6 method machinery.

## 6. Implementation per group

### A — arithmetic (`eval/bin-op/arith.ts` + `eval/bin-op/_ubi-binop.ts`)

A UBI branch at the top of `evalArithOp`, after left-eval, **before** the `isNumeric(lv.kind)` guard,
preserving the eval+cost ordering (left → cost → right):

```
lv = evalExpr(e.left)
if (lv.kind === 'UnsignedBigInt') {
  ctx.addCost(arithCost(op, /*isBigInt*/ false))   // 15 / 15 / 5 by op
  rv = evalExpr(e.right)
  if (rv.kind !== 'UnsignedBigInt')
      throw EvalError('bin-op-kind-mismatch')        // both must be UBI
  return evalUBIArith(op, lv.value, rv.value)        // _ubi-binop.ts: compute + [0,2^256) bound + div0
}
// ... existing signed path, unchanged ...
```

`evalUBIArith(op, x, y)` returns a `{ kind:'UnsignedBigInt', value }` (or throws). It reuses `UBI_MAX` /
`UBI_OUT_OF_RANGE` from `_numeric-v6.ts`; `'arith-divide-by-zero'` for `y===0` on Divide/Modulo.

### B — ordering (`eval/bin-op/relation.ts` + `_ubi-binop.ts`)

A UBI branch in `evalRelationOp`'s ordering path, after left-eval, before the `isNumeric` guard:

```
if (lv.kind === 'UnsignedBigInt') {
  ctx.addCost(RELATION_ORDERING_COST)   // 20
  rv = evalExpr(e.right)
  if (rv.kind !== 'UnsignedBigInt') throw EvalError('bin-op-kind-mismatch')
  return { kind:'Boolean', value: compareUBI(op, lv.value, rv.value) }   // _ubi-binop.ts
}
```

**Critical 1 — `validateBinOpTypes` must admit UBI for ordering (else the branch is unreachable).** The
pre-eval SameType pass (`eval/validate-bin-op-types.ts`) runs *before* eval; its ordering check applies
`OnlyNumeric` via `isNumericTpe`, which lists only Byte/Short/Int/Long/BigInt (`:36-47`). A V3
`LT(ubi, ubi)` would throw `'bin-op-not-numeric'` there (`:85`) — a reject-where-JVM-accepts **fork**
(`SUnsignedBigInt extends SNumericType`, so the JVM's `OnlyNumeric` passes and `SameType` holds, and it
evals via `opImpl.o = UnsignedBigIntIsExactOrdering`). **Fix: add `case 'SUnsignedBigInt': return true`
to `isNumericTpe`.** Verified safe: `LT(ubi,ubi)` then passes (`sTypeEqualsModuloSAny` true, `:93`);
`LT(Int,ubi)`/`LT(ubi,Long)` still reject (SameType, `:94-97`); EQ is unaffected (it uses
`sTypeEqualsModuloSAny`, not `isNumericTpe`).

### C — equality (`eval/bin-op/relation.ts`, inline) — **UBI mirrors BigInt**

Replace the two stubs and mirror the existing `BigInt` arms exactly:

- `sValueEquals` (`relation.ts:552-553`):
  `case 'UnsignedBigInt': ctx.addCost(EQ_BIGINT_COST); return a.value === (b as typeof a).value`
- `primitiveValueEqual` (`relation.ts:650-651`):
  `case 'UnsignedBigInt': return a.value === (b as typeof a).value` (no cost — the fast path)
- `collEqPerItemCost(elem)` and `isCoaCollElem(elem)`: add `'SUnsignedBigInt'` arms **identical to their
  `SBigInt` arms** (`collEqPerItemCost → EQ_COLL_BIGINT_PER_ITEM`; `isCoaCollElem → true`). `Coll[BigInt]`
  is a **COA bulk-compare** (`isCoaCollElem(SBigInt)=true`, `relation.ts:309-318`): one
  `EQ_COLL_BIGINT_PER_ITEM` `PerItemCost` charge, then a non-recursive loop via `primitiveValueEqual` (no
  per-element cost). Mirroring is JVM-faithful — `descriptors` maps both `BigIntRType` and
  `UnsignedBigIntRType` to `(EQ_BigInt, EQ_COA_BigInt)` (`DataValueComparer.scala:141-142`).

Cross-kind `EQ(ubi, Int)` is rejected **pre-eval** by `validateBinOpTypes` (the Eq path uses
`sTypeEqualsModuloSAny`, then numeric-and-pre-V3 allowance — `:69-79`; UBI/Int differ and V3 ⇒ reject; no
`isNumericTpe` change needed for EQ). The only residual is an SAny-typed UBI operand reaching
`sValueEquals` — there the top-of-function cross-kind guard charges `EQ_PRIM_COST` (JVM would charge
`EQ_BigInt`). This is the **same documented residual class** as JVM-align #2's SAny-dead-branch residual,
not a new P2c fork.

### D — bridges (`eval/method-call.ts` registry + a small handler)

Two MethodCall handlers, both `minVersion: 3`, both with **closed** return types (no P0 type-var):

- `(typeId 6, methodId 14)` `BigInt.toUnsigned`: receiver `kind 'BigInt'`; `value < 0n` →
  `'unsigned-bigint-out-of-range'`; else `{ kind:'UnsignedBigInt', value }`. Cost `4 + addCost(5)`.
- `(typeId 9, methodId 19)` `UnsignedBigInt.toSigned`: receiver `kind 'UnsignedBigInt'`;
  `value ≥ (1n << 255n)` → `'bigint-result-out-of-range'`; else `{ kind:'BigInt', value }`. Cost
  `4 + addCost(10)`.
- Operand-kind guard on the receiver (the P1 C1 lesson — wrong-kind receiver → `'numeric-method-bad-operand'`).
- `mir/method-signatures.ts`: add `(6,14) → SUnsignedBigInt` and `(9,19) → SBigInt` so `exprTpe` resolves
  the bridge returns (both closed; no substitution; don't collide with the `numericV6Signatures()` 6–13 loop).

## 7. Error codes

No **new** codes. Reuse:
- `'unsigned-bigint-out-of-range'` (P2b) — arith `[0, 2²⁵⁶)` violation (Minus underflow, Plus/Multiply
  overflow) and `toUnsigned` negative source.
- `'arith-divide-by-zero'` (existing) — UBI Divide/Modulo by zero.
- `'bin-op-kind-mismatch'` (existing) — a UBI BinOp with a non-UBI other operand (V3 adversarial tree).
- `'bigint-result-out-of-range'` (P1) — `toSigned` of a value `≥ 2²⁵⁵`.
- `'numeric-method-bad-operand'` (P1) — wrong-kind receiver on a bridge method.

Consensus contract is accept/reject + cost, not the string. Both stubs (`'unsigned-bigint-op-unsupported'`)
are **removed** by this phase (replaced with real equality). Grep after: that code should remain only in
`_cast-ubi.ts` (3 live throws — the P2b UBI↔BigInt cast rejects, still correct) plus the
`eval-context.ts:26` EvalError doc-catalog comment.

## 8. Stub inventory & carry-forwards

- **Stubs closed:** the two `'unsigned-bigint-op-unsupported'` sites in `relation.ts` (`:553` scalar EQ,
  `:651` Coll-element EQ). After P2c, `'unsigned-bigint-op-unsupported'` survives **only** in
  `_cast-ubi.ts` (3 live throws: UBI↔BigInt cast + UBI-source Upcast rejects — P2b, correct: the language
  routes those through `toUnsigned`/`toSigned`, which P2c now implements) plus the `eval-context.ts:26`
  doc-catalog comment.
- **`Negation(ubi)`** stays rejecting via `isNumeric`-false (non-regression test pins it).
- **Bridge v5-reject posture (same as P2b §8 Minor):** a hand-built v5 `MethodCall(6,14)`/`(9,19)` rejects
  via the dispatcher `minVersion:3` (`'tree-version-too-low'`) where the JVM fails method *resolution*
  (the method isn't in `getMethods` pre-V3); both reject, outcome matches, unreachable for parser-produced
  trees. Accepted, not re-litigated.
- **SValue exhaustiveness:** no new `SValue` member; re-run tsc to catch any switch made reachable.
- **P2d forward note:** the modular batch (`modInverse`/`plusMod`/`subtractMod`/`multiplyMod`/`mod` +
  `toUnsignedMod`) is the 95%-bar crypto phase — `mod`-family semantics + the `FixedCost` 150/30/30/40/20/15
  costs (`methods.scala:574-605`). Not touched here.

## 9. Work list (files) — contract-first (facts/ is Task 1)

- `facts/ergoscript-eval.md` — UBI BinOp operand support (arith A-group `15/15/5`, ordering `20`,
  equality `5` scalar / `EQ_COA_BigInt` Coll); the `toUnsigned` (6:14) / `toSigned` (9:19) registry rows;
  gating; the two stubs closed; the reused error codes. **Document the non-BigInt cost tier explicitly**
  (it is the surprising fact).
- `facts/ergoscript.md` — lookup-table touch if it enumerates the registry / codes.
- `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` — P2 ledger: P2c status → DONE + the cost-tier
  finding + the C1 `validateBinOpTypes` fork closed.
- `eval/bin-op/_ubi-binop.ts` — **new**: `evalUBIArith(op,x,y)` (compute + `[0,2²⁵⁶)` bound + div0),
  `compareUBI(op,x,y)`, the both-operands-UBI guard helper. Imports `UBI_MAX`/`UBI_OUT_OF_RANGE` from
  `_numeric-v6.ts`.
- `eval/bin-op/arith.ts` — UBI branch (A); reuses `arithCost(op, false)`.
- `eval/bin-op/relation.ts` — UBI ordering branch (B); the two equality cases (C); `collEqPerItemCost` +
  `isCoaCollElem` UBI arms mirroring BigInt.
- `eval/validate-bin-op-types.ts` — **`isNumericTpe` += `'SUnsignedBigInt'`** (Critical 1; required for
  the ordering `OnlyNumeric` gate to admit valid `LT(ubi,ubi)`).
- `mir/method-signatures.ts` — `(6,14) → SUnsignedBigInt`, `(9,19) → SBigInt`.
- `eval/method-call.ts` (or a small handler near `_numeric-v6.ts`) — `toUnsigned` / `toSigned` handlers,
  `minVersion: 3`, receiver-kind guard.
- `eval/eval-context.ts` — no new code; the reused codes are already catalogued.
- **NOT touched:** `eval/bin-op/_numeric.ts` (shared `isNumeric`/`NumericKind`/`valueToBigInt`/
  `bigIntToValue`/`checkRange` — Critical 1), `eval/bin-op/bit.ts`, `_cast-ubi.ts` (its rejects stay).

## 10. Test strategy (TDD; oracle = JVM-confirmed bytes + `LanguageSpecificationV6` `verifyCases`)

No Rust fixture-gen. Vectors hand-constructed from §2/§4 + `LanguageSpecificationV6.scala` `verifyCases`
where present. Each its own RED→GREEN. All in v6 (version-3) trees; pin tree cost on every accept.

- **A — arithmetic** (per op): in-range produce (assert cost 15/15/5); `Minus` **underflow** (`0 − 1 →
  'unsigned-bigint-out-of-range'`); `Plus`/`Multiply` **overflow** (`(2²⁵⁶−1) + 1`, `2¹²⁸ × 2¹²⁸ →
  'unsigned-bigint-out-of-range'`); `Divide`/`Modulo` by zero → `'arith-divide-by-zero'`; `Modulo`
  non-negative correctness (no signed `rem+y` correction); `Min`/`Max`; mismatched operand
  (`Plus(ubi, Int)` V3) → `'bin-op-kind-mismatch'`.
- **B — ordering** (per op): true/false cases; cost 20; mismatched operand → `'bin-op-kind-mismatch'`.
  **C1 regression: a V3 `LT(ubi,ubi)` must PASS `validateBinOpTypes`** (pins the `isNumericTpe` UBI add —
  without it the pass throws `'bin-op-not-numeric'` and the op is unreachable).
- **C — equality:** `EQ(ubi,ubi)` true/false + `NEQ`; cost 5; `Coll[UnsignedBigInt]` equality equal /
  length-mismatch / element-mismatch — assert cost **identical to the `Coll[BigInt]` analog** (COA bulk:
  `EQ_COLL_BIGINT_PER_ITEM`).
- **D — bridges:** `toUnsigned` (positive produce, cost 5; **negative BigInt** →
  `'unsigned-bigint-out-of-range'`); `toSigned` (in-range produce, cost 10; **`2²⁵⁵`** →
  `'bigint-result-out-of-range'`); `exprTpe`: `bigint.toUnsigned → SUnsignedBigInt`,
  `ubi.toSigned → SBigInt`; wrong-kind receiver → `'numeric-method-bad-operand'`.
- **Non-regression (Critical 1):** `Negation(ubiConst)` still rejects; a signed-numeric arith/ordering/
  equality BinOp is byte-unchanged (cost + value); the P2b cast matrix + UBI methods unchanged.
- **Stub-removal:** grep proves `'unsigned-bigint-op-unsupported'` is gone from `relation.ts` (survives
  only in `_cast-ubi.ts` + the eval-context doc-catalog).

## 11. Risks

- **Cost tier (the care item)** — UBI is the **non-BigInt** arith tier (15/15/5), not BigInt (20/25/10).
  Pinned by per-op tree-cost assertions; documented in `facts/` as the surprising fact.
- **`validateBinOpTypes` ordering gate (the fork the review caught)** — `isNumericTpe` must admit UBI or a
  valid `LT(ubi,ubi)` rejects pre-eval. Pinned by the §10.B C1 regression test.
- **Not widening shared `isNumeric`** (Critical 1) — the fork trap; UBI is local; `Negation`/arith/
  ordering non-regression tests pin it.
- **`Coll[UBI]` equality dispatch** — must mirror `Coll[BigInt]` exactly (COA bulk-compare,
  `EQ_COA_BigInt` PerItemCost); pinned by the cost-identical-to-`Coll[BigInt]` vectors.
- **Cost-charging order (inherited, not introduced)** — the UBI arith/ordering branches charge in ergots'
  existing left→cost→right order (sigma-rust-derived, v5-walk-validated across h=2→tip), a standing
  boundary-only divergence from the JVM's left→right→cost. Not new to P2c; the only self-consistent choice
  beside the signed arms it sits next to.
- **Cross-type EQ residual** — `EQ(ubi, Int)` rejected pre-eval by `validateBinOpTypes` (when `exprTpe`
  resolves); the SAny-operand residual is the existing documented #2 residual, not new.
- **Bound semantics** — `[0, 2²⁵⁶)` underflow/overflow (`toUnsignedBigIntValueExact`); re-read
  `CUnsignedBigInt`/`Extensions`/`UnsignedBigIntegerOps` at TDD red (subagent-sourced rows in §2).
- **Bridge cost envelope (inherited, made explicit)** — the bridges use the shared v6 method-dispatcher
  cost (`+4` before the handler's `addCost(5|10)`), identical to every shipped P1/P2b v6 method. Its
  JVM-correctness is inherited from those (validated through them) and pinned by P8 conformance, not
  separately re-derived in P2c.

## 12. Confidence

High on every cost fact in §2/§3 (read directly at the charge sites this session, after the subagent's
first table proved wrong, and independently re-confirmed by the adversarial review). High on the bridge
method ids/costs/semantics (`methods.scala` read directly). The `[0, 2²⁵⁶)` arith bound is P2b-verified at
the `CUnsignedBigInt` constructor; the `UnsignedBigIntIsExactIntegral` arith-routing through
`toUnsignedBigIntValueExact` and the `toSigned` `bitLength ≤ 255` helper are subagent-sourced and re-read
at TDD red (the docstrings I read directly — "throws on negative", "leftmost bit set" — corroborate).
**The adversarial review (REVISE) caught the C1 `validateBinOpTypes` ordering fork and corrected the I1
`Coll[UBI]` equality mechanism (now verified COA bulk via `descriptors` `:141-142`); both fixes verified
against the actual ergots + JVM source.** No curve/modular crypto in P2c (that is P2d).

## 13. Living-umbrella callback

On completion, update the umbrella P2 ledger: P2c status → DONE; record the **non-BigInt cost tier**
finding (the corrected assumption), the **C1 `validateBinOpTypes` ordering fork** closed (`isNumericTpe`
+= UBI), the `_ubi-binop.ts` helper, the two equality stubs closed (UBI mirrors BigInt — scalar + COA
bulk), the `toUnsigned`/`toSigned` bridge rows, and that `'unsigned-bigint-op-unsupported'` now survives
only in the P2b cast rejects. Confirm P2d (modular) is the remaining P2 sub-phase.
