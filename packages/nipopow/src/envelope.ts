/**
 * P2P envelope codec for Ergo NiPoPoW message codes 90 and 91.
 *
 * Code 90 (`GetNipopowProof`): peer requests a proof.
 * Code 91 (`NipopowProof`): peer sends a proof.
 *
 * Wire format (authoritative: ~/projects/ergo-node-rust/facts/nipopow.md):
 *
 * **Code 90 body**:
 *   m: i32 (ZigZag VLQ — JVM putInt)
 *   k: i32 (ZigZag VLQ — JVM putInt)
 *   header_id_present: u8 (raw byte: 0 or 1)
 *   [if present] header_id: 32 raw bytes
 *   future_pad_length: u16 (plain VLQ — JVM putUShort)
 *   [if > 0] padding: future_pad_length bytes
 *
 * **Code 91 body**:
 *   proof_length: u32 (plain VLQ — JVM putUInt)
 *   proof_bytes: [u8; proof_length]
 *   future_pad_length: u16 (plain VLQ — JVM putUShort)
 *   [if > 0] padding: future_pad_length bytes
 *
 * Critical: m/k in code-90 use ZigZag VLQ (signed), NOT plain VLQ.
 * The inner proof's m/k fields use plain VLQ — different layers.
 */

import { ByteReader } from './scorex/reader.ts';
import { ByteWriter } from './scorex/writer.ts';
import {
  encodeVlqU,
  decodeVlqU,
  encodeVlqZigZag,
  decodeVlqZigZag,
} from './scorex/vlq.ts';
import { readFixed, writeFixed, BLOCK_ID_LEN } from './digests.ts';
import { EnvelopeParseError } from './errors.ts';
export { EnvelopeParseError } from './errors.ts';

/** P2P message code: peer requests a NiPoPoW proof from us. */
export const GET_NIPOPOW_PROOF = 90 as const;
/** P2P message code: peer sends a NiPoPoW proof. */
export const NIPOPOW_PROOF = 91 as const;
/** Maximum allowed byte length for a code-90 body (mirrors JVM SizeLimit). */
export const GET_NIPOPOW_PROOF_MAX_SIZE = 1000 as const;
/** Maximum allowed byte length for a code-91 body (mirrors JVM SizeLimit). */
export const NIPOPOW_PROOF_MAX_SIZE = 2_000_000 as const;

/**
 * Parsed `GetNipopowProof` request (code 90).
 * Future-padding bytes are preserved for exact round-trip fidelity.
 */
export interface GetNipopowProofRequest {
  /** Min superchain length parameter (> 0). */
  m: number;
  /** Suffix length parameter (> 0). */
  k: number;
  /** Optional anchor header id (32 bytes), or null for "current tip". */
  headerId: Uint8Array | null;
  /**
   * Raw future-padding bytes following the pad-length field.
   * Preserved on round-trip. Callers constructing a new request should leave
   * this as an empty Uint8Array (or omit it — defaults to empty).
   */
  futurePad?: Uint8Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code 90: GetNipopowProof
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `GetNipopowProof` (code 90) message body.
 *
 * @throws {EnvelopeParseError} with codes: 'oversized', 'truncated',
 *   'invalid-mk', 'malformed'
 */
export function parseGetNipopowProof(body: Uint8Array): GetNipopowProofRequest {
  if (body.length > GET_NIPOPOW_PROOF_MAX_SIZE) {
    throw new EnvelopeParseError(
      `GetNipopowProof body too large: ${body.length} bytes (max ${GET_NIPOPOW_PROOF_MAX_SIZE})`,
      'oversized',
    );
  }

  const r = new ByteReader(body);

  // m: i32 (ZigZag VLQ)
  let mBig: bigint;
  try {
    mBig = decodeVlqZigZag(r);
  } catch (e) {
    throw new EnvelopeParseError(
      `GetNipopowProof: failed to read m: ${(e as Error).message}`,
      'truncated',
    );
  }
  const m = Number(mBig);

  // k: i32 (ZigZag VLQ)
  let kBig: bigint;
  try {
    kBig = decodeVlqZigZag(r);
  } catch (e) {
    throw new EnvelopeParseError(
      `GetNipopowProof: failed to read k: ${(e as Error).message}`,
      'truncated',
    );
  }
  const k = Number(kBig);

  // Validate m and k
  if (m <= 0 || k <= 0) {
    throw new EnvelopeParseError(
      `GetNipopowProof: invalid m=${m} k=${k} (both must be > 0)`,
      'invalid-mk',
    );
  }
  if (m + k > 1000) {
    throw new EnvelopeParseError(
      `GetNipopowProof: m + k = ${m + k} exceeds 1000`,
      'invalid-mk',
    );
  }

  // header_id_present: u8 (raw byte)
  let presentByte: number;
  try {
    presentByte = r.readU8();
  } catch {
    throw new EnvelopeParseError(
      'GetNipopowProof: truncated before headerIdPresent byte',
      'truncated',
    );
  }
  if (presentByte !== 0 && presentByte !== 1) {
    throw new EnvelopeParseError(
      `GetNipopowProof: invalid headerIdPresent byte ${presentByte} (must be 0 or 1)`,
      'malformed',
    );
  }

  // header_id: 32 raw bytes (if present)
  let headerId: Uint8Array | null = null;
  if (presentByte === 1) {
    headerId = readFixed(r, BLOCK_ID_LEN, 'GetNipopowProof.headerId');
  }

  // future_pad_length: u16 (plain VLQ)
  let padLen: number;
  try {
    padLen = Number(decodeVlqU(r));
  } catch (e) {
    throw new EnvelopeParseError(
      `GetNipopowProof: failed to read future_pad_length: ${(e as Error).message}`,
      'truncated',
    );
  }

  // Read (and preserve) padding bytes
  let futurePad = new Uint8Array(0);
  if (padLen > 0) {
    if (padLen > r.remaining) {
      throw new EnvelopeParseError(
        `GetNipopowProof: future_pad_length ${padLen} exceeds remaining body bytes (${r.remaining})`,
        'truncated',
      );
    }
    futurePad = r.readBytes(padLen).slice();
  }

  // Audit NIP-10: reject undeclared trailing bytes after declared payload + pad.
  if (!r.isExhausted) {
    throw new EnvelopeParseError(
      `GetNipopowProof: ${r.remaining} trailing bytes after declared payload`,
      'trailing-bytes',
    );
  }

  return { m, k, headerId, futurePad };
}

/**
 * Serialize a `GetNipopowProofRequest` into a code-90 message body.
 * Inverse of {@link parseGetNipopowProof}; preserves any futurePad bytes.
 */
export function serializeGetNipopowProof(req: GetNipopowProofRequest): Uint8Array {
  // Audit NIP-11: validate `m` and `k` against the same bounds parseGetNipopowProof
  // enforces. Pre-fix the serializer would silently emit `{m:0,k:1}` etc., and the
  // parser would then reject the bytes — letting callers build wire messages
  // their own parser refuses.
  if (req.m <= 0 || req.k <= 0 || req.m + req.k > 1000) {
    throw new EnvelopeParseError(
      `GetNipopowProofRequest: m=${req.m}, k=${req.k}; require m>0, k>0, m+k<=1000`,
      'invalid-mk',
    );
  }

  const w = new ByteWriter();

  // m: i32 (ZigZag VLQ)
  w.writeBytes(encodeVlqZigZag(BigInt(req.m)));
  // k: i32 (ZigZag VLQ)
  w.writeBytes(encodeVlqZigZag(BigInt(req.k)));

  // header_id_present + optional header_id
  if (req.headerId === null) {
    w.writeU8(0);
  } else {
    w.writeU8(1);
    writeFixed(w, req.headerId, BLOCK_ID_LEN, 'GetNipopowProofRequest.headerId');
  }

  // future_pad_length + pad bytes
  const pad = req.futurePad ?? new Uint8Array(0);
  w.writeBytes(encodeVlqU(BigInt(pad.length)));
  if (pad.length > 0) {
    w.writeBytes(pad);
  }

  return w.toBytes();
}

// ─────────────────────────────────────────────────────────────────────────────
// Code 91: NipopowProof envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a `NipopowProof` (code 91) message body.
 * Returns the raw inner proof bytes, suitable for passing to `parseProof`.
 *
 * Round-trip note: future-padding bytes are intentionally stripped. Code-91
 * is a framing codec — the output is passed to `parseProof`, never re-emitted
 * verbatim. Use `serializeNipopowProofEnvelope(inner)` to produce a normalized
 * envelope (pad_length=0). See `facts/nipopow.md` § Round-trip invariant.
 *
 * @throws {EnvelopeParseError} with codes: 'oversized', 'invalid-length', 'truncated'
 */
export function parseNipopowProofEnvelope(body: Uint8Array): Uint8Array {
  if (body.length > NIPOPOW_PROOF_MAX_SIZE) {
    throw new EnvelopeParseError(
      `NipopowProof body too large: ${body.length} bytes (max ${NIPOPOW_PROOF_MAX_SIZE})`,
      'oversized',
    );
  }

  const r = new ByteReader(body);

  // proof_length: u32 (plain VLQ)
  let proofLen: number;
  try {
    const v = decodeVlqU(r);
    proofLen = Number(v);
  } catch (e) {
    throw new EnvelopeParseError(
      `NipopowProof: failed to read proof_length: ${(e as Error).message}`,
      'truncated',
    );
  }

  if (proofLen === 0 || proofLen >= NIPOPOW_PROOF_MAX_SIZE) {
    throw new EnvelopeParseError(
      `NipopowProof: proof_length out of range: ${proofLen} (must be > 0 and < ${NIPOPOW_PROOF_MAX_SIZE})`,
      'invalid-length',
    );
  }

  // proof_bytes
  if (proofLen > r.remaining) {
    throw new EnvelopeParseError(
      `NipopowProof: proof_length ${proofLen} exceeds remaining body bytes (${r.remaining})`,
      'truncated',
    );
  }
  const inner = r.readBytes(proofLen).slice();

  // future_pad_length is always present per the wire spec (may be 0).
  let padLen: number;
  try {
    padLen = Number(decodeVlqU(r));
  } catch (e) {
    throw new EnvelopeParseError(
      `NipopowProof: failed to read future_pad_length: ${(e as Error).message}`,
      'truncated',
    );
  }
  if (padLen > r.remaining) {
    throw new EnvelopeParseError(
      `NipopowProof: future_pad_length ${padLen} exceeds remaining body bytes (${r.remaining})`,
      'truncated',
    );
  }
  if (padLen > 0) r.readBytes(padLen);

  // Audit NIP-10: reject undeclared trailing bytes after declared payload + pad.
  if (!r.isExhausted) {
    throw new EnvelopeParseError(
      `NipopowProof: ${r.remaining} trailing bytes after declared payload`,
      'trailing-bytes',
    );
  }

  return inner;
}

/**
 * Serialize inner proof bytes into a `NipopowProof` (code 91) message body.
 * Inverse of {@link parseNipopowProofEnvelope}; always writes pad_length=0.
 *
 * @throws {Error} if innerProof is empty or oversized (programming error).
 */
export function serializeNipopowProofEnvelope(innerProof: Uint8Array): Uint8Array {
  if (innerProof.length === 0 || innerProof.length >= NIPOPOW_PROOF_MAX_SIZE) {
    throw new Error(
      `serializeNipopowProofEnvelope: inner proof length out of range: ${innerProof.length}`,
    );
  }

  const w = new ByteWriter();
  // proof_length: u32 (plain VLQ)
  w.writeBytes(encodeVlqU(BigInt(innerProof.length)));
  // proof_bytes
  w.writeBytes(innerProof);
  // future_pad_length = 0 (single byte 0x00)
  w.writeU8(0);

  return w.toBytes();
}
