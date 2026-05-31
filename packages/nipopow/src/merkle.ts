/**
 * BatchMerkleProof parse + verify.
 *
 * Wire format (ScorexSerializable, matches sigma-rust batchmerkleproof.rs):
 *   4 bytes BE u32: indices_len
 *   4 bytes BE u32: proofs_len
 *   for each index: 4 bytes BE u32 index + 32 bytes hash
 *   for each proof: 32 bytes hash (all zeros = empty/None) + 1 byte side (0=Left, 1=Right)
 *
 * Leaf hashing (LEAF_PREFIX = 0x00):
 *   leafHash(data) = blake2b256([0x00] ++ data)
 *   For extension KV: data = [0x02] ++ key[2bytes] ++ value
 *
 * Internal node hashing (INTERNAL_PREFIX = 0x01):
 *   internalHash(left, right) = blake2b256([0x01] ++ left ++ right)
 *   If one child is empty (None): blake2b256([0x01] ++ present_child)
 *
 * NodeSide: Left=0 means the proof node is on the LEFT of the current node.
 *           Right=1 means the proof node is on the RIGHT of the current node.
 *
 * verify() is a TypeScript port of the `valid()` function in sigma-rust
 * ergo-merkle-tree/src/batchmerkleproof.rs, implementing the algorithm from
 * https://deepai.org/publication/compact-merkle-multiproofs
 */

import { blake2b256 } from './crypto/blake2b256';
import { ByteReader, ByteWriter } from '@ergots/scorex';
import { ProofParseError } from './errors';
import { bytesEqual } from './bytes';

// Leaf prefix byte: 0 = leaf node
const LEAF_PREFIX = 0x00;
// Internal node prefix byte: 1 = internal node
const INTERNAL_PREFIX = 0x01;

// Wire sizes of the count-prefixed entries; used to reject declared counts that
// cannot fit in the remaining bytes before looping (see parseBatchMerkleProof).
const INDEX_ENTRY_BYTES = 36; // 4-byte big-endian index + 32-byte leaf hash
const PROOF_ENTRY_BYTES = 33; // 32-byte sibling hash + 1-byte NodeSide

// NodeSide mirrors sigma-rust's NodeSide enum
export const NodeSide = {
  Left: 0,
  Right: 1,
} as const;
export type NodeSide = typeof NodeSide[keyof typeof NodeSide];

// LevelNode: a proof sibling node. hash=null means empty (no hash, like an empty sibling).
export interface LevelNode {
  hash: Uint8Array | null; // null = empty node
  side: NodeSide;
}

// One entry in the indices array of a BatchMerkleProof.
export interface BatchMerkleProofIndex {
  index: number;  // leaf index in the tree
  hash: Uint8Array; // 32-byte leaf hash (pre-computed by the prover)
}

// The BatchMerkleProof structure.
export interface BatchMerkleProof {
  indices: BatchMerkleProofIndex[];
  proofs: LevelNode[];
}

// A key-value leaf pair from the extension section.
export interface ExtensionKV {
  key: Uint8Array;   // 2 bytes
  value: Uint8Array; // variable length
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────

function readU32BE(r: ByteReader, name: string): number {
  try {
    const b = r.readBytes(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  } catch {
    throw new ProofParseError(`${name}: truncated`, 'truncated');
  }
}

/** Parse a BatchMerkleProof from its ScorexSerializable wire encoding. */
export function parseBatchMerkleProof(r: ByteReader): BatchMerkleProof {
  const indicesLen = readU32BE(r, 'indices_len');
  const proofsLen = readU32BE(r, 'proofs_len');

  // Reject counts that cannot fit in the remaining bytes before allocating or
  // looping. A valid proof carries exactly indicesLen*36 + proofsLen*33 body
  // bytes, so this never rejects a well-formed proof; it just converts a deep
  // read-exhaustion 'truncated' into an early, explicit 'oversized' — matching
  // the MAX_* sanity-cap convention in proof.ts / popow-header.ts and mirroring
  // the JVM reference, which splits the already-present buffer rather than
  // pre-allocating from the untrusted counts.
  const bodyBytes = indicesLen * INDEX_ENTRY_BYTES + proofsLen * PROOF_ENTRY_BYTES;
  if (bodyBytes > r.remaining) {
    throw new ProofParseError(
      `batch merkle proof declares ${indicesLen} indices + ${proofsLen} proofs ` +
        `(needs ${bodyBytes} bytes) but only ${r.remaining} remain`,
      'oversized',
    );
  }

  const indices: BatchMerkleProofIndex[] = [];
  for (let i = 0; i < indicesLen; i++) {
    const index = readU32BE(r, 'index');
    let hashBytes: Uint8Array;
    try {
      hashBytes = r.readBytes(32);
    } catch {
      throw new ProofParseError(`index entry ${i}: truncated`, 'truncated');
    }
    indices.push({ index, hash: hashBytes.slice() }); // copy out of the backing buffer
  }

  const proofs: LevelNode[] = [];
  for (let i = 0; i < proofsLen; i++) {
    let hashBytes: Uint8Array;
    let side: number;
    try {
      hashBytes = r.readBytes(32);
      side = r.readU8();
    } catch {
      throw new ProofParseError(`proof entry ${i}: truncated`, 'truncated');
    }
    if (side !== NodeSide.Left && side !== NodeSide.Right) {
      throw new ProofParseError(`invalid NodeSide byte: ${side}`, 'invalid-side');
    }
    const allZero = hashBytes.every(b => b === 0);
    proofs.push({
      hash: allZero ? null : hashBytes.slice(),
      side: side as NodeSide,
    });
  }

  return { indices, proofs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize
// ─────────────────────────────────────────────────────────────────────────────

/** Write a 4-byte big-endian u32. */
function writeU32BE(w: ByteWriter, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error(`writeU32BE: out of range: ${v}`);
  }
  const b = new Uint8Array(4);
  b[0] = (v >>> 24) & 0xff;
  b[1] = (v >>> 16) & 0xff;
  b[2] = (v >>> 8) & 0xff;
  b[3] = v & 0xff;
  w.writeBytes(b);
}

/**
 * Serialize a BatchMerkleProof to its ScorexSerializable wire encoding.
 *
 * Wire format (inverse of parseBatchMerkleProof, matches sigma-rust batchmerkleproof.rs):
 *   4 bytes BE u32: indices_len
 *   4 bytes BE u32: proofs_len
 *   for each index: 4 bytes BE u32 (leaf index) + 32 bytes (leaf hash)
 *   for each proof: 32 bytes (hash, all-zero if null) + 1 byte (side: 0=Left, 1=Right)
 */
export function serializeBatchMerkleProof(proof: BatchMerkleProof): Uint8Array {
  const w = new ByteWriter();
  writeU32BE(w, proof.indices.length);
  writeU32BE(w, proof.proofs.length);
  for (const idx of proof.indices) {
    writeU32BE(w, idx.index);
    if (idx.hash.length !== 32) {
      throw new Error(`indices[].hash: expected 32 bytes, got ${idx.hash.length}`);
    }
    w.writeBytes(idx.hash);
  }
  for (const p of proof.proofs) {
    if (p.hash === null) {
      w.writeBytes(new Uint8Array(32)); // all-zero sentinel for empty sibling
    } else {
      if (p.hash.length !== 32) {
        throw new Error(`proofs[].hash: expected 32 bytes, got ${p.hash.length}`);
      }
      w.writeBytes(p.hash);
    }
    w.writeU8(p.side); // 0 = Left, 1 = Right
  }
  return w.toBytes();
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Compute blake2b256 with a 1-byte prefix. */
function prefixedHash(prefix: number, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(1 + data.length);
  buf[0] = prefix;
  buf.set(data, 1);
  return blake2b256(buf);
}

/**
 * Compute blake2b256([prefix] ++ left ++ right).
 * Either left or right may be null (empty sibling); if null, that side is omitted.
 * Matches sigma-rust's prefixed_hash2(prefix, Option<&[u8]>, Option<&[u8]>).
 */
function prefixedHash2(
  prefix: number,
  left: Uint8Array | null,
  right: Uint8Array | null,
): Uint8Array {
  const leftLen = left ? left.length : 0;
  const rightLen = right ? right.length : 0;
  const buf = new Uint8Array(1 + leftLen + rightLen);
  buf[0] = prefix;
  if (left) buf.set(left, 1);
  if (right) buf.set(right, 1 + leftLen);
  return blake2b256(buf);
}

/**
 * Compute the leaf hash for a key-value extension entry.
 * sigma-rust kv_to_leaf: data = [2u8] ++ key ++ value
 * Then MerkleNode::from_bytes(data) hashes with prefixed_hash(LEAF_PREFIX, data).
 */
export function hashExtensionLeaf(kv: ExtensionKV): Uint8Array {
  const data = new Uint8Array(1 + kv.key.length + kv.value.length);
  data[0] = 0x02;
  data.set(kv.key, 1);
  data.set(kv.value, 1 + kv.key.length);
  return prefixedHash(LEAF_PREFIX, data);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a BatchMerkleProof against the supplied leaves and expected merkle root.
 *
 * The `leaves` array is used to recompute each leaf hash and check it matches
 * the corresponding `proof.indices[i].hash`. This is an additional integrity
 * check beyond sigma-rust's `valid()`, which trusts the stored hashes.
 *
 * Returns true iff every leaf hashes correctly AND the proof's reconstructed
 * root matches `expectedRoot`.
 */
export function verifyBatchMerkleProof(
  proof: BatchMerkleProof,
  leaves: ExtensionKV[],
  expectedRoot: Uint8Array,
): boolean {
  // Empty proof is a special case: vacuously true only when leaves are also empty.
  // sigma-rust check_interlinks_proof short-circuits when all three are empty.
  if (
    proof.indices.length === 0 &&
    proof.proofs.length === 0 &&
    leaves.length === 0
  ) {
    return true;
  }

  // Sort indices by index position (sigma-rust sorts e by key before validating).
  const sorted = [...proof.indices].sort((a, b) => a.index - b.index);

  // Recompute leaf hashes from the provided leaf data and verify they match the
  // proof's stored hashes. This ensures the proof indices are consistent with
  // the leaf data.
  //
  // The proof indices store leaf hashes; sigma-rust's extension_batch_proof_for
  // finds leaf hashes by calling MerkleNode::from_bytes(kv_to_leaf(kv)) which
  // gives prefixedHash(LEAF_PREFIX, [2u8] ++ key ++ val).
  //
  // We compute the leaf hashes from the leaves array in the order they appear,
  // then match them against the sorted proof indices.
  const leafHashes = leaves.map(kv => hashExtensionLeaf(kv));

  // Verify each index's stored hash matches our recomputed leaf hash.
  // The indices in the proof reference positions in the leaf array (0-based).
  for (const entry of sorted) {
    if (entry.index >= leafHashes.length) return false;
    const expected = leafHashes[entry.index]!;
    if (!bytesEqual(expected, entry.hash)) return false;
  }

  // Now run the compact multi-proof validation algorithm.
  // This is a port of sigma-rust's nested `validate` function.
  const result = validateMultiproof(
    sorted.map(e => e.index),
    sorted.map(e => e.hash),
    [...proof.proofs], // mutable copy
  );

  if (result === null || result.length !== 1) return false;
  return bytesEqual(result[0]!, expectedRoot);
}

/**
 * Recursive compact multi-proof validation.
 * Port of sigma-rust's `validate` inner function in batchmerkleproof.rs.
 *
 * a: sorted leaf indices
 * e: leaf hashes (same order as a)
 * m: mutable list of proof LevelNodes (consumed front-to-back)
 *
 * Returns the list of hashes at the next level up, or null on failure.
 */
function validateMultiproof(
  a: number[],
  e: Uint8Array[],
  m: LevelNode[],
): Uint8Array[] | null {
  if (e.length !== a.length) return null;

  // b: for each index in a, pair it with its sibling index.
  // If i is even, its sibling is i+1 (it's the left child); pair = (i, i+1)
  // If i is odd, its sibling is i-1 (it's the right child); pair = (i-1, i)
  const b: [number, number][] = a.map(i =>
    i % 2 === 0 ? [i, i + 1] : [i - 1, i]
  );

  const eNew: Uint8Array[] = [];
  let i = 0;

  while (i < b.length) {
    // Check if the next pair is the same as the current pair (both nodes
    // needed to compute the parent are in e).
    if (b.length > 1 && i + 1 < b.length && pairEquals(b[i]!, b[i + 1]!)) {
      // Both siblings are in e; hash them together.
      eNew.push(prefixedHash2(INTERNAL_PREFIX, e[i]!, e[i + 1]!));
      i += 2;
    } else {
      // Need a node from the proof list m.
      if (m.length === 0) return null;
      const head = m.shift()!;

      if (head.side === NodeSide.Left) {
        // The proof node is on the LEFT: hash(head, e[i])
        eNew.push(prefixedHash2(INTERNAL_PREFIX, head.hash, e[i]!));
      } else {
        // The proof node is on the RIGHT: hash(e[i], head)
        eNew.push(prefixedHash2(INTERNAL_PREFIX, e[i]!, head.hash));
      }
      i += 1;
    }
  }

  // Compute parent indices: a_new = deduplicated sorted b[i][1] / 2
  const aNewRaw = b.map(([, r]) => Math.floor(r / 2));
  const aNew = [...new Set(aNewRaw)].sort((x, y) => x - y);

  // Recurse if there's more tree to process.
  if ((m.length > 0 || eNew.length > 1) && aNew.length > 0) {
    // `aNew` is the deduplicated sibling-hash list for the next level;
    // `eNew` is one entry per parent in the next level (no dedup needed).
    // They have the same length because every parent contributes exactly one
    // entry to each.
    return validateMultiproof(aNew, eNew, m);
  }

  return eNew;
}

function pairEquals(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Interlink packing + root computation (sigma-rust parity helpers for
// PoPowHeader::check_interlinks_proof in ergo-nipopow).
// ─────────────────────────────────────────────────────────────────────────────

/** Prefix byte identifying interlink-vector extension keys (sigma-rust INTERLINK_VECTOR_PREFIX). */
const INTERLINK_VECTOR_PREFIX = 0x01;

/**
 * Pack a list of interlink BlockIds into the ExtensionKV format used in block
 * extensions. Matches the JVM Ergo (ergoplatform/ergo) packing semantics,
 * EMPIRICALLY VERIFIED against a real mainnet proof (block height 1784124).
 *
 * Consecutive duplicate BlockIds are grouped into a single entry:
 *   key   = [0x01, position_of_first_occurrence_in_interlinks_array]
 *   value = [count, ...blockId_32bytes]   (33 bytes total)
 *
 * Returns `[]` for an empty input (so callers can short-circuit on empty
 * interlinks — see `PoPowHeader::check_interlinks_proof`).
 *
 * HISTORICAL NOTE: sigma-rust's `NipopowAlgos::pack_interlinks` (ergo-nipopow/
 * src/nipopow_algos.rs:326-357) previously used sequential `distinct_ix` keys
 * which round-tripped internally (`unpack_interlinks` ignores key[1]) but
 * didn't match JVM-generated mainnet proofs. Fixed upstream as
 * [ergoplatform/sigma-rust#866](https://github.com/ergoplatform/sigma-rust/pull/866)
 * (landed 2026-05-19; cherry-picked to `integration/ergots`). This TS port
 * agrees with patched sigma-rust byte-for-byte.
 *
 * @throws Error if any interlink is not exactly 32 bytes.
 */
export function packInterlinks(interlinks: Uint8Array[]): ExtensionKV[] {
  if (interlinks.length === 0) return [];
  for (const link of interlinks) {
    if (link.length !== 32) {
      throw new Error(`packInterlinks: expected 32 bytes per interlink, got ${link.length}`);
    }
  }
  const res: ExtensionKV[] = [];
  let currCount = 1;
  let currId = interlinks[0]!;
  let currFirstPos = 0;
  const emit = (count: number, id: Uint8Array, firstPos: number) => {
    if (firstPos > 0xff) {
      throw new Error(`packInterlinks: first-position byte index ${firstPos} > 255`);
    }
    const value = new Uint8Array(1 + id.length);
    value[0] = count;
    value.set(id, 1);
    res.push({ key: new Uint8Array([INTERLINK_VECTOR_PREFIX, firstPos]), value });
  };
  for (let i = 1; i < interlinks.length; i++) {
    const id = interlinks[i]!;
    if (bytesEqual(id, currId)) {
      currCount++;
    } else {
      emit(currCount, currId, currFirstPos);
      currId = id;
      currCount = 1;
      currFirstPos = i;
    }
  }
  emit(currCount, currId, currFirstPos);
  return res;
}

/**
 * Compute the Merkle root of a list of leaf hashes (each already hashed by
 * `hashExtensionLeaf`). Port of sigma-rust `MerkleTree::new(...).root_hash()`
 * (ergo-merkle-tree/src/merkletree.rs:161-220).
 *
 * Empty input → 32-byte zero digest (sigma-rust's `Digest32::zero()`).
 * Single leaf  → `prefixed_hash(INTERNAL_PREFIX, leaf)` (sigma-rust pads to 2).
 * N≥2 leaves   → pad to next power-of-two with null sentinels; bottom-up pair
 *                via `prefixed_hash2(INTERNAL_PREFIX, left, right)` (both
 *                present) or `prefixed_hash(INTERNAL_PREFIX, single)` (one
 *                present, other empty); empty pairs collapse to empty.
 */
export function merkleRootFromLeaves(leafHashes: Uint8Array[]): Uint8Array {
  if (leafHashes.length === 0) return new Uint8Array(32);

  let level: (Uint8Array | null)[] = leafHashes.slice();
  // Pad to next power of two with null sentinels, minimum 2 (single leaf still
  // pairs with an empty sibling per sigma-rust's leaf padding).
  let target = 1;
  while (target < level.length) target *= 2;
  if (target < 2) target = 2;
  while (level.length < target) level.push(null);

  while (level.length > 1) {
    const next: (Uint8Array | null)[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i] ?? null;
      const r = level[i + 1] ?? null;
      if (l === null && r === null) {
        next.push(null);
      } else if (l !== null && r !== null) {
        next.push(prefixedHash2(INTERNAL_PREFIX, l, r));
      } else {
        next.push(prefixedHash(INTERNAL_PREFIX, (l ?? r)!));
      }
    }
    level = next;
  }
  return level[0]!;
}
