/**
 * The red table for SANTA conformance.
 *
 * A red row is a SANTA entry whose current ergots outcome diverges from the
 * JVM-blessed expectation. Rows are listed in `red-table.json` under a reason
 * id; the row check below is used by `cost-v5.test.ts` and `cost-v6.test.ts`
 * and is called two ways: a row NOT in the table must match (returns `null`),
 * and a row IN the table must NOT match (returns a non-null failure message).
 * A listed row that now matches fails the test with the sentinel text
 * `row is green; remove it from the red table`.
 *
 * The reason ids below are the sorting buckets; each names a board item that
 * owns closing the rows. A row whose root cause is settled by this stage goes
 * under `collection-class`; items 23/26/27 cover rows owned by later work
 * (a tuple handed where a collection is wanted, a cross-width comparison,
 * a method id with no handler). Only this stage's rows will leave the table
 * here; later tasks remove their own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evalSantaEntry, svalueToSantaJson, type SantaEntry } from './_santa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RED_TABLE_PATH = path.join(__dirname, '../fixtures/conformance/red-table.json')

/** Reason ids and the board item each belongs to. A reason outside this stage names the item that closes it. */
export const RED_REASONS: Record<string, { item: number; why: string }> = {
  'collection-class': {
    item: 22,
    why: "The row's verdict depends on a collection's runtime class, which the evaluator does not read yet.",
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
