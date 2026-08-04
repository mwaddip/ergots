import { describe, it, expect } from 'vitest'
import { BatchAVLProver } from '../src/batch-prover.js'
import { BatchAvlVerifier } from '../src/batch-verifier.js'
import { verifyAvlBatchPartial, type AvlTreeConfig } from '../src/index.js'

/**
 * Verifier ±infinity key gates (task 6g).
 *
 * Both references fail-and-poison any operation whose key is not STRICTLY
 * inside the sentinel bounds, at the shared op entry:
 *   - ergo_avltree_rust `authenticated_tree_ops.rs:267-268` @568e7c3
 *     (`ensure!(key > neg_inf)`, `ensure!(key < pos_inf)`)
 *   - scrypto 3.0.0 `AuthenticatedTreeOps.returnResultOfOneOperation`
 *     (same two requires, bytecode-verified; -inf = 0x00×keyLength,
 *     +inf = 0xFF×keyLength)
 *
 * Without the gates, a proof whose directions reach the −inf sentinel leaf
 * lets an out-of-bounds key MATCH that leaf: Lookup returns the sentinel's
 * dummy value, Update rewrites it, Remove deletes it — digests no reference
 * implementation can produce.
 *
 * Proofs here are honest prover output (generateProofForOperations of a
 * Lookup in the leftmost gap — its descent visits the −inf sentinel leaf);
 * only the keys handed to the verifier are adversarial. Neither reference
 * prover can generate proofs FOR these keys (their own gates reject them),
 * so no reference fixture can exist — same self-generated pattern as the
 * 6c/6d adversarial suites.
 */

/** Build a 2-key tree; return its digest and an honest proof whose descent
 * visits the −inf sentinel leaf (a Lookup in the gap between −inf and the
 * smallest real key). */
function treeWithSentinelPathProof(keyLength: number) {
  const prover = new BatchAVLProver(keyLength, null)
  const k1 = new Uint8Array(keyLength).fill(0x42)
  const k2 = new Uint8Array(keyLength).fill(0x77)
  prover.performOneOperation({ tag: 'Insert', key: k1, value: new Uint8Array([1]) })
  prover.performOneOperation({ tag: 'Insert', key: k2, value: new Uint8Array([2]) })
  const digest = prover.digest()
  const gapKey = new Uint8Array(keyLength)
  gapKey[keyLength - 1] = 0x01 // strictly between −inf and k1
  const gen = prover.generateProofForOperations([{ tag: 'Lookup', key: gapKey }])
  if (!gen.success) throw new Error('setup: lookup proof generation failed')
  return { digest, proof: gen.proof, k1 }
}

function isFailed(r: unknown): boolean {
  return typeof r === 'object' && r !== null && 'failed' in r
}

const config32: AvlTreeConfig = { keyLength: 32, valueLengthOpt: null }

describe('verifier ±inf key gates (authenticated_tree_ops.rs:267-268)', () => {
  it('Lookup at the −inf sentinel key fails the op instead of returning the sentinel dummy value', () => {
    const { digest, proof } = treeWithSentinelPathProof(32)
    const negInfKey = new Uint8Array(32) // all-0x00 = the −inf sentinel itself

    const r = verifyAvlBatchPartial(digest, proof, config32, [
      { tag: 'Lookup', key: negInfKey },
    ])

    expect(r).not.toBeNull()
    expect(r!.opsCompleted).toBe(0)
    expect(r!.results).toEqual([])
    expect(r!.newDigest).toEqual(digest)
  })

  it('Update at the −inf sentinel key fails instead of rewriting the sentinel leaf', () => {
    const { digest, proof } = treeWithSentinelPathProof(32)
    const negInfKey = new Uint8Array(32)

    const r = verifyAvlBatchPartial(digest, proof, config32, [
      { tag: 'Update', key: negInfKey, value: new Uint8Array([9, 9]) },
    ])

    expect(r).not.toBeNull()
    expect(r!.opsCompleted).toBe(0)
    // Without the gate the sentinel is rewritten and the digest moves to a
    // value no reference implementation can produce.
    expect(r!.newDigest).toEqual(digest)
  })

  it('Remove at the −inf sentinel key fails at the bounds gate, before the delete pass', () => {
    // On this proof shape the pre-gate code also failed — but deeper, as
    // 'proof-malformed' out of the delete-pass replay (measured in the 6g
    // review's neutralized run), not at any entry check. The references
    // never reach the walk at all: the op dies at the entry requires. Pin
    // the gate (not an incidental deep failure) via the failure reason.
    const { digest, proof } = treeWithSentinelPathProof(32)
    const v = new BatchAvlVerifier(digest, proof, config32)

    const r = v.performOneOperation({ tag: 'Remove', key: new Uint8Array(32) })

    expect(isFailed(r)).toBe(true)
    expect(v.lastFailReason).toBe('key-out-of-bounds')
  })

  it('sentinel bounds derive from config.keyLength, not a hardcoded 32', () => {
    const config8: AvlTreeConfig = { keyLength: 8, valueLengthOpt: null }
    const { digest, proof } = treeWithSentinelPathProof(8)

    // −inf side: gate presence at keyLength=8. (Presence only — a hardcoded
    // 32-byte −inf sentinel would ALSO reject 0x00×8 via the length tiebreak.)
    const r = verifyAvlBatchPartial(digest, proof, config8, [
      { tag: 'Lookup', key: new Uint8Array(8) },
    ])
    expect(r).not.toBeNull()
    expect(r!.opsCompleted).toBe(0)
    expect(r!.results).toEqual([])

    // +inf side: THE derivation discriminator (6g review I-2).
    // compareBytes(0xFF×8, 0xFF×32) = -1 via the length tiebreak, so a
    // hardcoded 32-byte +inf sentinel lets this key sail past the gate and
    // die deeper as 'leaf-key-out-of-order'; the config-derived sentinel
    // rejects it AT THE GATE.
    const v = new BatchAvlVerifier(digest, proof, config8)
    const rf = v.performOneOperation({
      tag: 'Lookup',
      key: new Uint8Array(8).fill(0xff),
    })
    expect(isFailed(rf)).toBe(true)
    expect(v.lastFailReason).toBe('key-out-of-bounds')
  })

  it('Lookup at the +inf sentinel key fails at the bounds gate, not on leaf ordering', () => {
    const { digest, proof } = treeWithSentinelPathProof(32)
    const v = new BatchAvlVerifier(digest, proof, config32)
    expect(v.isValid).toBe(true)

    const r = v.performOneOperation({
      tag: 'Lookup',
      key: new Uint8Array(32).fill(0xff),
    })

    expect(isFailed(r)).toBe(true)
    // Pre-gate this failed deeper in the walk as 'leaf-key-out-of-order';
    // the references reject it at op entry before any descent.
    expect(v.lastFailReason).toBe('key-out-of-bounds')
  })

  it('a key sorting below −inf (internal path, wrong length) fails at the bounds gate', () => {
    // Public wrappers throw on wrong-length keys (documented contract); the
    // internal engine must still be reference-shaped: lexicographically an
    // empty key sorts below −inf, so the −inf gate catches it exactly where
    // the references fail it.
    const { digest, proof } = treeWithSentinelPathProof(32)
    const v = new BatchAvlVerifier(digest, proof, config32)

    const r = v.performOneOperation({ tag: 'Lookup', key: new Uint8Array(0) })

    expect(isFailed(r)).toBe(true)
    expect(v.lastFailReason).toBe('key-out-of-bounds')
  })

  it('a bounds failure poisons the verifier like any op failure', () => {
    const { digest, proof, k1 } = treeWithSentinelPathProof(32)
    const v = new BatchAvlVerifier(digest, proof, config32)

    const first = v.performOneOperation({ tag: 'Lookup', key: new Uint8Array(32) })
    expect(isFailed(first)).toBe(true)
    expect(v.lastFailReason).toBe('key-out-of-bounds')
    // Poisoning must be directly observable (6g review I-1): digest() is
    // null iff root === null — Rust nulls root AND zeroes height
    // (batch_avl_verifier.rs:206-207 @568e7c3); scrypto nulls topNode.
    expect(v.digest()).toBeNull()
    expect(v.height).toBe(0)

    // Both references null the root on op failure; every later op fails,
    // and the poisoned-root guard's `??=` preserves the ORIGINAL reason.
    const second = v.performOneOperation({ tag: 'Lookup', key: k1 })
    expect(isFailed(second)).toBe(true)
    expect(v.lastFailReason).toBe('key-out-of-bounds')
  })
})
