/**
 * F4 Task 7.5 — op-shape mismatch routing across the AvlTree Tier-2 family.
 *
 * Pins the scorex per-op shape semantics (JVM-canonical, verified twice):
 *
 * 1. scrypto 3.0.0 bytecode (coursier jar, decompiled 2026-06-07):
 *    `AuthenticatedTreeOps.returnResultOfOneOperation` is `Try { ... }`; the
 *    Try body opens with THREE requires —
 *      require(ByteArray.compare(key, NegativeInfinityKey) > 0)   // all-0x00 × keyLength
 *      require(ByteArray.compare(key, PositiveInfinityKey) < 0)   // all-0xFF × keyLength
 *      require(key.length == keyLength)
 *    — and modifyHelper's two write branches require
 *      require(value.length == fixedValueLength)  // "Value length is fixed and should be N"
 *    Any violation → IllegalArgumentException inside the Try → Failure AT THAT
 *    OP'S INDEX; `BatchAVLVerifier.performOneOperation` poisons topNode = None.
 * 2. ergo_avltree_rust (faithful port): authenticated_tree_ops.rs:226-229
 *    (`ensure!` triple) + :291/:314 (value-length); batch_avl_verifier.rs:157-172
 *    (Err → root = None → all subsequent ops fail, digest None).
 *
 * Consequence: a shape-violating op is NOT an upfront error — ops BEFORE it
 * replay normally; the bad op Fails at its index and joins each method's
 * existing per-op-failure routing (contains→false, get/getMany→throw
 * 'avl-tree-proof-failed', insert V<3→throw / V3+→None, update/iou→None,
 * remove→None with ALL ops still charged).
 *
 * Construct-shape class (same foreign-throw bug, different routing): scorex
 * `BatchAVLVerifier.reconstructedTree` (lazy, forced at construction) requires
 * keyLength > 0, fixed valueLength >= 0, digest.length == 33 BEFORE parsing —
 * all swallowed into topNode = None (construct-fail). These requires fire
 * BEFORE `rootNodeHeight = digest.last & 0xff` is assigned, so the JVM's
 * bv.treeHeight is 0 (field default) in this class — NOT digest[32]. Charged
 * lookups use nItems=0 (base-only at chunkSize 1); modify ops use max(0,1)=1.
 *
 * Pre-7.5 ergots threw `AvlVerifyError` (a FOREIGN, non-EvalError type) out of
 * `@ergots/avltree`'s upfront validation for both classes — and silently
 * tolerated ±inf keys (no layer checked them; a -inf lookup MATCHED the
 * sentinel leaf). All pins below assert the JVM-faithful behavior.
 *
 * Fixture tree (from savltree-insert.json insert_success_1_entry):
 *   digest 931febe9170def63e50b66e4f923a9af40ac80ee43342ebf4fde9f0d5d1fc45900
 *   (33 bytes, height byte digest[32] = 0x00), keyLength = 1, the EMPTY tree —
 *   its valid 8-byte proof 0200ff0000000004 is the -inf sentinel leaf
 *   (leaf 02, key 00, nextLeafKey ff, value-len 00000000, end 04). Lookups of
 *   any in-range key resolve "absent" against it; one insert of ([01],[01])
 *   replays successfully.
 */
import { describe, expect, it } from 'vitest'
import { makeContext } from '../../src/eval/eval-context'
import {
  evalSAvlTreeContains,
  evalSAvlTreeGet,
  evalSAvlTreeGetMany,
  evalSAvlTreeInsert,
  evalSAvlTreeInsertOrUpdate,
  evalSAvlTreeRemove,
  evalSAvlTreeUpdate,
} from '../../src/eval/savltree'
import { hexToBytes, captureEvalError } from '../_helpers'
import type { SValue, SType } from '../../src/mir/types'

// ---------------------------------------------------------------------------
// Shared fixture constants + SValue builders (direct-handler style, Task 7).
// ---------------------------------------------------------------------------

/** Empty tree (keyLength=1), height byte digest[32]=0x00. */
const EMPTY_TREE_DIGEST_HEX =
  '931febe9170def63e50b66e4f923a9af40ac80ee43342ebf4fde9f0d5d1fc45900'
/** Valid proof for the empty tree: -inf sentinel leaf + end-of-tree. */
const EMPTY_TREE_PROOF_HEX = '0200ff0000000004'

const SBYTE: SType = { tag: 'SByte' }
const SCOLL_BYTE: SType = { tag: 'SColl', elem: SBYTE }
const ENTRY_TUPLE: SType = { tag: 'STuple', items: [SCOLL_BYTE, SCOLL_BYTE] }

function collByte(bytes: number[] | Uint8Array): SValue {
  return {
    kind: 'Coll',
    elem: SBYTE,
    items: Array.from(bytes, (b) => ({ kind: 'Byte', value: ((b & 0xff) << 24) >> 24 })),
  }
}

function collCollByte(keys: (number[] | Uint8Array)[]): SValue {
  return { kind: 'Coll', elem: SCOLL_BYTE, items: keys.map(collByte) }
}

function entryColl(entries: [number[], number[]][]): SValue {
  return {
    kind: 'Coll',
    elem: ENTRY_TUPLE,
    items: entries.map(([k, v]) => ({
      kind: 'Tuple',
      items: [collByte(k), collByte(v)],
    })),
  }
}

function avlTreeObj(opts: {
  digest?: Uint8Array
  treeFlags: number
  keyLength?: number
  valueLengthOpt?: number | null
}): SValue {
  return {
    kind: 'AvlTree',
    value: {
      digest: opts.digest ?? hexToBytes(EMPTY_TREE_DIGEST_HEX),
      treeFlags: opts.treeFlags,
      keyLength: opts.keyLength ?? 1,
      valueLengthOpt: opts.valueLengthOpt ?? null,
    },
  }
}

const validProof = (): SValue => collByte(hexToBytes(EMPTY_TREE_PROOF_HEX))
/** 8 zero bytes — fails reconstruction (construct-fail) on any tree. */
const garbageProof8 = (): SValue => collByte(new Uint8Array(8))

/** 33-byte digest whose height byte digest[32] = 0x05 — for pinning that the
 * construct-shape class charges with treeHeight 0/max(0,1)=1, NOT digest[32]. */
function digestWithHeight5(): Uint8Array {
  const d = hexToBytes(EMPTY_TREE_DIGEST_HEX)
  d[32] = 0x05
  return d
}

const NONE_AVL: SValue = { kind: 'Option', elem: { tag: 'SAvlTree' }, value: null }

// ---------------------------------------------------------------------------
// contains — wrong-length / ±inf keys → false (never a foreign throw).
// ---------------------------------------------------------------------------

describe('SAvlTree.contains — op-shape mismatches (F4 T7.5)', () => {
  // Cost decomposition (direct handler; no envelope), valid 8-byte proof:
  //   createVerifier PerItem(110,20,64) on 8 → chunks trunc(7/64)+1 = 1 → 130
  //   LookupAvlTree PerItem(40,10,1) × 1 on RAW h = digest[32] = 0 →
  //     chunks trunc(-1/1)+1 = 0 → base only → 40
  //   TOTAL 170. Charge is outcome-independent (JVM charges before the op
  //   attempt; the require fails inside the attempt).
  it('wrong-length key (2 bytes vs keyLength=1) → false @170', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeContains(ctx, avlTreeObj({ treeFlags: 0 }), [
      collByte([0x01, 0x02]),
      validProof(),
    ])
    // scorex: require(key.length == keyLength) → Failure → JVM contains → false.
    // Pre-7.5: AvlVerifyError 'operation-key-length-mismatch' escaped.
    expect(result).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(170)
  })

  it('-inf key (all-0x00 of keyLength) → false @170 — NOT a sentinel-leaf match', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeContains(ctx, avlTreeObj({ treeFlags: 0 }), [
      collByte([0x00]),
      validProof(),
    ])
    // scorex: require(compare(key, NegativeInfinityKey) > 0) → Failure → false.
    // Pre-7.5 ergots DESCENDED: key == sentinel leaf key (0x00) matched →
    // returned TRUE — an accept-divergence, the sharpest red in this class.
    expect(result).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(170)
  })

  it('+inf key (all-0xFF of keyLength) → false @170', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeContains(ctx, avlTreeObj({ treeFlags: 0 }), [
      collByte([0xff]),
      validProof(),
    ])
    // scorex: require(compare(key, PositiveInfinityKey) < 0) → Failure → false.
    // (Pre-7.5 this happened to fail per-op via keyMatchesLeaf next-key bound —
    // same observable; the pin keeps it that way under the new pre-scan.)
    expect(result).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(170)
  })

  it('construct-shape: keyLength=0 → false; lookup charged at nItems=0 (NOT digest[32]) @170', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeContains(
      ctx,
      avlTreeObj({ treeFlags: 0, keyLength: 0, digest: digestWithHeight5() }),
      [collByte([0x01]), validProof()]
    )
    // scorex reconstructedTree: require(keyLength > 0) fires BEFORE
    // rootNodeHeight is assigned → swallow → topNode None (construct-fail);
    // bv.treeHeight stays 0 → Lookup charge 40 + 10×chunks(0)=40, NOT
    // 40 + 10×5 = 90 (digest[32] = 5 here, deliberately).
    //   cv(8) 130 + Lookup(h=0) 40 = 170
    // Pre-7.5: AvlVerifyError 'invalid-config-key-length' escaped.
    expect(result).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(170)
  })
})

// ---------------------------------------------------------------------------
// get — wrong-length / -inf keys → throw 'avl-tree-proof-failed'.
// ---------------------------------------------------------------------------

describe('SAvlTree.get — op-shape mismatches (F4 T7.5)', () => {
  it("wrong-length key → throw 'avl-tree-proof-failed' @170", () => {
    const ctx = makeContext({})
    const err = captureEvalError(() =>
      evalSAvlTreeGet(ctx, avlTreeObj({ treeFlags: 0 }), [
        collByte([0x01, 0x02]),
        validProof(),
      ])
    )
    // JVM get: Lookup Failure → syntax.error (CErgoTreeEvaluator.scala:106).
    // The shape-require Failure is indistinguishable from a proof failure.
    expect(err.code).toBe('avl-tree-proof-failed')
    // Charges precede the throw: cv 130 + Lookup(h=0) 40.
    expect(ctx.jitCost).toBe(170)
  })

  it("-inf key → throw 'avl-tree-proof-failed' @170 — NOT Some(sentinel value)", () => {
    const ctx = makeContext({})
    const err = captureEvalError(() =>
      evalSAvlTreeGet(ctx, avlTreeObj({ treeFlags: 0 }), [
        collByte([0x00]),
        validProof(),
      ])
    )
    // Pre-7.5 ergots matched the -inf sentinel leaf and returned Some("") —
    // a value fork vs the JVM's throw.
    expect(err.code).toBe('avl-tree-proof-failed')
    expect(ctx.jitCost).toBe(170)
  })
})

// ---------------------------------------------------------------------------
// getMany — mid-batch bad key: keys BEFORE it replay + charge; throw at it.
// ---------------------------------------------------------------------------

describe('SAvlTree.getMany — op-shape mismatches (F4 T7.5)', () => {
  it('mid-batch [goodKey, badKey] → throw; BOTH lookups charged (index arithmetic) @210', () => {
    const ctx = makeContext({})
    const err = captureEvalError(() =>
      evalSAvlTreeGetMany(ctx, avlTreeObj({ treeFlags: 0 }), [
        collCollByte([[0x01], [0x01, 0x02]]),
        validProof(),
      ])
    )
    // JVM keys.map replays key 0 against the proof (succeeds, absent), then
    // key 1 Fails its length require → syntax.error out of the map.
    // chargedOps = opsCompleted(1) + 1 = 2 lookups:
    //   cv(8) 130 + 2 × Lookup(h=0→ 40) = 210
    // (construct-fail would charge 1 lookup → 170; full success → 210 with a
    // Coll result — the throw + 210 pair pins the mid-batch index.)
    expect(err.code).toBe('avl-tree-proof-failed')
    expect(ctx.jitCost).toBe(210)
  })
})

// ---------------------------------------------------------------------------
// insert — V<3 throw / V3+ None; mid-batch prefix replays; value-length class.
// ---------------------------------------------------------------------------

describe('SAvlTree.insert — op-shape mismatches (F4 T7.5)', () => {
  // Mid-batch cost (valid 8-byte proof, h=0 → nItems = max(0,1) = 1):
  //   isInsertAllowed 15 + cv(8) 130 + 2 × InsertIntoAvlTree(40+10×1=50) = 245
  // Op 0 ([01],[01]) genuinely replays against the sentinel-leaf proof
  // (the proof is valid for exactly that insert); op 1's key fails its
  // length require at index 1 → chargedOps = 1 + 1 = 2.
  // (A bad op at index 0 would charge 1×50 → 195; full success of two
  // shape-clean ops would return Some — the None/throw + 245 pair pins the
  // mid-batch index arithmetic.)
  it("V0 mid-batch [goodEntry, badKeyEntry] → throw 'avl-tree-proof-failed' @245", () => {
    const ctx = makeContext({})
    const err = captureEvalError(() =>
      evalSAvlTreeInsert(ctx, avlTreeObj({ treeFlags: 0x01 }), [
        entryColl([
          [[0x01], [0x01]],
          [[0x01, 0x02], [0x01]],
        ]),
        validProof(),
      ])
    )
    // JVM V<3: insertRes.isFailure && !isV3OrLater → syntax.error
    // (CErgoTreeEvaluator.scala:150).
    expect(err.code).toBe('avl-tree-proof-failed')
    expect(ctx.jitCost).toBe(245)
  })

  it('V3 mid-batch [goodEntry, badKeyEntry] → None @245', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalSAvlTreeInsert(ctx, avlTreeObj({ treeFlags: 0x01 }), [
      entryColl([
        [[0x01], [0x01]],
        [[0x01, 0x02], [0x01]],
      ]),
      validProof(),
    ])
    // JVM V3+: forall breaks at the Failure → digest None → None.
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(245)
  })

  it('V3 wrong VALUE length (valueLengthOpt=1, 2-byte value) → None @195', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalSAvlTreeInsert(
      ctx,
      avlTreeObj({ treeFlags: 0x01, valueLengthOpt: 1 }),
      [entryColl([[[0x01], [0x01, 0x02]]]), garbageProof8()]
    )
    // scorex modifyHelper write-branch: require(value.length == 1) → Failure
    // at op 0 ("Value length is fixed and should be 1" — scrypto bytecode
    // $anonfun$returnResultOfOneOperation$4/$6; Rust :291/:314).
    //   15 + cv(8) 130 + 1 × Insert(40+10×1=50) = 195
    // Pre-7.5: AvlVerifyError 'operation-value-length-mismatch' escaped.
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(195)
  })

  it("V0 wrong VALUE length → throw 'avl-tree-proof-failed' @195", () => {
    const ctx = makeContext({})
    const err = captureEvalError(() =>
      evalSAvlTreeInsert(ctx, avlTreeObj({ treeFlags: 0x01, valueLengthOpt: 1 }), [
        entryColl([[[0x01], [0x01, 0x02]]]),
        garbageProof8(),
      ])
    )
    expect(err.code).toBe('avl-tree-proof-failed')
    expect(ctx.jitCost).toBe(195)
  })
})

// ---------------------------------------------------------------------------
// update — wrong-length key → None; construct-shape nItems pin.
// ---------------------------------------------------------------------------

describe('SAvlTree.update — op-shape mismatches (F4 T7.5)', () => {
  it('wrong-length key → None @285 (never throws)', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeUpdate(ctx, avlTreeObj({ treeFlags: 0x02 }), [
      entryColl([[[0x01, 0x02], [0x01]]]),
      validProof(),
    ])
    // JVM update: per-op Failure → forall break → digest None → None
    // (no version split). chargedOps = 0 + 1 = 1:
    //   isUpdateAllowed 15 + cv(8) 130 + 1 × Update(120+20×1=140) = 285
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(285)
  })

  it('construct-shape: keyLength=0 (digest[32]=5) → None; per-op nItems = max(0,1)=1 @285', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeUpdate(
      ctx,
      avlTreeObj({ treeFlags: 0x02, keyLength: 0, digest: digestWithHeight5() }),
      [entryColl([[[0x01], [0x01]]]), validProof()]
    )
    // Construct-fail (require(keyLength > 0) pre-parse) → treeHeight 0 →
    // nItems = max(0,1) = 1, NOT max(5,1) = 5 (which would be 365):
    //   15 + cv(8) 130 + 1 × Update(120+20×1=140) = 285
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(285)
  })
})

// ---------------------------------------------------------------------------
// remove — wrong-length key → None; ALL ops still charged (cfor, no break).
// ---------------------------------------------------------------------------

describe('SAvlTree.remove — op-shape mismatches (F4 T7.5)', () => {
  it('[absentKey, badKey] → None; ALL ops charged + unconditional digest @390', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeRemove(ctx, avlTreeObj({ treeFlags: 0x04 }), [
      collCollByte([[0x01], [0x01, 0x02]]),
      validProof(),
    ])
    // JVM remove: cfor attempts + charges EVERY op regardless of failures
    // (op 0 fails as remove-of-absent; op 1 would fail its length require);
    // digest_Info(15) unconditional; digest None → None. NEVER throws.
    //   isRemoveAllowed 15 + cv(8) 130 + 2 × Remove(100+15×1=115) + digest 15 = 390
    // Pre-7.5: AvlVerifyError escaped for the bad key.
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(390)
  })
})

// ---------------------------------------------------------------------------
// insertOrUpdate — wrong-length key → None.
// ---------------------------------------------------------------------------

describe('SAvlTree.insertOrUpdate — op-shape mismatches (F4 T7.5)', () => {
  it('wrong-length key → None @300', () => {
    const ctx = makeContext({ treeVersion: 3 })
    const result = evalSAvlTreeInsertOrUpdate(ctx, avlTreeObj({ treeFlags: 0x03 }), [
      entryColl([[[0x01, 0x02], [0x01]]]),
      validProof(),
    ])
    // JVM insertOrUpdate: per-op Failure → forall break → None. chargedOps = 1:
    //   isUpdateAllowed 15 + isInsertAllowed 15 + cv(8) 130
    //   + 1 × Update-descriptor(120+20×1=140) = 300
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// Wrapped-negative field pins (F4 T7.5 follow-up, 2026-06-07).
//
// JVM AvlTreeData.scala:84-85 parses keyLength and valueLengthOpt via
// getUInt().toInt — wire values in [2^31, 2^32) wrap negative.  scorex then
// fires require(keyLength > 0) / require(valueLength >= 0) → swallowed →
// topNode None (construct-fail).  ergots parses them as positive u32 (VLQ
// u32), so without the fix constructShapeBad never fires for that range.
//
// Fix (savltree.ts constructShapeBad): reinterpret both fields as i32 via
// `| 0` — `(data.keyLength | 0) <= 0` and
// `(data.valueLengthOpt | 0) < 0` — citing AvlTreeData.scala:84-88.
// ---------------------------------------------------------------------------

describe('SAvlTree.contains — wrapped-negative keyLength (F4 T7.5 follow-up)', () => {
  it('keyLength=0x80000000 (wraps to i32 ≤ 0) → false; h forced to 0 NOT digest[32]=5 @170', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeContains(
      ctx,
      avlTreeObj({ treeFlags: 0, keyLength: 0x80000000, digest: digestWithHeight5() }),
      [collByte([0x01]), validProof()]
    )
    // JVM: keyLength wraps to -2^31 via getUInt().toInt → require(keyLength > 0) fires
    // BEFORE rootNodeHeight is assigned → treeHeight stays 0 (field default).
    // Construct-shape: ergots fix `(data.keyLength | 0) <= 0` → true → h=0.
    //   cv(8B) PerItem(110,20,64) → trunc(7/64)+1=1 chunk → 130
    //   LookupAvlTree PerItem(40,10,1) × 1 on h=0 → trunc(-1/1)+1=0 chunks → 40
    //   TOTAL 170
    // Pre-fix (constructShapeBad miss): h=digest[32]=5 → Lookup 40+10×5=90 → TOTAL 220.
    // Pin is RED at 220 before the fix; GREEN at 170 after.
    expect(result).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(170)
  })
})

describe('SAvlTree.update — wrapped-negative valueLengthOpt (F4 T7.5 follow-up)', () => {
  it('valueLengthOpt=0x80000000 (wraps to i32 < 0) → None; h forced to 0 NOT digest[32]=5 @285', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeUpdate(
      ctx,
      avlTreeObj({
        treeFlags: 0x02,
        keyLength: 1,
        valueLengthOpt: 0x80000000,
        digest: digestWithHeight5(),
      }),
      [entryColl([[[0x01], [0x01]]]), garbageProof8()]
    )
    // JVM: valueLengthOpt wraps to -2^31 via getUInt().toInt → require(valueLength >= 0)
    // fires BEFORE rootNodeHeight assigned → treeHeight 0.
    // Construct-shape: ergots fix `(data.valueLengthOpt | 0) < 0` → true → h=0.
    //   isUpdateAllowed Fixed(15)
    //   cv(8B) → 130
    //   Update PerItem(120,20,1) × 1 on max(0,1)=1 → 120+20×1=140
    //   TOTAL 285
    // Pre-fix (constructShapeBad miss): h=digest[32]=5 → max(5,1)=5 →
    //   Update 120+20×5=220, TOTAL 15+130+220=365.
    // Pin is RED at 365 before the fix; GREEN at 285 after.
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(285)
  })
})

describe('SAvlTree.remove — wrapped-negative keyLength, h-discriminator (F4 T7.5 follow-up)', () => {
  it('keyLength=0x80000000 (digest[32]=5), 2 keys → None; per-op h=max(0,1)=1 NOT max(5,1)=5 @390', () => {
    const ctx = makeContext({})
    const result = evalSAvlTreeRemove(
      ctx,
      avlTreeObj({ treeFlags: 0x04, keyLength: 0x80000000, digest: digestWithHeight5() }),
      [collCollByte([[0x01], [0x02]]), garbageProof8()]
    )
    // JVM: keyLength wraps → construct-fail → treeHeight 0.
    // remove: cfor charges ALL ops (no break) + unconditional digest(15).
    //   isRemoveAllowed Fixed(15)
    //   cv(8B) → 130
    //   RemoveAvlTree PerItem(100,15,1) × 2 on max(0,1)=1 → 2×(100+15×1)=230
    //   digest Fixed(15)
    //   TOTAL 390
    // Pre-fix (constructShapeBad miss): h=5 → max(5,1)=5 →
    //   2×(100+15×5)=2×175=350, TOTAL 15+130+350+15=510.
    // Pin is RED at 510 before the fix; GREEN at 390 after.
    expect(result).toEqual(NONE_AVL)
    expect(ctx.jitCost).toBe(390)
  })
})

// ---------------------------------------------------------------------------
// Digest-length disjunct pin (F4 epilogue, 2026-06-07).
//
// updateDigest now accepts any-length bytes, so a 3-byte digest IS reachable
// from script via tree.updateDigest(Coll(1,2,3)).contains(...). The digest-
// length disjunct in constructShapeBad (`data.digest.length !== 33`) is now
// the load-bearing gate for Tier-2 verify ops on such trees.
//
// This is the FIRST direct pin of the digest-length disjunct: verifies that
// contains on a 3-byte-digest tree routes through constructShapeBad (h forced
// to 0) → false, at the same cost as any other construct-fail tree with h=0.
// ---------------------------------------------------------------------------

describe('SAvlTree.contains — 3-byte-digest tree (digest-length disjunct, F4 epilogue)', () => {
  it('3-byte digest → constructShapeBad fires → false; h=0 NOT digest[2] @170', () => {
    // Build a tree with a 3-byte digest (instead of the required 33).
    // updateDigest can produce such a tree since the F4 epilogue any-length bless.
    // Cost decomposition (direct handler, 8-byte valid proof):
    //   createVerifier PerItem(110,20,64) on 8 → chunks trunc(7/64)+1=1 → 130
    //   LookupAvlTree PerItem(40,10,1) × 1 on h=0 (constructShapeBad fires
    //     BEFORE rootNodeHeight assigned → treeHeight field stays 0) →
    //     chunks trunc(-1/1)+1=0 → 40
    //   TOTAL 170
    const threeByteDigest = new Uint8Array([0x01, 0x02, 0x05]) // last byte 5 would be h if 33 bytes
    const ctx = makeContext({})
    const result = evalSAvlTreeContains(
      ctx,
      avlTreeObj({ treeFlags: 0, keyLength: 1, digest: threeByteDigest }),
      [collByte([0x01]), validProof()]
    )
    // constructShapeBad: digest.length !== 33 → true → h=0.
    // If the disjunct were missing, h would be read from digest[32] (out of
    // bounds → undefined → 0 via & 0xff on undefined = 0; but the key point is
    // the construct-fail routing: without the disjunct the verifier is called
    // with a 3-byte digest and would throw a foreign AvlVerifyError).
    expect(result).toEqual({ kind: 'Boolean', value: false })
    expect(ctx.jitCost).toBe(170)
  })
})
