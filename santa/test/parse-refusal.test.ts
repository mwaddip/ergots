import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runVector } from '../src/runner'

const here = path.dirname(fileURLToPath(import.meta.url))
const evalDir = path.resolve(here, '../../vectors/eval')

// The eval arm's parse stage: ergots' reader running out of bytes (or refusing them) is the library's verdict on the
// tree, as the wire arm counts it (codec-errors.ts isWireCodecError), so a tree the JVM refuses at parse and ergots'
// reader refuses grades `errored`, not `panicked`. The declared-count rows (sigma-rust's collection length limit
// request) declare a count and give fewer items: the JVM refuses at the count, ergots at the end of the bytes.
describe('the eval arm: a tree the reader refuses is a faithful reject', () => {
  for (const file of ['v5/authored/Coll.declared_count_at_parse.json', 'v6/authored/Coll.declared_count_at_parse_v6.json']) {
    it(`${file}: every entry the JVM refuses comes back errored`, () => {
      const doc = JSON.parse(readFileSync(path.join(evalDir, file), 'utf8'))
      const actuals = runVector(doc)
      const entries: { name: string; expected: { error: string | null } }[] = doc.entries
      const refused = entries.filter((e) => e.expected.error === 'errored')
      expect(refused.length).toBeGreaterThan(0)
      const wrong = refused
        .filter((e) => actuals[e.name]?.error !== 'errored')
        .map((e) => `${e.name}: ${JSON.stringify(actuals[e.name])}`)
      expect(wrong, wrong.join('\n')).toEqual([])
    })
  }
})
