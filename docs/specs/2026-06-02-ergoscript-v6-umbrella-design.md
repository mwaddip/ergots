# ErgoScript v6 (ErgoTree V3) — eval + cost umbrella design

**Date:** 2026-06-02
**Status:** approved shape (brainstorm); per-phase specs pending
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

### P0 — type-var / `exprTpe` substitution engine  ·  **status: partly started**
- **Goal:** make `resolveReturnTpe` substitute type vars from concrete call-site
  types, so generic-output methods resolve to concrete `SType` instead of `SAny`.
- **Items:** unify type-var-bearing `tDom` against `receiver`/`argTpes` (+
  `explicitTypeArgs`) → substitution map → substitute into `tRange`.
- **Start point:** A3 (`mir/method-signatures.ts`) already ships the
  `MethodSignature` catalog, the `resolveReturnTpe(sig, receiver, argTpes,
  explicitTypeArgs)` hook (API already takes the substitution inputs), `STypeVar`,
  and `hasTypeVar`. The body is the stub (`tRange` verbatim if closed, else `SAny`).
  P0 fills in unify + substitute. **Value-only — zero cost change.**
- **Depends-on:** none. **Gates:** P3, P5 (and any generic-output method).

### P1 — Numeric v6 methods  ·  status: not started
- **Goal:** bitwise (`bitOr/bitAnd/bitXor/bitNot`), `shiftLeft/shiftRight`,
  `toBigEndianBytes`, `toBits`, `toBytes` across Byte/Short/Int/Long/BigInt;
  `Boolean.toByte`. **Items:** eval arms + cost. **Depends-on:** none (self-contained
  warm-up; concrete return types, no P0 needed).

### P2 — `SUnsignedBigInt` (new type)  ·  status: not started
- **Goal:** the new numeric type end-to-end: thin wire (`SType` code + parse/serialize),
  eval, cost, its method set, and `BigInt.toUnsigned` / `toUnsignedMod`.
  **Depends-on:** none (mostly independent); largest single phase.

### P3 — Coll v6 methods  ·  status: not started
- **Goal:** `find`, `reverse`, `startsWith`, `endsWith`, `get`, `getOrElse`(lazy),
  bitwise, diff. Several already have eval fns in sigma-rust eni's `scoll.rs`.
  **Depends-on:** P0 (generic element types).

### P4 — Option v6 + `Global.some/none`  ·  status: not started
- **Goal:** `Option.getOrElse`(lazy default); `Global.some` / `Global.none`.
  **Depends-on:** P0 (`some`/`none` are generic).

### P5 — Global functions  ·  status: not started
- **Goal:** `serialize`, `deserializeTo`, `fromBigEndianBytes`, `encodeNbits`,
  `decodeNbits`, `powHit`. `deserializeTo` extends our existing Deserialize family.
  **Depends-on:** P0 (generics) + thin wire (new opcodes/predefs).

### P6 — higher-order lambdas  ·  status: not started (scope separately)
- **Goal:** lambdas as first-class values. Deepest phase — touches eval engine +
  type checker. Its spec scopes feasibility/risk before committing.
  **Depends-on:** TBD (assess in its spec).

### P7 — per-type additions + behavior changes + sigma reducers  ·  status: not started
- **Goal:** Box new props, Header new methods, `Context.getVarFromInput`; the
  version-gated behavior changes (`substConstants` v6, `AvlTree.insert`/`insertOrUpdate`
  v6); `allZK`/`anyZK`. **Depends-on:** mostly none; split further in its spec if large.

### P8 — validation (eventually)  ·  status: deferred
- **Goal:** wire `LanguageSpecificationV6` `verifyCases` + SANTA's JVM-blessed v6
  vectors into the conformance harness (`test/conformance/`). **Depends-on:** the
  eval/cost surface (P1–P7) existing to validate.

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
