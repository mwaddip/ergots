/**
 * PersistentBatchAVLProver — wraps a BatchAVLProver with versioned storage.
 *
 * Ports ergo_avltree_rust/src/persistent_batch_avl_prover.rs (69 lines).
 */
import { BatchAVLProver } from './batch-prover.js'
import type { VersionedAVLStorage } from './versioned-storage.js'
import type { Operation } from './operation.js'
import type { ProverOperationResult } from './batch-prover.js'
import { compareBytes } from './compare-bytes.js'

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
    // Rust line 30: ensure!(storage.version() == digest())
    const sv = storage.version()
    const d = this.digest()
    if (!sv || compareBytes(sv, d) !== 0) {
      throw new Error('Storage version does not match prover digest')
    }
  }

  performOneOperation(operation: Operation): ProverOperationResult {
    return this.prover.performOneOperation(operation)
  }

  unauthenticatedLookup(key: Uint8Array): Uint8Array | null {
    return this.prover.unauthenticatedLookup(key)
  }

  digest(): Uint8Array {
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
    // restoreRoot rebases the whole proof cycle atomically: it installs the
    // root and height, clears modified-node bookkeeping and any accumulated
    // direction bits from the aborted cycle, and points oldTopNode at the
    // restored root. Setting those fields by hand — as this did — left stale
    // directions behind, so the next generateProof() emitted bits for
    // operations that were rolled back.
    //
    // ergo_avltree_rust's own PersistentBatchAVLProver::rollback()
    // (src/persistent_batch_avl_prover.rs) still sets root/height/old_top_node
    // by hand and never calls restore_root — it was never updated after
    // restore_root was added. But every production caller in ergo-node-rust
    // bypasses that crate method and calls storage.rollback() followed
    // directly by prover.restore_root() (validation/src/utxo.rs:166 and :477;
    // src/main.rs:1841 and :2355 on resume/snapshot-load). Delegating here
    // matches that production usage pattern, not the crate's own method.
    this.prover.restoreRoot(root as import('./node.js').AvlNode, height)
  }
}
