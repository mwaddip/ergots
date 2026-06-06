import { ByteReader } from './reader.ts';
import { ReaderError } from './errors.ts';

const MAX_VLQ_BYTES = 10; // ceil(64 / 7) = 10

export function encodeVlqU(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error('encodeVlqU: negative value');
  }
  if (value > 0xffffffffffffffffn) {
    // The wire carries u64 only (references encode from u64/Long); a wider
    // value would decode WRAPPED on their side — reject at the source.
    throw new Error('encodeVlqU: value exceeds u64');
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
  for (let i = 0; i < MAX_VLQ_BYTES; i++) {
    const byte = reader.readU8();
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      // References accumulate into a 64-bit int: bits shifted past bit 63 are
      // silently discarded (sigma-rust vlq_encode.rs get_u64; JVM scorex-util
      // getULong — both the protobuf CodedInputStream loop). Mask to match:
      // a 10-byte encoding with payload above 2^64 wraps, it does NOT error.
      return BigInt.asUintN(64, result);
    }
    shift += 7n;
  }
  throw new ReaderError('decodeVlqU: VLQ exceeds 10 bytes (overflow)', 'vlq-overflow');
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
  // u64 -> i64 conversion is needed.
  return (zz >> 1n) ^ -(zz & 1n);
}

/**
 * Read a VLQ-encoded u32 (plain unsigned, not zigzag).
 * Throws ReaderError with 'vlq-overflow' if the decoded value exceeds u32 range.
 */
export function readVlqU32(reader: ByteReader, fieldName: string): number {
  const v = decodeVlqU(reader);
  if (v > 0xffffffffn) {
    throw new ReaderError(`${fieldName}: VLQ value exceeds u32 range`, 'vlq-overflow');
  }
  return Number(v);
}
