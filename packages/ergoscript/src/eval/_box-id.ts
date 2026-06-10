/**
 * Box-id derivation for byte-basis equality (F5 batch 4, ledger verdict 3).
 * JVM: ErgoBox.id = Blake2b256(bytes); bytes = retained parse slice or
 * canonical re-serialization (ErgoBox.scala:73,87-92,214-226). Memoized
 * per-object (JVM lazy val).
 *
 * The canonical fallback is the existing `serializeBoxBytes`
 * (wire/ergo-box-bytes.ts) — the same `writeBoxBodyWithoutRef` + txId/index
 * path the SBox SValue serializer arm uses, byte-identical to
 * `serializeSValue({tag:'SBox'}, …)` output. It can THROW for pathological
 * in-memory-constructed boxes (non-dense registers, v6-typed register
 * values at its pinned tree-version 0); the JVM's own re-serialization
 * throws on the same shapes (ErgoBoxCandidate.scala:177-178 sys.error on
 * non-dense registers; version-gated DATA serializers), so the throw
 * propagates as an equality evaluation error rather than being swallowed.
 */
import { blake2b256 } from '../crypto/hashes'
import { serializeBoxBytes } from '../wire/ergo-box-bytes'
import type { ErgoBox } from '../mir/types'

const memo = new WeakMap<ErgoBox, Uint8Array>()

export function boxIdOf(box: ErgoBox): Uint8Array {
  const hit = memo.get(box)
  if (hit) return hit
  const bytes = box.retainedBytes ?? serializeBoxBytes(box)
  const id = blake2b256(bytes)
  memo.set(box, id)
  return id
}
