# v6 P1 — Numeric v6 methods (toBytes / toBits / bitwise / shift) — design

**Status:** DRAFT — adversarial review v1 done (verdict REVISE → blocking gating defect fixed; see
§10 Review history). Branch `ergoscript-v6` (phase P1 of the v6 umbrella,
`docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`).
**Scope:** eval **+ cost** for the 6.0 numeric methods on Byte/Short/Int/Long/BigInt. Unlike the
value-only P0, P1 moves cost → the cost-path confidence rigor applies (OVERRIDES #10, CLAUDE.md
confidence escalation).
**Canonical source:** JVM `sigma-state` **only** — no sigma-rust, no Rust `fixture-gen`
(v6 umbrella decision). Paths below are relative to `~/projects/sigmastate-interpreter/`.

---

## 1. Canonical sources (read-first)

- **Descriptors / ids / cost kinds / array membership:** `data/shared/src/main/scala/sigma/ast/methods.scala`
  — `SNumericTypeMethods` trait (`:232`) + object (`:260`); `v5Methods` (`:461`), `v6Methods` (`:471`),
  `getMethods` version split (`:251`, keys on `isV3OrLaterErgoTreeVersion`).
- **Per-type semantics:**
  - `data/shared/src/main/scala/sigma/data/ExactIntegral.scala` — Byte/Short/Int/Long.
  - `data/shared/src/main/scala/sigma/data/ExactNumeric.scala` — the generic **`toBits` (`:44`)**, built on
    `toBigEndianBytes`; declares the bitwise/shift signatures.
  - `data/shared/src/main/scala/sigma/data/BigIntegerOps.scala` — `BigIntIsExactIntegral` (`:75`) — BigInt
    (arbitrary-precision `java.math.BigInteger` ops).
- **Version model + the numeric-typeId shadowing (the gate):** `core/shared/src/main/scala/sigma/VersionContext.scala`
  (`V6SoftForkVersion = 3` `:56`; `isV3OrLaterErgoTreeVersion = ergoTreeVersion ≥ 3` `:29`); `SType.scala`
  `v5Types`/`v6Types` (numeric typeIds absent from v5Types — shadowed by SGlobal); `methods.scala`
  `_methodsMap`/`getMethods` (`:101`,`:251`) all key on `isV3OrLaterErgoTreeVersion`.
- **Availability gate:** `…/validation/ValidationRules.scala` `CheckAndGetMethodTemplate` (`:105`) =
  `getMethodById` lookup-or-throw; **no per-`SMethod` version field** (`SMethod.scala:68`).
- **Behavior/cost vectors + the empirical gate proof:** `sc/shared/src/test/scala/sigma/LanguageSpecificationV6.scala`;
  `sc/shared/src/test/scala/sigmastate/ErgoTreeSpecification.scala` `property("MethodCall on numerics")`
  (`:648-665`, with `isV6Activated := isV3OrLaterErgoTreeVersion` `:318`, shadowing at `:610`).

---

## 2. Method inventory

8 methods × 5 numeric types (Byte/Short/Int/Long/BigInt). **All `FixedCost(JitCost(5))`.**

| id | name | sig (receiver `T`) | `tRange` | cost kind (methods.scala) |
|----|------|--------------------|----------|---------------------------|
| 6  | `toBytes`        | `T → Coll[Byte]`    | **closed** `Coll[SByte]`    | `ToBytes_CostKind` Fixed(5) `:309` |
| 7  | `toBits`         | `T → Coll[Boolean]` | **closed** `Coll[SBoolean]` | `ToBits_CostKind` Fixed(5) `:332` |
| 8  | `bitwiseInverse` | `T → T`             | `tNum` (= `T`)              | `BitwiseOp_CostKind` Fixed(5) `:353` |
| 9  | `bitwiseOr`      | `(T, T) → T`        | `tNum`                      | Fixed(5) |
| 10 | `bitwiseAnd`     | `(T, T) → T`        | `tNum`                      | Fixed(5) |
| 11 | `bitwiseXor`     | `(T, T) → T`        | `tNum`                      | Fixed(5) |
| 12 | `shiftLeft`      | `(T, Int) → T`      | `tNum`                      | Fixed(5) |
| 13 | `shiftRight`     | `(T, Int) → T`      | `tNum`                      | Fixed(5) |

→ **40 eval handlers + 40 method-signature entries** (10 closed for `toBytes`/`toBits`; 30 generic-`tNum`
for bitwise/shift → second consumer of the P0 substitution engine, after `patch` 12:19).

**Numeric typeIds — CONFIRMED** `SByte=2, SShort=3, SInt=4, SLong=5, SBigInt=6`
(`wire/parse-stype.ts:57-66`, matching JVM `typeCode`).

**Why these are v6-new (not v5-reachable):** `toBytes`/`toBits` are in the `v5Methods` *array*, but
unresolvable on a numeric receiver pre-V3. Mechanism: in v5 the per-type method copies rewrite only `stype`,
**not** `objType` (`methods.scala:237-241`), whereas v6 sets `objType = this` (the concrete numeric type,
`:243-249`) — so v5 `_methodsMap` keys them under `SNumericType.typeId` and `getMethodById(2..6)` on the
concrete typeId misses → `CheckAndGetMethod` throws (`ValidationRules.scala:109-118`). (Related SType-level
story: `v5Types` shadows `SNumericType.typeId` with SGlobal — `SMethod.fromIds(SNumericType.typeId,1) ==
groupGeneratorMethod`, `ErgoTreeSpecification.scala:610`.) Net: a numeric MethodCall gates on
`ergoTreeVersion ≥ 3` exactly like bitwise/shift. Confirmed deployed-v5 did NOT have them
(`git show v5.0.0:…/types.scala:195-197` — "not implemented at all"; LanguageSpecificationV5 has no numeric
toBytes/toBits cases). ergots' current absence is correct for v5.

**Excluded:** `Boolean.toByte` — DROPPED (unimplemented in canonical JVM; `LanguageSpecificationV6:213-218`
asserts `MethodNotFound`, PR #932 pending). `BigInt.toUnsigned` id 14 → P2 (SUnsignedBigInt). The numeric
**cast** MethodCalls (ids 1–5, `toByte…toBigInt`) are *also* v6-gated as MethodCalls (same shadowing) but are
normally lowered to Upcast/Downcast opcodes, not MethodCalls → out of P1 scope.

---

## 3. Semantics

### 3a. Fixed-width types — Byte/Short/Int/Long (width `W` = 8/16/32/64), `ExactIntegral.scala`

- `bitwiseInverse(x)` = `trunc_W(~x)` (`:42`,`:68`,`:95`,`:124`).
- `bitwiseOr/And/Xor(x,y)` = `trunc_W(x op y)` (`:43-45`, …).
- `shiftLeft(x,bits)`: `if (bits < 0 || bits >= W) throw IllegalArgumentException else trunc_W(x << bits)`
  (`:46`,`:72`,`:100`,`:129`).
- `shiftRight(x,bits)`: same bound; else `x >> bits` — **arithmetic (sign-extending)** shift
  (`:53`,`:79`,`:108`,`:137`).
- `toBytes(x)` (= `toBigEndianBytes`): big-endian `W/8` bytes — Byte `[x]` (`:41`), Short 2 (`:67`),
  Int 4 (`:93`), Long 8 (`:122`).
- `toBits(x)`: `toBytes(x)`, each byte → 8 bits **MSB-first** → `W` booleans (`ExactNumeric.scala:44-58`).

**ergots impl notes** (`types.ts:849-852`: Byte/Short/Int = `number`, Long = `bigint`):
- Byte/Short/Int: JS `~ & | ^ << >>` are **32-bit signed** → exact for `W ≤ 32`. Sign-truncate the result
  to `W`: Byte `(n << 24) >> 24`, Short `(n << 16) >> 16`, Int native. `bits` arg is `SInt` = `number`.
  (Never use `>>>` — logical; the JVM uses arithmetic `>>`.)
- Long: `bigint`; do ops then `BigInt.asIntN(64, …)` to wrap to signed 64-bit; `<<` must be masked
  (JS BigInt grows); JS BigInt `>>` is arithmetic — matches.

### 3b. BigInt — `BigIntegerOps.scala` + `CBigInt.scala` (⚠ STRICTLY signed-256; consensus-sensitive)

**v6 BigInt is strictly signed-256 `[-2^255, 2^255-1]`.** The `CBigInt` constructor throws
`ArithmeticException("Too big bigint value")` for **any** value with `bitLength() > 255`, gated on
`isV3OrLaterErgoTreeVersion` (`CBigInt.scala:18-20`) — so every v6 BigInt op result must fit signed-256 or
the script fails. (Corrected after the Task-4 checkpoint; an earlier draft wrongly said "arbitrary precision,
may exceed 256 bits" — `shiftLeft(1,255)=2^255` actually THROWS.)

- `bitwiseInverse(x)` = `x.not()` = `−x−1`; `bitwiseOr/And/Xor` = `BigInteger.or/and/xor`
  (`BigIntegerOps.scala:101-107`). From in-range operands these stay in-range (can't exceed 255 bits), so they
  never overflow — the `CBigInt` v3+ constructor is the backstop.
- `shiftLeft(x,bits)`: bound `bits ∈ [0,256)` else throw; then `CBigInt(x.shiftLeft(bits).toSignedBigIntValueExact)`
  (`CBigInt.scala:67`) — the **result is range-checked**: `toSignedBigIntValueExact` throws
  `"BigInteger out of 256 bit range"` (`Extensions.scala:219-223`, ≡ `bitLength() > 255`) AND the constructor
  re-checks. **A result outside signed-256 (e.g. `shiftLeft(1,255)=2^255`) THROWS.**
- `shiftRight(x,bits)`: same bound; `x.shiftRight(bits)` arithmetic; result shrinks → always in-range (`:71`).
- `toBytes(x)` = `x.toBigInteger.toByteArray()` — minimal-length big-endian two's-complement incl. sign byte;
  `BigInt(0) → [0x00]`; variable length, ≤ 32 bytes since x is signed-256 (`BigIntegerOps.scala:99`).
- `toBits(x)`: `bytes.length * 8` booleans (variable; `ExactNumeric.scala:44`).

**ergots impl notes** (`types.ts:853`: BigInt = `bigint`): JS `~ | & ^ << >>` on `bigint` match `BigInteger`
exactly — **no `asIntN` mask** — BUT **every op result is range-checked to `[I256_MIN, I256_MAX]`**
(`eval/_byte-coll.ts`) and throws on overflow, mirroring the `CBigInt` v3+ constructor invariant; reuse the
range-check + `EvalError` code already used by `eval/byte-array-to-bigint.ts`. In practice only `shiftLeft`
can trip it (the bits-bound throw stays `numeric-shift-out-of-range`; the result-overflow throw is the
out-of-256 code). `toBytes`: reuse `encodeBigIntBE` (`wire/serialize-svalue.ts:556-589`) — confirmed
byte-for-byte vs `toByteArray` (`0n→[0x00]`, high-bit sign-prepend, minimal-k negatives); inverse
`decodeBigIntBE` (`parse-svalue.ts:557`).

**JVM-blessed vectors to pin** (`LanguageSpecificationV6.scala`): `toBytes` 127→[127], Short.Max→[127,-1],
Short.Min→[-128,0], Int.Max→[127,-1,-1,-1] (`:1192-1195`); `shiftLeft` (3,3)→24, (3,8)→768, (-2,10)→-2048,
(-222,10)→-227328, (-222,-1)→throws, (-222,256)→throws (`:1244-1255`) — **plus a result-overflow case
`shiftLeft(1,255)`→THROWS**; `shiftRight` (24,3)→3, (1600,8)→6 (`:1271+`).

---

## 4. Version gating — all eight methods gate on `ergoTreeVersion ≥ 3`

> Corrected after adversarial review (§10). The original draft's activation-gate model was a consensus-level
> error — it would have ergots **accept** a pre-V3-tree numeric MethodCall that the JVM **rejects** (a fork).

Numeric-receiver method availability is gated on `isV3OrLaterErgoTreeVersion` (= `ergoTreeVersion ≥ 3`),
**not** activation — for two independent reasons, both → treeVersion ≥ 3:
- bitwise/shift (8–13) ∈ `v6Methods` only; `getMethods` returns `v6Methods` only when
  `isV3OrLaterErgoTreeVersion` (`methods.scala:251`).
- `toBytes`/`toBits` (6,7): although in the `v5Methods` array, the v5 per-type method copies aren't rewritten
  to the concrete `objType`, so `getMethodById` on the numeric typeId misses pre-V3 → throws (§2).

**Verified empirically:** `ErgoTreeSpecification.property("MethodCall on numerics")` (`:648-665`) asserts
`SMethod.fromIds(numericTypeId, 1..7)` (incl. `toBytes`=6/`toBits`=7) **throws** when `!isV6Activated`, where
the test's `isV6Activated := VersionContext.current.isV3OrLaterErgoTreeVersion` (`:318`). Run by the reviewer
under `CrossVersionProps` at `(activatedVersion=3, ergoTreeVersion=2)` → **rejects**. Independently re-read
here (`:318`, `:610`, `:648-665`).

→ **Gate all eight (6–13) on the existing `HandlerEntry.minVersion: 3`** — the tree-version mechanism already
used by `checkPow` (104:16) and `insertOrUpdate` (100:16) (`method-call.ts:781,853`). **No `activatedVersion`
field, no `minActivatedVersion`, no new error code.** The gate is exact (zero residual): `treeVersion ≥ 3`
is the JVM's own resolution gate.

**Adversarial-faithfulness note:** the tree-version gate IS the faithful one *because* the JVM rejects the
pre-V3 numeric case (CLAUDE.md "Consensus correctness — the adversarial path carries equal weight"). The
discarded activation-plumbing would have forked by accepting it; the principle is what drove finding the
defect, not what's contradicted by the fix.

---

## 5. ergots integration / file plan (one phase, 2 source files + 1 new + tests)

1. **NEW** `eval/_numeric-v6.ts` — per-type width descriptors + the 8 op implementations + the shared
   `toBits`-from-bytes expander + BigInt minimal-two's-complement bytes (reusing `encodeBigIntBE`) +
   `registerNumericV6Methods()` that **loops the 5 typeIds**, registering all 40 handlers with
   `{ minVersion: 3 }` (DRY over 40 inline `.set()` — see §9).
2. `eval/method-call.ts` — call `registerNumericV6Methods()` from `registerHandlers()`. (No `HandlerEntry`
   change — `minVersion` already exists.)
3. `mir/method-signatures.ts` — 10 closed entries (`toBytes`→`Coll[Byte]`, `toBits`→`Coll[Boolean]`) +
   30 generic-`tNum` entries (bitwise/shift; `tDom`/`tRange` per §2, `tpeParams=[TNum]`). Review confirmed
   `resolveReturnTpe` binds `tNum`→receiver via the `patch` precedent.

`eval-context.ts`, `evaluate()`, `evaluateWith()` — **unchanged** (no activation plumbing).

---

## 6. Cost model

Each method `FixedCost(JitCost(5))`, charged **inside the handler**. The dispatcher already charges `4`
(MethodCall base, Pattern A, `method-call.ts:126`). `toBits`/`toBytes` are **FixedCost** — flat 5 even though
they build `W`-element collections (`ToBytes_CostKind`/`ToBits_CostKind` are `FixedCost`, **not**
`PerItemCost`). Per-call total = `4 (node) + 5 (method) + operand-eval`. These never touch the per-item cost
path, so the open `per_item_cost_n0` divergence cannot affect P1. Exact tree totals pinned by JVM-blessed
vectors. (The v5 walk already validated the `4 + per-method` MethodCall pattern to tip → pattern proven; only
the constant `5` is new.)

---

## 7. Test / conformance strategy

- **TDD** per the project discipline — per `(type, method)` RED → GREEN.
- **Vectors are JVM-blessed.** Source from `LanguageSpecificationV6` `verifyCases` (value; cost where pinned).
  For cost-total parity reuse the existing **conformance-vector harness** (`test/conformance/` +
  `test/fixtures/conformance/`) from the v5 sweep; route any cost trace the spec leaves `None` through SANTA.
- **Edge cases (per type):** shift bound (`bits<0`, `bits=W−1` ok, `bits=W` throw), `bitwiseInverse` sign,
  `toBytes`/`toBits` MSB-first + width, BigInt zero / negative / over-256 `shiftLeft`, and the **gate**
  (numeric `toBytes`/bitwise on a `treeVersion<3` tree → `tree-version-too-low`; `treeVersion≥3` → resolves).
- **Mutation:** shift-bound off-by-one; MSB↔LSB bit order; width-truncation drop.

---

## 8. Out of scope / residuals

- `Boolean.toByte` (dropped); `BigInt.toUnsigned` id 14 (→ P2); numeric cast MethodCalls ids 1–5 (lowered to
  Upcast/Downcast, not MethodCalls).
- **No residual divergence on the gate** — `treeVersion ≥ 3` for all eight is the JVM's exact resolution gate.

---

## 9. Open questions for the reviewer (post-revision)

1. **BigInt escalation (§3b)** — three verification items + the concrete reference vectors; sufficient to
   clear ≥95% before GREEN?
2. **Cost sourcing** — conformance-harness/SANTA route vs compute-and-pin?
3. **Programmatic registration** (loop over 5 typeIds) vs the established inline `.set()`-per-method pattern —
   acceptable for 40 regular entries?

(Resolved in v1: gating model → treeVersion≥3 for all eight; numeric typeIds 2–6; `encodeBigIntBE` reuse;
P0-engine `tNum` resolution; deployed-v5 had none.)

---

## 10. Review history

- **v1 (adversarial, general-purpose agent):** verdict **REVISE**. Blocking: **C6/C7 — the gating model was
  inverted** (drafted as activation-gated; JVM gates numeric methods on `ergoTreeVersion ≥ 3` via the SGlobal
  typeId shadowing). Confirmed by the reviewer compiling+running `ErgoTreeSpecification."MethodCall on numerics"`
  and independently re-verified here (`:318`/`:610`/`:648-665`). Fixed in §2/§4/§5/§8 (the activation plumbing
  removed — change shrank). All other claims (C1–C5, C8–C11) + probes VERIFIED (semantics, cost, P0-engine,
  typeIds, `encodeBigIntBE`, deployed-v5 absence). Pending: a re-check of the revised §4 + the §9 items.
