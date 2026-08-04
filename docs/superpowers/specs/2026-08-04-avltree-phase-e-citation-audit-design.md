# Phase E — Rust source-citation audit

**Date:** 2026-08-04 (rev 2, same day — spec-review findings F1-F5 applied; review
at `.superpowers/sdd/2026-08-04-avltree-phase-e-citation-audit/`)
**Parent:** `2026-08-02-avltree-remediation-umbrella-design.md` ("Phase E —
Rust source-citation audit"; no finding number — postdates the audit)
**Branch:** `avltree-0.4.0` (continues from D; base `b7934bd`)
**Status:** approved design, spec-reviewed (APPROVE-WITH-FIXES, F1-F5 applied),
pre-implementation

## Goal

Make every Rust citation in `@ergots/avltree` true: the named construct
exists, the cited range lands on its true bounds, and everything points at
**one** canonical pin in **one** notation. The citations are the package's
primary navigation aid for maintaining the port against the reference; today
they are the least trustworthy text in the repo.

**Census (2026-08-04, this session):** ~158 citation-bearing lines across 15
`src/` files (top: `batch-prover.ts` 44, `delete.ts` 23, `operation.ts` 22,
`node.ts` 13, `modify.ts` 12), 9 lines across 6 `test/` files (plus
`EMITTER.rs`'s spaced-notation header line), the 29-row Source Mapping table
in `facts/avltree.md`, and README's pin line. Three pins coexist
(`@191052c` ×80, `@d18773c` ×3, `568e7c3` in prose ×2, ~75 untagged sites
that facts declares implicitly-191052c) in at least FOUR notations — the
spec review found a spaced `@ 191052c` form (`serialize.ts:6`, recurring as
`@ 568e7c3` in `EMITTER.rs`) beyond the suffix, prose, and untagged forms.
The umbrella's finding stands: for the nine files Phase A fenced off, many
citations were never correct at *any* pin (fabrication class — one cited a
function that does not exist in the named file).

## The framing decision: one pin, verified everywhere

The umbrella left "historical-pin vs re-pin" as a per-comment decision. User
decision 2026-08-04: **uniform re-pin to canonical `568e7c3`**, one notation.
Grounds:

- Everything behavioral has already converged on canonical `main`: B/C/D
  fixtures and conformance vectors were regenerated there, and `d18773c`
  exists to make the fork match what ergots ships. The code the comments
  describe IS the canonical code.
- E must verify every range individually anyway (the umbrella's rule: never
  derive by offset). Verification at `568e7c3` *is* the audit; re-pinning is
  nearly free once every site is being opened regardless.
- It retires the `backup/pre-rebase-main-20260803` indirection, the facts
  rebase note, and the notation trichotomy in one move. Future sessions
  verify against exactly one ref.

Rejected: per-comment historical pins (the "what was ported from" story is
already false at the fabricated sites, and dual pins tax every future
reader); construct-names-only without ranges (drift-proof but destroys the
jump-to-line value the citations exist for, against the house port style).

**Phase D's citations keep their verified values** (`removed_nodes` 146-153;
`contains` 519-525; `contains_recursive` 535-607 — all already at `568e7c3`);
only their prose notation is normalized to the standard form below.

## Scope

**In:**
- `packages/avltree/src/*.ts` — all 15 citation-bearing files.
- `packages/avltree/test/*.ts` — the 9 citation-bearing lines across 6 files.
- `facts/avltree.md` — ALL citation-bearing content, not an enumerated
  subset (spec-review F1): the 29-row Source Mapping table, the pin
  declarations (head, "Source mapping" preamble, cross-references), the
  rebase note (collapses to a one-sentence history line once the pin is
  uniform), and the Coverage section's self-labeled "Note for Phase E"
  (~:361-364) — which also names its own fix: the `modify.ts:184-188`
  "matching Rust's Lookup branch" citation is semantically imprecise (the
  reference routes UnknownModification through the generic `update_fn`
  same-value rewrite, not the Lookup arm); correct the src comment in the
  modify batch, then retire the facts note.
- `packages/avltree/README.md` — the pin line (also corrects the stale
  "338 tests" count while that sentence is open — 372 as of D).
- **B-emitter preservation** (the D pattern, applied retroactively):
  `tests/prover_fixtures.rs` exists only as an UNTRACKED file in the fork's
  checkout — one `git clean` from gone — and
  `packages/avltree/test/prover-fixtures.test.ts` cites that non-durable
  path. Preserve it as `packages/avltree/test/fixtures/prover/EMITTER.rs`
  with an as-found-provenance header, and repoint the test comment.
  **User sanction 2026-08-04:** a single read of that one untracked file
  from the fork's working tree is authorized — the never-read-the-working-
  tree rule guards against rebased-branch confusion, which cannot apply to
  an untracked file; the sanction covers exactly this file, once.
- Named known-stale fixes inside the sweep: `batch-verifier.ts:215` and
  `delete.ts:25` (the two legacy stale cites); the spec-F6 false
  dispatch narrative in `modify.ts` ("Remove/RemoveIfExists … never reach
  this function" — Remove's first pass routes through `handleLeafMatch`,
  which is where the D3 invariant gets its first-pass visits); the
  `delete.ts` "NUMBERING NOTE" (~:396-411), which documents a pre-existing
  ~22-line offset convention for that file's untagged citations — the
  re-pin retires the convention (every citation gets true verified numbers),
  so the note is deleted with it (spec-review F2); and `EMITTER.rs`'s
  spaced `@ 568e7c3` normalized to the standard suffix (header-only edit —
  the preserved emitter body below stays byte-unmodified).

**Out:**
- Tracked specs under `docs/superpowers/specs/` — **point-in-time exemption
  policy**: specs are archival; citations inside them describe the tree as
  it stood when written and are not retargeted. The Phase C ledger's ruling
  on the fifth-C4-row line numbers stands as the precedent and the
  annotation. (This paragraph IS the policy statement the arc needed.)
- Any code byte. This phase is comment/docs-only, mechanically enforced
  (gates below).
- The fork repo itself; `dist/`; other packages; changing any cited VALUE
  Phase D verified.

## Citation taxonomy and the target notation

The sweep classifies every `.rs`-mentioning line as exactly one of:

1. **Banner/JSDoc citation** — names a construct with a range. Target form
   (the facts-table / D style):
   `file.rs::Type::fn (A-B @568e7c3)` — or `Ports file.rs::fn (A-B @568e7c3)`
   in JSDoc lead position. Range bounds: first line of the construct proper
   (`pub fn` / `fn` / `struct` / `impl` line — doc comments excluded, the
   D convention) through its true closing brace.
2. **Inline line reference** — "Rust line 475 @191052c"-style pointers to a
   specific statement (the densest class in `delete.ts`/`modify.ts`, mostly
   B-era repairs). Re-resolve each to the statement's line at `568e7c3`,
   same suffix form: `Rust line N @568e7c3`. These are line-level, not
   construct-level: resolving one means reading both sources and finding the
   SAME statement, not applying an offset.
3. **Prose construct mention** — "matches Rust's `reset()`", no range.
   Verify the construct exists at the pin; do NOT manufacture a range that
   was never there.
4. **Narrative/history** — "An earlier port visited X here instead…",
   "the previous code nulled the root". Not citations; left alone unless
   factually false (the F6 comment is the known false one).

**Fabricated citations** (construct absent, or living in a different file):
correct when the intended construct is identifiable from the TS behavior and
the Rust source; otherwise **delete the citation** — no pointer beats a false
pointer. Every deletion is counted and listed in the task report.

**Verification rule (binding on every site):** each range/line is verified
individually against `git -C ~/projects/ergo_avltree_rust show
568e7c3:src/<file>` at write time. Never derived by offset, never copied
from this spec, the plan, another comment, or memory. The reference repo is
read via `git show` only (single sanctioned exception above).

## Process shape

- **Census tool first:** a small script in the SDD workspace (untracked,
  survives the phase per house precedent) emits a structured inventory —
  file, line, class (1-4), cited file, construct, range, pin tag. Its match
  surface is wider than the 2026-08-04 counts: lines matching `\.rs` OR
  `Rust` OR any bare pin string (`191052c`, `d18773c`, `568e7c3`) — the
  prose class-3/4 mentions ("matches Rust's `reset()`") often carry no
  `.rs`, and spec-review F2 found bare pin strings on lines with NEITHER
  marker (`delete.ts` NUMBERING NOTE, lines ~408/411), which the closing
  "`191052c` exactly once" assertion must be able to see. The spaced
  `@ <pin>` notation matches via the bare-string term and is normalized to
  the suffix form wherever encountered. The 2026-08-04 numbers are the
  `.rs` subset; the tool's first run at phase open supersedes them as the
  worklist. It runs at phase open (the
  worklist), after each task (progress), and at phase close (the acceptance
  assertion). The script is scaffolding, not a shipped artifact.
- **Batched per-file passes**, one subagent + one review each, sized by
  citation density and judgment load (final batching is the plan's call;
  the expected shape is: batch-prover alone; delete alone — highest
  inline-reference judgment; operation+node; modify+avl-tree-ops+rotation
  (carries the F6 fix); the verifier cluster (batch-verifier, proof-decode,
  tree-traversal, verify); the small tail (serialize, persistent-prover,
  versioned-storage, types) + the 9 test-file lines; facts+README; the
  emitter preservation task).
- **Per-task ledger counts:** verified-unchanged / retargeted /
  corrected / deleted / prose-normalized, per file. The counts are the
  audit's evidence trail; a task report without them is incomplete.
- **Emitter task detail:** copy the sanctioned file with its content
  preserved unmodified; prepend (above it, touching nothing below) a
  REGENERATION header in the D EMITTER.rs style, documenting as-found
  provenance (untracked in the fork checkout, recovered 2026-08-04) and the
  reproduction recipe; then verify it in a `568e7c3` worktree: it must
  compile and regenerate the committed prover fixtures byte-identically
  (`ERGOTS_FIXTURE_DIR` to a scratch dir, diff against committed). If
  reproduction FAILS, STOP the task and surface it — that is a real
  finding about fixture provenance, never silently patched.

## Gates

Per task commit:
- **Comment-only proof (src/test files), two mechanical layers:**
  (a) comment-stripped compile output byte-identical before/after — a
  workspace script runs TypeScript `transpileModule` with
  `removeComments: true` over every touched `.ts` file at the parent and at
  HEAD and byte-compares (empirically validated by the spec review:
  deterministic, zero diagnostics, catches real code edits); PLUS
  (b) zero changed import lines — `transpileModule` erases `import type`
  specifiers regardless of content (spec-review F3), so an edit confined to
  a type-only import would slip layer (a); since E has no legitimate reason
  to touch ANY import, every task diff must show zero `^[-+]\s*import`
  lines in src/test files, asserted mechanically per commit. Docs files
  (facts, README) are exempt from both (they are all "comment").
- Package fast loop: `cd packages/avltree && npm test && npm run typecheck`.

Phase close:
- Closing census: zero `@191052c`, zero `@d18773c`, zero unverified rows;
  `191052c` appears exactly once in the package — the one-sentence history
  line in facts (and nowhere in src/test).
- Full gates: repo-root `npx vitest run` + `npm test` + `npm run typecheck`;
  avltree suite green in node AND jsdom
  (`cd packages/avltree && npm run test:browser`); publint; all 28 committed
  fixtures byte-identical (21 pre-D, which include the 10-prover set the
  recovered emitter must additionally re-reproduce, + 7 removed-nodes).
- Whole-phase final review, then the arc proceeds to the whole-branch
  review + single A–E PR.

## Risks

- **Volume → wrong-range regressions.** ~190 sites re-verified by hand is
  exactly the environment where a transposed digit ships. Mitigations: the
  never-copy rule; per-task reviews spot-re-verifying ranges against the
  pin (the D reviews caught every citation defect this way); the closing
  census as a structural backstop.
- **`delete.ts`/`modify.ts` inline references are statement-level.** The
  rebase moved and CHANGED code at the 6a/6b/6c-class sites, so re-resolving
  "Rust line 475" requires semantic matching, not arithmetic. Highest-
  judgment batches; the plan assigns them standard-model implementers and
  names this as the review's focus risk.
- **Narrative-vs-citation misclassification.** A history note rewritten as
  a citation (or vice versa) either destroys provenance narrative or leaves
  a false pointer. The taxonomy above is binding; reviews check
  classification, not just ranges.
- **Emitter reproduction failure** — STOP path defined above; possible
  causes (emitter predates a fork fix; fixtures regenerated later than the
  emitter's last run) get surfaced with evidence, decided by the user.

## Verification

Everything under "Gates". Acceptance in one sentence: a reader can take any
Rust reference in the package, run `git show 568e7c3:src/<file>`, and land
exactly where the comment says — for every citation, with one pin, one
notation, and a census that proves nothing was missed.
