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

import { ByteReader, ByteWriter, ReaderError, encodeVlqU, readVlqU32 } from '@ergots/scorex';
import { parseHeader, serializeHeader, type Header } from '@ergots/scorex';
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
// Protocol bound: ⌊log₂(height)⌋ + 1 ≤ 33 at height 2^32. 64 gives headroom.
const MAX_INTERLINKS = 64;
const MAX_PROOF_BYTES = 1_000_000;

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
  try {
  // VLQ u32: header byte length
  const headerSize = readVlqU32(reader, 'header_size');
  if (headerSize > MAX_HEADER_BYTES) {
    throw new ProofParseError(`header_size ${headerSize} exceeds sanity limit`, 'oversized');
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
  if (!headerReader.isExhausted) {
    throw new ProofParseError(
      `popow_header: ${headerReader.remaining} trailing bytes in header subreader`,
      'trailing-bytes',
    );
  }

  // VLQ u32: interlinks count
  const interlinksCount = readVlqU32(reader, 'interlinks_count');
  if (interlinksCount > MAX_INTERLINKS) {
    throw new ProofParseError(`interlinks_count ${interlinksCount} exceeds sanity limit`, 'oversized');
  }
  // NIP-05: empty interlinks weaken proof anchoring — every PoPowHeader must
  // commit to at least interlinks[0] (the genesis id). sigma-rust's parser
  // permissively accepts empty interlinks, and `check_interlinks_proof` returns
  // true vacuously for empty + empty proof; we surface this as a typed parse
  // failure rather than relying on downstream connection checks to catch it.
  if (interlinksCount === 0) {
    throw new ProofParseError('interlinks must be non-empty', 'invalid-interlinks-empty');
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
    throw new ProofParseError(`proof_size ${proofSize} exceeds sanity limit`, 'oversized');
  }
  let proofBytes: Uint8Array;
  try {
    proofBytes = reader.readBytes(proofSize);
  } catch {
    throw new ProofParseError('proof bytes: truncated', 'truncated');
  }
  const proofReader = new ByteReader(proofBytes);
  const interlinksProof = parseBatchMerkleProof(proofReader);
  if (!proofReader.isExhausted) {
    throw new ProofParseError(
      `popow_header: ${proofReader.remaining} trailing bytes in proof subreader`,
      'trailing-bytes',
    );
  }

  return { header, interlinks, interlinksProof };
  } catch (e) {
    if (e instanceof ProofParseError) throw e;
    if (e instanceof ReaderError) throw new ProofParseError(e.message, e.code);
    throw e;
  }
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
