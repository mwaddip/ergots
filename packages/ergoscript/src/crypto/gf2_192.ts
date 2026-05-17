/**
 * GF(2^192) Galois-field arithmetic — phase 2g-combinators.
 *
 * Pure-TypeScript port of sigma-rust's `gf2_192` crate (HEAD ed5452cf, branch
 * `integration/ergots`). Underpins the Cthreshold conjecture verifier walk
 * (Task 9) and the polynomial layer (Task 3).
 *
 * **Field definition** (sigma-rust `gf2_192/src/gf2_192.rs:29-31`):
 *
 *   x^192 + x^7 + x^2 + x + 1   (irreducible pentanomial over GF(2))
 *
 * The low-word encoding of the reduction tail (x^7 + x^2 + x + 1) is
 *
 *   (1 << 7) | (1 << 2) | (1 << 1) | 1   =   0x87   =   0b1000_0111
 *
 * Beware: not `0xE7`. The bits set are at positions 0, 1, 2, 7 — exactly
 * the exponents in the polynomial tail. (A nearby comment in the sigma-rust
 * source visually rearranges the value to `(1<<7)|(1<<2)|(1<<1)|1`, which
 * is `0x87`, not `0xE7`.) Verified against `gf2_192.rs:31`.
 *
 * **Internal representation:** three 64-bit words held as `bigint` triples
 * `[word0, word1, word2]`, where `word0` carries coefficients x^0..x^63,
 * `word1` carries x^64..x^127, and `word2` carries x^128..x^191. Mirrors
 * sigma-rust's `Gf2_192 { word: [i64; 3] }`.
 *
 * **Byte serialization** (sigma-rust `gf2_192.rs:315-324`):
 *
 *   bytes[i + 8*j] = (word[j] >> (i << 3)) & 0xFF       for j ∈ 0..3, i ∈ 0..8
 *
 * Per-word little-endian, with `word[0]` first. So `bytes[0]` is the LSB of
 * `word[0]`, i.e. the coefficient of x^0. Note: this is the layout the
 * verifier walk expects on the wire; it matches the `[u8; 24]` and
 * `TryFrom<&[u8]>` impls in sigma-rust.
 *
 * **No-WASM / browser-first** (`CLAUDE.md`): `bigint` arithmetic only;
 * no `@noble/curves`, no `node:crypto`, no `Buffer`.
 *
 * Source-mapping notes for non-trivial algorithms cite the line ranges in
 * `~/projects/sigma-rust/sigma-rust/gf2_192/src/gf2_192.rs`.
 */

const MASK_64: bigint = (1n << 64n) - 1n

/**
 * Low-word encoding of the reduction tail `x^7 + x^2 + x + 1`. Bits set at
 * positions 0, 1, 2, 7 → `0b1000_0111 == 0x87 == 135`. The leading `x^192`
 * lives one word beyond `word[2]` and is implicitly accounted for whenever
 * the reduction step XORs the appropriate IRRED_MULS entry into `word[0]`.
 *
 * Source: `gf2_192.rs:31`
 *   `IRRED_PENTANOMIAL: i64 = (1i64 << 7) | (1i64 << 2) | (1i64 << 1) | 1i64`
 *
 * Do NOT mis-transcribe as `0xE7` (= `0b1110_0111`); that flips the wrong
 * bits and silently corrupts every multiply that triggers reduction.
 */
const IRRED_PENTANOMIAL: bigint = 0x87n

/**
 * Table of `IRRED_PENTANOMIAL * P_i` for `i = 0..16`, where `P_i` is the
 * 4-bit polynomial whose bits are the binary expansion of `i`:
 *
 *   P_0  = 0
 *   P_1  = 1
 *   P_2  = x
 *   P_3  = x + 1
 *   P_4  = x^2
 *   ...
 *   P_15 = x^3 + x^2 + x + 1
 *
 * Only the lowest 11 bits of any entry are non-zero (max `0x7ad = 1965`),
 * so the i64 ⇄ u64 sign issue from the IRRED tables of larger fields does
 * NOT apply here — every entry fits cleanly in a positive `bigint`.
 *
 * Source: `gf2_192.rs:35-55`. Each entry transcribed by symbolic XOR/shift
 * of `IRRED_PENTANOMIAL` to keep parity with the Rust definition visible.
 */
const IRRED_MULS_TABLE: readonly bigint[] = (() => {
  const P = IRRED_PENTANOMIAL
  return [
    0n,
    P,
    P << 1n,
    (P << 1n) ^ P,
    P << 2n,
    (P << 2n) ^ P,
    (P << 2n) ^ (P << 1n),
    (P << 2n) ^ (P << 1n) ^ P,
    P << 3n,
    (P << 3n) ^ P,
    (P << 3n) ^ (P << 1n),
    (P << 3n) ^ (P << 1n) ^ P,
    (P << 3n) ^ (P << 2n),
    (P << 3n) ^ (P << 2n) ^ P,
    (P << 3n) ^ (P << 2n) ^ (P << 1n),
    (P << 3n) ^ (P << 2n) ^ (P << 1n) ^ P,
  ] as const
})()

/**
 * An element of the Galois field GF(2^192) with the irreducible polynomial
 * x^192 + x^7 + x^2 + x + 1. Immutable.
 *
 * All operations return new `Gf2_192Element` instances; the internal
 * `words` array is never mutated and is owned by the instance.
 */
export class Gf2_192Element {
  /**
   * Internal three-word representation `[word0, word1, word2]`. Each entry
   * is a `bigint` in `[0, 2^64)`. Invariant maintained by every operation.
   */
  private readonly words: readonly [bigint, bigint, bigint]

  private constructor(w0: bigint, w1: bigint, w2: bigint) {
    this.words = [w0, w1, w2]
  }

  /** The zero element (additive identity). */
  static readonly ZERO: Gf2_192Element = new Gf2_192Element(0n, 0n, 0n)

  /** The one element (multiplicative identity). */
  static readonly ONE: Gf2_192Element = new Gf2_192Element(1n, 0n, 0n)

  /**
   * Decode a 24-byte little-endian-per-word representation (`bytes[0]` is
   * the coefficient of `x^0`, `bytes[23]` is the coefficient of `x^191`).
   *
   * Source: `gf2_192.rs:382-391` (`From<[u8; 24]>`).
   */
  static fromBytes(bytes: Uint8Array): Gf2_192Element {
    if (bytes.length !== 24) {
      throw new Error(
        `Gf2_192Element.fromBytes: expected 24 bytes, got ${bytes.length}`,
      )
    }
    let w0 = 0n
    let w1 = 0n
    let w2 = 0n
    for (let i = 0; i < 8; i++) {
      const shift = BigInt(i << 3)
      w0 |= BigInt(bytes[i]!) << shift
      w1 |= BigInt(bytes[i + 8]!) << shift
      w2 |= BigInt(bytes[i + 16]!) << shift
    }
    return new Gf2_192Element(w0, w1, w2)
  }

  /**
   * Encode to 24 bytes, little-endian per word, with `word[0]` first.
   *
   * Source: `gf2_192.rs:315-324` (`From<Gf2_192> for [u8; 24]`).
   */
  toBytes(): Uint8Array {
    const out = new Uint8Array(24)
    for (let j = 0; j < 3; j++) {
      const w = this.words[j as 0 | 1 | 2]
      for (let i = 0; i < 8; i++) {
        out[i + 8 * j] = Number((w >> BigInt(i << 3)) & 0xFFn)
      }
    }
    return out
  }

  /**
   * Field addition. In GF(2^n) this is the bitwise XOR of representations
   * — no carry, no reduction needed.
   *
   * Source: `gf2_192.rs:284-293` (`impl Add`).
   */
  add(other: Gf2_192Element): Gf2_192Element {
    return new Gf2_192Element(
      this.words[0] ^ other.words[0],
      this.words[1] ^ other.words[1],
      this.words[2] ^ other.words[2],
    )
  }

  /**
   * Field multiplication via the 4-bit nibble / IRRED_MULS_TABLE reduction.
   *
   * Algorithm shape (sigma-rust `gf2_192.rs:82-150`):
   *
   *   1. Precompute `a*P_i` for `i = 0..16` (16 partial-product triples).
   *      The base cases are `a*1 = a`, `a*x`, `a*x^2`, `a*x^3` (computed
   *      iteratively with single-bit shift-and-reduce), then linear XOR
   *      combinations fill in the remaining 12 entries.
   *   2. Walk `b` from high word to low, nibble by nibble (4 bits at a time),
   *      maintaining a 192-bit accumulator `(w0, w1, w2)`.
   *   3. For each nibble: multiply the accumulator by x^4 (shift left by 4
   *      bits across the 3 words; the bits that overflow `word[2]` form an
   *      index into IRRED_MULS_TABLE, which gets XORed back into `w0`).
   *      Then XOR in `a * b_nibble`.
   *
   * The IRRED_MULS_TABLE-driven reduction folds the polynomial degrees
   * 192..195 back into degrees 0..7 in one XOR per nibble.
   *
   * Confidence note (OVERRIDES #2): the algorithm is a direct port of the
   * sigma-rust code path; every shift is masked to 64 bits to emulate i64
   * wrap-around. Byte-equivalence against ~25 multiply fixtures + the
   * `x * invert(x) == 1` round-trip across the invert suite is the
   * correctness signal.
   */
  multiply(other: Gf2_192Element): Gf2_192Element {
    // Partial-product tables: aN[i] holds word[N] of (this * P_i) for i ∈ 0..16.
    // Plain `bigint[]`, not `BigInt64Array` — the latter is fixed-width i64
    // and would silently clobber the high-bit sentinel used by the table.
    const a0: bigint[] = new Array(16).fill(0n)
    const a1: bigint[] = new Array(16).fill(0n)
    const a2: bigint[] = new Array(16).fill(0n)

    // i = 1 → a * 1 == a
    a0[1] = this.words[0]
    a1[1] = this.words[1]
    a2[1] = this.words[2]

    // i = 2, 4, 8 → a*x, a*x^2, a*x^3 (single-bit shift-and-reduce).
    // Mirrors gf2_192.rs:100-108.
    for (const i of [2, 4, 8]) {
      const prev = i >> 1
      // Logical right shift by 63 selects the sign bit; on a masked bigint
      // (in [0, 2^64)) this is the same as the bit at position 63.
      const carryFrom0 = a0[prev]! >> 63n
      const carryFrom1 = a1[prev]! >> 63n
      const carryFrom2 = a2[prev]! >> 63n
      a0[i] = (a0[prev]! << 1n) & MASK_64
      a1[i] = ((a1[prev]! << 1n) & MASK_64) | carryFrom0
      a2[i] = ((a2[prev]! << 1n) & MASK_64) | carryFrom1
      // Reduction: if a bit was shifted out of word[2], fold the irreducible
      // polynomial's low-word contribution into word[0].
      a0[i] = a0[i]! ^ IRRED_MULS_TABLE[Number(carryFrom2)]!
    }

    // i = 3 → a * (x + 1) = a*x ^ a*1
    a0[3] = a0[1]! ^ a0[2]!
    a1[3] = a1[1]! ^ a1[2]!
    a2[3] = a2[1]! ^ a2[2]!

    // i = 5..7 → a * (x^2 + P_i) for i ∈ 1..4
    for (let i = 1; i < 4; i++) {
      a0[4 | i] = a0[4]! ^ a0[i]!
      a1[4 | i] = a1[4]! ^ a1[i]!
      a2[4 | i] = a2[4]! ^ a2[i]!
    }

    // i = 9..15 → a * (x^3 + P_i) for i ∈ 1..8
    for (let i = 1; i < 8; i++) {
      a0[8 | i] = a0[8]! ^ a0[i]!
      a1[8 | i] = a1[8]! ^ a1[i]!
      a2[8 | i] = a2[8]! ^ a2[i]!
    }

    // Main loop: walk b high-to-low, 4 bits per step. Per gf2_192.rs:132-148.
    let w0 = 0n
    let w1 = 0n
    let w2 = 0n
    for (let j = 2; j >= 0; j--) {
      const multiplier = other.words[j as 0 | 1 | 2]
      for (let i = 60; i >= 0; i -= 4) {
        // Top 4 bits of w2 become the reduction-table index.
        const modReduceIndex = Number((w2 >> 60n) & 0xFn)
        // Multiply (w0, w1, w2) by x^4.
        w2 = ((w2 << 4n) & MASK_64) | ((w1 >> 60n) & 0xFn)
        w1 = ((w1 << 4n) & MASK_64) | ((w0 >> 60n) & 0xFn)
        w0 = ((w0 << 4n) & MASK_64) ^ IRRED_MULS_TABLE[modReduceIndex]!

        // XOR in (a * b_nibble) where b_nibble is bits (i, i+1, i+2, i+3) of b.word[j].
        const idx = Number((multiplier >> BigInt(i)) & 0xFn)
        w0 ^= a0[idx]!
        w1 ^= a1[idx]!
        w2 ^= a2[idx]!
      }
    }

    return new Gf2_192Element(w0, w1, w2)
  }

  /**
   * Field squaring. Equivalent to `multiply(self)` in any commutative field,
   * and in characteristic 2 the simpler bit-interleave formulation is also
   * valid (sigma-rust uses precomputed tables for side-channel resistance;
   * we use self-multiply since the browser-side threat model does not
   * include power-analysis attacks).
   *
   * Source mapping: `gf2_192.rs:203-205` defines `sqr(z) == power_2_to_2_to_k(z, 0)`,
   * which mathematically equals `z^2 == z * z`. Byte-equivalence holds because
   * the field is well-defined; verified by the `multiply(x, x) == sqr(x)`
   * cross-checks at fixture-gen time and the algebraic-property smoke tests
   * on the TS side.
   */
  sqr(): Gf2_192Element {
    return this.multiply(this)
  }

  /**
   * Multiplicative inverse. By Fermat's little theorem in GF(2^192),
   * `z^{-1} == z^{2^192 - 2}` for nonzero `z`. The exponent has 191 leading
   * one-bits followed by one zero-bit, decomposed by the Itoh–Tsujii ladder.
   *
   * Source: `gf2_192.rs:173-198`. The Rust version uses precomputed
   * `POW_TABLE_*[k]` for `power_2_to_2_to_k`; we instead apply `sqr` directly
   * `2^k` times. Both compute the same value; the table-driven version is
   * faster (constant-time-ish) and the squaring-chain version is shorter
   * (and side-channel concerns don't apply to browser-side verification).
   *
   * @throws if called on the zero element.
   */
  invert(): Gf2_192Element {
    if (this.isZero()) {
      throw new Error('Gf2_192Element.invert: cannot invert zero')
    }
    // Itoh-Tsujii squaring chain. See gf2_192.rs:173-198 for the loop shape.
    let zTo2ToK1s = this as Gf2_192Element // z^1
    let res = this.multiply(this) // z^2
    let zTo2ToK1s2ToK0s = res // z^2 — placeholder name from sigma-rust

    for (let k = 1; k <= 6; k++) {
      zTo2ToK1s = zTo2ToK1s2ToK0s.multiply(zTo2ToK1s)
      zTo2ToK1s2ToK0s = powerOfTwoToTwoToK(zTo2ToK1s, k)
      res = res.multiply(zTo2ToK1s2ToK0s)
    }
    // Final tail-step: shift the accumulated exponent by another 2^6 zeros.
    zTo2ToK1s2ToK0s = powerOfTwoToTwoToK(zTo2ToK1s2ToK0s, 6)
    return res.multiply(zTo2ToK1s2ToK0s)
  }

  /** Equality test on the 192-bit representation. */
  equals(other: Gf2_192Element): boolean {
    return (
      this.words[0] === other.words[0] &&
      this.words[1] === other.words[1] &&
      this.words[2] === other.words[2]
    )
  }

  /** Test against the additive identity. */
  isZero(): boolean {
    return this.words[0] === 0n && this.words[1] === 0n && this.words[2] === 0n
  }

  /** Test against the multiplicative identity. */
  isOne(): boolean {
    return this.words[0] === 1n && this.words[1] === 0n && this.words[2] === 0n
  }
}

/**
 * Raise `z` to the `2^(2^k)`-th power by squaring `z` exactly `2^k` times.
 *
 * For `k = 0` this is just `sqr(z)`. For `k = 6` it's 64 sequential squarings.
 * The Itoh-Tsujii chain in `invert` calls this for `k ∈ 1..=6`, so the worst
 * case is 64 + 32 + 16 + 8 + 4 + 2 + 64 = 190 squarings per invert. Each
 * squaring is one `multiply` call (~24 BigInt operations), so an invert is
 * cheap in practice.
 *
 * Source-mapping: sigma-rust uses a precomputed table to avoid input-dependent
 * code paths (`gf2_192.rs:228-258`). We don't need that here because the
 * browser-side threat model does not include power-analysis attacks. The
 * value computed is the same.
 */
function powerOfTwoToTwoToK(z: Gf2_192Element, k: number): Gf2_192Element {
  // 2^k iterations of squaring.
  const iterations = 1 << k
  let result = z
  for (let i = 0; i < iterations; i++) {
    result = result.sqr()
  }
  return result
}
