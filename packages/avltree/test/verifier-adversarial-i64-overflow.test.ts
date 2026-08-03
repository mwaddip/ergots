/**
 * Adversarial rejection test for the i64 `UpdateLongBy` overflow divergence.
 *
 * The JVM reference (scrypto 3.0.0 `UpdateLongBy.updateFn`, bytecode-verified:
 * `Math.addExact` at `$anonfun$updateFn$7` offset 169) REJECTS an i64-
 * overflowing sum in either direction — `ArithmeticException` is `NonFatal`,
 * so the verifier's `Try` converts it to a per-op Failure. Pre-fix, this
 * package sign-checked the TRUE bigint sum and ACCEPTED positive overflow,
 * storing the wrapped-negative 8-byte encoding (`0x8000000000000000` for
 * MAX + 1) — accepting a proof both references reject, and planting a stored
 * value whose i64 reading is negative.
 *
 * (`ergo_avltree_rust` @191052c release builds reject positive overflow by
 * accident — the plain wrapping `+` yields a negative wrapped value, hitting
 * the `< 0` Err arm. Its NEGATIVE-overflow behaviour diverges from the JVM;
 * that crate-side issue is routed cross-project and is not covered here.)
 *
 * Byte provenance (6c capture technique): the proof below is exactly what a
 * pre-fix prover emitted for `Insert(0x10, i64::MAX)`, `generateProof()`,
 * then `UpdateLongBy(0x10, +1)` — i.e. bytes an adversary can supply today.
 * Config `keyLength: 1, valueLengthOpt: 8`. The starting digest is the
 * sealed post-insert digest; the proof is the second cycle's.
 *
 * @see facts/avltree.md — `update_fn` Source Mapping row
 * @see operation.test.ts — unit-level overflow coverage (both directions)
 */
import { describe, expect, it } from 'vitest'
import { verifyAvlBatch } from '../src/verify.js'
import type { Operation } from '../src/operation.js'
import type { AvlTreeConfig } from '../src/types.js'

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

const CONFIG: AvlTreeConfig = { keyLength: 1, valueLengthOpt: 8 }

describe('verifier rejects i64-overflowing UpdateLongBy', () => {
  it('returns null (no throw) on a proof whose UpdateLongBy sum exceeds i64::MAX', () => {
    // Sealed digest after Insert(0x10, i64::MAX) — height byte 0x01.
    const startingDigest = hexToBytes(
      '4309d217ddfc2131b1c9893c3f0f01526178bffbce96ef0b85a17c82e870b44701',
    )
    // LABEL (untouched sentinel side) · LEAF key=0x10 nextLeafKey=0xff
    // value=7fffffffffffffff (i64::MAX) · INTERNAL balance 0 · END · directions.
    const proof = hexToBytes(
      '031404b14360671ae0e86a9c9fc96cb4039bafe8c6c3ed104a1ff87a44a2ce8d740210ff7fffffffffffffff000400',
    )
    const op: Operation = { tag: 'UpdateLongBy', key: new Uint8Array([0x10]), delta: 1n }

    let result: ReturnType<typeof verifyAvlBatch> | undefined
    expect(() => {
      result = verifyAvlBatch(startingDigest, proof, CONFIG, [op])
    }, 'overflow rejection must not throw').not.toThrow()
    // `?? null` so an unexecuted closure cannot pass vacuously. Pre-fix this
    // returned { newDigest, results } with the wrapped-negative value stored.
    expect(result ?? null, 'verifier must reject the overflowing UpdateLongBy').toBeNull()
  })
})
