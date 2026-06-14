# v6 P0 — type-var / `exprTpe` substitution engine

**Status:** Draft v2 (2026-06-02). Adversarial reviewer pass applied — **SHIP** (3 minor findings folded in; see "Reviewer findings applied").
**Author:** Claude Opus 4.8 (1M context) under user direction.
**Branch:** `ergoscript-v6`.
**Umbrella:** `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` — this is **phase P0** of
that ledger (the GATING prerequisite). On completion this spec updates the umbrella's P0 status.
**Phase scope:** Build the type-variable substitution engine behind the existing
`resolveReturnTpe` seam (A3, 2026-06-01) so generic-output `MethodCall`/`PropertyCall` nodes resolve
to a concrete `SType` instead of falling back to `SAny`. Register **one** real generic method —
`SColl.patch` (12:19) — as the end-to-end proof-of-exercise. **Value/representation only — NOT a
cost change.**

**Canonical source (per the umbrella's load-bearing decision):** the JVM `sigma-state` is the
**sole** canonical source. The engine is a direct port of `sigma/ast/package.scala`
(`unifyTypes` / `unifyTypeLists` / `applySubst`), `SMethod.specializeFor`, and
`MethodCallSerializer.getSpecializedMethodFor`. No sigma-rust dependency, no `fixture-gen`, no WASM.

---

## Goal

A3 shipped the resolver *seam* — a declarative `MethodSignature` catalog keyed by
`(typeId, methodId)`, the `resolveReturnTpe(sig, receiver, argTpes, explicitTypeArgs)` applier (its
API already takes the substitution inputs), and `STypeVar` / `hasTypeVar`. But its body is a stub:

```ts
// method-signatures.ts:95-102 (today)
export function resolveReturnTpe(sig, _receiver, _argTpes, _explicitTypeArgs): SType {
  return hasTypeVar(sig.tRange) ? { tag: 'SAny' } : sig.tRange
}
```

A **closed** `tRange` (no type var) is returned verbatim; a `tRange` that references a type var
falls back to `SAny`. This is A3's explicitly-deferred **Future work #1** (A3 spec §381-388):

> Build the var-binding path inside `resolveReturnTpe` (unify `tDom` against
> `receiver`/`argTpes`/`explicitTypeArgs` → bind vars → substitute into `tRange`), replacing the
> current `SAny` fallback for a type-var `tRange`. Then populate generic-output methods
> (`reverse`, `patch`, `updated`, `map`, `zip`, …) by pure descriptor-addition.

P0 builds that path. It is the umbrella's **GATING** phase: `serialize[T]`, `deserializeTo[T]`,
`fromBigEndianBytes[T]`, `Global.some`/`none`, and every generic Coll/Option method (P3–P5) have
type-var return types and resolve to `SAny` until this engine exists.

**What "done" means for P0:** `resolveReturnTpe` resolves a type-var `tRange` to the concrete type
implied by the call-site operands (and explicit type args), exactly as JVM `MethodCall.tpe()` does;
`SColl.patch` (12:19) is registered and resolves `Coll[IV]` from its receiver on a real path; every
existing resolution (the two closed-`tRange` entries, all unregistered methods) is byte-identical;
zero cost change; full suite green.

## Non-goals

- **No cost change.** P0 is value/type only. `exprTpe` feeds the static type into the val-def store
  and into eval-time element-type checks; it does **not** participate in cost. `patch`'s cost
  (`addPerItemCost(30,2,10,n)`, already implemented iter-28) is untouched. The test strategy
  **asserts** costs are unchanged; any delta is a regression, not a P0 effect.
- **No new generic methods beyond `patch`.** `reverse`, `find`, `getReg`, `some`/`none`,
  `fromBigEndianBytes`, `deserializeTo`, `map`, `updated`, `zip`, … are P3–P7 — each a pure
  descriptor-addition once the engine exists. P0 registers exactly one (the proof-of-exercise).
- **No `exprTpe` arm changes.** The `MethodCall`/`PropertyCall` arms already consult the catalog
  (A3); only `resolveReturnTpe`'s *body* changes. Every other `exprTpe` arm is untouched.
- **No SAny-cascade removal.** `SAny`-for-unregistered stays the load-bearing wildcard
  (`reference_sany_type_checks_skip_not_fail`). The engine *upgrades* a resolvable type-var `tRange`
  to concrete where it can, and **stays `SAny` where it can't** (unresolvable operands) — it lives
  inside the cascade, it does not replace it.
- **No mechanical dual-table sync enforcement.** The signature↔handler invariant (A3 Decision 5)
  stays documented-not-enforced; `patch` is hand-verified to satisfy it (below).

## Background — the canonical algorithm (JVM)

For a `MethodCall`, the JVM resolves the return type at **deserialize** time (consensus-relevant)
in `MethodCallSerializer.getSpecializedMethodFor` → `SMethod.specializeFor` → the `ast` package
object's `unifyTypes`/`applySubst`. Verbatim:

```scala
// MethodCallSerializer.scala:77-97
def getSpecializedMethodFor(methodTemplate, explicitTypeSubst, obj, args): SMethod = {
  val method = methodTemplate.withConcreteTypes(explicitTypeSubst)   // (1) explicit type args FIRST
  val argTypes = args.map(_.tpe)
  method.specializeFor(obj.tpe, argTypes)                            // (2) then unify receiver +: args
}

// SMethod.scala:193-199
def specializeFor(objTpe: SType, args: Seq[SType]): SMethod =
  unifyTypeLists(stype.tDom, objTpe +: args) match {
    case Some(subst) if subst.nonEmpty => withConcreteTypes(subst)  // apply unification subst
    case _ => this                                                  // no subst / unify failed → unchanged
  }

// core/.../sigma/ast/package.scala:39-81
def unifyTypes(t1, t2): Option[STypeSubst] = (t1, t2) match {
  case (STypeVar(n1), STypeVar(n2))      => if (n1==n2) Some(empty) else None
  case (STypeVar(id1), _)                => Some(Map(id1 -> t2))      // bind the var to the concrete type
  case (SColl(e1), SColl(e2))            => unifyTypes(e1, e2)
  case (SColl(e1), _: STuple)            => unifyTypes(e1, SAny)
  case (SOption(e1), SOption(e2))        => unifyTypes(e1, e2)
  case (STuple(i1), STuple(i2)) if eqLen => unifyTypeLists(i1, i2)
  case (SFunc(d1,r1), SFunc(d2,r2)) if eqLen => unifyTypeLists(d1:+r1, d2:+r2)
  case (SBoolean, SSigmaProp)            => Some(empty)               // implicit conversion in Coll(bool, prop)
  case (SPrimType(e1), SPrimType(e2)) if e1==e2 => Some(empty)
  case (SAny, _)                         => Some(empty)               // SAny *pattern* matches anything
  case _                                 => None
}
def unifyTypeLists(items1, items2): Option[STypeSubst] =   // pairwise unify, merge, conflict → None
def applySubst(tpe, subst): SType =                        // rewrite every STypeVar present in subst;
                                                           //   for SFunc also drop substituted tpeParams
```

Three load-bearing facts from this:
1. **`unifyTypes(t1, t2)` is one-directional matching:** `t1` is the *pattern* (the signature's
   declared type, with vars), `t2` is the *concrete* call-site type. `STypeVar` binds to whatever
   `t2` is.
2. **Order is explicit-then-unify:** explicit type args substitute into the whole signature first,
   then receiver+args unify against the (already-substituted) `tDom`.
3. **The receiver is prepended:** `objTpe +: args` unifies against `tDom` (so `tDom[0]` is the
   receiver type, `tDom[1..]` the arg types). This matches our `MethodSignature.tDom` convention
   (`[receiverType, ...argTypes]`).

sigma-rust's equivalent (`SType::with_subst` + unification in `types/stype.rs`) is the same shape —
it is the **optional, non-canonical cross-check** the umbrella allows, nothing more. The port below
follows the JVM.

## The divergence P0 closes (today's behavior)

| Layer | Today | After P0 |
|---|---|---|
| `resolveReturnTpe`, type-var `tRange` | `{ tag: 'SAny' }` (deferred) | bound concrete type (or `SAny` if operands unresolvable) |
| `exprTpe(MethodCall patch on Coll[SLong])` | `SAny` (12:19 unregistered) | `Coll[SLong]` |
| `method-signatures.test.ts:52-62` | asserts `Coll[t]⇒Coll[t]` on `Coll[SLong]` → `SAny` | **flips** → `Coll[SLong]` |
| closed-`tRange` (getEncoded 7:2, indices 12:14), unregistered methods | concrete / `SAny` | **identical** (closed path preserved) |

## Architecture

### Decision 1 — the engine lives in a new module `mir/type-unify.ts`

Three pure functions + a type alias, ported from JVM `ast/package.scala`:

```ts
// mir/type-unify.ts
export type STypeSubst = Map<string, SType>   // keyed by STypeVar name (JVM: Map[STypeVar, SType])

/** One-directional match: t1 is the pattern (may contain STypeVar), t2 the concrete type.
 *  Returns the binding map, or null on failure. Mirrors JVM unifyTypes. */
export function unifyTypes(t1: SType, t2: SType): STypeSubst | null

/** Pairwise-unify two equal-length lists, merging bindings; a var bound to two
 *  structurally-different types → null (conflict). Mirrors JVM unifyTypeLists. */
export function unifyTypeLists(items1: readonly SType[], items2: readonly SType[]): STypeSubst | null

/** Substitute every STypeVar present in `subst` throughout `tpe`; for SFunc also drop
 *  substituted vars from tpeParams. Mirrors JVM applySubst. */
export function applySubst(tpe: SType, subst: STypeSubst): SType
```

Reference implementation (faithful to the JVM cases; our `SType` union has no `STypeApply`, so that
case is dropped):

```ts
export function unifyTypes(t1: SType, t2: SType): STypeSubst | null {
  if (t1.tag === 'STypeVar') {
    if (t2.tag === 'STypeVar') return t1.name === t2.name ? new Map() : null
    return new Map([[t1.name, t2]])                                   // bind var → concrete
  }
  if (t1.tag === 'SAny') return new Map()                             // SAny pattern matches anything
  if (t1.tag === 'SColl') {
    if (t2.tag === 'SColl') return unifyTypes(t1.elem, t2.elem)
    if (t2.tag === 'STuple') return unifyTypes(t1.elem, { tag: 'SAny' })
    return null
  }
  if (t1.tag === 'SOption')
    return t2.tag === 'SOption' ? unifyTypes(t1.elem, t2.elem) : null
  if (t1.tag === 'STuple')
    return t2.tag === 'STuple' && t1.items.length === t2.items.length
      ? unifyTypeLists(t1.items, t2.items) : null
  if (t1.tag === 'SFunc')
    return t2.tag === 'SFunc' && t1.args.length === t2.args.length
      ? unifyTypeLists([...t1.args, t1.result], [...t2.args, t2.result]) : null
  if (t1.tag === 'SBoolean' && t2.tag === 'SSigmaProp') return new Map()  // implicit-conversion case
  if (isPrimitive(t1) && t1.tag === t2.tag) return new Map()             // prim == prim
  return null
}

export function unifyTypeLists(items1, items2): STypeSubst | null {
  if (items1.length !== items2.length) return null      // defensive (JVM .zipped truncates; callers ensure eqLen)
  const merged: STypeSubst = new Map()
  for (let i = 0; i < items1.length; i++) {
    const s = unifyTypes(items1[i]!, items2[i]!)
    if (s === null) return null
    for (const [name, t] of s) {
      const prev = merged.get(name)
      if (prev !== undefined && !sTypeEquals(prev, t)) return null   // conflicting binding
      merged.set(name, t)
    }
  }
  return merged
}

export function applySubst(tpe: SType, subst: STypeSubst): SType {
  switch (tpe.tag) {
    case 'STypeVar': return subst.get(tpe.name) ?? tpe
    case 'SColl':    return { tag: 'SColl',   elem: applySubst(tpe.elem, subst) }
    case 'SOption':  return { tag: 'SOption', elem: applySubst(tpe.elem, subst) }
    case 'STuple':   return { tag: 'STuple',  items: tpe.items.map((t) => applySubst(t, subst)) }
    case 'SFunc':    return {
      tag: 'SFunc',
      args: tpe.args.map((t) => applySubst(t, subst)),
      result: applySubst(tpe.result, subst),
      tpeParams: tpe.tpeParams.filter((p) => !subst.has(p.name)),    // JVM removes substituted vars
    }
    default: return tpe                                              // primitives carry no vars
  }
}
```

`isPrimitive` / `sTypeEquals` already exist in `mir/stype-helpers.ts`. **Layering:**
`type-unify.ts` imports only `./types` + `./stype-helpers` (both `mir/`); it does **not** touch
`eval/`. Acyclic, mirrors the JVM's own split (these live in the `ast` package object, distinct from
type equality). A focused module (vs. piling into `stype-helpers.ts`) keeps the engine cohesive and
independently unit-testable.

**Why not extend `sTypeEqualsModuloSAny` instead?** That helper answers "are these two types
compatible" (a boolean) for eval-time checks; unification answers "what binds the vars" (a
substitution). Different question, different return type. The engine is the binding machinery the
boolean helper never needed.

### Decision 2 — `resolveReturnTpe` body: closed-`tRange` early-return, else explicit-then-unify

```ts
// method-signatures.ts (new body)
export function resolveReturnTpe(
  sig: MethodSignature,
  receiver: SType,
  argTpes: readonly SType[],
  explicitTypeArgs: Record<string, SType>,
): SType {
  // Closed tRange: substitution is identity. Return verbatim — the A3 path, preserved EXACTLY
  // (covers getEncoded 7:2, indices 12:14, and every future closed-tRange method).
  if (!hasTypeVar(sig.tRange)) return sig.tRange

  // Generic tRange. Mirror JVM getSpecializedMethodFor:
  //   (1) apply explicit type args to tDom + tRange (withConcreteTypes), THEN
  //   (2) unify the substituted tDom against [receiver, ...argTpes] (specializeFor).
  const explicitSubst: STypeSubst = new Map(Object.entries(explicitTypeArgs))
  const tDom = sig.tDom.map((t) => applySubst(t, explicitSubst))
  const tRange0 = applySubst(sig.tRange, explicitSubst)

  const unified = unifyTypeLists(tDom, [receiver, ...argTpes])
  const resolved = unified === null ? tRange0 : applySubst(tRange0, unified)

  // Safety net (no JVM analog — JVM never sees unresolved types). Any residual type var means the
  // operands couldn't bind it (e.g. an SAny-cascade receiver) → fall back to SAny (the cascade).
  return hasTypeVar(resolved) ? { tag: 'SAny' } : resolved
}
```

The early-return is not just an optimization: it **guarantees** the two existing closed-`tRange`
entries (and all future ones) are byte-identical to A3 — `applySubst` on a var-free type is identity,
but skipping unification entirely makes the invariance obvious and removes any risk a unify edge case
perturbs them. The engine activates **only** for a type-var `tRange` — today that set is empty; P0
adds exactly `patch`.

**Length divergence from JVM (intentional, safe).** `unifyTypeLists` returns `null` on a
`tDom`/operands length mismatch, whereas JVM `unifyTypeLists` (`package.scala:19`) uses `.zipped`,
which silently truncates to the shorter list (a malformed call with too few args could still bind
vars from the surviving prefix). For any well-formed call the lengths are equal
(`tDom` = `[receiver, ...args]`), so this never fires; on a malformed call it yields the conservative
`SAny` rather than a partially-bound type, and the eval handler rejects wrong arity independently
(`method-call.ts:553`). Since the static type never affects cost, the deviation is
unreachable-or-safe.

### Decision 3 — `SColl.patch` (12:19) is the proof-of-exercise

Per the user's call (2026-06-02): P0 registers one real, mainnet-exercised, already-eval-handled
generic method so the engine runs on a production path, not just synthetic unit tests — honoring
A3's "don't ship unexercised substitution machinery." `patch` is the clean candidate.

**Canonical signature** — JVM `methods.scala:1013-1015`:
`SFunc(Array(ThisType, SInt, ThisType, SInt), ThisType, paramIVSeq)` where `ThisType = SCollection(tIV)`
and `tIV = STypeVar("IV")`. I.e. `[Coll[IV], Int, Coll[IV], Int] → Coll[IV]`, type param `IV`.

```ts
const IV: SType = { tag: 'STypeVar', name: 'IV' }
const collOf = (e: SType): SType => ({ tag: 'SColl', elem: e })
// SColl.patch — methods.scala:1013-1015 — SFunc([Coll[IV], Int, Coll[IV], Int] → Coll[IV]).
[key(12, 19), {
  tDom: [collOf(IV), { tag: 'SInt' }, collOf(IV), { tag: 'SInt' }],
  tRange: collOf(IV),
  tpeParams: [{ name: 'IV' }],
}],
```

(The type-var *name* is signature-internal — only `tDom`↔`tRange` consistency matters. `IV` matches
the JVM's `tIV`; the existing `indices` entry's `'t'` is left as-is since its `tRange` is closed and
the name is irrelevant there.)

**Resolution on a real call** — `xs.patch(from, ys, replaced)` with `xs: Coll[Long]`, `ys: Coll[Long]`:
unify `[Coll[IV], Int, Coll[IV], Int]` against `[Coll[Long], Int, Coll[Long], Int]` → `IV ↦ Long`
(bound twice, consistently) → `applySubst(Coll[IV], {IV: Long})` = `Coll[Long]`.

**Sync invariant (A3 Decision 5) — verified.** The handler (`method-call.ts:581-589`) returns
`{ kind: 'Coll', elem: obj.elem, items: [...slices ++ patch...] }` — runtime element type is the
receiver's `obj.elem`. The static resolution binds `IV` to the receiver's element type and yields
`Coll[that]`. Static `tRange` ≡ handler runtime elem. ✓

### Decision 4 — SAny-cascade interaction (the correctness boundary)

The engine must never *break* the cascade. Three operand shapes, all safe:

| Receiver / args | unify outcome | `resolveReturnTpe` result |
|---|---|---|
| concrete `Coll[Long]` (+ matching args) | `IV ↦ Long` | `Coll[Long]` — the upgrade P0 is for |
| `Coll[SAny]` (elem unresolved) | `unify(Coll[IV], Coll[SAny])` → `IV ↦ SAny` | `Coll[SAny]` — `hasTypeVar` false → returned; cascade tolerates it |
| bare `SAny` (whole receiver unresolved) | `unify(Coll[IV], SAny)` → `null` (no SColl/STuple match) → list fails | falls through to `tRange0` (still has `IV`) → `hasTypeVar` → **`SAny`** |
| arg elem mismatches receiver elem | conflicting `IV` binding → `null` | → `SAny` (safety net) |

The engine's output is therefore **monotone over the cascade**: given resolvable operands it returns
the concrete type the JVM returns; given an `SAny`-tainted operand it returns an `SAny`-bearing type
(possibly nested) or bare `SAny`. It **never** emits a residual `STypeVar` (the `hasTypeVar` net), and
**never** emits a *wrong* concrete type (unification failure → `SAny`, not a guess). This is the key
safety argument: the worst case is "no more precise than today," never "wrong."

### Decision 5 — `facts/` contract update

Update **`facts/ergoscript-wire.md`** (lines 123-129, the A3 contract block): the
"Registered, type-var `tRange` → `SAny`" bullet becomes "→ `tRange` with type vars bound from
`receiver`/`argTpes`/`explicitTypeArgs` (≡ JVM `MethodCall.tpe()`); unresolvable residual → `SAny`,"
and note `patch` (12:19) → `Coll[IV-of-receiver]` as the first registered generic-output method.
Cross-reference the sync invariant in `facts/ergoscript-eval.md` (add `patch` to the satisfied set).

## Error taxonomy

No new error codes. `resolveReturnTpe` never throws (registered → type; unresolvable → `SAny`).
`exprTpe`'s `MethodCall`/`PropertyCall` arms still never throw for these tags.
`ExprTpeError('tpe-not-implemented')` remains the default only for genuinely-unparsed Expr variants.
No `eval` error-code change.

## Test strategy

### Layer 1 — engine units (new file `test/type-unify.test.ts`)

RED = module missing. Pin each ported JVM case directly against `unifyTypes`/`unifyTypeLists`/`applySubst`:
- **`unifyTypes` cases:** `STypeVar` vs concrete → `{name↦concrete}`; same/diff `STypeVar` pair →
  empty/null; `Coll[T]` vs `Coll[Long]` → `{T↦Long}`; `Coll[T]` vs `STuple` → `{T↦SAny}`;
  `Option[T]` vs `Option[Int]`; `STuple` equal/unequal length; `SFunc` (args+result unified);
  `SBoolean` vs `SSigmaProp` → empty; `SByte` vs `SByte` → empty, `SByte` vs `SInt` → null;
  `SAny` pattern vs anything → empty; `Coll[T]` vs bare `SAny` → null.
- **`unifyTypeLists`:** consistent double-bind (`[Coll[T],T]` vs `[Coll[Long],Long]` → `{T↦Long}`);
  conflicting bind (`[T,T]` vs `[Int,Long]` → null); length mismatch → null.
- **`applySubst`:** substitute in `Coll`/`Option`/`STuple`/`SFunc`; `SFunc` tpeParam-drop
  (substituted var removed from `tpeParams`); var absent from subst → unchanged; primitive → identity.

### Layer 2 — `resolveReturnTpe` units (`test/method-signatures.test.ts`, existing)

- **FLIP** the deferred-substitution test (`:52-62`): synthetic `Coll[t] ⇒ Coll[t]` on `Coll[SLong]`
  now → `{ tag: 'SColl', elem: { tag: 'SLong' } }` (was `SAny`). This is the canonical engine RED.
- **Add:** explicit-type-arg path — synthetic `getReg`-shaped sig `{tDom:[SBox,SInt], tRange:Option[T],
  tpeParams:[T]}` with `explicitTypeArgs {T: SLong}` → `Option[SLong]` (pins explicit-then-unify, and
  that an explicit var absent from `tDom` still resolves).
- **Add:** SAny-receiver → `SAny`; conflicting-arg → `SAny` (safety net).
- **Keep (regression pin):** the two closed-`tRange` tests (`getEncoded`/`indices`) return identical
  results — proves the early-return preserves A3 exactly.

### Layer 3 — `patch` end-to-end (`test/expr-tpe.test.ts`)

- RED = `patch` unregistered → `SAny`. After: `exprTpe(MethodCall{12,19, obj:<Coll[SLong] Const>,
  args:[Int, Coll[SLong] Const, Int]})` → `{ tag: 'SColl', elem: { tag: 'SLong' } }`.
- The **existing iter-28 patch eval + fixture tests** (value + cost) stay green unchanged — the
  in-suite proof the runtime value and cost are untouched (only the static type sharpens).

### Layer 4 — verification (OVERRIDES #6) + no-cost-change + regression

- `npx tsc --noEmit` across workspaces — CLEAN.
- Full `vitest run` (node + jsdom) green, including **`corpus-eval.test.ts`** (the concrete
  cascade-shrink gate — any mainnet tree whose `ValDef` rhs is `patch` now stores `Coll[concrete]`
  and runs the previously-skipped static checks; they pass iff our concrete type matches runtime,
  which Decision 3 verified).
- **No-cost-change assertion:** confirm no fixture/conformance cost moves (cost is computed from op
  execution, not `exprTpe`; we assert it, not assume it).
- **No walker run.** Value-only; the WASM oracle observes only cost (unchanged), so it cannot see this
  change — the unit + corpus suites are the gate (same rationale as A3 §295-301).

## Source mapping (JVM canonical)

| JVM source (`~/projects/sigmastate-interpreter`) | TS impact |
|---|---|
| `core/.../sigma/ast/package.scala:17-81` (`unifyTypes`/`unifyTypeLists`/`applySubst`) | `mir/type-unify.ts` (the engine) |
| `data/.../sigma/ast/SMethod.scala:193-199` (`specializeFor` = unify `tDom` vs `objTpe +: args`) | `resolveReturnTpe` step (2) |
| `data/.../sigma/serialization/MethodCallSerializer.scala:77-97` (`getSpecializedMethodFor` = explicit-then-unify order) | `resolveReturnTpe` steps (1)→(2) |
| `data/.../sigma/ast/methods.scala:1013-1015` (`PatchMethod`, `[Coll[IV],Int,Coll[IV],Int]→Coll[IV]`) | catalog entry `12:19` |

## Execution order (TDD)

```
T1  Spec lands (this file) + reviewer pass.
T2  RED — (a) test/type-unify.test.ts engine units (fail: module missing);
    (b) FLIP method-signatures.test.ts:52-62 + add explicit/SAny/conflict cases (fail: still SAny);
    (c) add patch exprTpe-resolution test in expr-tpe.test.ts (fail: 12:19 unregistered → SAny).
    Verify each fails for the right reason.
T3  GREEN — create mir/type-unify.ts (unifyTypes/unifyTypeLists/applySubst/STypeSubst); rewrite
    resolveReturnTpe body (closed-tRange early-return + explicit-then-unify generic path); register
    SColl.patch (12:19). Verify all T2 RED → green.
T4  Verify — tsc --noEmit clean; full vitest (node + jsdom) incl. corpus-eval; no cost deltas;
    confirm getEncoded/indices/unregistered resolutions identical.
T5  Docs — facts/ergoscript-wire.md (contract update) + facts/ergoscript-eval.md (sync-invariant
    +patch) + umbrella P0 ledger status → done + SESSION_CONTEXT + memory
    (project_jvm_alignment_workstream or a P0 note).
```

Expected commits: ~3 (T1 spec; T3 engine+resolveReturnTpe+patch+RED; T5 docs). T4 is verify-only.

## Risk hotspots

1. **Engine correctness (primary, new).** A wrong `unifyTypes`/`applySubst` case could mis-resolve a
   generic method to a *wrong* concrete type — worse than `SAny`, because a wrong concrete type could
   cause a false eval-time static-check rejection. **Mitigations, layered:** (a) the `hasTypeVar` safety
   net guarantees no residual var ever escapes; (b) unification *failure* → `SAny`, never a guess, so
   the only way to emit a wrong concrete type is a genuinely-wrong `applySubst`, which the Layer-1 units
   pin case-by-case against the JVM; (c) only type-var-`tRange` methods are affected — exactly `patch`
   in P0 — so the live blast radius is one method, gated by its existing fixtures + corpus-eval.
2. **Cascade-shrink for `patch` (same class as A3 Risk 1).** `patch`'s `ValDef`-rhs static type goes
   `SAny → Coll[concrete]`, changing two kinds of downstream consumer:
   - **modulo-SAny checks** (`coll-append.ts:60`, `coll-map.ts:115,171` — `sTypeEqualsModuloSAny`)
     that *skipped* on `SAny` (wildcard → `true`) now *run* against the concrete type. Safe: the
     concrete type equals the runtime elem (Decision 3), so they still pass.
   - **strict checks** (`scoll-flat-map.ts:103,154`, `_substitute-deserialize.ts:209/271/282` — plain
     `sTypeEquals`). For `_substitute-deserialize`, `sTypeEquals(SAny, declaredTpe)` was *false*, so it
     **threw** `deserialize-tpe-mismatch` on an `SAny`-rooted deserialize; post-P0 it resolves
     concretely and **accepts** when the declared tpe matches — a reject→accept improvement in the
     JVM-correct direction (a false-reject removed), never a new throw. This path is **unexercised on
     mainnet** (the walker reached tip with no `deserialize-tpe-mismatch` halt), so the change is
     latent. `scoll-flat-map`'s `outElem` refinement degrades gracefully (adopts the runtime item
     type), it does not throw.

   `patch` is mainnet-exercised (iter-28). The key safety property: **every affected check is either
   skip→run-and-pass or reject→accept — none goes passing→throwing**, so no new eval halt is
   introduced. **Mitigation:** full vitest incl. corpus-eval (T4); direction is safe (concrete matches
   runtime per Decision 3).
3. **Existing-entry invariance.** `getEncoded`/`indices` must resolve identically. **Mitigation:** the
   closed-`tRange` early-return (Decision 2) makes this structural, not incidental; pinned by the
   kept Layer-2 tests.
4. **Explicit-type-arg order.** Must be explicit-then-unify (JVM). No *mainnet* method exercises
   explicit args yet (`patch` doesn't), so this is forward-coverage for P5's `getReg`/`deserializeTo`
   — pinned synthetically in Layer 2 so the order is locked before a real consumer arrives.

## Confidence check (OVERRIDES #2)

**Confidence: 96%.** Not a crypto path; not a cost path (value-only). The engine is a direct,
case-by-case port of canonical JVM `ast/package.scala` + `SMethod.specializeFor` +
`MethodCallSerializer.getSpecializedMethodFor`, each source-verified. The `hasTypeVar` safety net +
unification-failure-→-`SAny` bound the output to "concrete-and-correct or `SAny`," never wrong; the
closed-`tRange` early-return makes existing resolutions provably invariant; the live blast radius is
one method (`patch`) with existing fixtures + corpus coverage. The 4% residual is Risk 2 —
cascade-shrink surfacing a *different* pre-existing latent bug in a `patch` corpus position; the
full-suite + corpus-eval run (T4) is the check.

**Escalation status:** none.

## Rollback plan

Single-revert per task. T3 reverts cleanly: delete `mir/type-unify.ts`, restore `resolveReturnTpe`'s
one-line stub body, remove the `12:19` catalog entry; `exprTpe` arms are unchanged so they need no
touch. T2 test flips revert by restoring the original assertions.

## Future work (deferred to later umbrella phases)

1. **Generic-output method population — P3/P5/P7.** With the engine live, `reverse`, `find`,
   `getReg`, `some`/`none`, `fromBigEndianBytes`, `deserializeTo`, `map`, `updated`, `zip`, … are pure
   descriptor-additions (each in its phase), auditing each `SAny`-skip site as it goes concrete.
2. **Mechanical dual-table sync test (A3 Future #2).** Still deferred — assert every
   `mir/method-signatures.ts` key has a matching `eval/method-call.ts` handler whose runtime element
   type agrees with the static `tRange`.

## Reviewer findings applied (2026-06-02)

Adversarial review by a general-purpose subagent (read-only; rules-preamble dispatched per
OVERRIDES #20, instructed to verify every claim against actual JVM + ergots source rather than the
spec's quotes). **Recommendation: SHIP** — the engine is a faithful, case-by-case port of canonical
JVM `unifyTypes`/`unifyTypeLists`/`applySubst` + `specializeFor` + `getSpecializedMethodFor`; all 8
load-bearing probes verified correct (algorithm faithfulness incl. `STypeApply` correctly dropped and
`SAny`-case reorder shown semantically equivalent; SAny-cascade table reproduced by executing the
reference code, counterexample hunt found no residual `STypeVar` and no wrong concrete type;
closed-`tRange` invariance; explicit-then-unify order; no-cost-change; reference TS typechecks; sync
invariant `elem: obj.elem`; `patch` signature exact). 0 critical, 0 moderate, 3 minor — each
re-verified against source (OVERRIDES #15: `grep` confirmed the strict-vs-modulo-SAny split) before
folding in:

- **m1 (minor, fixed):** Risk 2 mislabeled `coll-append.ts`/`coll-map.ts` as strict-`sTypeEquals`
  consumers; they use `sTypeEqualsModuloSAny`. The genuinely-strict consumers are `scoll-flat-map.ts`
  and `_substitute-deserialize.ts`. Risk 2 rewritten with the correct two-kind split. (Safety
  conclusion unchanged — the listed set already covered both risk-bearing files.)
- **m2 (minor, fixed):** for the strict `_substitute-deserialize` path, `SAny` did not *skip*, it
  *threw* (`sTypeEquals(SAny, …)` is false). So P0's effect there is reject→accept (a latent
  false-reject removed in the JVM-correct direction), stronger than "skip→run." Folded into Risk 2,
  with the note that the path is unexercised on mainnet (walker reached tip with no such halt).
- **m3 (minor, fixed):** the `unifyTypeLists` strict-length check intentionally diverges from JVM
  `.zipped` (which truncates). Added an explicit "Length divergence from JVM (intentional, safe)"
  note in Decision 2 — only reachable on malformed calls, conservative `SAny` direction, handler
  rejects wrong arity independently, static type never affects cost.

## Cross-references

- `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md` — umbrella (P0 = this phase).
- `docs/specs/2026-06-01-ergoscript-a3-method-return-tpe-resolver-design.md` — the seam P0 fills
  (Future work #1).
- `~/projects/sigmastate-interpreter/core/shared/src/main/scala/sigma/ast/package.scala:17-81`,
  `.../data/.../sigma/ast/SMethod.scala:193-199`,
  `.../data/.../sigma/serialization/MethodCallSerializer.scala:77-97`,
  `.../data/.../sigma/ast/methods.scala:1013-1015` — canonical source.
- `packages/ergoscript/src/mir/method-signatures.ts:95-102` — the stub `resolveReturnTpe`.
- `packages/ergoscript/src/mir/stype-helpers.ts` — `isPrimitive`/`sTypeEquals`/`hasTypeVar` (reused).
- `packages/ergoscript/src/eval/method-call.ts:544-590` — the `patch` handler (sync invariant).
- `packages/ergoscript/test/method-signatures.test.ts:52-62` — the deferred-substitution test P0 flips.
- Memory: `reference_sany_type_checks_skip_not_fail`, `project_jvm_alignment_workstream`,
  `reference_sigma_rust_branch_canonical`.
