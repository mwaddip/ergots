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
 * Locate a byte region by index into the inline-Coll[Byte] list.
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
  optsJson?: Record<string, unknown>,
  makeCtx?: (opts: Record<string, unknown>) => ReturnType<typeof makeContext>,
): EvalOutcome {
  try {
    const opts = optsJson ?? {}
    const tree = parseTree(treeBytes)
    const ctx = makeCtx ? makeCtx(opts) : makeContext(rehydrateEvalOpts(opts))
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
 * The standard kill rule (used by `savltree-mutation.test.ts` and
 * the 3 inline savltree-* consumers):
 *   - both threw → not a kill
 *   - one threw → kill
 *   - both ok → kill iff values differ
 */
export function isKillStandard(baseline: EvalOutcome, mutated: EvalOutcome): boolean {
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
 * The difference vs `isKillStandard` is the both-threw branch:
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
  optsJson?: Record<string, unknown>
  xorPatterns?: number[]
  isKill?: (baseline: EvalOutcome, mutated: EvalOutcome) => boolean
  makeCtx?: (opts: Record<string, unknown>) => ReturnType<typeof makeContext>
}

/** A single survived mutation: the (offset, xor pattern) pair plus the
 *  outcome that wasn't a kill. Used by `MutationRunResult.survived`. */
export interface SurvivedMutation {
  offset: number
  xor: number
  outcome: EvalOutcome
}

export interface MutationRunResult {
  killed: number
  total: number
  rate: number
  survived: SurvivedMutation[]
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
  const isKill = config.isKill ?? isKillStandard
  const baseline = evalSafely(config.treeBytes, config.optsJson, config.makeCtx)
  let killed = 0
  let total = 0
  const survived: SurvivedMutation[] = []
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
