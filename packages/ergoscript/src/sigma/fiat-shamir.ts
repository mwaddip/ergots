/**
 * Fiat-Shamir tree-to-bytes serialization for sigma-protocol verification.
 *
 * The verifier (Task 6) reconstructs the root challenge by:
 *   1. Walking the SigmaBoolean tree to build a byte-string (this module).
 *   2. Appending the message.
 *   3. Hashing with blake2b-256.
 *   4. Taking the first 24 bytes.
 *
 * **Critical byte-format details:**
 *
 *  - `propBytes` for a leaf: wrap the SigmaProp in an ErgoTree with
 *    `version=0, hasSize=false, constantSegregation=true` BEFORE serializing
 *    (sigma-rust `fiat_shamir.rs:148-157`, `tree_header.rs:79-88`).
 *    ErgoTree::new() with constant-segregation=true extracts the Const node
 *    into the constants array; the body becomes ConstPlaceholder(0).
 *    We mirror that behavior directly by constructing the ErgoTree with:
 *      - constants = [{ kind: 'SigmaProp', value: sb }]
 *      - constantTypes = [{ tag: 'SSigmaProp' }]
 *      - body = { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SSigmaProp' } }
 *    This produces byte-identical output to sigma-rust.
 *
 *  - Leaf prefix byte: `1`; internal-node prefix: `0`
 *    (`fiat_shamir.rs::LEAF_PREFIX = 1`).
 *  - Conjecture child counts use `put_i16_be_bytes` — 2-byte BIG-ENDIAN,
 *    NOT VLQ (`fiat_shamir.rs:197`). This differs from the wire format.
 *  - `Cthreshold` k is `put_u8` in Fiat-Shamir (`fiat_shamir.rs:184`);
 *    Cand=0, Cor=1, Cthreshold=2 conjecture-type bytes (`proof_tree.rs:131-135`).
 *
 * NOTE: 2g-medium ships only `propBytes` + the hash primitive. The full
 * tree-walker for conjectures ships in 2g-combinators.
 */

import { blake2b256 } from '../crypto/hashes'
import type { SigmaBoolean, ErgoTree } from '../mir/types'
import { serializeTree } from '../wire/ergo-tree'

export const FIAT_SHAMIR_HASH_BYTES = 24

/**
 * Wrap a SigmaBoolean in an ErgoTree(v0, constant-segregation=true) and
 * serialize. Used at every leaf during Fiat-Shamir tree construction.
 *
 * Source: sigma-rust `fiat_shamir.rs:148-157`.
 *
 * Sigma-rust calls `ErgoTree::new(ErgoTreeHeader::v0(true), &Expr::Const(...))`.
 * That `new()` with constant-segregation=true runs through the
 * ConstantStore-writer path which extracts the `Const` node into the
 * segregated constants array and replaces it with `ConstPlaceholder(0)`.
 * We reproduce that final shape directly so no constant-extraction pass is
 * needed in TS.
 *
 * Header byte value: 0b00010000 = 0x10
 *   bits 2..0 = 0  (version 0)
 *   bit 3     = 0  (no hasSize)
 *   bit 4     = 1  (constant-segregation=true)
 *   bits 7..5 = 0  (reserved)
 */
export function propBytes(sb: SigmaBoolean): Uint8Array {
  const tree: ErgoTree = {
    header: {
      version: 0,
      hasSize: false,
      constantSegregation: true,
      rawHeader: 0b00010000,  // 0x10
    },
    constantTypes: [{ tag: 'SSigmaProp' }],
    constants: [{ kind: 'SigmaProp', value: sb }],
    // Body is ConstPlaceholder(0) referencing the segregated constant.
    // Mirrors sigma-rust's ConstantStore extraction behavior.
    body: { tag: 'ConstPlaceholder', id: 0, tpe: { tag: 'SSigmaProp' } },
  }
  return serializeTree(tree)
}

/**
 * Hash an arbitrary byte sequence with blake2b-256 and truncate to 24 bytes.
 *
 * Source: sigma-rust `fiat_shamir.rs:73-76`.
 *   `let hash = blake2b256_hash(input);`
 *   `let taken: Vec<u8> = hash.iter().copied().take(SOUNDNESS_BYTES).collect();`
 */
export function fiatShamirHash(input: Uint8Array): Uint8Array {
  const digest = blake2b256(input)
  return digest.slice(0, FIAT_SHAMIR_HASH_BYTES)
}
