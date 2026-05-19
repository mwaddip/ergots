import { ByteReader, ReaderError } from './reader.ts';
import { ProofParseError } from '../errors.ts';

const MAX_VLQ_BYTES = 10; // ceil(64 / 7) = 10

export function encodeVlqU(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error('encodeVlqU: negative value');
  }
  const out: number[] = [];
  let v = value;
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

export function decodeVlqU(reader: ByteReader): bigint {
  let result = 0n;
  let shift = 0n;
  try {
    for (let i = 0; i < MAX_VLQ_BYTES; i++) {
      const byte = reader.readU8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  } catch (e) {
    if (e instanceof ReaderError) {
      // Audit NIP-12: emit the documented 'truncated' code rather than the
      // undocumented 'vlq-truncated' variant.
      throw new ProofParseError(`decodeVlqU: truncated input (${e.message})`, 'truncated');
    }
    throw e;
  }
  throw new ProofParseError('decodeVlqU: VLQ exceeds 10 bytes (overflow)', 'vlq-overflow');
}

export function encodeVlqZigZag(value: bigint): Uint8Array {
  // Two's-complement i64 zigzag: (v << 1) ^ (v >> 63), with sign-aware shift.
  const masked = value & 0xffffffffffffffffn; // emulate i64
  const sign = value < 0n ? 0xffffffffffffffffn : 0n;
  const zz = ((masked << 1n) & 0xffffffffffffffffn) ^ sign;
  return encodeVlqU(zz);
}

export function decodeVlqZigZag(reader: ByteReader): bigint {
  const zz = decodeVlqU(reader);
  // BigInt XOR with `-(zz & 1n)` performs sign extension natively when
  // the LSB of zz is set: -(1n) = -1n in arbitrary precision, and XOR
  // with -1n flips every bit yielding the negative value directly. No
  // u64 → i64 conversion is needed.
  return (zz >> 1n) ^ -(zz & 1n);
}

/**
 * Read a VLQ-encoded u32 (plain unsigned, not zigzag).
 * Throws ProofParseError with 'vlq-overflow' if the decoded value exceeds u32 range.
 */
export function readVlqU32(reader: ByteReader, name: string): number {
  const v = decodeVlqU(reader);
  if (v > 0xffffffffn) {
    throw new ProofParseError(`${name}: VLQ value exceeds u32 range`, 'vlq-overflow');
  }
  return Number(v);
}
