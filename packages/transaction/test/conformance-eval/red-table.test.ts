/**
 * Shape + coverage check on `red-table.json`:
 *   - every file key is one of the four vendored files;
 *   - every reason id is known (RED_REASONS);
 *   - every listed entry name exists in that file;
 *   - no entry is listed under more than one reason.
 *
 * Catches the two common drift modes of a hand-edited red table.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRedTable, RED_REASONS, type SantaFullCtxVector } from './_full-context'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIX_DIR = path.join(__dirname, '../fixtures/conformance/eval-fullctx')

const KNOWN_FILES = [
  'v5/Coll.patch_array_class_context.json',
  'v5/Coll.generic_producers.json',
  'v6/Coll.patch_array_class_context_v6.json',
  'v6/Coll.generic_producers_v6.json',
]

describe('red-table.json shape + coverage', () => {
  const table = loadRedTable()

  it('every file key is one of the four vendored files', () => {
    for (const key of Object.keys(table)) {
      expect(KNOWN_FILES, `unknown file key '${key}'`).toContain(key)
    }
  })

  it('every reason id is a known RED_REASONS id', () => {
    const known = new Set(Object.keys(RED_REASONS))
    for (const [key, byReason] of Object.entries(table)) {
      for (const reason of Object.keys(byReason)) {
        expect(known.has(reason), `file '${key}' reason '${reason}' not in RED_REASONS`).toBe(true)
      }
    }
  })

  it('every listed entry exists in its file, and no entry is listed twice', () => {
    for (const key of KNOWN_FILES) {
      const byReason = table[key]
      if (byReason === undefined) continue
      const abs = path.join(FIX_DIR, key)
      const doc = JSON.parse(fs.readFileSync(abs, 'utf8')) as SantaFullCtxVector
      const names = new Set(doc.entries.map(e => e.name))
      const seen = new Set<string>()
      for (const [reason, listed] of Object.entries(byReason)) {
        for (const name of listed) {
          expect(names.has(name), `'${key}' '${reason}' names unknown entry '${name}'`).toBe(true)
          expect(seen.has(name), `'${key}' lists entry '${name}' twice`).toBe(false)
          seen.add(name)
        }
      }
    }
  })
})
