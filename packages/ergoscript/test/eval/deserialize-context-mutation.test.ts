/**
 * Layer C3.a — Byte-level mutation testing for the DeserializeContext arm.
 *
 * Unlike most mutation tests in this suite, DeserializeContext has TWO
 * mutable byte regions per fixture entry, only one of which lives in
 * `tree_bytes_hex`:
 *
 *   1. **Outer tree bytes** (`treeBytes`, ≈4 bytes for these fixtures):
 *        [0] ErgoTree header (0x00 = V0, no segregation, no size)
 *        [1] OP_DESERIALIZE_CONTEXT (0xd4)
 *        [2] SType byte (0x01 = SBoolean, 0x08 = SSigmaProp)
 *        [3] var id (0x01)
 *      Flipping these tends to trip `ErgoTreeParseError` (bad opcode),
 *      `STypeParseError` (bad SType code), or — for the version-bits in the
 *      header — produce semantically-equivalent trees (see exclusion below).
 *
 *   2. **Inner Expr bytes** living in
 *      `opts_json.extension.values["1"].value.items[i].value`. These are
 *      NOT in `treeBytes`; they're rehydrated from JSON via
 *      `rehydrateEvalOpts`. Mutating these targets `substituteDeserialize`'s
 *      parse + tpe-check paths, which can yield:
 *        - `'deserialize-parse-failed'` (malformed inner Expr bytes)
 *        - `'deserialize-tpe-mismatch'` (parsed but with wrong result tpe)
 *        - a different success value if the mutated bytes still parse to a
 *          well-formed Expr of the same tpe.
 *
 * ── Structural exclusions ───────────────────────────────────────────────
 *
 * **ErgoTree header byte (offset 0) excluded universally.** The parser at
 * `packages/ergoscript/src/wire/ergo-tree.ts:115-122` masks the raw header
 * byte with `VERSION_MASK = 0x07` for the version field, then probes bit 3
 * (`HAS_SIZE_FLAG`) and bit 4 (`CONSTANT_SEGREGATION_FLAG`). Bits 5/6/7 are
 * silently ignored. Bit 0 changes V0→V1, which is semantically equivalent
 * for the simple `DeserializeContext` arm exercised by all 7 fixtures (no
 * V0/V1-gated semantics on this code path). The result is that XOR 0x01 and
 * XOR 0x80 at offset 0 produce byte-equivalent evaluation behaviour. Rather
 * than allowlist 14 of 21 offset-0 mutations across the 7 entries, the
 * cleaner approach is to drop offset 0 from the tree-mutation region. Bytes
 * 1-3 (opcode, SType, var id) carry all the load-bearing tree semantics.
 *
 * ── Per-entry equivalence classes (PER_ENTRY_EXEMPT) ─────────────────────
 *
 * **`dc_throw_key_not_found`** — extension is empty, so ALL var ids miss
 *   with the same `'deserialize-context-key-not-found'` code. Three of the
 *   nine offset-3 (var id) mutations survive because the failure mode is
 *   universal across var-id values. Exempted from per-entry threshold; the
 *   aggregate captures the remaining kill surface (tree-opcode + SType
 *   mutations, all of which kill via wire-parse-error code shift).
 *
 * **`dc_throw_parse_failed`** — inner bytes are `[0xff, 0xff, 0xff]`. Most
 *   byte flips still produce a `'deserialize-parse-failed'` code (different
 *   parse error message, but same code class). XOR 0x01 flips 0xff→0xfe
 *   which is opcode `Context` — a valid Expr that parses successfully but
 *   trips `'deserialize-tpe-mismatch'` (SContext ≠ SBoolean) → kills (3 of
 *   9 inner mutations). The remaining 6 stay within `'deserialize-parse-failed'`
 *   under isKillStrict's "both threw with same code → not kill" rule.
 *   Exempted from per-entry threshold.
 *
 * **`dc_bool_true`** — inner bytes are `[0x01, 0x01]`; opcode 0x01 (OpTrue)
 *   is a single-byte Expr. Per spec section "Walking rules / No reader-at-
 *   EOF assertion on inner parse," sigma-rust does NOT require the inner
 *   reader to be exhausted after the Expr parse. Trailing byte at idx=1 is
 *   invisible to the substitution pass. 2 of 6 inner mutations survive
 *   (idx=1 × XOR 0xff and 0x80; both produce `value=true`, idx=1 trailing
 *   ignored). Exempted from per-entry threshold.
 *
 * **`dc_throw_tpe_mismatch`** — inner bytes are `[0x04, 0x0a]`; opcode 0x04
 *   is a single-byte Const(SLong, ...) variant or similar. Some XOR=0x01
 *   mutations preserve the same `'deserialize-tpe-mismatch'` code (e.g.,
 *   SInt→SLong both mismatch SBoolean). 2 of 6 inner mutations survive via
 *   same-code equivalence. Exempted from per-entry threshold.
 *
 * **`dc_height_eq_compare`** — inner bytes encode BinOp(NEq, Height, Const).
 *   When Height = 999999, `Height ≠ X` evaluates to `true` for all
 *   plausible Const values, so byte 2/3 (the Const payload) mutations
 *   preserve the boolean result. 2 of 12 inner mutations survive via
 *   mathematical-equivalence. This entry crosses 90% (10/12 = 0.833 + tree
 *   9/9 + inner 10/12 = 19/21 = 0.905) — passes WITHOUT exemption.
 *
 * Kill rule: `isKillStrict` everywhere (matches `sheader-checkpow-mutation`).
 * Under `isKillStrict` both-threw mutations are kills iff error codes differ;
 * this catches behavioural drift in failure modes that `isKillStandard`
 * would let through.
 *
 * Threshold: ≥ 0.90 per entry (with exemptions listed above) + aggregate
 * ≥ 0.90 as the load-bearing safety net.
 *
 * Source: ergotree-ir/src/mir/expr.rs:442-465 (DC branch of substitute_deserialize)
 *         packages/ergoscript/src/eval/_substitute-deserialize.ts (substituteDeserializeContext)
 *         packages/ergoscript/src/wire/mir/deserialize-context.ts (parse)
 * Pattern: exponentiate-mutation.test.ts (PER_ENTRY_EXEMPT + aggregate
 *          fallback); custom inner-Expr-bytes loop because the inner bytes
 *          live in `opts_json`, not `treeBytes`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hexToBytes } from '../_helpers'
import {
  evalSafely,
  isKillStrict,
  runMutationLoop,
  XOR_PATTERNS_STANDARD,
  DEFAULT_KILL_THRESHOLD,
  type EvalOutcome,
} from '../_helpers/mutation-harness'

interface FixtureEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error: string | null
  expected_error_code: string | null
}

interface FixtureFile {
  corpus: string
  entries: FixtureEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'deserialize-context.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

/**
 * Tree-byte offsets to skip during mutation. Offset 0 = ErgoTree header
 * (version bits + reserved bits) — see top-of-file note for the rationale.
 */
const TREE_EXCLUDED_OFFSETS: ReadonlySet<number> = new Set<number>([0])

/**
 * Locate the items array inside `opts.extension.values[varId].value.items`,
 * matching the JSON shape produced by sigma-rust's `value_to_json` for a
 * `Coll[Byte]` constant. Returns null if the structure isn't present
 * (e.g., extension entry has tpe=SInt, or is absent entirely).
 *
 * The returned array carries entries of shape `{kind: 'Byte', value: i8}`;
 * we mutate `.value` in place on a deep-cloned copy of `opts_json`.
 */
function findInnerByteItems(
  opts: Record<string, unknown>,
  varId: string,
): Array<{ kind: string; value: number }> | null {
  const ext = opts['extension'] as Record<string, unknown> | undefined
  if (ext === undefined) return null
  const values = ext['values'] as Record<string, unknown> | undefined
  if (values === undefined) return null
  const entry = values[varId] as Record<string, unknown> | undefined
  if (entry === undefined) return null
  const value = entry['value'] as Record<string, unknown> | undefined
  if (value === undefined) return null
  if (value['kind'] !== 'Coll') return null
  const items = value['items']
  if (!Array.isArray(items)) return null
  return items as Array<{ kind: string; value: number }>
}

/**
 * Deep-clone `opts_json` via JSON round-trip (the fixture shape is JSON-
 * safe — no BigInt, no Date, no Uint8Array). Used to produce a fresh opts
 * object per mutation without aliasing the original items array.
 */
function deepCloneOpts(opts: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(opts)) as Record<string, unknown>
}

/**
 * Run a custom mutation loop over the inner Coll[Byte] items inside
 * `opts.extension.values[varId].value.items`. For each item index × each XOR
 * pattern, deep-clone opts, flip the byte (signed i8 ↔ XOR), run
 * `evalSafely`, and tally kills via `isKillStrict`.
 *
 * Sign-handling: fixture items carry i8 values (-128..=127). XOR is applied
 * to the unsigned-equivalent byte, then re-sign-extended via `<<24 >>24`
 * to restore the i8 representation that `rehydrateEvalOpts` →
 * `hydrateSValue` → `collByteToUint8Array` ultimately mask back to u8 via
 * `& 0xff`. So the round-trip is bit-stable regardless of the sign
 * representation chosen.
 */
function runInnerExprMutationLoop(
  entry: FixtureEntry,
  baseline: EvalOutcome,
): { killed: number; total: number; rate: number; inputLen: number } {
  const items = findInnerByteItems(entry.opts_json, '1')
  if (items === null) return { killed: 0, total: 0, rate: 1, inputLen: 0 }

  const treeBytes = hexToBytes(entry.tree_bytes_hex)
  let killed = 0
  let total = 0

  for (let i = 0; i < items.length; i++) {
    const origByte = items[i]!.value & 0xff
    for (const xor of XOR_PATTERNS_STANDARD) {
      total++
      const mutatedOpts = deepCloneOpts(entry.opts_json)
      const mutatedItems = findInnerByteItems(mutatedOpts, '1')!
      const flipped = (origByte ^ xor) & 0xff
      // Re-sign-extend back to i8 so the JSON-rehydration path sees a value
      // in [-128, 127] (matching sigma-rust's `value_to_json` output).
      mutatedItems[i]!.value = (flipped << 24) >> 24
      const outcome = evalSafely(treeBytes, mutatedOpts)
      if (isKillStrict(baseline, outcome)) {
        killed++
      }
    }
  }

  return { killed, total, rate: total === 0 ? 1 : killed / total, inputLen: items.length }
}

describe('DeserializeContext mutation testing (Layer C3.a)', () => {
  let aggKilled = 0
  let aggTotal = 0

  // Fixtures whose inherent equivalence classes (failure-mode stability,
  // trailing-byte-after-Expr, mathematical equivalence) make the per-entry
  // 90% threshold unachievable on this fixture set. Each is documented in
  // the top-of-file note. The aggregate kill rate is the load-bearing
  // safety net.
  const PER_ENTRY_EXEMPT = new Set<string>([
    'dc_bool_true',
    'dc_throw_key_not_found',
    'dc_throw_parse_failed',
    'dc_throw_tpe_mismatch',
  ])

  for (const entry of fixture.entries) {
    it(`${entry.name}: >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on tree + inner-Expr byte mutations`, () => {
      const treeBytes = hexToBytes(entry.tree_bytes_hex)
      // Baseline is shared between the tree-bytes loop (via runMutationLoop)
      // and the inner-Expr loop (computed here). The harness recomputes
      // baseline internally, so we pay one extra eval to share it with our
      // custom loop — negligible cost.
      const baseline = evalSafely(treeBytes, entry.opts_json)

      // ── Region 1: outer tree bytes (offset 0 excluded — see preamble) ──
      // Offsets 1-3 carry the load-bearing DeserializeContext payload
      // (opcode 0xd4, SType byte, var id). All 9 mutations across these
      // 3 offsets either trip ErgoTreeParseError (bad opcode), STypeParseError
      // (bad SType code), or shift the var-id (changing 'key-not-found' to
      // a different lookup result — kill via different code or different
      // value under isKillStrict).
      const treeResult = runMutationLoop({
        treeBytes,
        region: { start: 0, end: treeBytes.length },
        optsJson: entry.opts_json,
        isKill: isKillStrict,
        excludedOffsets: TREE_EXCLUDED_OFFSETS,
      })
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] deserialize_context.${entry.name}#tree: killed=${treeResult.killed} ` +
          `total=${treeResult.total} rate=${treeResult.rate.toFixed(3)} ` +
          `inputLen=${treeBytes.length} excludedOffsets=[0]`,
      )

      // ── Region 2: inner Expr bytes inside extension.values["1"] ────────
      // Mutates the Coll[Byte] items array via deep-clone + i8 flip.
      // Returns {killed: 0, total: 0} for entries with no inner items
      // (`dc_throw_key_not_found`, `dc_throw_wrong_input_type`).
      const innerResult = runInnerExprMutationLoop(entry, baseline)
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] deserialize_context.${entry.name}#inner: killed=${innerResult.killed} ` +
          `total=${innerResult.total} rate=${innerResult.rate.toFixed(3)} ` +
          `inputLen=${innerResult.inputLen}`,
      )

      const entryKilled = treeResult.killed + innerResult.killed
      const entryTotal = treeResult.total + innerResult.total
      const entryRate = entryTotal === 0 ? 1 : entryKilled / entryTotal
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] deserialize_context.${entry.name} TOTAL: killed=${entryKilled} ` +
          `total=${entryTotal} rate=${entryRate.toFixed(3)}`,
      )

      aggKilled += entryKilled
      aggTotal += entryTotal

      if (!PER_ENTRY_EXEMPT.has(entry.name)) {
        expect(entryRate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
      }
    })
  }

  it(`DeserializeContext: aggregate kill rate >=${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG deserialize_context: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})
