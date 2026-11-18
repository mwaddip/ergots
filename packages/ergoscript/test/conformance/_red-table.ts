/**
 * The red table for SANTA conformance.
 *
 * A red row is a SANTA entry whose ergots outcome differs from its JVM-blessed
 * expectation. Each row is listed in `red-table.json` under one reason id;
 * `RED_REASONS` below gives each reason id a numeric `item` and one sentence
 * that says what ergots does on the rows listed under the id.
 *
 * The row check `rowMismatch` is used by `cost-v5.test.ts` and `cost-v6.test.ts`
 * two ways: a row NOT in the table must match (returns `null`), and a row IN
 * the table must NOT match (returns a non-null failure message). A listed row
 * that matches fails its test with the sentinel text
 * `row is green; remove it from the red table`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalSantaEntry, svalueToSantaJson, type SantaEntry } from './_santa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RED_TABLE_PATH = path.join(__dirname, '../fixtures/conformance/red-table.json')

/** Reason ids and their tracking numbers. Each entry gives a numeric `item` and one sentence that says what ergots does on the rows listed under the id. */
export const RED_REASONS: Record<string, { item: number; why: string }> = {
  'collection-class': {
    item: 22,
    why: "The evaluator reads no collection class, so the row's verdict rests on one it does not have.",
  },
  'tuple-as-collection': {
    item: 23,
    why: 'A tuple constant of three or more items is handed where a collection is wanted.',
  },
  comparer: {
    item: 26,
    why: 'An item comparison across integer widths or over boxed values on a plain receiver.',
  },
  'method-not-implemented': {
    item: 27,
    why: "ergots throws its 'method-not-implemented' code: a method id with no handler, or an argument guard that reuses the code.",
  },
  cost: {
    item: 22,
    why: 'The value is right and only the cost differs.',
  },
}

/** The red-table JSON shape: file path → reason id → list of entry names. */
export type RedTable = Record<string, Record<string, string[]>>

/** Load the committed red table. Cached per-process. */
let redTableCache: RedTable | null = null
export function loadRedTable(): RedTable {
  if (redTableCache !== null) return redTableCache
  const raw = fs.readFileSync(RED_TABLE_PATH, 'utf8')
  redTableCache = JSON.parse(raw) as RedTable
  return redTableCache
}

/** The reason id a row is listed under, or null. */
export function redReason(file: string, entry: string): string | null {
  const table = loadRedTable()
  const byReason = table[file]
  if (byReason === undefined) return null
  for (const [reason, entries] of Object.entries(byReason)) {
    if (entries.includes(entry)) return reason
  }
  return null
}

/**
 * Compare a row's ergots outcome against its blessed expectation. Returns
 * `null` on match and a short failure description otherwise. An actual outcome
 * of `'not-implemented'` is a failure whatever the row expects, mirroring
 * SANTA's own grading.
 */
export function rowMismatch(e: SantaEntry): string | null {
  const actual = evalSantaEntry(e)
  if (actual.error === 'not-implemented') {
    return "actual error 'not-implemented' (JVM-blessed does not use this outcome)"
  }
  if (e.expected.error !== null) {
    if (actual.error !== 'errored') {
      return `expected errored, got ${actual.error === null ? 'ok' : actual.error}`
    }
    return null
  }
  if (actual.error !== null) {
    return `expected ok, got ${actual.error}`
  }
  const actualJson = JSON.stringify(svalueToSantaJson(actual.value!))
  const expectedJson = JSON.stringify(e.expected.value)
  if (actualJson !== expectedJson) {
    return `value mismatch: expected ${truncate(expectedJson)}, got ${truncate(actualJson)}`
  }
  if (actual.cost !== e.expected.cost) {
    return `cost mismatch: expected ${e.expected.cost}, got ${actual.cost}`
  }
  return null
}

function truncate(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}
