/**
 * Box `.bytes` basis + box-id derivation (F5 batch 4, ledger verdict 3 +
 * byte-accessor addendum).
 * JVM: ErgoBox.id = Blake2b256(bytes); bytes = retained parse slice or
 * canonical re-serialization (ErgoBox.scala:73,87-92,214-226). Memoized
 * per-object (JVM lazy val).
 *
 * `boxBytesOf` is the ONE basis function shared by the ExtractBytes eval arm
 * (`Box.bytes`, CBox.scala:25) and `boxIdOf` — the JVM hashes the same
 * `.bytes` it serves, so the two must never drift apart. NOTE the asymmetry:
 * `Box.bytesWithoutRef` does NOT share this basis — the JVM always
 * re-serializes the candidate (ErgoBoxCandidate.scala:54, no retained
 * candidate slice exists), see eval/extract-bytes-with-no-ref.ts.
 *
 * The canonical fallback is the existing `serializeBoxBytes`
 * (wire/ergo-box-bytes.ts) — the same `writeBoxBodyWithoutRef` + txId/index
 * path the SBox SValue serializer arm uses, byte-identical to
 * `serializeSValue({tag:'SBox'}, …)` output. It can THROW for pathological
 * in-memory-constructed boxes (non-dense registers, v6-typed register
 * values at its pinned tree-version 0). The JVM throws for the same
 * non-dense-register shape (ErgoBoxCandidate.scala:177-178 sys.error). The
 * v6-typed-register shape is unreachable from parse in both implementations
 * (rule-1019 blocks v6 register values at ingress); the JVM writer gates by
 * the ACTIVATED VersionContext (not pinned v0), so under v6 activation it
 * would succeed where our fallback throws — but that path is unreachable.
 * The throw propagates as an equality evaluation error rather than being
 * swallowed.
 */
import { blake2b256 } from '../crypto/hashes'
import { serializeBoxBytes } from '../wire/ergo-box-bytes'
import type { ErgoBox } from '../mir/types'

const memo = new WeakMap<ErgoBox, Uint8Array>()

/**
 * The JVM `ErgoBox.bytes` basis: the parse-RETAINED slice when the box came
 * off the wire (`_bytes`, ErgoBox.scala:87-92), the canonical full
 * re-serialization for constructed boxes. Callers must not mutate the result
 * (it may be the box's own `retainedBytes`).
 */
export function boxBytesOf(box: ErgoBox): Uint8Array {
  return box.retainedBytes ?? serializeBoxBytes(box)
}

export function boxIdOf(box: ErgoBox): Uint8Array {
  const hit = memo.get(box)
  if (hit) return hit
  const id = blake2b256(boxBytesOf(box))
  memo.set(box, id)
  return id
}
