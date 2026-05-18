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

// Set of Expr.tag values NOT yet wired in eval/eval.ts central dispatch.
// Sourced from eval/eval.ts central dispatch as of 2026-05-18.
// Re-verify against current src/eval/eval.ts when re-running on a corpus.
const UNIMPLEMENTED_TAGS = new Set([
  'SubstConstants',
  'ByteArrayToLong',
  'ByteArrayToBigInt',
  'LongToByteArray',
  'CalcBlake2b256',
  'CalcSha256',
  'Global',
  'Xor',
  'SigmaPropIsProven',
  'ZkProofBlock',
  'DecodePoint',
  'DeserializeRegister',
  'DeserializeContext',
  'MultiplyGroup',
  'Exponentiate',
  'TreeLookup',
  'CreateAvlTree',
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

  writeMarkdown(fixture.boxes, result, phase2g6Priority)
  writeTallyJson(fixture.boxes, fixture.meta, result, phase2g6Priority)

  console.log(`wrote ${RESULTS_MD_PATH}`)
  console.log(`wrote ${TALLY_JSON_PATH}`)
  console.log(`total boxes: ${fixture.boxes.length}`)
  console.log(`parse failures: ${result.parseFailures.length}`)
  console.log(`distinct tags: ${result.tagFrequencies.size}`)
  console.log(`distinct method pairs: ${result.methodPairs.size}`)
  console.log(`phase 2g.6 priority methods: ${phase2g6Priority.length}`)
}

function writeMarkdown(
  boxes: CorpusBox[],
  result: AnalysisResult,
  priority: MethodPairTally[],
): void {
  const totalBoxes = boxes.length
  const randomBoxes = boxes.filter((b) => b.source === 'random').length
  const mustIncludeBoxes = boxes.filter((b) => b.source.startsWith('must-include')).length
  const parseFailureRate = totalBoxes > 0 ? result.parseFailures.length / totalBoxes : 0

  const lines: string[] = []
  lines.push('# Task B — Wider Mainnet Corpus Survey Results')
  lines.push('')
  lines.push(`**Generated:** ${new Date().toISOString()}`)
  lines.push(`**Source fixture:** \`packages/ergoscript/test/fixtures/mainnet_boxes_wider.json\``)
  lines.push(`**Total boxes analyzed:** ${totalBoxes} (random=${randomBoxes}, mustInclude=${mustIncludeBoxes})`)
  lines.push(`**Parse failures:** ${result.parseFailures.length} (rate: ${(parseFailureRate * 100).toFixed(2)}%)`)
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
  const failGrouped = new Map<string, { count: number; examples: string[] }>()
  for (const f of result.parseFailures) {
    let entry = failGrouped.get(f.errorCode)
    if (!entry) {
      entry = { count: 0, examples: [] }
      failGrouped.set(f.errorCode, entry)
    }
    entry.count++
    if (entry.examples.length < 3) entry.examples.push(f.boxId)
  }
  lines.push('| Error class.code | Count | Example boxIds |')
  lines.push('|---|---|---|')
  for (const [code, { count, examples }] of Array.from(failGrouped.entries()).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| ${code} | ${count} | ${examples.join(', ')} |`)
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
  boxes: CorpusBox[],
  meta: Record<string, unknown>,
  result: AnalysisResult,
  priority: MethodPairTally[],
): void {
  const totalBoxes = boxes.length
  const randomBoxes = boxes.filter((b) => b.source === 'random').length
  const mustIncludeBoxes = boxes.filter((b) => b.source.startsWith('must-include')).length
  const parseFailureRate = totalBoxes > 0 ? result.parseFailures.length / totalBoxes : 0

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      fixtureSource: 'packages/ergoscript/test/fixtures/mainnet_boxes_wider.json',
      fixtureMeta: meta,
      totalBoxes,
      randomBoxes,
      mustIncludeBoxes,
      parseFailureRate,
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
    phase2g6Priority: priority.map((p, i) => ({ rank: i + 1, ...p })),
  }
  fs.writeFileSync(TALLY_JSON_PATH, JSON.stringify(out, null, 2))
}

main()
