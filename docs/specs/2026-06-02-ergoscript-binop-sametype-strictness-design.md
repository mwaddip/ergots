# Mismatched comparison/equality strictness — pre-eval type-check pass (JVM-align #2)

- **Date:** 2026-06-02
- **Status:** IMPLEMENTED 2026-06-02 — `eval/validate-bin-op-types.ts` pre-eval pass wired into `dispatchTreeBody`; typecheck clean, node 4153 / jsdom 3442 green, zero false positives on valid trees. Residual: the `SAny`-typed-operand dead-branch case (bounded by `exprTpe`).
- **Workstream:** JVM-alignment (`project_jvm_alignment_workstream`). The deferred half of the
  mismatched-numeric work; #1 (eval-time coercion, version-gated) landed in `a60bb12`.
- **Policy:** JVM `sigma-state` 6.0.3 is canonical. User chose the **faithful** option (reject the
  whole tree, dead branches included — matching the JVM's deserialize-time rejection).

## Problem (the residual after #1)

The JVM's deserializer runs a `check2(SameType)` constraint on **comparison** and **equality**
BinOps (and `check2(OnlyNumeric)` on comparison) — see `SigmaBuilder.scala`:
- `equalityOp` (679): `applyUpcast` (version-gated) → `check2(SameType)`.
- `comparisonOp` (689): `check2(OnlyNumeric)` → `applyUpcast` → `check2(SameType)`.
- `arithOp` (700): `applyUpcast` only — **no constraint check** (so arith is OUT of scope here).

`check2` throws `ConstraintFailed` at **deserialize** (`SigmaBuilder.scala:287`), killing the whole
tree before any evaluation — even if the offending node is in a never-evaluated branch.

After #1, ergots matches the JVM on the **evaluated** path for comparison (coerce pre-V3 / throw
V3+) but still diverges on:
1. **`Eq`/`NEq` cross-type** → ergots returns `false`; JVM rejects. Diverges **even when evaluated**
   (this is the meatier piece). Covers V3+ numeric-mismatch AND non-numeric mismatch (`EQ(Int, Boolean)`).
2. **Dead-branch** mismatched comparison/equality (V3+ numeric-mismatch, or non-numeric comparison)
   → JVM rejects the tree at parse; ergots, validating at eval, never sees the dead node.

Both are **adversarial-only** (the compiler always emits same-type operands; nothing honest/mainnet
hits this). The **walker cannot catch #2** — it validates ergots vs the sigma-rust WASM oracle, and
sigma-rust is *also* stricter-than-JVM here (returns `false` for cross-type `Eq`, doesn't reject), so
oracle≠JVM means the walker structurally can't surface it. #2 is JVM-conformance hardening,
validated by SANTA, not the walker.

## Design — pre-eval whole-tree validation pass (NOT `parseTree`)

A new pass `validateBinOpTypes(body)` walks the about-to-be-evaluated Expr tree and throws on a
mismatched comparison/equality node. Invoked from `dispatchTreeBody` (`eval/evaluate.ts`) — the single
chokepoint both eval paths converge on, which already runs whole-tree pre-passes
(`substituteConstants`, `substituteDeserialize`). Runs on the **post-substitution** body
(`rewrittenBody` in the deserialize branch, `tree.body` otherwise), **before** `tryTrivialReduce` /
`evalExpr` and **before any cost is charged** — so a rejected tree yields no value and **zero JIT
cost**, matching the JVM's pre-eval rejection (no cost-model / conformance-fixture impact).

**Why not `parseTree`:** the wire parser is deliberately permissive and round-trips type-mismatched
trees (`test/wire/option-ops.test.ts:23`); the byte-roundtrip invariant
`serializeTree(parseTree(b)) === b` is load-bearing. A pre-eval pass rejects the same trees the JVM
rejects (whole tree, dead branches included → same consensus outcome) without touching the wire
layer or that contract.

## The rule (per node, via `exprTpe`)

Let `lt = exprTpe(left)`, `rt = exprTpe(right)`. **If either is `SAny` → SKIP** (do not reject):
ergots' `exprTpe` is partial (unresolved MethodCall/PropertyCall returns cascade to `SAny`) while the
runtime value is concrete; rejecting on `SAny` would be a false positive that breaks valid trees —
the established policy (`reference_sany_type_checks_skip_not_fail`). This bounds faithfulness:
**ergots rejects only where it has concrete operand types.**

- **`Eq` / `NEq`**: if `sTypeEquals(lt, rt)` → OK. Else (types differ): allow iff **both numeric AND
  `treeVersion < 3`** (#1 coerces these at eval); otherwise **REJECT** with `'bin-op-kind-mismatch'`.
- **`Lt`/`Le`/`Gt`/`Ge`**: if either operand non-numeric → **REJECT** with `'bin-op-not-numeric'`
  (`OnlyNumeric`). Else if `sTypeEquals(lt, rt)` → OK. Else (both numeric, differ): `treeVersion < 3`
  → OK (#1 coerces); else **REJECT** with `'bin-op-kind-mismatch'`.
- **All other nodes** (Arith, Bit, Logical, …): no check.

Error codes **reused** (compact taxonomy): `'bin-op-kind-mismatch'` (SameType failure),
`'bin-op-not-numeric'` (OnlyNumeric failure) — the same codes the eval arms already raise for these
conditions. No new `EvalError` codes.

## Interaction with #1 and the existing eval arms

The pass **allows** pre-V3 numeric-mismatch (so #1's eval-time coercion still fires). The eval-arm
logic from #1 **stays** (defense-in-depth, and it handles `SAny`-skipped nodes that slip past the
pass — e.g. an `Eq` with an `SAny` operand still falls through to `sValueEquals` → cross-kind
`false`). So #2 is purely additive: a stricter pre-eval gate for the concretely-typed cases.

## Cost / hot-path note

The pass adds an O(nodes) walk per tree evaluation (honest mainnet txs included), for an
adversarial-only, walker-uncatchable gain. `exprTpe` is already used widely and is cheap; the walk is
one-time per proposition (not per eval-step) and charges no JIT cost. Acceptable; can be folded into
an existing walk later if it ever shows up in profiling. Flagged honestly because "faithful" here
taxes the honest path to reject hand-crafted trees.

## TDD plan

1. RED → GREEN, one behavior at a time:
   - `EQ(Int, Boolean)` v0 → REJECT `'bin-op-kind-mismatch'` (was `false`).
   - `EQ(Int, Long)` v3 → REJECT (was `false`); and the **dead-branch** case
     `If(false, EQ(Int,Long)==…, true)`-shaped tree at v3 → whole-tree REJECT (was: returns the live
     branch).
   - `Lt(Int, Boolean)` → REJECT `'bin-op-not-numeric'` (OnlyNumeric); `Lt(Int, Long)` v3 dead-branch
     → REJECT.
2. Regression (must still PASS — the pass must NOT reject these):
   - pre-V3 numeric-mismatch (`Plus`/`Lt`/`EQ(Int,Long)` v0) — #1 coercion path intact.
   - same-type ops (numeric and non-numeric: `EQ(Bool,Bool)`, `EQ(Coll[Byte],Coll[Byte])`, `Lt(Int,Int)`).
   - `SAny`-operand mismatch → NOT rejected (skipped) — a node whose operand `exprTpe` is `SAny`.
   - rejected tree charges **zero** cost (assert `ctx.jitCost === 0` on the throw).
3. `npm run typecheck` clean + full suite (node + jsdom). Confirm no regression on the existing
   3428-test ergoscript suite (the pass is cost-neutral for valid trees).

## SANTA / sigma-rust

The V3+ reject vectors requested in `prompts/santa-mismatched-numeric-coercion-vector.md` (§B) are
#2's oracle; add non-numeric-equality reject cases (`EQ(Int, Boolean)`) to that ask. sigma-rust is
also looser-than-JVM here (informational; no cherry-pick — the `integration/ergots` fork is frozen).

## Scope / non-goals

- Arith is OUT (no JVM `check2`). Bit/Logical out.
- Faithfulness is bounded by `exprTpe` completeness (the `SAny`-skip). Not closing that here — it's
  the same partial-resolver limitation tracked across the eval slice; widening `exprTpe` (the type-var
  substitution engine from A3's deferred follow-up) would tighten this pass for free later.
