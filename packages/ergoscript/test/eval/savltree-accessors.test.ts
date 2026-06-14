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
 * Also contains direct-handler pins for the i32-view semantics of keyLength and
 * valueLengthOpt (F4 epilogue, 2026-06-07): JVM AvlTreeData.scala:84-85 parses
 * both via `getUInt().toInt`, so wire values in [2^31, 2^32) wrap NEGATIVE at
 * the accessor. The handlers apply `| 0` to reinterpret the stored u32 as i32.
 * Blessed vectors: AvlTree.keyLength_wrapped_negative.json#0 (0x80000001 → −2147483647)
 * and AvlTree.negative_keylength_tree.json#4 (0x80000000 → −2147483648).
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
import {
  evalSAvlTreeKeyLength,
  evalSAvlTreeValueLengthOpt,
} from '../../src/eval/savltree'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'
import type { SValue, SType } from '../../src/mir/types'

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

// ---------------------------------------------------------------------------
// Direct-handler i32-view pins (F4 epilogue, 2026-06-07)
//
// JVM AvlTreeData.scala:84-85: both keyLength and valueLengthOpt are parsed
// via `getUInt().toInt` — wire values in [2^31, 2^32) wrap NEGATIVE and the
// ACCESSORS surface the negative Int. The JVM SERIALIZER requires unsigned
// range (writeUInt), so only the accessor view wraps — a deserialize-only
// asymmetry. Storage stays u32; `| 0` is applied at the accessor only.
//
// Direct handler calls bypass the ErgoTree envelope; the only cost charged is
// ACCESSOR_COST = 15. Blessed by SANTA (jvm:sigma-state-6.0.3):
//   - keyLength 0x80000001 → Int(-2147483647): AvlTree.keyLength_wrapped_negative.json#0
//   - keyLength 0x80000000 → Int(-2147483648): AvlTree.negative_keylength_tree.json#4
//   - valueLengthOpt Some(0x80000000) → Some(Int(-2147483648)): source-backed,
//     vector-unblessed (queued for future SANTA bless).
// ---------------------------------------------------------------------------

const SINT_TYPE: SType = { tag: 'SInt' }

function avlTreeValue(opts: {
  keyLength: number
  valueLengthOpt?: number | null
}): SValue {
  return {
    kind: 'AvlTree',
    value: {
      digest: new Uint8Array(33),
      treeFlags: 0,
      keyLength: opts.keyLength,
      valueLengthOpt: opts.valueLengthOpt ?? null,
    },
  }
}

describe('SAvlTree.keyLength — i32-view direct-handler pins (F4 epilogue)', () => {
  it('keyLength 0x80000000 → Int(-2147483648) @15 [SANTA blessed: negative_keylength_tree#4]', () => {
    const ctx = makeContext({})
    // Stored u32 = 2147483648; JVM getUInt().toInt wraps to -2147483648.
    const result = evalSAvlTreeKeyLength(avlTreeValue({ keyLength: 0x80000000 }), [], ctx)
    expect(result).toEqual({ kind: 'Int', value: -2147483648 })
    expect(ctx.jitCost).toBe(15)
  })

  it('keyLength 0x80000001 → Int(-2147483647) @15 [SANTA blessed: keyLength_wrapped_negative#0]', () => {
    const ctx = makeContext({})
    // Stored u32 = 2147483649; JVM getUInt().toInt wraps to -2147483647.
    const result = evalSAvlTreeKeyLength(avlTreeValue({ keyLength: 0x80000001 }), [], ctx)
    expect(result).toEqual({ kind: 'Int', value: -2147483647 })
    expect(ctx.jitCost).toBe(15)
  })

  it('keyLength 32 → Int(32) @15 (no-change — normal positive range)', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeKeyLength(avlTreeValue({ keyLength: 32 }), [], ctx)
    expect(result).toEqual({ kind: 'Int', value: 32 })
    expect(ctx.jitCost).toBe(15)
  })
})

describe('SAvlTree.valueLengthOpt — i32-view direct-handler pins (F4 epilogue)', () => {
  it('valueLengthOpt Some(0x80000000) → Some(Int(-2147483648)) @15 [source-backed, vector-unblessed]', () => {
    const ctx = makeContext({})
    // Same JVM parse line (AvlTreeData.scala:85); stored u32 wraps to -2147483648 via | 0.
    // Source-backed by JVM AvlTreeData.scala:84-85 pattern; vector-unblessed (queued ask).
    const result = evalSAvlTreeValueLengthOpt(
      avlTreeValue({ keyLength: 32, valueLengthOpt: 0x80000000 }),
      [],
      ctx
    )
    expect(result).toEqual({
      kind: 'Option',
      elem: SINT_TYPE,
      value: { kind: 'Int', value: -2147483648 },
    })
    expect(ctx.jitCost).toBe(15)
  })

  it('valueLengthOpt Some(8) → Some(Int(8)) @15 (no-change — normal positive range)', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeValueLengthOpt(
      avlTreeValue({ keyLength: 32, valueLengthOpt: 8 }),
      [],
      ctx
    )
    expect(result).toEqual({
      kind: 'Option',
      elem: SINT_TYPE,
      value: { kind: 'Int', value: 8 },
    })
    expect(ctx.jitCost).toBe(15)
  })
})
