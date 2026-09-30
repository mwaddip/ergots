/**
 * Neighbor-reporting lookups (0.5.0) — what a Lookup learns from the leaf it
 * resolves at: a present key's value and the next leaf's key, or an absent
 * key's two neighbors. TS-only: neither ergo_avltree_rust @568e7c3 nor
 * scrypto 3.0.0 has a neighbor-reporting lookup. See facts/avltree.md
 * § Neighbor lookups.
 */

import type { LeafNode } from './node.js'
import { compareBytes } from './compare-bytes.js'

/** What a neighbor-reporting lookup learns from the leaf it resolves at. */
export type NeighborLookup =
  | { found: true; value: Uint8Array; nextKey: Uint8Array | null }
  | { found: false; prevKey: Uint8Array | null; nextKey: Uint8Array | null }

/** A recorded (prover) or verifier neighbor lookup: the lookup, or a failure. */
export type NeighborLookupResult =
  | ({ success: true } & NeighborLookup)
  | { success: false }

/**
 * Maps the leaf a Lookup resolved at to its neighbor report. `null` marks a
 * sentinel — `nextKey: null` past the last key, `prevKey: null` below the
 * first — exact because no real key can equal either sentinel. Every returned
 * buffer is a fresh copy: `new Uint8Array`, never `.slice()` (a Buffer's slice
 * is a view).
 */
export function neighborLookupOf(
  leaf: LeafNode,
  found: boolean,
  negInfKey: Uint8Array,
  posInfKey: Uint8Array,
): NeighborLookup {
  const nextKey = compareBytes(leaf.nextLeafKey, posInfKey) === 0 ? null : new Uint8Array(leaf.nextLeafKey)
  if (found) return { found: true, value: new Uint8Array(leaf.value), nextKey }
  const prevKey = compareBytes(leaf.key, negInfKey) === 0 ? null : new Uint8Array(leaf.key)
  return { found: false, prevKey, nextKey }
}
