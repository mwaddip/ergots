# Phase 2j-b — Autonomous Fix Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** OVERRIDES rules apply, especially #6 (verification commands must pass before claiming any task done), #5 (root-cause mandate), #2 (95% confidence escalation), #7 (re-read files before editing after 10+ messages), #8 (read→edit→read). Per `[[feedback-subagent-explicit-rules]]`.

**Spec:** `docs/specs/2026-05-23-ergoscript-2j-b-autonomous-fix-loop-design.md` (v2, reviewer-pass applied; spec contains all design decisions)

**Goal:** Build the self-orchestrated autonomous fix loop infrastructure (heartbeat + log writer + repeated-arm detector + subagent prompt templates) and prove it works end-to-end by closing the h=3850 cost-drift as iter-1. The loop runs in this Claude session via `Bash run_in_background` + `Agent` tool dispatch; orchestration code is runtime, not committed.

**Architecture (one-paragraph summary):** Orchestrator spawns harness; harness exits on RED; orchestrator reads `error-report.json`, loads `~/projects/OVERRIDES.md` fresh, dispatches info-gather subagent (returns diagnosis with confidence rating + OVERRIDES echo-back); if `confidence ≥ 95`, dispatches fix-apply subagent (writes regression test + applies fix + commits + returns `testCountBefore`/`testCountAfter`); orchestrator independently verifies test count, appends log entry, runs repeated-arm detector, re-spawns harness. Loop halts on the narrow stop-signal set defined in the spec.

**Invariants:**

- No existing public API changes. `packages/ergoscript/` source remains stable in structure; only calibration patches land via the loop.
- All four existing harness validation passes (header / output-roundtrip / evaluate / verify-signature / evaluate-cost / evaluate-oracle-mismatch) remain unchanged. The loop sits ABOVE these.
- OVERRIDES.md must be inlined into every subagent dispatch (no caching across iterations). Per `[[feedback-subagent-explicit-rules]]`.
- Heartbeat is plain-text stdout; loop log is structured JSON. Two separate audiences (operator vs orchestrator).
- All orchestrator state survives session restart by living on disk.

---

## Task ordering

```
T1   Heartbeat in harness walker.ts (+ optional unit test)
T2   Loop log writer module + tests
T3   Repeated-arm detector module + tests
T4   Info-gather subagent prompt template (markdown file)
T5   Fix-apply subagent prompt template (markdown file)
T6   Orchestrator verification:
     T6.1 — Real-subagent dispatch against canned h=3850 mock
     T6.2 — Synthetic-harness shell script + state-machine traversal
T7   First end-to-end real loop run (h=3850 = iter-1)
T8   Docs sweep: SESSION_CONTEXT + HANDOFF + facts/ergoscript-eval.md +
     tools/mainnet-validate/README.md + memory refresh
```

Expected commit count: 5 code commits (T1-T5) + N iteration commits during T7 (at least 1) + 1 docs sweep commit (T8) = 6 + N total.

---

## Task 1: Heartbeat in harness walker

**Goal:** Emit `[heartbeat] ...` lines to stdout every 100 successful blocks for the operator's eyeball-progress signal AND the orchestrator's silence-watchdog.

**Files:**
- Modify: `tools/mainnet-validate/harness/src/main.ts` (the walker loop)
- Optionally modify: `tools/mainnet-validate/harness/src/walker-loop.ts` if walker logic is extracted

**Heartbeat formats (per spec):**

- Startup: `[heartbeat] starting at h=NNNNN (tip=TTTTTT)`
- Per 100 blocks: `[heartbeat] h=NNNNN (epoch EE) — txs=N boxes=N spends=N — avg=NNms/blk`
- Halt: `[heartbeat] halt at h=NNNNN — phase=<phase> errorCode=<code>`
- Tip-reach: `[heartbeat] tip reached at h=NNNNN`
- Milestone (100k): `[heartbeat] crossed h=NNNNNN milestone — orchestrator will schedule full rewalk next iteration`

**Critical:** The startup heartbeat MUST include `tip=TTTTTT` (shim-reported tip) so the orchestrator can capture it for tip-reach disambiguation (C2 from reviewer-pass). Without this, the loop has no reliable signal for "we've actually walked the whole chain" vs "we hit `--max-height` cap mid-chain".

**Per-OVERRIDES verification gates:**

- `cd tools/mainnet-validate/harness && npm run build` clean
- `cd tools/mainnet-validate/harness && npx tsc --noEmit` clean
- `cd tools/mainnet-validate/harness && npm test` clean (74 existing tests stay green)

- [ ] **Step 1: Re-read `src/main.ts` to identify the walker loop location and existing log statements.**

```bash
cd /home/mwaddip/projects/ergots/tools/mainnet-validate/harness
grep -n 'walking\|tip reached\|halt at' src/main.ts | head -20
```

- [ ] **Step 2: Implement heartbeat emission.**

Walker tracks `successfulBlocksSinceLastHeartbeat` + `wallClockMsAtLastHeartbeat`. On every successful block:
- If count >= 100: emit per-100 heartbeat with `epoch = Math.floor(height / 1024)` + avg = `(wallClockNow - wallClockMsAtLastHeartbeat) / 100`. Reset counter.

On startup (after shim handshake captures tip): emit startup heartbeat including `tip=`.

On halt path: emit halt heartbeat with phase + errorCode from the structured error.

On tip-reach: emit tip-reach heartbeat.

On 100k milestone crossing: emit milestone heartbeat (only at the FIRST block of a new 100k bucket — `prevHeight < 100000*K && curHeight >= 100000*K`).

- [ ] **Step 3: Verify TypeScript + build.**

```bash
npx tsc --noEmit && npm run build
```

- [ ] **Step 4: Run existing tests to confirm no regressions.**

```bash
npm test
```

Expected: 74 passing (no new tests yet).

- [ ] **Step 5 (optional): Unit test for heartbeat formatter.**

If the heartbeat formatting is extracted to a `formatHeartbeat(...)` helper, add a small `harness/test/heartbeat.test.ts` covering the five formats. If folded inline into the walker, skip.

- [ ] **Step 6: Commit.**

```bash
git add tools/mainnet-validate/harness/src/main.ts
# + walker-loop.ts and heartbeat.test.ts if applicable
git commit -m "$(cat <<'EOF'
feat(2j-b/T1): emit heartbeat lines every 100 blocks for loop orchestrator

Walker now emits [heartbeat] prefixed lines on startup, per 100 successful
blocks, on halt, on tip-reach, and at 100k-block milestones. The startup
heartbeat includes the shim-reported tipHeight so the orchestrator can
disambiguate tip-reach from --max-height cap (per spec §"Tip-reach
disambiguation").

Per OVERRIDES rule #6: tsc --noEmit + npm test + npm run build all clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Loop log writer module

**Goal:** Add `appendLoopLogEntry` + `readLoopLog` + atomic-write semantics for `tools/mainnet-validate/findings/loop-log.json`.

**Files:**
- Create: `tools/mainnet-validate/harness/src/loop-log.ts`
- Create: `tools/mainnet-validate/harness/test/loop-log.test.ts`

**API surface:**

```ts
export interface LoopLogEntry {
  iteration: number
  timestamp: string
  halt: { height: number; phase: string; errorCode: string; location: {...}; evaluateCost?: {...} }
  diagnosis: { rootCause, sigmaRustCites, ourCodeCites, proposedFix, redFixtureSpec, confidence, uncertaintySources }
  fix: { outcome: 'SUCCESS' | 'FAILURE'; overridesEcho: string; testCountBefore: number; testCountAfter: number; commitSha?: string; ... }
  smokeResult: { walkedFromHeight: number; walkedToHeight: number | null; outcome: 'halt' | 'tip-reached' | 'max-height' | 'pending' }
}

export function appendLoopLogEntry(entry: LoopLogEntry, path?: string): void
export function readLoopLog(path?: string): LoopLogEntry[]
```

Default path is `tools/mainnet-validate/findings/loop-log.json` (resolve relative to `findings/`).

**Atomicity discipline:**
- Read file mtime + content
- Parse + push
- Write to `<path>.tmp` + rename to `<path>`
- If file's mtime changed between read and write attempt: throw with message containing "external modification"; orchestrator catches as `'log-append-failure'` (M2 from reviewer).

**Per-OVERRIDES verification gates:**
- `npx tsc --noEmit` clean
- `npm test` clean (74 + new loop-log tests passing)

- [ ] **Step 1: Create the module + types.**

Define `LoopLogEntry` interface mirroring spec §"Log format". Reference structures from existing `error-report.ts` for `halt` field.

- [ ] **Step 2: Implement atomic write + mtime guard.**

```ts
import { readFileSync, writeFileSync, statSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export function appendLoopLogEntry(entry: LoopLogEntry, path = DEFAULT_PATH): void {
  let existing: LoopLogEntry[] = []
  let mtimeBefore: number | null = null
  try {
    const st = statSync(path)
    mtimeBefore = st.mtimeMs
    existing = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  existing.push(entry)
  // Re-check mtime; if changed, external modification raced us
  if (mtimeBefore !== null) {
    const stAfter = statSync(path)
    if (stAfter.mtimeMs !== mtimeBefore) {
      throw new Error(`loop-log.json: external modification detected (mtime ${mtimeBefore} → ${stAfter.mtimeMs})`)
    }
  }
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

export function readLoopLog(path = DEFAULT_PATH): LoopLogEntry[] {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
```

- [ ] **Step 3: Unit tests.**

Cover: empty-log read, write-then-read round-trip, append-twice round-trip, external-mtime-modification detection (touch the file between read + write), JSON.parse failure handling.

- [ ] **Step 4: Verify.**

```bash
cd tools/mainnet-validate/harness && npx tsc --noEmit && npm test
```

Expected: 74 + ~6 = 80 tests passing.

- [ ] **Step 5: Commit.**

```
feat(2j-b/T2): add loop log writer with atomic-write + external-mod guard

src/loop-log.ts exports appendLoopLogEntry + readLoopLog with mtime-based
external-modification detection (per spec §"Reconciliation" + M2 reviewer
finding). Atomic write via tmp + rename. Default path is
tools/mainnet-validate/findings/loop-log.json.

Per OVERRIDES rule #6: tsc + npm test all clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Task 3: Repeated-arm detector module

**Goal:** Pure function over `loop-log.json` that surfaces "same arm fixed N times" patterns.

**Files:**
- Create: `tools/mainnet-validate/harness/src/repeated-arm-detector.ts`
- Create: `tools/mainnet-validate/harness/test/repeated-arm-detector.test.ts`

**API:**

```ts
export interface DetectorResult {
  tripped: boolean
  arm?: string
  count?: number
  iterations?: number[]
}

export function detectRepeatedArm(
  log: LoopLogEntry[],
  threshold: number = 3
): DetectorResult
```

**Canonical arm names policy:** Discipline A (source-file basename without `.ts`) per spec §"Canonical arm names policy". Detector treats `affectedArm` as exact-string. Orchestrator (not the detector) enforces the basename discipline.

**Per-OVERRIDES verification gates:**
- `npx tsc --noEmit` clean
- `npm test` clean

- [ ] **Step 1: Implement.**

```ts
export function detectRepeatedArm(log: LoopLogEntry[], threshold = 3): DetectorResult {
  const armCounts = new Map<string, number[]>() // arm → iterations
  for (const entry of log) {
    const arm = entry.diagnosis.proposedFix.affectedArm
    const iters = armCounts.get(arm) ?? []
    iters.push(entry.iteration)
    armCounts.set(arm, iters)
  }
  for (const [arm, iters] of armCounts) {
    if (iters.length >= threshold) {
      return { tripped: true, arm, count: iters.length, iterations: iters }
    }
  }
  return { tripped: false }
}
```

- [ ] **Step 2: Unit tests.**

Cover: empty log → false; below threshold → false; at threshold → true with arm + count + iterations; multiple arms one at threshold → true on the right arm; threshold-0 edge case (return first arm or error per design choice — pick error and document).

- [ ] **Step 3: Verify + commit.**

```
feat(2j-b/T3): add repeated-arm detector for class-pattern surfacing

src/repeated-arm-detector.ts exports detectRepeatedArm (pure function over
LoopLogEntry[]). Default threshold 3; configurable per call. Returns
{tripped, arm, count, iterations}.

Per OVERRIDES rule #6: tsc + npm test all clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Task 4: Info-gather subagent prompt template

**Goal:** Static markdown file that the orchestrator string-substitutes per dispatch.

**Files:**
- Create: `tools/mainnet-validate/loop-prompts/info-gather.md`

**Template structure (per spec §"Subagent prompt templates"):**

```markdown
## Version: 1

You are diagnosing a divergence between sigma-rust (oracle) and our TS evaluator
in the @ergots/ergoscript package.

## OVERRIDES (read and apply)

{{OVERRIDES}}

## Halt to diagnose

Error report:
{{ERROR_REPORT_JSON}}

Recent loop log entries (last 5):
{{RECENT_LOG_ENTRIES}}

Relevant facts/ slice (evaluator-surface):
{{FACTS_ERGOSCRIPT_EVAL}}

Cross-cutting facts:
{{FACTS_ERGOSCRIPT}}

## Source paths (read these as needed)

- sigma-rust eval:  ~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/
- sigma-rust IR:    ~/projects/ergots/external/sigma-rust/ergotree-ir/src/
- our eval:         /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/
- our wire:         /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/
- our tests:        /home/mwaddip/projects/ergots/packages/ergoscript/test/eval/

## Task

1. Read the error report. Identify failing phase + errorCode + location.
2. Read surfaced ergoTreeHex; decode to identify arms exercised.
3. For cost-drift: identify which arm(s) charge differently. Source-read
   sigma-rust's per-arm code (`eval/<arm>.rs`) AND our TS arm. Compute
   the expected delta.
4. For oracle-mismatch: identify which side's behavior is wrong by
   comparing sigma-rust source vs. our TS source at the eval path the
   input took.
5. Rate your confidence 0-100 based on:
   - +30 — direct sigma-rust source citation showing the exact charge or behavior
   - +30 — numerical fingerprint match
   - +20 — no alternative explanations come to mind
   - +20 — you can describe the regression test that would catch this

   **ASYMMETRIC RULE for cost-drift specifically.** For `errorCode == 'cost-drift'`,
   you MUST have BOTH the +30 source citation AND the +30 numerical fingerprint
   match to reach `confidence >= 95`. If the observed delta does not reduce to
   an integer-product fingerprint you can predict pre-fix, declare
   `confidence < 95` regardless of other categories.

6. Return DiagnosisOutput JSON below.
7. **OVERRIDES echo-back.** As the FIRST entry in `uncertaintySources` (even
   if confidence == 100), include the literal:
   `"OVERRIDES rules received: #2, #5, #6, #7, #8, #10"`
   listing every OVERRIDES rule number whose text appeared in your prompt.
   If you did NOT receive OVERRIDES text, return confidence: 0 and set
   `uncertaintySources[0] = "OVERRIDES NOT RECEIVED"`.

## Output schema

Return ONLY this JSON, no surrounding prose:

```json
{
  "rootCause": "...",
  "sigmaRustCites": [{"path": "...", "line": N, "snippet": "..."}],
  "ourCodeCites": [{"path": "...", "line": N, "snippet": "..."}],
  "proposedFix": {
    "summary": "...",
    "affectedArm": "<source-file-basename-without-.ts>",
    "expectedCostDelta": 0,
    "filesToTouch": ["..."]
  },
  "redFixtureSpec": {
    "fixturePath": "packages/ergoscript/test/eval/...",
    "inputDescription": "...",
    "expectedValue": "...",
    "expectedCost": N
  },
  "confidence": NN,
  "uncertaintySources": ["OVERRIDES rules received: #...", ...]
}
```

## Constraints (OVERRIDES rule #2)

Confidence < 95 means you DO NOT propose a fix; return the diagnosis with
uncertainty populated and the loop will halt for human review.
```

- [ ] **Step 1: Write the template file.**

- [ ] **Step 2: Sanity check — list every `{{...}}` placeholder in the file.**

```bash
grep -o '{{[A-Z_]*}}' tools/mainnet-validate/loop-prompts/info-gather.md | sort -u
```

Expected: `{{OVERRIDES}}` `{{ERROR_REPORT_JSON}}` `{{RECENT_LOG_ENTRIES}}` `{{FACTS_ERGOSCRIPT_EVAL}}` `{{FACTS_ERGOSCRIPT}}`. The orchestrator's substitution code must handle exactly this set.

- [ ] **Step 3: Commit.**

```
feat(2j-b/T4): add info-gather subagent prompt template

tools/mainnet-validate/loop-prompts/info-gather.md is the static template
the orchestrator string-substitutes per dispatch. Includes OVERRIDES inline,
asymmetric rubric for cost-drift (per spec C5), and DiagnosisOutput schema.
Version 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Task 5: Fix-apply subagent prompt template

**Goal:** Static markdown file mirroring T4 shape; receives DiagnosisOutput as input.

**Files:**
- Create: `tools/mainnet-validate/loop-prompts/fix-apply.md`

**Template structure (per spec §"Subagent prompt templates" Fix-apply):**

```markdown
## Version: 1

You are applying a calibration fix to align our TS evaluator with sigma-rust.

## OVERRIDES (read and apply — load-bearing for crypto/consensus code)

{{OVERRIDES}}

Specifically attend to:
- Rule #2 (confidence escalation): if while implementing you discover the
  diagnosis was incomplete (e.g., the fix would change behavior in ways
  not predicted), STOP and return FAILURE with failureReason.
- Rule #5 (root-cause): no band-aids. Fix at the diagnosed site.
- Rule #6 (forced verification): `npm test` AND `npx tsc --noEmit` MUST
  pass before commit.
- Rule #7 (context decay): re-read every file before editing.
- Rule #8 (edit integrity): read → edit → read.

## Diagnosis (from info-gather subagent)

{{DIAGNOSIS_JSON}}

## Pre-fix test count baseline

testCountBefore: {{TEST_COUNT_BEFORE}}

(The orchestrator captured this independently via
`cd packages/ergoscript && npx vitest run --reporter=json | jq '.numTotalTests'`.
You will report your own value in FixOutput; the orchestrator will cross-check.)

## Iteration metadata

iteration: {{ITER_N}}

## Repo conventions

- Pure TS, browser-clean, no Buffer, no node:* in src/.
- TDD discipline: RED fixture → GREEN patch. Write the regression test
  FIRST, run it, confirm it goes RED, then apply the fix.
- Commit message: `loop(2j-b/iter-{{ITER_N}}): <short summary>`.

## Task

1. Re-read the file(s) in diagnosis.proposedFix.filesToTouch (OVERRIDES #7/#8).
2. Write the regression test at diagnosis.redFixtureSpec.fixturePath.
3. Run `cd packages/ergoscript && npx vitest run <test-path>` — confirm
   the test goes RED with the expected mismatch.
4. Apply the calibration patch to the file(s) in filesToTouch.
5. Re-run the regression test — confirm GREEN.
6. Run `cd packages/ergoscript && npm test` — confirm full suite passes.
   Capture the test count from vitest's output (parse the
   `Tests  NNNN passed` line OR use `--reporter=json | jq '.numTotalTests'`).
7. Run `cd packages/ergoscript && npx tsc --noEmit` — confirm clean.
8. If the patch touches harness-affecting code: run
   `cd tools/mainnet-validate/harness && npm test && npx tsc --noEmit`.
9. Commit ONLY changed files (regression test + calibration patch +
   optional facts/ergoscript-eval.md note). Use commit prefix
   `loop(2j-b/iter-{{ITER_N}}):`.
10. Return FixOutput JSON.

## OVERRIDES echo-back

In `overridesEcho`, return the literal:
`"OVERRIDES rules received: #2, #5, #6, #7, #8, #10"`
listing every rule number whose text appeared in your prompt. The
orchestrator validates this echo includes #2/#5/#6/#7/#8.

## Output schema

Return ONLY this JSON, no surrounding prose:

```json
{
  "outcome": "SUCCESS",
  "overridesEcho": "OVERRIDES rules received: #2, #5, #6, #7, #8, #10",
  "testCountBefore": NNNN,
  "testCountAfter": NNNN,
  "commitSha": "abcd1234",
  "filesChanged": ["..."],
  "regressionTestPath": "...",
  "diffStat": {"added": N, "removed": N}
}
```

Or on FAILURE:

```json
{
  "outcome": "FAILURE",
  "overridesEcho": "OVERRIDES rules received: #...",
  "testCountBefore": NNNN,
  "testCountAfter": NNNN,
  "failureReason": "...",
  "failureLog": "..."
}
```

## Failure modes that MUST return outcome: FAILURE

- Regression test does not go RED before fix.
- npm test breaks pre-existing tests post-fix.
- tsc --noEmit fails post-fix.
- You discover mid-implementation that diagnosis is incomplete.
```

- [ ] **Step 1: Write the template file.**

- [ ] **Step 2: Sanity check placeholders.**

```bash
grep -o '{{[A-Z_]*}}' tools/mainnet-validate/loop-prompts/fix-apply.md | sort -u
```

Expected: `{{OVERRIDES}}` `{{DIAGNOSIS_JSON}}` `{{TEST_COUNT_BEFORE}}` `{{ITER_N}}`.

- [ ] **Step 3: Commit.**

```
feat(2j-b/T5): add fix-apply subagent prompt template

tools/mainnet-validate/loop-prompts/fix-apply.md mirrors T4 shape with
FixOutput schema, mandatory OVERRIDES rule #2/#5/#6/#7/#8 inline citation,
and test-count self-report cross-checked by orchestrator (per spec C4).
Version 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Task 6: Orchestrator verification (T6.1 + T6.2)

**Goal:** Validate the orchestration pattern works BEFORE running the real loop on real mainnet halts. Two stages per spec §"Execution order" T6.

**T6.1 — Real-subagent dispatch against canned h=3850.**

- [ ] **Step 1: Verify template substitution works.**

In the orchestrator session (this session), run:

```bash
# Load OVERRIDES.md fresh
cat ~/projects/OVERRIDES.md > /tmp/2j-b-overrides.txt
# Load canned error-report.json from 2j-a's T9 smoke
cp bootstrap-data/t-2j-a-error-report.json /tmp/2j-b-error-report.json
# Load recent log entries (empty for iter-0 calibration probe)
echo '[]' > /tmp/2j-b-recent-log.json
# Load facts slices
cp facts/ergoscript-eval.md /tmp/2j-b-facts-eval.md
cp facts/ergoscript.md /tmp/2j-b-facts.md
```

Substitute these into the T4 template (read template; replace placeholders; write final prompt to `/tmp/2j-b-gather-prompt.md`).

- [ ] **Step 2: Dispatch the info-gather subagent with the rendered prompt.**

Use the Agent tool. The subagent should return DiagnosisOutput JSON.

Verify:
- `uncertaintySources[0]` matches `"OVERRIDES rules received: #2, #5, #6, #7, #8, #10"` (orchestrator: assert presence of each rule number).
- `confidence >= 95` (h=3850 has 99%+ pre-known evidence; the asymmetric rubric requires the 6×4=24 fingerprint, which is well-documented in 2j-a's findings doc).
- `affectedArm` matches the discipline-A basename of the first entry in `filesToTouch`.
- `proposedFix.expectedCostDelta == 0`.

If any of these fail, the prompt template is broken — fix the template, repeat T6.1.

- [ ] **Step 3: Dispatch the fix-apply subagent with the diagnosis.**

Orchestrator captures `testCountBefore = 3782` (or whatever vitest reports independently).

Dispatch fix-apply with `{{DIAGNOSIS_JSON}}` = result from Step 2, `{{TEST_COUNT_BEFORE}}` = 3782, `{{ITER_N}}` = 1.

Verify on return:
- `outcome == 'SUCCESS'`.
- `overridesEcho` parses with all required rule numbers.
- `testCountAfter >= testCountBefore`.
- Independent orchestrator-run `npx vitest --reporter=json | jq '.numTotalTests'` matches subagent's `testCountAfter`.
- `commitSha` exists and `git show <sha>` produces the expected diff shape.
- Regression test at `regressionTestPath` exists and passes.

If T6.1 ends here with the SUCCESS commit landed, it IS effectively T7's iter-1. Proceed to T6.2.

**T6.2 — Synthetic-harness state-machine traversal.**

- [ ] **Step 4: Build a tiny shell-script "fake harness".**

```bash
# tools/mainnet-validate/test-fixtures/synthetic-harness.sh
#!/bin/bash
echo "[heartbeat] starting at h=1 (tip=10000)"
sleep 2
for h in 100 200 300 400; do
  echo "[heartbeat] h=$h (epoch 0) — txs=$((h/10)) boxes=$((h/5)) spends=$((h/8)) — avg=10ms/blk"
  sleep 1
done
echo "[heartbeat] halt at h=500 — phase=evaluate-cost errorCode=cost-drift"
cp tools/mainnet-validate/test-fixtures/canned-error-report-synth.json error-report.json
exit 1
```

Mark executable; commit alongside.

- [ ] **Step 5: Build a heartbeat-silence "stuck harness".**

```bash
# tools/mainnet-validate/test-fixtures/stuck-harness.sh
#!/bin/bash
echo "[heartbeat] starting at h=1 (tip=10000)"
sleep 600   # silence — orchestrator should detect via Monitor watchdog
```

- [ ] **Step 6: Drive the orchestrator through SMOKE → DIAGNOSING → ... → SMOKE using synthetic-harness.sh.**

Mock the fix-subagent return (no real LLM dispatch) — orchestrator hardcodes a no-op FixOutput with SUCCESS. Verify state machine traverses cleanly.

- [ ] **Step 7: Drive the orchestrator against stuck-harness.sh; verify Monitor-based watchdog fires `'harness-silent-heartbeat'` after 5 min.**

Note: this step can be skipped at T6.2 if it's blocking T7; document the skip in the loop-log iter-0 entry.

- [ ] **Step 8: Document T6.1 + T6.2 outcomes in `loop-log.json` as `iteration: 0`.**

Iter-0 reserved for calibration probe per spec §T6.

---

## Task 7: First end-to-end real loop run

**Goal:** Run the autonomous loop against the real harness from h=3850 (or h=1 with the existing checkpoint resume). Let iter-1 close the cost-drift; let subsequent iterations land as far as they can before the first stop signal.

**Pre-conditions:**
- T1-T5 committed.
- T6.1 / T6.2 verified.
- `bootstrap-data/modifiers.redb` (25 GB) exists and is readable.
- `bootstrap-data/t-2j-a-checkpoint.json` exists at `lastValidatedHeight: 3849` (so harness resumes from h=3850).

**Special handling for iter-1:**
- The first iteration may have used T6.1's committed fix already (if T6.1 elected to commit). In that case iter-1 is "smoke walks past h=3850 and halts on whatever divergence comes next".
- If T6.1 did NOT commit (dry-run mode), iter-1 reproduces the h=3850 RED and applies the fix.

- [ ] **Step 1: Configure orchestrator state.**

```bash
# Use the in-repo bootstrap-data path (survives reboots vs /tmp/)
mkdir -p tools/mainnet-validate/findings
[ -f tools/mainnet-validate/findings/loop-log.json ] || echo '[]' > tools/mainnet-validate/findings/loop-log.json
```

- [ ] **Step 2: Initial harness spawn (foreground for first iteration to capture tip).**

```bash
node tools/mainnet-validate/harness/dist/main.js \
  --store-path bootstrap-data/modifiers.redb \
  --sidecar-path bootstrap-data/t-2j-b-sidecar.redb \
  --checkpoint-path bootstrap-data/t-2j-b-checkpoint.json \
  --error-report-path bootstrap-data/t-2j-b-error-report.json \
  --max-height 10000
```

Capture `tip=NNNNNNN` from the startup heartbeat into `bootstrap-data/.tip-height`. After the first halt (or the first run completes), the orchestrator sets `--max-height ${tip}` for subsequent runs.

- [ ] **Step 3: Run the loop.**

The orchestrator (this Claude session) executes the per-iteration sequence from spec §"Components → Per-iteration sequence". For each iteration:
- Read error-report.json
- Reconciliation check
- Load OVERRIDES fresh
- Dispatch info-gather subagent
- Validate echo + confidence
- Capture testCountBefore
- Dispatch fix-apply subagent
- Validate echo + cross-check testCountAfter
- Append log entry
- Run detector
- Re-spawn harness

- [ ] **Step 4: Loop ends on terminal stop signal.**

Document the terminal state in `loop-log.json` and in a findings document.

- [ ] **Step 5: Write findings doc.**

Create `tools/mainnet-validate/findings/2026-05-23-2j-b-first-loop-run.md` summarizing:
- Number of iterations completed
- Heights reached
- Terminal stop signal
- Iteration-by-iteration summary (arm, delta, fix shape)
- Any anomalies or recalibration needed
- Recommendations for the next loop run

---

## Task 8: Docs sweep

**Goal:** Update all load-bearing docs to reflect 2j-b shipping + the first loop run outcome.

**Files:**
- `SESSION_CONTEXT.md` — refresh with T1-T7 outcomes + iter count
- `HANDOFF_PROMPT.md` — next-session pickup state
- `facts/ergoscript-eval.md` — close the "deliberate, cost-equivalent" divergence note (iter-1 will have fixed it) AND update the per-phase changelog with 2j-b
- `facts/ergoscript.md` — coverage table updated if eval surface changed (per iter-1's fix)
- `tools/mainnet-validate/README.md` — document the loop's invocation, log format, stop signals, recovery from halt
- `~/.claude/projects/-home-mwaddip-projects-ergots/memory/project_ergots_direction.md` — refresh

- [ ] **Step 1: SESSION_CONTEXT.md refresh.**

Per `[[feedback-docs-pass-every-phase]]`.

- [ ] **Step 2: HANDOFF_PROMPT.md refresh.**

- [ ] **Step 3: facts/ updates.**

- [ ] **Step 4: tools/mainnet-validate/README.md update.**

- [ ] **Step 5: Memory refresh.**

- [ ] **Step 6: Final commit.**

```
docs(2j-b/T8): refresh SESSION_CONTEXT + HANDOFF + facts + README for 2j-b closure

[bullet list of what changed]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 7: Push to origin/master.**

```bash
git push origin master
```

---

## Done criterion

- T1-T5 committed.
- T6.1 + T6.2 verified.
- T7 produced at least one successful iteration; loop-log.json has well-formed entries.
- T7 findings doc landed.
- T8 docs sweep landed.
- `cargo build` + `cargo test` clean in `shim/` (unchanged; 29 tests).
- `npm test` + `npx tsc --noEmit` + `npm run build` clean in `harness/` (~80 tests).
- `npm test` clean in `packages/ergoscript/` (3782 + iter-1's regression test).
- `git status` clean modulo `audit20260519/` + `bootstrap-data/`.
- `origin/master` aligned.
