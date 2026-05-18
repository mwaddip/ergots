# `facts/ergoscript.md` Split — Design Spec

**Status:** Draft
**Date:** 2026-05-18
**Package:** `@ergots/ergoscript` (documentation refactor; no code or behavior change)
**Phase plan:** documentation hygiene; tracks post-phase-2g.6 file growth
**Brainstorm transcript:** session 2026-05-18 (post-phase-2g.6 ship)

## Goal

Split `facts/ergoscript.md` (currently 1,203 lines after the phase 2g.6 facts update) into a meta file plus per-slice contract files, aligned with the umbrella spec's already-stated subpath-export plan (`/wire`, `/eval`, `/sigma`, future `/avl`, future `/cost`). Pre-mark architectural seams that will become real boundaries when downstream packages (wallet, validator-node) start consuming the contract.

The split is driven by file growth (1,203 lines is hard to read in one Read; ~43k tokens consumes substantial context per pull), but the **architectural justification** — and the reason a split is worth doing at all — is that the project's umbrella spec already names these surfaces as plausible future subpath exports. Pre-marking the seams now means future phases (2h adds AVL+; 2i adds predefs; 2j adds cost validation) extend the relevant slice file rather than appending to a monolith.

## Non-goals

- **Code or behavior change.** This is pure documentation refactor; no `packages/ergoscript/src/` files are touched, no tests are added or removed.
- **Splitting `facts/nipopow.md`.** At 196 lines it's comfortably within bounds; no growth pressure.
- **Splitting the npm package itself.** `@ergots/ergoscript` stays a single published package. Subpath exports remain a "extract when a real consumer needs it" decision (per the umbrella spec); this spec only pre-marks where the seams would fall in the contract.
- **Preemptively creating empty placeholder files for future phases.** `facts/ergoscript-avl.md` and `facts/ergoscript-cost.md` are NOT created now — each future phase's design spec creates its own slice file as part of the phase's facts-update step.
- **Rewriting content.** The split is mostly cut-and-paste of existing material into new file homes; copy-edits are out of scope for this refactor.
- **Updating cross-refs in every existing design spec.** Only deep-link refs (the ones that name a specific section that's moved to a slice file) get updated; vague refs ("see facts/ergoscript.md") land on the hub via the lookup table and stay as-is.

## Architecture

### Target file layout

```
facts/
├── ergoscript.md             — meta + cross-cutting, target ~150 lines
├── ergoscript-wire.md        — phase 2a wire format surface
├── ergoscript-eval.md        — phases 2b–2g.6 eval surface (growth surface)
├── ergoscript-sigma.md       — phase 2g sigma-protocol verifier surface
├── ergoscript-avl.md         — phase 2h (created when 2h ships; NOT in this spec)
└── ergoscript-cost.md        — phase 2j (created when 2j ships; NOT in this spec)
```

Three new active files: `ergoscript-wire.md`, `ergoscript-eval.md`, `ergoscript-sigma.md`. The meta file (`facts/ergoscript.md`) is retained and trimmed.

### Content boundaries

**`facts/ergoscript.md` (meta)** — what stays at the top level:
- Header / scope statement (what this package is)
- Cross-cutting guarantees (browser-compat, determinism, ESM-only, no-WASM, runtime deps)
- Package shape (one published package; subpath strategy "none initially — extract when a real consumer needs it")
- Error-model overview (one paragraph: the project has multiple typed error classes per surface, each with structural `code` for programmatic dispatch — defer per-code lists to the slice files)
- Test-corpus layout (one paragraph naming the C1 / C2 / C3.a layers; defers to spec docs for detail)
- Coverage summary table (one row per slice; e.g., "wire: 100% of MIR variants; eval: 52/~70 arms; sigma: full SigmaBoolean; avl: not yet; cost: not yet")
- "Where to find what" lookup table (forward pointers to slice files)
- Cross-references to `docs/specs/` umbrella + the per-slice files

**`facts/ergoscript-wire.md`** — phase 2a wire format slice:
- Public surface: `parseTree`, `serializeTree`, `treeHeader`, `treeConstants`, `treeBody`, `isP2PK`, `p2pkPublicKey`, `addressFromErgoTree`, `ergoTreeFromAddress`
- Types: `ErgoTree`, `TreeHeader` (the `Expr` / `SValue` / `SType` discriminated unions are defined in `ergoscript-eval.md` — this file cross-refs)
- Errors: `ErgoTreeParseError`, `ErgoTreeSerializeError` with full `code` enums
- Determinism + round-trip invariants for the wire layer
- Coverage: 100% of MIR variants parse + serialize byte-identically (the wire-side coverage statement)

**`facts/ergoscript-eval.md`** — phases 2b–2g.6 eval surface (where the growth lives):
- Public surface: `evaluate`, `evaluateWith`, `makeContext`
- Interfaces: `EvalContext` (`addCost`, `addPerItemCost`), `EvalOpts` (`jitCostLimit`, `constants`, `treeVersion`, `height`, `selfBox`, `inputs`, `outputs`, `preHeader`, `extension`, `dataInputs`)
- Errors: `EvalError` with all 43 codes (this is the canonical home; the meta file's error-model overview points here)
- `SValue` discriminated union (the canonical definition; `ergoscript-wire.md` cross-refs)
- `SType` discriminated union (the canonical definition; cross-refs from elsewhere)
- `Expr` discriminated union and eval arm coverage table (52 of ~70 arms — listed by phase: 2b consts, 2c operators, 2d conditionals/blocks/lambdas, 2e box/context model, 2f Coll HOFs, 2g sigma helpers, 2g.5 method-call dispatcher, 2g.6 broader methods)
- Method-handler registry (all 8 current entries — `SBox.tokens`, `SContext.dataInputs`, `SColl.indexOf`, `SGlobal.groupGenerator`, `SColl.zip`, `SColl.indices`, `SContext.preHeader`, `SPreHeader.timestamp` — with per-method semantics; new entries land here as future tasks add them)

**`facts/ergoscript-sigma.md`** — phase 2g sigma-protocol verifier slice:
- Public surface: `verifySignature(sigmaBoolean, message, signature)`
- Types: `SigmaBoolean` 6-variant discriminated union (TrivialProp, ProveDlog, ProveDhTuple, Cand, Cor, Cthreshold)
- Errors: `VerifyError` with all 8 codes
- Internal helpers cross-ref (the GF(2^192) module, the secp256k1 adapter — internals not part of the public contract but useful for understanding)

### Shared types policy

`SValue` / `SType` / `Expr` are produced by the wire layer and consumed by the eval layer (and by the sigma verifier through `verifySignature(sigmaBoolean, …)` where `SigmaBoolean` is itself a related discriminated union). They appear in *both* `ergoscript-wire.md` and `ergoscript-eval.md` semantically.

**Canonical definition: `ergoscript-eval.md`.** Eval is the bigger consumer; the wire layer is mostly about serialization shape, not runtime value semantics. `ergoscript-wire.md` cross-refs to `ergoscript-eval.md` for these types via a short "Output types" pointer:

> `parseTree` returns an `ErgoTree` containing an `Expr` body and `SValue[]` constants. The discriminated-union definitions of `SValue` / `SType` / `Expr` are in `ergoscript-eval.md` (these types are shared across the wire and eval surfaces).

### Cross-reference migration policy

Existing references to `facts/ergoscript.md` exist in:
- ~14 design specs under `docs/specs/`
- `CLAUDE.md` (project conventions)
- `packages/ergoscript/README.md`, `API.md`, `PLAN.md`
- Memory files outside the repo (reference `facts/` directory generally)

**Policy:**
- The meta file (`facts/ergoscript.md`) becomes a hub. Its "Where to find what" lookup table forwards readers to the right slice.
- **Vague references** (`see facts/ergoscript.md`) stay unchanged. They land on the hub; the lookup table forwards. One extra hop per LLM session; acceptable (LLM consumers are the primary readers, per user-provided context).
- **Deep references** (the ones that name a specific section that's moved to a slice file — e.g., "the EvalError taxonomy in facts/ergoscript.md") get updated to point to the slice file. Mechanical; ~30 minutes of edits.
- **`CLAUDE.md`** explicitly lists read-first files; update to: `facts/ergoscript.md` (meta — points to per-slice files) plus the relevant slice file(s) for the topic.
- **New design specs (post-split)** author cross-refs to the specific slice file directly. Convention: deep-link by default; the meta file is for cross-cutting topics only.
- **Memory files** outside the repo are not updated by this spec (they reference `facts/` directory generally, no file-name specificity).

### Per-phase update pattern (going forward)

When a future phase ships, it updates the relevant slice file(s) rather than appending to a monolith:

- **Phase 2h** (AVL+ membership-proof verification + 5 `SAvlTree.*` methods): creates `facts/ergoscript-avl.md` for the `verifyMembershipProof` / `lookupInTree` public surface. The 5 `SAvlTree.*` method handlers register in the `ergoscript-eval.md` method-handler registry table with a "see ergoscript-avl.md for AVL+ semantics" cross-ref; the eval registry stays the single place where the (typeId, methodId) → handler dispatch is documented. (Open question deferred to phase 2h's design spec: whether AVL+ method semantics live in `ergoscript-eval.md` or `ergoscript-avl.md` — both are defensible; 2h's design picks one.)
- **Phase 2i** (predefs — `DecodePoint`, `SubstConstants`, `CalcBlake2b256`, byte-array conversions, etc.): these are `Expr` arms, so they update `ergoscript-eval.md`'s coverage table + add per-arm sections inline. No new slice file.
- **Phase 2j** (cost validation): creates `facts/ergoscript-cost.md` for `evaluateWithCost`. The meta file's "Where to find what" table grows one row (or has the row pre-listed as `(future, phase 2j)` from this spec onward).

### Content-drift mitigation

The meta file's coverage summary table (one row per slice, e.g., "eval: 52/~70 arms") is the only intentional redundancy with the slice files (which have full coverage tables). Convention: when a slice file's coverage changes, the meta file's summary table is updated in the same commit. Cheap to maintain; one row per slice.

No other intentional redundancy — the slice files are the canonical home for their content.

## Implementation phases

Three sequential phases, each its own commit. No interleaving; each phase is verifiable on its own.

### Phase 1 — Create the four new files (no deletions from `ergoscript.md` yet)

- Author `facts/ergoscript-wire.md` by extracting the wire-format sections from current `ergoscript.md` (Scope subset + Public surface wire parts + `ErgoTreeParseError`/`ErgoTreeSerializeError` + round-trip invariant + wire-side determinism). Add slice-specific scope statement at the top (one paragraph).
- Author `facts/ergoscript-eval.md` by extracting the v0.2.0 evaluator surface, `EvalError` taxonomy, `SValue`/`SType`/`Expr` discriminated union definitions, eval arm coverage table, method-handler registry, EvalContext/EvalOpts interfaces.
- Author `facts/ergoscript-sigma.md` by extracting the `verifySignature` / `VerifyError` / `SigmaBoolean` material.
- Verify by running `wc -l` on the four new files; total should approximate the current ergoscript.md size (minus header / cross-cutting that stays in the meta file).

At end of Phase 1, the new files exist alongside the old one. **Don't yet delete content from `ergoscript.md`** — duplication is temporary and intentional, so any process running mid-phase still finds what it needs.

### Phase 2 — Trim `facts/ergoscript.md` to the meta + lookup table

- Replace the wire/eval/sigma sections with the "Where to find what" lookup table.
- Keep cross-cutting content (scope, browser-compat, determinism, package shape, error-model overview, test-corpus layout, coverage summary table).
- Target ~150 lines.
- Verify each removed section is now present in exactly one of the new slice files (no orphaned content, no duplicated content beyond the intentional coverage summary).

### Phase 3 — Update cross-references + governance

- `CLAUDE.md`: update the read-first list. New wording: `facts/ergoscript.md` (meta — points to per-slice files) plus the relevant slice file(s) for the topic.
- `packages/ergoscript/README.md`, `packages/ergoscript/API.md`, `packages/ergoscript/PLAN.md`: update direct deep-references (only where a specific section is named — vague refs stay).
- `docs/specs/*-ergoscript-*.md` (~14 files): grep for `facts/ergoscript.md#` deep-link anchors or section-specific phrasing like "the EvalError taxonomy in facts/ergoscript.md" and update only those. Vague references (`see facts/ergoscript.md`) land on the hub via the lookup table — leave them.
- Sanity check: `grep -rn 'facts/ergoscript' docs/ packages/ CLAUDE.md README.md` and confirm every match either points to the meta file (intentional hub) or to a now-correct slice file.

### Verification at each phase boundary

- **Phase 1 done** = 4 new files present; old `ergoscript.md` unchanged; `wc -l` of new files ≈ what we expect (most of the old size redistributed).
- **Phase 2 done** = old file trimmed to ~150 lines; total content unchanged across all 4 files; `grep -c '^##\? ' facts/ergoscript*.md` confirms structure; manual diff confirms no orphaned content.
- **Phase 3 done** = `CLAUDE.md` reads-list updated; package README/API/PLAN deep-refs current; spec-doc deep-refs current; `grep -rn 'facts/ergoscript' ...` shows no broken references.

## Risks (minor)

- **Content drift between meta file and slice files.** Mitigation per the policy above: the meta file's coverage summary table is updated in the same commit as the slice file's coverage change.
- **Cross-refs in design specs we don't update.** Vague references stay as-is and land on the hub. The hub forwards correctly. No broken links.
- **Future phase implementer forgets to create the new slice file.** Mitigation: each future phase's design spec must list "create `facts/ergoscript-<slice>.md`" as an explicit task. This spec's "Per-phase update pattern" section is the durable reminder.
- **Memory files outside the repo reference `facts/` generally.** They don't need updating because they don't name specific files.

## Open items (none blocking)

- The "Where to find what" lookup table format — markdown table vs. bullet list. Pick one in Phase 1 implementation; not load-bearing.
- Whether to add a brief one-paragraph "this is a slice file" header at the top of each slice file explaining its role within the larger contract. Lean: yes (helps LLM context-setting on a single-file Read).

## Cross-references

### Source
- `facts/ergoscript.md` (current, 1,203 lines) — the file being split
- `facts/nipopow.md` (196 lines) — sister contract; pattern reference for the meta file's structure

### Sister specs
- `docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella spec; names `/wire` as a plausible future subpath export (the architectural justification for this split)
- `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` — most recent phase that grew the file

### Memories
- [[feedback-pre-v1-coverage-not-load-bearing]] — pre-v1 has no users; ensures this split isn't being done for hypothetical-consumer reasons (it's being done for real growth pressure + already-stated subpath-export plan)
- [[feedback-facts-directory]] — naming convention (`facts/` not `contracts/`)
- [[feedback-conversation-style]] — prose over MCQ when scoping

### Project conventions
- `CLAUDE.md` § "Read-first files" — establishes the canonical role of `facts/*.md` files in the project; will need an entry update in Phase 3
- `CLAUDE.md` § "Project facts" — names `facts/ergoscript.md` as the boundary contract; lookup-table forwarding from the meta file preserves this contract
