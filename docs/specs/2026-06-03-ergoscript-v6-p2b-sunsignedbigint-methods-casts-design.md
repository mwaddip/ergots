# ErgoScript v6 — P2b: `SUnsignedBigInt` numeric methods + casts

**Date:** 2026-06-03
**Status:** draft (brainstorm + adversarial review complete; pending user sign-off)
**Branch:** `ergoscript-v6`
**Umbrella:** `2026-06-02-ergoscript-v6-umbrella-design.md` — this is **P2b**. Note the **corrected P2
decomposition** (this session, after reading the JVM operation tables): P2a type core → **P2b numeric
methods + casts** → **P2c arithmetic + ordering BinOps + the trivial `toUnsigned`/`toSigned` bridges** →
**P2d modular-crypto batch** (`toUnsignedMod`, `modInverse`, `plusMod`, `subtractMod`, `multiplyMod`,
`mod`). The umbrella's original "P2b methods+casts / P2c modular+conversions" split silently omitted the
plain-arithmetic and ordering BinOp surface on UBI (`trees.scala:868` registers
`SUnsignedBigInt -> OperationImpl(UnsignedBigIntIsExactIntegral, UnsignedBigIntIsExactOrdering, …)`);
P2a stubs all of it (two sites in `relation.ts`) to throw `'unsigned-bigint-op-unsupported'`. P2b closes
the two lowest-risk groups; C/D/E and the crypto batch F follow.

**Adversarial review (2026-06-03) → REVISE, addressed in this revision:** (Critical 1) the cast path
must **not** widen the shared `isNumeric` predicate — it is consumed by 7 arms and would flip
`Negation(ubi)` from reject→accept (a fork); UBI is handled locally instead. (Critical 2) the original
"no cast targets UBI / `Upcast` untouched" claim was false for **hand-crafted** cast opcodes — a real
adversarial fork, now **closed** (the full UBI cast matrix, §4). (Important 1) `method-signatures.ts`
needs typeId 9 so UBI method returns resolve to concrete types, not `SAny`.

## 1. Goal & scope

Make `SUnsignedBigInt` usable through the **inherited numeric methods** and the **numeric casts**,
matching the JVM byte-for-byte on value **and** cost, version-gated to ErgoTree version ≥ 3.

**In scope (the two groups):**

- **A — numeric methods (typeId 9, methodIds 6–13):** `toBytes`, `toBits`, `bitwiseInverse`,
  `bitwiseOr`, `bitwiseAnd`, `bitwiseXor`, `shiftLeft`, `shiftRight`. All `FixedCost(JitCost(5))`.
  Implemented as MethodCall handlers — the 6th `NumV6` descriptor in the existing P1 machinery.
- **B — casts (`Upcast`/`Downcast` nodes with a UBI source or target):** the **full UBI cast matrix**
  (§4). Compiler-emitted casts only ever use UBI as a Downcast *source* (`ubi.toByte/Short/Int/Long` +
  the rejected `ubi.toBigInt`), but hand-crafted cast opcodes can put UBI in either position, and the
  JVM evaluates them — so faithfulness requires mirroring every `(source, target)` cell, including UBI
  as a cast *target*. Both `downcast.ts` **and** `upcast.ts` are touched.

**Explicitly out of P2b (deferred):**

- Plain arithmetic BinOps `+ − × / %` (`UnsignedBigIntIsExactIntegral`) and ordering `< ≤ > ≥`
  (`UnsignedBigIntIsExactOrdering`) → **P2c**. Includes `Negation(ubi)`, which the JVM leaves
  unimplemented (`UnsignedBigIntIsIntegral.negate = ???`) — a second permanently-rejected UBI op. These
  stay rejecting via the existing `isNumeric`-false path (Critical 1).
- `BigInt.toUnsigned` / `UBI.toSigned` (the trivial magnitude bridges) → **P2c**.
- Modular arithmetic `modInverse`/`plusMod`/`subtractMod`/`multiplyMod`/`mod` + `BigInt.toUnsignedMod`
  → **P2d**.

## 2. Canonical source (JVM `sigma-state`, confirmed by direct read)

All references are `~/projects/sigmastate-interpreter/`. v6 canonical source is the JVM **only** (no
sigma-rust dependency, no Rust fixture-gen). The existing `upcast.ts`/`downcast.ts` doc-comments cite
sigma-rust (v5-era); P2b's new arms cite the JVM. The pre-existing citations are left as-is (the v5 cast
cost was independently JVM-confirmed and walk-validated).

| Fact | Source |
|---|---|
| `SUnsignedBigInt` is an `SNumericType`; under v6 it inherits `SNumericTypeMethods.v6Methods` (ids 1–13) and adds its own (14–19) | `methods.scala:169, 232, 243–257, 570` |
| ids 6–13 all `FixedCost(JitCost(5))`: `ToBytes`(6), `ToBits`(7), `BitwiseInverse`(8), `BitwiseOr`(9), `BitwiseAnd`(10), `BitwiseXor`(11), `ShiftLeft`(12), `ShiftRight`(13) | `methods.scala:309–459` |
| `SUnsignedBigInt` `numericTypeIndex = 5` — the **largest** numeric (Byte 0 … BigInt 4, UBI 5); `getNumericCast` picks `Downcast` when `to ≤ from` | `SType.scala:418/441/463/488/519/556`, `methods.scala:493–501` |
| cast cost `NumericCastCostKind`: `SBigInt → 30`, **`SUnsignedBigInt → 30`**, else `→ 10`; charged **before** `tpe.downcast`/`upcast` runs (so a throwing cast still charges) | `CostKind.scala:60–66`, `trees.scala:404, 411–416, 436` |
| **The cast matrix** — `<target>.downcast/upcast(<source>)`: `SByte/SShort/SInt/SLong.downcast` accept a UBI source `if isV3OrLater` (`ubi.toXExact`); their `upcast` does **not**. `SBigInt.downcast`/`upcast` have **no** UBI case. `SUnsignedBigInt.downcast`/`upcast` accept Byte/Short/Int/Long/UBI sources (reject `< 0`) but **no BigInt** case. | `SType.scala:419–431, 442–454, 465–479, 491–506, 522–543, 559–590` |
| `CUnsignedBigInt`: constructor rejects negative + `bitLength > 256`; `toBytes = asUnsignedByteArray` (minimal); `bitwiseInverse = ~` over `asUnsignedByteArray(32,·)`; `shiftLeft = wrappedValue.shiftLeft` (bound via constructor); `toByte/Short/Int/Long = toXExact` | `CUnsignedBigInt.scala:16–22, 24–32, 86–94` |
| `toBits = toBigEndianBytes(x)` expanded to bits — **minimal** bytes, not fixed-width | `ExactNumeric.scala:44–58` |
| shift bits-range guard `bits < 0 || bits >= 256 ⇒ throw` (before the shift) | `UnsignedBigIntegerOps.scala:131–149` |
| `negate(UBI) = ???` (unimplemented) ⇒ `Negation(ubi)` rejects after cost — must NOT become reachable | `UnsignedBigIntegerOps.scala:48`, `trees.scala:868` |

## 3. Group A — the unsigned numeric descriptor

The 8 handlers already exist as factory functions in `eval/_numeric-v6.ts`, driven by a `NumV6`
descriptor and auto-registered at `minVersion: 3` (`method-call.ts:857–860`). P2b adds a **6th
descriptor** (`ubiDesc`, `typeId: 9`, `kind: 'UnsignedBigInt'`) to `NUMERIC_V6_TYPES`. It is **not** a
clone of `bigIntDesc` — three ops differ because the type is unsigned 256-bit:

| field | signed `bigIntDesc` | unsigned `ubiDesc` | why |
|---|---|---|---|
| `toBE` | `encodeBigIntBE` (two's-complement) | `encodeUnsignedBigIntBE` (P2a helper) | `toBytes`/`toBits` use unsigned magnitude (`CUnsignedBigInt.toBytes`) |
| `inv` | `~x` | `MASK256 - x` (≡ `x ^ MASK256`, `MASK256 = 2²⁵⁶−1`) | JVM flips all 256 bits via `asUnsignedByteArray(32,·)`; `~x` would go negative |
| `shl` | `checkBigInt256(x << bits)` (signed) | `(x << bits)`, throw if `≥ 2²⁵⁶` (`'unsigned-bigint-out-of-range'`) | `CUnsignedBigInt` constructor rejects `bitLength > 256` |
| `shr`,`or`,`and`,`xor` | as-is | same (non-negative ⇒ trivially in `[0, 2²⁵⁶−1]`) | — |
| `shiftBound` | 256 | 256 | bits ∈ [0,256) (`'numeric-shift-out-of-range'`, existing) |
| `kind`/`typeId` | `BigInt`/6 | `UnsignedBigInt`/9 | — |

- **`toBits` works unchanged** (`makeToBits` over the unsigned `toBE` — minimal bytes, confirmed
  `ExactNumeric.scala:44`). The `inv` asymmetry (256-bit fixed flip) is the inverse *value*; `toBytes`/
  `toBits` of that value still use minimal bytes — consistent.
- **`shiftLeft` overflow** is a new failure mode (left shift past `2²⁵⁶−1`). The bits-range guard fires
  first (in `makeShift`), then the magnitude guard inside `ubiDesc.shl` → **new** `EvalError`
  `'unsigned-bigint-out-of-range'` (P1's `'bigint-result-out-of-range'` is "signed-256"; the bound and
  meaning differ). The same code is reused for the negative-source cast rejects in §4 (both are "value
  outside `[0, 2²⁵⁶)`").
- **Operand-kind guard** (`requireKind`) comes for free once `NumV6.kind` admits `'UnsignedBigInt'`
  (a one-line union widening — note this is `_numeric-v6.ts`'s **local** `NumV6.kind`, NOT the shared
  `NumericKind`; no blast radius, per Critical 1).
- **Cost** is identical structure to P1: dispatcher Pattern-A `4` + handler `addCost(5)`.
- **Static return typing (Important 1).** `mir/method-signatures.ts` `NUMERIC_STYPE` has typeIds 2–6
  but **not 9**, so `numericV6Signatures()` does not emit UBI signatures and `exprTpe(ubi.bitwiseInverse)`
  resolves to `SAny` instead of `SUnsignedBigInt` (and `ubi.toBytes` → `SAny` not `Coll[Byte]`). Mostly
  masked by the SAny-skip discipline, but it is a real A3-class gap (empty-`Coll[UBI]` element typing).
  Fix: add `9: { tag: 'SUnsignedBigInt' }` to `NUMERIC_STYPE` (one line) — `tNum → SUnsignedBigInt`
  substitution then yields `bitwiseInverse: SUnsignedBigInt`, `toBytes: Coll[Byte]`, `toBits: Coll[Boolean]`.

`MASK256` / `UBI_MAX` (`2²⁵⁶−1`) is a new module constant in `_numeric-v6.ts`.

## 4. Group B — the full UBI cast matrix

Numeric casts serialize as `Upcast`/`Downcast` opcode nodes carrying an `input` value-expr and a numeric
`tpe`; deserialization enforces only `input.tpe ∈ SNumericType` (no `to ≤ from` constraint, no
post-deserialization typecheck), and `parseSType` accepts type code 9 permissively (P2a). So a
**hand-crafted** `Downcast(Int 5, SUnsignedBigInt)` (or any UBI-in-either-position cast) is a valid v6
tree the JVM evaluates — and ergots must match it bit-for-bit, not reject it (the original spec's "no
cast targets UBI" was a fork). The faithful behaviour is exactly `<tpe>.downcast/upcast(<source value>)`.

### 4.1 The matrix (mirror of `SType.scala`)

`v` = the source value as a bigint (UBI magnitude is already ≥ 0; signed kinds via `BigInt(value)`).
Cost is charged first in all cells (`30` if `tpe ∈ {SBigInt, SUnsignedBigInt}`, else `10`).

| node | source → target | JVM behaviour | ergots |
|---|---|---|---|
| Downcast | UBI → Byte/Short/Int/Long | `ubi.toX` (= `toXExact`) — range-check, throw if out of signed range | `checkRange(v, target, 'downcast-overflow')` → signed value |
| Downcast | UBI → BigInt | `SBigInt.downcast`: no UBI case ⇒ throw | throw `'unsigned-bigint-op-unsupported'` |
| Downcast/Upcast | UBI → UBI | identity (`v ≥ 0`) | `{ kind:'UnsignedBigInt', value: v }` |
| Downcast/Upcast | Byte/Short/Int/Long → UBI | `CUnsignedBigInt(valueOf(x))` if `x ≥ 0` else throw "negative" | `v < 0` ? throw `'unsigned-bigint-out-of-range'` : `{ kind:'UnsignedBigInt', value: v }` |
| Downcast/Upcast | BigInt → UBI | `SUnsignedBigInt.*`: no BigInt case ⇒ throw | throw `'unsigned-bigint-op-unsupported'` |
| Upcast | UBI → Byte/Short/Int/Long/BigInt | `<signed/BigInt>.upcast`: no UBI case ⇒ throw | throw `'unsigned-bigint-op-unsupported'` |

The signed-5 path (neither source nor target UBI) is **unchanged** — validated by the v5 walk.

### 4.2 Implementation (local, no shared-helper widening — Critical 1)

Both arms get a UBI branch **at the top**, before the existing `isNumeric`/`sTypeToNumericKind` signed
path:

```
evalDowncast(e):
  input = evalExpr(e.input)
  ctx.addCost((e.tpe.tag === 'SBigInt' || e.tpe.tag === 'SUnsignedBigInt') ? 30 : 10)
  if (e.tpe.tag === 'SUnsignedBigInt' || input.kind === 'UnsignedBigInt')
      return downcastUBI(input, e.tpe)        // §4.1 Downcast rows
  ... existing signed-5 path, unchanged ...

evalUpcast(e): symmetric — upcastUBI handles §4.1 Upcast rows.
```

- `downcastUBI` / `upcastUBI` are **local** to the cast arms. They read the source value as a bigint
  **directly** — `(input as { value: bigint }).value` for a UBI source, `BigInt(input.value)` for a
  signed source — and build UBI results inline (`{ kind:'UnsignedBigInt', value }`). They must **not**
  call `valueToBigInt`/`bigIntToValue`: those have no UBI arm (Critical 1) and would throw
  `'bin-op-not-numeric'` on a UBI value. They reuse only `checkRange` (signed target) and
  `sTypeToNumericKind` (signed target). They do **not** touch the shared `isNumeric`,
  `NUMERIC_KINDS`, `NumericKind`, `bigIntToValue`, or the `Record<NumericKind,…>` tables — so
  `Negation`/`BitInversion`/`Arith`/`Relation`/`Bit` keep rejecting UBI (correctly, until P2c/P2d).
- **Cost predicate** extended to `SUnsignedBigInt` (Minor 1): the existing `e.tpe.tag === 'SBigInt' ? 30
  : 10` would charge 10 for a UBI target — the JVM charges 30 (`NumericCastCostKind`). Now
  `(SBigInt || SUnsignedBigInt) ? 30 : 10` in both arms.
- **No V3 gate inside the UBI branch.** A cast with `tpe = SUnsignedBigInt` carries type code 9, which
  `validateV6Types` rejects pre-eval in a `< V3` tree; a UBI *source* value can only exist in a V3+ tree
  (P2a). So `downcastUBI`/`upcastUBI` are unreachable at `< V3` — the tree-level gate covers it (note,
  not a per-arm guard). Mirrors the JVM's `if isV3OrLater` on the signed-target UBI-source cases.
- **`upcast.ts` is now in scope** (UBI→UBI identity + signed/BigInt→UBI produce/reject + UBI-source
  reject) — the original "Upcast untouched" no longer holds.

### 4.3 Error codes

- `'unsigned-bigint-op-unsupported'` (reused from P2a) — the unsupported conversions: UBI↔BigInt (both
  directions, both nodes) and UBI-source `Upcast` to a signed target. Semantically "this UBI cast is not
  a supported language operation" (the language routes UBI↔BigInt through `toUnsigned`/`toSigned`).
- `'unsigned-bigint-out-of-range'` (new, shared with §3's `shiftLeft`) — a value outside `[0, 2²⁵⁶)`:
  `shiftLeft` result `≥ 2²⁵⁶`, and a **negative** signed source cast to a UBI target.
- `'downcast-overflow'` (existing) — UBI→signed Downcast where the magnitude exceeds the signed target.

Consensus contract is the accept/reject + cost, not the string; verified that the JVM **charges cost
then throws** at every reject cell (`trees.scala:436` wraps `tpe.downcast` in the cost closure).

## 5. Stub state & carry-forwards

- **Stub inventory (verified — grep of `'unsigned-bigint-op-unsupported'`).** P2a placed exactly **two**
  UBI stubs, both in `eval/bin-op/relation.ts:553,651` (the equality + ordering BinOp paths) — those are
  **P2c** (group D), left throwing. Methods reach the `(typeId, methodId)` registry (today `9:6…9:13`
  unregistered ⇒ `'method-not-implemented'`); casts reach the cast arms, where UBI today hits the
  generic `isNumeric`-false reject (`'bin-op-not-numeric'`) or `sTypeToNumericKind` throw — superseded by
  the §4 UBI branch. Nothing to remove; `Negation`/`Arith`/`Ordering` on UBI keep rejecting (they never
  enter the UBI cast branch).
- **`coll-map.ts inferSType`** (umbrella note) — **mandatory, not optional.** The `default:` arm
  **throws** (`'coll-map-elem-type-infer-failed'`); it does not fall back to `SAny`. Once the
  bitwise/shift handlers return `{kind:'UnsignedBigInt'}` values, a non-empty
  `Coll[T].map(x => x.bitwiseInverse)` calls `inferSType` on a UBI item → throws on a **valid** v6 tree
  (a reject-where-JVM-accepts mini-fork). tsc does **not** force the arm (the `default` swallows it). Add
  `case 'UnsignedBigInt': return { tag: 'SUnsignedBigInt' }`.
- **SValue exhaustiveness:** the `UnsignedBigInt` kind already exists (P2a, tsc-guarded then). P2b adds
  no `SValue` member; re-run tsc to catch any switch made reachable by UBI-producing ops.

## 6. Work list (files)

Contract-first: **facts/ is Task 1**.

- `facts/ergoscript-eval.md` — registry rows `9:6 … 9:13`; the UBI cast matrix (§4.1) incl. the
  `ubi.toBigInt` / BigInt↔UBI / UBI-source-Upcast rejects; the new `'unsigned-bigint-out-of-range'` code;
  the reused `'unsigned-bigint-op-unsupported'`; gating.
- `facts/ergoscript.md` — lookup-table touch if it enumerates the registry / codes.
- `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` — **P2 ledger update** (corrected b/c/d
  decomposition + P2b status).
- `mir/method-signatures.ts` — `NUMERIC_STYPE += 9: { tag: 'SUnsignedBigInt' }` (Important 1).
- `eval/_numeric-v6.ts` — `ubiDesc` (6th `NumV6`); widen the **local** `NumV6.kind` with
  `'UnsignedBigInt'`; `MASK256`/`UBI_MAX`; `'unsigned-bigint-out-of-range'` throw in `ubiDesc.shl`.
- `eval/downcast.ts` — `downcastUBI` branch (§4.2); cost predicate += `SUnsignedBigInt`.
- `eval/upcast.ts` — `upcastUBI` branch (§4.2); cost predicate += `SUnsignedBigInt`.
- `eval/coll-map.ts` — `inferSType` `'UnsignedBigInt'` arm.
- `eval/eval-context.ts` — add `'unsigned-bigint-out-of-range'` to the EvalError code doc-catalog
  (hygiene; `EvalError.code` is open `string`, not a closed union, so this is not a type gate).
  `'unsigned-bigint-op-unsupported'` is already catalogued (P2a).
- **NOT touched:** `eval/bin-op/_numeric.ts` (shared `isNumeric`/`NumericKind`/`bigIntToValue`/Records —
  Critical 1), `method-call.ts` (the `numericV6Handlers()` loop auto-registers `9:6…9:13`),
  `eval/bin-op/relation.ts` (its two UBI stubs are P2c).

## 7. Test strategy (TDD; oracle = hand-derived JVM-confirmed bytes)

No Rust fixture-gen. Vectors hand-constructed from the §2 confirmed JVM behaviour, plus
`LanguageSpecificationV6.scala` `verifyCases` where available. Each its own RED→GREEN.

- **A — methods** (v6 tree, version 3), per method: `toBytes` (`0→[]`, `2²⁵⁶−1→32×0xFF`); `toBits`
  (minimal width, `0x80→10000000`); `bitwiseInverse` (`inv(0)=2²⁵⁶−1`, `inv(1)=2²⁵⁶−2`, `inv(inv(x))=x`,
  **distinct from signed `~x`**); `or/and/xor`; `shiftLeft` (in-range; **overflow** `2²⁵⁵<<1 →
  'unsigned-bigint-out-of-range'`; bits `<0`/`≥256 → 'numeric-shift-out-of-range'`, bits-error-first);
  `shiftRight`; wrong-kind operand → `'numeric-method-bad-operand'`; v5 tree (hand-built MIR) →
  `'tree-version-too-low'`.
- **B — the cast matrix** (v6 tree), one per §4.1 cell:
  - UBI→Byte/Short/Int/Long: in-range converts; over-range → `'downcast-overflow'` (`ubi(200).toByte`,
    `ubi(2⁶³).toLong`); cost 10.
  - **UBI→BigInt → `'unsigned-bigint-op-unsupported'` for every value** (incl. `ubi(5)`); cost 30.
  - Int/Long→UBI (Up & Down): non-negative produces UBI (cost 30); **negative →
    `'unsigned-bigint-out-of-range'`** (`Downcast(Int -1, SUBI)`).
  - BigInt→UBI (Up & Down) → `'unsigned-bigint-op-unsupported'`; cost 30.
  - UBI→UBI (Up & Down) → identity, cost 30.
  - UBI→signed via **Upcast** → `'unsigned-bigint-op-unsupported'`; cost 10.
  - **Regression:** signed-5 Up/Downcast unchanged (no UBI) still pass.
- **exprTpe (Important 1):** `ubi.toBytes` statically resolves `Coll[Byte]`; `ubi.bitwiseInverse` →
  `SUnsignedBigInt`; an empty `Coll[UnsignedBigInt].map(x => x.bitwiseInverse)` element-types to
  `SUnsignedBigInt`, not `SAny`/`default:` throw.
- **Non-regression (Critical 1):** `Negation(ubiConst)` / an arith / an ordering BinOp on UBI still
  reject (unchanged) — pins that the cast work did not widen `isNumeric`.

## 8. Risks

- **Cast-matrix completeness** — the new care item: every §4.1 cell must match the JVM's
  `<target>.downcast/upcast(<source>)`. Mitigated by one test per cell + the exhaustive matrix table
  source-cited to `SType.scala`.
- **Not widening shared `isNumeric`** (Critical 1) — the fork trap; UBI handling is local, and the
  `Negation`/arith/ordering non-regression tests pin it.
- **Unsigned bitwise semantics** (`inverse` = 256-bit flip; `shiftLeft` overflow vs the unsigned bound)
  — pinned by the distinctness + overflow vectors against the source-confirmed `CUnsignedBigInt`.
- **Cost** — methods reuse P1's `4 + 5`; casts add the `SUnsignedBigInt → 30` target. Pinned by tree-cost
  assertions on every produce cell (and the charge-then-throw reject cells).
- **Minor (noted, no change):** a v5 hand-built `MethodCall(9, 6..13)` rejects via the dispatcher
  `minVersion: 3` (`'tree-version-too-low'`) where the JVM fails resolution differently; unreachable for
  parser-produced trees (`validateV6Types`), accept/reject outcome matches, so not a fork.

## 9. Confidence

High on every fact in §2/§4 (all source-confirmed by direct read of `SType.scala`/`CUnsignedBigInt`/
`CostKind`/`methods.scala`). No modular/curve crypto in P2b (that is P2d). The two care items
(unsigned bitwise semantics, the full cast matrix) are pinned by per-cell TDD vectors.

## 10. Living-umbrella callback

On completion, update the umbrella P2 ledger: P2b status → DONE; record the corrected b/c/d
decomposition, the `ubiDesc` descriptor, the **full UBI cast matrix** (incl. the UBI-as-target fork
closed per adversarial review), the new `'unsigned-bigint-out-of-range'` code, the `method-signatures.ts`
typeId-9 add, and the `inferSType` arm.
