# Phase 2j-b — Autonomous fix loop on top of the cost-oracle harness

**Status:** Reviewer-pass v2 (2026-05-23) — 5 ★★★ + 6 ★★ findings from general-purpose subagent reviewer applied inline; see §"Reviewer findings applied" at the bottom.
**Author:** Claude Opus 4.7 (1M context) under user direction.
**Phase scope:** Build the autonomous fix-loop infrastructure that drives the 2j-a-wired mainnet-validate harness from h=1 toward tip, dispatching subagents per RED for diagnosis + fix + commit + re-walk. Each loop iteration is a log entry, not a subphase.

**Preceding phase:** 2j-a (cost-oracle wiring; 13 commits on origin/master since `ca50e24`; HEAD `36ba042`).
**Umbrella spec:** [`2026-05-13-ergoscript-interpreter-design.md`](2026-05-13-ergoscript-interpreter-design.md) phase 2j (cost accounting / v1.0.0 release gate).

---

## Goal

Build a **self-orchestrated autonomous fix loop** that runs in this Claude session, spawning the harness in the background, watching for RED, dispatching per-iteration subagents for diagnosis + fix + commit, and continuing until a stop signal. The loop's purpose is to drive the smoke walk from h=1 to mainnet tip (or 2j-b's hard cap) without per-fix human intervention, accumulating an empirical inventory (`loop-log.json`) of every divergence and its remediation.

The h=3850 cost-drift surfaced by 2j-a's Layer-5 smoke becomes iteration-1's RED — the loop's first proof of life.

## Non-goals

- **NOT new ergots-package code.** The loop's iterations ARE authorized to patch `packages/ergoscript/src/eval/*` (calibration fixes) and add regression tests under `packages/ergoscript/test/eval/`, but the loop infrastructure itself lives entirely in `tools/mainnet-validate/`.
- **NOT a new validation pass.** The harness's four passes (header / output-roundtrip / evaluate / verify-signature) and the 2j-a cost-equivalence sub-step are unchanged. The loop reacts to halts; it doesn't introduce them.
- **NOT a CI tool.** Single-developer-driven, run-to-completion semantics. CI on cost-equivalence is downstream of "smoke walks cleanly to mainnet tip", which is the loop's success criterion.
- **NOT a continuous "watch-mainnet" daemon.** The loop terminates on smoke success or stop signal; it does not poll for new tip after reaching the snapshotted tip.
- **NOT a generic Claude-Code automation framework.** Templates and orchestration are scoped to ergots 2j calibration. Re-applying the pattern to other codebases is carry-forward, not 2j-b's deliverable.
- **NOT review-between-iterations.** Per user direction (this conversation, 2026-05-23): subagent dispatch already crosses an explicit boundary; review-between-tasks was an inline-execution mitigation. The loop's iterations do NOT insert review subagents — diagnosis + fix is a 2-subagent dispatch, not 3.

## Motivation

Three converging reasons:

1. **2j-a wired the oracle; per-fix work is now mechanical.** Each RED has the same shape: read `error-report.json` → source-read sigma-rust → identify cost-charging or arm-coverage gap → patch our TS → add regression test → commit. The diagnostic step is research, the fix step is editing. Both are isolatable to focused subagent dispatches; the orchestration between them is loop control flow, not domain reasoning.

2. **Subagent dispatch naturally bounds context growth.** Each iteration's gather + fix subagents run in fresh contexts with prompt-loaded state; the main orchestration session's context grows only by per-iteration log summaries. Context compaction mid-loop is tolerable — the next iteration's subagent re-loads from on-disk state (`loop-log.json` + `error-report.json` + facts/).

3. **Mainnet halts the only authoritative work-prioritizer.** Per the 2j-a per-fix-N convention, "the accumulating findings/ folder becomes the empirical inventory of what mainnet actually exercises". Automating the loop lets that empirical inventory accumulate at machine speed rather than human-spec-overhead speed. Post-hoc pattern detection over the log surfaces class-level bugs (same arm fixed N times) that motivate deeper refactor specs.

## Architecture

### One-paragraph summary

Orchestrator (this Claude session) spawns the mainnet-validate harness via `Bash run_in_background`, awaits exit notification, reads `error-report.json` + `checkpoint.json` on halt, dispatches an **info-gather subagent** with the error report + recent log entries + relevant `facts/` slices + OVERRIDES.md inline. The info-gather subagent returns a structured diagnosis `{rootCause, sigmaRustCites, proposedFix, confidence: 0-100, redFixtureSpec}`; if `confidence < 95` the loop halts for human input. If `confidence ≥ 95`, the orchestrator dispatches a **fix-apply subagent** with the diagnosis; the fix subagent writes the regression test under `packages/ergoscript/test/eval/`, applies the calibration patch, runs `npm test` + `npx tsc --noEmit`, commits with a `loop(2j-b/iter-N):` prefix, and returns the commit SHA. The orchestrator appends a structured entry to `tools/mainnet-validate/findings/loop-log.json`, runs the repeated-arm detector, schedules a full-rewalk-from-h=1 if the next iteration would cross a 100k-block milestone, and re-spawns the harness from checkpoint. Heartbeat lines from the walker stream into the session every 100 successful blocks (with `epoch = Math.floor(height / 1024)`). Loop terminates on `<95% confidence`, fix-subagent FAILURE, repeated-arm trip, 100-iteration cap, smoke tip-reach, or user interrupt.

### Components

**Harness side (`tools/mainnet-validate/harness/`, TS, T1):**

- **Heartbeat in `src/main.ts` or `src/walker-loop.ts`** — emit `[heartbeat] h=N (epoch E) — txs=X, boxes=Y, spends=Z — avg=Wms/blk over last 100` to stdout every 100 successful blocks. Also emit on startup (`[heartbeat] starting at h=N`) and on every halt (`[heartbeat] halt at h=N — phase=... errorCode=...`). Plain prefixed log lines, NOT structured JSON — these go to the orchestrator's stdout stream for the user's eyeball-progress signal, not machine parse.

**Orchestrator (this Claude session, T6 — runtime, not committed code):**

- Bash `run_in_background` spawns harness with appropriate `--store-path`, `--sidecar-path`, `--checkpoint-path`, `--error-report-path`, `--max-height` flags. The `--max-height` value is **always set to the shim's reported `tipHeight`** (captured from the first walk's startup heartbeat `[heartbeat] starting at h=N (tip=T)`); this is what makes exit-0 unambiguous (see "Tip-reach disambiguation" below).
- **OVERRIDES loader.** Before every subagent dispatch, the orchestrator reads `~/projects/OVERRIDES.md` fresh via the `Read` tool and substitutes the FULL file content into the template's `{{OVERRIDES}}` placeholder verbatim. No caching across iterations. Resolution failure (file missing, read error) → HALT-FOR-INPUT with signal `'overrides-load-failure'`. The orchestrator MUST NOT fall back to a memorized OVERRIDES; if the file can't be read, the loop stops.
- **OVERRIDES echo-back self-check.** Each subagent template instructs the subagent to echo back the OVERRIDES rule numbers it received as the FIRST element of `DiagnosisOutput.uncertaintySources` (or `FixOutput.failureLog` for fix-apply, even on SUCCESS) using the format `"OVERRIDES rules received: #2, #5, #6, #7, #8, #10"`. The orchestrator parses this echo; if any of {#2, #5, #6, #7, #8} are missing, halt with `'overrides-missing-from-subagent'`. This is the only end-to-end test that the substitution actually reached the subagent.
- **Tip-reach disambiguation.** Harness exit 0 means `endHeight = Math.min(--max-height, tipHeight)` was reached cleanly; the harness CANNOT distinguish "max-height cap" from "tip-reach" via exit code alone (per `main.ts:482` source). The orchestrator MUST verify by reading `checkpoint.json.lastValidatedHeight` and comparing against the tip height it captured from the first spawn's startup heartbeat. If `lastValidatedHeight >= tipHeight` → HALTED_OK. Otherwise (impossible if `--max-height` was passed correctly) → HALTED_INPUT with `'unexpected-early-exit'`. Because the orchestrator always passes `--max-height tipHeight` after the first walk, max-height cap and tip-reach collapse to the same condition.
- **In-memory vs on-disk state discipline.** ALL orchestrator state survives a session restart by living on disk: `loop-log.json` (iteration history), `checkpoint.json` (harness resume point), `error-report.json` (last halt's structured data), `bootstrap-data/.tip-height` (captured tip from first walk — new file, write-once). NO state is held in conversation context across tool calls. If the session compacts mid-iteration, the orchestrator MUST be able to reconstruct from these files alone — see "Reconciliation on iteration start" below.
- Per-iteration sequence:
  1. Read `error-report.json` + last 5 log entries + freshly load `OVERRIDES.md`
  2. **Reconciliation check** (see section below) — detect compaction-induced state drift
  3. Substitute placeholders → dispatch info-gather subagent (T4 template)
  4. Parse subagent return; validate OVERRIDES echo; if missing → HALT-FOR-INPUT
  5. If `confidence < 95` → HALT-FOR-INPUT
  6. Capture `testCountBefore = npx vitest run --reporter=json | jq '.numTotalTests'` (run from `packages/ergoscript/`)
  7. Substitute placeholders → dispatch fix-apply subagent (T5 template) with diagnosis + `testCountBefore`
  8. Parse fix-apply return; validate OVERRIDES echo
  9. Capture `testCountAfter` post-fix from the subagent's reported value; cross-check by re-running `npx vitest --reporter=json` independently if any doubt; if `testCountAfter < testCountBefore` → HALT-FOR-INPUT with `'test-count-regression'`
  10. If FixOutput.outcome == FAILURE → HALT-FOR-INPUT
  11. Append log entry (T2 writer)
  12. Run repeated-arm detector (T3); if tripped → HALT-FOR-INPUT
  13. If next iteration would cross 100k-block milestone (h crosses 100000, 200000, 300000, ...) → schedule a full-rewalk-from-h=1 as the next harness spawn (delete checkpoint + sidecar, restart)
  14. Re-spawn harness from checkpoint (or full-rewalk per step 13)
  15. Loop until stop signal

**Log writer (`tools/mainnet-validate/harness/src/loop-log.ts`, T2):**

- Exports `appendLoopLogEntry(entry: LoopLogEntry): void` and `readLoopLog(path?: string): LoopLogEntry[]`.
- Default path `tools/mainnet-validate/findings/loop-log.json`. File is a JSON array; append = parse + push + write atomic (write to tmp, rename — same pattern as harness's checkpoint writer).
- `LoopLogEntry` interface (see Log Format section below).

**Repeated-arm detector (`tools/mainnet-validate/harness/src/repeated-arm-detector.ts`, T3):**

- Exports `detectRepeatedArm(log: LoopLogEntry[], threshold = 3): { tripped: boolean; arm?: string; count?: number; iterations?: number[] }`.
- Pure function over the log. Counts occurrences of `diagnosis.affectedArm` (the canonical arm name, e.g., `'ConstPlaceholder'`, `'addPerItemCost'`, `'evalSigmaAnd'`) across log entries; trips when count ≥ threshold.
- Single unit test in `harness/test/repeated-arm-detector.test.ts` covering: no entries → false; below threshold → false; at threshold → true with metadata; multiple arms with one at threshold → true on the right arm.

**Info-gather subagent prompt template (`tools/mainnet-validate/loop-prompts/info-gather.md`, T4):**

- Static markdown file consumed by the orchestrator at dispatch time. Orchestrator string-substitutes placeholders (`{{ERROR_REPORT_JSON}}`, `{{RECENT_LOG_ENTRIES}}`, `{{FACTS_ERGOSCRIPT_EVAL}}`, `{{OVERRIDES}}`) and passes the result as the subagent prompt.
- Required template fields documented in the Subagent Prompt Templates section below.

**Fix-apply subagent prompt template (`tools/mainnet-validate/loop-prompts/fix-apply.md`, T5):**

- Same pattern. Receives info-gather output as the primary input plus OVERRIDES + repo conventions.

### Data flow — per-iteration sequence

```
orchestrator                              subprocess / subagent
────────────                              ─────────────────────
spawn harness (run_in_background)         harness walks h=N..N+K
                                          → emit heartbeats
                                          → on RED: write error-report.json + checkpoint.json
                                          → exit non-zero
notify: harness exited                    (orchestrator wakes)
  ↓
read error-report.json + last 5 log entries
  ↓
dispatch info-gather subagent      ──▶    subagent reads inputs
                                          source-reads sigma-rust
                                          computes confidence
                                          returns DiagnosisOutput
  ↓
if confidence < 95 → HALT-FOR-INPUT
  ↓
dispatch fix-apply subagent        ──▶    subagent writes regression test
                                          applies calibration patch
                                          runs npm test + tsc --noEmit
                                          commits with loop(2j-b/iter-N): prefix
                                          returns FixOutput
  ↓
if FixOutput.outcome == FAILURE → HALT-FOR-INPUT
  ↓
append log entry
  ↓
run repeated-arm detector
  ↓
if tripped → HALT-FOR-INPUT
  ↓
check 100k milestone — if next-iter crosses: delete checkpoint + sidecar
  ↓
re-spawn harness                          (cycle repeats)
```

### Subagent prompt templates

**Info-gather (T4) — output schema:**

```ts
interface DiagnosisOutput {
  rootCause: string                 // 1-3 sentence explanation citing exact mechanism
  sigmaRustCites: Array<{
    path: string                    // e.g., 'ergotree-interpreter/src/eval/expr.rs'
    line: number                    // e.g., 22
    snippet: string                 // 1-3 line excerpt
  }>
  ourCodeCites: Array<{
    path: string                    // e.g., 'packages/ergoscript/src/eval/const-placeholder.ts'
    line: number
    snippet: string
  }>
  proposedFix: {
    summary: string                 // 1-2 sentence what-and-where
    affectedArm: string             // canonical arm name (e.g., 'ConstPlaceholder', 'addPerItemCost', 'evalSigmaAnd')
    expectedCostDelta?: number      // for cost-drift: predicted post-fix delta = 0
    filesToTouch: string[]
  }
  redFixtureSpec: {
    fixturePath: string             // e.g., 'packages/ergoscript/test/eval/const-placeholder-deserialize-cost.test.ts'
    inputDescription: string        // what the fixture exercises
    expectedValue: string           // JSON-encoded expected SValue
    expectedCost: number            // sigma-rust oracle cost
  }
  confidence: number                // 0..100
  uncertaintySources: string[]      // bullet list of what makes confidence < 100
}
```

**Info-gather (T4) — prompt template skeleton (full template in T4 file):**

```
You are diagnosing a divergence between sigma-rust (oracle) and our TS evaluator.

OVERRIDES (read and apply):
{{OVERRIDES}}

The harness halted with:
{{ERROR_REPORT_JSON}}

Recent loop log entries (last 5):
{{RECENT_LOG_ENTRIES}}

Relevant facts/ slices:
{{FACTS_ERGOSCRIPT_EVAL}}
{{FACTS_ERGOSCRIPT}}

Source paths:
- sigma-rust eval: ~/projects/ergots/external/sigma-rust/ergotree-interpreter/src/
- sigma-rust IR: ~/projects/ergots/external/sigma-rust/ergotree-ir/src/
- our eval: /home/mwaddip/projects/ergots/packages/ergoscript/src/eval/
- our wire: /home/mwaddip/projects/ergots/packages/ergoscript/src/wire/

Task:
1. Read the error report. Identify the failing phase + errorCode + location.
2. Read the surfaced ergoTreeHex; decode it to identify the arms exercised.
3. For cost-drift: identify which arm(s) charge differently. Source-read sigma-rust's
   per-arm cost code (`eval/<arm>.rs`) AND our TS arm. Compute the expected delta.
4. For oracle-mismatch: identify which side's behavior is wrong by comparing
   sigma-rust source vs. our TS source at the eval path the input took.
5. Rate your confidence 0-100 based on:
   - Direct sigma-rust source citation showing the exact charge or behavior: +30
   - Numerical fingerprint match (cost delta or value mismatch matches your hypothesis exactly): +30
   - No alternative explanations come to mind after considering edge cases: +20
   - You can describe the regression test that would catch this: +20

   **ASYMMETRIC RULE for cost-drift specifically.** Cost-drift fixes are the
   highest-risk class because they can silently miscalibrate (tests pass; only
   mainnet walk surfaces the drift). For `errorCode == 'cost-drift'`, you MUST
   have BOTH the +30 source citation AND the +30 numerical fingerprint match to
   reach `confidence >= 95`. If the observed delta does NOT reduce to an
   integer-product fingerprint you can predict pre-fix (e.g.,
   "N placeholders × 4 = 24" or "M items × per-iter-cost"), declare
   `confidence < 95` and halt the loop regardless of how strong the other
   categories feel. The 95% bar is earned by EVIDENCE, not by self-rating.

6. Return DiagnosisOutput JSON. If confidence < 95, populate uncertaintySources explicitly.

7. **OVERRIDES echo-back.** As the FIRST entry in `uncertaintySources` array
   (even if confidence is 100 and there are no real uncertainties), include the
   literal string `"OVERRIDES rules received: #2, #5, #6, #7, #8, #10"` listing
   every OVERRIDES rule number whose text appeared in the prompt you received.
   This is a self-check that the orchestrator's OVERRIDES substitution actually
   reached you. If you did NOT receive OVERRIDES text in your prompt, return
   the diagnosis with confidence: 0 and `uncertaintySources[0] = "OVERRIDES
   NOT RECEIVED"` so the orchestrator halts.

Constraints (OVERRIDES rule #2): confidence < 95 means you DO NOT propose a fix;
return the diagnosis with the uncertainty and the loop will halt for human review.
```

**Fix-apply (T5) — output schema:**

```ts
interface FixOutput {
  outcome: 'SUCCESS' | 'FAILURE'
  overridesEcho: string             // ALWAYS present — first line is "OVERRIDES rules received: #..." for echo verification
  testCountBefore: number           // ALWAYS present — captured by the subagent on first vitest invocation
  testCountAfter: number            // ALWAYS present — captured post-fix on the final vitest invocation
  commitSha?: string                // present on SUCCESS
  filesChanged?: string[]           // present on SUCCESS
  regressionTestPath?: string       // present on SUCCESS
  diffStat?: { added: number; removed: number }
  failureReason?: string            // present on FAILURE — what went wrong
  failureLog?: string               // captured npm test / tsc output if applicable
}
```

The orchestrator INDEPENDENTLY verifies `testCountAfter` by re-running `npx vitest --reporter=json` after parsing FixOutput; the subagent's self-reported count is cross-checked, not trusted. If the independent run disagrees with the subagent's reported value, halt with `'test-count-self-report-mismatch'` (signals subagent honesty problem, not a regression).

**Fix-apply (T5) — prompt template skeleton:**

```
You are applying a calibration fix to align our TS evaluator with sigma-rust.

OVERRIDES (read and apply — load-bearing for crypto/consensus code):
{{OVERRIDES}}

Specifically attend to:
- Rule #2 (confidence escalation): if while implementing you discover the diagnosis
  was incomplete (e.g., the fix would change behavior in ways not predicted), STOP
  and return FAILURE with failureReason.
- Rule #5 (root-cause): no band-aids. Fix at the diagnosed site, not in a guard upstream.
- Rule #6 (forced verification): `npm test` AND `npx tsc --noEmit` MUST pass before commit.
- Rule #7 (context decay): re-read every file before editing.
- Rule #8 (edit integrity): read → edit → read.

Diagnosis (from info-gather subagent):
{{DIAGNOSIS_JSON}}

Repo conventions:
- Pure TS, browser-clean, no Buffer, no node:* in src.
- TDD discipline: RED fixture → GREEN patch. Write the regression test FIRST, run it,
  confirm it goes RED, then apply the fix.
- Commit message: `loop(2j-b/iter-{{ITER_N}}): <short summary>`.

Task:
1. Write the regression test at the path specified in diagnosis.redFixtureSpec.fixturePath.
2. Run `cd packages/ergoscript && npx vitest run <test-path>` — confirm RED with the
   expected cost / value mismatch.
3. Apply the calibration patch to the file(s) in diagnosis.proposedFix.filesToTouch.
4. Re-run the regression test — confirm GREEN.
5. Run `cd packages/ergoscript && npm test` — confirm full suite passes (3782+ tests).
6. Run `cd packages/ergoscript && npx tsc --noEmit` — confirm clean.
7. Run `cd tools/mainnet-validate/harness && npm test` and `npx tsc --noEmit` if your
   patch touched anything that affects the harness build (rare for cost-charging fixes;
   common for arm-coverage fixes that might change SValue shape).
8. Commit ONLY the changed files. Do not add unrelated changes.
9. Return FixOutput JSON.

Failure modes that MUST return outcome: 'FAILURE':
- Regression test does not go RED before fix (diagnosis was wrong about reproducibility).
- npm test breaks pre-existing tests post-fix (regression).
- tsc --noEmit fails post-fix (type error).
- You discover mid-implementation that the diagnosis is incomplete.
```

### Loop state machine

```
States:
  IDLE          — orchestrator initialized, no harness running
  SMOKE         — harness spawned, walking forward; heartbeat-watchdog active
  RECONCILING   — post-restart sanity check (Case A/B/C/D in Reconciliation section)
  DIAGNOSING    — info-gather subagent dispatched, awaiting result (15-min deadline)
  TEST_PREFLIGHT — orchestrator captures testCountBefore via independent npx vitest
  FIXING        — fix-apply subagent dispatched, awaiting result (30-min deadline)
  TEST_POSTFLIGHT — orchestrator captures testCountAfter via independent npx vitest; cross-checks
  LOGGING       — appending log entry + running detectors
  REWALKING     — full rewalk from h=1 (every 100k milestone)
  HALTED_OK     — terminal: tip reached (lastValidatedHeight >= tipHeight)
  HALTED_INPUT  — terminal awaiting human (any failure-class stop signal — see Stop signals table)

Transitions:
  IDLE          → RECONCILING  (always — check for compaction-induced state drift first)
  RECONCILING   → SMOKE        (Case A or Case B clean)
  RECONCILING   → LOGGING      (Case C — back-fill missing log entry first)
  RECONCILING   → HALTED_INPUT (Case D — log-commit desync)
  SMOKE         → DIAGNOSING   (harness exit nonzero + error-report.json present)
  SMOKE         → HALTED_OK    (harness exit 0 AND lastValidatedHeight >= tipHeight)
  SMOKE         → HALTED_INPUT (harness exit nonzero without error-report, OR 'unexpected-early-exit', OR 'harness-silent-heartbeat')
  DIAGNOSING    → TEST_PREFLIGHT (subagent returned confidence ≥ 95 with OVERRIDES echo valid)
  DIAGNOSING    → HALTED_INPUT  ('subagent-confidence-low' OR 'subagent-crashed' OR 'gather-subagent-timeout' OR 'overrides-missing-from-subagent')
  TEST_PREFLIGHT → FIXING       (testCountBefore captured cleanly)
  TEST_PREFLIGHT → HALTED_INPUT ('npm-test-timeout')
  FIXING        → TEST_POSTFLIGHT (subagent returned SUCCESS with OVERRIDES echo valid)
  FIXING        → HALTED_INPUT   ('subagent-fix-failure' OR 'fix-subagent-timeout' OR 'subagent-crashed' OR 'overrides-missing-from-subagent')
  TEST_POSTFLIGHT → LOGGING      (testCountAfter >= testCountBefore AND matches subagent's self-reported value)
  TEST_POSTFLIGHT → HALTED_INPUT ('test-count-regression' OR 'test-count-self-report-mismatch' OR 'npm-test-timeout')
  LOGGING       → SMOKE         (next iteration: clean log append; repeated-arm not tripped; iter-cap not reached)
  LOGGING       → REWALKING     (100k milestone crossed AND all other checks pass)
  LOGGING       → HALTED_INPUT  ('repeated-arm-tripped' OR 'iteration-cap-no-progress' OR 'iteration-cap-reached' OR 'log-append-failure' OR 'arm-name-discipline-violation')
  REWALKING     → SMOKE         (fresh-state harness spawn from h=1)
```

### Stop signals (terminal + recoverable)

| signal | state | recovery |
|---|---|---|
| **Domain stop signals** | | |
| `'subagent-confidence-low'` (< 95) | HALTED_INPUT | User reviews diagnosis, manually fixes or provides higher-confidence guidance; resume |
| `'subagent-fix-failure'` (FAILURE return) | HALTED_INPUT | User reviews failure log, manually fixes; resume |
| `'repeated-arm-tripped'` (5 consecutive same-arm OR ≥3 total at threshold) | HALTED_INPUT | User performs deeper investigation per [[feedback-correctness-over-effort]]; may patch multiple arms in one human-driven commit; resume |
| `'test-count-regression'` (testCountAfter < testCountBefore) | HALTED_INPUT | User reviews which test(s) were dropped; may indicate fix deleted a load-bearing test |
| `'test-count-self-report-mismatch'` (subagent's reported count differs from orchestrator's independent recount) | HALTED_INPUT | Subagent honesty failure; surface and investigate before continuing |
| `'overrides-load-failure'` (orchestrator failed to read `~/projects/OVERRIDES.md`) | HALTED_INPUT | User fixes filesystem state; resume |
| `'overrides-missing-from-subagent'` (echo-back missing one or more of #2/#5/#6/#7/#8) | HALTED_INPUT | Template substitution bug; orchestrator + template diagnosed |
| `'log-append-failure'` (loop-log.json parse-then-write race or external edit) | HALTED_INPUT | User closes any external editor / fixes the JSON / resumes |
| **Operational stop signals (crash / timeout)** | | |
| `'gather-subagent-timeout'` (default 15 min wall-clock) | HALTED_INPUT | Subagent stuck on source-read or returned malformed JSON; user investigates |
| `'fix-subagent-timeout'` (default 30 min wall-clock) | HALTED_INPUT | Subagent stuck on edit or npm-test; user investigates |
| `'subagent-crashed'` (no parseable JSON in subagent return) | HALTED_INPUT | Subagent context exhausted or returned text instead of JSON; user investigates |
| `'npm-test-timeout'` (10 min default — vitest typically completes in ~1 min for 3782 tests) | HALTED_INPUT | Fix introduced quadratic regression OR test hung; user investigates |
| `'harness-silent-heartbeat'` (no heartbeat for 5 min despite expected progress) | HALTED_INPUT | Walker stuck in inner loop (VLQ decode, sigma verify); orchestrator kills harness PID, user investigates |
| `'startup-failure'` (harness exit nonzero without writing error-report.json) | HALTED_INPUT | Shim spawn failure, store-path missing, version mismatch; surface stderr |
| `'unexpected-early-exit'` (harness exit 0 but lastValidatedHeight < tipHeight without `--max-height` cap explaining it) | HALTED_INPUT | Should never happen if `--max-height = tipHeight`; would indicate orchestrator bug |
| `'iteration-cap-reached'` (200 iterations absolute ceiling; see Iteration cap below) | HALTED_INPUT | User reviews log volume; manually inspects findings and either raises cap or pauses |
| **Terminal-OK signals** | | |
| Smoke tip-reached (lastValidatedHeight >= tipHeight) | HALTED_OK | Loop complete; user runs final verification (full re-walk from h=1) before declaring 2j success |
| **User-driven signals** | | |
| User interrupt (Ctrl-C; sentinel file `tools/mainnet-validate/.loop-pause` present at iteration boundary) | HALTED_INPUT | User direction |

**Timeout-implementation note.** `gather-subagent-timeout` and `fix-subagent-timeout` are wall-clock deadlines the orchestrator tracks externally — the Agent tool call is synchronous from Claude's perspective, but the orchestrator can dispatch with a deadline annotation and check before/after wall-clock. If a subagent return arrives AFTER the deadline, treat the return as valid but log the latency. The deadline is for HALTED_INPUT signaling, not for cancellation (Agent tool can't be cancelled mid-flight). True-cancel would require the external-supervisor variant (carry-forward).

**Heartbeat-watchdog implementation.** `harness-silent-heartbeat` is watched via `Monitor` over the harness's stdout stream. The Monitor command emits one event per heartbeat line; the orchestrator counts events received per wall-clock minute. If no event arrives in 5 min while the harness PID is still alive (`kill -0 <pid>` succeeds), the orchestrator SIGTERMs the harness PID and transitions to HALTED_INPUT.

### Iteration cap reframe (M5)

The "100-iteration cap" framing in v1 was unjustified relative to expected divergence count (h=3850 to mainnet tip ~1.79M at observed cadence ~1 divergence per 3850 blocks → ~466 expected iterations, well above 100). The cap is reframed as a pathological-loop detector PLUS a safety ceiling:

- **Primary cap: 5 consecutive iterations with no net forward progress** (same height or lower than the prior iteration's `lastValidatedHeight`). This signals a fix that didn't actually fix anything OR the fix introduced a new regression at the same height. Halts with `'iteration-cap-no-progress'`.
- **Secondary cap: 200 iterations absolute ceiling.** Safety net for runaway scenarios; can be lifted post-T7 if first run looks healthy.

Both caps surface as HALTED_INPUT; user re-spawns with higher caps if appropriate.

### Canonical arm names policy (M1)

The repeated-arm detector matches `diagnosis.affectedArm` exact-strings. To make matching deterministic across iterations, the gather-subagent prompt template MUST enforce one of two canonical naming disciplines:

- **Discipline A (source-file basename).** `affectedArm` = the basename (without `.ts`) of the primary source file containing the cost-charging or behavior bug. Examples: `'const-placeholder'`, `'substitute-deserialize'`, `'coll-map'`, `'_substitute-deserialize'`. Multiple bugs in the same file collapse into the same arm name — they SHOULD trip the repeated-arm detector because they signal that file is a hot spot.
- **Discipline B (call-site label).** `affectedArm` = a stable label corresponding to a sigma-rust eval arm or shared helper. Examples: `'EvalConstPlaceholder'`, `'EvalConst'`, `'addPerItemCost'`, `'tryTrivialReduceExpr'`. More granular than Discipline A; surface less when bugs cluster.

**Choice: Discipline A.** Source-file basename is unambiguous, machine-derivable from the diagnosis (the subagent already lists `proposedFix.filesToTouch`), and clusters related bugs into single-arm-name detections — which is the SIGNAL the repeated-arm detector is meant to catch. The orchestrator validates `affectedArm` matches the basename of the first entry in `filesToTouch` (modulo `_` underscore prefix); if mismatched, halt with `'arm-name-discipline-violation'`. Discipline B is the carry-forward refinement once the loop's runs reveal whether file-level clustering is too coarse.

### Reconciliation on iteration start (M3)

The orchestrator's per-iteration sequence begins with a reconciliation check to handle session-compaction races. Before reading `error-report.json` at step 1, perform:

1. Read `loop-log.json` last entry → call it `lastLog`. If absent, `lastLog = null`.
2. Run `git log --oneline -1 --format='%H %s'` → call it `lastCommit`.
3. **Case A** (clean state): `lastCommit.subject` does NOT start with `loop(2j-b/iter-`. Continue normally; this iteration is a fresh start.
4. **Case B** (clean log + clean commit): `lastCommit.subject` starts with `loop(2j-b/iter-N)` AND `lastLog.iteration == N` AND `lastLog.fix.commitSha == lastCommit.sha`. Continue normally; the log is up-to-date.
5. **Case C** (log missing post-commit): `lastCommit.subject` starts with `loop(2j-b/iter-N)` AND (`lastLog == null` OR `lastLog.iteration < N`). The compaction fired between fix-apply commit and log-append. Back-fill the iter-N log entry by:
   - Read `error-report.json` (this is the RED that was just fixed)
   - Re-parse the commit's diff via `git show <sha>`
   - Reconstruct a log entry with `iteration = N`, `halt = <from error-report>`, `fix.commitSha = <sha>`, `fix.filesChanged = <from git show>`, `diagnosis = "RECONSTRUCTED-AFTER-COMPACTION"` placeholder
   - Append the back-fill entry, then continue
6. **Case D** (drift): `lastLog.iteration > N from commit log`. Should not occur — would indicate the log was written without a corresponding commit. Halt with `'log-commit-desync'`.

The reconciliation step itself runs in the orchestrator session (Bash + Read tools), no subagent dispatch.

### Log format (`tools/mainnet-validate/findings/loop-log.json`)

The example below is ILLUSTRATIVE — the `proposedFix.summary` references `substituteConstantsInBody`, a helper that does not yet exist. The actual iter-1 fix's helper name + diff will be whatever the fix-apply subagent produces; the example exists only to show the field shape, not to prescribe the implementation.

```jsonc
[
  {
    "iteration": 1,
    "timestamp": "2026-05-23T14:32:11.428Z",
    "halt": {
      "height": 3850,
      "phase": "evaluate-cost",
      "errorCode": "cost-drift",
      "location": {
        "txIndex": 2,
        "txId": "e179f12156061c04d375f599bd8aea7ea5e704fab2d95300efb2d87460d60b83",
        "inputIndex": 0,
        "spentBoxId": "5527430474b673e4aafb08e0079c639de23e6a17e87edd00f78662b43c88aeda",
        "ergoTreeHex": "100e040004c094400580809cde91e7b001..."
      },
      "evaluateCost": { "expected": 434, "actual": 410, "delta": 24 }
    },
    "diagnosis": {
      "rootCause": "Deserialize-branch divergence: sigma-rust pre-substitutes ConstPlaceholder → Const via tree.proposition() before substitute_deserialize; our TS substitute pre-pass does not. Result: 6 placeholders evaluated × 4 JitCost (Const=5 vs ConstPlaceholder=1) = 24.",
      "sigmaRustCites": [
        { "path": "ergotree-interpreter/src/eval.rs", "line": 206, "snippet": "let expr = tree.proposition()?;" },
        { "path": "ergotree-interpreter/src/eval/expr.rs", "line": 22, "snippet": "ctx.add_jit_cost(5)?; // Constant = Fixed(5)" },
        { "path": "ergotree-interpreter/src/eval/expr.rs", "line": 53, "snippet": "ctx.add_jit_cost(1)?; // ConstantPlaceholder = Fixed(1)" }
      ],
      "ourCodeCites": [
        { "path": "packages/ergoscript/src/eval/evaluate.ts", "line": 98, "snippet": "if (treeHasDeserialize(tree)) {" },
        { "path": "packages/ergoscript/src/eval/_substitute-deserialize.ts", "line": 14, "snippet": "The substitution pass is purely a tree transform: it charges no cost" }
      ],
      "proposedFix": {
        "summary": "Add substituteConstantsInBody pre-pass before substituteDeserialize in dispatchTreeBody's deserialize branch.",
        "affectedArm": "ConstPlaceholder",
        "expectedCostDelta": 0,
        "filesToTouch": [
          "packages/ergoscript/src/eval/_substitute-deserialize.ts",
          "packages/ergoscript/src/eval/evaluate.ts"
        ]
      },
      "redFixtureSpec": {
        "fixturePath": "packages/ergoscript/test/eval/deserialize-placeholder-cost.test.ts",
        "inputDescription": "Synthetic tree with 1 ConstPlaceholder + DeserializeRegister; expected cost matches sigma-rust pre-substitute path.",
        "expectedValue": "{ kind: 'SigmaProp', ... }",
        "expectedCost": 434
      },
      "confidence": 99,
      "uncertaintySources": []
    },
    "fix": {
      "outcome": "SUCCESS",
      "commitSha": "abc1234",
      "filesChanged": [
        "packages/ergoscript/src/eval/_substitute-deserialize.ts",
        "packages/ergoscript/src/eval/evaluate.ts",
        "packages/ergoscript/test/eval/deserialize-placeholder-cost.test.ts",
        "facts/ergoscript-eval.md"
      ],
      "regressionTestPath": "packages/ergoscript/test/eval/deserialize-placeholder-cost.test.ts",
      "diffStat": { "added": 47, "removed": 8 }
    },
    "smokeResult": {
      "walkedFromHeight": 3850,
      "walkedToHeight": null,
      "outcome": "pending"
    }
  }
]
```

`smokeResult` is back-filled on the NEXT iteration (or on terminal state) — the orchestrator updates iteration N's `smokeResult` when iteration N+1 starts (or when the loop terminates with iteration N as the last one).

### Heartbeat format

Plain text to stdout, one line per:

- **Startup:** `[heartbeat] starting at h=NNNNN`
- **Per 100 blocks:** `[heartbeat] h=NNNNN (epoch EE) — txs=N boxes=N spends=N — avg=NNms/blk`
- **Halt:** `[heartbeat] halt at h=NNNNN — phase=<phase> errorCode=<code>`
- **Tip-reach:** `[heartbeat] tip reached at h=NNNNN`
- **Milestone (100k):** `[heartbeat] crossed h=NNNNNN milestone — orchestrator will schedule full rewalk next iteration`

Cadence is `successfulBlocksSinceLastHeartbeat >= 100` — measured by the walker's main loop. `epoch = Math.floor(height / 1024)`. `avg=NNms/blk` is `elapsed_since_last_heartbeat / 100`.

## Error taxonomy

**No new `EvalError`, `HarnessError`, or wire-layer codes.** The loop sits ABOVE the harness; failures inside the loop's orchestration logic are operational, not domain-error-class.

**New shim error codes:** none. The shim is unchanged.

**Operational failure modes (not coded; surface in HALTED_INPUT diagnostic):**

- `'subagent-confidence-low'` — gather subagent reported confidence < 95.
- `'subagent-fix-failure'` — fix subagent returned FAILURE with reason.
- `'repeated-arm-tripped'` — detector identified ≥3 fixes on same arm.
- `'iteration-cap-reached'` — loop ran 100 iterations.
- `'startup-failure'` — harness exited nonzero without writing error-report.json.

## Test strategy

### Layer 1 — Harness unit tests (`harness/test/`, ~3 new)

- **Heartbeat formatter** — given a height + counters + epoch, emits the expected text format. Trivial.
- **Repeated-arm detector** — covers no-entries, below-threshold, at-threshold, multiple-arms. ~30 LOC.
- **Loop log writer** — round-trip an entry through `appendLoopLogEntry` + `readLoopLog`; verify atomic-rename safety (write to tmp, rename).

### Layer 2 — Subagent prompt template tests

- **No formal unit tests.** Templates are markdown files; their correctness is validated by the first end-to-end loop run (T7).
- **Manual spot-check** during T4/T5: verify each `{{PLACEHOLDER}}` is documented in the template's header comment and the orchestrator's substitution code covers every one.

### Layer 3 — Loop orchestration (T6 — runtime, no committed code)

- The orchestrator runs inside this Claude session as Bash + Agent tool calls. It's not committed code.
- Its validation is T7: the first end-to-end loop run successfully closing iteration 1 (h=3850 cost-drift) and advancing the smoke past h=3850.

### Layer 4 — First end-to-end run (T7)

- **Iteration 1:** harness spawn → h=3850 RED → gather subagent → fix-apply subagent → commit → log entry → re-spawn → smoke advances.
- **Done criterion for T7:** at least 1 iteration completes successfully. Subsequent iterations are bonus.
- **Acceptable T7 outcomes:**
  - Iteration 1 SUCCESS, smoke advances to next halt at h > 3850, loop continues (we observe the cadence work).
  - Iteration 1 SUCCESS, smoke reaches tip (extremely unlikely — would mean h=3850 was the only divergence remaining in mainnet, which 2j-a explicitly didn't claim).
  - Iteration 1 SUCCESS, smoke advances and then 2j-b's hard 100-iter cap or some other natural stop fires later (fine — that's loop running as designed).
- **Failing T7 outcomes:**
  - Iteration 1 gather subagent confidence < 95 on a divergence we KNOW is at 99%+ (the 6×4=24 fingerprint match). Indicates the subagent prompt template is broken.
  - Iteration 1 fix subagent FAILURE. Indicates the fix subagent prompt template is broken, OR our diagnosis was wrong.
  - Orchestrator hangs / loop doesn't terminate on tip-reach. Indicates state-machine bug.

### Verification gates per OVERRIDES rule #6

For T1-T5 code:
- `cd tools/mainnet-validate/harness && npm test` — clean (74 → ~77 tests).
- `cd tools/mainnet-validate/harness && npx tsc --noEmit` — clean.
- `cd tools/mainnet-validate/harness && npm run build` — clean.

For T7 (runtime):
- Iteration 1 commit lands on origin/master.
- `loop-log.json` contains a well-formed iteration-1 entry.
- Smoke walks past h=3850.

## Source mapping (where the loop touches existing code)

| Existing file / module | 2j-b touch |
|---|---|
| `tools/mainnet-validate/harness/src/main.ts` (or `walker-loop.ts`) | T1 — heartbeat emission |
| `tools/mainnet-validate/harness/src/loop-log.ts` (new) | T2 — log writer |
| `tools/mainnet-validate/harness/src/repeated-arm-detector.ts` (new) | T3 — pattern detection |
| `tools/mainnet-validate/loop-prompts/info-gather.md` (new) | T4 — gather subagent template |
| `tools/mainnet-validate/loop-prompts/fix-apply.md` (new) | T5 — fix subagent template |
| `tools/mainnet-validate/harness/test/repeated-arm-detector.test.ts` (new) | T3 — unit test |
| `tools/mainnet-validate/harness/test/loop-log.test.ts` (new) | T2 — unit test |
| `tools/mainnet-validate/harness/test/heartbeat.test.ts` (new) | T1 — unit test (optional; might fold into walker test) |
| `tools/mainnet-validate/findings/loop-log.json` (new at T7) | T7 — runtime artifact |
| `tools/mainnet-validate/findings/2026-MM-DD-2j-b-first-loop-run.md` (new at T7) | T7 — findings doc summarizing iteration N count and what was learned |

## Execution order

```
T1   Harness heartbeat (1 commit). ~30 LOC. Unit test optional.
T2   Loop log writer + tests (1 commit). ~50 LOC + ~40 LOC test.
T3   Repeated-arm detector + tests (1 commit). ~30 LOC + ~30 LOC test.
T4   Info-gather subagent prompt template (1 commit). Markdown file with
     header documenting placeholders + schema for DiagnosisOutput JSON.
T5   Fix-apply subagent prompt template (1 commit). Same shape.
T6   Loop orchestrator scaffolding — NO COMMITTED CODE; the orchestrator
     runs in this Claude session via Bash run_in_background + Agent tool
     calls. T6 is documented in 2j-b PLAN.md as a TWO-STAGE verification:

     T6.1 — Template substitution & subagent-return parsing.
       Orchestrator dispatches a REAL info-gather + fix-apply subagent
       pair against the canned h=3850 error-report.json from 2j-a's T9
       smoke (no harness spawn). Validates:
         - OVERRIDES.md loaded fresh and substituted into prompts
         - Subagent's OVERRIDES echo-back present and includes #2/#5/#6/#7/#8
         - DiagnosisOutput / FixOutput parseable as JSON
         - Confidence rating ≥ 95 for h=3850 (we have 99%+ pre-known
           evidence; if subagent rates < 95, the rubric or prompt is broken)
         - testCountBefore / testCountAfter populated
         - Independent vitest cross-check matches subagent's self-report
       The fix subagent IS authorized to commit if it passes all gates;
       T6.1 IS effectively T7's iter-1 if it succeeds.

     T6.2 — Full state-machine integration via synthetic harness.
       Replace the real harness with a tiny bash shell script that emits
       startup heartbeat + several block heartbeats + writes a canned
       error-report.json + exits nonzero. Orchestrator drives the full
       state machine (RECONCILING → SMOKE → DIAGNOSING → ... ) with a
       MOCK fix subagent return (no real LLM dispatch for fix; SUCCESS
       with a no-op diff). Validates:
         - run_in_background notification semantics on harness exit
         - Monitor-based heartbeat-watchdog triggers correctly on a
           silent-stuck synthetic harness (sleep 600 inside shell script)
         - Reconciliation Case A → SMOKE clean
         - State-machine traversal completes without orchestrator hang

     Both T6.1 and T6.2 land as runtime exercises documented in PLAN.md
     with their outcomes captured in the loop-log.json (T6.1's iter is
     iter-0 by convention to distinguish from real T7 iterations).
T7   First end-to-end loop run on real harness. h=3850 becomes iter-1
     RED. Loop runs to first natural stop. Findings doc lands.
T8   Docs sweep: SESSION_CONTEXT + HANDOFF + facts/ergoscript-eval.md
     (close the "deliberate, cost-equivalent" divergence note if iter-1
     closed it; otherwise leave for the relevant iteration's findings)
     + tools/mainnet-validate/README.md (document the loop's invocation
     + log format + stop signals). Memory refresh.
```

Expected commit count: 5 code commits (T1-T5) + N iteration commits during T7 + 1 docs sweep commit (T8) = 6 + N total.

## Done criterion

**Required for ship:**

- T1-T5 committed (5 commits).
- T6 verified — orchestrator can dispatch subagents against a mock halt and parse return values.
- T7 completes — iteration 1 SUCCESS, smoke advances past h=3850 (any subsequent stop is fine).
- `loop-log.json` exists and contains at least one well-formed entry.
- `tools/mainnet-validate/findings/2026-MM-DD-2j-b-first-loop-run.md` documents the T7 run outcome.
- `cargo build` + `cargo test` clean in `shim/` (unchanged — 29 tests).
- `npm test` + `tsc --noEmit` + `npm run build` clean in `harness/` (~77 tests post-T1-T3).
- T8 docs sweep landed.
- `git status` clean modulo `audit20260519/` + `bootstrap-data/`.
- `origin/master` aligned.

**Explicitly NOT in 2j-b done criterion:**

- Smoke reaching tip (could take many iterations; out of 2j-b scope).
- Closing any specific subset of cost-drifts.
- Building infrastructure for the `/loop` skill or external bash supervisor (carry-forward).
- Fully autonomous run from h=1 to tip (carry-forward; depends on N iterations succeeding without halt-for-input).

## Risk hotspots

1. **Subagent prompt drift.** Templates are markdown; subagent behavior depends on prompt fidelity. A subtle wording change can degrade diagnostic quality. *Mitigation:* T4/T5 template files are committed and version-controlled; future prompt updates land via explicit commits with diff review. Templates carry a `## Version` header so the log entry can reference which prompt version generated it.

2. **OVERRIDES inheritance correctness.** Subagents don't auto-inherit OVERRIDES; must be inlined in every prompt. *Mitigation:* templates inline OVERRIDES.md verbatim at `{{OVERRIDES}}` substitution point; the orchestrator reads `~/projects/OVERRIDES.md` fresh per dispatch. Per `[[feedback-subagent-explicit-rules]]`.

3. **Confidence calibration.** The 0-100 confidence scale is subjective; a subagent could rate itself 95 on a wrong fix. *Mitigation:* prompt explicitly enumerates evidence sources (source cite +30, numerical match +30, no alternatives +20, regression test specifiable +20). The first few iterations are de facto calibration runs; user reviews `loop-log.json` post-run and tunes the prompt if mis-calibration shows.

4. **Subagent context window.** A diagnosis subagent reading large fixtures + facts/ + log entries could blow context. *Mitigation:* template instructs subagent to NOT pre-read facts/* exhaustively — only the cited slice. Log entries supplied are last 5, not full history (full history is a path reference for subagent to read on-demand).

5. **Fix subagent landing a wrong fix that passes tests.** Regression test + npm test gate catches direct breakage; doesn't catch "fix narrows cost charge in a way that happens to pass this fixture but breaks the next mainnet site". *Mitigation:* smoke walk IS the meta-validation — if the fix breaks downstream, the next iteration's halt surfaces it. Plus the 100k-rewalk milestone catches "fix broke earlier blocks".

6. **Repeated-arm false positives.** Two unrelated fixes touching the same canonical arm name could trip the detector. *Mitigation:* `affectedArm` field is set by the gather subagent based on diagnosis depth — distinct root causes get distinct arm names even if they share a file. Initial threshold of 3 is conservative; can raise to 5 if false positives observed.

7. **Repeated-arm false negatives.** Two related fixes with different `affectedArm` strings (e.g., one tagged `ConstPlaceholder`, one tagged `substituteDeserialize`) miss the pattern. *Mitigation:* the gather subagent prompt asks for the canonical arm name; if subagent inconsistently tags, the post-run log review surfaces this. Tune the prompt as needed.

8. **100k rewalk wipes a fix that was valid for h<100k but invalid for h>100k.** A "fix" that calibrates only the surfaced site can silently fail on broader corpus. *Mitigation:* 100k rewalk DOES catch this — the rewalk halts on the first earlier-block divergence introduced by the fix. Stop signal correctly fires.

9. **Orchestrator session compaction mid-iteration.** Claude session context could compact between dispatch + receive of a subagent call. *Mitigation:* per-iteration state is recoverable from `loop-log.json` + last error-report.json + the in-progress diagnosis (held in this conversation's context). Compaction after a SUCCESS commit is safe; compaction mid-FIX requires the post-compaction reads to reconstruct from disk. Worst case: a SUCCESS iteration's smokeResult back-fill is skipped; minor data quality issue, not correctness.

10. **Commit explosion.** N iterations × 1 commit per fix could produce 50+ commits on master. *Mitigation:* commit message prefix `loop(2j-b/iter-N):` makes them grep-filterable; `git log --oneline | grep -v 'loop(2j-b'` recovers the human-driven history. If commit volume becomes painful, consider squash-on-merge to a branch as a post-loop housekeeping step.

11. **First-loop-run failure cascading.** If T7's iteration 1 fails for a non-domain reason (template substitution bug, JSON parse error, fix subagent confused by unfamiliar prompt shape), the loop halts immediately and we have no signal whether the architecture works. *Mitigation:* T6 mock-halt verification retires this before T7's real run.

12. **Bootstrap data race.** Two `harness` processes accessing the same `modifiers.redb` would corrupt the snapshot. *Mitigation:* the orchestrator strictly waits for the previous harness to exit before re-spawning; `run_in_background` notification on exit is the gate. No parallel spawns.

13. **Cross-iteration cost-charging drift.** A "fix" that calibrates iter-N's specific site can subtly drift the cost model away from sigma-rust in a way iter-{N+1..N+K} silently adapt to (each subsequent fix patches a downstream symptom of an earlier wrong fix). `git revert` of iter-N alone would leave iter-{N+1..N+K} in an inconsistent state. *Mitigation:* the 100k-block rewalk milestone is the only systemic catch — at each milestone, full re-walk from h=1 fails on the first earlier-block divergence the cumulative fixes introduced. Plus per `[[feedback-correctness-over-effort]]`, the repeated-arm detector forces user attention when a class-pattern emerges. Worst case: user reverts iter-{N..M} as a range, re-walks from h=1, manually batch-fixes the class with a separate spec.

14. **Orchestrator session restart resilience.** The orchestrator runs in this Claude session; Bash `run_in_background` job state is session-scoped. If the session itself terminates (user closes the terminal, OS reboot, harness crashes the orchestrator host), the harness PID becomes orphaned without notification, and on session attach the orchestrator must reconstruct state from disk. *Mitigation:* on every IDLE → RECONCILING transition, the orchestrator runs `pgrep -f ergots-mainnet-validate-shim` to detect orphaned harness PIDs and either adopt (if PID still alive AND no `error-report.json` exists with newer mtime than checkpoint) or kill cleanly. The on-disk state discipline (loop-log.json + checkpoint.json + error-report.json + bootstrap-data/.tip-height) is sufficient for full reconstruction. *Verification:* T6.2 explicitly probes this by killing the orchestrator session mid-iteration and verifying recovery on re-attach.

15. **Subagent self-reporting honesty (test-count + OVERRIDES echo).** Subagents could lie about `testCountBefore`/`testCountAfter` or fabricate the OVERRIDES echo-back to pass the orchestrator's gates. *Mitigation:* the orchestrator runs an INDEPENDENT `npx vitest --reporter=json` post-fix and cross-checks against the subagent's self-reported value (`'test-count-self-report-mismatch'` halt signal). The OVERRIDES echo-back is verified against the literal rule numbers known to be inlined (#2, #5, #6, #7, #8); a fabricated echo that doesn't match the substituted text is structurally undetectable, but a subagent that strips OVERRIDES from its context entirely would not produce a fabricated echo either (no incentive). Residual risk accepted.

16. **Confidence-rubric weakness on non-cost-drift classes.** The asymmetric rubric tightening (C5 critical finding from reviewer-pass) applies ONLY to cost-drift halts. Oracle-mismatch halts (`'ours-succeeded-oracle-errored'` or `'ours-errored-oracle-succeeded'`) and other phase classes use the unmodified rubric (+30 source +30 fingerprint +20 alternatives +20 regression-test). *Mitigation:* oracle-mismatch by definition has a clean fingerprint (one side succeeds, one fails — boolean discriminant). The rubric's +30 numerical-match category is satisfied by "both sides returned the same value but differed on success/fail", which is trivially provable. Cost-drift is uniquely vulnerable because the fingerprint can require a synthesis step (predicting `6 × 4 = 24`). If a future halt class has weaker fingerprint discrimination, revisit the rubric per `[[feedback-correctness-over-effort]]`.

## Confidence check (OVERRIDES rule #2)

Post-reviewer-pass v2:

| sub-component | confidence | notes |
|---|---|---|
| Heartbeat (T1) | 99% | Trivial; logs every 100 blocks |
| Log writer (T2) | 99% | Append-only JSON; atomic write + mtime guard per M2 |
| Repeated-arm detector (T3) | 98% | Pure function over log; Discipline A arm-name policy reduces false-negative risk |
| Info-gather subagent template (T4) | 95% | Asymmetric rubric for cost-drift (C5) + OVERRIDES echo-back self-check (C1) address v1's largest residual risks |
| Fix-apply subagent template (T5) | 95% | Independent test-count cross-check (C4) + OVERRIDES echo (C1) catch self-report dishonesty |
| Orchestrator (T6) | 96% | Reconciliation logic (M3) + tip-reach disambiguation (C2) + timeouts (C3) closed the orchestration gaps |
| End-to-end iter-1 (T7) | 93% | h=3850 diagnosis is at 99%+; T6.2 synthetic-harness probe (M4) retires most orchestration risk before T7 |
| **Overall** | **~95%** | Meets OVERRIDES rule #2 threshold |

The v1 → v2 revisions closed five ★★★ critical and six ★★ moderate findings inline. The largest residual uncertainty is the inherent subjectivity of subagent confidence ratings under novel halt classes; the asymmetric rubric (C5) tightens this specifically for the highest-frequency / highest-risk class (cost-drift) but cannot fully eliminate it for future halt classes.

> ⚠️ **ESCALATION ADVISORY (closed at v2)**
> v1 had a borderline confidence (~93%) flagged. v2 revisions (C1-C5 + M1-M6) bring overall confidence to ~95%, meeting the OVERRIDES rule #2 threshold. The probe-style T7 iter-1 strategy remains the empirical correctness check: if iter-1's gather subagent reports < 99 on the h=3850 case (where pre-known evidence is ~99%), the prompt is broken and the loop pauses for recalibration. If iter-1 lands cleanly with `confidence ≥ 95`, the loop's calibration is empirically validated and subsequent iterations proceed under the same rubric.

This IS a consensus-critical phase indirectly — the loop's fixes touch cost-charging, which determines transaction acceptance. The 95% level is sufficient because: (a) gather subagent's < 95 confidence threshold halts the loop on subjective uncertainty; (b) the OVERRIDES echo-back catches subagent context-strip failures; (c) the independent test-count cross-check catches self-report dishonesty; (d) the asymmetric rubric makes cost-drift fixes earn their confidence with both source AND fingerprint evidence; (e) the 100k rewalk milestone catches common-path breakage; (f) the smoke walk itself is the empirical correctness check; (g) iter-1 is the calibration probe before letting the loop run further.

## Rollback plan

Single-revert per task:

- **T1:** revert heartbeat. Walker silently returns to its prior log volume.
- **T2:** revert log writer. No log file generated; no callers exist yet.
- **T3:** revert detector. No callers exist yet.
- **T4:** revert template. No callers exist yet.
- **T5:** revert template. Same.
- **T6:** runtime; nothing committed; no revert needed.
- **T7:** revert per-iteration commits individually OR via `git revert <range>`. Each iteration's commit is atomic (regression test + patch + facts/ note if applicable).
- **T8:** revert docs sweep.

If the loop runs amok during T7 (e.g., 50 commits land with subtle bugs), the recovery path is: stop the loop, `git revert` the iteration commits in reverse order, re-walk smoke from clean state to verify pre-loop state restored. Branch-based isolation was considered and rejected per user direction; the trade-off is master-history-clutter vs review-overhead, and grep-filterable commit prefixes mitigate the clutter.

**Cross-iteration drift caveat (M6 from reviewer-pass).** Simple per-commit revert ASSUMES each iteration's fix is independent. The realistic failure mode where iter-N's fix is wrong AND iter-{N+1..M} silently adapt to that wrong calibration means reverting iter-N alone leaves iter-{N+1..M} in an inconsistent state (each will fail subtly different tests post-revert). The recovery in this case is:

1. Identify the suspected wrong iteration N from `loop-log.json` review.
2. Revert the iteration range `[N..M]` as a sequence (`git revert <sha_N>..<sha_M>` or equivalent).
3. Verify `npm test` clean post-revert.
4. Re-walk smoke from h=1 (NOT from N's halt height — earlier blocks may have been silently affected).
5. The re-walk halts on the original iter-N divergence; manual diagnosis + spec-driven fix replaces the loop's iter-N attempt.

The fix-apply's `pre/post npm test` count is NOT sufficient to catch cross-iteration drift — downstream fixes may pass test counts while drifting calibration off-spec. The 100k-block rewalk milestone IS the systemic catch, but 100k blocks between rewalks leaves substantial room for drift. Future refinement: configurable rewalk cadence (e.g., 10k for the first few milestones, then 100k). Carry-forward.

## Carry-forward / future work

- **Extension to `/loop` skill** (option 2 from the orchestration brainstorm) — convert the orchestrator to a self-paced Claude loop with `ScheduleWakeup` so the loop survives session boundaries. Defer until 2j-b T7 proves the in-session pattern works.
- **External bash supervisor** (option 3) — fully decouple orchestration from Claude session. Defer until pattern is mature.
- **2j-c, 2j-d, ... separate-spec fixes** — if a halt requires a non-mechanical refactor (e.g., adding a new method handler with non-trivial design choices), the gather subagent reports confidence < 95 and the loop halts; a separate spec gets written manually. This is the natural overflow path; no separate provisioning.
- **100k rewalk policy refinement** (VG2 from reviewer-pass). The first 100k rewalk might surface dozens of previously-undetected divergences if early fixes were silently incomplete. Strategy for handling: TBD post-first-100k. Also: tighter cadence for the first few milestones (10k → 25k → 50k → 100k) would catch drift earlier but slow throughput; trade-off TBD empirically.
- **Repeated-arm threshold empirical calibration** (VG3 from reviewer-pass). Threshold is initially 3 (per detector default in T3). Post-T7, review actual log to see false-positive / false-negative rates and tune.
- **Bootstrap-data filesystem stability** (VG4 from reviewer-pass). The 25GB `bootstrap-data/modifiers.redb` snapshot is single-machine single-user; corruption mid-walk surfaces as `'startup-failure'` on the next harness spawn. Acceptable for 2j-b's single-developer-driven scope; a future multi-machine variant would need RBAC / snapshot versioning.
- **Canonical arm names Discipline B refinement** (M1 carry-forward). If file-level clustering (Discipline A) is too coarse — e.g., one source file has unrelated bugs that false-positive the detector — migrate to Discipline B (call-site / eval-arm label) per the table in §"Canonical arm names policy".
- **Loop prompt versioning + post-run prompt tuning.** Templates carry `## Version` header; on observed misbehavior, bump version + adjust prompt. Tooling for diff'ing prompt versions vs iteration outcomes can be added later.
- **Tighter oracle-mismatch error-code equivalence** (from 2j-a carry-forward — still open). Currently the loop tolerates any err-err pair as `'evaluate'` phase; tighter check would catch our-side mis-classification on the both-error path.
- **2j-a-stats parallel mini-spec** (DEFERRED from 2j-a) — chain-statistics piggyback. Independent of 2j-b; can land in parallel.

## Cross-references

- `~/projects/ergots/docs/specs/2026-05-22-ergoscript-2j-a-cost-oracle-design.md` — cost-oracle wiring; per-fix-N convention is the conceptual ancestor of the loop iteration.
- `~/projects/ergots/docs/specs/2026-05-22-ergoscript-2j-pre-fix-3-atleast-exprtpe-design.md` — single-arm fix-spec; the shape each loop iteration's commit replicates.
- `~/projects/ergots/docs/specs/2026-05-13-ergoscript-interpreter-design.md` — umbrella interpreter design (phase 2j cost-accounting + v1.0.0 gate).
- `~/projects/ergots/tools/mainnet-validate/findings/2026-05-23-2j-a-validation-smoke.md` — h=3850 RED that becomes iter-1's input.
- `~/projects/ergots/facts/ergoscript-eval.md` — current evaluator-surface contract; the divergence note at `dispatchTreeBody` is what iter-1 closes.
- `~/projects/ergots/tools/mainnet-validate/README.md` — harness operator docs; will be extended in T8.
- `~/.claude/projects/-home-mwaddip-projects-ergots/memory/feedback_subagent_explicit_rules.md` — OVERRIDES inheritance discipline for subagents.
- `~/.claude/projects/-home-mwaddip-projects-ergots/memory/feedback_no_artificial_stops.md` — drives the "loop runs continuously until stop signal" framing.
- `~/.claude/projects/-home-mwaddip-projects-ergots/memory/feedback_correctness_over_effort.md` — drives the repeated-arm detector's halt-for-deeper-investigation behavior.

## Reviewer findings applied (2026-05-23, v1 → v2)

Spec was reviewed by a general-purpose subagent dispatched with explicit instructions to verify subagent prompt template completeness (incl. OVERRIDES inheritance per `[[feedback-subagent-explicit-rules]]`), log format pattern-detection support, stop-signal coverage, orchestration mechanics (`Bash run_in_background` exit-notification + `Agent` synchronous return semantics), commit cadence + revert story, and confidence-rubric robustness against silent miscalibration.

**★★★ Critical findings (all applied inline):**

1. **C1 — OVERRIDES loader mechanism unspecified.** v1 referenced `{{OVERRIDES}}` placeholder but had no defined substitution mechanism. **Applied:** Components → "OVERRIDES loader" sub-bullet specifies orchestrator reads `~/projects/OVERRIDES.md` fresh per dispatch via Read tool, substitutes full content verbatim, no cross-iteration caching. New `'overrides-load-failure'` stop signal. Subagent templates instruct echo-back of received rule numbers as first entry of `uncertaintySources`; orchestrator validates echo includes #2/#5/#6/#7/#8, halts with `'overrides-missing-from-subagent'` otherwise.

2. **C2 — Tip-reach detection ambiguity.** v1 said "exit 0 with tipReachedAt set" but per harness source the exit-code is identical for `--max-height N` cap vs actual tip-reach. **Applied:** Components → "Tip-reach disambiguation" sub-bullet specifies orchestrator captures `tipHeight` from the first walk's startup heartbeat (`[heartbeat] starting at h=N (tip=T)`), always passes `--max-height tipHeight` after iter-1, and on exit 0 verifies `checkpoint.lastValidatedHeight >= tipHeight`. New `'unexpected-early-exit'` stop signal for the should-never-happen case.

3. **C3 — Subagent crash / timeout failure modes unspecified.** v1's stop-signal table had no entries for subagent timeouts, crashes, npm-test hangs, or silent-heartbeat scenarios. **Applied:** Stop-signal table now has Operational section with `'gather-subagent-timeout'` (15min), `'fix-subagent-timeout'` (30min), `'npm-test-timeout'` (10min), `'subagent-crashed'`, `'harness-silent-heartbeat'` (5min via Monitor-based watchdog), `'startup-failure'`, `'unexpected-early-exit'`. State machine updated to include `TEST_PREFLIGHT` and `TEST_POSTFLIGHT` intermediate states. Implementation notes added for wall-clock deadline tracking + heartbeat-watchdog via Monitor tool.

4. **C4 — Test-count regression check not implementable as described.** v1 mentioned "if `npm test` count drops post-fix, halt" without specifying capture mechanism. **Applied:** Orchestrator per-iteration sequence steps 6 + 9 specify `npx vitest run --reporter=json | jq '.numTotalTests'` for independent pre/post capture. FixOutput schema gains `testCountBefore` + `testCountAfter` as ALWAYS-PRESENT fields. Orchestrator cross-checks subagent's self-reported value against independent post-run; mismatch halts with `'test-count-self-report-mismatch'`. Drop halts with `'test-count-regression'`.

5. **C5 — Confidence rubric vulnerable to score inflation on cost-charging fixes.** v1's rubric capped at 100 with all four categories present in any halt; cost-charging fixes without clean fingerprints could still inflate to ≥95 via non-evidence categories. **Applied:** T4 template adds an ASYMMETRIC RULE specifically for `errorCode == 'cost-drift'`: BOTH +30 source citation AND +30 numerical fingerprint match are required to reach ≥95. If the observed delta does not reduce to an integer-product fingerprint, the subagent must declare <95 and halt regardless of other category scores. Plus new Risk #16 documents the residual exposure on non-cost-drift classes and the threshold for revisiting.

**★★ Moderate findings (applied):**

6. **M1 — `affectedArm` canonical-name policy unspecified.** **Applied:** New §"Canonical arm names policy" specifies Discipline A (source-file basename) as the v2 choice. Orchestrator validates `affectedArm` matches first entry of `proposedFix.filesToTouch`; mismatch halts with `'arm-name-discipline-violation'`. Discipline B (call-site label) retained as carry-forward refinement.

7. **M2 — Log writer race with manual edits.** **Applied:** New `'log-append-failure'` stop signal. Spec mandates mtime-comparison + atomic rename pattern (matching harness checkpoint writer). External-edit detection halts the loop pending user fix.

8. **M3 — Session compaction recovery incomplete for mid-fix case.** **Applied:** New §"Reconciliation on iteration start" specifies Case A/B/C/D reconciliation logic; orchestrator transitions IDLE → RECONCILING → SMOKE (clean) or LOGGING (back-fill missing log entry) or HALTED_INPUT (Case D log-commit desync).

9. **M4 — T6 mock-halt scope too narrow.** **Applied:** Execution order T6 split into T6.1 (real subagent dispatch against canned h=3850; effectively iter-1 if successful) and T6.2 (synthetic-harness shell script driving full state-machine traversal with mock fix subagent return). T6.2 explicitly probes heartbeat-watchdog firing on synthetic-stuck harness.

10. **M5 — 100-iteration cap rationale missing; expected divergence count exceeds cap.** **Applied:** New §"Iteration cap reframe" specifies primary cap = 5 consecutive iterations with no net forward progress (`'iteration-cap-no-progress'`), secondary cap = 200 absolute ceiling (`'iteration-cap-reached'`). The 100 figure was unjustified; reframe matches the actual pathological-loop detection goal.

11. **M6 — Cross-iteration drift not handled by simple per-commit revert.** **Applied:** New paragraph in Rollback Plan acknowledges drift-across-iterations failure mode; specifies revert-range + re-walk-from-h=1 recovery path. Risk #13 documents the failure mode. Acknowledges 100k-rewalk milestone as the only systemic catch, with cadence refinement as carry-forward.

**★ Minor findings (acknowledged):**

12. **Mi1** — Example log entry's `proposedFix.summary` references nonexistent helper. **Applied:** Pre-example clarification "the example below is ILLUSTRATIVE — the actual iter-1 fix's helper name + diff will be whatever the fix-apply subagent produces".
13. **Mi2** — Heartbeat cadence "every 100 blocks" assumes stable blocks-per-second. *Not changed* — even if cadence is uneven, the user's eyeball-progress signal works; can add "OR 30s whichever first" later.
14. **Mi3** — `epoch = floor(height/1024)` source-of-truth not cited. *Not changed* — well-known Ergo convention; cite added to README in T8 docs sweep.
15. **Mi4** — `iter-N` vs `iteration N` consistency. *Confirmed:* commit prefix is literal `iter-N`. T8 docs sweep will state this.
16. **Mi5** — Source-mapping table truncation suspicion. *Verified:* table is complete for current scope; new test files (heartbeat, loop-log, repeated-arm-detector) all listed.

**Verification gaps (carried forward as explicit later work):**

- **VG1** — T6 MUST use real Agent dispatch (T6.1 split addresses this).
- **VG2** — 100k rewalk has no test plan beyond emergence in T7. Added to carry-forward; first 100k rewalk gets a dedicated review pass.
- **VG3** — Repeated-arm threshold-3 needs empirical tuning. Added to carry-forward.
- **VG4** — Bootstrap-data filesystem corruption resilience. Added to carry-forward.

**Net effect:** confidence v1 ~93% → v2 ~95%. Reviewer's own confidence 91% with escalation advisory around orchestration session-restart resilience; M4 (T6.2 expansion with mid-iteration session-kill probe) and Risk #14 address this.

**Recommendation (from reviewer):** REVISE-THEN-SHIP. All Critical findings applied; Moderate findings applied; Minor findings acknowledged. Estimated revision scope ~6 paragraphs/sections → applied exactly.
