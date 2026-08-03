/**
 * Documents the single engine-level carve-out from the verifier's no-throw
 * contract: resource exhaustion on a pathologically deep proof.
 *
 * A packed proof encoding a deep left spine — `LEAF` then depth ×
 * (`LABEL`, `INTERNAL` balance 0) — decodes fine (reconstruction is an
 * explicit-stack loop, `proof-decode.ts:200-206`), but the constructor's digest
 * check calls `label(root)` (`proof-decode.ts:297`), which recurses once per
 * internal level (`node.ts:196`). Past an engine-dependent depth the
 * recursion overflows the JS call stack and a `RangeError` ("Maximum call
 * stack size exceeded" on V8) escapes `verifyAvlBatch` — resource
 * exhaustion, not a verification verdict.
 *
 * This is deliberately NOT converted to a `null` rejection (see
 * `facts/avltree.md`, "No throws on verification failures" carve-out):
 *
 *  - Both references share the exposure. `ergo_avltree_rust` @191052c
 *    `label` recurses the same way (`batch_node.rs`) and the process aborts
 *    on stack exhaustion. On the JVM, scrypto's `BatchAVLVerifier` wraps
 *    replay in `scala.util.Try`, which catches `NonFatal` only —
 *    `StackOverflowError` is a `VirtualMachineError` and escapes.
 *  - No reference-corroborated bound exists to reject deep proofs earlier:
 *    the JVM script-eval path constructs its verifier with NO
 *    `maxNumOperations` (sigmastate-interpreter
 *    `CAvlTreeVerifier.scala:17-23` — four constructor args, so scrypto's
 *    node-count gate defaults off), exactly like `@ergots/ergoscript`'s
 *    `savltree.ts`. A TS-side cap would be an invented limit: if the
 *    reference's differently-sized stack survives a depth we reject, that
 *    is an accept/reject fork on the consensus path — worse than the crash
 *    it prevents.
 *
 * Callers feeding untrusted proofs who need crash-isolation have two
 * contract-sanctioned options: set `config.maxNumOperations` (activates the
 * pre-reconstruction node-count bound — the configuration ergo-node-rust
 * uses) or catch `RangeError` at their own boundary.
 *
 * @see facts/avltree.md — "No throws on verification failures"
 * @see .superpowers/sdd/2026-08-02-avltree-phase-b-prover-engine/task-6c-report.md
 *      ("Sweep finding, NOT fixed: unbounded recursion escapes as RangeError")
 */
import { describe, expect, it } from 'vitest'
import { verifyAvlBatch } from '../src/verify.js'
import { label, newInternal, newLabel, newLeaf } from '../src/node.js'
import type { AvlNode } from '../src/node.js'
import type { AvlTreeConfig } from '../src/types.js'

/**
 * Mirrors the exposed consensus path (`@ergots/ergoscript`'s `savltree.ts`):
 * no `maxNumOperations`, so the node-count DoS bound (`computeMaxNodes`) is
 * inactive and reconstruction size is limited only by the proof bytes.
 */
const SPINE_CONFIG: AvlTreeConfig = { keyLength: 1, valueLengthOpt: 1 }

const LEAF_KEY = 0x10
const LEAF_NEXT = 0x20
const LEAF_VALUE = 0xaa
const LABEL_FILL = 0x11

/**
 * Packed proof for a left spine of `depth` internal nodes over one leaf:
 * `LEAF`, then depth × (`LABEL`, `INTERNAL` balance 0), then END_OF_TREE.
 * Each INTERNAL token pops right = the just-pushed LABEL and left = the
 * subtree so far (`proof-decode.ts:281-283`), so the spine grows down the
 * LEFT — the side `label()` recurses into first. No direction bytes: no
 * operation runs in these tests. 4 + 34·depth + 1 bytes.
 */
function buildSpineProof(depth: number): Uint8Array {
  const out = new Uint8Array(4 + 34 * depth + 1)
  let i = 0
  out[i++] = 0x02 // LEAF token
  out[i++] = LEAF_KEY
  out[i++] = LEAF_NEXT
  out[i++] = LEAF_VALUE
  for (let d = 0; d < depth; d += 1) {
    out[i++] = 0x03 // LABEL token
    out.fill(LABEL_FILL, i, i + 32)
    i += 32
    out[i++] = 0x00 // INTERNAL token — the byte IS the balance (0)
  }
  out[i++] = 0x04 // END_OF_TREE
  return out
}

/**
 * Correct 33-byte starting digest for the same spine, built through the
 * public node constructors. Construction is iterative; the final `label()`
 * call recurses `depth` frames, so callers must stay under the engine
 * threshold (the control test's depth 1000 does — the 6c probe measured the
 * overflow boundary between depth 1e3 and 1e4 under plain Node).
 * The height byte is unread on this config path: the digest check compares
 * only the first 32 bytes (`proof-decode.ts:296-302`), and without
 * `maxNumOperations` no node bound consults the height.
 */
function buildSpineDigest(depth: number, heightByte: number): Uint8Array {
  let subtree: AvlNode = newLeaf(
    new Uint8Array([LEAF_KEY]),
    new Uint8Array([LEAF_VALUE]),
    new Uint8Array([LEAF_NEXT]),
  )
  for (let d = 0; d < depth; d += 1) {
    subtree = newInternal(subtree, newLabel(new Uint8Array(32).fill(LABEL_FILL)), 0)
  }
  const digest = new Uint8Array(33)
  digest.set(label(subtree), 0)
  digest[32] = heightByte
  return digest
}

describe('engine-level resource exhaustion — the single no-throw carve-out', () => {
  it('a pathologically deep spine proof escapes as a RangeError, not a null rejection', () => {
    // 100_000 levels ≈ 3.4 MB of proof. label() needs one stack frame per
    // level. This package's vitest configs use pool: 'forks' (child-process
    // main thread, V8 default ≈ 1 MB stack — overflow measured near depth
    // 6.3e3); a worker-threads pool would default to a 4 MB stack (overflow
    // near 2.5e4). Surviving 100k frames would need ≈ 16 MB of stack, which
    // no default engine or pool configuration provides.
    const proof = buildSpineProof(100_000)
    // Starting digest content is irrelevant here: the overflow fires while
    // COMPUTING label(root) for the comparison, before any byte is compared.
    const startingDigest = new Uint8Array(33)

    let caught: unknown
    try {
      verifyAvlBatch(startingDigest, proof, SPINE_CONFIG, [])
    } catch (e) {
      caught = e
    }
    // Anchored to both the class and the stack-overflow message (V8 says
    // "Maximum call stack size exceeded", SpiderMonkey "too much recursion")
    // so this cannot pass via newLabel's unrelated RangeError or any
    // AvlVerifyError.
    expect(caught, 'expected the deep spine to overflow the stack').toBeInstanceOf(RangeError)
    expect(String(caught)).toMatch(/call stack|too much recursion/i)
  })

  it('the same shape at depth 1000 with a matching digest is accepted — depth, not shape, is the trigger', () => {
    const depth = 1000
    const proof = buildSpineProof(depth)
    const startingDigest = buildSpineDigest(depth, 0xff)

    let result: ReturnType<typeof verifyAvlBatch> | undefined
    expect(() => {
      result = verifyAvlBatch(startingDigest, proof, SPINE_CONFIG, [])
    }).not.toThrow()
    // `?? null` so an unexecuted closure (result === undefined) cannot pass
    // the not-null assertion vacuously.
    expect(result ?? null, 'spine proof should verify at sub-threshold depth').not.toBeNull()
    expect(result?.newDigest.length).toBe(33)
    expect(result?.results).toEqual([])
  })
})
