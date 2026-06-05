# ErgoScript v6 — P7a: per-type methods (`Box.getReg` / `Context.getVarFromInput` / `GroupElement.expUnsigned`)

**Status:** approved (2026-06-05; design approved in-session; adversarial spec review same day:
REVISE → fixed — 1 Important + 6 Minor precision findings applied, **0 Critical; all load-bearing
consensus claims verified-clean** with source cites).
**Phase:** v6 P7a — first slice of the decomposed P7. Remaining after P7a: P7b (behavior changes), P8 (validation).
**Branch:** `ergoscript-v6` (local-only per the v6 disposition; one PR to `master` at v6 delivery).
**Canonical source:** JVM `sigma-state` only (`~/projects/sigmastate-interpreter/`). sigma-rust is an optional
non-canonical cross-check — and is **known-divergent** on this slice's wire layer (see §2.3).

---

## 1. P7 decomposition and inventory close-out

The umbrella's P7 ("per-type additions + behavior changes + sigma reducers") bundles three unrelated buckets
and says "split further in its spec if large." Decomposed (user-agreed 2026-06-05):

- **P7a (this spec):** the three remaining per-type v6 methods.
- **P7b (own spec, next):** the version-gated behavior *changes* — `substConstants` v6 fix for tree version > 0
  (reconcile against the deferred A2-b serializer-level item) + `AvlTree.insert`/`insertOrUpdate` v6 semantics delta.
- **Sigma reducers (`allZK`/`anyZK`): DROPPED — nothing to build.** They are source-language
  `PredefinedFunc` sugar (`SigmaPredef.scala:79-92`) with **no opcode and no serializer** (zero hits in
  `sigma/serialization/`); `SigmaDsl.allZK`/`anyZK` are literally the eval bodies of the existing
  `SigmaAnd`/`SigmaOr` nodes (`trees.scala:135-140, 166-171`). Any on-chain form is a `SigmaAnd`/`SigmaOr`,
  which ergots already parses and evaluates (`eval.ts:204/206`, shipped 2g-combinators). User rule applied:
  only what can reach a serialized tree needs handling.

**Definitive per-type v6 inventory** (every version-gated method-set in `methods.scala`, swept 2026-06-05):

| Type | v6-only methods | Status |
|---|---|---|
| numeric ×5 | bitwise/shifts (`methods.scala:471-478`) | ✅ P1 |
| `SCollection` | reverse/startsWith/endsWith/get (`:1211-1216`) | ✅ P3 |
| `SBox` | `getRegMethodV6` id **19** (`:1367-1369`) | **P7a** |
| `SAvlTree` | `insertOrUpdateMethod` (`:1717`) | ✅ shipped (100:16, V3-gated) |
| `SContext` | `getVarFromInputMethod` id 12 (`:1773-1775`) | **P7a** |
| `SHeader` | `checkPowMethod` (`:1826`) | ✅ P4 (104:16) |
| `SBigInt` | `toUnsigned` 14 / `toUnsignedMod` 15 (`:546-565`) | ✅ P2c / P2d-1 |
| `SGlobal` | serialize 3 / deserializeTo 4 / fromBigEndianBytes 5 / encodeNbits 6 / decodeNbits 7 / powHit 8 / some 9 / none 10 (`:2001-2021`) | ✅ P4 / P5 |
| `SGroupElement` | `ExponentiateUnsignedMethod` id 6 (inline gate in its `getMethods()`) | **P7a** |

The umbrella's "`GroupElement.expUnsigned` — ergots already has this, V3-gated" was a **verified
inherited-framing error** (zero hits in `packages/ergoscript/src/`); corrected here. `SUnsignedBigInt`'s own
method set is ✅ P2.

---

## 2. `Box.getReg[T]` — MethodCall (typeId 99, methodId **19**)

### 2.1 The 7-vs-19 story (JVM, verified)

`methods.scala:1329-1347` declares **two** methods:

| | id | name | registered | explicit type args | eval route |
|---|---|---|---|---|---|
| `getRegMethodV5` | **7** | `"getRegV5"` | `commonBoxMethods` → **all versions** | **none** | `SMethod.javaMethod` fallback — JVM platform: real reflection `classOf[Box].getMethod("getRegV5", …)` → `NoSuchMethodException` (the trait declares only `getReg`, `SigmaDsl.scala:490`); JS platform: `ReflectionData` lacks it (only `"getReg"`, `:298`) → **eval-time throw on both platforms, every version** |
| `getRegMethodV6` | **19** | `"getReg"` | `v6Methods` only (`isV3OrLaterErgoTreeVersion`) | `Seq(tT)` — one serialized `T` | `javaMethodOf[Box, Int, RType[_]]("getReg")` → `CBox.getReg` |

This split is the fix for ScorexFoundation/sigmastate-interpreter#416: id 7 never serializes `T`, so the
register's expected type is unrecoverable from the wire — v6 adds id 19 carrying an explicit type arg.

**Literal-index lowering:** the compiler emits `OptionGet(ExtractRegisterAs(...))` for
`box.getReg[T](const)` (the blessed tree in `LanguageSpecificationV6.scala:1286-1294`). The MethodCall(19)
form appears for **dynamic** indices and hand-crafted trees. ExtractRegisterAs is long-shipped in ergots.

### 2.2 Eval semantics (= `CBox.getReg`, `CBox.scala:32-44`, exactly)

`CBox.registers` is a **fixed 10-slot array with nulls** for absent registers
(`CBox.regs`, `CBox.scala:77-91`: `new Array[AnyValue](ErgoBox.maxRegisters)`). Therefore:

1. Charge `FixedCost(JitCost(50))` (= `ExtractRegisterAs.costKind`, `transformers.scala:497-500`) —
   Pattern A, before any checks, consistent with the existing ExtractRegisterAs arm.
2. Operand-kind guard: obj must be `Box` (standard handler guard).
3. Arg: runtime `Int` index `i`. **`i < 0` or `i > 9` → `None`** (no throw — unlike the NODE's
   `'register-id-out-of-range'`, which only ever sees a parse-time byte; the method sees runtime values).
4. Absent register (incl. R4–R9 undefined) → `None`.
5. Defined register: `sTypeEquals(stored.tpe, T)` → `Some(value)`; **mismatch → throw**
   (JVM `InvalidType`, `CBox.scala:41`) — reuse the existing **`'register-type-mismatch'`** code.
   The NODE and the METHOD share this semantics (JVM `ExtractRegisterAs.eval` calls `inputV.getReg`,
   `transformers.scala:491-495`; ergots' arm already throws the same way, `extract-register-as.ts:144-152`).
6. Implementation reuses `getRegisterEntry` (`extract-register-as.ts`) — R0–R3 synthesis included.
7. `minVersion: 3` on the id-19 handler entry.

> ⚠️ The `methods.scala:1343-1346` doc-comment claims "None otherwise" for a wrong-typed register.
> **The code throws** (`CBox.scala:41`). Code wins; the doc-comment is wrong.

### 2.3 Wire fix (consensus-load-bearing)

`wire/mir/explicit-type-args.ts` currently maps **99:7 → ['T']** — transcribed from sigma-rust
(`sbox.rs` GET_REG), which diverges from the JVM here (same divergence class as the checkPow 0xdc/0xdb
lesson, `[[reference_zero_arg_method_wire_opcode]]`).

**Why it matters (dead-branch fork):** a JVM-shaped `MethodCall(99, 7, args)` carries **no** type-arg bytes.
ergots' current entry consumes one `SType` after the method body → mis-parse — typically a whole-tree
parse reject, and adversarially worse: the type-args tail is the node's **last** field, so a crafted tree
can re-align and parse successfully on BOTH sides into **different trees** (accept/accept with divergent
semantics). A pre-v3 or v6 tree with `MethodCall(99,7)` in a **dead branch** is *deserialize-accepted* by
the JVM (id 7 is registered at every version; the branch never evals) but *rejected* by ergots → fork.

**Fix:**
- Remove `7: ['T']` from the SBox block; add `19: ['T']`.
- `99:7` then parses as a plain MethodCall (zero type args — the registry's conservative default) and,
  having no handler, fails at eval with the existing `'method-not-implemented'` — matching the JVM's
  eval-time reflection throw at **every** version, live-branch. (Dead-branch: both sides accept.)
- Update the module-header provenance comment (the sigma-rust cross-refs for this entry are the trap).
- Sweep fixtures AND unit tests for `99:7` encodings. **Known hit:**
  `test/wire/method-call.test.ts:86-120` ("round-trips SELF.getReg[Int](4)") hard-codes the sigma-rust
  shape (99:7 + one SType byte) — rewrite as the 99:19 round-trip and add a 99:7 **zero**-type-args parse
  case. The mainnet claim stands (the walker reached tip without a 99:7 sighting).

---

## 3. `Context.getVarFromInput[T]` — MethodCall (typeId 101, methodId 12)

### 3.1 Wire

The existing `101:12 → ['T']` entry **matches the JVM** (`getVarFromInputMethod` declares `Seq(tT)`,
`methods.scala:1755-1765`). Zero wire change. Blessed tree shape: `MethodCall(ValUse(1, SContext),
getVarFromInputMethod, [ShortConstant, ByteConstant], {T → ...})` (`LanguageSpecificationV6.scala:1895-1902`).

### 3.2 Context-model extension (the one contract change)

JVM reads `spendingTransaction.inputs(inputIndex).extension` (`CContext.scala:76-83`). ergots' `EvalOpts`
carries input *boxes* (`inputs`) and **one** extension (SELF's). Extension data is per-input witness data —
not derivable from boxes.

**Additive optional field on `EvalOpts`/`EvalContext`:**

```ts
/** Per-input context extensions, indexed by SPENDING-TRANSACTION input
 *  position — mirrors JVM spendingTransaction.inputs(i).extension. May
 *  legitimately differ in length from `inputs` (the JVM's own blessed
 *  getVarFromInput vector has tx.inputs = 0 while ctx.inputs = 1) — never
 *  validate length equality. SContext.getVarFromInput (101:12) reads this.
 *  Absent ⇒ every lookup → None. */
inputExtensions?: ContextExtension[]
```

- **Faithfulness:** the positional array carries exactly the relation the JVM reads. An absent field is
  absent *data* (caller contract — same class as absent `inputs`/`dataInputs`), not a semantic divergence.
- **Invariant (documented, not enforced):** when both are supplied, `inputExtensions[selfIndex]` ≡
  `extension`. `getVar` (self) keeps reading `extension` — zero behavior change to the existing arm.
- `makeContext` passes it through like the sibling fields.

### 3.3 Eval semantics (= `CContext.getVarFromInput`, exactly)

1. Charge `FixedCost(JitCost(10))` (= `GetVar.costKind`, `transformers.scala:585-590`), Pattern A.
2. Operand-kind guard: obj must be `Context`.
3. Args: `Short` inputIdx, `Byte` varId.
4. `lift` semantics: idx `< 0` or `≥ inputExtensions.length` (or field absent) → `None`.
5. Missing var at that input → `None`.
6. Stored entry: `sTypeEquals(stored.tpe, T)` → `Some(value)`; **mismatch → `None`** — **never throws**.
7. `minVersion: 3`.

> The mismatch asymmetry is deliberate JVM behavior and a fork trap: self-`getVar` **throws**
> `InvalidType` on a wrong-typed var (`CContext.scala:61-75`), `getReg` **throws** (§2.2),
> `getVarFromInput` **returns None** (`CContext.scala:77-82`, `case _ => None`). Tests pin all three.

Blessed vectors: 4 `verifyCases` (`LanguageSpecificationV6.scala:1908-1916`) — missing input → `None`,
`Some(true)`, wrong-typed var → `None`, `Some(false)`.

---

## 4. `GroupElement.expUnsigned` — MethodCall (typeId 7, methodId 6)

- **JVM:** `ExponentiateUnsignedMethod`, `SFunc([SGroupElement, SUnsignedBigInt], SGroupElement)`, id 6,
  `Exponentiate.costKind` = `FixedCost(JitCost(900))` (`methods.scala:656-660`; `trees.scala:1042-1046`).
  v6-gated via the inline `if (isV3OrLaterErgoTreeVersion)` in `SGroupElementMethods.getMethods()`.
- **Impl semantics:** `CGroupElement.expUnsigned` is the **identical call** to `exp` —
  `CryptoFacade.exponentiatePoint(point, k)` (`CGroupElement.scala:22-26`) — only the scalar source
  differs (UBI's BigInteger, ∈ [0, 2²⁵⁶), instead of signed BigInt).
- **ergots:** there is no exported composite helper today — the arm's sequence is inline
  (`eval/exponentiate.ts:80-87`): `decodePoint` → identity-**base** guard (`base.is0()` → 33 zero bytes;
  noble `multiply` on the zero point is UB) → `pointMul` → `encodePoint`. **Extract a shared
  `expPoint(baseBytes, k)` covering all four steps** (the identity-base guard is mandatory) **and route
  both arms through it.** New handler: operand-kind guards (obj `GroupElement`, arg `UnsignedBigInt`),
  charge 900, `expPoint`, `minVersion: 3`. Monomorphic → **no explicit type args, zero wire change**.
- **Crypto-path escalation point (CLAUDE.md 95% bar):** scalar edges. The blessed vectors pin them —
  `g^1 = g`, `g^0 = identity`, `g^order = identity` (`LanguageSpecificationV6.scala:2475-2493`) — i.e.
  reduction mod the group order with zero → identity. Adversarial review verified the existing
  normalization covers the UBI range **unmodified**: `pointMul` (`crypto/secp256k1.ts:125-131`)
  short-circuits k=0 and k≡0 (mod n) to the zero point and reduces all else into [1, n−1];
  `encodePoint(ZERO)` → 33 zero bytes. JVM side is raw BC `ECPoint.multiply` with no extra range/sign
  handling (jvm `Platform.scala:105-111`; `CUnsignedBigInt` enforces [0, 2²⁵⁶) at construction). The
  three vectors are the gate; if implementation contradicts any of this, **stop and escalate** rather
  than hand-rolling a second path.

---

## 5. Cross-cutting

- **`mir/method-signatures.ts`** +3: `(99,19)` tDom `[SBox, SInt]`, tRange `SOption(tT)`, tpeParams `[T]`;
  `(101,12)` tDom `[SContext, SShort, SByte]`, tRange `SOption(tT)`, tpeParams `[T]`;
  `(7,6)` tDom `[SGroupElement, SUnsignedBigInt]`, tRange `SGroupElement` (closed).
  Explicit-type-arg substitution rides the P0 engine.
- **Registry 123 → 126.** **EvalError codes 81 → 81 (0 new):** reuse `'register-type-mismatch'`,
  `'method-not-implemented'`, `'tree-version-too-low'`, and the standard operand-guard codes.
- **facts/ is Task 1** (CLAUDE.md docs-pass rule): `facts/ergoscript-eval.md` registry table + the three
  semantics rows (incl. the §3.3 asymmetry note); `facts/ergoscript-wire.md` explicit-type-args correction
  (99:7 removed, 99:19 added, provenance note). README/API.md sweep at close-out.

---

## 6. Adversarial pins and the inherited residual

**Pinned by tests in this phase:**

1. `MethodCall(99,7)` — parses (no type-arg bytes), eval-throws `'method-not-implemented'` at **every**
   tree version (JVM parity: deserialize-accept + reflection eval-throw). Dead-branch occurrence
   parse-accepted (the §2.3 fix is what makes this hold). *≥1-arg form only:* the v3+ **empty-args** 0xdc
   variant is whole-tree-rejected on BOTH sides (JVM parse assert, `MethodCallSerializer.scala:53-55` /
   ergots `validateMethodCallArity`) — already covered by that pass's tests.
2. `MethodCall(99,19)` in a pre-v3 tree, live branch → `'tree-version-too-low'`.
3. getReg runtime index OOB (`-1`, `10`) → `None`; absent → `None`; wrong type → throw.
4. getVarFromInput totality: OOB input, missing var, wrong-typed var → `None`; never throws.
5. expUnsigned identity edges (`g^0`, `g^order`) + `g^1`.
6. The three-way mismatch asymmetry (§3.3) pinned side-by-side.
7. Wrong-arg-**type** / wrong-**arity** calls to the three methods: the JVM deserialize-accepts (no arg
   checks at parse — `mkMethodCall`/`specializeFor` don't validate) and eval-throws via reflection
   `IllegalArgumentException`; ergots parses and eval-throws via handler guards — reject-parity
   live-branch, accept-parity dead-branch. Pinned per method.

**Inherited residual (documented, NOT expanded here):** a v6-only method in a **dead branch** of a pre-v3
tree. JVM `SMethod.fromIds` is version-aware at **deserialize** → whole-tree reject; ergots' `minVersion`
gate fires at **eval** → dead branches escape. This residual is shared by every shipped v6 method
(P1–P6) — P7a's three follow the established pattern. Disposition: a future whole-tree
`validateMethodVersions`-style pre-eval pass (sibling of `validateV6Types`/`validateMethodCallArity`),
routed separately like P4's deferred arg-count sweep. Recorded in the umbrella ledger at close-out.

---

## 7. Validation

- **TDD per arm** (Iron Law); node + jsdom; `tsc --noEmit` all 4 packages; full monorepo suite green.
- **JVM-blessed values** hand-transcribed from the spec's `verifyCases` into unit tests now
  (getVarFromInput ×4, expUnsigned ×3; getReg's blessed case exercises the ExtractRegisterAs lowering —
  already-covered path, kept as a regression pin).
- **SANTA request at close-out** (the P6 pattern → `test/fixtures/conformance/v6/` + `cost-v6.test.ts`):
  byte-blessed vectors for (a) dynamic-index `getReg` via MethodCall(19), value + cost; (b) getVarFromInput
  4-case + cost; (c) expUnsigned 3-case + cost; (d) adversarial: a `99:7` tree (eval-reject parity, incl. a
  dead-branch accept case) and `99:19`-at-v2 reject.

---

## 8. Out of scope

- **P7b:** `substConstants` v6 fix (⟷ A2-b reconciliation) + `AvlTree.insert`/`insertOrUpdate` v6
  semantics delta — own spec.
- The dead-branch method-version pass (§6 residual).
- P8 conformance-harness wiring beyond the SANTA vectors above.

## 9. Risks

- **expUnsigned scalar normalization** (crypto path) — §4 escalation rule; blessed identity-edge vectors gate it.
- **99:7 removal** changes parse behavior for sigma-rust-shaped bytes; fixture sweep in §2.3 guards the suite.
- **Context contract addition** is optional/additive; only risk is caller-supplied inconsistency between
  `extension` and `inputExtensions[selfIndex]` — documented invariant, self-`getVar` semantics unchanged.
