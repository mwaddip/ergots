# ErgoScript v6 (ErgoTree V3) — P3: Coll v6 methods

**Date:** 2026-06-03
**Status:** approved shape (brainstorm); plan + TDD pending
**Branch:** `ergoscript-v6`
**Phase:** P3 of the v6 umbrella (`docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`)
**Scope owner:** `@ergots/ergoscript`
**Canonical source:** JVM `sigma-state` (`~/projects/sigmastate-interpreter/`) — the **sole** v6 oracle. No sigma-rust dependency, no Rust `fixture-gen`.

---

## 1. Context and framing correction

The umbrella's P3 ledger lists eight items — `find`, `reverse`, `startsWith`,
`endsWith`, `get`, `getOrElse`(lazy), "bitwise", "diff". **Source verification
against the canonical JVM reduces this to exactly four real methods.**

`SCollectionMethods.getMethods()` (`data/shared/src/main/scala/sigma/ast/methods.scala:1221-1227`)
returns `v6Methods` when `VersionContext.current.isV3OrLaterErgoTreeVersion`,
else `v5Methods`. The two lists differ by exactly:

```scala
private val v6Methods = v5Methods ++ Seq(
  ReverseMethod, StartsWithMethod, EndsWithMethod, GetMethod
)   // methods.scala:1211-1216
```

The dropped items, with their disposition (verified):

| umbrella item | reality | citation |
|---|---|---|
| `find` | **Not in v6.0** — `// TODO v6.0` placeholder (GitHub #479), wired only as a `newFeature` equality-check that runs *below* v6 activation. | `LanguageSpecificationV6.scala:1316-1330` |
| "bitwise" (`Coll[Boolean] >> 2`) | **Not in v6.0** — `// TODO v6.0` placeholder (GitHub #418). | `LanguageSpecificationV6.scala:1332-1349` |
| "diff" | **Not in v6.0** — `// TODO v6.0` placeholder (GitHub #479). | `LanguageSpecificationV6.scala:1351-1365` |
| `getOrElse`(lazy) | **`Coll.getOrElse` is a v5 method** (`GetOrElseMethod`, id 2, in `v5Methods`); the lazy-default `getOrElse` is **`Option.getOrElse` (P4)**, not Coll. | `methods.scala:1193, 824-833` |

Implementing `find`/`bitwise`/`diff` would be the inverse fork — adding methods
the reference does **not** have. Per the consensus-correctness mandate
(`CLAUDE.md`; `feedback_adversarial_path_equal_weight`), the faithful action is to
implement exactly the four the JVM gates behind V3.

**Side-finding (out of scope, recorded — no action): `Coll.getOrElse` (12:2) is
not a gap.** The JVM lowers it via a custom IR builder to a `ByIndex` node with
`Some(default)` (`methods.scala:826-830`, `mkByIndex(obj, index, Some(default))`) —
not a `MethodCall`. ergots already mirrors this: `ByIndex` carries an optional
`default` (`mir/types.ts:567`), the wire layer parses it, and `evalByIndex`
returns the default on OOB *including the V3+-lazy / pre-V3-eager split*
(`eval/coll-by-index.ts:77-94`). Fully covered.

---

## 2. Scope

**In:** four new `MethodCall` handlers on `SCollection` (typeId 12), method ids
30–33, gated to ErgoTree version ≥ 3; their static return-type signatures; their
JIT cost. Purely additive — **no existing-arm behavior changes** (v6 only appends
to the Coll method list; it does not modify any v5 Coll method).

**Out:** `find` / `bitwise` / `diff` (not in v6.0); `Option.getOrElse`-lazy and
`Global.some`/`none` (P4); any wire-format change (see §7 — none is needed).

---

## 3. The four methods

All four: typeId **12** (`SCollection`), `minVersion: 3` at the dispatcher,
cost charged inside the handler after the dispatcher has pre-evaluated `obj` +
`args` (the established non-lambda method-handler shape, identical to `zip` /
`patch` / `updated`).

### 3.1 `reverse` (12:30)
- **JVM:** `ReverseMethod` (`methods.scala:1126-1129`); eval `reverse_eval`
  (`:1135-1141`) = `addSeqCost(costKind, xs.length){ xs.reverse }`.
- **Signature:** `Coll[IV] → Coll[IV]` (`SFunc(Array(ThisType), ThisType, paramIVSeq)`).
- **Cost:** `Append.costKind` = `PerItemCost(20, 2, 100)` (`methods.scala:1124` →
  `transformers.scala:74-75`), charged on the **receiver** length.
- **Eval:** return the items reversed, same element type. Empty → empty.
  Result SValue: `{ kind: 'Coll', elem: obj.elem, items: [...obj.items].reverse() }`.
- **Return typing:** generic `Coll[IV]` → **P0 substitution** (`IV` ← receiver elem).
- **Errors:** receiver not `Coll` → `'method-not-implemented'` (defensive, SColl
  MethodCall convention — see §6; the dispatcher pre-evaluates `obj`).
- **Blessed values:** `LanguageSpecificationV6.scala:2242-2265`
  (`Coll(1,2)→Coll(2,1)`; `Coll[Int]()→Coll[Int]()`).

### 3.2 `startsWith` (12:31)
- **JVM:** `StartsWithMethod` (`methods.scala:1145-1149`); eval `startsWith_eval`
  (`:1155-1161`) = `addSeqCost(costKind, xs.length){ xs.startsWith(ys) }`.
- **Signature:** `(Coll[IV], Coll[IV]) → Boolean` (`SFunc(Array(ThisType, ThisType), SBoolean, paramIVSeq)`).
- **Cost:** `Zip_CostKind` = `PerItemCost(10, 1, 10)` (`methods.scala:1102-1103, 1143`),
  charged on the **receiver** (`xs`) length — *not* the prefix `ys`.
- **Eval:** `true` iff `xs.length ≥ ys.length` and `xs[i] == ys[i]` for
  `i ∈ [0, ys.length)`, via a **cost-free structural comparison**
  (`sValueStructuralEq`, see §8.2) — **NOT** the costed `sValueEquals`. Result:
  `{ kind: 'Boolean', value }`. **Cost is the single `Zip_CostKind` envelope only;
  the element comparison charges nothing** (the JVM's `Coll.startsWith` is an
  uncosted Scala op — see §4 / §8.2).
- **Return typing:** closed `SBoolean` (no substitution needed).
- **Errors:** receiver or arg not `Coll` → `'method-not-implemented'` (§6 convention).
- **Blessed values:** `LanguageSpecificationV6.scala:2267-2302`
  (`(1,2,3).startsWith(1,2)→true`; `(1,2,3).startsWith(1,2,4)→false`;
  `().startsWith()→true`).

### 3.3 `endsWith` (12:32)
- **JVM:** `EndsWithMethod` (`methods.scala:1165-1169`); eval `endsWith_eval`
  (`:1175-1181`) = `addSeqCost(costKind, xs.length){ xs.endsWith(ys) }`.
- **Signature:** `(Coll[IV], Coll[IV]) → Boolean`.
- **Cost:** `Zip_CostKind` = `PerItemCost(10, 1, 10)` (`methods.scala:1163`),
  charged on the **receiver** length.
- **Eval:** `true` iff `xs.length ≥ ys.length` and the last `ys.length` elements
  of `xs` equal `ys` element-wise (`xs[xs.length - ys.length + i] == ys[i]`), via
  the **cost-free** `sValueStructuralEq` (§8.2). Result: `{ kind: 'Boolean', value }`.
  **Cost is the single `Zip_CostKind` envelope only.**
- **Return typing:** closed `SBoolean`.
- **Errors:** receiver or arg not `Coll` → `'method-not-implemented'` (§6 convention).
- **Blessed values:** `LanguageSpecificationV6.scala:2304-2338`
  (`(1,2,3).endsWith(1,2)→false`; `(1,2,3).endsWith(2,3)→true`; `().endsWith()→true`).

### 3.4 `get` (12:33)
- **JVM:** `GetMethod` (`methods.scala:1183-1189`), `.withIRInfo(MethodCallIrBuilder)`
  (stays a `MethodCall`, unlike `getOrElse`); `ByIndex.costKind`.
- **Signature:** `(Coll[IV], Int) → Option[IV]`
  (`SFunc(Array(ThisType, SInt), SOption(tIV), Array[STypeParam](tIV))`).
- **Cost:** `ByIndex.costKind` = `FixedCost(30)` (`transformers.scala:285`).
- **Eval (total — never throws on the index):** `0 ≤ i < length ? Some(items[i]) : None`.
  Result SValue: `{ kind: 'Option', elem: obj.elem, value: inBounds ? items[i] : null }`
  (`null` = `None`, per `mir/types.ts:867`).
- **Return typing:** generic `Option[IV]` → **P0 substitution** (`IV` ← receiver elem).
- **Errors:** receiver not `Coll` → `'method-not-implemented'`; index arg not `Int`
  → `'method-not-implemented'` (§6 convention — matches `patch`'s arg checks).
  **No OOB error** — out-of-range / negative return `None`.
- **Blessed values:** `LanguageSpecificationV6.scala:2340-2371`
  (`(Coll(1,2),0)→Some(1)`; `(Coll(1,2),-1)→None`; `(Coll(1,2),2)→None`;
  `(Coll[Int](),0)→None`).

---

## 4. Cost model

All cost constants above are **verified JVM values** and cross-checked against
ergots' existing arms:

| cost kind | JVM value | existing ergots use | match |
|---|---|---|---|
| `Append.costKind` (→ reverse) | `PerItemCost(20, 2, 100)` | `eval/coll-append.ts:28-30` (`20, 2, 100`) | ✓ |
| `Zip_CostKind` (→ startsWith/endsWith) | `PerItemCost(10, 1, 10)` | `SColl.zip` handler `method-call.ts:496` (`10, 1, 10`) | ✓ |
| `ByIndex.costKind` (→ get) | `FixedCost(30)` | `COLL_BY_INDEX_COST = 30` (`coll-by-index.ts:42`) | ✓ |

**`PerItemCost` chunk formula (ergots `addPerItemCost`, JVM-aligned since
`f99aaff`):** `chunks = max(0, trunc((n − 1) / chunkSize) + 1)`;
`cost = baseCost + perChunkCost × chunks` (JVM `CostKind.scala:26`). Note `n = 0`
yields 1 chunk (the JVM n=0 alignment already landed).

**Doc-bug found during verification (fold into the facts/ Task):**
`facts/ergoscript-eval.md`'s phase-2f changelog records the `Append`/`Slice` arms
as `chunkSize 128`. The **code is 100** (`coll-append.ts:30`, `coll-slice.ts`) —
matching JVM `Append.costKind`/`Slice.costKind` (`transformers.scala:74-75, 106-107`).
Only the `Xor` arm legitimately uses 128 (`eval/xor.ts:47`). The facts doc is
wrong; correct it to 100 in the facts/ update.

**Per-test cost totals** must include, beyond the method cost: the `MethodCall`
dispatcher envelope `FixedCost(4)`, and a flat `evalConst` cost of `5` per literal
operand (the P2c "process-find" lesson — `Const` evals and the dispatcher envelope
are easy to omit). Worked examples (receiver/args as `Const` nodes):

- `Const(Coll[Int](1,2)).reverse` → `5 (Const) + 4 (dispatcher) + [20 + 2×1] (reverse, n=2) = 31`.
- `Const(Coll(1,2,3)).startsWith(Const(Coll(1,2)))` → `5 + 5 + 4 + [10 + 1×1] (n=3) = 25`.
- `Const(Coll(1,2)).get(Const(0))` → `5 + 5 + 4 + 30 (Fixed) = 44`.

**No hidden second cost term (load-bearing).** `startsWith`/`endsWith` charge the
**single** `Zip_CostKind` envelope and nothing else — the element comparison is
**cost-free**. The JVM's `startsWith_eval`/`endsWith_eval` wrap a plain
`xs.startsWith(ys)` / `xs.endsWith(ys)` inside one `addSeqCost(Zip_CostKind, xs.length)`
(`methods.scala:1158, 1178`); `Coll.startsWith`/`endsWith` are pure Scala
array comparisons that take no evaluator and charge no JIT cost. This is the
opposite of `indexOf` (`indexOf_eval`, `methods.scala:1080-1099`), which routes a
**per-comparison** equality cost via `DataValueComparer` — which is exactly why
ergots' `indexOf` handler uses the *costed* `sValueEquals`. For `startsWith`/`endsWith`
ergots must use a **cost-free** structural comparison (§8.2); the §4 worked total
(`…startsWith… = 25`) reflects Zip-only and would be wrong if per-element `EQ_*`
cost leaked in. A regression cost test pins this (§10).

**Cost oracle:** the `LanguageSpecificationV6` `verifyCases` shown pin *values*
only (the cost slot is `None`); costs are derived from the verified JVM
`CostKind`s + ergots' established `MethodCall` dispatch cost model (validated to
mainnet tip + the SANTA v5 conformance suite). SANTA's JVM-blessed v6 vectors are
the eventual independent cost cross-check at **P8**.

---

## 5. Static return typing — `mir/method-signatures.ts`

Four new entries (consulted by `exprTpe` for `MethodCall` nodes). `reverse` and
`get` have type-var `tRange` → resolved by the P0 substitution engine; `startsWith`
and `endsWith` are closed `SBoolean`. `SCOLL_IV` already exists (`method-signatures.ts:58`).

```ts
// SColl.reverse — methods.scala:1126 — SFunc([Coll[IV]] → Coll[IV]). v6 P3; generic tRange.
[key(12, 30), { tDom: [SCOLL_IV], tRange: SCOLL_IV, tpeParams: [{ name: 'IV' }] }],
// SColl.startsWith — methods.scala:1145 — SFunc([Coll[IV], Coll[IV]] → Boolean). v6 P3; closed tRange.
[key(12, 31), { tDom: [SCOLL_IV, SCOLL_IV], tRange: { tag: 'SBoolean' }, tpeParams: [{ name: 'IV' }] }],
// SColl.endsWith — methods.scala:1165 — SFunc([Coll[IV], Coll[IV]] → Boolean). v6 P3; closed tRange.
[key(12, 32), { tDom: [SCOLL_IV, SCOLL_IV], tRange: { tag: 'SBoolean' }, tpeParams: [{ name: 'IV' }] }],
// SColl.get — methods.scala:1183 — SFunc([Coll[IV], Int] → Option[IV]). v6 P3; generic tRange.
[key(12, 33), {
  tDom: [SCOLL_IV, { tag: 'SInt' }],
  tRange: { tag: 'SOption', elem: { tag: 'STypeVar', name: 'IV' } },
  tpeParams: [{ name: 'IV' }],
}],
```

**Dual-table sync invariant** (the static `tRange` must equal the handler's
runtime element type): `reverse` static `Coll[IV→recv.elem]` = handler's
`{ elem: obj.elem }`; `get` static `Option[IV→recv.elem]` = handler's
`{ kind:'Option', elem: obj.elem }`; `startsWith`/`endsWith` static `Boolean` =
handler's `{ kind:'Boolean' }`. ✓

---

## 6. Error taxonomy — zero new codes

| condition | code | provenance |
|---|---|---|
| receiver not `Coll` (all 4) | `'method-not-implemented'` | **SColl MethodCall convention** (zip/patch/indices/updated/updateMany all use it for defensive kind checks — 2g.5 compact taxonomy) |
| `startsWith`/`endsWith` arg not `Coll` | `'method-not-implemented'` | same convention |
| `get` index not `Int` | `'method-not-implemented'` | same convention (matches `patch`'s non-Int arg check, `method-call.ts:563`) |
| pre-V3 tree invokes any of the four | `'tree-version-too-low'` | dispatcher `minVersion` (2h-c.2) |

**Convention note (verified during planning):** the existing SColl *MethodCall*
handlers reuse `'method-not-implemented'` for non-`Coll`-receiver / wrong-arg-kind
defensive throws (e.g. `method-call.ts:489-492, 547-550, 562-566`) — **not**
`'coll-input-not-coll'` (which is the *Expr-arm* convention via `extractCollItems`).
P3 follows the MethodCall convention for uniformity with its siblings (these checks
are unreachable on type-checked trees; the code is internal and doesn't affect
consensus accept/reject — any throw = reject). `get` OOB/negative is **not** an
error (returns `None`). **P3 adds zero new EvalError codes** (recount the base from
source during the facts/ Task — §9/§11).

---

## 7. Wire format — no change

`MethodCall` is parsed generically: `typeId` (u8), `methodId` (u8), `obj` (Expr),
a **length-prefixed `Vec<Expr>`** of args (`r.readVlqU()` count), then a tail of
zero-or-more explicit-type-arg `SType`s (`wire/mir/method-call.ts:119-144`). The
arg count is on the wire, so no per-method arity table is needed.

The explicit-type-arg tail is non-empty only for methods whose type var **cannot
be inferred from the receiver/args** — `getReg[T]`, `getVarFromInput[T]`,
`deserialize[T]`, `fromBigEndianBytes[T]`, `none[T]` (`EXPLICIT_TYPE_ARG_NAMES`,
`method-call.ts:84-96`). The JVM serializes a method's `explicitTypeArgs`, which
defaults to `Nil` (`SMethod.scala:74, 326`) and is documented as "type parameters
which require explicit serialization … (deserialize[T], getVar[T], getReg[T])"
(`SMethod.scala:60-61`). `reverse`/`startsWith`/`endsWith`/`get` do **not** declare
it — their `IV` appears in `tDom` (the `Coll[IV]` receiver) and is inferred — so
nothing extra is serialized. They parse correctly under the existing path with the
conservative `?? []` default, exactly like P0's generic `patch` (12:19). **No wire
task.**

---

## 8. Faithfulness decisions (load-bearing)

1. **Cost charges on the receiver length** for all three `PerItemCost` methods —
   including `startsWith`/`endsWith`, which charge on `xs.length` (the haystack),
   *not* the prefix/suffix `ys` (`methods.scala:1158, 1178`). A naive
   "charge on the compared length" would diverge.

2. **Element comparison is COST-FREE and structural; no strict elem-type pre-check.**
   Two load-bearing sub-decisions:
   - **(a) Cost-free comparison (consensus-cost-critical).** The JVM charges only
     the one `Zip_CostKind` envelope; `Coll.startsWith`/`endsWith` compare elements
     with plain Scala `==` and charge **no** JIT cost (§4). ergots therefore must
     **NOT** use the costed `sValueEquals` (which charges `EQ_PRIM`/`EQ_BIGINT`/…
     per element/node, `relation.ts:380-449`) — that would over-charge and fork.
     Add a **cost-free structural-equality helper** `sValueStructuralEq(a, b): boolean`
     with the *same boolean semantics* as `sValueEquals` (cross-kind → `false`;
     primitives by value; `GroupElement`/`SigmaProp` byte-equal; `Coll`/`Tuple`/`Option`
     recurse) but **zero** `ctx.addCost` calls and **no** version-gated numeric
     coercion (that coercion is BinOp-`Eq`-specific and lives in the `Eq` arm, not
     in element comparison). To avoid logic drift from `sValueEquals`, factor a
     shared cost-free core that `sValueEquals` layers cost onto (preferred), or pin
     a corpus test asserting the two agree on the boolean across all SValue kinds.
   - **(b) No strict elem-type gate.** The JVM `SFunc` unifies both operands to the
     same `IV`; at eval it just compares. We deliberately **do not** add a strict
     `SType` elem-match gate: it would false-reject `SAny`-typed operands
     (`reference_sany_type_checks_skip_not_fail`), and the JVM has no such gate at
     eval. A hand-crafted mismatched-elem `startsWith`/`endsWith` reaches eval and
     returns `false`/non-match — benign, because `sValueStructuralEq` preserves the
     cross-kind → `false` rule (so the §8 residual stays benign).

3. **`get` is total** — negative and out-of-range indices return `None`, never
   throw (`LanguageSpecificationV6.scala:2340-2371`).

4. **Version gate via the dispatcher `minVersion: 3`** — pre-V3 trees reject with
   `'tree-version-too-low'` before the handler runs, via the established mechanism
   (`SHeader.checkPow`, `SAvlTree.insertOrUpdate`, the P1 numeric methods). No
   per-handler version branch.

### Documented residual (adversarial-only; not closed in P3)
A hand-crafted `MethodCall` with mismatched arg element types (e.g.
`Coll[Int].startsWith(Coll[Long])`) is type-incorrect; the JVM may reject it at
deserialization (type unification of the `MethodCall` signature), whereas ergots'
wire parser is permissive and `validateBinOpTypes` covers only `Relation`/`Eq`
nodes, not `MethodCall` arg types. ergots reaches eval and returns a benign
`false`/non-match. This is the **same residual class** as the existing permissive
`MethodCall`-arg acceptance (and the SAny dead-branch residual of JVM-align #2):
honest, compiler-produced trees never hit it, and closing it needs a general
pre-eval `MethodCall`-arg-type pass — genuinely broad work, deferred (consistent
with `CLAUDE.md`: accept a residual only when closing it needs broad work). Flagged
for the P8 validation pass; not a P3 deliverable.

---

## 9. Implementation layout (recommendation)

- **New module `eval/scoll-v6.ts`** — the four handler functions (mirrors the P1
  `eval/_numeric-v6.ts` precedent; keeps the already-large `method-call.ts` lean).
  Exports the handlers + a small registration array.
- **Cost-free structural equality** (§8.2a) — `sValueStructuralEq(a, b): boolean`,
  alongside `sValueEquals` in `eval/bin-op/relation.ts` (or a small
  `eval/_svalue-eq.ts` extracted from it). Used by `startsWith`/`endsWith`.
  **Preferred shape:** factor the structural recursion into a cost-free core that
  `sValueEquals` wraps with cost, so there is one source of truth for the boolean.
- **`eval/method-call.ts`** — register the four `(12, 30..33)` handlers with
  `minVersion: 3`.
- **`mir/method-signatures.ts`** — the four signature entries (§5).
- **`eval/errors.ts`** — unchanged (zero new codes).
- **No wire files touched** (§7).

**Counts: P3 delta is +4 method handlers, +0 EvalError codes.** Do **not** carry
the prior docs' base tallies forward unverified — the spec reviewer's source count
(~111 registry handlers, ~69 `EvalErrorCode` members) diverges from the docs'
"110 / 73", i.e. the base figures have drifted. **Recount both from source ground
truth during the facts/ Task (§11)** and write the true base + delta.

---

## 10. Testing strategy

TDD against the JVM-blessed `verifyCases` for **values**, with **costs** computed
from the verified `CostKind`s (§4):

- Per method: the blessed cases from §3 (incl. the empty-collection and
  boundary/negative-index cases) as value assertions.
- Per method: at least one **cost** assertion against the computed total (the §4
  worked examples are the templates).
- **Cost-free-comparison regression (§8.2a, locks the Finding-1 fix):** a
  multi-element *matching* `startsWith`/`endsWith` must equal the Zip-only total
  with NO per-element `EQ_*` added — e.g. `Const(Coll(1,2,3)).startsWith(Const(Coll(1,2,3)))`
  = `5 + 5 + 4 + [10 + 1×1]` = **25**, *not* `25 + 3×EQ_PRIM`. Use a BigInt-element
  case too (where leaked cost would be `EQ_BIGINT`=5/elem — a louder signal).
- **Generic-output coverage** (`reverse`, `get`): a test asserting the static
  return type resolves to the concrete receiver elem (P0 path) — e.g. an empty
  `Coll[Int].reverse` stays `Coll[SInt]` (not `Coll[SAny]`), and
  `Coll[Long].get(i)` types as `Option[SLong]`. Mirrors the A3/flatMap empty-input
  typing tests.
- **Wire roundtrip**: parse → serialize a real `MethodCall(12, 30..33, …)` tree
  byte-identically (confirms §7's no-wire-change claim end to end).
- **Version gate**: a pre-V3 tree invoking each method throws `'tree-version-too-low'`.
- **Adversarial**: wrong-kind receiver/arg → the §6 codes; `get` OOB/negative →
  `None` (not throw).

Gate (per CLAUDE.md): `tsc --noEmit` clean across all four packages; full suite
green under **both** node and jsdom.

---

## 11. facts/ + umbrella updates (the plan's Task 1, contract-first)

- **`facts/ergoscript-eval.md`**: new "Phase v6 P3 — Coll v6 methods" changelog
  entry; method-handler registry table +4 rows (12:30 reverse, 12:31 startsWith,
  12:32 endsWith, 12:33 get). **Recount the registry size and `EvalErrorCode` count
  from source** (the docs' "110 / 73" appear to have drifted from the actual
  ~111 / ~69 per the reviewer) and record the true base + the P3 delta (+4 handlers,
  +0 codes). **Correct the phase-2f `Append`/`Slice` chunkSize from 128 → 100**
  (the doc bug from §4); leave the legitimate 128s (`CalcBlake2b256`, `Xor`) alone.
- **`facts/ergoscript-wire.md`**: no change (no new wire slice) — optionally note
  that the four v6 Coll methods declare no explicit type args.
- **`docs/specs/2026-06-02-ergoscript-v6-umbrella-design.md`**: update the P3
  ledger entry — status → DONE, and replace the informal 8-item goal with the
  verified four (note `find`/`bitwise`/`diff` are JVM-confirmed not-in-v6.0, and
  `Coll.getOrElse` is v5 / already covered via `ByIndex`).

---

## 12. Risks

Low. No crypto path, no new error codes, no wire change, no new cost constants
(all three cost kinds are already in use and JVM-verified). The two genuine care
points are (a) charging cost on the **receiver** length (§8.1) and (b) the P0
generic-return typing for `reverse`/`get` (already exercised by `patch`). Both are
covered by explicit tests.
