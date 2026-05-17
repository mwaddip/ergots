/**
 * Fiat-Shamir tree-to-bytes serialization for sigma-protocol verification.
 *
 * The verifier (Task 6 leaf-only, Task 9 conjectures) reconstructs the root
 * challenge by:
 *   1. Walking the SigmaBoolean / CheckedTree to build a byte-string
 *      (this module's primitives + the verifier's recursive walk).
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
 * **Layout summary (from sigma-rust `fiat_shamir.rs:139-203`):**
 *
 *   Leaf:           LEAF_PREFIX(1) | put_i16_be(prop_len) | prop | put_i16_be(cmt_len) | cmt
 *   Internal Cand:  INTERNAL_NODE_PREFIX(0) | conj_type(0) | put_i16_be(n)                       | children
 *   Internal Cor:   INTERNAL_NODE_PREFIX(0) | conj_type(1) | put_i16_be(n)                       | children
 *   Internal Cthr:  INTERNAL_NODE_PREFIX(0) | conj_type(2) | put_u8(k) | put_i16_be(n)           | children
 *
 * 2g-medium shipped `propBytes` + `fiatShamirHash` (leaf-only). 2g-combinators
 * (Task 9) adds the structural primitives used by the verifier's recursive
 * tree walk. The recursion lives in `verifier.ts` (sees the CheckedTree); this
 * module only knows how to emit the right bytes for each node kind.
 */

import { blake2b256 } from '../crypto/hashes'
import type { SigmaBoolean, ErgoTree } from '../mir/types'
import { serializeTree } from '../wire/ergo-tree'

export const FIAT_SHAMIR_HASH_BYTES = 24

/** Leaf marker — sigma-rust `fiat_shamir.rs::LEAF_PREFIX = 1`. */
export const FS_LEAF_PREFIX = 1
/** Internal-node marker — sigma-rust `fiat_shamir.rs::INTERNAL_NODE_PREFIX = 0`. */
export const FS_INTERNAL_NODE_PREFIX = 0

/**
 * Conjecture-type discriminants (sigma-rust `proof_tree.rs:131-135`). Used as
 * the second byte after `FS_INTERNAL_NODE_PREFIX` to identify the node kind.
 *
 *   Cand        → 0
 *   Cor         → 1
 *   Cthreshold  → 2
 */
export const FS_CONJ_AND = 0
export const FS_CONJ_OR = 1
export const FS_CONJ_THRESHOLD = 2

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

/**
 * Growable byte buffer used by the verifier when serializing a CheckedTree
 * for Fiat-Shamir input. Pure userland Uint8Array — no Buffer, no Node-only
 * APIs (browser-first rule).
 *
 * Capacity grows by doubling when full. `append*` methods write at the tail
 * and advance the length; `toBytes` returns a defensive slice of exactly the
 * written bytes (so the consumer can hash without worrying about trailing
 * garbage from the unused capacity).
 */
export class FsByteBuilder {
  private buf: Uint8Array
  private len: number

  constructor(initialCapacity: number = 64) {
    this.buf = new Uint8Array(initialCapacity)
    this.len = 0
  }

  private ensure(extra: number): void {
    const needed = this.len + extra
    if (needed <= this.buf.length) return
    let cap = this.buf.length === 0 ? 1 : this.buf.length
    while (cap < needed) cap *= 2
    const grown = new Uint8Array(cap)
    grown.set(this.buf.subarray(0, this.len), 0)
    this.buf = grown
  }

  appendByte(b: number): void {
    this.ensure(1)
    this.buf[this.len++] = b & 0xff
  }

  /**
   * Append a 2-byte signed big-endian integer (`put_i16_be_bytes` in
   * sigma-rust). Caller is responsible for ensuring `value` fits in i16
   * (range -32768..32767); we mask to 16 bits and let bit-15 be the sign,
   * mirroring the wrapping semantics of Rust's `as i16` cast.
   *
   * In practice all callers pass non-negative child counts; this helper
   * accepts the i16 range to stay faithful to the source's signed type.
   */
  appendI16Be(value: number): void {
    const masked = value & 0xffff
    this.ensure(2)
    this.buf[this.len++] = (masked >> 8) & 0xff
    this.buf[this.len++] = masked & 0xff
  }

  appendBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length)
    this.buf.set(bytes, this.len)
    this.len += bytes.length
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

/**
 * Serialize a single leaf into FS bytes:
 *
 *   LEAF_PREFIX(1) | put_i16_be(prop.length) | prop | put_i16_be(commitment.length) | commitment
 *
 * Sigma-rust source: `fiat_shamir.rs:148-168`.
 *
 * Rejects prop/commitment lengths outside the i16 range with a thrown Error
 * (not a typed VerifyError — the caller in the verifier converts to a
 * VerifyError if it wants to surface a typed code; in practice no real leaf
 * exceeds i16 so this is a defensive check, not a hot path).
 */
export function writeFiatShamirLeaf(
  builder: FsByteBuilder,
  prop: Uint8Array,
  commitment: Uint8Array,
): void {
  if (prop.length > 0x7fff) {
    throw new Error(`writeFiatShamirLeaf: prop length ${prop.length} exceeds i16 range`)
  }
  if (commitment.length > 0x7fff) {
    throw new Error(`writeFiatShamirLeaf: commitment length ${commitment.length} exceeds i16 range`)
  }
  builder.appendByte(FS_LEAF_PREFIX)
  builder.appendI16Be(prop.length)
  builder.appendBytes(prop)
  builder.appendI16Be(commitment.length)
  builder.appendBytes(commitment)
}

/**
 * Write the header of an internal-node FS section for Cand or Cor.
 *
 *   INTERNAL_NODE_PREFIX(0) | conj_type | put_i16_be(child_count)
 *
 * The caller is responsible for serializing each child afterward (recursively).
 *
 * Sigma-rust source: `fiat_shamir.rs:174-201`.
 */
export function writeFiatShamirInternalHeader(
  builder: FsByteBuilder,
  conjectureType: typeof FS_CONJ_AND | typeof FS_CONJ_OR,
  childCount: number,
): void {
  if (childCount > 0x7fff) {
    throw new Error(`writeFiatShamirInternalHeader: childCount ${childCount} exceeds i16 range`)
  }
  builder.appendByte(FS_INTERNAL_NODE_PREFIX)
  builder.appendByte(conjectureType)
  builder.appendI16Be(childCount)
}

/**
 * Write the header of an internal-node FS section for Cthreshold (k-byte
 * appears between the conjecture-type byte and the child-count i16):
 *
 *   INTERNAL_NODE_PREFIX(0) | CONJ_THRESHOLD(2) | put_u8(k) | put_i16_be(child_count)
 *
 * Sigma-rust source: `fiat_shamir.rs:180-187, 197`.
 */
export function writeFiatShamirThresholdHeader(
  builder: FsByteBuilder,
  k: number,
  childCount: number,
): void {
  if (k < 0 || k > 0xff) {
    throw new Error(`writeFiatShamirThresholdHeader: k=${k} out of u8 range`)
  }
  if (childCount > 0x7fff) {
    throw new Error(`writeFiatShamirThresholdHeader: childCount ${childCount} exceeds i16 range`)
  }
  builder.appendByte(FS_INTERNAL_NODE_PREFIX)
  builder.appendByte(FS_CONJ_THRESHOLD)
  builder.appendByte(k)
  builder.appendI16Be(childCount)
}
