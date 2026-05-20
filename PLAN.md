# Phase 2h-e — Test-and-fixture-gen helper consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **CRITICAL — pass to every implementer subagent verbatim:** [OVERRIDES rule #6 — verification commands must pass before claiming any task done; #2 — confidence < 95% on crypto → halt and declare; #5 — root-cause mandate, no band-aids; #7 — re-read files before editing after 10+ messages; #8 — read→edit→read, max 3 edits between verify reads]. Per `[[feedback-subagent-explicit-rules]]`, this is load-bearing.

**Goal:** Consolidate three duplicated helpers — the TS byte-level mutation harness (5 copies across `packages/ergoscript/test/eval/`), the Rust `make_resolver` closure-factory (8 copies under `fixture-gen/src/cmds/ergoscript/eval/`), and the Rust `avl_tree_value_json` JSON encoder (2 copies) — into shared modules. **Refactor only:** zero behavioral change. Test counts invariant at 3481. Mutation kill rates exactly preserved (diff-zero against pre-refactor capture). fixture-gen output byte-identical after each Rust commit.

**Architecture:** New file `packages/ergoscript/test/_helpers/mutation-harness.ts` exports the harness API; 5 consumer test files become thin wrappers selecting region + scenarios + (optionally) custom `isKill`. New file `fixture-gen/src/cmds/ergoscript/eval/savltree_helpers.rs` exports `pub(super) make_resolver()`; 8 consumer modules import. `avl_tree_value_json` promoted to `pub(super)` in `savltree_insert.rs` (adjacent to the existing `option_avl_tree_json`); 2 consumers import. No new functional surface, no new error codes, no new fixtures, no new method handlers.

**Tech Stack:** TypeScript (workspace ESM), vitest (node + jsdom), Rust fixture-gen against pinned sigma-rust `integration/ergots` branch. No new runtime deps. No version bumps.

**Spec:** `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md`. **Spec wins on any interface disagreement.**

---

## File structure

**Created:**

- `packages/ergoscript/test/_helpers/mutation-harness.ts` (new shared TS harness, ~150-200 LOC)
- `fixture-gen/src/cmds/ergoscript/eval/savltree_helpers.rs` (new shared Rust helper module, ~15 LOC)

**Modified:**

- `packages/ergoscript/test/eval/savltree-mutation.test.ts` — strip extracted helpers; import + use shared harness.
- `packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts` — same; pass a **custom `isKill`** that treats same-error-code throw as survival (preserves existing semantics).
- `packages/ergoscript/test/eval/savltree-update-operations.test.ts` — replace the inline mutation block (lines ~220 onward) with shared-harness call; keep the edge-case test suite (lines 1-219) untouched.
- `packages/ergoscript/test/eval/savltree-update-digest.test.ts` — same pattern (edge cases + mutation block in one file; only mutation block changes).
- `packages/ergoscript/test/eval/savltree-insert-or-update.test.ts` — same pattern.
- `fixture-gen/src/cmds/ergoscript/eval/mod.rs` — add `pub mod savltree_helpers;` (alphabetical between `savltree_get_many` and `savltree_insert`).
- `fixture-gen/src/cmds/ergoscript/eval/savltree_insert.rs` — append `pub(super) fn avl_tree_value_json` adjacent to `option_avl_tree_json`.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_contains.rs` — strip local `make_resolver`; add `use super::savltree_helpers::make_resolver;`.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_get.rs` — same.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_get_many.rs` — same.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_insert.rs` — same (in addition to the `avl_tree_value_json` change above).
- `fixture-gen/src/cmds/ergoscript/eval/savltree_insert_or_update.rs` — same.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_partial_success.rs` — same.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_remove.rs` — same.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_update.rs` — same.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_update_operations.rs` — strip local `avl_tree_value_json`; add `use super::savltree_insert::avl_tree_value_json;`.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_update_digest.rs` — same.

**Deleted:**

- None (helpers move, files stay).

**NOT modified (explicit non-scope):**

- `fixture-gen/src/cmds/avltree.rs` — its local `make_resolver` (line 142) is in a different module path; cross-module promotion deferred per spec Non-goal R3.
- `fixture-gen/src/cmds/ergoscript/eval/savltree_partial_success.rs::build_proof_for_ops` and `savltree_insert_or_update.rs::build_proof_for_ops` — only 2 copies, below threshold; deferred per spec.
- `packages/ergoscript/test/_mutation-operators.ts` and `_mutation-allowlist.ts` — Expr-tree-level mutation infra for `parse-mutation.test.ts` / `eval-mutation.test.ts`; orthogonal to byte-level mutation. Out of scope.
- `packages/ergoscript/src/` — no production code changes.

---

## Phase 1 — TS mutation-harness consolidation

### Task 1: Capture baseline kill rates + create harness + migrate `savltree-mutation.test.ts`

**Files:**
- Create: `packages/ergoscript/test/_helpers/mutation-harness.ts`
- Modify: `packages/ergoscript/test/eval/savltree-mutation.test.ts`

- [ ] **Step 1: Capture pre-refactor mutation kill rates**

Run the full ergoscript test suite and capture every `[mutation]` log line to a temp file. This is the load-bearing baseline; the post-refactor output must diff-zero against it.

Run: `node_modules/.bin/vitest run packages/ergoscript 2>&1 | grep '^\[mutation\]' | sort > /tmp/kill-rates-pre.txt`
Expected: file is non-empty (≥ 20 lines, covering all 5 mutation test files). Inspect briefly: each line names a handler / scenario plus a killed/total/rate triple.

- [ ] **Step 2: Verify baseline is non-trivial**

Run: `wc -l /tmp/kill-rates-pre.txt`
Expected: at least 20 lines. If empty or near-empty, halt and investigate — the `console.log` lines may have been removed in a prior commit.

- [ ] **Step 3: Create `packages/ergoscript/test/_helpers/mutation-harness.ts`**

Extract from `savltree-mutation.test.ts:37-218` (the most complete consumer). The harness exposes:

```ts
/**
 * Shared byte-level mutation-testing harness.
 *
 * Consumers (5 test files as of Phase 2h-e) call `runMutationLoop` with a
 * pre-located byte region and an optional custom `isKill`. The harness
 * iterates each XOR pattern × each byte in the region, evaluates the
 * mutated tree, and counts kills against the supplied baseline.
 *
 * Extracted from savltree-mutation.test.ts and sheader-checkpow-mutation.test.ts
 * per Phase 2h-e spec (docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md).
 * Test-only — not part of the published bundle.
 */
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext, EvalError } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import type { ErgoTree, Expr, SValue } from '../../src/mir/types'
import { rehydrateEvalOpts } from './index'

// ─── Inline-Coll[Byte] location ─────────────────────────────────────────────

/**
 * Collect every inline `Const(Coll[Byte], …)` value reachable from `expr`,
 * in depth-first order. Used to identify byte payloads embedded in the body.
 */
export function findInlineByteColls(expr: Expr): Uint8Array[] {
  const out: Uint8Array[] = []
  walk(expr)
  return out

  function walk(node: unknown): void {
    if (node === null || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (
      n['tag'] === 'Const' &&
      typeof n['tpe'] === 'object' &&
      n['tpe'] !== null &&
      (n['tpe'] as Record<string, unknown>)['tag'] === 'SColl' &&
      typeof (n['tpe'] as Record<string, unknown>)['elem'] === 'object' &&
      ((n['tpe'] as Record<string, unknown>)['elem'] as Record<string, unknown>)['tag'] ===
        'SByte' &&
      typeof n['value'] === 'object' &&
      n['value'] !== null &&
      (n['value'] as Record<string, unknown>)['kind'] === 'Coll'
    ) {
      const items = (n['value'] as Record<string, unknown>)['items'] as Array<{ value: number }>
      const bytes = new Uint8Array(items.length)
      for (let i = 0; i < items.length; i++) {
        bytes[i] = items[i]!.value & 0xff
      }
      out.push(bytes)
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) {
        for (const item of v) walk(item)
      } else if (v !== null && typeof v === 'object') {
        walk(v)
      }
    }
  }
}

/**
 * Locate `needle` as a contiguous byte substring of `haystack`; return the
 * starting BYTE offset. Throws if zero or multiple matches (ambiguous).
 */
export function locateBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) throw new Error('locateBytes: empty needle')
  const matches: number[] = []
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    matches.push(i)
    if (matches.length > 1) break
  }
  if (matches.length === 0) {
    throw new Error('locateBytes: needle not found in haystack')
  }
  if (matches.length > 1) {
    throw new Error(`locateBytes: ambiguous (>=2 matches in haystack)`)
  }
  return matches[0]!
}

/**
 * Locate a proof region by index into the inline-Coll[Byte] list.
 * Returns `{ start, end, length }` byte offsets within `treeBytes`.
 */
export function locateInlineCollRegion(
  treeBytes: Uint8Array,
  tree: ErgoTree,
  collIndex: number,
): { start: number; end: number; length: number } {
  const byteColls = findInlineByteColls(tree.body)
  if (byteColls.length <= collIndex) {
    throw new Error(
      `locateInlineCollRegion: expected ≥${collIndex + 1} inline Coll[Byte], got ${byteColls.length}`,
    )
  }
  const bytes = byteColls[collIndex]!
  const start = locateBytes(treeBytes, bytes)
  return { start, end: start + bytes.length, length: bytes.length }
}

// ─── Evaluation outcome + kill criteria ─────────────────────────────────────

export type EvalOutcome =
  | { ok: true; value: SValue }
  | { ok: false; errorCode: string | undefined; errorMessage: string }

/**
 * Wrap `parseTree` + `evaluateWith` in try/catch; surface `EvalError.code`.
 * `optsJson` is parsed via `rehydrateEvalOpts` from `_helpers/index.ts`.
 *
 * For consumers that need to inject a non-JSON context (e.g. SHeader.checkPow
 * which constructs a Header from bytes), pass a custom `makeCtx` callback.
 */
export function evalSafely(
  treeBytes: Uint8Array,
  optsJson: Record<string, unknown>,
  makeCtx?: (opts: Record<string, unknown>) => ReturnType<typeof makeContext>,
): EvalOutcome {
  try {
    const tree = parseTree(treeBytes)
    const ctx = makeCtx ? makeCtx(optsJson) : makeContext(rehydrateEvalOpts(optsJson))
    const value = evaluateWith(tree, ctx)
    return { ok: true, value }
  } catch (e) {
    if (e instanceof EvalError) {
      return { ok: false, errorCode: e.code, errorMessage: e.message }
    }
    if (e instanceof Error) {
      return { ok: false, errorCode: undefined, errorMessage: e.message }
    }
    return { ok: false, errorCode: undefined, errorMessage: String(e) }
  }
}

/** JSON-stringify-based SValue deep equality, BigInt-safe. */
export function svalueEqual(a: SValue, b: SValue): boolean {
  const replacer = (_k: string, v: unknown): unknown =>
    typeof v === 'bigint' ? `__bigint__${v.toString()}__` : v
  return JSON.stringify(a, replacer) === JSON.stringify(b, replacer)
}

/**
 * The "throw-or-diverge" kill rule (used by `savltree-mutation.test.ts` and
 * the 3 inline savltree-* consumers):
 *   - both threw → not a kill
 *   - one threw → kill
 *   - both ok → kill iff values differ
 */
export function isKillThrowOrDiverge(baseline: EvalOutcome, mutated: EvalOutcome): boolean {
  if (!baseline.ok && !mutated.ok) return false
  if (!baseline.ok && mutated.ok) return true
  if (baseline.ok && !mutated.ok) return true
  if (!baseline.ok || !mutated.ok) return false // narrowing
  return !svalueEqual(baseline.value, mutated.value)
}

/**
 * The "any-change" kill rule (used by `sheader-checkpow-mutation.test.ts`):
 *   - both threw AND error codes match → not a kill
 *   - both threw with different codes → kill (semantically different failure)
 *   - one threw → kill
 *   - both ok → kill iff values differ
 *
 * The difference vs `isKillThrowOrDiverge` is the both-threw branch:
 * sheader.checkPow wants finer-grained kill detection because a byte flip
 * that changes the throw site (e.g. wire-parse error → eval error) counts
 * as a kill there.
 */
export function isKillStrict(baseline: EvalOutcome, mutated: EvalOutcome): boolean {
  if (!baseline.ok && !mutated.ok) return baseline.errorCode !== mutated.errorCode
  if (!baseline.ok || !mutated.ok) return true
  return !svalueEqual(baseline.value, mutated.value)
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export const XOR_PATTERNS_STANDARD = [0xff, 0x01, 0x80]
export const DEFAULT_KILL_THRESHOLD = 0.9

export interface MutationRunConfig {
  treeBytes: Uint8Array
  region: { start: number; end: number }
  optsJson: Record<string, unknown>
  xorPatterns?: number[]
  isKill?: (baseline: EvalOutcome, mutated: EvalOutcome) => boolean
  makeCtx?: (opts: Record<string, unknown>) => ReturnType<typeof makeContext>
}

export interface MutationRunResult {
  killed: number
  total: number
  rate: number
  survived: Array<{ offset: number; xor: number; outcome: EvalOutcome }>
}

/**
 * Execute the mutation loop and return kill counts + the list of survived
 * mutations (for offline analysis). Caller asserts against a threshold.
 *
 * Logging: the runner does NOT emit `console.log` lines itself — the caller
 * is responsible for logging `[mutation] <label>: killed=X total=Y rate=Z`
 * using the returned counts (preserves the existing log format across all
 * 5 consumers; format-stability is required for the baseline diff at Task 8).
 */
export function runMutationLoop(config: MutationRunConfig): MutationRunResult {
  const xorPatterns = config.xorPatterns ?? XOR_PATTERNS_STANDARD
  const isKill = config.isKill ?? isKillThrowOrDiverge
  const baseline = evalSafely(config.treeBytes, config.optsJson, config.makeCtx)
  let killed = 0
  let total = 0
  const survived: Array<{ offset: number; xor: number; outcome: EvalOutcome }> = []
  for (let i = config.region.start; i < config.region.end; i++) {
    for (const xor of xorPatterns) {
      total++
      const mutated = new Uint8Array(config.treeBytes)
      mutated[i] = (mutated[i]! ^ xor) & 0xff
      const outcome = evalSafely(mutated, config.optsJson, config.makeCtx)
      if (isKill(baseline, outcome)) {
        killed++
      } else {
        survived.push({ offset: i, xor, outcome })
      }
    }
  }
  return { killed, total, rate: total === 0 ? 1 : killed / total, survived }
}
```

- [ ] **Step 4: Refactor `savltree-mutation.test.ts` to use the harness**

The file currently has ~218 LOC of inline helper code (lines 37-218) + a ~120 LOC runner (lines 220-339). Replace the helpers with an import from the harness, and rewrite the runner to delegate to `runMutationLoop`. Keep the `HANDLERS` config array and the per-handler scenario filter intact — that's the consumer-specific surface.

The refactored file should be approximately:

```ts
/**
 * Layer C3.a — Byte-level mutation testing for the 6 Tier-2 SAvlTree
 * verification op handlers.
 *
 * [...keep the existing doc block prose explaining the test strategy...]
 *
 * Phase 2h-b Phase G; harness extracted to test/_helpers/mutation-harness.ts
 * in Phase 2h-e (2026-05-20).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { hexToBytes } from '../_helpers'
import {
  locateInlineCollRegion,
  runMutationLoop,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code?: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, '..', 'fixtures', 'eval')

function loadFixture(file: string): FixtureFile {
  return JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8')) as FixtureFile
}

const HANDLERS: Array<{
  name: string
  file: string
  collIndex: 0 | 1   // which inline Coll[Byte] is the proof; renamed from whichColl
  successEntries: string[]
}> = [
  {
    name: 'contains',
    file: 'savltree-contains.json',
    collIndex: 1,
    successEntries: ['contains_key_present', 'contains_key_absent', 'contains_bytes_key_32'],
  },
  {
    name: 'get',
    file: 'savltree-get.json',
    collIndex: 1,
    successEntries: ['get_key_present', 'get_key_absent', 'get_bytes_key_32'],
  },
  {
    name: 'getMany',
    file: 'savltree-get-many.json',
    collIndex: 0,
    successEntries: ['get_many_all_present', 'get_many_mixed_2_of_3', 'get_many_all_absent'],
  },
  {
    name: 'insert',
    file: 'savltree-insert.json',
    collIndex: 0,
    successEntries: ['insert_success_1_entry', 'insert_success_3_entries'],
  },
  {
    name: 'update',
    file: 'savltree-update.json',
    collIndex: 0,
    successEntries: ['update_success_1_entry', 'update_success_3_entries'],
  },
  {
    name: 'remove',
    file: 'savltree-remove.json',
    collIndex: 0,
    successEntries: ['remove_success_1_key', 'remove_success_3_keys'],
  },
]

describe('SAvlTree mutation testing (Layer C3.a)', () => {
  for (const handler of HANDLERS) {
    describe(`SAvlTree.${handler.name}`, () => {
      const fixture = loadFixture(handler.file)
      const entries = fixture.entries.filter((e) => handler.successEntries.includes(e.name))
      let aggKilled = 0
      let aggTotal = 0

      for (const entry of entries) {
        it(`${entry.name}: ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on proof-byte mutations`, () => {
          const treeBytes = hexToBytes(entry.tree_bytes_hex)
          const tree = parseTree(treeBytes)
          const region = locateInlineCollRegion(treeBytes, tree, handler.collIndex)
          const result = runMutationLoop({
            treeBytes,
            region: { start: region.start, end: region.end },
            optsJson: entry.opts_json,
          })
          // eslint-disable-next-line no-console
          console.log(
            `[mutation] ${handler.name}.${entry.name}: killed=${result.killed} ` +
              `total=${result.total} rate=${result.rate.toFixed(3)} ` +
              `proofLen=${region.length} proofStart=${region.start}`,
          )
          aggKilled += result.killed
          aggTotal += result.total
          expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
        })
      }

      it(`SAvlTree.${handler.name}: aggregate kill rate ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
        const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
        // eslint-disable-next-line no-console
        console.log(
          `[mutation] AGG ${handler.name}: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
        )
        expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
      })
    })
  }
})
```

Critical: **preserve the `console.log` line format exactly** — the baseline diff at Task 8 is byte-exact. Same field order, same precision (`toFixed(3)`), same separators.

- [ ] **Step 5: Run typecheck + tests + verify kill-rate parity for this file**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

Run: `node_modules/.bin/vitest run packages/ergoscript/test/eval/savltree-mutation.test.ts 2>&1 | grep '^\[mutation\]' | sort > /tmp/kill-rates-task1.txt`
Expected: file populated.

Run: `grep -E '\[mutation\] (contains|get|getMany|insert|update|remove)\.|AGG' /tmp/kill-rates-pre.txt | sort > /tmp/kill-rates-pre-savltree.txt && diff /tmp/kill-rates-pre-savltree.txt /tmp/kill-rates-task1.txt`
Expected: EMPTY. If non-empty, halt — kill rate has drifted. Investigate root cause (harness logic diverged from extracted source).

- [ ] **Step 6: Commit**

```bash
git add packages/ergoscript/test/_helpers/mutation-harness.ts \
        packages/ergoscript/test/eval/savltree-mutation.test.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): extract byte-level mutation harness to test/_helpers

Phase 2h-e Task 1. Creates test/_helpers/mutation-harness.ts with the
shared findInlineByteColls / locateBytes / locateInlineCollRegion /
evalSafely / svalueEqual / isKillThrowOrDiverge / isKillStrict /
runMutationLoop surface previously inlined in 5 consumer test files.

Migrates savltree-mutation.test.ts (the largest consumer, 339 LOC) as
the first to use the shared harness. Strips ~180 LOC of duplicate
helpers; kill rates verified diff-zero against pre-refactor baseline
captured in /tmp/kill-rates-pre.txt.

The harness exposes two pre-baked isKill rules:
 - isKillThrowOrDiverge (default; both-threw → not a kill)
 - isKillStrict (both-threw → kill iff error codes differ;
   used by sheader-checkpow-mutation.test.ts at Task 2)

Spec: docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2: Migrate `sheader-checkpow-mutation.test.ts` (custom `isKill` + custom `makeCtx`)

**Files:**
- Modify: `packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts`

This consumer is the trickier one: it uses a STRICTER `isKill` (both-threw with different error codes = kill) AND a custom context (constructs a Header from raw bytes rather than from `rehydrateEvalOpts`).

- [ ] **Step 1: Refactor `sheader-checkpow-mutation.test.ts` to use the harness**

The file is 166 LOC, single `it()` block. Replace the local `XOR_PATTERNS` / `EvalOutcome` / `evalSafely` / `isKill` with a `runMutationLoop` call that passes a custom `isKill: isKillStrict` and a custom `makeCtx` that builds the Header.

Region to mutate: the entire `exprBytes` (all 13 bytes), since the fixture mutates every offset. So instead of `locateInlineCollRegion`, this consumer passes a region of `{ start: 0, end: treeBytes.length }`.

```ts
/**
 * Mutation testing for SHeader.checkPow oracle fixture — phase 2h-c.2.
 *
 * [...preserve the existing doc block prose, byte map, tolerance notes...]
 *
 * Harness extracted to test/_helpers/mutation-harness.ts in Phase 2h-e.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hexToBytes } from '../_helpers'
import {
  runMutationLoop,
  isKillStrict,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'
import { makeContext } from '../../src/eval/eval-context'
import { ByteReader, parseHeader } from '@ergots/scorex'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/sheader-checkpow.json')

interface CheckPowFixture {
  name: string
  exprBytes: string
  headerHexBytes: string
  headerVersion: number
  headerHeight: number
  expectedValue: boolean
  expectedJitCost: number
  v1HeaderHexBytes: string
  v1HeaderVersion: number
  v1HeaderHeight: number
}

const fixture: CheckPowFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SHeader.checkPow mutation testing (phase 2h-c.2)', () => {
  it(`≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate across all byte offsets`, () => {
    const originalBytes = hexToBytes(fixture.exprBytes)
    const headerBytes = hexToBytes(fixture.headerHexBytes)
    const header = parseHeader(new ByteReader(headerBytes))

    const result = runMutationLoop({
      treeBytes: originalBytes,
      region: { start: 0, end: originalBytes.length },
      optsJson: {},
      isKill: isKillStrict,
      makeCtx: () => makeContext({ treeVersion: 3, headers: [header] }),
    })

    // eslint-disable-next-line no-console
    console.log(
      `[mutation] SHeader.checkPow: killed=${result.killed} survived=${result.total - result.killed} total=${result.total}` +
        ` rate=${(result.rate * 100).toFixed(1)}%`,
    )

    if (result.survived.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[mutation] Survived mutations (tolerated):`)
      for (const s of result.survived) {
        const origByte = originalBytes[s.offset]!
        const mutByte = (origByte ^ s.xor) & 0xff
        // eslint-disable-next-line no-console
        console.log(
          `  offset=${s.offset} orig=0x${origByte.toString(16).padStart(2, '0')} ` +
            `xor=0x${s.xor.toString(16).padStart(2, '0')} ` +
            `mut=0x${mutByte.toString(16).padStart(2, '0')} ` +
            `outcome=${s.outcome.ok ? `ok(${JSON.stringify(s.outcome.value)})` : `err(${s.outcome.errorCode})`}`,
        )
      }
    }

    expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
```

Critical: preserve the `rate=${(rate * 100).toFixed(1)}%` format (1-decimal-place + percent sign) — this file uses a *different* log format from `savltree-mutation.test.ts` (which uses `rate=${result.rate.toFixed(3)}`). Both formats are kept exactly as-is to preserve the baseline-diff invariant.

- [ ] **Step 2: Run typecheck + targeted test + kill-rate diff**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

Run: `node_modules/.bin/vitest run packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts 2>&1 | grep '^\[mutation\]'`
Expected: at least one `[mutation] SHeader.checkPow:` line. Optionally diff against the pre-refactor capture for this specific consumer:

Run: `grep 'SHeader.checkPow' /tmp/kill-rates-pre.txt`
Compare visually to the new output. Same `killed` / `survived` / `total` / `rate` values expected.

- [ ] **Step 3: Commit**

```bash
git add packages/ergoscript/test/eval/sheader-checkpow-mutation.test.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): migrate sheader-checkpow mutation test to shared harness

Phase 2h-e Task 2. Strips ~90 LOC of inlined harness from
sheader-checkpow-mutation.test.ts; replaces with a runMutationLoop call
passing the strict isKill rule (both-threw with different codes = kill,
matching original semantics) and a custom makeCtx that constructs the
Header from fixture bytes.

Kill rate verified equal pre/post by comparing the [mutation] log line
against /tmp/kill-rates-pre.txt.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: Migrate `savltree-update-operations.test.ts` mutation block

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-update-operations.test.ts`

This file has BOTH edge-case tests (lines 1-~220) AND a mutation block (lines ~220 onward). Only the mutation block is migrated; edge-case tests untouched.

- [ ] **Step 1: Re-read the file to confirm the boundary**

Run: `grep -n "describe.*mutation\|XOR_PATTERNS\|function evalSafely\|function isKill" packages/ergoscript/test/eval/savltree-update-operations.test.ts`
Note the line numbers. The mutation block starts at the `describe('SAvlTree.updateOperations — mutation testing'` line.

- [ ] **Step 2: Refactor only the mutation block**

Replace the inline helpers + runner from the mutation `describe` block onward with a thin harness call. Keep the file's first `describe('SAvlTree.updateOperations — edge cases')` block completely intact.

Pattern (adapt to the actual file shape — the file may have a 1-arg mutation rather than a proof-region mutation; if it mutates a different region, use a custom `region` calculation):

```ts
// At the top of the file, add to existing imports:
import {
  locateInlineCollRegion,
  runMutationLoop,
  DEFAULT_KILL_THRESHOLD,
} from '../_helpers/mutation-harness'

// Delete the inline XOR_PATTERNS / THRESHOLD / EvalOutcome / evalSafely /
// svalueEqual / isKill / findInlineByteColls / locate functions that
// appear between the edge-case describe and the mutation describe.

// Replace the mutation describe with:
describe('SAvlTree.updateOperations — mutation testing', () => {
  // [...preserve scenario list / collIndex selection / per-entry loop...]
  // Each `it` invokes runMutationLoop with the located region and asserts
  // result.rate >= DEFAULT_KILL_THRESHOLD; logs the same console.log line
  // as before.
})
```

**Implementer note:** read the actual file in full at task start. The exact migration shape depends on whether the file mutates the proof bytes (use `locateInlineCollRegion`) or the entire tree (use `{ start: 0, end: treeBytes.length }`). The handler `updateOperations` takes a Byte arg + AvlTree receiver, no proof bytes — likely mutates the full tree. Inspect to decide.

- [ ] **Step 3: Run typecheck + targeted test + kill-rate diff**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

Run: `node_modules/.bin/vitest run packages/ergoscript/test/eval/savltree-update-operations.test.ts 2>&1 | grep '^\[mutation\]'`
Expected: same kill rate as the corresponding lines in `/tmp/kill-rates-pre.txt`.

Run: `grep 'updateOperations' /tmp/kill-rates-pre.txt`
Compare visually.

- [ ] **Step 4: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-update-operations.test.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): migrate savltree-update-operations mutation block to shared harness

Phase 2h-e Task 3. Edge-case test suite (describe block 1) unchanged;
mutation block (describe block 2) now uses runMutationLoop. Kill rate
verified equal pre/post against /tmp/kill-rates-pre.txt.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4: Migrate `savltree-update-digest.test.ts` + `savltree-insert-or-update.test.ts` mutation blocks

**Files:**
- Modify: `packages/ergoscript/test/eval/savltree-update-digest.test.ts`
- Modify: `packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`

Same migration pattern as Task 3. Two files in one commit because they share the structural shape (edge-cases block + mutation block in one file) and the mutation logic is nearly identical to Task 3 — the only variance is the specific scenarios and the optional `collIndex` choice.

- [ ] **Step 1: Re-read both files to confirm the mutation-block boundary**

Run: `grep -n "describe.*mutation\|XOR_PATTERNS" packages/ergoscript/test/eval/savltree-update-digest.test.ts packages/ergoscript/test/eval/savltree-insert-or-update.test.ts`
Note the line numbers per file.

- [ ] **Step 2: Refactor mutation blocks in both files**

For each file, apply the Task 3 pattern: add imports from the harness, delete inline helpers, replace the mutation `describe` body to use `runMutationLoop`. Preserve the edge-case blocks unchanged. Preserve console.log format exactly.

Special note: `savltree-insert-or-update.test.ts` mutates a tree with V3-gated dispatcher behavior. The fixture's `opts_json` should already encode `treeVersion: 3` per the 2h-d convention; verify at refactor time that `rehydrateEvalOpts` parses this correctly (it does — see `_helpers/index.ts:226-232`).

- [ ] **Step 3: Run typecheck + both targeted tests + kill-rate diff**

Run: `npx tsc --noEmit -p packages/ergoscript/tsconfig.json`
Expected: CLEAN.

Run:
```bash
node_modules/.bin/vitest run \
  packages/ergoscript/test/eval/savltree-update-digest.test.ts \
  packages/ergoscript/test/eval/savltree-insert-or-update.test.ts 2>&1 | \
  grep '^\[mutation\]'
```
Expected: kill rates match `/tmp/kill-rates-pre.txt` lines for `updateDigest` and `insertOrUpdate`.

Run: `grep 'updateDigest\|insertOrUpdate' /tmp/kill-rates-pre.txt`
Compare visually.

- [ ] **Step 4: Final TS-side kill-rate parity check (all 5 consumers)**

Run: `node_modules/.bin/vitest run packages/ergoscript 2>&1 | grep '^\[mutation\]' | sort > /tmp/kill-rates-post-phase1.txt && diff /tmp/kill-rates-pre.txt /tmp/kill-rates-post-phase1.txt`
Expected: EMPTY. If non-empty, halt — Phase 1 has drifted somewhere.

- [ ] **Step 5: Commit**

```bash
git add packages/ergoscript/test/eval/savltree-update-digest.test.ts \
        packages/ergoscript/test/eval/savltree-insert-or-update.test.ts
git commit -m "$(cat <<'EOF'
refactor(ergoscript): migrate update-digest + insert-or-update mutation blocks

Phase 2h-e Task 4. Both files keep their edge-case describe blocks
unchanged; mutation describe blocks now call runMutationLoop. Phase 1
end-of-phase verification: full-suite mutation log diff against
/tmp/kill-rates-pre.txt is empty. Phase 1 (TS mutation-harness
consolidation) complete; 5 consumers migrated, ~400-700 LOC removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Rust `make_resolver` consolidation

### Task 5: Create `savltree_helpers.rs` + register module

**Files:**
- Create: `fixture-gen/src/cmds/ergoscript/eval/savltree_helpers.rs`
- Modify: `fixture-gen/src/cmds/ergoscript/eval/mod.rs`

- [ ] **Step 1: Create `savltree_helpers.rs`**

```rust
//! Shared helpers for the SAvlTree fixture-gen modules.
//!
//! Consolidates the `make_resolver` closure-factory previously duplicated
//! across 8 sibling modules (savltree_insert / update / get / get_many /
//! contains / remove / partial_success / insert_or_update). Promoted in
//! Phase 2h-e per
//! `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md`.

use std::sync::Arc;

use ergo_avltree_rust::batch_node::{Node, NodeHeader};
use ergo_avltree_rust::operation::Digest32;

/// Factory for the `BatchAVLProver`'s node-resolver. Returns a closure that
/// produces `Node::LabelOnly` from any 32-byte digest input.
pub(super) fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}
```

- [ ] **Step 2: Register module in `mod.rs`**

In `fixture-gen/src/cmds/ergoscript/eval/mod.rs`, insert `pub mod savltree_helpers;` in the alphabetical position. The current sequence has `savltree_get_many` at line 27 and `savltree_insert` at line 28; `savltree_helpers` goes between them.

Edit the file: between the existing `pub mod savltree_get_many;` line and `pub mod savltree_insert;` line, add:

```rust
pub mod savltree_helpers;
```

- [ ] **Step 3: Verify build**

Run: `cd fixture-gen && cargo build --release`
Expected: CLEAN, zero new warnings. (The new helper isn't called yet — Rust may warn `dead_code`. If so, that's tolerated until Task 6 wires up the consumers.)

If the `dead_code` warning would fail CI, gate the helper with `#[allow(dead_code)]` temporarily and remove the attribute in Task 6's commit. Otherwise leave clean.

- [ ] **Step 4: Verify determinism (no fixture-gen output change)**

Run: `cd fixture-gen && cargo run --release && git diff --exit-code packages/`
Expected: EMPTY. The new helper hasn't been consumed yet, so fixture output is unchanged from pre-task.

- [ ] **Step 5: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/savltree_helpers.rs \
        fixture-gen/src/cmds/ergoscript/eval/mod.rs
git commit -m "$(cat <<'EOF'
refactor(fixture-gen): create savltree_helpers.rs with shared make_resolver

Phase 2h-e Task 5. Introduces a new module under
fixture-gen/src/cmds/ergoscript/eval/ to host the make_resolver
closure-factory currently duplicated across 8 sibling savltree_*.rs
modules. Task 6 migrates the 8 consumers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6: Migrate 8 `make_resolver` consumers

**Files (all under `fixture-gen/src/cmds/ergoscript/eval/`):**
- Modify: `savltree_contains.rs`, `savltree_get.rs`, `savltree_get_many.rs`, `savltree_insert.rs`, `savltree_insert_or_update.rs`, `savltree_partial_success.rs`, `savltree_remove.rs`, `savltree_update.rs`

- [ ] **Step 1: For each of the 8 files, replace local `fn make_resolver` with an import**

In each file, find the block:

```rust
fn make_resolver() -> Arc<dyn Fn(&Digest32) -> Node + Send + Sync> {
    Arc::new(|digest: &Digest32| Node::LabelOnly(NodeHeader::new(Some(*digest), None)))
}
```

Delete it.

If the file's existing `use` block contains imports that are now only used by the deleted function, remove them. The candidates to check after deletion:

- `use std::sync::Arc;` — may still be used elsewhere; check by grep before removing.
- `use ergo_avltree_rust::batch_node::{Node, NodeHeader};` or partial of (e.g., `NodeHeader` only used by `make_resolver`) — likely safe to remove the `NodeHeader` import; keep `Node` if used elsewhere.
- `use ergo_avltree_rust::operation::Digest32;` — likely still used elsewhere (`Digest32` is used by `make_resolver` argument type but also frequently as a return-type annotation in fixture builders); check by grep.

Add to the file's existing `use super::...` block (or create one near other module-local imports):

```rust
use super::savltree_helpers::make_resolver;
```

**Per-file note for `savltree_insert.rs`:** this file is also modified in Task 7 (to add `pub(super) fn avl_tree_value_json`). Keep Task 6 and Task 7 in separate commits — refactor + new symbol promotion are different concerns; bisect-friendly to keep them separate.

- [ ] **Step 2: Verify build**

Run: `cd fixture-gen && cargo build --release`
Expected: CLEAN, zero warnings (including no `unused_imports`).

If `cargo build` reports `unused_imports`, find the responsible file and prune the unused `use` line(s). Re-run.

- [ ] **Step 3: Verify fixture determinism — byte-identical output**

Run:
```bash
cd fixture-gen && cargo run --release && \
git diff --exit-code packages/
```
Expected: EMPTY. If non-empty, halt — fixture-gen output has drifted. This would indicate the new shared `make_resolver` is producing different node-resolver behavior than the inlined copies. Investigate (likely a subtle Rust-pattern difference: the closure capture or NodeHeader argument).

Re-run a second time to confirm determinism (a re-run should also produce no diff):

Run: `cd fixture-gen && cargo run --release && git diff --exit-code packages/`
Expected: EMPTY (still).

- [ ] **Step 4: Verify no residual `fn make_resolver` in the 8 consumer files**

Run: `grep -n "fn make_resolver" fixture-gen/src/cmds/ergoscript/eval/savltree_*.rs`
Expected: only `fixture-gen/src/cmds/ergoscript/eval/savltree_helpers.rs:N:pub(super) fn make_resolver(…)` appears. The 8 consumer files should have zero matches.

(`fixture-gen/src/cmds/avltree.rs:142` is intentionally NOT consolidated per spec; that file remains with its local `fn make_resolver`. Confirm:
Run: `grep -n "fn make_resolver" fixture-gen/src/cmds/avltree.rs`
Expected: 1 match at line 142. Unchanged.)

- [ ] **Step 5: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/savltree_contains.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_get.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_get_many.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_insert.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_insert_or_update.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_partial_success.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_remove.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_update.rs
git commit -m "$(cat <<'EOF'
refactor(fixture-gen): migrate 8 make_resolver consumers to shared helper

Phase 2h-e Task 6. Replaces 8 inlined fn make_resolver definitions with
`use super::savltree_helpers::make_resolver;`. Net diff: -8 function
definitions, +8 import lines. Fixture-gen output verified byte-identical
pre/post via cargo run + git diff --exit-code (twice for determinism).

The cmds/avltree.rs::make_resolver copy stays local — different module
path; consolidation deferred per Phase 2h-e spec Non-goal R3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Rust `avl_tree_value_json` consolidation

### Task 7: Promote `avl_tree_value_json` to `pub(super)` in `savltree_insert.rs`; migrate 2 consumers

**Files:**
- Modify: `fixture-gen/src/cmds/ergoscript/eval/savltree_insert.rs` (add `pub(super) fn avl_tree_value_json`)
- Modify: `fixture-gen/src/cmds/ergoscript/eval/savltree_update_operations.rs` (delete local; add import)
- Modify: `fixture-gen/src/cmds/ergoscript/eval/savltree_update_digest.rs` (delete local; add import)

- [ ] **Step 1: Append `pub(super) fn avl_tree_value_json` to `savltree_insert.rs`**

Locate the existing `option_avl_tree_json` block at `savltree_insert.rs:81-100`. Append immediately after (around line 101) the new function:

```rust
/// Encode a bare `AvlTree` Value as the TS SValue AvlTree variant:
///   `{ "kind": "AvlTree", "value": <avl_tree_data> }`
/// matching `hydrateSValue` at `packages/ergoscript/test/_helpers/index.ts:94`.
///
/// Promoted to `pub(super)` in Phase 2h-e to deduplicate copies previously
/// inlined in `savltree_update_operations.rs` and `savltree_update_digest.rs`.
pub(super) fn avl_tree_value_json(value: &Value) -> anyhow::Result<JsonValue> {
    match value {
        Value::AvlTree(avl) => Ok(json!({
            "kind": "AvlTree",
            "value": avl_tree_data_to_json(avl),
        })),
        other => anyhow::bail!("expected Value::AvlTree, got {:?}", other),
    }
}
```

The module-name-prefix on the error message (currently `"savltree_update_operations: expected …"` and `"savltree_update_digest: expected …"`) is genericized to `"expected Value::AvlTree, got {:?}"`. `anyhow::bail!` is debug-only; the prefix has low load-bearing value, and a generic message is cleaner across both consumers.

- [ ] **Step 2: Delete local copies in `savltree_update_operations.rs` and `savltree_update_digest.rs`**

In `savltree_update_operations.rs`, locate the existing `fn avl_tree_value_json` at line 49 (verified pre-task by Spec Refactor 3 census). Delete the function. Add to the existing import block (alongside the existing `use super::savltree_insert::avl_tree_data_to_json;`):

```rust
use super::savltree_insert::{avl_tree_data_to_json, avl_tree_value_json};
```

(Consolidating the two imports into one `use` line.)

Same for `savltree_update_digest.rs`: locate `fn avl_tree_value_json` at line 92, delete, update the existing `use super::savltree_insert::…` line to include `avl_tree_value_json`.

- [ ] **Step 3: Verify build**

Run: `cd fixture-gen && cargo build --release`
Expected: CLEAN. No `unused_imports`, no `dead_code`, no `private_in_public` errors (Rust's `pub(super)` exports correctly between sibling modules).

- [ ] **Step 4: Verify fixture determinism**

Run: `cd fixture-gen && cargo run --release && git diff --exit-code packages/`
Expected: EMPTY. If non-empty, halt — the genericized error message wasn't itself encoded in the JSON output (it's a Rust-side throw message), so this should be clean. A diff would indicate an unrelated drift.

Run a second time:

Run: `cd fixture-gen && cargo run --release && git diff --exit-code packages/`
Expected: EMPTY (still — determinism confirmed).

- [ ] **Step 5: Verify no residual `fn avl_tree_value_json` in consumers**

Run: `grep -rn "fn avl_tree_value_json" fixture-gen/src/cmds/`
Expected: 1 match only at `fixture-gen/src/cmds/ergoscript/eval/savltree_insert.rs:N:pub(super) fn avl_tree_value_json(…)`. Zero in the 2 update consumers.

- [ ] **Step 6: Commit**

```bash
git add fixture-gen/src/cmds/ergoscript/eval/savltree_insert.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_update_operations.rs \
        fixture-gen/src/cmds/ergoscript/eval/savltree_update_digest.rs
git commit -m "$(cat <<'EOF'
refactor(fixture-gen): promote avl_tree_value_json to pub(super) sibling

Phase 2h-e Task 7. Mirrors the existing option_avl_tree_json pattern
in savltree_insert.rs: one canonical pub(super) function reused by
sibling modules. Deletes 2 local copies in update_operations.rs and
update_digest.rs. Error message prefix genericized (no per-module
prefix); anyhow::bail! is debug-only so the change is cosmetic.

Fixture-gen output verified byte-identical pre/post via cargo run +
git diff --exit-code (twice for determinism).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Final verification + doc refresh

### Task 8: End-of-phase verification — full-suite + cross-runtime + determinism + kill-rate diff

**Files:** none modified (this is a verification step; doc refresh splits to Task 9 if needed).

- [ ] **Step 1: Cross-package typecheck**

Run each in parallel (separate Bash invocations):

```bash
npx tsc --noEmit -p packages/scorex/tsconfig.json
npx tsc --noEmit -p packages/nipopow/tsconfig.json
npx tsc --noEmit -p packages/avltree/tsconfig.json
npx tsc --noEmit -p packages/ergoscript/tsconfig.json
```

Expected: all CLEAN.

- [ ] **Step 2: Full node-mode test suite (expect 3481)**

Run: `node_modules/.bin/vitest run packages/`
Expected: 3481 tests pass. Per-package breakdown (verified pre-phase): scorex 177, nipopow 245, avltree 156, ergoscript 2903. Any deviation = regression.

- [ ] **Step 3: Cross-runtime jsdom verification (4 packages)**

```bash
cd packages/scorex && npx vitest run --config vitest.browser.config.ts && cd ../..
cd packages/nipopow && npx vitest run --config vitest.browser.config.ts && cd ../..
cd packages/avltree && npx vitest run --config vitest.browser.config.ts && cd ../..
cd packages/ergoscript && npx vitest run --config vitest.browser.config.ts && cd ../..
```

Expected: 177 / 245 / 156 / 2903 pass per package under jsdom.

- [ ] **Step 4: Final mutation kill-rate parity**

Run: `node_modules/.bin/vitest run packages/ergoscript 2>&1 | grep '^\[mutation\]' | sort > /tmp/kill-rates-post.txt && diff /tmp/kill-rates-pre.txt /tmp/kill-rates-post.txt`
Expected: EMPTY. If non-empty, **halt** — kill rates have drifted since Phase 1 completed. Investigate (would indicate the 3 inline-block migrations in Phase 1 Tasks 3-4 didn't fully preserve semantics).

- [ ] **Step 5: Fixture-gen determinism (final)**

```bash
cd fixture-gen && cargo build --release
cd fixture-gen && cargo run --release
git diff --exit-code packages/
cd fixture-gen && cargo run --release    # second run for determinism
git diff --exit-code packages/
```

Expected: CLEAN throughout. If first `git diff --exit-code` fails, fixture-gen has drifted in Phase 2 or 3. Investigate. If second `git diff --exit-code` fails (after first succeeded), it's a determinism regression in shared helpers.

- [ ] **Step 6: Working tree status**

Run: `git status`
Expected: clean modulo gitignored `audit20260519/`.

- [ ] **Step 7: Commit log review**

Run: `git log --oneline origin/master..HEAD`
Expected: 7 commits (T1-T7), each with the `Phase 2h-e Task N` prefix in the body.

### Task 9 (optional): Refresh `SESSION_CONTEXT.md`

**Files:**
- Modify: `SESSION_CONTEXT.md` — close out the deferred items from the 2h-d session.

This task is only needed if the user wants to update local-only context. `SESSION_CONTEXT.md` is gitignored (per `CLAUDE.md` line 6: "This file is local-only (gitignored)"). The user may prefer to write SESSION_CONTEXT manually after seeing the phase land.

- [ ] **Step 1: Update SESSION_CONTEXT.md "Items intentionally deferred from this phase" section**

Mark these as ✅ closed:

- "Mutation-harness helper consolidation — now at 5 copies across …" → closed by Phase 2h-e Task 1-4.
- "Rust fixture-gen `avl_tree_value_json` consolidation — 4 copies across …" → closed by Phase 2h-e Task 7. (Census update: actually 2 copies, not 4.)
- "Rust fixture-gen `make_resolver` + `build_proof_for_ops` consolidation — 5+ copies." → `make_resolver` closed by Phase 2h-e Task 5-6 (8 copies consolidated; 9th in `cmds/avltree.rs` deferred). `build_proof_for_ops` still open (2 copies; below threshold).

- [ ] **Step 2: Append a new "Phase 2h-e summary" section** if SESSION_CONTEXT.md typically tracks per-phase summaries (it does per the 2h-d session — see lines 10-67).

(Skip if user prefers to author SESSION_CONTEXT manually. The file is gitignored anyway, so this step is local-only.)

- [ ] **Step 3: Do NOT commit `SESSION_CONTEXT.md`** — it's gitignored. If `git status` shows it as modified, that's fine; just don't `git add` it.

### Task 10 (optional): Refresh `CLAUDE.md` and/or `facts/*.md` if needed

**Files:**
- Modify: `CLAUDE.md` — only if the gotcha list around mutation-harness duplication should be updated.
- Modify: `facts/*.md` — likely no change needed; Phase 2h-e doesn't touch public-surface counts.

- [ ] **Step 1: Re-read `CLAUDE.md` § Common gotchas to see if any deferred-item references need closing**

Run: `grep -n "mutation-harness\|make_resolver\|avl_tree_value_json" CLAUDE.md`
Expected: probably 0 matches (gotchas tend to be byte-format pitfalls, not refactor todos). If matches found, close out the relevant lines.

- [ ] **Step 2: Re-read `facts/ergoscript-eval.md` Coverage table**

Counts unchanged this phase. No refresh needed.

- [ ] **Step 3: If any docs touched, commit**

```bash
git add CLAUDE.md   # or whichever facts files were touched
git commit -m "$(cat <<'EOF'
docs: refresh deferred-items references post-phase-2h-e

Phase 2h-e Task 10. Mutation-harness consolidation, make_resolver
consolidation, and avl_tree_value_json consolidation all closed;
remove the corresponding deferred-items breadcrumbs from CLAUDE.md
and the relevant facts/*.md files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(If no docs need touching, skip this step.)

---

## End-of-phase invariants (must all hold after Task 8)

- ✅ Test count: 3481 across all 4 packages under both `node` and `jsdom`.
- ✅ Mutation kill rates: diff-zero against pre-refactor baseline (`/tmp/kill-rates-pre.txt`).
- ✅ Typecheck: clean per-package.
- ✅ Fixture-gen determinism: byte-identical output on second `cargo run`.
- ✅ Working tree: clean modulo gitignored `audit20260519/`.
- ✅ Commit count: 7 (or 8-9 with optional Task 9-10 doc refresh).
- ✅ Net LOC delta: −600 to −900 across the codebase (test/_helpers grows, 5 test files + 8 Rust modules + 2 update modules shrink, no production code change).
- ✅ `packages/*/src/` unchanged across the entire phase.
- ✅ `facts/*.md` unchanged (no count refresh needed).
- ✅ `RELEASING.md` unchanged.
- ✅ No new runtime deps, no version bumps.

## Risks reminder (from spec)

- **R1 (critical):** Mutation kill-rate drift. The pre-refactor baseline diff at Task 8 step 4 is the load-bearing check. Halt if non-empty.
- **R6:** Mutation-test logging side effect. The 5 consumer files emit `console.log [mutation] …` lines; preserve format exactly to keep the baseline diff clean.

## Cross-references

- `docs/specs/2026-05-20-test-and-fixture-gen-helper-consolidation-design.md` — the spec this plan implements. **Spec wins on any interface disagreement.**
- `docs/specs/2026-05-20-ergoscript-phase-2h-d-savltree-completion-design.md` — predecessor phase; flagged this consolidation as deferred.
- `SESSION_CONTEXT.md` — local-only state tracking (gitignored).
- `CLAUDE.md` — TDD discipline, browser-first rules, confidence-escalation list, "Never use --no-verify".
