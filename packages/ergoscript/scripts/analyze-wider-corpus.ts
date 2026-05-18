#!/usr/bin/env tsx
/**
 * Task B analyzer — loads mainnet_boxes_wider.json, walks every box's
 * parsed ErgoTree, tallies tag/method-pair frequencies (source-segmented),
 * emits markdown report + JSON tally under docs/specs/.
 *
 * Invocation: `npx tsx packages/ergoscript/scripts/analyze-wider-corpus.ts`
 *
 * Design spec: docs/specs/2026-05-18-task-b-corpus-widening-design.md
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseTree } from '../src/index'
import { hexToBytes } from './_hex'
import { analyzeBox, emptyResult, type CorpusBox, type AnalysisResult, type MethodPairTally } from './_walker'
import { KNOWN_METHODS } from './_known-methods'

// Set of Expr.tag values NOT yet wired in eval/eval.ts as of phase 2g.5.
// Derived from facts/ergoscript.md § Coverage at time of analysis.
// Refer to facts/ergoscript.md when Task 5 runs to make sure this list is
// current; the analyzer's "unimplementedHits" tally is only as accurate as
// this set.
const UNIMPLEMENTED_TAGS = new Set([
  'LastBlockUtxoRootHash',
  'CalcBlake2b256',
  'CalcSha256',
  'DecodePoint',
  'ByteArrayToLong',
  'ByteArrayToBigInt',
  'LongToByteArray',
  'Xor',
  'SubstConstants',
  // Add any 'not-implemented-yet' tags surfaced by facts/ergoscript.md at
  // Task 5 implementation time.
])

const FIXTURE_PATH =
  process.argv[2] ??
  path.join(__dirname, '..', 'test', 'fixtures', 'mainnet_boxes_wider.json')
const RESULTS_MD_PATH = path.join(
  __dirname, '..', '..', '..', 'docs', 'specs',
  '2026-05-18-task-b-corpus-survey-results.md',
)
const TALLY_JSON_PATH = path.join(
  __dirname, '..', '..', '..', 'docs', 'specs',
  '2026-05-18-task-b-corpus-survey-tally.json',
)

interface Fixture {
  meta: Record<string, unknown>
  boxes: CorpusBox[]
}

function main(): void {
  const fixture: Fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'))
  const result = emptyResult()

  for (const box of fixture.boxes) {
    try {
      const tree = parseTree(hexToBytes(box.ergoTreeBytes))
      analyzeBox(tree.body, box, result, KNOWN_METHODS, UNIMPLEMENTED_TAGS)
    } catch (err) {
      const errorCode =
        err && typeof err === 'object' && 'code' in err
          ? (err as { code: string }).code
          : String(err)
      result.parseFailures.push({ boxId: box.boxId, errorCode, source: box.source })
    }
  }

  // Phase 2g.6 prioritization: unimplemented method pairs, sorted by
  // distinctBoxes desc with mustInclude as tiebreaker.
  const phase2g6Priority: MethodPairTally[] = Array.from(result.methodPairs.values())
    .filter((p) => p.implemented !== true)
    .sort((a, b) =>
      b.distinctBoxes - a.distinctBoxes || b.mustInclude - a.mustInclude,
    )

  writeMarkdown(result, phase2g6Priority)
  writeTallyJson(fixture.meta, result, phase2g6Priority)

  console.log(`wrote ${RESULTS_MD_PATH}`)
  console.log(`wrote ${TALLY_JSON_PATH}`)
  console.log(`total boxes: ${fixture.boxes.length}`)
  console.log(`parse failures: ${result.parseFailures.length}`)
  console.log(`distinct tags: ${result.tagFrequencies.size}`)
  console.log(`distinct method pairs: ${result.methodPairs.size}`)
  console.log(`phase 2g.6 priority methods: ${phase2g6Priority.length}`)
}

function writeMarkdown(
  result: AnalysisResult,
  priority: MethodPairTally[],
): void {
  const lines: string[] = []
  lines.push('# Task B — Wider Mainnet Corpus Survey Results')
  lines.push('')
  lines.push(`**Generated:** ${new Date().toISOString()}`)
  lines.push(`**Source fixture:** \`packages/ergoscript/test/fixtures/mainnet_boxes_wider.json\``)
  lines.push(`**Parse failures:** ${result.parseFailures.length}`)
  lines.push('')

  lines.push('## Top-level Expr tag frequencies')
  lines.push('')
  lines.push('| Tag | Total nodes | Distinct boxes | Random | Must-include |')
  lines.push('|---|---|---|---|---|')
  const tagsSorted = Array.from(result.tagFrequencies.entries())
    .sort((a, b) => b[1].distinctBoxes - a[1].distinctBoxes)
  for (const [tag, t] of tagsSorted) {
    lines.push(`| ${tag} | ${t.totalAppearances} | ${t.distinctBoxes} | ${t.random} | ${t.mustInclude} |`)
  }
  lines.push('')

  lines.push('## Method-call (typeId, methodId) pair frequencies')
  lines.push('')
  lines.push('| typeId | methodId | Sigma-rust name | Total | Distinct boxes | Random | Must-include | Implemented? |')
  lines.push('|---|---|---|---|---|---|---|---|')
  const methodsSorted = Array.from(result.methodPairs.values())
    .sort((a, b) => b.distinctBoxes - a.distinctBoxes)
  for (const p of methodsSorted) {
    const impl = p.implemented === true ? `✅ ${p.implementedIn ?? ''}` : (p.implemented === false ? '❌' : '(unknown)')
    lines.push(`| ${p.typeId} | ${p.methodId} | ${p.methodName ?? '(unknown)'} | ${p.totalAppearances} | ${p.distinctBoxes} | ${p.random} | ${p.mustInclude} | ${impl} |`)
  }
  lines.push('')

  lines.push('## Currently-unimplemented arms hit')
  lines.push('')
  lines.push('| Tag | Distinct boxes | Example boxIds |')
  lines.push('|---|---|---|')
  const unimplSorted = Array.from(result.unimplementedHits.entries())
    .sort((a, b) => b[1].distinctBoxes - a[1].distinctBoxes)
  for (const [tag, h] of unimplSorted) {
    lines.push(`| ${tag} | ${h.distinctBoxes} | ${h.exampleBoxIds.slice(0, 3).join(', ')} |`)
  }
  lines.push('')

  lines.push('## Parse failures')
  lines.push('')
  const failGrouped = new Map<string, number>()
  for (const f of result.parseFailures) {
    failGrouped.set(f.errorCode, (failGrouped.get(f.errorCode) ?? 0) + 1)
  }
  lines.push('| Error code | Count |')
  lines.push('|---|---|')
  for (const [code, count] of Array.from(failGrouped.entries()).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${code} | ${count} |`)
  }
  lines.push('')

  lines.push('## Phase 2g.6 prioritization (raw — Task 6 authors the clustered version below)')
  lines.push('')
  lines.push('| Rank | typeId | methodId | Method | distinctBoxes | Random | Must-include |')
  lines.push('|---|---|---|---|---|---|---|')
  priority.forEach((p, i) => {
    lines.push(`| ${i + 1} | ${p.typeId} | ${p.methodId} | ${p.methodName ?? '(unknown)'} | ${p.distinctBoxes} | ${p.random} | ${p.mustInclude} |`)
  })
  lines.push('')

  fs.writeFileSync(RESULTS_MD_PATH, lines.join('\n'))
}

function writeTallyJson(
  meta: Record<string, unknown>,
  result: AnalysisResult,
  priority: MethodPairTally[],
): void {
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      fixtureSource: 'packages/ergoscript/test/fixtures/mainnet_boxes_wider.json',
      fixtureMeta: meta,
    },
    tagFrequencies: Array.from(result.tagFrequencies.entries())
      .map(([tag, t]) => ({ tag, ...t }))
      .sort((a, b) => b.distinctBoxes - a.distinctBoxes),
    methodPairs: Array.from(result.methodPairs.values())
      .sort((a, b) => b.distinctBoxes - a.distinctBoxes),
    unimplementedHits: Array.from(result.unimplementedHits.entries())
      .map(([tag, h]) => ({ tag, ...h }))
      .sort((a, b) => b.distinctBoxes - a.distinctBoxes),
    parseFailures: result.parseFailures,
    phase2g6Priority: priority,
  }
  fs.writeFileSync(TALLY_JSON_PATH, JSON.stringify(out, null, 2))
}

main()
