/**
 * Cryptographic hash wrappers.
 *
 * Thin shims over `@noble/hashes` 2.x so the address layer (and future
 * sigma-protocol code paths) imports a stable interface. Keeps the
 * "hashing is `@noble/hashes` only" rule from CLAUDE.md in one place.
 *
 * Notes:
 *  - `@noble/hashes` 2.x exposes blake2b at `/blake2.js` (memory
 *    `reference-noble-hashes-blake2`).
 *  - `blake2b256` returns 32 bytes; we set `dkLen: 32` explicitly to
 *    pin the digest length and match `sigma_util::hash::blake2b256_hash`
 *    in sigma-rust.
 *  - `sha256` is exported from `/sha2.js` in the same package version.
 */

import { blake2b } from '@noble/hashes/blake2.js'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * Blake2b-256 hash of `input`. Returns a fresh 32-byte `Uint8Array`.
 *
 * Matches sigma-rust's `blake2b256_hash` (`sigma-util/src/hash.rs`):
 * a Blake2b digest configured with `dkLen = 32`, no key, no salt.
 */
export function blake2b256(input: Uint8Array): Uint8Array {
  return blake2b(input, { dkLen: 32 })
}

/**
 * SHA-256 hash of `input`. Returns a fresh 32-byte `Uint8Array`.
 */
export function sha2_256(input: Uint8Array): Uint8Array {
  return sha256(input)
}
