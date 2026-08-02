/**
 * PersistentBatchAVLProver — wraps a BatchAVLProver with versioned storage.
 *
 * Ports ergo_avltree_rust/src/persistent_batch_avl_prover.rs (68 lines).
 */
import { BatchAVLProver } from './batch-prover.js'
import type { VersionedAVLStorage } from './versioned-storage.js'
import type { Operation } from './operation.js'
import type { ProverOperationResult } from './batch-prover.js'

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length)
  for (let i = 0; i < min; i++) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

export class PersistentBatchAVLProver {
  readonly prover: BatchAVLProver
  readonly storage: VersionedAVLStorage

  constructor(
    prover: BatchAVLProver,
    storage: VersionedAVLStorage,
    additionalData: [Uint8Array, Uint8Array][],
  ) {
    this.prover = prover
    this.storage = storage

    // Rust lines 22-30
    const ver = storage.version()
    if (ver !== null) {
      this.rollback(ver)
    } else {
      this.generateProofAndUpdateStorage(additionalData)
    }
    // Rust line 31: ensure!(storage.version() == digest())
    const sv = storage.version()
    const d = this.digest()
    if (!sv || !d || compareBytes(sv, d) !== 0) {
      throw new Error('Storage version does not match prover digest')
    }
  }

  performOneOperation(operation: Operation): ProverOperationResult {
    return this.prover.performOneOperation(operation)
  }

  unauthenticatedLookup(key: Uint8Array): Uint8Array | null {
    return this.prover.unauthenticatedLookup(key)
  }

  digest(): Uint8Array | null {
    return this.prover.digest()
  }

  height(): number {
    return this.prover.height
  }

  generateProofAndUpdateStorage(
    additionalData: [Uint8Array, Uint8Array][],
  ): Uint8Array {
    this.storage.update(this.prover, additionalData)
    return this.prover.generateProof()
  }

  rollback(version: Uint8Array): void {
    const [root, height] = this.storage.rollback(version)
    this.prover.root = root as import('./node.js').AvlNode
    this.prover.height = height
    // Sync oldTopNode to the restored root — ports ergo_avltree_rust commit 191052c.
    // Without this, the first generateProof() after rollback walks a stale snapshot
    // (the dummy-tree root from BatchAVLProver's constructor) instead of the restored
    // tree, producing a wrong proof.
    this.prover.oldTopNode = this.prover.root
  }
}
