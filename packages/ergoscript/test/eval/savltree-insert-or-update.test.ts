/**
 * SAvlTree.insertOrUpdate (100:16) — V3-gated batch-InsertOrUpdate handler.
 *
 * Fixture-driven oracle suite (T11 of phase 2h-d, re-blessed in F4 Task 6).
 * Handler implementation lives at `src/eval/savltree.ts`.
 *
 * Scenario coverage (re-blessed costs per F4 JVM model):
 *   1. insert_or_update_happy_v3                — happy path; full-success batch returns Some(AvlTree(new_digest)), cost 719.
 *   2. insert_or_update_insert_allowed_false    — INSERT_ALLOWED bit clear → None (both flag charges + envelope = 49).
 *   3. insert_or_update_update_allowed_false    — UPDATE_ALLOWED bit clear → None (both flag charges + envelope = 49).
 *   4. insert_or_update_per_op_fail_graceful    — per-op fail under V3+ → None (519 = envelope+flags+cv+chargedOps).
 *   5. insert_or_update_malformed_proof         — construct fail → None (359; NOT a throw — JVM swallows construct errors).
 *   6. insert_or_update_v2_dispatcher_reject    — opts_json.treeVersion=2 → dispatcher rejects 'tree-version-too-low'.
 *
 * F4 value-class fix: entry 5 flipped from throw('avl-tree-proof-failed') →
 * None (JVM canonical: scorex BatchAVLVerifier swallows reconstruction errors;
 * broken verifier → every op returns Failure → forall breaks → digest None →
 * None). Pre-F4 ergots had the sigma-rust `?`-on-construct fork; ergots leads.
 *
 * Test uses the canonical multi-scenario template from
 * `test/eval/savltree-update-digest.test.ts:58-74`. Each entry branches on
 * `expected_error_code !== null`:
 *   - Throw branch: `captureEvalError` + `expect(err.code).toBe(...)`.
 *     Cost is NOT asserted on throw entries (fixture sentinel `expected_cost: 0`).
 *   - Success branch: assert value matches hydrated SValue + cost matches
 *     fixture-recorded `ctx.jitCost`.
 *
 * Source: CErgoTreeEvaluator.scala:196-228 (JVM-canonical cost model, F4).
 *         ergotree-interpreter/src/eval/savltree.rs:441-498 (reference).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseTree } from '../../src/wire/ergo-tree'
import { makeContext } from '../../src/eval/eval-context'
import { evaluateWith } from '../../src/eval/evaluate'
import { evalSAvlTreeInsertOrUpdate } from '../../src/eval/savltree'
import { hexToBytes, hydrateSValue, rehydrateEvalOpts, captureEvalError } from '../_helpers'
import { runMutationLoop, evalSafely, DEFAULT_KILL_THRESHOLD } from '../_helpers/mutation-harness'

interface InsertOrUpdateEntry {
  name: string
  tree_bytes_hex: string
  opts_json: Record<string, unknown>
  expected_value_json?: unknown
  expected_cost: number
  expected_error_code?: string | null
}
interface InsertOrUpdateFixture {
  corpus: string
  entries: InsertOrUpdateEntry[]
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, '../fixtures/eval/savltree-insert-or-update.json')
const fixture: InsertOrUpdateFixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

describe('SAvlTree.insertOrUpdate (100:16) — V3-gated, fixture-driven', () => {
  for (const entry of fixture.entries) {
    it(entry.name, () => {
      const tree = parseTree(hexToBytes(entry.tree_bytes_hex))
      const ctx = makeContext(rehydrateEvalOpts(entry.opts_json))
      if (entry.expected_error_code) {
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

describe('SAvlTree.insertOrUpdate — V3 dispatcher-gating cost parity', () => {
  // Parallel-pair cost-correctness invariant (mirrors SHeader.checkPow precedent
  // at sheader-checkpow.test.ts:66-103). The V<3 dispatcher reject must charge
  // EXACTLY receiver-eval + envelope cost, NOT the handler's per-handler cost.
  //
  // After F4, insertOrUpdate has per-handler costs: isUpdateAllowed_Info(15) +
  // isInsertAllowed_Info(15) + createVerifier + per-op + updateDigest. The V2
  // reject fires at the dispatcher BEFORE those handler costs accumulate. The
  // load-bearing assertion is: V2 reject cost < V3 success cost, and
  // specifically (v3 - v2) > 0.
  //
  // The V2 reject cost is the envelope cost: methodCall(4) + receiver Const +
  // args Consts, accumulated before the minVersion gate at method-call.ts:144.
  // The fixture's `expected_cost: 0` on the v2-reject entry is a sentinel (the
  // fixture-driven oracle test above skips cost assertion on throw entries);
  // the actual numeric cost-at-throw is asserted here instead.
  it('V2 reject incurs receiver-eval + envelope cost only, not the handler cost', () => {
    const v3Happy = fixture.entries.find((e) => e.name === 'insert_or_update_happy_v3')!
    const v2Reject = fixture.entries.find((e) => e.name === 'insert_or_update_v2_dispatcher_reject')!

    // Capture the V3 success cost (the pivot for the parallel-pair delta).
    const v3Tree = parseTree(hexToBytes(v3Happy.tree_bytes_hex))
    const v3Ctx = makeContext(rehydrateEvalOpts(v3Happy.opts_json))
    evaluateWith(v3Tree, v3Ctx)

    // Capture the V2 reject cost: evaluateWith throws but the EvalContext
    // accumulates cost up to the throw (cost-before-throw semantics from
    // 2h-c.2 dispatcher; see method-call.ts:116-150).
    const v2Tree = parseTree(hexToBytes(v2Reject.tree_bytes_hex))
    const v2Ctx = makeContext(rehydrateEvalOpts(v2Reject.opts_json))
    const err = captureEvalError(() => evaluateWith(v2Tree, v2Ctx))
    expect(err.code).toBe('tree-version-too-low')

    // V3 fixture-driven oracle: success cost matches F4 JVM model.
    expect(v3Ctx.jitCost).toBe(v3Happy.expected_cost)

    // Load-bearing assertion: the cost delta between V3 success and V2 reject
    // equals the handler's accumulated cost exactly:
    //   30 (isUpdateAllowed 15 + isInsertAllowed 15) + 150 (createVerifier,
    //   66 B proof → 2 chunks) + 3×160 (UpdateAvlTree 120+20×2, h=2) + 40
    //   (updateDigest) = 700.
    // If a regression moved handler costs before the dispatcher gate or made
    // the handler run on V<3, this exact delta shifts and reveals it.
    expect(v3Ctx.jitCost - v2Ctx.jitCost).toBe(700)

    // The V2 reject cost is exactly the pre-gate envelope: 4 (MethodCall) +
    // 5+5+5 (receiver + 2 arg Consts) = 19, charged before the dispatcher's
    // minVersion check fired. If the V<3 gate were moved BEFORE these
    // charges (or the handler ran), this exact pin fails and reveals it.
    expect(v2Ctx.jitCost).toBe(19)
  })
})

// ---------------------------------------------------------------------------
// Mutation testing (T13 — single-byte XOR mutations across tree_bytes_hex)
//
// Pattern mirrors `test/eval/savltree-update-operations.test.ts` (T4) and
// `test/eval/savltree-update-digest.test.ts` (T8): three XOR patterns per
// byte (0xFF, 0x01, 0x80); kill iff the mutated outcome observably diverges
// from the baseline. Same helpers (`evalSafely`, `svalueEqual`, `isKill`) and
// threshold (`THRESHOLD = 0.9`).
//
// Scope: ONLY the happy scenario (`insert_or_update_happy_v3`) is mutated.
// The other five scenarios are structurally incompatible with a mutation
// suite under THRESHOLD = 0.9:
//
//   - insert_allowed_false / update_allowed_false: handler pre-check returns
//     Option None when the receiver flag bit is clear (savltree.ts:672-677).
//     Mutations that DON'T alter the pre-check still return Option None →
//     survive. Most byte mutations to flags/keys/proof are downstream of the
//     pre-check and produce identical Option None output.
//   - per_op_fail_graceful: baseline returns Option None (verifier yields a
//     partial batch). Mutations that still produce a verifier-recognized
//     partial outcome continue to return Option None → survive.
//   - malformed_proof: baseline returns None (JVM-canonical post-F4; construct
//     fail → None, not a throw). Mutations that also yield a broken verifier
//     return None → survive under the "different error or value" kill rule.
//   - v2_dispatcher_reject: baseline throws 'tree-version-too-low' from the
//     dispatcher BEFORE the handler runs. Mutations to tree bytes don't
//     change opts_json.treeVersion, so the dispatcher still rejects → all
//     mutations survive trivially. Also: the v2_reject tree bytes are
//     byte-identical to happy_v3 (only opts_json differs), so mutating them
//     is redundant with the happy_v3 mutation surface.
//
// These five are already pinned by the fixture-driven oracle suite above.
// Per the T8 precedent and the user's recommendation in the task brief,
// happy-v3-only mutation is the correct scope.
//
// MUTATION SURFACE — happy scenario, 148-byte tree, FULL whole-tree:
//   - All 148 bytes are eligible (no excluded receiver-digest region).
//   - For insertOrUpdate, the receiver digest at offsets 5..37 inside the
//     SAvlTree Const is CONSUMED by the verifier as `startingDigest`
//     (savltree.ts:682: `verifyAvlBatchPartial(obj.value.digest, ...)`).
//     A flipped receiver digest produces either a verifier construct-fail
//     (throw 'avl-tree-proof-failed') or a successful verifier run with a
//     different output digest — either way a KILL. This is the opposite of
//     T8's updateDigest where the receiver digest is REPLACED by args[0]
//     and is therefore semantically invisible.
//
//   Mutation surface: 148 bytes × 3 patterns = 444 mutations.
//
// TOLERATED (survived) mutations — observed for insert_or_update_happy_v3
// (3 survivors out of 444 mutations; rate 441/444 = 0.993):
//   - offset 0 (header byte, 0x00), xor 0x01 → 0x01 (v1 header tag): parses
//     identically (no constants section to validate); body and evaluation
//     unchanged. Same tolerance as T4/T8 (universal across ergo-tree wire
//     fixtures with `0x00` header byte).
//   - offset 0 (header byte, 0x00), xor 0x80 → 0x80 (reserved bit set):
//     parser tolerates the reserved bit per the wire spec; body unchanged.
//     Same tolerance as T4/T8.
//   - offset 147 (last byte of proof, 0x08), xor 0x80 → 0x88 (bit 7 set):
//     this byte is the trailing byte of the inline 66-byte AVL proof Coll[Byte].
//     The AVL verifier consumes directions as a bit-string indexed by
//     `proof[i >> 3] & (1 << (i & 7))` (batch-verifier.ts:102), reading only
//     as many bits as the operations require. For the 3-op happy fixture, the
//     directions consumer doesn't reach bit 7 of the final byte — so that bit
//     is never inspected by the verifier and a flip is structurally invisible.
//     This is a property of the proof's directions bit-string ending mid-byte;
//     not a verifier bug and not a missed kill — bits past the consumed end
//     are simply unread. The xor 0xFF and xor 0x01 mutations at the same
//     offset DO kill (they flip the value within consumed bits or alter the
//     tree-shape byte the verifier replays).
// ---------------------------------------------------------------------------

describe('SAvlTree.insertOrUpdate — mutation testing', () => {
  const happyEntry = fixture.entries.find((e) => e.name === 'insert_or_update_happy_v3')
  if (happyEntry === undefined) {
    throw new Error('expected insert_or_update_happy_v3 entry in fixture')
  }

  it(`${happyEntry.name}: ≥${(DEFAULT_KILL_THRESHOLD * 100).toFixed(0)}% kill rate on whole-tree byte mutations`, () => {
    const treeBytes = hexToBytes(happyEntry.tree_bytes_hex)

    // Precondition: baseline must succeed for kill-rate math to be meaningful.
    const baseline = evalSafely(treeBytes, happyEntry.opts_json)
    expect(baseline.ok).toBe(true)

    const result = runMutationLoop({
      treeBytes,
      region: { start: 0, end: treeBytes.length },
      optsJson: happyEntry.opts_json,
    })

    // eslint-disable-next-line no-console
    console.log(
      `[mutation] insertOrUpdate.${happyEntry.name}: killed=${result.killed} ` +
        `total=${result.total} rate=${result.rate.toFixed(3)} bytes=${treeBytes.length}`,
    )
    expect(result.rate).toBeGreaterThanOrEqual(DEFAULT_KILL_THRESHOLD)
  })
})

// ---------------------------------------------------------------------------
// F4 Task 7 — construct-fail + empty-ops unit pins (unvectored class)
// ---------------------------------------------------------------------------

describe('SAvlTree.insertOrUpdate — F4 construct-fail + empty-ops pins', () => {
  // Direct handler calls — no envelope overhead.
  // Precedent: getMany empty-keys pin in savltree-getmany.test.ts.
  //
  // Fixture source: insert_or_update_happy_v3
  //   digest: ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02
  //   height byte: digest[32] = 0x02 → h=2 → max(h,1)=2
  //   treeFlags: 3 (insert+update allowed)  keyLength: 1
  //   proof (66 bytes): 030d3ba8e4d07b47d873efc37349712ca91b0f50e380a5467aded1e60b84b3e6ff
  //                      02020300000008020202020202020202ff00000008030303030303030300000408

  it('pin 9 — empty-ops + VALID proof → Some(starting digest), cost exact', () => {
    // With zero InsertOrUpdate entries, the forall loop never executes.
    // verifyAvlBatchPartial(ops=[]) → { opsCompleted:0, newDigest:<starting digest>, results:[] }.
    // opsCompleted(0) == ops.length(0) → success branch → updateDigest(40).
    // Result: Some(AvlTree) with digest BYTE-EQUAL to the input starting digest.
    //
    // Source fixture: insert_or_update_happy_v3 (proof 66 bytes, valid for this tree)
    //   digest: ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02
    //   h=2, treeFlags=3
    //
    // Cost decomposition (handler; no envelope, treeVersion=3 required):
    //   isUpdateAllowed_Info Fixed(15) — FIRST (CErgoTreeEvaluator.scala:199)
    //   isInsertAllowed_Info Fixed(15) — SECOND
    //   createVerifier PerItem(110,20,64) on proofLen=66:
    //     chunks = Math.trunc((66-1)/64)+1 = Math.trunc(65/64)+1 = 1+1 = 2
    //     → 110+40=150
    //   chargedOps(partial_success_0ops, 0) = 0 UpdateAvlTree charges
    //   updateDigest Fixed(40) on success
    //   TOTAL: 15 + 15 + 150 + 0 + 40 = 220
    const digestHex = 'ddaa12c7e5fd5ea2d7e017e50f51b2693f29fc5db8e4fdd0809792583fce11de02'
    // 66-byte proof from insert_or_update_happy_v3 (bytes after "0e42" tag in fixture hex):
    const proofHex = '030d3ba8e4d07b47d873efc37349712ca91b0f50e380a5467aded1e60b84b3e6ff' +
      '02020300000008020202020202020202ff00000008030303030303030300000408'
    const digest = hexToBytes(digestHex)
    const proofBytes = hexToBytes(proofHex)
    expect(digest.length).toBe(33)
    expect(proofBytes.length).toBe(66)

    const treeObj = {
      kind: 'AvlTree' as const,
      value: { digest, treeFlags: 0x03, keyLength: 1, valueLengthOpt: null as number | null },
    }
    // Empty Coll[Tuple[Coll[Byte], Coll[Byte]]] — the shape buildInsertOrUpdateOps expects.
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

    const ctx = makeContext({ treeVersion: 3 })
    const result = evalSAvlTreeInsertOrUpdate(ctx, treeObj, [emptyEntries, proofColl])

    // Value: Some(AvlTree) with digest BYTE-EQUAL to the starting digest (0 ops → no change).
    expect(result.kind).toBe('Option')
    expect(result.value).not.toBeNull()
    if (result.value !== null && result.value.kind === 'AvlTree') {
      expect(result.value.value.digest).toEqual(digest)
    } else {
      throw new Error('expected Some(AvlTree) but got a different shape')
    }

    // Exact cost: 15 + 15 + 150 + 0 + 40 = 220
    expect(ctx.jitCost).toBe(220) // isUpdate(15)+isInsert(15)+cv(66→150)+0 ops+updateDigest(40)
  })

  it('pin 10 — BOTH-flags-denied (treeFlags=0x00) → None @ exactly 30 (double charge)', () => {
    // From Task-6 quality review: the flags-deny path must charge BOTH isUpdateAllowed(15)
    // AND isInsertAllowed(15) before returning None — the blessed flags-deny cost of 73
    // (= envelope 43 + 30) pins the double charge in the fixture suite.
    // This direct-call pin verifies the same invariant without envelope overhead:
    //   jitCost starts at 0, handler charges isUpdate(15)+isInsert(15)=30, then returns None.
    //
    // If either flag charge were skipped (e.g. moved after the combined check), cost would be 15.
    // This pin catches that regression.
    //
    // Cost: isUpdateAllowed_Info Fixed(15) + isInsertAllowed_Info Fixed(15) = 30.
    // No createVerifier, no per-op, no updateDigest (flag check fails → early return).
    const treeObj = {
      kind: 'AvlTree' as const,
      value: {
        // treeFlags=0x00: neither insert (0x01) nor update (0x02) allowed
        digest: new Uint8Array(33), // arbitrary 33-byte array; height byte=0
        treeFlags: 0x00,
        keyLength: 1,
        valueLengthOpt: null as number | null,
      },
    }
    // Dummy args — never reached (handler returns None before consuming them)
    const dummyEntries = {
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
    const dummyProof = {
      kind: 'Coll' as const,
      elem: { tag: 'SByte' as const },
      items: [] as never[],
    }

    const ctx = makeContext({ treeVersion: 3 })
    const result = evalSAvlTreeInsertOrUpdate(ctx, treeObj, [dummyEntries, dummyProof])

    expect(result).toEqual({ kind: 'Option', elem: { tag: 'SAvlTree' }, value: null })
    // Exact cost: 30 — both flag charges fired before the combined check.
    expect(ctx.jitCost).toBe(30) // isUpdateAllowed(15) + isInsertAllowed(15) = 30
  })
})
