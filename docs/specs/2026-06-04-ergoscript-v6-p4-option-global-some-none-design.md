# ErgoScript v6 (ErgoTree V3) — P4: `Global.some` / `Global.none` design

**Date:** 2026-06-04
**Status:** approved shape (brainstorm) — spec for review
**Branch:** `ergoscript-v6`
**Phase:** P4 of the v6 umbrella (`docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`)
**Scope owner:** `@ergots/ergoscript`
**Canonical source:** JVM `sigma-state` only (`~/projects/sigmastate-interpreter/`). No
sigma-rust dependency, no Rust fixture-gen (umbrella validation-strategy section).

---

## 1. Framing correction (challenge the inherited P4 scope)

The umbrella's P4 entry reads: *"`Option.getOrElse`(lazy default); `Global.some` /
`Global.none`."* Source-verification against the JVM canonical reduces that to **one**
genuinely-new deliverable plus an adversarial-completeness fix:

1. **`Option.getOrElse` lazy default is already shipped.** `SOptionMethods.getMethods()`
   (`data/.../sigma/ast/methods.scala:792-799`) returns the **same five** methods for v5
   and v6 — `isDefined`/`get`/`getOrElse`/`map`/`filter`, with **no** `isV3OrLater`
   branch. `getOrElse` (id 4) compiles to the dedicated `OptionGetOrElse` MIR node
   (`mkOptionGetOrElse`), whose only "v6" aspect is **lazy** default evaluation at tree
   version ≥ 3. ergots already implements exactly that (`eval/option-get-or-else.ts:54-66`:
   V3+ lazy, V<3 eager). The JVM's own `property("Option.getOrElse with lazy default")`
   (`LanguageSpecificationV6.scala:1921`) blesses `Some(2L) → Success(2L)` at v3 /
   `Failure(/ by zero)` at v0–2 — precisely ergots' behavior. **No implementation work.**

2. **`Option.fold` is NOT in v6.0.** `property("Option new methods")`
   (`LanguageSpecificationV6.scala:1367`) tests `fold` via `newFeature`, but `fold` is
   **absent from `getMethods()`** — a non-shipping placeholder, the same status as P3's
   `find`/`bitwise`/`diff` and the `allZK`/`anyZK` TODOs. **Out of scope.**

3. **`Global.some` / `Global.none` are the new work.** Both are new V3-gated `SGlobal`
   methods inside the `isV3OrLaterErgoTreeVersion` branch
   (`methods.scala:1986-2021`).

4. **Adversarial-completeness fix (folded into P4 per the consensus mandate):** closing
   `none`/`some` exposes a wire-wellformedness rule ergots does not yet enforce — a V3+
   `MethodCall`-opcode node with empty args. See §6. This also closes a **pre-existing**
   over-accept on `groupGenerator`.

*(Aside, explicitly out of scope: `SOption.filter` (36:8) is an unimplemented **v5**
method — a latent gap like `negate`/`updated` were, never mainnet-reached. Not v6; left
for a separate v5-gap sweep / SANTA RED.)*

---

## 2. The v6 surface (authoritative: JVM `methods.scala:1986-2021`)

```scala
lazy val someMethod = SMethod(this, "some",
  SFunc(Array(SGlobal, tT), SOption(tT), Array(paramT)), 9, FixedCost(JitCost(5)), Seq(tT))
  .withIRInfo(MethodCallIrBuilder, javaMethodOf[...]("some"), { mtype => Array(mtype.tRange) })
  .withInfo(MethodCall, "Wrap given input into optional value (Option()).", ...)

lazy val noneMethod = SMethod(this, "none",
  SFunc(Array(SGlobal), SOption(tT), Array(paramT)), 10, FixedCost(JitCost(5)), Seq(tT))
  .withIRInfo(MethodCallIrBuilder, javaMethodOf[...]("none"), { mtype => Array(mtype.tRange) })
  .withInfo(PropertyCall, "Returns empty Option[T] of given type T.")

protected override def getMethods() = super.getMethods() ++ {
  if (VersionContext.current.isV3OrLaterErgoTreeVersion) Seq(..., someMethod, noneMethod)
  else Seq(groupGeneratorMethod, xorMethod)
}
```

| method | (typeId, methodId) | signature | cost | explicitTypeArgs | gate |
|---|---|---|---|---|---|
| `some` | 106:9 | `(SGlobal, T) → Option[T]` | `FixedCost(JitCost(5))` | `Seq(T)` | V3+ |
| `none` | 106:10 | `(SGlobal) → Option[T]` | `FixedCost(JitCost(5))` | `Seq(T)` | V3+ |

Blessed values (`LanguageSpecificationV6.scala:2884`, `:2897`):
`some(0.toByte) → Some(0.toByte)`, `some(1) → Some(1)`; `none[Byte]() → None`.
The `none` tree literal (`:2901-2908`) is
`MethodCall.typed(Global, noneMethod.withConcreteTypes(Map(T→SByte)), IndexedSeq(), Map(T→SByte))`
— **empty args, explicit `T = SByte`**.

Both consume the **P0 type-var substitution engine** (generic `Option[T]` return). `none`
is the **first method whose return type resolves purely from an explicit type argument**
(no receiver/arg to unify from) — the proof-of-exercise for the explicit-type-arg half of
P0, parallel to how `patch` first exercised the unify half.

---

## 3. Wire format (the one non-trivial piece)

### 3.1 Opcode selection — verified from the JVM serializers

A `MethodCall` AST node's serialized **opcode depends on its args**:

- **`some`** has 1 arg → **MethodCall opcode**. `MethodCallSerializer.serialize`
  (`.../serialization/MethodCallSerializer.scala:23-33`) writes
  `typeId, methodId, obj, args`, then `method.explicitTypeArgs.foreach { putType(typeSubst(a)) }`.
- **`none`** has 0 args → **PropertyCall opcode**. `MethodCallSerializer.serialize`
  asserts `args.nonEmpty` (line 27), so a zero-arg node **cannot** serialize through it; it
  routes to `PropertyCallSerializer.serialize` (`.../PropertyCallSerializer.scala:20-28`),
  which writes `typeId, methodId, obj`, then the same
  `method.explicitTypeArgs.foreach { putType(typeSubst(a)) }`. **This is conclusive** —
  the `assert` proves `none` is PropertyCall-encoded, despite the existing ergots registry
  entry's `method-call.ts` placement (a sigma-rust-provenance artifact).

So **both** `some` and `none` serialize `T` on the wire, but via **different
opcodes/serializers**. Parse mirrors (the `PropertyCallSerializer.parse:36-49` reads
`method.explicitTypeArgs.length` types iff `method.hasExplicitTypeArgs`).

### 3.2 ergots changes

The MethodCall path already supports explicit type args
(`wire/mir/method-call.ts:103` `explicitTypeArgNames` + parse:139-143 / serialize:178-187).
The PropertyCall path does **not** (`wire/mir/property-call.ts` reads/writes only
`typeId, methodId, obj`; `evalPropertyCall` hardcodes `explicitTypeArgs={}`,
`eval/method-call.ts:138`).

1. **Share the registry.** Extract `EXPLICIT_TYPE_ARG_NAMES` (currently a private const in
   `wire/mir/method-call.ts:84-96`) into a small shared module
   (`wire/mir/explicit-type-args.ts`) exporting `explicitTypeArgNames(typeId, methodId)`.
   Import it from both `method-call.ts` and `property-call.ts`. This mirrors the JVM, where
   `method.hasExplicitTypeArgs` is opcode-independent.
   - Add **`106:9 → ['T']`** (some). `106:10 → ['T']` (none) **already exists** — keep it;
     it now applies to the PropertyCall path (and harmlessly covers the adversarial
     OP_METHOD_CALL+none case, §6).
2. **`PropertyCall` MIR node** (`mir/types.ts`) gains
   `explicitTypeArgs: Record<string, SType>` (mirror the `MethodCall` node).
3. **`parsePropertyCall` / `serializePropertyCall`** iterate
   `explicitTypeArgNames(typeId, methodId)`, reading/writing one `SType` each after `obj`
   — byte-identical to the MethodCall path (`PropertyCallSerializer` order).
4. **`evalPropertyCall`** (`eval/method-call.ts:138`) forwards `e.explicitTypeArgs` to
   `dispatch` instead of `{}`.
5. **`exprTpe` PropertyCall arm** (`mir/expr-tpe.ts`) passes `e.explicitTypeArgs` to
   `resolveReturnTpe` (currently `{}` — the MethodCall arm already passes `e.explicitTypeArgs`,
   `expr-tpe.ts:344`).

**No new opcodes, no new MIR `Expr` variants.** Byte-roundtrip is preserved (parse→serialize
identity) and pinned by tests.

---

## 4. Evaluation

Two handlers in `eval/method-call.ts`, mirroring `groupGenerator` (106:1,
`method-call.ts:416-425`): `ctx.addCost(5)` first (Pattern A), then the `obj.kind ===
'Global'` guard, then construct the `Option` SValue. Both registered with `minVersion: 3`.

```
// some (106:9): (Global, value) → Some(value)
HANDLERS.set(handlerKey(106, 9), {
  handler: (obj, args, ctx, explicitTypeArgs) => {
    ctx.addCost(5)                          // FixedCost(JitCost(5)); methods.scala:1987
    if (obj.kind !== 'Global') throw EvalError(..., 'method-not-implemented')  // reuse, per taxonomy
    return { kind: 'Option', elem: explicitTypeArgs['T'], value: args[0] }
  },
  minVersion: 3,
})

// none (106:10): (Global) → None : Option[T]
HANDLERS.set(handlerKey(106, 10), {
  handler: (obj, _args, ctx, explicitTypeArgs) => {
    ctx.addCost(5)                          // FixedCost(JitCost(5)); methods.scala:1995
    if (obj.kind !== 'Global') throw EvalError(..., 'method-not-implemented')
    return { kind: 'Option', elem: explicitTypeArgs['T'], value: null }
  },
  minVersion: 3,
})
```

The `Option` SValue carries an `elem: SType` (`mir/types.ts`; every None-producer sets it —
`extract-register-as.ts:141`, `get-var.ts:44`, `soption-map.ts:74`, …). For `none` the
element type has no runtime value to infer from, so `elem` **must** come from
`explicitTypeArgs['T']` (the load-bearing input). For `some`, `T` is also on the wire (§3.1),
so both read `elem` uniformly — **no runtime-value→SType inference needed**.

`explicitTypeArgs` reaches the handler as the dispatcher's 4th argument (`dispatch(...)`,
`eval/method-call.ts:163`). `none` needs no `extra={mc,env}` (no lambda/env) — fine, since
`evalPropertyCall` passes `extra=undefined`.

---

## 5. Cost

`FixedCost(JitCost(5))` handler self-cost each. Full tree totals (the per-arm unit-test
assertions, V3 trees):

- **`some`**: `MethodCall(obj=Global, args=[Const(SByte,0)], 106:9, {T:SByte})`
  → `evalMethodCall` 4 + `evalGlobal` 5 + `evalConst` 5 + handler 5 = **19**.
  Value = `{kind:'Option', elem:SByte, value:{kind:'Byte', value:0}}`.
- **`none`**: `PropertyCall(obj=Global, 106:10, {T:SByte})`
  → `evalPropertyCall` 4 + `evalGlobal` 5 + handler 5 = **14**.
  Value = `{kind:'Option', elem:SByte, value:null}`.

(Cost sources: dispatcher envelope 4 — `method-call.ts:129`/`:136`; `Global` sentinel 5 —
`global.ts:16`; `Const` 5.) The JVM `testCases` for some/none carry blessed *values* but
not explicit cost totals (they use `testCases`, not `verifyCases`); ergots' unit tests pin
the totals above from the source cost constants. No cost-fixture (sigma-rust) involvement —
v6 has none.

---

## 6. Adversarial completeness: V3+ empty-args `MethodCall` reject

### 6.1 The divergence (verified)

The JVM enforces, **for V3+ trees**, that a `MethodCall`-opcode node has non-empty args:
`MethodCallSerializer.parse` does `if (isV3OrLaterErgoTreeVersion) assert(args.nonEmpty)`
(`MethodCallSerializer.scala:53-55`), mirroring the serializer's `assert` (`:27`). ergots'
`parseMethodCall` performs no such check → it accepts empty-args MethodCall at all versions.

**Is the JVM reject real?** Verified yes:
- sigma-state's build sets **no `-Xelide-below`** (`build.sbt`, `project/` — grep clean), so
  the Scala `assert` is **compiled into the published artifact and throws** at runtime
  (Scala `assert` is compile-time-elided, unlike Java `-ea`; default = on). The check is
  deliberately version-gated with an explaining comment ("the same check we have in
  serializer since v3 trees") — intentional. An `AssertionError` during deserialization can
  only make the tree *not validate*; there is no path where it becomes "accepted."
- **sigma-rust does *not* reject** (`method_call.rs:33-60` has no empty-args check; it leans
  on `specialize_for`, which *succeeds* for a zero-arg method like `none`). sigma-rust is
  explicitly **non-canonical** for v6 — this is a "faithful = less code" temptation we
  reject. The JVM is canonical and it rejects.

**Why it matters / is reachable:** any **zero-arg** method reached via the MethodCall opcode
evaluates successfully in ergots. P4 adds `none` (zero-arg) → directly reachable. And
`groupGenerator` (106:1, zero-arg) is **already** exploitable today (pre-existing
over-accept). For an adversarial V3 tree `OP_METHOD_CALL, 106:10, args=[], T`: the JVM
rejects (assert), ergots currently returns `None` (accept) — a latent consensus fork. The
box proposition bytes are attacker-controlled, so this is adversary-reachable; per the
project's consensus mandate (adversarial path ≥ honest path), it must be closed.

### 6.2 The rule (matches the JVM assert exactly)

> For `treeVersion ≥ 3`, reject any **`MethodCall`** node (ergots' `tag:'MethodCall'`, i.e.
> the OP_METHOD_CALL form — **not** `PropertyCall`) whose `args.length === 0`.

- **Method-agnostic** — the JVM asserts *before* `SMethod.fromIds`, so any (typeId,
  methodId), known or not, is rejected. ergots matches: no method lookup.
- **Pre-V3 grandfathered** — the JVM does **not** assert pre-V3 (grandfathered on-chain
  trees), so ergots must **not** reject there either. (Pre-V3 `groupGenerator`-via-MethodCall
  remains accepted, matching the JVM.)
- `PropertyCall` (the zero-arg opcode) is exempt — it is the legitimate empty-args form.

### 6.3 Implementation

A whole-tree, pre-eval, **zero-cost** validation pass keyed on `ctx.treeVersion`, mirroring
`validateBinOpTypes` (`eval/validate-bin-op-types.ts`) and `validateV6Types`:

- New `eval/validate-method-call-arity.ts` exporting `validateMethodCallArity(body, treeVersion)`,
  walking the tree via the exported `childrenOf` (`eval/_substitute-deserialize.ts`).
- Wired into `dispatchTreeBody` (`eval/evaluate.ts`) on the **post-substitution** body,
  before `tryTrivialReduce`/`evalExpr` and before any cost — so a rejected tree yields **no
  value and zero JIT cost**, and **dead branches are covered** (matching the JVM's
  parse-time, whole-tree reject). **Not** in `parseTree` (the wire parser stays permissive
  and version-agnostic — the established P2a architecture).
- This closes both the new (`none`) and pre-existing (`groupGenerator`) instances in one rule.

*(Could later be consolidated with `validateBinOpTypes`/`validateV6Types` into one V3
structural-validation walk; kept separate here to stay focused — flagged, not done.)*

---

## 7. EvalError codes

- **1 new code:** `'method-call-empty-args'` — raised by `validateMethodCallArity` (§6).
- **some/none reuse existing codes:** the `obj.kind !== 'Global'` guard reuses
  `'method-not-implemented'` (the `groupGenerator` precedent / taxonomy option 1); the
  `minVersion: 3` gate reuses `'tree-version-too-low'` (dispatcher, `method-call.ts:160`). A
  missing `explicitTypeArgs['T']` is a parse/registry invariant violation, not an adversarial
  input — no dedicated code.

Registry / code tallies: handlers **115 → 117**; EvalError codes **73 → 74**. (The
canonical registry count is the `facts/ergoscript-eval.md` registry-section header — 115,
= 67 individual `HANDLERS.set` + 48 loop-registered numeric/UBI. The per-phase running
tally in that file drifted to "110" by P2d-2; the P4 facts update reconciles the two.)

---

## 8. Version gating (consistent with P2a)

`some`/`none` exist only at V3+ (JVM `getMethods` gate). ergots realizes this with the
dispatcher `minVersion: 3` (eval-time reject → `'tree-version-too-low'`), **not** a
parse-time gate — the wire parser stays permissive and version-agnostic. A pre-V3 tree
carrying a `some`/`none` call parses (the explicit `T` is consumed by the registry-driven
path) and is rejected at eval. This is the same permissive-parse + eval-gate shape verified
conformant in P2a; the residual (byte-consumption on a tree the JVM rejects earlier) does
not change accept/reject — both reject the tree.

---

## 9. Test plan (per-arm RED → GREEN; no conformance-harness vectors)

Conformance vectors are **SANTA's lane** (user, this session) — P4 ships normal per-arm
unit tests with JVM-source-derived value+cost; SANTA's v6 vectors validate later (P8 / live
run). Cases:

1. **`some` value+cost** — V3 tree `Global.some[Byte](Const 0)` → `Some(Byte 0)`, cost 19;
   `some[Byte](1)` → `Some(1)`. (Blessed values: `LanguageSpecificationV6.scala:2890-2891`.)
2. **`none` value+cost** — V3 tree `Global.none[Byte]()` → `None : Option[SByte]`
   (`{elem:SByte, value:null}`), cost 14. (Blessed: `:2912-2913`.)
3. **`none` wire roundtrip** — parse(bytes) → serialize → identical bytes; the PropertyCall
   opcode + explicit `T` tail. A `some` MethodCall roundtrip with its `T` tail.
4. **Generic return typing** — `exprTpe(some[Byte](x)) === SOption(SByte)`;
   `exprTpe(none[Byte]()) === SOption(SByte)` (P0 via `explicitTypeArgs`). A second element
   type (e.g. `Coll[Byte]`) to confirm the substitution isn't hard-coded to `SByte`.
5. **Pre-V3 gate** — V2 tree with `some`/`none` → `'tree-version-too-low'`, no value.
6. **Adversarial reject** — V3 tree `OP_METHOD_CALL, 106:10 (none), args=[], T` →
   `'method-call-empty-args'`, **zero cost**. Same for an arbitrary (typeId, methodId).
7. **Pre-V3 grandfather (non-regression)** — V2 tree `OP_METHOD_CALL, 106:1 (groupGenerator),
   args=[]` → **accepted** (returns the generator). Pins that the reject is V3-only and
   ergots does not over-reject grandfathered trees.
8. **V3 groupGenerator-via-MethodCall reject** — V3 tree `OP_METHOD_CALL, 106:1, args=[]` →
   `'method-call-empty-args'` (the pre-existing hole, now closed).
9. **Honest non-regression** — a normal V3 `MethodCall` with ≥1 arg (e.g. `some[Byte](0)`,
   or any existing 1-arg method) is unaffected by the arity pass.

Gate: `tsc --noEmit` clean (4 packages); full suite green (node + jsdom).

---

## 10. Risks & faithfulness notes

- **Assert-elision caveat (documented, decision unchanged):** the JVM reject relies on
  assertions being compiled in. Verified for the canonical sigma-state build (no
  `-Xelide-below`). A hypothetical assertion-eliding downstream build would *accept* the
  adversarial tree — but that is not the reference, and elision can only make the JVM *more*
  accepting, so matching the canonical (non-eliding) build by rejecting is correct.
- **Permissive-parse residual (P2a-consistent):** ergots' registry-driven PropertyCall parse
  consumes the explicit `T` even on a pre-V3 tree the JVM may reject earlier at `fromIds`;
  both still reject the tree (ergots at the `minVersion:3` eval gate). No accept divergence.
- **Crypto/consensus confidence:** the wire format and the adversarial rule were verified by
  reading the JVM serializers + build config directly (≥95%). The cost constants are
  `FixedCost(JitCost(5))` straight from `methods.scala`.

---

## 11. Out of scope

- Conformance-harness vectors (some/none/getOrElse) — **SANTA**.
- An `OptionGetOrElse` JVM-conformance vector — SANTA (the arm is already implemented &
  behaviorally correct; user declined adding the vector here).
- `SOption.filter` (36:8) — a v5 gap, not v6.
- P5 SGlobal globals (`serialize`/`deserializeTo`/`fromBigEndianBytes`/`encodeNbits`/
  `decodeNbits`/`powHit`) — those registry entries (106:4, 106:5) already exist in the wire
  type-arg registry but are P5 eval/handler work.

---

## 12. Living-umbrella update (on completion)

Mark P4 **DONE** in `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`, recording: the
framing correction (Option.getOrElse already shipped; fold/filter excluded); the
`some`/`none` handlers + the first PropertyCall explicit-type-arg wire slice; the V3+
empty-args-MethodCall adversarial reject (+ the pre-existing `groupGenerator` hole it
closed); the new `'method-call-empty-args'` code; final tallies. Update `facts/ergoscript-eval.md`
(registry → 117, codes → 74; **reconcile** the per-phase running tally vs the registry-section
count, which currently disagree — 110 vs 115) and `facts/ergoscript-wire.md` (PropertyCall
explicit-type-arg support). **Next: P5 (Global functions).**
