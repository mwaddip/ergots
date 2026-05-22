# Phase 2j-pre fix-3 — Atleast/Or/Xor exprTpe arms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` (the fix is small enough that one execution pass suffices). Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #5 — root-cause mandate; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read]. Per `[[feedback-subagent-explicit-rules]]`.

**Spec:** `docs/specs/2026-05-22-ergoscript-2j-pre-fix-3-atleast-exprtpe-design.md` (v2, reviewer pass applied)

**Goal:** Add 3 missing case arms (`Or`, `Xor`, `Atleast`) to `packages/ergoscript/src/mir/expr-tpe.ts`'s top-level switch. The foundation 2-of-3 multisig at h=3850 trips Atleast first; Or/Xor are the same gap at the same call site.

**Architecture (one-paragraph summary):** 3 one-liner case arms inserted after `case 'And':` at `expr-tpe.ts:237-240`. Each returns the sigma-rust-canonical SType per `mir/{or,xor,atleast}.rs::tpe()`. Comment block updated to per-arm style. RED test → GREEN implementation → Layer 3 smoke re-run from fresh sidecar.

**Invariants:**
- Library behavior unchanged except for the 3 newly-handled arms; the default throw remains for the other 14 unhandled variants (per spec Non-goals).
- No public-API additions; no test refactoring beyond new file.
- Package test count grows by 3.

---

## Task ordering

```
T1   PLAN.md committed (this document; overwrites fix-2 plan)
T2   Layer 1 RED — new test/expr-tpe.test.ts with 3 failing tests
     (Or, Xor, Atleast). Confirm they throw ExprTpeError.
T3   GREEN — add 3 arms to expr-tpe.ts + per-arm comment block
     rewrite. Verify per OVERRIDES rule #6.
T4   Rebuild ergoscript dist (npm run build; gitignored — no commit).
T5   Layer 3 smoke re-run from FRESH sidecar; capture new halt
     site (or clean tip-reach) in findings file.
T6   Refresh harness halt-path snapshot for new halt site
     (analogous to fix-2 T9).
T7   SESSION_CONTEXT + HANDOFF + memory refresh + push.
```

Total: 6 commits (T1 + T2 + T3 + T5 + T6 + T7). T4 is gitignored dist rebuild.

---

## Task 1: Commit PLAN.md

- [ ] Stage + commit; one task, no sub-steps.

---

## Task 2: Layer 1 RED — failing tests for 3 new arms

**Files:** Create `packages/ergoscript/test/expr-tpe.test.ts`.

**Tests:**

```ts
import { describe, it, expect } from 'vitest'
import { exprTpe, ExprTpeError } from '../src/mir/expr-tpe'
import type { Expr, SType } from '../src/mir/types'

// Minimal valid Const sub-Exprs for use as sub-fields in the 3 tested
// Expr nodes. We don't recurse into them in the projection; they just
// need to be syntactically valid.
const SBOOLEAN: SType = { tag: 'SBoolean' }
const SINT: SType = { tag: 'SInt' }
const SCOLL_SBOOLEAN: SType = { tag: 'SColl', elem: { tag: 'SBoolean' } }
const SCOLL_SBYTE: SType = { tag: 'SColl', elem: { tag: 'SByte' } }
const SCOLL_SSIGMAPROP: SType = { tag: 'SColl', elem: { tag: 'SSigmaProp' } }

const constBool: Expr = { tag: 'Const', tpe: SBOOLEAN, value: { kind: 'Boolean', value: true } }
const constCollByte: Expr = {
  tag: 'Const',
  tpe: SCOLL_SBYTE,
  value: { kind: 'Coll', elemKind: 'Byte', items: [] },
}
const constInt: Expr = { tag: 'Const', tpe: SINT, value: { kind: 'Int', value: 1 } }
const constCollSigma: Expr = {
  tag: 'Const',
  tpe: SCOLL_SSIGMAPROP,
  value: { kind: 'Coll', elemKind: 'SigmaProp', items: [] },
}

describe('exprTpe (phase 2j-pre fix-3 arms)', () => {
  it('Or returns SBoolean', () => {
    const e: Expr = { tag: 'Or', input: { tag: 'Const', tpe: SCOLL_SBOOLEAN, value: { kind: 'Coll', elemKind: 'Boolean', items: [] } } }
    expect(exprTpe(e)).toEqual({ tag: 'SBoolean' })
  })

  it('Xor returns SColl[SByte]', () => {
    const e: Expr = { tag: 'Xor', left: constCollByte, right: constCollByte }
    expect(exprTpe(e)).toEqual({ tag: 'SColl', elem: { tag: 'SByte' } })
  })

  it('Atleast returns SSigmaProp', () => {
    const e: Expr = { tag: 'Atleast', bound: constInt, input: constCollSigma }
    expect(exprTpe(e)).toEqual({ tag: 'SSigmaProp' })
  })
})
```

(Adjust Const sub-Expr shapes to match the actual `mir/types.ts` `Const` interface — may need slight tweaks for the `value` discriminator. If `kind: 'Coll'` doesn't compile, use a simpler shape or `as Expr` cast for the synthetic test inputs only.)

- [ ] **Step 1: Write the test file.**
- [ ] **Step 2: Run vitest; confirm 3 failures with `ExprTpeError 'tpe-not-implemented'`.**
- [ ] **Step 3: Commit RED.**

---

## Task 3: GREEN — add 3 arms

**Files:** Edit `packages/ergoscript/src/mir/expr-tpe.ts`.

**Insertion point:** after the existing `case 'And':` block at `expr-tpe.ts:237-240`. Replace the misleading comment at line 239 with per-arm comments:

```ts
case 'And':
  // sigma-rust `mir/and.rs::And::tpe`: SBoolean (AND-reduction of a
  // Coll[Boolean]).
  return { tag: 'SBoolean' }
case 'Or':
  // sigma-rust `mir/or.rs::Or::tpe`: SBoolean (OR-reduction of a
  // Coll[Boolean]).
  return { tag: 'SBoolean' }
case 'Xor':
  // sigma-rust `mir/xor.rs::Xor::tpe`: SColl[SByte] (bytewise XOR of
  // two byte collections).
  return { tag: 'SColl', elem: { tag: 'SByte' } }
case 'Atleast':
  // sigma-rust `mir/atleast.rs::Atleast::tpe`: SSigmaProp (threshold
  // composition over Coll[SigmaProp]).
  return { tag: 'SSigmaProp' }
```

- [ ] **Step 1: Read expr-tpe.ts:230-245 (OVERRIDES rule #8).**
- [ ] **Step 2: Apply the 4-arm rewrite (And + new Or + new Xor + new Atleast).**
- [ ] **Step 3: Verify per OVERRIDES rule #6:**

```bash
npx tsc --noEmit -p /home/mwaddip/projects/ergots/packages/ergoscript/tsconfig.json
node_modules/.bin/vitest run packages/ergoscript 2>&1 | tail -3
cd /home/mwaddip/projects/ergots/packages/ergoscript && npx vitest run --config vitest.browser.config.ts 2>&1 | tail -3
cd /home/mwaddip/projects/ergots
```

Expected: tsc clean; all tests pass including 3 new ones; cross-runtime jsdom clean.

- [ ] **Step 4: Commit GREEN.**

---

## Task 4: Rebuild dist

- [ ] **`npm --prefix /home/mwaddip/projects/ergots/packages/ergoscript run build`**
- [ ] Verify the build refreshed `dist/index.js` (mtime updated). Gitignored — no commit.

---

## Task 5: Layer 3 smoke from FRESH sidecar

```bash
rm -f /tmp/t-fix3-sidecar.redb /tmp/t-fix3-checkpoint.json /tmp/t-fix3-error-report.json
timeout 600 node /home/mwaddip/projects/ergots/tools/mainnet-validate/harness/dist/main.js \
  --network mainnet \
  --store-path /tmp/ergots-2j-pre-smoke-data/modifiers.redb \
  --sidecar-path /tmp/t-fix3-sidecar.redb \
  --checkpoint-path /tmp/t-fix3-checkpoint.json \
  --error-report-path /tmp/t-fix3-error-report.json \
  --start-height 1 --max-height 10000 --sleep-ms 0 2>&1 | tail -10
```

- [ ] **Step 1: Run smoke.**
- [ ] **Step 2: Document outcome in `tools/mainnet-validate/findings/2026-05-22-fix-3-smoke.md`** (analogous to fix-2 findings). Capture: blocks validated, new halt site (phase + errorCode + height + location), comparison with fix-2 baseline (halt at h=3850 evaluate-exprTpe-Atleast).
- [ ] **Step 3: Commit findings.**

---

## Task 6: Refresh harness halt-path snapshot

**Strategy depends on T5 outcome (per spec §Layer 3 reviewer-pass M2 calibration):**

- **Likely outcome:** harness advances some N blocks past 3850 then hits a new exprTpe halt on `CalcSha256`, `ExtractBytes`, `SigmaPropIsProven`, or similar. halt-path snapshot updates to new height + new errorCode.
- **Stretch outcome:** smoke walks to --max-height cleanly. halt-path test's premise breaks; needs deeper rework (deliberate fault injection, or pin to a much-higher halt height).

- [ ] **Step 1: Read T5 findings to know which scenario applied.**
- [ ] **Step 2: Update `halt-path.test.ts:119-185` accordingly:**
  - Bump `--max-height` if the new halt is further than 3850.
  - Update `report.height`, `report.phase`, `report.errorCode`, `report.location.*` to match T5's observed site.
  - Update narrative comments.
- [ ] **Step 3: Verify `npm test` in `tools/mainnet-validate/harness/` passes.**
- [ ] **Step 4: Commit.**

---

## Task 7: SESSION_CONTEXT + HANDOFF + memory + push

- [ ] **Step 1: Refresh `SESSION_CONTEXT.md`** (gitignored, local-only) with fix-3 closure: arms added, test counts, new halt site (if any).
- [ ] **Step 2: Refresh `HANDOFF_PROMPT.md`** (gitignored): strike fix-list item 3 with RESOLVED; add new halt-site fix-list item from T5 if any.
- [ ] **Step 3: Refresh `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md`** with fix-3 summary.
- [ ] **Step 4: Update fix-2 smoke-findings file's path reference** (reviewer Mi4): `wire/expr-tpe.ts` → `mir/expr-tpe.ts` if any cross-reference is wrong. Sweep for misreferences.
- [ ] **Step 5: Push to origin/master.**

```bash
git push origin master
```

Per OVERRIDES: never `--force`, never `--no-verify`.

---

## Done criteria

- All 7 tasks committed (6 commits + T4's gitignored rebuild).
- `git status` clean modulo `audit20260519/`.
- `origin/master` aligned.
- `npx tsc --noEmit -p packages/ergoscript/tsconfig.json` CLEAN.
- `node_modules/.bin/vitest run packages/ergoscript` — all pass + 3 new = 3204 total (was 3201).
- Cross-runtime jsdom CLEAN.
- `cd tools/mainnet-validate/harness && npm test` CLEAN (74 tests, halt-path snapshot refreshed).
- Layer 3 smoke documented; new halt site captured for next fix-list item.

**Done criteria explicitly NOT in scope:**
- Closing the other 14 unhandled exprTpe arms (each its own future fix-list item).
- Walking the chain to tip cleanly (2j proper).
- 2j proper cost calibration.
