# ErgoScript v6 — P6: higher-order lambdas (first-class functions) design

**Status:** proposed (2026-06-05). **Reframed from the umbrella's "deepest/riskiest phase":** a verification pass against the JVM-blessed vector proves ergots' eval engine *already* evaluates first-class functions (value + cost exact). P6 is therefore **verification + adversarial-path closure** (two small, source-justified fixes) + **JVM-blessed conformance lock-in** — not an eval-engine build.
**Phase:** v6 P6 — higher-order lambdas. After this: P7 (per-type additions + behavior changes + `allZK`/`anyZK`), P8 (validation). P0–P5 complete.
**Branch:** `ergoscript-v6` (local-only; one PR to `master` at v6 delivery). **No push until the consensus-path conformance gate is green + explicit go** (user constraint).
**Canonical source:** JVM `sigma-state` only (per the v6 canonical-source decision). sigma-rust `eni`/`ergo-node-integration` is an optional non-canonical cross-check — read it only via `git show ergo-node-integration:<path>` from the vendored `external/sigma-rust`, **never** the living `~/projects/sigma-rust` clone (a parallel session can switch its branch mid-read).

### Canonical sources (cited)

- `sc/shared/src/test/scala/sigma/LanguageSpecificationV6.scala:1603-1672` — `property("higher order lambdas")`, the *only* dedicated HOF feature test (`sinceVersion = V6SoftForkVersion`), blessed value `Coll(1,2) → Coll(2,3)`.
- `sc/shared/src/test/scala/sigma/SigmaDslTesting.scala:895-977` — `NewFeature`: pre-v6 the feature **must fail** (`oldRes.isFailure shouldBe true`); `isSupportedIn = activatedVersion ≥ since && ergoTreeVersion ≥ since`; `ActivationByTreeVersion`.
- `core/shared/src/main/scala/sigma/serialization/TypeSerializer.scala:111,211` — `SFunc` type code (112) gated `if isV3OrLaterErgoTreeVersion` (serialize + deserialize). **Lines 122, 202-205** — `STypeVar` (code 103) serialize/deserialize, **no version gate**.
- `data/shared/src/main/scala/sigma/serialization/ValueSerializer.scala:126-131,157` — `ValDef`/`FunDef`/`BlockValue`/`ValUse`/`FuncValue`/`Apply` registered **unconditionally**; the lone version gate (line 157) is unrelated `Upcast`-stripping.
- `data/shared/src/main/scala/sigma/ast/values.scala:911-949` — `FunDef` *is* a `ValDef` with non-empty `tpeArgs` (`companion = if (tpeArgs.isEmpty) ValDef else FunDef`). **Lines 991-1004** — `BlockValue.eval` casts every item to `ValDef`, evaluates `rhs`, binds `id → v`, **ignores `tpeArgs`**.
- `data/shared/src/main/scala/sigma/serialization/ValDefSerializer.scala:12-50` — `FunDef` serialize/parse: `id` + (`nTpeArgs` ≥ 1, `require(len > 0)`) `STypeVar` args via `getType()` + `rhs`.
- SANTA `vectors/eval/v6/spec/higher_order_lambdas.json` (`jvm:sigma-state-6.0.3`) — blessed value `Coll(2,3)`, **cost 408** (runner-measured eval cost; the spec's `Expected.cost=1793` includes harness/context accounting — 408 is the `jitCost`-comparable figure, same convention as every v5 conformance vector).

---

## 1. What v6 "higher-order lambdas" actually is

The capability is **functions as first-class values**: stored in composite types (tuples, collections), pulled out via `SelectField`/`ByIndex`, passed as values, and `Apply`'d. It is **not** "lambdas exist" — v5 already has lambdas as the arguments of higher-order collection methods (`map`/`filter`/`fold`/…).

The canonical feature (`LanguageSpecificationV6:1603`):

```
{ (xs: Coll[Int]) =>
    val inc = { (x: Int) => x + 1 }
    def apply(in: (Int => Int, Int)) = in._1(in._2)   // a function stored in a pair
    xs.map { (x: Int) => apply((inc, x)) }
}
```

The serialized MIR stores `inc` (a `FuncValue`) as element 1 of a `Tuple` typed `SPair(SFunc(SInt,SInt), SInt)`, `SelectField`s it back out, and `Apply`s it. That `SFunc`-inside-a-composite is the new wire shape, gated to V3+.

---

## 2. The reframe — what ergots already has (verified, not assumed)

ergots' evaluator landed first-class-function *machinery* in phase 2e and after:
- `FuncValue` → Lambda SValue (`eval/eval.ts:182`, `eval/func-value.ts`; Fixed(5)).
- `Apply` evaluates its `func` **expression** generically (`eval/eval.ts:102`, `eval/apply.ts`; Fixed(30) + ADD_TO_ENV(5)/arg), checks the result is a Lambda, invokes with arity check.
- `SelectField` / `ByIndex` / `Tuple` / immutable lexically-scoped `Env` with shadowing.
- SValues are **dynamically typed**, so a Lambda can already live inside a Tuple/Coll SValue, be selected out, and applied.

**Verification (live evidence, run via the `_santa.ts` conformance harness):** the SANTA `higher_order_lambdas.json` tree → `{ value: Coll[Int][2,3], cost: 408, error: null }` at ErgoTree v3 — **both exact**. At v2 → rejected (`errored`). No new eval code was needed for the happy path.

**The version gate is purely the `SFunc` type code.** `FuncValue`/`Apply` deserialize at every version (§ canonical sources); the only function-related gate is `SFunc` (112) at V3+ in `TypeSerializer`. ergots reproduces this in `validate-v6-types.ts` (`annotationsOf` walks `FuncValue.args[].tpe`; `containsV6Type` recurses `STuple.items`/`SColl.elem`/`SFunc` → rejects under `treeVersion < 3`). The v3-accept / v2-reject result above confirms it end-to-end for the canonical feature.

---

## 3. The adversarial surface (the consensus closure)

A consensus validator must match the JVM on **every** hand-crafted HOF input, not just compiler-produced ones (CLAUDE.md: the adversarial path carries equal weight). The full surface:

| Shape | JVM behavior (source) | ergots today | Action |
|---|---|---|---|
| Function in `SPair`/`STuple` | accept ≥v3 / reject <v3 (`SFunc` type-code gate) | **matches** (verified: v3 ✓ 408, v2 reject) | ✅ closed |
| Function in `SColl[SFunc]` | same `SFunc` gate | `ByIndex→SFunc→Apply` types fine; gate recurses `SColl.elem` | vector **A** (confirm value+cost) |
| Direct apply of bound/inline lambda (no `SFunc` code) | evals all versions (no gate) | evals (matches) | ✅ closed (source) |
| `Apply` of an `SAny`-typed func | accepts (well-typed in JVM) | **over-rejects**: `exprTpe(Apply)` throws `'apply-func-not-sfunc'` (`mir/expr-tpe.ts:73`) | **Fix 2** + vector **B** |
| `FunDef` (polymorphic `let f[T]=…`) | **accept + eval, all versions** | **under-rejects**: parse-reject (`wire/parse.ts:507`) | **Fix 1** + vector(s) |
| Currying / func-returning-func | recursive `Apply` | `exprTpe`/eval recurse; should match | vector **C** |

Two genuine divergences fall out: an **all-version under-accept** (`FunDef`) and a candidate **over-accept→reject** (`Apply` of `SAny`). Both are adversarial-only (no compiler emits them; the walker reached mainnet tip without hitting either), and both are closed below.

---

## 4. Fix 1 — `FunDef` parse + serialize + eval (the under-accept fork)

**Why it's a fork (~95% from canonical source):** `FunDef` is a `ValDef` with non-empty `tpeArgs` (`values.scala:922`). Its required `STypeVar` args (`ValDefSerializer:19` `require(len > 0)`) deserialize at **every** version (`STypeVar` un-gated, `TypeSerializer:122/202`). Nothing in the JVM main source validates `FunDef` out (it appears only in the serializer, the registration, and the opcode constant). `BlockValue.eval:996` casts every item to `ValDef`, evaluates `rhs`, binds `id → v`, and never inspects `tpeArgs`. So a hand-crafted `FunDef` tree **deserializes and evaluates at all tree versions** in the JVM; ergots parse-rejects it → under-accept fork at all versions.

**Fix (incremental — the type machinery already exists):**
- `wire/parse.ts`: replace the `OP_FUN_DEF (0xd7)` reject with a parse arm — read `id`, `nTpeArgs` (u8), `nTpeArgs` × `STypeVar` via the existing `parseSType` (`parse-stype.ts:250` already parses code 103), then `rhs` (existing `getValue`). Mirror `ValDefSerializer.parse`; populate the val-def type store with `rhs.tpe`.
- `mir/types.ts`: `ValDef` gains an optional `tpeArgs: STypeVar[]` (empty ⇒ serializes as `ValDef`/opcode `0xd6`; non-empty ⇒ `FunDef`/`0xd7`). The MIR `tag` stays `'ValDef'`; the opcode is chosen from `tpeArgs.length` on serialize, matching the JVM `companion`.
- `wire/serialize.ts`: round-trip — emit `FunDefCode` + `nTpeArgs` + each `STypeVar` (existing `serializeSTypeVar`, `serialize-stype.ts:306`) + `rhs` when `tpeArgs` is non-empty; otherwise the existing `ValDef` path. **Byte-roundtrip is load-bearing.**
- `eval/`: **no eval change** — `eval/val-def.ts` + `eval/block-value.ts` already bind a `ValDef`; a `tpeArgs`-carrying `ValDef` binds identically (type params are eval-irrelevant, exactly as `BlockValue.eval:996`).
- **All-version, NOT V3-gated** — matching the JVM (the opcode/`STypeVar` are version-agnostic). An `SFunc` *appearing inside* a `FunDef` (its `rhs` or arg types) stays caught by the existing `validate-v6-types` `SFunc`-type-code gate under `treeVersion < 3` — no new gate.

**Cost:** the bind charges the same `ADD_TO_ENV` (`FuncValue.AddToEnvironmentDesc`, FixedCost(5)) per `BlockValue` item as a `ValDef` (already implemented). No new cost; confirmed against the JVM-blessed `FunDef` vector.

---

## 5. Fix 2 — `exprTpe(Apply)` `SAny` relaxation (the over-reject candidate)

**Today:** `mir/expr-tpe.ts:66-79` throws `ExprTpeError('apply-func-not-sfunc')` when `exprTpe(e.func)` is not `SFunc` — **including `SAny`**. The sibling arms `ByIndex` (line 93) and `OptionGet` (line 128) instead **relax `SAny → SAny`** (the documented "PropertyCall cascade" convention while a method-return type is unresolved). So an `Apply` whose func is obtained from an `SAny`-cascading position (e.g. `ByIndex` on a method-call-typed coll) over-rejects where the JVM — which carries the concrete `SFunc` — accepts.

**Fix:** in the `Apply` arm, when `ft.tag === 'SAny'`, return `{ tag: 'SAny' }` (mirror `ByIndex`/`OptionGet`); keep the throw for any *other* non-`SFunc` tag (a genuinely malformed AST). **Value-only, zero cost.** Confirmed by adversarial vector **B** (a tree the JVM accepts whose `Apply.func` resolves to `SAny` in ergots).

> Open until vector B: whether such a tree is *reachable* (i.e. whether `exprTpe(Apply)` is actually invoked on an `SAny`-func node during a validation pass on a JVM-accepted tree). If B shows no reachable over-reject, Fix 2 reduces to a defensive no-op + a documented non-divergence. The relaxation is harmless either way (it only widens an internal throw to the same `SAny` the siblings already produce).

---

## 6. Cost model

No new cost logic. The canonical HOF tree's **408** is already the exact sum of ergots' existing per-op costs (`FuncValue` Fixed(5), `Apply` Fixed(30) + ADD_TO_ENV(5)/arg, `MapCollection` per-item, `ArithOp`, `SelectField`, `Tuple`, `ByIndex`). `FunDef`'s bind reuses the `BlockValue` `ADD_TO_ENV` cost. The `exprTpe` relaxation is value-only. **Every cost is verified against a JVM-blessed vector (§9), never asserted.**

---

## 7. Error handling

Target: **zero new `EvalError` codes.**
- Fix 1 *removes* a parse-reject (`FunDef`); eval reuses the `ValDef` path (no new code).
- Fix 2 *narrows* an existing `ExprTpeError` throw (keeps it for non-`SAny` non-`SFunc`).
The plan re-confirms no taxonomy change during implementation.

---

## 8. Wire / dispatch / type resolution

- `FunDef` opcode `0xd7` (215): parse + serialize (§4). `exprTpe` is unaffected — `ValDef.tpe = exprTpe(rhs)` already (`expr-tpe.ts:46-49`), independent of `tpeArgs`.
- No new dispatch entries, no new method-signature rows (HOF is structural, not a method).
- `validate-v6-types` unchanged (already covers `SFunc`-in-composite and `SFunc`-in-`FunDef`-`rhs`).

---

## 9. Test plan & conformance — the empirical-match gate (definition of done)

**P6 is not complete until ergots matches every JVM-blessed adversarial vector below — value + cost, accept *and* reject.** That gate *is* the adversarial-path closure.

1. **Happy-path lock-in:** promote `higher_order_lambdas.json` → `packages/ergoscript/test/fixtures/conformance/v6/` + a `test/conformance/cost-v6.test.ts` (the v6 analog of `cost-v5.test.ts`, reusing `_santa.ts`).
2. **v2-reject companion:** the same tree at `ergoTree: 2` must reject (the `SFunc`-in-`SPair` gate). Asserted via the harness (ergots-side, but SANTA blesses the "v5 fails" side too for symmetry).
3. **SANTA-blessed adversarial vectors** (authored → JVM-blessed value+cost, accept/reject):
   - **A** — function in `SColl[SFunc]` (store lambdas in a coll, `ByIndex`, apply).
   - **B** — `Apply` of an `SAny`-cascading func (probes Fix 2).
   - **C** — nested currying / func-returning-func (`Apply` of an `Apply` result).
   - **FunDef** — a polymorphic `let f[T]=…` tree at **multiple versions** (confirm accept + eval + the bind cost, all-version), plus a `FunDef`-in-`BlockValue` round-trip.
4. **Unit/red-green for the two fixes:** FunDef parse/serialize byte-roundtrip + eval; `exprTpe(Apply)` `SAny` relaxation.
5. Gate: `npm run build` clean, full suite green (node + jsdom), `tsc --noEmit` clean across all 4 packages.

**SANTA dependency:** vectors A/B/C/FunDef require JVM blessing (SANTA's jvm-blesser is the only `value+cost` oracle for hand-crafted v6 trees). The fixes are built source-first (§4 is ~95% closed); the blessed vectors are the **gate** that confirms them and the cost. If a blessed vector contradicts the source analysis (e.g. the JVM *does* reject `FunDef` somewhere), the fix is revised before P6 closes. The blessing ask is a separate request doc (§13).

---

## 10. Risks & residuals

- **FunDef ~95% (source), 100% on blessing.** Residual: a non-name-matching JVM validation, or a runtime edge with `STypeVar`-typed values. The blessed `FunDef` vector closes it; **do not land Fix 1 as "done" until that vector is green.**
- **Fix 2 reachability** — may be a no-op if no JVM-accepted tree drives `exprTpe(Apply)` to an `SAny` func (vector B decides). Harmless regardless.
- **Recursion via self-referential `FunDef`** is *not* a new fork: `BlockValue.eval` binds after evaluating `rhs`, so a `ValUse` of the still-unbound id fails identically in both the JVM and ergots (`'val-use-unbound'` / `cannot resolve`). Pinned by a test, not fixed.
- **No crypto path** in P6 — the CLAUDE.md crypto-confidence escalation doesn't apply; the consensus-correctness bar does, and §9's empirical gate meets it.

---

## 11. Scope

**IN:** `FunDef` parse/serialize/eval (Fix 1); `exprTpe(Apply)` `SAny` relaxation (Fix 2); conformance lock-in (happy + v2-reject); SANTA-blessed adversarial vectors A/B/C/FunDef; `facts/` + umbrella docs.
**OUT:** any eval-engine rewrite (unneeded); new HOF *methods* (none in v6); per-type additions / behavior changes / `allZK`/`anyZK` (P7); the broader v6 validation-harness wiring (P8) beyond this phase's `cost-v6.test.ts`.

---

## 12. `facts/` + docs updates (contract-first — Task 1 of the plan)

- `facts/ergoscript-eval.md`: record first-class-function support (functions in composites; the `SFunc`-type-code gate via `validate-v6-types`); the `FunDef` eval arm (eval-as-`ValDef`); the `exprTpe(Apply)` `SAny` relaxation; bump the eval-arm coverage count (`FunDef` added).
- `facts/ergoscript-wire.md`: `FunDef` opcode (`0xd7`) parse + serialize, `tpeArgs` as `STypeVar[]`.
- `docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`: P6 ledger entry → **done**, with the reframe note (eval engine already supported HOF; P6 = verification + 2 adversarial fixes + conformance).

---

## 13. SANTA request (drafted separately; shown for review before filing)

`~/projects/santa/prompts/ergots-v6-hof-vectors.md` (matching the existing `ergots-*.md` convention; OVERRIDES #18 cross-project edit — pre-authorized to add to the vector-request list, but the content is reviewed before filing):
- Bless value + cost (JVM `sigma-state-6.0.3`, v6) for shapes **A** (func-in-`Coll`), **B** (`Apply`-of-`SAny`), **C** (currying), and **FunDef** (multiple versions).
- Confirm the **FunDef deserialize + eval + serialize** behavior across versions (the empirical close of §4's ~95%).
- Confirm the composite-function **v5-reject** side.

---

## 14. Commit plan (local-only; no push until §9 gate green + explicit go)

Contract-first, small commits on `ergoscript-v6`:
1. `facts/` + umbrella ledger (Task 1).
2. Fix 1 — `FunDef` parse/serialize (+ byte-roundtrip tests).
3. Fix 1 — `FunDef` eval coverage (+ tests).
4. Fix 2 — `exprTpe(Apply)` `SAny` relaxation (+ test).
5. Conformance — `cost-v6.test.ts` + the promoted happy-path/v2-reject fixtures.
6. Conformance — the SANTA-blessed A/B/C/FunDef vectors (once blessed).
7. Close-out — umbrella status, SESSION_CONTEXT/HANDOFF, READMEs/API.md.

Push only after the full §9 gate is green **and** an explicit go (per the v6 push discipline).
