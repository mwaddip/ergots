/**
 * Tier-1 SAvlTree pure-accessor handlers (phase 2h-b).
 *
 * 7 handlers, all Pattern A cost 15, none calling into @ergots/avltree:
 *   digest             (100:1) → Coll[Byte]
 *   enabledOperations  (100:2) → Byte
 *   keyLength          (100:3) → Int
 *   valueLengthOpt     (100:4) → Option[Int]
 *   isInsertAllowed    (100:5) → Boolean
 *   isUpdateAllowed    (100:6) → Boolean
 *   isRemoveAllowed    (100:7) → Boolean
 *
 * Fixtures (4 per handler = 28 entries) live under test/fixtures/eval/.
 * Each carries tree-bytes hex, opts JSON, expected SValue JSON, expected jit cost.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:29-75
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface AccessorEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface AccessorFixture {
  corpus: string
  entries: AccessorEntry[]
}

const ACCESSOR_FIXTURES: { handler: string; file: string }[] = [
  { handler: 'digest', file: 'savltree-digest.json' },
  { handler: 'enabledOperations', file: 'savltree-enabled-operations.json' },
  { handler: 'keyLength', file: 'savltree-key-length.json' },
  { handler: 'valueLengthOpt', file: 'savltree-value-length-opt.json' },
  { handler: 'isInsertAllowed', file: 'savltree-is-insert-allowed.json' },
  { handler: 'isUpdateAllowed', file: 'savltree-is-update-allowed.json' },
  { handler: 'isRemoveAllowed', file: 'savltree-is-remove-allowed.json' },
]

const __dirname = dirname(fileURLToPath(import.meta.url))

for (const { handler, file } of ACCESSOR_FIXTURES) {
  const fixturePath = join(__dirname, '../fixtures/eval/', file)
  const fixture: AccessorFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

  describe(`SAvlTree.${handler} — fixture-driven`, () => {
    for (const entry of fixture.entries) {
      it(entry.name, () => {
        const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
        const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      })
    }
  })
}
