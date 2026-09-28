/**
 * The box-tree cache behind boxTreeOf / reencodeTreeBytes (spec 2026-09-28 §8), keyed by the
 * ergoTreeBytes INSTANCE. Box ingest (parseErgoTreeBytes) seeds it with the tree it parsed under
 * the box rules; an embedder can seed a tree it parsed itself (seedBoxTree). Bytes must not be
 * mutated after first use (as for eval/_box-id.ts).
 */
import type { ErgoTree } from '../mir/types'

export interface BoxTreeEntry { tree: ErgoTree; reencoded?: Uint8Array }
export const boxTreeCache = new WeakMap<Uint8Array, BoxTreeEntry>()

export function seedBoxTree(ergoTreeBytes: Uint8Array, tree: ErgoTree): void {
  boxTreeCache.set(ergoTreeBytes, { tree })
}
