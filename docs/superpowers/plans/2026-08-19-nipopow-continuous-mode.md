# NiPoPoW Continuous-Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@ergots/nipopow` 0.4.0 builds and verifies continuous-mode NiPoPoW proofs — closing the interop gap where every live JVM node serves `continuous = true` proofs that 0.3.0 rejects outright.

**Architecture:** One new pure module (`difficulty.ts`: epoch math + membership check + param resolver), threaded into the three existing surfaces (verifier, compare, both provers) plus a `useLastEpochs` coupling into the connections look-back window. Wire format untouched. Verifier accept-set for `continuous: false` proofs is bit-for-bit 0.3.0's.

**Tech Stack:** TypeScript ESM (browser-safe: no Buffer/node imports in `src/`), vitest, existing test helpers (`buildSyntheticProof`, `buildTestChain`, `MemoryReader`).

**Spec:** `docs/superpowers/specs/2026-08-19-nipopow-continuous-mode-design.md` (committed as this branch's base, `9bb5fad`). The spec carries the JVM citations; every behavioral question resolves against `~/projects/ergo-jvm-pr` (sigma-rust has no continuous mode and is not a reference here).

## Global Constraints

- **TDD Iron Law**: no production code without a failing test first. Fixture lands before the test that reads it.
- **Clean-room**: JVM Scala is behavior reference only; no line-by-line translation.
- **Browser rules** (src/ only): no `Buffer`, no `node:*`, no `process`/`fs`/`path`, ESM only. Test files may use `node:fs`.
- **Defaults**: `EPOCH_LENGTH_MAINNET = 128` (EIP-37 effective value), `USE_LAST_EPOCHS_MAINNET = 8`. Bad overrides throw `RangeError` (caller-config defect — deliberately outside the `ProofParseError`/`ProofVerificationError`/`ProofBuildError` taxonomies).
- **Error-code delta**: `'continuous-unsupported'` removed; `'missing-difficulty-headers'` added. Codes are plain strings (`errors.ts` needs NO change).
- **Non-continuous accept-set MUST NOT change.** Any existing test that breaks for a reason other than the two documented type/code changes is a defect in the task, not the test.
- **fixture-gen/ stays frozen.** New fixtures come from SANTA (already delivered/requested) — never from sigma-rust.
- **Version bump to 0.4.0 happens in Task 10 only.**
- **Commits**: explicit pathspecs on `git add` AND `git commit -- <paths>` (OVERRIDES rule 18); message trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Verification commands**: package-scoped while iterating — `npx vitest run packages/nipopow/test/<file>.test.ts` (from repo root, path-filtered), `npx tsc --noEmit --project packages/nipopow/tsconfig.json`. Full gates in Task 10. Never bare `npx tsc --noEmit` at repo root.
- **Subagent dispatches** carry `~/projects/OVERRIDES.md` verbatim + proof-of-reading gate (standing rule; applies to implementers AND reviewers).

## File Structure

- `packages/nipopow/src/difficulty.ts` — NEW: epoch math, `hasValidDifficultyHeaders`, `resolveDifficultyParams`, constants. Imports only `proof.ts`/`popow-header.ts` types.
- `packages/nipopow/src/connections.ts` — `useLastEpochs` parameter (default = mainnet const).
- `packages/nipopow/src/verifier.ts` — gate removal, options fields, post-loop difficulty check, result type widening.
- `packages/nipopow/src/compare.ts` — `isValid` difficulty conjunct, `compareProofs` opts arg.
- `packages/nipopow/src/prover.ts` — `PoPowParams` fields, injection in both provers.
- `packages/nipopow/src/index.ts` — new exports.
- `packages/nipopow/test/difficulty.test.ts` — NEW (Tasks 2–3).
- `packages/nipopow/test/fixtures/jvm_difficulty/epoch-math-truth-table.json` — SANTA batch 1 (already staged untracked; committed in Task 2).
- `packages/nipopow/test/fixtures/jvm_continuous/vectors.json` — SANTA batch 2 (in flight; Task 8).
- `packages/nipopow/test/jvm-continuous-vectors.test.ts` — NEW (Task 8).
- `tools/nipopow-capture/live-walk.mjs` — full-identity mode goes continuous (Task 9).
- `facts/nipopow.md` (Task 1), `packages/nipopow/{README.md,API.md,package.json}` + `SESSION_CONTEXT.md`/`HANDOFF.md` (Task 10).

---

### Task 1: Contract-first — `facts/nipopow.md`

**Files:**
- Modify: `facts/nipopow.md`

**Interfaces:**
- Consumes: the spec (all sections).
- Produces: the contract every later task implements against. Later tasks cite it; reviewers diff against it.

- [ ] **Step 1: Read the current contract end-to-end** (`facts/nipopow.md`). Locate: the "Does NOT ship" continuous bullet (~line 21), `parseProof`/`serializeProof` postconditions (~41–47), `verifyProof`/`verifyParsedProof` entries (~58–69), `compareProofs` entry, `/prover` section (`prove`, `proveWithReader`, `PoPowParams`), the `NipopowProof` type block (~355), "Limitations" (~225 live-endpoint note, ~403 wire-dialect note).

- [ ] **Step 2: Apply the contract deltas.** Exact content to land (integrate into the file's existing voice; key sentences below are normative):

1. **Delete** the "Does NOT ship: continuous-mode proofs" bullet; replace with a "Ships since 0.4.0" description: prover-side injection + verifier-side membership check + compare gate, with the JVM sources (`NipopowProverWithDbAlgs.scala:93-105`, `NipopowProof.scala:82-105`, `DifficultyAdjustment.scala:27-55`).
2. **New `difficulty` section** documenting the six new exports with signatures:
   - `nextRecalculationHeight(height: number, epochLength: number): number`
   - `previousHeightsRequiredForRecalculation(height: number, epochLength: number, useLastEpochs: number): number[]`
   - `heightsForNextRecalculation(height: number, epochLength: number, useLastEpochs: number): number[]`
   - `hasValidDifficultyHeaders(proof: NipopowProof, epochLength: number, useLastEpochs: number): boolean` — **precondition:** caller has established strictly-increasing chain heights (the membership scan is an ordered non-resetting cursor, JVM `indexWhere(_, lastIndex)` semantics; both in-package callers run the heights check first, mirroring the JVM `isValid` short-circuit order). Vacuously `true` when `proof.continuous === false`; ignores needed heights `<= 0` or `>= suffixHead.height`.
   - `resolveDifficultyParams(opts?: DifficultyParams): { epochLength: number; useLastEpochs: number }` — defaults `EPOCH_LENGTH_MAINNET = 128` / `USE_LAST_EPOCHS_MAINNET = 8`; gates: both integers, `epochLength >= 1`, `useLastEpochs >= 2`, `epochLength * useLastEpochs <= 2**31` (the JVM `DifficultyAdjustment` constructor requires); violations throw `RangeError`.
   - Document that 128 is the *composed* `eip37EpochLength.getOrElse(epochLength)` mainnet value (JVM applies it in this machinery with no height gating; testnet is also 128).
3. **`verifyProof`/`verifyParsedProof`**: remove the `'continuous-unsupported'` failure mode and the `continuous === false` success postcondition. Add: `VerifyOptions.epochLength?`/`useLastEpochs?` (RangeError gates, resolved before any proof inspection); success postcondition `continuous` echoes the proof's flag; new failure mode `'missing-difficulty-headers'` — thrown after connections/interlinks/heights/PoW, when `proof.continuous === true` and a needed height in `(0, suffixHead.height)` is absent from the header chain. Non-continuous accept-set unchanged vs 0.3.0.
4. **`compareProofs(a, b, opts?)`**: third optional arg `{ epochLength?, useLastEpochs? }`; internal `isValid` now = connections ∧ heights ∧ interlinks-proofs ∧ difficulty-headers (the JVM `NipopowProof.isValid` conjunction, `NipopowProof.scala:75`); a continuous proof missing difficulty headers is not comparable (boolean domain, no new throws).
5. **`hasValidConnections(proof, useLastEpochs = USE_LAST_EPOCHS_MAINNET)`**: window = `useLastEpochs + 3` predecessors, derived from the same setting the JVM couples it to (`NipopowProof.scala:129,135`); behavior at default unchanged.
6. **`PoPowParams`** gains `continuous?: boolean` (default false), `epochLength?`, `useLastEpochs?` (RangeError gates fire in both provers *unconditionally* — the JVM constructs `DifficultyAdjustment` before checking `params.continuous`).
7. **`proveWithReader`**: when continuous, injects `heightsForNextRecalculation(suffixHead.height, e, u)` heights `< suffixHead.height` via `popowHeaderAtHeight`, **silently skipping** heights the reader lacks (JVM `Option.foreach` — NOT `'missing-popow-header'`; such a proof fails verification downstream, matching JVM). Injected headers take precedence in the by-height dedupe (JVM `storedHeights` order: genesis → injected → walk). Exotic-config note: under `epochLength === 1` the JVM can append a duplicate-height header (self-invalid proof); ergots dedupes — documented divergence, unreachable under real configs where injected heights are multiples of `epochLength > 1`.
8. **`prove`**: **deliberate divergence** — JVM `NipopowAlgos.prove` stamps `params.continuous` WITHOUT injecting (`NipopowAlgos.scala:158`; self-marked "Paper-like code used in tests only" with a todo). ergots injects in both provers so continuous `prove()` output is self-valid and equals `proveWithReader()` on chains where the walks already coincide — the level-0-free equivalence predicate is UNCHANGED (injection adds the identical set to both sides). JVM `NipopowAlgos.prove` vectors remain ground truth for `continuous: false` only.
9. **Limitations**: rewrite the "Live-endpoint byte-identity requires continuous mode" block (~225) to past tense / resolved-in-0.4.0, pointing at the Task 9 acceptance record.

- [ ] **Step 3: Self-check** — grep the file for `continuous-unsupported` (must be gone except, if present, an explicit "removed in 0.4.0" historical note), and for every new export name (all six documented).

- [ ] **Step 4: Commit**

```bash
git add facts/nipopow.md
git commit -m "docs(nipopow): continuous-mode contract — difficulty section, error-taxonomy delta, prover divergence note

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- facts/nipopow.md
```

---

### Task 2: Epoch math + param resolver (`difficulty.ts`)

**Files:**
- Create: `packages/nipopow/src/difficulty.ts`
- Create: `packages/nipopow/test/difficulty.test.ts`
- Commit (already staged untracked): `packages/nipopow/test/fixtures/jvm_difficulty/epoch-math-truth-table.json`
- Modify: `packages/nipopow/src/index.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Tasks 3–7 rely on these exact names):
  - `export const EPOCH_LENGTH_MAINNET = 128`
  - `export const USE_LAST_EPOCHS_MAINNET = 8`
  - `export interface DifficultyParams { epochLength?: number; useLastEpochs?: number }`
  - `export function resolveDifficultyParams(opts?: DifficultyParams): { epochLength: number; useLastEpochs: number }`
  - `export function nextRecalculationHeight(height: number, epochLength: number): number`
  - `export function previousHeightsRequiredForRecalculation(height: number, epochLength: number, useLastEpochs: number): number[]`
  - `export function heightsForNextRecalculation(height: number, epochLength: number, useLastEpochs: number): number[]`

- [ ] **Step 1: Verify + commit the SANTA batch-1 fixture.** The file is already staged untracked (delivered 2026-08-19, 6 rows independently hand-verified against the Scala). Sanity-check shape, then commit it alone:

```bash
python3 -c "
import json
rows=json.load(open('packages/nipopow/test/fixtures/jvm_difficulty/epoch-math-truth-table.json'))['rows']
assert len(rows)==49, len(rows)
assert all(set(r)=={'epochLength','useLastEpochs','height','next','prev','forNext'} for r in rows)
print('ok 49 rows')
"
git add packages/nipopow/test/fixtures/jvm_difficulty/epoch-math-truth-table.json
git commit -m "test(nipopow): SANTA JVM DifficultyAdjustment truth table (49 rows; e=128/1024/1, u=8)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/test/fixtures/jvm_difficulty/epoch-math-truth-table.json
```

- [ ] **Step 2: Write the failing tests** — `packages/nipopow/test/difficulty.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  nextRecalculationHeight,
  previousHeightsRequiredForRecalculation,
  heightsForNextRecalculation,
  resolveDifficultyParams,
  EPOCH_LENGTH_MAINNET,
  USE_LAST_EPOCHS_MAINNET,
} from '../src/difficulty.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TruthRow {
  epochLength: number;
  useLastEpochs: number;
  height: number;
  next: number;
  prev: number[];
  forNext: number[];
}

const truthTable: { rows: TruthRow[] } = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/jvm_difficulty/epoch-math-truth-table.json'), 'utf8'),
);

describe('epoch math vs JVM DifficultyAdjustment truth table (SANTA batch 1)', () => {
  test('fixture has the expected 49 rows across three (e,u) pairs', () => {
    expect(truthTable.rows.length).toBe(49);
    const pairs = new Set(truthTable.rows.map(r => `${r.epochLength}/${r.useLastEpochs}`));
    expect(pairs).toEqual(new Set(['128/8', '1024/8', '1/8']));
  });

  test('every row matches all three functions', () => {
    for (const row of truthTable.rows) {
      const { epochLength: e, useLastEpochs: u, height: h } = row;
      expect(nextRecalculationHeight(h, e), `next(${h}, ${e})`).toBe(row.next);
      expect(
        previousHeightsRequiredForRecalculation(h, e, u),
        `prev(${h}, ${e}, ${u})`,
      ).toEqual(row.prev);
      expect(heightsForNextRecalculation(h, e, u), `forNext(${h}, ${e}, ${u})`).toEqual(row.forNext);
    }
  });
});

describe('resolveDifficultyParams', () => {
  test('defaults are the mainnet constants', () => {
    expect(resolveDifficultyParams()).toEqual({ epochLength: 128, useLastEpochs: 8 });
    expect(resolveDifficultyParams({})).toEqual({ epochLength: 128, useLastEpochs: 8 });
    expect(EPOCH_LENGTH_MAINNET).toBe(128);
    expect(USE_LAST_EPOCHS_MAINNET).toBe(8);
  });

  test('partial overrides keep the other default', () => {
    expect(resolveDifficultyParams({ epochLength: 1024 })).toEqual({ epochLength: 1024, useLastEpochs: 8 });
    expect(resolveDifficultyParams({ useLastEpochs: 4 })).toEqual({ epochLength: 128, useLastEpochs: 4 });
  });

  test.each([
    { epochLength: 0 },
    { epochLength: -128 },
    { epochLength: 1.5 },
    { epochLength: Number.NaN },
    { useLastEpochs: 1 },
    { useLastEpochs: 0 },
    { useLastEpochs: 2.5 },
    { epochLength: 2 ** 20, useLastEpochs: 2 ** 15 }, // product 2^35 > 2^31
  ])('rejects %j with RangeError', (opts) => {
    expect(() => resolveDifficultyParams(opts)).toThrow(RangeError);
  });

  test('accepts exotic-but-valid overrides (epochLength 1 is legal, JVM requires only > 0)', () => {
    expect(resolveDifficultyParams({ epochLength: 1, useLastEpochs: 8 })).toEqual({
      epochLength: 1,
      useLastEpochs: 8,
    });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/nipopow/test/difficulty.test.ts`
Expected: FAIL — cannot resolve `../src/difficulty.ts`.

- [ ] **Step 4: Implement `packages/nipopow/src/difficulty.ts`** (epoch-math half; `hasValidDifficultyHeaders` is Task 3):

```ts
/**
 * Difficulty-recalculation epoch math + continuous-mode membership check.
 *
 * Clean-room port of the JVM's DifficultyAdjustment height selectors
 * (~/projects/ergo-jvm-pr ergo-core .../mining/difficulty/DifficultyAdjustment.scala:27-55)
 * and NipopowProof.hasValidDifficultyHeaders (.../popow/NipopowProof.scala:82-105).
 * The difficulty *arithmetic* (bitcoinCalculate / eip37Calculate / interpolate)
 * is deliberately NOT ported — the proof layer checks header membership only.
 */
import type { NipopowProof } from './proof.ts';

/**
 * Effective mainnet epoch length for difficulty recalculation: the JVM
 * computes eip37EpochLength.getOrElse(epochLength) = 128 (EIP-37) at both
 * the prover and verifier call sites, with no height gating — the pre-EIP-37
 * value 1024 never participates in this machinery. Testnet is also 128.
 */
export const EPOCH_LENGTH_MAINNET = 128;
/** Mainnet/testnet chainSettings.useLastEpochs. */
export const USE_LAST_EPOCHS_MAINNET = 8;

export interface DifficultyParams {
  epochLength?: number;
  useLastEpochs?: number;
}

/**
 * Apply mainnet defaults and validate (JVM DifficultyAdjustment constructor
 * requires: useLastEpochs > 1, epochLength > 0, epochLength bounded so the
 * epoch-span product cannot overflow). Bad values are a caller-configuration
 * defect, not a proof defect — hence RangeError, outside the proof-error
 * class taxonomy.
 */
export function resolveDifficultyParams(
  opts: DifficultyParams = {},
): { epochLength: number; useLastEpochs: number } {
  const epochLength = opts.epochLength ?? EPOCH_LENGTH_MAINNET;
  const useLastEpochs = opts.useLastEpochs ?? USE_LAST_EPOCHS_MAINNET;
  if (!Number.isInteger(epochLength) || epochLength < 1) {
    throw new RangeError(`epochLength must be an integer >= 1, got ${epochLength}`);
  }
  if (!Number.isInteger(useLastEpochs) || useLastEpochs < 2) {
    throw new RangeError(`useLastEpochs must be an integer >= 2, got ${useLastEpochs}`);
  }
  if (epochLength * useLastEpochs > 2 ** 31) {
    throw new RangeError(
      `epochLength * useLastEpochs must be <= 2^31, got ${epochLength * useLastEpochs}`,
    );
  }
  return { epochLength, useLastEpochs };
}

/** Height at which difficulty is recalculated next after `height`. */
export function nextRecalculationHeight(height: number, epochLength: number): number {
  if (height % epochLength === 0) return height + 1;
  return (Math.floor(height / epochLength) + 1) * epochLength + 1;
}

/** Heights of previous headers required to recalculate difficulty at `height`. */
export function previousHeightsRequiredForRecalculation(
  height: number,
  epochLength: number,
  useLastEpochs: number,
): number[] {
  if ((height - 1) % epochLength === 0 && epochLength > 1) {
    const out: number[] = [];
    for (let i = useLastEpochs; i >= 0; i--) {
      const h = height - 1 - i * epochLength;
      if (h >= 0) out.push(h);
    }
    return out;
  } else if ((height - 1) % epochLength === 0 && height > epochLength * useLastEpochs) {
    // Reachable only when epochLength === 1 (the branch above eats every
    // epochLength > 1 case). Ported anyway — faithful includes the branches
    // real configs never take. Unlike the first branch, no >= 0 filter.
    const out: number[] = [];
    for (let i = useLastEpochs; i >= 0; i--) out.push(height - 1 - i * epochLength);
    return out;
  } else {
    return [height - 1];
  }
}

/** Heights needed to recalculate difficulty after a block at `height`. */
export function heightsForNextRecalculation(
  height: number,
  epochLength: number,
  useLastEpochs: number,
): number[] {
  return previousHeightsRequiredForRecalculation(
    nextRecalculationHeight(height, epochLength),
    epochLength,
    useLastEpochs,
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/nipopow/test/difficulty.test.ts`
Expected: PASS (all describes).

- [ ] **Step 6: Export from `index.ts`.** In the "Primary export" region add:

```ts
export {
  nextRecalculationHeight,
  previousHeightsRequiredForRecalculation,
  heightsForNextRecalculation,
  resolveDifficultyParams,
  EPOCH_LENGTH_MAINNET,
  USE_LAST_EPOCHS_MAINNET,
  type DifficultyParams,
} from './difficulty.ts';
```

(`hasValidDifficultyHeaders` joins this export block in Task 3.)

- [ ] **Step 7: Typecheck + package suite**

Run: `npx tsc --noEmit --project packages/nipopow/tsconfig.json && npx vitest run packages/nipopow/test/`
Expected: clean; all existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add packages/nipopow/src/difficulty.ts packages/nipopow/test/difficulty.test.ts packages/nipopow/src/index.ts
git commit -m "feat(nipopow): epoch math + difficulty-param resolver (JVM DifficultyAdjustment port, 49-row truth table)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/src/difficulty.ts packages/nipopow/test/difficulty.test.ts packages/nipopow/src/index.ts
```

---

### Task 3: `hasValidDifficultyHeaders`

**Files:**
- Modify: `packages/nipopow/src/difficulty.ts` (append)
- Modify: `packages/nipopow/test/difficulty.test.ts` (append)
- Modify: `packages/nipopow/src/index.ts` (add the export)

**Interfaces:**
- Consumes: Task 2's `heightsForNextRecalculation`.
- Produces: `export function hasValidDifficultyHeaders(proof: NipopowProof, epochLength: number, useLastEpochs: number): boolean` (Tasks 4–5 call it with already-resolved numbers).

- [ ] **Step 1: Write the failing tests.** Append to `test/difficulty.test.ts` (add `buildSyntheticProof` to the helper imports):

```ts
import { buildSyntheticProof } from './helpers.ts';
import { hasValidDifficultyHeaders } from '../src/difficulty.ts';

describe('hasValidDifficultyHeaders (e=16, u=8 unless noted)', () => {
  // suffixHead 100, e=16: next = 113, prevHeights(113) = [0,16,...,112];
  // gated to (0, 100) -> [16, 32, 48, 64, 80, 96].
  const NEEDED_100 = [16, 32, 48, 64, 80, 96];

  test('continuous=false is vacuously true (headers absent)', () => {
    const proof = buildSyntheticProof({ prefixHeights: [1, 50], suffixHeadHeight: 100, m: 2, k: 1 });
    expect(proof.continuous).toBe(false);
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('continuous=true with every needed height present is true', () => {
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1, ...NEEDED_100], suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('interleaved extra prefix heights do not break the non-resetting cursor', () => {
    const heights = [1, 10, 16, 20, 32, 40, 48, 60, 64, 77, 80, 90, 96, 99];
    const proof = {
      ...buildSyntheticProof({ prefixHeights: heights, suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('one missing needed height (48) is false', () => {
    const heights = [1, 16, 32, 64, 80, 96];
    const proof = {
      ...buildSyntheticProof({ prefixHeights: heights, suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(false);
  });

  test('needed height only in suffixTail still counts (chain-wide scan, JVM headersChain)', () => {
    // suffixHead 95: next = 97, prevHeights(97) = [0,16,...,96]; gated (0,95) -> [16,...,80].
    // Put 96 in the tail anyway (not needed) and one needed height, 80, ONLY implicitly:
    // heights strictly increasing: prefix has 16..64, tail has 96; 80 missing -> false.
    const missing80 = {
      ...buildSyntheticProof({
        prefixHeights: [1, 16, 32, 48, 64],
        suffixHeadHeight: 95,
        suffixTailHeights: [96],
        m: 2,
        k: 2,
      }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(missing80, 16, 8)).toBe(false);
    const present = {
      ...buildSyntheticProof({
        prefixHeights: [1, 16, 32, 48, 64, 80],
        suffixHeadHeight: 95,
        suffixTailHeights: [96],
        m: 2,
        k: 2,
      }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(present, 16, 8)).toBe(true);
  });

  test('boundary suffixHead % e === 0: needed excludes the suffixHead height itself', () => {
    // suffixHead 48: next = 49, prevHeights(49) = [0, 16, 32, 48]; gated (0, 48) -> [16, 32].
    const ok = {
      ...buildSyntheticProof({ prefixHeights: [1, 16, 32], suffixHeadHeight: 48, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(ok, 16, 8)).toBe(true);
    const missing32 = {
      ...buildSyntheticProof({ prefixHeights: [1, 16], suffixHeadHeight: 48, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(missing32, 16, 8)).toBe(false);
  });

  test('tiny suffixHead: gated needed set empty -> vacuously true with flag set', () => {
    // suffixHead 16: next = 17, prevHeights(17) = [0, 16]; gated (0, 16) -> [].
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1], suffixHeadHeight: 16, m: 1, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 16, 8)).toBe(true);
  });

  test('mainnet defaults on a small chain: vacuously true (matches fixture[0] shape)', () => {
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1, 5], suffixHeadHeight: 19, m: 2, k: 1 }),
      continuous: true,
    };
    expect(hasValidDifficultyHeaders(proof, 128, 8)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/nipopow/test/difficulty.test.ts`
Expected: FAIL — `hasValidDifficultyHeaders` not exported.

- [ ] **Step 3: Implement.** Append to `src/difficulty.ts`:

```ts
/**
 * Continuous-mode membership check — clean-room port of
 * NipopowProof.hasValidDifficultyHeaders (NipopowProof.scala:82-105).
 *
 * PRECONDITION: the caller has established strictly-increasing heights
 * across prefix ++ suffixHead ++ suffixTail. The scan below is an ordered,
 * non-resetting cursor (the JVM's indexWhere(_, lastIndex)); it equals set
 * membership only under that precondition. Both in-package callers
 * (verifyParsedProof, compareProofs' isValid) run the heights check first,
 * mirroring the JVM isValid &&-chain's short-circuit order.
 *
 * Takes resolved numbers (not DifficultyParams) — callers resolve once.
 */
export function hasValidDifficultyHeaders(
  proof: NipopowProof,
  epochLength: number,
  useLastEpochs: number,
): boolean {
  if (!proof.continuous) return true;
  const suffixHeadHeight = proof.suffixHead.header.height;
  const chainHeights: number[] = [
    ...proof.prefix.map(p => p.header.height),
    suffixHeadHeight,
    ...proof.suffixTail.map(h => h.height),
  ];
  let cursor = 0; // JVM lastIndex: search resumes at the previous match, never resets
  for (const h of heightsForNextRecalculation(suffixHeadHeight, epochLength, useLastEpochs)) {
    if (h <= 0 || h >= suffixHeadHeight) continue; // JVM: only 0 < height < suffixHead.height checked
    while (cursor < chainHeights.length && chainHeights[cursor] !== h) cursor++;
    if (cursor === chainHeights.length) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/nipopow/test/difficulty.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `hasValidDifficultyHeaders` to the Task 2 export block in `index.ts`.**

- [ ] **Step 6: Typecheck + package suite**

Run: `npx tsc --noEmit --project packages/nipopow/tsconfig.json && npx vitest run packages/nipopow/test/`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/nipopow/src/difficulty.ts packages/nipopow/test/difficulty.test.ts packages/nipopow/src/index.ts
git commit -m "feat(nipopow): hasValidDifficultyHeaders — continuous-mode membership check (NipopowProof.scala:82-105)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/src/difficulty.ts packages/nipopow/test/difficulty.test.ts packages/nipopow/src/index.ts
```

---

### Task 4: Verifier integration + connections threading

**Files:**
- Modify: `packages/nipopow/src/connections.ts`
- Modify: `packages/nipopow/src/verifier.ts`
- Modify: `packages/nipopow/test/proof.test.ts:293-309` (the flip-byte test)
- Modify: `packages/nipopow/test/verifier.test.ts` (new describe)

**Interfaces:**
- Consumes: Task 3's `hasValidDifficultyHeaders`, Task 2's `resolveDifficultyParams` + constants.
- Produces:
  - `hasValidConnections(proof: NipopowProof, useLastEpochs: number = USE_LAST_EPOCHS_MAINNET): boolean` (Task 5 threads a value).
  - `VerifyOptions` with `epochLength?: number; useLastEpochs?: number`.
  - `VerificationResult.continuous: boolean`.
  - Error code `'missing-difficulty-headers'`.

- [ ] **Step 1: Write the failing tests.**

(a) **Rewrite** `proof.test.ts`'s flip-byte test (lines ~293–309). The current test asserts `'continuous-unsupported'`. Fixture[0] is `chain-20-m2-k2-tip` (suffixHead height 19, present heights {1,3,5,8,9,10,12,14,19,20}): at mainnet defaults the gated needed set is EMPTY → the proof now verifies; with `epochLength: 8` the gated set is [8, 16] and 16 is absent → deterministic reject. Replace the test body with:

```ts
  test('continuous byte = 0x01 parses, re-serializes byte-identically, and now VERIFIES (vacuous difficulty check at mainnet defaults on this tiny chain)', () => {
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    const tampered = new Uint8Array(original);
    tampered[tampered.length - 1] = 0x01;

    const proof = parseProof(tampered);
    expect(proof.continuous).toBe(true);
    expect(serializeProof(proof)).toEqual(tampered);

    // suffixHead height 19 < EPOCH_LENGTH_MAINNET: heightsForNextRecalculation
    // gated to (0, 19) is empty, so the membership check is vacuous.
    const result = verifyParsedProof(proof, { checkPoW: false });
    expect(result.continuous).toBe(true);
    expect(result.suffixTipHeight).toBe(fixtures[0]!.suffix_tail_heights.at(-1) ?? fixtures[0]!.suffix_head_height);
  });

  test('continuous proof missing a needed height rejects with missing-difficulty-headers (epochLength override 8: needs {8,16}, 16 absent)', () => {
    const original = hexToBytes(fixtures[0]!.bytes_hex);
    const tampered = new Uint8Array(original);
    tampered[tampered.length - 1] = 0x01;
    const proof = parseProof(tampered);

    try {
      verifyParsedProof(proof, { checkPoW: false, epochLength: 8 });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('missing-difficulty-headers');
    }
  });
```

(b) **New describe** in `verifier.test.ts` (imports to add: `buildSyntheticProof` from `./helpers.ts` if absent — it is already imported there per the existing synthetic tests; check the file's import block):

```ts
describe('continuous mode: difficulty-header verification', () => {
  const NEEDED_100 = [16, 32, 48, 64, 80, 96]; // e=16,u=8, suffixHead 100, gated (0,100)

  test('accepts a continuous proof carrying all needed heights (e=16 override)', () => {
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1, ...NEEDED_100], suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    const result = verifyParsedProof(proof, { checkPoW: false, epochLength: 16, useLastEpochs: 8 });
    expect(result.continuous).toBe(true);
    expect(result.totalHeaders).toBe(NEEDED_100.length + 2);
  });

  test('rejects when one needed height is missing', () => {
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1, 16, 32, 64, 80, 96], suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    try {
      verifyParsedProof(proof, { checkPoW: false, epochLength: 16 });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ProofVerificationError);
      expect((e as ProofVerificationError).code).toBe('missing-difficulty-headers');
    }
  });

  test('non-continuous proofs are untouched by the new check (missing heights, still accepted)', () => {
    const proof = buildSyntheticProof({ prefixHeights: [1, 50], suffixHeadHeight: 100, m: 2, k: 1 });
    const result = verifyParsedProof(proof, { checkPoW: false, epochLength: 16 });
    expect(result.continuous).toBe(false);
  });

  test('difficulty check runs AFTER structural checks: non-monotone continuous proof fails on heights first', () => {
    const proof = {
      ...buildSyntheticProof({ prefixHeights: [1, 50, 40], suffixHeadHeight: 100, m: 2, k: 1 }),
      continuous: true,
    };
    try {
      verifyParsedProof(proof, { checkPoW: false, epochLength: 16 });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ProofVerificationError).code).toBe('non-increasing-heights');
    }
  });

  test('bad difficulty options throw RangeError before any proof inspection', () => {
    const proof = buildSyntheticProof({ prefixHeights: [1], suffixHeadHeight: 2, m: 1, k: 1 });
    expect(() => verifyParsedProof(proof, { epochLength: 0 })).toThrow(RangeError);
    expect(() => verifyParsedProof(proof, { useLastEpochs: 1 })).toThrow(RangeError);
    // even a proof that would fail m/k gates: options resolve first
    const badShape = { ...buildSyntheticProof({ prefixHeights: [1], suffixHeadHeight: 2, m: 0, k: 0 }) };
    expect(() => verifyParsedProof(badShape, { epochLength: -1 })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/nipopow/test/proof.test.ts packages/nipopow/test/verifier.test.ts`
Expected: FAIL — the rewritten flip-byte test still hits `'continuous-unsupported'`; new describe fails on unknown options / wrong behavior.

- [ ] **Step 3: Implement `connections.ts` threading.** Replace the two module constants and the signature (keep the doc comment, updating the sigma-rust framing to name the JVM coupling):

```ts
import { USE_LAST_EPOCHS_MAINNET } from './difficulty.ts';

export function hasValidConnections(
  proof: NipopowProof,
  useLastEpochs: number = USE_LAST_EPOCHS_MAINNET,
): boolean {
  return checkPrefixConnections(proof, useLastEpochs + 3) && checkSuffixConnections(proof);
}
```

`checkPrefixConnections(proof: NipopowProof, lookbackSpan: number)` takes the span as a parameter (`const lookbackStart = i > lookbackSpan ? i - lookbackSpan : 0;`). Delete the module-level `USE_LAST_EPOCHS` / `LOOKBACK_SPAN` consts. The JVM derivation to cite in the comment: `maxDiffHeaders = useLastEpochs + 1`, window lower bound `checkIdx - maxDiffHeaders - 2` ⇒ span `useLastEpochs + 3` (`NipopowProof.scala:129,135`).

- [ ] **Step 4: Implement `verifier.ts` changes.**

1. Imports: add `import { hasValidDifficultyHeaders, resolveDifficultyParams } from './difficulty.ts';`
2. `VerifyOptions`: add fields (documented — RangeError on bad values, defaults `EPOCH_LENGTH_MAINNET`/`USE_LAST_EPOCHS_MAINNET`):

```ts
  epochLength?: number;
  useLastEpochs?: number;
```

3. `VerificationResult`: `continuous: boolean;` (was `continuous: false;`).
4. In `verifyParsedProof`, FIRST statement (before the m/k gates):

```ts
  const { epochLength, useLastEpochs } = resolveDifficultyParams(opts);
```

5. DELETE the whole `if (proof.continuous) { throw ... 'continuous-unsupported' }` block and its Task 7b comment (lines ~116–131).
6. Step 1 becomes `if (!hasValidConnections(proof, useLastEpochs)) {`.
7. After the monotonic-height + PoW loop, before the return:

```ts
  // ── Step 4: Continuous-mode difficulty headers ─────────────────────────────
  // JVM NipopowProof.hasValidDifficultyHeaders — runs last, as in the JVM
  // isValid &&-chain, so the strictly-increasing-heights precondition of the
  // ordered membership scan is already established. Vacuous for
  // continuous === false: the non-continuous accept-set is exactly 0.3.0's.
  if (!hasValidDifficultyHeaders(proof, epochLength, useLastEpochs)) {
    throw new ProofVerificationError(
      `continuous proof is missing difficulty-recalculation headers for suffix head ${proof.suffixHead.header.height}`,
      'missing-difficulty-headers',
    );
  }
```

8. Return: `continuous: proof.continuous,`.
9. Update the file-header failure-modes doc comment: drop `'continuous-unsupported'`, add `'missing-difficulty-headers'`, and drop the `continuous === false` postcondition line.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/nipopow/test/proof.test.ts packages/nipopow/test/verifier.test.ts packages/nipopow/test/difficulty.test.ts packages/nipopow/test/connections.test.ts`
Expected: PASS.

- [ ] **Step 6: Full package suite + typecheck** (catches any other test relying on the removed code path — `mutation.test.ts` and `connections.test.ts` reference `continuous` and must pass unmodified)

Run: `npx vitest run packages/nipopow/test/ && npx tsc --noEmit --project packages/nipopow/tsconfig.json`
Expected: clean. If anything besides the rewritten flip-byte test fails, STOP — that is an accept-set regression, not a test to edit.

- [ ] **Step 7: Commit**

```bash
git add packages/nipopow/src/connections.ts packages/nipopow/src/verifier.ts packages/nipopow/test/proof.test.ts packages/nipopow/test/verifier.test.ts
git commit -m "feat(nipopow): verifier accepts continuous proofs — hasValidDifficultyHeaders check replaces continuous-unsupported gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/src/connections.ts packages/nipopow/src/verifier.ts packages/nipopow/test/proof.test.ts packages/nipopow/test/verifier.test.ts
```

---

### Task 5: Compare integration

**Files:**
- Modify: `packages/nipopow/src/compare.ts`
- Modify: `packages/nipopow/test/compare.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 (`hasValidDifficultyHeaders`, `resolveDifficultyParams`, `DifficultyParams`, `hasValidConnections(proof, useLastEpochs)`).
- Produces: `compareProofs(a: Uint8Array, b: Uint8Array, opts?: DifficultyParams): boolean`.

- [ ] **Step 1: Write the failing tests.** Append to `compare.test.ts` (it already loads proof fixtures and helpers — extend its import block with `serializeProof` from `../src/proof.ts` and `buildSyntheticProof` from `./helpers.ts` if absent). Note: synthetic proofs serialize fine (`buildSyntheticProof` output round-trips — empty interlinks arrays are a parse-time NIP-05 reject, so serialize the objects and compare via `compareProofs` only where parseable; use the fixture-based path instead):

```ts
describe('continuous gate in compareProofs isValid (JVM NipopowProof.isValid conjunction)', () => {
  // fixture[0] chain-20-m2-k2-tip: suffixHead 19, present heights {1,3,5,8,9,10,12,14,19,20}.
  // At epochLength 8 (u=8): needed gated (0,19) = [8,16]; 16 is ABSENT.
  const originalBytes = () => hexToBytes(fixtures[0]!.bytes_hex);
  const continuousBytes = () => {
    const b = new Uint8Array(originalBytes());
    b[b.length - 1] = 0x01;
    return b;
  };

  test('continuous proof missing difficulty headers is not comparable: valid non-continuous wins', () => {
    expect(compareProofs(originalBytes(), continuousBytes(), { epochLength: 8 })).toBe(true);
    expect(compareProofs(continuousBytes(), originalBytes(), { epochLength: 8 })).toBe(false);
  });

  test('same pair at mainnet defaults: both valid (vacuous check on tiny chain), equal chains -> not better either way', () => {
    expect(compareProofs(originalBytes(), continuousBytes())).toBe(false);
    expect(compareProofs(continuousBytes(), originalBytes())).toBe(false);
  });

  test('both continuous-invalid: neither is better', () => {
    expect(compareProofs(continuousBytes(), continuousBytes(), { epochLength: 8 })).toBe(false);
  });

  test('bad opts throw RangeError', () => {
    expect(() => compareProofs(originalBytes(), originalBytes(), { epochLength: 0 })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/nipopow/test/compare.test.ts`
Expected: FAIL — `compareProofs` takes no third argument / continuous proof scores as valid at `epochLength: 8`.

- [ ] **Step 3: Implement.** In `compare.ts`:

1. Imports: `import { hasValidDifficultyHeaders, resolveDifficultyParams, type DifficultyParams } from './difficulty.ts';`
2. Entry point:

```ts
export function compareProofs(a: Uint8Array, b: Uint8Array, opts: DifficultyParams = {}): boolean {
  const { epochLength, useLastEpochs } = resolveDifficultyParams(opts);
  const proofA = parseProof(a);
  const proofB = parseProof(b);
  return isBetterThan(proofA, proofB, epochLength, useLastEpochs);
}
```

3. `isBetterThan(a, b, epochLength, useLastEpochs)` passes both numbers to `isValid`; body otherwise unchanged.
4. `isValid(proof, epochLength, useLastEpochs)`:

```ts
function isValid(proof: NipopowProof, epochLength: number, useLastEpochs: number): boolean {
  if (!hasValidConnections(proof, useLastEpochs)) return false;
  if (!hasValidHeights(proof)) return false;
  for (const ph of [proof.suffixHead, ...proof.prefix]) {
    if (!checkInterlinksProof(ph)) return false;
  }
  // JVM isValid's fourth conjunct (NipopowProof.scala:75) — runs after the
  // heights check, preserving the ordered-scan precondition.
  return hasValidDifficultyHeaders(proof, epochLength, useLastEpochs);
}
```

5. Update the file-header algorithm comment: `is_valid` gains the fourth conjunct; note the JVM (not sigma-rust) is the reference for it.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/nipopow/test/compare.test.ts`
Expected: PASS.

- [ ] **Step 5: Package suite + typecheck**

Run: `npx vitest run packages/nipopow/test/ && npx tsc --noEmit --project packages/nipopow/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/nipopow/src/compare.ts packages/nipopow/test/compare.test.ts
git commit -m "feat(nipopow): compareProofs difficulty-header gate — isValid matches JVM four-conjunct order

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/src/compare.ts packages/nipopow/test/compare.test.ts
```

---

### Task 6: `proveWithReader` injection

**Files:**
- Modify: `packages/nipopow/src/prover.ts`
- Modify: `packages/nipopow/test/prover-reader.test.ts`

**Interfaces:**
- Consumes: Task 2 (`heightsForNextRecalculation`, `resolveDifficultyParams`), Task 4 verifier (round-trip assertions).
- Produces:
  - `PoPowParams = { m: number; k: number; continuous?: boolean; epochLength?: number; useLastEpochs?: number }`
  - module-internal `neededPrefixHeights(suffixHeadHeight: number, epochLength: number, useLastEpochs: number): number[]` (Task 7 reuses it)
  - `proveWithReader` returning `continuous`-stamped proofs with injected headers.

- [ ] **Step 1: Write the failing tests.** Append to `prover-reader.test.ts` (it already imports `proveWithReader`, `buildTestChain`, `MemoryReader`; add `verifyParsedProof` from `../src/verifier.ts` and `heightsForNextRecalculation` from `../src/difficulty.ts`):

```ts
describe('proveWithReader continuous mode (e=16, u=8)', () => {
  // 64-header level-0-free-ish chain; exact levels don't matter for injection.
  const levels = Array.from({ length: 64 }, (_, i) => (i % 8 === 7 ? 2 : 1));
  const E = { epochLength: 16, useLastEpochs: 8 };

  test('injects exactly the gated needed heights and verifies end-to-end', async () => {
    const chain = buildTestChain(levels);
    const reader = new MemoryReader(chain);
    const proof = await proveWithReader(reader, { m: 3, k: 3, continuous: true, ...E });

    expect(proof.continuous).toBe(true);
    const sh = proof.suffixHead.header.height; // tip-mode: 64 - k + 1 = 62
    const needed = heightsForNextRecalculation(sh, 16, 8).filter(h => h > 0 && h < sh);
    const prefixHeights = new Set(proof.prefix.map(p => p.header.height));
    for (const h of needed) expect(prefixHeights.has(h), `height ${h}`).toBe(true);

    // strictly increasing prefix (dedupe + sort held under injection)
    const hs = proof.prefix.map(p => p.header.height);
    for (let i = 1; i < hs.length; i++) expect(hs[i]!).toBeGreaterThan(hs[i - 1]!);

    // the unit's promise: what the prover builds, the verifier accepts
    const result = verifyParsedProof(proof, { checkPoW: false, ...E });
    expect(result.continuous).toBe(true);
  });

  test('continuous=false output is byte-region-identical to the pre-0.4.0 shape (flag default false)', async () => {
    const chain = buildTestChain(levels);
    const a = await proveWithReader(new MemoryReader(chain), { m: 3, k: 3 });
    const b = await proveWithReader(new MemoryReader(chain), { m: 3, k: 3, continuous: false, ...E });
    expect(a.continuous).toBe(false);
    expect(a.prefix.map(p => p.header.height)).toEqual(b.prefix.map(p => p.header.height));
  });

  test('reader missing a needed height: silently skipped, proof then fails verification', async () => {
    const chain = buildTestChain(levels);
    const sh = 62;
    const needed = heightsForNextRecalculation(sh, 16, 8).filter(h => h > 0 && h < sh);
    const dropped = needed[0]!;
    class GappyReader extends MemoryReader {
      override async popowHeaderAtHeight(h: number) {
        return h === dropped ? null : super.popowHeaderAtHeight(h);
      }
    }
    const proof = await proveWithReader(new GappyReader(chain), { m: 3, k: 3, continuous: true, ...E });
    expect(proof.continuous).toBe(true);
    expect(proof.prefix.some(p => p.header.height === dropped)).toBe(false);
    // walk-selected prefix does not happen to contain `dropped` for this chain shape;
    // if it ever does after a helper change, pick the first needed height NOT in the
    // non-continuous proof's prefix instead of needed[0].
    try {
      verifyParsedProof(proof, { checkPoW: false, ...E });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as ProofVerificationError).code).toBe('missing-difficulty-headers');
    }
  });

  test('bad difficulty params throw RangeError even with continuous=false (JVM constructs DifficultyAdjustment unconditionally)', async () => {
    const chain = buildTestChain(levels);
    await expect(
      proveWithReader(new MemoryReader(chain), { m: 3, k: 3, epochLength: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
```

(`ProofVerificationError` import: add from `../src/errors.ts` if not present.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/nipopow/test/prover-reader.test.ts`
Expected: FAIL — unknown `continuous` param has no effect / `proof.continuous` is `false`.

- [ ] **Step 3: Implement.** In `prover.ts`:

1. Imports: `import { heightsForNextRecalculation, resolveDifficultyParams } from './difficulty.ts';`
2. Params type:

```ts
export type PoPowParams = {
  m: number;
  k: number;
  /** Build a continuous-mode proof (difficulty-recalculation headers injected into the prefix). Default false. */
  continuous?: boolean;
  /** Effective difficulty epoch length; default EPOCH_LENGTH_MAINNET = 128. RangeError on invalid. */
  epochLength?: number;
  /** chainSettings.useLastEpochs; default USE_LAST_EPOCHS_MAINNET = 8. RangeError on invalid. */
  useLastEpochs?: number;
};
```

3. Shared helper (module-internal, above `prove`):

```ts
/**
 * Difficulty-recalculation heights the prover must inject into the prefix:
 * heightsForNextRecalculation gated to h < suffixHeadHeight (strict — JVM
 * NipopowProverWithDbAlgs.scala:98). No h > 0 gate: no chain has a header at
 * height <= 0, so lookup misses and the silent-skip rule applies, matching
 * the JVM's popowHeader(height).foreach.
 */
function neededPrefixHeights(
  suffixHeadHeight: number,
  epochLength: number,
  useLastEpochs: number,
): number[] {
  return heightsForNextRecalculation(suffixHeadHeight, epochLength, useLastEpochs).filter(
    h => h < suffixHeadHeight,
  );
}
```

4. In `proveWithReader`: destructure `const continuous = params.continuous ?? false;` and `const { epochLength, useLastEpochs } = resolveDifficultyParams(params);` right after the existing m/k integer gates (unconditional — before the `headersHeight()` call). Then, in the genesis/dedupe block, inject between the genesis seed and the walk-collected merge:

```ts
  const byHeight = new Map<number, PoPowHeader>();
  byHeight.set(1, genesis);
  if (continuous) {
    // JVM NipopowProverWithDbAlgs.scala:93-105: difficulty headers enter
    // storedHeights before the walk selection, so they take precedence in
    // the by-height dedupe. A null (reader lacks the height) is silently
    // skipped — Option.foreach semantics; the resulting proof fails
    // verification downstream exactly as the JVM's would.
    for (const h of neededPrefixHeights(suffixHead.header.height, epochLength, useLastEpochs)) {
      if (byHeight.has(h)) continue;
      const ph = await reader.popowHeaderAtHeight(h);
      if (ph !== null) byHeight.set(h, ph);
    }
  }
  for (const ph of collected.values()) {
    if (!byHeight.has(ph.header.height)) byHeight.set(ph.header.height, ph);
  }
```

5. Return `{ m, k, prefix, suffixHead, suffixTail, continuous };` and delete the Task 7b stamp-only comment.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/nipopow/test/prover-reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Package suite + typecheck** (`prover-santa.test.ts` MUST pass untouched — SANTA vectors are non-continuous, `params.continuous` defaults false)

Run: `npx vitest run packages/nipopow/test/ && npx tsc --noEmit --project packages/nipopow/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/nipopow/src/prover.ts packages/nipopow/test/prover-reader.test.ts
git commit -m "feat(nipopow): proveWithReader continuous-mode injection (NipopowProverWithDbAlgs.scala:93-105)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/src/prover.ts packages/nipopow/test/prover-reader.test.ts
```

---

### Task 7: `prove()` injection + cross-prover equivalence

**Files:**
- Modify: `packages/nipopow/src/prover.ts`
- Modify: `packages/nipopow/test/prover.test.ts`

**Interfaces:**
- Consumes: Task 6's `neededPrefixHeights` + params handling; Task 4 verifier.
- Produces: `prove(chain, params)` continuous support. No new names.

- [ ] **Step 1: Write the failing tests.** Append to `prover.test.ts` (imports to add: `proveWithReader` from `../src/prover.ts`, `MemoryReader` from `./reader-double.ts`, `verifyParsedProof` from `../src/verifier.ts`, `serializeProof` from `../src/proof.ts`, `heightsForNextRecalculation` from `../src/difficulty.ts`):

```ts
describe('prove() continuous mode (deliberate divergence from JVM stamp-only NipopowAlgos.prove)', () => {
  const levels = Array.from({ length: 64 }, (_, i) => (i % 8 === 7 ? 2 : 1));
  const E = { epochLength: 16, useLastEpochs: 8 };

  test('injects gated needed heights, stamps the flag, and self-verifies', () => {
    const chain = buildTestChain(levels);
    const proof = prove(chain, { m: 3, k: 3, continuous: true, ...E });
    expect(proof.continuous).toBe(true);
    const sh = proof.suffixHead.header.height;
    const needed = heightsForNextRecalculation(sh, 16, 8).filter(h => h > 0 && h < sh);
    const prefixHeights = new Set(proof.prefix.map(p => p.header.height));
    for (const h of needed) expect(prefixHeights.has(h), `height ${h}`).toBe(true);
    const result = verifyParsedProof(proof, { checkPoW: false, ...E });
    expect(result.continuous).toBe(true);
  });

  test('continuous prove() === continuous proveWithReader() on the same chain (injection adds the identical set)', async () => {
    const chain = buildTestChain(levels);
    const a = prove(chain, { m: 3, k: 3, continuous: true, ...E });
    const b = await proveWithReader(new MemoryReader(chain), { m: 3, k: 3, continuous: true, ...E });
    expect(serializeProof(a)).toEqual(serializeProof(b));
  });

  test('needed height absent from the chain argument is skipped silently (mirrors reader-path rule)', () => {
    const chain = buildTestChain(levels);
    const sh = 62;
    const needed = heightsForNextRecalculation(sh, 16, 8).filter(h => h > 0 && h < sh);
    const dropped = needed[0]!;
    const gappy = chain.filter(p => p.header.height !== dropped);
    const proof = prove(gappy, { m: 3, k: 3, continuous: true, ...E });
    expect(proof.prefix.some(p => p.header.height === dropped)).toBe(false);
    expect(proof.continuous).toBe(true);
  });

  test('bad difficulty params throw RangeError with continuous=false too', () => {
    const chain = buildTestChain(levels);
    expect(() => prove(chain, { m: 3, k: 3, useLastEpochs: 1 })).toThrow(RangeError);
  });
});
```

Note on the equivalence test: `buildTestChain` levels put a superblock every 8th header. The two provers coincide when the reader walk's per-level selections match the in-memory filter — the SANTA fixtures established this for level-0-free chains; this `levels` array has no level-0 entries (all ≥ 1), preserving the predicate. If the byte-equality assertion fails, the chain shape violated the predicate — fix the `levels` array (all entries ≥ 1), not the prover.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/nipopow/test/prover.test.ts`
Expected: FAIL — `prove` ignores `continuous`, returns `continuous: false`.

- [ ] **Step 3: Implement.** In `prove()`:

1. After the existing m/k gates: `const continuous = params.continuous ?? false;` and `const { epochLength, useLastEpochs } = resolveDifficultyParams(params);` (unconditional).
2. After the dedupe+sort block (current lines ~48–52), inject:

```ts
  // Continuous mode: inject difficulty-recalculation headers. DELIBERATE
  // divergence from JVM NipopowAlgos.prove, which stamps params.continuous
  // WITHOUT injecting (NipopowAlgos.scala:158 — "Paper-like code used in
  // tests only") and so emits proofs its own verifier rejects. Both ergots
  // provers inject the identical set; see facts/nipopow.md.
  if (continuous) {
    for (const h of neededPrefixHeights(suffixHead.header.height, epochLength, useLastEpochs)) {
      const candidate = preSuffix.find(p => p.header.height === h);
      if (candidate === undefined) continue; // absent from chain: silent skip, mirrors reader path
      if (!prefix.some(q => bytesEqual(q.header.id, candidate.header.id))) prefix.push(candidate);
    }
    prefix.sort((a, b) => a.header.height - b.header.height);
  }
```

3. Return `{ m, k, prefix, suffixHead, suffixTail, continuous };` and delete the Task 7b comment above it.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/nipopow/test/prover.test.ts`
Expected: PASS.

- [ ] **Step 5: Package suite + typecheck**

Run: `npx vitest run packages/nipopow/test/ && npx tsc --noEmit --project packages/nipopow/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/nipopow/src/prover.ts packages/nipopow/test/prover.test.ts
git commit -m "feat(nipopow): prove() continuous-mode injection + cross-prover byte equivalence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/src/prover.ts packages/nipopow/test/prover.test.ts
```

---

### Task 8: SANTA batch-2 conformance vectors

**Delivery note:** SANTA batch 2 DELIVERED 2026-08-19 and already staged untracked at `packages/nipopow/test/fixtures/jvm_continuous/vectors.json` (6 vectors, e=16/u=8: v1-noncontinuous-tip, v2-continuous-tip-no-injection [JVM stamp-only → hVDH=false/isValid=FALSE — independent confirmation of the option-b rationale], v3-continuous-tip-injected, v4-continuous-tip-missing-one, v5-continuous-anchored-h48-injected, v6-continuous-anchored-h16-vacuous). Schema validated; `neededHeights` is recorded RAW (ungated — includes 0 and heights ≥ suffixHeadHeight), matching our ungated `heightsForNextRecalculation` return; all three raw lists already hand-verified against our math.

**Files:**
- Commit (already staged untracked): `packages/nipopow/test/fixtures/jvm_continuous/vectors.json`
- Create: `packages/nipopow/test/jvm-continuous-vectors.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5.
- Produces: JVM-conformance evidence; no new exports.

- [ ] **Step 1: Sanity-check the staged delivery, commit the fixture.** (File already staged untracked — copied and schema-validated at plan time.)

```bash
python3 - <<'EOF'
import json
v = json.load(open('packages/nipopow/test/fixtures/jvm_continuous/vectors.json'))['vectors']
assert len(v) == 6, len(v)
for x in v:
    for k in ('name','m','k','epochLength','useLastEpochs','suffixHeadHeight','neededHeights','hasValidDifficultyHeaders','isValid','bytesHex'):
        assert k in x, (x.get('name'), k)
print('ok', len(v), 'vectors:', [x['name'] for x in v])
EOF
git add packages/nipopow/test/fixtures/jvm_continuous/vectors.json
git commit -m "test(nipopow): SANTA JVM continuous-mode truth vectors (hasValidDifficultyHeaders/isValid + bytes)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/test/fixtures/jvm_continuous/vectors.json
```

Cross-check each vector's `neededHeights` against our own `heightsForNextRecalculation(suffixHeadHeight, 16, 8)` mentally or in the python block — a mismatch is a STOP (either SANTA drove different settings or our math diverges; investigate before writing tests).

- [ ] **Step 2: Write the failing test** — `packages/nipopow/test/jvm-continuous-vectors.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseProof, serializeProof } from '../src/proof.ts';
import { verifyParsedProof } from '../src/verifier.ts';
import { compareProofs } from '../src/compare.ts';
import { hasValidDifficultyHeaders, heightsForNextRecalculation } from '../src/difficulty.ts';
import { ProofVerificationError } from '../src/errors.ts';
import { hexToBytes } from './helpers.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ContinuousVector {
  name: string;
  description: string;
  m: number;
  k: number;
  epochLength: number;
  useLastEpochs: number;
  suffixHeadHeight: number;
  neededHeights: number[];
  hasValidDifficultyHeaders: boolean;
  isValid: boolean;
  bytesHex: string;
}

const vectors: ContinuousVector[] = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/jvm_continuous/vectors.json'), 'utf8'),
).vectors;

describe('JVM continuous-mode truth vectors (SANTA batch 2)', () => {
  test.each(vectors.map(v => [v.name, v] as const))('%s: parse + round-trip + booleans match JVM', (_name, v) => {
    const bytes = hexToBytes(v.bytesHex);
    const proof = parseProof(bytes);
    expect(serializeProof(proof)).toEqual(bytes);
    expect(proof.m).toBe(v.m);
    expect(proof.suffixHead.header.height).toBe(v.suffixHeadHeight);

    // our epoch math reproduces the JVM's recorded needed heights
    expect(heightsForNextRecalculation(v.suffixHeadHeight, v.epochLength, v.useLastEpochs)).toEqual(
      v.neededHeights,
    );

    // the membership check agrees with the JVM boolean
    expect(hasValidDifficultyHeaders(proof, v.epochLength, v.useLastEpochs)).toBe(
      v.hasValidDifficultyHeaders,
    );

    // full-pipeline agreement with JVM isValid: verifyParsedProof with
    // checkPoW:false runs exactly the four isValid conjuncts (fake-PoW
    // chains; the v1/v2 version gate is checkPoW-gated too).
    const opts = { checkPoW: false, epochLength: v.epochLength, useLastEpochs: v.useLastEpochs };
    if (v.isValid) {
      expect(verifyParsedProof(proof, opts).continuous).toBe(proof.continuous);
    } else {
      expect(() => verifyParsedProof(proof, opts)).toThrow(ProofVerificationError);
    }
  });

  test('compareProofs: JVM-valid vector beats JVM-invalid vector, not vice versa', () => {
    const valid = vectors.find(v => v.isValid && v.hasValidDifficultyHeaders);
    const invalid = vectors.find(v => !v.isValid);
    if (!valid || !invalid) return; // vector set lacks the pairing; covered per-vector above
    const opts = { epochLength: valid.epochLength, useLastEpochs: valid.useLastEpochs };
    expect(compareProofs(hexToBytes(valid.bytesHex), hexToBytes(invalid.bytesHex), opts)).toBe(true);
    expect(compareProofs(hexToBytes(invalid.bytesHex), hexToBytes(valid.bytesHex), opts)).toBe(false);
  });
});
```

- [ ] **Step 3: Run.** This is a conformance test over an already-built implementation (Tasks 2–5), so it should pass immediately. An assertion failure here is a conformance bug against JVM ground truth — STOP and investigate against the JVM sources; do NOT edit expectations to green.

Run: `npx vitest run packages/nipopow/test/jvm-continuous-vectors.test.ts`
Expected: PASS (or STOP on divergence).

- [ ] **Step 4: Package suite + typecheck**

Run: `npx vitest run packages/nipopow/test/ && npx tsc --noEmit --project packages/nipopow/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/nipopow/test/jvm-continuous-vectors.test.ts
git commit -m "test(nipopow): continuous-mode conformance against SANTA JVM truth vectors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/test/jvm-continuous-vectors.test.ts
```

---

### Task 9: Live-mainnet acceptance — `--expect-full-identity` flips to PASS

**Files:**
- Modify: `tools/nipopow-capture/live-walk.mjs`
- Ledger record: per-task report in the arc ledger directory (not committed to the package)

**Interfaces:**
- Consumes: Tasks 6 (continuous `proveWithReader`) and 4 (verifier).
- Produces: the acceptance record (report + script output); the updated tool.

- [ ] **Step 1: Read `tools/nipopow-capture/live-walk.mjs` end-to-end** (14.4K — it carries the Task 9 (prover arc) composite-acceptance logic and a long header comment documenting exactly what moves to this unit).

- [ ] **Step 2: Implement the full-identity flip.** In `--expect-full-identity` mode ONLY:
  - call `proveWithReader` with `{ m, k, continuous: true }` (mainnet defaults for `epochLength`/`useLastEpochs` — do NOT pass overrides);
  - do NOT normalize either side's `continuous` flag to `false`;
  - byte-compare our serialized proof against the raw JVM response bytes as-is;
  - add a verifier step: `verifyProof(jvmRawBytes, { checkPoW: true })` — log `verify: PASS (suffixTip=…, totalHeaders=…, continuous=true)` or the error;
  - update the header comment: the "what still moves to the future continuous-mode unit" paragraph becomes "resolved in 0.4.0 (this run)".
  Default (non-flag) mode stays byte-for-byte as today — still normalizes, still passes, still useful against older captures.

- [ ] **Step 3: Run both Task-9 parameter sets against the mainnet node** (the prover arc used `213.239.193.208:9053`, `ergo-mainnet-6.0.4`; any conformant 6.x node works):

```bash
node tools/nipopow-capture/live-walk.mjs 6 6 --expect-full-identity
node tools/nipopow-capture/live-walk.mjs 2 10 --expect-full-identity
```

Expected: both print `PASS` on the raw byte comparison AND `verify: PASS … continuous=true`. A FAIL here is a real divergence — capture the full output, STOP, and investigate (the prover-arc composite acceptance already attributed every surplus height, so a mismatch means the injection or defaults are wrong, not the method).

- [ ] **Step 4: Record the acceptance** — save both runs' full output into the arc ledger (`task-9-report.md` equivalent per the sdd process), including node identity, tip height/id, prefix/byte counts both sides.

- [ ] **Step 5: Commit the tool change**

```bash
git add tools/nipopow-capture/live-walk.mjs
git commit -m "feat(tools): live-walk full-identity mode goes continuous — raw byte identity + verifyProof acceptance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- tools/nipopow-capture/live-walk.mjs
```

---

### Task 10: Docs close-out, 0.4.0, full gates

**Files:**
- Modify: `packages/nipopow/package.json` (version 0.3.0 → 0.4.0)
- Modify: `packages/nipopow/README.md`, `packages/nipopow/API.md`
- Modify: `SESSION_CONTEXT.md`, `HANDOFF.md`
- Verify: `packages/nipopow/src/index.ts` export completeness

**Interfaces:**
- Consumes: everything.
- Produces: the releasable branch state.

- [ ] **Step 1: `package.json`** — `"version": "0.4.0"`.

- [ ] **Step 2: README.md** — continuous-mode section: what it is (one paragraph), that live-node proofs now verify, the `epochLength`/`useLastEpochs` defaults + override surface, the `prove()` divergence note, and a migration block for 0.3.x users: `'continuous-unsupported'` no longer exists (continuous proofs verify or fail `'missing-difficulty-headers'`), `VerificationResult.continuous` is now `boolean`. Update the fixture-provenance section: `jvm_difficulty/` + `jvm_continuous/` are SANTA JVM deliveries (like `jvm_prover/`), not fixture-gen output.

- [ ] **Step 3: API.md** — per-function updates mirroring the Task 1 facts deltas (the six new exports, changed options/params/result types, `compareProofs` third arg, error-code delta). Keep it at API.md's existing per-function granularity; facts/nipopow.md remains the contract of record.

- [ ] **Step 4: index.ts export audit** — confirm the export block matches the facts "Public-surface inventory" exactly; `git grep -n "export" packages/nipopow/src/index.ts` and diff by eye against facts.

- [ ] **Step 5: Full gates (all four, from repo root):**

```bash
npm test                                        # all workspaces
npm run typecheck                               # all workspaces
npm test --workspace @ergots/nipopow -- --config vitest.browser.config.ts   # jsdom
npm run build --workspace @ergots/nipopow       # tsup, incl. /prover dist entry
```

Expected: all green. (Reminder: root `npm test` covers packages/* only; the bare-root-vitest superset figure differs by the harness tests — scope, not staleness.)

- [ ] **Step 6: SESSION_CONTEXT.md + HANDOFF.md** — refresh to continuous-mode-complete: state, acceptance record pointer, open items (npm publish 0.4.0 = user's call; sigma-rust upstream report still owned by the sigma-rust session; the three unrelated carries still open).

- [ ] **Step 7: Commit**

```bash
git add packages/nipopow/package.json packages/nipopow/README.md packages/nipopow/API.md SESSION_CONTEXT.md HANDOFF.md
git commit -m "docs(nipopow): continuous-mode close-out — README/API surface, 0.4.0, session records

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" -- packages/nipopow/package.json packages/nipopow/README.md packages/nipopow/API.md SESSION_CONTEXT.md HANDOFF.md
```

---

## Plan Self-Review (run before execution)

1. **Spec coverage**: spec §1 module → Tasks 2–3; §2 params+coupling → Tasks 2, 4; §3 verifier → Task 4; §4 compare → Task 5; §5 provers → Tasks 6–7; §6 surface → Tasks 2–7 + 10 audit; validation tiers 1/2/4/5 → Tasks 2, 8, 9, 10 (tier 3 skipped by decision 2026-08-19 — SANTA sized it at a full-node-jar dependency; live gate is the prover anchor); versioning → Task 10; Task 1 carries the contract.
2. **Placeholders**: none — every step has runnable content or an exact edit description with code.
3. **Type consistency**: `resolveDifficultyParams` returns `{ epochLength, useLastEpochs }` (consumed in Tasks 4–7); `hasValidDifficultyHeaders(proof, epochLength: number, useLastEpochs: number)` (Tasks 4, 5, 8); `PoPowParams` optional fields (Tasks 6, 7); `hasValidConnections(proof, useLastEpochs?)` (Tasks 4, 5).
