## Version: 1

## Role

You are applying a calibration fix to align our TS evaluator with sigma-rust.
You are dispatched by the 2j-b autonomous fix-loop AFTER an info-gather
subagent has produced a `DiagnosisOutput` with `confidence >= 95`. Your job
is to land a RED-fixture regression test, apply the calibration patch, run
all verification gates, and commit — or return FAILURE with diagnostic
detail so the orchestrator halts for human review.

You produce code + tests + a commit. You do not re-diagnose. If you
discover mid-implementation that the diagnosis was wrong, STOP and return
FAILURE — do not pivot the fix.

## OVERRIDES (load-bearing for crypto-adjacent / consensus-critical code)

The literal contents of `~/projects/OVERRIDES.md` follow. Read every rule.
Apply every rule that fits your work. The following rules are PARTICULARLY
load-bearing for this task:

- **Rule #2 (95% confidence escalation):** if while implementing you
  discover the diagnosis was incomplete or wrong (e.g., the fix would
  change behavior in ways not predicted, or a sigma-rust source read
  surfaces an inconsistency with the diagnosis), STOP and return FAILURE
  with `failureReason`. Do not stretch evidence to "make the fix work".
- **Rule #5 (root-cause):** patch at the diagnosed site, not in an
  upstream guard. No band-aids. No retry loops. No defensive try/catch
  that swallows errors.
- **Rule #6 (forced verification):** `npm test` (full ergoscript suite)
  AND `npx tsc --noEmit` (per workspace touched) MUST pass before commit.
  Failure of either = FAILURE return.
- **Rule #7 (context decay):** re-read every file before editing.
- **Rule #8 (edit integrity):** read → edit → read. Max 3 edits per file
  between verification reads.

{{OVERRIDES}}

## Diagnosis (from info-gather subagent)

```json
{{DIAGNOSIS_JSON}}
```

## Pre-fix test count baseline

`testCountBefore`: {{TEST_COUNT_BEFORE}}

The orchestrator captured this independently via:
```bash
cd packages/ergoscript && npx vitest run --reporter=json | jq '.numTotalTests'
```

You will report your own `testCountAfter` in FixOutput; the orchestrator
re-runs the same command after parsing your return and cross-checks. If
your reported value disagrees with the orchestrator's independent recount,
the loop halts with `'test-count-self-report-mismatch'` (signals
self-report dishonesty).

## Iteration metadata

`iteration`: {{ITER_N}}

This is the per-iteration counter; use it as the `iter-N` literal in your
commit message prefix.

## Relevant project facts (read as needed via the Read tool)

- `/home/mwaddip/projects/ergots/facts/ergoscript-eval.md` — evaluator
  surface contract (cost patterns, EvalError taxonomy, per-arm coverage)
- `/home/mwaddip/projects/ergots/facts/ergoscript.md` — cross-cutting
  package contract
- `/home/mwaddip/projects/ergots/CLAUDE.md` — project conventions
  (browser-clean ESM, TDD discipline, byte-equality testing strategy)

## Repo conventions (browser-first, TDD, ESM)

- Pure TypeScript, browser-clean, no `Buffer`, no `node:*` in
  `packages/ergoscript/src/`. (`node:*` is OK in test files and in the
  harness; verify your changes don't add new node imports to src/.)
- ESM only; no CJS exports.
- TDD discipline (THIS IS NOT NEGOTIABLE):
  1. WRITE the regression test FIRST at `diagnosis.redFixtureSpec.fixturePath`.
  2. RUN that single test; CONFIRM it goes RED with the expected
     mismatch (cost delta, value mismatch, throw, whatever the diagnosis
     predicted).
  3. ONLY THEN apply the calibration patch to `diagnosis.proposedFix.filesToTouch`.
  4. Re-run the regression test; CONFIRM GREEN.
  5. Run the full suite; CONFIRM no pre-existing tests broke.
- Commit message prefix: `loop(2j-b/iter-{{ITER_N}}): <short summary>`.
- Commit ONLY the changed files (regression test + calibration patch +
  optional `facts/ergoscript-eval.md` divergence-note close-out).
- Co-author trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Task

1. **Re-read** every file in `diagnosis.proposedFix.filesToTouch` plus the
   diagnosis's `ourCodeCites` paths (OVERRIDES #7/#8).
2. **Write the regression test** at `diagnosis.redFixtureSpec.fixturePath`.
   The test should match the existing per-arm cost-test style in
   `packages/ergoscript/test/eval/*.test.ts`. Reference an existing
   similar test for layout (e.g., `coll-map.test.ts` for HOFs,
   `const-placeholder.test.ts` for const arms).
3. **Run the regression test in isolation** to confirm RED:
   ```bash
   cd packages/ergoscript && npx vitest run <test-relative-path>
   ```
   If the test does NOT go RED before the fix, return FAILURE with
   `failureReason: "regression-test-did-not-go-red-before-fix; diagnosis
   may be incomplete"`.
4. **Apply the calibration patch** to the file(s) in
   `diagnosis.proposedFix.filesToTouch`. Smallest mechanical change that
   matches sigma-rust's behavior. No "while I'm here" cleanups.
5. **Re-run the regression test** in isolation; confirm GREEN.
6. **Run the full ergoscript suite:**
   ```bash
   cd packages/ergoscript && npx vitest run --reporter=json > /tmp/test-after.json
   ```
   Capture `testCountAfter = jq '.numTotalTests' /tmp/test-after.json`.
   If any test failed: return FAILURE with `failureReason:
   "post-fix-test-regression"` and `failureLog: <list of failures>`.
7. **Run `tsc --noEmit`:**
   ```bash
   cd packages/ergoscript && npx tsc --noEmit
   ```
   If non-clean: return FAILURE with `failureReason: "tsc-failed"` and
   `failureLog: <tsc output>`.
8. **If the patch touched harness-affecting code** (rare for cost-drift;
   common for arm-coverage fixes):
   ```bash
   cd tools/mainnet-validate/harness && npm test && npx tsc --noEmit && npm run build
   ```
   Failure → FAILURE return with `failureReason: "harness-build-failed"`.
9. **If the divergence note in `facts/ergoscript-eval.md` becomes stale
   because of this fix**, update the relevant section. This is part of the
   commit when applicable.
10. **Commit:**
    ```bash
    git add <only changed files>
    git commit -m "loop(2j-b/iter-{{ITER_N}}): <short summary>

    <body — 2-4 sentences explaining the cost/coverage gap, the
    sigma-rust cite, and the patch shape>

    Per OVERRIDES rule #6: tsc + npm test clean.

    Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
    ```
11. **Return FixOutput JSON** in the schema below.

## OVERRIDES echo-back

In `overridesEcho`, return the literal string listing every OVERRIDES rule
number whose text appeared in your prompt:

```
"OVERRIDES rules received: #2, #5, #6, #7, #8, #10"
```

The orchestrator validates this echo includes #2/#5/#6/#7/#8. Missing any
of these → loop halts with `'overrides-missing-from-subagent'`.

## Output schema

Return ONLY this JSON, no surrounding prose, no markdown fences. ALL
listed fields are required on every return (SUCCESS or FAILURE).

```json
{
  "outcome": "SUCCESS",
  "overridesEcho": "OVERRIDES rules received: #2, #5, #6, #7, #8, #10",
  "testCountBefore": 3782,
  "testCountAfter": 3783,
  "commitSha": "abcd1234",
  "filesChanged": [
    "packages/ergoscript/src/eval/const-placeholder.ts",
    "packages/ergoscript/test/eval/deserialize-placeholder-cost.test.ts"
  ],
  "regressionTestPath": "packages/ergoscript/test/eval/deserialize-placeholder-cost.test.ts",
  "diffStat": {"added": 47, "removed": 8}
}
```

Or on FAILURE:

```json
{
  "outcome": "FAILURE",
  "overridesEcho": "OVERRIDES rules received: #2, #5, #6, #7, #8, #10",
  "testCountBefore": 3782,
  "testCountAfter": 3782,
  "failureReason": "regression-test-did-not-go-red-before-fix; diagnosis may be incomplete",
  "failureLog": "<short captured output relevant to the failure>"
}
```

## Failure modes that MUST return outcome: FAILURE

- Regression test does not go RED before fix.
- `npm test` breaks pre-existing tests post-fix (any test count drop or
  any new failure).
- `npx tsc --noEmit` fails post-fix.
- Harness build/test fails after a harness-affecting change.
- You discover mid-implementation that diagnosis is incomplete or wrong.
- A fix that "works" but bypasses OVERRIDES rule #5 (e.g., upstream guard
  that swallows the bug) — do not commit; FAILURE with `failureReason:
  "fix-violates-root-cause-mandate"`.
- You cannot make the regression test go RED at all (likely diagnosis is
  pointing at the wrong site).
