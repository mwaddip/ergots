# Phase 2j-pre fix-3 — Atleast/Or/Xor exprTpe arms

**Status:** Draft v2 (2026-05-22). Reviewer pass applied.
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Add 3 missing arms (`Or`, `Xor`, `Atleast`) to `packages/ergoscript/src/mir/expr-tpe.ts`. Closes fix-list item 3 from 2j-pre. Library-side projection-only fix.

**Preceding phase:** 2j-pre fix-2 (genesis-box seeding; 12 commits on origin/master; HEAD `62f48ce`).
**Surfacing artifact:** `tools/mainnet-validate/findings/2026-05-22-fix-2-smoke.md` documents the smoke halt at h=3850 tx#2 input 0 on the foundation 2-of-3 multisig: `exprTpe: variant 'Atleast' not yet supported`.

---

## Goal

Resolve fix-list item 3 from the 2j-pre handoff. The `exprTpe` projection (a value-to-SType helper used by the wire layer and the evaluator's type-checking paths) has a 3-arm gap for logical/threshold connectives: `Or`, `Xor`, `Atleast`. The parser and serializer already handle these variants (`wire/mir/atleast.ts`, parse dispatch at `wire/parse.ts:235`); only the projection is missing. The foundation 2-of-3 multisig script reaches `Atleast` first; `Or`/`Xor` are grouped here because they're the same kind of gap at the same call site.

The fix is 3 one-liner case arms in `expr-tpe.ts`'s top-level switch, each returning the sigma-rust-canonical SType per `mir/{or,xor,atleast}.rs::tpe()`.

## Non-goals

- **No new opcode arms.** Parser/serializer/evaluator paths for Or/Xor/Atleast are already complete (parser at `wire/parse.ts:226-244` dispatches them; evaluator covered per `facts/ergoscript-sigma.md` 2g-combinators).
- **No structural change to `expr-tpe.ts`.** New arms slot into the existing `switch (e.tag)` block alongside the existing `case 'And':` at line 237.
- **No facts file changes beyond mentioning the resolved gap.** `facts/ergoscript-wire.md` already documents the `ExprTpeError` taxonomy (line 179: `'tpe-not-implemented'` is the throw for missing arms).
- **No fix for other potentially-missing arms.** The Expr discriminated union has 68 variants per `mir/types.ts`. `expr-tpe.ts` has 61 unique `case` labels, but 10 of those are sub-discriminators inside nested switches (`expr-tpe.ts:108-121` for `Const.kind` and `expr-tpe.ts:186-200` for `BinOp.kind`). Top-level Expr arms handled = 51. **Variants NOT handled (reviewer-pass M1 corrected count): 17 total** — `Atleast, BitInversion, CalcSha256, Context, CreateAvlTree, CreateProveDhTuple, Exponentiate, ExtractBytes, Global, MultiplyGroup, Or, SigmaPropIsProven, SubstConstants, TreeLookup, Xor, XorOf, ZkProofBlock`. After fix-3 closes Or/Xor/Atleast, **14 will remain**, of which 11 are dispatched by the wire parser (verified via grep on `wire/parse.ts`) and thus reachable from mainnet bytes. Particularly hot for mainnet validation: **`CalcSha256`, `ExtractBytes`, `SigmaPropIsProven`** — likely to surface in subsequent smoke walks. Closing those is out of scope for fix-3; each is its own fix-list item with the same one-arm shape.

## Motivation

Three reasons:

1. **The fix is trivial.** Sigma-rust's source is canonical and matches the existing pattern (`expr-tpe.ts:237-240` `case 'And': return SBoolean`). Three new arms each match exactly one source-line in sigma-rust.

2. **The misleading comment was right.** Line 239 of `expr-tpe.ts` says "Same for Or, Atleast (covered as needed)" — fix-2's smoke "needed" them. The comment author anticipated the gap; we close it.

3. **Foundation multisig is a high-value reach.** Foundation script trips Atleast at h=3850 tx#2 — only ~3849 blocks into mainnet. Without this fix, no further smoke progress is possible.

## Architecture

### Decision 1: Add 3 arms with sigma-rust source-mapped return types

| TS arm | sigma-rust source | Return SType |
|---|---|---|
| `case 'Or':` | `external/sigma-rust/ergotree-ir/src/mir/or.rs:tpe` | `SBoolean` |
| `case 'Xor':` | `external/sigma-rust/ergotree-ir/src/mir/xor.rs:tpe` | `SColl(SByte)` |
| `case 'Atleast':` | `external/sigma-rust/ergotree-ir/src/mir/atleast.rs:49-51` | `SSigmaProp` |

Insertion point: directly after the existing `case 'And':` arm (`expr-tpe.ts:237-240`). The 4 arms group naturally as logical/threshold connectives.

Note: `And` returns `SBoolean` (boolean-AND of `Coll[Boolean]`); `Atleast` returns `SSigmaProp` (sigma-protocol threshold composition of `Coll[SigmaProp]`). The comment at line 239 that lumps them ("Same for Or, Atleast") is misleading because Atleast has a DIFFERENT output type. T2's rewrite of the comment block makes this distinction explicit per-arm.

### Decision 2: Update the misleading comment at line 239

Current: `// AND-reduction of a Coll[Boolean]). Same for Or, Atleast (covered as needed).`

Rewrite to per-arm comments inline with each `case`, matching the file's style for adjacent arms (see e.g. `expr-tpe.ts:258-268` where `LogicalNot`, `CalcBlake2b256`, `SigmaPropBytes` each have their own `// sigma-rust ...` comment).

Reviewer Mi3 noted that the existing comment doesn't mention `Xor` at all; the rewrite-per-arm proposal closes that gap implicitly by giving each of the 3 new arms its own per-line comment.

### Decision 3: One synthetic test file covering all 3 new arms

Create `packages/ergoscript/test/expr-tpe.test.ts` (new file — no existing dedicated test for the projection helper). 3 simple unit tests:

- `exprTpe({ tag: 'Or', input: <SColl[SBoolean]> })` returns `{ tag: 'SBoolean' }`.
- `exprTpe({ tag: 'Xor', left: <SColl[SByte]>, right: <SColl[SByte]> })` returns `{ tag: 'SColl', elem: { tag: 'SByte' } }`.
- `exprTpe({ tag: 'Atleast', bound: <SInt>, input: <SColl[SSigmaProp]> })` returns `{ tag: 'SSigmaProp' }`.

The synthetic inputs use minimal valid sub-Exprs (e.g., `{ tag: 'Const', tpe: ..., value: ... }`); the test only verifies the top-level switch behavior, not deep nested evaluation.

### Decision 4: Layer-3 smoke re-run

After landing the fix, re-run the harness against the bootstrap-data snapshot from a fresh sidecar. Expected: walk advances PAST h=3850 (the Atleast halt site). New halt — if any — feeds the next fix-list item.

Decision 4 uses the existing seed/walk flow from fix-2 unchanged.

### Decision 5: Stale-comment cleanup is in scope; broader exprTpe gaps are NOT

Only the comment at line 239 changes (per Decision 2). Other potential gaps in `expr-tpe.ts` (5+ remaining unhandled Expr variants) are NOT addressed; they surface as future fix-list items only if a smoke reaches them.

## Error taxonomy

No new error codes. The fix REMOVES one reachable case of `ExprTpeError('tpe-not-implemented')` for `Atleast`/`Or`/`Xor` inputs (the code remains the default for the other ~5 unhandled tags).

## Test strategy

### Layer 1 — RED + GREEN unit test

New file `packages/ergoscript/test/expr-tpe.test.ts` with 3 tests (per Decision 3). Pre-fix: all 3 fail with `ExprTpeError('tpe-not-implemented')`. Post-fix: all 3 pass with the sigma-rust-mapped SType.

### Layer 2 — verification commands (OVERRIDES rule #6)

- `npx tsc --noEmit -p packages/ergoscript/tsconfig.json` — CLEAN.
- `node_modules/.bin/vitest run packages/ergoscript` — all pass + 3 new.
- Cross-runtime jsdom — clean.

### Layer 3 — smoke re-run

Re-run Layer 3 smoke from a FRESH sidecar at `/tmp/t-fix3-sidecar.redb` (avoid reusing fix-2's sidecar to ensure a clean walk). Document findings in `tools/mainnet-validate/findings/2026-05-22-fix-3-smoke.md`.

**Expected outcome (reviewer-pass M2 calibrated):** the walk advances PAST h=3850 (Atleast no longer halts the founders-multisig tx). However, given the 14 remaining unhandled exprTpe arms post-fix-3 (per Non-goals revised count) — including high-frequency mainnet variants like `CalcSha256`, `ExtractBytes`, `SigmaPropIsProven` — a new halt is LIKELY within a small number of blocks after 3850. The smoke's success criterion is "walks past h=3850," NOT "validates the chain"; any new halt is a fresh fix-list item, not a fix-3 regression.

If the smoke surprisingly reaches `--max-height` without halting, that's a stretch outcome worth documenting.

### Layer 4 — harness integration tests

The fix-2 T9 halt-path snapshot pinned the halt at h=3850 phase 'evaluate' errorCode 'evaluate-threw'. After fix-3, the halt either:
- Vanishes (smoke advances past h=3850 cleanly).
- Moves to a new site (different phase / height / code).

The halt-path snapshot needs refresh in either case (analogous to fix-2 T9).

## Source mapping to sigma-rust

| Rust source (pinned `integration/ergots`) | TS impact |
|---|---|
| `ergotree-ir/src/mir/or.rs::Or::tpe` | New TS arm `case 'Or': return { tag: 'SBoolean' }` |
| `ergotree-ir/src/mir/xor.rs::Xor::tpe` | New TS arm `case 'Xor': return { tag: 'SColl', elem: { tag: 'SByte' } }` |
| `ergotree-ir/src/mir/atleast.rs:49-51 (Atleast::tpe)` | New TS arm `case 'Atleast': return { tag: 'SSigmaProp' }` |

## Execution order

```
T1   Spec lands (this file) + PLAN.md committed
T2   Layer 1 RED — packages/ergoscript/test/expr-tpe.test.ts new file
     with 3 failing tests (Or, Xor, Atleast). Verify they fail with
     ExprTpeError('tpe-not-implemented').
T3   GREEN — add 3 arms to expr-tpe.ts; update misleading comment
     at line 239. Verify per OVERRIDES rule #6:
       - npx tsc --noEmit -p packages/ergoscript/tsconfig.json
       - vitest run (node + jsdom)
T4   Rebuild dist (npm run build) since harness uses dist.
T5   Layer 3 smoke re-run from FRESH sidecar; document findings.
T6   Refresh harness halt-path snapshot for new halt site (analogous
     to fix-2 T9).
T7   SESSION_CONTEXT + HANDOFF + memory refresh + push.
```

Expected commit count: ~7 (T1 PLAN + T2 RED + T3 GREEN + T5 smoke + T6 halt-path + T7 docs). T4 is `npm run build` against gitignored `dist/` — no commit.

## Risk hotspots

1. **`exprTpe` is called from multiple sites.** The fix doesn't break any callers (it ADDS handled cases; the default throw is preserved for unhandled tags). Mitigation: T3's full vitest re-run catches any regression in dependent test paths.

2. **The synthetic test inputs need valid sub-Exprs.** A test that constructs `{ tag: 'Atleast', bound: <bogus>, input: <bogus> }` would still trip the projection arm (which doesn't recurse into bound/input — the projection is just the outer type). Mitigation: use minimal valid Const sub-Exprs in the test inputs, but verify the assertion is on the TOP-level arm (no deeper recursion).

3. **The dist rebuild step (T4) is implicit.** Without rebuild, the harness's bundled library remains stale. T4 is explicit in the PLAN.

4. **Layer 3 smoke might surface a new halt deeper in the chain.** Expected — that's the natural progression. T6 refreshes the halt-path snapshot accordingly. If the smoke reaches `--max-height` cleanly (no new halt), the halt-path test's premise breaks and needs deeper rework.

5. **The 5+ other missing arms in expr-tpe.ts.** Out of scope per Decision 5, but each could surface a halt on a different mainnet box. The fix-list pattern continues until smoke reaches max-height.

## Confidence check (OVERRIDES #2 — crypto/cost path)

**Confidence: 98%.**

- Sigma-rust source is direct, 3 single-line `tpe()` impls.
- The TS arm structure is established (`case 'And':` exists at line 237).
- No new tests beyond the projection assertion. No new evaluator semantics.
- Verification via standard tsc + vitest commands.

**The 2% residual uncertainty:** the synthetic test inputs need to satisfy TypeScript's discriminated-union type-checks for `Atleast { bound: Expr; input: Expr }` etc. — if the test compiler complains about minimal sub-Expr shapes, that's a 5-minute fix.

**Escalation status:** none. Not a crypto-path phase; not a cost-path phase.

## Rollback plan

Single-revert per task. T3's 3-arm addition reverts cleanly; the default throw resumes. T5's findings file is doc-only.

## Future work (residual)

1. **Audit the remaining ~5 missing exprTpe arms.** Once smoke surfaces them, each is a similar one-line fix per sigma-rust source.

2. **`ExprTpeError` taxonomy promotion.** Currently `code: string` is not a literal union (per fix-1 reviewer C2). Future hardening to literal union would catch missing arms at compile time across all error classes — out of scope here.

## Reviewer findings applied (2026-05-22)

Spec was reviewed by a general-purpose reviewer subagent dispatched with the explicit instruction set: validate the 3 sigma-rust source-mapped return types, the TS Expr interface field-shapes, the "60 case arms vs 68 variants" math, the `case 'And':` insertion-neighborhood structural simplicity, the synthetic-test compilability, and the Layer 3 smoke success-criterion realism. Reviewer returned 0 ★★★ critical, 2 ★★ moderate, 4 ★ minor findings, and 1 verification gap (non-material).

**★★ Moderate findings (both folded inline):**

1. **M1 — "~5 OTHER arms remain missing" undercounts by ~9.** Actually 17 unhandled top-level Expr variants today; after fix-3 closes 3, **14 remain**; 11 of those are reachable via wire-parser dispatch. **Applied:** Non-goals section now lists the exact 17-variant set + the 11 parser-reachable ones + flags `CalcSha256`, `ExtractBytes`, `SigmaPropIsProven` as mainnet-hot.

2. **M2 — Layer 3 success criterion was overoptimistic.** "Walks past h=3850" is correct but framed as if the harness will walk freely afterward. **Applied:** Test strategy §Layer 3 now states "walks past h=3850 (founders multisig); new halt LIKELY within a small number of blocks given the 14 remaining gaps. Success criterion = 'walks past h=3850', NOT 'validates the chain'."

**★ Minor findings (acknowledged):**

1. **Mi1** — Line-anchored refs verified; no change needed.
2. **Mi2** — Comment-style example reference rewritten per reviewer suggestion (cites `expr-tpe.ts:258-268` instead of "lines 258-260 unary").
3. **Mi3** — Existing comment doesn't mention `Xor`. Decision 2 already addresses (per-arm comments cover all 3 new arms). Noted in Decision 2.
4. **Mi4** — fix-2 smoke-findings file references `wire/expr-tpe.ts` (wrong path; actual is `mir/expr-tpe.ts`). T7 (docs sweep) should correct.

**Verification gaps:** non-material (just confirms tsc invocation path is canonical).

Confidence: 98% on fix mechanics holds (sigma-rust source verified line-by-line; TS interfaces match). The reviewer noted that confidence on the SMOKE'S broader outcome is lower (~70-75%; new halt likely shortly after 3850), but that's not a fix-3 correctness concern.

Recommendation: REVISE → SHIP.

## Cross-references

- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/mir/or.rs` — Or::tpe source.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/mir/xor.rs` — Xor::tpe source.
- `~/projects/ergots/external/sigma-rust/ergotree-ir/src/mir/atleast.rs:49-51` — Atleast::tpe source.
- `~/projects/ergots/packages/ergoscript/src/mir/expr-tpe.ts:237-240` — current `case 'And':` arm (insertion point).
- `~/projects/ergots/packages/ergoscript/src/mir/types.ts:475-479` — Atleast interface (`bound: Expr; input: Expr`).
- `~/projects/ergots/packages/ergoscript/src/wire/mir/atleast.ts` — existing parse/serialize.
- `~/projects/ergots/tools/mainnet-validate/findings/2026-05-22-fix-2-smoke.md` — surfacing artifact.
- `~/projects/ergots/docs/specs/2026-05-22-mainnet-validate-fix-2-genesis-box-seeding-design.md` — preceding fix-2 spec.
