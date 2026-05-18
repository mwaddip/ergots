# `facts/ergoscript.md` Split Implementation Plan

**Status: ✅ COMPLETE 2026-05-18** (facts/ergoscript.md split from 1,203 lines into meta hub (94 lines) + 3 slice files: ergoscript-wire.md (207), ergoscript-eval.md (352), ergoscript-sigma.md (139). CLAUDE.md reads-list updated. One deep-link in packages/ergoscript/API.md redirected to the wire slice. All other cross-references are vague and continue to land on the meta hub via its lookup table. Total facts/ content compressed ~34% via deduplication. No code, test, or fixture changes; no broken refs.)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `facts/ergoscript.md` (currently 1,203 lines after phase 2g.6) into a meta file (~150 lines) plus three per-slice contract files (`facts/ergoscript-wire.md`, `facts/ergoscript-eval.md`, `facts/ergoscript-sigma.md`), aligned with the umbrella spec's `/wire` / `/eval` / `/sigma` subpath-export plan.

**Architecture:** Three sequential phases, each producing one or more commits. Phase 1 creates the three new slice files by extracting content from `ergoscript.md` (no deletions yet — duplication is intentional and temporary). Phase 2 trims `ergoscript.md` to the meta + lookup table. Phase 3 updates cross-references in `CLAUDE.md`, the ergoscript package README/API/PLAN, and the ~14 design specs that deep-link to specific sections.

**Tech Stack:** Markdown only. No code changes, no test changes, no fixture changes. Verification via `wc -l`, `grep`, and manual content review.

**Reference oracles:**
- Design spec: `/home/mwaddip/projects/ergots/docs/specs/2026-05-18-facts-ergoscript-split-design.md` (the authoritative source for this plan)
- Current file: `/home/mwaddip/projects/ergots/facts/ergoscript.md` (1,203 lines; the source material)
- Sister contract: `/home/mwaddip/projects/ergots/facts/proof.md` (196 lines; structural reference for the meta file's shape)
- Section structure (from `grep '^##\? ' facts/ergoscript.md`):
  - Line 1: Header
  - Line 19: `## Scope`
  - Line 576: `## Public surface`
  - Line 631: `#### verifySignature(...)` (the sigma surface section)
  - Line 654: `### Internal modules (current monorepo surface)`
  - Line 695: `### Round-trip invariant`
  - Line 707: `## Type invariants`
  - Line 767: `## Determinism and purity`
  - Line 773: `## Browser-compat guarantees`
  - Line 784: `## Error taxonomy` (wire errors: ErgoTreeParseError, ErgoTreeSerializeError)
  - Line 822: `## Test plan summary`
  - Line 831: `## v0.2.0 — Evaluator surface (phase 2b)` (the giant eval section)
  - Line 900: `### EvalError taxonomy (v0.2.0)`
  - Line 1140: `### VerifyError taxonomy (phase 2g-medium + 2g-combinators; 8 codes total)`
  - Line 1188: `### Coverage and stability`
  - Line 1195: `## Cross-references`

**Out of scope (per design spec § Non-goals):**
- Code or behavior change (`packages/ergoscript/src/` is untouched)
- Splitting `facts/proof.md` (it's 196 lines, comfortably within bounds)
- Splitting the npm package itself (one published package stays)
- Preemptively creating `facts/ergoscript-avl.md` or `facts/ergoscript-cost.md` (each future phase creates its own slice file)
- Rewriting / copy-editing existing content (the split is mostly extraction)
- Updating cross-refs in every existing spec — only deep-link refs naming moved sections (vague refs stay; they land on the meta hub)

---

## File structure

**Created in this phase:**

```
ergots/
└── facts/
    ├── ergoscript-wire.md            NEW (Task 1): phase 2a wire-format slice
    ├── ergoscript-eval.md            NEW (Task 2): phases 2b-2g.6 eval surface
    └── ergoscript-sigma.md           NEW (Task 3): phase 2g sigma-protocol verifier
```

**Modified in this phase:**

```
ergots/
├── facts/
│   └── ergoscript.md                 MODIFIED (Task 4): trim to ~150 lines (meta + lookup table)
├── CLAUDE.md                         MODIFIED (Task 5): update reads-first list
├── packages/ergoscript/
│   ├── README.md                     MODIFIED (Task 6, if deep-refs exist): update slice pointers
│   ├── API.md                        MODIFIED (Task 6, if deep-refs exist): update slice pointers
│   └── PLAN.md                       NOT modified (it now holds THIS plan; will be overwritten at next phase)
└── docs/specs/*-ergoscript-*.md      MODIFIED (Task 7, ~14 files): update deep-link refs only
```

---

## Phase 1: Create the three new slice files

Three independent tasks; each produces one new file plus one commit. The source material lives in `facts/ergoscript.md` and is too large to Read in one call (~43k tokens), so each task reads its source section(s) by offset/limit.

### Task 1: Author `facts/ergoscript-wire.md`

**Files:**
- Source: `facts/ergoscript.md` (read sections by line range)
- Create: `facts/ergoscript-wire.md`

**Content extraction map (from `facts/ergoscript.md`):**
- Lines 1-18: header pattern (don't copy verbatim — author a slice-specific header)
- Lines 19-575: `## Scope` and wire-format material
- Lines 576-630: `parseTree` / `serializeTree` / address helpers from `## Public surface`
- Lines 695-706: `### Round-trip invariant`
- Lines 784-821: `## Error taxonomy` — extract ONLY `ErgoTreeParseError` and `ErgoTreeSerializeError` (eval/sigma error classes go to their respective slices)

**Cross-cutting NOT to copy** (these stay in the meta file in Phase 2):
- Lines 767-783: `## Determinism and purity` + `## Browser-compat guarantees` (cross-cutting; meta-file scope)
- Lines 822-830: `## Test plan summary` (cross-cutting; meta-file scope)

- [ ] **Step 1: Read the wire-format source sections**

Run: `cd /home/mwaddip/projects/ergots && wc -l facts/ergoscript.md`
Expected: `1203 facts/ergoscript.md`

Read lines 1-100, 100-200, ..., chunked through 575 to absorb the Scope section.
Then read lines 576-720 to absorb Public surface (wire parts) + Round-trip invariant.
Then read lines 784-821 to absorb the wire-side error taxonomy.

- [ ] **Step 2: Author `facts/ergoscript-wire.md`**

Create the file with this structure (compose the body from the extracted material, retaining wording):

```markdown
# `@mwaddip/ergots-ergoscript` — Wire Format Contract

This file documents the **wire-format slice** of the `@mwaddip/ergots-ergoscript`
boundary contract. For cross-cutting guarantees (browser-compat, determinism, ESM-only,
no-WASM, runtime deps) and forward pointers to other slices, see [`facts/ergoscript.md`](./ergoscript.md).

## Scope

[Insert the wire-format-relevant subset of the original Scope section. The original
Scope at lines 19-575 covers a lot of ground; pull only what concerns parse/serialize/address.]

## Public surface

### `parseTree(bytes)`
[From lines 603-608]

### `serializeTree(tree)`
[From lines 609-614]

### `isP2PK(tree)` / `p2pkPublicKey(tree)`
[From lines 615-621]

### `addressFromErgoTree(tree, network)` / `ergoTreeFromAddress(address)`
[From lines 622-630]

## Types

`ErgoTree` and `TreeHeader` are defined here (the wire layer's primary output shape).
The discriminated-union types `SValue` / `SType` / `Expr` are shared across the
wire and eval surfaces — their canonical definitions live in
[`ergoscript-eval.md`](./ergoscript-eval.md). `parseTree` returns an `ErgoTree`
containing an `Expr` body and `SValue[]` constants.

### `interface ErgoTree`
[Extract from lines 707-766 — only the ErgoTree and TreeHeader interfaces;
SValue/SType/Expr go to the eval slice]

## Round-trip invariant

[From lines 695-706]

## Error taxonomy

### `class ErgoTreeParseError extends Error`
[Extract from lines 784-821 — only ErgoTreeParseError]

### `class ErgoTreeSerializeError extends Error`
[Extract from lines 784-821 — only ErgoTreeSerializeError]

## Coverage

100% of MIR variants parse and serialize byte-identically against the PR 862 corpora
(45 legacy + 14 ecosystem + 9 sig-15 = 68 trees) plus mainnet boxes (12,712 from
Task B's wider corpus + 173 from the original C2 corpus).

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting
- [`facts/ergoscript-eval.md`](./ergoscript-eval.md) — evaluator surface (shared types live there)
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`) — byte-format oracle
```

The `[Insert ...]` and `[Extract from ...]` markers tell you what to fill in from the source. Keep exact wording where possible; this is extraction, not rewriting.

- [ ] **Step 3: Verify the file**

Run: `wc -l /home/mwaddip/projects/ergots/facts/ergoscript-wire.md`
Expected: somewhere in the 300-500 line range (large enough to hold the wire surface; smaller than the full original).

Run: `grep -c '^##\? ' /home/mwaddip/projects/ergots/facts/ergoscript-wire.md`
Expected: at least 6 (Scope, Public surface, Types, Round-trip invariant, Error taxonomy, Coverage, Cross-references).

- [ ] **Step 4: Commit**

```bash
git -C /home/mwaddip/projects/ergots add facts/ergoscript-wire.md
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs(facts): create facts/ergoscript-wire.md — phase 2a wire-format slice

Per the facts/ergoscript.md split design (5da8289): extracts the
wire-format surface (parseTree, serializeTree, address helpers, ErgoTree
types, round-trip invariant, ErgoTreeParseError/SerializeError) into its
own slice contract.

Does NOT yet remove content from facts/ergoscript.md — duplication is
intentional during the multi-phase split. Phase 2 trims the meta file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Author `facts/ergoscript-eval.md`

**Files:**
- Source: `facts/ergoscript.md` (read sections by line range)
- Create: `facts/ergoscript-eval.md`

**Content extraction map:**
- Line 631: `#### verifySignature(...)` — SKIP; this goes to ergoscript-sigma.md (Task 3)
- Lines 654-694: `### Internal modules` — extract only the eval-related modules; defer sigma modules to Task 3
- Lines 707-766: `## Type invariants` — extract the `SValue` / `SType` / `Expr` definitions (this slice owns them per the spec's "shared types policy"; also extract any other eval-side interfaces)
- Lines 831-899: `## v0.2.0 — Evaluator surface (phase 2b)` — the public exports + EvalContext / EvalOpts
- Lines 900-1139: `### EvalError taxonomy (v0.2.0)` — all 43 codes
- The method-handler registry content (per phase 2g.5 + 2g.6) — locate via `grep -n 'method-handler' facts/ergoscript.md` or `grep -n 'HANDLERS' facts/ergoscript.md`; should be in the v0.2.0 section near line 1000-1100
- Eval-arm coverage table — locate via `grep -n 'arm' facts/ergoscript.md` or `grep -n 'coverage' facts/ergoscript.md`
- Lines 1188-1194: `### Coverage and stability` — extract eval-specific coverage; cross-cutting summary stays in meta

- [ ] **Step 1: Read the eval source sections**

Read in chunks: 707-830 (types + browser-compat boundary), then 831-1000, then 1000-1140, then 1188-1203.

- [ ] **Step 2: Author `facts/ergoscript-eval.md`**

Create the file with this structure:

```markdown
# `@mwaddip/ergots-ergoscript` — Evaluator Surface Contract

This file documents the **evaluator slice** of the `@mwaddip/ergots-ergoscript`
boundary contract (phases 2b through 2g.6). It also serves as the canonical home
for the `SValue` / `SType` / `Expr` discriminated unions, which are produced by
the wire layer (see [`ergoscript-wire.md`](./ergoscript-wire.md)) and consumed
across the package.

For cross-cutting guarantees (browser-compat, determinism, etc.) see
[`facts/ergoscript.md`](./ergoscript.md). For the sigma-protocol verifier see
[`facts/ergoscript-sigma.md`](./ergoscript-sigma.md).

## Public surface (v0.2.0)

### `evaluate(tree, opts?)`
[From lines 868-874]

### `evaluateWith(tree, ctx)`
[From lines 875-880]

### `makeContext(opts?)`
[From lines 881-886]

## Interfaces

### `interface EvalOpts`
[Extract from lines 831-867 + any later additions; should include jitCostLimit,
constants, treeVersion, height, selfBox, inputs, outputs, preHeader, extension, dataInputs]

### `interface EvalContext extends EvalOpts`
[Methods: addCost, addPerItemCost — from lines 887-899]

## Type invariants

### `type SValue`
[Extract the discriminated union from lines 707-766; should include Boolean, Byte,
Short, Int, Long, BigInt, GroupElement, SigmaProp, Box, AvlTree, Unit, Context,
Global, Coll, Tuple, Option, Lambda, PreHeader (the last two are the post-2g.5
and post-2g.6 additions respectively)]

### `type SType`
[Extract from lines 707-766]

### `type Expr` (~80 variants, partial coverage of 52)
[Extract the union definition; defer per-variant detail to the coverage table below]

## Error taxonomy

### `class EvalError extends Error` (43 codes)
[Extract from lines 900-1139 — all 43 codes with brief descriptions]

## Eval arm coverage (52 of ~70)

[Table or list, organized by phase:
- Phase 2b (consts + chassis): Const, ConstPlaceholder, BlockValue, ValDef, ValUse, Tuple, Collection, If
- Phase 2c (operators): BinOp, LogicalNot, BoolToSigmaProp, ...
- Phase 2d (conditionals/blocks/lambdas): If, FuncValue, Apply, ...
- Phase 2e (box/context model): GlobalVars, SelfBox, ExtractAmount, ExtractScriptBytes, ...
- Phase 2f (Coll HOFs): Map, Filter, Fold, Exists, ForAll, SizeOf, ByIndex, Slice, Append
- Phase 2g (sigma helpers): Atleast, SigmaAnd, SigmaOr, CreateProveDlog, CreateProveDhTuple
- Phase 2g.5 (method-call dispatch): MethodCall, PropertyCall, Context, SigmaPropBytes
- Phase 2g.6 (broader methods): Global
Pull the exact arm list from the source; this is illustrative.]

## Method-handler registry (8 entries)

[Per the 2g.5 + 2g.6 facts updates. List each by (typeId, methodId) → method name +
cost pattern + brief semantics. The 8 entries are:
1. SBox.tokens (99, 8) — Pattern A cost 15
2. SContext.dataInputs (101, 1) — Pattern A cost 15
3. SColl.indexOf (12, 26) — Pattern B addPerItemCost(20, 10, 2, n)
4. SGlobal.groupGenerator (106, 1) — Pattern A cost 10
5. SColl.zip (12, 29) — Pattern B addPerItemCost(10, 1, 10, n)
6. SColl.indices (12, 14) — Pattern B addPerItemCost(20, 2, 16, n)
7. SContext.preHeader (101, 3) — Pattern A cost 15
8. SPreHeader.timestamp (105, 3) — Pattern A cost 10
Pull the exact wording from the corresponding section in the source file.]

## Coverage and stability

[From lines 1188-1194 — eval-specific portion only]

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format
- [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) — sigma-protocol verifier
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec
- `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` — method-call dispatcher
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — most recent eval phase
```

- [ ] **Step 3: Verify the file**

Run: `wc -l /home/mwaddip/projects/ergots/facts/ergoscript-eval.md`
Expected: 600-800 lines (this is the biggest slice; contains the 43-code EvalError taxonomy and the method-handler registry).

Run: `grep -c '^##\? ' /home/mwaddip/projects/ergots/facts/ergoscript-eval.md`
Expected: at least 8 sections (Public surface, Interfaces, Type invariants, Error taxonomy, Eval arm coverage, Method-handler registry, Coverage and stability, Cross-references).

Run: `grep -c '###' /home/mwaddip/projects/ergots/facts/ergoscript-eval.md`
Expected: at least 5 sub-sections.

- [ ] **Step 4: Commit**

```bash
git -C /home/mwaddip/projects/ergots add facts/ergoscript-eval.md
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs(facts): create facts/ergoscript-eval.md — phases 2b-2g.6 eval surface

Per the facts/ergoscript.md split design (5da8289): extracts the evaluator
public surface (evaluate, evaluateWith, makeContext), EvalContext/EvalOpts
interfaces, the 43 EvalError codes, SValue/SType/Expr discriminated unions
(canonical home; wire slice cross-refs here), eval arm coverage (52/~70),
and the 8-entry method-handler registry into its own slice contract.

The growth surface for future phases (2h adds AVL+ methods, 2i adds predef
arms) — those phase specs extend this file directly rather than the meta hub.

Does NOT yet remove content from facts/ergoscript.md — duplication is
intentional during the multi-phase split. Phase 2 trims the meta file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Author `facts/ergoscript-sigma.md`

**Files:**
- Source: `facts/ergoscript.md` (read sections by line range)
- Create: `facts/ergoscript-sigma.md`

**Content extraction map:**
- Line 631: `#### verifySignature(...)` (the sigma verifier public surface)
- Lines 654-694: `### Internal modules` — extract only the sigma-related entries (the GF(2^192) module, the secp256k1 adapter, fiat-shamir, prop-bytes, verifier internals)
- Lines 1140-1187: `### VerifyError taxonomy (phase 2g-medium + 2g-combinators; 8 codes total)`
- `SigmaBoolean` discriminated union — locate via `grep -n 'SigmaBoolean' facts/ergoscript.md`; the 6-variant union (TrivialProp, ProveDlog, ProveDhTuple, Cand, Cor, Cthreshold) is defined somewhere in the file
- Any other sigma-specific public types

- [ ] **Step 1: Read the sigma source sections**

Read lines 631-700 (verifySignature + internal modules), then 1140-1200 (VerifyError).

Locate `SigmaBoolean` via grep:
```bash
grep -n 'SigmaBoolean\|interface.*SigmaBoolean\|type.*SigmaBoolean' /home/mwaddip/projects/ergots/facts/ergoscript.md
```

Read whichever range contains the canonical definition.

- [ ] **Step 2: Author `facts/ergoscript-sigma.md`**

Create the file with this structure:

```markdown
# `@mwaddip/ergots-ergoscript` — Sigma-Protocol Verifier Contract

This file documents the **sigma-protocol verifier slice** of the
`@mwaddip/ergots-ergoscript` boundary contract (phases 2g-medium and
2g-combinators). It covers the public `verifySignature` entry point, the
`SigmaBoolean` discriminated union, the `VerifyError` taxonomy, and a
pointer to the internal helpers.

For cross-cutting guarantees see [`facts/ergoscript.md`](./ergoscript.md).
For the evaluator surface (which produces `SigmaProp` SValues consumed by
`verifySignature`) see [`facts/ergoscript-eval.md`](./ergoscript-eval.md).

## Public surface (phase 2g)

### `verifySignature(sigmaBoolean, message, signature)`
[From line 631 onward — pull the full signature, parameters, return value,
guarantees, and any throws documentation]

## Types

### `type SigmaBoolean` (6 variants)
[Extract the discriminated union: TrivialProp, ProveDlog, ProveDhTuple, Cand,
Cor, Cthreshold. Each variant's fields. Where this type comes from (produced
by EvalSValue.SigmaProp; consumed by verifySignature).]

## Error taxonomy

### `class VerifyError extends Error` (8 codes)
[From lines 1140-1187 — all 8 codes with brief descriptions]

## Internal helpers (not part of the public contract)

[From the lines 654-694 portion that's sigma-related. Brief one-line per module:
- `eval/sigma/fiat-shamir.ts` — Fiat-Shamir challenge construction
- `eval/sigma/prop-bytes.ts` — SigmaBoolean → bytes serialization
- `eval/sigma/verifier.ts` — the verifySignature core
- `crypto/gf2_192.ts` — GF(2^192) module for Cthreshold polynomial interpolation
- `crypto/secp256k1.ts` — @noble/curves adapter for ProveDlog / ProveDhTuple

These are not part of the public contract but useful for understanding the
implementation. See `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md`
and `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` for design rationale.]

## Coverage

Full SigmaBoolean verifier surface: TrivialProp, ProveDlog, ProveDhTuple leaf
verification (phase 2g-medium), plus Cand/Cor/Cthreshold conjecture-walk
verification (phase 2g-combinators). 8 VerifyError codes total.

## Cross-references

- [`facts/ergoscript.md`](./ergoscript.md) — meta + cross-cutting
- [`facts/ergoscript-wire.md`](./ergoscript-wire.md) — wire format
- [`facts/ergoscript-eval.md`](./ergoscript-eval.md) — evaluator (produces `SigmaProp` SValues)
- `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` — leaf-verifier design
- `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` — conjecture-verifier design
```

- [ ] **Step 3: Verify the file**

Run: `wc -l /home/mwaddip/projects/ergots/facts/ergoscript-sigma.md`
Expected: 100-200 lines (this is the smallest slice; sigma-protocol surface is narrow).

Run: `grep -c '^##\? ' /home/mwaddip/projects/ergots/facts/ergoscript-sigma.md`
Expected: at least 5 sections (Public surface, Types, Error taxonomy, Internal helpers, Coverage, Cross-references).

- [ ] **Step 4: Commit**

```bash
git -C /home/mwaddip/projects/ergots add facts/ergoscript-sigma.md
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs(facts): create facts/ergoscript-sigma.md — phase 2g sigma verifier slice

Per the facts/ergoscript.md split design (5da8289): extracts the sigma-protocol
verifier surface (verifySignature, SigmaBoolean 6-variant union, 8 VerifyError
codes, internal-helper module pointers) into its own slice contract.

Does NOT yet remove content from facts/ergoscript.md — duplication is
intentional during the multi-phase split. Phase 2 trims the meta file.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2: Trim `facts/ergoscript.md` to the meta + lookup table

### Task 4: Trim `facts/ergoscript.md`

**Files:**
- Modify: `facts/ergoscript.md`

**What stays in the meta file (~150 lines target):**
- Header / scope statement (one paragraph: what this package is)
- Cross-cutting guarantees (browser-compat, determinism, ESM-only, no-WASM, runtime deps) — from lines 767-783 of the original
- Package shape (one paragraph; subpath strategy "none initially")
- Error-model overview (one paragraph: typed error classes per surface with structural `code` fields — points to slice files for the specific codes)
- Test-corpus layout (one paragraph naming C1/C2/C3.a layers — from lines 822-830)
- Coverage summary table (one row per slice)
- "Where to find what" lookup table (forward pointers to slice files)
- Cross-references to `docs/specs/` umbrella and the three slice files

**What gets removed (now lives in the slice files):**
- Lines 19-575 (Scope — much of this is wire-specific): trimmed to a one-paragraph scope statement
- Lines 576-694 (Public surface, Internal modules): removed (slice files own these)
- Lines 695-706 (Round-trip invariant): removed (wire slice)
- Lines 707-766 (Type invariants): removed (eval slice)
- Lines 784-821 (Error taxonomy — wire side): removed (wire slice)
- Lines 831-1187 (v0.2.0 evaluator + EvalError + VerifyError + everything): removed (eval + sigma slices)
- Lines 1188-1194 (Coverage and stability): replaced with the new summary table

- [ ] **Step 1: Read the current meta-relevant sections**

Read lines 1-30 (header + scope opening), 767-830 (cross-cutting + test plan), 1188-1203 (coverage + cross-refs).

- [ ] **Step 2: Verify the slice files contain everything**

Run:
```bash
wc -l /home/mwaddip/projects/ergots/facts/ergoscript-*.md
```

Expected: three files exist (wire, eval, sigma). Sum of lines + new meta target (~150) should be roughly equal to original 1,203 + some redundancy (each slice has its own header / cross-refs section, adding ~50 lines total of new boilerplate).

- [ ] **Step 3: Replace `facts/ergoscript.md` with the trimmed meta version**

Use the Write tool to overwrite `facts/ergoscript.md` with this content:

```markdown
# `@mwaddip/ergots-ergoscript` — Interface Contract (Meta)

This is the **meta hub** for the `@mwaddip/ergots-ergoscript` boundary contract.
Cross-cutting guarantees (browser-compat, determinism, package shape) live here.
For surface-specific contracts (public API, types, error codes), see the slice
files below.

## Scope

[One-paragraph scope statement. Pull the essential framing from the original
lines 19-30 — "pure-TypeScript port of sigma-rust's ergotree-ir + ergotree-interpreter,
validated byte-for-byte and value-for-value." Drop the per-section detail; it
lives in the slice files now.]

## Where to find what

| Concern | File |
|---|---|
| Wire format (parse, serialize, address helpers, `ErgoTree` / `TreeHeader` types) | [`facts/ergoscript-wire.md`](./ergoscript-wire.md) |
| Evaluator surface, `EvalError` (43 codes), `SValue` / `SType` / `Expr` discriminated unions, method-handler registry (8 entries), eval arm coverage (52/~70) | [`facts/ergoscript-eval.md`](./ergoscript-eval.md) |
| Sigma-protocol verifier (`verifySignature`), `SigmaBoolean` 6-variant union, `VerifyError` (8 codes) | [`facts/ergoscript-sigma.md`](./ergoscript-sigma.md) |
| AVL+ membership proofs (`verifyMembershipProof`, `lookupInTree`) | (future, phase 2h) |
| Cost validation (`evaluateWithCost`) | (future, phase 2j) |

## Cross-cutting guarantees

### Browser-compat

[From lines 773-783 — verbatim or near-verbatim]

### Determinism

[From lines 767-772 — verbatim or near-verbatim]

### Package shape

One published npm package, `@mwaddip/ergots-ergoscript`. **Subpath exports —
none initially.** If a downstream consumer eventually needs finer tree-shaking
(e.g., just the wire layer for a wallet PoC), introduce a `/wire`, `/eval`, or
`/sigma` subpath at that point. The slice contract files above are pre-marked
seams; the package itself stays unified until real consumer demand justifies a split.

### Runtime dependencies

- `@noble/hashes@2.2.0` (blake2b, sha-256, sha-512)
- `@noble/curves@2.2.0` (secp256k1 point ops; introduced in phase 2g-medium)

No `Buffer`, no `node:*` outside test files, no WASM.

## Error model overview

The package exports multiple typed error classes, one per surface, each carrying
a structural `code: string` for programmatic dispatch:

- `ErgoTreeParseError`, `ErgoTreeSerializeError` — wire layer; see [`ergoscript-wire.md`](./ergoscript-wire.md)
- `EvalError` — evaluator layer (43 codes); see [`ergoscript-eval.md`](./ergoscript-eval.md)
- `VerifyError` — sigma-protocol verifier (8 codes); see [`ergoscript-sigma.md`](./ergoscript-sigma.md)

Common discipline: `.message` is human-readable; `.code` matches a fixed enum of
structural reason strings for programmatic handling. No other error classes are
exported.

## Test-corpus layout

The package validates implementation via three layers per the project's TDD discipline:

- **Layer C1** — per-arm fixtures: each evaluator arm has a fixture (or set of sub-cases)
  asserting both value and cost against sigma-rust's `try_eval_out` oracle.
- **Layer C2** — corpus eval: real mainnet trees (currently 18 evaluable; hard regression
  gate `expect(evalSuccess).toBe(18)`).
- **Layer C3.a** — operator-driven mutation testing (Coll HOF-oriented; method handlers
  deferred per 2g.5/2g.6 posture).

Cross-runtime: vitest runs each test under both `node` and `jsdom` environments.

See `docs/specs/` for per-phase test-strategy detail.

## Coverage summary

| Slice | Status |
|---|---|
| Wire format | 100% of MIR variants parse + serialize byte-identically |
| Evaluator | 52 of ~70 `Expr` arms wired; 8 method handlers; 43 `EvalError` codes |
| Sigma verifier | Full `SigmaBoolean` surface (leaf + conjecture walk); 8 `VerifyError` codes |
| AVL+ | (not yet — phase 2h) |
| Cost validation | (not yet — phase 2j) |

When a slice file's coverage changes, this table is updated in the same commit.

## Cross-references

- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design
- `docs/specs/2026-05-18-facts-ergoscript-split-design.md` — this file's split design
- `facts/proof.md` — sister contract for `@mwaddip/ergots-proof`
- `CLAUDE.md` — project conventions (read-first files include this meta + relevant slices)
```

- [ ] **Step 4: Verify the trimmed file**

Run: `wc -l /home/mwaddip/projects/ergots/facts/ergoscript.md`
Expected: around 150 lines (target). 100-200 is acceptable.

Run: `grep -c '^##\? ' /home/mwaddip/projects/ergots/facts/ergoscript.md`
Expected: at least 6 sections (Scope, Where to find what, Cross-cutting guarantees, Error model overview, Test-corpus layout, Coverage summary, Cross-references).

- [ ] **Step 5: Sanity-check that no content was lost**

Pick 3-5 distinctive phrases from sections that were moved to the slice files (e.g., a specific error code, a specific function signature, a specific cost value). For each, grep across `facts/`:

```bash
grep -l 'specific phrase' /home/mwaddip/projects/ergots/facts/ergoscript*.md
```

Expected: each phrase appears in exactly one slice file (not in meta, not in two slices). If it appears in zero files, it was lost — re-extract.

- [ ] **Step 6: Commit**

```bash
git -C /home/mwaddip/projects/ergots add facts/ergoscript.md
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs(facts): trim facts/ergoscript.md to meta hub + lookup table

Per the facts/ergoscript.md split design (5da8289): trims facts/ergoscript.md
from 1,203 lines to ~150 lines. Removes wire/eval/sigma surface content
(now lives in the three slice files added in Phase 1). Retains the meta hub:
scope statement, lookup table forwarding to slice files, cross-cutting
guarantees (browser-compat, determinism, package shape, runtime deps),
error-model overview, test-corpus layout, and coverage summary table.

Vague cross-references from other docs ("see facts/ergoscript.md") still
land here and forward correctly via the lookup table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Update cross-references + governance

Three tasks (5, 6, 7); one sanity-check task (8).

### Task 5: Update `CLAUDE.md` reads-list

**Files:**
- Modify: `/home/mwaddip/projects/ergots/CLAUDE.md`

- [ ] **Step 1: Locate the read-first list**

Run: `grep -n 'facts/ergoscript' /home/mwaddip/projects/ergots/CLAUDE.md`

Note each line that references `facts/ergoscript.md`. The "Read-first files" section is currently near the top of the file.

- [ ] **Step 2: Update the read-first entry**

Find the current entry for `facts/ergoscript.md`. Replace it with:

```markdown
   - `facts/ergoscript.md` — meta hub for `@mwaddip/ergots-ergoscript`; points to per-slice files
   - `facts/ergoscript-wire.md` — wire format (parseTree, serializeTree, address helpers, ErgoTree types)
   - `facts/ergoscript-eval.md` — evaluator surface (evaluate, EvalError 43 codes, SValue/SType/Expr, method-handler registry, eval arm coverage)
   - `facts/ergoscript-sigma.md` — sigma-protocol verifier (verifySignature, SigmaBoolean, VerifyError 8 codes)
```

Adjust formatting to match the surrounding style (whether the original used dashes, asterisks, or numbered bullets).

If `facts/ergoscript.md` is referenced anywhere else in CLAUDE.md (e.g., "Project facts" section), update the wording to clarify that it's the meta hub.

- [ ] **Step 3: Verify**

Run: `grep -n 'facts/ergoscript' /home/mwaddip/projects/ergots/CLAUDE.md`

Expected: the read-first entry now lists 4 files (meta + 3 slices); any other references mention the meta as a hub.

- [ ] **Step 4: Commit**

```bash
git -C /home/mwaddip/projects/ergots add CLAUDE.md
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs: update CLAUDE.md reads-list for facts/ergoscript.md split

Per the split design (5da8289): updates the read-first files list to
include the three new slice contracts (ergoscript-wire.md,
ergoscript-eval.md, ergoscript-sigma.md) alongside the meta hub.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Update `packages/ergoscript/` README / API / PLAN deep-refs

**Files:**
- Modify (if deep-refs exist): `packages/ergoscript/README.md`, `packages/ergoscript/API.md`
- DO NOT modify: `packages/ergoscript/PLAN.md` (or the root `PLAN.md`) — those are working plans, not reference docs

- [ ] **Step 1: Find all references**

Run: `grep -rn 'facts/ergoscript' /home/mwaddip/projects/ergots/packages/ergoscript/ /home/mwaddip/projects/ergots/README.md 2>/dev/null`

For each reference, determine:
- Vague (`see facts/ergoscript.md`) → leave as-is; it lands on the meta hub
- Deep-link (`facts/ergoscript.md#evalerror-taxonomy` or "the EvalError taxonomy in facts/ergoscript.md") → update to point to the right slice file

- [ ] **Step 2: Update each deep-link reference**

For each deep-link found in Step 1, edit the source file to point at the right slice. Example patterns:

- "the EvalError taxonomy in facts/ergoscript.md" → "the EvalError taxonomy in facts/ergoscript-eval.md"
- "the SValue discriminated union in facts/ergoscript.md" → "the SValue discriminated union in facts/ergoscript-eval.md"
- "verifySignature documented in facts/ergoscript.md" → "verifySignature documented in facts/ergoscript-sigma.md"
- "parseTree returns ErgoTree (see facts/ergoscript.md)" → "parseTree returns ErgoTree (see facts/ergoscript-wire.md)"

- [ ] **Step 3: Verify**

Run: `grep -rn 'facts/ergoscript' /home/mwaddip/projects/ergots/packages/ergoscript/ /home/mwaddip/projects/ergots/README.md 2>/dev/null`

Expected: every deep-link reference now points to a slice file; vague refs still point to the meta.

- [ ] **Step 4: Commit (only if any files were actually changed)**

```bash
git -C /home/mwaddip/projects/ergots add packages/ergoscript/README.md packages/ergoscript/API.md
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs(ergoscript): update package README/API deep-refs for facts split

Per the split design (5da8289): redirects deep-link references that named
specific sections now living in slice files (ergoscript-wire.md,
ergoscript-eval.md, ergoscript-sigma.md). Vague references to the meta
hub stay as-is.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no files changed in Step 2, skip the commit (and note this in the task completion report).

---

### Task 7: Update design-spec deep-refs

**Files:**
- Modify (selectively): `docs/specs/*-ergoscript-*.md` and any other spec docs containing deep-links to moved sections

- [ ] **Step 1: Find all references**

Run: `grep -rln 'facts/ergoscript' /home/mwaddip/projects/ergots/docs/`

Expected: ~14 spec files plus possibly a few more. List them.

- [ ] **Step 2: Inspect each file for deep-links**

For each file in the list, run:
```bash
grep -n 'facts/ergoscript' /home/mwaddip/projects/ergots/docs/specs/<filename>
```

Classify each match:
- Vague (`see facts/ergoscript.md`, `facts/ergoscript.md — interface contract`) → leave as-is
- Deep-link (mentions a specific section / type / error code / handler that's now in a slice file) → update

- [ ] **Step 3: Update each deep-link reference**

Edit each spec file to point deep-links at the right slice file. Common patterns to watch for:

- References to `EvalError` codes (43 of them) → `facts/ergoscript-eval.md`
- References to `SValue` / `SType` / `Expr` definitions → `facts/ergoscript-eval.md`
- References to the method-handler registry → `facts/ergoscript-eval.md`
- References to `verifySignature` / `SigmaBoolean` / `VerifyError` → `facts/ergoscript-sigma.md`
- References to `parseTree` / `serializeTree` / address helpers → `facts/ergoscript-wire.md`
- References to `ErgoTreeParseError` / `ErgoTreeSerializeError` → `facts/ergoscript-wire.md`

- [ ] **Step 4: Verify**

Run: `grep -rn 'facts/ergoscript' /home/mwaddip/projects/ergots/docs/`

Spot-check 3-4 random matches and confirm each points at the correct slice (or correctly remains pointing at the meta hub for vague references).

- [ ] **Step 5: Commit**

```bash
git -C /home/mwaddip/projects/ergots add docs/specs/
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs(specs): update design-spec deep-refs for facts/ergoscript split

Per the split design (5da8289): redirects deep-link references across the
~14 ergoscript design specs that named specific sections now living in
slice files. Vague references continue to land on the meta hub.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no specs needed updating (all references were vague), skip the commit and note this.

---

### Task 8: Final sanity check + PLAN.md status update

**Files:**
- Modify: `PLAN.md` (mark phase complete)

- [ ] **Step 1: Full grep sweep**

Run:
```bash
grep -rn 'facts/ergoscript' /home/mwaddip/projects/ergots/CLAUDE.md /home/mwaddip/projects/ergots/docs/ /home/mwaddip/projects/ergots/packages/ /home/mwaddip/projects/ergots/README.md /home/mwaddip/projects/ergots/facts/ 2>/dev/null
```

Read every match. Confirm:
- Every reference resolves to an existing file (no `facts/ergoscript-bogus.md` typos)
- Vague references land on the meta hub correctly (the meta hub has the lookup table forwarding them)
- Deep-link references point to the right slice

- [ ] **Step 2: Verify file structure**

Run:
```bash
ls -la /home/mwaddip/projects/ergots/facts/
wc -l /home/mwaddip/projects/ergots/facts/*.md
```

Expected: 4 active `.md` files in `facts/`:
- `ergoscript.md` — ~150 lines (meta hub)
- `ergoscript-wire.md` — 300-500 lines
- `ergoscript-eval.md` — 600-800 lines
- `ergoscript-sigma.md` — 100-200 lines
- (plus `proof.md` at 196 lines, untouched)

- [ ] **Step 3: Update PLAN.md to mark phase complete**

Edit `/home/mwaddip/projects/ergots/PLAN.md`. Add a status line at the top below the title:

```markdown
**Status: ✅ COMPLETE 2026-05-18** (facts/ergoscript.md split into meta hub + 3 slice files; CLAUDE.md and design-spec deep-refs updated; vague refs continue to land on the meta hub via the lookup table.)
```

- [ ] **Step 4: Commit**

```bash
git -C /home/mwaddip/projects/ergots add PLAN.md
git -C /home/mwaddip/projects/ergots commit -m "$(cat <<'EOF'
docs: facts/ergoscript.md split complete — final sanity sweep

Per the split design (5da8289): all cross-references resolve correctly; the
4-file facts layout is in place (meta hub + wire/eval/sigma slices); no
broken links via grep sweep. Marks the implementation plan as complete.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (run before declaring the plan ready)

After implementing all 8 tasks, re-check:

1. **Spec coverage:**
   - Three new slice files created (Tasks 1-3): wire, eval, sigma ✓
   - Meta file trimmed to lookup table + cross-cutting (Task 4) ✓
   - CLAUDE.md updated (Task 5) ✓
   - Package README/API updated where deep-refs existed (Task 6) ✓
   - Design specs updated where deep-refs existed (Task 7) ✓
   - Final sanity sweep (Task 8) ✓
2. **Type / content consistency:**
   - `SValue` / `SType` / `Expr` defined canonically in `ergoscript-eval.md` (per spec's "shared types policy"); `ergoscript-wire.md` cross-refs to it
   - `SigmaProp` SValue defined in `ergoscript-eval.md`; `ergoscript-sigma.md` cross-refs to it (since `verifySignature` takes a `SigmaBoolean`, the eval-side `SigmaProp` is the producer)
   - All 43 `EvalError` codes appear exactly once across the slice files (in `ergoscript-eval.md`)
   - All 8 `VerifyError` codes appear exactly once (in `ergoscript-sigma.md`)
   - `ErgoTreeParseError` and `ErgoTreeSerializeError` appear exactly once (in `ergoscript-wire.md`)
3. **No placeholders:**
   - Every step has actual content. The `[Insert ...]` and `[Extract from lines ...]` markers in the Phase 1 file-templates direct the implementer to specific source ranges — they are operational instructions, not placeholders.
4. **No content loss:**
   - Task 4 Step 5 explicitly tests for content loss via distinctive-phrase grep
   - Task 8 Step 1 catches any broken references
