// SANTA JVM-blessed Box vectors (sigma-state 6.0.6), replayed as Dasher does:
// parseSValue(SBox) → serializeSValue(SBox); expected = expected_bytes_hex ?? bytes_hex.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader, ByteWriter } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const FILES: [string, string[]][] = [
  ['Box.sized_tree_declared_size.json', ['box-sized-tree-control#0', 'box-sized-tree-declared-over#1', 'box-sized-tree-declared-under#2']],
  ['Box.tree_read_window.json', ['box-tree-window-degrade-accept#0', 'box-tree-window-unsized-reject#1', 'box-tree-window-box-read-reject#2', 'box-tree-window-within-accept#3']],
  ['Box.tree_root_type_check.json', ['box-unsized-sigmaprop-root-accept#0', 'box-unsized-int-root-reject#1', 'box-sized-int-root-degrade-accept#2']],
]
for (const [file, names] of FILES) {
  describe(`SANTA ${file} (jvm-blessed)`, () => {
    const entries = JSON.parse(readFileSync(join(__dirname, '../fixtures/conformance/wire', file), 'utf8')).entries
    it('holds exactly the expected entries', () => expect(entries.map((e: { name: string }) => e.name)).toEqual(names))
    for (const e of entries) {
      it(e.name, () => {
        const run = () => {
          const v = parseSValue({ tag: 'SBox' }, e.version.ergoTree, new ByteReader(hex(e.bytes_hex)))
          const w = new ByteWriter(); serializeSValue({ tag: 'SBox' }, v, e.version.ergoTree, w); return toHex(w.toBytes())
        }
        if (e.error === 'errored') expect(run).toThrow()
        else expect(run()).toBe(e.expected_bytes_hex ?? e.bytes_hex)
      })
    }
  })
}
