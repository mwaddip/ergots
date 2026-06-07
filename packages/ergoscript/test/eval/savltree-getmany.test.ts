/**
 * SAvlTree.getMany (100:11) — Tier-2 verification op handler.
 *
 * Source: ergotree-interpreter/src/eval/savltree.rs:152-212 — GET_MANY_EVAL_FN.
 *         CErgoTreeEvaluator.scala:111-130 (JVM-canonical, F4).
 *
 * Failure model (JVM-canonical, F4):
 *   - verifier construct fail + ops.length > 0 → throw 'avl-tree-proof-failed'
 *   - verifier construct fail + ops.length == 0 → empty Coll (JVM swallows; keys.map
 *     over empty coll runs zero lookups so no Failure ever surfaces)
 *   - per-key Lookup Err (line 200-203) → throw same code
 *   - per-key Lookup Ok None → element `Option None`
 *   - per-key Lookup Ok Some → element `Some(Coll[Byte])`
 *
 * Verifier returns `Coll[Option[Coll[Byte]]]`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalSAvlTreeGetMany } from '../../src/eval/savltree'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface GetManyEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface GetManyFixture {
  corpus: string
  entries: GetManyEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-get-many.json')
const fixture: GetManyFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.getMany — fixture-driven', () => {
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

describe('SAvlTree.getMany — throw paths', () => {
  it('throws avl-tree-proof-failed when proof bytes are zeroed (construct fail)', () => {
    // Reuse the get_many_all_absent fixture (its proof prefix is the same
    // "0e55..." pattern as the get/contains fixtures).
    const sample = fixture.entries.find((e) => e.name === 'get_many_all_absent')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')

    const goodHex = sample.tree_bytes_hex
    const proofTagIdx = goodHex.indexOf('0e55030d3b')
    if (proofTagIdx < 0) throw new Error('test setup: proof prefix not found')
    const proofBodyStart = proofTagIdx + 4
    const proofBodyLen = 85 * 2
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(85) +
      goodHex.slice(proofBodyStart + proofBodyLen)

    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('avl-tree-proof-failed')
  })
})

describe('SAvlTree.getMany — empty keys + construct-failing proof (JVM-canonical, F4)', () => {
  it('returns empty Coll and does not throw when keys is empty, even with a garbage proof', () => {
    // JVM CErgoTreeEvaluator.scala:111-130: keys.map over an EMPTY coll executes
    // zero lookups — no Failure ever surfaces, even if the verifier's reconstruct_tree
    // fails (scorex swallows topNode=None). The result is an empty Coll[Option[Coll[Byte]]].
    //
    // Wire-reachable adversarial fork: empty Coll[Coll[Byte]] keys const + garbage proof.
    // Pre-fix ergots threw 'avl-tree-proof-failed' whenever partial===null regardless
    // of ops.length — this test pins the JVM-faithful empty-keys path.
    //
    // Direct handler call (not via evaluateWith): no fixture tree is needed because the
    // input shape is hand-constructed. All existing fixture-driven getMany tests go through
    // evaluateWith; direct-call here avoids the overhead of building a synthetic ErgoTree
    // wire blob just to exercise one branch of the handler. The direct call is still a valid
    // unit pin — the handler is a pure function of (ctx, obj, args).

    // Build a minimal AvlTree SValue from the get_many_all_present fixture's digest.
    // Any valid 33-byte digest works; the verifier will fail to reconstruct anyway
    // (garbage proof), and we only need a structurally sound AvlTreeData.
    const sample = fixture.entries.find((e) => e.name === 'get_many_all_present')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')
    // Digest is the first 33 bytes of the AvlTree constant in the fixture.
    // We use a fixed 33-byte array: 32 bytes of 0xdd + height byte 0x02 (h=2).
    // Height 2 is what h=2 fixtures carry; any value works for the empty-keys path.
    const digest = new Uint8Array(33)
    digest.fill(0xdd, 0, 32)
    digest[32] = 0x02 // height byte

    const treeObj = {
      kind: 'AvlTree' as const,
      value: {
        digest,
        treeFlags: 0x07, // all ops allowed
        keyLength: 32,
        valueLengthOpt: null as number | null,
      },
    }

    // Empty Coll[Coll[Byte]] keys argument.
    const emptyKeys = {
      kind: 'Coll' as const,
      elem: { tag: 'SColl' as const, elem: { tag: 'SByte' as const } },
      items: [] as Array<{ kind: 'Coll'; elem: { tag: 'SByte' }; items: [] }>,
    }

    // Garbage proof: 100 bytes of 0x00 — enough to trigger construct failure inside
    // BatchAVLVerifier but still satisfy the extractBytes shape check.
    // proofLen = 100 → createVerifier cost = 110 + 20*(Math.trunc(99/64)+1) = 110+40 = 150.
    const garbageProofItems = Array.from({ length: 100 }, () => ({ kind: 'Byte' as const, value: 0 }))
    const garbageProof = {
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: garbageProofItems,
    }

    const ctx = makeContext({})
    const result = evalSAvlTreeGetMany(ctx, treeObj, [emptyKeys, garbageProof])

    // Result: empty Coll[Option[Coll[Byte]]].
    expect(result).toEqual({
      kind: 'Coll',
      elem: { tag: 'SOption', elem: { tag: 'SColl', elem: { tag: 'SByte' } } },
      items: [],
    })

    // Cost: createVerifier only — no lookup charges (chargedOps(null, 0) = 0).
    // proofLen=100: chunks = Math.trunc(99/64)+1 = 2 → 110 + 20*2 = 150.
    expect(ctx.jitCost).toBe(110 + 20 * (Math.trunc((100 - 1) / 64) + 1))
    // Explicit: 150.
    expect(ctx.jitCost).toBe(150)
  })
})
