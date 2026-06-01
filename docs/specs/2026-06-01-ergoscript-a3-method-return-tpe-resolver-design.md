# Phase A3 — MethodCall/PropertyCall return-type resolver (minimal population)

**Status:** Draft v2 (2026-06-01). Reviewer pass applied (REVISE → SHIP).
**Author:** Claude Opus 4.8 (1M context) under user direction.
**Phase scope:** Introduce a `(typeId, methodId) → return-type` resolver seam in the `mir/`
(IR) layer, consulted by `exprTpe` for `MethodCall`/`PropertyCall`, with an `SAny`
fallback for unregistered methods. Populate it with the two methods the SANTA v5
flatMap vector exercises (`SGroupElement.getEncoded`, `SColl.indices`). Closes SANTA
v5 item **A3** (`Coll_flatMap_method_equivalence.json :: Coll()#0`). **Value/representation
only — NOT a cost change.**

**Workstream:** JVM-alignment (`project_jvm_alignment_workstream`); ergots LEADS via SANTA
JVM-blessed conformance vectors. JVM `sigma-state-6.0.3` is canonical.
**Surfacing artifact:** `HANDOFF_A3_FLATMAP_EMPTY_ELEM_TYPE.md` (untracked).

---

## Goal

`exprTpe` (the pure AST→`SType` projection in `mir/expr-tpe.ts`) returns `SAny` for every
`MethodCall` and `PropertyCall` node, because ergots has no method return-type resolver
(documented since phase 2a; `expr-tpe.ts:138-154` PropertyCall, `:334-346` MethodCall). On
an **empty** `flatMap` input the handler cannot refine its output element type from a runtime
iteration, so it returns `Coll[SAny]` where JVM/sigma-rust return `Coll[T]` (the lambda
body's static return type).

The single failing conformance entry:

```
{ (x: Coll[GroupElement]) => x.flatMap({ (b: GroupElement) => b.getEncoded }) }   // empty input
```

`b.getEncoded` is `PropertyCall(typeId=7, methodId=2)` (0-arg, `OP_PROPERTY_CALL=0xdb` on the wire
— the eval registry's "MethodCall" comment is loose; both node kinds share the dispatch key); its
static return type is `Coll[SByte]`.
JVM yields `Coll[SByte][]` (empty); ergots yields `Coll[SAny][]`. Expected value
`{ kind: Coll, elem: SByte, items: [] }`, cost **149** (cost is already correct — this is value-only).

This spec builds the **minimal resolver**: the real resolver *mechanism* (a declarative
method-signature catalog + a `resolveReturnTpe` applier consulted by `exprTpe` + `SAny` fallback),
populated only with the methods A3 needs. The mechanism's *contract* — the descriptor format and
the resolution semantics — is defined to cover the full eventual method universe (including
type-variable substitution for generic methods). Closed-`t_range` methods then grow by pure
descriptor-addition; the one-time substitution branch lands behind the applier when the first
generic-output method needs it — neither path redesigns the seam.

## Non-goals

- **No full resolver / no substitution engine.** We do NOT populate all ~43 registered methods,
  and we do NOT build the type-var binding/substitution path. Both target methods (`getEncoded`,
  `indices`) have a *closed* `t_range` (no type vars in the output), so `resolveReturnTpe` returns
  it verbatim. A type-var `t_range` falls back to `SAny` (the cascade) until that branch lands.
  Populating generic-output methods + total cascade removal is a deliberate future phase (Future
  work).
- **No cost change.** A3 is value/representation only. The test strategy asserts costs are
  unchanged. Any cost delta is a regression, not an A3 fix.
- **No new `exprTpe` arms for other variants.** Only the `MethodCall`/`PropertyCall` arms change
  behavior (table consult + fallback). Every other arm is untouched.
- **No SOption.map code change.** `soption-map.ts:70` already calls `exprTpe(closure.body)`; all
  its fixtures use `BinOp` bodies that resolve concretely, so it has no failing vector. It
  inherits the fix for free *if* a method-call body ever appears (none does today).
- **No removal of the `SAny` cascade.** `SAny` remains `exprTpe`'s answer for every unregistered
  `(typeId, methodId)`. The cascade (`sTypeEqualsModuloSAny`/`hasSAny`,
  `reference_sany_type_checks_skip_not_fail`) stays load-bearing and unchanged for those.

## The divergence — precise

| Layer | Behavior |
|---|---|
| ergots `mir/expr-tpe.ts:138-154`, `:334-346` | `PropertyCall`/`MethodCall` → `SAny` (resolver offline). |
| ergots `eval/scoll-flat-map.ts:115-126,151-153` | `outElem` init from `exprTpe(body)`; `SAny` → refine from first runtime item; **empty input → no refinement → `Coll[SAny]`**. |
| sigma-rust `ergotree-interpreter/src/eval/scoll.rs:132` | `CollKind::from_vec_vec(lambda.body.tpe(), values)` → output elem from the body's **static** type → empty still `Coll[Byte]`. JVM identical. |
| SANTA | `Coll_flatMap_method_equivalence.json :: Coll()#0` — JVM `Coll[SByte][]`, ergots `Coll[SAny][]`. Currently in `KNOWN_DIVERGENCES` (`test/conformance/cost-v5.test.ts:37-41`; the `Coll()#0` entry is `:39`). |

The non-empty entries (#1–#3) already pass via the handler's runtime refinement
(`scoll-flat-map.ts:151-153`). The fix must agree with that refinement on non-empty inputs —
it does: for the `getEncoded` body, `exprTpe` now returns `Coll[SByte]` pre-loop, then every
item's runtime `Coll[Byte]` matches the (now-concrete) `outElem` at the `sTypeEquals` check
(`:154`). No non-empty regression.

## Architecture

### Decision 1 — Resolver seam: `mir/method-signatures.ts` (declarative descriptors + applier)

A new module in the **IR layer** (`mir/`, not `eval/`), keyed by `(typeId, methodId)`. Each entry
is the method's **signature descriptor**, mirroring sigma-rust's `SMethodDesc.tpe` (an `SFunc`)
line-for-line — `t_dom` (receiver + arg types, with type vars) and `t_range` (the return type,
which may reference those vars):

```ts
/** A method's static signature — mirrors sigma-rust SMethodDesc.tpe (an SFunc). */
export interface MethodSignature {
  /** t_dom: [receiverType, ...argTypes]; type vars allowed (e.g. SColl(STypeVar 't')). */
  readonly tDom: readonly SType[]
  /** t_range: the return type; may reference vars bound by tDom / explicitTypeArgs. */
  readonly tRange: SType
  /** Declared type params (sigma-rust SFunc.tpe_params); [] for monomorphic methods. */
  readonly tpeParams?: readonly STypeVar[]
}

export const METHOD_SIGNATURES: ReadonlyMap<string, MethodSignature> // "typeId:methodId" → sig
export function methodSignature(typeId: number, methodId: number): MethodSignature | undefined

/**
 * Resolve a registered method's concrete return type. Inputs are exactly sigma-rust's
 * substitution inputs:
 *   - receiver         = exprTpe(node.obj)        (unifies tDom[0])
 *   - argTpes          = node.args.map(exprTpe)   (unify tDom[1..]; [] for PropertyCall)
 *   - explicitTypeArgs = node.explicitTypeArgs    ({} for PropertyCall)
 * THIS PHASE: no type-var substitution. Returns tRange verbatim when it is CLOSED (contains no
 * STypeVar); a tRange that references a type var falls back to { tag: 'SAny' } — the same
 * load-bearing cascade fallback as an unregistered method. The substitution branch (bind vars
 * from the inputs → substitute into tRange) lands with the first generic-OUTPUT method, under its
 * own tests (Future work).
 */
export function resolveReturnTpe(
  sig: MethodSignature, receiver: SType, argTpes: readonly SType[],
  explicitTypeArgs: Record<string, SType>,
): SType
```

The only new helper this phase needs is `hasTypeVar(t: SType): boolean` (a small recursive walker,
sibling to `hasSAny` in `stype-helpers.ts`); `resolveReturnTpe` is then
`hasTypeVar(sig.tRange) ? SAny : sig.tRange`. **Implementation caution:** it must return `true` for
`tag === 'STypeVar'` and recurse the same composites (`SColl`/`SOption`/`STuple`/`SFunc`) — do NOT
copy `hasSAny`'s `default: false` tail, which would silently treat a type-var `tRange` as closed and
return it verbatim (a latent bug for the future generic path; the Layer-1 deferred-substitution test
pins against it).

**Why `mir/` not `eval/`:** `exprTpe` lives in `mir/` and cannot import the eval handler
registry (`eval/method-call.ts`) without inverting the layer dependency (eval depends on mir,
not the reverse). This mirrors sigma-rust exactly — method *signatures* live in
`ergotree-ir/src/types/*` (the IR crate), eval *functions* in `ergotree-interpreter/src/eval/*`
(the interpreter crate). The two are *meant* to be separate layers.

**Why declarative descriptors (your call):** each entry declares the method's full signature, so
the table is a *catalog* the contract can enumerate — and adding a method whose `t_range` is closed
is pure descriptor-addition, zero code. It transcribes sigma-rust's `types/*.rs`
`SMethodDesc.tpe` one-to-one; `ergots` already represents `STypeVar { name }` and
`SFunc { args, result, tpeParams }`, so a faithful descriptor (incl. the `SColl(T)` in
`indices`'s `t_dom`) is expressible today. The descriptors and the substitution *applier* are
split: `resolveReturnTpe` implements only the closed-`t_range` path now (which fully covers
`getEncoded`/`indices`), and falls back to `SAny` for a type-var `t_range` — exactly the cascade.
The var-binding branch is deferred so we don't ship unexercised substitution machinery (TDD: no
production code without a failing test). The *contract* (the descriptor catalog + resolution
semantics) is complete and forward-covering; the *engine* grows when first exercised.

### Decision 2 — `exprTpe` consults the table; `SAny` is the contractual fallback

The `MethodCall` and `PropertyCall` arms of `exprTpe` change from "return `SAny`" to:

```ts
case 'PropertyCall': {
  const sig = methodSignature(e.typeId, e.methodId)
  if (sig === undefined) return { tag: 'SAny' }              // load-bearing fallback (cascade)
  return resolveReturnTpe(sig, exprTpe(e.obj), [], {})
}
case 'MethodCall': {
  const sig = methodSignature(e.typeId, e.methodId)
  if (sig === undefined) return { tag: 'SAny' }
  return resolveReturnTpe(sig, exprTpe(e.obj), e.args.map(exprTpe), e.explicitTypeArgs)
}
```

(Implementation note: `expr-tpe.ts` imports `{ methodSignature, resolveReturnTpe }` from
`method-signatures.ts`. The applier needs only `SType` + `hasTypeVar` and does NOT import
`ExprTpeError`, so the `mir/` dependency graph stays acyclic.)

`SAny`-for-unregistered is **part of the contract**, not an accident: it is the documented
placeholder `sTypeEqualsModuloSAny` treats as a wildcard. A future SANTA type-resolution suite
probing an unpopulated method gets a defined answer (`SAny`); we tighten it by adding a table
entry. Same incremental model as eval-arm coverage.

### Decision 3 — Minimal population: the flatMap vector's two method bodies

| Key | Method | Source (`external/sigma-rust`) | Descriptor `{ tDom → tRange }` | `tRange` type vars |
|---|---|---|---|---|
| `7:2` | `SGroupElement.getEncoded` | `ergotree-ir/src/types/sgroup_elem.rs:41-50` | `[SGroupElement] → SColl(SByte)` | none |
| `12:14` | `SColl.indices` | `ergotree-ir/src/types/scoll.rs:123-136` | `[SColl(STypeVar 't')] → SColl(SInt)` | none (`t` only in `t_dom`) |

Both descriptors transcribe sigma-rust verbatim — including `indices`'s `SColl(T)` receiver in
`t_dom` (faithful, though unused for resolution since `t_range` is closed). Critically, **neither
`t_range` references a type var**, so `resolveReturnTpe` returns `t_range` verbatim and the deferred
substitution fallback is never taken for these two. `getEncoded` closes the RED entry directly;
`indices` is the *other* lambda body in the same vector file (entry #3: `b.getEncoded.indices`) and
is included so the table covers the whole vector's method surface — principled (driven by the
conformance oracle), not arbitrary, and zero-risk.

### Decision 4 — `facts/` contract (the artifact the user's constraint asks for)

Document the resolver boundary in **`facts/ergoscript-wire.md`** (which already owns the
`exprTpe`/`ExprTpeError` surface), with a cross-reference from **`facts/ergoscript-eval.md`**
for the dual-table sync invariant. Contract text in the next section. This is the
"contract that covers what will be built": it specifies resolution semantics and the
substitution inputs for the *full* method universe, while the implementation populates two
entries.

### Decision 5 — Dual-table sync invariant (stated, not yet enforced)

The signature table (`mir/method-signatures.ts`) and the eval handler registry
(`eval/method-call.ts`) share the `(typeId, methodId)` namespace. Invariant:

> A handler MAY exist without a signature (eval-only; the call's static type stays `SAny`).
> Every signature MUST agree with its handler's runtime element type (the static `t_range`
> equals the `elem`/shape the handler constructs at runtime).

`getEncoded`/`indices` satisfy this: `7:2`'s handler returns `bytesToCollByteSValue(...)`
(`Coll[Byte]`); `12:14`'s helper `indicesCollOf` returns `{ elem: SINT }` (`Coll[Int]`).
Mechanical enforcement (a test that diffs the two tables) is Future work, not this phase.

## Contract specification (for `facts/ergoscript-wire.md`)

> **`exprTpe` method-call resolution.** `exprTpe` is the static `SType` projection of an `Expr`.
> For `MethodCall`/`PropertyCall` it consults the `mir/method-signatures.ts` descriptor catalog,
> keyed by `(typeId, methodId)`, then applies `resolveReturnTpe`.
> - **Descriptor catalog:** each registered method declares a `MethodSignature`
>   `{ tDom, tRange, tpeParams? }`, transcribing sigma-rust's `SMethodDesc.tpe` (an `SFunc`). The
>   catalog is the enumerable contract surface; it grows by descriptor-addition.
> - **`resolveReturnTpe(sig, receiver, argTpes, explicitTypeArgs)`** — `receiver`, `argTpes`,
>   `explicitTypeArgs` are exactly sigma-rust's substitution inputs. The eventual semantics:
>   return `tRange` with type vars bound from those inputs (≡ sigma-rust `MethodCall::tpe()`).
> - **Postcondition (registered, closed `tRange`):** returns `tRange` verbatim. This is the only
>   path implemented this phase, and it covers `getEncoded`/`indices`.
> - **Postcondition (registered, type-var `tRange`):** returns `{ tag: 'SAny' }` (substitution
>   deferred). No such method is registered yet.
> - **Postcondition (unregistered):** returns `{ tag: 'SAny' }` — the documented placeholder,
>   treated as a wildcard by `sTypeEqualsModuloSAny`/`hasSAny`. Never throws (contrast unimplemented
>   *parser* variants, which still throw `ExprTpeError('tpe-not-implemented')`).
> - **Sync invariant** with the eval handler registry: see `facts/ergoscript-eval.md`.

## Error taxonomy

No new error codes. `exprTpe`'s `MethodCall`/`PropertyCall` arms previously could not throw
(always returned `SAny`); after the fix they still never throw for these tags (registered →
type; unregistered → `SAny`). `ExprTpeError('tpe-not-implemented')` remains the default only for
genuinely unparsed Expr variants. No change to `eval` error codes — `scoll-flat-map.ts`'s
`'lambda-result-type-mismatch'` path is unaffected (the body type is now concrete `Coll[Byte]`,
which takes the `SColl` branch at `:117`, never the defensive throw at `:122`).

## Test strategy

### Layer 1 — unit (`packages/ergoscript/test/expr-tpe.test.ts`, existing file)

Both target methods are **`PropertyCall`** on the wire (`OP_PROPERTY_CALL = 0xdb`; the `Coll()#0`
tree is `…db 07 02…` = getEncoded, entry #3 adds `db 0c 0e` = indices). The A3-critical arm is
therefore `PropertyCall`; the `MethodCall` arm is wired identically (Decision 2) for robustness and
for methods encoded with args, and gets one test too.

RED → GREEN unit tests on the projection directly:
- `exprTpe(PropertyCall{typeId:7, methodId:2, obj:<GroupElement Const>})`
  → `{ tag: 'SColl', elem: { tag: 'SByte' } }` (getEncoded).
- `exprTpe(PropertyCall{typeId:12, methodId:14, obj:<Coll[Long] Const>})`
  → `{ tag: 'SColl', elem: { tag: 'SInt' } }` (indices). Also assert it ignores the receiver elem
  (a `Coll[Byte]` receiver still yields `Coll[Int]`) — pins the closed-`tRange` behavior.
- **MethodCall arm:** the same `(7,2)` key via a `MethodCall` node also resolves `Coll[SByte]`
  (proves both arms consult the catalog).
- **Unregistered fallback:** `exprTpe(PropertyCall{typeId:999, methodId:999, …})` → `{ tag: 'SAny' }`.
- **Deferred-substitution fallback:** `resolveReturnTpe({tDom:[SColl(t)], tRange:SColl(t)}, SColl(SLong), [], {})`
  → `{ tag: 'SAny' }` — pins the type-var-`tRange` → `SAny` path directly, independent of any
  registered method (so adding a generic descriptor before the engine fails loudly in *its* test,
  not silently).

Pre-fix: the positive tests fail (`SAny` ≠ concrete). Post-fix: all pass.

### Layer 2 — conformance (un-skip the RED vector)

Remove the `Coll()#0` entry from `KNOWN_DIVERGENCES` (`test/conformance/cost-v5.test.ts:39`).
Pre-fix: fails (`Coll[SAny]` vs `Coll[SByte]`). Post-fix: passes — the whole-tree assert checks
both `value` (`hydrateSValue` of the empty `Coll[SByte]`) and `cost` (149).

### Layer 3 — eval layer (FLIP the existing R3(b) divergence test)

`scoll-flat-map.test.ts:183-225` currently asserts the *divergent* behavior: empty
`Coll[Coll[Long]].flatMap(xs => xs.indices)` → `elem: { tag: 'SAny' }`, `jitCost: 70`. This is the
eval-layer RED for A3. Flip it: post-fix `elem` is `{ tag: 'SInt' }` (indices → `Coll[Int]`,
flattened), `items.length` stays 0, and **`jitCost` stays 70** — the in-test proof A3 is value-only
(cost is value-independent). Rename the test and drop its "R3(b) divergence" doc-comment (now
JVM-aligned). Add a companion with the `getEncoded` body → empty `Coll[SByte]`, mirroring the
conformance vector. This is the only existing test that flips — the other `SAny` test sites
(`coll-append-sany`, `coll-map-sany-output-elem`, `coll-map-nested-sany`, `avltree-adapter`,
`_sigma-helpers`) construct *synthetic* `SAny` values to exercise the cascade machinery, which is
untouched.

### Layer 4 — verification commands (OVERRIDES rule #6) + no-cost-change

- `npx tsc --noEmit -p packages/ergoscript/tsconfig.json` — CLEAN.
- `node_modules/.bin/vitest run packages/ergoscript` — all pass (node + jsdom), incl. the
  un-skipped vector + new units. **A clean full-suite run is the cascade-shrink regression
  gate** (Risk 1): any val-def whose rhs is `getEncoded`/`indices` now stores a concrete type;
  previously-skipped static checks now run with that concrete type and must still pass.
- **No-cost-change assertion:** the conformance entry already asserts `cost === 149`; confirm no
  other vector's cost moves. (Cost is computed from op execution, not from `exprTpe`, so no cost
  path is touched — but we assert it, not assume it.)

A full mainnet walker re-run is **not** required: the change is value-only and the WASM oracle
returns no value (it can only observe cost, which is unchanged). The val-def-store regression surface
is covered by an existing *eval* harness, not just round-trip: `indices` (`db0c0e`) appears in
`ValDef`-rhs positions in `test/fixtures/mainnet_boxes.json`, which `corpus-eval.test.ts:118` (Layer
C2) fully evaluates via `evaluateWith`, asserting value AND cost against the sigma-rust-generated
fixture. Those trees now store concrete `Coll[SInt]` and run the previously-skipped static checks —
so that suite (run in T4) is the concrete cascade-shrink gate.

## Source mapping to sigma-rust

| Rust source (pinned `integration/ergots`, `external/sigma-rust`) | TS impact |
|---|---|
| `ergotree-ir/src/types/sgroup_elem.rs:41-50` (`GET_ENCODED_METHOD_DESC`, `t_range = SColl(SByte)`) | table entry `7:2 → Coll[SByte]` |
| `ergotree-ir/src/types/scoll.rs:123-136` (`INDICES_METHOD_DESC`, `t_range = SColl(SInt)`) | table entry `12:14 → Coll[SInt]` |
| `ergotree-ir/src/mir/method_call.rs` (`MethodCall::tpe` = specialized `t_range`) | the `exprTpe` consult pattern (Decision 2) |
| `ergotree-interpreter/src/eval/scoll.rs:132` (`from_vec_vec(body.tpe(), …)`) | confirms empty-input output elem = body static type |

## Execution order (TDD)

```
T1  Spec lands (this file).
T2  RED — (a) Layer 1 expr-tpe.test.ts units (PropertyCall getEncoded/indices, MethodCall arm,
    unregistered + deferred-substitution fallbacks); (b) FLIP scoll-flat-map.test.ts:183 (indices
    empty-input) to expect Coll[SInt] + jitCost 70, add getEncoded companion → Coll[SByte];
    (c) un-skip Coll()#0 in cost-v5.test.ts. Verify each fails for the right reason (positive
    units: SAny ≠ concrete; new-symbol tests: methodSignature/resolveReturnTpe undefined).
T3  GREEN — create mir/method-signatures.ts (MethodSignature + METHOD_SIGNATURES catalog +
    methodSignature lookup + resolveReturnTpe + hasTypeVar helper); wire the PropertyCall AND
    MethodCall exprTpe arms to consult it. Verify all T2 RED → green.
T4  Verification: tsc --noEmit clean; full vitest (node + jsdom) green; confirm no cost deltas
    (the cascade-shrink regression gate, Risk 1).
T5  Docs: facts/ergoscript-wire.md (contract) + facts/ergoscript-eval.md (sync-invariant
    cross-ref) + SESSION_CONTEXT + memory (project_jvm_alignment_workstream: A3 closed).
```

Expected commits: ~4 (T1 spec, T3 mechanism+population+RED, T4 verify-only, T5 docs). RED (T2)
folds into the T3 commit or stands alone per the TDD skill's preference.

## Risk hotspots

1. **Cascade-shrink regression (primary) — demonstrably exercised, not latent.** Making
   `exprTpe(getEncoded/indices)` concrete means any val-def whose rhs is one of these stores a
   concrete type instead of `SAny` (via `wire/mir/val-def.ts:66`); downstream static checks
   (`coll-append.ts:60`, `coll-map.ts`, `scoll-flat-map.ts:154`) that *skipped* on `SAny` now *run*.
   This is not hypothetical: `indices` (`db0c0e`) is present in `ValDef`-rhs positions in
   `mainnet_boxes.json`, evaluated by `corpus-eval.test.ts:118`. The checks pass iff our concrete
   type matches sigma-rust's — which it does for these two closed-`t_range`, source-verified methods.
   **Mitigation:** full vitest run (T4), incl. that corpus eval suite, is the gate.
   **Full `exprTpe` consumer set** (the spec previously under-listed it): `val-def.ts:66`,
   `scoll-flat-map.ts:115`, `soption-map.ts:70`, `coll-map.ts:123`, `coll-append.ts`, AND
   **`_substitute-deserialize.ts:208/270/281`**. The last is special: it compares `exprTpe(parsed)`
   against the declared `e.tpe` with **strict `sTypeEquals`** (not the SAny-wildcard variant). So a
   deserialized inner expr topped by `getEncoded`/`indices` *currently* resolves to `SAny` and
   `sTypeEquals(SAny, …)` is `false` → today it throws `deserialize-tpe-mismatch`. Post-fix it
   resolves concretely and *passes* when the declared `e.tpe` matches the true return type — a strict
   improvement (a false rejection removed), never a new failure unless the declared tpe genuinely
   disagrees with the true type, which sigma-rust would itself reject. Direction is safe; the corpus
   eval suite covers it.
2. **Layering.** Table must live in `mir/`; importing the eval registry into `mir/` would invert
   the dependency. **Mitigation:** Decision 1 puts it in `mir/`; `tsc` + the existing layer
   conventions catch an accidental cross-layer import.
3. **Drift between the two tables.** A future signature that disagrees with its handler's runtime
   type would reintroduce a divergence. **Mitigation:** the sync invariant is documented now
   (Decision 5); mechanical enforcement is Future work.
4. **Over-broad fallback change.** If someone later makes the unregistered arm *throw* instead of
   returning `SAny`, the cascade breaks across the eval surface. **Mitigation:** the Layer 1
   fallback test pins `SAny`-for-unknown.

## Confidence check (OVERRIDES #2)

**Confidence: 96%.** Not a crypto path; not a cost path (value-only). Both return types are
single-line sigma-rust descriptors, source-verified. The resolver seam is small and additive;
the `SAny` fallback preserves all current behavior for unregistered methods. The 4% residual is
Risk 1 — a latent type check somewhere in the corpus that goes concrete and surfaces a
*different* pre-existing bug; the full-suite run (T4) is the check, and the blast radius is
bounded to val-defs of exactly two methods.

**Escalation status:** none.

## Rollback plan

Single-revert per task. T3 (mechanism + population) reverts cleanly — the `PropertyCall`/
`MethodCall` arms return to `return { tag: 'SAny' }` and `method-signatures.ts` is removed. The T2
un-skip + test flips revert by restoring the `KNOWN_DIVERGENCES` entry and the original
`scoll-flat-map.test.ts` assertions.

## Future work (residual — explicitly deferred)

1. **Type-var substitution branch + generic-output methods.** Build the var-binding path inside
   `resolveReturnTpe` (unify `tDom` against `receiver`/`argTpes`/`explicitTypeArgs` → bind vars →
   substitute into `tRange`), replacing the current `SAny` fallback for a type-var `tRange`. Then
   populate generic-output methods (`reverse`, `patch`, `updated`, `map`, `zip`, …) by pure
   descriptor-addition, and audit each `SAny`-skip site as it goes concrete. Its own spec; likely
   SANTA-driven (a type-resolution conformance suite would surface which methods to populate next).
2. **Mechanical dual-table sync test.** Assert every `mir/method-signatures.ts` key has a
   matching `eval/method-call.ts` handler and that the static `t_range` agrees with the handler's
   constructed runtime type.
3. **SOption.map method-call body.** Inherits the fix for free; add a conformance vector if SANTA
   produces a `None`-input `Option.map(method-call body)` case.

## Reviewer findings applied (2026-06-01)

Adversarial review by a general-purpose subagent (rules-preamble dispatched per OVERRIDES #20).
Recommendation: **REVISE → SHIP.** 0 critical, 3 moderate, 2 minor. All 9 load-bearing claims
verified correct (return types, PropertyCall-on-wire, test-flip + cost-invariance, synthetic-SAny
isolation, layering/no-cycle, non-empty agreement, sync invariant, completeness, contract adequacy);
not-a-cost-path and no-TDD-violation also confirmed. Each finding below was re-verified against
source before folding in (OVERRIDES #15).

- **M1 (moderate, fixed):** Goal §line 33 called `b.getEncoded` a `MethodCall`; the wire bytes
  (`db 07 02`) make it a `PropertyCall`. Corrected; noted the eval-registry comment is loose.
- **M2 (moderate, fixed):** `_substitute-deserialize.ts:208/270/281` is a fourth `exprTpe` consumer
  using **strict** `sTypeEquals`, omitted from the risk analysis. Added to the consumer set in
  Risk 1 with the direction-of-change argument (today throws on `SAny`; post-fix passes when the
  declared tpe matches — a strict improvement, no new failure).
- **M3 (moderate, fixed):** Risk 1 framed cascade-shrink as a 4% "latent" possibility; in fact
  `indices` is in `ValDef`-rhs positions in `mainnet_boxes.json`, eval'd by `corpus-eval.test.ts:118`,
  so it's demonstrably exercised. Reframed Risk 1 + the verification note to cite that eval suite as
  the concrete gate (was loosely "corpus round-trip tests").
- **m1 (minor, fixed):** `cost-v5.test.ts` citation — the `Coll()#0` entry is `:39` (block `:37-41`),
  not `:38-40`.
- **m2 (minor, fixed):** flagged that `hasTypeVar` must add an explicit `STypeVar` arm and NOT copy
  `hasSAny`'s `default: false` tail (else a type-var `tRange` is silently treated as closed).

## Cross-references

- `external/sigma-rust/ergotree-ir/src/types/sgroup_elem.rs:41-50` — `getEncoded` descriptor.
- `external/sigma-rust/ergotree-ir/src/types/scoll.rs:123-136` — `indices` descriptor.
- `external/sigma-rust/ergotree-interpreter/src/eval/scoll.rs:132` — `from_vec_vec` empty-input elem.
- `packages/ergoscript/src/mir/expr-tpe.ts:138-154,334-346` — the two arms changing.
- `packages/ergoscript/src/eval/scoll-flat-map.ts:115-173` — flatMap handler (refinement path).
- `packages/ergoscript/src/eval/soption-map.ts:70` — SOption.map (inherits for free).
- `packages/ergoscript/src/mir/types.ts:413-432` — `MethodCall`/`PropertyCall` shapes.
- `packages/ergoscript/src/mir/stype-helpers.ts` — `sTypeEqualsModuloSAny`/`hasSAny` (cascade).
- `packages/ergoscript/test/conformance/cost-v5.test.ts:37-41` — `KNOWN_DIVERGENCES` (un-skip target).
- `HANDOFF_A3_FLATMAP_EMPTY_ELEM_TYPE.md` — surfacing handoff.
- Memory: `reference_sany_type_checks_skip_not_fail`, `project_jvm_alignment_workstream`.
