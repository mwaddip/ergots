/**
 * Layer C3.a — Byte-level mutation testing for the DeserializeRegister arm.
 *
 * Mirrors the DC mutation test (deserialize-context-mutation.test.ts) — same
 * two-region pattern, adapted for DR's register-side payload:
 *
 *   1. **Outer tree bytes** (`treeBytes`, 5..9 bytes for these fixtures):
 *        [0]    ErgoTree header byte (0x00 = V0, no segregation, no size)
 *        [1]    OP_DESERIALIZE_REGISTER (0xd5)
 *        [2]    reg (u8 in 0..=9; sigma-rust rejects > 9)
 *        [3]    SType byte (0x01 = SBoolean, 0x04 = SInt, etc.)
 *        [4]    Option<Box<Expr>> tag (0x00 = None, 0x01 = Some)
 *        [5..]  Inline default Expr bytes (when default-tag = 0x01).
 *      Flipping these tends to trip `ErgoTreeParseError` (bad opcode),
 *      `STypeParseError` (bad SType code), `ExprParseError` (bad reg id or
 *      default tag), or produce semantically-equivalent trees (see exclusion
 *      below).
 *
 *   2. **Inner Expr bytes** living in
 *      `opts_json.selfBox.registers["4"].value.items[i].value`. These are
 *      NOT in `treeBytes`; they're rehydrated from JSON via
 *      `rehydrateEvalOpts` → `hydrateErgoBox` → `hydrateSValue`. Mutating
 *      these targets `substituteDeserializeRegister`'s parse + tpe-check
 *      paths, which can yield:
 *        - `'deserialize-parse-failed'` (malformed inner Expr bytes)
 *        - `'deserialize-tpe-mismatch'` (parsed but with wrong result tpe)
 *        - a different success value if the mutated bytes still parse to a
 *          well-formed Expr of the same tpe.
 *
 *      Note: when the default Expr is embedded inline in the tree bytes
 *      (e.g. `dr_r5_default_int`, `dr_default_used_when_register_absent`,
 *      `dr_throw_default_wrong_type`), its bytes live in region 1, not
 *      region 2. The register-side inner Expr only exists for entries
 *      where `selfBox.registers["4"]` carries a Coll[Byte] value.
 *
 * ── Structural exclusions ───────────────────────────────────────────────
 *
 * **ErgoTree header byte (offset 0) excluded universally.** Same rationale
 * as the DC mutation test: the parser masks with `VERSION_MASK = 0x07` for
 * the version field, probes bit 3 (`HAS_SIZE_FLAG`) and bit 4
 * (`CONSTANT_SEGREGATION_FLAG`); bits 5/6/7 are silently ignored. Bit 0 (V0
 * → V1) is semantically equivalent on the DR code path (no V0/V1-gated
 * semantics here). Dropping offset 0 from the mutation region matches DC's
 * exclusion exactly.
 *
 * ── Per-entry equivalence classes (PER_ENTRY_EXEMPT) ─────────────────────
 *
 * **`dr_r4_bool_neq`** — selfBox.registers["4"] holds inner Expr bytes
 *   `[0x94, 0xa3, 0x04, 0x02]` = NEq(Height, Const(SInt, 1)). Height
 *   evaluates to 999999 in this fixture, so the inner expression returns
 *   `Boolean true` regardless of small Const-SInt payload mutations
 *   (Height ≠ 1, ≠ −2, ≠ 0 all reduce to `true`). Inner mutations at
 *   idx=2 (XOR 0x01: 0x04 Const(SInt) → 0x05 Const(SLong) — same value-
 *   semantic) and idx=3 (XOR 0x01: VLQ 1 → ZigZag −2 — still ≠ Height)
 *   survive via mathematical equivalence. 10 of 12 inner mutations
 *   killed; total kill rate 22/24 = 0.917 → passes 0.90 per-entry without
 *   exemption.
 *
 * **`dr_r5_default_int`** — default Expr `04 02` = Const(SInt, 1) inline
 *   in tree at offsets 5-6. Register absent (registers={}). Tree
 *   mutations at offset 2 (reg byte 0x05 XOR 0x01 → 0x04): both R4 and
 *   R5 are absent in registers={}, so the substitution path returns
 *   `default` Expr in both cases → value-equivalent `Int 1`. 1 survivor
 *   via reg-absent equivalence. Offset 4 (default-tag 0x01) XOR 0xff/0x80
 *   produce nonzero tags → Some → parse same default Expr → value-equivalent
 *   (JVM getOption semantics); these 2 are consensus-dead and excluded from
 *   the denominator (see SOME_DEFAULT_TAG_OFFSET below). XOR 0x01 at offset 4
 *   flips 0x01→0x00 (Some→None) — value-changing, counted + must kill.
 *   Effective surface: 16 mutations; 1 survivor (reg-absent). 15/16 = 0.9375
 *   → passes 0.90 per-entry without exemption.
 *
 * **`dr_default_used_when_register_absent`** — default Expr `94 a3 04 00`
 *   = NEq(Height, Const(SInt, 0)) embedded in tree at offsets 5-8.
 *   Register absent, default returns `Boolean true` (Height=999999 ≠ 0).
 *   Three tree mutations survive: offset 2 (reg R5→R4, both absent),
 *   offset 7 (SLong 0 still ≠ Height), offset 8 (ZigZag(−1) still ≠
 *   Height). Offset 4 XOR 0xff/0x80 are excluded from the denominator
 *   (consensus-dead, see SOME_DEFAULT_TAG_OFFSET). Effective surface: 22
 *   mutations; 3 survivors (reg-absent + Height-NEq). 19/22 = 0.864 —
 *   exempted from per-entry threshold (reg-absent + Height-NEq equivalence
 *   classes).
 *
 * **`dr_throw_register_wrong_type`** — register holds Const(SInt, 1) (a
 *   single SValue, not a Coll[Byte]). The fixture's `value` field is
 *   `{ kind: 'Int', value: 1 }`, with no `items` array to iterate. We
 *   skip inner-Expr mutations for this entry (set membership in
 *   `NO_REGISTER_INNER_BYTES`). Tree mutations alone provide the kill
 *   surface: opcode/reg/tpe/default-tag flips all trip parse errors or
 *   substitution-error code shifts. 12/12 = 1.000.
 *
 * **`dr_throw_no_register_no_default`** — empty registers, default=None.
 *   No inner-Expr mutations available (skipped via `NO_REGISTER_INNER_BYTES`).
 *   The tree body is `DeserializeRegister { reg=R5, tpe=SBoolean,
 *   default=None }`. One tree mutation survives (offset 2 reg byte
 *   XOR 0x01: R5 → R4, both absent → both leave node unchanged → both
 *   throw same `'deserialize-not-substituted'` code). 11/12 = 0.917 →
 *   passes 0.90 per-entry without exemption.
 *
 * **`dr_throw_inner_wrong_type`** — register holds `[0x04, 0x02]` =
 *   Const(SInt, 1). Inner bytes parse to a valid Expr of tpe SInt, then
 *   the tpe-check vs. SBoolean throws `'deserialize-tpe-mismatch'`. Many
 *   inner-byte flips still produce a valid Expr of the same wrong type or
 *   a parse-failed code, both of which fall outside the baseline tpe-
 *   mismatch code. XOR 0x01 at idx=0 flips 0x04 → 0x05 (Const(SLong));
 *   parses to SLong; tpe mismatch SLong vs SBoolean → same code class
 *   (`'deserialize-tpe-mismatch'`) → NOT a kill under isKillStrict. A
 *   handful of mutations fall in this equivalence class. Exempted from
 *   per-entry threshold; aggregate captures.
 *
 * **`dr_throw_parse_failed`** — register holds `[0xff, 0xff, 0xff]`. Most
 *   byte flips still produce `'deserialize-parse-failed'` (different parse
 *   error message, but same code class). XOR 0x01 flips 0xff → 0xfe, which
 *   is opcode `Context` — a valid Expr that parses successfully but trips
 *   `'deserialize-tpe-mismatch'` (SContext ≠ SBoolean) → kill. The
 *   remaining mutations stay within `'deserialize-parse-failed'` under
 *   isKillStrict's same-code rule. Exempted from per-entry threshold.
 *
 * **`dr_throw_default_wrong_type`** — default Expr `01 01` inline at tree
 *   offsets 5..6. Default-tag 0x01 + byte 6 is the boolean VALUE byte of
 *   `Const(SBoolean, true)` (byte 5 = SBoolean TYPE code 0x01). The
 *   wrong-type assertion is SBoolean ≠ SInt
 *   (declared tpe = SInt at offset 3). Most tree mutations preserve
 *   `'deserialize-tpe-mismatch'` (any default-Expr parse that yields ≠
 *   SInt produces the same code under isKillStrict's same-code rule).
 *   Several mutations survive: e.g. XOR 0x01 at offset 6 flips opcode
 *   0x01 (OpTrue) → 0x00, which is OpFalse (still SBoolean, same mismatch).
 *   Offset 4 XOR 0xff/0x80 are excluded from the denominator (consensus-dead,
 *   see SOME_DEFAULT_TAG_OFFSET). XOR 0x01 at offset 4 (Some→None) is
 *   value-changing → counted + kills. Exempted from per-entry threshold
 *   (same-code tpe-mismatch equivalence class).
 *
 * Kill rule: `isKillStrict` everywhere (matches DC mutation test). Under
 * `isKillStrict` both-threw mutations are kills iff error codes differ;
 * this catches behavioural drift in failure modes that `isKillStandard`
 * would let through.
 *
 * Threshold: ≥ 0.90 per entry (with exemptions listed above). Aggregate
 * threshold lowered to ≥ 0.85 with documented rationale (see below) per
 * OVERRIDES rule #2 (confidence escalation on sub-90% kill rates).
 *
 * ── Aggregate threshold rationale (sub-90% escalation) ───────────────────
 *
 * Empirical aggregate: 121/141 = 0.858 (6 consensus-dead JVM getOption
 * nonzero-tag mutations excluded from denominator; see SOME_DEFAULT_TAG_OFFSET).
 * The DR fixture set is dominated by small-payload entries (5-9 tree bytes;
 * 2-4 inner bytes); the effective mutation surface (141 after exclusions) has
 * 20 survivors in legitimate equivalence classes:
 *
 *   - 5 reg-absent equivalences (R0..R9 absent → same default path)
 *   - 4 Height-NEq mathematical equivalences (Height=999999 dominates
 *     small Const-SInt values; NEq returns `true` regardless of small
 *     payload mutations)
 *   - 11 same-code throw equivalences (parse-failed bytes still produce
 *     parse-failed; tpe-mismatch bytes still produce tpe-mismatch; subset
 *     of the full class — others are kills under isKillStrict's code-diff rule)
 *
 * Each of these mirrors JVM behaviour correctly; there is no behavioural
 * drift to catch. The DC mutation test reaches 0.925 aggregate only because
 * of the 32-byte inline SigmaProp fixture (`dc_const_sigmaprop_inner`
 * contributes 114/114 kills); the DR fixture set has no comparable
 * large-payload entry to dilute the small-fixture equivalence classes.
 *
 * Per OVERRIDES rule #2 ("Don't ship sub-90% kill rates without
 * investigation + documented rationale"): the structural ceiling for this
 * fixture composition is ~0.86 after correct exclusions; the 0.85 aggregate
 * threshold is the load-bearing safety net against regressions; per-entry
 * exemptions are the equivalence-class filter.
 *
 * Source: ergotree-ir/src/mir/expr.rs:466-491 (DR branch of
 *           substitute_deserialize)
 *         packages/ergoscript/src/eval/_substitute-deserialize.ts
 *           (substituteDeserializeRegister)
 *         packages/ergoscript/src/wire/mir/deserialize-register.ts (parse)
 * Pattern: deserialize-context-mutation.test.ts (T9) — direct parallel,
 *          adapted for DR's register-side inner-Expr path which lives one
 *          level deeper than DC's extension-side path.
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
const fixturePath = join(__dirname, '..', 'fixtures', 'eval', 'deserialize-register.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile

/**
 * Tree-byte offsets to skip during mutation. Offset 0 = ErgoTree header
 * (version bits + reserved bits) — see top-of-file note for the rationale.
 */
const TREE_EXCLUDED_OFFSETS: ReadonlySet<number> = new Set<number>([0])

/**
 * The Option<Box<Expr>> tag byte sits at wire offset 4 in every
 * DeserializeRegister tree:
 *   [0] header  [1] 0xd5  [2] reg  [3] SType  [4] tag  [5..] inline Expr
 *
 * For the three Some-defaulted fixtures (dr_r5_default_int,
 * dr_default_used_when_register_absent, dr_throw_default_wrong_type) this
 * byte holds 0x01. Under JVM getOption semantics ANY nonzero tag = Some, so
 * XOR 0xff (0x01→0xfe) and XOR 0x80 (0x01→0x81) produce nonzero→nonzero
 * flips: the parser reads the same inline Expr → same MIR → same canonical
 * bytes. These are consensus-dead mutations; excluded from the denominator.
 * XOR 0x01 (0x01→0x00, Some→None) changes the value and must still count.
 *
 * Exclusion mechanism: SOME_DEFAULT_FIXTURES entries pass an extended
 * excludedOffsets set (TREE_EXCLUDED_OFFSETS ∪ {4}) to runMutationLoop, then
 * manually test the single value-changing mutation (offset 4, XOR 0x01).
 * Same recalibration mechanism as the F4 decodePoint identity-bytes exclusion
 * in multiply-group-mutation.test.ts.
 */
const SOME_DEFAULT_TAG_OFFSET = 4
const SOME_DEFAULT_FIXTURES: ReadonlySet<string> = new Set<string>([
  'dr_r5_default_int',
  'dr_default_used_when_register_absent',
  'dr_throw_default_wrong_type',
])
const TREE_EXCLUDED_OFFSETS_WITH_TAG: ReadonlySet<number> = new Set<number>([
  0,
  SOME_DEFAULT_TAG_OFFSET,
])

/**
 * Entries whose `selfBox.registers["4"]` carries no Coll[Byte] items
 * (either an SInt scalar or absent registers entirely). For these we skip
 * the inner-Expr mutation loop because there are no register-side bytes
 * to mutate; the tree-bytes region carries all the load-bearing payload.
 */
const NO_REGISTER_INNER_BYTES: ReadonlySet<string> = new Set<string>([
  'dr_r5_default_int', // default inline in tree; registers={}
  'dr_default_used_when_register_absent', // default inline in tree; registers={}
  'dr_throw_register_wrong_type', // register holds Const(SInt,1) — no items array
  'dr_throw_default_wrong_type', // default inline in tree; registers={}
  'dr_throw_no_register_no_default', // registers={}, default=None
])

/**
 * Locate the items array inside `opts.selfBox.registers[reg].value.items`,
 * matching the JSON shape produced by sigma-rust's `value_to_json` for a
 * `Coll[Byte]` register value. Returns null if the structure isn't present
 * (e.g. register has tpe=SInt, or is absent entirely).
 *
 * The returned array carries entries of shape `{kind: 'Byte', value: i8}`;
 * we mutate `.value` in place on a deep-cloned copy of `opts_json`.
 */
function findRegisterByteItems(
  opts: Record<string, unknown>,
  reg: string,
): Array<{ kind: string; value: number }> | null {
  const selfBox = opts['selfBox'] as Record<string, unknown> | undefined
  if (selfBox === undefined) return null
  const registers = selfBox['registers'] as Record<string, unknown> | undefined
  if (registers === undefined) return null
  const entry = registers[reg] as Record<string, unknown> | undefined
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
 * `opts.selfBox.registers[reg].value.items`. For each item index × each XOR
 * pattern, deep-clone opts, flip the byte (signed i8 ↔ XOR), run
 * `evalSafely`, and tally kills via `isKillStrict`.
 *
 * Sign-handling: fixture items carry i8 values (-128..=127). XOR is applied
 * to the unsigned-equivalent byte, then re-sign-extended via `<<24 >>24`
 * to restore the i8 representation that `rehydrateEvalOpts` →
 * `hydrateErgoBox` → `hydrateSValue` → `collByteToUint8Array` ultimately
 * mask back to u8 via `& 0xff`. The round-trip is bit-stable regardless
 * of the sign representation chosen.
 */
function runRegisterInnerExprMutationLoop(
  entry: FixtureEntry,
  baseline: EvalOutcome,
  reg: string,
): { killed: number; total: number; rate: number; inputLen: number } {
  const items = findRegisterByteItems(entry.opts_json, reg)
  if (items === null) return { killed: 0, total: 0, rate: 1, inputLen: 0 }

  const treeBytes = hexToBytes(entry.tree_bytes_hex)
  let killed = 0
  let total = 0

  for (let i = 0; i < items.length; i++) {
    const origByte = items[i]!.value & 0xff
    for (const xor of XOR_PATTERNS_STANDARD) {
      total++
      const mutatedOpts = deepCloneOpts(entry.opts_json)
      const mutatedItems = findRegisterByteItems(mutatedOpts, reg)!
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

describe('DeserializeRegister mutation testing (Layer C3.a)', () => {
  let aggKilled = 0
  let aggTotal = 0

  // Fixtures whose inherent equivalence classes (failure-mode stability,
  // mathematical equivalence, same-code variants) make the per-entry 0.90
  // threshold unachievable on this fixture set. Each is documented in the
  // top-of-file note. The aggregate kill rate is the load-bearing safety
  // net (asserted separately below at a documented lower threshold).
  const PER_ENTRY_EXEMPT = new Set<string>([
    'dr_default_used_when_register_absent', // Height-NEq + reg-absent equivalence
    'dr_throw_default_wrong_type', // same-code tpe-mismatch variants
    'dr_throw_inner_wrong_type', // same-code tpe-mismatch variants
    'dr_throw_parse_failed', // same-code parse-failed variants on 0xff bytes
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
      // Offsets 1..N carry the load-bearing DeserializeRegister payload
      // (opcode 0xd5, reg byte, tpe byte, default-tag, optional inline
      // default Expr). All mutations across these offsets either trip
      // ErgoTreeParseError / ExprParseError / STypeParseError (parse errors
      // surface as errorCode=undefined under evalSafely), shift the
      // substitution outcome to a different EvalError code, or change a
      // success value.
      //
      // For Some-defaulted fixtures, the tag byte (offset 4) has 2 of 3 XOR
      // patterns that are consensus-dead (nonzero→nonzero tag → same Expr →
      // same value; JVM getOption). Those 2 are excluded from the denominator
      // via TREE_EXCLUDED_OFFSETS_WITH_TAG; the one value-changing mutation
      // (XOR 0x01 → 0x00, Some→None) is added back manually below.
      // See SOME_DEFAULT_TAG_OFFSET note above for full rationale.
      const isSomeDefault = SOME_DEFAULT_FIXTURES.has(entry.name)
      const treeLoopResult = runMutationLoop({
        treeBytes,
        region: { start: 0, end: treeBytes.length },
        optsJson: entry.opts_json,
        isKill: isKillStrict,
        excludedOffsets: isSomeDefault
          ? TREE_EXCLUDED_OFFSETS_WITH_TAG
          : TREE_EXCLUDED_OFFSETS,
      })
      let treeKilled = treeLoopResult.killed
      let treeTotal = treeLoopResult.total
      if (isSomeDefault) {
        // Consensus-dead mutation class (JVM getOption: ANY nonzero tag = Some →
        // a nonzero→nonzero tag flip parses the identical Expr/MIR/canonical bytes;
        // DeserializeRegisterSerializer.scala:30). Excluded from the denominator —
        // same recalibration mechanism as the F4 decodePoint identity-bytes
        // exclusion (multiply-group-mutation.test.ts). nonzero→ZERO flips still
        // count (Some→None is value-changing) and must kill.
        const tagMutated = new Uint8Array(treeBytes)
        tagMutated[SOME_DEFAULT_TAG_OFFSET] = (treeBytes[SOME_DEFAULT_TAG_OFFSET]! ^ 0x01) & 0xff
        const tagOutcome = evalSafely(tagMutated, entry.opts_json)
        treeTotal += 1
        if (isKillStrict(baseline, tagOutcome)) treeKilled += 1
        // Direct kill assertion: Some→None (offset 4, XOR 0x01) MUST kill
        // regardless of per-entry threshold exemptions. Pin it explicitly so
        // the "value-changing mutation kills" claim is test-enforced, not
        // only captured in the aggregate rate.
        expect(isKillStrict(baseline, tagOutcome)).toBe(true)
      }
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] deserialize_register.${entry.name}#tree: killed=${treeKilled} ` +
          `total=${treeTotal} rate=${(treeTotal === 0 ? 1 : treeKilled / treeTotal).toFixed(3)} ` +
          `inputLen=${treeBytes.length} excludedOffsets=${isSomeDefault ? '[0,4]' : '[0]'}`,
      )

      // ── Region 2: inner Expr bytes inside selfBox.registers["4"] ───────
      // Mutates the Coll[Byte] items array via deep-clone + i8 flip.
      // Returns {killed: 0, total: 0} for entries whose register holds no
      // Coll[Byte] items (default-inline-in-tree variants + the wrong-type
      // SInt-scalar variant + the no-register variant).
      const innerResult = NO_REGISTER_INNER_BYTES.has(entry.name)
        ? { killed: 0, total: 0, rate: 1, inputLen: 0 }
        : runRegisterInnerExprMutationLoop(entry, baseline, '4')
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] deserialize_register.${entry.name}#inner: killed=${innerResult.killed} ` +
          `total=${innerResult.total} rate=${innerResult.rate.toFixed(3)} ` +
          `inputLen=${innerResult.inputLen}`,
      )

      const entryKilled = treeKilled + innerResult.killed
      const entryTotal = treeTotal + innerResult.total
      const entryRate = entryTotal === 0 ? 1 : entryKilled / entryTotal
      // eslint-disable-next-line no-console
      console.log(
        `[mutation] deserialize_register.${entry.name} TOTAL: killed=${entryKilled} ` +
          `total=${entryTotal} rate=${entryRate.toFixed(3)}`,
      )

      aggKilled += entryKilled
      aggTotal += entryTotal

      if (!PER_ENTRY_EXEMPT.has(entry.name)) {
        expect(entryRate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
      }
    })
  }

  // Aggregate threshold lowered from DEFAULT_KILL_THRESHOLD (0.90) to 0.85
  // per OVERRIDES rule #2 with documented rationale. See top-of-file
  // preamble "Aggregate threshold rationale" — the DR fixture set's
  // composition has a structural ceiling at ~0.86 (after consensus-dead
  // JVM getOption tag-byte mutations are excluded from the denominator).
  // Surviving equivalence classes: reg-absent, Height-NEq, same-code throws.
  // Each reflects correct JVM behaviour; no drift to catch.
  const AGGREGATE_KILL_THRESHOLD = 0.85
  it(`DeserializeRegister: aggregate kill rate >=${(AGGREGATE_KILL_THRESHOLD * 100).toFixed(0)}%`, () => {
    const rate = aggTotal === 0 ? 1 : aggKilled / aggTotal
    // eslint-disable-next-line no-console
    console.log(
      `[mutation] AGG deserialize_register: killed=${aggKilled} total=${aggTotal} rate=${rate.toFixed(3)}`,
    )
    expect(rate).toBeGreaterThanOrEqual(AGGREGATE_KILL_THRESHOLD)
  })
})
