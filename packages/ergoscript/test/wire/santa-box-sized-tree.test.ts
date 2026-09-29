// SANTA JVM-blessed Box vectors (sigma-state 6.0.6), replayed as Dasher does:
// parseSValue(SBox) → serializeSValue(SBox); expected = expected_bytes_hex ?? bytes_hex.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ByteReader, ByteWriter, ReaderError } from '@ergots/scorex'
import { parseSValue } from '../../src/wire/parse-svalue'
import { serializeSValue } from '../../src/wire/serialize-svalue'
import { ErgoTreeParseError } from '../../src/wire/ergo-tree'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const FILES: [string, string[]][] = [
  ['Box.sized_tree_declared_size.json', ['box-sized-tree-control#0', 'box-sized-tree-declared-over#1', 'box-sized-tree-declared-under#2']],
  ['Box.tree_read_window.json', ['box-tree-window-degrade-accept#0', 'box-tree-window-unsized-reject#1', 'box-tree-window-box-read-reject#2', 'box-tree-window-within-accept#3']],
  ['Box.tree_root_type_check.json', ['box-unsized-sigmaprop-root-accept#0', 'box-unsized-int-root-reject#1', 'box-sized-int-root-degrade-accept#2']],
]
// Each errored entry's reject, as its description gives it: the class, the code, and the cause's code.
const ERRORS: Record<string, { cls: new (...args: never[]) => Error; code: string; cause?: string }> = {
  // The read at candidate offset 4100 trips the tree window (rule 1014), and without a size bit
  // the tree cannot degrade (ErgoTreeSerializer.scala:204-207).
  'box-tree-window-unsized-reject#1': { cls: ErgoTreeParseError, code: 'soft-fork-without-size-bit', cause: 'position-limit-exceeded' },
  // The creation-height read at 4100 is past the box window: a hard reject, outside any tree.
  'box-tree-window-box-read-reject#2': { cls: ReaderError, code: 'position-limit-exceeded' },
  // Rule 1001 fails the unsized Int root, which cannot degrade either.
  'box-unsized-int-root-reject#1': { cls: ErgoTreeParseError, code: 'soft-fork-without-size-bit', cause: 'root-not-sigma-prop' },
}
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
        if (e.error === 'errored') {
          const want = ERRORS[e.name]
          expect(want, `no reject pinned for ${e.name}`).toBeDefined()
          let err: unknown
          try { run() } catch (x) { err = x }
          expect(err).toBeInstanceOf(want!.cls)
          expect((err as { code?: string }).code).toBe(want!.code)
          if (want!.cause !== undefined) expect(((err as Error).cause as { code?: string }).code).toBe(want!.cause)
        } else {
          expect(run()).toBe(e.expected_bytes_hex ?? e.bytes_hex)
        }
      })
    }
  })
}
