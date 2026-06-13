# ErgoScript v6 (ErgoTree V3) — eval + cost umbrella design

**Date:** 2026-06-02
**Status:** ✅ **COMPLETE (2026-06-13)** — all phases done. P0–P6 + P7a shipped as dedicated phases; **P7b closed** (its nominal items were already landed in the 2h-era port — framing collapsed; the real gap it surfaced, AvlTree Tier-2 cost, became F4); **P8 delivered as the F1–F5 conformance run** (SANTA JVM-blessed vectors in `test/conformance/`, eval tier value+cost+reject 100% green, dasher = 21 roadmap-only). Pending v6-delivery PR to `master`. (Was: "approved shape (brainstorm); per-phase specs pending".)
**Branch:** `ergoscript-v6`
**Scope owner:** `@ergots/ergoscript`

This is the **umbrella** for bringing ergots' evaluator + cost model to the v6
(ErgoTree version 3) language surface. It fixes the *shape* and *end goal*; each
phase below gets its own focused spec → plan → TDD cycle, and **every phase calls
back to update this document** (the Phase ledger) as reality diverges — scope
adjustments, new findings, status. This doc is the source of truth for "what v6
support means and where we are."

## Scope and boundary

- **In:** v6 *language* semantics — **evaluation + JIT cost** — for ErgoTree-V3
  trees, per the canonical `LanguageSpecificationV6` (below). Each phase carries a
  **thin wire slice**: just enough parse/serialize to make what it evaluates
  *parseable* (a new `SType`, a new opcode/predef). We do **not** redo the full
  v5-style wire mutation/roundtrip hardening unless a phase's spec calls for it.
- **Out (for now):**
  - The sigma-protocol verifier's v6 internals beyond the `allZK`/`anyZK`
    reducers (P7). Deeper verifier changes, if any, are a later effort.
  - Node-level 6.0 consensus machinery (difficulty re-targeting, block-version /
    activation-height logic). That is node territory — the line we have always held.
  - Full validation comes **later** (P8, "eventually") — the conformance harness
    + vectors land after the eval/cost surface exists.

## End goal

ergots' `evaluate` / cost model implement the **complete v6 (ErgoTree V3) language
surface** enumerated in `LanguageSpecificationV6.scala`, version-gated correctly
(see Version model), with per-arm cost matching the JVM. "Done" = every
`LanguageSpecificationV6` feature is reachable in ergots with JVM-correct value +
cost, and (P8) validated against the JVM-blessed vectors with zero divergences —
the same bar v5 met.

## Version model

Two distinct version dimensions, both already partly plumbed in ergots
(`treeVersion` gates: `expUnsigned` 7:6, `checkPow` 104:16, `insertOrUpdate` 100:16,
BigInt→BigInt Upcast, SHeader-literal wire):

- **ErgoTree version ≥ 3** (`VersionContext.isV3OrLaterErgoTreeVersion`) — gates the
  bulk of v6: in sigma-state, `getMethods` returns `_v6Methods` under this flag.
  This is "v6" for almost everything.
- **`isV6Activated`** (protocol/block activation) — a *rarer* gate; notably adds the
  new **`SUnsignedBigInt`** type to the type universe. A handful of items key on
  this rather than the tree-version byte; each phase confirms which gate applies
  from the spec/source.

## The v6 surface (authoritative: `LanguageSpecificationV6.scala`)

`sc/shared/src/test/scala/sigma/LanguageSpecificationV6.scala` (sigma-state, 3166
lines) enumerates every v6 feature as a `property(...)` with `verifyCases`
(input → expected value+cost). Grouped:

- **Numeric** (Byte/Short/Int/Long/BigInt): `bitOr`/`bitAnd`/`bitXor`/`bitNot`,
  `shiftLeft`/`shiftRight`, `toBigEndianBytes`, `toBits`, `toBytes`; `Boolean.toByte`.
- **New type `SUnsignedBigInt`** + its full method set; `BigInt.toUnsigned` /
  `toUnsignedMod`.
- **Coll**: `find`, `reverse`, `startsWith`, `endsWith`, `get`, `getOrElse`(lazy
  default), bitwise, diff.
- **Option**: `getOrElse`(lazy default); `Global.some` / `Global.none`.
- **Global functions**: `serialize`, `deserializeTo`, `fromBigEndianBytes`,
  `encodeNbits`, `decodeNbits`, `powHit`.
- **Higher-order lambdas** — lambdas as first-class values (a language-capability
  change, not a method).
- **Per-type**: Box new properties, Header new methods, `Context.getVarFromInput`,
  `GroupElement.expUnsigned` (ergots already has this, V3-gated).
- **Sigma reducers**: `allZK` / `anyZK`.
- **Version-gated behavior *changes*** (not additions): `substConstants` v6 fix for
  ErgoTree version > 0; `AvlTree.insert` / `insertOrUpdate` v6 semantics.

## Four findings that determine the shape

1. **The type-var substitution engine is a hard prerequisite (P0).** `serialize[T]`,
   `deserializeTo[T]`, `fromBigEndianBytes[T]`, `some`/`none`, and the generic Coll
   methods all have type-var return types. Until the engine lands, they resolve to
   `SAny` — so it gates everything downstream.
2. **Higher-order lambdas are a language capability, not a handler.** They touch the
   eval engine + the type checker, so they are the deepest/riskiest phase and get
   scoped on their own (P6).
3. **"Eval + cost only" carries an irreducible thin wire slice.** `SUnsignedBigInt`
   is a new `SType`; the new globals are new opcodes/predefs. Each must be
   *parseable* to be evaluable — so wire is a per-phase supporting layer, not zero.
4. **Some v6 items are version-gated behavior *changes* to existing arms**
   (`substConstants`, `AvlTree.insert`). The ledger tracks "modify existing"
   alongside "add new."

## Phase ledger

Dependency-ordered. Each phase: **goal · key items · depends-on · status**. Status
is the living field — phases update it (and append findings / scope deltas) here.

### P0 — type-var / `exprTpe` substitution engine  ·  **status: DONE (2026-06-02)**
- **Goal:** make `resolveReturnTpe` substitute type vars from concrete call-site
  types, so generic-output methods resolve to concrete `SType` instead of `SAny`.
- **Items:** unify type-var-bearing `tDom` against `receiver`/`argTpes` (+
  `explicitTypeArgs`) → substitution map → substitute into `tRange`.
- **Start point:** A3 (`mir/method-signatures.ts`) already shipped the
  `MethodSignature` catalog, the `resolveReturnTpe(sig, receiver, argTpes,
  explicitTypeArgs)` hook (API already takes the substitution inputs), `STypeVar`,
  and `hasTypeVar`. The body was the stub (`tRange` verbatim if closed, else `SAny`).
- **Depends-on:** none. **Gates:** P3, P5 (and any generic-output method).
- **Done (2026-06-02):** `mir/type-unify.ts` (faithful port of JVM
  `unifyTypes`/`unifyTypeLists`/`applySubst`, `ast/package.scala`) + the
  `resolveReturnTpe` substitution path (closed-`tRange` early-return; else
  explicit-then-unify with a `hasTypeVar→SAny` safety net, mirroring JVM
  `getSpecializedMethodFor`). `SColl.patch` (12:19) registered as the
  proof-of-exercise (first type-var `tRange`). Value-only, full suite green
  (4071 tests), no cost moved. Spec:
  `2026-06-02-ergoscript-v6-p0-typevar-substitution-engine-design.md`.
  **Now unlocks P3/P5 generic-output methods** (pure descriptor-additions).

### P1 — Numeric v6 methods  ·  **status: DONE (2026-06-02)**
- **Goal:** `bitwiseInverse`/`bitwiseOr`/`bitwiseAnd`/`bitwiseXor`, `shiftLeft`/`shiftRight`,
  `toBytes`, `toBits` across Byte/Short/Int/Long/BigInt; `Boolean.toByte` (JVM
  `SNumericTypeMethods.v6Methods` ids 6–13 + `SBooleanMethods.toByte`). NB `toBytes` IS big-endian
  (its eval is `toBigEndianBytes` internally); the spec's `toBigEndianBytes` is a
  `LanguageSpecificationV6` `newFeature` — resolve the exact mapping in the P1 spec.
  `Global.fromBigEndianBytes` is a **separate P5** global, not this.
- **Items:** MethodCall handlers (distinct from the existing `BinOp` Bit *operators*) + per-method
  cost (**P1 HAS cost** — `ToBytes`/`ToBits`/`BitwiseOp` CostKinds). **Depends-on:** not blocking, BUT
  `bitwise*`/`shift*` return `tNum` (the receiver's numeric type = a type-var `tRange`) → they USE the
  **P0** engine for precise return typing (`toBytes`→`Coll[Byte]` / `toBits`→`Coll[Boolean]` are
  closed). Refines the original "no P0 needed".
- **Done (2026-06-02):** 40 MethodCall handlers (typeIds 2–6, methodIds 6–13) across Byte/Short/Int/Long/BigInt, all `minVersion: 3` gated. 3 new `EvalError` codes (`'numeric-shift-out-of-range'`, `'bigint-result-out-of-range'`, `'numeric-method-bad-operand'`). BigInt is signed-256-bounded (`checkBigInt256`). P0 type-var engine used for `bitwise*`/`shift*` return-type resolution. Final-review fix (C1): operand-kind guards on all 5 factory functions, preventing consensus over-accept on wrong-kind arguments. Full suite: 3527 green. Spec: `2026-06-02-ergoscript-v6-p1-numeric-methods-design.md`.

### P2 — `SUnsignedBigInt` (new type)  ·  status: COMPLETE (2026-06-03) — P2a · P2b · P2c · P2d-1 · P2d-2 all DONE

**Corrected P2 decomposition (2026-06-03, after reading the JVM operation tables):**
The original "P2b methods+casts / P2c modular+conversions" split silently omitted the
plain-arithmetic and ordering BinOp surface on UBI (`trees.scala:868` registers
`SUnsignedBigInt → OperationImpl(UnsignedBigIntIsExactIntegral, UnsignedBigIntIsExactOrdering, …)`);
P2a stubs all of it (two sites in `relation.ts`) to throw `'unsigned-bigint-op-unsupported'`.
The corrected decomposition closes the two lowest-risk groups first:

- **P2b** = UBI numeric/bitwise methods (typeId 9, methodIds 6–13) + full UBI cast matrix (`Upcast`/`Downcast` with UBI source or target)  ·  **status: in progress (this branch)**
- **P2c** = UBI arithmetic + ordering BinOps (`+`, `−`, `×`, `/`, `%`, `<`, `≤`, `>`, `≥`) + equality (`==`/`!=`) + trivial `toUnsigned`/`toSigned` bridges  ·  **DONE (2026-06-03)**
- **P2d-1** = the 5 mechanical modular methods: `mod`, `plusMod`, `subtractMod`, `multiplyMod` (UBI 9:18/15/16/17) + `BigInt.toUnsignedMod` (6:15)  ·  **DONE (2026-06-03)**
- **P2d-2** = `UnsignedBigInt.modInverse` (9:14, `FixedCost(150)`; hand-written extended-Euclidean), carved out for focused scrutiny  ·  **DONE (2026-06-03)**

**Goal:** the new numeric type end-to-end: thin wire (`SType` code + parse/serialize),
  eval, cost, its full method set, and `BigInt.toUnsigned` / `toUnsignedMod`.
  **Depends-on:** none (mostly independent); largest single phase.

- **P2a DONE (2026-06-03):** `SUnsignedBigInt` type code 9 added to `SType`/`SValue` unions.
  Option-B gate: permissive wire parse + `validateV6Types` pre-eval pass over `constantTypes[]`
  and the (post-substitution) body, keyed on authoritative `ctx.treeVersion`. Distinct
  unsigned-magnitude codec (`encodeUnsignedBigIntBE` / `decodeUnsignedBigIntBE`): `0 → []`,
  no sign pad, length-0 decodes to `0n`, 32-byte cap. 2 new `EvalError` codes:
  `'v6-type-in-pre-v3-tree'` (validateV6Types reject; zero cost), `'unsigned-bigint-op-unsupported'`
  (defensive for deferred UBI operations). SFunc-112 v5 over-accept closed in the same pass
  (the `annotationsOf()` enumerator deliberately excludes `ValUse.tpe`, which is computed not
  serialized — checking it would false-reject valid v5 lambdas). Full suite: 3580 green. Spec:
  `2026-06-03-ergoscript-v6-p2a-sunsignedbigint-type-core-design.md`.

- **P2b DONE (2026-06-03):** 8 UBI method handlers (typeId 9, methodIds 6–13; same `FixedCost(5)`/`minVersion:3` pattern as the P1 signed-numeric group) + the full UBI cast matrix for `Upcast`/`Downcast`. Implemented across 5 commits (Tasks 1–6 on `ergoscript-v6`). **Key decisions and findings:**
  - **Load-bearing adversarial-review finding:** the original "no cast targets UBI / Upcast untouched" claim was false for hand-crafted cast opcodes — a real adversarial fork, closed by implementing all 6 `(source, target)` cells of the matrix (see cast matrix in `facts/ergoscript-eval.md`). Faithfulness drives the gate: the JVM has no UBI-source Upcast path (use `toSigned`), no BigInt↔UBI cast path (use `toUnsigned`/`toSigned`), and all cells throw `'unsigned-bigint-op-unsupported'` there.
  - **Critical 1 (non-regression):** UBI handling stays local to the cast arms and the `ubiDesc` NumV6 descriptor — the shared `isNumeric` predicate is NOT widened. Widening would flip `Negation(ubi)`, `Arith(ubi)`, and ordering-BinOp(ubi) from reject→accept — a fork. Test pins confirm no regression.
  - **`ubiDesc`:** the 6th `NumV6` descriptor in `_numeric-v6.ts`, with `kind: 'UnsignedBigInt'`, `typeId: 9`, unsigned-magnitude `toBE` (`encodeUnsignedBigIntBE`), 256-bit-fixed-flip `inv` (`UBI_MAX − x`), and shiftLeft magnitude guard (result `≥ 2²⁵⁶` → `'unsigned-bigint-out-of-range'`).
  - **`mir/method-signatures.ts`:** `NUMERIC_STYPE` gained `9: { tag: 'SUnsignedBigInt' }` (Important 1). Without it `exprTpe(ubi.bitwiseInverse)` → `SAny`; with it → `SUnsignedBigInt`.
  - **`eval/coll-map.ts` `inferSType`:** `case 'UnsignedBigInt': return { tag: 'SUnsignedBigInt' }` arm added (tsc does NOT force this; the `default:` swallowed it).
  - **Version gating for casts:** no per-arm V3 guard in `downcastUBI`/`upcastUBI` — `validateV6Types` (P2a) covers it via `Upcast.tpe`/`Downcast.tpe` type-annotation walks.
  - **1 new `EvalError` code:** `'unsigned-bigint-out-of-range'` (72 total). `'unsigned-bigint-op-unsupported'` (P2a) reused for UBI↔BigInt casts + UBI-source Upcast.
  - Full suite: 3602 green (node + jsdom). `tsc --noEmit` clean. Spec: `2026-06-03-ergoscript-v6-p2b-sunsignedbigint-methods-casts-design.md`.

- **P2c DONE (2026-06-03):** UBI arithmetic (`+ − × / % min max`), ordering (`< ≤ > ≥`), and equality
  (`== !=`) BinOps + the `toUnsigned`/`toSigned` bridge methods. Built via the full skill chain (brainstorm →
  spec → 2 adversarial spec reviews REVISE→SHIP → writing-plans → subagent-driven TDD with per-task
  spec+quality review). 6 commits on `ergoscript-v6` (facts · arith · ordering+C1 · equality · bridges ·
  non-regression). **Key decisions/findings:**
  - **Load-bearing cost correction:** UBI arith/ordering takes the **non-BigInt cost tier** — the JVM cost
    match is `case SBigInt => X; case _ => Y` and `SUnsignedBigInt` is a distinct case object ⇒ `case _`. So
    `+ − × / %` = **15** (not 20/25), `min`/`max` = **5** (not 10); ordering = 20; scalar `==`/`!=` = 5
    (`EQ_BigInt`). The inherited "UBI = BigInt tier" assumption (and an exploration subagent's first table)
    was WRONG — caught by reading the charge site (`trees.scala:735` → `costFunc(SUnsignedBigInt)`).
  - **C1 fork (caught by adversarial spec review):** `validateBinOpTypes.isNumericTpe` excluded
    `SUnsignedBigInt`, so a valid V3 `LT(ubi,ubi)` would be rejected pre-eval (`'bin-op-not-numeric'`) — a
    reject-where-JVM-accepts fork (`SUnsignedBigInt extends SNumericType`). Closed by adding UBI to
    `isNumericTpe`; verified safe (`LT(Int,ubi)` still rejects via SameType; `Eq` unaffected).
  - **`isNumeric` stays UNWIDENED (Critical 1):** UBI is routed by LOCAL branches in `arith.ts`/`relation.ts`
    (before the `isNumeric` guard) + the new helper `eval/bin-op/_ubi-binop.ts` (`evalUBIArith` with the
    `[0,2²⁵⁶)` bound + `compareUBI`). `Negation(ubi)` stays permanently rejecting (non-regression test pins it).
  - **Equality mirrors BigInt exactly** (scalar `EQ_BIGINT_COST` + `Coll[UBI]` COA bulk via `EQ_COA_BigInt` —
    the JVM `descriptors` maps both `BigIntRType` and `UnsignedBigIntRType` to the same pair). Closes the two
    P2a `'unsigned-bigint-op-unsupported'` stubs in `relation.ts` (now survives only in `_cast-ubi.ts` ×3 +
    the eval-context doc-catalog).
  - **2 bridge methods** (registry 102 → 104): `BigInt.toUnsigned` (6:14, `FixedCost 5`, rejects negative) +
    `UnsignedBigInt.toSigned` (9:19, `FixedCost 10`, rejects `≥ 2²⁵⁵`), both `minVersion: 3`, closed-`tRange`
    `method-signatures.ts` entries. **0 new `EvalError` codes** (all reused).
  - **Process find:** the plan's test cost-totals omitted the per-`Const` eval cost (5 each) + the MethodCall
    dispatcher envelope (4); the Task-2 implementer caught it and the plan was corrected for Tasks 3–5.
  - Full suite: **3624 green (node + jsdom)**, `tsc --noEmit` clean. Spec:
    `2026-06-03-ergoscript-v6-p2c-sunsignedbigint-binops-bridges-design.md`.

- **P2d-1 DONE (2026-06-03):** the 5 mechanical UBI modular methods — `mod` (9:18, cost 20),
  `plusMod` (9:15, 30), `subtractMod` (9:16, 30), `multiplyMod` (9:17, 40) + `BigInt.toUnsignedMod`
  (6:15, 15). All `minVersion: 3`, all `FixedCost`. Built via the full skill chain (brainstorm → spec →
  writing-plans → subagent-driven TDD with per-task spec/quality review). **Key points:**
  - One Euclidean primitive `umod(x,m) = ((x % m) + m) % m` (`eval/_ubi-modular.ts`) — JS `%` is a
    remainder, Java `BigInteger.mod` is Euclidean; load-bearing for `subtractMod` underflow and
    `toUnsignedMod`'s signed (possibly-negative) receiver. Result ∈ [0,m) ⊂ [0,2²⁵⁶) ⇒ no range path.
  - **0 new `EvalError` codes** (registry 104 → 109): `m == 0` reuses `'arith-divide-by-zero'`; wrong-kind
    operand reuses `'numeric-method-bad-operand'`. 5 closed-`tRange` `method-signatures.ts` entries.
  - Oracle = JVM `LanguageSpecificationV6.scala verifyCases` (incl. the `subtractMod(0,24,10)=6` underflow
    and `toUnsignedMod(50,0)→Failure` cases). Full suite: **3658 green (node + jsdom)**, `tsc` clean. Spec:
    `2026-06-03-ergoscript-v6-p2d1-ubi-modular-methods-design.md`.
- **P2d-2 DONE (2026-06-03):** `UnsignedBigInt.modInverse` (9:14, `FixedCost(150)`, `minVersion: 3`) — the
  95%-crypto-confidence-bar piece, carved out for focused scrutiny. Built via the full skill chain
  (brainstorm → spec → writing-plans → subagent-driven TDD with spec + opus code-quality review). **Key points:**
  - Hand-rolled classic iterative **extended Euclidean** `umodInverse(a, m)` (`eval/_ubi-modular.ts`, beside
    `umod`) — JS `bigint` has no native modInverse. Reuses `umod` twice (reduce base into [0,m); normalize the
    Bézout coefficient). Result ∈ [0,m) ⊂ [0,2²⁵⁶) ⇒ no range path. `m == 1 → 0` falls out (no special case).
  - **1 new `EvalError` code** (registry 109 → 110; codes 72 → 73): `'unsigned-bigint-not-invertible'`
    (`gcd(a,m) ≠ 1`). `m == 0` reuses `'arith-divide-by-zero'` (inherited via `umod`). 1 closed-`tRange`
    `(9,14)→SUnsignedBigInt` signature entry.
  - Oracle = JVM `LanguageSpecificationV6.scala:2874-2880` (`modInverse(12,5)=3`) +
    `BasicOpsSpecification.scala:590-628` (`modInverse(3,7)=5`; `m==0` throws). Both blessed vectors
    hand-traced; the opus code-quality review ran an exhaustive brute-force cross-check (0 defects, ship).
    Full suite: **3669 green (node + jsdom)**, `tsc` clean. Spec:
    `2026-06-03-ergoscript-v6-p2d2-ubi-modinverse-design.md`.
- **P2 (`SUnsignedBigInt`) COMPLETE (2026-06-03)** — full v6 method surface landed (P2a type core · P2b
  methods+casts · P2c BinOps+bridges · P2d-1 modular · P2d-2 modInverse). Next: P3 (Coll v6).

### P3 — Coll v6 methods  ·  status: DONE (2026-06-03)
- **Goal (verified surface):** the v6 `SCollection` additions are exactly FOUR
  methods (`methods.scala:1211-1216`, gated `isV3OrLaterErgoTreeVersion` `:1221-1227`):
  `reverse` (30, `Coll[IV]→Coll[IV]`), `startsWith` (31) / `endsWith` (32)
  (`(Coll[IV],Coll[IV])→Boolean`), `get` (33, `(Coll[IV],Int)→Option[IV]`). **Depends-on:** P0.
- **Framing correction (the umbrella's earlier 8-item list was wrong):** `find` /
  `bitwise` / `diff` are NOT in v6.0 — they are `// TODO v6.0` placeholders
  (`LanguageSpecificationV6.scala:1316/1332/1351`, GitHub #479/#418). `Coll.getOrElse`
  is a v5 method already covered via the `ByIndex` lowering (`methods.scala:826-830` →
  `eval/coll-by-index.ts`, incl. the V3+ lazy default); the lazy-default `getOrElse`
  belongs to **Option (P4)**, not Coll.
- **Done (2026-06-03):** 4 handlers in `eval/scoll-v6.ts` (`minVersion:3`) + 4
  `method-signatures.ts` entries (`reverse`/`get` generic via the P0 engine;
  `startsWith`/`endsWith` closed `Boolean`) + a cost-free `sValueStructuralEq`
  (`compareSValues(a,b,ctx?)` factored from `sValueEquals`) so `startsWith`/`endsWith`
  charge only the JVM `Zip_CostKind` envelope (element comparison uncosted, matching
  the JVM's uncosted `Coll.startsWith`). Costs JVM-verified: `reverse`=`Append.costKind`
  PerItem(20,2,100), `startsWith`/`endsWith`=`Zip_CostKind` PerItem(10,1,10) on receiver
  length, `get`=`ByIndex.costKind` Fixed(30). **0 new EvalError codes, 0 wire changes**
  (generic MethodCall path, `explicitTypeArgs` empty). Built via the full skill chain
  (brainstorm → spec → adversarial reviewer → writing-plans → subagent-driven TDD with
  per-task spec + opus quality review). Gate: tsc clean (4 pkgs), **3701 green (node +
  jsdom)**. Spec: `2026-06-03-ergoscript-v6-p3-coll-methods-design.md`. **Next: P4
  (Option v6 + `Global.some/none`).**

### P4 — Option v6 + `Global.some/none`  ·  status: DONE (2026-06-04)
- **Framing correction (verified vs JVM):** the umbrella's earlier "`Option.getOrElse`(lazy
  default); some/none" was 2/3 already-done or out-of-scope. `SOptionMethods.getMethods()`
  (`methods.scala:792-799`) is identical v5/v6, and `Option.getOrElse`'s lazy default (its
  only v6 aspect) was already shipped as the `OptionGetOrElse` arm (`eval/option-get-or-else.ts`,
  V3-gated). `Option.fold` is a non-shipping placeholder (absent from `getMethods()`, like P3's
  find/bitwise/diff); `SOption.filter` is an unrelated v5 gap. So P4 = just `Global.some`/`none`
  + an adversarial-completeness reject.
- **Landed:** `Global.some` (106:9) / `Global.none` (106:10) — 2 SGlobal method handlers,
  `FixedCost(JitCost(5))`, `minVersion: 3`, generic `Option[T]` via the P0 engine (`none` is the
  first method resolved purely from an explicit type arg). Both serialize `T` on the wire; `some`
  rides the MethodCall opcode, `none` the **PropertyCall** opcode (JVM `MethodCall.companion =
  if (args.isEmpty) PropertyCall else MethodCall`, `values.scala:1322`). First **PropertyCall
  explicit-type-arg wire slice** (shared registry `wire/mir/explicit-type-args.ts` +
  `PropertyCall.explicitTypeArgs` field + parse/serialize mirroring `PropertyCallSerializer.scala:20-49`).
- **Adversarial reject (in scope):** `validateMethodCallArity` — a pre-eval, zero-cost, whole-tree
  pass rejecting V3+ `MethodCall`-opcode nodes with empty args (JVM `MethodCallSerializer.scala:53-55`
  `assert(args.nonEmpty)`), wired into both `dispatchTreeBody` sites. 1 new code `'method-call-empty-args'`.
  Closes the new `none` AND the pre-existing `groupGenerator` (106:1) over-accept. The pass surfaced
  that the `checkPow` (104:16) fixture was sigma-rust-shaped (0xdc MethodCall — a form the JVM rejects
  at V3); regenerated to the JVM-faithful 0xdb PropertyCall encoding (eval value `true` + cost 759
  unchanged; now hand-blessed, diverges from `fixture-gen`). Corpus audit: checkPow was the only such
  fixture. Handler arity guards (some=1 / none=0 args) close the live-branch arity divergence; the
  **dead-branch arity check (all methods, deserialize-time whole-tree) is the deferred broad arg-count
  faithfulness sweep** (user-scoped separate, 2026-06-04).
- **Built via the full skill chain** (brainstorm → spec → writing-plans → subagent-driven TDD with
  per-task review + final whole-diff code review = SHIP, 0 Critical/Important). **Gate: tsc clean
  (4 pkgs), 3721 green (node + jsdom).** Registry 115→117, codes 73→74, 0 new wire opcodes. Spec:
  `2026-06-04-ergoscript-v6-p4-option-global-some-none-design.md`. 6 commits `0508651`(spec)→`1f8e5af`
  (facts)→`8934dcfa`(wire)→`21fa31df`(sigs)→`4f0b08b`(handlers)→`a772527`(reject+checkPow regen).
  **Next: P5 (Global functions).**

### P5 — Global functions  ·  status: COMPLETE (P5a + P5b-1 + P5b-2 + P5c DONE)
- **Goal:** `serialize`, `deserializeTo`, `fromBigEndianBytes`, `encodeNbits`,
  `decodeNbits`, `powHit`. **Depends-on:** P0 (generics) + a thin wire slice.
- **Decomposition (2026-06-04, after verifying the surface vs JVM):** all six are real,
  registered SGlobal methods (type id 106, methodIds 3–8), gated `isV3OrLaterErgoTreeVersion`,
  all `MethodCall` (0xdc) — **zero new wire code** (the explicit-type-arg slice exists from
  P4; `serialize` carries none; `106:4`/`106:5` already in the wire registry). Split by
  machinery:
  - **P5a** — `serialize` (106:3) + `deserializeTo` (106:4): the value/data codec pair (reuse
    `serializeSValue`/`parseSValue`). serialize = DynamicCost (analytical cost walk;
    **runtime-value** type derivation, NOT `exprTpe` — closes the SAny over-reject fork);
    deserializeTo = PerItemCost(100,32,32) on input length + a `MaxTreeDepth`(110) bound.
    Full data-type domain incl. Box/Header/AvlTree (Box registers cost = `putType` + data,
    no envelope). **status: DONE (2026-06-04)** —
    `2026-06-04-ergoscript-v6-p5a-serialize-deserializeto-design.md`. Landed serialize (106:3) +
    deserializeTo (106:4) — registry 119, codes 76, 3822 green (node + jsdom). The `MaxTreeDepth`
    gap was closed STRUCTURALLY (T2.5: one shared reader-level counter on `@ergots/scorex`
    `ByteReader`, bumped at parseExpr/parseSValue/parseSigmaBoolean + the box-register Expr —
    all parsers share one counter). Deferred residual: the V1-Header d=0 byte-shape
    sigma-rust-vs-JVM fork in scorex (→ v6 scorex work).
  - **P5b** — split (2026-06-04) into two focused batches, mirroring the P2d-1/P2d-2 cut
    (mechanical vs crypto-confidence):
    - **P5b-1** — `fromBigEndianBytes` (106:5): generic decoder, `FixedCost(10)`, inverse of
      P1 `toBytes`, rides deserializeTo's explicit-type-arg wire (zero new wire). **status: DONE (2026-06-04)** — `docs/specs/2026-06-04-ergoscript-v6-p5b1-from-bigendian-bytes-design.md`.
    - **P5b-2** — `encodeNbits` (106:6) + `decodeNbits` (106:7): the Bitcoin-compact pair;
      `decodeNbits` reuses `@ergots/scorex` `decodeCompactBits`, `encodeNbits` ports
      `NBitsUtils.encodeCompactBits` (ergoscript-local `eval/_nbits.ts`). **status: DONE
      (2026-06-04)** — `docs/specs/2026-06-04-ergoscript-v6-p5b2-encode-decode-nbits-design.md`.
      Landed `encodeNbits` (106:6) + `decodeNbits` (106:7) — registry 122, codes 79.
  - **P5c** — `powHit` (106:8): Autolykos v2 hit → `SUnsignedBigInt`; carved for the 95%
    crypto-confidence bar. **status: DONE (2026-06-05)** —
    `docs/specs/2026-06-05-ergoscript-v6-p5c-powhit-design.md` (Architecture **C″**).
    `FixedCost(500 + (k+1)·(⌊L/128⌋+1)·7)` charged before the require guards (cost-then-throw;
    k≥2/k≤32/N≥16); returns `SUnsignedBigInt`; `method-signatures` `(106,8)` closed-tRange.
    **Single-source unification:** the Autolykos-2 hit lives once in `@ergots/scorex`
    (`autolykosHitForMessage`/`…WithChecks`); `verifyAutolykosV2` AND **nipopow's**
    `compare.ts powHit` both route through it (the scorex hit-trio → internal; the nipopow
    refactor was user-authorized). Registry 123, codes 80 (`'pow-hit-invalid-params'`). Gate:
    build clean, **4455 green** (scorex 181 / avltree 156 / nipopow 247 / ergoscript 3871), tsc
    clean. Follow-up: a JVM-blessed k≠32 value vector (SANTA `ergots-powhit-vectors.md`).
    **→ P5 COMPLETE; next P6 (HOF lambdas).**

### P6 — higher-order lambdas  ·  status: done
- **Goal:** lambdas as first-class values. Deepest phase — touches eval engine +
  type checker. Its spec scopes feasibility/risk before committing.
  **Depends-on:** TBD (assess in its spec).
- P6 reframed on entry: the eval engine already handled first-class functions *without closures* (the happy path ran). The real work comprised four deliverables: (1) `FunDef` opcode `0xd7` parse+serialize+eval as a `ValDef` carrying `tpeArgs`; (2) `exprTpe(Apply)` SAny relaxation (was over-rejecting unresolved func types); (3) **lexical-scoping (closures)** — `Lambda` now captures its definition-site env (`Closure.capturedEnv`), and `Apply` + all 7 HOF arms evaluate the body in `capturedEnv` extended with args (reverses the prior dynamic scoping; currying `add(3)(1)` → 4); (4) **type-var-apply reject** — applying a lambda whose arg type is an unresolved `STypeVar` throws `EvalError('apply-unresolved-type-var')`, mirroring the JVM `stypeToRType(STypeVar)` failure. All four deliverables validated against JVM-blessed SANTA conformance vectors (`higher_order_lambdas`, `FunDef` concrete, currying, `Coll[SFunc]`, type-var-body accept+reject, plus powHit k≠32). Registry 123 (unchanged), EvalError codes 81 (+1: `'apply-unresolved-type-var'`). Full suite **3891 green** (node + jsdom), tsc clean. Remaining v6: P7, P8.

### P7 — per-type additions + behavior changes + sigma reducers  ·  decomposed 2026-06-05

P7 was decomposed (user-agreed 2026-06-05) into P7a, P7b, and a dropped bucket:

#### P7a ✅ DONE 2026-06-06 — three per-type v6 method handlers

Spec: `docs/specs/2026-06-05-ergoscript-v6-p7a-per-type-methods-design.md`.

- **99:7 → 99:19 wire fix** — JVM `getRegV5` (id 7) carries no type-arg bytes; id 19 (`getRegMethodV6`) carries `['T']`. Prior sigma-rust-shaped `99:7 → ['T']` entry removed; `99:19 → ['T']` added. Consensus-load-bearing: the old entry mis-consumed one SType byte.
- **`Box.getReg[T]` (99:19)** — `FixedCost(50)`, Pattern A. Index `[0,9]`; absent → `None`; mismatch → `'register-type-mismatch'` throw; `minVersion: 3`.
- **`Context.getVarFromInput[T]` (101:12)** — `FixedCost(10)`, Pattern A. Total (never throws): OOB idx, missing var, type-mismatch → `None`; `minVersion: 3`. Added `inputExtensions?: ContextExtension[]` to `EvalOpts`/`makeContext`.
- **`GroupElement.expUnsigned` (7:6)** — `FixedCost(900)`, Pattern A. Routes through shared `expPoint` helper (extracted from the existing v5 Exponentiate arm). Scalar edges `g^0=g^order=identity`, `g^1=g` pinned; `minVersion: 3`.
- **Registry:** 122 → 125 (a P3-era one-high recount corrected at P7a close-out; see facts). **EvalError codes:** 81 (0 new). Suite: 3935 (was 3891 at P6 close).
- **Review-caught consensus fixes:** (a) `expUnsigned` arity-1-exact guard (JVM `IllegalArgumentException` on wrong arity); (b) `getVarFromInput` var-id byte-identity `& 0xff` — JS bitwise ops sign-extend; the mask aligns with JVM `Byte` → unsigned-key semantics, confirmed to be Critical.

**Documented inherited residuals (pre-existing class, not expanded in P7a):**
1. **v6-method-in-dead-branch-of-pre-v3-tree** — JVM rejects at deserialize (`SMethod.fromIds` is version-aware); ergots' `minVersion` gate fires at eval → dead branches escape. Candidate future `validateMethodVersions` pre-eval pass (sibling of `validateV6Types`/`validateMethodCallArity`), routed separately.
2. **Registry-wide extra-args arity sweep** — pre-existing class; P7a's three handlers use arity-exact guards, but the sweep over all ~125 registry entries is a separate pass.
3. **Self-GetVar key-domain sibling gap** — JVM crashes at context construction for `extension` keys ≥ 0x80; ergots `GetVar` returns `Some`/`None` for those keys (opposite direction from the `& 0xff` fix to `getVarFromInput`). Pre-existing; needs its own pass.

#### P7b — ✅ CLOSED (framing collapsed on contact; absorbed by the F-series)

Nominal items: version-gated behavior *changes* — `substConstants` v6 fix for tree version > 0 (reconcile against the deferred A2-b serializer-level item) + `AvlTree.insert`/`insertOrUpdate` v6 semantics delta.

**Outcome (verified during the F-series conformance run, 2026-06-07):** both nominal items were **already landed** in the phase-2h-era port (`5e56367`) — `AvlTree.insert`/`insertOrUpdate` carry their treeVersion≥3 v6 gates (savltree.ts), and `substConstants` carries its treeVersion-aware no-op path (subst-constants.ts, JVM-parity §A2). When the spec was opened the framing collapsed: nothing to build. What the verification surfaced *instead* was the AvlTree Tier-2 **cost** surface charging zero vs the JVM model — that became **F4** (AvlTree Tier-2 cost faithfulness, ✅ DONE 2026-06-07, commits `0665f84..cbaad45`). substConstants v3+hasSize was confirmed SETTLED-covered on both readings (conformance manifest, 2026-06-06). So P7b closes with no dedicated phase; the conformance run is its closure record (ledger §F5).

#### Sigma reducers (`allZK`/`anyZK`) — DROPPED

`allZK`/`anyZK` are source-language `PredefinedFunc` sugar (`SigmaPredef.scala:79-92`) with **no opcode and no serializer**. Any on-chain form is `SigmaAnd`/`SigmaOr`, already shipped in 2g-combinators. Nothing to build.

### P8 — validation  ·  ✅ DONE (this IS the F1–F5 conformance run)
- **Goal:** wire `LanguageSpecificationV6` `verifyCases` + SANTA's JVM-blessed v6
  vectors into the conformance harness (`test/conformance/`). **Depends-on:** the
  eval/cost surface (P1–P7) existing to validate.
- **Outcome:** delivered as the **F1–F5 conformance run** (ledger
  `docs/specs/2026-06-06-ergoscript-conformance-run-design.md`) — SANTA's JVM-blessed
  v5+v6 vectors are vendored into `test/conformance/` (2,346 entries at the batch-5
  tip; auto-registered via readdir), graded both ways (our local probe + SANTA's
  5-way board). Eval tier is value+cost+reject **100% green** across all four slices
  (v5/v6 × spec/authored); dasher = 21, all roadmap (transaction-tier), zero eval
  divergences. P8's "wire the verifyCases vectors" became "vendor the SANTA corpus
  + run the conformance harness" — same goal, JVM-canonical, achieved.

## Validation strategy (P8)

The **JVM is the sole canonical source — no sigma-rust dependency.** v6 vectors are
JVM-blessed end to end: `LanguageSpecificationV6.scala`'s `verifyCases` (input →
blessed value+cost, carrying `tree_bytes_hex`) are a ready-made vector source, and
SANTA's v6 conformance vectors (JVM `sigma-state` 6.0.3) are the oracle. **No Rust
`fixture-gen` for v6** — the byte-for-byte reference is the JVM, not sigma-rust. (A
deliberate shift from the README's "validated against sigma-rust" framing; reconcile
that doc when v6 lands.) sigma-rust `eni` / `ergo-node-integration` stays available
as an **optional, non-canonical cross-check** — handy as a second, TS-adjacent
reading when a JVM arm is unclear — but never a gate, a cost source, or a behavior
source (it can diverge; cf. `reference_sigma_rust_branch_canonical`).

## Reference sources

- **Canonical (JVM) — the sole required source:** `~/projects/sigmastate-interpreter/`
  — `LanguageSpecificationV6.scala` (the spec + `verifyCases` vector source),
  `data/.../sigma/ast/methods.scala` (`v6Methods`, `CostKind`s, version gates),
  `data/.../sigma/ast/SigmaPredef.scala` (predef globals: `serialize`/`deserialize`/
  `fromBigEndianBytes`).
- **Optional cross-check (Rust), non-canonical:** sigma-rust `eni` /
  `ergo-node-integration` — a convenience second reading when a JVM arm is unclear,
  nothing more. Never a gate or a cost/behavior source (it can diverge). When used,
  read `ergo-node-integration`, not the stale vendored `integration/ergots`
  (`reference_sigma_rust_branch_canonical`).
- **Existing ergots scaffolding:** `mir/method-signatures.ts` (P0 start), the
  `treeVersion` gates already in eval/wire.

## Living-umbrella protocol

Each phase spec opens by referencing this doc. On a phase's completion **or** on any
discovery that changes the shape (a new sub-divergence, a scope split, a dependency
that wasn't obvious), update this doc: the phase's **status**, plus a short note
under its ledger entry. The umbrella is expected to drift from this first draft —
that drift, recorded here, is the point.
