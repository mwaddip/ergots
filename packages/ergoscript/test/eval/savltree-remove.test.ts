/**
 * SAvlTree.remove (100:14) — Tier-2 verification op handler (JVM-canonical, F4).
 *
 * Source: CErgoTreeEvaluator.scala:230-254 (JVM), savltree.rs:279-337 (sigma-rust ref).
 *
 * Failure model (JVM-canonical, F4) — remove NEVER throws:
 *   - !remove_allowed → isRemoveAllowed Fixed(15) charged, return `Option None`.
 *   - verifier construct fail → verifier poisoned; per-op results discarded (cfor);
 *     digest None → `Option None` (NO throw — pre-F4 ergots threw; sigma-rust fork).
 *   - any per-op Remove fail → result discarded (cfor continues); digest None → `Option None`.
 *   - full success → `Some(AvlTree(new_digest))`.
 *
 * Pre-F4 ergots threw on both construct-fail and per-op-fail, matching sigma-rust's
 * `?`-on-construct fork (savltree.rs:316,322). F4 fixes this to match JVM; ergots leads.
 * The 'avl-tree-proof-failed' code is no longer reachable from remove.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalSAvlTreeRemove } from '../../src/eval/savltree'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts } from '../_helpers'

interface RemoveEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json: unknown
  expected_cost: number
}

interface RemoveFixture {
  corpus: string
  entries: RemoveEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-remove.json')
const fixture: RemoveFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.remove — fixture-driven', () => {
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

describe('SAvlTree.remove — construct-fail model (JVM: never-throws → None)', () => {
  it('returns None (not throw) when proof bytes are zeroed (construct fail)', () => {
    // JVM-canonical (F4): remove NEVER throws. Construct failure poisons the verifier;
    // per-op results are discarded (cfor, no break); digest() → None → None.
    // Pre-F4 ergots threw 'avl-tree-proof-failed' here — that was the sigma-rust fork.
    //
    // remove_success_1_key uses a length-100 proof: "0e64 03 85ab460a..."
    // Cost decomposition for zeroed-proof case (treeHeight=2, 1 op, proof 100 B):
    //   envelope(19) + isRemoveAllowed(15) + createVerifier(110+20×2=150)
    //   + RemoveAvlTree(100+15×2=130)×1 + digest_unconditional(15) = 329
    //   (no updateDigest(40) — construct fail → None before success path)
    const sample = fixture.entries.find((e) => e.name === 'remove_success_1_key')
    if (sample === undefined) throw new Error('test setup: missing fixture entry')
    const goodHex = sample.tree_bytes_hex
    const proofTagIdx = goodHex.indexOf('0e640385ab')
    if (proofTagIdx < 0) throw new Error('test setup: proof prefix not found')
    const proofBodyStart = proofTagIdx + 4
    const proofBodyLen = 100 * 2
    const mutated =
      goodHex.slice(0, proofBodyStart) +
      '00'.repeat(100) +
      goodHex.slice(proofBodyStart + proofBodyLen)
    const tree = parseTree(hexToBytes(mutated))
    const ctx = makeContext({})
    const result = evaluateWith(tree, ctx)
    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SAvlTree' }, value: null })
    expect(ctx.jitCost).toBe(329)
  })
})

// ---------------------------------------------------------------------------
// F4 Task 7 — construct-fail + empty-ops unit pins (unvectored class)
// ---------------------------------------------------------------------------

describe('SAvlTree.remove — F4 construct-fail + empty-ops pins', () => {
  // All pins use direct handler calls — no envelope overhead.
  // Precedent: getMany empty-keys pin in savltree-getmany.test.ts.
  //
  // Fixture source: remove_success_3_keys / remove_success_1_key
  //   digest: ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02
  //   height byte: digest[32] = 0x02 → h=2 → max(h,1)=2
  //   treeFlags: 4 (remove allowed)  keyLength: 1
  //   remove_success_1_key proof (100 bytes): 0385ab460a...0402

  it('pin 6 — ≥2-op construct-fail → ALL-ops charging discriminator (JVM cfor, no break)', () => {
    // HARD REQUIREMENT from Task-5 quality review: discriminate ALL-ops charging
    // from a chargedOps-based hypothetical regression (which would charge only 1).
    //
    // Remove uses cfor (no break): ALL ops are charged even after the verifier is
    // poisoned by a bad proof. With 3 keys + garbage proof:
    //   ops.length = 3, all 3 RemoveAvlTree charges fire regardless of verifier state.
    //
    // A hypothetical chargedOps regression (chargedOps(null, 3) = min(1,3) = 1)
    // would produce: 15+150+130+15 = 310.  The correct cost (ALL 3 ops) is 570.
    // This pin discriminates: the delta is 2×130 = 260 — cannot be accidentally equal.
    //
    // Cost decomposition (handler; no envelope):
    //   isRemoveAllowed Fixed(15)
    //   createVerifier PerItem(110,20,64) on proofLen=100:
    //     chunks = Math.trunc((100-1)/64)+1 = 1+1 = 2 → 110+40=150
    //   RemoveAvlTree PerItem(100,15,1) × ALL ops.length=3 on max(h=2,1)=2:
    //     each: 100+15×2=130 → 3×130=390
    //   digest_unconditional Fixed(15) (ALWAYS charged, even on failure)
    //   no updateDigest (None path — construct fail → digest None)
    //   TOTAL: 15 + 150 + 390 + 15 = 570
    //
    //   If a chargedOps regression charged min(1,3)=1 instead of 3, total would be 310.
    //   This discriminator catches that regression.
    const digest = hexToBytes('ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02')
    expect(digest.length).toBe(33)

    const treeObj = {
      kind: 'AvlTree' as const,
      value: { digest, treeFlags: 0x04, keyLength: 1, valueLengthOpt: null as number | null },
    }
    // 3 keys as Coll[Coll[Byte]]: key=[0x01], key=[0x02], key=[0x03]
    const makeKey = (b: number) => ({
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: [{ kind: 'Byte' as const, value: b }],
    })
    const threeKeysColl = {
      kind: 'Coll' as const,
      elem: { tag: 'SColl' as const, elem: { tag: 'SByte' as const } },
      items: [makeKey(0x01), makeKey(0x02), makeKey(0x03)],
    }
    // 100-byte garbage proof → construct fail
    const garbageProofColl = {
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: Array.from({ length: 100 }, () => ({ kind: 'Byte' as const, value: 0 })),
    }

    const ctx = makeContext({})
    const result = evalSAvlTreeRemove(ctx, treeObj, [threeKeysColl, garbageProofColl])

    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SAvlTree' }, value: null })
    // Exact cost: 15 + 150 + 3×130 + 15 = 570.
    // A chargedOps regression (min(1,3)=1) would give 310 — this pin catches it.
    expect(ctx.jitCost).toBe(570) // isRemoveAllowed(15) + cv(100→150) + ALL3×Remove(130) + digest(15)
  })

  // pin 7 — mid-batch per-op-fail via valid proof:
  // Not implementable with existing fixture data without generating a custom fixture.
  // The existing fixtures provide proofs for complete single-key or 3-key removal;
  // a "valid proof that covers key A but not key B, with ops=[A,B]" would require
  // a new fixture-gen scenario. The garbage-proof ≥2-op pin (6) above, combined
  // with the existing single-op construct-fail (329 = 1×Remove) and the fixture-
  // driven full-success entries (3-key = 3×Remove verified), adequately cover
  // the ALL-ops charging dimension for both construct-fail and per-op-fail:
  // remove's cfor has no break; whether ops fail at op 1 or op N, all N are charged.

  it('pin 8 — empty-keys + VALID proof → Some(starting digest), cost exact', () => {
    // With zero remove keys, the cfor body never executes.
    // verifyAvlBatchPartial(ops=[]) → { opsCompleted:0, newDigest:<starting digest>, results:[] }.
    // digest None branch not taken (verifier not poisoned; 0 ops = no failures) →
    // Some(AvlTree(starting digest)) + updateDigest(40).
    //
    // Source fixture: remove_success_1_key (proof 100 bytes, valid for this digest+config)
    //   digest: ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02
    //   proof hex (100 bytes): 0385ab460a6564d1e5ded17716cd5866650d7fbb9cada7fecabd5fe21e2f80e43a
    //                           02010200000008010101010101010100020300000008020202020202020203f830
    //                           3bddebd7a262a1e85dffdd76cf6c51c134f477485b8b307e88e67a9e14c1000004 02
    //
    // Cost decomposition (handler; no envelope):
    //   isRemoveAllowed Fixed(15)
    //   createVerifier PerItem(110,20,64) on proofLen=100:
    //     chunks = Math.trunc((100-1)/64)+1 = 1+1 = 2 → 110+40=150
    //   RemoveAvlTree × ALL ops.length=0 → 0 charges
    //   digest_unconditional Fixed(15) (ALWAYS charged, even here with 0 ops)
    //   updateDigest Fixed(40) on success
    //   TOTAL: 15 + 150 + 0 + 15 + 40 = 220
    const digestHex = 'ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02'
    // 100-byte proof from remove_success_1_key (bytes after "0e64" tag in fixture hex):
    const proofHex = '0385ab460a6564d1e5ded17716cd5866650d7fbb9cada7fecabd5fe21e2f80e43a' +
      '02010200000008010101010101010100020300000008020202020202020203f830' +
      '3bddebd7a262a1e85dffdd76cf6c51c134f477485b8b307e88e67a9e14c1000004' +
      '02'
    const digest = hexToBytes(digestHex)
    const proofBytes = hexToBytes(proofHex)
    expect(digest.length).toBe(33)
    expect(proofBytes.length).toBe(100)

    const treeObj = {
      kind: 'AvlTree' as const,
      value: { digest, treeFlags: 0x04, keyLength: 1, valueLengthOpt: null as number | null },
    }
    // Empty Coll[Coll[Byte]] — the shape extractByteArrayList expects.
    const emptyKeysColl = {
      kind: 'Coll' as const,
      elem: { tag: 'SColl' as const, elem: { tag: 'SByte' as const } },
      items: [] as never[],
    }
    const proofColl = {
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: Array.from(proofBytes, (b) => ({ kind: 'Byte' as const, value: (b << 24) >> 24 })),
    }

    const ctx = makeContext({})
    const result = evalSAvlTreeRemove(ctx, treeObj, [emptyKeysColl, proofColl])

    // Value: Some(AvlTree) with digest BYTE-EQUAL to the input starting digest
    // (0 remove ops → tree unchanged; verifyAvlBatchPartial returns starting digest).
    expect(result.kind).toBe('Option')
    if (result.kind !== 'Option' || result.value === null || result.value.kind !== 'AvlTree') {
      throw new Error('expected Some(AvlTree) but got a different shape')
    }
    expect(result.value.value.digest).toEqual(digest)

    // Exact cost: 15 + 150 + 0 + 15 + 40 = 220
    expect(ctx.jitCost).toBe(220) // isRemoveAllowed(15) + cv(100→150) + 0 ops + digest(15) + updateDigest(40)
  })
})
