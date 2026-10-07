/**
 * Lexicographic unsigned byte comparison with length tiebreak — the ordering
 * every tree comparison in this package uses (Rust byte-slice Ord / scrypto
 * UnsignedBytes semantics). Single source of truth; was four private copies
 * before Phase C (spec C5).
 *
 * `?? 0`, not `!`: for a type-violating sparse input from an untyped JS
 * caller, a hole compares as byte 0 (Uint8Array-equivalent) instead of
 * `undefined`, whose `<`/`>` are both false — silently skipping the byte.
 * Keeps the consensus-path copies' exact behavior (spec review M-7).
 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length)
  for (let i = 0; i < min; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return -1
    if ((a[i] ?? 0) > (b[i] ?? 0)) return 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/**
 * The −inf sentinel key for a tree of the given keyLength: a fresh buffer of
 * `keyLength` zero bytes. Every valid key sorts strictly above it (the engine
 * rejects a key `<= negInfKey(keyLength)` with 'key-out-of-bounds').
 *
 * Part of the extension surface for downstream verifiers that need the same
 * sentinel as the engine's own ±inf gate. Not Ergo consensus.
 */
export function negInfKey(keyLength: number): Uint8Array {
  return new Uint8Array(keyLength)
}

/**
 * The +inf sentinel key for a tree of the given keyLength: a fresh buffer of
 * `keyLength` 0xff bytes. Every valid key sorts strictly below it (the engine
 * rejects a key `>= posInfKey(keyLength)` with 'key-out-of-bounds').
 *
 * Part of the extension surface for downstream verifiers that need the same
 * sentinel as the engine's own ±inf gate. Not Ergo consensus.
 */
export function posInfKey(keyLength: number): Uint8Array {
  return new Uint8Array(keyLength).fill(0xff)
}
