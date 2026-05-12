/**
 * PoPowHeader parse/serialize.
 *
 * PoPowHeader = (header: Header, interlinks: BlockId[], interlinksProof: BatchMerkleProof).
 *
 * WIRE FORMAT (ScorexSerializable, sigma-rust ergo-nipopow/src/nipopow_proof.rs):
 *
 *   VLQ u32        : header byte length (size prefix; sigma-ser put_u32 = VLQ)
 *   [header_bytes] : the header in its canonical serialized form
 *   VLQ u32        : interlinks count
 *   per interlink  : 32 bytes (raw BlockId)
 *   VLQ u32        : proof byte length (size prefix)
 *   [proof_bytes]  : the BatchMerkleProof in its canonical serialized form
 *
 * DEVIATIONS FROM PLAN REFERENCE:
 *   - The plan said "4-byte BE u32" for size fields. sigma-rust WriteSigmaVlqExt::put_u32
 *     is VLQ-encoded (variable-length), NOT 4-byte BE. All three size/count fields use VLQ.
 *   - The plan said "VLQ count" for interlinks (same as actual).
 *   - Confirmed by byte-inspection of fixture output from fixture-gen.
 *
 * Reference: sigma-rust ergo-nipopow/src/nipopow_proof.rs, PoPowHeader::scorex_serialize +
 *            PoPowHeader::scorex_parse.
 */

import { ByteReader } from './scorex/reader.ts';
import { ByteWriter } from './scorex/writer.ts';
import { decodeVlqU, encodeVlqU } from './scorex/vlq.ts';
import { parseHeader, serializeHeader, type Header } from './header.ts';
import { parseBatchMerkleProof, serializeBatchMerkleProof, type BatchMerkleProof } from './merkle.ts';
import { ProofParseError } from './errors.ts';

export interface PoPowHeader {
  header: Header;
  interlinks: Uint8Array[];      // each 32 bytes (BlockId); interlinks[0] is genesis_id
  interlinksProof: BatchMerkleProof;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_ID_LEN = 32;
const MAX_HEADER_BYTES = 10_000;
const MAX_INTERLINKS = 10_000;
const MAX_PROOF_BYTES = 1_000_000;

/** Read a VLQ-encoded u32 size/count field. Uses sigma-ser VLQ (put_u32 is VLQ). */
function readVlqU32(r: ByteReader, name: string): number {
  const v = decodeVlqU(r);
  if (v > 0xffffffffn) {
    throw new ProofParseError(`${name}: VLQ value exceeds u32 range`, 'overflow');
  }
  return Number(v);
}

/** Write a VLQ-encoded u32 size/count field. */
function writeVlqU32(w: ByteWriter, v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new Error(`writeVlqU32: out of range: ${v}`);
  }
  w.writeBytes(encodeVlqU(BigInt(v)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a PoPowHeader from its ScorexSerializable wire encoding. */
export function parsePoPowHeader(reader: ByteReader): PoPowHeader {
  // VLQ u32: header byte length
  const headerSize = readVlqU32(reader, 'header_size');
  if (headerSize > MAX_HEADER_BYTES) {
    throw new ProofParseError(`header_size ${headerSize} exceeds sanity limit`, 'overflow');
  }
  // Read exactly headerSize bytes, then parse from a sub-reader
  let headerBytes: Uint8Array;
  try {
    headerBytes = reader.readBytes(headerSize);
  } catch {
    throw new ProofParseError('header bytes: truncated', 'truncated');
  }
  const headerReader = new ByteReader(headerBytes);
  const header = parseHeader(headerReader);

  // VLQ u32: interlinks count
  const interlinksCount = readVlqU32(reader, 'interlinks_count');
  if (interlinksCount > MAX_INTERLINKS) {
    throw new ProofParseError(`interlinks_count ${interlinksCount} exceeds sanity limit`, 'overflow');
  }
  const interlinks: Uint8Array[] = [];
  for (let i = 0; i < interlinksCount; i++) {
    try {
      interlinks.push(reader.readBytes(BLOCK_ID_LEN).slice());
    } catch {
      throw new ProofParseError(`interlink[${i}]: truncated`, 'truncated');
    }
  }

  // VLQ u32: proof byte length
  const proofSize = readVlqU32(reader, 'proof_size');
  if (proofSize > MAX_PROOF_BYTES) {
    throw new ProofParseError(`proof_size ${proofSize} exceeds sanity limit`, 'overflow');
  }
  let proofBytes: Uint8Array;
  try {
    proofBytes = reader.readBytes(proofSize);
  } catch {
    throw new ProofParseError('proof bytes: truncated', 'truncated');
  }
  const proofReader = new ByteReader(proofBytes);
  const interlinksProof = parseBatchMerkleProof(proofReader);

  return { header, interlinks, interlinksProof };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize
// ─────────────────────────────────────────────────────────────────────────────

/** Serialize a PoPowHeader to its ScorexSerializable wire encoding. */
export function serializePoPowHeader(p: PoPowHeader): Uint8Array {
  const w = new ByteWriter();

  // Header: VLQ size prefix + serialized bytes
  const headerBytes = serializeHeader(p.header);
  writeVlqU32(w, headerBytes.length);
  w.writeBytes(headerBytes);

  // Interlinks: VLQ count + 32-byte each
  writeVlqU32(w, p.interlinks.length);
  for (const link of p.interlinks) {
    if (link.length !== BLOCK_ID_LEN) {
      throw new Error(`interlink: expected ${BLOCK_ID_LEN} bytes, got ${link.length}`);
    }
    w.writeBytes(link);
  }

  // Proof: VLQ size prefix + serialized bytes
  const proofBytes = serializeBatchMerkleProof(p.interlinksProof);
  writeVlqU32(w, proofBytes.length);
  w.writeBytes(proofBytes);

  return w.toBytes();
}
