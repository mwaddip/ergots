/**
 * SAvlTree.insert (100:12) — Tier-2 verification op handler.
 *
 * Source (F4, JVM-canonical): CErgoTreeEvaluator.scala:132-164 insert_eval.
 * Cost: isInsertAllowed Fixed(15) charge-then-check + CreateAvlVerifier
 * PerItem(110,20,64) on proof.length + InsertIntoAvlTree PerItem(40,10,1)
 * × chargedOps on max(digest[32],1) + updateDigest Fixed(40) on success.
 *
 * Failure model (construct fail is NOT a distinct observable — it manifests
 * as the first op failing; the JVM swallows reconstruction failure):
 *   - !insert_allowed → `Option None` after the flag charge
 *   - op fail (incl. construct fail) at V<3 with ≥1 op attempted → throw
 *     'avl-tree-proof-failed' (JVM syntax.error, gated
 *     !isV3OrLaterErgoTreeVersion)
 *   - op fail at V3+ → `Option None` via poisoned digest; 0-ops construct
 *     fail → None at EVERY version (empty forall never reaches the throw)
 *   - full success → `Some(AvlTree(new_digest))`
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalSAvlTreeInsert } from '../../src/eval/savltree'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'

interface InsertEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface InsertFixture {
  corpus: string
  entries: InsertEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-insert.json')
const fixture: InsertFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

/**
 * Carry-forward fixtures from phase 2h-d (T14). The V3+ graceful break path
 * and V<3 throw hardening path share a single fixture shape; both use
 * `expected_error_code: string | null` to distinguish success/throw entries.
 */
interface InsertPartialEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
  expected_error_code: string | null
}

interface InsertPartialFixture {
  corpus: string
  entries: InsertPartialEntry[]
}

const insertPartialPath = join(__dirname, '../fixtures/eval/savltree-insert-partial.json')
const insertPartialFixture: InsertPartialFixture = JSON.parse(
  readFileSync(insertPartialPath, 'utf-8')
)

const insertPartialV2ThrowPath = join(
  __dirname,
  '../fixtures/eval/savltree-insert-partial-v2-throw.json'
)
const insertPartialV2ThrowFixture: InsertPartialFixture = JSON.parse(
  readFileSync(insertPartialV2ThrowPath, 'utf-8')
)

describe('SAvlTree.insert — fixture-driven', () => {
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

describe('SAvlTree.insert — throw paths', () => {
  it('throws avl-tree-proof-failed when proof bytes are zeroed (construct fail) — V0 default', () => {
    // Reuse insert_success_1_entry — the proof Const is "0e08 02 00ff 00000000"
    // (tag 0e = SColl Byte, len 0x08 = 8, then 8 bytes). Zero the 8 proof
    // body bytes to force a construct-time failure (the root header byte 0x02
    // tells reconstruct_tree to expect a packed-tree InternalWithLabel; zeroing
    // it yields a LabelOnly node with no label — fails the start-digest match).
    const sample = fixture.entries.find((e) => e.name === 'insert_success_1_entry')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')
    const goodHex = sample.tree_bytes_hex
    // Proof Const tag = "0e08" near end. Find it as the last occurrence.
    const tagIdx = goodHex.lastIndexOf('0e08')
    if (tagIdx < 0) throw new Error('test setup: proof tag not found')
    const proofBodyStart = tagIdx + 4
    const proofBodyLen = 8 * 2
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(8) +
      goodHex.slice(proofBodyStart + proofBodyLen)
    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const err = captureEvalError(() => evaluateWith(tree, ctx))
    expect(err.code).toBe('avl-tree-proof-failed')
  })

  it('V3+ partial-success path: insert with insert_allowed and treeVersion=3 — fixture full-success still works', () => {
    // This test confirms the V3 branch is NOT broken by the survey-noted V3
    // partial-success semantics: a full-success input under V3 still returns
    // Some(AvlTree). The break path (per-op fail under V3) isn't exercised
    // here because we lack a "V3-per-op-fail" fixture (would require fixture-
    // gen to set treeVersion=3, and the V3 break returns Option None which
    // is reachable only via a deliberately-bad proof + insert_allowed).
    //
    // The point of this test: confirm the V3 path doesn't accidentally throw
    // on full-success input (i.e., we read `ctx.treeVersion` correctly and
    // pass through to the verifier).
    const sample = fixture.entries.find((e) => e.name === 'insert_success_1_entry')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')
    const tree = parseTree(hexToBytes(sample.tree_bytes_hex))
    // Force treeVersion=3 even if the tree's header version is lower; the
    // V3+ break is gated by ctx.treeVersion which evaluate() seeds from
    // tree.header.version when not explicitly set.
    const ctx = makeContext({ treeVersion: 3 })
    const value = evaluateWith(tree, ctx)
    expect(value).toEqual(hydrateSValue(sample.expected_value_json))
  })
})

// ---------------------------------------------------------------------------
// Carry-forward from phase 2h-b (T14/T15 of 2h-d)
//
// The V3+ per-op-fail-graceful break path (savltree.ts:446-460) was implemented
// in 2h-b but lacked a committed fixture. T14 emitted two carry-forward
// fixtures targeting this gap:
//   - savltree-insert-partial.json: V3+ graceful — handler returns
//     Option None (not Some(AvlTree(partial))) via the break-to-None branch.
//   - savltree-insert-partial-v2-throw.json: V<3 hardening — same proof bytes
//     under treeVersion=0 must throw 'avl-tree-proof-failed' (the V<3 branch
//     at savltree.rs:263-267 propagates per-op failures as errors).
//
// Sigma-rust semantics (savltree.rs:495-497): bv.digest() is poisoned to None
// after a per-op fail under V3+; the handler returns Option None, NOT a
// Some(AvlTree) carrying a partial-state digest. This is the load-bearing
// invariant the V3+ test exercises.
// ---------------------------------------------------------------------------

describe('SAvlTree.insert — V3+ per-op-fail-graceful (carry-forward from 2h-b)', () => {
  for (const entry of insertPartialFixture.entries) {
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

describe('SAvlTree.insert — V<3 per-op-fail-throw (hardening, carry-forward from 2h-b audit)', () => {
  for (const entry of insertPartialV2ThrowFixture.entries) {
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

// ---------------------------------------------------------------------------
// F4 Task 7 — construct-fail + empty-ops unit pins (unvectored class)
// ---------------------------------------------------------------------------

describe('SAvlTree.insert — F4 construct-fail + empty-ops pins', () => {
  // All three pins use direct handler calls — no envelope overhead.
  // Precedent: getMany empty-keys pin in savltree-getmany.test.ts.
  //
  // Fixture source: insert_success_1_entry
  //   digest: 931febe9170def63e50b66e4f923a9af40ac80ee43342ebf4fde9f0d5d1fc45900
  //   height byte: digest[32] = 0x00 → h=0 → max(h,1)=1
  //   proof (8 bytes): 0200ff0000000004  (= bytes after tag "0e08" in fixture hex)
  //   treeFlags: 1 (insert allowed)  keyLength: 1

  it('pin 3 — V3 construct-fail (≥1 op) → None, not throw (JVM-canonical)', () => {
    // JVM insert V3+: forall breaks on first op failure → digest None → None.
    // Construct-fail = first-op-fail (scorex swallows reconstruction errors;
    // broken verifier → every op fails immediately). So V3 + garbage proof +
    // ≥1 op → None, never throws.  Cost: flag(15) + cv(8→130) + 1×Insert(40+10×1=50) + 0.
    // (The existing V0 test in "throw paths" already pins V0 construct-fail → throw.)
    //
    // Cost decomposition (handler; no envelope):
    //   isInsertAllowed Fixed(15)
    //   createVerifier PerItem(110,20,64) on proofLen=8:
    //     chunks = Math.trunc((8-1)/64)+1 = 0+1 = 1 → 110+20=130
    //   chargedOps(null, ops.length=1) = min(1,1) = 1 → InsertIntoAvlTree(40+10×max(0,1)=50)×1
    //   no updateDigest (failure path)
    //   TOTAL: 15 + 130 + 50 = 195
    const digestHex = '931febe9170def63e50b66e4f923a9af40ac80ee43342ebf4fde9f0d5d1fc45900'
    // (The valid proof for this tree is 0200ff0000000004 — unused here.)
    const digest = hexToBytes(digestHex)
    // Garbage proof (8 bytes of zeros) to force construct failure:
    const garbageProof = new Uint8Array(8) // all zeros
    expect(digest.length).toBe(33)

    const treeObj = {
      kind: 'AvlTree' as const,
      value: { digest, treeFlags: 0x01, keyLength: 1, valueLengthOpt: null as number | null },
    }
    // One insert entry: key=[0x01], value=[0x01] — Coll[Tuple[Coll[Byte],Coll[Byte]]]
    const oneEntry = {
      kind: 'Coll' as const,
      elem: {
        tag: 'STuple' as const,
        items: [
          { tag: 'SColl' as const, elem: { tag: 'SByte' as const } },
          { tag: 'SColl' as const, elem: { tag: 'SByte' as const } },
        ],
      },
      items: [
        {
          kind: 'Tuple' as const,
          items: [
            { kind: 'Coll' as const, elem: { tag: 'SByte' as const }, items: [{ kind: 'Byte' as const, value: 0x01 }] },
            { kind: 'Coll' as const, elem: { tag: 'SByte' as const }, items: [{ kind: 'Byte' as const, value: 0x01 }] },
          ],
        },
      ],
    }
    const garbageProofColl = {
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: Array.from(garbageProof, () => ({ kind: 'Byte' as const, value: 0 })),
    }

    const ctx = makeContext({ treeVersion: 3 })
    const result = evalSAvlTreeInsert(ctx, treeObj, [oneEntry, garbageProofColl])

    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SAvlTree' }, value: null })
    // Exact cost: 15 + 130 + 50 = 195
    expect(ctx.jitCost).toBe(195) // isInsertAllowed(15) + cv(8→130) + 1×Insert(50)
  })

  it('pin 4 — V0 + empty ops + garbage proof → None (not throw) at every version', () => {
    // JVM insert: "when the tree is empty we still need to add the insert cost"
    // (CErgoTreeEvaluator.scala:139 comment). But with ops.length=0, the forall
    // body NEVER executes — the V<3 throw is inside the forall body (after per-op
    // failure). An empty forall has no iteration, so even a construct-broken
    // verifier cannot reach the throw path → returns None at EVERY version.
    //
    // spec: "ops.length === 0: empty forall never runs; even a construct failure
    // cannot surface → digest → None at every version." (F4 spec failure table row)
    //
    // This pin uses V0 (makeContext({})) to confirm the zero-ops carve-out overrides
    // the V<3 throw. If the handler incorrectly checked version BEFORE ops.length,
    // it would throw for V0 — this pin would fail and reveal the regression.
    //
    // Cost decomposition (handler; no envelope):
    //   isInsertAllowed Fixed(15)
    //   createVerifier PerItem(110,20,64) on proofLen=100 (garbage):
    //     chunks = Math.trunc((100-1)/64)+1 = 1+1 = 2 → 110+40=150
    //   chargedOps(null, ops.length=0) = min(1,0) = 0 → 0 InsertIntoAvlTree charges
    //   no updateDigest (failure path — verifier poisoned, digest None)
    //   TOTAL: 15 + 150 + 0 = 165
    const digest = hexToBytes('931febe9170def63e50b66e4f923a9af40ac80ee43342ebf4fde9f0d5d1fc45900')
    const treeObj = {
      kind: 'AvlTree' as const,
      value: { digest, treeFlags: 0x01, keyLength: 1, valueLengthOpt: null as number | null },
    }
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
    const garbageProofColl = {
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: Array.from({ length: 100 }, () => ({ kind: 'Byte' as const, value: 0 })),
    }

    const ctx = makeContext({}) // V0 — the most restrictive version
    const result = evalSAvlTreeInsert(ctx, treeObj, [emptyEntries, garbageProofColl])

    // Must return None, NOT throw — even in V0. Zero-ops carve-out overrides V<3 throw.
    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SAvlTree' }, value: null })
    // Exact cost: 15 + 150 + 0 = 165
    expect(ctx.jitCost).toBe(165) // isInsertAllowed(15) + cv(100→150) + 0 ops
  })

  it('pin 5 — empty-ops + VALID proof → Some(starting digest), cost exact', () => {
    // With zero insert entries, verifyAvlBatchPartial(ops=[]) runs 0 ops →
    // newDigest = starting digest → success → updateDigest(40) fired.
    // Result: Some(AvlTree) with digest BYTE-EQUAL to the input starting digest.
    //
    // Source fixture: insert_success_1_entry (proof 8 bytes, valid for this tree)
    //   digest: 931febe9170def63e50b66e4f923a9af40ac80ee43342ebf4fde9f0d5d1fc45900
    //   height byte: digest[32] = 0x00 → h=0 → max(h,1)=1 (floor applied for insert)
    //   proof hex (8 bytes): 0200ff0000000004
    //   treeFlags: 1 (insert allowed)
    //
    // Cost decomposition (handler; no envelope):
    //   isInsertAllowed Fixed(15)
    //   createVerifier PerItem(110,20,64) on proofLen=8:
    //     chunks = Math.trunc((8-1)/64)+1 = 0+1 = 1 → 110+20=130
    //   chargedOps(partial_success_0ops, 0) = 0 InsertIntoAvlTree charges
    //   updateDigest Fixed(40) on success
    //   TOTAL: 15 + 130 + 0 + 40 = 185
    const digestHex = '931febe9170def63e50b66e4f923a9af40ac80ee43342ebf4fde9f0d5d1fc45900'
    const proofHex = '0200ff0000000004' // 8-byte proof from insert_success_1_entry
    const digest = hexToBytes(digestHex)
    const proofBytes = hexToBytes(proofHex)
    expect(digest.length).toBe(33)
    expect(proofBytes.length).toBe(8)

    const treeObj = {
      kind: 'AvlTree' as const,
      value: { digest, treeFlags: 0x01, keyLength: 1, valueLengthOpt: null as number | null },
    }
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
    const result = evalSAvlTreeInsert(ctx, treeObj, [emptyEntries, proofColl])

    // Value: Some(AvlTree) with digest BYTE-EQUAL to starting digest (0 ops → no change).
    expect(result.kind).toBe('Option')
    if (result.kind !== 'Option' || result.value === null || result.value.kind !== 'AvlTree') {
      throw new Error('expected Some(AvlTree) but got a different shape')
    }
    expect(result.value.value.digest).toEqual(digest)

    // Exact cost: 15 + 130 + 0 + 40 = 185
    expect(ctx.jitCost).toBe(185) // isInsertAllowed(15) + cv(8→130) + 0 ops + updateDigest(40)
  })
})
