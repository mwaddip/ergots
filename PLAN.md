# Plan: npm-org rename `@mwaddip/ergots-*` → `@ergots/*` (with `proof` → `nipopow`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename all three packages from the `@mwaddip/ergots-*` namespace to the new `@ergots/*` org. The proof package additionally renames semantically: `@mwaddip/ergots-proof` → `@ergots/nipopow`, with directory `packages/proof/` → `packages/nipopow/` and `facts/proof.md` → `facts/nipopow.md`. Avltree and ergoscript get name-only renames; their directories stay put. In-repo only — no `npm publish` this session per user decision.

**Architecture:** Mechanical search-and-replace across ~50 files (no algorithmic changes). Substitution rules:

1. `@mwaddip/ergots-proof` → `@ergots/nipopow`
2. `@mwaddip/ergots-avltree` → `@ergots/avltree`
3. `@mwaddip/ergots-ergoscript` → `@ergots/ergoscript`
4. `packages/proof` → `packages/nipopow` (only where it refers to the directory path — comments + Rust path string + `repository.directory` field in package.json)

The word "proof" remains in domain prose ("NiPoPoW proof verifier", "interlinks proof", etc.) — only exact-string matches of the four substitutions above change. Renames preserve git history via `git mv`.

**Tech Stack:** TypeScript (vitest + tsup + tsc), npm workspaces, Rust (cargo + sigma-rust path deps via `[patch.crates-io]`), `@noble/hashes 2.2.0` runtime baseline, `@noble/curves 2.2.0` for ergoscript.

**Per-OVERRIDES discipline:** Phased execution per Rule #4 (≤5 files per phase for code/config; pure-doc phases may batch up to ~8 logically identical files). Verification per Rule #6 (`npx tsc --noEmit` + `npm test` after any TS edit; `cargo build` + `cargo test` + `cargo run` after fixture-gen edit; comprehensive grep at end). Exhaustive rename search per Rule #9 (comprehensive grep already mapped all 45+ references).

**Sub-tasks: 18 tasks (T0 baseline, T1–T15 commits, T16–T18 user-local + final verification).**

---

## T0 — Baseline verification (no edits, no commit)

**Files:** none

- [ ] **Step 1: Confirm clean working tree**

```bash
cd /home/mwaddip/projects/ergots && git status
```
Expected: `nothing to commit, working tree clean` (modulo gitignored `SESSION_CONTEXT.md` / `HANDOFF_PROMPT.md`).

- [ ] **Step 2: Verify TypeScript baseline green**

```bash
cd /home/mwaddip/projects/ergots && npm test --workspaces --if-present 2>&1 | tail -30
```
Expected: every package's vitest run reports passing tests. No failures.

- [ ] **Step 3: Verify TypeScript types clean baseline**

```bash
cd /home/mwaddip/projects/ergots && for pkg in packages/avltree packages/ergoscript packages/proof; do (cd "$pkg" && echo "== $pkg ==" && npx tsc --noEmit); done
```
Expected: zero errors across all 3 packages.

- [ ] **Step 4: Verify fixture-gen Rust baseline**

```bash
cd /home/mwaddip/projects/ergots/fixture-gen && cargo build 2>&1 | tail -5
```
Expected: `Finished` / no errors.

- [ ] **Step 5: No commit (baseline check only). Proceed to T1.**

---

## T1 — Directory rename + 3 package.json renames + lockfile regen

**Files:**
- Move: `packages/proof/` → `packages/nipopow/` (via `git mv`)
- Modify: `packages/nipopow/package.json` (name + repository.directory)
- Modify: `packages/avltree/package.json` (name)
- Modify: `packages/ergoscript/package.json` (name)

- [ ] **Step 1: Move proof directory**

```bash
cd /home/mwaddip/projects/ergots && git mv packages/proof packages/nipopow
```

- [ ] **Step 2: Update `packages/nipopow/package.json` — name + repository.directory**

```json
"name": "@ergots/nipopow",
...
"repository": {
  "type": "git",
  "url": "git+https://github.com/mwaddip/ergots.git",
  "directory": "packages/nipopow"
}
```

- [ ] **Step 3: Update `packages/avltree/package.json` — name only**

```json
"name": "@ergots/avltree",
```

- [ ] **Step 4: Update `packages/ergoscript/package.json` — name only**

```json
"name": "@ergots/ergoscript",
```

- [ ] **Step 5: Regenerate lockfile (clean install)**

```bash
cd /home/mwaddip/projects/ergots && rm -rf node_modules package-lock.json && npm install 2>&1 | tail -5
```
Expected: `added X packages` / no errors. (Note: package-lock.json is gitignored per .gitignore line 9.)

- [ ] **Step 6: Verify tests still pass**

```bash
cd /home/mwaddip/projects/ergots && npm test --workspaces --if-present 2>&1 | tail -10
```
Expected: every package PASS.

- [ ] **Step 7: Verify tsc clean**

```bash
cd /home/mwaddip/projects/ergots && for pkg in packages/avltree packages/ergoscript packages/nipopow; do (cd "$pkg" && npx tsc --noEmit); done
```
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add packages/nipopow packages/avltree/package.json packages/ergoscript/package.json
git status  # confirm packages/proof removed, packages/nipopow added
git commit -m "$(cat <<'EOF'
rename: @mwaddip/ergots-{proof,avltree,ergoscript} → @ergots/{nipopow,avltree,ergoscript}

Package.json name field + packages/proof/ → packages/nipopow/ directory rename.
TS source intentionally untouched in this commit (no cross-package imports exist
in source; subsequent commits update comment-only references).

In-repo rename only — no npm publish this session per user decision.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## T2 — TS source comment refs (5 files)

**Files:**
- Modify: `packages/avltree/src/index.ts:1`
- Modify: `packages/ergoscript/src/eval/errors.ts:2`
- Modify: `packages/ergoscript/src/wire/reader.ts:4`
- Modify: `packages/ergoscript/src/wire/writer.ts:4`
- Modify: `packages/ergoscript/src/wire/errors.ts:7`

- [ ] **Step 1: Edit each file** — substitute per the rules (only comments affected; no code changes).

| File | Before | After |
|---|---|---|
| `packages/avltree/src/index.ts:1` | `// Public surface of @mwaddip/ergots-avltree.` | `// Public surface of @ergots/avltree.` |
| `packages/ergoscript/src/eval/errors.ts:2` | `* EvalError code taxonomy for \`@mwaddip/ergots-ergoscript\`.` | `* EvalError code taxonomy for \`@ergots/ergoscript\`.` |
| `packages/ergoscript/src/wire/reader.ts:4` | `* Mirrors the conventions of \`@mwaddip/ergots-proof\`'s \`ByteReader\`` | `* Mirrors the conventions of \`@ergots/nipopow\`'s \`ByteReader\`` |
| `packages/ergoscript/src/wire/writer.ts:4` | `* Mirrors the conventions of \`@mwaddip/ergots-proof\`'s \`ByteWriter\`` | `* Mirrors the conventions of \`@ergots/nipopow\`'s \`ByteWriter\`` |
| `packages/ergoscript/src/wire/errors.ts:7` | `* established by \`packages/proof/src/errors.ts\`.` | `* established by \`packages/nipopow/src/errors.ts\`.` |

- [ ] **Step 2: Verify tsc clean**

```bash
cd /home/mwaddip/projects/ergots && for pkg in packages/avltree packages/ergoscript packages/nipopow; do (cd "$pkg" && npx tsc --noEmit); done
```

- [ ] **Step 3: Commit**

```bash
git commit -am "rename: update package-name comments in src/ files"
```

---

## T3 — TS test + script comment refs (3 files)

**Files:**
- Modify: `packages/ergoscript/scripts/_hex.ts:3`
- Modify: `packages/ergoscript/test/parse-mutation.test.ts:30`
- Modify: `packages/nipopow/test/autolykos-v2.test.ts` (path comment ref; was `packages/proof/test/fixtures/...` → `packages/nipopow/test/fixtures/...`)

- [ ] **Step 1: Edit each file**

| File | Before | After |
|---|---|---|
| `packages/ergoscript/scripts/_hex.ts:3` | `* mirrors packages/proof/test/helpers.ts for browser-clean parity.` | `* mirrors packages/nipopow/test/helpers.ts for browser-clean parity.` |
| `packages/ergoscript/test/parse-mutation.test.ts:30` | `* Mirror of \`packages/proof/test/mutation.test.ts\`, adapted to drop the` | `* Mirror of \`packages/nipopow/test/mutation.test.ts\`, adapted to drop the` |
| `packages/nipopow/test/autolykos-v2.test.ts` | `packages/proof/test/fixtures/autolykos_v2.json` | `packages/nipopow/test/fixtures/autolykos_v2.json` |

- [ ] **Step 2: Verify npm test still passes**

```bash
cd /home/mwaddip/projects/ergots && npm test --workspaces --if-present 2>&1 | tail -10
```

- [ ] **Step 3: Commit**

```bash
git commit -am "rename: update package-name + path comments in test/scripts files"
```

---

## T4 — facts/ rename + facts/{nipopow,avltree,ergoscript}.md edits

**Files:**
- Move: `facts/proof.md` → `facts/nipopow.md` (via `git mv`)
- Modify: `facts/nipopow.md` (3 refs)
- Modify: `facts/avltree.md` (4 refs)
- Modify: `facts/ergoscript.md` (4 refs)

- [ ] **Step 1: Rename facts file**

```bash
cd /home/mwaddip/projects/ergots && git mv facts/proof.md facts/nipopow.md
```

- [ ] **Step 2: Substitute all 3 occurrences** of `@mwaddip/ergots-proof` → `@ergots/nipopow` in `facts/nipopow.md`.

- [ ] **Step 3: Substitute all 4 occurrences** of `@mwaddip/ergots-avltree` → `@ergots/avltree` AND `@mwaddip/ergots-ergoscript` → `@ergots/ergoscript` in `facts/avltree.md`. (The file references both packages.)

- [ ] **Step 4: Substitute all 4 occurrences** of old names in `facts/ergoscript.md` (uses all three old package names).

- [ ] **Step 5: Commit**

```bash
git commit -am "rename: facts/proof.md → facts/nipopow.md + facts/{nipopow,avltree,ergoscript}.md content"
```

---

## T5 — facts/ergoscript slice files (3 files)

**Files:**
- Modify: `facts/ergoscript-eval.md` (2 refs)
- Modify: `facts/ergoscript-wire.md` (2 refs)
- Modify: `facts/ergoscript-sigma.md` (2 refs)

- [ ] **Step 1: Substitute** `@mwaddip/ergots-ergoscript` → `@ergots/ergoscript` in each.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: facts/ergoscript-{wire,eval,sigma}.md slice contracts"
```

---

## T6 — Per-package READMEs (3 files)

**Files:**
- Modify: `packages/avltree/README.md` (5 refs)
- Modify: `packages/nipopow/README.md` (4 refs)
- Modify: `packages/ergoscript/README.md` (4 refs)

- [ ] **Step 1: Substitute per the rules** in each README.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: per-package README.md files"
```

---

## T7 — Per-package API.md docs (3 files)

**Files:**
- Modify: `packages/avltree/API.md` (3 refs)
- Modify: `packages/nipopow/API.md` (5 refs)
- Modify: `packages/ergoscript/API.md` (3 refs)

- [ ] **Step 1: Substitute per the rules** in each API.md.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: per-package API.md files"
```

---

## T8 — ergoscript per-package status files (1 tracked + 1 gitignored)

**Files:**
- Modify: `packages/ergoscript/PLAN.md` (1 ref, tracked)
- Modify: `packages/ergoscript/SESSION_CONTEXT.md` (2 refs, gitignored — still update)

- [ ] **Step 1: Substitute** in both files.

- [ ] **Step 2: Commit** (only `packages/ergoscript/PLAN.md` is tracked)

```bash
git add packages/ergoscript/PLAN.md
git commit -m "rename: packages/ergoscript/PLAN.md"
```

---

## T9 — docs/specs/ batch 1 (5 files)

**Files (alphabetical, 5 oldest):**
- Modify: `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` (4 refs)
- Modify: `docs/specs/2026-05-13-ergoscript-interpreter-design.md` (6 refs)
- Modify: `docs/specs/2026-05-13-no-gossip-decision.md` (3 refs)
- Modify: `docs/specs/2026-05-14-ergoscript-phase-2b-design.md` (2 refs)
- Modify: `docs/specs/2026-05-14-ergoscript-phase-2c-design.md` (1 ref)

- [ ] **Step 1: Substitute per the rules** in each.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: docs/specs/ batch 1 (2026-05-12 → 2026-05-14)"
```

---

## T10 — docs/specs/ batch 2 (5 files)

**Files:**
- Modify: `docs/specs/2026-05-15-ergoscript-phase-2d-design.md` (2 refs)
- Modify: `docs/specs/2026-05-15-ergoscript-phase-2d-slice-b-design.md` (2 refs)
- Modify: `docs/specs/2026-05-15-ergoscript-phase-2e-design.md` (1 ref)
- Modify: `docs/specs/2026-05-15-ergoscript-phase-2f-design.md` (2 refs)
- Modify: `docs/specs/2026-05-16-ergoscript-phase-2f-coll-hofs-design.md` (2 refs)

- [ ] **Step 1: Substitute per the rules** in each.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: docs/specs/ batch 2 (2026-05-15 → 2026-05-16 Coll HOFs)"
```

---

## T11 — docs/specs/ batch 3 (5 files)

**Files:**
- Modify: `docs/specs/2026-05-16-ergoscript-phase-2f-medium-design.md` (2 refs)
- Modify: `docs/specs/2026-05-16-ergoscript-phase-2g-medium-design.md` (3 refs)
- Modify: `docs/specs/2026-05-17-ergoscript-phase-2g-5-method-call-dispatch-design.md` (2 refs)
- Modify: `docs/specs/2026-05-17-ergoscript-phase-2g-combinators-design.md` (2 refs)
- Modify: `docs/specs/2026-05-18-ergoscript-phase-2g-6-method-handlers-design.md` (3 refs)

- [ ] **Step 1: Substitute per the rules** in each.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: docs/specs/ batch 3 (2026-05-16 medium → 2026-05-18 2g.6)"
```

---

## T12 — docs/specs/ batch 4 (3 files)

**Files:**
- Modify: `docs/specs/2026-05-18-ergots-avltree-package-design.md` (8 refs)
- Modify: `docs/specs/2026-05-18-facts-ergoscript-split-design.md` (2 refs)
- Modify: `docs/specs/2026-05-18-task-b-corpus-widening-design.md` (3 refs)

- [ ] **Step 1: Substitute per the rules** in each.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: docs/specs/ batch 4 (2026-05-18 avltree + facts-split + task-b)"
```

---

## T13 — fixture-gen Rust (4 files)

**Files:**
- Modify: `fixture-gen/src/main.rs` (3 refs: line 7 path string + lines 46, 59 comments)
- Modify: `fixture-gen/src/cmds/ergoscript/mod.rs:1` (comment)
- Modify: `fixture-gen/src/cmds/ergoscript/wire/mod.rs:1` (comment)
- Modify: `fixture-gen/src/cmds/ergoscript/wire/ergo_box_bytes.rs:1` (comment)

- [ ] **Step 1: Substitute per the rules** in each.

For `main.rs:7`, the substitution is path-level: the Rust string `"packages/proof/test/fixtures"` → `"packages/nipopow/test/fixtures"`. The comment refs on lines 46/59 use the npm-name form.

- [ ] **Step 2: Verify Rust still builds**

```bash
cd /home/mwaddip/projects/ergots/fixture-gen && cargo build 2>&1 | tail -5
```

- [ ] **Step 3: Verify Rust tests still pass**

```bash
cd /home/mwaddip/projects/ergots/fixture-gen && cargo test 2>&1 | tail -10
```

- [ ] **Step 4: Determinism check — regenerate fixtures**

```bash
cd /home/mwaddip/projects/ergots/fixture-gen && cargo run --release 2>&1 | tail -10
cd /home/mwaddip/projects/ergots && git status fixture-gen packages/
```
Expected: zero untracked files; zero modified files under `packages/{avltree,nipopow,ergoscript}/test/fixtures/`. (If non-empty diff, STOP — determinism regression.)

- [ ] **Step 5: Commit**

```bash
git commit -am "rename: fixture-gen Rust comments + packages/proof → packages/nipopow path string"
```

---

## T14 — Repo root tracked files: CLAUDE.md + README.md (2 files)

**Files:**
- Modify: `CLAUDE.md` (11 refs — includes `facts/proof.md` reads-first list line)
- Modify: `README.md` (5 refs)

- [ ] **Step 1: Substitute** in both, including the `facts/proof.md` → `facts/nipopow.md` reference in CLAUDE.md's reads-first list.

- [ ] **Step 2: Commit**

```bash
git commit -am "rename: CLAUDE.md + README.md (incl. facts/proof.md → facts/nipopow.md reads-list)"
```

---

## T15 — Root PLAN.md replaced (this file → COMPLETE marker)

**Files:**
- Modify: `PLAN.md` (this file)

- [ ] **Step 1: After all prior tasks complete, overwrite this PLAN.md** with a short "COMPLETE" marker that captures what shipped and what's queued next.

- [ ] **Step 2: Commit**

```bash
git commit -am "chore(plan): mark rename plan complete; overwrite PLAN.md"
```

---

## T16 — Memory files (~/.claude/projects/-home-mwaddip-projects-ergots/memory/)

**Files (user-local, NOT committed to repo):**
- Modify: `MEMORY.md` (hook line if it references old names)
- Modify: `project_ergots_direction.md`
- Modify: `feedback_focused_specs.md`
- Modify: `feedback_pre_v1_coverage_not_load_bearing.md`
- Modify: `feedback_question_framing_first.md`
- Modify: `feedback_wire_format_first_scoping.md`
- Modify: `project_no_gossip_decision.md`
- Modify: `reference_source_first_discipline.md`
- Modify: `project_fixture_gen_cargo_gotchas.md`

- [ ] **Step 1: Re-grep memory dir for old refs**

```bash
grep -ln '@mwaddip/ergots-\|packages/proof' /home/mwaddip/.claude/projects/-home-mwaddip-projects-ergots/memory/
```

- [ ] **Step 2: For each file, substitute per the rules.**

- [ ] **Step 3: No commit (user-local memory dir).**

---

## T17 — Repo-level gitignored handoff files for next session

**Files (gitignored; updated for next-session handoff):**
- Modify: `SESSION_CONTEXT.md` (13 refs; gitignored)
- Modify: `HANDOFF_PROMPT.md` (10 refs; gitignored)

- [ ] **Step 1: Substitute per the rules** AND update SESSION_CONTEXT.md to reflect post-rename state (`@ergots/*` namespace; packages/nipopow/ directory; etc.).

- [ ] **Step 2: Update HANDOFF_PROMPT.md** for next session's start-of-conversation context. Strip rename-specific content and prepare for "nipopow-module work" continuation.

- [ ] **Step 3: No commit (both files gitignored).**

---

## T18 — Final comprehensive verification

- [ ] **Step 1: Comprehensive grep — zero remaining old-name refs in tracked files**

```bash
cd /home/mwaddip/projects/ergots && git ls-files | xargs grep -ln '@mwaddip/ergots-\|packages/proof' 2>/dev/null
```
Expected: empty output (no tracked files match). If any match: STOP, investigate, fix.

- [ ] **Step 2: Final test run + tsc + cargo**

```bash
cd /home/mwaddip/projects/ergots && npm test --workspaces --if-present 2>&1 | tail -10
for pkg in packages/avltree packages/ergoscript packages/nipopow; do (cd "$pkg" && npx tsc --noEmit); done
cd /home/mwaddip/projects/ergots/fixture-gen && cargo build 2>&1 | tail -5
```
Expected: all green.

- [ ] **Step 3: Verify git tree is clean (no leftover untracked/modified)**

```bash
cd /home/mwaddip/projects/ergots && git status
```
Expected: nothing to commit (modulo gitignored SESSION_CONTEXT.md / HANDOFF_PROMPT.md).

- [ ] **Step 4: Hand off — surface "further nipopow-module work" decision to user**

End-of-rename status report to user; ask for specifics on the nipopow-module work.

---

## Phase ordering notes

- **No artificial stops between phases.** Per `[[feedback-no-artificial-stops]]`: drive forward through T1→T15 with per-task commits; only stop if a verification fails or the user interrupts.
- **T0 is purely a safety check** — no commit; if any baseline check fails, STOP and investigate before any rename edits.
- **T13 (fixture-gen) is the only Rust-side verification.** The path-string change in `main.rs:7` affects where `cargo run` writes regenerated fixtures, so the determinism check is mandatory.
- **T15 (PLAN.md) is intentionally last** — keeps this rename plan readable through execution and only marks COMPLETE at the very end.
- **T16/T17/T18 are user-local + final verification** — no commits, no risk of merging incomplete state.

## Risk callouts

- **`npm install` lockfile changes.** `package-lock.json` is gitignored, so regenerating it doesn't affect committed state. If `npm install` itself fails (e.g., npm registry issue), STOP — that's an environmental problem, not a rename problem.
- **`cargo run` determinism.** If `cargo run` after the path-string change produces unexpected fixture changes, that means the path was being used in a way I missed during discovery. STOP, re-grep, fix.
- **Memory-file updates** (T16) and **handoff-file updates** (T17) are explicitly NOT commits — they're user-local artifacts. Do them; don't commit them.
- **Substitution edge case: `@mwaddip/ergots` (without trailing `-pkg`).** Per pre-flight grep, only the four substitution targets appear; no bare-org occurrences. If any surface during execution, STOP and decide explicitly.
