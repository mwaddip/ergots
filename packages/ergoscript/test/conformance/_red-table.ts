/**
 * The red table for SANTA conformance.
 *
 * A red row is a SANTA entry whose ergots outcome differs from its JVM-blessed
 * expectation. Each row is listed in `red-table.json` under one reason id;
 * `RED_REASONS` below gives each reason id one sentence that says what ergots
 * does on the rows listed under the id.
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

/** Reason ids, each with one sentence that says what ergots does on the rows listed under the id. */
export const RED_REASONS: Record<string, string> = {
  'collection-length-limit':
    'ergots builds a collection of more than 100,000 items at evaluation; the JVM refuses it in the collection class\'s constructor (core/shared/src/main/scala/sigma/data/CollsOverArrays.scala:13-14, MaxArrayLength in core/shared/src/main/scala/sigma/util/package.scala:7).',
  'tuple-as-collection':
    'A tuple constant of three or more items is handed where a collection is wanted.',
  comparer:
    'An item comparison across integer widths or over boxed values on a plain receiver.',
  'method-not-implemented':
    "ergots throws its 'method-not-implemented' code: a method id with no handler, or an argument guard that reuses the code.",
  'method-call-type':
    "ergots builds the tree and evaluates it; the JVM refuses it at parse because the call's return type keeps a type variable (the patch method's SFunc tRange is Coll[IV]) and the EQ's Constraints$SameType2 check fails on Coll[IV] against Coll[Unit] (data/shared/src/main/scala/sigma/ast/SigmaBuilder.scala Constraints$SameType2).",
  'zero-width-collection':
    'ergots parses a collection of a zero-width item type (SUnit, SColl of SUnit, STuple of SUnit) the JVM refuses at parse under rule 1020 CheckZeroWidthCollection (core/shared/src/main/scala/sigma/serialization/CoreDataSerializer.scala:166-170).',
  'checked-type':
    "ergots answers where the node's static type is one the JVM's type check has no value for.",
  'own-type-check':
    "ergots refuses by a check of its own that the JVM does not make.",
  'expression-register':
    "The entry's SELF, another box, or an extension holds an expression as a register or variable value, which ergots' readers refuse before anything else is read.",
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
