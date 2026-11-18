/**
 * The evaluator imports the collection module only through the facade,
 * `packages/ergoscript/src/eval/_coll.ts`. Every other file under
 * `packages/ergoscript/src/eval/` that imports from `src/coll/` (`../coll`,
 * `../coll/...`, `../coll/index`) fails this scan.
 *
 * A plain text scan of each `.ts` file under `eval/`: an import line that
 * names `'...coll...'` on its right-hand side and is not inside `_coll.ts`
 * fails the test. `./_coll` imports (inside eval itself) are the allowed
 * form; `../coll` is the one this scan forbids.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVAL_DIR = path.resolve(__dirname, '../../src/eval')
const FACADE_NAME = '_coll.ts'

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Matches an import line whose right-hand side contains '../coll' (or the alias). */
const IMPORT_RE = /^\s*import[^'"`]*['"`]([^'"`]+)['"`]/

describe('the evaluator imports the collection module only through _coll.ts', () => {
  it('no file under src/eval/ (except _coll.ts) imports from src/coll/', () => {
    const offenders: string[] = []
    for (const file of listTsFiles(EVAL_DIR)) {
      if (path.basename(file) === FACADE_NAME) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const m = IMPORT_RE.exec(line)
        if (m === null) continue
        const spec = m[1]!
        // A relative import reaching `src/coll/`: '../coll', '../coll/x', '../coll/index'.
        // Not './_coll' (the facade in the same directory).
        if (/(^|[/\\])\.\.\/coll([/'"`]|$)/.test(spec)) {
          offenders.push(`${path.relative(EVAL_DIR, file)}: ${line.trim()}`)
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
