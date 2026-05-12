// Header parse/serialize + blake2b256 ID derivation
//
// Wire format (sigma-rust ergo-chain-types/src/header.rs, serialize_without_pow + autolykos):
//
//   version:          u8 (1 byte, raw)
//   parent_id:        32 bytes
//   ad_proofs_root:   32 bytes
//   transaction_root: 32 bytes  ← NOTE: before state_root
//   state_root:       33 bytes  (ADDigest = 32-byte digest + 1-byte tree height)
//   timestamp:        VLQ u64
//   extension_root:   32 bytes
//   n_bits:           4 bytes big-endian (NOT VLQ)
//   height:           VLQ u32
//   votes:            3 bytes
//   [if version > 1:  unparsed_bytes_len: u8, then unparsed_bytes]
//   autolykos v2:     miner_pk (33 bytes) + nonce (8 bytes)
//
// ID = blake2b256(all bytes above) — computed in scorex_parse, not stored on wire.
//
// Reference: sigma-rust ergo-chain-types/src/header.rs:114-212

import { ByteReader } from './scorex/reader.ts';
import { ByteWriter } from './scorex/writer.ts';
import { decodeVlqU, encodeVlqU } from './scorex/vlq.ts';
import { blake2b256 } from './crypto/blake2b256.ts';
import { readFixed, writeFixed, BLOCK_ID_LEN, DIGEST32_LEN, AD_DIGEST_LEN } from './digests.ts';
import { parseAutolykosSolution, serializeAutolykosSolution } from './autolykos-solution.ts';
import type { AutolykosSolution } from './autolykos-solution.ts';

// Re-export the interface type for downstream modules (PoPowHeader, NipopowProof)
export type { AutolykosSolution } from './autolykos-solution.ts';

const VOTES_LEN = 3;
const NBITS_LEN = 4; // raw big-endian u32

export interface Header {
  version: number;             // 0..=255
  id: Uint8Array;              // 32 bytes, derived via blake2b256; not on wire
  parentId: Uint8Array;        // 32 bytes
  adProofsRoot: Uint8Array;    // 32 bytes
  stateRoot: Uint8Array;       // 33 bytes (ADDigest)
  transactionRoot: Uint8Array; // 32 bytes
  timestamp: number;           // ms since epoch (u64 in Rust, safe as JS number for dates < ~2^53ms)
  nBits: number;               // Bitcoin-compact difficulty (u32, up to 2^32-1)
  height: number;              // u32, > 0
  extensionRoot: Uint8Array;   // 32 bytes
  autolykosSolution: AutolykosSolution;
  votes: Uint8Array;           // 3 bytes
  unparsedBytes: Uint8Array;   // forward-compat bytes (only present if version > 1)
}

/**
 * Parse a Header from the reader.
 * The `id` field is derived by hashing all serialized bytes (not read from wire).
 */
export function parseHeader(reader: ByteReader): Header {
  const version = reader.readU8();

  const parentId = readFixed(reader, BLOCK_ID_LEN, 'parentId');
  const adProofsRoot = readFixed(reader, DIGEST32_LEN, 'adProofsRoot');
  const transactionRoot = readFixed(reader, DIGEST32_LEN, 'transactionRoot');
  const stateRoot = readFixed(reader, AD_DIGEST_LEN, 'stateRoot');

  // timestamp: VLQ u64 — fits in Number for all realistic timestamps (< 2^53 ms)
  const timestamp = Number(decodeVlqU(reader));

  const extensionRoot = readFixed(reader, DIGEST32_LEN, 'extensionRoot');

  // n_bits: 4 bytes big-endian (NOT VLQ)
  const nBitsBytes = readFixed(reader, NBITS_LEN, 'nBits');
  const nBits = ((nBitsBytes[0]! << 24) | (nBitsBytes[1]! << 16) | (nBitsBytes[2]! << 8) | nBitsBytes[3]!) >>> 0;

  // height: VLQ u32
  const height = Number(decodeVlqU(reader));

  const votes = readFixed(reader, VOTES_LEN, 'votes');

  // Forward-compat bytes: only present if version > 1
  let unparsedBytes: Uint8Array = new Uint8Array(0);
  if (version > 1) {
    const unparsedLen = reader.readU8();
    if (unparsedLen > 0) {
      unparsedBytes = readFixed(reader, unparsedLen, 'unparsedBytes').slice();
    }
  }

  // AutolykosSolution: v2 for version >= 2 (minerPk 33 bytes + nonce 8 bytes)
  // For v1 the format includes pow_onetime_pk and pow_distance — but all mainnet
  // blocks ≥ height ~417792 are v2+. The autolykos-solution module handles v2.
  const autolykosSolution = parseAutolykosSolution(reader);

  // Derive ID: blake2b256 of the full serialized bytes
  const header: Header = {
    version,
    id: new Uint8Array(32), // placeholder, replaced below
    parentId,
    adProofsRoot,
    stateRoot,
    transactionRoot,
    timestamp,
    nBits,
    height,
    extensionRoot,
    autolykosSolution,
    votes,
    unparsedBytes,
  };

  header.id = deriveHeaderId(header);
  return header;
}

/**
 * Serialize a Header to its canonical byte representation.
 * Field order matches sigma-rust's `scorex_serialize` (serialize_without_pow + autolykos).
 * The `id` field is NOT included in the output (it is derived, not stored).
 */
export function serializeHeader(header: Header): Uint8Array {
  const w = new ByteWriter();

  w.writeU8(header.version);

  writeFixed(w, header.parentId, BLOCK_ID_LEN, 'parentId');
  writeFixed(w, header.adProofsRoot, DIGEST32_LEN, 'adProofsRoot');
  writeFixed(w, header.transactionRoot, DIGEST32_LEN, 'transactionRoot');
  writeFixed(w, header.stateRoot, AD_DIGEST_LEN, 'stateRoot');

  // timestamp: VLQ u64
  w.writeBytes(encodeVlqU(BigInt(header.timestamp)));

  writeFixed(w, header.extensionRoot, DIGEST32_LEN, 'extensionRoot');

  // n_bits: 4 bytes big-endian
  const nBitsBytes = new Uint8Array(4);
  nBitsBytes[0] = (header.nBits >>> 24) & 0xff;
  nBitsBytes[1] = (header.nBits >>> 16) & 0xff;
  nBitsBytes[2] = (header.nBits >>> 8) & 0xff;
  nBitsBytes[3] = header.nBits & 0xff;
  w.writeBytes(nBitsBytes);

  // height: VLQ u32
  w.writeBytes(encodeVlqU(BigInt(header.height)));

  writeFixed(w, header.votes, VOTES_LEN, 'votes');

  // Forward-compat bytes: only if version > 1
  if (header.version > 1) {
    w.writeU8(header.unparsedBytes.length);
    if (header.unparsedBytes.length > 0) {
      w.writeBytes(header.unparsedBytes);
    }
  }

  // AutolykosSolution (v2: minerPk + nonce)
  w.writeBytes(serializeAutolykosSolution(header.autolykosSolution));

  return w.toBytes();
}

/**
 * Derive the Header ID: blake2b256 of the full serialized header bytes.
 * The `id` field on the input is NOT hashed — it is the output.
 *
 * Per sigma-rust: id = blake2b256(serialize_without_pow + autolykos_bytes)
 * which is exactly the full serialized representation (id not included on wire).
 */
export function deriveHeaderId(header: Header): Uint8Array {
  return blake2b256(serializeHeader(header));
}
