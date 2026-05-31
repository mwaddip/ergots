/**
 * NipopowProof parse/serialize.
 *
 * NipopowProof = (m, k, prefix: PoPowHeader[], suffixHead: PoPowHeader, suffixTail: Header[])
 *
 * WIRE FORMAT (ScorexSerializable — sigma-rust ergo-nipopow/src/nipopow_proof.rs,
 * NipopowProof::scorex_serialize / scorex_parse):
 *
 *   m:                      VLQ u32  (put_u32 = VLQ, plain unsigned — NOT zigzag)
 *   k:                      VLQ u32
 *   prefix_length:          VLQ u32  (number of prefix PoPowHeader entries)
 *   for each prefix entry:
 *     size:                 VLQ u32  (byte length of the PoPowHeader; read & discarded on parse)
 *     PoPowHeader bytes:    (header_size: VLQ u32 + header_bytes + interlinks_count: VLQ u32 +
 *                            interlink_bytes + proof_size: VLQ u32 + proof_bytes)
 *   suffix_head_size:       VLQ u32  (byte length of suffix_head PoPowHeader; read & discarded)
 *   suffix_head:            PoPowHeader
 *   suffix_tail_length:     VLQ u32  (number of tail Header entries)
 *   for each suffix_tail:
 *     size:                 VLQ u32  (byte length of the Header; read & discarded on parse)
 *     Header bytes:         full serialized Header
 *
 * KEY FINDING (STEP 0 inspection of sigma-rust source):
 *   - m and k are plain VLQ u32 (put_u32), NOT zigzag VLQ.
 *   - The facts/nipopow.md "ZigZag VLQ" comment applies to the P2P ENVELOPE's
 *     GetNipopowProof message (code 90), NOT to the inner proof's m/k fields.
 *   - Every size/length/count field uses VLQ u32.
 *   - Each element (both PoPowHeader and Header in suffix_tail) is preceded by
 *     a VLQ u32 size prefix that is written but DISCARDED on parse (the parser
 *     does not use it to bound the read; it just reads the next item inline).
 *   - suffix_tail length is explicit (VLQ u32), NOT implicit from k-1.
 *
 * Reference: sigma-rust ergo-nipopow/src/nipopow_proof.rs lines 203-261.
 */

import { ByteReader, ByteWriter, ReaderError, readVlqU32 } from '@ergots/scorex';
import { parsePoPowHeader, serializePoPowHeader, type PoPowHeader } from './popow-header.ts';
import { parseHeader, serializeHeader, type Header } from '@ergots/scorex';
import { ProofParseError } from './errors.ts';
import { writeVlqU32 } from './vlq-write.ts';

export interface NipopowProof {
  m: number;
  k: number;
  prefix: PoPowHeader[];
  suffixHead: PoPowHeader;
  suffixTail: Header[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PROOF_BYTES = 2_000_000;
/** Upper bound matching sigma-rust MAX_NIPOPOW_PROOF_ELEMENTS = 20_000. */
const MAX_ELEMENTS = 20_000;


// ─────────────────────────────────────────────────────────────────────────────
// Parse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a NipopowProof from its ScorexSerializable wire encoding.
 *
 * The returned proof's serialization is byte-identical to the input
 * (round-trip invariant).
 *
 * @throws ProofParseError on empty/oversized input, truncation, or VLQ overflow.
 */
export function parseProof(bytes: Uint8Array): NipopowProof {
  if (bytes.length === 0) {
    throw new ProofParseError('empty proof bytes', 'empty-proof');
  }
  if (bytes.length > MAX_PROOF_BYTES) {
    throw new ProofParseError(`proof bytes too large: ${bytes.length}`, 'oversized');
  }

  const r = new ByteReader(bytes);

  try {
    // m: VLQ u32 (plain unsigned)
    const m = readVlqU32(r, 'm');
    // NIP-03: m=0 is invalid (m is the minimum superchain-length parameter; m<=0
    // produces a non-terminating loop in compareProofs' bestArg). The facts file
    // declares m>0 as a type invariant; we enforce it at parse time so downstream
    // code (verifier, comparer) can rely on it without re-checking.
    if (m === 0) {
      throw new ProofParseError('m must be > 0', 'invalid-m');
    }

    // k: VLQ u32 (plain unsigned)
    const k = readVlqU32(r, 'k');
    // NIP-04: k=0 is invalid (k is the suffix-length parameter; facts/nipopow.md
    // declares it as `> 0` type invariant).
    if (k === 0) {
      throw new ProofParseError('k must be > 0', 'invalid-k');
    }

    // prefix_length: VLQ u32
    const prefixLen = readVlqU32(r, 'prefix_length');
    if (prefixLen > MAX_ELEMENTS) {
      throw new ProofParseError(`prefix_length ${prefixLen} exceeds sanity limit`, 'oversized');
    }
    // Note (NIP-04 audit re-scope): sigma-rust accepts an empty prefix
    // (`NipopowProof::scorex_parse` has no lower bound; `is_valid` does not check
    // `prefix.is_empty()`). We mirror that to stay byte-compatible. The previous
    // facts claim `prefix.length >= 1` was overstated; see facts/nipopow.md.

    // Parse prefix entries: each preceded by a VLQ u32 size prefix bounding the element.
    const prefix: PoPowHeader[] = [];
    for (let i = 0; i < prefixLen; i++) {
      // size: VLQ u32 (byte count of the following PoPowHeader)
      const sz = readVlqU32(r, `prefix[${i}].size`);
      let elemBytes: Uint8Array;
      try {
        elemBytes = r.readBytes(sz);
      } catch {
        throw new ProofParseError(`prefix[${i}]: declared size ${sz} but input truncated`, 'truncated');
      }
      const subR = new ByteReader(elemBytes);
      let popowHeader: PoPowHeader;
      try {
        popowHeader = parsePoPowHeader(subR);
      } catch (e) {
        if (e instanceof ProofParseError) throw e;
        if (e instanceof ReaderError) throw new ProofParseError(`prefix[${i}]: ${e.message}`, e.code);
        throw new ProofParseError(`prefix[${i}]: ${String(e)}`, 'truncated');
      }
      if (!subR.isExhausted) {
        throw new ProofParseError(
          `prefix[${i}]: declared size ${sz} but ${subR.remaining} bytes unused`,
          'oversized',
        );
      }
      prefix.push(popowHeader);
    }

    // suffix_head_size: VLQ u32 bounding the suffix_head element
    const shSz = readVlqU32(r, 'suffix_head.size');
    let shBytes: Uint8Array;
    try {
      shBytes = r.readBytes(shSz);
    } catch {
      throw new ProofParseError(`suffix_head: declared size ${shSz} but input truncated`, 'truncated');
    }
    const shSubR = new ByteReader(shBytes);
    let suffixHead: PoPowHeader;
    try {
      suffixHead = parsePoPowHeader(shSubR);
    } catch (e) {
      if (e instanceof ProofParseError) throw e;
      if (e instanceof ReaderError) throw new ProofParseError(`suffix_head: ${e.message}`, e.code);
      throw new ProofParseError(`suffix_head: ${String(e)}`, 'truncated');
    }
    if (!shSubR.isExhausted) {
      throw new ProofParseError(
        `suffix_head: declared size ${shSz} but ${shSubR.remaining} bytes unused`,
        'oversized',
      );
    }

    // suffix_tail_length: VLQ u32 (explicit count, NOT k-1)
    // Note (NIP-04 audit re-scope): the wire format stores the tail length
    // explicitly; sigma-rust does NOT enforce `length == k - 1`. Real proofs
    // generated in "anchor" mode have `length == 0` even when `k > 1` (see
    // fixture `chain-64-m2-k2-anchor`). The previous facts claim
    // `suffixTail.length === k - 1` was overstated; see facts/nipopow.md.
    const tailLen = readVlqU32(r, 'suffix_tail_length');
    if (tailLen > MAX_ELEMENTS) {
      throw new ProofParseError(`suffix_tail_length ${tailLen} exceeds sanity limit`, 'oversized');
    }

    // Parse suffix_tail entries: each preceded by a VLQ u32 size prefix bounding the element.
    const suffixTail: Header[] = [];
    for (let i = 0; i < tailLen; i++) {
      // size: VLQ u32 (byte count of the following Header)
      const stSz = readVlqU32(r, `suffix_tail[${i}].size`);
      let stBytes: Uint8Array;
      try {
        stBytes = r.readBytes(stSz);
      } catch {
        throw new ProofParseError(`suffix_tail[${i}]: declared size ${stSz} but input truncated`, 'truncated');
      }
      const stSubR = new ByteReader(stBytes);
      let tailHeader: Header;
      try {
        tailHeader = parseHeader(stSubR);
      } catch (e) {
        if (e instanceof ProofParseError) throw e;
        if (e instanceof ReaderError) throw new ProofParseError(`suffix_tail[${i}]: ${e.message}`, e.code);
        throw new ProofParseError(`suffix_tail[${i}]: ${String(e)}`, 'truncated');
      }
      if (!stSubR.isExhausted) {
        throw new ProofParseError(
          `suffix_tail[${i}]: declared size ${stSz} but ${stSubR.remaining} bytes unused`,
          'oversized',
        );
      }
      suffixTail.push(tailHeader);
    }

    if (!r.isExhausted) {
      throw new ProofParseError(
        `proof: ${r.remaining} trailing bytes after end of suffix_tail`,
        'trailing-bytes',
      );
    }

    return { m, k, prefix, suffixHead, suffixTail };
  } catch (e) {
    if (e instanceof ProofParseError) throw e;
    if (e instanceof ReaderError) throw new ProofParseError(e.message, e.code);
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialize a NipopowProof to its ScorexSerializable wire encoding.
 *
 * For any proof returned by parseProof(b), serializeProof(parseProof(b)) === b
 * byte-for-byte (round-trip invariant).
 */
export function serializeProof(p: NipopowProof): Uint8Array {
  const w = new ByteWriter();

  // m: VLQ u32
  writeVlqU32(w, p.m);

  // k: VLQ u32
  writeVlqU32(w, p.k);

  // prefix_length: VLQ u32
  writeVlqU32(w, p.prefix.length);

  // prefix entries: each preceded by VLQ u32 size prefix
  for (const ph of p.prefix) {
    const phBytes = serializePoPowHeader(ph);
    writeVlqU32(w, phBytes.length);
    w.writeBytes(phBytes);
  }

  // suffix_head: preceded by VLQ u32 size prefix
  const shBytes = serializePoPowHeader(p.suffixHead);
  writeVlqU32(w, shBytes.length);
  w.writeBytes(shBytes);

  // suffix_tail_length: VLQ u32
  writeVlqU32(w, p.suffixTail.length);

  // suffix_tail entries: each preceded by VLQ u32 size prefix
  for (const h of p.suffixTail) {
    const hBytes = serializeHeader(h);
    writeVlqU32(w, hBytes.length);
    w.writeBytes(hBytes);
  }

  return w.toBytes();
}
