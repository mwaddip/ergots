/**
 * VersionedAVLStorage — interface for persistent AVL+ tree storage.
 *
 * Ports ergo_avltree_rust/src/versioned_avl_storage.rs (69 lines).
 * No concrete implementation ships with the package; consumers provide
 * their own (in-memory for tests, redb/SQLite for production).
 */
import type { BatchAVLProver } from './batch-prover.js'

export interface VersionedAVLStorage {
  /**
   * Synchronize storage with the prover's state.
   * Called after operations are applied but before proof generation.
   */
  update(
    prover: BatchAVLProver,
    additionalData: [Uint8Array, Uint8Array][],
  ): void

  /**
   * Return the root node and tree height at the given version.
   * The return type is implementation-specific; PersistentBatchAVLProver
   * wires it to the prover's internal tree.
   */
  rollback(version: Uint8Array): [/* root */ unknown, /* height */ number]

  /** Current version digest, or null if storage is empty. */
  version(): Uint8Array | null

  /** Versions available for rollback. */
  rollbackVersions(): Uint8Array[]

  /** Force durable commit. No-op by default. */
  flush(): void
}
