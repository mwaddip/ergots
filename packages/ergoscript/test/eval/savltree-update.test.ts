/**
 * SAvlTree.update (100:13) — Tier-2 verification op handler.
 *
 * Source (F4, JVM-canonical): CErgoTreeEvaluator.scala:166-194 update_eval.
 * Cost: isUpdateAllowed Fixed(15) charge-then-check + CreateAvlVerifier
 * PerItem(110,20,64) on proof.length + UpdateAvlTree PerItem(120,20,1)
 * × chargedOps on max(digest[32],1) + updateDigest Fixed(40) on success.
 *
 * Failure model (NOTE: diverges from `insert` — no V<3/V3+ split; update
 * NEVER throws):
 *   - !update_allowed → `Option None` after the flag charge, before any
 *     avltree call
 *   - construct fail AND per-op fail → `Option None` (the JVM swallows
 *     reconstruction failure; both surface as the forall breaking → digest
 *     None → None). Pre-F4 ergots threw on construct fail — that was the
 *     sigma-rust `?`-on-construct fork (savltree.rs:420).
 *   - full success → `Some(AvlTree(new_digest))`
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalSAvlTreeUpdate } from '../../src/eval/savltree'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface UpdateEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface UpdateFixture {
  corpus: string
  entries: UpdateEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-update.json')
const fixture: UpdateFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

/**
 * Carry-forward fixture from phase 2h-d (T14). Update has no V<3/V3+ split —
 * sigma-rust unconditionally graceful-breaks on per-op failure (savltree.rs:
 * 421-431). Schema mirrors the insert carry-forward (extended with
 * `expected_error_code: string | null`) for consistency, though for update
 * every entry's `expected_error_code` is null (success path returns
 * Option None — no throw counterpart exists).
 */
interface UpdatePartialEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface UpdatePartialFixture {
  corpus: string
  entries: UpdatePartialEntry[]
}

const updatePartialPath = join(__dirname, '../fixtures/eval/savltree-update-partial.json')
const updatePartialFixture: UpdatePartialFixture = JSON.parse(
  readFileSync(updatePartialPath, 'utf-8')
)

describe('SAvlTree.update — fixture-driven', () => {
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

describe('SAvlTree.update — construct-fail → None (JVM-canonical, F4)', () => {
  it('returns Option None when proof bytes are zeroed (construct fail) — never throws', () => {
    // JVM update never throws: scorex swallows construct failures (topNode=None);
    // every subsequent op returns Failure → forall breaks → digest None → None.
    // (CErgoTreeEvaluator.scala:178-186). Pre-F4 ergots threw on construct fail
    // (sigma-rust `?`-on-construct fork) — now closed. See F4 spec failure table.
    //
    // update_success_1_entry has a proof "0e55 03 0d3b ..." (length-85 proof).
    const sample = fixture.entries.find((e) => e.name === 'update_success_1_entry')
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
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual({ kind: 'Option', elem: { tag: 'SAvlTree' }, value: null })
    // Exact cost (JVM-canonical, F4) — envelope(19) + isUpdateAllowed(15) +
    // createVerifier(110+20×⌈85/64⌉ = 110+40 = 150) +
    // chargedOps(null,1)=1 × UpdateAvlTree(120+20×max(2,1)=160) + 0 updateDigest
    //   = 19 + 15 + 150 + 160 = 344
    // If cost is wrong here a cost-model regression has crept in on the construct-fail path.
    expect(ctx.jitCost).toBe(344) // 19+15+150+160
  })
})

// ---------------------------------------------------------------------------
// F4 Task 7 — construct-fail + empty-ops unit pins (unvectored class)
// ---------------------------------------------------------------------------

describe('SAvlTree.update — F4 construct-fail + empty-ops pins', () => {
  // Direct handler call — no wire tree, no envelope overhead, jitCost starts at 0.
  // Precedent: getMany empty-keys pin in savltree-getmany.test.ts.
  // Digest + proof bytes taken from `update_success_1_entry` (the only valid
  // update fixture with treeFlags=2 = update allowed).

  it('empty-ops + VALID proof → Some(tree with starting digest), cost exact (JVM-canonical)', () => {
    // With zero update entries, the op loop body never executes.
    // verifyAvlBatchPartial(ops=[]) → { opsCompleted:0, newDigest:<starting digest>, results:[] }.
    // opsCompleted(0) == ops.length(0) → success branch → updateDigest(40) fired.
    // Result: Some(AvlTree) whose digest BYTE-EQUALS the input tree's starting digest.
    //
    // Source fixture: update_success_1_entry
    //   digest: ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02
    //   height byte: digest[32] = 0x02 → h=2 → max(h,1)=2
    //   proof (85 bytes, hex): 030d3ba8e4d07b47d873efc37349712ca91b0f50e380a5467aded1e60b84b3e6ff
    //                           02020300000008020202020202020203f8303bddebd7a262a1e85dffdd76cf6c
    //                           51c134f477485b8b307e88e67a9e14c10000
    //   treeFlags: 2 (update allowed)
    //
    // Cost decomposition (handler cost; no envelope since direct call):
    //   isUpdateAllowed Fixed(15)
    //   createVerifier PerItem(110,20,64) on proofLen=85:
    //     chunks = Math.trunc((85-1)/64)+1 = Math.trunc(84/64)+1 = 1+1 = 2
    //     → 110 + 20×2 = 150
    //   chargedOps(partial, ops.length=0) = min(1,0) = 0 → 0 UpdateAvlTree charges
    //   updateDigest Fixed(40) on success
    //   TOTAL: 15 + 150 + 0 + 40 = 205
    const digestHex = 'ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02'
    const proofHex = '030d3ba8e4d07b47d873efc37349712ca91b0f50e380a5467aded1e60b84b3e6ff' +
      '02020300000008020202020202020203f8303bddebd7a262a1e85dffdd76cf6c' +
      '51c134f477485b8b307e88e67a9e14c100000402'
    const digest = hexToBytes(digestHex) // 33 bytes; digest[32]=0x02 (h=2)
    const proofBytes = hexToBytes(proofHex) // 85 bytes
    expect(digest.length).toBe(33)
    expect(proofBytes.length).toBe(85)

    const treeObj = {
      kind: 'AvlTree' as const,
      value: {
        digest,
        treeFlags: 0x02, // update allowed
        keyLength: 1,
        valueLengthOpt: null as number | null,
      },
    }
    // Empty Coll[Tuple[Coll[Byte], Coll[Byte]]] — the shape buildUpdateOps expects.
    const emptyEntries = {
      kind: 'Coll' as const,
      elem: {
        tag: 'STuple' as const,
        items: [
          { tag: 'SColl' as const, elem: { tag: 'SByte' as const } },
          { tag: 'SColl' as const, elem: { tag: 'SByte' as const } },
        ],
      },
      items: [] as never[],
    }
    const proofColl = {
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: Array.from(proofBytes, (b) => ({ kind: 'Byte' as const, value: (b << 24) >> 24 })),
    }

    const ctx = makeContext({})
    const result = evalSAvlTreeUpdate(ctx, treeObj, [emptyEntries, proofColl])

    // Value: Some(AvlTree) with digest BYTE-EQUAL to the input starting digest.
    // The verifier ran zero ops → newDigest = starting digest (tree unchanged).
    expect(result.kind).toBe('Option')
    expect(result.value).not.toBeNull()
    if (result.value !== null && result.value.kind === 'AvlTree') {
      expect(result.value.value.digest).toEqual(digest)
    } else {
      throw new Error('expected Some(AvlTree) but got a different shape')
    }

    // Exact cost: 15 + 150 + 0 + 40 = 205
    expect(ctx.jitCost).toBe(205) // isUpdateAllowed(15) + cv(85→150) + 0 ops + updateDigest(40)
  })
})

// ---------------------------------------------------------------------------
// Carry-forward from phase 2h-b (T14/T16 of 2h-d)
//
// The per-op-fail-graceful break path (savltree.ts:507-510) was implemented
// in 2h-b but lacked a committed fixture. T14 emitted a single carry-forward
// fixture targeting this gap. Unlike insert, update has no V<3/V3+ split —
// sigma-rust unconditionally graceful-breaks on per-op failure (savltree.rs:
// 421-431). Source-read confirmation: line 429 is `break;` without a
// tree_version check.
//
// Sigma-rust semantics: after the unconditional break, bv.digest() returns
// None (poisoned) and the handler returns Option None, NOT a Some(AvlTree)
// carrying a partial-state digest.
// ---------------------------------------------------------------------------

describe('SAvlTree.update — per-op-fail-graceful (carry-forward from 2h-b)', () => {
  for (const entry of updatePartialFixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      if (entry.expected_error_code !== null) {
        const err = captureEvalError(() => evaluateWith(tree, ctx))
        expect(err.code).toBe(entry.expected_error_code)
      } else {
        const value = evaluateWith(tree, ctx)
        expect(value).toEqual(hydrateSValue(entry.expected_value_json))
        expect(ctx.jitCost).toBe(entry.expected_cost)
      }
    })
  }
})
