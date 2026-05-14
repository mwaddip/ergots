/**
 * Mutation tests for the ergoscript parser.
 *
 * For every valid fixture (synthetic Expr body, full ErgoTree corpus entry),
 * iterate over sampled byte offsets and XOR-flip one byte. The parser MUST
 * either:
 *   (a) throw a TYPED error from the documented taxonomy
 *       (`ErgoTreeParseError`, `ExprParseError`, `STypeParseError`,
 *        `SValueParseError`, `SigmaBooleanParseError`, `ReaderError`,
 *        `ExprTpeError`), OR
 *   (b) succeed silently (the mutation landed in a value-content region —
 *       BigInt magnitude byte, GroupElement coord, ZigZag VLQ payload, the
 *       non-zero boolean byte, etc.).
 *
 * Both outcomes are acceptable. The single hard failure is "untyped throw":
 * any error thrown from `parseTree`/`parseExpr` that is NOT in the typed
 * union above. That indicates a parser code path with an uncaught edge case
 * (raw `TypeError`, `RangeError`, naked `Error`) — a coverage gap in the
 * error taxonomy.
 *
 * Why not require throws on structure-affecting mutations?
 *   Determining a priori which offsets are "structure-affecting" requires
 *   parsing the fixture and tracing reader positions through value vs.
 *   structural reads — work the proof package's `fixture-gen` does on the
 *   Rust side. We don't generate that metadata for ergoscript (too large a
 *   surface; 74 corpus trees × variable lengths, 83 synthetic Exprs). We
 *   substitute an aggregate check: across the whole corpus, the throw rate
 *   should comfortably exceed a sanity floor.
 *
 * Mirror of `packages/proof/test/mutation.test.ts`, adapted to drop the
 * per-offset `expected_to_fail` flags (which require Rust-side metadata
 * generation) in favor of aggregate-stat sanity checks.
 *
 * Density (per the task spec):
 *   - Synthetic Expr fixtures (83): mutate every byte (most are < 50B).
 *   - Corpus trees:
 *       - < 200 bytes: mutate every byte.
 *       - >= 200 bytes: sample every 8th byte (starting at 0).
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTree, ErgoTreeParseError } from '../src/wire/ergo-tree'
import { parseExpr } from '../src/wire/parse'
import { ByteReader, ReaderError } from '../src/wire/reader'
import { ExprParseError } from '../src/wire/errors'
import { STypeParseError } from '../src/wire/parse-stype'
import { SValueParseError } from '../src/wire/parse-svalue'
import { SigmaBooleanParseError } from '../src/wire/sigma-boolean'
import { ExprTpeError } from '../src/mir/expr-tpe'
import { hexToBytes } from './_helpers'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURE_DIR = path.join(__dirname, 'fixtures')

// ---------- helpers ---------------------------------------------------------

/** Flip every bit of one byte (XOR 0xff) at the given offset. */
function mutateByte(bytes: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(bytes)
  out[offset] = out[offset]! ^ 0xff
  return out
}

type Outcome =
  | { kind: 'thrown'; errorName: string; code?: string }
  | { kind: 'parsed-silently' }
  | { kind: 'untyped-throw'; errorName: string; message: string }

interface MutationParser {
  /** Parse only; no reserialization. Throws on parse failure. */
  parse(bytes: Uint8Array): void
}

/** Body-only Expr parser (no envelope; segregated-constant arrays empty). */
function exprParser(): MutationParser {
  return {
    parse(bytes: Uint8Array): void {
      const reader = new ByteReader(bytes)
      parseExpr(reader, [], [])
    },
  }
}

/** Full ErgoTree parser (header + envelope + constants + body). */
function treeParser(): MutationParser {
  return {
    parse(bytes: Uint8Array): void {
      parseTree(bytes)
    },
  }
}

/**
 * Classify a single mutation outcome by catching against the documented
 * typed-error union.
 */
function classify(mutated: Uint8Array, parser: MutationParser): Outcome {
  try {
    parser.parse(mutated)
    return { kind: 'parsed-silently' }
  } catch (e: unknown) {
    if (
      e instanceof ErgoTreeParseError ||
      e instanceof ExprParseError ||
      e instanceof STypeParseError ||
      e instanceof SValueParseError ||
      e instanceof SigmaBooleanParseError ||
      e instanceof ReaderError ||
      e instanceof ExprTpeError
    ) {
      const err = e as { name: string; code?: string }
      return { kind: 'thrown', errorName: err.name, code: err.code }
    }
    const err = e as { name?: string; message?: string }
    return {
      kind: 'untyped-throw',
      errorName: err.name ?? 'Unknown',
      message: String(err.message ?? e),
    }
  }
}

/**
 * Offsets to mutate for a fixture of `byteLength` bytes.
 * < 200 bytes → every byte; >= 200 bytes → every 8th byte (starting at 0).
 */
function mutationOffsets(byteLength: number): number[] {
  const step = byteLength < 200 ? 1 : 8
  const offsets: number[] = []
  for (let i = 0; i < byteLength; i += step) {
    offsets.push(i)
  }
  return offsets
}

// ---------- fixture types ---------------------------------------------------

interface SyntheticExprEntry {
  name: string
  description?: string
  expr_hex: string
}

interface CorpusTreeEntry {
  name: string
  source_es?: string
  tree_bytes_hex: string
  byte_length?: number
  known_unstable?: boolean
}

interface CorpusFile<E> {
  corpus?: string
  entries: E[]
  non_deterministic?: E[]
  deferred?: boolean
}

function loadFixture<T>(filename: string): T {
  const p = path.join(FIXTURE_DIR, filename)
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

// ---------- mutation runner -------------------------------------------------

interface AggregateStats {
  totalMutations: number
  thrown: number
  parsedSilently: number
  fixturesWithZeroThrows: string[]
  untypedThrows: Array<{
    fixture: string
    offset: number
    errorName: string
    message: string
  }>
}

const stats: AggregateStats = {
  totalMutations: 0,
  thrown: 0,
  parsedSilently: 0,
  fixturesWithZeroThrows: [],
  untypedThrows: [],
}

function runMutations(
  label: string,
  bytes: Uint8Array,
  parser: MutationParser
): void {
  // Sanity: original parses cleanly.
  let originalParses = false
  try {
    parser.parse(bytes)
    originalParses = true
  } catch {
    // Fall through — recorded as the sanity it() below.
  }

  it(`${label}: original parses (sanity)`, () => {
    expect(originalParses, `${label}: original fixture failed to parse`).toBe(
      true
    )
  })

  if (!originalParses) return

  const offsets = mutationOffsets(bytes.length)

  // One it() per fixture covering all sampled offsets — keeps the test count
  // bounded while still surfacing per-fixture failures with offset info.
  it(`${label}: no untyped throws across ${offsets.length} offsets (of ${bytes.length}B)`, () => {
    const localUntyped: Array<{
      offset: number
      errorName: string
      message: string
    }> = []
    let localThrown = 0
    let localParsedSilently = 0

    for (const offset of offsets) {
      const mutated = mutateByte(bytes, offset)
      const outcome = classify(mutated, parser)
      stats.totalMutations++
      switch (outcome.kind) {
        case 'thrown':
          stats.thrown++
          localThrown++
          break
        case 'parsed-silently':
          stats.parsedSilently++
          localParsedSilently++
          break
        case 'untyped-throw':
          stats.untypedThrows.push({
            fixture: label,
            offset,
            errorName: outcome.errorName,
            message: outcome.message,
          })
          localUntyped.push({
            offset,
            errorName: outcome.errorName,
            message: outcome.message,
          })
          break
      }
    }

    // Hard failure: any throw outside the documented taxonomy is a parser
    // coverage gap. The taxonomy MUST cover every reject path.
    expect(
      localUntyped,
      `${label}: untyped throws at ${localUntyped
        .map((u) => `${u.offset} (${u.errorName}: ${u.message.slice(0, 120)})`)
        .join('; ')}`
    ).toEqual([])

    if (localThrown === 0) {
      stats.fixturesWithZeroThrows.push(
        `${label} (${bytes.length}B, ` +
          `parsed-silently=${localParsedSilently})`
      )
    }
  })
}

// ---------- test suites -----------------------------------------------------

describe('Mutation: synthetic Expr (body-only)', () => {
  const fixture = loadFixture<{ entries: SyntheticExprEntry[] }>(
    'synthetic_expr.json'
  )
  expect(fixture.entries.length).toBeGreaterThan(0)
  const parser = exprParser()
  for (const entry of fixture.entries) {
    const bytes = hexToBytes(entry.expr_hex)
    runMutations(`Expr ${entry.name}`, bytes, parser)
  }
})

function runCorpusMutations(filename: string, suiteLabel: string): void {
  describe(`Mutation: ${suiteLabel}`, () => {
    const fixture = loadFixture<CorpusFile<CorpusTreeEntry>>(filename)
    const stable = fixture.entries.filter((e) => !e.known_unstable)
    if (stable.length === 0) {
      it.skip(`${filename}: no stable entries`, () => {})
      return
    }
    const parser = treeParser()
    for (const entry of stable) {
      const bytes = hexToBytes(entry.tree_bytes_hex)
      runMutations(`${suiteLabel} ${entry.name}`, bytes, parser)
    }
  })
}

runCorpusMutations('corpus_legacy_45.json', 'legacy_45')
runCorpusMutations('corpus_ecosystem_14.json', 'ecosystem_14')
runCorpusMutations('corpus_significant_15.json', 'significant_15')

// ---------- aggregate reporter ---------------------------------------------

describe('Mutation: aggregate', () => {
  // Vitest registers `describe` blocks in source order during test
  // collection, and runs them in order during execution (default config).
  // The aggregate suite is defined last so its `it()` bodies fire after the
  // fixture suites have populated `stats`.

  it('aggregate: zero untyped throws across all fixtures', () => {
    expect(
      stats.untypedThrows,
      `untyped throws found: ${stats.untypedThrows
        .map(
          (u) =>
            `${u.fixture}@${u.offset} (${u.errorName}: ${u.message.slice(0, 80)})`
        )
        .join('; ')}`
    ).toEqual([])
  })

  it('aggregate: throw rate is at least 30% across all fixtures', () => {
    // Floor sanity check: if fewer than 30% of mutations throw, the parser
    // is suspiciously lenient. Real ErgoTrees have a high proportion of
    // structural bytes (opcodes, type codes, length prefixes); the throw
    // rate on corpus mutations should comfortably exceed this floor.
    expect(stats.totalMutations).toBeGreaterThan(0)
    const throwRate = stats.thrown / stats.totalMutations
    expect(
      throwRate,
      `throw rate ${(throwRate * 100).toFixed(1)}% below 30% floor — ` +
        `total=${stats.totalMutations} thrown=${stats.thrown} ` +
        `parsed-silently=${stats.parsedSilently}`
    ).toBeGreaterThanOrEqual(0.3)
  })

  it('aggregate: reports stats (informational)', () => {
    expect(stats.totalMutations).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log(
      `[mutation-test] total=${stats.totalMutations} ` +
        `thrown=${stats.thrown} (${((stats.thrown / stats.totalMutations) * 100).toFixed(1)}%) ` +
        `parsed-silently=${stats.parsedSilently} (${((stats.parsedSilently / stats.totalMutations) * 100).toFixed(1)}%) ` +
        `untyped-throws=${stats.untypedThrows.length} ` +
        `zero-throw-fixtures=${stats.fixturesWithZeroThrows.length}`
    )
    if (stats.fixturesWithZeroThrows.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[mutation-test] zero-throw fixtures (informational):\n  ${stats.fixturesWithZeroThrows.join('\n  ')}`
      )
    }
  })
})
