/**
 * StrictBatchAVLVerifier (0.6.0) — a step-by-step verifier that can also say
 * whether the proof it replayed is exactly the proof a prover writes for the
 * operations performed. TS-only: neither ergo_avltree_rust @568e7c3 nor
 * scrypto 3.0.0 has a counterpart.
 *
 * NOT Ergo consensus. Ergo's references accept proofs this check rejects (a
 * proof with trailing bytes, for one), so no Ergo path may use this class.
 * It exists for networks whose full nodes regenerate each proof and compare
 * it byte for byte. BatchAVLVerifier and the batch functions (verify.ts) are
 * the reference-faithful surface, and nothing here runs on their paths.
 *
 * See facts/avltree.md § StrictBatchAVLVerifier for the guarantee and its
 * conditions.
 */

import { VerifierCore } from './batch-verifier.js'
import { matchesCanonicalProof } from './canonical-proof.js'
import type { AvlTreeOpsCallbacks } from './avl-tree-ops.js'
import type { ProverOperationResult } from './batch-prover.js'
import type { AvlVerifyFailReason } from './errors.js'
import type { AvlNode, LeafNode } from './node.js'
import type { Operation } from './operation.js'
import type { AvlTreeConfig } from './types.js'

/**
 * VerifierCore, plus a record of what the replay touched: the tree as the
 * proof decoded it, every node the engine visits, and where the directions
 * begin. Internal.
 *
 * It relies on one property of VerifierCore's constructor: it calls no
 * overridable method. This class's fields are initialized only after
 * `super()` returns, so an override reached from that constructor would see
 * them unset.
 */
class RecordingVerifierCore extends VerifierCore {
  /** The root as decoded from the proof; null when decoding or anchoring failed. */
  private readonly decodedRoot: AvlNode | null
  /** The bit after END_OF_TREE, where this proof's directions begin. */
  private readonly directionsStartBit: number
  private readonly valueLengthOpt: number | null
  /**
   * Every node the engine visited, by identity — what the prover's
   * `modifiedNodes` holds (batch-prover.ts), fed by the same `onNodeVisit`
   * calls. Nodes the replay created are recorded too; only decoded nodes are
   * ever looked up.
   */
  private readonly visited = new Set<AvlNode>()

  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig) {
    super(startingDigest, proof, config)
    this.decodedRoot = this.root
    this.directionsStartBit = this.state.directionsIndex
    this.valueLengthOpt = config.valueLengthOpt
  }

  /** The parent's callbacks, with `onNodeVisit` recording instead of doing nothing. */
  protected override buildCallbacks(onLeaf?: (leaf: LeafNode, matches: boolean) => void): AvlTreeOpsCallbacks {
    const visited = this.visited
    return {
      ...super.buildCallbacks(onLeaf),
      onNodeVisit: (node: AvlNode) => {
        visited.add(node)
      },
    }
  }

  /**
   * Whether the proof is exactly what a prover writes for the operations
   * performed so far. False once poisoned.
   */
  isFullyConsumed(): boolean {
    if (this.root === null || this.decodedRoot === null) return false
    return matchesCanonicalProof(
      this.proof,
      this.decodedRoot,
      this.visited,
      this.valueLengthOpt,
      this.directionsStartBit,
      this.state.directionsIndex,
    )
  }
}

/** A step-by-step verifier that can say whether its proof was consumed exactly. */
export class StrictBatchAVLVerifier {
  private readonly core: RecordingVerifierCore

  constructor(startingDigest: Uint8Array, proof: Uint8Array, config: AvlTreeConfig) {
    this.core = new RecordingVerifierCore(startingDigest, proof, config)
  }

  performOneOperation(op: Operation): ProverOperationResult {
    const r = this.core.performOneOperation(op)
    if (r !== null && 'failed' in r) return { success: false }
    return { success: true, value: r }
  }

  digest(): Uint8Array | null {
    return this.core.digest()
  }

  getLastFailReason(): AvlVerifyFailReason | null {
    return this.core.lastFailReason
  }

  isFullyConsumed(): boolean {
    return this.core.isFullyConsumed()
  }
}
