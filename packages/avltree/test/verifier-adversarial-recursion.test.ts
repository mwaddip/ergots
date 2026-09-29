/**
 * Regression coverage for the label-path stack-overflow exposure that this
 * package used to share with the pre-`b785d0d` reference — CLOSED as of
 * this task — plus the digest-mismatch behavior a deep-but-otherwise-valid
 * proof gets now that decoding no longer overflows.
 *
 * A packed proof encoding a deep left spine — `LEAF` then depth ×
 * (`LABEL`, `INTERNAL` balance 0) — decodes fine (reconstruction is an
 * explicit-stack loop — proof-decode.ts::parseProofPackedTree's
 * explicit-stack reconstruction loop); the constructor's digest check then
 * calls `label(root)` (proof-decode.ts::parseProofPackedTree's digest-check
 * `label(root)` call). Before this task,
 * `label()`'s Internal arm recursed directly into its children once per
 * tree level (`node.ts`), and past an engine-dependent depth that recursion
 * overflowed the JS call stack — a `RangeError` ("Maximum call stack size
 * exceeded" on V8) escaped `verifyAvlBatch` as resource exhaustion, not a
 * verification verdict. This was documented as the verifier's single
 * engine-level carve-out from its no-throw contract (`facts/avltree.md`,
 * "No throws on verification failures").
 *
 * This task closed it: `label()`'s Internal arm now labels its children via
 * the module-private `labelSubtree` helper — an explicit heap-allocated
 * stack, ports `Node::label_subtree` (`batch_node.rs:130-157 @568e7c3`) —
 * instead of recursing directly, matching the reference's own `b785d0d`
 * fix. See `node.ts`'s `label()` JSDoc and
 * `docs/superpowers/specs/2026-08-04-avltree-label-iterative-design.md`.
 * Test 1 below now asserts the closure directly: the same depth-100,000
 * spine that used to overflow now decodes cleanly and reports an ordinary
 * digest-mismatch `null` — never a throw.
 *
 * This is NOT a claim that every recursive walk in this package is now
 * stack-bounded — only the label/digest-check path. `modifyHelper` /
 * `deleteHelper`'s per-operation descent (`modify.ts` / `delete.ts`) and
 * several prover-side walks (`containsLabel`, `packTree`, `deepCloneNode`,
 * `lookupWalk`, `removedNodes`' walk) are each independently recursive and
 * untouched by this task — see the design spec's "Out of scope" section;
 * they remain candidates for the whole-branch review. The reference's own
 * `b785d0d` fix was likewise label-only, so its `modify_helper` /
 * `delete_helper` recursion is presumably unchanged, and the JVM context
 * below still applies to that residual surface:
 *
 *  - No reference-corroborated bound exists to reject deep proofs earlier:
 *    the JVM script-eval path constructs its verifier with NO
 *    `maxNumOperations` (sigmastate-interpreter
 *    `CAvlTreeVerifier.scala:17-23` — four constructor args, so scrypto's
 *    node-count gate defaults off), exactly like `@ergots/ergoscript`'s
 *    `savltree.ts`. A TS-side cap would be an invented limit: if the
 *    reference's differently-sized stack survives a depth we reject, that
 *    is an accept/reject fork on the consensus path — worse than the crash
 *    it prevents. On the JVM, scrypto's `BatchAVLVerifier` wraps replay in
 *    `scala.util.Try`, which catches `NonFatal` only — `StackOverflowError`
 *    is a `VirtualMachineError` and escapes, so the JVM path — the
 *    canonical semantic reference — still shares whatever recursion-depth
 *    exposure remains on the non-label surfaces above.
 *
 * Callers feeding untrusted proofs who need crash-isolation on those
 * residual surfaces still have two contract-sanctioned options: set
 * `config.maxNumOperations` (activates the pre-reconstruction node-count
 * bound — the configuration ergo-node-rust uses) or catch `RangeError` at
 * their own boundary.
 *
 * @see facts/avltree.md — "No throws on verification failures"
 * @see packages/avltree/test/label-deep-spine.test.ts — the direct,
 *      unit-level `label()` regression for the same fix
 * @see .superpowers/sdd/2026-08-02-avltree-phase-b-prover-engine/task-6c-report.md
 *      ("Sweep finding, NOT fixed: unbounded recursion escapes as RangeError")
 */
import { describe, expect, it } from 'vitest'
import { verifyAvlBatch } from '../src/verify.js'
import { SPINE_CONFIG, buildSpineDigest, buildSpineProof } from './helpers/deep-spine.js'

describe('label-path stack exhaustion — closed by iterative subtree labeling', () => {
  it('a pathologically deep spine proof no longer overflows the stack — it decodes and reports a clean digest mismatch', () => {
    // 100_000 levels ≈ 3.4 MB of proof. PRE-fix, label() needed one native
    // stack frame per level and this depth reliably overflowed (this
    // package's vitest configs use pool: 'forks' — V8 default ≈ 1 MB stack,
    // overflow measured near depth 6.3e3; see the top-of-file comment for
    // the fix). POST-fix, label()'s Internal arm labels children via the
    // iterative labelSubtree helper — heap, not native stack — so depth no
    // longer costs a stack frame on this path.
    const proof = buildSpineProof(100_000)
    // Starting digest deliberately does NOT match the spine's real label
    // (all-zero vs. a blake2b-256 chain). This proves the decode path
    // itself now runs to completion (no throw) and falls through to the
    // ordinary digest-mismatch failure — not a vacuous "didn't get far
    // enough to compare" pass.
    const startingDigest = new Uint8Array(33)

    let result: ReturnType<typeof verifyAvlBatch> | undefined
    expect(() => {
      result = verifyAvlBatch(startingDigest, proof, SPINE_CONFIG, [])
    }).not.toThrow()
    expect(result).toBeNull()
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
