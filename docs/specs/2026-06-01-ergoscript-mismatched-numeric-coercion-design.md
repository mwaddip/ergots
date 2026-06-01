# Mismatched-numeric BinOp coercion — eval-time upcast (version-gated)

- **Date:** 2026-06-01
- **Status:** Mechanism #1 IMPLEMENTED 2026-06-01 (eval-time version-gated coercion across arith + ordering + Eq/NEq; tsc clean, node 4139 / jsdom 3428 green). Mechanism #2 (parser-layer `check2(SameType)` strictness) DEFERRED — separate follow-up.
- **Workstream:** JVM-alignment (`project_jvm_alignment_workstream`); one of the two open items
  (other was A3, closed). Supersedes `HANDOFF_INTLONG_NUMERIC_COERCION.md`, whose framing this spec
  **corrects** in two ways (version gate + Eq/NEq inclusion).
- **Policy:** JVM `sigma-state` 6.0.3 is canonical. Source leads, the handoff does not.

## Problem

A `BinOp` whose two operands are **both numeric but of different width** (e.g. raw `Plus(Int, Long)`,
`Lt(Int, Long)`, `EQ(Int 5, Long 5)`) is handled by the JVM via an *auto-upcast inserted by the
deserializer* — but **only for pre-V3 ErgoTree versions**. ergots currently rejects (arith/ordering
throw `bin-op-kind-mismatch`) or silently mishandles (Eq/NEq returns `false` cross-kind) at **all**
versions. That makes ergots diverge from the JVM on hand-crafted pre-V3 trees — a latent multi-client
consensus-split vector (the workstream's recurring class).

## Canonical source — TWO distinct mechanisms

The deserializer uses `DeserializationSigmaBuilder` (`ValueSerializer.scala:36`), which extends
`TransformingSigmaBuilder` and routes each numeric BinOp through one of three op-helpers:

| op-helper | ops | body (`SigmaBuilder.scala`) |
|---|---|---|
| `arithOp` (700) | Plus/Minus/Multiply/Divide/Modulo/Min/Max | `applyUpcast` only — **no** SameType check |
| `comparisonOp` (689) | LT/LE/GT/GE | `check2(OnlyNumeric)` → `applyUpcast` → `check2(SameType)` |
| `equalityOp` (679) | EQ/NEQ | `applyUpcast` → `check2(SameType)` |

(Deserializer wiring: `ValueSerializer.scala:48-53` `Relation2Serializer(EQ, mkEQ)` … → `mkEQ`/`mkGT`/…
`SigmaBuilder.scala:291-307` → `equalityOp`/`comparisonOp`. `mkPlus`/… → `arithOp`.)

**Mechanism #1 — `applyUpcast` (coercion), VERSION-GATED.**
`DeserializationSigmaBuilder.applyUpcast` (`SigmaBuilder.scala:750-756`):

```scala
override protected def applyUpcast(left, right) =
  if (VersionContext.current.isV3OrLaterErgoTreeVersion) (left, right)   // V3+: raw, NO upcast
  else super.applyUpcast(left, right)                                     // pre-V3: upcast narrower
```

`isV3OrLaterErgoTreeVersion = ergoTreeVersion >= 3` (`VersionContext.scala:29`, `V6SoftForkVersion = 3`;
supported tree versions 0,1,2,3). `super.applyUpcast` (line 667-676): when both are `SNumericType` and
`t1 != t2`, upcast each to `t1 max t2` (the wider). The comment at line 744-749 is the reason it was
removed for V3+: *"to make deserialization always producing tree which was serialized"* — the JVM
itself adopted ergots' byte-roundtrip invariant as of V3.

**Mechanism #2 — `check2(SameType)` (strictness), at PARSE.** `check2` throws `ConstraintFailed`
(`SigmaBuilder.scala:287`) at deserialize-time. For comparison/equality, after the (version-gated)
upcast, operands must be the same type:
- pre-V3 + numeric-mismatch: upcast makes them equal → passes.
- V3+ + numeric-mismatch: upcast is a no-op → **fails → tree rejected at parse**.
- **non-numeric** mismatch (e.g. `EQ(Int, Boolean)`) at **any** version: `applyUpcast` is a no-op
  (not both numeric) → **fails → tree rejected at parse**.

`arithOp` has **no** SameType check, so mismatched arith never fails at parse — it fails at eval (V3+)
or is upcast (pre-V3), exactly matching ergots' eval-time posture.

## Behavior matrix (mismatched-NUMERIC operands)

| family | pre-V3 (`treeVersion < 3`) | V3+ (`treeVersion >= 3`) |
|---|---|---|
| arith | **coerce** → eval at wider (ACCEPT) | reject at eval — ergots already does this ✓ |
| comparison LT/LE/GT/GE | **coerce** → compare at wider (ACCEPT) | reject at **parse** (JVM) / ergots rejects at eval |
| equality EQ/NEQ | **coerce** → compare equal at wider (ACCEPT) | reject at **parse** (JVM) / ergots returns `false` |

ergots today: arith/comparison throw `bin-op-kind-mismatch` at eval; equality returns `false`.

## Scope

**IN (this task) — Mechanism #1, eval-time, `treeVersion < 3` only, all three families:**
- arith: replace the throw with coercion.
- comparison: replace the throw with coercion (value is already width-independent via bigint compare —
  only the cost changes).
- equality: replace cross-kind `false` with coercion + same-kind compare (value can flip `false`→`true`).

For `treeVersion >= 3` the coercion does **not** fire → existing behavior is left untouched (arith /
comparison throw at eval; equality returns `false`). This fully mirrors the JVM on every **evaluated**
path.

**DEFERRED / flagged — Mechanism #2 (parse-time SameType strictness).** A distinct mechanism (parser
layer, not coercion). Closing it would reject, at parse:
1. V3+ comparison/equality numeric-mismatch **in a dead branch** (JVM kills the whole tree at parse;
   ergots only fails if the node is evaluated) — the lone residual after Mechanism #1.
2. **Non-numeric** equality/comparison mismatch (`EQ(Int, Boolean)`) at any version — broader than the
   numeric task; present since 2a; adversarial-only.
Both are even-more-theoretical (adversarial + needs parser type-checking ergots deliberately avoids).
Recommendation: separate follow-up. **Decision pending.**

## Cost model

Coercion charges exactly the one `Upcast` node the JVM inserts on the narrower operand. Because
`evalConst` is a flat `5` regardless of type (`const.ts:28`), the cost is exactly:

> **cost(mismatched, pre-V3) = cost(same-width op at the WIDER kind) + Upcast(target = wider)**
> where Upcast = **30** if wider is BigInt, else **10** (`upcast.rs:80`, reused from `upcast.ts`).

Per family:
- **arith** — the op rate is taken at the **wider** kind. For non-BigInt widers (Int+Long, Byte+Int, …)
  `arithCost` is unchanged (15/5), so net = +Upcast(10). For BigInt widers the rate flips
  (Plus/Minus 15→20, Mult/Div/Mod 15→25, Max/Min 5→10) **and** Upcast is 30.
  Worked: `Plus(Int 2, Long 3)` = `5 + 15 + 5 + 10 = 35` (✓ handoff). `Plus(Int 2, BigInt 3)` =
  `5 + 20 + 5 + 30 = 60`.
- **comparison** — cost is a flat `20` (`RELATION_ORDERING_COST`), no rate flip. Net = +Upcast(10|30).
  Value unchanged (already a bigint compare). `Lt(Int 2, Long 3)` = `5 + 20 + 5 + 10 = 40`.
- **equality** — `sValueEquals` charges the per-kind eq cost at the **wider** kind: `EQ_PRIM_COST 3`
  (Long/Int/…) or `EQ_BIGINT_COST 5` (BigInt). Net = +Upcast(10|30), plus the eq rate is taken at
  wider. `EQ(Int 5, Long 5)` = `5 + 5 + 10 + 3 = 23`, value `true` (vs ergots-today `false`).

Charge order is reconstructed faithfully (the inserted Upcast is charged when the narrower operand is
processed); totals are order-independent here (all charges precede any throwing arithmetic), so
conformance (final cost) is unaffected by left/right operand order.

## Implementation sites

- `eval/bin-op/_numeric.ts` — add `widerKind(a, b): NumericKind` (Byte<Short<Int<Long<BigInt, = JVM
  `t1 max t2`) and an `upcastCost(target): number` helper (10/30) so the magic numbers live with the
  numeric kit; have `eval/upcast.ts` reuse it.
- `eval/bin-op/arith.ts` — at the kind-mismatch site (110-115): if `treeVersion < 3` and both numeric,
  coerce instead of throw (charge Upcast + arith-rate delta; compute/range-check at wider; return wider).
- `eval/bin-op/relation.ts` — ordering site (688-693): if `treeVersion < 3` and both numeric, charge
  Upcast instead of throw (compare unchanged). EQ/NEQ branch (661-666): if `treeVersion < 3` and both
  numeric and different kind, charge Upcast + coerce both to wider before `sValueEquals`.
- Keep the parser/wire layer untouched — tree stays RAW; byte-roundtrip
  `serializeTree(parseTree(b)) === b` holds (and is now JVM-corroborated for V3+).

## TDD plan

1. RED: hand-built MIR fixtures (no SANTA vector exists yet) at `treeVersion < 3`:
   `Plus(Int, Long)` → Long value + cost 35; `Lt(Int, Long)` → Boolean + cost 40; `EQ(Int 5, Long 5)`
   → `true` + cost 23. Plus one BigInt-wider case (`Plus(Int, BigInt)` = 60) for the rate flip. Watch
   each fail (throws / returns false / wrong cost).
2. GREEN: implement per family. REFACTOR.
3. Regression guards: same-width ops unchanged (common path); `treeVersion >= 3` mismatched still
   rejects (arith/comparison) / returns false (equality) — assert the gate.
4. Swap/augment hand-built expectations with SANTA-blessed value+cost when the vector lands (re-bless,
   don't rederive).
5. `tsc --noEmit` clean + full ergoscript suite (node + jsdom) green.

## SANTA conformance-vector request (explicit user ask)

No vector exists yet (not in v5: A1/A2/A3 + B1–B4). Route a note in `prompts/` (untracked) asking the
SANTA session to bless, against sigma-state 6.0.3 with **explicit tree version**:
- pre-V3 (version 0/1/2): `Plus(Int,Long)`, `Plus(Int,BigInt)`, `Lt(Int,Long)`, `EQ(Int 5,Long 5)`,
  `NEQ(...)` → JVM value + cost (the coercion path).
- V3+ (version 3): the same raw trees → JVM **rejects** (arith at eval; comparison/equality at
  deserialize) — these double as the Mechanism #2 follow-up vectors.
Also route the divergence to sigma-rust (`santa/prompts/ergots-v5-divergences.md` pattern): the canonical
fix is the deserializer `applyUpcast` (version-gated) + the `check2 SameType` strictness; sigma-rust is
currently stricter-than-JVM on coercion and looser-than-JVM on the SameType reject.

## Risks / reachability

Adversarial **and** pre-V3 only. No honest/mainnet path: the compiler emits an explicit `Upcast` node
(which ergots already evaluates), the walker validated genesis→~1.52M clean, and new honest trees are
V3 where the JVM also keeps raw. This is consensus-hardening against a hand-crafted version-0/1/2 tree,
not a live bug. The fix must **not** over-reach: coercion is gated `treeVersion < 3` so ergots never
*accepts* a V3+ mismatch the JVM *rejects*.
